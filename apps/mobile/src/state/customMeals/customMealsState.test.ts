import { describe, expect, it } from 'vitest';
import type { CustomMeal } from '@nutritime/contracts';
import {
  STORAGE_BOUNDS,
  STORAGE_DEFINITIONS,
  customMealSchema,
} from '../../infrastructure/storage/definitions.js';
import {
  MAX_CUSTOM_MEALS,
  customMealsActions,
  customMealsReducer,
  customMealsStoreConfig,
  hasCustomMeal,
  selectAtCustomMealsBound,
  selectCustomMeal,
  selectCustomMeals,
} from './customMealsState.js';
import type { CustomMealsAction, CustomMealsState } from './customMealsState.js';
import { customMeal, fullState, idsOf, stateOf } from './__testing__/customMealFixture.js';

/**
 * T-17-01. The store that holds the only records in this app the user authored themselves.
 *
 * T-17-01's acceptance is "Create, update, delete, list"; T-17-07's is "At 200, refused with a clear
 * message". Both are properties of this reducer, and every no-op branch is asserted as **identity**
 * (`toBe`): TSD §6.3 invariant 3 is what suppresses the re-render *and* the storage write, and
 * `toEqual` cannot see it. The bound assertions are built from `STORAGE_BOUNDS.customMeals` rather
 * than `MAX_CUSTOM_MEALS`, because comparing the module's constant against itself would stay green
 * if somebody retyped the number.
 */

/** Storage's own bound for this key, so the two can be compared instead of assumed to agree. */
function storageBoundOf(meals: readonly CustomMeal[]): readonly CustomMeal[] {
  const bound = STORAGE_DEFINITIONS.customMeals.bound;
  if (bound === undefined) {
    throw new Error('the customMeals definition has no bound; the agreement cannot be checked');
  }
  return bound(meals);
}

/**
 * **The control set, and every `toBe` in this file depends on it.**
 *
 * A reducer that mutated `state.meals` in place and returned `state` from every branch passed all
 * 26 assertions here before this block existed — V9 proved it with a module swap. `toBe` only means
 * something beside a `not.toBe`: one says an idempotent action must not allocate, the other says a
 * real change must. The allocation IS the re-render and the storage write, so a reducer that stopped
 * allocating would leave an edit on screen and never write it to disk.
 *
 * Each case also asserts the input state is **unmutated** afterwards, which catches the subtler
 * mutant: allocate a fresh wrapper, mutate the array inside it.
 */
describe('the control set: a real change must NOT preserve the reference', () => {
  const held = customMeal({ name: 'Before' });
  const cases: readonly (readonly [string, CustomMealsState, CustomMealsAction])[] = [
    ['a first create', stateOf(), customMealsActions.create(customMeal())],
    // Same id, different name: a real edit, and the only one of the four that replaces rather than
    // lengthens or shortens the list — so it is the case an in-place mutation hides best.
    [
      'an update that changes a field',
      stateOf(held),
      customMealsActions.update(customMeal({ name: 'After' })),
    ],
    ['a delete of a present id', stateOf(held), customMealsActions.remove(held.id)],
    ['a clear of a non-empty list', stateOf(held), customMealsActions.clear()],
  ];

  it.each(cases)(
    '%s allocates, and leaves the previous state untouched',
    (_label, state, action) => {
      const namesBefore = state.meals.map((meal) => meal.name);
      const next = customMealsReducer(state, action);
      expect(next).not.toBe(state);
      expect(next.meals).not.toBe(state.meals);
      expect(state.meals.map((meal) => meal.name)).toStrictEqual(namesBefore);
    },
  );
});

