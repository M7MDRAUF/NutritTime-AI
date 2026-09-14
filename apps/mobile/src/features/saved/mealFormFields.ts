/**
 * What one typed field MEANS: the bounds, the copy, and the two parsers (T-17-05).
 *
 * Extracted from `mealFormValidation.ts` under SQG-09, along a seam that keeps that module's
 * single pass intact. The seam is **"what does this string mean" versus "what does the form do
 * about it"**. Nothing here takes an error map, records an error against a field, or knows that a
 * draft exists; every function is a string in and a `Parsed` out. The rules that turn a `Parsed`
 * into a field-bound message — and the all-or-nothing nutrition rule that reads several fields at
 * once — stay with `interpret`, because that single pass is what makes `validateMealForm` and the
 * two composers unable to disagree. `mealFormValidation.ts` re-exports the copy, so CONTRACTS §7's
 * published surface is unchanged.
 *
 * `MEAL_FORM_MESSAGES` is exported so a screen and its test use this copy rather than retyping a
 * string that would then drift from the assertions about it.
 */

/**
 * `mealSchema`'s own bounds, restated because the form must enforce them BEFORE the value is
 * stored — the same reason `dietaryValidation.ts` restates `MAX_DISLIKES`. Each is asserted
 * against the schema in `mealFormValidation.test.ts`, so a drifted bound fails the suite rather
 * than reaching a user as a save that is refused with nothing to point at.
 */
export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 400;
export const MINUTES_MAX = 600;
export const SERVINGS_MIN = 1;
export const SERVINGS_MAX = 24;

const PRICE_MAX_CENTS = 100_000;
const CENTS_PER_DOLLAR = 100;
const MINOR_UNIT_DIGITS = 2;
/** More major digits than this cannot be inside `PRICE_MAX_CENTS`, and checking the length first
 * is what keeps `major * 100` inside the safe-integer range. */
const PRICE_MAJOR_DIGITS_MAX = 7;
const WHOLE_DIGITS_MAX = 10;

export const NUTRIENT_LIMITS = {
  caloriesText: { max: 2000, label: 'Calories', unit: 'kcal' },
  proteinGramsText: { max: 200, label: 'Protein', unit: 'g' },
  carbsGramsText: { max: 300, label: 'Carbohydrate', unit: 'g' },
  fatGramsText: { max: 200, label: 'Fat', unit: 'g' },
} as const;
export type NutrientField = keyof typeof NUTRIENT_LIMITS;

/** One message per failure mode, written for the person reading it rather than the developer. */
export const MEAL_FORM_MESSAGES = {
  nameRequired: 'Enter a name for this meal.',
  nameTooLong: `Use ${String(NAME_MAX)} characters or fewer.`,
  descriptionTooLong: `Use ${String(DESCRIPTION_MAX)} characters or fewer.`,
  mealPeriodsRequired: 'Choose at least one time of day.',
  dietTagsRequired: 'Choose at least one diet tag.',
  ingredientsRequired: 'Add at least one ingredient.',
  ingredientNameRequired: 'Name this ingredient, or clear the row.',
  rowBlank: 'Fill this row in, or remove it.',
  instructionsRequired: 'Add at least one step.',
  priceRequired: 'Enter a price, or 0 if it is free.',
  priceFormat: 'Enter a price in dollars and cents, like 4.50.',
  pricePrecision: 'A price has at most two decimal places.',
  priceRange: `Enter a price between 0 and ${String(PRICE_MAX_CENTS / CENTS_PER_DOLLAR)}.`,
  negative: 'Enter a number that is not negative.',
  wholeNumber: 'Enter a whole number.',
  minutesRequired: 'Enter how many minutes it takes to prepare.',
  minutesRange: `Enter a preparation time between 0 and ${String(MINUTES_MAX)} minutes.`,
  /** Bound to each BLANK figure: that is the field the user has to act on. */
  nutritionIncomplete: 'Enter all four nutrition figures, or leave all four blank.',
  servingsRequired: 'Enter how many servings these figures are for.',
  servingsRange: `Enter a serving count between ${String(SERVINGS_MIN)} and ${String(SERVINGS_MAX)}.`,
  servingsWithoutNutrition: 'Enter the four nutrition figures, or clear the serving count.',
  /** The backstop refused the record. Not actionable field by field, so it says what happened. */
  notSaveable: 'This meal could not be saved, so nothing was changed. Check the fields above.',
  idCollision: 'This meal could not be given a unique id. Try saving again.',
} as const;

