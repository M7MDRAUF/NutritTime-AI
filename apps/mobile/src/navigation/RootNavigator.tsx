/**
 * The root stack and the three boot phases (TSD §6.1, §6.2 — T-12-12).
 *
 * **The phase decides which screens exist, not which screen is focused.** Each branch below
 * renders a different set of `Stack.Screen` children, so during `hydrating` there is no `Tabs`
 * route to navigate to and no `MealDetails` to deep-link into — a protected screen cannot render
 * early because it is not in the navigator at all. A mounted tree with a redirect on top would
 * give the opposite guarantee: the screen mounts, reads state that has not arrived, and the
 * redirect wins a race it is not guaranteed to win. TSD §6.1 says this in as many words.
 *
 * `phase` is a **prop**, on the same reasoning as `ThemeProvider`'s `mode`: the store that decides
 * it (`onboarding`, T-14-02) does not exist yet, this task may not import `infrastructure/`, and a
 * navigator that read the phase internally would make every navigation test a mocking exercise.
 * T-14-06 supplies the real value.
 *
 * `MealDetails`, `MealForm` and `DietarySetup` sit on this stack rather than inside a tab. TSD
 * §6.1 calls the `app` phase "the tab navigator plus the stack screens", and the params corroborate
 * it: `MealDetailsParams.origin` exists precisely because one `MealDetails` is reached from four
 * tabs. Copies inside each tab's stack would make the origin implicit and the param dead.
 *
 * **The `main` landmark lives here too (R-77).** `ScreenLandmark` below says why it is this file
 * and why it is gated on focus.
 */

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../shared/theme/ThemeProvider.js';
import { screenFor } from './registry.js';
import { TabNavigator } from './TabNavigator.js';
import type { BootPhase, RootParamList } from './routes.js';

const Stack = createNativeStackNavigator<RootParamList>();

const styles = StyleSheet.create({
  /**
   * `screenLayout` inserts this box between native-stack's screen container and the screen, so it
   * has to fill its parent the way the screen it replaces did. `flex: 1` and nothing else: any
   * padding, background or margin here would be a visual change rather than a semantic one.
   */
  landmark: { flex: 1 },
});

/**
 * The one `main` landmark the web export exposes — `Plan.md` §20's `Semantic HTML` row asks for
 * exactly that wording, "the app exposes one `main` landmark", and the P28 audit ruled it NOT MET
 * because the built export contained zero `role="main"`.
 *
 * **`role`, not `accessibilityRole`, and that is a type constraint rather than a preference.**
 * React Native 0.86.3's `AccessibilityRole` union
 * (`react-native/Libraries/Components/View/ViewAccessibility.d.ts`) has thirty members and `main`
 * is not among them; the `Role` union in the same file does list it, and `ViewProps.role` takes
 * `Role`. So `accessibilityRole="main"` — which is how R-77's own resolution column proposes the
 * fix — does not typecheck, and react-native-web reads `role` first anyway:
 * `propsToAriaRole.js`'s `var _role = role || accessibilityRole`.
 *
 * **What react-native-web 0.21.2 actually does with it, read from the shipped source rather than
 * assumed** — BRIEF §6.1j, because three claims about this library were false in one window.
 * `modules/AccessibilityUtil/propsToAriaRole.js` holds `accessibilityRoleToWebRole`, and that map
 * is a **rename-and-suppress table, not an allow-list**: line 29 looks the role up, line 30 lets
 * anything through that is not explicitly `null`, and line 32 returns `inferredRole || _role`, so
 * a role the map has never heard of passes through verbatim. `main` is not in the map and reaches
 * the DOM unchanged. `modules/AccessibilityUtil/propsToAccessibilityComponent.js` then maps the
 * resolved role to an element — `main: 'main'` on line 26 — and `exports/createElement/index.js`
 * line 20 uses that in place of the `div` `View` asked for. The measured output is
 * `<main role="main">`: the element and the attribute, not one or the other.
 *
 * **Why it is gated on `useIsFocused`, which is the part a presence assertion would miss.** A
 * native stack keeps every screen below the top one mounted. An ungated `screenLayout` therefore
 * emits one landmark per *mounted* route, and the measured counts are 1 at rest, **2** with
 * `MealDetails` pushed over the tabs and **3** with `MealForm` above that — several `main`s, which
 * is a worse document than none. Gated, the count is 1 in every state measured.
 *
 * **What it encloses, and the one thing it does not exclude.** On every stack route except `Tabs`
 * it wraps exactly the screen. On `Tabs` it also encloses the tab bar, because
 * `@react-navigation/bottom-tabs` renders the tab bar and the screen area as siblings *inside*
 * the `Tabs` screen — so no wrapper reachable from this file can separate them. Excluding the tab
 * bar as well needs a second `screenLayout` on `Tabs.Navigator` in `TabNavigator.tsx`, which is
 * recorded rather than done here.
 */
