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
 * `initialRouteName: 'HomeTab'` puts Home underneath a link that opens another tab, so a deep link
 * to `nutritime://settings` leaves the user somewhere to go back to rather than on a dead end.
 */
export const linking: LinkingOptions<RootParamList> = {
  prefixes: [LINKING_PREFIX],
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
