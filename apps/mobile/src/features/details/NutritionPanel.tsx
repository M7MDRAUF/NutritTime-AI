/**
 * The four macro figures and the trail back to where they came from (T-16-03, PRD FR-006, FR-011).
 *
 * FR-011's sentence is the whole specification of this file: **"A figure the user cannot trace is
 * a figure the user cannot check."** So the panel never renders a number without also rendering
 * where it came from, the serving count it was divided by, and - for the catalog - the fact that
 * the serving count was authored rather than measured. TSD 7.4 is explicit that the recipe source
 * publishes no serving count, that it divides all four values, and that it is therefore "recorded
 * as authored, never presented as measured". Copy that implied a measured divisor would be the
 * one lie this panel is built to prevent.
 *
 * **"Not available" is the common case here, and the panel is shaped around that.** 53 of the 60
 * catalog records carry `null` for all four macros (probed: `origin` is `unavailable` for 53 and
 * `usda-derived` for 7), which is TSD 7.4's all-or-nothing rule working as designed. Two
 * consequences, both deliberate:
 *
 *  1. **The four rows are always rendered**, even when every one of them says "Not available".
 *     Hiding the rows for 53 records and showing them for 7 would make the panel look broken on
 *     the common record and make the two records feel like different screens. A row that is
 *     present and says "Not available" in the same neutral pill as "24 g" is a statement about
 *     the data; a row that vanished is a bug the user cannot distinguish from a bug.
 *  2. **The reason is the most useful thing on the panel**, so `origin: 'unavailable'` renders it
 *     verbatim rather than swallowing it. FR-006 says the reason is recorded; recording it and
 *     then not showing it would be recording it for nobody.
 *
 * `null` versus `0` is delegated entirely to `NutritionBadge`, which already draws that line and
 * is tested on it. This panel therefore never names the "Not available" string at all - it passes
 * `nutrition[field]` through untouched, and a `?? 0` anywhere on that path would turn 53 records'
 * unknown into a measured zero before the badge ever saw it. The suite asserts the distinction
 * end-to-end against `NUTRITION_UNAVAILABLE` imported from `shared/components`, because the
 * composition is what T-16-03's acceptance is about.
 *
 * Props only - no fetch, no store, no navigation (CONTRACTS 5). That is what makes every `origin`
 * and every `null` combination reachable from a test rather than only from a lucky catalog record.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { NutritionProvenance, NutritionSummary } from '@nutritime/contracts';
import { AppText, NutritionBadge } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';

/**
 * The four rows, in the order PRD FR-006 lists them: calories, protein, carbohydrate, fat.
 *
 * A table rather than four hand-written JSX blocks, so "all four rows always render" is
 * structural instead of a convention three of them happen to follow. `id` is the testID suffix and
 * is deliberately not the field name: `proteinGrams` in a test id would leak the wire shape into
 * the selector, and the unit is already on the row.
 */
const MACRO_ROWS = [
  { id: 'calories', field: 'calories', label: 'Calories', unit: 'kcal' },
  { id: 'protein', field: 'proteinGrams', label: 'Protein', unit: 'g' },
  { id: 'carbs', field: 'carbsGrams', label: 'Carbs', unit: 'g' },
  { id: 'fat', field: 'fatGrams', label: 'Fat', unit: 'g' },
] as const satisfies readonly {
  readonly id: string;
  readonly field: keyof NutritionSummary;
  readonly label: string;
  readonly unit: 'kcal' | 'g';
}[];

const HEADING = 'Nutrition';

/**
 * Fixed local copy, every sentence of it.
 *
 * The only upstream string this panel renders is `reason`, and it is rendered as its own line so
 * that the sentences around it stay this app's words. `reason` is authored catalog data naming the
 * ingredient that failed (TSD 7.4) - it is not an exception message, which BRIEF 3.6 rightly bans
 * from a user-facing surface.
 */
