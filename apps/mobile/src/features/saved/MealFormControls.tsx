/**
 * The meal form's controls: the pieces that only know how a field LOOKS (T-17-03, T-17-05).
 *
 * Extracted from `MealFormScreen.tsx` under SQG-09, along the seam a reviewer would draw rather
 * than wherever the line count fell. The rule for this file is one sentence: **nothing here knows
 * that a draft, a store or a validation rule exists.** Every component takes its value and its
 * error as props and hands keystrokes back; there is no `useState`, no `customMealsStore`, no
 * `validateMealForm`, and no way to reach `dispatch` from inside it. That is what makes the split
 * safe to make — a presentational file cannot break the invariant the screen is holding.
 *
 * **What deliberately did NOT move, and this is the whole point.** The draft state, the
 * `validateMealForm` call, the S-43 visited-field filter and the create-confirmation lane stay
 * together in `MealFormScreen.tsx`. They are one mechanism — the one standing between a
 * half-typed value and the store — and P14's CRITICAL is exactly what happens when part of that
 * mechanism lives somewhere else: the screen that shipped it dispatched every keystroke, the
 * store held a value its key's schema rejected, and the next launch erased the user's data. A
 * reviewer must be able to read those four things in one pass, in one file, which they still can.
 *
 * What moved is the noise that was crowding them out: three chip groups that differed only in
 * their contents, two list rows repeated per entry, four identical nutrition boxes, and the error
 * row those five surfaces share.
 */

import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { AppText, Chip, FormField, Icon, IconButton } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import { EMPTY_MEAL_FORM_DRAFT, nutrientRangeMessage } from './mealFormValidation.js';
import type { MealFormDraft } from './mealFormValidation.js';

/** The draft's string-valued keys, derived rather than listed so a renamed field cannot drift. */
export type TextField = {
  [K in keyof MealFormDraft]: MealFormDraft[K] extends string ? K : never;
}[keyof MealFormDraft];

export interface NumberSpec {
  readonly field: TextField;
  readonly testID: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * The four nutrition boxes, which differ only in their bound — so they are data, not four blocks
 * of near-identical JSX.
 *
 * The hint is `nutrientRangeMessage`'s own sentence, which names the bound **and** the unit. Said
 * before the user types, the same words are then the error if they exceed it: one copy, so the
 * guidance and the complaint can never disagree.
 */
export const NUTRIENT_SPECS: readonly NumberSpec[] = [
  {
    field: 'caloriesText',
    testID: 'calories',
    label: 'Calories',
    hint: nutrientRangeMessage('caloriesText'),
  },
  {
    field: 'proteinGramsText',
    testID: 'protein',
    label: 'Protein',
    hint: nutrientRangeMessage('proteinGramsText'),
  },
  {
    field: 'carbsGramsText',
    testID: 'carbs',
    label: 'Carbohydrate',
    hint: nutrientRangeMessage('carbsGramsText'),
  },
  {
    field: 'fatGramsText',
    testID: 'fat',
    label: 'Fat',
    hint: nutrientRangeMessage('fatGramsText'),
  },
];

/**
 * `EMPTY_MEAL_FORM_DRAFT`'s lists are genuinely empty — that is the state "add at least one" is
 * about — so a create form appends the one row there has to be something to type into. A blank
 * row is still no ingredient: `validateMealForm` counts it as none, which is why this is safe.
 */
export const CREATE_DRAFT: MealFormDraft = {
  ...EMPTY_MEAL_FORM_DRAFT,
  ingredients: [{ name: '', measure: '' }],
  instructions: [''],
};

/** `tree-nut` and `gluten-aware` read badly with the hyphen left in. */
export function labelOf(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).split('-').join(' ');
}

/** Multi-select membership, as a value: the chip groups are not exclusive choices. */
export function toggled<T extends string>(list: readonly T[], value: T): readonly T[] {
  return list.includes(value) ? list.filter((one) => one !== value) : [...list, value];
}

