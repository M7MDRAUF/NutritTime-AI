import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { getByRole } from '@testing-library/dom';
import { AppState, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal, Recommendation, RecommendationResponse } from '@nutritime/contracts';
import { effectiveAllergenTags, recommend } from '@nutritime/domain';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { ApiProvider } from '../../infrastructure/api/ApiProvider.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { preferencesStore, preferencesActions } from '../../state/preferences/index.js';
import type { PreferencesState } from '../../state/preferences/index.js';
import { uiStore } from '../../state/ui/index.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS } from '../../infrastructure/storage/definitions.js';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import { DEFAULT_PREFERENCES } from '../../infrastructure/storage/definitions.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import type { RecommendationRequest } from '../../infrastructure/api/routes.js';
import type { RootParamList } from '../../navigation/routes.js';
import { HomeScreen, HomeScreenWithFocus } from './HomeScreen.js';
import { useRecommendations } from './useRecommendations.js';

/**
 * The one mock a navigator cannot mount without — `HomeScreenWithFocus` is rendered inside a real
 * stack below, and `@react-navigation/native-stack` reaches `react-native-safe-area-context`
 * through `@react-navigation/elements`. Its web build ships as `*.web.js` platform files Vitest
 * does not resolve, so the bare `.js` files load React Native's Flow-typed codegen specs and fail
 * to parse. Nothing else in this file touches the package.
 */
vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('../../navigation/testHarness.js');
  return createSafeAreaContextMock();
});

/**
 * T-15-01 … T-15-07, and T-14-07.
 *
 * **The peanut assertion is the reason this file exists**, and it is asserted against the REAL
 * domain rather than a hand-made response: the stub calls `recommend()` on the real catalog with the
 * real preferences, so what reaches the screen is what the server would have computed. A stub that
 * returned three meals of my choosing would prove the screen renders three cards and nothing about
 * whether a peanut meal can reach one.
 */

const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((record) =>
  mealSchema.parse(record),
);

const PEANUT_MEALS = CATALOG.filter((meal) => [...effectiveAllergenTags(meal)].includes('peanut'));

const CLOCK = () => '2026-09-13T12:00:00.000Z';
/** 12:30 local — lunch, under the default anchors. Fixed, so the test asserts rather than hopes. */
const AT_LUNCH = (): Date => new Date(2026, 8, 13, 12, 30, 0);

/**
 * A client that answers through the real domain.
 *
 * This is the whole point: the request the screen builds goes into `recommend()`, and the hard
 * allergen rejection that runs there is the one the assertions below are about.
 */
function domainClient(): {
  readonly client: ApiClient;
  readonly requests: RecommendationRequest[];
} {
  const requests: RecommendationRequest[] = [];
  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: () => Promise.reject(new Error('not used')),
    recommend: (request) => {
      requests.push(request);
      const result = recommend(
        {
          period: request.mealPeriod,
          preferences: request.preferences,
          // The REQUEST's list, not an empty one. Dropping it made the stub unfaithful on exactly
          // the field P10's suite uses to make the hard rejection observable — favouriting a
          // peanut meal must not buy it past the filter — and it would have diverged silently at
          // P16 when Home starts sending a real list.
          favoriteMealIds: request.favoriteMealIds,
        },
        CATALOG,
      );
      const recommendations: Recommendation[] = result.selected.map((scored) => ({
        meal: scored.meal,
        score: scored.score,
        scoreReasons: scored.scoreReasons,
        explanation: 'Fits your preferences.',
        explanationSource: 'fallback',
      }));
      const response: RecommendationResponse = { mealPeriod: request.mealPeriod, recommendations };
      return Promise.resolve(response);
    },
    ask: () => Promise.reject(new Error('not used')),
  };
  return { client, requests };
}

interface Harness {
  readonly host: HTMLElement;
  find(testID: string): HTMLElement | null;
  text(): string;
  mealIds(): string[];
  refocus(epoch: number): Promise<void>;
  dispatch(action: Parameters<ReturnType<typeof preferencesStore.useDispatch>>[0]): Promise<void>;
  settle(): Promise<void>;
}