const COPY = {
  /** `origin` says USDA; `dataset` is the field that names which release, and it can be `null`. */
  datasetUnnamed: 'Derived from a USDA dataset that this record does not name.',
  /**
   * The "authored" word survives even with no count to attach it to, because the fact TSD 7.4
   * records is about serving counts in general and not about this one number.
   */
  servingsUnrecorded:
    'The serving count was authored for this meal, and this record does not state it.',
  unavailable: 'These figures could not be derived from published data.',
  unavailableNoReason: 'No reason for that was recorded.',
  userEntered: 'You entered these figures yourself. They are not derived from a published dataset.',
  userNoServings: 'You recorded no serving count for this meal.',
  /** Both of these replace a whole trace rather than a line of one. See `noFigures` below. */
  derivedWithoutFigures:
    'No figures are recorded for this meal, so there is nothing to trace to a dataset or a serving count.',
  userWithoutFigures: 'You have not entered nutrition figures for this meal.',
} as const;

/** "1 serving", "2 servings". Separate because three sentences below need it. */
function servingWords(servings: number): string {
  return `${String(servings)} ${servings === 1 ? 'serving' : 'servings'}`;
}

/**
 * True when not one of the four figures is known, which is the state a serving count must never be
 * rendered beside.
 *
 * **Why this guard exists, and why it is here rather than argued away as unreachable.** W5's
 * schema reading, which this file's suite re-runs against the real `mealSchema` rather than
 * trusting: the `user` branch of `superRefine` fails only when `known === whole && servings ===
 * null`, so a record with all four figures `null` **and** a serving count of 4 validates. Without
 * this guard the panel would print "They are per serving, for the 4 servings you recorded" directly
 * above four rows saying "Not available" - a traceability line tracing nothing, which is worse than
 * silence: it tells the reader a division happened to produce values that do not exist.
 *
 * The catalog cannot produce that combination (`servings` is non-null in exactly the 7
 * `usda-derived` records and null in all 53 `unavailable` ones) and W5's all-or-nothing form rule
 * closes the create path, so the callers that remain are a restored backup, a migration, and a
 * future import - the same class of caller `customMealSchema` exists to defend against, and the
 * reason a component that renders a claim checks the claim itself.
 *
 * Derived from `MACRO_ROWS`, so a fifth macro is covered the day it is added rather than the day
 * someone remembers this function.
 */
function noFigures(nutrition: NutritionSummary): boolean {
  return MACRO_ROWS.every((row) => nutrition[row.field] === null);
}

/**
 * The trace, as one sentence per line, in reading order.
 *
 * Pure and exported so the test can pin the wording down directly as well as through the render -
 * the wording *is* the requirement here, and a test that only counted lines would stay green
 * after "authored" was deleted.
 *
 * Never empty. An `origin` that produced no lines would leave a figure on screen with nothing
 * saying where it came from, which is the exact state FR-011 forbids; and a `servings` of `null`
 * produces a sentence saying so rather than a gap or the words "divided by null".
 *
 * **It takes the figures as well as the provenance**, which reads like more than a trace needs
 * until you notice that whether a serving count may be spoken at all depends on whether there are
 * figures for it to have divided. See `noFigures`.
 */
