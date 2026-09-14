/**
 * The application root.
 *
 * Still deliberately thin: providers, the navigation container, and nothing else. The placeholder
 * tree that stood here until T-12-12 is gone — `RootNavigator` decides what renders, and it decides
 * it from the boot phase.
 *
 * Provider order is not arbitrary. `SafeAreaProvider` is outermost because the tab bar and every
 * header measure insets; `ThemeProvider` next because the navigation theme is built from its
 * tokens; `NavigationContainer` innermost because it is the first thing that paints.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { useFonts } from 'expo-font';
// **One import per face, not the package barrel, and the difference is 8.8 MB.**
//
// `from '@expo-google-fonts/inter'` re-exports all eighteen cuts, and Metro's asset pipeline
// follows every `require` it finds — so the first web export carried every weight and italic the
// family has, while `useFonts` loaded four of them. The comment below claimed the opposite, and the
// export proved it wrong. A subpath per face is the only thing that makes the claim true.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Inter_800ExtraBold } from '@expo-google-fonts/inter/800ExtraBold';
import { ThemeProvider, useTheme } from './src/shared/theme/ThemeProvider.js';
import { ApiProvider } from './src/infrastructure/api/ApiProvider.js';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import type { BootPhase } from './src/navigation/routes.js';
import { buildNavigationTheme } from './src/navigation/navigationTheme.js';
import { linking } from './src/navigation/linking.js';
import { registerScreens } from './src/features/register.js';
import { SplashSurface } from './src/features/onboarding/SplashSurface.js';
import { StorageProvider } from './src/state/StorageProvider.js';
import { preferencesStore } from './src/state/preferences/index.js';
import { onboardingStore } from './src/state/onboarding/index.js';

/**
 * The four faces the type scale actually names, and no more.
 *
 * `typeFamily` maps each of `typeScale`'s weights — 400, 600, 700, 800 — to one loaded face,
 * because React Native does not synthesise a weight for a custom family. The other fourteen cuts
 * would be bytes nothing can reference: a variant that is not in the scale cannot be selected,
 * since `AppText` takes a variant name and never a raw size or weight.
 *
 * **Measured, because the first version of this comment was wrong.** Importing the four names from
 * the package barrel still bundled all eighteen faces — `expo export` wrote an 8.8 MB `dist` — since
 * the barrel `require`s every `.ttf` and Metro follows each one. Four subpath imports, and only the
 * four faces ship.
 */
const FONTS = {
  Inter_400Regular,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
};

/**
 * Split from `App` only so it can call `useTheme()` — a hook cannot read a provider its own
 * component renders.
 */
function NavigationRoot({
  fontsReady,
  phase,
}: {
  readonly fontsReady: boolean;
  readonly phase: BootPhase;
}): ReactNode {
  const theme = useTheme();
  // Memoised because `NavigationContainer` re-renders the whole tree when `theme` changes
  // identity, and a fresh object every render would make that every render.
  const navigationTheme = useMemo(() => buildNavigationTheme(theme), [theme]);

  return (
    <NavigationContainer theme={navigationTheme} linking={linking}>
      {/*
        **The real boot phase (T-14-06), ANDed with the font gate.**

        `StorageProvider` supplies `onboarding` or `app` from what hydration actually found; the
        font gate holds it at `hydrating` until the faces resolve. Both have to be satisfied,
        because `hydrating` is the one phase in which the protected screens are not in the
        navigator at all — which is what makes FR-001's guarantee structural rather than a
        redirect over a mounted tree.
      */}
      <RootNavigator phase={fontsReady ? phase : 'hydrating'} />
    </NavigationContainer>
  );
}

/**
 * Registration happens at module scope, once, before anything renders.
 *
 * Not in an effect: `RootNavigator` asks `screenFor('Explore')` during its first render, and a
 * registration that ran afterwards would paint the placeholder and then swap it — a visible flash
 * on every cold start. The registry handles late registration correctly (that is what
 * `useSyncExternalStore` is for, and P12 tests it), but correct-and-flickering is still worse than
 * simply being registered in time.
 */
