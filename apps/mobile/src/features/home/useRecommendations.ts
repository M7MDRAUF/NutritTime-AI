/**
 * Home's data hook: the meal period, the request, and FR-003's invalidation (T-15-01, T-15-02).
 *
 * **Two things here are safety behaviour rather than UI behaviour.**
 *
 * 1. **FR-003 — changing an allergy discards what is on screen.** The effect is keyed on
 *    `allergiesRevision`, and on a change it sets the state back to `pending` *before* the request
 *    goes out. That ordering is the whole requirement: clearing after the response arrives would
 *    leave meals the user has just said they cannot eat on screen for the length of a round trip,
 *    and if the request failed they would stay there indefinitely.
 *
 * 2. **The period is computed here, on the device, and the server holds no clock** (TSD §5.4).
 *    `shared/mealPeriodNow.ts` wraps the domain's `mealPeriodForDate`, and **the assistant uses
 *    the same module as of P28**, so Home and the assistant cannot disagree about what time it
 *    is. That sentence used to sit here as a claim about a shared function the assistant did not
 *    actually call — it was never sent a period at all — which is why `chatRequestSchema` gained
 *    `mealPeriod` and this guard moved out of this file. The period is still returned separately
 *    from the request state so the screen can render it before anything resolves, which
 *    T-15-01's acceptance requires *with the server down*.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { mealPeriodNow } from '../../shared/mealPeriodNow.js';
import type { MealPeriod, Recommendation } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import type { RecommendationRequest } from '../../infrastructure/api/routes.js';
import type { PreferencesState } from '../../state/preferences/index.js';
import { selectRequestPreferences } from '../../state/preferences/index.js';

/** PRD §10.1's two thresholds. Below the first, a spinner is flicker rather than feedback. */
export const LOADING_AFTER_MS = 200;
export const AI_PROGRESS_AFTER_MS = 2_000;

export type RecommendationsState =
  /** In flight, or discarded and about to be. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'loaded'; readonly recommendations: readonly Recommendation[] }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed' };

export interface UseRecommendationsOptions {
  readonly client: ApiClient;
  readonly preferences: PreferencesState;
  readonly favoriteMealIds: readonly string[];
  /** Injected so a test fixes the time instead of asking the machine what it is. */
  readonly now?: () => Date;
  /**
   * Bumped by the caller when the screen regains focus.
   *
   * A number rather than a callback, because the hook needs to RECOMPUTE rather than be told: any
   * change re-reads the clock. `HomeScreen` drives it from `useFocusEffect`, which needs a route
   * context this hook must not require.
   */
  readonly focusEpoch?: number;
}

export interface UseRecommendationsResult {
  /** Available on the first render, before any request. T-15-01. */
  readonly mealPeriod: MealPeriod;
  readonly state: RecommendationsState;
  /** True once the request has been in flight past PRD §10.1's first threshold. */
  readonly showLoading: boolean;
  /** True once it has been in flight past the second, and AI was asked for. */
  readonly showAiProgress: boolean;
  /**
   * Ask again.
   *
   * **Home had no way to retry at all**, which PRD §12's "what to do next" requires and PRD §10.1
   * explicitly anticipates: "the first request after a restart may legitimately fail and then
   * recover on its own". Home is a tab screen and is never unmounted, so returning to the tab
   * re-ran nothing — the only way out was to change a preference or restart the app.
   *
   * A nonce rather than calling the request function directly, so the retry goes through the same
   * effect as every other trigger and inherits its generation guard and its abort.
   */
  readonly reload: () => void;
}

function stateForError(error: unknown): RecommendationsState {
  if (isApiClientError(error) && (error.kind === 'unreachable' || error.kind === 'timeout')) {
    return { kind: 'unreachable' };
  }
  return { kind: 'failed' };
}

