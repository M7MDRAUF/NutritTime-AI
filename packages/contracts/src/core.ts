/**
 * Enumerations and entity types (TSD 3.1, 3.2).
 *
 * Every enumeration is a const array plus a derived union, so the runtime values and the
 * type can never drift apart and a schema can validate against the same list the type is
 * built from.
 */

export const MEAL_PERIODS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealPeriod = (typeof MEAL_PERIODS)[number];

export const DIET_TAGS = [
  'regular',
  'vegetarian',
  'vegan',
  'halal-preference',
  'gluten-aware',
] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const NUTRITION_GOALS = ['balanced', 'high-protein', 'lower-calorie'] as const;
export type NutritionGoal = (typeof NUTRITION_GOALS)[number];

export const BUDGET_BANDS = ['low', 'medium', 'high'] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DATA_SOURCES = ['local', 'user'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

/**
 * The complete allergen taxonomy. A tag outside this list is not a canonical allergen.
 * `Meal.allergenTags` is deliberately `readonly string[]`, not `CanonicalAllergen[]`: a
 * catalog record may carry a tag the taxonomy does not know, and rejecting an unrecognised
 * allergen tag is the one failure mode this system must never have.
 */
export const CANONICAL_ALLERGENS = [
  'peanut',
  'tree-nut',
  'milk',
  'egg',
  'soy',
  'wheat',
  'gluten',
  'fish',
  'shellfish',
  'sesame',
] as const;
export type CanonicalAllergen = (typeof CANONICAL_ALLERGENS)[number];

/** The eight scoring policies of TSD 4.6, in evaluation order. */
export const SCORE_REASON_KINDS = [
  'meal-period-match',
  'diet-match',
  'goal-match',
  'budget-match',
  'previous-like',
  'preparation-time-fit',
  'local-availability',
  'disliked-ingredient',
] as const;
export type ScoreReasonKind = (typeof SCORE_REASON_KINDS)[number];

// ----------------------------------------------------------------- entities

export interface Money {
  readonly amountCents: number;
  readonly currency: 'USD';
}

export interface Ingredient {
  readonly name: string;
  readonly measure: string;
}

/**
 * Per serving. Units are implied by the field names: kcal for calories, grams for the rest.
 * `null` means unknown and renders as "Not available" - never 0, never a guess (PRD FR-006).
 */
export interface NutritionSummary {
  readonly calories: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
}

/** Where a catalog record came from. Carried because the upstream licence obliges it. */
export interface Provenance {
  readonly themealdbId: string | null;
  readonly sourceUrl: string | null;
  readonly imageSource: string | null;
  readonly licenceConfirmed: boolean;
}

/**
 * How a record's nutrition was obtained. `servings` is the divisor the per-serving figures
 * were computed with, and is authored - the recipe source publishes none.
 */
export interface NutritionProvenance {
  readonly origin: 'usda-derived' | 'unavailable' | 'user';
  readonly dataset: string | null;
  readonly servings: number | null;
  readonly reason: string | null;
}

export interface Meal {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mealPeriods: readonly MealPeriod[];
  readonly ingredients: readonly Ingredient[];
  readonly instructions: readonly string[];
  readonly allergenTags: readonly string[];
  readonly dietTags: readonly DietTag[];
  readonly nutrition: NutritionSummary;
  readonly price: Money;
  readonly preparationMinutes: number;
  readonly imageUrl: string | null;
  readonly available: boolean;
  readonly source: DataSource;
  readonly catalogVersion: string;
  readonly provenance: Provenance;
  readonly nutritionProvenance: NutritionProvenance;
}

export interface UserPreferences {
  readonly schemaVersion: 1;
  readonly name?: string;
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly goal: NutritionGoal;
  readonly budget: BudgetBand;
  readonly dislikedIngredients: readonly string[];
  readonly mealTimes: {
    readonly breakfast: string;
    readonly lunch: string;
    readonly dinner: string;
  };
  readonly aiEnabled: boolean;
  readonly themeMode: ThemeMode;
}

/** A user-authored meal. Same shape as Meal, with its own source and timestamps. */
export interface CustomMeal extends Omit<Meal, 'source' | 'catalogVersion'> {
  readonly source: 'user';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScoreReason {
  readonly kind: ScoreReasonKind;
  readonly points: number;
  readonly detail: string;
}

export interface Recommendation {
  readonly meal: Meal;
  readonly score: number;
  readonly scoreReasons: readonly ScoreReason[];
  readonly explanation: string;
  readonly explanationSource: 'gemma' | 'fallback';
}

export interface Citation {
  readonly mealId: string;
  readonly name: string;
}

/**
 * What the model is allowed to return on the chat lane (TSD 3.3, 5.5).
 *
 * Named here because TSD 5.7's `containReply(reply: ChatModelReply, ...)` signature needs a type
 * and the document declares only the schema. Nothing in this shape can hold a fabricated fact:
 * `citedMealIds` are ids the prompt already carried, and `answer` is prose that containment reads
 * before a user ever sees it.
 */
export interface ChatModelReply {
  readonly answered: boolean;
  readonly answer: string;
  readonly citedMealIds: readonly string[];
}

/** What the model is allowed to return on the explanation lane (TSD 3.3). */
export interface ExplanationReply {
  readonly mealId: string;
  readonly reason: string;
}