const M = MEAL_FORM_MESSAGES;

/** Names the bound AND the unit: "between 0 and 200" alone leaves the user guessing at grams. */
export function nutrientRangeMessage(field: NutrientField): string {
  const limit = NUTRIENT_LIMITS[field];
  return `${limit.label} must be a whole number between 0 and ${String(limit.max)} ${limit.unit}.`;
}

const DIGITS = /^\d+$/;
/** Decimal, deliberately WITHOUT an exponent: `Number('1e3')` is 1000, and a price box that read
 * "1e3" as $1000 would store a number nobody typed. `\d` is ASCII-only, so '٤' is refused too. */
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

export type Parsed = { ok: true; value: number } | { ok: false; message: string };

/**
 * A non-negative whole number, bounded. Blank is the caller's business: it means a missing price
 * on one field and nutrition a user may leave unset on another.
 *
 * A leading `-` is refused before the digit test, so `-4` gets the negative message rather than
 * "enter a whole number" — FR-013 names negative numbers as their own failure. **That includes
 * `'-0'`:** `Number('-0')` is `-0`, which `Number.isInteger` and Zod's `.min(0)` both accept, so
 * the schema itself would take it. This is the only place that can say otherwise.
 */
export function parseWhole(text: string, max: number, rangeMessage: string): Parsed {
  if (text.startsWith('-')) return { ok: false, message: M.negative };
  if (!DIGITS.test(text)) return { ok: false, message: M.wholeNumber };
  if (text.length > WHOLE_DIGITS_MAX) return { ok: false, message: rangeMessage };
  const value = Number(text);
  return value > max ? { ok: false, message: rangeMessage } : { ok: true, value };
}

/**
 * Minor units, derived from what a person typed — never typed directly.
 *
 * The arithmetic is on the two digit groups as integers, never on a float: TSD §4.2 forbids
 * `Math.round(parseFloat(text) * 100)`, and `'4.505'` is refused rather than rounded, because a
 * price that round-trips to a different number than the user typed is a defect however small.
 */
export function parsePriceCents(text: string): Parsed {
  if (text === '') return { ok: false, message: M.priceRequired };
  if (text.startsWith('-')) return { ok: false, message: M.negative };
  if (!DECIMAL.test(text)) return { ok: false, message: M.priceFormat };
  const dot = text.indexOf('.');
  const majorText = dot === -1 ? text : text.slice(0, dot);
  const minorText = dot === -1 ? '' : text.slice(dot + 1);
  if (minorText.length > MINOR_UNIT_DIGITS) return { ok: false, message: M.pricePrecision };
  if (majorText.length > PRICE_MAJOR_DIGITS_MAX) return { ok: false, message: M.priceRange };
  const major = majorText === '' ? 0 : Number(majorText);
  const cents = major * CENTS_PER_DOLLAR + Number(minorText.padEnd(MINOR_UNIT_DIGITS, '0'));
  return cents > PRICE_MAX_CENTS
    ? { ok: false, message: M.priceRange }
    : { ok: true, value: cents };
}

/** The inverse, for edit mode. Integer arithmetic, so the round trip is exact. */
export function priceTextFromCents(cents: number): string {
  const minor = String(cents % CENTS_PER_DOLLAR).padStart(MINOR_UNIT_DIGITS, '0');
  return `${String(Math.trunc(cents / CENTS_PER_DOLLAR))}.${minor}`;
}
