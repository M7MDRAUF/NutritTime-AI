import { describe, expect, it } from 'vitest';
import { MIN_PREFIX_LENGTH, RELEVANCE_WEIGHTS, STOP_WORDS, queryMeals } from './relevance.js';
import type { MealMatch } from './relevance.js';
import { singularize } from './text.js';
import type { Meal } from '@nutritime/contracts';

/**
 * Plan.md 19.3 requires five vectors for this module: token/prefix exclusivity, a prefix below
 * three characters ignored, the phrase bonus, a stop-words-only query returning `[]`, and a
 * score of 0 omitted. Each has its own named test below, alongside the exact arithmetic of a
 * known match, the id tie-break, an empty catalog, a description-only hit, and a repeat query.
 *
 * Every expected score is written out as a sum in the comment above it, so a weight change
 * that is not also made here fails with the arithmetic on screen.
 */

const BASE_MEAL: Meal = {
  id: 'base',
  name: '',
  description: '',
  mealPeriods: [],
  ingredients: [],
  instructions: [],
  allergenTags: [],
  dietTags: [],
  nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
  price: { amountCents: 0, currency: 'USD' },
  preparationMinutes: 0,
  imageUrl: null,
  available: true,
  source: 'local',
  catalogVersion: 'test',
  provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
  nutritionProvenance: {
    origin: 'unavailable',
    dataset: null,
    servings: null,
    reason: 'fixture',
  },
};

/**
 * A meal built from the few fields relevance reads. Everything omitted stays empty, so a
 * fixture's score depends only on the text written into it, and each vector reads as
 * arithmetic over the fields it names.
 */
function makeMeal(overrides: Partial<Meal>): Meal {
  return { ...BASE_MEAL, ...overrides };
}

const CHICKEN_CURRY = makeMeal({
  id: 'chicken-curry',
  name: 'Chicken Curry',
  description: 'A warm chicken stew',
  ingredients: [{ name: 'Chicken breast', measure: '200 g' }],
  mealPeriods: ['dinner'],
  dietTags: ['regular'],
});

const GARDEN_SALAD = makeMeal({
  id: 'garden-salad',
  name: 'Garden Salad',
  description: 'A crisp bowl tossed with tangy vinaigrette',
  ingredients: [
    { name: 'Romaine lettuce', measure: '1 head' },
    { name: 'Cherry tomatoes', measure: '6' },
  ],
  mealPeriods: ['lunch'],
  dietTags: ['vegan'],
});

/** The word "vegan" lands in the name, an ingredient, a tag and the description at once. */
const VEGAN_STEW = makeMeal({
  id: 'vegan-stew',
  name: 'Vegan Stew',
  description: 'A vegan stew for a cold night',
  ingredients: [{ name: 'Vegan butter', measure: '2 tbsp' }],
  mealPeriods: ['dinner'],
  dietTags: ['vegan'],
});

const CHICKEN_SOUP = makeMeal({ id: 'chicken-soup', name: 'Chicken Soup' });
const CHICKPEA_STEW = makeMeal({ id: 'chickpea-stew', name: 'Chickpea Stew' });

const CATALOG: readonly Meal[] = [
  CHICKEN_CURRY,
  GARDEN_SALAD,
  VEGAN_STEW,
  CHICKEN_SOUP,
  CHICKPEA_STEW,
];

/**
 * The score for one meal id. A missing match throws rather than returning 0: a vector that
 * expected a match and got none is a failure, not a zero to be compared against.
 */
function scoreOf(matches: readonly MealMatch[], mealId: string): number {
  const match = matches.find((candidate) => candidate.meal.id === mealId);
  if (match === undefined) {
    throw new Error('expected a match for ' + mealId + ', got none');
  }
  return match.score;
}

function idsOf(matches: readonly MealMatch[]): readonly string[] {
  return matches.map((match) => match.meal.id);
}

