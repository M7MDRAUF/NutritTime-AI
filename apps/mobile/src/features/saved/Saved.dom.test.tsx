/**
 * T-17-02 and T-17-07 — the Saved screen's suite.
 *
 * Two claims are the reason this file exists, and both are about data the seeded catalog cannot
 * produce, so both are constructed rather than hoped for (Plan §6.1):
 *
 *  1. **A favourite can outlive its meal.** The favourites store holds ids and never meals, and
 *     nothing enforces a stored id against the catalog — it is reseeded by hand and
 *     `catalogVersion` moves. So the fixture below holds one id the server answers and one it
 *     404s, and ONE render asserts both outcomes: the resolved meal on screen, the missing one
 *     named, and the section neither failed nor silently shortened.
 *  2. **The two sections are independent.** All four combinations of empty/non-empty are rendered,
 *     because the defect this guards is a single empty state for the screen — which passes a test
 *     that only ever renders the both-empty case.
 *
 * **Rendered ids are compared, never row counts** (R-45). A count is a statement about the
 * rendering budget; the ids are a statement about the data.
 *
 * The favourites store is seeded through the storage driver rather than by dispatching, so the
 * screen is exercised on a list that came off the "device" — which is where an orphan comes from.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { createRoot } from 'react-dom/client';
import { getByRole } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { CustomMeal, Meal } from '@nutritime/contracts';
import { conflictingAllergens } from '@nutritime/domain';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { ApiProvider } from '../../infrastructure/api/ApiProvider.js';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import { mealPath } from '../../infrastructure/api/routes.js';
import { favoritesActions, favoritesStore } from '../../state/favorites/index.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { MAX_CUSTOM_MEALS, customMealsStore } from '../../state/customMeals/index.js';
import { composeCustomMeal } from './mealFormValidation.js';
import type { MealFormDraft } from './mealFormValidation.js';
import { SavedScreen } from './SavedScreen.js';

const NOW = '2026-09-13T08:30:00.000Z';
const CLOCK = (): string => NOW;

/** Real catalog records, for the same reason the Explore suite uses them: fixtures choose. */
const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((record) =>
  mealSchema.parse(record),
);

/**
 * The 404 a missing meal actually produces.
 *
 * Built to `apps/server/src/errors.ts`'s own `meal_not_found` body rather than invented: a
 * hand-made error can carry a status/kind/code combination the server would never send, and then
 * the test asserts against a case that cannot happen.
 */
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

const DRAFT: MealFormDraft = {
  name: 'Overnight oats',
  description: 'Oats soaked overnight in milk.',
  mealPeriods: ['breakfast'],
  dietTags: ['vegetarian'],
  allergenTags: ['milk'],
  ingredients: [{ name: 'Rolled oats', measure: '80 g' }],
  instructions: ['Combine the oats and milk.'],
  priceText: '4.50',
  preparationMinutesText: '10',
  caloriesText: '',
  proteinGramsText: '',
  carbsGramsText: '',
  fatGramsText: '',
  servingsText: '',
};

/**
 * A custom meal built through the real `composeCustomMeal`, so every fixture in this file is a
 * record `customMealSchema` accepts — which is what the `customMeals` reducer and the storage read
 * path both require. A hand-written literal would be the one thing the store silently refuses.
 */
function recipe(id: string, name: string, patch: Partial<MealFormDraft> = {}): CustomMeal {
  const result = composeCustomMeal(
    { ...DRAFT, name, ...patch },
    { now: () => NOW, newId: () => id, existingIds: [] },
  );
  if (!result.ok) {
    throw new Error(`fixture is not a valid custom meal: ${JSON.stringify(result.errors)}`);
  }
  return result.meal;
}

/** Hex-only, so it satisfies `MEAL_ID_PATTERN` the way a generated id does. */
function recipeId(index: number): string {
  return `cccccccc-3333-4333-8333-${index.toString(16).padStart(12, '0')}`;
}

function recipes(count: number): readonly CustomMeal[] {
  return Array.from({ length: count }, (_unused, index) =>
    recipe(recipeId(index), `Recipe ${String(index)}`),
  );
}

/** A 500, for the failure that is NOT a 404 and NOT a transport failure. */
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

/**
 * A client that answers from a fixed set of meals, 500s the ids in `failing`, and 404s the rest.
 *
 * The `failing` set is what makes the non-404 row-level path reachable: a uniformly-rejecting stub
 * can only produce a whole-section failure, so it can never render `saved-favorites-unresolved`.
 */
function catalogClient(
  meals: readonly Meal[],
  failing: readonly string[] = [],
): {
  readonly client: ApiClient;
  readonly asked: string[];
} {
  const asked: string[] = [];
  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: (mealId) => {
      asked.push(mealId);
      if (failing.includes(mealId)) {
        return Promise.reject(serverError());
      }
      const meal = meals.find((candidate) => candidate.id === mealId);
      return meal === undefined ? Promise.reject(notFound()) : Promise.resolve(meal);
    },
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };
  return { client, asked };
}

/**
 * A client that reproduces the SYNCHRONOUS throw, using the real path builder.
 *
 * `mealPath` runs `encodeURIComponent`, which raises `URIError` on a lone surrogate — and it does so
 * inside `getMeal`'s argument list, before any promise exists. The real `mealPath` is called rather
 * than a hand-thrown error so the test cannot drift from the mechanism it is about.
 */
function surrogateClient(meals: readonly Meal[]): ApiClient {
  return {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: (mealId) => {
      // Throws here for a lone surrogate, exactly as the real client does.
      mealPath(mealId);
      const meal = meals.find((candidate) => candidate.id === mealId);
      return meal === undefined ? Promise.reject(notFound()) : Promise.resolve(meal);
    },
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };
}

/** Every `getMeal` rejects with the same error — for the two whole-section failure states. */
function failingClient(error: unknown): ApiClient {
  return {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: () => Promise.reject(error),
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };
}

interface Deferred {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly resolve: (meal: Meal) => void;
}

/**
 * A client whose every `getMeal` is a promise this test completes when it chooses.
 *
 * Kept per call rather than per id, because the assertion that matters most is about ORDERING: a
 * slow first batch landing after a fast second one must not render. Real timing cannot make that
 * happen on demand.
 */
function deferredClient(): {
  readonly client: ApiClient;
  readonly calls: readonly Deferred[];
  settle(index: number, meal: Meal): Promise<void>;
  flush(): Promise<void>;
} {
  const calls: Deferred[] = [];
  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: (mealId, signal) =>
      new Promise<Meal>((resolve) => {
        calls.push({ id: mealId, signal, resolve });
      }),
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  return {
    client,
    calls,
    settle: async (index, meal) => {
      calls[index]?.resolve(meal);
      await flush();
    },
    flush,
  };
}

