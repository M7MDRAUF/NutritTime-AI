/**
 * Diet compatibility (TSD 4.5).
 *
 * A user's diet is a requirement; a meal's tags are what the meal offers. Compatibility is a
 * table lookup, not a hierarchy - the table below is the whole policy, and every rule in the
 * system that turns on diet reads it from here.
 */

import type { DietTag } from '@nutritime/contracts';

/**
 * User diet -> the meal tags that satisfy it. An empty list means "no requirement": a
 * `regular` user is compatible with every meal, including an untagged one.
 *
 * Two entries are deliberately asymmetric. Neither is an oversight, and neither should be
 * "tidied" into symmetry:
 *
 * 1. `vegan` satisfies `vegetarian`, but `vegetarian` does not satisfy `vegan`. A vegan dish
 *    is acceptable to a vegetarian; the reverse is not true, because a vegetarian dish may
 *    contain dairy or egg.
 *
 * 2. `vegan` satisfies `halal-preference`, but `vegetarian` does not. A vegetarian dish may
 *    still contain non-halal ingredients such as alcohol or non-halal rennet; a vegan dish
 *    avoids the animal-derived ones this preference is concerned with.
 *
 * Both asymmetries are pinned by named tests in diet.test.ts, so an edit that restores
 * symmetry fails with a test name that says what it broke.
 */
const SATISFIED_BY: Record<DietTag, readonly DietTag[]> = {
  regular: [],
  vegetarian: ['vegetarian', 'vegan'],
  vegan: ['vegan'],
  'halal-preference': ['halal-preference', 'vegan'],
  'gluten-aware': ['gluten-aware'],
};

/**
 * True when the meal satisfies the user's diet.
 *
 * An empty accepted list is "no requirement", so it admits everything - including a meal
 * carrying no diet tags at all. Otherwise one accepted tag on the meal is enough; the meal is
 * not required to carry them all.
 */
export function isDietCompatible(userDiet: DietTag, mealDietTags: readonly DietTag[]): boolean {
  const accepted = SATISFIED_BY[userDiet];
  if (accepted.length === 0) {
    return true;
  }
  return accepted.some((tag) => mealDietTags.includes(tag));
}

/**
 * What the meal would need to carry, or `[]` when it already does.
 *
 * This exists to explain a rejection to the user, so it returns the requirement rather than
 * the gap: for a vegetarian user it is always `['vegetarian', 'vegan']`, never "the part that
 * is missing". The result aliases the table above rather than copying it; the `readonly` type
 * is what keeps a caller from writing through it.
 */
export function unmetDietRequirement(
  userDiet: DietTag,
  mealDietTags: readonly DietTag[],
): readonly DietTag[] {
  // Copied, not aliased: `readonly` is compile-time only, and one cast at any call
  // site would otherwise corrupt the policy table for the whole process.
  return isDietCompatible(userDiet, mealDietTags) ? [] : [...SATISFIED_BY[userDiet]];
}
