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
import {
  useFonts,
  Inter_400Regular,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import { ThemeProvider, useTheme } from './src/shared/theme/ThemeProvider.js';
import { RootNavigator } from './src/navigation/RootNavigator.js';
import { buildNavigationTheme } from './src/navigation/navigationTheme.js';
import { linking } from './src/navigation/linking.js';

/**
 * The four faces the type scale actually names, and no more.
 *
 * `typeFamily` maps each of `typeScale`'s weights — 400, 600, 700, 800 — to one loaded face,
 * because React Native does not synthesise a weight for a custom family. Loading the other fourteen
 * Inter cuts would ship bytes nothing can reference: a variant that is not in the scale cannot be
 * selected, since `AppText` takes a variant name and never a raw size or weight.
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
function NavigationRoot({ fontsReady }: { readonly fontsReady: boolean }): ReactNode {
  const theme = useTheme();
  // Memoised because `NavigationContainer` re-renders the whole tree when `theme` changes
  // identity, and a fresh object every render would make that every render.
  const navigationTheme = useMemo(() => buildNavigationTheme(theme), [theme]);

  return (
    <NavigationContainer theme={navigationTheme} linking={linking}>
      {/*
        `hydrating` until the fonts resolve, then `app`. T-14-06 replaces the second half of this
        with the real phase, derived from storage hydration and the onboarding store (TSD §6.1);
        the font gate stays and is ANDed with it. `app` rather than a third state because P12's own
        verification is that an empty Home renders in both themes.
      */}
      <RootNavigator phase={fontsReady ? 'app' : 'hydrating'} />
    </NavigationContainer>
  );
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
        <StatusBar style="auto" />
        <NavigationRoot fontsReady={fontsReady} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
