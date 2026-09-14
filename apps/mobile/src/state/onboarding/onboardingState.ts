/**
 * The `onboarding` store (T-14-02): one boolean, and the reason it is its own key.
 *
 * It could have lived on `preferences`. It does not, because the two have different failure
 * consequences: a quarantined `preferences` key should send the user back through setup, and a
 * quarantined `onboarding` key should too — but a quarantined `preferences` key must NOT be able to
 * claim onboarding was completed, which is what a single key would allow. Separate keys mean the
 * conservative answer ("not completed") survives either one failing.
 */

import type { StoreConfig } from '../createStore.js';

export interface OnboardingState {
  readonly completed: boolean;
}

export type OnboardingAction = { readonly type: 'onboarding/completed' };

export const onboardingActions = {
  complete: (): OnboardingAction => ({ type: 'onboarding/completed' }),
};

export function onboardingReducer(
  state: OnboardingState,
  action: OnboardingAction,
): OnboardingState {
  switch (action.type) {
    case 'onboarding/completed': {
      // Reference-preserving: completing an already-completed onboarding writes nothing and
      // re-renders nothing (TSD 6.3 invariant 3).
      if (state.completed) {
        return state;
      }
      return { completed: true };
    }
  }
}

/**
 * **There is no `onboarding/reset` action, and that is deliberate.**
 *
 * P18's full reset clears the KEY through its repository rather than dispatching a reset here: an
 * action that un-completes onboarding would be reachable from any screen holding a dispatch, and
 * sending a user back through setup is a destructive action that TSD 6.7 puts behind a confirmation.
 */
export function selectOnboardingCompleted(state: OnboardingState): boolean {
  return state.completed;
}

export const onboardingStoreConfig = {
  name: 'onboarding',
  key: 'onboarding',
  create: (persisted) => ({ completed: persisted.completed }),
  reducer: onboardingReducer,
  project: (state) => ({ completed: state.completed }),
} satisfies StoreConfig<'onboarding', OnboardingState, OnboardingAction>;