registerScreens();

/**
 * The boot phase, derived from the LIVE onboarding store.
 *
 * **This used to read the hydration snapshot, and the first end-to-end run found out why that was
 * wrong.** A snapshot is read once at boot and never updated, so dispatching `onboarding/completed`
 * moved the store and left the phase behind: pressing Save at the end of setup did nothing visible
 * until the app was restarted. Two specs failed on it — "completes the journey and lands in the
 * app" and "the choices survive a reload" — and no dom test had covered it, because none of them
 * renders the navigator.
 *
 * So the phase is computed here, inside the store's provider, from the value that changes.
 *
 * An `unavailable` onboarding key means the store was created from its fallback, `completed:
 * false` — which is the conservative reading, and the right one: showing setup to someone who has
 * already done it costs them a few taps, while skipping it for someone who has not leaves the app
 * with no diet, no allergies and no meal times.
 */
/**
 * What renders while the one `multiGet` is in flight.
 *
 * The navigator cannot be used for it — it lives inside `StorageProvider`, which is what is waiting
 * — so this is the phase's own surface. Deliberately the minimum: a coloured ground and the app's
 * name, with no spinner, because hydration is a local read that finishes in milliseconds and a
 * spinner that flashes for one frame reads as a fault.
 */
function HydratingSplash(): ReactNode {
  return <SplashSurface />;
}

function PhasedNavigation({ fontsReady }: { readonly fontsReady: boolean }): ReactNode {
  const onboarding = onboardingStore.useValue();
  const phase: BootPhase = onboarding.completed ? 'app' : 'onboarding';
  return <NavigationRoot fontsReady={fontsReady} phase={phase} />;
}

export default function App(): ReactNode {
  const [fontsLoaded, fontError] = useFonts(FONTS);

  /**
   * **A font that fails to load must not brick the app.**
   *
   * `useFonts` reports an error rather than throwing, and gating on `fontsLoaded` alone would hold
   * the splash forever on a device where the load failed — a blank screen with no way out, caused
   * by a typeface. Advancing on either outcome degrades to the platform face, which is exactly what
   * shipped before Inter existed here (R-32) and is a legible app rather than a dead one.
   */
  const fontsReady = fontsLoaded || fontError !== null;

  return (
    <SafeAreaProvider>
      {/* `mode` is hard-coded until the preferences store hydrates at T-14-06. */}
      <ThemeProvider mode="system">
        {/*
          Inside the theme and outside the navigator: a screen reads the client through context
          (`screenFor` passes only `route` and `navigation`, so there is no prop route in), and no
          request is made before a screen mounts. `baseUrl` is left to `DEFAULT_API_BASE_URL` —
          nothing in the bundle reads an environment variable.
        */}
        <ApiProvider>
          <StatusBar style="auto" />
          {/*
            Hydration once, above the stores, because TSD §6.1 requires ONE `multiGet` across all
            six keys — not one per store. Each store then creates itself from its own slice.

            The store providers sit inside it and outside the navigator: a screen in any phase can
            read preferences, and the `preferences` store is what `DietarySetupScreen` writes during
            `onboarding`, before the app phase exists.
          */}
          {/*
            `fallback` is `Splash`, and without it this phase was unreachable: `StorageProvider`
            rendered NOTHING until the snapshot resolved, and the navigator that holds `Splash` is
            inside it. So `hydrating` only ever came from the font gate, while PRD §8.1 opens
            "Splash hydrates persisted state" and TSD §6.1 ties the phase to the `multiGet`.
            FR-001's guarantee was stronger than specified rather than weaker — nothing rendered at
            all — but the screen the document names never appeared.
          */}
          <StorageProvider fallback={<HydratingSplash />}>
            <preferencesStore.Provider>
              <onboardingStore.Provider>
                <PhasedNavigation fontsReady={fontsReady} />
              </onboardingStore.Provider>
            </preferencesStore.Provider>
          </StorageProvider>
        </ApiProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
