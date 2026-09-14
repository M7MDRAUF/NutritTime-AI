/**
 * The storage core (TSD 6.4): the driver seam, the read path, the migration gate, the bound
 * semantics, and the write failures.
 *
 * The read path is `decode envelope -> migrate -> validate -> bound`, and every stage that
 * cannot produce a usable value does the same three things: quarantine the raw bytes, remove the
 * live key, return the key's own fallback with status `recovered`. **One key's corruption never
 * touches another's**, which is only true because nothing on this path throws past its caller.
 *
 * `StorageDriver` is the seam that keeps AsyncStorage out of this file — and out of every file
 * except `asyncStorageDriver.ts`, per TSD 2.3 rule 4. Tests pass an in-memory driver, which is
 * what makes a corrupt-key vector a plain unit test rather than a device experiment.
 */

import type { ValueSchema } from '@nutritime/contracts';
import type { QuarantineReason, QuarantineRecord } from './envelope.js';
import {
  QUARANTINE_KEY,
  appendQuarantine,
  buildQuarantineRecord,
  decodeEnvelope,
  decodeQuarantineLedger,
  encodeEnvelope,
  encodeQuarantineLedger,
} from './envelope.js';

/** TSD 6.4, verbatim. Four methods, and the only shape AsyncStorage is allowed to arrive as. */
export interface StorageDriver {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
}

export interface Repository<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface RepositoryDefinition<T> {
  readonly key: string;
  readonly schemaVersion: number;
  readonly schema: ValueSchema<T>;
  readonly fallback: () => T;
  /**
   * Keyed by the version a migration produces, taking the value of the version before it. TSD
   * 6.4: only `schemaVersion - 1` migrates, so only `migrations[schemaVersion]` is ever read.
   */
  readonly migrations?: Readonly<Record<number, (previous: unknown) => unknown>>;
  /**
   * **Must return the value itself when it is within bounds**, and a shortened copy otherwise.
   *
   * That one rule is what lets a single function carry both of TSD 6.4's directions: the write
   * path refuses when `bound(value) !== value` (something would have been dropped), and the read
   * path keeps whatever it returns. A `bound` that always allocated would refuse every write.
   */
  readonly bound?: (value: T) => T;
}

/**
 * TSD 6.4. `unavailable` is not a synonym for `default`: it means the driver itself failed, so
 * this build does not know whether data exists. TSD 6.3 forbids a store writing over a key in
 * that state, because the write would destroy a record that was merely unreadable this once.
 */
export type EntryStatus = 'loaded' | 'default' | 'recovered' | 'unavailable';

export type StorageWriteFailure = 'write-failed' | 'bound-exceeded';

/** Fixed, local, user-facing. No driver text: a driver message can quote the payload. */
const WRITE_MESSAGES: Readonly<Record<StorageWriteFailure, string>> = {
  'write-failed': 'That change could not be saved.',
  'bound-exceeded': 'That list is full.',
};

export class StorageWriteError extends Error {
  public readonly key: string;
  public readonly reason: StorageWriteFailure;

  public constructor(key: string, reason: StorageWriteFailure) {
    super(WRITE_MESSAGES[reason]);
    this.name = 'StorageWriteError';
    this.key = key;
    this.reason = reason;
  }
}

export function isStorageWriteError(value: unknown): value is StorageWriteError {
  return value instanceof StorageWriteError;
}

/** A read result and how it was obtained. TSD 6.3's `StoreStatus.entryStatus` is this field. */
export interface StorageEntry<T> {
  readonly value: T;
  readonly status: EntryStatus;
}

/**
 * What the repository needs from the outside world: a driver, and a clock.
 *
 * TSD 6.4 names `RepositoryRuntime` in `createRepository`'s signature and never declares it.
 * Declared here as the two capabilities the read and write paths actually use. The clock is a
 * parameter for the same reason the domain has none (TSD 4.3): `updatedAt` is asserted in tests,
 * and a test that reads the wall clock asserts nothing.
 */
export interface RepositoryRuntime {
  readonly driver: StorageDriver;
  /** An ISO-8601 instant — `() => new Date().toISOString()` in the app. */
  readonly now: () => string;
}

