/**
 * Relevance ranking (TSD 4.7).
 *
 * One implementation, two callers: `GET /api/v1/meals?query=` and chat retrieval (TSD 4.8).
 * That is the whole point of the module existing - the catalog screen and the assistant can
 * never disagree about which meals match a phrase, because there is only one answer to
 * disagree with.
 *
 * Pure. The one piece of mutable state is a memo keyed on the meal objects themselves, which
 * changes how fast an answer arrives and never what the answer is.
 */

import type { Meal } from '@nutritime/contracts';
import { compareIds, containsTokenSequence, singularize, tokenize } from './text.js';

/**
 * What each kind of hit is worth.
 *
 * The ordering is the policy, not a set of dials. A whole name word (10) outranks any
 * combination of ingredient, tag and description hits (4 + 3 + 2 = 9), so a meal *called*
 * "Chicken Curry" always beats one that merely lists chicken. The phrase bonus (25) outranks
 * everything, because a user typing "chicken curry" means the dish, not the two ingredients.
 */
export const RELEVANCE_WEIGHTS = {
  namePhrase: 25,
  nameToken: 10,
  namePrefix: 5,
  ingredientToken: 4,
  tagToken: 3,
  descriptionToken: 2,
} as const;

/** A prefix shorter than this matches too much to be a signal. */
export const MIN_PREFIX_LENGTH = 3;

/**
 * Common function words, dropped from the query so that "what is in the chicken curry" ranks
 * exactly as "chicken curry" does.
 *
 * Every entry is stored in its SINGULARISED form, because the query is singularised before
 * this set is consulted: `does` never reaches the check, `doe` does. `this` is the one word
 * listed in both spellings - `singularize('this')` is `thi`, so `thi` is the form that
 * actually arrives, and `this` is kept beside it so the list still reads as English.
 *
 * **The single letters are contraction tails, and they are load-bearing.** `normalizeText`
 * turns an apostrophe into a space, so `"what's"` tokenises to `['what','s']`. A surviving
 * `s` lengthens the query, which breaks the contiguous-run test and silently costs the
 * 25-point phrase bonus: "what's in the chicken curry" scored 26 against Chicken Curry where
 * "what is in the chicken curry" scored 51. The entries `d ll m re s t ve` cover the tails of
 * 'd, 'll, 'm, 're, 's, 't and 've. Known gap: a contraction whose HEAD is not a function
 * word still perturbs the run - "don't" leaves `don` behind. Closing that belongs in TSD 4.1
 * tokenisation, not in a word list here.
 *
 * The list is short on purpose. Every word added here is a word no user can ever search for,
 * so it holds function words only: nothing that could name a dish, an ingredient or a tag.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'd',
  'do',
  'doe',
  'for',
  'from',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'll',
  'm',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  're',
  's',
  'show',
  't',
  'that',
  'the',
  'these',
  'thi',
  'this',
  'those',
  'to',
  've',
  'we',
  'what',
  'which',
  'with',
  'you',
  'your',
]);

export interface MealMatch {
  readonly meal: Meal;
  readonly score: number;
}

/** The searchable shape of one meal. */
interface MealIndex {
  /**
   * Name tokens in order. An array rather than a `Set`, because the phrase check asks whether
   * the query appears as a contiguous run - a question a `Set` cannot answer.
   */
  readonly name: readonly string[];
  readonly ingredients: ReadonlySet<string>;
  readonly description: ReadonlySet<string>;
  /** `dietTags` and `mealPeriods` together, each tag tokenised so `halal-preference` is two. */
  readonly tags: ReadonlySet<string>;
}

/**
 * The memo, keyed on the meal object itself.
 *
 * A `WeakMap` and not a `Map`: the catalog is replaced wholesale on reload, and a strong map
 * would pin every superseded meal in memory for the life of the process.
 *
 * The precondition is that a catalog meal is REPLACED, never edited in place. Identity keying
 * does not enforce that: `readonly` is compile-time only, so mutating `meal.name` keeps the
 * same object and this memo would then serve the stale index for the old text. Nothing in the
 * system mutates a meal - the catalog is loaded once and rebuilt wholesale - but that is a
 * property of the callers, not a guarantee this map provides.
 */
const MEAL_INDEXES = new WeakMap<Meal, MealIndex>();

function buildMealIndex(meal: Meal): MealIndex {
  const ingredients = new Set<string>();
  for (const ingredient of meal.ingredients) {
    for (const token of tokenize(ingredient.name)) {
      ingredients.add(singularize(token));
    }
  }

  const tags = new Set<string>();
  for (const tag of [...meal.dietTags, ...meal.mealPeriods]) {
    for (const token of tokenize(tag)) {
      tags.add(singularize(token));
    }
  }

  return {
    name: tokenize(meal.name).map(singularize),
    ingredients,
    description: new Set(tokenize(meal.description).map(singularize)),
    tags,
  };
}

/** The index for a meal, built on first sight and reused for every later query. */
function mealIndex(meal: Meal): MealIndex {
  const cached = MEAL_INDEXES.get(meal);
  if (cached !== undefined) {
    return cached;
  }
  const built = buildMealIndex(meal);
  MEAL_INDEXES.set(meal, built);
  return built;
}

/** Tokenise, singularise, then drop stop words - in that order, which is why `doe` is listed. */
function tokenizeQuery(query: string): string[] {
  return tokenize(query)
    .map(singularize)
    .filter((token) => !STOP_WORDS.has(token));
}

function startsAnyNameWord(name: readonly string[], token: string): boolean {
  return name.some((word) => word.startsWith(token));
}

function scoreIndex(index: MealIndex, queryTokens: readonly string[]): number {
  let score = 0;

  for (const token of queryTokens) {
    // Token or prefix, never both. `'chicken'.startsWith('chicken')` is true, so without the
    // `else` every exact name hit would quietly collect the prefix weight as well.
    if (index.name.includes(token)) {
      score += RELEVANCE_WEIGHTS.nameToken;
    } else if (token.length >= MIN_PREFIX_LENGTH && startsAnyNameWord(index.name, token)) {
      score += RELEVANCE_WEIGHTS.namePrefix;
    }

    // The other three are independent of the name score and of each other: one word can be
    // the dish name, an ingredient, a tag and a description word at once, and each is a
    // separate piece of evidence.
    if (index.ingredients.has(token)) {
      score += RELEVANCE_WEIGHTS.ingredientToken;
    }
    if (index.tags.has(token)) {
      score += RELEVANCE_WEIGHTS.tagToken;
    }
    if (index.description.has(token)) {
      score += RELEVANCE_WEIGHTS.descriptionToken;
    }
  }

  // The score-is-positive guard stops a query that matched nothing from earning a phrase
  // bonus against a name it never touched.
  if (score > 0 && containsTokenSequence(index.name, queryTokens)) {
    score += RELEVANCE_WEIGHTS.namePhrase;
  }

  return score;
}

/**
 * Meals matching `query`, best first.
 *
 * A meal scoring 0 is omitted rather than returned with a zero: a caller rendering results
 * should not have to know that 0 means "no match". Ties fall through to `compareIds`, which
 * is what makes the order stable across runs and assertable in a test.
 */
export function queryMeals(meals: readonly Meal[], query: string): readonly MealMatch[] {
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const matches: MealMatch[] = [];
  for (const meal of meals) {
    const score = scoreIndex(mealIndex(meal), queryTokens);
    if (score > 0) {
      matches.push({ meal, score });
    }
  }

  return matches.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return compareIds(left.meal.id, right.meal.id);
  });
}
