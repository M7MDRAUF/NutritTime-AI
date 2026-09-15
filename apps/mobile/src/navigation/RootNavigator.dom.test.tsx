/**
 * T-12-12 and T-22-03. The claims that matter, and the reason each is a test rather than a review
 * note:
 *
 *  1. **The boot phase gates what renders.** Not what is focused — what *exists*. The negative
 *     assertions carry the weight here: in `hydrating` there must be no route to the tabs at all,
 *     which is TSD §6.1's guarantee that a protected screen cannot render before hydration and
 *     that onboarding cannot be shown to someone who has finished it.
 *  2. **Five tabs, in PRD §11's order**, with the Assistant in the centre.
 *  3. **A cold URL loads its own screen** — R-44, and the one the last section of this file owns.
 *     `linking.dom.test.ts` proves `getStateFromPath` parses the paths; this proves the container
 *     applies the parse to the real navigator, which is precisely the wiring R-44 recorded as
 *     missing and could not name.
 *
 * Nothing is registered, so each route renders its placeholder — which names the route, and so
 * makes "which screens exist" directly readable from the DOM.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import type { NavigationContainerRefWithCurrent } from '@react-navigation/native';
import { ThemeProvider } from '../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../state/StorageProvider.js';
import { uiStore } from '../state/ui/index.js';
import { memoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from '../infrastructure/storage/definitions.js';
import type { UiTab } from '../infrastructure/storage/definitions.js';
import { RootNavigator } from './RootNavigator.js';
import { NON_LINKABLE_SCREENS, ROUTE_PATHS, linking } from './linking.js';
import type { LinkableScreenName } from './linking.js';
import { SCREEN_ROUTE_NAMES } from './routes.js';
import type { BootPhase, RootParamList, ScreenRouteName } from './routes.js';
import { renderToDom } from './testHarness.js';
import type { DomRender } from './testHarness.js';

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('./testHarness.js');
  return createSafeAreaContextMock();
});

/**
 * **`StorageProvider` and the `ui` store are mounted here as of P18, and that is a real change to
 * what this suite covers rather than boilerplate.**
 *
 * `TabNavigator` now records the tab the user moved to (T-18-01): it dispatches
 * `ui/tabChanged` on `focus`, and reads the tab to open on from the hydration snapshot. So the
 * navigator genuinely depends on both, and a test that rendered it without them would be testing a
 * tree the app never builds.
 *
 * This is **not** the mocking exercise `RootNavigator`'s own docstring warns about — `phase` is
 * still a prop, for exactly the reason recorded there. These are the real providers with an
 * injected memory driver, the same shape `createStore.dom.test.tsx` uses, so nothing here is a
 * stand-in for the thing it is testing.
 */
const CLOCK = () => '2026-09-13T12:00:00.000Z';

function App({
  phase,
  navigationRef,
}: {
  readonly phase: BootPhase;
  /**
   * Only the landmark section passes one. A navigation from outside the tree is how "two screens
   * are mounted at once" is reached without a screen registry to click through — nothing is
   * registered here, so the placeholders have no links.
   */
  readonly navigationRef?: NavigationContainerRefWithCurrent<RootParamList>;
}): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <StorageProvider runtime={{ driver: memoryDriver({}), now: CLOCK }}>
        <uiStore.Provider>
          <NavigationContainer ref={navigationRef}>
            <RootNavigator phase={phase} />
          </NavigationContainer>
        </uiStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );
}

/** The accessible names of the tab buttons, in render order. */
/**
 * What each tab ANNOUNCES, which is not the same as its `textContent`.
 *
 * Descendants marked `aria-hidden` are dropped, and that turned from bookkeeping into the point of
 * the helper when the tabs got real icons (A-11): every `tabBarIcon` renders an `Icon`, which hides
 * itself from assistive technology because the visible label beside it already says the word. A
 * bare `textContent` read picks the icon up anyway and returned `home-outlineHome`.
 *
 * So this now asserts the accessibility claim rather than merely tolerating the icon: a tab
 * announces "Home", once, and the icon contributes nothing to its name.
 */
function tabNames(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll('[role="tab"]')].map((tab) => {
    const clone = tab.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      return '';
    }
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
    return clone.textContent ?? '';
  });
}

