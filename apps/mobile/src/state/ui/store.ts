import { createStore } from '../createStore.js';
import { uiStoreConfig } from './uiState.js';

/** Split from the state module for the same reason `onboarding` is: a pure reducer test. */
export const uiStore = createStore(uiStoreConfig);