describe('a query that survives tokenisation as nothing matches nothing', () => {
  it('returns no matches for a stop-words-only query, even against a name spelling them out', () => {
    const showMeTheCurry = makeMeal({ id: 'show-me-the-curry', name: 'Show Me The Curry' });
    // Every query word is a stop word, so nothing survives step 1 and the empty-query guard
    // returns before any scoring. Note what this does NOT exercise: the `score > 0` guard on
    // the phrase bonus is never reached, and in fact cannot be reached as a discriminator -
    // a contiguous run of >=1 query tokens in the name means every one of them scored the
    // name-token weight, so the score is already >= 10. The guard is mandated by TSD 4.7
    // step 4 and is kept, but it is defence, not a live branch.
    expect(queryMeals([showMeTheCurry], 'show me the')).toStrictEqual([]);
  });

  it('returns no matches for a query holding no word characters at all', () => {
    expect(queryMeals(CATALOG, '   ')).toStrictEqual([]);
    expect(queryMeals(CATALOG, '...')).toStrictEqual([]);
  });

  it('drops a query word whose singular form is the stop word', () => {
    // "does" singularises to "doe", and "doe" is the entry in STOP_WORDS that catches it.
    expect(queryMeals(CATALOG, 'does')).toStrictEqual([]);
  });

  it('returns no matches for an empty meal list', () => {
    expect(queryMeals([], 'chicken curry')).toStrictEqual([]);
  });

  it('drops a contraction tail, so an apostrophe cannot cost the phrase bonus', () => {
    // `normalizeText` turns an apostrophe into a space, so "what's" tokenises to
    // ["what","s"]. Before `s` was a stop word the stray token lengthened the query, the
    // contiguous-run test failed, and this phrasing scored 26 where the other scored 51.
    const spelled = queryMeals([CHICKEN_CURRY], 'what is in the chicken curry');
    const contracted = queryMeals([CHICKEN_CURRY], "what's in the chicken curry");
    expect(scoreOf(contracted, 'chicken-curry')).toBe(scoreOf(spelled, 'chicken-curry'));
    expect(scoreOf(contracted, 'chicken-curry')).toBe(51);
  });

  it('drops every contraction tail an apostrophe can leave behind', () => {
    // 'd 'll 'm 're 's 't 've. Each would otherwise survive as a one- or two-letter token.
    for (const tail of ['d', 'll', 'm', 're', 's', 't', 've']) {
      expect(STOP_WORDS.has(tail)).toBe(true);
    }
  });
});

describe('a name token and a name prefix are mutually exclusive', () => {
  it('pays the name-token weight alone for a word that is also a prefix of itself', () => {
    // "chicken".startsWith("chicken") is true, so two ifs instead of an if/else would pay
    // both: nameToken 10 + namePhrase 25 = 35, and never 10 + 5 + 25 = 40.
    expect(scoreOf(queryMeals([CHICKEN_SOUP], 'chicken'), 'chicken-soup')).toBe(35);
  });

  it('pays the prefix weight when the query word only starts a name word', () => {
    // "chick" starts "chickpea" but is not a whole name token, and a token absent from the
    // name array is not a phrase either. namePrefix 5, and nothing else.
    expect(scoreOf(queryMeals([CHICKPEA_STEW], 'chick'), 'chickpea-stew')).toBe(
      RELEVANCE_WEIGHTS.namePrefix,
    );
  });

  it('ignores a prefix shorter than MIN_PREFIX_LENGTH, leaving the meal unmatched', () => {
    const tooShort = 'ch';
    expect(tooShort.length).toBeLessThan(MIN_PREFIX_LENGTH);
    // "ch" starts "chickpea", but two characters match too much to be a signal: the meal
    // scores 0 and is omitted, so the whole result is empty.
    expect(queryMeals([CHICKPEA_STEW], tooShort)).toStrictEqual([]);
  });

  it('counts a prefix of exactly MIN_PREFIX_LENGTH characters', () => {
    const shortest = 'chi';
    expect(shortest.length).toBe(MIN_PREFIX_LENGTH);
    expect(scoreOf(queryMeals([CHICKPEA_STEW], shortest), 'chickpea-stew')).toBe(
      RELEVANCE_WEIGHTS.namePrefix,
    );
  });
});

describe('the phrase bonus', () => {
  // The same two name words; only their order differs.
  const CHICKEN_CURRY_IN_ORDER = makeMeal({ id: 'z-in-order', name: 'Chicken Curry' });
  const CHICKEN_CURRY_REVERSED = makeMeal({ id: 'a-reversed', name: 'Curry Chicken' });

  it('adds the bonus when the query words are a contiguous run of the name', () => {
    // nameToken 10 (chicken) + nameToken 10 (curry) + namePhrase 25 = 45.
    expect(scoreOf(queryMeals([CHICKEN_CURRY_IN_ORDER], 'chicken curry'), 'z-in-order')).toBe(45);
  });

  it('withholds the bonus when the same words appear in the name out of order', () => {
    // nameToken 10 + nameToken 10 = 20. No contiguous run, so no bonus.
    expect(scoreOf(queryMeals([CHICKEN_CURRY_REVERSED], 'chicken curry'), 'a-reversed')).toBe(20);
  });

  it('is worth exactly namePhrase and outranks an alphabetically earlier id', () => {
    const matches = queryMeals([CHICKEN_CURRY_REVERSED, CHICKEN_CURRY_IN_ORDER], 'chicken curry');
    expect(idsOf(matches)).toStrictEqual(['z-in-order', 'a-reversed']);
    expect(scoreOf(matches, 'z-in-order') - scoreOf(matches, 'a-reversed')).toBe(
      RELEVANCE_WEIGHTS.namePhrase,
    );
  });
});

