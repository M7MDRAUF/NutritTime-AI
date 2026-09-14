import { describe, expect, it } from 'vitest';
import { QUARANTINE_KEY, decodeQuarantineLedger, encodeEnvelope } from './envelope.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_BOUNDS,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from './definitions.js';
import type { RepositoryRuntime, StorageDriver } from './repository.js';
import { callsOf, memoryDriver } from './__fixtures__/memoryDriver.js';
import { HYDRATION_KEYS, hydrateStorage, recordLaunch } from './hydrate.js';

const AT = '2026-09-13T10:00:00.000Z';
const LATER = '2026-09-14T08:30:00.000Z';

function runtimeFor(driver: StorageDriver, now: () => string = () => AT): RepositoryRuntime {
  return { driver, now };
}

function wrap(value: unknown): string {
  return encodeEnvelope(STORAGE_SCHEMA_VERSION, value, AT);
}

const GOOD_STORE: Record<string, string> = {
  [STORAGE_KEYS.meta]: wrap({ firstLaunchAt: AT, lastLaunchAt: AT }),
  [STORAGE_KEYS.onboarding]: wrap({ completed: true }),
  [STORAGE_KEYS.preferences]: wrap({ ...DEFAULT_PREFERENCES, diet: 'vegan' }),
  [STORAGE_KEYS.favorites]: wrap(['meal-a', 'meal-b']),
  [STORAGE_KEYS.customMeals]: wrap([]),
  [STORAGE_KEYS.ui]: wrap({ lastTab: 'explore', disclaimerAcknowledged: true }),
};

