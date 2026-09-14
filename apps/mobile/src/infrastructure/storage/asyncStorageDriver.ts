/**
 * **The only file in this repository permitted to import AsyncStorage** (TSD 2.3 rule 4, Plan
 * 12.2 rule 5). `eslint.config.mjs` carries the carve-out for this exact path, and the P12 gate
 * greps for a second importer.
 *
 * A four-method pass-through and nothing else. Every decision about envelopes, migrations,
 * quarantine and bounds lives above this seam, which is why the whole storage layer is testable
 * in the `unit` project against an in-memory object: the thing that needs a device is confined
 * to this file, and this file has no behaviour to get wrong.
 *
 * `multiGet` is the one method that does more than forward. AsyncStorage answers with mutable
 * tuples of `[string, string | null]`; `StorageDriver` promises readonly ones, so the pairs are
 * copied rather than handed over. A shared mutable array from a library is exactly the kind of
 * aliasing that turns into a bug nobody can locate.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageDriver } from './repository.js';

export const asyncStorageDriver: StorageDriver = {
  getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },

  setItem(key: string, value: string): Promise<void> {
    return AsyncStorage.setItem(key, value);
  },

  removeItem(key: string): Promise<void> {
    return AsyncStorage.removeItem(key);
  },

  async multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]> {
    const pairs = await AsyncStorage.multiGet(keys);
    return pairs.map(([key, value]): readonly [string, string | null] => [key, value ?? null]);
  },
};

/** The clock half of `RepositoryRuntime`. Separated so a test can replace it with a fixed one. */
export function systemClock(): string {
  return new Date().toISOString();
}
