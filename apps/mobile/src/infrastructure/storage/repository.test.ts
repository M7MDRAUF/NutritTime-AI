import { beforeEach, describe, expect, it } from 'vitest';
import type { ValueSchema } from '@nutritime/contracts';
import { QUARANTINE_KEY, decodeQuarantineLedger, encodeEnvelope, isRecord } from './envelope.js';
import type { QuarantineReason } from './envelope.js';
import {
  StorageWriteError,
  classifyEntry,
  createRepository,
  isStorageWriteError,
  readEntry,
} from './repository.js';
import type { RepositoryDefinition, RepositoryRuntime, StorageDriver } from './repository.js';
import { memoryDriver } from './__fixtures__/memoryDriver.js';
import type { MemoryDriver } from './__fixtures__/memoryDriver.js';

const AT = '2026-09-13T10:00:00.000Z';
const KEY = '@test/counter';

function runtimeFor(driver: StorageDriver): RepositoryRuntime {
  return { driver, now: () => AT };
}

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

/**
 * A definition at version 3 with a migration FROM version 2.
 *
 * The shipped definitions are all at version 1 (nothing has ever been stored by an earlier
 * build), so the migration gate has to be proved against a definition written for the purpose.
 * Authoring a migration for a version that never shipped would be fabricating its input.
 */
function counterDefinition(
  overrides: Partial<RepositoryDefinition<Counter>> = {},
): RepositoryDefinition<Counter> {
  const base: RepositoryDefinition<Counter> = {
    key: KEY,
    schemaVersion: 3,
    schema: counterSchema,
    fallback: () => ({ count: 0 }),
    migrations: { 3: (previous: unknown) => previous },
  };
  return { ...base, ...overrides };
}

function stored(schemaVersion: number, value: unknown): string {
  return encodeEnvelope(schemaVersion, value, AT);
}

async function ledgerOf(
  driver: MemoryDriver,
): Promise<readonly { key: string; reason: QuarantineReason }[]> {
  const raw = driver.store.get(QUARANTINE_KEY) ?? null;
  return decodeQuarantineLedger(raw).records.map((entry) => ({
    key: entry.key,
    reason: entry.reason,
  }));
}

describe('the read path', () => {
  it('returns the stored value with status `loaded`', async () => {
    const driver = memoryDriver({ [KEY]: stored(3, { count: 7 }) });
    await expect(readEntry(counterDefinition(), runtimeFor(driver))).resolves.toEqual({
      value: { count: 7 },
      status: 'loaded',
    });
  });

  it('returns the fallback with status `default` when nothing is stored', async () => {
    const driver = memoryDriver();
    await expect(readEntry(counterDefinition(), runtimeFor(driver))).resolves.toEqual({
      value: { count: 0 },
      status: 'default',
    });
    // Nothing was quarantined: an absent key is not corruption.
    expect(driver.store.has(QUARANTINE_KEY)).toBe(false);
  });

  it('returns status `unavailable` — not `default` — when the driver itself fails', async () => {
    // The distinction is load-bearing: TSD 6.3 forbids a store writing over an `unavailable`
    // key, because the record may be perfectly fine and merely unreadable this once.
    const driver = memoryDriver({ [KEY]: stored(3, { count: 7 }) });
    driver.failOn.add('getItem');
    await expect(readEntry(counterDefinition(), runtimeFor(driver))).resolves.toEqual({
      value: { count: 0 },
      status: 'unavailable',
    });
    expect(driver.store.get(KEY)).toBeDefined();
  });
});