describe('hydration', () => {
  it('reads all six keys plus the quarantine key in ONE multiGet', async () => {
    const driver = memoryDriver(GOOD_STORE);
    await hydrateStorage(runtimeFor(driver));

    expect(driver.multiGetKeys).toHaveLength(1);
    expect(driver.multiGetKeys[0]).toEqual([...HYDRATION_KEYS]);
    expect(HYDRATION_KEYS).toHaveLength(7);
    expect(HYDRATION_KEYS).toContain(QUARANTINE_KEY);
    // No per-key getItem: six round trips at boot is the thing one multiGet replaces.
    expect(callsOf(driver, 'getItem')).toEqual([]);
  });

  it('loads every key when every key is sound', async () => {
    const snapshot = await hydrateStorage(runtimeFor(memoryDriver(GOOD_STORE)));
    expect(snapshot.recovered).toEqual([]);
    expect(snapshot.entries.preferences).toEqual({
      value: { ...DEFAULT_PREFERENCES, diet: 'vegan' },
      status: 'loaded',
    });
    expect(snapshot.entries.ui.value).toEqual({ lastTab: 'explore', disclaimerAcknowledged: true });
    expect(snapshot.entries.favorites.value).toEqual(['meal-a', 'meal-b']);
  });

  it('defaults every key on a first launch, and quarantines nothing', async () => {
    const driver = memoryDriver();
    const snapshot = await hydrateStorage(runtimeFor(driver));
    for (const entry of Object.values(snapshot.entries)) {
      expect(entry.status).toBe('default');
    }
    expect(snapshot.quarantine.records).toEqual([]);
    expect(driver.store.size).toBe(0);
  });

  /**
   * **The defect this task exists to prevent.** T-12-09's acceptance: one key's corruption never
   * affects another, and hydration never rejects.
   */
  it('decodes each key in ISOLATION: one garbage key does not take the others with it', async () => {
    const driver = memoryDriver({ ...GOOD_STORE, [STORAGE_KEYS.preferences]: '<<<garbage' });

    const snapshot = await hydrateStorage(runtimeFor(driver));

    expect(snapshot.entries.preferences).toEqual({
      value: DEFAULT_PREFERENCES,
      status: 'recovered',
    });
    expect(snapshot.recovered).toEqual(['preferences']);
    // Every other key is untouched and still loaded.
    expect(snapshot.entries.onboarding).toEqual({ value: { completed: true }, status: 'loaded' });
    expect(snapshot.entries.favorites.status).toBe('loaded');
    expect(snapshot.entries.customMeals.status).toBe('loaded');
    expect(snapshot.entries.ui.status).toBe('loaded');
    expect(snapshot.entries.meta.status).toBe('loaded');
    // PRD 13: "a corrupt entry under one key does not erase valid preferences under another".
    expect(driver.store.get(STORAGE_KEYS.favorites)).toBe(GOOD_STORE[STORAGE_KEYS.favorites]);
    expect(driver.store.has(STORAGE_KEYS.preferences)).toBe(false);
  });

  it('survives every key being corrupt at once, each for a different reason', async () => {
    const driver = memoryDriver({
      [STORAGE_KEYS.meta]: 'not json',
      [STORAGE_KEYS.onboarding]: JSON.stringify({ completed: true }),
      [STORAGE_KEYS.preferences]: encodeEnvelope(STORAGE_SCHEMA_VERSION - 2, {}, AT),
      [STORAGE_KEYS.favorites]: wrap([7]),
      [STORAGE_KEYS.customMeals]: wrap('not a list'),
      [STORAGE_KEYS.ui]: wrap({ lastTab: 'HomeTab', disclaimerAcknowledged: false }),
    });

    const snapshot = await hydrateStorage(runtimeFor(driver));

    expect(snapshot.recovered).toHaveLength(6);
    expect(snapshot.quarantine.records).toHaveLength(6);
    expect(snapshot.entries.preferences.value).toEqual(DEFAULT_PREFERENCES);
    expect(new Set(snapshot.quarantine.records.map((entry) => entry.reason))).toEqual(
      new Set(['unreadable', 'envelope-invalid', 'version-unsupported', 'schema-invalid']),
    );
  });

  it('writes the quarantine ledger ONCE for many corrupt keys', async () => {
    const writes: string[] = [];
    const driver = memoryDriver({
      [STORAGE_KEYS.favorites]: 'broken',
      [STORAGE_KEYS.customMeals]: 'broken',
      [STORAGE_KEYS.ui]: 'broken',
    });
    const spy: StorageDriver = {
      ...driver,
      setItem(key, value) {
        writes.push(key);
        return driver.setItem(key, value);
      },
    };

    await hydrateStorage(runtimeFor(spy));

    expect(writes).toEqual([QUARANTINE_KEY]);
    expect(decodeQuarantineLedger(driver.store.get(QUARANTINE_KEY) ?? null).records).toHaveLength(
      3,
    );
  });

  it('keeps the corrupt bytes in place when the ledger cannot be written', async () => {
    const driver = memoryDriver({ [STORAGE_KEYS.favorites]: 'broken' });
    driver.failOn.add('setItem');

    const snapshot = await hydrateStorage(runtimeFor(driver));

    expect(snapshot.entries.favorites.status).toBe('recovered');
    expect(driver.store.get(STORAGE_KEYS.favorites)).toBe('broken');
  });

  it('preserves an existing ledger and adds this boot’s records to the front', async () => {
    const driver = memoryDriver({ [STORAGE_KEYS.ui]: 'broken' });
    await hydrateStorage(runtimeFor(driver));
    driver.store.set(STORAGE_KEYS.favorites, 'also broken');

    const second = await hydrateStorage(runtimeFor(driver, () => LATER));

    expect(second.quarantine.records.map((entry) => entry.key)).toEqual([
      STORAGE_KEYS.favorites,
      STORAGE_KEYS.ui,
    ]);
  });

  it('truncates an over-long list on read and reports `recovered`, without quarantining', async () => {
    const over = Array.from(
      { length: STORAGE_BOUNDS.favorites + 5 },
      (_unused, i) => `meal-${String(i)}`,
    );
    const driver = memoryDriver({ [STORAGE_KEYS.favorites]: wrap(over) });

    const snapshot = await hydrateStorage(runtimeFor(driver));

    expect(snapshot.entries.favorites.status).toBe('recovered');
    expect(snapshot.entries.favorites.value).toHaveLength(STORAGE_BOUNDS.favorites);
    expect(snapshot.quarantine.records).toEqual([]);
    // The stored bytes are left alone: truncating a read is not a licence to rewrite the key.
    expect(driver.store.get(STORAGE_KEYS.favorites)).toBe(wrap(over));
  });

  it('NEVER rejects, even when the driver cannot multiGet at all', async () => {
    const driver = memoryDriver(GOOD_STORE);
    driver.failOn.add('multiGet');

    const snapshot = await hydrateStorage(runtimeFor(driver));

    for (const [name, entry] of Object.entries(snapshot.entries)) {
      expect(entry.status, name).toBe('unavailable');
    }
    // Nothing was destroyed. `unavailable` is TSD 6.3's signal not to write over the key.
    expect(driver.store.get(STORAGE_KEYS.preferences)).toBe(GOOD_STORE[STORAGE_KEYS.preferences]);
  });

  it('NEVER rejects when the ledger write fails', async () => {
    const driver = memoryDriver({ [STORAGE_KEYS.preferences]: 'broken' });
    driver.failOn.add('setItem');
    await expect(hydrateStorage(runtimeFor(driver))).resolves.toMatchObject({
      recovered: ['preferences'],
    });
    // The corrupt key is still there: the ledger write failed, so the removal must not have run.
    // Discarding the bytes after failing to record them is the one outcome worse than both.
    expect(driver.store.has(STORAGE_KEYS.preferences)).toBe(true);
  });

  it('NEVER rejects when the REMOVAL fails, with the ledger write succeeding', async () => {
    /**
     * **This is the case the previous version of this test could not reach.**
     *
     * It set `failOn` for `setItem` AND `removeItem` together - so `setItem` failed first,
     * `writeQuarantineRecords` returned `false`, and the removal branch was skipped entirely.
     * The `removeItem` line was decoration: deleting it changed nothing, while the test's name
     * claimed to cover "every write and removal too".
     *
     * Reaching the branch exposed a real rejection. The removals were built with a synchronous
     * `.map((key) => driver.removeItem(key))`, and a driver that throws synchronously threw
     * inside the callback, before `Promise.allSettled` was ever constructed. `hydrateStorage`
     * rejected, against its own stated guarantee.
     */
    const driver = memoryDriver({ [STORAGE_KEYS.preferences]: 'broken' });
    driver.failOn.add('removeItem');

    const snapshot = await hydrateStorage(runtimeFor(driver));
    expect(snapshot.recovered).toStrictEqual(['preferences']);
    // The ledger write DID succeed, which is what forces the removal branch open.
    expect(driver.store.has(QUARANTINE_KEY)).toBe(true);
    expect(snapshot.quarantine.records).toHaveLength(1);
    // And the bytes survive twice over: recorded in the ledger, and still under the key because
    // the removal failed. A driver that cannot delete is not allowed to lose data either.
    expect(driver.store.get(STORAGE_KEYS.preferences)).toBe('broken');
  });

  it('removes the corrupt key once the ledger has the bytes', async () => {
    // The positive half, so the test above cannot pass by the removal never being attempted.
    const driver = memoryDriver({ [STORAGE_KEYS.preferences]: 'broken' });
    const snapshot = await hydrateStorage(runtimeFor(driver));
    expect(snapshot.recovered).toStrictEqual(['preferences']);
    expect(driver.store.has(STORAGE_KEYS.preferences)).toBe(false);
    expect(snapshot.quarantine.records[0]?.payload).toBe('broken');
  });

  it('treats a key the driver omitted from its answer as absent rather than as an error', async () => {
    const driver = memoryDriver(GOOD_STORE);
    const partial: StorageDriver = {
      ...driver,
      multiGet: (keys) =>
        Promise.resolve(
          keys
            .filter((key) => key !== STORAGE_KEYS.ui)
            .map((key): readonly [string, string | null] => [key, driver.store.get(key) ?? null]),
        ),
    };
    const snapshot = await hydrateStorage(runtimeFor(partial));
    expect(snapshot.entries.ui.status).toBe('default');
    expect(snapshot.entries.favorites.status).toBe('loaded');
  });
});

