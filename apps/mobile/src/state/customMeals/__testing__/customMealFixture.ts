/**
 * The `CustomMeal` fixture builder and the state helpers `customMealsState.test.ts` is built on.
 *
 * Extracted for SQG-09: the suite reached 389 lines once the reference control set was added, and
 * three rounds of comment trimming had already taken everything that could go. The fixture is the
 * real unit here — 18 required fields, four of them nested objects, shared by every assertion — so
 * moving it is the extraction the rule asks for rather than a reshuffle to satisfy a number.
 * `shared/components/__testing__/iconSet.tsx` is the precedent for the location.
 *
 * **Every record this builds must satisfy `customMealSchema`.** A reducer test asserting against a
 * record the app can never hold proves nothing, and since P17 the reducer itself refuses an
 * unstorable record — so a fixture that drifted out of validity would silently turn half the suite
 * into assertions about the refusal path. `customMealsState.test.ts` parses the default record
 * through the schema before it asserts anything else, which is the guard against that drift.
 */

import type { CustomMeal } from '@nutritime/contracts';
import { STORAGE_BOUNDS } from '../../../infrastructure/storage/definitions.js';
import type { CustomMealsState } from '../customMealsState.js';

/**
 * A complete, schema-valid `CustomMeal`, with any one field varied.
 *
 * Nutrition is all-null with `origin: 'user'`: the case FR-006 permits, and the one the form
 * produces when the user leaves those fields blank. `id` is kebab-shaped, which a lowercase v4 UUID
 * also is, so a fixture id and a real one are the same shape to `kebabIdSchema`.
 */
export function customMeal(overrides: Partial<CustomMeal> = {}): CustomMeal {
  return {
    id: 'house-omelette',
    name: 'House omelette',
    description: 'Three eggs, folded.',
    mealPeriods: ['breakfast'],
    ingredients: [{ name: 'egg', measure: '3' }],
    instructions: ['Beat the eggs.', 'Fold in the pan.'],
    allergenTags: ['egg'],
    dietTags: ['vegetarian'],
    nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
    price: { amountCents: 450, currency: 'USD' },
    preparationMinutes: 10,
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
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...overrides,
  };
}

export function stateOf(...meals: readonly CustomMeal[]): CustomMealsState {
  return { meals };
}

export function idsOf(state: CustomMealsState): readonly string[] {
  return state.meals.map((meal) => meal.id);
}

/**
 * A list at exactly the storage bound, built rather than hoped for: the bound is only testable at
 * the bound. Sized from `STORAGE_BOUNDS.customMeals` rather than from the store's re-exported
 * `MAX_CUSTOM_MEALS`, so a retyped constant in the store fails a test instead of resizing the
 * fixture to match itself.
 */
export function fullState(): CustomMealsState {
  return stateOf(
    ...Array.from({ length: STORAGE_BOUNDS.customMeals }, (_unused, index) =>
      customMeal({ id: `meal-${String(index)}` }),
    ),
  );
}
