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
 * The text a screen reader would be handed for one region.
 *
 * `Icon` renders a vendor glyph inside a `Text`, so a decorative mark contributes characters to
 * `textContent` that are no part of any announcement. Stripping the `aria-hidden` subtrees is what
 * makes an assertion about the *announcement* rather than about every character in the subtree.
 *
 * Throws on `null` rather than taking a non-null assertion at the call site: `expect(x).not.toBe
 * Null()` does not narrow, and the alternative is the `as` this codebase exists to avoid.
 */
function announcedTextOf(region: HTMLElement | null): string {
  if (region === null) {
    throw new Error('no region to read an announcement from');
  }
  const clone = region.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error('cloneNode did not return an element');
  }
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return clone.textContent ?? '';
}

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

  it('ANNOUNCES it, because a user who cannot see the panel is the one at risk', async () => {
    /**
     * **T-23-05's "async results announced", on the surface where the result is a data loss.**
     *
     * The test above proves the notice is drawn. It was drawn to nobody: `StatusMessage` set
     * `aria-live` and no role, and a live region that is inserted TOGETHER with its own words
     * announces nothing — the region has to exist before the contents change for a screen reader
     * to speak them, and this branch mounts at hydration with its sentences already inside it. So
     * to a blind user with a peanut allergy whose declarations had just been quarantined, the app
     * looked exactly like an app that was working.
     *
     * Asserted as what a screen reader receives rather than as a prop that was passed: the
     * rendered `role`, and the announced text read off **that same element**, which is the defect
     * three `Sheet` dialogs were found with — a role on one node and its name on another.
     */
    const driver = memoryDriver({
      [STORAGE_KEYS.preferences]: JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-09-13T12:00:00.000Z',
        value: { schemaVersion: 1, diet: 'not-a-real-diet' },
      }),
    });

    const view = await render(domainClient().client, AT_LUNCH, 0, undefined, driver);
    const notice = view.find('home-preferences-recovered');
    expect(notice).not.toBeNull();

    // A live region that is actually announced on arrival, and polite rather than an interruption.
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.getAttribute('aria-live')).toBe('polite');

    /**
     * And it has something to say. **Both sentences, off the alert node itself** — the reset AND
     * the consequence, because "your preferences were reset" is not the safety claim; "your
     * allergy list is empty" is. An alert with a role and no words is silent in exactly the way
     * this test exists to catch, so the copy is asserted here and not merely somewhere on screen.
     */
    const spoken = announcedTextOf(notice);
    expect(spoken).toContain('Your preferences were reset');
    expect(spoken).toContain('your allergy list is empty');
    expect(spoken).toContain('Set it again before relying on these suggestions');

    /**
     * **And it announces ONCE.** A re-focus re-renders this screen and re-requests; an alert that
     * were rebuilt each time would be re-spoken each time, which is noise a user turns off. The
     * same DOM node across the bump is how "not remounted" is observable from here.
     */
    await view.refocus(1);
    expect(view.find('home-preferences-recovered')).toBe(notice);
  });

  it('does not announce the notices that were on screen all along', async () => {
    /**
     * The control that no single constant satisfies with the test above: a `StatusMessage` that
     * alerted unconditionally would announce the FR-007 disclaimer too — which is present before
     * the user is, is read in normal document order, and is not dismissible. Turning it into an
     * alert would make the one panel every user meets the one every screen reader interrupts for.
     */
    const view = await render(domainClient().client);
    const disclaimer = view.find('home-disclaimer');

    expect(disclaimer).not.toBeNull();
    expect(disclaimer?.getAttribute('role')).not.toBe('alert');
    // `react-native-web` 0.21.2 maps `accessibilityLiveRegion: 'none'` to `aria-live="off"`, so
    // "not a live region" is an attribute with a value here rather than an absent one.
    expect(disclaimer?.getAttribute('aria-live')).toBe('off');
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

/** The two values `explanationSource` can take (`packages/contracts` core, `Recommendation`). */
type ExplanationSource = Recommendation['explanationSource'];

/**
 * Distinct per card AND per source, so an assertion can bind one card to one sentence.
 *
 * The meal id is in the sentence because "the screen contains this string" is satisfied by the
 * string being anywhere — including on the wrong card, which is the defect a mixed render exists
 * to catch.
 */
function explanationFor(source: ExplanationSource, mealId: string): string {
  return `${source === 'gemma' ? 'A model' : 'A template'} wrote this for ${mealId}.`;
}

/**
 * The real-domain response with the two fields the AI lane owns substituted, per card.
 *
 * **`'gemma'` has never reached this screen.** P10's explanation lane always answered
 * `'fallback'`, so no response in production, in a fixture or in a test has ever carried the other
 * value — and the marker has only ever been exercised in the direction that shows it. P20's server
 * work sends `'gemma'` for the first time.
 *
 * Wraps `domainClient` rather than replacing it, so the cards are still whatever the real
 * `recommend()` chose from the real catalog and only `explanation` and `explanationSource` are
 * mine. A missing entry becomes `'fallback'`, which is the direction that FAILS the assertions
 * below rather than satisfying them: every one of them is about the marker being absent or counted,
 * so a short fixture goes red instead of passing quietly.
 */
function sourcedClient(sources: readonly ExplanationSource[]): ApiClient {
  const real = domainClient();
  return {
    ...real.client,
    recommend: async (request, signal) => {
      const response = await real.client.recommend(request, signal);
      return {
        ...response,
        recommendations: response.recommendations.map((recommendation, index) => {
          const source = sources[index] ?? 'fallback';
          return {
            ...recommendation,
            explanation: explanationFor(source, recommendation.meal.id),
            explanationSource: source,
          };
        }),
      };
    },
  };
}

/**
 * Every marker in one render, as meal ids in card order.
 *
 * Scoped to this render's `host` and not to `document`: this file never unmounts a tree, so a
 * document-wide count would add up every render in the file. Counted rather than existence-checked
 * because "a marker is present" is true of a screen that marks all three.
 */
function markedMealIds(view: Harness): string[] {
  return [...view.host.querySelectorAll('[data-testid^="explanation-source-"]')].map((node) =>
    (node.getAttribute('data-testid') ?? '').replace('explanation-source-', ''),
  );
}

/** The marker inside its OWN card, so a legend somewhere else on the screen does not count. */
function markerInCard(view: Harness, mealId: string): HTMLElement | null {
  const row = view.find(`recommendation-${mealId}`);
  const found = row?.querySelector(`[data-testid="explanation-source-${mealId}"]`);
  return found instanceof HTMLElement ? found : null;
}

/**
 * T-20-04 — PRD FR-009, "client rendering: fallback is visibly marked".
 *
 * **A badge on every card is not a distinction, and half of this claim had never been tested.**
 * The T-15-04 test above proves a fallback IS marked; nothing proved a model-written explanation
 * is NOT, because `'gemma'` did not exist anywhere in the app until P20. So a screen that marked
 * every card — `HomeScreen.tsx`'s own docstring says that would "put a badge on every card and
 * tell the user nothing" — passed the whole of the acceptance.
 *
 * The three tests here are built so **no single constant satisfies them**: all-gemma demands zero
 * markers, all-fallback demands three, and the mixed render demands exactly the fallback ones, in
 * their own cards. A screen that marks everything fails the first, a screen that marks nothing
 * fails the second, and a screen whose marker is keyed off the wrong recommendation fails the
 * third while passing both others.
 */
describe('the explanation-source marker (T-20-04)', () => {
  it('does NOT mark a model-written explanation, and still renders it', async () => {
    /**
     * The missing half. `'gemma'` means a model wrote this sentence, which is the ordinary case
     * FR-009 describes — so it carries no marker, and the absence is what makes the marker on the
     * other card mean something.
     *
     * The explanation itself is still asserted on every card: not marking a sentence must not
     * become not showing it.
     */
    const view = await render(sourcedClient(['gemma', 'gemma', 'gemma']));
    const ids = view.mealIds();
    expect(ids, 'three cards, or the absences below are absences of nothing').toHaveLength(3);

    for (const id of ids) {
      const row = view.find(`recommendation-${id}`);
      expect(row, id).not.toBeNull();
      expect(row?.textContent ?? '', id).toContain(explanationFor('gemma', id));
      expect(markerInCard(view, id), id).toBeNull();
    }

    expect(markedMealIds(view), 'nothing model-written may be marked').toStrictEqual([]);
    expect(view.text()).not.toContain('Written by the app');
  });

  it('marks all three when all three are the fallback — the half that pairs with it', async () => {
    /**
     * The same claim as T-15-04's test above, restated here as the other end of the pair so the
     * two sit in one describe and one mutation cannot satisfy both. Counted, not merely found: the
     * test above reads the first card only.
     *
     * **PRD §10.5 — "colour is never the only carrier of status".** The marker is a sentence, so
     * the exact words are asserted rather than a class, a tone or an icon: in react-native-web
     * this `AppText` renders its text content, which is also its accessible name, and that is the
     * whole of the distinction a user (or a screen reader) gets.
     */
    const view = await render(sourcedClient(['fallback', 'fallback', 'fallback']));
    const ids = view.mealIds();
    expect(ids).toHaveLength(3);
    expect(markedMealIds(view)).toStrictEqual(ids);

    for (const id of ids) {
      expect(markerInCard(view, id)?.textContent, id).toBe('Written by the app');
    }
  });

  it('marks exactly the fallback card in a mixed response, in its own card', async () => {
    /**
     * **The render a real user meets once P20's lane is live**, and the one that catches a marker
     * keyed off the wrong recommendation: with `'gemma'` first and last, a marker driven by
     * `recommendations[0]` — or by the last card, or by any one of them — is either on all three
     * cards or on none, and both are wrong here.
     *
     * Each card is also checked against ITS OWN sentence, so a marker that lands on the right
     * count but the wrong card fails too.
     */
    const sources: readonly ExplanationSource[] = ['gemma', 'fallback', 'gemma'];
    const view = await render(sourcedClient(sources));
    const ids = view.mealIds();
    expect(ids).toHaveLength(sources.length);

    const expected = ids.filter((_id, index) => sources[index] === 'fallback');
    // The fixture must actually mix, or this is one of the two tests above wearing a new name.
    expect(expected, 'exactly one fallback card in the fixture').toHaveLength(1);
    expect(markedMealIds(view)).toStrictEqual(expected);

    for (const [index, id] of ids.entries()) {
      const source = sources[index] ?? 'fallback';
      const row = view.find(`recommendation-${id}`);
      expect(row, id).not.toBeNull();
      expect(row?.textContent ?? '', id).toContain(explanationFor(source, id));

      const marker = markerInCard(view, id);
      if (source === 'fallback') {
        expect(marker, id).not.toBeNull();
        expect(marker?.textContent, id).toBe('Written by the app');
      } else {
        expect(marker, id).toBeNull();
      }
    }
  });
});

/**
 * A response carrying MORE recommendations than the screen may paint.
 *
 * `recommend()` returns `candidates` — the whole eligible list, with allergen-conflicting,
 * diet-incompatible and unavailable meals already rejected — alongside the `selected` three it
 * slices out of them. So the top `count` of `candidates` is `count` REAL recommendations, with the
 * domain's own scores, reasons and order, whose fourth member is precisely the meal
 * `MAX_RECOMMENDATIONS` excluded. Nothing here is hand-made except the two fields the AI lane owns.
 *
 * **It bypasses the domain's slice, and that is the point rather than a weakness.** `Plan.md`
 * §11.5's recommendations block fixes the response at three, so no server this project ships sends
 * four — but `decodeRecommendationResponse` imposes **no length bound**, so a server that did
 * would decode cleanly and land four in this screen's state. What the fixture therefore cannot
 * claim is that today's server produces this; what it does claim is that the screen does not
 * *trust* the server's cap, which is the entire reason the cap is applied on this side too.
 *
 * `offered()` reports what the fixture actually handed over, so an assertion about a fourth card
 * can first establish that a fourth was on offer.
 */
function overflowingClient(count: number): {
  readonly client: ApiClient;
  readonly offered: () => readonly string[];
} {
  let offered: readonly string[] = [];
  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: () => Promise.reject(new Error('not used')),
    recommend: (request) => {
      const result = recommend(
        {
          period: request.mealPeriod,
          preferences: request.preferences,
          favoriteMealIds: request.favoriteMealIds,
        },
        CATALOG,
      );
      const recommendations: Recommendation[] = result.candidates.slice(0, count).map((scored) => ({
        meal: scored.meal,
        score: scored.score,
        scoreReasons: scored.scoreReasons,
        explanation: explanationFor('fallback', scored.meal.id),
        explanationSource: 'fallback',
      }));
      offered = recommendations.map((recommendation) => recommendation.meal.id);
      const response: RecommendationResponse = { mealPeriod: request.mealPeriod, recommendations };
      return Promise.resolve(response);
    },
    ask: () => Promise.reject(new Error('not used')),
  };
  return { client, offered: () => offered };
}

/**
 * T-28-03 — "no duplicated domain logic", and the case that had never run.
 *
 * `HomeScreen.tsx` used to declare its own `MAX_RECOMMENDATIONS = 3`, unimported and equal to
 * `packages/domain/src/scoring.ts`'s by coincidence rather than by construction. The final audit
 * measured what that cost: **3 → 4 in the screen's copy failed 0 of this file's tests**, because
 * every fixture answered through `recommend().selected` and so **no fixture had ever supplied a
 * fourth recommendation** — the "no fourth card" guard's own case never ran. The copy also masked
 * the drift in the other direction: moving the **domain's** constant to 4 while the screen said 3
 * failed nothing either, because the screen's slice quietly absorbed it.
 *
 * The duplication is gone — the screen imports the domain's constant — so a divergence between the
 * two is no longer representable. These two tests close what the import does not: that the cap is
 * **applied at all**. Removing `.slice(...)` leaves one copy of one constant and still paints a
 * fourth card, and nothing in the repository used to notice.
 */
describe('the cap on cards (T-28-03)', () => {
  /**
   * **Three, hand-transcribed from PRD §7.1 — "Return the top three." — and deliberately NOT read
   * from `MAX_RECOMMENDATIONS`.** BRIEF §6.1g: an expectation computed from the constant under
   * test pins nothing, because a drift moves both sides together and the assertion stays true of
   * whatever the implementation happens to be. Written out, it pins the screen against the
   * *product requirement*, which is a different authority from the module — so the domain's
   * constant moving to 4 reddens here instead of passing quietly.
   */
  const PRD_TOP_THREE = 3;

  it('paints three cards when a response offers four, and the fourth appears nowhere', async () => {
    const { client, offered } = overflowingClient(4);
    const view = await render(client);

    // Vacuous otherwise: every assertion below is about a fourth that had to have been on offer.
    const fixture = offered();
    expect(fixture, 'the fixture must offer a fourth eligible recommendation').toHaveLength(4);
    expect(new Set(fixture).size, 'four DISTINCT meals, or "absent" means nothing').toBe(4);

    const ids = view.mealIds();
    expect(ids).toHaveLength(PRD_TOP_THREE);
    // The FIRST three, in the domain's order — not merely three of the four. A screen that kept
    // the fourth and dropped the first has the right count and the wrong cards.
    expect(ids).toStrictEqual([...fixture].slice(0, PRD_TOP_THREE));

    const fourth = fixture[PRD_TOP_THREE];
    expect(fourth, 'the fourth id').toBeDefined();
    expect(view.find(`recommendation-${fourth ?? ''}`), 'no fourth row').toBeNull();
    expect(view.find(`meal-${fourth ?? ''}`), 'no fourth MealCard').toBeNull();
    // Not only the testIDs: a fourth card rendered without them would still put its sentence on
    // screen, and `explanationFor` carries the meal id exactly so this can tell the cards apart.
    expect(view.text()).not.toContain(explanationFor('fallback', fourth ?? ''));
  });

  it('paints all three when a response offers exactly three — the control', async () => {
    /**
     * The half no single constant satisfies with the test above. `slice(0, 0)` satisfies "the
     * fourth appears nowhere"; a screen hard-wired to two cards satisfies neither; a screen that
     * renders whatever it is handed passes this one and fails the other. Only a cap of three
     * passes both.
     */
    const { client, offered } = overflowingClient(PRD_TOP_THREE);
    const view = await render(client);

    const fixture = offered();
    expect(fixture, 'the control must offer exactly three').toHaveLength(PRD_TOP_THREE);
    expect(view.mealIds()).toStrictEqual([...fixture]);
    expect(view.find('home-recommendations'), 'the list itself').not.toBeNull();
  });
});
