/**
 * The theme at runtime (TSD 6.6, T-12-03).
 *
 * **`mode` is a PROP, not a global read.** The provider takes the user's stored preference and
 * the device scheme as parameters, so a screen test can render both schemes in one file without
 * mocking a module. A provider that read `useColorScheme()` internally would make every
 * appearance test a mocking exercise, and the dark palette - which P11 authored by hand rather
 * than deriving - would go untested in practice.
 *
 * The font scale is read, not ignored: PRD 10.5 requires the UI to hold at a 2x scale, so the
 * components need to know it rather than assume 1.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useColorScheme, useWindowDimensions, PixelRatio } from 'react-native';
import type { ThemeMode } from '@nutritime/contracts';
import { buildComponentTokens, colorsByScheme, resolveScheme } from './index.js';
import type { ColorScheme, ComponentTokens, SemanticTokens } from './index.js';

/** Beyond this the layout must reflow rather than shrink text (PRD 10.5). */
export const LARGE_TEXT_SCALE = 1.3;

export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: SemanticTokens;
  readonly components: ComponentTokens;
  /** The OS text-scaling factor, clamped to something a layout can survive. */
  readonly fontScale: number;
  /** True when text is large enough that a row should become a column. */
  readonly isLargeText: boolean;
}

/**
 * No default value.
 *
 * `undefined` and a `useContext` guard, rather than a light-theme default: a component rendered
 * outside the provider would otherwise silently get light tokens on a dark device, which is a
 * bug that looks like a styling mistake. Failing loudly names the real cause.
 */
const ThemeContext = createContext<Theme | undefined>(undefined);

export interface ThemeProviderProps {
  /** The user's stored preference. `system` defers to the device. */
  readonly mode: ThemeMode;
  /**
   * The device scheme, injected for tests. Defaults to the real hook, so production callers
   * pass only `mode`.
   */
  readonly deviceScheme?: ColorScheme | null;
  /** The text-scaling factor, injected for tests. */
  readonly fontScale?: number;
  readonly children: ReactNode;
}

export function ThemeProvider({
  mode,
  deviceScheme,
  fontScale,
  children,
}: ThemeProviderProps): ReactNode {
  const hookScheme = useColorScheme();
  // `useWindowDimensions` is the supported way to observe a font-scale change; `PixelRatio`
  // alone does not re-render when the user changes it in Settings while the app is open.
  const { fontScale: windowFontScale } = useWindowDimensions();

  const value = useMemo<Theme>(() => {
    // React Native's hook can also return `'unspecified'`, which `resolveScheme` does not
    // accept - and should not: "the device has no preference" is exactly what `null` means, and
    // widening `ColorScheme` to carry a third state would push the same branch into every
    // consumer.
    const raw = deviceScheme === undefined ? hookScheme : deviceScheme;
    const device: ColorScheme | null = raw === 'light' || raw === 'dark' ? raw : null;
    const scheme = resolveScheme(mode, device);
    const scale = fontScale ?? windowFontScale ?? PixelRatio.getFontScale();
    const colors = colorsByScheme[scheme];
    return {
      scheme,
      colors,
      components: buildComponentTokens(colors),
      fontScale: scale,
      isLargeText: scale >= LARGE_TEXT_SCALE,
    };
  }, [mode, deviceScheme, hookScheme, fontScale, windowFontScale]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === undefined) {
    throw new Error('useTheme was called outside a ThemeProvider');
  }
  return theme;
}
