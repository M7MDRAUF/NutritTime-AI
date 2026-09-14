/**
 * The `customMeals` store's state, actions, reducer and selectors (T-17-01, FR-013).
 *
 * **PLAN-INTRODUCED.** TSD §6.3 names `customMeals` as one of the five stores and then specifies
 * nothing whatsoever about it — the section's worked example is `favorites`. So this module is
 * shaped by analogy with that example: one collection field on the state, `slice/verb-past-tense`
 * action types, action creators only, a reference-preserving reducer, the §6.4 bound re-exported so
 * a screen need not import storage definitions, and an at-bound selector. A second shape for the
 * same job would be precisely the duplication Plan §12.3 calls a gate failure, and a screen that
 * already knows how to read `favorites` can read this one without learning anything new.
 *
 * Four decisions here are load-bearing rather than stylistic:
 *
 *  1. **`created` with an id already present refuses, and never replaces.** A create is not an
 *     update. Silently overwriting a record the user authored is data loss of the worst kind: the
 *     old meal is gone and nothing on screen says so. This branch is also the **id-collision
 *     containment** for the form's id generator, which has no `crypto` to rely on (Expo 57's winter
 *     runtime ships none) and may fall back to `Math.random`. The containment has a cost callers
 *     must pay: refusing by returning `state` *identically* is silent — `dispatch` returns nothing
 *     — so a caller must check `hasCustomMeal` before dispatching and confirm the record landed
 *     afterwards rather than assuming a create succeeded.
 *  2. **The bound is enforced in the reducer, not left to storage.** P14 shipped a CRITICAL defect
 *     of exactly this shape: the store held a value the key's schema rejected, `repository.set`
 *     deliberately does not re-validate ("a typed-caller bug, not a storage condition"), the write
 *     landed, and the next launch quarantined the whole entry. Here that would mean **every custom
 *     meal the user has ever authored, erased at launch, to contain a 201st**. Hence the rule: a
 *     reducer must never be able to produce a value its own key cannot store. `saveBlocked` is the
 *     backstop for a value arriving another way, not the primary guard.
 *  3. **`updated` replaces in place and preserves order.** The array order is the user's list order.
 *     Re-sorting, or removing and re-appending, would make a record jump position while the user is
 *     looking at it — a defect they would report, correctly, as data loss.
 *  4. **No clock and no id generation, but there IS a validation backstop.** Composing a record —
 *     ids, both timestamps, provenance — belongs to `features/saved/mealFormValidation.ts`, and a
 *     reducer that read a clock would break TSD §6.3's purity and make every test here depend on
 *     the time of day. Validation is different: see `isStorable` below for why a reducer checks a
 *     schema at all, and why that is defence in depth rather than the primary guard.
 */

import type { CustomMeal } from '@nutritime/contracts';
import { STORAGE_BOUNDS, customMealSchema } from '../../infrastructure/storage/definitions.js';
import type { StoreConfig } from '../createStore.js';

export interface CustomMealsState {
  /** The user's list, in the user's order. Never re-sorted by this reducer. */
  readonly meals: readonly CustomMeal[];
}

export type CustomMealsAction =
  | { readonly type: 'customMeals/created'; readonly meal: CustomMeal }
  | { readonly type: 'customMeals/updated'; readonly meal: CustomMeal }
  | { readonly type: 'customMeals/deleted'; readonly mealId: string }
  | { readonly type: 'customMeals/cleared' };

/** Action creators only. A component never constructs an action literal (TSD §6.3 invariant 2). */
export const customMealsActions = {
  create: (meal: CustomMeal): CustomMealsAction => ({ type: 'customMeals/created', meal }),
  update: (meal: CustomMeal): CustomMealsAction => ({ type: 'customMeals/updated', meal }),
  remove: (mealId: string): CustomMealsAction => ({ type: 'customMeals/deleted', mealId }),
  clear: (): CustomMealsAction => ({ type: 'customMeals/cleared' }),
};

/**
 * The bound from TSD §6.4, **imported and never retyped**.
 *
 * Re-exported here so `SavedScreen` and `MealFormScreen` can say "the list is full" without
 * importing storage definitions, and so there is exactly one number: a literal `200` copied into a
 * screen would drift from the storage bound the moment either moved, and the drift would surface
 * only as a quarantined key on somebody's next launch.
 */
export const MAX_CUSTOM_MEALS = STORAGE_BOUNDS.customMeals;

export function selectCustomMeals(state: CustomMealsState): readonly CustomMeal[] {
  return state.meals;
}

export function selectCustomMeal(state: CustomMealsState, mealId: string): CustomMeal | undefined {
  return state.meals.find((meal) => meal.id === mealId);
}

export function hasCustomMeal(state: CustomMealsState, mealId: string): boolean {
  return state.meals.some((meal) => meal.id === mealId);
}

/**
 * True when one more custom meal could not be stored. Drives T-17-07's message.
 *
 * `>=` rather than `===`, deliberately: a list somehow already longer than the bound must still
 * report full rather than inviting a save the reducer will refuse and the user will read as a dead
 * button.
 */
export function selectAtCustomMealsBound(state: CustomMealsState): boolean {
  return state.meals.length >= MAX_CUSTOM_MEALS;
}