export function nutritionTraceLines(
  nutrition: NutritionSummary,
  provenance: NutritionProvenance,
): readonly string[] {
  const { origin, dataset, servings, reason } = provenance;
  const unfigured = noFigures(nutrition);

  switch (origin) {
    case 'usda-derived':
      // `mealSchema` rejects this one (`if (known !== whole) fail('usda-derived requires all four
      // values')`), so it is type-reachable rather than schema-reachable. Guarded anyway: the
      // dataset and the serving count are both claims about figures, and naming either beside no
      // figures would say a derivation produced something it did not.
      return unfigured
        ? [COPY.derivedWithoutFigures]
        : [
            dataset === null ? COPY.datasetUnnamed : `Derived from ${dataset}.`,
            servings === null
              ? COPY.servingsUnrecorded
              : `Divided by ${servingWords(servings)}, a count authored for this meal rather than measured.`,
          ];

    case 'unavailable':
      // No guard needed and none added: this branch never mentions a serving count, because for
      // the 53 records that carry it there is nothing to divide. The reason is first-class on its
      // own line, and a sentence says so when there is none - an empty second line here is the
      // 53-record case looking broken.
      return [COPY.unavailable, reason === null ? COPY.unavailableNoReason : reason];

    case 'user':
      // The schema-reachable half of the guard. One sentence, and deliberately not a word about
      // the serving count: with nothing entered there is nothing it divided, and mentioning it
      // would invite the reader to believe otherwise.
      //
      // `dataset` is deliberately NOT rendered for a user-entered record either, even if one is
      // present. Naming a dataset beside figures a person typed would imply the figures came from
      // it, and `customMealSchema` makes `origin: 'user'` mean exactly the opposite (CONTRACTS 0).
      return unfigured
        ? [COPY.userWithoutFigures]
        : [
            COPY.userEntered,
            servings === null
              ? COPY.userNoServings
              : `They are per serving, for the ${servingWords(servings)} you recorded.`,
          ];
  }
}

export interface NutritionPanelProps {
  readonly nutrition: NutritionSummary;
  readonly provenance: NutritionProvenance;
  readonly testID?: string;
}

export function NutritionPanel({ nutrition, provenance, testID }: NutritionPanelProps): ReactNode {
  const { components } = useTheme();
  const card = components.card;
  const suffix = (part: string): string | undefined =>
    testID === undefined ? undefined : `${testID}-${part}`;

  return (
    <View
      testID={testID}
      style={{
        // The `card` group, because this is a section with an edge rather than a control: a
        // bordered panel is what makes four "Not available" rows read as a complete answer
        // instead of an area that failed to fill in. Same tokens as `MealCard`, which is the
        // closest sibling, and no number or colour written here.
        alignSelf: 'stretch',
        gap: card.gap,
        padding: card.padding,
        borderRadius: card.radius,
        borderWidth: card.borderWidth,
        borderColor: card.borderColor,
        backgroundColor: card.background,
      }}
    >
      <AppText variant="subheading" level={2}>
        {HEADING}
      </AppText>

      <View
        // Wraps rather than scrolls: at a large OS font scale `NutritionBadge` becomes a column
        // and four of them on one line would each get a sliver (PRD 10.5).
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.badge.gap }}
      >
        {MACRO_ROWS.map((row) => (
          <NutritionBadge
            key={row.id}
            testID={suffix(row.id)}
            label={row.label}
            // `nutrition[row.field]` and never a coalesce to `0`: the badge is the component that
            // decides what `null` looks like, and `?? 0` here would silently turn 53 records'
            // unknown into a measured zero before the badge ever saw it.
            amount={nutrition[row.field]}
            unit={row.unit}
          />
        ))}
      </View>

      <View
        testID={suffix('trace')}
        // Tighter than the panel's own `card.gap`, so the trail reads as one block belonging to
        // the figures above it rather than as two more sections of the panel. `badge.gap` is the
        // smallest gap the component groups publish and the row above already spaces on it.
        style={{ gap: components.badge.gap }}
      >
        {nutritionTraceLines(nutrition, provenance).map((line, index) => (
          // Secondary, not `tertiary` and not a status tone: the trail is supporting text, and
          // tinting it as a warning would make a correct refusal look like a fault. The words
          // carry the meaning, never the colour (PRD 10.5).
          //
          // Keyed by position rather than by the sentence: one of these lines is `reason`, an
          // upstream string, and two equal strings would collide on a content key.
          <AppText key={index} variant="caption" tone="secondary">
            {line}
          </AppText>
        ))}
      </View>
    </View>
  );
}
