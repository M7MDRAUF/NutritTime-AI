import { z } from 'zod';
import { BUDGET_BANDS, DIET_TAGS, MEAL_PERIODS, NUTRITION_GOALS, THEME_MODES } from './core.js';

/**
 * Zod schemas (TSD 3.3). Every value crossing a trust boundary is parsed, never cast.
 *
 * `z.strictObject` everywhere a body is parsed: an unexpected field is a 400, not a silent
 * ignore. That is what stops a client sending a field the server quietly drops.
 */

/**
 * The structural minimum the codebase depends on, so a schema can cross a package edge
 * without dragging Zod's types with it.
 */
export interface ValueSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

// ----------------------------------------------------------------- nutrition

/**
 * Range bounds are the only defence against a hand-authoring or derivation slip. TSD 3.2
 * deleted the unit/basis fields that used to carry the per-serving invariant, so it moves
 * here: when a type-level guard goes, a validation-level one takes its place.
 */
const nutrient = (max: number) => z.number().int().min(0).max(max).nullable();

export const nutritionSummarySchema = z.strictObject({
  calories: nutrient(2000),
  proteinGrams: nutrient(200),
  carbsGrams: nutrient(300),
  fatGrams: nutrient(200),
});

export const moneySchema = z.strictObject({
  amountCents: z.number().int().min(0).max(100_000),
  currency: z.literal('USD'),
});

export const ingredientSchema = z.strictObject({
  name: z.string().min(1),
  measure: z.string(),
});

const httpUrl = z.url().refine((v) => v.startsWith('http://') || v.startsWith('https://'), {
  message: 'must be an http(s) URL',
});

export const provenanceSchema = z.strictObject({
  themealdbId: z.string().regex(/^\d+$/).nullable(),
  sourceUrl: httpUrl.nullable(),
  imageSource: z.string().max(300).nullable(),
  licenceConfirmed: z.boolean(),
});

export const nutritionProvenanceSchema = z.strictObject({
  origin: z.enum(['usda-derived', 'unavailable', 'user']),
  dataset: z.string().max(120).nullable(),
  servings: z.number().int().min(1).max(24).nullable(),
  reason: z.string().max(200).nullable(),
});

export const kebabIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** The object half, exported so a test can inspect its key set. */
export const mealObjectSchema = z.strictObject({
  id: kebabIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(400),
  mealPeriods: z.array(z.enum(MEAL_PERIODS)).min(1),
  ingredients: z.array(ingredientSchema).min(1),
  instructions: z.array(z.string().min(1)).min(1),
  allergenTags: z.array(z.string()),
  dietTags: z.array(z.enum(DIET_TAGS)).min(1),
  nutrition: nutritionSummarySchema,
  price: moneySchema,
  preparationMinutes: z.number().int().min(0).max(600),
  imageUrl: httpUrl.nullable(),
  available: z.boolean(),
  source: z.enum(['local', 'user']),
  catalogVersion: z.string().min(1),
  provenance: provenanceSchema,
  nutritionProvenance: nutritionProvenanceSchema,
});

export const mealSchema = mealObjectSchema.superRefine((meal, ctx) => {
  const values = [
    meal.nutrition.calories,
    meal.nutrition.proteinGrams,
    meal.nutrition.carbsGrams,
    meal.nutrition.fatGrams,
  ];
  const known = values.filter((v) => v !== null).length;
  const whole = values.length;
  const { origin, dataset, servings, reason } = meal.nutritionProvenance;
  const fail = (message: string, path: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });

  // The all-or-nothing rule (TSD 7.4). A partial sum is worse than no number: it looks
  // complete.
  if (known !== 0 && known !== whole) {
    fail('nutrition must be wholly known or wholly null', 'nutrition');
  }

  // The origin must match the record's source, so a catalog record cannot claim to be
  // user-authored and slip past the checks below.
  if (meal.source === 'user' && origin !== 'user') {
    fail('a user-authored meal must have nutritionProvenance.origin "user"', 'source');
  }
  if (meal.source === 'local' && origin === 'user') {
    fail('a catalog record cannot claim user-authored nutrition', 'source');
  }

  // Each origin is constrained in BOTH directions. The first version only constrained
  // 'unavailable', which let a catalog record ship all-null nutrition with no explanation.
  switch (origin) {
    case 'usda-derived':
      if (known !== whole) fail('usda-derived requires all four values', 'nutrition');
      if (dataset === null) fail('usda-derived requires a dataset', 'nutritionProvenance');
      if (servings === null) fail('usda-derived requires a serving count', 'nutritionProvenance');
      if (reason !== null) fail('a derived record carries no reason', 'nutritionProvenance');
      break;
    case 'unavailable':
      if (known !== 0) fail('unavailable requires all-null values', 'nutrition');
      if (reason === null) fail('unavailable requires a reason', 'nutritionProvenance');
      if (dataset !== null) fail('unavailable carries no dataset', 'nutritionProvenance');
      if (servings !== null) fail('unavailable carries no serving count', 'nutritionProvenance');
      break;
    case 'user':
      // A user may leave nutrition unset (PRD FR-006), but values without a serving count
      // divide by nothing.
      if (known === whole && servings === null) {
        fail('user-entered nutrition requires a serving count', 'nutritionProvenance');
      }
      if (dataset !== null) fail('a user record carries no dataset', 'nutritionProvenance');
      break;
  }
});

// --------------------------------------------------------------- preferences

export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

export const userPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().max(60).optional(),
  diet: z.enum(DIET_TAGS),
  allergies: z.array(z.string().min(1)).max(20),
  goal: z.enum(NUTRITION_GOALS),
  budget: z.enum(BUDGET_BANDS),
  dislikedIngredients: z.array(z.string().min(1)).max(30),
  mealTimes: z.strictObject({
    breakfast: clockTimeSchema,
    lunch: clockTimeSchema,
    dinner: clockTimeSchema,
  }),
  aiEnabled: z.boolean(),
  themeMode: z.enum(THEME_MODES),
});

/** The narrow projection the chat route accepts - deliberately smaller than UserPreferences. */
export const retrievalPreferencesSchema = z.strictObject({
  diet: z.enum(DIET_TAGS),
  allergies: z.array(z.string().min(1)).max(20),
  dislikedIngredients: z.array(z.string().min(1)).max(30),
});

// ------------------------------------------------------------------ requests

export const chatRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  preferences: retrievalPreferencesSchema,
});

export const recommendationRequestSchema = z.strictObject({
  // The client sends the meal period. The server holds no clock (TSD 5.4).
  mealPeriod: z.enum(MEAL_PERIODS),
  aiEnabled: z.boolean(),
  preferences: z.strictObject({
    diet: z.enum(DIET_TAGS),
    allergies: z.array(z.string().min(1)).max(20),
    goal: z.enum(NUTRITION_GOALS),
    budget: z.enum(BUDGET_BANDS),
    dislikedIngredients: z.array(z.string().min(1)).max(30),
  }),
  favoriteMealIds: z.array(z.string()).max(200),
});

// -------------------------------------------------------------- model replies

/** Nothing here can hold a fabricated fact: `answer` is prose, numbers come from the domain. */
export const chatModelReplySchema = z.strictObject({
  answered: z.boolean(),
  answer: z.string().min(1).max(700),
  citedMealIds: z.array(z.string().min(1).max(200)).max(5),
});

export const explanationReplySchema = z.strictObject({
  mealId: z.string().min(1),
  reason: z.string().min(1).max(240),
});
