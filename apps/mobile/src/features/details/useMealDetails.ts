/**
 * Meal Details' data lane: one request per meal id, and five states (T-16-02, T-16-06).
 *
 * **Why this is a hook of its own, and why it has two guards rather than one.** Explore's
 * `useMealSearch` already wrote the reasoning out in full and it applies here unchanged:
 *
 *  1. **`AbortController`** — cancels the in-flight request, which is what stops the work and
 *     frees the socket. It does NOT stop a response that already arrived: by the time `abort()`
 *     runs, a resolved promise's continuation may already be queued as a microtask.
 *  2. **A generation counter** — the commit is refused unless the response belongs to the newest
 *     request. This is the guard that actually makes a stale render impossible, and it is why an
 *     abort alone would be a false sense of security.
 *
 * Both are asserted by the suite, **including the case where a response arrives after its abort**.
 * The consequence of getting it wrong is worse on this screen than on Explore: a stale response
 * would render one meal's name and photograph above another meal's ingredients and allergen
 * notice, which on a screen a user consults about an allergy is a wrong safety answer, not a
 * cosmetic glitch.
 *
 * **Three decisions this module encodes, each from a document rather than from taste:**
 *
 * - **`notFound` is its own state, and it comes from the status.** TSD §6.8 lists "not-found" for
 *   this screen beside "loading" and "local-only", and PRD FR-005 says "A request for an unknown
 *   meal is a 404, not an empty success". A user who followed a stale link needs to be told the
 *   meal is gone; folding it into `failed` would tell them the app is broken and invite a retry
 *   that can never succeed.
 * - **`unreachable` is not an error.** It is PRD §12's "local-only": the app works, the machine
 *   running the server does not. Calling a 500 "offline" — or a missing server "broken" — is the
 *   comfortable lie that stops a real problem being reported.
 * - **`loading` is set synchronously at the top of the effect.** Clearing in the response handler
 *   instead would leave the previous meal on screen under the new id for a whole round trip, and
 *   for ever if the request failed. That is the same defect class FR-003 forbids on Home, where a
 *   recommendation surviving an allergy change is the failure this project exists to prevent.
 */

import { useEffect, useRef, useState } from 'react';
import type { Meal } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';

export type MealDetailsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly meal: Meal }
  /** The server answered 404 — this meal id does not exist. TSD §6.8's "not-found". */
  | { readonly kind: 'notFound' }
  /** The server could not be reached. PRD §12's "local-only" — not an error to the user. */
  | { readonly kind: 'unreachable' }
  /** Reached, and it refused or answered something unusable. */
  | { readonly kind: 'failed' };

export interface UseMealDetailsOptions {
  readonly client: ApiClient;
  readonly mealId: string;
  /** Bumped to re-request the same id. The retry affordance drives this. */
  readonly nonce?: number;
}

/**
 * HTTP 404 — "the thing you asked for is not here".
 *
 * **Keyed on the status, not on `code === 'meal_not_found'`, and that is deliberate.** The client
 * preserves the wire status for an error response whose body is not an envelope (`errors.ts` says
 * so at the site: "a 404 stays 404"), and such a response arrives as `kind: 'unreadable'` with
 * `code: null`. A plain 404 from a path the server does not claim, or from anything sitting in
 * front of it, is exactly as much "this meal does not exist" as the enveloped one — so requiring
 * the code would send a real 404 to `failed` and offer a retry that can never succeed.
 *
 * Not imported from `@nutritime/contracts`: `API_ERROR_STATUS.meal_not_found` is the status the
 * SERVER assigns to one of its five codes, and what is meant here is the HTTP status itself. The
 * two are equal today and that equality is not the fact being relied on.
 */
const NOT_FOUND_STATUS = 404;

