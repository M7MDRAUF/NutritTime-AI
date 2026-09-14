/**
 * The on-device storage format (TSD 6.4) — the envelope, and the quarantine ledger.
 *
 * Both live here because both are *stored JSON shapes*: the envelope wraps a live value, the
 * ledger wraps the bytes of one that stopped being live. Everything in this file is pure —
 * strings in, strings out — so `repository.ts` and `hydrate.ts` can share one decoder and the
 * tests can exercise every failure without a driver.
 *
 * **Nothing here throws.** A decoder that throws on bad input is the exact defect T-12-09 exists
 * to prevent: one corrupt key would reject the whole hydration and the app would not boot. Every
 * function below returns a discriminated result instead.
 *
 * **Nothing here logs.** A quarantined payload is the user's own data — `preferences` carries a
 * name and an allergy list — and PRD 10.3 forbids either reaching a log line. Storing the bytes
 * under the quarantine key is what TSD 6.4 asks for; printing them is not.
 */

/** TSD 6.4, verbatim. `value` is `unknown` because the key's own schema decides what it is. */
export interface StorageEnvelope {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly value: unknown;
}

/**
 * The five ways a read can fail, one per stage of TSD 6.4's read path
 * (decode envelope -> migrate -> validate -> bound).
 *
 * The bound stage produces no reason, and that is deliberate: TSD 6.4 says reads TRUNCATE and
 * report `recovered`, because refusing there would make an over-long entry permanently
 * unreadable. Only the four stages that cannot produce a usable value quarantine, and `decode`
 * fails in two distinguishable ways.
 */
export const QUARANTINE_REASONS = [
  /** The stored string is not JSON at all. */
  'unreadable',
  /** JSON, but not `{ schemaVersion: number, updatedAt: string, value }`. */
  'envelope-invalid',
  /** More than one version behind, ahead of this build, or no migration for this version. */
  'version-unsupported',
  /** The migration function itself threw. */
  'migration-failed',
  /** The value did not satisfy the key's schema. */
  'schema-invalid',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export type EnvelopeDecode =
  | { readonly ok: true; readonly envelope: StorageEnvelope }
  | { readonly ok: false; readonly reason: 'unreadable' | 'envelope-invalid' };

/**
 * A plain JSON object, narrowed without a cast.
 *
 * `typeof null === 'object'` and an array is an object too, so both are excluded explicitly.
 * Exported because `definitions.ts` reads the same kind of untrusted record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Exactly what `new Date().toISOString()` produces, and nothing else.
 *
 * Three checks, because each one alone lets something through:
 *
 *  - the regex alone accepts `2026-02-31T00:00:00.000Z`;
 *  - `Date.parse` alone accepts `March 3, 2026`, and it also **silently rolls an out-of-range
 *    day over** — `2026-02-31` parses as `2026-03-03` rather than failing;
 *  - so the date part is compared against the re-serialised instant, which is the only thing
 *    that catches the roll-over.
 *
 * A timestamp read back off the device has to be the instant it claims to be. `updatedAt` is
 * what a future migration would reason about.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString().startsWith(value.slice(0, 10));
}

export function encodeEnvelope(schemaVersion: number, value: unknown, updatedAt: string): string {
  const envelope: StorageEnvelope = { schemaVersion, updatedAt, value };
  return JSON.stringify(envelope);
}

/**
 * Stage 1 of the read path. Returns a reason rather than throwing.
 *
 * `schemaVersion` must be a finite integer: `NaN`, `Infinity` and `1.5` would all sail past a
 * bare `typeof === 'number'` and then make the migration gate's arithmetic meaningless.
 */
export function decodeEnvelope(raw: string): EnvelopeDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'envelope-invalid' };
  }
  const schemaVersion = parsed['schemaVersion'];
  const updatedAt = parsed['updatedAt'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    return { ok: false, reason: 'envelope-invalid' };
  }
  if (!isTimestamp(updatedAt)) {
    return { ok: false, reason: 'envelope-invalid' };
  }
  // `value` is deliberately not checked for presence: `undefined` is not representable in JSON,
  // so a key whose stored value is `null` and one whose `value` field is missing are the same
  // record on disk. The key's schema decides whether that is acceptable.
  return { ok: true, envelope: { schemaVersion, updatedAt, value: parsed['value'] } };
}

// ------------------------------------------------------------- quarantine ledger

/**
 * What was quarantined, why, and the bytes themselves.
 *
 * `payloadLength` and `payloadTruncated` exist so a truncated copy can never be mistaken for the
 * whole record. Plan 10.2 calls the ledger "the rollback equivalent" — a partial payload that
 * looked complete would be a rollback to data that never existed.
 */
export interface QuarantineRecord {
  readonly key: string;
  readonly reason: QuarantineReason;
  /** The version found in the envelope, or `null` when the envelope itself was unreadable. */
  readonly schemaVersion: number | null;
  readonly quarantinedAt: string;
  readonly payload: string;
  readonly payloadLength: number;
  readonly payloadTruncated: boolean;
}

