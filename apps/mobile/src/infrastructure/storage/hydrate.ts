/**
 * Boot hydration (TSD 6.1, T-12-09): **one `multiGet`, six isolated decodes, and no rejection.**
 *
 * This is the defect this module exists to prevent. During the `hydrating` phase the protected
 * screens are not in the navigator at all, so a rejected hydration is not a screen that fails to
 * load — it is an app that never leaves the splash. Every failure below is therefore handled at
 * the key that produced it and converted into an `EntryStatus`, and the only `await` that can
 * reject is wrapped.
 *
 * Three consequences worth stating, because each is a thing that would otherwise go wrong:
 *
 *  1. **Decodes are independent.** `classifyEntry` is pure and is called once per key with that
 *     key's own bytes. There is no shared parse step in which one corrupt string can strand five
 *     good ones.
 *  2. **The quarantine ledger is written ONCE.** It is read in the same `multiGet` as the live
 *     keys, so N corrupt keys still cost one read and one write instead of N read-modify-writes
 *     racing each other.
 *  3. **A live key is removed only after its bytes are safe.** If the ledger write fails, nothing
 *     is deleted — Plan 10.2 calls the ledger the rollback equivalent, and a rollback to bytes
 *     that were deleted first is no rollback.
 */

import type { QuarantineLedger, QuarantineRecord } from './envelope.js';
import {
  QUARANTINE_KEY,
  appendQuarantine,
  buildQuarantineRecord,
  decodeQuarantineLedger,
} from './envelope.js';
import type { StorageKeyName, StorageValues, StoredMeta } from './definitions.js';
import { STORAGE_DEFINITIONS, STORAGE_KEYS, STORAGE_KEY_NAMES } from './definitions.js';
import type { RepositoryDefinition, RepositoryRuntime, StorageEntry } from './repository.js';
import { classifyEntry, createRepository, writeQuarantineRecords } from './repository.js';

export type HydratedEntries = {
  readonly [K in StorageKeyName]: StorageEntry<StorageValues[K]>;
};

export interface HydrationSnapshot {
  readonly entries: HydratedEntries;
  /** The ledger as it stands after this boot. **Never surfaced to the UI** (TSD 6.4). */
  readonly quarantine: QuarantineLedger;
  /**
   * Keys whose status is `recovered` — quarantined, or truncated at their bound. For tests and
   * diagnosis, not for a screen: the ledger's contents are never surfaced (TSD 6.4).
   */
  readonly recovered: readonly StorageKeyName[];
}

/** Every key read at boot: the six live keys, plus the ledger (TSD 6.1). */
export const HYDRATION_KEYS: readonly string[] = [
  ...STORAGE_KEY_NAMES.map((name) => STORAGE_KEYS[name]),
  QUARANTINE_KEY,
];

interface Decoded<T> {
  readonly entry: StorageEntry<T>;
  readonly record: QuarantineRecord | null;
  readonly keyToRemove: string | null;
}

function decodeOne<T>(
  definition: RepositoryDefinition<T>,
  raw: ReadonlyMap<string, string | null>,
  now: string,
): Decoded<T> {
  // A key the driver did not return at all reads as absent, not as an error: `multiGet`
  // answering for five of six keys is a driver quirk, and "nothing stored" is the honest reading.
  const stored = raw.get(definition.key) ?? null;
  const classified = classifyEntry(definition, stored);
  if (classified.kind === 'value') {
    return {
      entry: { value: classified.value, status: classified.status },
      record: null,
      keyToRemove: null,
    };
  }
  return {
    entry: { value: definition.fallback(), status: 'recovered' },
    record: buildQuarantineRecord(
      definition.key,
      classified.corrupt.reason,
      classified.corrupt.schemaVersion,
      stored ?? '',
      now,
    ),
    keyToRemove: definition.key,
  };
}

function unavailable<T>(definition: RepositoryDefinition<T>): StorageEntry<T> {
  return { value: definition.fallback(), status: 'unavailable' };
}

/**
 * Hydrate every key. **Never rejects**, under any driver behaviour.
 *
 * The six decodes are written out one per line rather than built by iterating `STORAGE_KEY_NAMES`
 * into an accumulator, because the accumulator form cannot be typed without an assertion: each
 * key has a different value type, and `StorageValues[K]` only stays honest if the compiler sees
 * all six assignments. A missing key is then a compile error rather than an `undefined` entry a
 * store reads at boot.
 */
