import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal, MealListResponse } from '@nutritime/contracts';
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

function page(meals: readonly Meal[]): MealListResponse {
  return { meals: [...meals], page: 1, pageSize: 20, total: meals.length };
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
  params?: {
    readonly query?: string;
    readonly period?: 'breakfast' | 'lunch' | 'dinner' | 'snack';
  },
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
     * distinction. The response below carries twenty meals and says so in `total`; the assertion
     * is that the screen built eight.
     *
     * Eight is `INITIAL_ROWS`, chosen because a card is tall and twenty is more than any phone
     * shows. `initialNumToRender={state.meals.length}` — the mutation that removes the bound —
     * renders twenty here and fails.
     */
    const meals = CATALOG.slice(0, 20);
    expect(
      meals,
      'the catalog must hold more than one window for this to mean anything',
    ).toHaveLength(20);

    const stub = deferredClient();
    const view = renderExplore(stub.client);
    await tick();
    await stub.settle(0, page(meals));

    expect(view.host.querySelectorAll('[data-testid^="meal-"]')).toHaveLength(8);
    // And the list still announces the real size, so the bound is a rendering budget and not a
    // silently truncated result.
    expect(view.must('explore-list').getAttribute('aria-label')).toBe('20 meals');
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
});