interface RenderOptions {
  readonly client: ApiClient;
  readonly favorites?: readonly string[];
  readonly custom?: readonly CustomMeal[];
  readonly params?: unknown;
  /** Raw stored bytes, so a corrupt entry can be planted under a key. */
  readonly raw?: Readonly<Record<string, string>>;
  /** Declared allergies, seeded onto `DEFAULT_PREFERENCES` under the `preferences` key. */
  readonly allergies?: readonly string[];
  /**
   * Break the driver, which is the only way to reach `entryStatus: 'unavailable'`.
   *
   * **`multiGet`, not `getItem`** — and the difference matters. Boot hydration is one `multiGet`
   * across all six keys (`hydrate.ts`), and the stores read that snapshot rather than calling
   * `repository.get()`, so failing `getItem` changes nothing a store can see. When `multiGet`
   * throws, `hydrateStorage` marks **every** key `unavailable` at once, which is also the honest
   * shape of the real failure: the driver is broken, not one key.
   */
  readonly failDriver?: 'multiGet' | 'getItem' | 'setItem' | 'removeItem';
}

/**
 * Mounted roots, torn down after each test.
 *
 * Required now rather than tidy-mindedness: `Sheet` renders through `Modal`, which portals to
 * `document.body` instead of the harness's own container, so the sheet assertions have to query the
 * document — and a leftover host from an earlier test would then be in scope for them.
 */
const mounted: { readonly root: Root; readonly host: HTMLElement }[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => {
      entry.root.unmount();
    });
    entry.host.remove();
  }
});

interface View {
  readonly host: HTMLElement;
  readonly navigate: ReturnType<typeof vi.fn>;
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  text(): string;
  /** The two section containers, in document order. */
  sectionOrder(): string[];
  idsWithPrefix(prefix: string): string[];
  favoriteIds(): string[];
  recipeIds(): string[];
  orphanIds(): string[];
  press(testID: string): Promise<void>;
  /** For anything inside a `Sheet`: `Modal` portals to `document.body`, not to our container. */
  findAnywhere(testID: string): HTMLElement | null;
  pressAnywhere(testID: string): Promise<void>;
  /** Favourite something from elsewhere — which is what the heart on `MealDetails` does. */
  favorite(mealId: string): Promise<void>;
  /**
   * Re-render the SAME root with different route params.
   *
   * The same root, deliberately: `createRoot(...).render()` a second time RECONCILES rather than
   * remounting, which is the only way to ask whether a params change preserves a DOM node. A fresh
   * root would remount everything and every identity assertion would fail for the wrong reason.
   */
  rerenderWith(params: unknown): Promise<void>;
  settle(): Promise<void>;
}