describe('recordLaunch', () => {
  it('stamps both instants on a first launch', async () => {
    const driver = memoryDriver();
    const runtime = runtimeFor(driver);
    const snapshot = await hydrateStorage(runtime);

    await expect(recordLaunch(runtime, snapshot)).resolves.toEqual({
      firstLaunchAt: AT,
      lastLaunchAt: AT,
    });
    expect(JSON.parse(driver.store.get(STORAGE_KEYS.meta) ?? '')).toEqual({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      updatedAt: AT,
      value: { firstLaunchAt: AT, lastLaunchAt: AT },
    });
  });

  it('preserves firstLaunchAt on a later launch', async () => {
    const driver = memoryDriver(GOOD_STORE);
    const runtime = runtimeFor(driver, () => LATER);
    const snapshot = await hydrateStorage(runtime);

    await expect(recordLaunch(runtime, snapshot)).resolves.toEqual({
      firstLaunchAt: AT,
      lastLaunchAt: LATER,
    });
  });

  it('refuses to write over an `unavailable` meta key', async () => {
    // TSD 6.3. `meta` is the first key anything writes at boot, so getting this wrong would
    // reset a first-launch date on every storage hiccup.
    const driver = memoryDriver(GOOD_STORE);
    driver.failOn.add('multiGet');
    const runtime = runtimeFor(driver);
    const snapshot = await hydrateStorage(runtime);

    await expect(recordLaunch(runtime, snapshot)).resolves.toBeNull();
    expect(driver.store.get(STORAGE_KEYS.meta)).toBe(GOOD_STORE[STORAGE_KEYS.meta]);
  });

  it('never rejects when the write is refused', async () => {
    const driver = memoryDriver();
    const runtime = runtimeFor(driver);
    const snapshot = await hydrateStorage(runtime);
    driver.failOn.add('setItem');
    await expect(recordLaunch(runtime, snapshot)).resolves.toBeNull();
  });

  it('starts the first-launch instant over after meta was quarantined', async () => {
    const driver = memoryDriver({ [STORAGE_KEYS.meta]: 'broken' });
    const runtime = runtimeFor(driver, () => LATER);
    const snapshot = await hydrateStorage(runtime);
    expect(snapshot.entries.meta.status).toBe('recovered');
    await expect(recordLaunch(runtime, snapshot)).resolves.toEqual({
      firstLaunchAt: LATER,
      lastLaunchAt: LATER,
    });
  });
});
