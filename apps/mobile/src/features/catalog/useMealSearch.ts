/**
 * Explore's data hook: debounce, abort, and three states (T-13-02).
 *
 * **The abort matters more than the debounce, and it is the reason this is a hook of its own.** A
 * slow first query that lands *after* a fast second one would render the wrong results under the
 * right search box — the user types "rice", then "ricotta", and sees rice. The debounce only
 * reduces how often that can happen; it cannot prevent it, because any two requests can overlap
 * whatever the gap between them.
 *
 * So there are two guards, and they defend different failure modes:
 *
 *  1. **`AbortController`** — cancels the in-flight request, which is what stops the work and frees
 *     the socket. It does NOT stop a response that already arrived: by the time `abort()` runs, a
 *     resolved promise's continuation may already be queued as a microtask.
 *  2. **A generation counter** — the commit is refused unless the response belongs to the newest
 *     request. This is the one that actually makes a stale render impossible, and it is the reason
 *     an abort alone would be a false sense of security.
 *
 * Both are asserted, including the case where a response arrives after its abort.
 */

import { useEffect, useRef, useState } from 'react';
import type { Meal } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import { queryFrom } from './exploreFilters.js';
import type { ExploreFilters } from './exploreFilters.js';

/**
 * **SDD §11's figure** ("Search debounces at ~300 ms"). A keystroke is not a request; a pause in
 * typing is.
 *
 * The citation here used to read "TSD §6.5", and that section is the **API client** — the
 * `ApiClient` interface, the per-route deadline table and the abort rules. It carries no debounce
 * figure; `debounce` does not appear in TSD at all. Recorded rather than reconciled: SDD outranks
 * TSD, so the value 300 was always authorised, only its attribution was wrong.
 *
 * Pinned by `Explore.dom.test.tsx`'s "waits the screen's own default", which withholds the
 * `debounceMs` prop and advances a fake clock to 299 ms and then to 300 ms.
 */
export const SEARCH_DEBOUNCE_MS = 300;

export type MealSearchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly meals: readonly Meal[]; readonly total: number }
  /** The server could not be reached. PRD §12's "local-only", which is not an error to the user. */
  | { readonly kind: 'unreachable' }
  /** Reached, and it refused or answered something unusable. */
  | { readonly kind: 'failed' };

export interface UseMealSearchOptions {
  readonly client: ApiClient;
  readonly search: string;
  readonly filters: ExploreFilters;
  /** Injected so a test does not wait 300 ms of real time. */
  readonly debounceMs?: number;
}

/**
 * Which api failures are "the server is not there" rather than "the server said no".
 *
 * `unreachable` and `timeout` are the local-only pair: the app works, the machine running the
 * server does not. Everything else — a 400, a 500, an unreadable body — is a failure the user can
 * only retry, so it gets the error state and not the reassuring one. Calling a 500 "offline" would
 * be a claim the client cannot support, and it is the sort of comfortable lie that stops a real
 * problem being reported.
 */
function stateForError(error: unknown): MealSearchState {
  if (isApiClientError(error) && (error.kind === 'unreachable' || error.kind === 'timeout')) {
    return { kind: 'unreachable' };
  }
  return { kind: 'failed' };
}

export function useMealSearch({
  client,
  search,
  filters,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: UseMealSearchOptions): MealSearchState {
  const [state, setState] = useState<MealSearchState>({ kind: 'loading' });

  /**
   * The newest request's number. A response may only commit if it still holds it.
   *
   * A ref rather than state, deliberately: incrementing it must not itself cause a render, and it
   * must be readable by a continuation that was created during an earlier one.
   */
  const generation = useRef(0);

  // The query is rebuilt from primitives inside the effect, so the dependency list can be the
  // primitives themselves. Depending on an object would re-request on every render, since
  // `queryFrom` returns a fresh object each call and `filters` is a fresh object each parent render.
  const { period, diet, budget } = filters;

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    const controller = new AbortController();

    /**
     * **Only the text is debounced.**
     *
     * A chip tap is a discrete, deliberate action and waiting 300 ms after one makes the interface
     * feel broken — the chip is visibly selected and nothing happens. Typing is the opposite: every
     * keystroke is provisional. So a filter change fires immediately and a text change waits, which
     * is why the timer is declared here and set to 0 for everything but `search`.
     */
    const delay = search.trim() === '' ? 0 : debounceMs;

    const timer = setTimeout(() => {
      // Not `void client.listMeals(...)`: an async IIFE keeps the rejection inside a `catch` even
      // when `listMeals` throws synchronously before returning a promise.
      void (async () => {
        try {
          const response = await client.listMeals(
            queryFrom(search, { period, diet, budget }),
            controller.signal,
          );
          // **The guard that actually prevents a stale render.** `abort()` cannot un-resolve a
          // promise whose continuation is already queued, so the newest-request check is what makes
          // the wrong result unrenderable rather than merely unlikely.
          if (generation.current !== mine) {
            return;
          }
          setState({ kind: 'loaded', meals: response.meals, total: response.total });
        } catch (error) {
          if (generation.current !== mine) {
            return;
          }
          /**
           * An abort is not a failure to report: it means a newer request replaced this one, or
           * the screen went away, and neither is something to tell the user about.
           *
           * Tested through **this request's own signal**, not through the error. There is no
           * `'cancelled'` in `ApiClientFailureKind` — the kinds are `server`, `unreachable`,
           * `timeout` and `unreadable` — and `cancellation()` raises a plain `Error` named
           * `AbortError`, or the caller's own reason object if one was given. So an
           * `error.kind === 'cancelled'` check would never match and every superseded request
           * would have rendered the failure state. `signal.aborted` cannot be wrong about it.
           */
          if (controller.signal.aborted) {
            return;
          }
          setState(stateForError(error));
        }
      })();
    }, delay);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, search, period, diet, budget, debounceMs]);

  return state;
}
