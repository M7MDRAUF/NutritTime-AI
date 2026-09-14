/**
 * The button (TSD 6.7).
 *
 * Four variants, one shape: `component.ts` gives every variant the same height, padding and
 * radius and varies only the fill, the label and the border, so a screen cannot accidentally
 * ship a secondary button that is a different size from the primary one beside it.
 *
 * Built to 48 on both axes from `button.minHeight`, which is `touch.buildTo` - PRD 10.5 (2.1.0)
 * via X-05: 44 pt iOS, 48 dp Android, 24 px web, and 48 satisfies all three.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export interface AccessibleButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly icon?: IconName;
  readonly fullWidth?: boolean;
  /** Defaults to `label`. Give one only when the visible label is not the whole story. */
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly testID?: string;
}

export function AccessibleButton({
  label,
  onPress,
  variant = 'secondary',
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: AccessibleButtonProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const button = components.button;
  const tokens = button[variant];

  // A loading button is inert, not merely slow: the press already happened and a second one
  // would submit twice. It stays unpressable AND announces `busy`, so a screen reader user is
  // told which of the two states it is in.
  const inactive = disabled || loading;
  const labelColor = inactive ? tokens.labelDisabled : tokens.label;

  // See `Chip`: ripple on Android, highlight everywhere else. `component.ts` says this in as
  // many words on the destructive variant - colour is not the only press affordance - and it is
  // the only affordance that variant has, because its pressed fill is its resting fill.
  const highlight = Platform.OS === 'android' ? undefined : colors.effect.highlight;

  return (
    <Pressable
      testID={testID}
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      // The aria-* alias alongside `accessibilityState`, for the reason given in `Chip`.
      aria-busy={loading}
      android_ripple={{ color: colors.effect.ripple }}
      style={({ pressed }) => ({
        // A row until the text is large enough that a row would squeeze the label into a sliver
        // beside the icon; then it becomes a column (PRD 10.5, `isLargeText`).
        flexDirection: isLargeText ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: button.gap,
        minHeight: button.minHeight,
        minWidth: button.minHeight,
        paddingHorizontal: button.paddingHorizontal,
        borderRadius: button.radius,
        borderWidth: tokens.borderWidth,
        borderColor: tokens.borderColor,
        backgroundColor: inactive
          ? tokens.backgroundDisabled
          : pressed
            ? tokens.backgroundPressed
            : tokens.background,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
        // So the press overlay stops at the button's own corners.
        overflow: 'hidden',
      })}
    >
      {({ pressed }) => (
        <>
          {pressed && !inactive && highlight !== undefined ? (
            <View aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: highlight }]} />
          ) : null}
          {loading ? (
            // The spinner replaces the icon, never the label: a button whose text disappears
            // while it works loses its accessible name at the moment the user is waiting on it.
            <ActivityIndicator size="small" color={labelColor} />
          ) : icon === undefined ? null : (
            <Icon name={icon} size={typography.bodyStrong.lineHeight} color={labelColor} />
          )}
          {/*
            Not `AppText`. The label colour is `button.primary.label` - a layer-3 decision - and
            `AppText`'s `tone` reaches only `semantic.ts`'s content roles. Restating that mapping
            here would leave the component token with no consumer to notice if it changed.
          */}
          <Text allowFontScaling={false} style={{ ...typography.bodyStrong, color: labelColor }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