/**
 * Which failure is which, decided through `errors.ts` and never by reading a message.
 *
 * Order matters: the 404 test runs first, because a `not-found` is a `kind: 'server'` failure and
 * would otherwise fall through to `failed`. `unreachable` and `timeout` are the local-only pair —
 * the app works, the server is not there. Everything else (a 400, a 500, an unreadable body, or
 * anything that is not an `ApiClientError` at all) is a failure the user can only retry.
 *
 * **Nothing from the error reaches the returned state.** The states carry a `kind` and, when
 * loaded, a `Meal` — no message field, so there is nowhere for a wire string to be smuggled into
 * a screen (PRD §12, TSD §6.5 rule 1). The suite asserts the shape, not just the kind.
 */
function stateForError(error: unknown): MealDetailsState {
  if (!isApiClientError(error)) {
    return { kind: 'failed' };
  }
  if (error.status === NOT_FOUND_STATUS) {
    return { kind: 'notFound' };
  }
  if (error.kind === 'unreachable' || error.kind === 'timeout') {
    return { kind: 'unreachable' };
  }
  return { kind: 'failed' };
}

export function useMealDetails({
  client,
  mealId,
  nonce = 0,
}: UseMealDetailsOptions): MealDetailsState {
  const [state, setState] = useState<MealDetailsState>({ kind: 'loading' });

  /**
   * The newest request's number. A response may only commit if it still holds it.
   *
   * A ref rather than state, deliberately: incrementing it must not itself cause a render, and it
   * must be readable by a continuation that was created during an earlier one.
   */
  const generation = useRef(0);

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    /**
     * **Discard first, ask second.** See the module docstring: the previous meal must not be on
     * screen under a new id for the length of a round trip.
     *
     * The updater returns the current state identically when it is already `loading`, which is
     * TSD §6.3's reference-preservation rule applied to a hook: on first mount there is nothing to
     * discard, and a fresh object there would cost an extra commit for no change a user can see.
     */
    setState((current) => (current.kind === 'loading' ? current : { kind: 'loading' }));

    const controller = new AbortController();

    // Not `void client.getMeal(...)`: an async IIFE keeps the rejection inside a `catch` even when
    // `getMeal` throws synchronously before returning a promise.
    void (async () => {
      try {
        const meal = await client.getMeal(mealId, controller.signal);
        // **The guard that actually prevents a stale render.** `abort()` cannot un-resolve a
        // promise whose continuation is already queued, so the newest-request check is what makes
        // the wrong meal unrenderable rather than merely unlikely.
        if (generation.current !== mine) {
          return;
        }
        setState({ kind: 'loaded', meal });
      } catch (error) {
        /**
         * An abort is not a failure to report: it means a newer request replaced this one, or the
         * screen went away, and neither is something to tell the user about.
         *
         * Tested through **this request's own signal**, not through the error. There is no
         * `'cancelled'` in `ApiClientFailureKind` and `cancellation()` raises a plain `Error`
         * named `AbortError` (or the caller's own reason object), so an `error.kind === 'cancelled'`
         * check would never match and every superseded request would have rendered a failure.
         * `signal.aborted` cannot be wrong about it. It is a second line behind the generation
         * check, which catches every case except an abort within the same generation — an unmount.
         */
        if (generation.current !== mine || controller.signal.aborted) {
          return;
        }
        setState(stateForError(error));
      }
    })();

    return () => {
      controller.abort();
    };
    /**
     * **Reviewed by hand, because nothing lints it.** `react-hooks/exhaustive-deps` is not
     * registered in `eslint.config.mjs` (R-46), and P15's frozen-clock defect (M-6) is what a hand
     * review getting one of these wrong looks like. So, each entry and why:
     *
     * - `client` — the request is made through it. `ApiProvider` holds one instance for the life of
     *   the app, so in practice this never changes; it is here because a caller that swapped the
     *   client and did not re-request would be silently reading the old server.
     * - `mealId` — the identity of what is being fetched. Dropping it is the defect the suite
     *   probes by re-rendering the same root: the screen would keep the first meal for ever.
     * - `nonce` — the retry. Dropping it would make the retry button do nothing at all.
     *
     * Nothing else belongs: `state` is written here and reading it would loop, and there is no
     * object or function dependency, which is why a parent re-render with identical props issues no
     * second request (also asserted).
     */
  }, [client, mealId, nonce]);

  return state;
}
