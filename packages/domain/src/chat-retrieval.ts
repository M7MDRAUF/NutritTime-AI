/**
 * Chat retrieval (TSD 4.8, PRD FR-015).
 *
 * Safe before relevant. Every filter that protects the user runs before anything that merely
 * ranks, so no question phrasing can surface a meal the user must not be shown. Pure: this
 * runs before any model call, and it decides what the model is even allowed to see.
 *
 * Two sets come back rather than one, because 4.9 needs both. A superlative asserts something
 * about everything the user could have (`eligible`); a listing describes what is in front of
 * them (`context`). Collapsing the two produces "the cheapest meal is X" where X is merely the
 * cheapest of five - a sentence that reads as true and is not.
 */

import type { DietTag, Meal } from '@nutritime/contracts';
import { hasAllergenConflict } from './allergens.js';
import { isDietCompatible } from './diet.js';
import { queryMeals } from './relevance.js';
import { matchedDislikedIngredients } from './scoring.js';

export const MAX_CHAT_CONTEXT_MEALS = 5;

/**
 * The narrow projection the chat route accepts - deliberately smaller than `UserPreferences`.
 *
 * Declared here because TSD 4.8 names the type without defining it, exactly as 4.6 does for
 * `RecommendationPreferences`. The shape mirrors `retrievalPreferencesSchema` field for field;
 * the conformance test in contracts is what keeps the two honest.
 */
export interface RetrievalPreferences {
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly dislikedIngredients: readonly string[];
}

export interface ChatRetrievalInput {
  readonly question: string;
  readonly preferences: RetrievalPreferences;
  readonly meals: readonly Meal[];
}

export interface ChatRetrievalResult {
  /** Everything that survived the safety filters, in catalog order. */
  readonly eligible: readonly Meal[];
  /** At most five, ranked. What a resolver runs over for a context-scoped question. */
  readonly context: readonly Meal[];
}

/**
 * The seven steps of TSD 4.8, in order.
 *
 * Steps 1-3 are the safety filters and they are unconditional. Step 4 **demotes rather than
 * excludes**: a user who dislikes onion and whose every safe meal contains onion still gets an
 * answer, which is the whole reason a dislike is a penalty in 4.6 rather than a filter.
 */
export function retrieveChatMeals(input: ChatRetrievalInput): ChatRetrievalResult {
  const { preferences, meals, question } = input;

  const eligible: Meal[] = [];
  const preferred: Meal[] = [];
  const demoted: Meal[] = [];

  for (const meal of meals) {
    // 1. Allergen conflict, on EFFECTIVE tags - declared union inferred (4.4). Checking the
    //    declared list alone is how an untagged peanut reaches someone who cannot eat one.
    if (hasAllergenConflict(meal, preferences.allergies)) {
      continue;
    }
    // 2. Diet incompatibility, and 3. availability.
    if (!isDietCompatible(preferences.diet, [...meal.dietTags])) {
      continue;
    }
    if (!meal.available) {
      continue;
    }

    eligible.push(meal);

    // 4. Partition, never drop.
    if (matchedDislikedIngredients(meal, preferences.dislikedIngredients).length > 0) {
      demoted.push(meal);
    } else {
      preferred.push(meal);
    }
  }

  // 5. Rank each partition independently, and 6. take the first five across both, preferred
  //    first. Ranking the partitions separately is what keeps a liked meal ahead of a disliked
  //    one even when the disliked one is the better lexical match.
  const ranked = [...queryMeals(preferred, question), ...queryMeals(demoted, question)].map(
    (match) => match.meal,
  );

  // 7. Nothing matched lexically. A general question - "what is quick?" - names no meal, and a
  //    grounded answer over the eligible set beats a refusal. Partition order is preserved so
  //    the fallback still prefers what the user likes.
  const fallback = [...preferred, ...demoted];
  const chosen = ranked.length > 0 ? ranked : fallback;

  return { eligible, context: chosen.slice(0, MAX_CHAT_CONTEXT_MEALS) };
}
