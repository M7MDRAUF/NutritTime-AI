// @vitest-environment jsdom

/**
 * Boot hydration and the quarantine ledger, against **real `localStorage`** (P22 T-22-06, TSD 6.4,
 * TSD 6.1, D-01).
 *
 * `hydrate.test.ts` proves all of this against `memoryDriver`, and `hydrate.ts` says in its own
 * comments that one of its guards "was unreachable in the app and entirely reachable through the
 * `StorageDriver` seam the tests use and P22 will use for `localStorage`". This file is that use:
 * the driver is the shipped one, unmocked, resolving to the web implementation that passes through
 * to `window.localStorage`, and every ledger assertion below is read back off the origin rather
 * than out of the snapshot the function returned.
 *
 * **Two things only a real origin can put on this path.**
 *
 *  1. The quota is shared. A corrupt key needs the ledger WRITTEN before the live key is removed
 *     (Plan 10.2's "rollback equivalent"), and on a full origin that write is refused — so the
 *     bytes must stay put. Nothing in the memory driver can produce that, because nothing there
 *     couples one key's size to another key's write.
 *  2. `localStorage` is synchronous, so a failure arrives at a different point in the same code.
 *     The claim "hydration never rejects" is about a code path, and the path is not the same one.
 *
 * `migration-failed` is the one quarantine reason the shipped definitions cannot produce — all six
 * are at schema version 1 and none declares a migration — so the five-reason table below runs
 * against a definition written for the purpose, exactly as `repository.test.ts` does and for the
 * same reason: authoring a migration for a version that never shipped would fabricate its input.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValueSchema } from '@nutritime/contracts';
import {
  QUARANTINE_REASONS,
  decodeQuarantineLedger,
  encodeEnvelope,
  isRecord,
} from './envelope.js';
import type { QuarantineReason, QuarantineRecord } from './envelope.js';
import { STORAGE_DEFINITIONS, STORAGE_KEYS, STORAGE_KEY_NAMES } from './definitions.js';
import type { StorageKeyName } from './definitions.js';
import type { RepositoryDefinition, RepositoryRuntime, StorageDriver } from './repository.js';
import { readEntry } from './repository.js';
import { HYDRATION_KEYS, hydrateStorage, recordLaunch } from './hydrate.js';
import { asyncStorageDriver } from './asyncStorageDriver.js';
import { exhaustOrigin, releaseOrigin, resetOrigin } from './__fixtures__/localStorageOrigin.js';

/** TSD 6.4, transcribed rather than imported (§6.1g): the ledger's key, and the six keys + it. */
const TSD_QUARANTINE_KEY = '@nutritime/quarantine/v1';
const TSD_HYDRATION_KEY_COUNT = 7;

const AT = '2026-09-14T09:30:00.000Z';
/** A second instant, for the one test where "the value changed" has to be true. */
const LATER = '2026-09-14T11:45:00.000Z';
const TEST_KEY = '@test/counter';

interface Counter {
  readonly count: number;
}

const counterSchema: ValueSchema<Counter> = {
  safeParse(value: unknown) {
    if (!isRecord(value) || typeof value['count'] !== 'number') {
      return { success: false };
    }
    return { success: true, data: { count: value['count'] } };
  },
};

/** A definition at version 3 with a migration from 2 — the only way to reach `migration-failed`. */
function counterDefinition(
  overrides: Partial<RepositoryDefinition<Counter>> = {},
): RepositoryDefinition<Counter> {
  return {
    key: TEST_KEY,
    schemaVersion: 3,
    schema: counterSchema,
    fallback: () => ({ count: 0 }),
    migrations: { 3: (previous: unknown) => previous },
    ...overrides,
  };
}

/**
 * The shipped driver, with `multiGet` counted at the seam.
 *
 * Every method delegates, so the origin under test is still the real one. Counting HERE rather
 * than on `window.localStorage` is deliberate: TSD 6.1's claim is "one `multiGet`", which is a
 * statement about the driver contract. The web implementation fans one `multiGet` out into one
 * `localStorage.getItem` per key internally, and that is its business, not this app's.
 */
interface CountedDriver {
  readonly driver: StorageDriver;
  readonly multiGetKeys: string[][];
}

function counted(): CountedDriver {
  const multiGetKeys: string[][] = [];
  return {
    multiGetKeys,
    driver: {
      getItem: (key) => asyncStorageDriver.getItem(key),
      setItem: (key, value) => asyncStorageDriver.setItem(key, value),
      removeItem: (key) => asyncStorageDriver.removeItem(key),
      multiGet: (keys) => {
        multiGetKeys.push([...keys]);
        return asyncStorageDriver.multiGet(keys);
      },
    },
  };
}

const runtime: RepositoryRuntime = { driver: asyncStorageDriver, now: () => AT };

function raw(key: string): string | null {
  return window.localStorage.getItem(key);
}

function seed(key: string, value: unknown, schemaVersion = 1): void {
  window.localStorage.setItem(key, encodeEnvelope(schemaVersion, value, AT));
}

