import { createStore } from '../createStore.js';
import { preferencesStoreConfig } from './preferencesState.js';

/**
 * The live `preferences` store.
 *
 * Separated from `preferencesState.ts` so the reducer, the selectors and `canonicalAllergies` can
 * be unit-tested in the `unit` project without React: `createStore` builds contexts and hooks, and
 * importing it drags the whole provider tree into a test that only wants to check that an
 * idempotent action returns `state` identically.
 */
export const preferencesStore = createStore(preferencesStoreConfig);
