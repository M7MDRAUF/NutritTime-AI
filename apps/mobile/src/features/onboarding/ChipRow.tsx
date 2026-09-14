/**
 * A single-select row of chips (T-14-04).
 *
 * Extracted from `DietarySetupScreen` when that file passed SQG-09's 350 lines, and it is a real
 * seam rather than line-shuffling: P17's meal form and P18's settings both need an exclusive choice
 * row, and a component that lives inside one screen is a component the next screen copies.
 *
 * **`toggle` IS passed, and this comment used to say the opposite** (R-55, closed at P23 by T-23-01
 * and T-23-04). The old reasoning was that an exclusive choice has no "none" state, so a `checkbox`
 * a user cannot uncheck announces a lie about what it does. That is a real objection, and it lost to
 * a worse one: `button` + `selected` announces **nothing at all** on the web build. `Chip` puts
 * `selected` on `aria-selected`, which ARIA does not allow on a `button`, and react-native-web
 * 0.21.2 maps `accessibilityState` to no DOM attribute — verified by reading
 * `node_modules/react-native-web/dist/modules/createDOMProps/index.js`, which reads `aria-checked`
 * and `aria-selected` and never reads `accessibilityState` at all. So a screen-reader or
 * colour-blind user was told there were five diets and never which one was theirs. A checked
 * checkbox that stays checked is at least true about the state it reports.
 *
 * **The container is a `toolbar`, not a `radiogroup`.** ARIA requires a `radiogroup` to own `radio`s,
 * and `Chip` has no `radio` mode — TSD §6.7 fixes the shared inventory's prop lists, so one cannot
 * be added from here. `toolbar` may own arbitrary widgets, which is what these are, and
 * `ExploreScreen`'s filter row already uses it for the same shape. Neither role's arrow-key
 * navigation is implemented by react-native-web, which was equally true of the `radiogroup` this
 * replaces, so nothing was lost there.
 *
 * **The group's accessible name is derived from `testIDPrefix`**, which is the preference field name
 * — `diet`, `goal`, `budget` — and produces exactly the three headings `DietarySetupScreen` already
 * renders above these rows. R-55's second half is that the group had no name at all; naming it from
 * the visible heading instead would need an `aria-labelledby` target in that screen, which is not
 * this file. See the phase report for the explicit-label alternative.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Chip } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';

/** `halal-preference` and `gluten-aware` read badly with the hyphen left in. */
export function chipLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace('-', ' ');
}

export interface ChipRowProps<T extends string> {
  readonly testIDPrefix: string;
  readonly values: readonly T[];
  readonly selected: T;
  readonly onSelect: (value: T) => void;
}

/**
 * A single-select row of chips, each announcing its own checked state.
 *
 * Exactly one chip carries `selected`, so exactly one is announced as checked — which is the whole
 * of what a user has to be able to hear, and what the file docstring above explains was missing.
 */
export function ChipRow<T extends string>({
  testIDPrefix,
  values,
  selected,
  onSelect,
}: ChipRowProps<T>): ReactNode {
  const { components } = useTheme();
  return (
    <View
      testID={`field-${testIDPrefix}`}
      accessibilityRole="toolbar"
      accessibilityLabel={chipLabel(testIDPrefix)}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
    >
      {values.map((value) => (
        <Chip
          key={value}
          testID={`chip-${testIDPrefix}-${value}`}
          label={chipLabel(value)}
          // Without this the chip is a `button` carrying an `aria-selected` ARIA does not allow
          // there, which is R-55: the state is drawn and never announced.
          toggle
          selected={value === selected}
          onPress={() => {
            onSelect(value);
          }}
        />
      ))}
    </View>
  );
}
