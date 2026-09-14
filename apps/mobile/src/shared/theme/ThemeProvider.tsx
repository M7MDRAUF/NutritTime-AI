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
// The one legal importer of `primitive.js` outside the token modules themselves: this file IS
// inside the theme directory, and applying the scale is exactly what it is for.
import { typeFamily, typeScale } from './primitive.js';

/** Beyond this the layout must reflow rather than shrink text (PRD 10.5). */
export const LARGE_TEXT_SCALE = 1.3;

export type TypeVariant = keyof typeof typeScale;

export interface TextTokens {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: '400' | '600' | '700' | '800';
  readonly letterSpacing: number;
  /** TSD 6.6 fixes `label` as uppercase. Carried here so no consumer re-decides it. */
  readonly textTransform: 'none' | 'uppercase';
}

export type Typography = Readonly<Record<TypeVariant, TextTokens>>;

export interface Theme {
  readonly scheme: ColorScheme;
  readonly colors: SemanticTokens;
  readonly components: ComponentTokens;
  /**
   * The type scale with the OS font scale ALREADY APPLIED.
   *
   * DECISIONS.md S-09 assigns this multiplication to `useTheme()`, and until it existed every
   * label in the component batches had no legal source for its size: the scale lives in
   * `primitive.ts`, which is private to this directory, and the semantic and component tokens
   * are colour and geometry only. A component agent stopped rather than invent literals, which
   * is the correct outcome and is why this is here.
   *
   * **Because the scale is pre-multiplied, every `Text` must set `allowFontScaling={false}`.**
   * React Native would otherwise apply the OS factor a second time and a 2x setting would
   * render 4x. That is the direct cost of putting the multiplication here rather than in each
   * component, and it is worth it: one place decides, and a screen cannot forget to scale.
   */
  readonly typography: Typography;
  /** The OS text-scaling factor, for anything that must size itself against the text. */
  readonly fontScale: number;
  /** True when text is large enough that a row should become a column. */
  readonly isLargeText: boolean;
}

/**
 * One variant, scaled.
 *
 * `letterSpacing` scales too, which is easy to miss: React Native measures it in points and it
 * does not track the font scale on its own, so leaving `-0.5` fixed while the body grows to
 * 32 px visibly loosens a headline exactly when it is largest.
 */
function scaleVariant(variant: TypeVariant, scale: number): TextTokens {
  const step = typeScale[variant];
  return {
    // The face is chosen BY THE WEIGHT, because React Native does not synthesise weights for a
    // custom family. `typeScale`'s `fontWeight` and `typeFamily`'s keys are the same four string
    // literals, so this index is total and needs no fallback.
    fontFamily: typeFamily[step.fontWeight],
    fontSize: step.fontSize * scale,
    lineHeight: step.lineHeight * scale,
    fontWeight: step.fontWeight,
    letterSpacing: step.letterSpacing * scale,
    // `label` is the only uppercase variant (TSD 6.6: 700 uppercase at +1 tracking). The scale
    // carries the weight and the tracking but not the transform, so it is decided once here
    // rather than at eight call sites.
    textTransform: variant === 'label' ? 'uppercase' : 'none',
  };
}

/**
 * Written out key by key rather than reduced over `Object.entries`.
 *
 * A mapped reduce under `noUncheckedIndexedAccess` needs a cast or a non-null assertion to
 * satisfy `Record<TypeVariant, TextTokens>`, and this project forbids both. Eight lines that
 * typecheck beat four that need an escape hatch.
 */
function buildTypography(scale: number): Typography {
  return {
    display: scaleVariant('display', scale),
    headline: scaleVariant('headline', scale),
    title: scaleVariant('title', scale),
    subheading: scaleVariant('subheading', scale),
    body: scaleVariant('body', scale),
    bodyStrong: scaleVariant('bodyStrong', scale),
    caption: scaleVariant('caption', scale),
    label: scaleVariant('label', scale),
  };
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
      typography: buildTypography(scale),
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
