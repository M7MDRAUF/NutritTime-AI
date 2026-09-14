/**
 * First launch (T-14-03). PRD §8.1's first step.
 *
 * **It asks for nothing.** PRD §8.1 lists what the user sets — diet, allergies, goal, budget,
 * dislikes, meal times — and every one of those is `DietarySetupScreen`'s. This screen says what the
 * app is for and what it is not, and then gets out of the way.
 *
 * That second half is why it exists at all rather than dropping the user straight into a form. PRD
 * FR-007 requires a safety disclaimer, and the honest place for it is **before** someone enters an
 * allergy list — a disclaimer shown afterwards is a disclaimer shown too late to inform the
 * decision it is about.
 *
 * `name` is deliberately not asked for here either. It is the one optional field (S-20), and putting
 * it first would make the app feel like it needs an account.
 */

import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { AccessibleButton, AppText, Divider } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';

export function OnboardingScreen({ navigation }: ScreenProps<'Onboarding'>): ReactNode {
  const { colors, components } = useTheme();

  return (
    <ScrollView
      testID="onboarding-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{
        flexGrow: 1,
        gap: components.card.gap,
        justifyContent: 'center',
        padding: components.card.padding,
      }}
    >
      <AppText variant="display" tone="primary" level={1}>
        NutriTime
      </AppText>
      <AppText variant="subheading" tone="secondary">
        Meals that suit the time of day, your diet, and your budget.
      </AppText>

      <Divider />

      {/*
        FR-007, before the allergy list rather than after it. `status.warning` tone would make this
        look like an error; it is not an error, it is the single most important sentence on the
        screen, so it is body copy in a tone a user reads rather than dismisses.
      */}
      <View testID="onboarding-disclaimer" style={{ gap: components.card.gap }}>
        <AppText variant="bodyStrong" tone="primary">
          Before you start
        </AppText>
        <AppText variant="body" tone="secondary">
          This app filters meals using the allergy information you give it, and the catalog it
          filters is not complete or verified. It is not medical advice, and it cannot replace
          reading an ingredient label. If a mistake would be dangerous for you, check the label.
        </AppText>
      </View>

      <AccessibleButton
        testID="onboarding-continue"
        label="Set up my preferences"
        variant="primary"
        onPress={() => {
          // `navigate`, not `replace`: the onboarding group has gestures disabled (TSD §6.1), so
          // there is no swipe back to guard against, and leaving this screen on the stack means
          // the disclaimer is still reachable from setup rather than gone for good.
          navigation.navigate('DietarySetup', { returnTo: 'Onboarding' });
        }}
      />
    </ScrollView>
  );
}
