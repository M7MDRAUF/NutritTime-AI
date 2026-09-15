/**
 * FR-013's validation and record composition for a user-authored meal — pure, so the whole rule
 * set is tested without a renderer (T-17-03, T-17-05).
 *
 * **This module is the guard that makes P14's defect class unreachable for custom meals.** That
 * defect was a screen putting a value into a store whose storage schema then rejected it: the
 * write was persisted unchecked, `classifyEntry` quarantined the whole key on the next launch, and
 * the user's data was gone with no message. Nothing downstream would catch it here either —
 * `repository.set` checks `definition.bound` and never `definition.schema`, and the `customMeals`
 * reducer deliberately takes a complete `CustomMeal` without validating it. The only place a
 * malformed custom meal can be stopped is before it is composed, which is here. Three decisions
 * make that structural rather than hopeful:
 *
 *  - `MealFormDraft` is all strings, because that is what a text input holds: a half-typed price
 *    is unfinished, not wrong. `composeCustomMeal` is the app's only producer of a `CustomMeal`.
 *  - `validateMealForm` and the composers are **one pass** (`interpret`). Two passes could
 *    disagree, and a disagreement between "the form said this was fine" and "what we stored" is
 *    exactly the defect above. **This is why `interpret` was not split** under SQG-09, which moved
 *    what a typed string means to `mealFormFields.ts`, id assembly to `mealIdentity.ts`, and what
 *    becomes of already-proved values to `mealRecord.ts`, all three re-exported below. Every rule
 *    that records a field-bound error stays in this one pass — including the all-or-nothing
 *    nutrition rule, which reads five fields at once — and so do both `compose*` functions, so the
 *    only route to a `CustomMeal` is interpret-then-compose inside one function. `MealFormErrors`
 *    stays here too, beside the draft its keys come from; `mealRecord.ts` takes it as a type
 *    parameter rather than importing it, which is what removed the tree's one source-level import
 *    cycle (see `ComposeOutcome` there).
 *  - The composed record is checked against `customMealSchema` — the schema storage itself
 *    applies — before it is returned. That is a **backstop, not the primary guard**: the
 *    field-bound rules are what a user can act on, and the suite's job is to prove the two agree
 *    across the whole rule set. A record only the backstop rejects means a rule here is missing.
 *
 * Errors are keyed by field because PRD §13 requires that "validation errors appear beside the
 * field that caused them". *When* they are shown is the screen's business, per P14's S-43: this
 * module reports everything it knows on every call, and the screen filters by visited field.
 *
 * No clock and no global randomness: `now` and `newId` are injected (CONTRACTS §7). A module that
 * read `Date.now()` would make every test depend on the time of day.
 */

import type {
  CustomMeal,
  DietTag,
  Ingredient,
  MealPeriod,
  NutritionSummary,
} from '@nutritime/contracts';
import {
  DESCRIPTION_MAX,
  MEAL_FORM_MESSAGES,
  MINUTES_MAX,
  NAME_MAX,
  NUTRIENT_LIMITS,
  SERVINGS_MAX,
  SERVINGS_MIN,
  nutrientRangeMessage,
  parsePriceCents,
  parseWhole,
  priceTextFromCents,
} from './mealFormFields.js';
import type { NutrientField } from './mealFormFields.js';
import { createRecord, updateRecord } from './mealRecord.js';
import type { ComposeContext, ComposeOutcome, DraftValues } from './mealRecord.js';

// CONTRACTS §7's published surface, unchanged by the SQG-09 split and by the cycle break below: a
// screen imports everything here and never needs to know the rule set lives in three files.
export { MEAL_FORM_MESSAGES, nutrientRangeMessage } from './mealFormFields.js';
export { MEAL_ID_PATTERN, generateMealId } from './mealIdentity.js';
export type { ComposeContext } from './mealRecord.js';
export type ComposeResult = ComposeOutcome<MealFormErrors>;

const M = MEAL_FORM_MESSAGES;

/** What the form holds while the user types: every field a string, because inputs are strings. */
export interface MealFormDraft {
  readonly name: string;
  readonly description: string;
  readonly mealPeriods: readonly MealPeriod[];
  readonly dietTags: readonly DietTag[];
  readonly allergenTags: readonly string[];
  readonly ingredients: readonly { readonly name: string; readonly measure: string }[];
  readonly instructions: readonly string[];
  readonly priceText: string;
  readonly preparationMinutesText: string;
  readonly caloriesText: string;
  readonly proteinGramsText: string;
  readonly carbsGramsText: string;
  readonly fatGramsText: string;
  readonly servingsText: string;
}

/**
 * Both lists start genuinely **empty** rather than seeded with one blank row: empty is the state
 * the "add at least one" rule is about, and a screen wanting a row to type into can append one
 * without this constant pretending the user already made one.
 */
export const EMPTY_MEAL_FORM_DRAFT: MealFormDraft = {
  name: '',
  description: '',
  mealPeriods: [],
  dietTags: [],
  allergenTags: [],
  ingredients: [],
  instructions: [],
  priceText: '',
  preparationMinutesText: '',
  caloriesText: '',
  proteinGramsText: '',
  carbsGramsText: '',
  fatGramsText: '',
  servingsText: '',
};

