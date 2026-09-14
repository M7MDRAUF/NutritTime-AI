import { createStore } from '../createStore.js';
import { customMealsStoreConfig } from './customMealsState.js';

/**
 * The live `customMeals` store.
 *
 * Split from `customMealsState.ts` for the same reason `preferences` and `onboarding` are:
 * `createStore` builds contexts and hooks, so importing it drags the whole provider tree into a
 * test that only wants to prove an idempotent action returns `state` identically. That test runs in
 * the `unit` project, where React is not available at all.
 */
export const customMealsStore = createStore(customMealsStoreConfig);
