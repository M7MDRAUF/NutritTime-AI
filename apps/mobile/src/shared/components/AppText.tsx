/**
 * The one text primitive (TSD 6.7).
 *
 * Every string the user reads goes through here, which is what makes "no font size literal in
 * feature code" enforceable rather than aspirational: a screen picks a `variant` and a `tone`,
 * and the numbers behind both come from `useTheme()`.
 *
 * **`allowFontScaling` is off, and that is not an accessibility regression - it is the opposite.**
 * `theme.typography` is the type scale with the OS font scale ALREADY multiplied in
 * (DECISIONS.md S-09 puts that multiplication in `useTheme()`). React Native's own scaling would
 * apply the same factor a second time, so a user at 2x would get 4x and PRD 10.5's "scales
 * without clipping" would fail at exactly the setting it exists to protect. One place scales;
 * this is the switch that stops the second one.
 */

import type { ReactNode } from 'react';
import { Text } from 'react-native';
import type { TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';
import type { TypeVariant } from '../theme/ThemeProvider.js';
import type { SemanticTokens } from '../theme/index.js';

/**
 * Every role `semantic.ts` publishes, and nothing else.
 *
 * Derived from the token map rather than listed, so a role added to `content` is available here
 * the day it lands and a role removed stops compiling at its call sites.
 */
export type TextTone = keyof SemanticTokens['content'];

export type TextAlign = 'auto' | 'left' | 'right' | 'center';

/** Six, because that is how many heading levels the accessibility model has. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface AppTextProps {
  readonly variant?: TypeVariant;
  readonly tone?: TextTone;
  /** Lines the digits up in a column. Off by default: proportional figures read better in prose. */
  readonly numeric?: boolean;
  /** Marks this text as a heading. See the note on `accessibilityRole` below. */
  readonly level?: HeadingLevel;
  readonly align?: TextAlign;
  readonly testID?: string;
  readonly children: ReactNode;
}

export function AppText({
  variant = 'body',
  tone = 'primary',
  numeric = false,
  level,
  align = 'auto',
  testID,
  children,
}: AppTextProps): ReactNode {
  const { typography, colors } = useTheme();
  const step = typography[variant];

  // Spreading the token gives family, size, line height, weight, tracking and transform in one
  // move - `TextTokens` was shaped to be exactly a text style, so there is no field-by-field
  // copy here to fall out of date.
  const base: TextStyle = {
    ...step,
    color: colors.content[tone],
    textAlign: align,
  };
  const style: TextStyle = numeric ? { ...base, fontVariant: ['tabular-nums'] } : base;

  return (
    <Text
      testID={testID}
      allowFontScaling={false}
      // React Native 0.86 has no heading-LEVEL prop - `aria-level` is absent from its
      // accessibility types, and react-native-web renders every `header` role as an `h1`. So
      // `level` marks the text as a heading on all three platforms and the depth reaches none
      // of them. The prop is kept because TSD 6.7 fixes it and because the depth is real
      // information the web surface (P22) should eventually carry; see the phase report.
      accessibilityRole={level === undefined ? undefined : 'header'}
      style={style}
    >
      {children}
    </Text>
  );
}
