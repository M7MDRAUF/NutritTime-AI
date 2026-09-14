/**
 * Where every feature's screen is registered, and the only module imported for its side effects.
 *
 * **TSD §1387 fixes half of this and leaves the other half open.** It says "features register their
 * screens; `navigation/` never imports `features/`", which is what keeps the navigation layer from
 * depending on every feature in the app — but it never says *who calls `registerScreen`*. Three
 * shapes would satisfy the rule:
 *
 *  1. each screen module calls `registerScreen` at its own top level, and something imports them;
 *  2. `App.tsx` imports every screen and registers them itself;
 *  3. this — one barrel that does the registering, imported once for effect.
 *
 * (1) hides a side effect inside a module a test might import for its component, and makes the
 * registration order depend on import order. (2) puts a growing list of feature imports in the
 * application root, which is the dependency the rule exists to prevent, just moved up a level.
 * (3) keeps `App.tsx` at one import, keeps `navigation/` clean, and puts the whole answer to "what
 * is registered?" in one readable file. Recorded as a proposed S-row.
 *
 * **Imported for its side effect, which is why it exports a function rather than running at import
 * time.** A bare top-level `registerScreen(...)` in this file would fire whenever any module
 * reached it, including a test that wanted the registry empty — and P12's registry test asserts
 * that an unregistered route renders the placeholder, which a stray import could silently break.
 * An explicit `registerScreens()` is a side effect the caller chose.
 */

import { registerScreen } from '../navigation/registry.js';
import { ExploreScreen } from './catalog/ExploreScreen.js';
import { HomeScreenWithFocus } from './home/HomeScreen.js';
import { OnboardingScreen } from './onboarding/OnboardingScreen.js';
import { DietarySetupScreen } from './onboarding/DietarySetupScreen.js';
import { SplashSurface } from './onboarding/SplashSurface.js';
import { MealDetailsScreen } from './details/MealDetailsScreen.js';
import { SavedScreen } from './saved/SavedScreen.js';
import { MealFormScreen } from './saved/MealFormScreen.js';
import { SettingsScreen } from './settings/SettingsScreen.js';

/**
 * Register every screen this build has.
 *
 * Idempotent: `registerScreen` returns early when the same component is registered twice, so
 * calling this from `App.tsx` and again from a test harness notifies no listener the second time.
 *
 * After P16–P18 the only unregistered route is **`Assistant`**, which P19–P21 own.
 *
 * **`Splash` used to be left out on a justification that was wrong, and users saw it.** This
 * docstring previously claimed the route was "unreachable until the phase has already advanced",
 * because the surface shown during hydration is `StorageProvider`'s `fallback`. That is true of
 * hydration and misses the **second** gate: `App.tsx` renders
 * `phase={fontsReady ? phase : 'hydrating'}`, so once hydration resolves and the fonts have not,
 * the navigator really does render the `hydrating` phase — and `screenFor('Splash')` fell through
 * to `PlaceholderScreen`. On web the fonts are a network fetch while hydration is a `localStorage`
 * read, which makes that **the normal cold-start ordering**, not an edge case: the first thing a
 * user saw was "Splash is not available yet".
 *
 * `RootNavigator.dom.test.tsx` asserted that placeholder, so the suite documented the state rather
 * than catching it — a test can only be evidence about what someone thought to claim.
 */
export function registerScreens(): void {
  /**
   * `SplashSurface` takes no props, which makes it assignable to `ScreenComponent<'Splash'>`
   * directly — a component that ignores its props satisfies one that receives them. So the same
   * surface serves both routes to it: `StorageProvider`'s `fallback` during the `multiGet`, and
   * this route while the font gate holds the phase at `hydrating`.
   */
  registerScreen('Splash', SplashSurface);
  registerScreen('Onboarding', OnboardingScreen);
  registerScreen('DietarySetup', DietarySetupScreen);
  // The focus-aware wrapper, not the bare screen: the period has to be re-read when the user
  // comes back to this tab (M-6).
  registerScreen('Home', HomeScreenWithFocus);
  registerScreen('Explore', ExploreScreen);
  // P16. On the root stack and presented modally, reachable from four origins — which is why
  // `MealDetailsParams` carries `origin` rather than the tab implying it.
  registerScreen('MealDetails', MealDetailsScreen);
  // P17. `Saved` is a tab; `MealForm` is on the root stack, so `navigate('MealForm', …)` from
  // Saved PUSHES it and `goBack()` returns to the list — which is the only exit the form has.
  registerScreen('Saved', SavedScreen);
  registerScreen('MealForm', MealFormScreen);
  // P18. A tab, not a stack: TSD §6.2 declares four `*Tab` containers and no fifth, and nothing
  // in Settings pushes a second screen — it navigates to `DietarySetup` on the root stack.
  registerScreen('Settings', SettingsScreen);
}
