/**
 * Our tokens, in the shape React Navigation paints with.
 *
 * React Navigation fills the gaps its own chrome owns — the surface behind a screen during a push
 * transition, the card behind a header, a focus tint — from `NavigationContainer`'s `theme` prop.
 * Left at its default, that chrome is a hard-coded light grey, which shows as a white flash behind
 * every dark-mode transition. This maps the same semantic tokens the rest of the app uses onto
 * those six slots, so there is one palette and not two.
 *
 * `fonts` is taken from React Navigation's own theme rather than ours: the type scale lives in
 * `primitive.ts`, which TSD §6.6 makes private to the theme directory, and the public `Theme`
 * exposes no font family. React Navigation's defaults are already the platform faces our typeface
 * falls back to, so borrowing them is the accurate answer as well as the only reachable one.
 */

import { DarkTheme, DefaultTheme } from '@react-navigation/native';
import type { Theme as NavigationTheme } from '@react-navigation/native';
import type { Theme } from '../shared/theme/ThemeProvider.js';

export function buildNavigationTheme(theme: Theme): NavigationTheme {
  const isDark = theme.scheme === 'dark';
  const { colors } = theme;

  return {
    dark: isDark,
    colors: {
      // The tint on an active tab and on a header's back affordance.
      primary: colors.accent.brand,
      background: colors.surface.canvas,
      // `card` is the header and tab-bar fill: raised, so the bar reads as above the canvas.
      card: colors.surface.raised,
      text: colors.content.primary,
      border: colors.border.subtle,
      // Badge fills. `status.danger` rather than an accent: a notification is a status.
      notification: colors.status.danger,
    },
    fonts: isDark ? DarkTheme.fonts : DefaultTheme.fonts,
  };
}
