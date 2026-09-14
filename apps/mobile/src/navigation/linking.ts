/**
 * Deep links (T-12-12), mirroring the navigator tree.
 *
 * The scheme is **not decided here**. `apps/mobile/app.json` sets `expo.scheme` to `nutritime` and
 * that file is what the native build reads; this constant restates it so TypeScript can see it,
 * and `linking.dom.test.ts` asserts the two are equal by reading the manifest from disk. A drift
 * therefore fails the suite instead of producing an app whose links silently never arrive.
 *
 * `ROUTE_PATHS` is typed `Record<ScreenRouteName, string>`, so a screen added to the route table
 * without a path is a compile error — T-22-02's "a path per screen", made structural now rather
 * than audited later. Containers get no path of their own: a URL names a destination screen, and
 * the navigators in between are how the app gets there, not part of what the user asked for.
 *
 * Slugs come from Plan §14.5's route table and `design-system/pages/`, so a page's file name, its
 * route and its URL are the same word.
 */

import type { LinkingOptions } from '@react-navigation/native';
import type { RootParamList, ScreenRouteName } from './routes.js';

/** Must equal `expo.scheme` in `app.json`; the test proves it does. */
export const LINKING_SCHEME = 'nutritime';

export const LINKING_PREFIX = `${LINKING_SCHEME}://`;

/**
 * One path per screen.
 *
 * `MealDetails` takes its id in the path rather than a query string because the param is required
 * — a `meal-details` URL with no meal is not a partially-filled screen, it is not a destination.
 * `MealForm`'s `mealId` is optional (absent means create), so it stays a query param, where
 * absence is representable.
 */
export const ROUTE_PATHS = {
  Splash: 'splash',
  Onboarding: 'onboarding',
  DietarySetup: 'dietary-setup',
  Home: 'home',
  Explore: 'explore',
  Assistant: 'assistant',
  Saved: 'saved',
  MealForm: 'meal-form',
  MealDetails: 'meal-details/:mealId',
  Settings: 'settings',
} as const satisfies Record<ScreenRouteName, string>;

/**
 * **`Tabs.initialRouteName: 'HomeTab'` does not put a back target under a deep-linked tab, and the
 * comment here said for nine phases that it did** (T-22-04).
 *
 * `getStateFromPath('saved')` does produce `[HomeTab, SavedTab]` rather than `[SavedTab]`, and
 * `linking.dom.test.ts` pins that. But a tab router rebuilds its routes from `routeNames` — all
 * five always exist — and derives its history from the partial state's own `history` field, which
 * a URL parse never supplies. Measured against `@react-navigation/routers` 7.6.4: the rehydrated
 * history for `/settings` is `[HomeTab, Settings]` with this line and `[HomeTab, Settings]`
 * without it, identical under every one of the six `backBehavior` values. What actually left Home
 * underneath `nutritime://settings` was the router's DEFAULT `backBehavior: 'firstRoute'`, which
 * T-22-04 replaces for the reasons in `TabNavigator.tsx` — including that this is the behaviour
 * the change gives up.
 *
 * **The line stays, because it does one measurable thing, and that thing matters more now.**
 * `getActionFromState` emits `initial: false` on the tab-level NAVIGATE only when the config names
 * an initial route, and `getStateFromParams` builds a replacement one-route state for the nested
 * navigator only when `initial !== false` (`@react-navigation/core` 7.21.13,
 * `useNavigationBuilder.js:151`). So on the one path that dispatches an action instead of
 * restoring a state — `useLinking` going forward to a path it holds no record for — this is what
 * stops an arriving link from wiping the visited-tab history `backBehavior: 'history'` builds.
 */