/** A read that produced no value, carrying everything the ledger needs to record it. */
export interface CorruptEntry {
  readonly reason: QuarantineReason;
  readonly schemaVersion: number | null;
}

export type ClassifiedEntry<T> =
  | {
      readonly kind: 'value';
      readonly value: T;
      readonly status: 'loaded' | 'default' | 'recovered';
    }
  | { readonly kind: 'corrupt'; readonly corrupt: CorruptEntry };

/**
 * The whole read path, as a pure function of the stored string.
 *
 * Pure on purpose: `hydrate.ts` classifies six keys from one `multiGet` and then writes the
 * ledger ONCE, while a single repository read classifies one key and writes the ledger itself.
 * Both share this, so the two paths cannot disagree about what counts as corruption.
 */
export function classifyEntry<T>(
  definition: RepositoryDefinition<T>,
  raw: string | null,
): ClassifiedEntry<T> {
  if (raw === null) {
    return { kind: 'value', value: definition.fallback(), status: 'default' };
  }

  // Stage 1 — decode.
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) {
    return { kind: 'corrupt', corrupt: { reason: decoded.reason, schemaVersion: null } };
  }
  const { schemaVersion: storedVersion, value: storedValue } = decoded.envelope;

  // Stage 2 — the migration gate.
  //
  // **Only `schemaVersion - 1`, and only with a migration function for the current version.**
  // Anything else is quarantined rather than guessed at (TSD 6.4). A version AHEAD of this build
  // lands here too: a downgraded app reading a newer record has no way to know what was added,
  // and dropping the unknown fields silently is exactly the data loss the gate exists to refuse.
  const current = definition.schemaVersion;
  let migrated: unknown = storedValue;
  if (storedVersion !== current) {
    const migration = definition.migrations?.[current];
    if (storedVersion !== current - 1 || migration === undefined) {
      return {
        kind: 'corrupt',
        corrupt: { reason: 'version-unsupported', schemaVersion: storedVersion },
      };
    }
    try {
      migrated = migration(storedValue);
    } catch {
      // The migration's own error is not inspected. It was written by this codebase, but it ran
      // over the user's data and its message can quote what it choked on.
      return {
        kind: 'corrupt',
        corrupt: { reason: 'migration-failed', schemaVersion: storedVersion },
      };
    }
  }

  // Stages 3 and 4 — validate, then bound.
  //
  // **Wrapped, because `schema` and `bound` are supplied by the DEFINITION and this function
  // promises its caller that nothing on this path throws.** The six shipped definitions are all
  // pure and Zod's `safeParse` does not throw, so this is unreachable in the app today; it is
  // reachable the moment a definition is added, and an exception escaping here would travel
  // `classifyEntry` -> `decodeOne` -> `hydrateStorage` and brick the launch. A definition that
  // throws is behaving exactly like one whose data is invalid, so `schema-invalid` is the honest
  // reason - the value could not be validated, and why is the definition's business.
  try {
    // A migrated value is validated by the SAME schema as a current one, so a migration that
    // produces a subtly wrong shape is caught here rather than at first render.
    const parsed = definition.schema.safeParse(migrated);
    if (!parsed.success) {
      return {
        kind: 'corrupt',
        corrupt: { reason: 'schema-invalid', schemaVersion: storedVersion },
      };
    }

    // **Reads truncate**; they never refuse (TSD 6.4). An over-long entry already on disk is a
    // fact to recover from, and refusing here would make it permanently unreadable.
    if (definition.bound !== undefined) {
      const bounded = definition.bound(parsed.data);
      if (bounded !== parsed.data) {
        return { kind: 'value', value: bounded, status: 'recovered' };
      }
    }
    return { kind: 'value', value: parsed.data, status: 'loaded' };
  } catch {
    return { kind: 'corrupt', corrupt: { reason: 'schema-invalid', schemaVersion: storedVersion } };
  }
}

