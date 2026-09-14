/**
 * A labelled text field (TSD 6.7).
 *
 * **The label is visible, always.** `component.ts` says it in the token itself - "Placeholders are
 * a hint, never a label" - so `placeholder` is optional here and `label` is not, and a field with
 * only a placeholder is not expressible.
 *
 * **The inline error is bound to the field by name, not by `aria-describedby`.** `Plan.md` 14.2
 * adopted "inline errors bound by `aria-describedby`" from the UX guidelines, and React Native
 * 0.86's prop surface has no such prop: `ViewAccessibility.d.ts` declares `aria-label`,
 * `aria-labelledby`, `aria-live` and the state aliases, and neither `aria-describedby` nor
 * `aria-invalid` nor `aria-required`. react-native-web 0.21 would forward all three, so this is a
 * React Native gap rather than a web one - and reaching it would need a cast, which this project
 * forbids. What is used instead works on all three platforms:
 *
 *  - the field's accessible NAME carries the label, the required marker and the error, which is
 *    what iOS and Android actually read out; and
 *  - the error text itself is a live region with `role="alert"`, so a message that appears after
 *    the user has moved on is announced rather than discovered.
 *
 * Recorded in the phase report as a divergence from `Plan.md` 14.2 with the mechanism named.
 *
 * Built to `field.minHeight`, which is `touch.buildTo` - PRD 10.5 (2.1.0) via X-05.
 */

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';
import { AppText } from './AppText.js';
import { Icon } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * The word appended to a required field's accessible name, and the visible marker beside its
 * label. One string for both, so the two can never say different things.
 *
 * No document fixes it. An asterisk was rejected: a screen reader says "star" or nothing at all,
 * and PRD 10.5's rule that a state needs a carrier other than colour applies just as much to a
 * state carried by punctuation nobody can hear.
 */
const REQUIRED_MARKER = 'Required';

/** The marks that already end a sentence. A clause ending in one must not be given a second. */
const TERMINATORS = ['.', '!', '?'];

/**
 * One clause, ending in exactly one full stop.
 *
 * Callers write their own copy and some of them punctuate it. Joining the clauses with `'. '`
 * regardless produced `"Enter a name.. Up to 60 characters."` - which a screen reader reads as a
 * stumble, and which the test for the composed name caught.
 */
function terminated(clause: string): string {
  return TERMINATORS.some((mark) => clause.endsWith(mark)) ? clause : `${clause}.`;
}

/**
 * The field's accessible name: what it is, whether it must be filled, and what is wrong with it.
 *
 * A separate function because it is the only logic in this file, and a pure one is the half a
 * test can pin down through the rendered `aria-label` without reaching into the component.
 *
 * The LAST clause is left unterminated, so a field with nothing but a label is named "Meal name"
 * rather than "Meal name." - a trailing stop on a two-word name is a pause with nothing after it.
 */
function accessibleName(
  label: string,
  required: boolean,
  hint: string | undefined,
  error: string | undefined,
): string {
  const parts: string[] = [required ? `${label}, ${REQUIRED_MARKER.toLowerCase()}` : label];
  // The correction before the guidance: a user who has just been told the value is wrong needs
  // the reason before the advice.
  if (error !== undefined) {
    parts.push(error);
  }
  if (hint !== undefined) {
    parts.push(hint);
  }
  return parts
    .map((part, index) => (index === parts.length - 1 ? part : terminated(part)))
    .join(' ');
}

export interface FormFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  /** User-facing copy, never an exception message. Rendered as a live region. */
  readonly error?: string;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly keyboardType?: TextInputProps['keyboardType'];
  readonly autoCapitalize?: TextInputProps['autoCapitalize'];
  /** Plan 14.2 adopted validation on blur; this is where a screen hangs it. */
  readonly onBlur?: () => void;
  readonly testID?: string;
}

export function FormField({
  label,
  value,
  onChangeText,
  error,
  hint,
  placeholder,
  required = false,
  multiline = false,
  maxLength,
  keyboardType,
  autoCapitalize,
  onBlur,
  testID,
}: FormFieldProps): ReactNode {
  const { components, typography } = useTheme();
  const field = components.field;
  const [focused, setFocused] = useState(false);

  const borderColor =
    error !== undefined
      ? field.borderColorError
      : focused
        ? field.borderColorFocused
        : field.borderColor;
  const borderWidth = focused ? field.borderWidthFocused : field.borderWidth;
  // `component.ts` requires that focus "thickens the border rather than replacing it: the field
  // must not appear to move or resize when it gains focus". In React Native a border grows the
  // layout box, so the extra stroke is taken back out of the padding rather than added to the
  // outside. Arithmetic on two tokens, not a literal.
  const inset = borderWidth - field.borderWidth;

  return (
    <View testID={testID} style={{ alignSelf: 'stretch', gap: field.errorGap }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: field.errorGap }}>
        <AppText variant="label" tone="secondary">
          {label}
        </AppText>
        {required ? (
          // The visible half of the required state. `label` is already uppercase in the type
          // scale (TSD 6.6), so this is not re-cased here.
          <AppText variant="label" tone="tertiary">
            {REQUIRED_MARKER}
          </AppText>
        ) : null}
      </View>

      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        placeholder={placeholder}
        placeholderTextColor={field.placeholder}
        multiline={multiline}
        maxLength={maxLength}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={accessibleName(label, required, hint, error)}
        // `theme.typography` already carries the OS font scale (DECISIONS.md S-09), so React
        // Native's own scaling would apply it a second time and a 2x setting would render 4x.
        allowFontScaling={false}
        style={{
          ...typography.body,
          color: field.text,
          minHeight: field.minHeight,
          paddingHorizontal: field.paddingHorizontal - inset,
          paddingVertical: field.paddingVertical - inset,
          borderRadius: field.radius,
          borderWidth,
          borderColor,
          backgroundColor: field.background,
          // A multiline box fills downwards from the top; without this the first line sits in the
          // vertical middle of an empty three-line box.
          textAlignVertical: multiline ? 'top' : 'center',
        }}
      />

      {hint === undefined ? null : (
        <AppText variant="caption" tone="tertiary">
          {hint}
        </AppText>
      )}

      {error === undefined ? null : (
        <View
          // `role="alert"` is Plan 14.2's adopted guideline for an error. Both live-region
          // spellings alongside it: Android reads `accessibilityLiveRegion`, the web export and
          // this suite read `aria-live`, and react-native-web 0.21 maps neither from the other.
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          aria-live="assertive"
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: field.errorGap }}
        >
          {/*
            `component.ts` on `field.errorText`: "Paired with an icon, never colour alone."
            Decorative, because the sentence beside it is the message.
          */}
          {/*
            `alertCircle`, not `danger`. A field whose value is invalid has not FAILED - the user
            is mid-correction - and the failure mark belongs to `ErrorState`, where something
            actually did. Two different marks for two different states (PRD 10.5).
          */}
          <Icon name="alertCircle" size={typography.caption.lineHeight} color={field.errorText} />
          {/*
            Not `AppText`. `field.errorText` is a layer-3 decision and `AppText`'s `tone` reaches
            only `semantic.ts`'s content roles; `status.danger` happens to be the same colour
            today, and restating that mapping here is exactly how the two drift apart. The flex
            box is what lets a long sentence wrap inside the row.
          */}
          <Text
            allowFontScaling={false}
            style={{ ...typography.caption, color: field.errorText, flex: 1 }}
          >
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}