async function renderSaved(options: RenderOptions): Promise<View> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const navigate = vi.fn();

  const initial: Record<string, string> = {
    [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, options.favorites ?? [], NOW),
    [STORAGE_KEYS.customMeals]: encodeEnvelope(STORAGE_SCHEMA_VERSION, options.custom ?? [], NOW),
    [STORAGE_KEYS.preferences]: encodeEnvelope(
      STORAGE_SCHEMA_VERSION,
      { ...DEFAULT_PREFERENCES, allergies: [...(options.allergies ?? [])] },
      NOW,
    ),
    ...(options.raw ?? {}),
  };
  // Hoisted, so the runtime object is stable across renders: a fresh one re-runs
  // `StorageProvider`'s effect and rebuilds every store, which would make a re-render look like a
  // remount and prove nothing.
  const driver = memoryDriver(initial);
  if (options.failDriver !== undefined) {
    driver.failOn.add(options.failDriver);
  }
  const runtime = { driver, now: CLOCK };

  let favoritesDispatch: ((action: never) => void) | null = null;
  function Capture(): ReactNode {
    favoritesDispatch = favoritesStore.useDispatch() as (action: never) => void;
    return null;
  }

  const treeFor = (params: unknown): ReactNode => (
    <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
      <ApiProvider client={options.client}>
        <StorageProvider runtime={runtime}>
          <preferencesStore.Provider>
            <favoritesStore.Provider>
              <customMealsStore.Provider>
                <Capture />
                <SavedScreen
                  route={{ key: 'saved-1', name: 'Saved', params } as never}
                  navigation={{ navigate } as never}
                />
              </customMealsStore.Provider>
            </favoritesStore.Provider>
          </preferencesStore.Provider>
        </StorageProvider>
      </ApiProvider>
    </ThemeProvider>
  );

  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(treeFor(options.params));
  });

  const settle = async (): Promise<void> => {
    // Three, not one: hydration resolves, the stores mount, and then the favourites requests
    // settle — each is its own microtask turn plus the render React schedules for it.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await settle();

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  const must = (testID: string): HTMLElement => {
    const found = find(testID);
    if (found === null) {
      throw new Error(`no element for testID ${testID}`);
    }
    return found;
  };
  const idsWithPrefix = (prefix: string): string[] =>
    [...host.querySelectorAll(`[data-testid^="${prefix}"]`)].map((node) =>
      (node.getAttribute('data-testid') ?? '').slice(prefix.length),
    );
  /**
   * **This harness's own `host` first, and `document.body` only as a fallback.**
   *
   * A body-rooted query is unavoidable for anything inside a `Sheet`: it renders through `Modal`,
   * which portals to `document.body` rather than into the container this harness created. But a
   * body query is ambiguous the moment two trees are mounted at once, and **this file has an `it`
   * that renders twice** — the one comparing `recovered` against `unavailable` — so the ambiguity is
   * reachable here rather than hypothetical. W10 lost a negative control to exactly this: its
   * control had been typing into an earlier tree and passing for a reason unrelated to its subject.
   *
   * Trying `host` first means the fallback only ever runs for a genuinely portalled node, and no
   * caller can silently act on another render's DOM for anything rendered in-tree.
   */
  const findAnywhere = (testID: string): HTMLElement | null => {
    const own = host.querySelector(`[data-testid="${testID}"]`);
    if (own instanceof HTMLElement) {
      return own;
    }
    const portalled = document.body.querySelector(`[data-testid="${testID}"]`);
    return portalled instanceof HTMLElement ? portalled : null;
  };

  return {
    host,
    navigate,
    find,
    must,
    text: () => host.textContent ?? '',
    sectionOrder: () =>
      [
        ...host.querySelectorAll('[data-testid="saved-favorites"], [data-testid="saved-custom"]'),
      ].map((node) => node.getAttribute('data-testid') ?? ''),
    idsWithPrefix,
    favoriteIds: () => idsWithPrefix('saved-favorite-'),
    recipeIds: () => idsWithPrefix('saved-recipe-'),
    orphanIds: () => idsWithPrefix('saved-orphan-'),
    press: async (testID) => {
      await act(async () => {
        must(testID).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },
    rerenderWith: async (params) => {
      await act(async () => {
        root.render(treeFor(params));
      });
      await settle();
    },
    findAnywhere,
    pressAnywhere: async (testID) => {
      const found = findAnywhere(testID);
      if (found === null) {
        throw new Error(`no element anywhere for testID ${testID}`);
      }
      await act(async () => {
        found.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },
    favorite: async (mealId) => {
      await act(() => {
        favoritesDispatch?.(favoritesActions.add(mealId) as never);
      });
      await settle();
    },
    settle,
  };
}

function catalogMeal(index: number): Meal {
  const meal = CATALOG[index];
  if (meal === undefined) {
    throw new Error('the seeded catalog is too small for this fixture');
  }
  return meal;
}

describe('SavedScreen — two independent sections (T-17-02)', () => {
  /**
   * All four combinations, because the defect being guarded against is ONE empty state for the
   * screen — and that defect passes a suite which only ever renders the both-empty case.
   */
  it('shows the favourites empty state beside a populated recipe list', async () => {
    const own = recipes(3);
    const view = await renderSaved({
      client: catalogClient([]).client,
      favorites: [],
      custom: own,
    });

    expect(view.find('saved-favorites-empty')).not.toBeNull();
    expect(view.find('saved-custom-empty')).toBeNull();
    // Ids, not a count: the three recipes are on screen while the other section says it is empty.
    expect(view.recipeIds()).toStrictEqual(own.map((meal) => meal.id));
    expect(view.text()).toContain('Recipe 0');
  });

  it('shows the recipe empty state beside a populated favourites list', async () => {
    const meals = [catalogMeal(0), catalogMeal(1)];
    const view = await renderSaved({
      client: catalogClient(meals).client,
      favorites: meals.map((meal) => meal.id),
      custom: [],
    });

    expect(view.find('saved-custom-empty')).not.toBeNull();
    expect(view.find('saved-favorites-empty')).toBeNull();
    expect(view.favoriteIds()).toStrictEqual(meals.map((meal) => meal.id));
  });

  it('shows both empty states when both lists are empty', async () => {
    const view = await renderSaved({ client: catalogClient([]).client });

    expect(view.find('saved-favorites-empty')).not.toBeNull();
    expect(view.find('saved-custom-empty')).not.toBeNull();
    expect(view.favoriteIds()).toStrictEqual([]);
    expect(view.recipeIds()).toStrictEqual([]);
  });

  it('shows neither empty state when both lists have content', async () => {
    const meals = [catalogMeal(2)];
    const own = recipes(2);
    const view = await renderSaved({
      client: catalogClient(meals).client,
      favorites: meals.map((meal) => meal.id),
      custom: own,
    });

    expect(view.find('saved-favorites-empty')).toBeNull();
    expect(view.find('saved-custom-empty')).toBeNull();
    expect(view.favoriteIds()).toStrictEqual(meals.map((meal) => meal.id));
    expect(view.recipeIds()).toStrictEqual(own.map((meal) => meal.id));
  });

  it('keeps the recipe list on screen while the favourites are still loading', async () => {
    // The sharpest form of "independent": one section's pending request must not withhold the
    // other section, which reads a store and has nothing to wait for.
    const meals = [catalogMeal(0)];
    const own = recipes(2);
    const deferred = deferredClient();
    const view = await renderSaved({
      client: deferred.client,
      favorites: meals.map((meal) => meal.id),
      custom: own,
    });

    expect(view.find('saved-favorites-loading')).not.toBeNull();
    expect(view.favoriteIds()).toStrictEqual([]);
    expect(view.recipeIds()).toStrictEqual(own.map((meal) => meal.id));

    await deferred.settle(0, catalogMeal(0));
    expect(view.find('saved-favorites-loading')).toBeNull();
    expect(view.favoriteIds()).toStrictEqual(meals.map((meal) => meal.id));
  });

  it('does NOT render a superseded batch that lands after the newer one', async () => {
    /**
     * **The assertion the generation counter exists for.** A favourite added from the `MealDetails`
     * heart while this screen is mounted changes the id list, so a second batch of requests goes
     * out while the first is still in flight. `abort()` cannot un-resolve a promise whose
     * continuation is already queued as a microtask, so only the newest-batch check makes the
     * superseded answer unrenderable — and the visible symptom of getting it wrong is the newly
     * favourited meal vanishing from the list a moment after it appeared.
     *
     * Settled deliberately out of order: the newer batch first, then the older one.
     */
    const first = catalogMeal(0);
    const added = catalogMeal(1);
    const deferred = deferredClient();
    const view = await renderSaved({ client: deferred.client, favorites: [first.id] });

    expect(deferred.calls.map((call) => call.id)).toStrictEqual([first.id]);

    await view.favorite(added.id);
    // The store prepends, so the second batch asks for the new id first.
    expect(deferred.calls.map((call) => call.id)).toStrictEqual([first.id, added.id, first.id]);
    // The superseded request is aborted; the newest ones are not.
    expect(deferred.calls[0]?.signal.aborted).toBe(true);
    expect(deferred.calls[2]?.signal.aborted).toBe(false);

    await deferred.settle(1, added);
    await deferred.settle(2, first);
    expect(view.favoriteIds()).toStrictEqual([added.id, first.id]);

    // Now the superseded batch answers. Nothing may change.
    await deferred.settle(0, first);
    expect(view.favoriteIds()).toStrictEqual([added.id, first.id]);
  });

  it('renders the favourites in the order the store holds them, sorting nothing', async () => {
    // Reverse-alphabetical, so a screen that sorted its own list would have to actively destroy
    // this order to pass.
    const meals = [...CATALOG].sort((a, b) => b.name.localeCompare(a.name)).slice(0, 4);
    const view = await renderSaved({
      client: catalogClient(meals).client,
      favorites: meals.map((meal) => meal.id),
    });
    expect(view.favoriteIds()).toStrictEqual(meals.map((meal) => meal.id));
  });

  it('has exactly one scroll container, and it is the screen (T-22-08)', async () => {
    /**
     * **The other half of "rows are mapped, not virtualised"** (`SavedScreen.tsx:50-53`), and the
     * half nothing asserted.
     *
     * Both sections must be mounted at once for their empty states to be independent, which is why
     * this screen is one `ScrollView` over mapped rows rather than a list per section. T-22-08
     * measured what that costs — twenty favourites mount twenty remote photographs — and measured
     * the obvious fix: putting a `FlatList` inside `FavoritesSection` does drop the render to
     * `initialNumToRender`, and it also puts a **second** scroll container inside the first. React
     * Native's own `VirtualizedList` says why that is wrong — "never be nested inside plain
     * ScrollViews with the same orientation because it can break windowing and other
     * functionality" — and react-native-web 0.21.2 ships that warning **commented out**
     * (`vendor/react-native/VirtualizedList/index.js`, above the `__DEV__` block, pending
     * necolas/react-native-web#2239), so on the web surface it would arrive with no diagnostic at
     * all. The whole suite stayed green under that mutation; this is the assertion that would not.
     *
     * It is deliberately NOT an assertion that every row renders. That would pin the current
     * eager list in place and forbid the fix. A `SectionList` replacing the `ScrollView` — RN's own
     * recommended "another VirtualizedList-backed container" — keeps exactly one scroll container
     * and passes this unchanged.
     *
     * The selector is react-native-web's atomic class convention (`r-<property>-<hash>`), which is
     * what a `ScrollView` actually carries in the DOM; an upgrade that renamed it would fail here
     * loudly, which is the right way for a claim about a library to rot.
     */
    const meals = CATALOG.slice(0, 4);
    const view = await renderSaved({
      client: catalogClient(meals).client,
      favorites: meals.map((meal) => meal.id),
      custom: recipes(2),
    });

    const scrollers = [...view.host.querySelectorAll('*')].filter(
      (node) => node instanceof HTMLElement && /r-overflowY-/.test(node.className),
    );

    // Identity, not a count: "which element scrolls" is the claim, and a bare `1` would also be
    // satisfied by the inner list scrolling while the screen did not.
    expect(scrollers.map((node) => node.getAttribute('data-testid'))).toStrictEqual([
      'saved-screen',
    ]);
    // And both sections are inside it, which is the reason there is only one.
    expect(view.sectionOrder()).toStrictEqual(['saved-favorites', 'saved-custom']);
  });
});

describe('SavedScreen — a favourite that outlived its meal', () => {
  const good = catalogMeal(0);
  const GONE = 'meal-that-was-reseeded-away';

  it('renders what resolved AND names what could not be found, in one render', async () => {
    const view = await renderSaved({
      client: catalogClient([good]).client,
      favorites: [good.id, GONE],
    });

    // The resolved half survives.
    expect(view.favoriteIds()).toStrictEqual([good.id]);
    expect(view.text()).toContain(good.name);

    // The missing half is SAID, not dropped.
    expect(view.find('saved-favorites-missing')).not.toBeNull();
    expect(view.text()).toContain('1 favourite could not be found');
    expect(view.orphanIds()).toStrictEqual([GONE]);

    // And the section did not fail, nor claim to be empty.
    expect(view.find('saved-favorites-error')).toBeNull();
    expect(view.find('saved-favorites-offline')).toBeNull();
    expect(view.find('saved-favorites-empty')).toBeNull();
  });

  it('does not fail the section when the ONLY favourite is gone', async () => {
    // The hardest case: nothing resolved at all, and it is still not a failure — the request
    // succeeded and answered "no such meal".
    const view = await renderSaved({ client: catalogClient([]).client, favorites: [GONE] });

    expect(view.find('saved-favorites-missing')).not.toBeNull();
    expect(view.orphanIds()).toStrictEqual([GONE]);
    expect(view.find('saved-favorites-error')).toBeNull();
    expect(view.find('saved-favorites-offline')).toBeNull();
  });

  it('lets the user remove an orphan, and keeps the meals that resolved', async () => {
    /**
     * The decision this asserts: an orphan CAN be un-favourited. A row the user can see and cannot
     * clear is a dead end — only a hand-run reseed could bring the record back — and removing it
     * for them would discard a choice they made without saying so.
     *
     * Behind a confirmation, because this removal is the least reversible one in the app: the
     * catalog no longer has the record, so no screen can reach it to re-favourite it.
     */
    const view = await renderSaved({
      client: catalogClient([good]).client,
      favorites: [good.id, GONE],
    });
    expect(view.orphanIds()).toStrictEqual([GONE]);

    // The press opens the sheet and removes NOTHING on its own.
    await view.press(`saved-forget-${GONE}`);
    expect(view.orphanIds()).toStrictEqual([GONE]);
    expect(view.findAnywhere('saved-forget-confirm')).not.toBeNull();
    /**
     * **The call site's title, pinned where only a consumer suite can pin it.**
     *
     * `Sheet.dom.test.tsx` proves the MECHANISM — that one element carries both `role="dialog"` and
     * the accessible name, after react-native-web 0.21.2 was found putting the role and the label on
     * different elements while a test asserted them separately and passed. What that file cannot
     * see is a **call site** dropping or rewording its title, because the wiring is here.
     *
     * `getByRole(document.body, 'dialog', { name })` is one query on purpose: it fails when the role
     * and the name part company, which is exactly what the old split assertion could not do.
     */
    expect(getByRole(document.body, 'dialog', { name: 'Remove this favourite?' })).toBeTruthy();

    await view.pressAnywhere('saved-forget-confirm');

    expect(view.orphanIds()).toStrictEqual([]);
    expect(view.find('saved-favorites-missing')).toBeNull();
    // The user-visible consequence, not the store: the meal that resolved is still on screen.
    expect(view.favoriteIds()).toStrictEqual([good.id]);
  });

  it('cancelling the confirmation leaves the orphan provably present', async () => {
    /**
     * T-18-07's rule, applied here: "a confirmation nobody tested is a confirmation that might not
     * be wired", and a cancel is asserted against the DATA rather than against the closed sheet. A
     * cancel that closed the sheet and removed the favourite anyway would pass a
     * "the sheet went away" assertion.
     */
    const view = await renderSaved({
      client: catalogClient([good]).client,
      favorites: [good.id, GONE],
    });

    await view.press(`saved-forget-${GONE}`);
    await view.pressAnywhere('saved-forget-cancel');

    expect(view.orphanIds()).toStrictEqual([GONE]);
    expect(view.find('saved-favorites-missing')).not.toBeNull();
    expect(view.favoriteIds()).toStrictEqual([good.id]);
  });

  it('renders the unresolved notice for a failure that is NOT a 404, and offers a retry', async () => {
    /**
     * The row-level non-404 path, which no test reached before: one id 500s while another resolves.
     * A uniformly-rejecting client can only produce a whole-section failure, which is why
     * `catalogClient` takes a `failing` set.
     *
     * **The favourite must NOT be offered for removal.** A 500 says nothing about whether the
     * record still exists, so treating it as an orphan would invite the user to delete a favourite
     * over a dropped socket.
     */
    const broken = catalogMeal(3);
    const view = await renderSaved({
      client: catalogClient([good, broken], [broken.id]).client,
      favorites: [good.id, broken.id],
    });

    expect(view.find('saved-favorites-unresolved')).not.toBeNull();
    expect(view.text()).toContain('1 favourite could not be loaded');
    expect(view.favoriteIds()).toStrictEqual([good.id]);
    // Not an orphan, and not the whole section.
    expect(view.orphanIds()).toStrictEqual([]);
    expect(view.find('saved-favorites-missing')).toBeNull();
    expect(view.find('saved-favorites-error')).toBeNull();
    expect(view.find('saved-favorites-empty')).toBeNull();
    // Retryable, unlike the bound refusal: the notice carries an action.
    expect(view.must('saved-favorites-unresolved').querySelectorAll('[role="button"]').length).toBe(
      1,
    );
  });

  it('survives an id that makes the client throw synchronously', async () => {
    /**
     * A lone surrogate. `mealPath` runs `encodeURIComponent`, which raises `URIError` **before any
     * promise exists**, so a bare `(id) => client.getMeal(id, signal)` would let the throw escape
     * `.map` and kill the whole batch — leaving the section on `loading` for ever, with no retry and
     * an unhandled rejection. `favoriteIdsSchema` only requires a non-empty string, so a corrupt or
     * hand-edited store really can hold this id.
     */
    const view = await renderSaved({
      client: surrogateClient([good]),
      favorites: [good.id, '\uD800'],
    });

    // Not stuck loading, which is the whole point.
    expect(view.find('saved-favorites-loading')).toBeNull();
    // The good meal still rendered, and the bad id is reported as unloadable rather than as gone.
    expect(view.favoriteIds()).toStrictEqual([good.id]);
    expect(view.find('saved-favorites-unresolved')).not.toBeNull();
    expect(view.orphanIds()).toStrictEqual([]);
  });

  it('tells the difference between a 404 and an unreachable server', async () => {
    // Both are "no meal on screen", and conflating them is the comfortable lie: one means the
    // favourite is stale, the other means the machine running the server is down.
    const view = await renderSaved({
      client: failingClient(transportError('getMeal', 'unreachable')),
      favorites: [good.id],
    });

    expect(view.find('saved-favorites-offline')).not.toBeNull();
    expect(view.find('saved-favorites-missing')).toBeNull();
    expect(view.orphanIds()).toStrictEqual([]);
    // PRD §12's third clause, and "Working offline" rather than "You're offline" (S-23).
    expect(view.text()).toContain('Working offline');
    expect(view.text()).toContain('still work');
  });
});

describe('SavedScreen — states (PRD §12)', () => {
  it('shows the error state for a failure that is not a transport failure', async () => {
    const view = await renderSaved({
      client: failingClient(
        new ApiClientError({
          kind: 'server',
          status: 500,
          code: 'internal_error',
          retryable: false,
          wire: {
            code: 'internal_error',
            message: 'ECONNREFUSED /var/run/secret.sock',
            retryable: false,
          },
          route: 'getMeal',
        }),
      ),
      favorites: [catalogMeal(0).id],
    });

    expect(view.find('saved-favorites-error')).not.toBeNull();
    expect(view.find('saved-favorites-offline')).toBeNull();
    expect(view.text()).toContain('still work');
    // TSD §3.5 and PRD §12: nothing off the wire reaches the screen.
    expect(view.text()).not.toContain('ECONNREFUSED');
    expect(view.text()).not.toContain('secret.sock');
  });

  it('names WHICH list was reset when the favourites entry was recovered', async () => {
    /**
     * `entryStatus === 'recovered'` means the stored bytes failed the key's schema, were
     * quarantined, and the list came back empty. P14's report: a reset the user is not told about
     * is the reset that matters — and with two lists on one screen, an unnamed reset leaves them
     * unable to tell which one is gone.
     */
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: recipes(1),
      // A number where `favoriteIdsSchema` requires a string: schema-invalid, so the read
      // quarantines and reports `recovered`.
      raw: {
        [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, ['ok', 42], NOW),
      },
    });

    expect(view.find('saved-favorites-recovered')).not.toBeNull();
    expect(view.find('saved-custom-recovered')).toBeNull();
    expect(view.text()).toContain('Your favourites were reset');
    // The other list is untouched, which is the sentence that stops the notice reading as "all
    // your data is gone".
    expect(view.recipeIds()).toHaveLength(1);
  });

  it('names the recipe list when the customMeals entry was recovered', async () => {
    const view = await renderSaved({
      client: catalogClient([]).client,
      raw: {
        [STORAGE_KEYS.customMeals]: encodeEnvelope(STORAGE_SCHEMA_VERSION, [{ nope: true }], NOW),
      },
    });

    expect(view.find('saved-custom-recovered')).not.toBeNull();
    expect(view.find('saved-favorites-recovered')).toBeNull();
    expect(view.text()).toContain('Your own recipes were reset');
  });
});

describe('SavedScreen — the section param', () => {
  it('puts the favourites section first by default', async () => {
    const view = await renderSaved({ client: catalogClient([]).client });
    expect(view.sectionOrder()).toStrictEqual(['saved-favorites', 'saved-custom']);
  });

  it('puts the named section first', async () => {
    const view = await renderSaved({
      client: catalogClient([]).client,
      params: { section: 'custom' },
    });
    expect(view.sectionOrder()).toStrictEqual(['saved-custom', 'saved-favorites']);
    // Both are still mounted: the param reorders, it does not hide.
    expect(view.find('saved-favorites-empty')).not.toBeNull();
    expect(view.find('saved-custom-empty')).not.toBeNull();
  });

  it('ignores a section a deep link invented', async () => {
    /**
     * `nutritime://saved?section=dessert`. `route.params` is only as true as the URL that produced
     * it, so the value is read through `readUnionParam` against `SAVED_SECTIONS` rather than
     * trusted as typed.
     *
     * **What this discriminates**, and it is a real alternative rather than a strawman: an
     * implementation that trusts the param and asks "is it not `favorites`?" — the natural shape
     * when the value is believed to be one of two — puts a section named `dessert` FIRST as custom.
     * Probed that way, and it fails. An array param is included because a repeated query key parses
     * to one, and `readStringParam` rejects arrays rather than taking the first.
     */
    for (const section of ['dessert', '', 'FAVORITES', ['custom']]) {
      const view = await renderSaved({ client: catalogClient([]).client, params: { section } });
      expect(view.sectionOrder(), JSON.stringify(section)).toStrictEqual([
        'saved-favorites',
        'saved-custom',
      ]);
    }
  });
});

describe('SavedScreen — where a tap goes', () => {
  it('opens a favourite in MealDetails, carrying the saved origin', async () => {
    const meal = catalogMeal(0);
    const view = await renderSaved({
      client: catalogClient([meal]).client,
      favorites: [meal.id],
    });

    await view.press(`saved-favorite-${meal.id}`);
    expect(view.navigate).toHaveBeenCalledWith('MealDetails', {
      mealId: meal.id,
      origin: 'saved',
    });
  });

  it('opens the user’s own recipe in MealForm, never in MealDetails', async () => {
    /**
     * The orchestrator's decision, and the reason it matters: TSD §6.8 gives `MealDetails` the
     * data source `GET /meals/:id`, and a user-authored meal carries a UUID the server has never
     * heard of. Routing it there would make "not-found" mean two different things.
     */
    const own = recipes(1);
    const first = own[0];
    if (first === undefined) {
      throw new Error('fixture is empty');
    }
    const view = await renderSaved({ client: catalogClient([]).client, custom: own });

    await view.press(`saved-recipe-${first.id}`);
    expect(view.navigate).toHaveBeenCalledWith('MealForm', { mealId: first.id });
    expect(view.navigate).not.toHaveBeenCalledWith(
      'MealDetails',
      expect.objectContaining({ mealId: first.id }),
    );
  });

  it('opens MealForm with NO mealId for a new meal', async () => {
    // The route table defines create mode as an absent `mealId`, so the assertion is about the
    // absence of the key and not about it being undefined.
    const view = await renderSaved({ client: catalogClient([]).client });

    await view.press('saved-new-meal');
    const call = view.navigate.mock.calls[0];
    expect(call?.[0]).toBe('MealForm');
    expect(Object.keys((call?.[1] ?? {}) as object)).not.toContain('mealId');
  });
});

describe('SavedScreen — the custom-meal bound (T-17-07)', () => {
  it('offers the create affordance one below the bound', async () => {
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: recipes(MAX_CUSTOM_MEALS - 1),
    });

    expect(view.find('saved-new-meal')).not.toBeNull();
    expect(view.find('saved-custom-full')).toBeNull();
  });

  it('refuses at the bound, says the list is full, and offers no retry', async () => {
    /**
     * TSD §6.4: bounds are refusals, and "retrying the same value can never succeed". So the
     * message carries no action at all — a button that will always refuse is a lie in the
     * interface, and the `customMeals` reducer refuses SILENTLY (it returns `state` identically),
     * so a create affordance here would look like it worked.
     */
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: recipes(MAX_CUSTOM_MEALS),
    });

    const full = view.must('saved-custom-full');
    expect(view.find('saved-new-meal')).toBeNull();
    expect(view.text()).toContain('Your recipe list is full');
    expect(view.text()).toContain(String(MAX_CUSTOM_MEALS));
    // No control of any kind inside the refusal.
    expect(full.querySelectorAll('[role="button"]')).toHaveLength(0);
    expect(view.text()).not.toContain('Try again');
  });
});

