/**
 * The `onboarding` store, which had **no test at all** — and P18's whole reset mechanism rests on it.
 *
 * TSD §9's traceability table names a test for FR-002; there was none, and nobody noticed because
 * the store is four lines of reducer. What those four lines decide, though, is whether a user who
 * has asked to erase their data is returned to setup: the full reset clears the `onboarding` **key**
 * and remounts, and the app goes back to onboarding only because this store then creates itself
 * from a fallback of `completed: false`. If `create` ever preferred a truthy default, "erase all
 * data" would leave the user in the app with no profile — the worst of both outcomes.
 *
 * So the assertions below are not four-lines-of-reducer assertions. Two of them are about the reset.
 */

import { describe, expect, it } from 'vitest';
import {
  onboardingActions,
  onboardingReducer,
  onboardingStoreConfig,
  selectOnboardingCompleted,
} from './onboardingState.js';
import type { OnboardingState } from './onboardingState.js';
import { STORAGE_DEFINITIONS } from '../../infrastructure/storage/definitions.js';

const NOT_COMPLETED: OnboardingState = { completed: false };
const COMPLETED: OnboardingState = { completed: true };

describe('onboardingActions', () => {
  it('names its action `slice/verb-past-tense`, per TSD §6.3 invariant 1', () => {
    expect(onboardingActions.complete().type).toBe('onboarding/completed');
  });

  it('exposes exactly one creator, because the absence of a reset is deliberate', () => {
    /**
     * `onboardingState.ts` states in as many words that there is no `onboarding/reset` action:
     * "an action that un-completes onboarding would be reachable from any screen holding a
     * dispatch, and sending a user back through setup is a destructive action that TSD §6.7 puts
     * behind a confirmation."
     *
     * That is a claim about what the module does **not** have, and a docstring cannot enforce it.
     * This does: adding a second creator fails here, so whoever adds one has to come and read the
     * reasoning before deleting this line. The `ui` store makes the same argument about
     * `disclaimerAcknowledged` for the same reason.
     */
    expect(Object.keys(onboardingActions)).toEqual(['complete']);
  });
});

describe('onboardingReducer', () => {
  it('completes onboarding, and allocates when it really changes', () => {
    const next = onboardingReducer(NOT_COMPLETED, onboardingActions.complete());

    expect(next.completed).toBe(true);
    // The control. Without it, a reducer returning `state` from every branch would satisfy the
    // identity assertion below and nothing here would object — and the new reference is what
    // queues the storage write, so suppressing it would lose the completion on the next launch.
    expect(next).not.toBe(NOT_COMPLETED);
  });

  it('returns state IDENTICALLY when onboarding is already complete', () => {
    // `toBe`, not `toEqual`: an equal-but-fresh object passes `toEqual` and is exactly the defect
    // this asserts against (TSD §6.3 invariant 3).
    expect(onboardingReducer(COMPLETED, onboardingActions.complete())).toBe(COMPLETED);
  });

  it('reads back through its selector', () => {
    expect(selectOnboardingCompleted(NOT_COMPLETED)).toBe(false);
    expect(selectOnboardingCompleted(COMPLETED)).toBe(true);
  });
});

describe('onboardingStoreConfig', () => {
  it('round-trips both states through create and project', () => {
    for (const completed of [true, false]) {
      expect(onboardingStoreConfig.project(onboardingStoreConfig.create({ completed }))).toEqual({
        completed,
      });
    }
  });

  it('projects a value the onboarding key accepts, in both states', () => {
    // Against the key's own schema rather than a restatement of it, so a shape the storage layer
    // would quarantine cannot pass here. P14's CRITICAL was a store persisting a value its own
    // schema rejected, and the next launch erasing the entry.
    for (const completed of [true, false]) {
      const projected = onboardingStoreConfig.project({ completed });
      expect(STORAGE_DEFINITIONS.onboarding.schema.safeParse(projected).success).toBe(true);
    }
  });

  it('creates NOT-completed from the key fallback, which is what a full reset relies on', () => {
    /**
     * **The reset assertion.** T-18-06 clears every key and remounts; the app returns to onboarding
     * only because hydration then finds nothing, hands this store its fallback, and the store reads
     * `completed: false`. Taken from the real definition rather than a hand-written `{}`, so the
     * fallback the app actually ships is the one under test.
     */
    const fallback = STORAGE_DEFINITIONS.onboarding.fallback();

    expect(fallback.completed).toBe(false);
    expect(onboardingStoreConfig.create(fallback).completed).toBe(false);
    expect(selectOnboardingCompleted(onboardingStoreConfig.create(fallback))).toBe(false);
  });

  it('is wired to the onboarding key, not another one', () => {
    // Cheap, and it is the one thing a rename could silently break: a config pointed at a
    // neighbouring key would read and write someone else's data, and every assertion above would
    // still pass.
    expect(onboardingStoreConfig.key).toBe('onboarding');
    expect(onboardingStoreConfig.name).toBe('onboarding');
  });
});