/**
 * Record one corrupt key in the ledger, then drop the live key.
 *
 * **In that order, and the removal is conditional.** If the ledger write fails there is nowhere
 * the bytes survive, so removing the live key would destroy them — the opposite of what Plan
 * 10.2 calls the rollback equivalent. A corrupt key that stays put is re-quarantined next launch,
 * which is harmless; a deleted one is gone.
 *
 * Never rejects. Quarantine bookkeeping failing must not turn a recovered read into a crash.
 */
export async function quarantine(
  runtime: RepositoryRuntime,
  key: string,
  corrupt: CorruptEntry,
  payload: string,
): Promise<boolean> {
  const record = buildQuarantineRecord(
    key,
    corrupt.reason,
    corrupt.schemaVersion,
    payload,
    runtime.now(),
  );
  const stored = await writeQuarantineRecords(runtime, [record]);
  if (!stored) {
    return false;
  }
  try {
    await runtime.driver.removeItem(key);
  } catch {
    return false;
  }
  return true;
}

/**
 * Append records to the ledger in one read-modify-write. Returns whether the write landed.
 *
 * Shared with hydration, which has already read the ledger but re-reads nothing else: the extra
 * `getItem` here is one call on a path that only runs when something is already broken.
 */
export async function writeQuarantineRecords(
  runtime: RepositoryRuntime,
  records: readonly QuarantineRecord[],
): Promise<boolean> {
  if (records.length === 0) {
    return true;
  }
  try {
    const existing = await runtime.driver.getItem(QUARANTINE_KEY);
    const ledger = appendQuarantine(decodeQuarantineLedger(existing), records);
    await runtime.driver.setItem(QUARANTINE_KEY, encodeQuarantineLedger(ledger, runtime.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * One key's read, including its quarantine side effects. Never rejects.
 *
 * A driver that throws yields `unavailable` rather than `default`, because the two lead to
 * different behaviour: `default` means "nothing is stored, save freely", `unavailable` means
 * "this build could not look, do not overwrite".
 */
export async function readEntry<T>(
  definition: RepositoryDefinition<T>,
  runtime: RepositoryRuntime,
): Promise<StorageEntry<T>> {
  let raw: string | null;
  try {
    raw = await runtime.driver.getItem(definition.key);
  } catch {
    return { value: definition.fallback(), status: 'unavailable' };
  }
  const classified = classifyEntry(definition, raw);
  if (classified.kind === 'value') {
    return { value: classified.value, status: classified.status };
  }
  await quarantine(runtime, definition.key, classified.corrupt, raw ?? '');
  return { value: definition.fallback(), status: 'recovered' };
}

export function createRepository<T>(
  definition: RepositoryDefinition<T>,
  runtime: RepositoryRuntime,
): Repository<T> {
  return {
    async get(): Promise<T> {
      return (await readEntry(definition, runtime)).value;
    },

    /**
     * **Bounds are refusals on write** (TSD 6.4). Every entry under a bounded key is something
     * the user chose or authored, so a save that silently dropped the oldest one would destroy
     * data they have already been shown. `StorageWriteError('bound-exceeded')` is what tells the
     * UI to present the failure with no retry button: retrying the same value can never succeed.
     *
     * The value is NOT re-validated against the schema. TSD 6.4 declares exactly two write
     * failures, and a value that fails its own schema is a typed-caller bug, not a storage
     * condition — inventing a third reason here would put a programming error in front of a user.
     */
    async set(value: T): Promise<void> {
      if (definition.bound !== undefined && definition.bound(value) !== value) {
        throw new StorageWriteError(definition.key, 'bound-exceeded');
      }
      let payload: string;
      try {
        payload = encodeEnvelope(definition.schemaVersion, value, runtime.now());
      } catch {
        throw new StorageWriteError(definition.key, 'write-failed');
      }
      try {
        await runtime.driver.setItem(definition.key, payload);
      } catch {
        throw new StorageWriteError(definition.key, 'write-failed');
      }
    },

    async clear(): Promise<void> {
      try {
        await runtime.driver.removeItem(definition.key);
      } catch {
        throw new StorageWriteError(definition.key, 'write-failed');
      }
    },
  };
}