describe('the root navigator', () => {
  it('shows only Splash while hydrating', async () => {
    const view = await renderToDom(<App phase="hydrating" />);

    expect(view.text()).toContain('Splash is not available yet');
    // The tabs are not merely unfocused — there is no tab bar, because the route does not exist.
    expect(tabNames(view.host)).toEqual([]);
    expect(view.text()).not.toContain('Home');
    expect(view.text()).not.toContain('Onboarding');
    await view.unmount();
  });

  it('shows onboarding, and no route into the app, while onboarding', async () => {
    const view = await renderToDom(<App phase="onboarding" />);

    expect(view.text()).toContain('Onboarding is not available yet');
    expect(tabNames(view.host)).toEqual([]);
    expect(view.text()).not.toContain('Splash');
    await view.unmount();
  });

  it('shows the five tabs, Assistant in the centre, once the app phase is reached', async () => {
    const view = await renderToDom(<App phase="app" />);

    expect(tabNames(view.host)).toEqual(['Home', 'Explore', 'Assistant', 'Saved', 'Settings']);
    // Home is the initial tab, and its stack is mounted.
    expect(view.text()).toContain('Home is not available yet');
    // Onboarding is gone: a user who has finished it cannot be shown it again.
    expect(view.text()).not.toContain('Onboarding is not available yet');
    expect(view.text()).not.toContain('Splash is not available yet');
    await view.unmount();
  });

  it('swaps the screens when the phase advances, rather than redirecting over them', async () => {
    const view = await renderToDom(<App phase="hydrating" />);
    expect(view.text()).toContain('Splash is not available yet');

    await view.rerender(<App phase="app" />);

    expect(tabNames(view.host)).toEqual(['Home', 'Explore', 'Assistant', 'Saved', 'Settings']);
    expect(view.text()).not.toContain('Splash is not available yet');
    await view.unmount();
  });
});

/**
 * **R-77 and `Plan.md` §20's `Semantic HTML` row, which asks for "one `main` landmark".**
 *
 * Every assertion below is a COUNT rather than a presence check, and that is the whole design.
 * The built export had zero `role="main"`; the obvious repair — an ungated `screenLayout` — was
 * measured at **1** landmark at rest, **2** with `MealDetails` pushed over the tabs and **3** with
 * `MealForm` above that, because a native stack keeps the screens below the top one mounted. A
 * `toBeTruthy()` on the landmark passes all three. So does a wrapper placed outside
 * `Stack.Navigator`, which is one landmark forever and is also the entire viewport.
 *
 * `LANDMARK` is written out rather than read from the component, per BRIEF §6.1g: a selector
 * derived from `ScreenLandmark` would match whatever that file happens to say.
 */
const LANDMARK = '[role="main"]';

function landmarks(host: HTMLElement): readonly HTMLElement[] {
  return [...host.querySelectorAll(LANDMARK)].filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
}

/** The one landmark, or a failure naming how many there actually were. */
function theLandmark(host: HTMLElement): HTMLElement {
  const found = landmarks(host);
  expect(found.length, `expected exactly one ${LANDMARK}`).toBe(1);
  const only = found[0];
  if (only === undefined) {
    // Unreachable past the assertion above; `noUncheckedIndexedAccess` wants it said anyway, and
    // a throw is preferable to the cast that would otherwise hide a real zero.
    throw new Error(`no ${LANDMARK} in the document`);
  }
  return only;
}