describe('SavedScreen — the key could not be read at all (entryStatus: unavailable)', () => {
  /**
   * **The state that made the app lie.** When the driver fails, `hydrateStorage` marks every key
   * `unavailable` and `createStore` then refuses to write over it (TSD §6.3) — silently, because
   * `saveError` stays null and `saveBlocked` stays false. So without a message the user is told
   * "You have not written any recipes yet", writes one, watches it appear, and loses it at the next
   * launch with nothing having said so.
   *
   * Driven with `memoryDriver`'s `failOn`, which no P17 test used before this one.
   */
  it('says both lists could not be read, and does NOT claim either is empty', async () => {
    const view = await renderSaved({ client: catalogClient([]).client, failDriver: 'multiGet' });

    expect(view.find('saved-favorites-unavailable')).not.toBeNull();
    expect(view.find('saved-custom-unavailable')).not.toBeNull();

    // The lie, and the assertion that it is gone: neither section may claim to be empty when the
    // key it would be empty from could not be read.
    expect(view.find('saved-custom-empty')).toBeNull();
    expect(view.find('saved-favorites-empty')).toBeNull();
    expect(view.text()).not.toContain('You have not written any recipes yet');
    expect(view.text()).not.toContain('No favourite meals yet');
  });

  it('warns that a recipe written now will not be kept', async () => {
    // PRD §12's "what to do next", and the specific harm: the write is skipped, not failed, so
    // nothing else in the app will ever tell the user.
    const view = await renderSaved({ client: catalogClient([]).client, failDriver: 'multiGet' });

    expect(view.text()).toContain('will not be kept');
    // The create affordance stays — the failure may be transient and a dead end is worse — but the
    // warning is above it.
    expect(view.find('saved-new-meal')).not.toBeNull();
  });

  it('is worded differently from `recovered`, because it means something different', async () => {
    /**
     * `recovered` is "it was reset"; `unavailable` is "it could not be read, and changes cannot be
     * saved". Conflating them would tell a user their data was destroyed when it is intact but
     * unreadable, or the reverse — and the reverse is the dangerous direction.
     */
    const unreadable = await renderSaved({
      client: catalogClient([]).client,
      failDriver: 'multiGet',
    });
    expect(unreadable.find('saved-favorites-recovered')).toBeNull();
    expect(unreadable.find('saved-custom-recovered')).toBeNull();

    const reset = await renderSaved({
      client: catalogClient([]).client,
      raw: { [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, ['ok', 42], NOW) },
    });
    expect(reset.find('saved-favorites-recovered')).not.toBeNull();
    expect(reset.find('saved-favorites-unavailable')).toBeNull();
  });
});

