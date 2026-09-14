/**
 * One macro figure, or the honest absence of one (TSD 6.7, PRD FR-006, FR-011).
 *
 * **"Not available" is the common case, not the failure case.** 53 of the 60 catalog records carry
 * `null` for all four macros, and that is TSD 7.4's all-or-nothing rule working exactly as
 * designed: if any ingredient cannot be resolved to a published USDA food, or its measure cannot
 * be converted to grams, all four values are `null` and the reason is recorded. A meal whose
 * nutrition is three-quarters known is a meal whose nutrition is unknown. So this component says
 * "Not available" in the same neutral voice it says "24 g" - same pill, same size, same position
 * in the row. Nothing about it is red, nothing warns, and nothing apologises. It is a statement
 * about the data, and the data is refusing to guess.
 *
 * Two things this must never do, and they are different mistakes:
 *
 *  1. **Render `0`.** `null` is "we do not know" and `0` is "we know, and it is none". A meal with
 *     no fat and a meal whose fat could not be derived are not the same claim, and one of them is
 *     a claim this project has no basis to make. The test for it passes `amount={0}` and asserts
 *     the digit survives - a falsy check, which is the natural way to write this component wrong,
 *     fails there rather than in production.
 *  2. **Read as broken.** The quiet tone is `badge.unavailableText`, which `component.ts` pins to
 *     `content.tertiary` and not `content.disabled`, with the reason spelled out in the token
 *     itself: "'Not available' is a fact about the data, not an inactive control, so it has to
 *     meet the AA minimum like any other text."
 *
 * T-16-03 renders a row of these on the meal-details screen and depends on both.
 *
 * **Colour is not the carrier here, and that is not a compromise.** TSD 6.7 fixes this signature
 * as `{ label; amount; unit }` with no macro discriminator, so `badge.proteinText`,
 * `badge.carbText` and `badge.fatText` cannot be selected from anything this component is given -
 * a colour chosen by string-matching the user-facing `label` would break the first time the copy
 * changed. The three accents therefore have no consumer; recorded in the phase report as a
 * proposed TSD amendment rather than papered over with a prop the document does not name.
 */

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * The exact string TSD 6.7 and PRD FR-011 both name. A constant so that the component and its
 * test cannot disagree about it, and so that a screen searching for it finds one definition.
 */
export const NUTRITION_UNAVAILABLE = 'Not available';

export interface NutritionBadgeProps {
  readonly label: string;
  /** `null` means the derivation refused, not that the value is zero. */
  readonly amount: number | null;
  readonly unit: 'kcal' | 'g';
  readonly testID?: string;
}

export function NutritionBadge({ label, amount, unit, testID }: NutritionBadgeProps): ReactNode {
  const { components, typography, isLargeText } = useTheme();
  const badge = components.badge;

  // `=== null`, never a truthiness test: `0` is a figure this app is entitled to report and a
  // falsy check would turn it into "Not available", which is a different and unsupported claim.
  const known = amount !== null;
  const value = known ? `${String(amount)} ${unit}` : NUTRITION_UNAVAILABLE;

  const absenceStyle: TextStyle = {
    ...typography.bodyStrong,
    color: known ? badge.neutralText : badge.unavailableText,
  };
  // Tabular figures only where there are figures: a column of macro values has to line up, and
  // applying them to "Not available" would be a lie about what is in the string. Two annotated
  // styles rather than a conditional spread, which needed an `as const` to keep its literal.
  const figureStyle: TextStyle = { ...absenceStyle, fontVariant: ['tabular-nums'] };

  return (
    <View
      testID={testID}
      // Grouped, so iOS and Android announce "Protein, Not available" as one element rather than
      // two the user has to swipe between. No `accessibilityLabel`: the visible text already says
      // it, and a label on a container with no role is ignored on the web anyway.
      accessible
      style={{
        // A row until the type is large enough that a label and a value side by side would each
        // get a sliver (PRD 10.5, `isLargeText`). "Not available" is the longest value this
        // component renders, so it is the one that would wrap first.
        flexDirection: isLargeText ? 'column' : 'row',
        alignItems: isLargeText ? 'flex-start' : 'center',
        alignSelf: 'flex-start',
        gap: badge.gap,
        minHeight: badge.minHeight,
        paddingHorizontal: badge.paddingHorizontal,
        borderRadius: badge.radius,
        backgroundColor: badge.neutralBackground,
      }}
    >
      {/*
        Not `AppText`. `badge.neutralText` and `badge.unavailableText` are layer-3 decisions and
        `AppText`'s `tone` reaches only `semantic.ts`'s content roles; restating that mapping here
        would leave both badge tokens with no consumer to notice if either changed.
      */}
      <Text allowFontScaling={false} style={{ ...typography.label, color: badge.neutralText }}>
        {label}
      </Text>
      <Text allowFontScaling={false} style={known ? figureStyle : absenceStyle}>
        {value}
      </Text>
    </View>
  );
}