export async function hydrateStorage(runtime: RepositoryRuntime): Promise<HydrationSnapshot> {
  let pairs: readonly (readonly [string, string | null])[];
  try {
    pairs = await runtime.driver.multiGet(HYDRATION_KEYS);
  } catch {
    // The driver itself is unusable. Every key is `unavailable`, which TSD 6.3 turns into "do
    // not write over it" — the app runs on defaults this session and destroys nothing.
    return {
      entries: {
        meta: unavailable(STORAGE_DEFINITIONS.meta),
        onboarding: unavailable(STORAGE_DEFINITIONS.onboarding),
        preferences: unavailable(STORAGE_DEFINITIONS.preferences),
        favorites: unavailable(STORAGE_DEFINITIONS.favorites),
        customMeals: unavailable(STORAGE_DEFINITIONS.customMeals),
        ui: unavailable(STORAGE_DEFINITIONS.ui),
      },
      quarantine: decodeQuarantineLedger(null),
      recovered: [],
    };
  }

  const raw = new Map<string, string | null>(pairs.map(([key, value]) => [key, value]));
  const now = runtime.now();

  const meta = decodeOne(STORAGE_DEFINITIONS.meta, raw, now);
  const onboarding = decodeOne(STORAGE_DEFINITIONS.onboarding, raw, now);
  const preferences = decodeOne(STORAGE_DEFINITIONS.preferences, raw, now);
  const favorites = decodeOne(STORAGE_DEFINITIONS.favorites, raw, now);
  const customMeals = decodeOne(STORAGE_DEFINITIONS.customMeals, raw, now);
  const ui = decodeOne(STORAGE_DEFINITIONS.ui, raw, now);

  const entries: HydratedEntries = {
    meta: meta.entry,
    onboarding: onboarding.entry,
    preferences: preferences.entry,
    favorites: favorites.entry,
    customMeals: customMeals.entry,
    ui: ui.entry,
  };

  const decoded = [meta, onboarding, preferences, favorites, customMeals, ui];
  const records = decoded
    .map((one) => one.record)
    .filter((record): record is QuarantineRecord => record !== null);

  const ledger = decodeQuarantineLedger(raw.get(QUARANTINE_KEY) ?? null);
  const recovered = STORAGE_KEY_NAMES.filter((name) => entries[name].status === 'recovered');

  if (records.length === 0) {
    return { entries, quarantine: ledger, recovered };
  }

  // One write for the whole ledger, then the removals. `writeQuarantineRecords` re-reads the
  // ledger rather than trusting the copy above, so a record another path wrote between the
  // `multiGet` and here is not lost. It never rejects.
  const stored = await writeQuarantineRecords(runtime, records);
  if (stored) {
    await Promise.allSettled(
      decoded
        .map((one) => one.keyToRemove)
        .filter((key): key is string => key !== null)
        // **`async` is load-bearing, not stylistic.** `Promise.allSettled` absorbs a REJECTED
        // promise; it cannot absorb a callback that throws before returning one. A driver whose
        // `removeItem` throws synchronously threw inside `.map()`, so the array was never built,
        // `allSettled` was never called, and `hydrateStorage` REJECTED - breaking the one
        // guarantee this module makes in bold three screens up, and bricking the app on launch.
        // An `async` arrow turns a synchronous throw into a rejection, which is what the
        // surrounding `allSettled` was written to handle.
        //
        // The shipped `asyncStorageDriver` cannot produce a synchronous throw - AsyncStorage
        // wraps its work in a promise executor - so this was unreachable in the app and entirely
        // reachable through the `StorageDriver` seam the tests use and P22 will use for
        // `localStorage`.
        .map(async (key) => runtime.driver.removeItem(key)),
    );
  }

  return { entries, quarantine: appendQuarantine(ledger, records), recovered };
}

/**
 * Write the `meta` key once at boot (TSD 6.3: "written once at boot through its repository
 * directly"). **Never rejects**, and returns `null` when nothing was written.
 *
 * Two rules it obeys that a naive `set` would not:
 *
 *  - `unavailable` is skipped. TSD 6.3 forbids writing over a key whose read status is
 *    `unavailable`, and `meta` is the first key anything writes at boot — getting this wrong here
 *    would overwrite a first-launch date on every storage hiccup.
 *  - `firstLaunchAt` is preserved when it is already set, including through a `recovered` read.
 *    A quarantined `meta` legitimately starts over; a loaded one must not.
 */
export async function recordLaunch(
  runtime: RepositoryRuntime,
  snapshot: HydrationSnapshot,
): Promise<StoredMeta | null> {
  const entry = snapshot.entries.meta;
  if (entry.status === 'unavailable') {
    return null;
  }
  const at = runtime.now();
  const next: StoredMeta = {
    firstLaunchAt: entry.value.firstLaunchAt ?? at,
    lastLaunchAt: at,
  };
  try {
    await createRepository(STORAGE_DEFINITIONS.meta, runtime).set(next);
  } catch {
    // The device refused the write. Boot continues: `meta` is diagnostic and nothing downstream
    // reads it. The `StorageWriteError` is swallowed, not logged — see `envelope.ts`.
    return null;
  }
  return next;
}
