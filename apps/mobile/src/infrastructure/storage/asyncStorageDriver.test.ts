import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isTimestamp } from './envelope.js';

/**
 * The real package pulls in React Native, which ships Flow-typed source esbuild cannot strip, so
 * it is unimportable in the `unit` project (see `vitest.config.mts`). The mock replaces it before
 * the driver loads, which is the point: the driver is the only thing under test here, and there
 * is nothing about AsyncStorage's own behaviour this repository is responsible for.
 *
 * `vi.hoisted` rather than a plain `const`: `vi.mock` is hoisted above the imports, so a factory
 * closing over an ordinary module-scope binding reads it in its temporal dead zone.
 */
const { backing, calls, handedBack } = vi.hoisted(() => ({
  backing: new Map<string, string>(),
  calls: [] as string[],
  handedBack: [] as unknown[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string): Promise<string | null> => {
      calls.push(`getItem:${key}`);
      return Promise.resolve(backing.get(key) ?? null);
    },
    setItem: (key: string, value: string): Promise<void> => {
      calls.push(`setItem:${key}`);
      backing.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key: string): Promise<void> => {
      calls.push(`removeItem:${key}`);
      backing.delete(key);
      return Promise.resolve();
    },
    // The real method answers with MUTABLE tuples, and with `null` for an absent key.
    multiGet: (keys: readonly string[]): Promise<[string, string | null][]> => {
      calls.push(`multiGet:${keys.join(',')}`);
      const pairs = keys.map((key): [string, string | null] => [key, backing.get(key) ?? null]);
      handedBack.push(pairs);
      return Promise.resolve(pairs);
    },
  },
}));

// A STATIC import is correct here: `vi.mock` is hoisted above every import in the file, so the
// driver loads against the mock above rather than the real package.
import { asyncStorageDriver, systemClock } from './asyncStorageDriver.js';

beforeEach(() => {
  backing.clear();
  calls.length = 0;
  handedBack.length = 0;
});

describe('asyncStorageDriver', () => {
  it('forwards each of the four methods to the package', async () => {
    await asyncStorageDriver.setItem('@k', 'v');
    await expect(asyncStorageDriver.getItem('@k')).resolves.toBe('v');
    await asyncStorageDriver.removeItem('@k');
    await expect(asyncStorageDriver.getItem('@k')).resolves.toBeNull();

    expect(calls).toEqual(['setItem:@k', 'getItem:@k', 'removeItem:@k', 'getItem:@k']);
  });

  it('answers a multiGet with one readonly pair per requested key, null for the absent ones', async () => {
    await asyncStorageDriver.setItem('@a', '1');
    const pairs = await asyncStorageDriver.multiGet(['@a', '@missing']);
    expect(pairs).toEqual([
      ['@a', '1'],
      ['@missing', null],
    ]);
  });

  it('copies the pairs rather than handing back the package’s own array', async () => {
    // A shared mutable array from a library is the kind of aliasing that turns into a bug
    // nobody can locate — and `StorageDriver` promises readonly tuples.
    const pairs = await asyncStorageDriver.multiGet(['@a']);
    expect(handedBack).toHaveLength(1);
    expect(pairs).not.toBe(handedBack[0]);
    expect(pairs).toEqual(handedBack[0]);
  });
});

describe('systemClock', () => {
  it('produces an instant the envelope decoder accepts', () => {
    expect(isTimestamp(systemClock())).toBe(true);
  });
});

/**
 * TSD 2.3 rule 4 and Plan 12.2 rule 5, proved by reading the tree from disk.
 *
 * `eslint.config.mjs` carries the other half (a `no-restricted-imports` entry with a carve-out
 * for this one path), and P12's gate asks for a grep. This is that grep, run as a test: an
 * import-based check would pass while a violating file sat right beside it, unread.
 */
describe('AsyncStorage has exactly one importer', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '..', '..');
  const driverPath = path.join(import.meta.dirname, 'asyncStorageDriver.ts');

  function typeScriptFilesUnder(directory: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        found.push(...typeScriptFilesUnder(full));
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        found.push(full);
      }
    }
    return found;
  }

  const files = typeScriptFilesUnder(sourceRoot);

  it('finds the tree it is supposed to be checking', () => {
    // Without this a wrong root would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(driverPath);
  });

  it('is imported by asyncStorageDriver.ts and by nothing else', () => {
    const importers = files.filter((file) =>
      /from\s+['"]@react-native-async-storage\/async-storage['"]/.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    expect(importers).toEqual([driverPath]);
  });

  it('is not so much as named anywhere but the driver and this test', () => {
    const mentions = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes('@react-native-async-storage'))
      .map((file) => path.relative(sourceRoot, file))
      .sort();
    expect(mentions).toEqual(
      [
        path.relative(sourceRoot, driverPath),
        path.relative(sourceRoot, path.join(import.meta.dirname, 'asyncStorageDriver.test.ts')),
      ].sort(),
    );
  });
});