describe('action creators (TSD §6.3 invariants 1 and 2)', () => {
  it('namespace every type as slice/verb-past-tense, over a fixture the schema accepts', () => {
    // The strings are the contract other modules dispatch against; a rename here is a silent
    // break in `MealFormScreen` and `SettingsScreen`, which this file cannot see. The fixture is
    // checked here so that a failure anywhere below is the change under test, not the data.
    expect(customMealSchema.safeParse(customMeal()).success).toBe(true);
    expect(customMealsActions.create(customMeal()).type).toBe('customMeals/created');
    expect(customMealsActions.update(customMeal()).type).toBe('customMeals/updated');
    expect(customMealsActions.remove('house-omelette').type).toBe('customMeals/deleted');
    expect(customMealsActions.clear().type).toBe('customMeals/cleared');
  });
});

describe('customMeals/created', () => {
  it('appends to the END, untouched, because the array order is the user list order', () => {
    const meal = customMeal({ id: 'meal-b' });
    const first = stateOf(customMeal({ id: 'meal-a' }));
    const next = customMealsReducer(first, customMealsActions.create(meal));
    expect(idsOf(next)).toStrictEqual(['meal-a', 'meal-b']);
    // The reducer stamps nothing and copies nothing: the stored record IS the composed record.
    expect(next.meals[1]).toBe(meal);
  });

  it('REFUSES an id already present, and returns state identically rather than replacing', () => {
    // The load-bearing branch. A create is not an update: replacing the record the user authored
    // would destroy it with nothing on screen to say so. It is also the id-collision containment
    // for `generateMealId`, which may fall back to `Math.random` on a Hermes device.
    const original = customMeal({ name: 'House omelette' });
    const state = stateOf(original);
    const collision = customMeal({ name: 'Something else entirely' });

    const next = customMealsReducer(state, customMealsActions.create(collision));

    expect(next).toBe(state);
    expect(next.meals).toHaveLength(1);
    // Asserted on the record, not only on the reference: the user's meal is still theirs.
    expect(next.meals[0]).toBe(original);
    expect(selectCustomMeal(next, 'house-omelette')?.name).toBe('House omelette');
  });

  it('refuses at the storage bound, and returns state identically', () => {
    // Why this is the guard rather than `saveBlocked`: `repository.set` does not re-validate, so a
    // store able to hold 201 would persist 201, and the next launch would quarantine the whole key
    // — every custom meal lost to contain one.
    const state = fullState();
    expect(state.meals).toHaveLength(STORAGE_BOUNDS.customMeals);

    const next = customMealsReducer(
      state,
      customMealsActions.create(customMeal({ id: 'one-too-many' })),
    );

    expect(next).toBe(state);
    expect(hasCustomMeal(next, 'one-too-many')).toBe(false);
  });

  it('accepts the record that fills the list exactly, so the bound is not off by one', () => {
    // Without this, `length > MAX` and `length >= MAX` both pass the test above — and one of the
    // two costs the user their 200th meal.
    const state = stateOf(...fullState().meals.slice(0, STORAGE_BOUNDS.customMeals - 1));
    const next = customMealsReducer(state, customMealsActions.create(customMeal({ id: 'last' })));
    expect(next.meals).toHaveLength(STORAGE_BOUNDS.customMeals);
    expect(hasCustomMeal(next, 'last')).toBe(true);
  });
});

