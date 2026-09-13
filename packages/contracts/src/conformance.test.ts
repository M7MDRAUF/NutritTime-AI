import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

// Imported through the barrel on purpose: this is also T-02-08's import smoke test. A line
// dropped from index.ts, or a broken wire type, fails here rather than silently.
import {
  BUDGET_BANDS,
  CANONICAL_ALLERGENS,
  DATA_SOURCES,
  DIET_TAGS,
  MEAL_PERIODS,
  NUTRITION_GOALS,
  SCORE_REASON_KINDS,
  THEME_MODES,
  explanationReplySchema,
  ingredientSchema,
  kebabIdSchema,
  mealObjectSchema,
  mealSchema,
  moneySchema,
  nutritionProvenanceSchema,
  provenanceSchema,
  retrievalPreferencesSchema,
  userPreferencesSchema,
} from './index.js';
import type {
  ApiErrorBody,
  ChatResponse,
  HealthResponse,
  Meal,
  MealListResponse,
  RecommendationResponse,
  UserPreferences,
  ValueSchema,
} from './index.js';

/**
 * Two jobs.
 *
 * 1. Bind the schemas to the interfaces. Without this, adding a field to `Meal` breaks
 *    neither tsc nor a test - which is the exact divergence P02 exists to prevent.
 * 2. Cover the schemas that had no direct test of their own.
 */

describe('schema and interface stay bound', () => {
  it('mealSchema output is usable as a Meal, and covers every Meal field', () => {
    // Direction that matters at runtime: a parsed value is assignable to the interface.
    // This also catches a field added to Meal but not to the schema - the inferred type
    // would then be missing it and fail to compile.
    const reader: ValueSchema<Meal> = mealSchema;
    type Inferred = z.infer<typeof mealSchema>;
    const toMeal = (v: Inferred): Meal => v;
    expect(typeof reader.safeParse).toBe('function');
    expect(typeof toMeal).toBe('function');

    // The reverse direction cannot be asserted by assignment: the interfaces use readonly
    // arrays and Zod infers mutable ones, so Meal is not assignable to Inferred. The key
    // set is checked explicitly instead, which is what catches a field added to the schema
    // but not to the interface.
    expect(Object.keys(mealObjectSchema.shape).sort()).toEqual(
      [
        'allergenTags',
        'available',
        'catalogVersion',
        'description',
        'dietTags',
        'id',
        'imageUrl',
        'ingredients',
        'instructions',
        'mealPeriods',
        'name',
        'nutrition',
        'nutritionProvenance',
        'preparationMinutes',
        'price',
        'provenance',
        'source',
      ].sort(),
    );
  });

  it('userPreferencesSchema output is usable as UserPreferences', () => {
    const reader: ValueSchema<UserPreferences> = userPreferencesSchema;
    type Inferred = z.infer<typeof userPreferencesSchema>;
    const to = (v: Inferred): UserPreferences => v;
    expect(typeof reader.safeParse).toBe('function');
    expect(typeof to).toBe('function');
  });

  it('exposes the wire contracts through the barrel', () => {
    // Type-only imports vanish at runtime, so this asserts they resolve at compile time.
    const shapes: [MealListResponse, RecommendationResponse, ChatResponse, HealthResponse] = [
      { meals: [], page: 1, pageSize: 20, total: 0 },
      { mealPeriod: 'lunch', recommendations: [] },
      { answered: false, answer: 'no', citations: [], source: 'local' },
      { status: 'ok', catalogVersion: '1.0.0', mealCount: 0 },
    ];
    const err: ApiErrorBody = {
      error: { code: 'meal_not_found', message: 'not found', retryable: false },
    };
    expect(shapes).toHaveLength(4);
    expect(err.error.code).toBe('meal_not_found');
  });
});

describe('enumerations hold exactly the documented members', () => {
  // toEqual, not toHaveLength: a phase whose product is exact lists must assert the list.
  it('matches TSD 3.1 member for member', () => {
    expect(MEAL_PERIODS).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    expect(DIET_TAGS).toEqual([
      'regular',
      'vegetarian',
      'vegan',
      'halal-preference',
      'gluten-aware',
    ]);
    expect(NUTRITION_GOALS).toEqual(['balanced', 'high-protein', 'lower-calorie']);
    expect(BUDGET_BANDS).toEqual(['low', 'medium', 'high']);
    expect(THEME_MODES).toEqual(['system', 'light', 'dark']);
    expect(DATA_SOURCES).toEqual(['local', 'user']);
    expect(CANONICAL_ALLERGENS).toEqual([
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
    ]);
    expect(SCORE_REASON_KINDS).toEqual([
      'meal-period-match',
      'diet-match',
      'goal-match',
      'budget-match',
      'previous-like',
      'preparation-time-fit',
      'local-availability',
      'disliked-ingredient',
    ]);
  });
});