/**
 * "peanut", "peanut and milk", "peanut, milk and egg" — for the allergen conflict notice.
 *
 * Canonical allergens are kebab-cased (`tree-nut`), so the hyphen becomes a space: a warning read
 * aloud as "tree hyphen nut" is a warning the user has to decode. The domain sorts its output, so
 * the order is stable and testable.
 *
 * `MealDetailsBody.tsx` has the same five lines as a private helper, and that duplication is
 * recorded rather than resolved: a shared formatter would be a new module in `shared/`, which is
 * not this agent's to add, and a screen importing another feature's private helper is the
 * dependency the feature boundary exists to prevent.
 */
export function namedList(values: readonly string[]): string {
  const words = values.map((value) => value.split('-').join(' '));
  if (words.length <= 1) {
    return words[0] ?? '';
  }
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

/**
 * The error surface for a control `FormField` does not wrap — the chip groups and the two lists.
 *
 * It is `FormField`'s error row, deliberately identical: same `alertCircle` mark, same
 * `field.errorText` token, same `role="alert"` and both live-region spellings. Two visual
 * languages for one state would be the drift PRD §10.5 is about.
 *
 * **Local to this feature, and not a seventeenth shared component.** The duplication with
 * `FormField.tsx` is real and recorded as a MINOR. P12 met this exact question and answered it:
 * `StillAvailableNote` was left unexported inside `StatusMessage.tsx` because "TSD §6.7's
 * inventory is sixteen components — it is not a seventeenth". Adding one is an amendment to a
 * document that outranks code, which is not a subagent's to make.
 *
 * **Bare `Text`, for `FormField`'s own stated reason**: `field.errorText` is a layer-3 decision
 * and `AppText`'s `tone` reaches only `semantic.ts`'s content roles, so restating that mapping
 * through `tone` is precisely how the two colours drift apart.
 *
 * The message is not bound to its group by ARIA, and that is React Native's limit rather than a
 * choice: RN 0.86 declares no `aria-describedby` and no `group` role, so a label on a roleless
 * container is ignored by most screen readers (the same gap `DietarySetupScreen` records for its
 * allergy chips). What carries the meaning instead is the visible heading above the group, each
 * chip's own announced state, and this alert — whose copy names what to do without needing the
 * field's name.
 */
export function GroupError({
  testID,
  message,
}: {
  readonly testID: string;
  readonly message: string;
}): ReactNode {
  const { components, typography } = useTheme();
  const field = components.field;
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      aria-live="assertive"
      style={{ flexDirection: 'row', alignItems: 'flex-start', gap: field.errorGap }}
    >
      <Icon name="alertCircle" size={typography.caption.lineHeight} color={field.errorText} />
      <Text
        allowFontScaling={false}
        style={{ ...typography.caption, color: field.errorText, flex: 1 }}
      >
        {message}
      </Text>
    </View>
  );
}

export interface ChipGroupProps<T extends string> {
  readonly label: string;
  readonly caption?: string;
  /** The draft field this group edits. Also its testIDs: `field-<field>`, `error-<field>`. */
  readonly field: string;
  /** The per-chip testID prefix: `chip-<prefix>-<value>`. */
  readonly prefix: string;
  readonly values: readonly T[];
  readonly selected: readonly string[];
  readonly onToggle: (value: T) => void;
  readonly error?: string;
}

/**
 * A heading, a wrapped row of multi-select chips, and its error.
 *
 * **`toggle` is set on every chip, and that is not what `ChipRow` does.** That component (in
 * `features/onboarding/`) is single-select by construction — `selected: T`, no "none" state — and
 * its docstring's expectation that "P17's meal form needs an exclusive choice row" does not hold:
 * a meal can be both lunch and dinner, and can carry no allergen at all. So these chips announce
 * `checkbox` + `checked` rather than `button` + `selected` (S-13). A checkbox a user cannot
 * uncheck announces a lie about what it does, and so does a radio group that is really
 * multi-select.
 */
