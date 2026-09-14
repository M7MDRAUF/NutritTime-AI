/**
 * The favourites data lane: resolve stored ids to meals, and group the outcomes (T-17-02).
 *
 * **A favourite can outlive its meal, and that is what this module exists to survive.** The
 * favourites store holds ids and never meals, the catalog is reseeded by hand, `catalogVersion`
 * moves, and a stored id is not a foreign key anything enforces. So a favourited id can name a
 * catalog record that no longer exists, and the section must render what resolved, say plainly that
 * one could not be found, drop nothing silently, and not fail whole.
 *
 * **`getMeal` per id rather than `listMeals`, because only a 404 can tell an orphan from a paging
 * boundary.** `GET /meals` is paged and filtered; an id absent from a page says nothing about
 * whether the record exists, and treating absence as "gone" would offer to delete favourites that
 * are merely on page two.
 *
 * **The fetch and the grouping are deliberately in one module, and must stay that way.** That
 * property — a 404 means gone, anything else does not — is the one the suite's orphan test rests
 * on, and it only holds while the code that classifies a rejection sits beside the code that
 * produced it. Split them and the grouping becomes a function over "some settled results", which
 * the next reader can feed from a paged list without noticing that "missing" has quietly changed
 * meaning. `classify` is exported for assertions a renderer cannot reach, not as a seam.
 *
 * Nothing here renders and nothing here reads a store: the screen owns both.
 */

import { useEffect, useRef, useState } from 'react';
import type { Meal } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';

/** One favourite id that resolved to a meal. The id is kept so rows key off the store's list. */
export interface FavoriteEntry {
  readonly id: string;
  readonly meal: Meal;
}

/**
 * The favourites section's state.
 *
 * `loaded` carries three id groups rather than one list, because the three have different causes and
 * different honest answers: `resolved` renders, `missing` is a favourite whose catalog record is gone
 * (a 404 — offer to forget it), and `unresolved` is a request that failed for some other reason
 * (retryable, and the meal may well still exist).
 */
export type FavoritesFeed =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'loaded';
      readonly resolved: readonly FavoriteEntry[];
      readonly missing: readonly string[];
      readonly unresolved: readonly string[];
    }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed' };

export const NOTHING_SAVED: FavoritesFeed = {
  kind: 'loaded',
  resolved: [],
  missing: [],
  unresolved: [],
};

/**
 * The ACTUAL 404, read off the classified error — never guessed from a message string.
 *
 * The status is what is checked rather than the `kind`, because a 404 reaches the client two ways:
 * with the server's error envelope it arrives as `kind: 'server'`, and without one as
 * `kind: 'unreadable'` with the wire status preserved (`errors.ts` says so in as many words). Both
 * are the same fact about the meal.
 */
function isNotFound(reason: unknown): boolean {
  return isApiClientError(reason) && reason.status === 404;
}

/** The local-only pair (PRD §12): the app works, the machine running the server does not. */
function isUnreachable(reason: unknown): boolean {
  return isApiClientError(reason) && (reason.kind === 'unreachable' || reason.kind === 'timeout');
}

/**
 * Group the settled requests into the three outcomes.
 *
 * **The section fails whole only when there is genuinely nothing to show.** One id that 404s, or one
 * that errors beside nine that resolved, is a row-level fact and not a failed screen — that is the
 * "must not break the section" half. The other half is that a whole-section failure still has to
 * distinguish local-only from failed, so an error set that is entirely transport failures reports
 * `unreachable` and a set with one non-transport failure in it reports `failed`: calling a 500
 * "offline" is the comfortable lie that sends the user to check their connection for no reason.
 */
export function classify(
  ids: readonly string[],
  settled: readonly PromiseSettledResult<Meal>[],
): FavoritesFeed {
  const resolved: FavoriteEntry[] = [];
  const missing: string[] = [];
  const unresolved: string[] = [];
  let transportOnly = true;

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const outcome = settled[index];
    /**
     * Two indexed reads, both `T | undefined` under `noUncheckedIndexedAccess`, and **handled
     * rather than asserted** — BRIEF §3.2 forbids `!` and a papering-over `as`.
     *
     * Neither can actually occur: `index` is bounded by `ids.length`, and `Promise.allSettled`
     * resolves to exactly one result per input promise, so `settled.length === ids.length` for the
     * only caller that matters. It is still written out, because the alternative shapes are worse —
     * a non-null assertion would be a claim about a caller this function cannot see, and the honest
     * cost of skipping a pair is one favourite silently absent from the list rather than a crash.
     * If a future caller ever passes a short `settled`, the id is simply not grouped.
     */
    if (id === undefined || outcome === undefined) {
      continue;
    }
    if (outcome.status === 'fulfilled') {
      resolved.push({ id, meal: outcome.value });
    } else if (isNotFound(outcome.reason)) {
      missing.push(id);
    } else {
      unresolved.push(id);
      transportOnly = transportOnly && isUnreachable(outcome.reason);
    }
  }

  if (resolved.length === 0 && missing.length === 0 && unresolved.length > 0) {
    return transportOnly ? { kind: 'unreachable' } : { kind: 'failed' };
  }
  return { kind: 'loaded', resolved, missing, unresolved };
}

