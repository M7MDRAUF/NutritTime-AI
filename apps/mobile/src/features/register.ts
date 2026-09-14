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

/**
 * Register every screen this build has.
 *
 * Idempotent: `registerScreen` returns early when the same component is registered twice, so
 * calling this from `App.tsx` and again from a test harness notifies no listener the second time.
 *
 * The routes that are not here yet render `PlaceholderScreen`, which is the registry working as
 * designed rather than a gap — P15 to P21 fill them in, and each one is a single line.
 */
export function registerScreens(): void {
  registerScreen('Onboarding', OnboardingScreen);
  registerScreen('DietarySetup', DietarySetupScreen);
  // The focus-aware wrapper, not the bare screen: the period has to be re-read when the user
  // comes back to this tab (M-6).
  registerScreen('Home', HomeScreenWithFocus);
  registerScreen('Explore', ExploreScreen);
}
