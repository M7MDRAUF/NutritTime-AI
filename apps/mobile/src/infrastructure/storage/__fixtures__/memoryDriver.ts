/**
 * The in-memory `StorageDriver` that Plan 19.1 requires storage tests to use.
 *
 * It lives in `__fixtures__/` — the convention `apps/server/src/__fixtures__` already sets — so
 * that `repository.test.ts` and `hydrate.test.ts` share ONE fake. Two copies would drift, and the
 * copy that drifted would be the one making a failure-injection test pass.
 *
 * This fake is the whole justification for the driver seam: every storage vector in §19.3 runs in
 * the `unit` project, in node, with no device, no AsyncStorage and no React Native.
 */

import type { StorageDriver } from '../repository.js';

export type DriverMethod = 'getItem' | 'setItem' | 'removeItem' | 'multiGet';

export interface MemoryDriver extends StorageDriver {
  /** The bytes on the "device". Readable and writable directly, to set a scenario up. */
  readonly store: Map<string, string>;
  /** Add a method name to make it throw — the driver failing is a case the code must survive. */
  readonly failOn: Set<DriverMethod>;
  /** Every call, in order, as `method:argument`. */
  readonly calls: string[];
  /** The key list of each `multiGet`, so "exactly one, over these keys" is assertable. */
  readonly multiGetKeys: string[][];
}

export function memoryDriver(initial: Record<string, string> = {}): MemoryDriver {
  const store = new Map<string, string>(Object.entries(initial));
  const failOn = new Set<DriverMethod>();
  const calls: string[] = [];
  const multiGetKeys: string[][] = [];

  // Recorded BEFORE the failure check, so a test can prove the call was attempted and refused.
  const enter = (method: DriverMethod, argument: string): void => {
    calls.push(`${method}:${argument}`);
    if (failOn.has(method)) {
      throw new Error(`driver refused ${method}`);
    }
  };

  return {
    store,
    failOn,
    calls,
    multiGetKeys,
    getItem(key) {
      enter('getItem', key);
      return Promise.resolve(store.get(key) ?? null);
    },
    setItem(key, value) {
      enter('setItem', key);
      store.set(key, value);
      return Promise.resolve();
    },
    removeItem(key) {
      enter('removeItem', key);
      store.delete(key);
      return Promise.resolve();
    },
    multiGet(keys) {
      multiGetKeys.push([...keys]);
      enter('multiGet', keys.join(','));
      return Promise.resolve(
        keys.map((key): readonly [string, string | null] => [key, store.get(key) ?? null]),
      );
    },
  };
}

/** Calls of one method, in order — `callsOf(driver, 'setItem')` is the usual question. */
export function callsOf(driver: MemoryDriver, method: DriverMethod): string[] {
  return driver.calls
    .filter((call) => call.startsWith(`${method}:`))
    .map((call) => call.slice(method.length + 1));
}