describe('the main landmark', () => {
  // Every phase, because a phase that renders a different screen set is a different document and
  // the rule is one landmark per document, not one per happy path.
  for (const phase of ['hydrating', 'onboarding', 'app'] as const) {
    it(`is present exactly once in the ${phase} phase`, async () => {
      const view = await renderToDom(<App phase={phase} />);

      // Both halves: react-native-web resolves the role to an ARIA attribute AND upgrades the
      // `div` to a `main` element, and losing either is a regression a screen reader would feel.
      expect(theLandmark(view.host).tagName).toBe('MAIN');
      expect(view.host.querySelectorAll('main')).toHaveLength(1);
      await view.unmount();
    });
  }

  it('encloses the screen the user is on', async () => {
    const view = await renderToDom(<App phase="app" />);

    expect(theLandmark(view.host).textContent).toContain(placeholderFor('Home'));
    await view.unmount();
  });

  /**
   * **The case the count exists for.** Two pushes leave three stack routes mounted — asserted
   * here, so this test cannot pass by the pushes silently failing — and the landmark must still be
   * one, must have MOVED to the focused screen, and must no longer contain the tab bar. The tab
   * bar is asserted still mounted for the same reason: "not inside the landmark" would otherwise
   * be satisfied by the tabs having unmounted.
   */
  it('stays a single landmark, on the focused screen, with two screens still mounted beneath', async () => {
    const ref = createNavigationContainerRef<RootParamList>();
    const view = await renderToDom(<App phase="app" navigationRef={ref} />);
    expect(theLandmark(view.host).textContent).toContain(placeholderFor('Home'));

    await act(async () => {
      ref.navigate('MealDetails', { mealId: 'dessert-42', origin: 'home' });
    });
    await act(async () => {
      ref.navigate('MealForm', { mealId: 'custom-7' });
    });

    expect(ref.getRootState()?.routes.map((route) => route.name)).toEqual([
      'Tabs',
      'MealDetails',
      'MealForm',
    ]);
    const landmark = theLandmark(view.host);
    expect(landmark.textContent).toContain(placeholderFor('MealForm'));
    expect(landmark.textContent).not.toContain(placeholderFor('Home'));

    const tabBar = view.host.querySelector('[role="tablist"]');
    expect(tabBar, 'the tabs unmounted, so "outside the landmark" proves nothing').not.toBeNull();
    expect(landmark.contains(tabBar)).toBe(false);
    await view.unmount();
  });
});

/**
 * A cold start at a URL, with `linking` wired exactly as `App.tsx` wires it (T-22-03).
 *
 * `linking` is passed as the whole imported object rather than a locally-built one, so a change to
 * the real config is what these tests run against. On the web `useLinking` never consults
 * `prefixes` at all — `getInitialState` reads `window.location.pathname + search` directly — which
 * is why R-44's `window.location.origin` probe changed nothing and why it stays out (see
 * `linking.dom.test.ts`).
 */
function DeepLinkApp({
  phase,
  driver,
}: {
  readonly phase: BootPhase;
  readonly driver: MemoryDriver;
}): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <StorageProvider runtime={{ driver, now: CLOCK }}>
        <uiStore.Provider>
          <NavigationContainer linking={linking}>
            <RootNavigator phase={phase} />
          </NavigationContainer>
        </uiStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );
}

/** A driver holding a stored `ui` record, written the way the repository writes one. */
function driverWithLastTab(lastTab: UiTab | null): MemoryDriver {
  return memoryDriver({
    [STORAGE_KEYS.ui]: JSON.stringify({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      updatedAt: CLOCK(),
      value: { lastTab, disclaimerAcknowledged: false },
    }),
  });
}

/**
 * Put the URL in the address bar FIRST, then mount — which is the whole subject.
 *
 * `history.replaceState` rather than assigning `location`: jsdom refuses a navigation, and the
 * container reads `window.location` at mount either way.
 */
async function coldStartAt(
  url: string,
  phase: BootPhase,
  lastTab: UiTab | null = null,
): Promise<DomRender> {
  window.history.replaceState({}, '', url);
  return renderToDom(<DeepLinkApp phase={phase} driver={driverWithLastTab(lastTab)} />);
}

interface DeepLinkCase {
  /** The URL a user pastes. **Hand-transcribed**, per BRIEF §6.1g — see the note below. */
  readonly url: string;
  /** What `ROUTE_PATHS` must say for this screen. Also hand-transcribed, also on purpose. */
  readonly slug: string;
  /** The phase in which this screen is in the navigator at all (TSD §6.1). */
  readonly phase: BootPhase;
  /**
   * A stored `lastTab` naming a DIFFERENT tab than the URL does.
   *
   * Without it three rows would be free passes — `/home` opens Home because Home is the initial
   * tab, whatever the URL said. `TabNavigator` reads `lastTab` into `initialRouteName`, so seeding
   * a rival tab means every tab row has to be won by the URL rather than defaulted into. That is
   * the coincidence R-44's "a path does restore" turned out to be.
   */
  readonly decoy: UiTab;
}