/**
 * Resolve the favourited ids to meals, one request each, and hand back the grouped outcome.
 *
 * Both of `useMealSearch`'s guards, and they defend different failure modes: the `AbortController`
 * cancels the in-flight request, which stops the work and frees the socket, and the generation
 * counter refuses a commit that does not belong to the newest batch. The user-visible symptom they
 * prevent is a meal just favourited from `MealDetails` vanishing a moment after it appeared, because
 * the superseded batch answered last.
 *
 * **One deliberate difference from `useMealSearch`, and it is worth knowing which way round it is.**
 * There, the success path carries only the generation check and `signal.aborted` is tested in the
 * `catch` alone — so the generation counter is the single thing standing between a stale response
 * and the screen, exactly as that module's docstring says. Here both checks sit on the success path,
 * which makes each individually sufficient (the cleanup aborts synchronously before the next effect
 * runs, so `signal.aborted` still reads true inside an already-queued continuation). That is
 * redundancy on purpose, not a spare part: a probe removing either one alone leaves this suite green,
 * so the claim this file's test supports is "a guard is present", and the phase report says so rather
 * than letting a green probe be read as proof that the other guard is unnecessary.
 *
 * `ids` is safe as a dependency precisely because the favourites reducer preserves references
 * (TSD §6.3 invariant 3): an unrelated dispatch returns `state` identically, so this does not
 * re-request on every render the way a freshly-allocated array would.
 */
export function useFavoriteMeals(
  client: ApiClient,
  ids: readonly string[],
  nonce: number,
): FavoritesFeed {
  const [feed, setFeed] = useState<FavoritesFeed>(
    ids.length === 0 ? NOTHING_SAVED : { kind: 'loading' },
  );
  const generation = useRef(0);

  useEffect(() => {
    const mine = generation.current + 1;
    generation.current = mine;

    // No ids, no request. Reported as loaded-and-empty rather than loading, or an empty list would
    // sit under "Loading…" forever with nothing on its way.
    if (ids.length === 0) {
      setFeed(NOTHING_SAVED);
      return;
    }

    setFeed({ kind: 'loading' });
    const controller = new AbortController();

    void (async () => {
      try {
        // `allSettled`, so one rejected id cannot discard the meals that resolved beside it — which
        // is the whole orphan requirement.
        const settled = await Promise.allSettled(
          /**
           * **`async` here, and it is load-bearing rather than decorative.**
           *
           * `client.getMeal` can throw **synchronously, before any promise exists**: it builds its
           * path with `mealPath`, which runs `encodeURIComponent`, and that raises `URIError` on a
           * lone surrogate. `useMealDetails.ts` states the same hazard for the same call.
           *
           * A favourite id is only ever checked for being a non-empty string, so a corrupt or
           * hand-edited store can hold one — and a bare `(id) => client.getMeal(...)` would let
           * that throw escape `.map` before `allSettled` was even reached, killing the whole batch.
           * Wrapping the callback in `async` turns it into a rejected promise for **that id
           * alone**, which the classifier then groups as `unresolved`: one favourite that cannot be
           * fetched, beside the rest of the list, instead of a section stuck on `loading` for ever.
           */
          ids.map(async (id) => client.getMeal(id, controller.signal)),
        );
        if (generation.current !== mine || controller.signal.aborted) {
          return;
        }
        setFeed(classify(ids, settled));
      } catch {
        /**
         * Nothing above should be able to throw now. This is here because the cost of being wrong
         * about that is the worst state this screen has: `loading` for ever, with no retry
         * affordance, and an unhandled rejection in the bargain. An honest failure the user can
         * retry is strictly better than a spinner that never resolves.
         */
        if (generation.current !== mine || controller.signal.aborted) {
          return;
        }
        setFeed({ kind: 'failed' });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [client, ids, nonce]);

  return feed;
}