export function useRecommendations({
  client,
  preferences,
  favoriteMealIds,
  now = () => new Date(),
  focusEpoch = 0,
}: UseRecommendationsOptions): UseRecommendationsResult {
  /**
   * The period, computed before anything else happens.
   *
   * Recomputed when the user's anchors change, and NOT on a timer: a screen that re-classified
   * itself every minute would swap the user's recommendations out from under them mid-read at
   * 10:30. A remount is when the time is re-read, which is when the user came back to the screen.
   */
  /**
   * When the clock is re-read.
   *
   * **The first version memoised on `mealTimes` alone and defended it with a comment that was
   * simply wrong**: "A remount is when the time is re-read, which is when the user came back to
   * the screen." A bottom-tab screen is NOT remounted on re-focus — `TabNavigator` sets no
   * `unmountOnBlur` — so the period was frozen for the life of the process. An app opened at 12:00
   * and resumed at 20:00 still said "Lunch" and still recommended lunch, which is the exact
   * opposite of P15's objective and of PRD FR-004.
   *
   * So it is re-read on the two events that mean "the user is looking at this now": the screen
   * gaining focus, and the app returning to the foreground. Not on a timer — a screen that
   * reclassified itself every minute would swap the list out from under someone reading it at
   * 10:30, which is the case the original comment was right to guard against.
   */
  const [resumeEpoch, setResumeEpoch] = useState(0);

  useEffect(() => {
    // The resume half lives here because `AppState` needs no navigation context. The FOCUS half is
    // `HomeScreen`'s, through `useFocusEffect`, which requires a route — keeping it out of this
    // hook is what lets the hook and the screen be tested without mounting a navigator.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        setResumeEpoch((current) => current + 1);
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);

  const mealTimes = preferences.preferences.mealTimes;
  const mealPeriod = useMemo(
    /**
     * **Guarded, because `mealPeriodForDate` THROWS** — the guard itself now lives in
     * `shared/mealPeriodNow.ts`, shared with the assistant.
     *
     * `parseClockTime` raises `RangeError` on anything that is not zero-padded `HH:mm`, this runs
     * during render, and there is no error boundary anywhere in the app — so one unparseable stored
     * anchor unmounted the whole tree. The store now refuses such a value, which is the real fix;
     * this is the second line, because the store is not the only way a value can arrive (a
     * migration, a restored backup, a future import) and a crash is the worst possible response.
     *
     * `snack` is the fallback for the same reason TSD §4.3 makes it the default: it is the period
     * that claims least. Showing "Something small" is a mild inaccuracy; showing nothing at all
     * would break T-15-01's guarantee that the period renders before any request.
     */
    // The guard moved to `shared/mealPeriodNow.ts` at P28 so the ASSISTANT could share it - the
    // claim above, that Home and the assistant cannot disagree about the time, was aspirational
    // until then. The reasoning lives there now; the behaviour is unchanged.
    () => mealPeriodNow(now(), mealTimes),
    // `clockEpoch` is what makes this recompute on focus and on resume; `now` is deliberately
    // excluded, because including it would recompute on every render for a caller that passes an
    // inline arrow, which is every caller. **Nothing lints this** —
    // `react-hooks/exhaustive-deps` is not registered in `eslint.config.mjs` (R-46), so these
    // arrays are reviewed by hand — and M-6 is what a hand review getting it wrong looks like.
    [mealTimes, resumeEpoch, focusEpoch],
  );

  const [state, setState] = useState<RecommendationsState>({ kind: 'pending' });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);
  const [showLoading, setShowLoading] = useState(false);
  const [showAiProgress, setShowAiProgress] = useState(false);
  const generation = useRef(0);

  const { aiEnabled } = preferences.preferences;
  const requestPreferences = selectRequestPreferences(preferences);
  const allergiesRevision = preferences.allergiesRevision;

  // Primitive dependencies, so the effect does not re-run on every parent render. The five
  // preference fields are compared by their serialised form for the same reason.
  const preferenceKey = JSON.stringify(requestPreferences);
  const favoritesKey = favoriteMealIds.join(' ');

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    /**
     * **FR-003: discard first, ask second.**
     *
     * `setState({ kind: 'pending' })` runs synchronously at the top of the effect, so a change to
     * the allergy list takes the current meals off the screen in the same commit that starts the
     * new request. Doing it in the response handler instead would leave a peanut meal visible to
     * someone who has just declared a peanut allergy for as long as the round trip takes — and for
     * ever, if it failed.
     */
    setState({ kind: 'pending' });
    setShowLoading(false);
    setShowAiProgress(false);

    const controller = new AbortController();
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, LOADING_AFTER_MS);
    const aiTimer = aiEnabled
      ? setTimeout(() => {
          setShowAiProgress(true);
        }, AI_PROGRESS_AFTER_MS)
      : undefined;

    const request: RecommendationRequest = {
      mealPeriod,
      aiEnabled,
      preferences: requestPreferences,
      favoriteMealIds,
    };

    void (async () => {
      try {
        const response = await client.recommend(request, controller.signal);
        if (generation.current !== mine) {
          return;
        }
        setState({ kind: 'loaded', recommendations: response.recommendations });
      } catch (error) {
        // Same pair of guards as Explore, and for the same reason: `abort()` cannot un-resolve a
        // continuation that is already queued, so the generation check is what makes a superseded
        // response unrenderable. Here it matters more — the stale set may contain an allergen.
        if (generation.current !== mine || controller.signal.aborted) {
          return;
        }
        setState(stateForError(error));
      } finally {
        if (generation.current === mine) {
          setShowLoading(false);
          setShowAiProgress(false);
        }
      }
    })();

    return () => {
      clearTimeout(loadingTimer);
      if (aiTimer !== undefined) {
        clearTimeout(aiTimer);
      }
      controller.abort();
    };
    // `allergiesRevision` is in the list although nothing in the body reads it: it IS the FR-003
    // trigger, and a change to it must re-run this effect even when the serialised preferences
    // happen to look the same to `JSON.stringify`. A dependency-array linter would flag it as
    // unnecessary and be wrong; none is configured here, which cuts both ways.
  }, [client, mealPeriod, aiEnabled, preferenceKey, favoritesKey, allergiesRevision, nonce]);

  return { mealPeriod, state, showLoading, showAiProgress, reload };
}
