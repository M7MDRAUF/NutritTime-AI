/**
 * `classify`'s two rules that a renderer cannot reach — an ADDITION to `Saved.dom.test.tsx`, never a
 * relocation from it. All 22 tests there stay, and they reach this code the way a user does.
 *
 * What is here instead is the pair of cases the screen has no way to produce:
 *
 *  1. **A MIXED error set.** The dom suite can make every id fail the same way (all transport, or
 *     all 500) because a stub client rejects uniformly. It cannot easily make one id time out while
 *     another 500s — and that combination is exactly what `transportOnly` decides: one non-transport
 *     failure in the set means the section reports `failed` rather than `unreachable`, because
 *     calling a 500 "offline" sends the user to check a connection that is fine.
 *  2. **`resolved` order across interleaved rejections.** The dom suite proves the order is the
 *     store's for an all-resolved list; it cannot easily prove that a rejection in the middle does
 *     not shuffle what is left, because the ids that 404 leave no row to compare positions against.
 *
 * No React and no renderer: `classify` is pure, which is the reason it is exported at all.
 */

import { describe, expect, it } from 'vitest';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import { classify } from './favoritesFeed.js';

const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((record) =>
  mealSchema.parse(record),
);

function meal(index: number): Meal {
  const found = CATALOG[index];
  if (found === undefined) {
    throw new Error('the seeded catalog is too small for this fixture');
  }
  return found;
}

function ok(value: Meal): PromiseSettledResult<Meal> {
  return { status: 'fulfilled', value };
}

function no(reason: unknown): PromiseSettledResult<Meal> {
  return { status: 'rejected', reason };
}

/** The server's own `meal_not_found` body, as `apps/server/src/errors.ts` writes it. */
function notFound(): ApiClientError {
  return new ApiClientError({
    kind: 'server',
    status: 404,
    code: 'meal_not_found',
    retryable: false,
    wire: { code: 'meal_not_found', message: 'That meal could not be found.', retryable: false },
    route: 'getMeal',
  });
}

function serverError(): ApiClientError {
  return new ApiClientError({
    kind: 'server',
    status: 500,
    code: 'internal_error',
    retryable: false,
    wire: null,
    route: 'getMeal',
  });
}

describe('classify — a whole-section failure', () => {
  it('reports local-only when every failure is a transport failure', () => {
    const feed = classify(
      ['a', 'b'],
      [no(transportError('getMeal', 'unreachable')), no(transportError('getMeal', 'timeout'))],
    );
    // `timeout` counts as transport too: the app works, the machine running the server does not.
    expect(feed.kind).toBe('unreachable');
  });

  it('reports failed when ONE failure in the set is not a transport failure', () => {
    /**
     * The rule `transportOnly` exists for, and the reason it is `&&` rather than "any": a 500 mixed
     * in means the server answered, so the honest report is "failed" — a screen that said "Working
     * offline" would send the user to check a connection that is perfectly fine, which is the
     * comfortable lie that stops a real problem being reported.
     */
    const feed = classify(
      ['a', 'b'],
      [no(transportError('getMeal', 'unreachable')), no(serverError())],
    );
    expect(feed.kind).toBe('failed');
  });

  it('is not a whole-section failure when even one id merely 404s', () => {
    // A 404 is an answer, not a failure. With one, the section stays `loaded` and the orphan is
    // surfaced — which is what stops a reseeded catalog blanking the screen.
    const feed = classify(['gone', 'b'], [no(notFound()), no(serverError())]);
    expect(feed.kind).toBe('loaded');
    if (feed.kind !== 'loaded') {
      throw new Error('unreachable');
    }
    expect(feed.missing).toStrictEqual(['gone']);
    expect(feed.unresolved).toStrictEqual(['b']);
  });
});

describe('classify — grouping', () => {
  it('keeps the resolved ids in the caller’s order across interleaved rejections', () => {
    const first = meal(0);
    const second = meal(1);
    const third = meal(2);
    const feed = classify(
      [first.id, 'gone-1', second.id, 'broken', third.id],
      [ok(first), no(notFound()), ok(second), no(serverError()), ok(third)],
    );

    expect(feed.kind).toBe('loaded');
    if (feed.kind !== 'loaded') {
      throw new Error('unreachable');
    }
    // The order is the favourites store's order, which is what the user sees. A rejection in the
    // middle must not shuffle what is left.
    expect(feed.resolved.map((entry) => entry.id)).toStrictEqual([first.id, second.id, third.id]);
    expect(feed.resolved.map((entry) => entry.meal.name)).toStrictEqual([
      first.name,
      second.name,
      third.name,
    ]);
    expect(feed.missing).toStrictEqual(['gone-1']);
    expect(feed.unresolved).toStrictEqual(['broken']);
  });
});
