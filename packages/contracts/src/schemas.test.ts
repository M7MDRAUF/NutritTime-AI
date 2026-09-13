import { describe, expect, it } from 'vitest';
import { CANONICAL_ALLERGENS, DIET_TAGS, MEAL_PERIODS, SCORE_REASON_KINDS } from './core.js';
import { API_ERROR_CODES, API_ERROR_RETRYABLE, API_ERROR_STATUS } from './errors.js';
import {
  chatModelReplySchema,
  chatRequestSchema,
  clockTimeSchema,
  mealSchema,
  nutritionSummarySchema,
  recommendationRequestSchema,
  userPreferencesSchema,
} from './schemas.js';

/**
 * Every schema gets an acceptance test AND a rejection test. A schema that has only ever
 * been shown to accept valid input has not been shown to do anything: its job is refusing.
 */

const validMeal = {
  id: 'meal-spicy-arrabiata-penne',
  name: 'Spicy Arrabiata Penne',
  description: 'Italian vegetarian pasta',
  mealPeriods: ['lunch', 'dinner'],
  ingredients: [{ name: 'penne rigate', measure: '1 pound' }],
  instructions: ['Boil the pasta.'],
  allergenTags: ['gluten', 'wheat'],
  dietTags: ['vegetarian'],
  nutrition: { calories: 540, proteinGrams: 18, carbsGrams: 82, fatGrams: 14 },
  price: { amountCents: 1010, currency: 'USD' },
  preparationMinutes: 22,
  imageUrl: 'https://www.themealdb.com/images/media/meals/x.jpg',
  available: true,
  source: 'local',
  catalogVersion: '1.0.0',
  provenance: {
    themealdbId: '52771',
    sourceUrl: 'https://example.com/recipe',
    imageSource: 'TheMealDB',
    licenceConfirmed: true,
  },
  nutritionProvenance: {
    origin: 'usda-derived',
    dataset: 'FNDDS 2022-10-28',
    servings: 4,
    reason: null,
  },
};

const meal = (patch: Record<string, unknown>) => ({ ...validMeal, ...patch });

describe('enumerations', () => {
  it('carries exactly the ten canonical allergens', () => {
    expect(CANONICAL_ALLERGENS).toHaveLength(10);
    expect(CANONICAL_ALLERGENS).toContain('peanut');
    expect(CANONICAL_ALLERGENS).toContain('sesame');
  });

  it('carries four meal periods, five diet tags and eight score reasons', () => {
    expect(MEAL_PERIODS).toHaveLength(4);
    expect(DIET_TAGS).toHaveLength(5);
    expect(SCORE_REASON_KINDS).toHaveLength(8);
  });

  it('gives every error code a status and a retryability', () => {
    expect(API_ERROR_CODES).toHaveLength(5);
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(typeof API_ERROR_RETRYABLE[code]).toBe('boolean');
    }
    // Only the two transient failures are retryable.
    expect(API_ERROR_RETRYABLE.ai_unavailable).toBe(true);
    expect(API_ERROR_RETRYABLE.ai_busy).toBe(true);
    expect(API_ERROR_RETRYABLE.ai_disabled).toBe(false);
  });
});

