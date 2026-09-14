/**
 * A filter or selection chip (TSD 6.7).
 *
 * Built to 48 on both axes. PRD 10.5 (2.1.0) via conflict X-05 sets 44 pt on iOS, 48 dp on
 * Android and 24 px on the web, and names 48 as the single value that satisfies all three; the
 * number is never written here, it is `chip.minHeight`, which `component.ts` derives from
 * `touch.buildTo`. `minWidth` matches it because a one-character chip is otherwise 48 tall and
 * 20 wide, which meets the requirement on the axis nobody misses.
 */

import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';

export interface ChipProps {
  readonly label: string;
  readonly selected?: boolean;
  /** Makes the chip a two-state control rather than a button that happens to look selected. */
  readonly toggle?: boolean;
  readonly onPress?: () => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

export function Chip({
  label,
  selected = false,
  toggle = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  testID,
}: ChipProps): ReactNode {
  const { components, colors, typography } = useTheme();
  const chip = components.chip;

  const background = disabled
    ? chip.backgroundDisabled
    : selected
      ? chip.backgroundSelected
      : chip.background;
  const labelColor = disabled ? chip.labelDisabled : selected ? chip.labelSelected : chip.label;
  const borderColor = selected ? chip.borderColorSelected : chip.borderColor;

  // `effect.ripple` is Android's press affordance and `effect.highlight` is iOS's - semantic.ts
  // names them exactly that. Drawing both on Android would stack two effects, so the overlay is
  // suppressed on the platform that already draws a ripple. The `chip` group has no
  // `backgroundPressed` of its own, so without this a chip would have no press feedback at all
  // on iOS or on the web; see the phase report.
  const highlight = Platform.OS === 'android' ? undefined : colors.effect.highlight;

  return (
    <Pressable
      testID={testID}
      // Gated here as well as through `disabled`. React Native honours the prop, but a
      // `checkbox` role renders as a plain element on the web rather than a `<button>`, and a
      // plain element has no native "disabled means no click" behaviour to inherit.
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole={toggle ? 'checkbox' : 'button'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={toggle ? { disabled, checked: selected } : { disabled, selected }}
      // Both forms, deliberately. `accessibilityState` is what iOS and Android read;
      // react-native-web 0.21 maps none of it (verified against the rendered DOM), and the
      // aria-* props are React Native's own aliases for the same state, so the web export and
      // the tests can see what the phone announces.
      aria-checked={toggle ? selected : undefined}
      // `aria-selected` is outside ARIA's allowed set for a button - `aria-pressed` is the
      // correct attribute there, and React Native 0.86 exposes neither it nor an
      // `accessibilityState.pressed` to carry it. So a chip with a real on/off state should pass
      // `toggle` and be a checkbox; `selected` without `toggle` is a chip that merely LOOKS
      // active, and the check glyph is what says so on every platform.
      aria-selected={toggle ? undefined : selected}
      android_ripple={{ color: colors.effect.ripple }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: chip.gap,
        minHeight: chip.minHeight,
        minWidth: chip.minHeight,
        paddingHorizontal: chip.paddingHorizontal,
        borderRadius: chip.radius,
        borderWidth: chip.borderWidth,
        borderColor,
        backgroundColor: background,
        // So the press overlay stops at the pill's edge.
        overflow: 'hidden',
      }}
    >
      {({ pressed }) => (
        <>
          {pressed && highlight !== undefined ? (
            <View aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: highlight }]} />
          ) : null}
          {selected ? (
            // Selection is carried by the fill, the border AND this mark: PRD 10.5 forbids
            // colour as the only carrier of state.
            <Icon name="check" size={typography.bodyStrong.lineHeight} color={labelColor} />
          ) : null}
          {/*
            Not `AppText`. The label colour is `chip.labelSelected` - a layer-3 decision - and
            `AppText`'s `tone` reaches only `semantic.ts`'s content roles. Restating that mapping
            here would leave the chip token with no consumer to notice if it changed.
          */}
          <Text allowFontScaling={false} style={{ ...typography.bodyStrong, color: labelColor }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
