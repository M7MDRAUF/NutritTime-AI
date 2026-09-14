import { describe, expect, it } from 'vitest';
import { userPreferencesSchema } from '@nutritime/contracts';
import type { CustomMeal } from '@nutritime/contracts';
import { QUARANTINE_KEY } from './envelope.js';
import {
  CUSTOM_MEAL_CATALOG_VERSION,
  DEFAULT_META,
  DEFAULT_ONBOARDING,
  DEFAULT_PREFERENCES,
  DEFAULT_UI,
  STORAGE_BOUNDS,
  STORAGE_DEFINITIONS,
  STORAGE_KEYS,
  STORAGE_KEY_NAMES,
  UI_TABS,
  customMealSchema,
} from './definitions.js';

const AT = '2026-09-13T10:00:00.000Z';

/** A minimal valid custom meal: user-authored, and with nutrition left unset (PRD FR-006). */
function customMeal(overrides: Partial<CustomMeal> = {}): CustomMeal {
  return {
    id: 'my-lentil-soup',
    name: 'My lentil soup',
    description: 'Weeknight batch.',
    mealPeriods: ['dinner'],
    ingredients: [{ name: 'red lentils', measure: '200 g' }],
    instructions: ['Simmer everything for 25 minutes.'],
    allergenTags: [],
    dietTags: ['vegan'],
    nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
    price: { amountCents: 220, currency: 'USD' },
    preparationMinutes: 30,
    imageUrl: null,
    available: true,
    source: 'user',
    provenance: {
      themealdbId: null,
      sourceUrl: null,
      imageSource: null,
      licenceConfirmed: false,
    },
    nutritionProvenance: { origin: 'user', dataset: null, servings: null, reason: null },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe('the key table', () => {
  it('declares the six keys TSD 6.4 names, and the quarantine key beside them', () => {
    expect(STORAGE_KEYS).toEqual({
      meta: '@nutritime/meta',
      onboarding: '@nutritime/onboarding',
      preferences: '@nutritime/preferences/v1',
      favorites: '@nutritime/favorites/v1',
      customMeals: '@nutritime/custom-meals/v1',
      ui: '@nutritime/ui/v1',
    });
    expect(QUARANTINE_KEY).toBe('@nutritime/quarantine/v1');
  });

  it('has a definition for every key and a key for every definition', () => {
    expect(Object.keys(STORAGE_DEFINITIONS).sort()).toEqual(Object.keys(STORAGE_KEYS).sort());
    expect([...STORAGE_KEY_NAMES].sort()).toEqual(Object.keys(STORAGE_KEYS).sort());
  });

  it('points each definition at its own key', () => {
    for (const name of STORAGE_KEY_NAMES) {
      expect(STORAGE_DEFINITIONS[name].key).toBe(STORAGE_KEYS[name]);
    }
  });

  it('bounds exactly the two keys TSD 6.4 bounds, at 200 each', () => {
    expect(STORAGE_BOUNDS).toEqual({ favorites: 200, customMeals: 200 });
    const bounded = STORAGE_KEY_NAMES.filter(
      (name): boolean => STORAGE_DEFINITIONS[name].bound !== undefined,
    );
    expect(bounded).toEqual(['favorites', 'customMeals']);
  });

  it('returns the value itself from `bound` when it fits — the write refusal depends on it', () => {
    const favorites = STORAGE_DEFINITIONS.favorites.bound;
    const within = ['a', 'b'];
    expect(favorites?.(within)).toBe(within);
    const over = Array.from({ length: STORAGE_BOUNDS.favorites + 1 }, (_unused, i) => String(i));
    expect(favorites?.(over)).not.toBe(over);
    expect(favorites?.(over)).toHaveLength(STORAGE_BOUNDS.favorites);
  });
});

describe('fallbacks', () => {
  it('produces a value its own schema accepts, for every key', () => {
    // A fallback its own schema rejects would quarantine itself on the next read.
    for (const name of STORAGE_KEY_NAMES) {
      const definition = STORAGE_DEFINITIONS[name];
      expect(definition.schema.safeParse(definition.fallback()).success, name).toBe(true);
    }
  });

  it('needs no clock: `meta` defaults to two nulls rather than "now"', () => {
    expect(DEFAULT_META).toEqual({ firstLaunchAt: null, lastLaunchAt: null });
  });

  it('starts onboarding incomplete and the disclaimer unacknowledged', () => {
    expect(DEFAULT_ONBOARDING).toEqual({ completed: false });
    expect(DEFAULT_UI).toEqual({ lastTab: null, disclaimerAcknowledged: false });
  });
});

describe('DEFAULT_PREFERENCES (A-09, plan-introduced)', () => {
  it('satisfies the contracts schema', () => {
    expect(userPreferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true);
  });

  it('stores no name, because nothing has told it one', () => {
    expect('name' in DEFAULT_PREFERENCES).toBe(false);
  });

  it('assumes no restriction: no diet, no allergy, no dislike', () => {
    // An assumed allergy hides food the user can eat and teaches them to distrust the filter.
    expect(DEFAULT_PREFERENCES.diet).toBe('regular');
    expect(DEFAULT_PREFERENCES.allergies).toEqual([]);
    expect(DEFAULT_PREFERENCES.dislikedIngredients).toEqual([]);
  });

  it('anchors meal times so the TSD 4.3 windows cover the ordinary day', () => {
    expect(DEFAULT_PREFERENCES.mealTimes).toEqual({
      breakfast: '08:00',
      lunch: '12:30',
      dinner: '19:00',
    });
  });

  it('matches app.json on theme and leaves the assistant on', () => {
    expect(DEFAULT_PREFERENCES.themeMode).toBe('system');
    expect(DEFAULT_PREFERENCES.aiEnabled).toBe(true);
  });
});

describe('customMealSchema — X-14', () => {
  it('accepts a user-authored meal with no nutrition at all', () => {
    // "Nutrition optional" (TSD 3.2) means "may be wholly null", and `mealSchema`'s `user`
    // branch already permits it. That is the prose half of X-14.
    const parsed = customMealSchema.safeParse(customMeal());
    expect(parsed.success && parsed.data).toEqual(customMeal());
  });

  it('accepts a user-authored meal with complete nutrition and a serving count', () => {
    const meal = customMeal({
      nutrition: { calories: 420, proteinGrams: 18, carbsGrams: 60, fatGrams: 9 },
      nutritionProvenance: { origin: 'user', dataset: null, servings: 4, reason: null },
    });
    expect(customMealSchema.safeParse(meal).success).toBe(true);
  });

  it('carries no catalogVersion out, and never stores the placeholder it borrowed', () => {
    const parsed = customMealSchema.safeParse(customMeal());
    expect(parsed.success && 'catalogVersion' in parsed.data).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(CUSTOM_MEAL_CATALOG_VERSION);
  });

  it.each<[string, Record<string, unknown>]>([
    ['no createdAt', { createdAt: undefined }],
    ['a createdAt that is not a timestamp', { createdAt: 'yesterday' }],
    ['a catalog source', { source: 'local' }],
    ['an empty ingredient list', { ingredients: [] }],
    ['a negative price', { price: { amountCents: -1, currency: 'USD' } }],
    [
      'a calorie count past the range bound',
      {
        nutrition: { calories: 99_999, proteinGrams: 1, carbsGrams: 1, fatGrams: 1 },
        nutritionProvenance: { origin: 'user', dataset: null, servings: 2, reason: null },
      },
    ],
    [
      'half-known nutrition',
      {
        nutrition: { calories: 400, proteinGrams: null, carbsGrams: null, fatGrams: null },
      },
    ],
    [
      'nutrition values with no serving count',
      {
        nutrition: { calories: 400, proteinGrams: 10, carbsGrams: 40, fatGrams: 5 },
      },
    ],
    [
      'a nutritionProvenance origin that contradicts the source',
      {
        nutritionProvenance: { origin: 'unavailable', dataset: null, servings: null, reason: 'x' },
      },
    ],
  ])('refuses %s', (_name, overrides) => {
    // Every rule above is `mealSchema`'s, reached by delegation. None is restated here, which is
    // the point: Plan 12.3 calls a duplicated definition a gate failure.
    expect(customMealSchema.safeParse({ ...customMeal(), ...overrides }).success).toBe(false);
  });

  it('refuses a value that is not an object at all', () => {
    for (const value of [null, 'meal', 7, [], undefined]) {
      expect(customMealSchema.safeParse(value).success).toBe(false);
    }
  });

  it('refuses an unknown field, because mealSchema is strict', () => {
    expect(customMealSchema.safeParse({ ...customMeal(), calories: 400 }).success).toBe(false);
  });
});

describe('the plan-introduced schemas', () => {
  it('accepts and rejects a stored `ui` record on its tab list', () => {
    const schema = STORAGE_DEFINITIONS.ui.schema;
    for (const tab of UI_TABS) {
      expect(schema.safeParse({ lastTab: tab, disclaimerAcknowledged: true }).success).toBe(true);
    }
    expect(schema.safeParse({ lastTab: null, disclaimerAcknowledged: false }).success).toBe(true);
    expect(schema.safeParse({ lastTab: 'HomeTab', disclaimerAcknowledged: false }).success).toBe(
      false,
    );
    expect(schema.safeParse({ lastTab: null }).success).toBe(false);
  });

  it('accepts a favourites list of ids and refuses anything else', () => {
    const schema = STORAGE_DEFINITIONS.favorites.schema;
    expect(schema.safeParse(['meal-a', 'meal-b']).success).toBe(true);
    // A duplicate is a shape this schema can represent. Quarantining would cost the user every
    // favourite to fix one they cannot see.
    expect(schema.safeParse(['meal-a', 'meal-a']).success).toBe(true);
    expect(schema.safeParse(['meal-a', 7]).success).toBe(false);
    expect(schema.safeParse(['']).success).toBe(false);
    expect(schema.safeParse('meal-a').success).toBe(false);
  });

  it('refuses a custom-meals list containing one invalid meal', () => {
    const schema = STORAGE_DEFINITIONS.customMeals.schema;
    expect(schema.safeParse([customMeal(), customMeal({ id: 'second-meal' })]).success).toBe(true);
    expect(schema.safeParse([customMeal(), { id: 'broken' }]).success).toBe(false);
  });

  it('accepts a `meta` record with either instant unset', () => {
    const schema = STORAGE_DEFINITIONS.meta.schema;
    expect(schema.safeParse({ firstLaunchAt: AT, lastLaunchAt: AT }).success).toBe(true);
    expect(schema.safeParse({ firstLaunchAt: null, lastLaunchAt: AT }).success).toBe(true);
    expect(schema.safeParse({ firstLaunchAt: 'soon', lastLaunchAt: AT }).success).toBe(false);
  });
});
