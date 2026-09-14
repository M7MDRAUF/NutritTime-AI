import { createStore } from '../createStore.js';
import { favoritesStoreConfig } from './favoritesState.js';

/**
 * The live `favorites` store.
 *
 * Separated from `favoritesState.ts` so the reducer and the selectors can be unit-tested in the
 * `unit` project without React: `createStore` builds contexts and hooks, and importing it drags the
 * whole provider tree into a test that only wants to check that an idempotent action returns
 * `state` identically — which is precisely the claim TSD 6.3 makes about this store, and the one
 * the suite must be able to make cheaply and exactly.
 */
export const favoritesStore = createStore(favoritesStoreConfig);