describe('customMeals/updated', () => {
  it('replaces IN PLACE, so a record never jumps position while the user looks at it', () => {
    const state = stateOf(
      customMeal({ id: 'meal-a' }),
      customMeal({ id: 'meal-b', name: 'Before' }),
      customMeal({ id: 'meal-c' }),
    );
    const edited = customMeal({
      id: 'meal-b',
      name: 'After',
      updatedAt: '2026-09-14T08:30:00.000Z',
    });

    const next = customMealsReducer(state, customMealsActions.update(edited));

    expect(idsOf(next)).toStrictEqual(['meal-a', 'meal-b', 'meal-c']);
    expect(next.meals[1]).toBe(edited);
    // The siblings are not re-created either: an edit must not invalidate every row's identity.
    expect(next.meals[0]).toBe(state.meals[0]);
    expect(next.meals[2]).toBe(state.meals[2]);
  });

  it('returns state identically for an id that is not present', () => {
    // Inserting instead would turn a lost edit into a duplicate record, and a stale deep link into
    // a meal the user never created.
    const state = stateOf(customMeal({ id: 'meal-a' }));
    const next = customMealsReducer(
      state,
      customMealsActions.update(customMeal({ id: 'deleted-elsewhere' })),
    );
    expect(next).toBe(state);
    expect(idsOf(next)).toStrictEqual(['meal-a']);
  });

  it('returns state identically when handed the very record it already holds', () => {
    const meal = customMeal();
    const state = stateOf(meal);
    expect(customMealsReducer(state, customMealsActions.update(meal))).toBe(state);
  });

  it('projects the same reference after a no-op, or every no-op would still queue a write', () => {
    const state = fullState();
    const before = customMealsStoreConfig.project(state);
    const next = customMealsReducer(state, customMealsActions.update(customMeal({ id: 'absent' })));
    // Same projected reference ⇒ the queue in `createStore` has nothing new to write.
    expect(customMealsStoreConfig.project(next)).toBe(before);
  });
});

describe('customMeals/deleted', () => {
  it('removes only the named record, leaving order intact', () => {
    const state = stateOf(
      customMeal({ id: 'meal-a' }),
      customMeal({ id: 'meal-b' }),
      customMeal({ id: 'meal-c' }),
    );
    const next = customMealsReducer(state, customMealsActions.remove('meal-b'));
    expect(idsOf(next)).toStrictEqual(['meal-a', 'meal-c']);
  });

  it('returns state identically for an absent id', () => {
    const state = stateOf(customMeal({ id: 'meal-a' }));
    expect(customMealsReducer(state, customMealsActions.remove('never-existed'))).toBe(state);
  });

  it('removes EVERY entry under a duplicated id, so a stored duplicate is not undeletable', () => {
    // `customMealsSchema` does not treat a duplicate id as corruption, so two entries under one id
    // can arrive from disk — and a delete leaving one behind leaves a record the user cannot reach,
    // cannot edit and cannot remove.
    const state = stateOf(
      customMeal({ id: 'twin', name: 'First' }),
      customMeal({ id: 'twin', name: 'Second' }),
    );
    const next = customMealsReducer(state, customMealsActions.remove('twin'));
    expect(next.meals).toStrictEqual([]);
  });
});

describe('customMeals/cleared', () => {
  it('empties a populated list', () => {
    const next = customMealsReducer(stateOf(customMeal()), customMealsActions.clear());
    expect(next.meals).toStrictEqual([]);
  });

  it('returns state identically when the list is already empty', () => {
    const state = stateOf();
    expect(customMealsReducer(state, customMealsActions.clear())).toBe(state);
  });
});

describe('selectors', () => {
  it('list, find and membership read the stored list without copying it', () => {
    const meal = customMeal();
    const state = stateOf(meal);
    expect(selectCustomMeals(state)).toBe(state.meals);
    expect(selectCustomMeal(state, 'house-omelette')).toBe(meal);
    expect(selectCustomMeal(state, 'absent')).toBeUndefined();
    expect(hasCustomMeal(state, 'house-omelette')).toBe(true);
    expect(hasCustomMeal(state, 'absent')).toBe(false);
  });

  it('reports the bound only when the list is full, at the number storage itself uses', () => {
    expect(MAX_CUSTOM_MEALS).toBe(STORAGE_BOUNDS.customMeals);
    expect(selectAtCustomMealsBound(stateOf())).toBe(false);
    expect(selectAtCustomMealsBound(fullState())).toBe(true);
    const oneShort = stateOf(...fullState().meals.slice(0, STORAGE_BOUNDS.customMeals - 1));
    expect(selectAtCustomMealsBound(oneShort)).toBe(false);
  });
});

