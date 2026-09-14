/**
 * The `ui` store's state, actions, reducer and selectors (T-18-01).
 *
 * **Both fields are plan-introduced.** `TSD §6.3` names `ui` as one of the five stores and says
 * nothing about what it holds; `Plan.md` records `lastTab` and the disclaimer flag under **A-09**,
 * "some implementation symbols are named by this plan, not by the documents". So no document fixes
 * the contents of this key — the plan does, and T-18-01's acceptance is only that the two values
 * *persist*. The stored shape itself is already authored in
 * `infrastructure/storage/definitions.ts` (`StoredUi`, `UI_TABS`, `DEFAULT_UI`) and is imported
 * here rather than restated: a second copy of the tab list is a second thing to forget.
 *
 * **`ui/tabChanged` to the tab already stored returns `state` identically, and that is load-bearing
 * rather than cosmetic.** `createStore`'s projection effect is keyed on `state`, so a fresh object
 * reference — even one with equal contents — puts a value on the write queue. Without this branch
 * every tab press would queue a storage write, and navigation would drive the disk. TSD §6.3's
 * third invariant is what keeps navigation off the write queue.
 *
 * `lastTab` is a **logical** tab id, never a React Navigation route name. `definitions.ts` gives
 * the reason; it is not re-derived here.
 */

import type { UiTab } from '../../infrastructure/storage/definitions.js';
import type { StoreConfig } from '../createStore.js';

export interface UiState {
  readonly lastTab: UiTab | null;
  readonly disclaimerAcknowledged: boolean;
}

export type UiAction =
  | { readonly type: 'ui/tabChanged'; readonly tab: UiTab }
  | { readonly type: 'ui/disclaimerAcknowledged' };

export const uiActions = {
  changeTab: (tab: UiTab): UiAction => ({ type: 'ui/tabChanged', tab }),
  acknowledgeDisclaimer: (): UiAction => ({ type: 'ui/disclaimerAcknowledged' }),
};

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'ui/tabChanged': {
      // Reference-preserving, and here it is the difference between one write per real tab change
      // and one write per tab press. See the module docstring.
      if (state.lastTab === action.tab) {
        return state;
      }
      return { ...state, lastTab: action.tab };
    }
    case 'ui/disclaimerAcknowledged': {
      if (state.disclaimerAcknowledged) {
        return state;
      }
      return { ...state, disclaimerAcknowledged: true };
    }
  }
}

export function selectLastTab(state: UiState): UiTab | null {
  return state.lastTab;
}

/**
 * **There is no `ui/cleared` action, and that is deliberate — it is not missing.**
 *
 * An agent building `SettingsScreen` will look for one. The answer is the argument
 * `onboardingState.ts` makes for itself, applied to a safety control: P18's full reset clears the
 * KEY through its repository and remounts the storage subtree, so every store re-creates from its
 * fallback. A reducer action that un-acknowledged the disclaimer would instead be reachable from
 * any screen holding a dispatch, and PRD FR-014 puts destroying local data behind a confirmation —
 * a confirmation an arbitrary screen's dispatch would bypass. Un-acknowledging a safety disclaimer
 * is exactly the decision that must not be one dispatch away.
 *
 * Selective clears (T-18-05) are dispatches because losing favourites is recoverable. This is not.
 */
export function selectDisclaimerAcknowledged(state: UiState): boolean {
  return state.disclaimerAcknowledged;
}

export const uiStoreConfig = {
  name: 'ui',
  key: 'ui',
  create: (persisted) => ({
    lastTab: persisted.lastTab,
    disclaimerAcknowledged: persisted.disclaimerAcknowledged,
  }),
  reducer: uiReducer,
  project: (state) => ({
    lastTab: state.lastTab,
    disclaimerAcknowledged: state.disclaimerAcknowledged,
  }),
} satisfies StoreConfig<'ui', UiState, UiAction>;
