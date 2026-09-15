/**
 * The hydrating surface (TSD §6.1, PRD §8.1).
 *
 * Rendered by `StorageProvider`'s `fallback`, which is the only thing that can render during
 * `hydrating`: the navigator holding the `Splash` ROUTE lives inside the provider that is waiting,
 * so the route is reachable only once the phase has already advanced. This is the same screen by a
 * different mechanism, and it is why `Splash` stays in the route table — P22's web export and a
 * deep link both still need the route to exist.
 *
 * **The deep-link half of that is no longer true (P28).** `Splash` stays in the route table because
 * PRD §11 names it and `features/register.ts` keeps it registered as a deliberate guard — **no deep
 * link needs it.** `NON_LINKABLE_SCREENS` in `navigation/linking.ts` records the measurement: a cold
 * `/splash` that restored would leave the user on a surface with no controls and no way out.
 *
 * No spinner. Hydration is a local read that finishes in milliseconds, and a spinner visible for
 * one frame reads as a fault rather than as progress.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AppText } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';

export function SplashSurface(): ReactNode {
  const { colors, components } = useTheme();
  return (
    <View
      testID="splash-surface"
      accessibilityRole="alert"
      accessibilityLabel="Loading NutriTime"
      style={{
        alignItems: 'center',
        backgroundColor: colors.surface.canvas,
        flex: 1,
        gap: components.card.gap,
        justifyContent: 'center',
        padding: components.card.padding,
      }}
    >
      <AppText variant="display" tone="primary">
        NutriTime
      </AppText>
    </View>
  );
}