export function ChipGroup<T extends string>({
  label,
  caption,
  field,
  prefix,
  values,
  selected,
  onToggle,
  error,
}: ChipGroupProps<T>): ReactNode {
  const { components } = useTheme();
  return (
    <>
      <AppText variant="label" tone="secondary">
        {label}
      </AppText>
      {caption === undefined ? null : (
        <AppText variant="caption" tone="tertiary">
          {caption}
        </AppText>
      )}
      <View
        testID={`field-${field}`}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
      >
        {values.map((value) => (
          <Chip
            key={value}
            testID={`chip-${prefix}-${value}`}
            label={labelOf(value)}
            toggle
            selected={selected.includes(value)}
            onPress={() => {
              onToggle(value);
            }}
          />
        ))}
      </View>
      {error === undefined ? null : <GroupError testID={`error-${field}`} message={error} />}
    </>
  );
}

/** One nutrition box, driven by its `NumberSpec`. */
export function NutritionField({
  spec,
  value,
  onChangeText,
  onBlur,
  error,
}: {
  readonly spec: NumberSpec;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onBlur: () => void;
  readonly error?: string;
}): ReactNode {
  return (
    <FormField
      testID={`field-${spec.testID}`}
      label={spec.label}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      {...(error === undefined ? {} : { error })}
      hint={spec.hint}
      keyboardType="number-pad"
      maxLength={12}
    />
  );
}

/**
 * One ingredient: a name, a measure, and a way to remove the row.
 *
 * **The error binds to the NAME field, not to the row**, because that is the box the user has to
 * act on — `ingredientSchema` requires `name.min(1)`, so "200 ml of nothing" fails on the name.
 * The measure carries no error of its own: there is no rule it can break alone.
 */
export function IngredientRow({
  index,
  name,
  measure,
  onChangeName,
  onChangeMeasure,
  onBlur,
  onRemove,
  error,
}: {
  readonly index: number;
  readonly name: string;
  readonly measure: string;
  readonly onChangeName: (value: string) => void;
  readonly onChangeMeasure: (value: string) => void;
  readonly onBlur: () => void;
  readonly onRemove: () => void;
  readonly error?: string;
}): ReactNode {
  const { components } = useTheme();
  const position = String(index + 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: components.card.gap }}>
      <View style={{ flex: 2 }}>
        <FormField
          testID={`field-ingredient-${String(index)}-name`}
          label={`Ingredient ${position}`}
          value={name}
          onChangeText={onChangeName}
          onBlur={onBlur}
          {...(error === undefined ? {} : { error })}
          maxLength={120}
        />
      </View>
      <View style={{ flex: 1 }}>
        <FormField
          testID={`field-ingredient-${String(index)}-measure`}
          label="Measure"
          value={measure}
          onChangeText={onChangeMeasure}
          maxLength={60}
        />
      </View>
      {/* Named by position, so "Remove" is never announced twice with nothing to tell them apart. */}
      <IconButton
        testID={`remove-ingredient-${String(index)}`}
        icon="close"
        accessibilityLabel={`Remove ingredient ${position}`}
        onPress={onRemove}
      />
    </View>
  );
}

/** One step. Multiline, because a step is a sentence and a one-line box hides its own end. */
export function StepRow({
  index,
  value,
  onChangeText,
  onBlur,
  onRemove,
  error,
}: {
  readonly index: number;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onBlur: () => void;
  readonly onRemove: () => void;
  readonly error?: string;
}): ReactNode {
  const { components } = useTheme();
  const position = String(index + 1);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: components.card.gap }}>
      <View style={{ flex: 1 }}>
        <FormField
          testID={`field-instruction-${String(index)}`}
          label={`Step ${position}`}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          {...(error === undefined ? {} : { error })}
          multiline
          maxLength={400}
        />
      </View>
      <IconButton
        testID={`remove-instruction-${String(index)}`}
        icon="close"
        accessibilityLabel={`Remove step ${position}`}
        onPress={onRemove}
      />
    </View>
  );
}
