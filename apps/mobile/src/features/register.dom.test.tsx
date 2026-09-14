/**
 * `registerScreens()` actually runs, and binds the right component to every route.
 *
 * **This file replaces one that could not fail, and the reason it could not is worth keeping.** The
 * first version read `register.ts` as *source text* and regex-matched `registerScreen('Name'`. That
 * answers "is the list complete?" — useful, and it is still asserted below — but never executes the
 * function, so a mutation audit gave `registerScreens()` an unconditional early `return`, dropping
 * **every screen in the app to `PlaceholderScreen`**, and all 2012 tests stayed green. A test that
 * reads a file cannot tell you the file's behaviour.
 *
 * It also could not catch a route bound to the *wrong* component, which is not hypothetical here:
 * `Home` must register `HomeScreenWithFocus` and not the bare `HomeScreen`, or the meal period stops
 * being re-read when the user returns to the tab — the exact defect P15 shipped and recorded.
 *
 * `screenFor` cannot answer either question, by design: it returns its stable wrapper whether or not
 * anything is registered behind it, which is what allows a feature to register late. So
 * `registry.tsx` gained `registeredScreen()` for this, and that is the whole reason it exists.
 *
 * A `.dom` test because it imports real screens, and therefore React Native. It renders nothing.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerScreens } from './register.js';
import { registeredScreen } from '../navigation/registry.js';
import { SCREEN_ROUTE_NAMES } from '../navigation/routes.js';
import { SplashSurface } from './onboarding/SplashSurface.js';
import { OnboardingScreen } from './onboarding/OnboardingScreen.js';
import { DietarySetupScreen } from './onboarding/DietarySetupScreen.js';
import { HomeScreen, HomeScreenWithFocus } from './home/HomeScreen.js';
import { ExploreScreen } from './catalog/ExploreScreen.js';
import { MealDetailsScreen } from './details/MealDetailsScreen.js';
import { SavedScreen } from './saved/SavedScreen.js';
import { MealFormScreen } from './saved/MealFormScreen.js';
import { SettingsScreen } from './settings/SettingsScreen.js';
import { AssistantScreen } from './assistant/AssistantScreen.js';

/**
 * Routes with no screen component, and why.
 *
 * The reason is part of the data, so the justification sits beside the exemption instead of being
 * something a reader has to trust once existed.
 *
 * **It is empty as of P21, and the emptiness is asserted below rather than left implicit.** That
 * matters because an empty record silently satisfies every `for` loop over it: the two tests that
 * iterate this list stopped making a claim the moment the last entry was removed, which is
 * failure shape 3 arriving as a consequence of finishing the work. `Assistant` was the final
 * exemption — "P19-P21 own the assistant; the route exists so the tab and the deep link resolve" —
 * and P21 registered it.
 *
 * A future route added without a screen belongs here **with a reason**, and the length check below
 * is what stops the reason being a placeholder.
 */
const UNREGISTERED: Readonly<Record<string, string>> = {};

/** What each route must bind. Written out, because "something is registered" is the weaker claim. */
const EXPECTED: Readonly<Record<string, unknown>> = {
  Assistant: AssistantScreen,
  Splash: SplashSurface,
  Onboarding: OnboardingScreen,
  DietarySetup: DietarySetupScreen,
  // The focus-aware wrapper, NOT the bare screen: the meal period has to be re-read when the user
  // comes back to this tab, and P15 shipped a frozen clock by getting exactly this wrong.
  Home: HomeScreenWithFocus,
  Explore: ExploreScreen,
  MealDetails: MealDetailsScreen,
  Saved: SavedScreen,
  MealForm: MealFormScreen,
  Settings: SettingsScreen,
};

const screenRoutes: readonly string[] = SCREEN_ROUTE_NAMES;

beforeAll(() => {
  // The thing under test. Vitest isolates module state per file, so this does not leak into
  // `registry.dom.test.tsx`, which asserts that an UNregistered route renders the placeholder.
  registerScreens();
});

describe('registerScreens', () => {
  it('actually registers a component for every route that is not exempt', () => {
    const missing = SCREEN_ROUTE_NAMES.filter(
      (route) => UNREGISTERED[route] === undefined && registeredScreen(route) === undefined,
    );

    // Named individually: "3 routes missing" sends the next person hunting.
    expect(missing, `routes with no registered screen: ${missing.join(', ')}`).toEqual([]);
  });

  it('binds the SPECIFIC component each route needs, not merely something', () => {
    for (const [route, component] of Object.entries(EXPECTED)) {
      expect(registeredScreen(route as never), route).toBe(component);
    }
  });

  it('does not register a route that is exempt', () => {
    for (const route of Object.keys(UNREGISTERED)) {
      expect(screenRoutes.includes(route), `${route} is not a real route`).toBe(true);
      expect(registeredScreen(route as never), `${route} is exempt but registered`).toBeUndefined();
    }
  });

  it('registers Home through the focus wrapper, which is a separate claim from registering Home', () => {
    /**
     * Kept as its own named assertion. The table above would catch it, but a reader who breaks this
     * should be told they have reintroduced P15's frozen clock rather than reading "1 route wrong".
     */
    expect(registeredScreen('Home')).toBe(HomeScreenWithFocus);
    expect(registeredScreen('Home')).not.toBe(HomeScreen);
  });

  it('registers Splash, which is the defect this file was first written for', () => {
    // `register.ts` left it out on a justification that was true of hydration and missed `App.tsx`'s
    // font gate, so a normal web cold start showed "Splash is not available yet".
    expect(registeredScreen('Splash')).toBe(SplashSurface);
  });

  it('keeps the exemption list honest in the source, not only at runtime', () => {
    /**
     * The one claim the runtime cannot make: that nothing registers a route which is **not** in the
     * route table. `registerScreen` is typed, so such a call is a compile error today — this guards
     * the day the table widens, and it is the surviving half of the original source-text test.
     */
    const source = fs.readFileSync(path.join(import.meta.dirname, 'register.ts'), 'utf8');
    const named = [...source.matchAll(/registerScreen\('([A-Za-z]+)'/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    expect(named.filter((route) => !screenRoutes.includes(route))).toEqual([]);
    expect(new Set(named).size, 'a route is registered twice').toBe(named.length);
    for (const reason of Object.values(UNREGISTERED)) {
      expect(reason.length).toBeGreaterThan(20);
    }

    /**
     * **Every route in the table now has a screen, so `PlaceholderScreen` is unreachable through
     * the app.**
     *
     * Asserted explicitly because the loop above no longer says anything: an empty record iterates
     * zero times and passes whatever the exemption list means. This is the claim the loop used to
     * carry, restated in a form that an emptied list cannot satisfy by accident — and it fails the
     * day a route is added without a screen, which is exactly when someone needs to be told.
     *
     * The placeholder itself stays: `registry.dom.test.tsx` still renders it to prove an
     * unregistered route degrades rather than throwing.
     */
    expect(Object.keys(UNREGISTERED)).toStrictEqual([]);
    expect(named.sort()).toStrictEqual([...screenRoutes].sort());
  });
});
