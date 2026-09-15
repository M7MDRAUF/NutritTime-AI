import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { MEAL_QUERY_MAX_LENGTH, mealSchema } from '@nutritime/contracts';
import type { Meal, MealListResponse, MealPeriod } from '@nutritime/contracts';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { ApiProvider } from '../../infrastructure/api/ApiProvider.js';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import type { MealQuery } from '../../infrastructure/api/routes.js';
import { ExploreScreen } from './ExploreScreen.js';

/**
 * T-13-06. The tracer slice's own suite, and the phase's real evidence.
 *
 * **Real catalog records, not hand-written fixtures**, and that is the point of the slice: the
 * mismatch this phase found — `Meal.imageUrl` is `string | null` while `MealCardProps.imageUrl` was
 * `string` — was invisible to every component test in P12 precisely because each fixture's author
 * chose a URL. A screen fed the actual data is the only place that surfaces.
 *
 * The client is a stub whose promises this file resolves by hand, because the assertion that
 * matters most is about ORDERING: a slow first request landing after a fast second one must not
 * render. Real timing cannot make that happen on demand.
 */

const CATALOG = (seededCatalog as unknown[]).map((record) => mealSchema.parse(record));

/**
 * One page of a `GET /meals` answer.
 *
 * **`total` is a second parameter now, and that is R-73's other half.** `apps/server`'s
 * `paginate` documents `total` as "the count AFTER filtering and BEFORE paging", so it is
 * independent of how many meals the page in hand carries: the real server answers `total: 60`
 * with twenty meals on every unfiltered first page. This helper used to compute it as
 * `meals.length`, so **the fixture could not express the disagreement** — and the screen
 * announcing `state.total` over a twenty-row list was therefore invisible to all nineteen tests
 * here. The audit measured the mutation `state.total` → `state.meals.length` at **0 of 19** for
 * exactly that reason: a fixture drawn from the same shape as the code tests nothing (BRIEF §6.3).
 *
 * The default is kept for the tests whose subject is not the count, and it is a **trap** for any
 * new one — an assertion about the announced count has to pass a `total` that differs, or it is
 * decoration. `catalogPage` below always differs, because the server always does.
 */
function page(meals: readonly Meal[], total = meals.length): MealListResponse {
  return { meals: [...meals], page: 1, pageSize: 20, total };
}

/**
 * Page `n` of the WHOLE catalogue, sliced the way `apps/server`'s `paginate` slices it.
 *
 * Twenty per page across sixty records, so `total` (60) and `meals.length` (20) disagree on every
 * page — which is what the server sends and what the helper above could not say.
 *
 * The twenty is written out rather than imported: slicing by `EXPLORE_PAGE_SIZE` and then
 * asserting the screen's behaviour against the same constant would compare it to itself and pass
 * at any value (BRIEF §6.1g). Each paging test asserts `CATALOG` is sixty as the other end of the
 * pin, and a page size that moved would make these pages short and fail them — which is the point.
 */
function catalogPage(pageNumber: number): MealListResponse {
  const start = (pageNumber - 1) * 20;
  return {
    meals: CATALOG.slice(start, start + 20),
    page: pageNumber,
    pageSize: 20,
    total: CATALOG.length,
  };
}

/** A client whose every call is a promise this test completes when it chooses. */
function deferredClient(): {
  readonly client: ApiClient;
  readonly calls: MealQuery[];
  readonly signals: AbortSignal[];
  settle(index: number, value: MealListResponse): Promise<void>;
  reject(index: number, error: unknown): Promise<void>;
} {
  const calls: MealQuery[] = [];
  const signals: AbortSignal[] = [];
  const resolvers: { resolve: (v: MealListResponse) => void; reject: (e: unknown) => void }[] = [];

  const client: ApiClient = {
    listMeals: (query, signal) => {
      calls.push(query);
      signals.push(signal);
      return new Promise<MealListResponse>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
    getMeal: () => Promise.reject(new Error('not used')),
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };

  const flush = async (): Promise<void> => {
    // Two awaits: one for the `listMeals` continuation, one for the `setState` React schedules.
    await act(async () => {
      await Promise.resolve();
    });
  };

  return {
    client,
    calls,
    signals,
    settle: async (index, value) => {
      resolvers[index]?.resolve(value);
      await flush();
    },
    reject: async (index, error) => {
      resolvers[index]?.reject(error);
      await flush();
    },
  };
}

interface Rendered {
  readonly host: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  text(): string;
}

function renderExplore(
  client: ApiClient,
  /**
   * What `route.params` really holds, which is not what `ExploreParams` says it holds.
   *
   * Both of Explore's params are query params, so a repeated key arrives as a `string[]` and an
   * unrecognised `?period=` value as an arbitrary string — shapes the param list's types never saw
   * (T-22-05). The union keeps the well-formed cases type-checked and admits the hostile ones as
   * the strings-or-arrays a URL can actually deliver, rather than widening everything to `unknown`
   * and losing the check on the twelve call sites that pass a proper value.
   */
  params?:
    | { readonly query?: string; readonly period?: MealPeriod }
    | Readonly<Record<string, string | readonly string[]>>,
  /**
   * `null` withholds the prop so the screen falls back to `SEARCH_DEBOUNCE_MS`.
   *
   * **The comment that used to sit here said "the 300 ms figure itself is asserted separately,
   * against the constant", and no such assertion existed anywhere in the repository** — an audit
   * grep for `SEARCH_DEBOUNCE_MS` found the declaration and its own default-parameter use and
   * nothing else, so `300 → 3000` failed nothing while this file told the reader otherwise. It is
   * asserted now, by "does the screen's own default wait exactly that long", below.
   */
  debounceMs: number | null = 0,
): Rendered {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const navigate = vi.fn();

  // `debounceMs: 0` in every test but the one above, so the effect's timer fires on the next tick
  // rather than after 300 ms of real time.
  const tree: ReactNode = (
    <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
      <ApiProvider client={client}>
        <ExploreScreen
          {...(debounceMs === null ? {} : { debounceMs })}
          route={{ key: 'Explore-1', name: 'Explore', params } as never}
          navigation={{ navigate } as never}
        />
      </ApiProvider>
    </ThemeProvider>
  );

  act(() => {
    createRoot(host).render(tree);
  });

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    host,
    navigate,
    find,
    must: (testID) => {
      const found = find(testID);
      if (found === null) {
        throw new Error(`no element for testID ${testID}`);
      }
      return found;
    },
    text: () => host.textContent ?? '',
  };
}