/**
 * The ten screens, their URLs, and the phase each one exists in.
 *
 * **Every string here is typed out rather than read from `ROUTE_PATHS`, and that is the point.**
 * A table that built its URL from the module under test would pass for any value the module
 * happened to hold: rename `ROUTE_PATHS.Explore` to `xplore` and a derived table would visit
 * `/xplore`, the config would answer to `/xplore`, and nothing would fail. So the URLs are stated,
 * `declares the path its screen is reached by` compares the two authorities, and a drift in either
 * direction fails exactly the row that drifted.
 *
 * `satisfies Record<ScreenRouteName, DeepLinkCase>` makes a new screen with no row a compile
 * error; `covers every screen in the route table` is the runtime half, for a row deleted rather
 * than never added.
 */
const DEEP_LINKS = {
  Onboarding: { url: '/onboarding', slug: 'onboarding', phase: 'onboarding', decoy: 'settings' },
  DietarySetup: { url: '/dietary-setup', slug: 'dietary-setup', phase: 'app', decoy: 'settings' },
  Home: { url: '/home', slug: 'home', phase: 'app', decoy: 'settings' },
  Explore: { url: '/explore?query=rice', slug: 'explore', phase: 'app', decoy: 'settings' },
  Assistant: { url: '/assistant', slug: 'assistant', phase: 'app', decoy: 'settings' },
  Saved: { url: '/saved', slug: 'saved', phase: 'app', decoy: 'settings' },
  MealForm: { url: '/meal-form?mealId=custom-7', slug: 'meal-form', phase: 'app', decoy: 'saved' },
  MealDetails: {
    url: '/meal-details/dessert-42',
    slug: 'meal-details/:mealId',
    phase: 'app',
    decoy: 'saved',
  },
  Settings: { url: '/settings', slug: 'settings', phase: 'app', decoy: 'saved' },
} as const satisfies Record<LinkableScreenName, DeepLinkCase>;

/** The placeholder names its route, so "which screen opened" is readable rather than inferred. */
function placeholderFor(name: ScreenRouteName): string {
  return `${name} is not available yet`;
}

/** What a user would copy out of the address bar, in the form `useLinking` reads it back. */
function addressBar(): string {
  return window.location.pathname + window.location.search;
}