describe('SavedScreen — a meal that conflicts with a declared allergy is marked', () => {
  /**
   * V6's journey: the user declares peanut, authors a recipe with peanut in it under a caption
   * promising the app will keep conflicting meals away from them, and the row shows nothing.
   *
   * **Every fixture here conflicts through an INGREDIENT NAME with the tags stripped**, which is
   * the case a naive `allergenTags.filter(...)` gets wrong. A fixture that was merely tagged would
   * pass against both the domain's matcher and the naive one, and would therefore prove nothing.
   */
  const ALLERGIES = ['peanut'];

  /** A catalog meal that conflicts, with its declared tags removed. */
  const taggedPeanutMeal = CATALOG.find((meal) => conflictingAllergens(meal, ALLERGIES).length > 0);
  if (taggedPeanutMeal === undefined) {
    throw new Error('the seeded catalog has no peanut meal to build this fixture from');
  }
  const INGREDIENT_ONLY: Meal = { ...taggedPeanutMeal, allergenTags: [] };

  /** A recipe of the user's own, tagged with nothing, whose ingredient names it away. */
  const OWN_RECIPE = recipe(recipeId(901), 'Satay noodles', {
    allergenTags: [],
    ingredients: [{ name: 'Peanut butter', measure: '2 tbsp' }],
  });

  it('the fixtures are discriminating, or every assertion below is vacuous', () => {
    /**
     * The control the P09/P10 re-audit taught, and the one W8's 24-of-25 green mutation needed. If
     * either half of this fails, the tests below stop distinguishing the domain's matcher from a
     * tag filter and become decoration.
     */
    for (const subject of [INGREDIENT_ONLY, OWN_RECIPE]) {
      // The domain finds it...
      expect(conflictingAllergens(subject, ALLERGIES)).toContain('peanut');
      // ...and a tag filter does not, because there are no tags to filter.
      expect(subject.allergenTags.filter((tag) => ALLERGIES.includes(tag))).toStrictEqual([]);
    }
  });

  it('marks a favourited catalog meal, naming the allergen in text', async () => {
    const view = await renderSaved({
      client: catalogClient([INGREDIENT_ONLY]).client,
      favorites: [INGREDIENT_ONLY.id],
      allergies: ALLERGIES,
    });

    expect(view.favoriteIds()).toStrictEqual([INGREDIENT_ONLY.id]);
    expect(view.find(`saved-conflict-${INGREDIENT_ONLY.id}`)).not.toBeNull();
    // PRD §10.5: the allergen is NAMED, so the warning does not depend on the colour being seen.
    expect(view.text()).toContain('peanut');
    expect(view.text()).toContain('declared as an allergy');
  });

  it('marks the user’s own recipe too', async () => {
    // Both sections, because a user can tick an allergen on their own recipe — which is exactly
    // the journey that was reported.
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: [OWN_RECIPE],
      allergies: ALLERGIES,
    });

    expect(view.recipeIds()).toStrictEqual([OWN_RECIPE.id]);
    expect(view.find(`saved-conflict-${OWN_RECIPE.id}`)).not.toBeNull();
    expect(view.text()).toContain('peanut');
  });

  it('marks the conflict BEFORE the meal it is about, in document order', async () => {
    // A screen reader reaches children in order, and a safety warning after the thing it warns
    // about is one the user meets too late.
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: [OWN_RECIPE],
      allergies: ALLERGIES,
    });

    const marker = view.must(`saved-conflict-${OWN_RECIPE.id}`);
    const card = view.must(`saved-recipe-${OWN_RECIPE.id}`);
    // `DOCUMENT_POSITION_FOLLOWING` — the card comes after the marker.
    expect(marker.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(
      0,
    );
  });

  it('marks nothing when the user has declared no allergies', async () => {
    // The other direction, so the marker is not simply always on: same meals, empty allergy list.
    const view = await renderSaved({
      client: catalogClient([INGREDIENT_ONLY]).client,
      favorites: [INGREDIENT_ONLY.id],
      custom: [OWN_RECIPE],
      allergies: [],
    });

    expect(view.favoriteIds()).toStrictEqual([INGREDIENT_ONLY.id]);
    expect(view.recipeIds()).toStrictEqual([OWN_RECIPE.id]);
    expect(view.find(`saved-conflict-${INGREDIENT_ONLY.id}`)).toBeNull();
    expect(view.find(`saved-conflict-${OWN_RECIPE.id}`)).toBeNull();
    expect(view.text()).not.toContain('declared as an allergy');
  });

  it('marks only the meals that conflict, not the whole list', async () => {
    const safe = recipe(recipeId(902), 'Plain porridge', {
      allergenTags: [],
      ingredients: [{ name: 'Rolled oats', measure: '80 g' }],
    });
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: [OWN_RECIPE, safe],
      allergies: ALLERGIES,
    });

    expect(view.recipeIds()).toStrictEqual([OWN_RECIPE.id, safe.id]);
    expect(view.find(`saved-conflict-${OWN_RECIPE.id}`)).not.toBeNull();
    expect(view.find(`saved-conflict-${safe.id}`)).toBeNull();
    expect(view.idsWithPrefix('saved-conflict-')).toStrictEqual([OWN_RECIPE.id]);
  });
});

