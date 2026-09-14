import { createStore } from '../createStore.js';
import { onboardingStoreConfig } from './onboardingState.js';

/** Split from the state module for the same reason `preferences` is: a pure reducer test. */
export const onboardingStore = createStore(onboardingStoreConfig);