describe('the five quarantine reasons', () => {
  let driver: MemoryDriver;

  beforeEach(() => {
    driver = memoryDriver();
  });

  it.each<[QuarantineReason, string, Partial<RepositoryDefinition<Counter>>]>([
    ['unreadable', 'not json at all', {}],
    ['envelope-invalid', JSON.stringify({ count: 7 }), {}],
    ['version-unsupported', stored(1, { count: 7 }), {}],
    [
      'migration-failed',
      stored(2, { count: 7 }),
      {
        migrations: {
          3: () => {
            throw new Error('migration exploded');
          },
        },
      },
    ],
    ['schema-invalid', stored(3, { count: 'seven' }), {}],
  ])('quarantines with reason `%s`', async (reason, raw, overrides) => {
    driver.store.set(KEY, raw);
    const definition = counterDefinition(overrides);

    const entry = await readEntry(definition, runtimeFor(driver));

    expect(entry).toEqual({ value: { count: 0 }, status: 'recovered' });
    expect(await ledgerOf(driver)).toEqual([{ key: KEY, reason }]);
    // The live key is gone; the bytes are not.
    expect(driver.store.has(KEY)).toBe(false);
    expect(
      decodeQuarantineLedger(driver.store.get(QUARANTINE_KEY) ?? null).records[0]?.payload,
    ).toBe(raw);
  });

  it('keeps the live key when the ledger could not be written', async () => {
    // Removing first and failing to record is how the "rollback equivalent" (Plan 10.2) loses
    // the only copy of the bytes.
    driver.store.set(KEY, 'not json at all');
    driver.failOn.add('setItem');

    const entry = await readEntry(counterDefinition(), runtimeFor(driver));

    expect(entry.status).toBe('recovered');
    expect(driver.store.get(KEY)).toBe('not json at all');
  });

  it('does not reject when quarantine bookkeeping fails entirely', async () => {
    driver.store.set(KEY, 'not json at all');
    driver.failOn.add('setItem');
    driver.failOn.add('removeItem');
    await expect(readEntry(counterDefinition(), runtimeFor(driver))).resolves.toMatchObject({
      status: 'recovered',
    });
  });
});

describe('the migration gate', () => {
  // §19.3 storage vector 3, and T-12-07's acceptance criterion.
  it('accepts schemaVersion − 1 and runs the migration for the current version', async () => {
    const driver = memoryDriver({ [KEY]: stored(2, { legacy: 7 }) });
    const definition = counterDefinition({
      migrations: { 3: (previous: unknown) => ({ count: readLegacy(previous) }) },
    });

    await expect(readEntry(definition, runtimeFor(driver))).resolves.toEqual({
      value: { count: 7 },
      status: 'loaded',
    });
    expect(await ledgerOf(driver)).toEqual([]);
  });

  it('refuses schemaVersion − 2 and quarantines instead of guessing', async () => {
    const driver = memoryDriver({ [KEY]: stored(1, { count: 7 }) });
    const entry = await readEntry(counterDefinition(), runtimeFor(driver));
    expect(entry.status).toBe('recovered');
    expect(await ledgerOf(driver)).toEqual([{ key: KEY, reason: 'version-unsupported' }]);
  });

  it('refuses schemaVersion − 1 when no migration for the current version exists', async () => {
    const driver = memoryDriver({ [KEY]: stored(2, { count: 7 }) });
    const definition = counterDefinition({ migrations: undefined });
    expect(classifyEntry(definition, stored(2, { count: 7 }))).toEqual({
      kind: 'corrupt',
      corrupt: { reason: 'version-unsupported', schemaVersion: 2 },
    });
    await expect(readEntry(definition, runtimeFor(driver))).resolves.toMatchObject({
      status: 'recovered',
    });
  });

  it('refuses a version AHEAD of this build', async () => {
    // A downgraded app cannot know what a newer record added, and dropping the unknown fields
    // silently is the data loss the gate exists to refuse.
    const driver = memoryDriver({ [KEY]: stored(4, { count: 7 }) });
    await expect(readEntry(counterDefinition(), runtimeFor(driver))).resolves.toMatchObject({
      status: 'recovered',
    });
    expect(await ledgerOf(driver)).toEqual([{ key: KEY, reason: 'version-unsupported' }]);
  });

  it('validates a migrated value with the same schema as a current one', async () => {
    const driver = memoryDriver({ [KEY]: stored(2, { count: 7 }) });
    const definition = counterDefinition({ migrations: { 3: () => ({ count: 'seven' }) } });
    await expect(readEntry(definition, runtimeFor(driver))).resolves.toMatchObject({
      status: 'recovered',
    });
    expect(await ledgerOf(driver)).toEqual([{ key: KEY, reason: 'schema-invalid' }]);
  });
});

function readLegacy(previous: unknown): number {
  return isRecord(previous) && typeof previous['legacy'] === 'number' ? previous['legacy'] : 0;
}