describe('SavedScreen — two authored recipes sharing one id', () => {
  /**
   * V9's case, and the store owner's reasoning for why it reaches this screen rather than being
   * fixed upstream: `customMeals` holds **records**, so two entries under one id are two meals the
   * user authored, and de-duplicating them at hydration would delete one silently. The store keeps
   * both deliberately; the React-key cost is the renderer's to pay.
   *
   * So there are two claims here, and they pull in opposite directions: **both records must be
   * visible** (no de-duplicating for display either), and **React must not be handed two children
   * with the same key**. A bare `key={meal.id}` satisfies the first and breaks the second.
   */
  it('renders both records, and hands React no duplicate key', async () => {
    const shared = recipeId(903);
    const first = recipe(shared, 'Braised beans');
    const second = recipe(shared, 'Braised beans, second try');

    /**
     * React reports a duplicate key through `console.error`, which does not fail a test on its own
     * — so it is captured and asserted. Without this the key could regress to the bare id and
     * nothing would notice: both rows still render, because React warns rather than dropping one.
     */
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: readonly unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      const view = await renderSaved({
        client: catalogClient([]).client,
        custom: [first, second],
      });

      // Rendered ids, not a row count: the multiplicity IS the claim here, and both records the
      // user authored have to be on screen.
      expect(view.recipeIds()).toStrictEqual([shared, shared]);
      expect(view.text()).toContain('Braised beans, second try');
      expect(logged.filter((line) => line.includes('same key'))).toStrictEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('the store really does keep both, or the test above is about nothing', async () => {
    // The control: if `customMeals` ever started de-duplicating, the assertion above would pass
    // for the wrong reason — one row, no duplicate key, nothing to key uniquely.
    const shared = recipeId(904);
    const view = await renderSaved({
      client: catalogClient([]).client,
      custom: [recipe(shared, 'One'), recipe(shared, 'Two')],
    });
    expect(view.recipeIds()).toHaveLength(2);
  });
});
describe('SavedScreen - the notices a screen reader has to hear (T-23-05)', () => {
  /**
   * **A live region nobody announced is a notice drawn to nobody.** Every notice here arrives
   * mounted together with its own words, so `aria-live` has no change to report by the time the
   * region exists (`StatusMessage.tsx` records the mechanism); the announcement is `role="alert"`,
   * which is spoken on INSERTION. These four surfaces carried neither until this task.
   *
   * **The role and the words are read off the SAME element**, never off a container. A role on one
   * node and the sentence on another announces an empty alert - the defect `Sheet`'s dialogs were
   * found with in this same window - and a `find(...) !== null` assertion cannot see it.
   *
   * **Each case is paired with a notice that must NOT be an alert.** A suite where everything is an
   * alert is satisfied by a component that marks everything, and a component that marks everything
   * is the interruption Plan 20's focus row ("moved deliberately, never on every blur") rules out.
   */
  it('announces which list was reset, on the element that carries the words', async () => {
    const view = await renderSaved({
      client: catalogClient([]).client,
      raw: { [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, ['ok', 42], NOW) },
    });

    const notice = view.must('saved-favorites-recovered');
    expect(notice.getAttribute('role')).toBe('alert');
    // Kept alongside the role on purpose: it downgrades the `assertive` that `role="alert"`
    // implies, which is what keeps a reset from interrupting mid-sentence.
    expect(notice.getAttribute('aria-live')).toBe('polite');
    // Announced text, read off the element that carries the role.
    expect(notice.textContent ?? '').toContain('Your favourites were reset');
    expect(notice.textContent ?? '').toContain('Favourite the meals you want again');

    // The control, present in this very render: an empty list is page content, not an arrival, and
    // Explore re-renders `EmptyState` on every keystroke.
    expect(view.must('saved-custom-empty').getAttribute('role')).not.toBe('alert');
  });

  it('announces the recipe-list reset too, and not the bound refusal beside it', async () => {
    const reset = await renderSaved({
      client: catalogClient([]).client,
      raw: {
        [STORAGE_KEYS.customMeals]: encodeEnvelope(STORAGE_SCHEMA_VERSION, [{ nope: true }], NOW),
      },
    });

    const notice = reset.must('saved-custom-recovered');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent ?? '').toContain('Your own recipes were reset');

    /**
     * The other half of the pair, and no single rule satisfies both. `saved-custom-full` is drawn
     * for as long as the user is at the bound, so it is present on every visit to Saved: an alert
     * there would interrupt without reporting an arrival. Marking every `StatusMessage` fails here;
     * marking none fails above.
     */
    const full = await renderSaved({
      client: catalogClient([]).client,
      custom: recipes(MAX_CUSTOM_MEALS),
    });
    const bound = full.must('saved-custom-full');
    expect(bound.getAttribute('role')).not.toBe('alert');
    // `'off'`, not absent, and that is the library rather than the component: `StatusMessage`
    // passes `accessibilityLiveRegion="none"` when it is not announcing, and react-native-web
    // 0.21.2 rewrites `'none'` to `'off'` on its way to `aria-live`
    // (`dist/modules/createDOMProps/index.js:460-462`). Asserted as measured, because the first
    // draft of this line expected `null` and reddened - which is the mapping four comments in
    // this repository claimed does not exist.
    expect(bound.getAttribute('aria-live')).toBe('off');
  });

  it('announces both unreadable-key warnings, which are the two that cost data', async () => {
    /**
     * `multiGet` refuses, so `hydrateStorage` marks every key `unavailable` and `createStore`
     * writes over none of them (TSD 6.3) - silently, because `saveError` stays null. A user who
     * cannot see these two panels writes a recipe, watches it appear, and loses it at the next
     * launch with nothing having said so. This is the pair the announcement exists for.
     */
    const view = await renderSaved({ client: catalogClient([]).client, failDriver: 'multiGet' });

    const favorites = view.must('saved-favorites-unavailable');
    const custom = view.must('saved-custom-unavailable');
    expect(favorites.getAttribute('role')).toBe('alert');
    expect(custom.getAttribute('role')).toBe('alert');
    expect(favorites.textContent ?? '').toContain('will not be remembered');
    expect(custom.textContent ?? '').toContain('will not be kept');
  });

  it('does not re-announce when the `section` param swaps the two sections', async () => {
    /**
     * **The sibling of the test below, and the one the suite was missing.**
     *
     * `section` chooses which of the two sections renders first, so changing it puts a different
     * component TYPE at each of two sibling positions. React reconciles siblings by index unless
     * they are keyed — so without a `key` on each, both sections unmount and remount, and since
     * P23 both carry `role="alert"` notices. A remount **re-speaks** them: a screen-reader user
     * who switches section is interrupted to be told again about a recovery they already heard.
     *
     * Measured before the keys existed: removing both left this file at **41 passed**, unchanged.
     * The property was real, the fix was one word per element, and nothing in 41 tests could see
     * it — so this assertion is the whole of the evidence for it.
     *
     * The identity check is on the NODE, not on its text: `toBe` on the same `HTMLElement` is what
     * distinguishes "still there" from "torn down and rebuilt looking identical", and only the
     * second one speaks.
     */
    const view = await renderSaved({
      client: catalogClient(CATALOG).client,
      params: { section: 'favorites' },
      raw: { [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, ['ok', 42], NOW) },
    });
    const before = view.must('saved-favorites-recovered');
    expect(view.sectionOrder()).toStrictEqual(['saved-favorites', 'saved-custom']);

    await view.rerenderWith({ section: 'custom' });

    // The swap really happened, or the identity claim is about nothing — the same trap the test
    // below names, and the reason `sectionOrder` is asserted on both sides.
    expect(view.sectionOrder()).toStrictEqual(['saved-custom', 'saved-favorites']);
    expect(view.must('saved-favorites-recovered')).toBe(before);
  });

  it('does not re-announce when the section re-renders around it', async () => {
    /**
     * Plan 2793 - "moved deliberately, never on every blur" - applied to speech. `role="alert"` is
     * re-spoken every time the node is inserted, so a notice that remounts on an unrelated change
     * interrupts the user on each one, which is worse than silence. Favouriting a meal re-renders
     * the whole section; the notice has to be the SAME DOM node afterwards. A per-render `key`, or
     * this notice moved inside a subtree that remounts, fails here.
     */
    const view = await renderSaved({
      client: catalogClient(CATALOG).client,
      raw: { [STORAGE_KEYS.favorites]: encodeEnvelope(STORAGE_SCHEMA_VERSION, ['ok', 42], NOW) },
    });
    const before = view.must('saved-favorites-recovered');

    await view.favorite(catalogMeal(0).id);

    // The re-render really happened, or "it did not re-announce" is a claim about nothing.
    expect(view.favoriteIds()).toContain(catalogMeal(0).id);
    expect(view.must('saved-favorites-recovered')).toBe(before);
  });
});