/** Field-bound errors, keyed by field. PRD §13: "Validation errors appear beside the field". */
export type MealFormField = keyof MealFormDraft | `ingredient.${number}` | `instruction.${number}`;
export type MealFormErrors = Readonly<Partial<Record<MealFormField, string>>>;
type MutableErrors = Partial<Record<MealFormField, string>>;

// --------------------------------------------------------------------------- the single pass

const NUTRITION_UNSET: NutritionSummary = {
  calories: null,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
};

/**
 * Ingredient rows, with **trailing blank rows dropped and interior ones reported**.
 *
 * The asymmetry is the point: a blank row at the end is an unfilled affordance, while silently
 * deleting a blank row somebody is looking at is the quiet data loss this module exists to
 * prevent. A row with a measure but no name always fails — `ingredientSchema` requires
 * `name.min(1)`, and "200 ml of nothing" is not an ingredient.
 */
function readIngredients(
  draft: MealFormDraft,
  errors: MutableErrors,
): readonly Ingredient[] | null {
  const rows = draft.ingredients.map((r) => ({ name: r.name.trim(), measure: r.measure.trim() }));
  const last = rows.findLastIndex((row) => row.name !== '' || row.measure !== '');
  if (last === -1) {
    errors.ingredients = M.ingredientsRequired;
    return null;
  }
  const kept: Ingredient[] = [];
  rows.slice(0, last + 1).forEach((row, index) => {
    if (row.name === '' && row.measure === '') errors[`ingredient.${index}`] = M.rowBlank;
    else if (row.name === '') errors[`ingredient.${index}`] = M.ingredientNameRequired;
    else kept.push({ name: row.name, measure: row.measure });
  });
  return kept.length === last + 1 ? kept : null;
}

/**
 * Instruction steps, same rule as the rows above.
 *
 * FR-013 does not list instructions and `mealObjectSchema` requires `.min(1)` non-empty strings,
 * so the form has to enforce it (see `## JUDGEMENTS`). Without this, saving a step-less meal would
 * fail at the storage edge with no field to point at.
 */
function readInstructions(draft: MealFormDraft, errors: MutableErrors): readonly string[] | null {
  const steps = draft.instructions.map((step) => step.trim());
  const last = steps.findLastIndex((step) => step !== '');
  if (last === -1) {
    errors.instructions = M.instructionsRequired;
    return null;
  }
  const kept: string[] = [];
  steps.slice(0, last + 1).forEach((step, index) => {
    if (step === '') errors[`instruction.${index}`] = M.rowBlank;
    else kept.push(step);
  });
  return kept.length === last + 1 ? kept : null;
}

function readNutrient(text: string, field: NutrientField, errors: MutableErrors): number | null {
  const value = text.trim();
  if (value === '') {
    errors[field] = M.nutritionIncomplete;
    return null;
  }
  const parsed = parseWhole(value, NUTRIENT_LIMITS[field].max, nutrientRangeMessage(field));
  if (parsed.ok) return parsed.value;
  errors[field] = parsed.message;
  return null;
}

function readServings(text: string, errors: MutableErrors): number | null {
  if (text === '') {
    errors.servingsText = M.servingsRequired;
    return null;
  }
  const parsed = parseWhole(text, SERVINGS_MAX, M.servingsRange);
  if (!parsed.ok) {
    errors.servingsText = parsed.message;
    return null;
  }
  if (parsed.value < SERVINGS_MIN) {
    errors.servingsText = M.servingsRange;
    return null;
  }
  return parsed.value;
}

/**
 * Nutrition, all-or-nothing (FR-006, and `mealSchema.superRefine` enforces it).
 *
 * Either all four figures are blank ⇒ all `null` and `servings: null`, or all four are given and
 * `servings` is an integer 1…24. Three-of-four is a field-bound error on **each blank figure**,
 * because a meal whose nutrition is three-quarters known is a meal whose nutrition is unknown.
 *
 * A serving count with no figures is refused rather than discarded: a divisor with nothing to
 * divide means nothing, and silently dropping what somebody typed is how a form loses data.
 */
function readNutrition(
  draft: MealFormDraft,
  errors: MutableErrors,
): { readonly nutrition: NutritionSummary; readonly servings: number | null } | null {
  const servingsText = draft.servingsText.trim();
  const figures = [
    draft.caloriesText,
    draft.proteinGramsText,
    draft.carbsGramsText,
    draft.fatGramsText,
  ];
  if (figures.every((text) => text.trim() === '')) {
    if (servingsText === '') return { nutrition: NUTRITION_UNSET, servings: null };
    errors.servingsText = M.servingsWithoutNutrition;
    return null;
  }
  const calories = readNutrient(draft.caloriesText, 'caloriesText', errors);
  const proteinGrams = readNutrient(draft.proteinGramsText, 'proteinGramsText', errors);
  const carbsGrams = readNutrient(draft.carbsGramsText, 'carbsGramsText', errors);
  const fatGrams = readNutrient(draft.fatGramsText, 'fatGramsText', errors);
  const servings = readServings(servingsText, errors);
  if (calories === null || proteinGrams === null || carbsGrams === null) return null;
  if (fatGrams === null || servings === null) return null;
  return { nutrition: { calories, proteinGrams, carbsGrams, fatGrams }, servings };
}