export const linking: LinkingOptions<RootParamList> = {
  /**
   * The custom scheme only, and **that is now a decision rather than an omission** — R-44, closed
   * by T-22-03.
   *
   * **R-44's cause was never in this file.** `/explore?query=chicken` landed on Home because
   * `App.tsx` mounted `NavigationContainer` above `<RootNavigator phase={fontsReady ? phase :
   * 'hydrating'} />`: on the web the font fetch always loses to a synchronous `localStorage` read,
   * so the container mounted while the root stack held **only `Splash`**. `useLinking` resolves
   * the URL once, at that first mount, and `StackRouter` discards a parsed route its `routeNames`
   * does not contain — so the `Tabs` route was thrown away and the address bar rewritten to
   * `/home` when the phase advanced. The fix is the gate's position in `App.tsx`; nothing here
   * changed.
   *
   * **`window.location.origin` stays out, and `linking.dom.test.ts` now says why.** The web
   * `useLinking` builds `location.pathname + location.search` and parses that — a path, with the
   * origin already stripped by the browser — and never reads `prefixes` at all. A prefix exists to
   * strip a scheme off a native `nutritime://explore` URL. That is why the probe R-44 records
   * "changed nothing" could only ever have changed nothing, and it is not cargo-culted back in.
   *
   * **R-44's recorded symptoms were also wrong in the other direction**, which is worth keeping
   * because it is what made the defect look narrower than it was: the row says "a path does
   * restore". No path restored. `/saved` appeared to work because `ui.lastTab` was feeding
   * `TabNavigator`'s `initialRouteName` — the right screen for an unrelated reason. Every
   * deep-link assertion in this codebase is now seeded with a rival `lastTab` so that coincidence
   * cannot pass for a restore.
   */
  prefixes: [LINKING_PREFIX],
  /**
   * **No `initialRouteName` at the ROOT, and that is T-22-04 declining it rather than not having
   * thought of it** — the opposite call to the one above, for measured reasons.
   *
   * `initialRouteName: 'Tabs'` here would make `getStateFromPath('meal-details/dessert-42')` yield
   * `[Tabs, MealDetails]` instead of `[MealDetails]`, and unlike the tab case a STACK keeps the
   * routes a parse hands it — so it really would put the app under a cold-loaded modal. Three
   * measurements against it:
   *
   *  1. **It cannot change browser Back**, which is what T-22-04 is about. A cold load is ONE
   *     browser entry: `useLinking` calls `history.replace` at the container's first mount and
   *     pushes only when the navigator's history GROWS. Back from a deep-linked modal therefore
   *     leaves the site with or without it. What it changes is `canGoBack()`, what renders
   *     beneath, and Android's hardware back.
   *  2. **It would make two deliberate fallbacks unreachable.** `MealDetailsScreen`'s dismiss is
   *     `canGoBack() ? goBack() : navigate('Tabs', { screen: ORIGIN_TABS[origin] })` (T-16-07) and
   *     `MealFormScreen`'s is the same shape onto `SavedTab`. Both choose a destination on
   *     purpose; with a route underneath, `canGoBack()` is true and both branches die —
   *     `MealDetailsParams.origin` would go dead on the one path it exists for, which is exactly
   *     the guard-nobody-would-miss shape this codebase keeps finding.
   *  3. **It does not rescue the screen that is actually stranded.** A cold `/dietary-setup` shows
   *     the onboarding-flavoured form to a finished user (no `returnTo` in a URL, so
   *     `fromOnboarding` is true), its single Save button takes the branch that deliberately does
   *     not navigate, and a pushed screen covers the tab bar — so a route underneath gives that
   *     user nothing to tap either. That defect wants fixing where it lives.
   *
   * No document decides this either: PRD §10.5, PRD §12 and Plan §20's browser-back row are the
   * whole authority, and none of them mentions what a deep link should have beneath it.
   */
  config: {
    screens: {
      Splash: ROUTE_PATHS.Splash,
      Onboarding: ROUTE_PATHS.Onboarding,
      DietarySetup: ROUTE_PATHS.DietarySetup,
      Tabs: {
        initialRouteName: 'HomeTab',
        screens: {
          HomeTab: { screens: { Home: ROUTE_PATHS.Home } },
          ExploreTab: { screens: { Explore: ROUTE_PATHS.Explore } },
          AssistantTab: { screens: { Assistant: ROUTE_PATHS.Assistant } },
          SavedTab: { screens: { Saved: ROUTE_PATHS.Saved } },
          Settings: ROUTE_PATHS.Settings,
        },
      },
      MealForm: ROUTE_PATHS.MealForm,
      MealDetails: ROUTE_PATHS.MealDetails,
    },
  },
};