describe('a cold URL', () => {
  // The address bar is global to the jsdom document, so it is put back between cases — otherwise a
  // later test in this file would inherit the previous one's path and pass for the wrong reason.
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('covers every LINKABLE screen in the route table', () => {
    /**
     * **Every screen minus the non-linkable ones, so the table still cannot lose a row silently.**
     *
     * `Splash` left this table at P28 because it is not a destination: making `/splash` restore was
     * measured and it **strands** the user — zero interactive elements, no tab bar, nothing that
     * advances it, and an `alert` role announcing a load that is not happening. The row that used
     * to be here was green only under `phase: 'hydrating'`, which `App.tsx` never passes, so it
     * asserted a path no user could take.
     *
     * The exclusion is not restated here: `linking.dom.test.ts` pins that it is exactly
     * `['Splash']`, and a second copy of that list is how two lists come to disagree.
     */
    const linkable = SCREEN_ROUTE_NAMES.filter(
      (name) => !(NON_LINKABLE_SCREENS as readonly string[]).includes(name),
    );
    expect(Object.keys(DEEP_LINKS).sort()).toEqual([...linkable].sort());
  });

  for (const name of Object.keys(DEEP_LINKS) as readonly LinkableScreenName[]) {
    const { url, slug, phase, decoy } = DEEP_LINKS[name];

    // One case per path rather than one loop inside one `it`, so a single broken `ROUTE_PATHS`
    // entry reddens exactly its own two tests and names the screen in the report.
    it(`declares ${slug} as the path to ${name}`, () => {
      expect(ROUTE_PATHS[name]).toBe(slug);
    });

    it(`loads ${name} from ${url}`, async () => {
      const view = await coldStartAt(url, phase, decoy);

      expect(view.text(), `${url} did not open ${name}`).toContain(placeholderFor(name));
      // The address bar is half of R-44's recorded symptom — the URL was **rewritten** to `/home`,
      // not merely ignored — and it is the half a user copies and shares. Paired with the rewrite
      // asserted in `is LOST` below, so no single behaviour satisfies both.
      expect(addressBar(), `${url} survived on screen but not in the address bar`).toBe(url);
      await view.unmount();
    });
  }

  /**
   * **The control R-44's recorded symptoms make necessary.**
   *
   * The risk row says "a path does restore" and cites `/saved`. It does not: `ui.lastTab` was
   * driving `TabNavigator`'s `initialRouteName`, so the app opened on Saved for a reason that had
   * nothing to do with the URL — the right screen, arrived at by accident. `loads Saved from
   * /saved` above is beatable by exactly that, because a stored `saved` and a URL naming `saved`
   * agree.
   *
   * So the stored tab is seeded to a DIFFERENT tab than the URL names, in both directions. No
   * single mechanism satisfies both rows: `initialRouteName` winning fails the first, and a
   * navigator that ignored the stored tab entirely would still pass — which is fine, because
   * `tabPersistence.dom.test.tsx` owns that claim and would fail instead.
   */
  it('wins over the stored tab, so the right screen is not a coincidence', async () => {
    const savedUrl = await coldStartAt('/saved', 'app', 'settings');
    expect(savedUrl.text()).toContain(placeholderFor('Saved'));
    expect(savedUrl.text()).not.toContain(placeholderFor('Settings'));
    await savedUrl.unmount();

    // The other direction, so the pair cannot be satisfied by "always open Saved".
    const settingsUrl = await coldStartAt('/settings', 'app', 'saved');
    expect(settingsUrl.text()).toContain(placeholderFor('Settings'));
    expect(settingsUrl.text()).not.toContain(placeholderFor('Saved'));
    await settingsUrl.unmount();
  });

  /**
   * **Why the font gate had to move above the container, characterised as a test.**
   *
   * `NavigationContainer` resolves the URL **once**: `useLinking`'s `getInitialState` is a
   * `useCallback` with no dependencies, `useThenable` resolves it at the first mount, and the
   * result reaches `BaseNavigationContainer` as `initialState`. `StackRouter` then filters that
   * state through its own `routeNames`, so a container mounted while the stack holds only `Splash`
   * discards the parsed `Tabs` route as unknown — and advancing the phase afterwards does not go
   * back for it.
   *
   * That is the mechanism behind R-44, and it is a fact about the library rather than about this
   * app, so it is asserted rather than assumed. `App.tsx` gating fonts inside the container
   * reproduced it on every web cold start (hydration is a synchronous `localStorage` read; the
   * faces are a network fetch), which is why `PhasedNavigation` now holds the container's MOUNT
   * instead of holding the phase. If this test ever fails, the constraint that shape rests on has
   * changed and the comment in `App.tsx` needs rewriting.
   */
  it('is LOST when the container mounts before the phase settles', async () => {
    window.history.replaceState({}, '', '/settings');
    const view = await renderToDom(
      <DeepLinkApp phase="hydrating" driver={driverWithLastTab(null)} />,
    );
    expect(view.text()).toContain(placeholderFor('Splash'));

    await view.rerender(<DeepLinkApp phase="app" driver={driverWithLastTab(null)} />);

    // The URL named Settings and the app is on Home: the parse was thrown away, not deferred.
    expect(view.text()).toContain(placeholderFor('Home'));
    expect(view.text()).not.toContain(placeholderFor('Settings'));
    // **And the address bar is rewritten to `/home`**, which is the rest of R-44's symptom and the
    // reason every case above asserts the URL as well as the screen: the phase change is a state
    // change, `getPathFromState` prints the state the app actually kept, and the evidence of what
    // the user asked for is erased. A successful restore changes no state and so rewrites nothing.
    expect(addressBar()).toBe('/home');
    await view.unmount();
  });

  /**
   * `DietarySetup` is the one screen in two phases — a gate during onboarding, a detour from
   * Settings afterwards — so its URL has to resolve in both. The table row covers the `app` phase;
   * this is the other one, and it matters because the two declarations carry different
   * `navigationKey`s and could diverge without either being obviously wrong.
   */
  it('reaches DietarySetup in the onboarding phase too', async () => {
    const view = await coldStartAt('/dietary-setup', 'onboarding');

    expect(view.text()).toContain(placeholderFor('DietarySetup'));
    await view.unmount();
  });
});