/** Every key sound, written the way a previous launch would have left them. */
function seedSoundOrigin(): void {
  seed(STORAGE_KEYS.meta, { firstLaunchAt: AT, lastLaunchAt: AT });
  seed(STORAGE_KEYS.onboarding, { completed: true });
  seed(STORAGE_KEYS.preferences, STORAGE_DEFINITIONS.preferences.fallback());
  seed(STORAGE_KEYS.favorites, ['meal-1', 'meal-2']);
  seed(STORAGE_KEYS.customMeals, []);
  seed(STORAGE_KEYS.ui, { lastTab: 'home', disclaimerAcknowledged: true });
}

/** The ledger as the ORIGIN holds it — never as the returned snapshot describes it. */
function ledgerOnDisk(): readonly QuarantineRecord[] {
  return decodeQuarantineLedger(raw(TSD_QUARANTINE_KEY)).records;
}

function statusesOf(entries: {
  readonly [K in StorageKeyName]: { readonly status: string };
}): Readonly<Record<string, string>> {
  return Object.fromEntries(STORAGE_KEY_NAMES.map((name) => [name, entries[name].status]));
}

beforeEach(() => {
  resetOrigin();
});

afterEach(() => {
  releaseOrigin();
});

describe('hydration against localStorage', () => {
  it('reads the six keys plus the ledger in ONE multiGet at the driver seam', async () => {
    seedSoundOrigin();
    const { driver, multiGetKeys } = counted();

    await hydrateStorage({ driver, now: () => AT });

    expect(multiGetKeys).toHaveLength(1);
    expect(multiGetKeys[0]).toEqual([...HYDRATION_KEYS]);
    // And the list is the documented one, not whatever `HYDRATION_KEYS` happens to hold.
    expect(HYDRATION_KEYS).toHaveLength(TSD_HYDRATION_KEY_COUNT);
    expect(HYDRATION_KEYS).toContain(TSD_QUARANTINE_KEY);
  });

  it('loads every key when the origin is sound', async () => {
    seedSoundOrigin();
    const snapshot = await hydrateStorage(runtime);
    expect(statusesOf(snapshot.entries)).toEqual({
      meta: 'loaded',
      onboarding: 'loaded',
      preferences: 'loaded',
      favorites: 'loaded',
      customMeals: 'loaded',
      ui: 'loaded',
    });
    expect(snapshot.recovered).toEqual([]);
    expect(raw(TSD_QUARANTINE_KEY)).toBeNull();
  });

  it('decodes each key in ISOLATION: one corrupt key does not take the other five', async () => {
    /**
     * **The claim T-12-09 exists for, on the surface P22 delivers.** During `hydrating` the
     * protected screens are not in the navigator, so a rejected hydration is not a screen that
     * fails to load — it is an app that never leaves the splash. One corrupt key on a real origin
     * must cost exactly that key.
     */
    seedSoundOrigin();
    window.localStorage.setItem(STORAGE_KEYS.customMeals, '{"schemaVersion":1,"updated');

    const snapshot = await hydrateStorage(runtime);

    expect(statusesOf(snapshot.entries)).toEqual({
      meta: 'loaded',
      onboarding: 'loaded',
      preferences: 'loaded',
      favorites: 'loaded',
      customMeals: 'recovered',
      ui: 'loaded',
    });
    // The five survivors are the VALUES, not just the statuses: a status of `loaded` over a
    // fallback would look identical here and hand the user an empty profile.
    expect(snapshot.entries.favorites.value).toEqual(['meal-1', 'meal-2']);
    expect(snapshot.entries.onboarding.value).toEqual({ completed: true });
    expect(snapshot.recovered).toEqual(['customMeals']);
    // Their bytes are still on the origin, and only the corrupt key was removed.
    expect(raw(STORAGE_KEYS.favorites)).not.toBeNull();
    expect(raw(STORAGE_KEYS.customMeals)).toBeNull();
  });

  it('records the corrupt bytes on the origin, under the ledger key', async () => {
    seedSoundOrigin();
    window.localStorage.setItem(STORAGE_KEYS.ui, 'not json at all');

    await hydrateStorage(runtime);

    expect(ledgerOnDisk()).toEqual([
      {
        key: STORAGE_KEYS.ui,
        reason: 'unreadable',
        schemaVersion: null,
        quarantinedAt: AT,
        payload: 'not json at all',
        payloadLength: 'not json at all'.length,
        payloadTruncated: false,
      },
    ]);
  });
});

