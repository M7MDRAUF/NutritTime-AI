/**
 * Explore's data hook: debounce, abort, and three states (T-13-02).
 *
 * **The abort matters more than the debounce, and it is the reason this is a hook of its own.** A
 * slow first query that lands *after* a fast second one would render the wrong results under the
 * right search box — the user types "rice", then "ricotta", and sees rice. The debounce only
 * reduces how often that can happen; it cannot prevent it, because any two requests can overlap
 * whatever the gap between them.
 *
 * So there are guards, and each defends a different failure mode. The first two are the original
 * pair and defend the WRONG LIST:
 *
 *  1. **`AbortController`** — cancels the in-flight request, which is what stops the work and frees
 *     the socket. It does NOT stop a response that already arrived: by the time `abort()` runs, a
 *     resolved promise's continuation may already be queued as a microtask.
 *  2. **A generation counter** — the commit is refused unless the response belongs to the newest
 *     request. This is the one that actually makes a stale render impossible, and it is the reason
 *     an abort alone would be a false sense of security.
 *
 * Both are asserted, including the case where a response arrives after its abort.
 *
 * **Paging adds a second axis for a late response to land on (R-73), and three more guards.**
 * Before paging, every response either replaced the list or was refused, so a wrong result was a
 * wrong list. A page-2 response *appends*, so a stale one would not replace a result set — it
 * would corrupt a different one, leaving twenty meals of "rice" underneath twenty meals of
 * "ricotta" with nothing on screen saying so. These three defend the MIXED LIST, in the order a
 * page request meets them:
 *
 *  3. **The requested page is derived from the query key during render**, never carried across a
 *     query change. A filter change makes the effective page 1 in the same render that changes the
 *     filters, so there is no render in which "the new query" and "page 2" are both true — and a
 *     companion effect discards the stale record, so returning to an earlier query starts over too.
 *  4. **`loadMore` refuses unless the current query has a settled page.** So page N+1 is only ever
 *     requestable once page N *of the same query* has landed, which is what makes "append" a
 *     meaningful instruction rather than a bet on request ordering.
 *  5. **The commit knows which query it belongs to.** `loaded` carries the key it was built from
 *     and `commitPage` appends only onto a set with the same key. Guards 2 and 4 already make a
 *     cross-query append unreachable; this one is here because the two costs are not comparable —
 *     a refused render is invisible and a silently mixed list is not.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Meal, MealListResponse } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import { exploreQueryKey, isLastPage, queryFrom } from './exploreFilters.js';
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
  | {
      readonly kind: 'loaded';
      /** `exploreQueryKey` of the search and filters these meals answer. */
      readonly key: string;
      /**
       * The highest page folded into `meals`.
       *
       * Stored rather than computed from `meals.length / EXPLORE_PAGE_SIZE`, because the append
       * de-duplicates: one record the server sent on two pages would leave the arithmetic a page
       * behind and the screen re-requesting a page it already holds, forever.
       */
      readonly page: number;
      /** Every page loaded so far, in the order the server sent them. */
      readonly meals: readonly Meal[];
      /** The server's count AFTER filtering and BEFORE paging, so `meals.length <= total`. */
      readonly total: number;
      /** No further page exists — see `isLastPage` for the two reasons that can be true. */
      readonly exhausted: boolean;
    }
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

/** What the screen needs: the state, and the one action that reaches the rest of the catalogue. */
export interface MealSearch {
  readonly state: MealSearchState;
  /** A page after the first is in flight. The screen announces this rather than blanking the list. */
  readonly appending: boolean;
  /** Another page exists and none is in flight, so the affordance is worth showing. */
  readonly canLoadMore: boolean;
  /** Ask for the next page. A no-op unless `canLoadMore`, so a repeated call cannot double-request. */
  readonly loadMore: () => void;
  /**
   * Run the current query again, from the first page.
   *
   * **The screen's retry had no way to do this and therefore did nothing** — and the comment at
   * the call site argued for the defect (BRIEF §6.1j): it said the retry "re-mounts the list by
   * identity", so it replaced `filters` with a fresh object. This effect never depended on that
   * object. It depends on the search text and the three filter primitives, none of which the
   * retry changed, so pressing it re-rendered the screen and re-requested nothing. The retry now
   * has an input the effect actually watches, and it resets the page: a failure on page 3 leaves
   * nothing loaded, so re-requesting page 3 would show records 41-60 as the whole catalogue.
   */
  readonly retry: () => void;
}