function ScreenLandmark({ children }: { readonly children: ReactNode }): ReactNode {
  const focused = useIsFocused();

  // `undefined` rather than a second element shape: `View` is the same component in both cases, so
  // React changes a prop instead of unmounting and remounting the screen underneath it.
  return (
    <View role={focused ? 'main' : undefined} style={styles.landmark}>
      {children}
    </View>
  );
}

export interface RootNavigatorProps {
  readonly phase: BootPhase;
}

export function RootNavigator({ phase }: RootNavigatorProps): ReactNode {
  const theme = useTheme();

  return (
    <Stack.Navigator
      // One landmark per screen rather than one around the navigator: a wrapper outside
      // `Stack.Navigator` is a single `main` too, but it is the whole viewport in every state and
      // never names the screen the user is on, which is not a skip target. See `ScreenLandmark`.
      screenLayout={({ children }) => <ScreenLandmark>{children}</ScreenLandmark>}
      screenOptions={{
        headerShown: false,
        // The canvas behind a screen mid-transition. Without it React Navigation's own default
        // shows through, which is the white flash a dark-mode push otherwise produces.
        contentStyle: { backgroundColor: theme.colors.surface.canvas },
      }}
    >
      {phase === 'hydrating' ? (
        // One screen, and nothing else registered: PRD FR-001's "only Splash".
        <Stack.Screen name="Splash" component={screenFor('Splash')} />
      ) : phase === 'onboarding' ? (
        // Gestures off (TSD §6.1): onboarding is a sequence with a validated end, and a swipe
        // back out of dietary setup would land the user in the app with no preferences stored.
        /**
         * `navigationKey` is load-bearing, and P14's first end-to-end run is what proved it.
         *
         * **`DietarySetup` exists in BOTH this phase and the next one** — it is a gate during
         * onboarding and a detour from Settings afterwards. Without distinct keys, React Navigation
         * sees the same route name on both sides of the phase change and KEEPS it in the stack: so
         * completing onboarding advanced the phase, wrote `{completed: true}`, swapped the screen
         * set — and left the user looking at the setup form they had just finished.
         *
         * The keys make the two declarations different screens, so the onboarding route is dropped
         * from navigation state when the phase advances. That is TSD §6.1's "the phase determines
         * which screens exist" holding from the other direction: a route that survives the change
         * is a redirect-on-a-mounted-tree wearing a different hat.
         */
        <Stack.Group navigationKey="onboarding" screenOptions={{ gestureEnabled: false }}>
          <Stack.Screen name="Onboarding" component={screenFor('Onboarding')} />
          <Stack.Screen name="DietarySetup" component={screenFor('DietarySetup')} />
        </Stack.Group>
      ) : (
        <>
          <Stack.Screen name="Tabs" component={TabNavigator} />
          <Stack.Screen
            name="MealDetails"
            component={screenFor('MealDetails')}
            // TSD §6.2: "MealDetails presents modally." A detail view opened from a list is a
            // look, not a departure — dismissing it returns to the list the user was reading.
            options={{ presentation: 'modal' }}
          />
          <Stack.Screen name="MealForm" component={screenFor('MealForm')} />
          {/* Reachable again from Settings, which is why `DietarySetupParams` carries
              `returnTo`. Gestures stay on here: this visit is a detour, not a gate.

              `navigationKey="app"` pairs with the onboarding group's key above — see the note
              there for why the two must differ. */}
          <Stack.Screen
            name="DietarySetup"
            navigationKey="app"
            component={screenFor('DietarySetup')}
          />
        </>
      )}
    </Stack.Navigator>
  );
}