describe('nutritionSummarySchema range bounds', () => {
  it('accepts values inside the bounds and null', () => {
    expect(
      nutritionSummarySchema.safeParse({
        calories: 540,
        proteinGrams: 18,
        carbsGrams: 82,
        fatGrams: 14,
      }).success,
    ).toBe(true);
    expect(
      nutritionSummarySchema.safeParse({
        calories: null,
        proteinGrams: null,
        carbsGrams: null,
        fatGrams: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['calories above 2000', { calories: 2001 }],
    ['negative protein', { proteinGrams: -1 }],
    ['non-integer fat', { fatGrams: 1.5 }],
    ['carbs above 300', { carbsGrams: 301 }],
  ])('rejects %s', (_label, patch) => {
    const value = { calories: 1, proteinGrams: 1, carbsGrams: 1, fatGrams: 1, ...patch };
    expect(nutritionSummarySchema.safeParse(value).success).toBe(false);
  });
});

describe('mealSchema', () => {
  it('accepts a well-formed record', () => {
    expect(mealSchema.safeParse(validMeal).success).toBe(true);
  });

  it('rejects an unknown extra field', () => {
    expect(mealSchema.safeParse(meal({ calories: 900 })).success).toBe(false);
  });

  it.each([
    ['a non-kebab id', { id: 'Meal_One' }],
    ['an empty ingredient list', { ingredients: [] }],
    ['no meal period', { mealPeriods: [] }],
    ['no diet tag', { dietTags: [] }],
    ['a negative preparation time', { preparationMinutes: -1 }],
    ['a non-url image', { imageUrl: 'not-a-url' }],
    ['a non-numeric themealdbId', { provenance: { ...validMeal.provenance, themealdbId: 'abc' } }],
  ])('rejects %s', (_label, patch) => {
    expect(mealSchema.safeParse(meal(patch)).success).toBe(false);
  });

  // The all-or-nothing rule (TSD 7.4). This is the reason the superRefine exists.
  it('rejects partially known nutrition', () => {
    const result = mealSchema.safeParse(
      meal({ nutrition: { calories: 540, proteinGrams: null, carbsGrams: 82, fatGrams: 14 } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects usda-derived without a dataset or serving count', () => {
    expect(
      mealSchema.safeParse(
        meal({
          nutritionProvenance: { origin: 'usda-derived', dataset: null, servings: 4, reason: null },
        }),
      ).success,
    ).toBe(false);
    expect(
      mealSchema.safeParse(
        meal({
          nutritionProvenance: {
            origin: 'usda-derived',
            dataset: 'FNDDS',
            servings: null,
            reason: null,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts unavailable nutrition only when all four are null and a reason is given', () => {
    const allNull = { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null };
    expect(
      mealSchema.safeParse(
        meal({
          nutrition: allNull,
          nutritionProvenance: {
            origin: 'unavailable',
            dataset: null,
            servings: null,
            reason: 'ingredient "garam masala" did not resolve',
          },
        }),
      ).success,
    ).toBe(true);

    // ...and refuses it without a reason, so "unknown" is always explained.
    expect(
      mealSchema.safeParse(
        meal({
          nutrition: allNull,
          nutritionProvenance: {
            origin: 'unavailable',
            dataset: null,
            servings: null,
            reason: null,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

describe('clockTimeSchema', () => {
  it.each(['00:00', '08:00', '13:05', '23:59'])('accepts %s', (value) => {
    expect(clockTimeSchema.safeParse(value).success).toBe(true);
  });

  it.each(['24:00', '8:00', '08:60', '0800', '8am', ''])('rejects %s', (value) => {
    expect(clockTimeSchema.safeParse(value).success).toBe(false);
  });
});

describe('userPreferencesSchema', () => {
  const prefs = {
    schemaVersion: 1,
    diet: 'vegetarian',
    allergies: ['peanut'],
    goal: 'high-protein',
    budget: 'medium',
    dislikedIngredients: ['mushroom'],
    mealTimes: { breakfast: '08:00', lunch: '13:00', dinner: '19:00' },
    aiEnabled: true,
    themeMode: 'system',
  };

  it('accepts a complete profile and an optional name', () => {
    expect(userPreferencesSchema.safeParse(prefs).success).toBe(true);
    expect(userPreferencesSchema.safeParse({ ...prefs, name: 'Sam' }).success).toBe(true);
  });

  it('rejects an unknown diet and a malformed meal time', () => {
    expect(userPreferencesSchema.safeParse({ ...prefs, diet: 'keto' }).success).toBe(false);
    expect(
      userPreferencesSchema.safeParse({
        ...prefs,
        mealTimes: { breakfast: '8:00', lunch: '13:00', dinner: '19:00' },
      }).success,
    ).toBe(false);
  });
});

describe('chatRequestSchema', () => {
  const body = {
    question: 'Which of these is quickest to prepare?',
    preferences: { diet: 'vegetarian', allergies: ['peanut'], dislikedIngredients: ['mushroom'] },
  };

  it('accepts the narrow preference projection', () => {
    expect(chatRequestSchema.safeParse(body).success).toBe(true);
  });

  // goal and budget are rejected on purpose: retrieval does not read them, and a required
  // field that changes nothing is a field that will eventually be believed (TSD 5.4).
  it('rejects goal and budget', () => {
    expect(
      chatRequestSchema.safeParse({
        ...body,
        preferences: { ...body.preferences, goal: 'high-protein' },
      }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        ...body,
        preferences: { ...body.preferences, budget: 'medium' },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty question and one over 500 characters', () => {
    expect(chatRequestSchema.safeParse({ ...body, question: '   ' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ ...body, question: 'a'.repeat(501) }).success).toBe(false);
  });
});

describe('recommendationRequestSchema', () => {
  const body = {
    mealPeriod: 'lunch',
    aiEnabled: true,
    preferences: {
      diet: 'vegetarian',
      allergies: ['peanut'],
      goal: 'high-protein',
      budget: 'medium',
      dislikedIngredients: ['mushroom'],
    },
    favoriteMealIds: ['meal-greek-yogurt-bowl'],
  };

  it('accepts a client-supplied meal period', () => {
    expect(recommendationRequestSchema.safeParse(body).success).toBe(true);
  });

  // The server holds no clock, so a timestamp has nowhere to go (TSD 5.4).
  it('rejects a timestamp or mealTimes on the wire', () => {
    expect(
      recommendationRequestSchema.safeParse({ ...body, requestTime: '2026-09-13T12:00:00Z' })
        .success,
    ).toBe(false);
    expect(
      recommendationRequestSchema.safeParse({
        ...body,
        preferences: { ...body.preferences, mealTimes: { breakfast: '08:00' } },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown meal period', () => {
    expect(recommendationRequestSchema.safeParse({ ...body, mealPeriod: 'brunch' }).success).toBe(
      false,
    );
  });
});

describe('chatModelReplySchema', () => {
  const reply = { answered: true, answer: 'The bowl is quickest at 5 minutes.', citedMealIds: [] };

  it('accepts a well-formed reply', () => {
    expect(chatModelReplySchema.safeParse(reply).success).toBe(true);
  });

  it('rejects a 701-character answer and a sixth citation', () => {
    expect(chatModelReplySchema.safeParse({ ...reply, answer: 'a'.repeat(701) }).success).toBe(
      false,
    );
    expect(
      chatModelReplySchema.safeParse({ ...reply, citedMealIds: ['a', 'b', 'c', 'd', 'e', 'f'] })
        .success,
    ).toBe(false);
  });

  it('rejects an extra field, so the model cannot smuggle one in', () => {
    expect(chatModelReplySchema.safeParse({ ...reply, calories: 500 }).success).toBe(false);
  });
});

describe('nutrition origin is constrained in both directions (TSD 7.4)', () => {
  const allNull = { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null };

  // The first version of this rule only constrained `unavailable`, so a catalog record
  // could ship all-null nutrition with no explanation at all.
  it('rejects a catalog record with no values and no reason', () => {
    expect(
      mealSchema.safeParse(
        meal({
          nutrition: allNull,
          nutritionProvenance: { origin: 'user', dataset: null, servings: null, reason: null },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a catalog record claiming user-authored nutrition', () => {
    expect(
      mealSchema.safeParse(
        meal({
          source: 'local',
          nutritionProvenance: { origin: 'user', dataset: null, servings: 4, reason: null },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects a derived record that also carries a reason', () => {
    expect(
      mealSchema.safeParse(
        meal({
          nutritionProvenance: {
            origin: 'usda-derived',
            dataset: 'FNDDS 2022-10-28',
            servings: 4,
            reason: 'oops',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects an unavailable record that carries a dataset or serving count', () => {
    const unavailable = (patch: Record<string, unknown>) =>
      mealSchema.safeParse(
        meal({
          nutrition: allNull,
          nutritionProvenance: {
            origin: 'unavailable',
            dataset: null,
            servings: null,
            reason: 'ingredient did not resolve',
            ...patch,
          },
        }),
      ).success;
    expect(unavailable({ dataset: 'FNDDS' })).toBe(false);
    expect(unavailable({ servings: 4 })).toBe(false);
    expect(unavailable({})).toBe(true);
  });

  it('accepts a user meal with no nutrition, and rejects values without a serving count', () => {
    const userMeal = (nutrition: unknown, servings: number | null) =>
      mealSchema.safeParse(
        meal({
          source: 'user',
          nutrition,
          nutritionProvenance: { origin: 'user', dataset: null, servings, reason: null },
        }),
      ).success;
    expect(userMeal(allNull, null)).toBe(true);
    expect(userMeal({ calories: 400, proteinGrams: 10, carbsGrams: 40, fatGrams: 12 }, 2)).toBe(
      true,
    );
    expect(userMeal({ calories: 400, proteinGrams: 10, carbsGrams: 40, fatGrams: 12 }, null)).toBe(
      false,
    );
  });
});