/**
 * The search input.
 *
 * `querySelector('input')`, not `getByRole('searchbox')`, and the difference is a real React Native
 * limitation rather than a preference: RN 0.86 has no `searchbox` accessibility role, so
 * `SearchField` puts `role="search"` on the CONTAINER as a landmark and leaves the input itself
 * with no role. That is what its own suite does, for the same reason.
 */
function searchInput(host: HTMLElement): HTMLElement {
  const found = host.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no search input rendered');
  }
  return found;
}

/** Let the debounce timer fire and the request go out. */
async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

/** Press a control and let whatever request it starts go out. */
async function press(view: Rendered, testID: string): Promise<void> {
  act(() => {
    view.must(testID).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await tick();
}

/**
 * A button found by the label the user reads, because `ErrorState` gives its retry no `testID`.
 * Its props are fixed by TSD §6.7 and adding one is another agent's decision, not this file's.
 */
function buttonLabelled(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll('[role="button"]')].find((node) =>
    (node.textContent ?? '').includes(label),
  );
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no button labelled ${label}`);
  }
  return found;
}

/** What the list tells a screen-reader user its size is. */
function announced(view: Rendered): string | null {
  return view.must('explore-list').getAttribute('aria-label');
}

/** The rows actually MOUNTED, which is the render budget and never the result-set size (R-45). */
function mountedRows(view: Rendered): number {
  return view.host.querySelectorAll('[data-testid^="meal-"]').length;
}

describe('ExploreScreen', () => {
  it('shows the loading state before anything resolves, and asks for page 1', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);

    expect(view.find('explore-loading')).not.toBeNull();
    expect(view.find('explore-list')).toBeNull();

    await tick();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toStrictEqual({ page: 1, pageSize: 20 });
  });

  it('renders a row per meal, keyed by id, from real catalog records', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(CATALOG.slice(0, 5)));

    expect(view.find('explore-loading')).toBeNull();
    for (const meal of CATALOG.slice(0, 5)) {
      // `testID` is `meal-${id}`, so finding all five proves the ids reached the rows rather than
      // positions doing it.
      expect(view.find(`meal-${meal.id}`), meal.id).not.toBeNull();
    }
    expect(view.text()).toContain(CATALOG[0]?.name ?? 'IMPOSSIBLE');
  });

  it('renders a meal with no photograph at all', async () => {
    // The defect this slice found: `Meal.imageUrl` is `string | null` and `MealCardProps.imageUrl`
    // was `string`. Every P12 fixture chose a URL, so nothing failed. A null renders the skeleton
    // floor and no `<img>` - asserted by counting images, because an empty `uri` would still
    // produce one and would issue a request for it.
    const first = CATALOG[0];
    if (first === undefined) {
      throw new Error('empty catalog');
    }
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page([{ ...first, imageUrl: null }]));

    expect(view.find(`meal-${first.id}`)).not.toBeNull();
    expect(view.host.querySelectorAll('img')).toHaveLength(0);
    // And the name is still readable, which is what `card.skeleton` is the floor for.
    expect(view.text()).toContain(first.name);
  });

  it('sends the search text as `query` after the debounce, not per keystroke', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(CATALOG.slice(0, 2)));

    const input = searchInput(view.host);
    act(() => {
      // Three "keystrokes" inside one act, so the debounce has one window to collapse them into.
      for (const value of ['r', 'ri', 'ric']) {
        fireEvent.change(input, { target: { value } });
      }
    });
    await tick();

    const queries = stub.calls.map((call) => call.query);
    // One request for the final text, not one per character. The first call is the initial load.
    expect(queries.filter((one) => one !== undefined)).toStrictEqual(['ric']);
  });

  it('does NOT render a slow first response that lands after a fast second one', async () => {
    /**
     * **The assertion this whole hook exists for.**
     *
     * A user types "rice", then "ricotta". If the "rice" request resolves second, an
     * abort-only implementation still renders rice under the word ricotta — because `abort()`
     * cannot un-resolve a promise whose continuation is already queued as a microtask. Only the
     * generation check makes it unrenderable.
     *
     * Settled deliberately out of order below: request 1 (the newer) first, then request 0.
     */
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();

    const input = searchInput(view.host);
    const type = async (value: string): Promise<void> => {
      act(() => {
        fireEvent.change(input, { target: { value } });
      });
      await tick();
    };

    await type('rice');
    await type('ricotta');
    expect(stub.calls.length).toBeGreaterThanOrEqual(3);

    const stale = CATALOG.slice(0, 3);
    const fresh = CATALOG.slice(10, 12);
    const newest = stub.calls.length - 1;

    await stub.settle(newest, page(fresh));
    for (const meal of fresh) {
      expect(view.find(`meal-${meal.id}`), `fresh ${meal.id}`).not.toBeNull();
    }

    // Now the superseded one answers. Nothing may change.
    await stub.settle(newest - 1, page(stale));
    for (const meal of stale) {
      expect(view.find(`meal-${meal.id}`), `stale ${meal.id} must not render`).toBeNull();
    }
    for (const meal of fresh) {
      expect(view.find(`meal-${meal.id}`), `fresh ${meal.id} must survive`).not.toBeNull();
    }
  });

  it('aborts the superseded request rather than leaving it running', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();

    act(() => {
      fireEvent.change(searchInput(view.host), { target: { value: 'rice' } });
    });
    await tick();

    // The first request's signal is aborted; the newest one's is not.
    const [first] = stub.signals;
    const last = stub.signals[stub.signals.length - 1];
    expect(first?.aborted).toBe(true);
    expect(last?.aborted).toBe(false);
  });

  it('a chip tap sends its parameter, and a second tap removes it', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(CATALOG.slice(0, 2)));

    const chip = view.must('chip-diet-vegan');
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await tick();
    expect(stub.calls[stub.calls.length - 1]?.diet).toBe('vegan');

    act(() => {
      view.must('chip-diet-vegan').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await tick();
    expect(Object.keys(stub.calls[stub.calls.length - 1] ?? {})).not.toContain('diet');
  });

  it('shows the local-only state when the server cannot be reached, never an error', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    // Built with the client's OWN factory, not hand-assembled: a hand-made error can carry a
    // `kind`/`status`/`retryable` combination the client would never produce, and then the test
    // asserts against a case that cannot happen.
    await stub.reject(0, transportError('listMeals', 'unreachable'));

    expect(view.find('explore-offline')).not.toBeNull();
    expect(view.find('explore-error')).toBeNull();
    // PRD §12: what still works. And "Working offline", never "You're offline" (S-23) - the server
    // is on the same machine and can be down while the phone's connection is perfect.
    expect(view.text()).toContain('Working offline');
    expect(view.text()).toContain('still work');
    expect(view.text()).not.toContain("You're offline");
  });

  it('shows the error state for a failure that is NOT a transport failure', async () => {
    // A 500 is not "offline". Calling it that is the comfortable lie that stops a real problem
    // being reported, and it would send the user to check their connection for no reason.
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.reject(
      0,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        wire: null,
        route: 'listMeals',
      }),
    );

    expect(view.find('explore-error')).not.toBeNull();
    expect(view.find('explore-offline')).toBeNull();
  });

  it('never shows a server-supplied string', async () => {
    // TSD §3.5, PRD §12 ("stack traces and raw provider errors never reach the user") and PRD
    // §10.3 ("logs never contain prompts, questions, allergy lists, or names").
    //
    // **Not "PRD §15.5", which this line used to cite and which does not exist**: PRD §15 is
    // "Dependencies and Assumptions" and has no subsections at all. The table everyone was
    // reaching for is **Plan §15.5**, which restates PRD §10.3 — `apps/server/src/errors.ts:10`
    // records the same mis-citation and names it as widespread.
    //
    // The client keeps the wire body on `.wire` and never in `.message`;
    // this proves the screen does not reach for it either.
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.reject(
      0,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        // The wire body IS the point of this test: the client keeps it on `.wire` and never in
        // `.message`, and this proves the screen does not reach for it either.
        wire: {
          code: 'internal_error',
          message: 'ECONNREFUSED /var/run/secret.sock',
          retryable: false,
        },
        route: 'listMeals',
      }),
    );

    expect(view.text()).not.toContain('ECONNREFUSED');
    expect(view.text()).not.toContain('secret.sock');
  });

  it('says WHY the result is empty, differently when a filter is on', async () => {
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page([]));

    expect(view.find('explore-empty')).not.toBeNull();
    expect(view.text()).toContain('The catalog is empty.');

    act(() => {
      view.must('chip-period-breakfast').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await tick();
    await stub.settle(1, page([]));
    // Now the empty set is the filter's doing, and the copy has to say so or the user thinks the
    // app is broken.
    expect(view.text()).toContain('Try removing one');
  });

  it('seeds the search box and the period chip from deep-link params', async () => {
    // `nutritime://explore?query=rice&period=lunch` (TSD §6.2's `ExploreParams`).
    const stub = deferredClient();
    const view = renderExplore(stub.client, { query: 'rice', period: 'lunch' });
    await tick();

    expect(stub.calls[0]).toMatchObject({ query: 'rice', period: 'lunch' });
    expect(searchInput(view.host).getAttribute('value')).toBe('rice');
    expect(view.must('chip-period-lunch').getAttribute('aria-checked')).toBe('true');
  });

  it('refuses an array-valued `query` rather than coercing it (T-22-05)', async () => {
    /**
     * `?query=rice&query=ricotta` parses to a `string[]` where `ExploreParams` says `string`.
     * Unreachable only because nothing links into the app yet (R-44) — the day the web export's
     * URL reaches the navigator, this read is live.
     *
     * Refused, never joined and never first-taken: `readStringParam`'s stated reason is that there
     * is no honest single answer to which one the user meant, and a search box holding
     * `rice,ricotta` would be the screen inventing one and then showing the user results for it.
     *
     * **The second half is what makes the first half mean something.** A reader that refused every
     * value would satisfy the refusal assertions on its own, so the same param is rendered again as
     * a single value and is required to arrive.
     */
    const refused = deferredClient();
    const refusedView = renderExplore(refused.client, { query: ['rice', 'ricotta'] });
    await tick();

    expect(searchInput(refusedView.host).getAttribute('value') ?? '').toBe('');
    expect(refusedView.text()).not.toContain('rice,ricotta');
    // No `query` key at all rather than an empty one: §11.3 makes a wrong-typed parameter a 400,
    // so a coerced array would earn the user an error state for a search they never typed.
    expect(refused.calls[0]).toStrictEqual({ page: 1, pageSize: 20 });

    const honoured = deferredClient();
    const honouredView = renderExplore(honoured.client, { query: 'rice' });
    await tick();

    expect(searchInput(honouredView.host).getAttribute('value')).toBe('rice');
    expect(honoured.calls[0]).toMatchObject({ query: 'rice' });
  });

  it('bounds an over-long `query` param at the length the field enforces (R-74)', async () => {
    /**
     * **R-74's second door, and the door is the URL rather than the field.**
     *
     * A user cannot type past `MEAL_QUERY_MAX_LENGTH` — `SearchField` slices `onChangeText` — so
     * every earlier assertion about this bound was made against the one path that could not break
     * it. A deep link carries whatever it likes: `param=101` was measured arriving as `sent=101`,
     * earning a `400 invalid_request` and an error state whose retry repeated the rejected
     * request. The user met a server error for a length the interface never let them reach.
     *
     * **Asserted on the REQUEST, not on the input's `value`.** A test that only checked the box
     * would be decoration here: the box was already bounded, and what was wrong was what left the
     * screen. `stub.calls[0]` is the same seam the array-param refusal above uses.
     *
     * **The control is the half that makes this a test.** Truncating to 99 would satisfy the
     * over-length assertion and fail the control; not truncating at all would satisfy the control
     * and fail the over-length assertion. No single constant satisfies both — which is the shape
     * Plan §10.3 names, "a control that passes under the mutation is not a control".
     */
    const overLong = 'a'.repeat(MEAL_QUERY_MAX_LENGTH + 1);
    const tooLong = deferredClient();
    const tooLongView = renderExplore(tooLong.client, { query: overLong });
    await tick();

    expect(tooLong.calls[0]?.query).toHaveLength(MEAL_QUERY_MAX_LENGTH);
    expect(tooLong.calls[0]?.query).toBe(overLong.slice(0, MEAL_QUERY_MAX_LENGTH));
    // What the user sees agrees with what was sent, or the box would offer to re-submit a length
    // the request already refused.
    expect(searchInput(tooLongView.host).getAttribute('value')).toHaveLength(MEAL_QUERY_MAX_LENGTH);

    // The control: a param at exactly the ceiling arrives untouched, character for character.
    const atLimit = 'b'.repeat(MEAL_QUERY_MAX_LENGTH);
    const exact = deferredClient();
    renderExplore(exact.client, { query: atLimit });
    await tick();

    expect(exact.calls[0]?.query).toBe(atLimit);
  });

  it('refuses an array-valued AND an unrecognised `period` (T-22-05)', async () => {
    /**
     * `period` is a union, so `readUnionParam` against `MEAL_PERIODS` is the right reader and the
     * array is only half of what it has to refuse: `?period=brunch` is as invalid as
     * `?period=lunch&period=dinner`, and a `readStringParam`-only guard would pass `brunch`
     * straight through to `queryFrom` and into a 400.
     *
     * Asserted on the chips as well as on the request, because the chips are what the user reads:
     * a period the screen filtered by without showing it selected would be a filter they cannot
     * find or remove.
     */
    const array = deferredClient();
    const arrayView = renderExplore(array.client, { period: ['lunch', 'dinner'] });
    await tick();

    expect(arrayView.must('chip-period-lunch').getAttribute('aria-checked')).toBe('false');
    expect(arrayView.must('chip-period-dinner').getAttribute('aria-checked')).toBe('false');
    expect(Object.keys(array.calls[0] ?? {})).not.toContain('period');

    const unknown = deferredClient();
    const unknownView = renderExplore(unknown.client, { period: 'brunch' });
    await tick();

    expect(Object.keys(unknown.calls[0] ?? {})).not.toContain('period');
    // The toolbar counts what is active, so an unrecognised value that had been admitted to the
    // filter state would be visible here even though it matches no chip.
    expect(unknownView.must('explore-filters').getAttribute('aria-label')).toBe(
      'Filters, 0 active',
    );

    const honoured = deferredClient();
    const honouredView = renderExplore(honoured.client, { period: 'lunch' });
    await tick();

    expect(honouredView.must('chip-period-lunch').getAttribute('aria-checked')).toBe('true');
    expect(honouredView.must('explore-filters').getAttribute('aria-label')).toBe(
      'Filters, 1 active',
    );
    expect(honoured.calls[0]).toMatchObject({ period: 'lunch' });
  });

  it('opens a meal through the navigator, carrying the origin', async () => {
    const first = CATALOG[0];
    if (first === undefined) {
      throw new Error('empty catalog');
    }
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page([first]));

    act(() => {
      view.must(`meal-${first.id}`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // `origin: 'explore'` is what lets ONE MealDetails screen be reached from four tabs (S-17).
    expect(view.navigate).toHaveBeenCalledWith('MealDetails', {
      mealId: first.id,
      origin: 'explore',
    });
  });

  it('ranks nothing itself — the rendered order is the order the server sent', async () => {
    // TSD §4.7 gives relevance one implementation and two callers. A screen that sorted its own
    // list would be a third source of truth that passes its own tests. Asserted by sending an
    // order the screen would have to actively destroy: reverse-alphabetical.
    const reversed = [...CATALOG].sort((a, b) => b.name.localeCompare(a.name)).slice(0, 6);
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(reversed));

    const rendered = [...view.host.querySelectorAll('[data-testid^="meal-"]')].map((node) =>
      node.getAttribute('data-testid'),
    );
    expect(rendered).toStrictEqual(reversed.map((meal) => `meal-${meal.id}`));
  });

  it('keeps each meal on its OWN row element when the list is reordered (T-13-04)', async () => {
    /**
     * **T-13-04's stable key, asserted through its consequence — the only thing about it a test
     * can see.**
     *
     * A React key is not in the DOM, and the `meal-<id>` ids every other test in this file matches
     * come from `MealCard`'s `testID` prop, not from `keyExtractor`. So an audit found that
     * `keyExtractor = (_meal, index) => String(index)` — the exact defect `ExploreScreen`'s own
     * docstring warns about — left all 26 catalog tests and the whole e2e suite green.
     *
     * What an index key really does is observable: React reconciles by key, so with a positional
     * key the element that held position 3 is REUSED for whatever meal now sits at position 3.
     * With the meal's id as the key, React moves the existing element instead, and the DOM node
     * for a given meal is the same object before and after. Node identity is the assertion.
     *
     * Reversed rather than shuffled: a reversal of four has no fixed point, so every id must move,
     * and there is no arrangement in which a positional key could accidentally agree.
     */
    const meals = CATALOG.slice(0, 4);
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(meals));

    const before = new Map(meals.map((meal) => [meal.id, view.must(`meal-${meal.id}`)]));

    // A search re-requests without unmounting the list: `useMealSearch` leaves the previous
    // `loaded` state in place while the next request is in flight, so the rows below are the same
    // rows, re-ordered — which is the only condition under which node identity means anything.
    act(() => {
      fireEvent.change(searchInput(view.host), { target: { value: 'anything' } });
    });
    await tick();
    await stub.settle(stub.calls.length - 1, page([...meals].reverse()));

    // The reorder really happened, or the identity check below would hold trivially.
    expect(
      [...view.host.querySelectorAll('[data-testid^="meal-"]')].map((node) =>
        node.getAttribute('data-testid'),
      ),
    ).toStrictEqual([...meals].reverse().map((meal) => `meal-${meal.id}`));

    for (const meal of meals) {
      expect(view.must(`meal-${meal.id}`), `${meal.id} must keep its own element`).toBe(
        before.get(meal.id),
      );
    }
  });

  it('builds only INITIAL_ROWS rows before the first paint, not the whole page (T-13-04)', async () => {
    /**
     * The render budget, and **this is the one place a DOM row count is the thing being measured
     * rather than a proxy for a result-set size** — R-45 forbids the latter, and names this
     * distinction. The response below carries twenty meals out of a stated sixty; the assertion is
     * that the screen built eight.
     *
     * Eight is `INITIAL_ROWS`, chosen because a card is tall and twenty is more than any phone
     * shows. `initialNumToRender={state.meals.length}` — the mutation that removes the bound —
     * renders twenty here and fails.
     *
     * **`total` is 60 and the page is 20, deliberately** (R-73). This assertion used to run against
     * `page(meals)`, whose `total` was `meals.length`, so `'20 meals'` was true of the loaded count
     * and of the catalogue's size at once and could not tell them apart. Now only the loaded count
     * produces it.
     */
    const meals = CATALOG.slice(0, 20);
    expect(
      meals,
      'the catalog must hold more than one window for this to mean anything',
    ).toHaveLength(20);

    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(meals, CATALOG.length));

    expect(mountedRows(view)).toBe(8);
    // And the list still announces the size of the RESULT SET it holds — eight would be the same
    // defect in the other direction, a rendering budget reported as a result.
    expect(announced(view)).toBe('20 meals');
  });

  it('reaches all sixty meals by paging, and still mounts only eight rows (R-73, FR-010)', async () => {
    /**
     * **FR-010: "Results page locally."** The clause R-73 found had no implementation and no test.
     *
     * Before this, `useMealSearch` never passed `queryFrom`'s third argument, so every request was
     * page 1 and a browsing user reached **twenty of sixty** — the meals were not lost, because
     * search and the chips re-query and surface other records, but the *browse* path stopped.
     *
     * Asserted on the requests and on the announced size, not on the row count: the row count is
     * `INITIAL_ROWS` at every result-set size, which is why R-45 calls it a rendering budget. The
     * last assertion is the other half of that — sixty loaded and still eight mounted, so paging
     * has not been bought by mounting sixty rows and sixty remote images (R-45, T-22-08).
     */
    expect(CATALOG, 'the sixty records R-73 counted').toHaveLength(60);

    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, catalogPage(1));

    expect(stub.calls[0]).toStrictEqual({ page: 1, pageSize: 20 });
    expect(announced(view)).toBe('20 meals');

    await press(view, 'explore-more');
    expect(stub.calls[1]).toStrictEqual({ page: 2, pageSize: 20 });
    // While the page is in flight the control stays, keeps its name, and says it is working.
    expect(view.must('explore-more').getAttribute('aria-busy')).toBe('true');
    expect(view.must('explore-more').textContent).toContain('Show more meals');
    await stub.settle(1, catalogPage(2));
    expect(announced(view)).toBe('40 meals');

    await press(view, 'explore-more');
    expect(stub.calls[2]).toStrictEqual({ page: 3, pageSize: 20 });
    await stub.settle(2, catalogPage(3));
    expect(announced(view)).toBe('60 meals');

    // Every record, in the order the server sent them, with nothing dropped or repeated.
    expect(
      [...stub.calls].every((call) => call.pageSize === 20),
      'the screen sends its own page size on every page',
    ).toBe(true);

    // Exhausted: the affordance goes away rather than asking for a fourth page that does not exist.
    expect(view.find('explore-more')).toBeNull();
    await tick();
    expect(stub.calls, 'no fourth request once the catalogue is exhausted').toHaveLength(3);

    expect(mountedRows(view)).toBe(8);
    expect(
      view.host.querySelectorAll('img').length,
      'sixty loaded meals must not mean sixty remote images',
    ).toBeLessThanOrEqual(8);
  });

  it('announces the meals in the LIST, never the size of the catalogue (R-73)', async () => {
    /**
     * **The false announcement, and the fixture that could not disagree with it.**
     *
     * `accessibilityLabel={`${state.total} meals`}` announced the server's unfiltered count — sixty
     * — over a twenty-row list. To the one user who cannot see the list's length for themselves
     * that is a statement of fact, and it was false by forty.
     *
     * The two assertions below are the control pair: the response must DISAGREE with the rendered
     * count, or `state.total` and `state.meals.length` are the same number and the assertion is
     * decoration. That is what `page`'s old `total: meals.length` made impossible.
     */
    const first = catalogPage(1);
    expect(first.meals, 'a page is twenty meals').toHaveLength(20);
    expect(first.total, 'and the catalogue is sixty — the fixture disagrees with the page').toBe(
      60,
    );

    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, first);

    expect(announced(view)).toBe('20 meals');

    // And it follows the list as the list grows, rather than being a constant that happened to be
    // right once: a label pinned only at the first page is satisfied by `'20 meals'` hard-coded.
    await press(view, 'explore-more');
    await stub.settle(1, catalogPage(2));
    expect(announced(view)).toBe('40 meals');
  });

  it('refuses a page that lands after a filter change, and restarts at page one (R-73)', async () => {
    /**
     * **The stale-request guard under paging.**
     *
     * A page-2 response *appends*, so a superseded one would not replace a result set — it would
     * mix two, leaving twenty meals of one query underneath twenty of another with nothing on
     * screen saying so. Two guards are exercised here at once:
     *
     *  - the chip tap must request **page 1** of the new query, not page 2. The requested page is
     *    derived from the query key during render, so it cannot survive the change;
     *  - the in-flight page 2 then answers and must commit **nothing**.
     *
     * Asserted by identity as well as by size, because a *replace* by the stale page would also
     * leave twenty meals on screen. `CATALOG[0]` is page 1's first record and `CATALOG[20]` is page
     * 2's, so the pair separates "refused" from "replaced" and from "appended".
     */
    const firstOfPageOne = CATALOG[0];
    const firstOfPageTwo = CATALOG[20];
    if (firstOfPageOne === undefined || firstOfPageTwo === undefined) {
      throw new Error('the catalogue is too small for two pages');
    }

    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, catalogPage(1));

    await press(view, 'explore-more');
    expect(stub.calls[1]).toStrictEqual({ page: 2, pageSize: 20 });

    await press(view, 'chip-diet-vegan');
    expect(stub.calls[2]).toStrictEqual({ page: 1, pageSize: 20, diet: 'vegan' });
    expect(stub.signals[1]?.aborted, 'the superseded page is aborted too').toBe(true);

    // Now the superseded page 2 answers. Nothing may change.
    await stub.settle(1, catalogPage(2));
    expect(announced(view), 'a refused page appends nothing').toBe('20 meals');
    expect(view.find(`meal-${firstOfPageOne.id}`), 'page 1 must survive').not.toBeNull();
    expect(view.find(`meal-${firstOfPageTwo.id}`), 'page 2 must not arrive').toBeNull();

    // And the new query's own first page replaces cleanly.
    await stub.settle(2, page(CATALOG.slice(0, 3), 3));
    expect(announced(view)).toBe('3 meals');
  });

  it('starts a query it had already paged over again from page one', async () => {
    /**
     * The other half of the page reset, and the half a derivation alone does not cover.
     *
     * Deriving the page from the query key makes the CURRENT render right. It does not forget:
     * leaving `{ key: unfiltered, page: 2 }` stored while the user browses a filtered query means
     * that coming back asks for page 2 of a list holding nothing — twenty records skipped, with no
     * gap a reader would see. So the record is reset once the render has settled, and the last
     * assertion below is what says so.
     */
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, catalogPage(1));
    await press(view, 'explore-more');
    await stub.settle(1, catalogPage(2));
    expect(announced(view)).toBe('40 meals');

    await press(view, 'chip-diet-vegan');
    await stub.settle(2, page(CATALOG.slice(0, 3), 3));

    // The same chip again withdraws the filter, so this is the query that had reached page 2.
    await press(view, 'chip-diet-vegan');
    expect(stub.calls[3]).toStrictEqual({ page: 1, pageSize: 20 });
    await stub.settle(3, catalogPage(1));
    expect(announced(view)).toBe('20 meals');
  });

  it('folds a record the server sent twice only once', async () => {
    /**
     * `keyExtractor` returns `meal.id`, so one id twice is one React key twice — T-13-04's lesson
     * arriving by a new route. The guards make a repeated page unrequestable, so this asserts the
     * append itself is by id rather than a blind concatenation.
     *
     * The overlap is deliberate: page 2 here starts one record early, so nineteen of its twenty are
     * new. `39 meals`, not `40`. **The screen folds by the page it ASKED for, not the one the
     * response echoes** — which is why the fixture's own `page` field is left at 1 and changes
     * nothing; the generation counter is what ties a response to its request.
     */
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, catalogPage(1));
    await press(view, 'explore-more');
    await stub.settle(1, page(CATALOG.slice(19, 39), CATALOG.length));

    expect(announced(view)).toBe('39 meals');
    // Still more to come, so an overlap has not been read as the end of the catalogue.
    expect(view.find('explore-more')).not.toBeNull();
  });

  it("carries FR-007's disclaimer, above the results and in every state (T-24-03)", async () => {
    /**
     * **PRD FR-007: "The UI carries a general safety disclaimer."**
     *
     * T-24-03's acceptance reads "peanut allergy excludes meals from Home **and** Explore", and
     * Explore excludes nothing — by design. PRD FR-010 gives this screen period, diet and price and
     * no allergen clause, FR-007 scopes allergen rejection to *recommendations*, and FR-011 puts
     * the allergen notices on the detail screen; `TSD.md` §8.4 case 2's "off Home and out of
     * Explore" contradicts all three, and PRD outranks TSD. What was genuinely unmet is the
     * **disclaimer** — one occurrence in the PRD, none in SDD or TSD, and `Plan.md` scopes it to
     * T-15-06, which is Home.
     *
     * Asserted before any response, because it is a property of the screen rather than of a result.
     * And asserted as NOT an alert, which is `HomeScreen`'s treatment for the same requirement: it
     * is present before the user is, so it reads in normal document order.
     */
    const stub = deferredClient();
    const view = renderExplore(stub.client);

    const disclaimer = view.must('explore-disclaimer');
    expect(view.find('explore-list'), 'asserted before any response has arrived').toBeNull();
    expect(disclaimer.textContent).toContain('Check the label if it matters');
    expect(disclaimer.textContent).toContain('not filtered by the allergies you set');
    expect(disclaimer.textContent).toContain('This is not medical advice');
    expect(disclaimer.getAttribute('role')).not.toBe('alert');
    // react-native-web maps `accessibilityLiveRegion: 'none'` to `aria-live="off"`, so "not a live
    // region" is an attribute with a value here rather than an absent one.
    expect(disclaimer.getAttribute('aria-live')).toBe('off');

    /**
     * **And the sentence is TRUE of the screen, which is the half copy cannot assert by itself.**
     *
     * The record is taken from the catalogue by its own `allergenTags` rather than hand-named,
     * because the subject here is the screen and the screen has never heard of `allergenTags` — so
     * the catalogue is a different source from the code under test (BRIEF §6.3), not the same one.
     * Any future "fix" that made Explore filter — Amendment 15 ruling 2's stop condition — fails
     * here.
     */
    const withPeanut = CATALOG.find((meal) => meal.allergenTags.includes('peanut'));
    if (withPeanut === undefined) {
      throw new Error('no catalogue record carries a peanut tag');
    }
    await tick();
    await stub.settle(0, page([withPeanut], CATALOG.length));

    expect(view.find(`meal-${withPeanut.id}`), 'Explore excludes nothing').not.toBeNull();
    expect(announced(view)).toBe('1 meals');

    // Above the results: a qualification below them qualifies nothing.
    const list = view.must('explore-list');
    expect(
      view.must('explore-disclaimer').compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('retries from the first page, and the retry really re-requests', async () => {
    /**
     * **This control did nothing, and its comment argued for it** (BRIEF §6.1j).
     *
     * `onRetry` read `setSearch((current) => current); setFilters((current) => ({ ...current }))`
     * under a comment saying the retry "re-mounts the list by identity". `useMealSearch`'s effect
     * never depended on that object — only on the search text and the three filter primitives, and
     * the retry changed neither — so pressing it re-rendered the screen and re-requested nothing.
     *
     * From page ONE, and that is the second half: the failure below happens on page 3, which leaves
     * nothing loaded, so re-requesting page 3 would show records 41-60 as the whole catalogue.
     */
    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, catalogPage(1));
    await press(view, 'explore-more');
    await stub.settle(1, catalogPage(2));
    await press(view, 'explore-more');
    expect(stub.calls[2]).toStrictEqual({ page: 3, pageSize: 20 });

    await stub.reject(
      2,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        wire: null,
        route: 'listMeals',
      }),
    );
    expect(view.find('explore-error')).not.toBeNull();

    act(() => {
      buttonLabelled(view.host, 'Try again').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await tick();

    expect(stub.calls, 'the retry issues a request').toHaveLength(4);
    expect(stub.calls[3]).toStrictEqual({ page: 1, pageSize: 20 });
    await stub.settle(3, catalogPage(1));
    expect(announced(view)).toBe('20 meals');

    /**
     * **And again from a failure on page ONE, which is the half a page reset cannot cover.**
     *
     * Above, the retry changed the requested page from 3 to 1, and a changed page is itself an
     * effect dependency — so that case would pass even if the retry did nothing else. A probe
     * measured exactly that: neutralising the reload counter changed **0 of 44** until this second
     * phase existed. Here the page is 1 before the press and 1 after, so the counter is the only
     * input that moves and the only reason a request goes out at all.
     */
    await press(view, 'chip-diet-vegan');
    expect(stub.calls[4]).toStrictEqual({ page: 1, pageSize: 20, diet: 'vegan' });
    await stub.reject(
      4,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        wire: null,
        route: 'listMeals',
      }),
    );
    expect(view.find('explore-error')).not.toBeNull();

    act(() => {
      buttonLabelled(view.host, 'Try again').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await tick();

    expect(stub.calls, 'a retry on page one still has to re-request').toHaveLength(6);
    expect(stub.calls[5]).toStrictEqual({ page: 1, pageSize: 20, diet: 'vegan' });
  });

  it("waits the screen's own default before searching, and that default is 300 ms", async () => {
    /**
     * **SDD §11: "Search debounces at ~300 ms."**
     *
     * Every other test in this file injects `debounceMs={0}`, so until now `SEARCH_DEBOUNCE_MS`
     * could have been 3 000 and nothing would have said so — the e2e search spec polls with a 20 s
     * timeout and would not have noticed either. This one withholds the prop, so the screen falls
     * back to its own constant, and drives a fake clock to the two sides of the figure the
     * document gives.
     *
     * The numbers below are SDD's, written out rather than imported: importing the constant and
     * advancing by it would compare the constant to itself and pass at any value.
     */
    vi.useFakeTimers();
    try {
      const stub = deferredClient();
      const view = renderExplore(stub.client, undefined, null);
      // The empty search is not debounced at all — `delay` is 0 until there is text — so the
      // initial load goes out on the next tick.
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      await stub.settle(0, page(CATALOG.slice(0, 2)));
      const beforeTyping = stub.calls.length;

      act(() => {
        fireEvent.change(searchInput(view.host), { target: { value: 'rice' } });
      });

      await act(async () => {
        vi.advanceTimersByTime(299);
      });
      expect(stub.calls.length, 'nothing may go out before the debounce elapses').toBe(
        beforeTyping,
      );

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(stub.calls.length).toBe(beforeTyping + 1);
      expect(stub.calls[stub.calls.length - 1]?.query).toBe('rice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not make a chip tap wait for the text debounce (P28, F-6)', async () => {
    /**
     * **The rule `useMealSearch.ts` stated for two phases while doing something else.**
     *
     * Its docstring said "a filter change fires immediately and a text change waits". The
     * expression was `trimmed === '' || page > 1 ? 0 : debounceMs`, which asks *is the box empty*
     * rather than *what did the user just do* — so a chip tap with text in the box paid the whole
     * debounce. Measured through Playwright at P28: **30.8 ms** for the same tap with an empty box
     * against **333.9 ms** with text in it, on a 150 ms target.
     *
     * **Asserted on the clock rather than on the wall**, because a 303 ms gap in a performance
     * report is a number somebody has to read, and this is a yes/no question: with text in the box
     * and the debounce **not yet elapsed**, does the chip's request reach the client at all?
     *
     * **Its control is the test directly above.** That one proves typing still waits the full
     * 300 ms, so a "fix" that deleted the debounce outright would redden it. Neither test alone
     * separates "keyed off what changed" from "not debounced"; together they pin the rule.
     */
    vi.useFakeTimers();
    try {
      const stub = deferredClient();
      const view = renderExplore(stub.client, undefined, null);
      await act(async () => {
        vi.advanceTimersByTime(0);
      });
      await stub.settle(0, page(CATALOG.slice(0, 2)));

      // Put text in the box and let its own debounce run out, so the state under test is "the box
      // holds text", not "a keystroke is still pending".
      act(() => {
        fireEvent.change(searchInput(view.host), { target: { value: 'rice' } });
      });
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      await stub.settle(stub.calls.length - 1, page(CATALOG.slice(0, 1)));
      const beforeTap = stub.calls.length;

      // Now the deliberate action, and only ONE millisecond of clock afterwards: far inside the
      // 300 ms a text change would have cost.
      // The click is dispatched inline rather than through this file's `press` helper, which
      // awaits a REAL `setTimeout` and would never resolve while the clock is faked.
      act(() => {
        view.must('chip-period-lunch').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(stub.calls.length, 'a chip tap must not wait for the text debounce').toBe(
        beforeTap + 1,
      );
      // And it carries both the filter and the text already in the box - firing early must not
      // mean firing without the query.
      expect(stub.calls[stub.calls.length - 1]).toMatchObject({
        period: 'lunch',
        query: 'rice',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
