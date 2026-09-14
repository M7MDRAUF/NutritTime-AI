/**
 * The composition lane, tested directly (SQG-09 split).
 *
 * `mealFormValidation.test.ts` drives all of this through `composeCustomMeal` and
 * `composeCustomMealUpdate` and asserts the field-bound errors and the schema verdict — those
 * tests **stayed there**, because `composeCustomMeal` stayed there: it is the function CONTRACTS
 * §7 publishes, and a test of it is also the test that would catch a broken re-export.
 *
 * What is here is the lane on its own, reachable for the first time because `DraftValues` is now
 * a type a test can construct. That buys three things the form-level tests cannot state:
 *
 *  1. **`buildRecord` stamps FR-013's fixed fields rather than reading them**, asserted against a
 *     `DraftValues` that contains none of them.
 *  2. **`pickId` calls `newId` exactly five times before giving up** — countable here without a
 *     draft in the way.
 *  3. **`money()` really is the guard the comment claims**, which only a hand-built `DraftValues`
 *     can show, because `interpret` cannot produce a negative price to try it with.
 */

import { describe, expect, it } from 'vitest';
import { kebabIdSchema } from '@nutritime/contracts';
import { customMealSchema } from '../../infrastructure/storage/definitions.js';
import { createRecord, updateRecord } from './mealRecord.js';
import type { ComposeContext, DraftValues } from './mealRecord.js';

const NOW = '2026-09-13T08:30:00.000Z';
const LATER = '2026-09-14T19:05:00.000Z';
const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';

/** Nutrition unset — the common case, and it carries none of the fields `buildRecord` stamps. */
const VALUES: DraftValues = {
  name: 'Overnight oats',
  description: 'Oats soaked overnight in milk.',
  mealPeriods: ['breakfast'],
  dietTags: ['vegetarian'],
  allergenTags: ['milk'],
  ingredients: [{ name: 'Rolled oats', measure: '80 g' }],
  instructions: ['Combine the oats and milk.', 'Chill overnight.'],
  priceCents: 450,
  preparationMinutes: 10,
  nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
  servings: null,
};

function context(overrides: Partial<ComposeContext> = {}): ComposeContext {
  return { now: () => NOW, newId: () => ID_A, existingIds: [], ...overrides };
}

describe('createRecord', () => {
  it('produces a record customMealSchema accepts', () => {
    const result = createRecord(VALUES, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(customMealSchema.safeParse(result.meal).success).toBe(true);
    expect(kebabIdSchema.safeParse(result.meal.id).success).toBe(true);
  });

  it('stamps the fields FR-013 fixes, none of which are in DraftValues', () => {
    const result = createRecord(VALUES, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.source).toBe('user');
    expect(result.meal.available).toBe(true);
    expect(result.meal.imageUrl).toBeNull();
    expect(result.meal.provenance).toStrictEqual({
      themealdbId: null,
      sourceUrl: null,
      imageSource: null,
      licenceConfirmed: false,
    });
    expect(result.meal.nutritionProvenance).toStrictEqual({
      origin: 'user',
      dataset: null,
      servings: null,
      reason: null,
    });
  });

  it('carries every DraftValues field onto the record, unchanged', () => {
    const result = createRecord(VALUES, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.name).toBe(VALUES.name);
    expect(result.meal.description).toBe(VALUES.description);
    expect(result.meal.mealPeriods).toStrictEqual(VALUES.mealPeriods);
    expect(result.meal.dietTags).toStrictEqual(VALUES.dietTags);
    expect(result.meal.allergenTags).toStrictEqual(VALUES.allergenTags);
    expect(result.meal.ingredients).toStrictEqual(VALUES.ingredients);
    expect(result.meal.instructions).toStrictEqual(VALUES.instructions);
    expect(result.meal.preparationMinutes).toBe(VALUES.preparationMinutes);
    expect(result.meal.nutrition).toStrictEqual(VALUES.nutrition);
    expect(result.meal.price).toStrictEqual({ amountCents: 450, currency: 'USD' });
  });

  it('sets both timestamps to the same instant, from the injected clock only', () => {
    const result = createRecord(VALUES, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.createdAt).toBe(NOW);
    expect(result.meal.updatedAt).toBe(NOW);
  });

  it('carries a complete nutrition set and its serving count', () => {
    const result = createRecord(
      {
        ...VALUES,
        nutrition: { calories: 320, proteinGrams: 12, carbsGrams: 40, fatGrams: 9 },
        servings: 2,
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.nutritionProvenance.servings).toBe(2);
    expect(customMealSchema.safeParse(result.meal).success).toBe(true);
  });

  it('regenerates against existingIds and uses the fresh id', () => {
    const ids = [ID_A, ID_B];
    let call = 0;
    const result = createRecord(
      VALUES,
      context({ existingIds: [ID_A], newId: () => ids[call++] ?? ID_B }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meal.id).toBe(ID_B);
    }
    expect(call).toBe(2);
  });

  it('calls newId exactly five times, then gives up rather than colliding', () => {
    let call = 0;
    const result = createRecord(
      VALUES,
      context({
        existingIds: [ID_A],
        newId: () => {
          call += 1;
          return ID_A;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Not a field the user can fix, so the message says what happened. `customMeals/created`
      // refuses a duplicate id SILENTLY, which is why giving up beats returning one.
      expect(result.errors.name).toBeDefined();
    }
    expect(call).toBe(5);
  });

  it.each(['yesterday', '2026-02-31T00:00:00.000Z', '', '2026-09-13'])(
    'refuses a record the injected clock made unstorable: %s',
    (bad) => {
      const result = createRecord(VALUES, context({ now: () => bad }));
      expect(result.ok).toBe(false);
    },
  );

  it('refuses an id kebabIdSchema would reject, so the backstop is not only about timestamps', () => {
    const result = createRecord(VALUES, context({ newId: () => 'NOT_A_KEBAB_ID' }));
    expect(result.ok).toBe(false);
  });

  it('throws on a negative price, which is what makes money() the guard the comment claims', () => {
    // `interpret` cannot produce this, so only a hand-built `DraftValues` can prove the guard is
    // live rather than decorative. A silently rounded or negative price is a lie the rest of the
    // system cannot detect (TSD §4.2).
    expect(() => createRecord({ ...VALUES, priceCents: -1 }, context())).toThrow(RangeError);
    expect(() => createRecord({ ...VALUES, priceCents: 4.5 }, context())).toThrow(RangeError);
  });
});

describe('updateRecord', () => {
  function existing() {
    const result = createRecord(VALUES, context());
    if (!result.ok) throw new Error('fixture did not compose');
    return result.meal;
  }

  it('keeps id and createdAt and moves updatedAt', () => {
    const before = existing();
    const result = updateRecord({ ...VALUES, name: 'Renamed oats' }, before, { now: () => LATER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.id).toBe(before.id);
    expect(result.meal.createdAt).toBe(NOW);
    expect(result.meal.updatedAt).toBe(LATER);
    expect(result.meal.name).toBe('Renamed oats');
    expect(customMealSchema.safeParse(result.meal).success).toBe(true);
  });

  it('never asks for a new id, so an edit cannot move a record out from under a favourite', () => {
    const before = existing();
    const result = updateRecord(VALUES, before, { now: () => LATER });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meal.id).toBe(ID_A);
    }
  });

  it('applies the same backstop as a create', () => {
    const result = updateRecord(VALUES, existing(), { now: () => 'not a timestamp' });
    expect(result.ok).toBe(false);
  });
});