describe('schemas that had no direct test', () => {
  it('moneySchema: integer cents, USD only, bounded', () => {
    expect(moneySchema.safeParse({ amountCents: 1010, currency: 'USD' }).success).toBe(true);
    expect(moneySchema.safeParse({ amountCents: 10.5, currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: -1, currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: 100_001, currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountCents: 100, currency: 'EUR' }).success).toBe(false);
  });

  it('ingredientSchema: a name is required, a long measure is not rejected', () => {
    expect(ingredientSchema.safeParse({ name: 'garlic', measure: '3 cloves' }).success).toBe(true);
    expect(ingredientSchema.safeParse({ name: '', measure: 'x' }).success).toBe(false);
    // TheMealDB measures run long; TSD 3.3 leaves them unbounded, and a tighter cap here
    // would be a silent tripwire for P07 seeding.
    const long = '1 1/2 cups of finely chopped fresh flat-leaf parsley, plus extra to serve';
    expect(ingredientSchema.safeParse({ name: 'parsley', measure: long }).success).toBe(true);
  });

  it('kebabIdSchema: lowercase kebab only', () => {
    expect(kebabIdSchema.safeParse('meal-greek-yogurt-bowl').success).toBe(true);
    expect(kebabIdSchema.safeParse('Meal_One').success).toBe(false);
    expect(kebabIdSchema.safeParse('meal--two').success).toBe(false);
    expect(kebabIdSchema.safeParse('-leading').success).toBe(false);
  });

  it('provenanceSchema: numeric upstream id, http(s) URLs only', () => {
    const ok = {
      themealdbId: '52771',
      sourceUrl: 'https://example.com/r',
      imageSource: 'TheMealDB',
      licenceConfirmed: true,
    };
    expect(provenanceSchema.safeParse(ok).success).toBe(true);
    expect(provenanceSchema.safeParse({ ...ok, themealdbId: 'abc' }).success).toBe(false);
    // z.url() alone accepts any scheme that URL() parses.
    expect(provenanceSchema.safeParse({ ...ok, sourceUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(provenanceSchema.safeParse({ ...ok, sourceUrl: 'file:///etc/passwd' }).success).toBe(
      false,
    );
  });

  it('nutritionProvenanceSchema: known origins and a bounded serving count', () => {
    const base = { origin: 'user', dataset: null, servings: 4, reason: null };
    expect(nutritionProvenanceSchema.safeParse(base).success).toBe(true);
    expect(nutritionProvenanceSchema.safeParse({ ...base, origin: 'guessed' }).success).toBe(false);
    expect(nutritionProvenanceSchema.safeParse({ ...base, servings: 0 }).success).toBe(false);
    expect(nutritionProvenanceSchema.safeParse({ ...base, servings: 25 }).success).toBe(false);
  });

  it('retrievalPreferencesSchema: the narrow projection rejects goal and budget', () => {
    const p = { diet: 'vegan', allergies: [], dislikedIngredients: [] };
    expect(retrievalPreferencesSchema.safeParse(p).success).toBe(true);
    expect(retrievalPreferencesSchema.safeParse({ ...p, goal: 'balanced' }).success).toBe(false);
    expect(retrievalPreferencesSchema.safeParse({ ...p, budget: 'low' }).success).toBe(false);
  });

  it('explanationReplySchema: bounded prose tied to one meal', () => {
    const r = { mealId: 'meal-x', reason: 'High in protein and quick to make.' };
    expect(explanationReplySchema.safeParse(r).success).toBe(true);
    expect(explanationReplySchema.safeParse({ ...r, reason: 'a'.repeat(241) }).success).toBe(false);
    expect(explanationReplySchema.safeParse({ ...r, reason: '' }).success).toBe(false);
    // The model cannot smuggle a figure in through an extra field.
    expect(explanationReplySchema.safeParse({ ...r, calories: 500 }).success).toBe(false);
  });
});
