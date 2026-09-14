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
      /**
       * The tint on an active tab and on a header's back affordance — both of which React
       * Navigation draws as **text**, which is why this is a `content` role and not an `accent`
       * one.
       *
       * It was `accent.brand`, and that shipped a live WCAG 1.4.3 failure: `accent.brand` is a
       * FILL colour, authored to be readable *under* `content.onBrand`, and light's `#059669` on
       * `card` (`surface.raised`, `#FFFFFF`) measures **3.77:1** against AA's 4.5:1 for normal
       * text. DECISIONS.md §3.1 already rejected exactly that pair — "white on the same green is
       * 3.77:1 and fails AA" — and the tab bar shipped it with the two roles swapped, which is
       * contrast-symmetric and therefore the identical ratio.
       *
       * `content.link` is the role this theme already means by "a navigable affordance rendered as
       * text": **7.68:1** in light (`#065F46` on `#FFFFFF`) and **10.72:1** in dark (`#6EE7B7` on
       * `#12231E`), and it is measured on all four surfaces in both schemes in `contrast.test.ts`.
       * `component-contrast.test.ts` reads this slot back out of this file and re-measures the
       * pair, so pointing it at a fill colour again fails there rather than on a device.
       */
      primary: colors.content.link,
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