describe('bounds', () => {
  const listSchema: ValueSchema<readonly string[]> = {
    safeParse(value: unknown) {
      if (!Array.isArray(value)) {
        return { success: false };
      }
      const items: readonly unknown[] = value;
      return items.every((item) => typeof item === 'string')
        ? { success: true, data: items.filter((item): item is string => typeof item === 'string') }
        : { success: false };
    },
  };
  const listDefinition: RepositoryDefinition<readonly string[]> = {
    key: '@test/list',
    schemaVersion: 1,
    schema: listSchema,
    fallback: () => [],
    bound: (value) => (value.length <= 3 ? value : value.slice(0, 3)),
  };

  // §19.3 storage vector 4, both halves.
  it('REFUSES a write past the bound, with no retry to offer', async () => {
    const driver = memoryDriver();
    const repository = createRepository(listDefinition, runtimeFor(driver));

    await expect(repository.set(['a', 'b', 'c', 'd'])).rejects.toBeInstanceOf(StorageWriteError);
    // Nothing was written: a refusal that half-saved would be worse than either outcome.
    expect(driver.store.has('@test/list')).toBe(false);

    const error = await repository.set(['a', 'b', 'c', 'd']).catch((value: unknown) => value);
    expect(isStorageWriteError(error) && error.reason).toBe('bound-exceeded');
    expect(isStorageWriteError(error) && error.key).toBe('@test/list');
  });

  it('accepts a write exactly at the bound', async () => {
    const driver = memoryDriver();
    await createRepository(listDefinition, runtimeFor(driver)).set(['a', 'b', 'c']);
    expect(driver.store.has('@test/list')).toBe(true);
  });

  it('TRUNCATES on read and reports `recovered`', async () => {
    // Refusing here instead would make an over-long entry permanently unreadable.
    const driver = memoryDriver({ '@test/list': stored(1, ['a', 'b', 'c', 'd', 'e']) });
    await expect(readEntry(listDefinition, runtimeFor(driver))).resolves.toEqual({
      value: ['a', 'b', 'c'],
      status: 'recovered',
    });
    // Truncation is not corruption: nothing is quarantined and the stored bytes stay put.
    expect(driver.store.has(QUARANTINE_KEY)).toBe(false);
  });

  it('reports `loaded` for a stored list within the bound', async () => {
    const driver = memoryDriver({ '@test/list': stored(1, ['a']) });
    await expect(readEntry(listDefinition, runtimeFor(driver))).resolves.toEqual({
      value: ['a'],
      status: 'loaded',
    });
  });
});

describe('writes', () => {
  it('wraps the value in an envelope carrying the definition version and the clock', async () => {
    const driver = memoryDriver();
    await createRepository(counterDefinition(), runtimeFor(driver)).set({ count: 4 });
    expect(JSON.parse(driver.store.get(KEY) ?? '')).toEqual({
      schemaVersion: 3,
      updatedAt: AT,
      value: { count: 4 },
    });
  });

  it('maps a driver failure to `write-failed`, with no driver text in the message', async () => {
    const driver = memoryDriver();
    driver.failOn.add('setItem');
    const error = await createRepository(counterDefinition(), runtimeFor(driver))
      .set({ count: 4 })
      .catch((value: unknown) => value);

    expect(isStorageWriteError(error)).toBe(true);
    expect(isStorageWriteError(error) && error.reason).toBe('write-failed');
    // The driver said "driver refused setItem". A driver message can quote the payload, and the
    // payload is the user's own data (PRD 10.3).
    expect(isStorageWriteError(error) && error.message).toBe('That change could not be saved.');
  });

  it('maps an unserialisable value to `write-failed` rather than throwing a TypeError', async () => {
    interface Cyclic {
      self?: Cyclic;
    }
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const definition: RepositoryDefinition<Cyclic> = {
      key: '@test/cyclic',
      schemaVersion: 1,
      // Never consulted: `set` does not re-validate (see `createRepository`).
      schema: { safeParse: () => ({ success: false }) },
      fallback: () => ({}),
    };
    const error = await createRepository(definition, runtimeFor(memoryDriver()))
      .set(cyclic)
      .catch((value: unknown) => value);
    expect(isStorageWriteError(error) && error.reason).toBe('write-failed');
  });

  it('clears a key, and maps a failed clear to `write-failed`', async () => {
    const driver = memoryDriver({ [KEY]: stored(3, { count: 1 }) });
    const repository = createRepository(counterDefinition(), runtimeFor(driver));
    await repository.clear();
    expect(driver.store.has(KEY)).toBe(false);

    driver.failOn.add('removeItem');
    await expect(repository.clear()).rejects.toBeInstanceOf(StorageWriteError);
  });

  it('reads back what it wrote', async () => {
    const driver = memoryDriver();
    const repository = createRepository(counterDefinition(), runtimeFor(driver));
    await repository.set({ count: 12 });
    await expect(repository.get()).resolves.toEqual({ count: 12 });
  });
});
