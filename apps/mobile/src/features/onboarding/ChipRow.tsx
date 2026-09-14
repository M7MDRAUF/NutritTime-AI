/**
 * A single-select row of chips (T-14-04).
 *
 * Extracted from `DietarySetupScreen` when that file passed SQG-09's 350 lines, and it is a real
 * seam rather than line-shuffling: P17's meal form and P18's settings both need an exclusive choice
 * row, and a component that lives inside one screen is a component the next screen copies.
 *
 * `toggle` is deliberately NOT set on these chips. They are exclusive choices with no "none" state
 * — a diet is always one of five — so they are `button` + `selected` rather than `checkbox` +
 * `checked` (S-13). A checkbox a user cannot uncheck announces a lie about what it does.
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
 * A single-select row of chips.
 *
 * `toggle` is deliberately NOT set: these are exclusive choices with no "none" state — a diet is
 * always one of five — so they are `button` + `selected` rather than `checkbox` + `checked` (S-13).
 * A checkbox a user cannot uncheck announces a lie about what it does.
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
      accessibilityRole="radiogroup"
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
    >
      {values.map((value) => (
        <Chip
          key={value}
          testID={`chip-${testIDPrefix}-${value}`}
          label={chipLabel(value)}
          selected={value === selected}
          onPress={() => {
            onSelect(value);
          }}
        />
      ))}
    </View>
  );
}