export interface QuarantineLedger {
  readonly records: readonly QuarantineRecord[];
}

/**
 * TSD 6.4 declares `QUARANTINE_KEY` beside `STORAGE_KEYS`, and `definitions.ts` re-exports it
 * under that name so the documented surface stays where the document puts it. It is DECLARED
 * here because `repository.ts` writes the ledger and `definitions.ts` imports `repository.ts`:
 * the other direction would be the import cycle Plan 12.2 rule 6 forbids and no tool detects
 * (X-10).
 */
export const QUARANTINE_KEY = '@nutritime/quarantine/v1';

export const QUARANTINE_SCHEMA_VERSION = 1;

/**
 * The ledger is bounded in BOTH dimensions, and the numbers are a trade, not a guess.
 *
 * A `customMeals` blob at its own 200-entry bound is comfortably past 16 KB, so a generous
 * per-record cap still cannot hold every case. Ten records at 16 KB caps the ledger at ~160 KB,
 * which fits inside the several-megabyte `localStorage` quota the web export inherits (D-01).
 * An unbounded ledger would eventually fail to write, and a quarantine that cannot be written is
 * a quarantine that loses the bytes it exists to keep.
 */
export const QUARANTINE_MAX_RECORDS = 10;
export const QUARANTINE_MAX_PAYLOAD_CHARS = 16_384;

export const EMPTY_QUARANTINE_LEDGER: QuarantineLedger = { records: [] };

export function buildQuarantineRecord(
  key: string,
  reason: QuarantineReason,
  schemaVersion: number | null,
  payload: string,
  quarantinedAt: string,
): QuarantineRecord {
  const truncated = payload.length > QUARANTINE_MAX_PAYLOAD_CHARS;
  return {
    key,
    reason,
    schemaVersion,
    quarantinedAt,
    payload: truncated ? payload.slice(0, QUARANTINE_MAX_PAYLOAD_CHARS) : payload,
    payloadLength: payload.length,
    payloadTruncated: truncated,
  };
}

/** Newest first, oldest dropped. The most recent corruption is the one worth keeping. */
export function appendQuarantine(
  ledger: QuarantineLedger,
  records: readonly QuarantineRecord[],
): QuarantineLedger {
  if (records.length === 0) {
    return ledger;
  }
  return { records: [...records, ...ledger.records].slice(0, QUARANTINE_MAX_RECORDS) };
}

/**
 * Read the ledger, and **never quarantine the quarantine**.
 *
 * There is nowhere to put the bytes of a corrupt ledger, and recursing into the quarantine path
 * from inside the quarantine path is how a corrupt ledger becomes an infinite loop at boot. A
 * ledger this build cannot read starts over as empty: the live keys are unaffected, which is the
 * only thing a user can actually lose.
 */
export function decodeQuarantineLedger(raw: string | null): QuarantineLedger {
  if (raw === null) {
    return EMPTY_QUARANTINE_LEDGER;
  }
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok || decoded.envelope.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    return EMPTY_QUARANTINE_LEDGER;
  }
  const value = decoded.envelope.value;
  if (!isRecord(value)) {
    return EMPTY_QUARANTINE_LEDGER;
  }
  const rawRecords = value['records'];
  if (!Array.isArray(rawRecords)) {
    return EMPTY_QUARANTINE_LEDGER;
  }
  const records: QuarantineRecord[] = [];
  for (const entry of rawRecords) {
    const record = decodeQuarantineRecord(entry);
    if (record !== null) {
      records.push(record);
    }
  }
  return { records: records.slice(0, QUARANTINE_MAX_RECORDS) };
}

function decodeQuarantineRecord(value: unknown): QuarantineRecord | null {
  if (!isRecord(value)) {
    return null;
  }
  const key = value['key'];
  const reason = value['reason'];
  const schemaVersion = value['schemaVersion'];
  const quarantinedAt = value['quarantinedAt'];
  const payload = value['payload'];
  const payloadLength = value['payloadLength'];
  const payloadTruncated = value['payloadTruncated'];
  if (typeof key !== 'string' || typeof payload !== 'string') {
    return null;
  }
  if (!isQuarantineReason(reason) || !isTimestamp(quarantinedAt)) {
    return null;
  }
  if (schemaVersion !== null && typeof schemaVersion !== 'number') {
    return null;
  }
  if (typeof payloadLength !== 'number' || typeof payloadTruncated !== 'boolean') {
    return null;
  }
  return { key, reason, schemaVersion, quarantinedAt, payload, payloadLength, payloadTruncated };
}

function isQuarantineReason(value: unknown): value is QuarantineReason {
  return (
    typeof value === 'string' && QUARANTINE_REASONS.some((reason): boolean => reason === value)
  );
}

export function encodeQuarantineLedger(ledger: QuarantineLedger, updatedAt: string): string {
  return encodeEnvelope(QUARANTINE_SCHEMA_VERSION, ledger, updatedAt);
}