/** Which query, and how far into it, one request is for. */
interface PageRequest {
  readonly key: string;
  readonly page: number;
}

/**
 * Fold one page into the state. **Guard 5** (see the module docstring).
 *
 * Appends only when the response is for a page after the first AND the state it is folding into
 * came from the same query. Anything else replaces, which is the right answer for page 1 and the
 * only safe answer for a case that should not arise: a page-2 response landing on a foreign list
 * is refused an append, so no list can ever hold two queries' meals at once.
 *
 * **The append is de-duplicated by id**, not concatenated blindly. `keyExtractor` returns
 * `meal.id`, so one id twice would be one React key twice — the P13 lesson's failure mode arriving
 * by a new route. A duplicate page cannot be produced by the guards above; this makes it
 * unrepresentable rather than merely unlikely, and it is asserted by settling one page twice.
 */
function commitPage(
  previous: MealSearchState,
  key: string,
  page: number,
  response: MealListResponse,
): MealSearchState {
  const kept = page > 1 && previous.kind === 'loaded' && previous.key === key ? previous.meals : [];
  const seen = new Set(kept.map((meal) => meal.id));
  const meals = [...kept, ...response.meals.filter((meal) => !seen.has(meal.id))];

  return {
    kind: 'loaded',
    key,
    page,
    meals,
    total: response.total,
    exhausted: isLastPage(response.meals.length, meals.length, response.total),
  };
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
}: UseMealSearchOptions): MealSearch {
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

  /**
   * **The TRIMMED text, and that is the dependency the effect takes.**
   *
   * `search` itself would make `'rice '` a different query from `'rice'` — one whose page-2
   * request would be issued a second time and folded into the same list. `queryFrom` trims too, so
   * the two requests were always identical; only the effect's idea of "changed" was not.
   */
  const trimmed = search.trim();
  const key = exploreQueryKey(search, filters);

  /**
   * How far into the current query the screen has asked to go.
   *
   * **Guard 3, first half.** The stored record carries the key it was made for, and the page the
   * effect acts on is derived from it *during render*: a query change makes `page` 1 in the same
   * render that changed the filters, so no request is ever built from a new query and an old page.
   *
   * **It is measured REDUNDANT and kept anyway — read this before deleting it.** This comment
   * first claimed an effect-based reset "would be one request too late". A probe says otherwise:
   * `requested.page` in place of this line changed **0 of 44** tests, because the reset effect
   * below schedules a re-render whose cleanup clears the request's `setTimeout` before the
   * macrotask fires. True, and it is *timing* — the reset-only version is correct only while a
   * timer has not run. This line makes it structural. Honest status: unpinned belt to the reset
   * effect's braces (BRIEF §6.1j: the rationale is rewritten because the measurement refuted it).
   */
  const [requested, setRequested] = useState<PageRequest>(() => ({ key, page: 1 }));
  const page = requested.key === key ? requested.page : 1;

  /** Bumped by `retry`, and in the effect's dependencies, which is the whole of its job. */
  const [reloads, setReloads] = useState(0);

  /**
   * **Guard 3, second half**, and the pinned one: the record itself is reset once the render has
   * settled. Removing it reddens the "starts a query it had already paged over again from page
   * one" case.
   *
   * Without this the *derivation* above is the only thing neutralising a stale record, and a
   * derivation forgets nothing: leaving `{ key: A, page: 2 }` in place while the user browses query
   * B means that returning to A asks for page 2 of a list holding nothing — twenty records skipped
   * with no gap a reader would see. Written as an updater that returns `current` when it already
   * matches, so React bails out and the common case costs no render.
   */
  useEffect(() => {
    setRequested((current) => (current.key === key ? current : { key, page: 1 }));
  }, [key]);

  /**
   * The text the previous effect run dispatched, so `delay` can ask what changed.
   *
   * Seeded with the first render's query rather than `''` so a deep-linked mount is not read
   * as a keystroke. A ref rather than state: reading it must not schedule a render, and it is
   * written inside the effect that consumes it.
   */
  const lastDispatchedText = useRef(trimmed);

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    const controller = new AbortController();

    /**
     * **Only the text is debounced, and the delay keys off what CHANGED — not off what the text
     * happens to be.**
     *
     * A chip tap is a discrete, deliberate action and waiting 300 ms after one makes the interface
     * feel broken — the chip is visibly selected and nothing happens. Typing is the opposite: every
     * keystroke is provisional. So a filter change fires immediately and a text change waits.
     *
     * **That rule was stated here for two phases while the code did something else**, and the
     * false sentence is left visible rather than quietly deleted. The expression was
     * `trimmed === '' || page > 1 ? 0 : debounceMs`, which asks *is the box empty* rather than
     * *what did the user just do* — so a chip tap with text in the box paid the full debounce. P28
     * measured it: **30.8 ms** for the same tap with an empty box against **333.9 ms** with text
     * in it, `+303.1 ms`, on a target of 150. Comparing `trimmed` against the previous run's value
     * is what makes the delay answer the question the docstring asks.
     *
     * **An empty box still fires at once** for a different reason: clearing the field is itself a
     * deliberate action, and the request it produces is the cheap unfiltered one.
     *
     * **A page request is not typing either.** Tapping "Show more meals" with text in the box
     * would otherwise wait 300 ms after a deliberate press, so a page after the first goes out at
     * once — the text it pages through has already been debounced once.
     *
     * The mount is not typing either, which is why `lastDispatchedText` starts at the initial
     * query rather than at `''`: a screen opened from `nutritime://explore?query=rice` should not
     * hold a cold, empty list for 300 ms before asking for anything.
     */
    const textChanged = trimmed !== lastDispatchedText.current;
    lastDispatchedText.current = trimmed;
    const delay = trimmed === '' || page > 1 || !textChanged ? 0 : debounceMs;

    const timer = setTimeout(() => {
      // Not `void client.listMeals(...)`: an async IIFE keeps the rejection inside a `catch` even
      // when `listMeals` throws synchronously before returning a promise.
      void (async () => {
        try {
          const response = await client.listMeals(
            queryFrom(trimmed, { period, diet, budget }, page),
            controller.signal,
          );
          // **The guard that actually prevents a stale render.** `abort()` cannot un-resolve a
          // promise whose continuation is already queued, so the newest-request check is what makes
          // the wrong result unrenderable rather than merely unlikely. Under paging it is also what
          // stops a superseded page APPENDING: a page-2 response for the query the user has just
          // left is refused here, before `commitPage` ever sees it.
          if (generation.current !== mine) {
            return;
          }
          setState((current) => commitPage(current, key, page, response));
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
  }, [client, key, trimmed, period, diet, budget, page, debounceMs, reloads]);

  /**
   * The loaded set for the CURRENT query, or nothing.
   *
   * A `loaded` state whose key no longer matches is the list the user is still looking at while the
   * next query is in flight — correct to render and wrong to page, because paging it would ask for
   * the next page of a query nobody is running.
   */
  const settled = state.kind === 'loaded' && state.key === key ? state : null;

  /**
   * A page after the first is in flight exactly when a higher page has been asked for than the
   * state has folded in.
   *
   * Derived rather than stored: a separate `appending` flag is a second source of truth about the
   * same fact, and the two go out of step on the path nobody tests — a failure, where the state
   * moves to `failed` and a stored flag would sit `true` for the life of the screen.
   */
  const appending = settled !== null && page > settled.page;
  const canLoadMore = settled !== null && !settled.exhausted && !appending;

  const loadMore = useCallback(() => {
    if (!canLoadMore || settled === null) {
      return;
    }
    // **Guard 4.** `FlatList` fires `onEndReached` more than once per scroll, and the button can be
    // pressed twice. Both land on the same `{ key, page }`, so the effect's dependencies do not
    // change and no second request goes out; and the `canLoadMore` test above means the page being
    // asked for is always the one after a page that has actually landed for THIS query.
    setRequested({ key, page: settled.page + 1 });
  }, [canLoadMore, key, settled]);

  const retry = useCallback(() => {
    setRequested({ key, page: 1 });
    setReloads((count) => count + 1);
  }, [key]);

  return { state, appending, canLoadMore, loadMore, retry };
}
