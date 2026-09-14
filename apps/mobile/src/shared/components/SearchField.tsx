/**
 * The search input (TSD 6.7, FR-010).
 *
 * Three things carry "this is a search field", and none of them is the glyph alone: the container
 * is an ARIA `search` landmark, the input has an accessible name that says so, and a clear control
 * appears as soon as there is something to clear. The leading icon is decoration on top of that -
 * which is the right dependency order for an icon in any case.
 *
 * TSD 6.7 gives this component a `placeholder` and an `accessibilityLabel` and NO `label`, unlike
 * `FormField`. That is deliberate rather than an oversight to correct: a search field sits in a
 * header where a visible label would push the content it searches off the screen, and the
 * accessible name is what a placeholder cannot be. So the name always exists, defaulted, and is
 * never left to the placeholder.
 *
 * The trough is the `field` group, exactly as `component.ts` says ("`SearchField` from `field`").
 * `semantic.ts` describes `surface.sunken` as "a search field's trough", but `field.background` is
 * `surface.raised`; taking the whole geometry and the fill from one group is what stops a search
 * field and a form field drifting into two different shapes. Recorded in the phase report.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { Icon } from './Icon.js';
import { IconButton } from './IconButton.js';
import { useTheme } from '../theme/ThemeProvider.js';

/** The accessible name when a caller gives none. No document fixes it; this is the plain one. */
const DEFAULT_LABEL = 'Search';

/** The accessible name of the control that empties the field. */
const CLEAR_LABEL = 'Clear search';

export interface SearchFieldProps {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onSubmit?: () => void;
  readonly placeholder?: string;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}

export function SearchField({
  value,
  onChangeText,
  onSubmit,
  placeholder,
  accessibilityLabel,
  testID,
}: SearchFieldProps): ReactNode {
  const { components, typography } = useTheme();
  const field = components.field;
  const [focused, setFocused] = useState(false);

  const borderWidth = focused ? field.borderWidthFocused : field.borderWidth;
  // The extra stroke comes out of the padding rather than growing the box, so the field does not
  // appear to move when it gains focus - `component.ts` requires exactly that of `field`.
  const inset = borderWidth - field.borderWidth;

  return (
    <View
      testID={testID}
      // The ARIA landmark, which is what actually says "search" to assistive technology. React
      // Native 0.86 has no `searchbox` role for the input itself, and `search` on an `<input>`
      // would be invalid ARIA, so it goes on the container where it is correct.
      accessibilityRole="search"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: field.errorGap,
        minHeight: field.minHeight,
        paddingHorizontal: field.paddingHorizontal - inset,
        borderRadius: field.radius,
        borderWidth,
        borderColor: focused ? field.borderColorFocused : field.borderColor,
        backgroundColor: field.background,
        // So the clear button's press effect stops at the trough's corners.
        overflow: 'hidden',
      }}
    >
      {/* Decorative: the landmark and the accessible name already say what this is. */}
      <Icon name="search" size={typography.body.lineHeight} color={field.placeholder} />

      <TextInput
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        // The keyboard's own return key says "Search", so submitting needs no on-screen button.
        returnKeyType="search"
        placeholder={placeholder}
        placeholderTextColor={field.placeholder}
        accessibilityLabel={accessibilityLabel ?? DEFAULT_LABEL}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
        }}
        // `theme.typography` already carries the OS font scale (DECISIONS.md S-09); React
        // Native's own scaling would apply it a second time.
        allowFontScaling={false}
        style={{
          ...typography.body,
          color: field.text,
          flex: 1,
          // No padding and no height of its own: the trough above owns both, so the input cannot
          // push the row past the target it was built to.
          paddingVertical: field.paddingVertical - inset,
        }}
      />

      {value === '' ? null : (
        // Only when there is something to clear. A permanently visible clear button is a control
        // that does nothing most of the time, and a screen reader announces it either way.
        <IconButton
          icon="close"
          accessibilityLabel={CLEAR_LABEL}
          onPress={() => {
            onChangeText('');
          }}
          size={typography.body.lineHeight}
        />
      )}
    </View>
  );
}
