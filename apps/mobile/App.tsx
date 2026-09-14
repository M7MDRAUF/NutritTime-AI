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
import { DataResetProvider } from './src/features/settings/DataResetProvider.js';
import { preferencesStore, selectPreferences } from './src/state/preferences/index.js';
import { onboardingStore } from './src/state/onboarding/index.js';
import { favoritesStore } from './src/state/favorites/index.js';
import { customMealsStore } from './src/state/customMeals/index.js';
import { uiStore } from './src/state/ui/index.js';

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
 *
 * **It takes no `fontsReady`, and that omission is R-44's fix** (T-22-02/T-22-03). See
 * `PhasedNavigation` below for the measurement; the short version is that this component must
 * only ever be reached with the boot phase already settled, because `NavigationContainer`
 * resolves the browser's URL **once**, at its first mount, against whatever routes the stack
 * below happens to be holding at that instant.
 */
function NavigationRoot({ phase }: { readonly phase: BootPhase }): ReactNode {
  const theme = useTheme();
  // Memoised because `NavigationContainer` re-renders the whole tree when `theme` changes
  // identity, and a fresh object every render would make that every render.
  const navigationTheme = useMemo(() => buildNavigationTheme(theme), [theme]);

  return (
    <NavigationContainer theme={navigationTheme} linking={linking}>
      {/*
        **The real boot phase (T-14-06), and nothing ANDed onto it.**

        `StorageProvider` supplies `onboarding` or `app` from what hydration actually found, and
        that is the only thing that may decide which screens exist. `hydrating` reaches this
        navigator from its own prop in the dom suite and from nowhere else in the running app:
        the hydration gate is `DataResetProvider`'s `fallback`, which renders INSTEAD of this
        whole subtree, so during the `multiGet` there is no navigator at all — strictly stronger
        than TSD §6.1's "the protected screens are not in the navigator".
      */}
      <RootNavigator phase={phase} />
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

/**
 * **The font gate sits ABOVE the navigation container, and that is R-44 (T-22-03).**
 *
 * It used to sit inside: this component rendered `NavigationRoot` unconditionally and the
 * container rendered `<RootNavigator phase={fontsReady ? phase : 'hydrating'} />`. So on the web
 * the container mounted while the root stack was still holding **only `Splash`** — hydration is a
 * synchronous `localStorage` read and `Font.loadAsync` is a network fetch, which makes the font
 * gate's win the *normal* cold-start ordering rather than a race that sometimes goes wrong.
 *
 * That is fatal for a deep link and for exactly one reason: `NavigationContainer` resolves the
 * URL **once**. `useLinking`'s `getInitialState` is a `useCallback` with an empty dependency
 * array, `useThenable` resolves it at the first mount, and the result is handed to
 * `BaseNavigationContainer` as `initialState` — an *initial* state, consumed once and never
 * recomputed. `StackRouter` then filters that state through its own `routeNames`, so with only
 * `Splash` declared the parsed `Tabs` route was discarded as unknown and the fallback pushed. The
 * URL was rewritten to `/home` a moment later, when the phase advanced and the container printed
 * the state it had actually kept.
 *
 * Returning the hydrating surface here instead holds the **container's mount**, not the phase, so
 * it mounts once with `phase` already `app` (or `onboarding`) and the URL is resolved against the
 * real route set. Every provider above stays mounted, so the `multiGet` and the font fetch still
 * overlap — this delays the navigator, not hydration.
 *
 * **Why not gate higher up, in `App`?** `HydratingSplash` calls `useTheme()`, and the *stored*
 * theme only exists below `ThemedNavigation`. Gating in `App` would show the font-wait splash in
 * `system` while the user had chosen dark — T-18-04's defect, reintroduced one level up.
 *
 * Note what this does NOT move: the hydration gate. `DataResetProvider`'s `fallback` still
 * replaces this entire subtree while the snapshot is in flight, so a protected screen cannot
 * render early (TSD §6.1). `fontsReady` is not a boot phase and never was — it is a reason to
 * hold the first paint, and `'hydrating'` was only ever standing in for it.
 */
function PhasedNavigation({ fontsReady }: { readonly fontsReady: boolean }): ReactNode {
  const onboarding = onboardingStore.useValue();
  const phase: BootPhase = onboarding.completed ? 'app' : 'onboarding';
  if (!fontsReady) {
    return <HydratingSplash />;
  }
  return <NavigationRoot phase={phase} />;
}

/**
 * The user's stored theme, applied (T-18-04).
 *
 * **There are deliberately two `ThemeProvider`s, and the nesting is forced rather than chosen.**
 * `themeMode` lives in the `preferences` store, which cannot exist above hydration — while
 * `SplashSurface`, the surface rendered *during* hydration, calls `useTheme()`. So one provider has
 * to sit outside the storage tree to theme the splash, and the mode it uses can only be `'system'`:
 * before hydration there is no stored preference, and `'system'` is the one honest default rather
 * than a guess at the user's answer. This inner provider then governs everything below it.
 *
 * The alternative was a second, unthemed splash surface, which would duplicate a tested screen in
 * order to avoid a provider — and would make the first frame of every cold start a different
 * design from the second.
 *
 * **Without this, T-18-04 was a control that changed nothing.** `App.tsx` hard-coded
 * `mode="system"`, so the Settings switch dispatched correctly, stored correctly, and moved no
 * pixel in the running app. `Settings.dom.test.tsx` could not have caught it: the screen was right
 * and the wiring above it was missing — the same shape as P14's boot-phase defect, which only the
 * first end-to-end run found.
 */
function ThemedNavigation({ fontsReady }: { readonly fontsReady: boolean }): ReactNode {
  const themeMode = selectPreferences(preferencesStore.useValue()).themeMode;
  return (
    <ThemeProvider mode={themeMode}>
      <ThemedStatusBar />
      <PhasedNavigation fontsReady={fontsReady} />
    </ThemeProvider>
  );
}

/**
 * The status bar, resolved from the theme the user chose rather than from the device.
 *
 * **It was `<StatusBar style="auto" />` above the themed provider, and T-18-04's switch moved every
 * pixel except this one.** `auto` resolves against the *device* colour scheme, so a user on a light
 * device who chose the dark theme got dark glyphs on a dark canvas — unreadable, and unreachable by
 * any screen test, because the defect lives in the composition rather than in a screen.
 *
 * It sits INSIDE the inner provider, which is the only place the resolved scheme exists. There is
 * deliberately just one: `expo-status-bar` applies its style from an effect, and child effects run
 * before parents', so an outer instance kept "for the hydrating window" would run last and win —
 * quietly restoring the bug. During hydration no explicit style is set, which is the same result
 * `auto` produced there anyway, since before hydration there is no stored preference to honour.
 *
 * `light`/`dark` name the GLYPHS, not the ground: a dark scheme needs light glyphs.
 */
function ThemedStatusBar(): ReactNode {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
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
      {/*
        The PRE-HYDRATION theme, and `"system"` here is a statement of fact rather than a default
        left behind: this provider exists to theme `SplashSurface`, which renders while the one
        `multiGet` is in flight, and at that moment the app has not yet read what the user chose.
        `ThemedNavigation` applies the stored `themeMode` the moment the store exists.
      */}
      <ThemeProvider mode="system">
        {/*
          Inside the theme and outside the navigator: a screen reads the client through context
          (`screenFor` passes only `route` and `navigation`, so there is no prop route in), and no
          request is made before a screen mounts. `baseUrl` is left to `DEFAULT_API_BASE_URL` —
          nothing in the bundle reads an environment variable.
        */}
        <ApiProvider>
          {/* The status bar is `ThemedStatusBar`, inside the themed provider — see its docstring
              for why there is exactly one and why it cannot live here. */}
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
          {/*
            **`DataResetProvider`, not `StorageProvider` directly** (T-18-06).

            It renders `StorageProvider` itself and owns the full reset: while a reset runs it
            renders the fallback INSTEAD of the storage tree, so every store below is unmounted and
            none can begin a write, then it clears the keys and verifies they stayed cleared. The
            fresh mount afterwards re-runs hydration, which is what returns the app to onboarding.

            **Every store provider must sit INSIDE it**, and that is not ordering taste. A store
            mounted above the reset boundary would survive the unmount holding the very data the
            user asked to destroy — the app would show onboarding while the favourites list, the
            custom meals and the allergy profile were all still in memory, ready to be written
            back. W7's verification reproduced that class: a write already in flight resurrected
            `{"diet":"vegetarian","allergies":["peanut"]}` after a confirmed wipe.
          */}
          <DataResetProvider fallback={<HydratingSplash />}>
            <preferencesStore.Provider>
              <onboardingStore.Provider>
                <favoritesStore.Provider>
                  <customMealsStore.Provider>
                    <uiStore.Provider>
                      <ThemedNavigation fontsReady={fontsReady} />
                    </uiStore.Provider>
                  </customMealsStore.Provider>
                </favoritesStore.Provider>
              </onboardingStore.Provider>
            </preferencesStore.Provider>
          </DataResetProvider>
        </ApiProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
