/**
 * Turning what the form proved into the record storage will accept (T-17-03).
 *
 * Extracted from `mealFormValidation.ts` under SQG-09, along the seam a reviewer would draw:
 * **this module never looks at a draft.** It starts from `DraftValues` — the set of values
 * `interpret` has already proved valid — and its whole job is the three things that happen after
 * that: pick an id nothing else is using, stamp the fields FR-013 fixes rather than reads, and
 * check the result against the schema storage itself applies.
 *
 * The seam does not touch the single pass. `interpret` and every field-bound rule stay in
 * `mealFormValidation.ts`, and so do `composeCustomMeal` and `composeCustomMealUpdate` — so the
 * only way to reach a `CustomMeal` is still interpret-then-compose inside one function, which is
 * the property the acceptance test rests on. Nothing here can be called with a draft that was
 * never validated, because nothing here takes a draft.
 */

import type { CustomMeal } from '@nutritime/contracts';
import { money } from '@nutritime/domain';
import { customMealSchema } from '../../infrastructure/storage/definitions.js';
import type { DietTag, Ingredient, MealPeriod, NutritionSummary } from '@nutritime/contracts';
import { MEAL_FORM_MESSAGES } from './mealFormFields.js';
// Type-only, and that matters: `verbatimModuleSyntax` erases it, so there is no runtime edge back
// to `mealFormValidation.js` — which imports this module's functions as values. One direction.
import type { MealFormErrors } from './mealFormValidation.js';

const M = MEAL_FORM_MESSAGES;

/**
 * What `interpret` proved about a draft: parsed, trimmed, bounded, and nothing left to decide.
 *
 * Every field is already the type the record needs, which is why this module has no rules in it.
 * A `DraftValues` that did not come out of `interpret` is not something the app can construct —
 * the only producer is that one pass.
 */
export interface DraftValues {
  readonly name: string;
  readonly description: string;
  readonly mealPeriods: readonly MealPeriod[];
  readonly dietTags: readonly DietTag[];
  readonly allergenTags: readonly string[];
  readonly ingredients: readonly Ingredient[];
  readonly instructions: readonly string[];
  readonly priceCents: number;
  readonly preparationMinutes: number;
  readonly nutrition: NutritionSummary;
  readonly servings: number | null;
}

export interface ComposeContext {
  readonly now: () => string;
  readonly newId: () => string;
  /**
   * **Every id already in the `customMeals` store — and passing `[]` is a promise that the store
   * is empty, not a way to skip this argument.**
   *
   * Read that literally, because this module cannot tell the difference and nothing downstream
   * will tell you either. `createRecord` checks a generated id against this list and regenerates
   * on a collision; with `[]` the check is a no-op, a colliding id composes happily, and
   * `customMeals/created` then refuses the duplicate by **returning state identically** — no
   * thrown error, no rejected dispatch, no message. The user presses Save, the form closes, and
   * their meal is simply not there. That silence is why the caller's promise matters.
   *
   * So the call site is `existingIds: selectCustomMeals(state).map((meal) => meal.id)`, read from
   * the same store the create will be dispatched to. An empty array is correct on first use and
   * correct nowhere else.
   */
  readonly existingIds: readonly string[];
}

export type ComposeResult =
  | { readonly ok: true; readonly meal: CustomMeal }
  | { readonly ok: false; readonly errors: MealFormErrors };

/** Attempts before a create gives up. Five is enough that a working generator never reaches it. */
const ID_ATTEMPTS = 5;

function buildRecord(v: DraftValues, id: string, createdAt: string, updatedAt: string): CustomMeal {
  return {
    id,
    name: v.name,
    description: v.description,
    mealPeriods: v.mealPeriods,
    ingredients: v.ingredients,
    instructions: v.instructions,
    allergenTags: v.allergenTags,
    dietTags: v.dietTags,
    nutrition: v.nutrition,
    // `money` throws on a negative or fractional amount. Unreachable here — `parsePriceCents`
    // already proved this is a whole number of cents inside the bound — and that guard is the
    // reason to call it rather than hand-build the object literal.
    price: money(v.priceCents),
    preparationMinutes: v.preparationMinutes,
    imageUrl: null,
    available: true,
    source: 'user',
    // Nothing upstream to attribute, and claiming a confirmed licence for a record the user typed
    // would be a claim about somebody else's terms.
    provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
    // `reason` explains why a DERIVATION failed; nothing was derived here, and inventing a
    // sentence would put user-facing copy into a stored record that `NutritionPanel` owns.
    nutritionProvenance: { origin: 'user', dataset: null, servings: v.servings, reason: null },
    createdAt,
    updatedAt,
  };
}

/**
 * The backstop. `customMealSchema` is what storage applies, so applying it here is the difference
 * between a refused save the user is told about and a quarantined key on the next launch.
 *
 * It is a backstop and not the primary guard: the field-bound rules in `mealFormValidation.ts` are
 * what a user can act on, and a record only this function rejects means a rule there is missing.
 */
function finalise(record: CustomMeal): ComposeResult {
  const parsed = customMealSchema.safeParse(record);
  return parsed.success
    ? { ok: true, meal: parsed.data }
    : { ok: false, errors: { name: M.notSaveable } };
}

/**
 * A fresh id that is not already taken, or `null` after `ID_ATTEMPTS`.
 *
 * The retry is not superstition: `customMeals/created` refuses a duplicate id by returning state
 * **identically** — no error, no failed dispatch — so a colliding record would make the meal
 * vanish with nothing on screen to explain it. Giving up with a message is the honest end.
 */
function pickId(context: ComposeContext): string | null {
  const taken = new Set(context.existingIds);
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const candidate = context.newId();
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/** Create: a generated id and both timestamps at the same instant. */
export function createRecord(values: DraftValues, context: ComposeContext): ComposeResult {
  const id = pickId(context);
  if (id === null) return { ok: false, errors: { name: M.idCollision } };
  const timestamp = context.now();
  return finalise(buildRecord(values, id, timestamp, timestamp));
}

/** Edit: keeps the existing `id` and `createdAt`, moves `updatedAt`. */
export function updateRecord(
  values: DraftValues,
  existing: CustomMeal,
  context: Pick<ComposeContext, 'now'>,
): ComposeResult {
  return finalise(buildRecord(values, existing.id, existing.createdAt, context.now()));
}