async function render(
  client: ApiClient,
  now: () => Date = AT_LUNCH,
  initialFocusEpoch = 0,
  onDisclaimerShown?: () => void,
  driver: ReturnType<typeof memoryDriver> = memoryDriver({}),
): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let dispatchRef: ((action: never) => void) | null = null;

  function Capture(): ReactNode {
    dispatchRef = preferencesStore.useDispatch() as (action: never) => void;
    return null;
  }

  // Hoisted out of `treeFor`: a fresh driver per render would make a fresh `runtime` object, which
  // re-runs `StorageProvider`'s effect and rebuilds the store — so a re-focus would have looked
  // like a remount and the test would have proved nothing.
  const runtime = { driver, now: CLOCK };

  const treeFor = (focusEpoch: number): ReactNode => (
    <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
      <ApiProvider client={client}>
        <StorageProvider runtime={runtime}>
          <preferencesStore.Provider>
            <Capture />
            <HomeScreen
              now={now}
              focusEpoch={focusEpoch}
              onDisclaimerShown={onDisclaimerShown}
              route={{ key: 'h', name: 'Home', params: undefined } as never}
              navigation={{ navigate: () => undefined } as never}
            />
          </preferencesStore.Provider>
        </StorageProvider>
      </ApiProvider>
    </ThemeProvider>
  );

  const root = createRoot(host);
  const draw = async (epoch: number): Promise<void> => {
    await act(async () => {
      root.render(treeFor(epoch));
    });
  };
  await draw(initialFocusEpoch);

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await settle();

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    host,
    find,
    text: () => host.textContent ?? '',
    mealIds: () =>
      [...host.querySelectorAll('[data-testid^="recommendation-"]')].map((node) =>
        (node.getAttribute('data-testid') ?? '').replace('recommendation-', ''),
      ),
    /** Re-render the SAME root with a new focus epoch, which is what a tab re-focus does. */
    refocus: async (epoch: number) => {
      await draw(epoch);
      await settle();
    },
    dispatch: async (action) => {
      await act(async () => {
        dispatchRef?.(action as never);
      });
      await settle();
    },
    settle,
  };
}

/**
 * The registered component, mounted the way the app mounts it.
 *
 * **`HomeScreenWithFocus` was rendered by nothing.** `register.dom.test.tsx` compares the
 * *registered reference* and never mounts it, so the wrapper's whole body — the `useFocusEffect`
 * that bumps `focusEpoch` — was unverified: replacing its callback with `() => undefined` left the
 * suite green, and M-6's frozen clock came back on the focus path in silence.
 *
 * It needs a route context (`useFocusEffect` throws without one), which is exactly why the screen
 * and the wrapper are separate files — so the harness is a two-screen stack: Home, and somewhere
 * to go. Two rather than one because a screen that is never left is never re-focused, and
 * re-focus is the event under test.
 */
const FocusStack = createNativeStackNavigator<RootParamList>();
const focusNavigation = createNavigationContainerRef<RootParamList>();

function Elsewhere(): ReactNode {
  return <View testID="elsewhere" />;
}

/**
 * The hook alone, with the period in a `testID` so no theme or store has to be mounted to read it.
 *
 * The one seam through which a profile the store would refuse can still reach the period
 * computation — which is what the guard inside `useRecommendations` exists for.
 */
function PeriodProbe({
  client,
  preferences,
}: {
  readonly client: ApiClient;
  readonly preferences: PreferencesState;
}): ReactNode {
  const { mealPeriod } = useRecommendations({
    client,
    preferences,
    favoriteMealIds: [],
    now: AT_LUNCH,
  });
  return <View testID={`probe-period-${mealPeriod}`} />;
}