describe('all five quarantine reasons, recorded on localStorage', () => {
  it('is the whole closed set envelope.ts declares', () => {
    // So a sixth reason cannot arrive without a case below, and a deleted one fails here.
    expect([...QUARANTINE_REASONS].sort()).toEqual([
      'envelope-invalid',
      'migration-failed',
      'schema-invalid',
      'unreadable',
      'version-unsupported',
    ]);
  });

  it.each<[QuarantineReason, string, Partial<RepositoryDefinition<Counter>>]>([
    ['unreadable', '{not json', {}],
    ['envelope-invalid', JSON.stringify({ schemaVersion: 3, value: { count: 1 } }), {}],
    ['version-unsupported', encodeEnvelope(1, { count: 1 }, AT), {}],
    [
      'migration-failed',
      encodeEnvelope(2, { count: 1 }, AT),
      {
        migrations: {
          3: () => {
            throw new Error('migration exploded');
          },
        },
      },
    ],
    ['schema-invalid', encodeEnvelope(3, { count: 'one' }, AT), {}],
  ])('records `%s` in the ledger and drops the live key', async (reason, payload, overrides) => {
    // A second key, sound, carried through every case: a ledger write that clobbered the origin
    // would pass every assertion about the record it just wrote.
    seed(STORAGE_KEYS.onboarding, { completed: true });
    window.localStorage.setItem(TEST_KEY, payload);

    const entry = await readEntry(counterDefinition(overrides), runtime);

    expect(entry).toEqual({ value: { count: 0 }, status: 'recovered' });
    expect(ledgerOnDisk().map((record) => ({ key: record.key, reason: record.reason }))).toEqual([
      { key: TEST_KEY, reason },
    ]);
    // The bytes are in the ledger and the live key is gone — in that order (Plan 10.2).
    expect(ledgerOnDisk()[0]?.payload).toBe(payload);
    expect(raw(TEST_KEY)).toBeNull();
    expect(raw(STORAGE_KEYS.onboarding)).not.toBeNull();
  });
});

describe('a quota-exhausted origin at boot', () => {
  it('KEEPS the corrupt bytes when the ledger cannot be written, and still never rejects', async () => {
    /**
     * **The vector only a shared quota can produce.** `quarantine` writes the ledger first and
     * removes the live key only if that write landed, because Plan 10.2 calls the ledger the
     * rollback equivalent and a rollback to bytes that were deleted first is no rollback. On a full
     * origin the ledger write is refused — so the corrupt key must survive, to be re-quarantined at
     * a launch where there is room. Losing it here would be the one unrecoverable outcome.
     */
    seedSoundOrigin();
    const corrupt = '{"schemaVersion":1,"updatedAt":"' + AT + '","value":"not a ui record"}';
    window.localStorage.setItem(STORAGE_KEYS.ui, corrupt);
    exhaustOrigin(0);

    const snapshot = await hydrateStorage(runtime);

    expect(snapshot.entries.ui.status).toBe('recovered');
    expect(snapshot.entries.preferences.status).toBe('loaded');
    // Nothing was recorded, so nothing was destroyed.
    expect(raw(TSD_QUARANTINE_KEY)).toBeNull();
    expect(raw(STORAGE_KEYS.ui)).toBe(corrupt);
  });

  it('removes the corrupt key once there IS room, so the case above is not a stuck state', async () => {
    // The control for it: the same corruption, the same origin, with the quota released.
    seedSoundOrigin();
    window.localStorage.setItem(STORAGE_KEYS.ui, 'not json at all');

    await hydrateStorage(runtime);

    expect(ledgerOnDisk()).toHaveLength(1);
    expect(raw(STORAGE_KEYS.ui)).toBeNull();
  });

  it('returns null from recordLaunch rather than failing the boot', async () => {
    /**
     * `meta` is the first key anything writes at boot, so a throw here is an app that does not
     * start.
     *
     * **A full origin refuses a write that GROWS it, and nothing else** — and getting that wrong is
     * how this test passed twice while proving nothing. Storage's `setItem` returns early when the
     * new value equals the old one, before any quota check; and the check itself compares the
     * origin's new total against the quota, so a replacement of the same LENGTH also fits. Two
     * earlier versions of this test wrote `meta` back at the same length (same clock, then a second
     * ISO instant, which is the same number of characters) and were accepted for exactly that
     * reason. So `meta` is seeded EMPTY here: two nulls becoming two instants is the growth that a
     * full origin has to refuse.
     */
    seedSoundOrigin();
    seed(STORAGE_KEYS.meta, { firstLaunchAt: null, lastLaunchAt: null });
    const snapshot = await hydrateStorage(runtime);
    const before = raw(STORAGE_KEYS.meta);
    exhaustOrigin(0);
    const nextLaunch: RepositoryRuntime = { driver: asyncStorageDriver, now: () => LATER };

    await expect(recordLaunch(nextLaunch, snapshot)).resolves.toBeNull();
    expect(raw(STORAGE_KEYS.meta)).toBe(before);
  });

  it('stamps meta when there IS room, so the null above is not the only outcome', async () => {
    const snapshot = await hydrateStorage(runtime);
    await expect(recordLaunch(runtime, snapshot)).resolves.toEqual({
      firstLaunchAt: AT,
      lastLaunchAt: AT,
    });
    expect(raw(STORAGE_KEYS.meta)).not.toBeNull();
  });
});
