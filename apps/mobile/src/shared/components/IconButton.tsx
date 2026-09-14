/**
 * A button whose entire label is its icon (TSD 6.7).
 *
 * `accessibilityLabel` is REQUIRED here, which is the one place this batch tightens TSD 6.7's
 * signature rather than following it: an icon-only control without a label is unusable with a
 * screen reader, and leaving the prop optional means the compiler never says so.
 *
 * **No `hitSlop`, deliberately.** The box is built to `button.minHeight` - 48, `touch.buildTo` -
 * on both axes, so the visual target already meets PRD 10.5's 44 pt / 48 dp / 24 px (X-05) and
 * `hitSlop`, which is the tool for when a visual box is SMALLER than its target, has nothing to
 * make up. It is also invisible in the DOM, so a target that leaned on it could not be verified
 * by this suite at all. `size` shrinks the glyph and never the box.
 */

import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';

export interface IconButtonProps {
  readonly icon: IconName;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  /** The glyph, not the target. Defaults to the body line box. */
  readonly size?: number;
  readonly testID?: string;
}

export function IconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled = false,
  size,
  testID,
}: IconButtonProps): ReactNode {
  const { components, colors, typography } = useTheme();
  const button = components.button;
  // Ghost: an icon button sits in a header or a row and must not compete with the content it
  // acts on, which is what `component.ts` defines the ghost variant to be.
  const tokens = button.ghost;
  const glyphColor = disabled ? tokens.labelDisabled : tokens.label;
  const highlight = Platform.OS === 'android' ? undefined : colors.effect.highlight;

  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      android_ripple={{ color: colors.effect.ripple }}
      style={({ pressed }) => ({
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: button.minHeight,
        minWidth: button.minHeight,
        borderRadius: button.radius,
        backgroundColor: disabled
          ? tokens.backgroundDisabled
          : pressed
            ? tokens.backgroundPressed
            : tokens.background,
        overflow: 'hidden',
      })}
    >
      {({ pressed }) => (
        <>
          {pressed && !disabled && highlight !== undefined ? (
            <View aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: highlight }]} />
          ) : null}
          {/* Decorative: the button carries the name, and labelling both says it twice. */}
          <Icon name={icon} size={size ?? typography.body.lineHeight} color={glyphColor} />
        </>
      )}
    </Pressable>
  );
}