/**
 * **A reducer that validates, and P14 is the whole reason.**
 *
 * `validateMealForm` is the primary guard and the only one that can tell the user *which field* is
 * wrong, so this is not a substitute for it. It is the backstop for the paths that never touch the
 * form: a restored backup, a future import, a migration, or a rule the form does not yet have.
 *
 * P14 shipped this defect one key over. The `preferences` store held a value
 * `userPreferencesSchema` rejected, `repository.set` deliberately does not re-validate ("a
 * typed-caller bug, not a storage condition"), the write persisted, and on the **next launch** the
 * whole entry was quarantined and the store rebuilt from defaults — erasing the user's declared
 * allergy list with nothing shown to them. Here the blast radius is **every custom meal the user
 * has ever authored**, lost at a launch they cannot connect to the record that caused it. P14's fix
 * went into four places because one would not have been enough; this is one of the four for this
 * key. The type system cannot stand in for it: `CustomMeal` permits a 200-character name, a
 * three-of-four nutrition set and 900 preparation minutes, and `customMealSchema` rejects all three.
 *
 * Pure, so the reducer stays pure: `safeParse` reads no clock, no storage and no global.
 */
function isStorable(meal: CustomMeal): boolean {
  return customMealSchema.safeParse(meal).success;
}

export function customMealsReducer(
  state: CustomMealsState,
  action: CustomMealsAction,
): CustomMealsState {
  switch (action.type) {
    case 'customMeals/created': {
      // Every refusal returns `state` identically, which is what suppresses the re-render and the
      // storage write (TSD §6.3 invariant 3) — and what makes each refusal silent to the caller.
      if (state.meals.length >= MAX_CUSTOM_MEALS) {
        return state;
      }
      if (hasCustomMeal(state, action.meal.id)) {
        return state;
      }
      if (!isStorable(action.meal)) {
        return state;
      }
      return { meals: [...state.meals, action.meal] };
    }

    case 'customMeals/updated': {
      const index = state.meals.findIndex((meal) => meal.id === action.meal.id);
      // Nothing to update. Inserting instead would turn a lost edit into a duplicate record, and a
      // stale deep link into a meal the user never created.
      if (index === -1) {
        return state;
      }
      // Re-saving the very record already held changes nothing, so it must not allocate. The
      // comparison is by reference and makes no claim about deep equality — it could not be deep
      // usefully, because `composeCustomMealUpdate` moves `updatedAt` on every save, so two
      // composed records are never deeply equal anyway.
      if (state.meals[index] === action.meal) {
        return state;
      }
      // Checked after the identity shortcut above, not before: a record already in the list got
      // here past this same guard, so re-parsing it would cost a full schema walk to learn nothing.
      if (!isStorable(action.meal)) {
        return state;
      }
      const meals = [...state.meals];
      meals[index] = action.meal;
      return { meals };
    }

    case 'customMeals/deleted': {
      if (!hasCustomMeal(state, action.mealId)) {
        return state;
      }
      // `filter`, so a duplicate id that arrived on disk is fully removable. `customMealsSchema`
      // does not treat a duplicate id as corruption — quarantining the key would cost the user
      // every meal they have to fix one they cannot see — so the stored list can legitimately hold
      // two entries under one id, and a delete that left one behind would be an undeletable record.
      return { meals: state.meals.filter((meal) => meal.id !== action.mealId) };
    }

    case 'customMeals/cleared': {
      if (state.meals.length === 0) {
        return state;
      }
      return { meals: [] };
    }
  }
}

export const customMealsStoreConfig = {
  name: 'customMeals',
  key: 'customMeals',
  /**
   * **`create` needs no `isStorable` check, and this is the justification.**
   *
   * It is the hydration path, so its input is whatever came off disk — but it arrives *through*
   * `repository.get`, which has already run `customMealsSchema` over the array (that schema calls
   * `customMealSchema` on every record, so a single bad record quarantines the key and this
   * function receives the fallback `[]` instead) and has already truncated to the bound. Adding a
   * second check here would re-walk a schema the read path just walked, on every launch, to reach
   * the same answer — and the only action it could take is to drop a record the user authored,
   * which is the data loss the read path deliberately avoids. `created` and `updated` are the
   * untrusted edges, because a caller reaches them without passing any schema at all.
   *
   * **It also does NOT de-duplicate ids, and that is where this store parts company with
   * `favorites` on purpose.** `favorites` holds ids, where `['a','a']` and `['a']` denote the same
   * set and the duplicate carries no information; `customMeals` holds records, where two entries
   * under one id are two distinct authored meals that happen to share it — different names,
   * ingredients, instructions and timestamps. De-duplicating here would silently delete a meal the
   * user wrote, at hydration, which is P14's defect class exactly. **The React-key cost is a
   * display defect payable by the renderer; data loss is not payable at all** — so `SavedScreen`
   * keys its custom rows on more than the id, and `customMeals/deleted` removes every entry sharing
   * an id so the user can clear a duplicate themselves. The case is also barely reachable:
   * `created` refuses a duplicate id and `updated` replaces in place, so this reducer cannot
   * produce one, and only a hand-edited value, a restored backup or a future import can.
   */
  create: (persisted) => ({ meals: persisted }),
  reducer: customMealsReducer,
  project: (state) => state.meals,
} satisfies StoreConfig<'customMeals', CustomMealsState, CustomMealsAction>;