describe('the store configuration', () => {
  it('adopts the persisted list as-is, with no second schema walk of its own', () => {
    // `create` is the hydration edge, but not an untrusted one: `customMealsSchema` has already
    // parsed every record, so a bad one quarantines the key and this receives the fallback `[]`.
    const persisted = [customMeal()];
    expect(customMealsStoreConfig.create(persisted).meals).toBe(persisted);
  });

  it('projects a value customMealSchema accepts, record by record', () => {
    const state = customMealsReducer(
      customMealsStoreConfig.create([]),
      customMealsActions.create(
        customMeal({
          id: 'lentil-soup',
          nutrition: { calories: 320, proteinGrams: 18, carbsGrams: 44, fatGrams: 6 },
          nutritionProvenance: { origin: 'user', dataset: null, servings: 4, reason: null },
        }),
      ),
    );
    const projected = customMealsStoreConfig.project(state);
    expect(projected).toHaveLength(1);
    for (const meal of projected) {
      expect(customMealSchema.safeParse(meal).success).toBe(true);
    }
  });

  it('cannot be grown past what storage will accept, however many creates arrive', () => {
    // The point of the reducer holding the bound, asserted end to end. `boundedTo` returns the
    // value itself when it fits and `repository.set` refuses exactly when `bound(value) !== value`,
    // so the list is driven with 225 creates and handed to storage's own bound. Projecting a list
    // built from `STORAGE_BOUNDS.customMeals` could not fail: 200 records by construction.
    let state = customMealsStoreConfig.create([]);
    for (let index = 0; index < STORAGE_BOUNDS.customMeals + 25; index += 1) {
      state = customMealsReducer(
        state,
        customMealsActions.create(customMeal({ id: `meal-${String(index)}` })),
      );
    }
    const projected = customMealsStoreConfig.project(state);
    expect(projected).toHaveLength(STORAGE_BOUNDS.customMeals);
    expect(storageBoundOf(projected)).toBe(projected);
  });
});

/**
 * The schema backstop (ORCHESTRATOR DECISION on F-W2-CM-STORE-1). Each vector is type-valid and
 * schema-invalid, and each case asserts the schema rejects it, or the refusal would prove nothing.
 */
const unstorable: readonly (readonly [string, CustomMeal])[] = [
  [
    'three-of-four nutrition',
    customMeal({
      nutrition: { calories: 320, proteinGrams: 18, carbsGrams: 44, fatGrams: null },
      nutritionProvenance: { origin: 'user', dataset: null, servings: 4, reason: null },
    }),
  ],
  ['a name over 120 characters', customMeal({ name: 'e'.repeat(121) })],
  ['preparation minutes over 600', customMeal({ preparationMinutes: 601 })],
];

describe('created and updated refuse a record the key cannot store', () => {
  it.each(unstorable)('created refuses %s, returning state identically', (_label, meal) => {
    expect(customMealSchema.safeParse(meal).success).toBe(false);
    const state = stateOf();
    expect(customMealsReducer(state, customMealsActions.create(meal))).toBe(state);
  });

  // The id is present in each case, so the refusal is the schema's, not the absent-id branch's.
  it.each(unstorable)('updated refuses %s for an id it holds, identically', (_label, meal) => {
    expect(customMealSchema.safeParse(meal).success).toBe(false);
    const state = stateOf(customMeal({ id: meal.id, name: 'The record the user still has' }));
    const next = customMealsReducer(state, customMealsActions.update(meal));
    expect(next).toBe(state);
    expect(selectCustomMeal(next, meal.id)?.name).toBe('The record the user still has');
  });

  // Without this, a backstop refusing everything unconditionally would pass every test above.
  it('still stores a valid record on both paths', () => {
    const created = customMealsReducer(stateOf(), customMealsActions.create(customMeal()));
    expect(created.meals).toHaveLength(1);
    const edited = customMeal({ name: 'Edited', updatedAt: '2026-09-14T08:30:00.000Z' });
    expect(customMealsReducer(created, customMealsActions.update(edited)).meals[0]).toBe(edited);
  });
});
