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
import { MEAL_QUERY_MAX_LENGTH } from '@nutritime/contracts';
import { Icon } from './Icon.js';
import { IconButton } from './IconButton.js';
import { useTheme } from '../theme/ThemeProvider.js';

/** The accessible name when a caller gives none. No document fixes it; this is the plain one. */
const DEFAULT_LABEL = 'Search';

/** The accessible name of the control that empties the field. */
const CLEAR_LABEL = 'Clear search';

/**
 * The longest search text this field will report (R-74).
 *
 * **100 is documented, not chosen.** TSD §5.4's `GET /api/v1/meals` parameter table says
 * "`query` | string | 1–100 chars", and `apps/server/src/routes/meals.ts` implements it as
 * `query: z.string().trim().min(1).max(100)`. Until this bound existed, 101 pasted characters
 * answered 400 `invalid_request`, which Explore renders as its **ERROR** state — not "no meals
 * match" — offering a retry that re-sends the same refused request.
 *
 * **It is declared here rather than imported, because there is nowhere to import it from**, and
 * all three walls are deliberate: `eslint.config.mjs`'s rule 4 forbids `apps/mobile/**` importing
 * `apps/server/**`; `packages/contracts` declares no query-length constant and `apps/mobile`
 * carries no `zod`, so the schema cannot be restated here either. So the number is pinned
 * **executably against both of its authorities instead of against this line**:
 * `SearchField.dom.test.tsx` reads the figure out of TSD §5.4's table *and* out of the server
 * route's own source, refuses to run if it cannot find either, and asserts the field agrees with
 * them. A drift on any of the three sides is red. The constant is not exported, so no assertion
 * can accidentally compare it with itself (BRIEF §6.1g).
 *
 * **It counts raw characters where the server counts trimmed ones**, so the field is stricter by
 * however many spaces surround the phrase. That asymmetry is accepted rather than worked around:
 * 100 non-space characters are always available, a padded query is not a query anyone loses, and
 * the reverse error — a field looser than the server — is the defect R-74 records.
 */
/**
 * Re-exported under the local name so the call sites below read unchanged, but the FIGURE is
 * `packages/contracts`'s single declaration — it was a local `100` until P28, one of three.
 */
const SEARCH_MAX_QUERY = MEAL_QUERY_MAX_LENGTH;

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
        /**
         * **Two enforcements of one bound, and neither is redundant.**
         *
         * `maxLength` is what the *platform* enforces, and it is the half a user feels. On the
         * web — the build this project tests and ships — react-native-web 0.21.2 forwards the
         * prop straight onto the DOM input and does nothing else with it: `maxLength: true` sits
         * in `forwardPropsList` (`dist/exports/TextInput/index.js:60`) and `pickProps` is its only
         * reader, and those are the *only* occurrences of the name in the whole `dist` tree — so
         * there is no JS-side truncation in the library at all, and HTML's own `maxlength`
         * behaviour is what refuses the keystroke and truncates an over-long paste to fit. On iOS
         * and Android the same prop is React Native's documented input limit; that half is stated
         * as the prop's contract rather than read from a shipped implementation, because the
         * implementation is native and this project has no device to measure it on.
         *
         * The slice is what *this component* guarantees, and it exists because the attribute is
         * only ever enforced by whoever is rendering: measured under jsdom 30.0.1, assigning an
         * over-long value to an input with `maxlength` is not truncated and does not even set
         * `validity.tooLong`. So the attribute alone is a bound that cannot be exercised in this
         * project's `dom` project — BRIEF §6.1k's shape, where a guard is free to mutate because
         * the line enforcing it never runs here. The slice is realm-independent, which is what
         * makes "no more than 100 characters leaves this field" a claim a test can execute
         * rather than a claim about an attribute's presence.
         *
         * It bounds what is *reported*, never `value`: the text stays the caller's, so a screen
         * holding an over-long value (a deep link seeds one) still renders what it holds rather
         * than silently disagreeing with the field about its own state.
         */
        maxLength={SEARCH_MAX_QUERY}
        onChangeText={(next) => {
          onChangeText(next.slice(0, SEARCH_MAX_QUERY));
        }}
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