/** The one pass both `validateMealForm` and the composers run, so they cannot disagree. */
function interpret(draft: MealFormDraft): {
  readonly errors: MealFormErrors;
  readonly values: DraftValues | null;
} {
  const errors: MutableErrors = {};
  const name = draft.name.trim();
  if (name === '') errors.name = M.nameRequired;
  else if (name.length > NAME_MAX) errors.name = M.nameTooLong;
  const description = draft.description.trim();
  if (description.length > DESCRIPTION_MAX) errors.description = M.descriptionTooLong;
  if (draft.mealPeriods.length === 0) errors.mealPeriods = M.mealPeriodsRequired;
  if (draft.dietTags.length === 0) errors.dietTags = M.dietTagsRequired;

  const ingredients = readIngredients(draft, errors);
  const instructions = readInstructions(draft, errors);
  const price = parsePriceCents(draft.priceText.trim());
  if (!price.ok) errors.priceText = price.message;
  const minutesText = draft.preparationMinutesText.trim();
  const minutes =
    minutesText === ''
      ? { ok: false as const, message: M.minutesRequired }
      : parseWhole(minutesText, MINUTES_MAX, M.minutesRange);
  if (!minutes.ok) errors.preparationMinutesText = minutes.message;
  const nutrition = readNutrition(draft, errors);

  const blocked =
    Object.keys(errors).length > 0 || ingredients === null || instructions === null || !price.ok;
  if (blocked || !minutes.ok || nutrition === null) return { errors, values: null };
  return {
    errors,
    values: {
      name,
      description,
      mealPeriods: draft.mealPeriods,
      dietTags: draft.dietTags,
      // A blank tag is not a tag. Unknown tags are KEPT deliberately: `Meal.allergenTags` is
      // `readonly string[]` precisely so a tag the taxonomy does not know survives, and
      // `core.ts` calls rejecting one "the one failure mode this system must never have".
      allergenTags: draft.allergenTags.map((tag) => tag.trim()).filter((tag) => tag !== ''),
      ingredients,
      instructions,
      priceCents: price.value,
      preparationMinutes: minutes.value,
      nutrition: nutrition.nutrition,
      servings: nutrition.servings,
    },
  };
}

export function validateMealForm(draft: MealFormDraft): MealFormErrors {
  return interpret(draft).errors;
}

// ------------------------------------------------------------------------------------ edit mode

/**
 * A draft loaded from an existing record, for edit mode (T-17-04).
 *
 * `servingsText` is blank whenever nutrition is wholly unknown, even if the stored record carries
 * a serving count. `mealSchema`'s `user` branch permits that pair (see `## FINDINGS`) but it
 * divides nothing, and carrying it in only to reject it would tell the user they were wrong about
 * a record they had not edited.
 */
export function draftFromCustomMeal(meal: CustomMeal): MealFormDraft {
  const text = (value: number | null): string => (value === null ? '' : String(value));
  const known = meal.nutrition.calories !== null;
  return {
    name: meal.name,
    description: meal.description,
    mealPeriods: meal.mealPeriods,
    dietTags: meal.dietTags,
    allergenTags: meal.allergenTags,
    ingredients: meal.ingredients.map((row) => ({ name: row.name, measure: row.measure })),
    instructions: meal.instructions,
    priceText: priceTextFromCents(meal.price.amountCents),
    preparationMinutesText: String(meal.preparationMinutes),
    caloriesText: text(meal.nutrition.calories),
    proteinGramsText: text(meal.nutrition.proteinGrams),
    carbsGramsText: text(meal.nutrition.carbsGrams),
    fatGramsText: text(meal.nutrition.fatGrams),
    servingsText: known ? text(meal.nutritionProvenance.servings) : '',
  };
}

// ------------------------------------------------------------------------------------ composing

/**
 * Create. Generates an id, stamps both timestamps, sets user provenance.
 *
 * `context.existingIds` must be the store's real id list — see that field's own docstring in
 * `mealRecord.ts` for what passing `[]` promises and what it costs when the promise is false.
 */
export function composeCustomMeal(draft: MealFormDraft, context: ComposeContext): ComposeResult {
  const { errors, values } = interpret(draft);
  if (values === null) return { ok: false, errors };
  return createRecord(values, context);
}

/** Edit. Keeps `id` and `createdAt`, moves `updatedAt`. */
export function composeCustomMealUpdate(
  draft: MealFormDraft,
  existing: CustomMeal,
  context: Pick<ComposeContext, 'now'>,
): ComposeResult {
  const { errors, values } = interpret(draft);
  if (values === null) return { ok: false, errors };
  return updateRecord(values, existing, context);
}
