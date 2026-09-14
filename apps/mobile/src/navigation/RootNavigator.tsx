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
 */

import type { ReactNode } from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../shared/theme/ThemeProvider.js';
import { screenFor } from './registry.js';
import { TabNavigator } from './TabNavigator.js';
import type { BootPhase, RootParamList } from './routes.js';

const Stack = createNativeStackNavigator<RootParamList>();

export interface RootNavigatorProps {
  readonly phase: BootPhase;
}

export function RootNavigator({ phase }: RootNavigatorProps): ReactNode {
  const theme = useTheme();

  return (
    <Stack.Navigator
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
        <Stack.Group screenOptions={{ gestureEnabled: false }}>
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
              `returnTo`. Gestures stay on here: this visit is a detour, not a gate. */}
          <Stack.Screen name="DietarySetup" component={screenFor('DietarySetup')} />
        </>
      )}
    </Stack.Navigator>
  );
}