async function renderWithFocus(client: ApiClient): Promise<{
  find(testID: string): HTMLElement | null;
  leaveAndReturn(): Promise<void>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const runtime = { driver: memoryDriver({}), now: CLOCK };

  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
        <ApiProvider client={client}>
          <StorageProvider runtime={runtime}>
            <preferencesStore.Provider>
              <uiStore.Provider>
                <NavigationContainer ref={focusNavigation}>
                  <FocusStack.Navigator screenOptions={{ headerShown: false }}>
                    <FocusStack.Screen name="Home" component={HomeScreenWithFocus} />
                    <FocusStack.Screen name="Settings" component={Elsewhere} />
                  </FocusStack.Navigator>
                </NavigationContainer>
              </uiStore.Provider>
            </preferencesStore.Provider>
          </StorageProvider>
        </ApiProvider>
      </ThemeProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    find: (testID) => {
      const found = host.querySelector(`[data-testid="${testID}"]`);
      return found instanceof HTMLElement ? found : null;
    },
    leaveAndReturn: async () => {
      await act(async () => {
        focusNavigation.navigate('Settings');
      });
      await act(async () => {
        focusNavigation.goBack();
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

describe('the quarantined-preferences warning', () => {
  it('tells the user their profile was reset, because nothing is filtering any more', async () => {
    /**
     * **A mutation audit found this notice was deletable in silence** — no test in the repository
     * mentioned `home-preferences-recovered`, so removing the whole branch changed nothing that was
     * checked. It is the one reset a user must be told about: `recovered` on the preferences key
     * means the stored profile failed its schema, was quarantined, and rebuilt from defaults — so
     * `allergies` is now `[]`, every meal passes the filter, and **the app looks completely normal**.
     * That is precisely P14's CRITICAL, and this banner is the only thing standing between it and a
     * user who thinks their allergy list is still in force.
     *
     * Reached the way the app reaches it: a stored record that is a well-formed envelope and an
     * invalid value, so the read path quarantines it rather than a test asserting a status directly.
     */
    const driver = memoryDriver({
      [STORAGE_KEYS.preferences]: JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-09-13T12:00:00.000Z',
        value: { schemaVersion: 1, diet: 'not-a-real-diet' },
      }),
    });

    const view = await render(domainClient().client, AT_LUNCH, 0, undefined, driver);

    expect(view.find('home-preferences-recovered')).not.toBeNull();

    /**
     * And the corrupt record really is gone — the warning is not cosmetic.
     *
     * **Asserted as "replaced by the defaults" rather than "absent", because absent is false and
     * finding that out is worth more than the assertion.** The read path does remove the live key,
     * and then `createStore`'s projection effect writes the fresh store straight back at mount, so
     * the key exists again a tick later holding `DEFAULT_PREFERENCES`. That is **R-54**, reproduced
     * here by accident: every store rewrites its own key at every launch. It is also why this
     * banner matters more than it looks — by the time the user reads it, the defaults are already
     * on disk and the original profile is only in the quarantine ledger.
     */
    const stored: unknown = JSON.parse(driver.store.get(STORAGE_KEYS.preferences) ?? '{}');
    expect(stored).toMatchObject({ value: { diet: 'regular', allergies: [] } });
  });

  it('shows nothing when the stored profile read cleanly — the control', async () => {
    // Without this, a screen that rendered the warning unconditionally would pass the test above.
    const view = await render(domainClient().client);

    expect(view.find('home-preferences-recovered')).toBeNull();
  });
});

describe('the FR-007 disclaimer acknowledgement', () => {
  it('reports that the disclaimer was shown, once, and not once per re-focus', async () => {
    /**
     * **The missing half of T-18-01, found by four separate auditors.**
     *
     * `uiActions.acknowledgeDisclaimer()` existed with a schema, a default and a Settings surface,
     * and **nothing in the app ever dispatched it** — so `disclaimerAcknowledged` could only be
     * `false`, and Settings told every user they had not seen the allergen notice. That was untrue
     * for anyone who had opened this screen, where the disclaimer always renders.
     *
     * Asserted through the injected callback rather than the `ui` store, because that is the seam:
     * `HomeScreenWithFocus` owns the dispatch so this screen stays renderable without a store it
     * has nothing else to do with. The end-to-end proof that the wrapper is wired — open Home, then
     * read Settings — belongs to the Settings e2e spec, and is recorded as such.
     *
     * The re-focus half is the interesting one: `focusEpoch` changing must NOT fire it again, or a
     * user switching tabs would queue a storage write per visit for a flag that cannot change.
     */
    let calls = 0;
    const view = await render(domainClient().client, AT_LUNCH, 0, () => {
      calls += 1;
    });

    expect(view.find('home-disclaimer')).not.toBeNull();
    expect(calls).toBe(1);

    await view.refocus(1);
    await view.refocus(2);

    // Still one. The effect depends on the callback's identity, and the wrapper memoises it.
    expect(calls).toBe(1);
  });
});

describe('HomeScreen', () => {
  it('has at least one peanut meal in the catalog, or the assertion below is vacuous', () => {
    // The control the P09/P10 re-audit taught: an exclusion test on a catalog with nothing to
    // exclude passes for the wrong reason.
    expect(PEANUT_MEALS.length).toBeGreaterThan(0);
  });

  it('renders the meal period before any request resolves', async () => {
    /**
     * T-15-01, and asserted the hard way: the client never answers at all, so there is no response
     * to have rendered from. 12:30 with the default anchors is lunch.
     */
    const client: ApiClient = {
      listMeals: () => Promise.reject(new Error('not used')),
      getMeal: () => Promise.reject(new Error('not used')),
      recommend: () => new Promise(() => undefined),
      ask: () => Promise.reject(new Error('not used')),
    };
    const view = await render(client);
    expect(view.find('home-period')?.textContent).toBe('Lunch');
  });

  it('re-reads the clock when the screen regains focus', async () => {
    /**
     * M-6, and the comment this replaces was factually wrong. It said "A remount is when the time
     * is re-read, which is when the user came back to the screen" — but a bottom-tab screen is NOT
     * remounted on re-focus (`TabNavigator` sets no `unmountOnBlur`), so the period was frozen for
     * the life of the process: an app opened at 12:00 and resumed at 20:00 still said "Lunch".
     *
     * Driven through `focusEpoch`, which is what `HomeScreenWithFocus` bumps from
     * `useFocusEffect`. The clock moves between the two renders, so a hook that ignored the bump
     * would still say "Lunch".
     */
    const { client } = domainClient();
    let current = new Date(2026, 8, 13, 12, 30, 0);
    const clock = (): Date => current;

    const view = await render(client, clock, 0);
    expect(view.find('home-period')?.textContent).toBe('Lunch');

    /**
     * **Re-rendered on the SAME root, which is the whole point.**
     *
     * My first version of this test called `render()` twice and built a fresh tree each time, so
     * the `useMemo` re-ran regardless of its dependency array — I probed it by restoring the old
     * `[mealTimes]` array and the test still passed. A re-focus does not remount the screen; that
     * is exactly why the bug existed, so the test has to not remount it either.
     */
    current = new Date(2026, 8, 13, 20, 0, 0);
    await view.refocus(1);
    expect(view.find('home-period')?.textContent).toBe('Dinner');
  });

  it('re-reads the clock when the app comes back to the foreground', async () => {
    /**
     * **The resume half of M-6, and it was covered by nothing.**
     *
     * The test above drives `focusEpoch` as a prop, which is the seam BELOW the trigger. This one
     * is about the other trigger entirely, and the two are not redundant: returning from the
     * background does **not** re-fire focus on a screen that never lost it, so the `AppState`
     * listener is the only code covering the scenario the hook's own comment names — an app opened
     * at 12:00 and resumed at 20:00 still saying "Lunch".
     *
     * The registration is intercepted rather than simulated through jsdom's `visibilitychange`,
     * because that event is document-wide and this file leaves every earlier tree mounted: a real
     * event would drive them all. The spy is the production call site — if the hook stopped
     * subscribing, or subscribed to another event, `listeners` is empty and the test says so.
     */
    const listeners: ((status: AppStateStatus) => void)[] = [];
    const subscription = vi.spyOn(AppState, 'addEventListener').mockImplementation((type, next) => {
      if (type === 'change') {
        listeners.push(next);
      }
      return { remove: () => undefined };
    });

    try {
      const { client } = domainClient();
      let current = new Date(2026, 8, 13, 12, 30, 0);
      const view = await render(client, () => current);
      expect(view.find('home-period')?.textContent).toBe('Lunch');
      expect(
        listeners,
        'the hook must subscribe to AppState, or nothing below means anything',
      ).toHaveLength(1);

      current = new Date(2026, 8, 13, 20, 0, 0);
      await act(async () => {
        listeners[0]?.('active');
      });
      await view.settle();
      expect(view.find('home-period')?.textContent).toBe('Dinner');

      /**
       * And only `'active'` counts.
       *
       * Without the `next === 'active'` guard the period would be re-read as the app LEAVES — at
       * the moment the user is not looking — and the list would be swapped out under them for the
       * next time they return. The clock moves to breakfast here, so a hook that reacted to every
       * transition would say "Breakfast".
       */
      current = new Date(2026, 8, 14, 8, 30, 0);
      await act(async () => {
        listeners[0]?.('background');
      });
      await view.settle();
      expect(view.find('home-period')?.textContent).toBe('Dinner');
    } finally {
      subscription.mockRestore();
    }
  });

  it('re-reads the clock when the registered screen is re-focused', async () => {
    /**
     * The focus trigger, at the seam the app actually uses: `HomeScreenWithFocus` inside a real
     * navigator, left and returned to. The test three above proves the hook REACTS to a bump; this
     * one proves something bumps it.
     *
     * The wrapper takes no `now`, deliberately — it is the registered component and a clock prop
     * no navigator would ever pass is a seam that exists only for its test. So the system clock is
     * what moves, with only `Date` faked: the hook's 200 ms and 2 s timers stay real, and so do
     * the microtasks `act` drains.
     */
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 8, 13, 12, 30, 0));
      const { client } = domainClient();
      const view = await renderWithFocus(client);
      expect(view.find('home-period')?.textContent).toBe('Lunch');

      vi.setSystemTime(new Date(2026, 8, 13, 20, 0, 0));
      await view.leaveAndReturn();

      expect(view.find('home-period')?.textContent).toBe('Dinner');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the period with the server unreachable', async () => {
    // The other half of T-15-01's acceptance. A period that needed a response would be blank here.
    const client: ApiClient = {
      listMeals: () => Promise.reject(new Error('not used')),
      getMeal: () => Promise.reject(new Error('not used')),
      recommend: () => Promise.reject(transportError('recommend', 'unreachable')),
      ask: () => Promise.reject(new Error('not used')),
    };
    const view = await render(client);
    expect(view.find('home-period')?.textContent).toBe('Lunch');
    expect(view.find('home-offline')).not.toBeNull();
    expect(view.text()).toContain('Working offline');
  });

  it('sends the period and no clock reading of any kind', async () => {
    /**
     * T-15-02. `z.strictObject` means one extra field is a 400, and the specific fields worth
     * naming are a timestamp and `mealTimes`: sending either would move the clock decision to the
     * server, which TSD §5.4 forbids because it cannot be right across time zones.
     */
    const { client, requests } = domainClient();
    const view = await render(client);
    await view.settle();

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.mealPeriod).toBe('lunch');
    expect(Object.keys(request ?? {}).sort()).toStrictEqual([
      'aiEnabled',
      'favoriteMealIds',
      'mealPeriod',
      'preferences',
    ]);
    expect(Object.keys(request?.preferences ?? {}).sort()).toStrictEqual([
      'allergies',
      'budget',
      'diet',
      'dislikedIngredients',
      'goal',
    ]);
  });

  it('renders exactly three meals, each carrying its own reason', async () => {
    /**
     * T-15-03 says "exactly three", and the first version of this asserted `toBeLessThanOrEqual(3)`
     * — which an empty list satisfies — and checked "each with one reason" by looking for the
     * sentence ONCE anywhere in the document. Both are now counted per card.
     */
    const { client } = domainClient();
    const view = await render(client);
    const ids = view.mealIds();
    expect(ids).toHaveLength(3);

    for (const id of ids) {
      const row = view.find(`recommendation-${id}`);
      expect(row, id).not.toBeNull();
      expect(row?.textContent ?? '', id).toContain('Fits your preferences.');
    }
  });

  it('marks a fallback explanation, so it is distinguishable from a written one', async () => {
    // T-15-04. The stub answers `explanationSource: 'fallback'`, which is what P10 always returns.
    const { client } = domainClient();
    const view = await render(client);
    const first = view.mealIds()[0];
    expect(first).toBeDefined();
    expect(view.find(`explanation-source-${first ?? ''}`)).not.toBeNull();
    expect(view.text()).toContain('Written by the app');
  });

  it('shows the loading surface at 200 ms and the AI-progress copy at 2 s (T-15-04)', async () => {
    /**
     * **PRD §10.1: "The UI shows a loading state after 200 ms and an AI-progress message after
     * 2 s" — and until now neither figure was pinned by anything in the repository.** `home-loading`,
     * both sentences and both constants appeared in the two production files and nowhere else, so
     * deleting the whole block, or setting `LOADING_AFTER_MS` to 200 000, shipped green: this file
     * only ever awaited microtasks, and a timer that never fires is indistinguishable from one that
     * does if nothing advances the clock.
     *
     * Driven through the state the screen derives, on a fake clock, with the **document's** numbers
     * written out. Importing `LOADING_AFTER_MS` and advancing by it would compare the constant to
     * itself and pass at any value; waiting 2 s of real time would make the suite slower and no more
     * truthful.
     *
     * 200 ms is a threshold in both directions, so both sides are asserted: below it a spinner is
     * flicker rather than feedback, which is the reason the figure exists.
     */
    vi.useFakeTimers();
    try {
      const never: ApiClient = {
        listMeals: () => Promise.reject(new Error('not used')),
        getMeal: () => Promise.reject(new Error('not used')),
        recommend: () => new Promise(() => undefined),
        ask: () => Promise.reject(new Error('not used')),
      };
      const view = await render(never);

      expect(view.find('home-loading'), 'nothing at 0 ms').toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(199);
      });
      expect(view.find('home-loading'), 'nothing at 199 ms either').toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(view.find('home-loading')?.textContent).toBe('Finding meals for you…');

      await act(async () => {
        vi.advanceTimersByTime(1_799);
      });
      expect(view.find('home-loading')?.textContent, 'still the first copy at 1 999 ms').toBe(
        'Finding meals for you…',
      );

      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(view.find('home-loading')?.textContent).toBe('Still writing your reasons…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never promises AI progress when AI is switched off', async () => {
    /**
     * The other half of the second threshold, and the branch that decides it: the AI timer is set
     * only when `aiEnabled`, because "Still writing your reasons…" is a claim about a model that
     * was never asked. Dropping the ternary — always arming the timer — fails here and nowhere
     * else.
     */
    vi.useFakeTimers();
    try {
      const never: ApiClient = {
        listMeals: () => Promise.reject(new Error('not used')),
        getMeal: () => Promise.reject(new Error('not used')),
        recommend: () => new Promise(() => undefined),
        ask: () => Promise.reject(new Error('not used')),
      };
      const view = await render(never);
      await view.dispatch(preferencesActions.changeAiEnabled(false));

      // Well past both thresholds, and the request is still in flight.
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      // The loading surface still appears — the first threshold is not about AI.
      expect(view.find('home-loading')?.textContent).toBe('Finding meals for you…');
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces the safety disclaimer above the meals', async () => {
    /**
     * T-15-06 / FR-007. The ORDER is the assertion, not merely the presence: a qualification the
     * user has to scroll past three cards to reach has not qualified anything.
     */
    const { client } = domainClient();
    const view = await render(client);
    const disclaimer = view.find('home-disclaimer');
    const meals = view.find('home-recommendations');
    expect(disclaimer).not.toBeNull();
    expect(meals).not.toBeNull();
    if (disclaimer !== null && meals !== null) {
      // `DOCUMENT_POSITION_FOLLOWING` on the disclaimer means the meals come after it.
      expect(disclaimer.compareDocumentPosition(meals) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
    }
    expect(view.text()).toContain('not medical advice');
  });

  it('NEVER renders a peanut meal to a user with a peanut allergy (T-15-07)', async () => {
    /**
     * **The assertion this product exists to get right — and the first version of it could not
     * have failed.**
     *
     * It used `DEFAULT_PREFERENCES` (regular / balanced / medium) and asserted that no peanut meal
     * appeared in the top three. The catalog has exactly two peanut-bearing meals, `pad-see-ew` and
     * `rocky-road-fudge`, and under those preferences the top three are **identical with and
     * without the allergy** at every period — `pad-see-ew` ranks 4th of 60 at lunch and
     * `rocky-road-fudge` 6th at snack. Deleting the allergen hard-rejection entirely left the test
     * green. It held by luck of the scoring, not by the rule.
     *
     * `budget: 'low'` at lunch is the lever that makes the rejection observable: it puts
     * `pad-see-ew` **into** the top three, so removing it is something the DOM can see.
     *
     * Answered through the real `recommend()`, and checked against `effectiveAllergenTags` —
     * declared tags UNION inferred — so a meal whose peanut content is only in its ingredient list
     * counts too.
     */
    const { client } = domainClient();
    const view = await render(client);

    // THE CONTROL. Without it this test is exactly as vacuous as the version it replaces: it must
    // be shown that a peanut meal is reachable before its absence means anything.
    await view.dispatch(preferencesActions.changeBudget('low'));
    const reachable = view.mealIds();
    expect(reachable.length).toBeGreaterThan(0);
    expect(
      reachable,
      'a peanut meal must be in the top three for the next step to mean anything',
    ).toContain('pad-see-ew');

    await view.dispatch(preferencesActions.changeAllergies(['peanut']));

    const rendered = view.mealIds();
    // Not vacuous in the other direction either: a failed request would empty the list and pass
    // every exclusion loop below.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain('pad-see-ew');
    for (const meal of PEANUT_MEALS) {
      expect(rendered, `${meal.id} must not be recommended`).not.toContain(meal.id);
    }
    // And the stronger form: everything rendered is peanut-free by the effective-tag measure, not
    // merely absent from a list of two ids that happens to be today's catalog.
    for (const id of rendered) {
      const meal = CATALOG.find((one) => one.id === id);
      expect(meal).toBeDefined();
      expect([...effectiveAllergenTags(meal as Meal)], id).not.toContain('peanut');
    }
  });

  it('discards the meals on screen the moment an allergy changes (T-14-07, FR-003)', async () => {
    /**
     * **The requirement is about the INTERVAL, not the outcome.**
     *
     * A screen that cleared its list when the new response arrived would satisfy "changing
     * allergies re-runs filtering" and still leave a peanut meal visible to someone who has just
     * declared a peanut allergy — for the length of a round trip, and for ever if it failed.
     *
     * So this holds the response open: the client is made to never answer the second request, and
     * the assertion is that the list is **already gone** while nothing has come back.
     */
    let calls = 0;
    const real = domainClient();
    const client: ApiClient = {
      ...real.client,
      recommend: (request, signal) => {
        calls += 1;
        if (calls === 1) {
          return real.client.recommend(request, signal);
        }
        // The second request never resolves, so the assertions below run at a moment when
        // nothing has come back.
        return new Promise(() => undefined);
      },
    };

    const view = await render(client);
    const before = view.mealIds();
    expect(before.length).toBeGreaterThan(0);

    await view.dispatch(preferencesActions.changeAllergies(['peanut']));

    /**
     * **A new request went out, nothing has answered it, and the old meals are already gone.**
     *
     * Those three together are the interval claim. `calls === 2` proves the change re-ran
     * filtering; the second promise never settles, so no response can have cleared the list; and
     * the list is empty anyway.
     *
     * An earlier version of this test also asserted a `releaseSecond` callback was still `null`,
     * which could never have failed: a `new Promise` executor runs SYNCHRONOUSLY at construction,
     * so the variable was assigned before the assertion read it. Removed rather than repaired —
     * the three assertions below already say the whole thing.
     */
    expect(calls).toBe(2);
    expect(view.mealIds()).toStrictEqual([]);
    expect(view.find('home-recommendations')).toBeNull();
  });

  it('does NOT re-request when a no-op allergy change is dispatched', async () => {
    /**
     * The other half of FR-003 being useful: re-selecting the same set must not blank the screen,
     * or the invalidation becomes something a user learns to work around.
     *
     * **Counted as REQUESTS, because comparing the rendered list could not fail.** The stub
     * resolves synchronously with the same three meals, so removing the reducer's `sameList` guard
     * would bump the revision, re-run the effect, and still leave `mealIds()` equal — the
     * assertion was true either way. The request count is the only thing that moves.
     */
    const { client, requests } = domainClient();
    const view = await render(client);
    await view.dispatch(preferencesActions.changeAllergies(['peanut']));
    const afterRealChange = requests.length;
    expect(view.mealIds().length).toBeGreaterThan(0);

    // `PEANUTS` normalises to `peanut`, which is already selected: no change, no request.
    await view.dispatch(preferencesActions.changeAllergies(['PEANUTS']));
    expect(requests.length).toBe(afterRealChange);
    // And re-ordering the same set is not a change either.
    await view.dispatch(preferencesActions.changeAllergies(['peanut', 'PEANUTS']));
    expect(requests.length).toBe(afterRealChange);
  });

  it('says why the list is empty when everything is excluded', async () => {
    /**
     * T-15-05, and the first version of this test never reached the state it was named for.
     *
     * It used vegan + four allergens + `budget: 'low'` at lunch and wrapped the assertion in an
     * `if` — I ran that profile through `recommend()` and it returns **three** meals, so the branch
     * was never taken and the `else` asserted the empty state was *absent*. `home-empty` was
     * rendered by nothing in the suite.
     *
     * The stub is given an empty response directly instead. That is a true server answer — §11.5
     * fixes the response at "up to three" and P10's suite covers an empty result for real — and it
     * is the only way to reach this branch without asserting a fact about today's catalog.
     */
    const empty: ApiClient = {
      listMeals: () => Promise.reject(new Error('not used')),
      getMeal: () => Promise.reject(new Error('not used')),
      recommend: (request) =>
        Promise.resolve({ mealPeriod: request.mealPeriod, recommendations: [] }),
      ask: () => Promise.reject(new Error('not used')),
    };
    const view = await render(empty);

    expect(view.find('home-empty')).not.toBeNull();
    expect(view.text()).toContain('Nothing fits right now');
    // And it says what to do about it, which is PRD §12's third clause.
    expect(view.text()).toContain('Widening one of them');
    // Not the failure states: an empty answer is a successful request.
    expect(view.find('home-error')).toBeNull();
    expect(view.find('home-offline')).toBeNull();
  });

  it('offers a retry on both failure states', async () => {
    /**
     * M-5: Home is a tab screen and is never unmounted, so without a retry the only way out of a
     * failed first request was to change a preference or restart the app.
     *
     * **This test was titled "both" and exercised one.** It rejected with `unreachable` only, and
     * `home-error` — the state `useRecommendations` returns for a 400, a 500 or an unreadable
     * body, and the one the server emits on `invalid_request` — was rendered by no test in the
     * repository. Its single mention anywhere was a `toBeNull()` in the empty-result test, which a
     * deleted element satisfies: removing the whole `failed` block left the suite green and left a
     * user whose request failed with anything but a transport error on a screen with a disclaimer,
     * a heading, and no way out.
     *
     * Both states now, in sequence, each with its own retry, and the third answer succeeds so the
     * screen is shown to recover rather than merely to change failures.
     */
    let calls = 0;
    const flaky: ApiClient = {
      listMeals: () => Promise.reject(new Error('not used')),
      getMeal: () => Promise.reject(new Error('not used')),
      recommend: (request) => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(transportError('recommend', 'unreachable'));
        }
        if (calls === 2) {
          // Not a transport failure: the server was reached and refused. `transportError` cannot
          // build this one, and calling it "offline" would be the comfortable lie S-23 names.
          return Promise.reject(
            new ApiClientError({
              kind: 'server',
              status: 500,
              code: 'internal_error',
              retryable: false,
              wire: null,
              route: 'recommend',
            }),
          );
        }
        return Promise.resolve({ mealPeriod: request.mealPeriod, recommendations: [] });
      },
      ask: () => Promise.reject(new Error('not used')),
    };
    const view = await render(flaky);

    const offline = view.find('home-offline');
    expect(offline).not.toBeNull();
    expect(view.find('home-error'), 'unreachable is not an error state').toBeNull();

    const retryOffline = getByRole(offline as HTMLElement, 'button', { name: 'Try again' });
    await act(async () => {
      retryOffline.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await view.settle();

    // The retry really re-requested, and the second failure is the OTHER state.
    expect(calls).toBe(2);
    expect(view.find('home-offline')).toBeNull();
    const failed = view.find('home-error');
    expect(failed).not.toBeNull();
    // PRD §12's three clauses: what happened, what still works, what to do next.
    expect(view.text()).toContain('Suggestions could not be loaded.');
    expect(view.text()).toContain('Explore and your saved meals still work.');

    const retryFailed = getByRole(failed as HTMLElement, 'button', { name: 'Try again' });
    await act(async () => {
      retryFailed.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await view.settle();

    expect(calls, 'the error state must re-request too, not merely repaint').toBe(3);
    expect(view.find('home-error')).toBeNull();
    expect(view.find('home-offline')).toBeNull();
    // And it recovered into a real state rather than into nothing.
    expect(view.find('home-empty')).not.toBeNull();
  });

  it('does not crash when a meal time cannot be parsed — it settles on a snack', async () => {
    /**
     * C-3's second line of defence. `parseClockTime` throws `RangeError` on anything but
     * zero-padded `HH:mm`, `mealPeriodForDate` is called during RENDER, and there is no error
     * boundary in this app — so one unparseable anchor unmounted the tree.
     *
     * **Driven at the hook rather than through `replace`, because the route this test used has
     * been closed.** It dispatched `preferencesActions.replace({… breakfast: '08:' …})` and read
     * the heading; the store's `replaced` branch now sanitises every field, so `'08:'` is refused
     * and the previous anchor is kept — the screen said "Lunch" and the assertion failed without
     * anything about this guard having changed. That closure is the real fix and it is the store's
     * to assert. The guard behind it still has to hold, because the store is not the only way a
     * value arrives: a migration, a restored backup or a future import is not the store, and a
     * crash is the worst possible response. So the hook is handed the state directly.
     */
    const unparseable: PreferencesState = {
      preferences: {
        ...DEFAULT_PREFERENCES,
        mealTimes: { breakfast: '08:', lunch: '12:30', dinner: '19:00' },
      },
      allergiesRevision: 0,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <PeriodProbe client={domainClient().client} preferences={unparseable} />,
      );
    });

    // Rendered at all — a `RangeError` during render would have thrown out of `act` — and it
    // settled on the period that claims least rather than on a guess.
    expect(host.querySelector('[data-testid="probe-period-snack"]')).not.toBeNull();
  });

  it('calls a period outside every window "Something small"', async () => {
    /**
     * The other half of what the test above used to cover: the screen's copy for `snack`, reached
     * through the real store with anchors it will actually keep. 12:30 sits 630 minutes or more
     * from all three, and `MEAL_PERIOD_WINDOW` is −90/+120, so no window claims it.
     *
     * Not `titleCase`, and that is the point of `PERIOD_HEADING`: "Snack" is not a time of day.
     */
    const { client } = domainClient();
    const view = await render(client);
    await view.dispatch(
      preferencesActions.replace({
        ...DEFAULT_PREFERENCES,
        mealTimes: { breakfast: '00:00', lunch: '01:00', dinner: '02:00' },
      }),
    );

    expect(view.find('home-period')?.textContent).toBe('Something small');
  });
});