describe('the score of one meal', () => {
  it('scores the query "chicken curry" against Chicken Curry at 51', () => {
    // chicken: nameToken 10 + ingredientToken 4 ("Chicken breast") + descriptionToken 2
    //          ("A warm chicken stew") = 16. Not in the tags {regular, dinner}.
    // curry:   nameToken 10. Not an ingredient, not a tag, not in the description.
    // Running 26, and ["chicken", "curry"] is the whole name array in order, so plus 25.
    // 16 + 10 + 25 = 51.
    expect(scoreOf(queryMeals([CHICKEN_CURRY], 'chicken curry'), 'chicken-curry')).toBe(51);
  });

  it('accumulates the ingredient, tag and description hits independently of the name', () => {
    // One word, all six weights in play: nameToken 10 ("Vegan Stew") + ingredientToken 4
    // ("Vegan butter") + tagToken 3 (dietTag vegan) + descriptionToken 2 ("A vegan stew for
    // a cold night") = 19, plus namePhrase 25 for the single-word run = 44.
    expect(scoreOf(queryMeals([VEGAN_STEW], 'vegan'), 'vegan-stew')).toBe(44);
  });

  it('scores a word found only in the description at the description weight', () => {
    // "vinaigrette" is not the name, not a prefix of "garden" or "salad", not an ingredient
    // and not a tag. descriptionToken 2, and nothing else.
    expect(scoreOf(queryMeals([GARDEN_SALAD], 'vinaigrette'), 'garden-salad')).toBe(
      RELEVANCE_WEIGHTS.descriptionToken,
    );
  });
});

describe('the returned list', () => {
  it('omits a meal scoring zero rather than returning it with a zero', () => {
    const matches = queryMeals(CATALOG, 'curry');
    // Only Chicken Curry touches the word; the other four score 0 and never appear.
    // nameToken 10 + namePhrase 25 = 35.
    expect(matches).toStrictEqual([{ meal: CHICKEN_CURRY, score: 35 }]);
    expect(matches.every((match) => match.score > 0)).toBe(true);
  });

  it('ranks by score descending across a mixed catalog', () => {
    // Chicken Curry 51 (above). Chicken Soup: nameToken 10 for chicken, nothing for curry,
    // and "chicken soup" does not hold the run "chicken curry", so 10. The rest score 0.
    expect(queryMeals(CATALOG, 'chicken curry')).toStrictEqual([
      { meal: CHICKEN_CURRY, score: 51 },
      { meal: CHICKEN_SOUP, score: 10 },
    ]);
  });

  it('breaks a tie by id ascending, whatever order the meals arrive in', () => {
    const soupC = makeMeal({ id: 'c-soup', name: 'Chicken Soup' });
    const soupA = makeMeal({ id: 'a-soup', name: 'Chicken Soup' });
    const soupB = makeMeal({ id: 'b-soup', name: 'Chicken Soup' });
    const matches = queryMeals([soupC, soupA, soupB], 'chicken');

    expect(idsOf(matches)).toStrictEqual(['a-soup', 'b-soup', 'c-soup']);
    // Identical names, so identical scores: nameToken 10 + namePhrase 25 = 35 each.
    expect(matches.map((match) => match.score)).toStrictEqual([35, 35, 35]);
  });

  it('returns identical results when the same query is run again over the same catalog', () => {
    // The per-meal index is memoised in a WeakMap, so the second run reads cached indexes
    // where the first built them. The query in between proves the memo is not per-query.
    const first = queryMeals(CATALOG, 'chicken curry');
    queryMeals(CATALOG, 'vegan');
    const third = queryMeals(CATALOG, 'chicken curry');

    expect(third).toStrictEqual(first);
    expect(third).not.toBe(first);
  });
});

describe('STOP_WORDS', () => {
  const REQUIRED: readonly string[] = [
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
    'me',
    'my',
    'not',
    'of',
    'on',
    'or',
    'show',
    'that',
    'the',
    'these',
    'this',
    'those',
    'to',
    'what',
    'which',
    'with',
    'you',
    'your',
  ];

  it('holds every required function word in the form singularisation actually produces', () => {
    // The old version of this test only checked `STOP_WORDS.has(word)`, which is the raw
    // spelling - the one form the filter may never see. `queryMeals` singularises BEFORE
    // consulting the set, so the folded form is what has to be present.
    expect(REQUIRED.filter((word) => !STOP_WORDS.has(singularize(word)))).toStrictEqual([]);
    // "this" singularises to "thi", so "thi" is the spelling the filter actually sees.
    expect(singularize('this')).toBe('thi');
    expect(STOP_WORDS.has('thi')).toBe(true);
  });

  it('has no dead entry: every member survives its own singularisation', () => {
    // An entry that folds to something outside the set can never fire, and would leave the
    // word it was added to catch escaping into the query.
    const dead = [...STOP_WORDS].filter((word) => !STOP_WORDS.has(singularize(word)));
    expect(dead).toStrictEqual([]);
  });

  it('holds nothing but function words and contraction tails', () => {
    // Pinning the exact contents. A word added here is a word no user can ever search for,
    // so an accidental addition of, say, "chicken" would silently make it unsearchable in
    // both the catalog screen and chat retrieval with every other test still green.
    expect([...STOP_WORDS].sort()).toStrictEqual(
      [...REQUIRED, 'd', 'll', 'm', 're', 's', 't', 've', 'thi', 'we'].sort(),
    );
  });
});
