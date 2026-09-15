import { describe, expect, it } from 'vitest';
import type { Meal, MealPeriod } from '@nutritime/contracts';
import type { ChatRetrievalResult } from './chat-retrieval.js';
import { formatAnswerValue, resolveAnswer } from './answer.js';
import { COMPILED_CRITERIA, COMPILED_SENSES, COMPILED_SHAPES } from './answer-lexicon.js';
import type { AnswerOutcome, ResolvedAnswer } from './answer.js';

/**
 * Plan.md 19.3 requires every intent, ambiguity, the partial-`null` refusal, the
 * eligible-vs-context scope rule, figures taken from formatted strings, and an empty
 * `namedMeals` for a count.
 *
 * The scope rule is the one worth staring at. Resolving a superlative over the five meals in
 * front of the user instead of everything they could have produces "the cheapest meal is X" -
 * a grammatical, confident, false sentence. It is the subtlest defect surface in the system,
 * so it gets a test that would fail loudly if the two sets were ever swapped.
 */

const BASE: Meal = {
  id: 'base',
  name: 'Base',
  description: '',
  mealPeriods: ['lunch'],
  ingredients: [],
  instructions: [],
  allergenTags: [],
  dietTags: ['vegetarian'],
  nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 },
  price: { amountCents: 1000, currency: 'USD' },
  preparationMinutes: 20,
  imageUrl: null,
  available: true,
  source: 'local',
  catalogVersion: '1.0.0',
  provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
  nutritionProvenance: {
    origin: 'usda-derived',
    dataset: 'FNDDS 2022-10-28',
    servings: 2,
    reason: null,
  },
};

const makeMeal = (overrides: Partial<Meal>): Meal => ({ ...BASE, ...overrides });

const scopeOf = (
  eligible: readonly Meal[],
  context?: readonly Meal[],
  /**
   * What "now" is for the question under test. `lunch` by default because it is the period the
   * fixtures below mostly carry, so a test that does not care about the clock reads unchanged.
   *
   * Passed explicitly by the `current-period` tests, which are the only ones whose subject it is.
   */
  currentPeriod: MealPeriod = 'lunch',
): ChatRetrievalResult => ({
  eligible,
  context: context ?? eligible,
  currentPeriod,
});

/** Narrows for assertions, and fails the test rather than the type system if it is unresolved. */
function resolved(outcome: AnswerOutcome): ResolvedAnswer {
  if (outcome.kind === 'unresolved') {
    throw new Error(`expected a resolved answer, got unresolved: ${outcome.reason}`);
  }
  return outcome;
}

const CHEAP = makeMeal({
  id: 'a-cheap',
  name: 'Cheap Bowl',
  price: { amountCents: 500, currency: 'USD' },
  nutrition: { calories: 300, proteinGrams: 10, carbsGrams: 30, fatGrams: 5 },
  preparationMinutes: 10,
});
const MID = makeMeal({
  id: 'b-mid',
  name: 'Mid Plate',
  price: { amountCents: 1000, currency: 'USD' },
  nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 },
  preparationMinutes: 20,
});
const DEAR = makeMeal({
  id: 'c-dear',
  name: 'Dear Feast',
  price: { amountCents: 1500, currency: 'USD' },
  nutrition: { calories: 900, proteinGrams: 40, carbsGrams: 90, fatGrams: 30 },
  preparationMinutes: 40,
});

describe('the scope rule', () => {
  // The whole point: the cheapest meal the user could have is NOT in the five in front of them.
  const scope = scopeOf([CHEAP, MID, DEAR], [MID, DEAR]);

  it('holds over the 60-meal eligible set Plan section 20 names', () => {
    // The plan asks for this exact vector: a superlative over a 60-meal eligible set must not
    // return the winner of the 5-meal context. The three-meal case below proves the same
    // property; this one proves it at the size the system actually runs at.
    const many = Array.from({ length: 60 }, (_unused, index) =>
      makeMeal({
        id: `meal-${String(index).padStart(2, '0')}`,
        name: `Meal ${String(index)}`,
        // Cheapest is the LAST one, so it cannot be in any plausible first-five context.
        price: { amountCents: 2000 - index * 10, currency: 'USD' },
      }),
    );
    const answer = resolved(
      resolveAnswer('what is the cheapest?', scopeOf(many, many.slice(0, 5))),
    );
    expect(answer.citedMealIds).toStrictEqual(['meal-59']);
    expect(answer.figures).toStrictEqual(['14.10']);
  });

  it('resolves a superlative over the eligible set, not the context', () => {
    const answer = resolved(resolveAnswer('what is the cheapest?', scope));
    expect(answer.kind).toBe('superlative');
    expect(answer.citedMealIds).toStrictEqual(['a-cheap']);
    expect(answer.statement).toContain('Cheap Bowl');
    // Resolving over `context` would name Mid Plate at $10.00 and read as true.
    expect(answer.statement).not.toContain('Mid Plate');
    expect(answer.figures).toStrictEqual(['5.00']);
  });

  it('resolves a count over the eligible set, not the context', () => {
    const answer = resolved(resolveAnswer('how many meals do I have?', scope));
    expect(answer.figures).toStrictEqual(['3']);
  });

  it('resolves an ordering over the context, not the eligible set', () => {
    const answer = resolved(resolveAnswer('rank these by price', scope));
    expect(answer.citedMealIds).toStrictEqual(['b-mid', 'c-dear']);
    expect(answer.citedMealIds).not.toContain('a-cheap');
  });

  it('resolves a listing over the context, not the eligible set', () => {
    const answer = resolved(resolveAnswer('show me what I can eat', scope));
    expect(answer.figures).toStrictEqual(['2']);
  });

  it('resolves a total over the context, not the eligible set', () => {
    // $10.00 + $15.00 = $25.00. Over the eligible set it would be $30.00.
    const answer = resolved(resolveAnswer('what would all of these cost?', scope));
    expect(answer.statement).toContain('$25.00');
  });
});

describe('superlative', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it('names the winner and reports only the winner figure', () => {
    const answer = resolved(resolveAnswer('which has the most protein?', scope));
    expect(answer.statement).toBe('Dear Feast has the highest protein, at 40 g.');
    // 10 g and 20 g belong to meals the sentence does not mention, so they are not permitted.
    expect(answer.figures).toStrictEqual(['40']);
  });

  it('handles a lowest direction stated separately from its field', () => {
    const answer = resolved(resolveAnswer('which meal has the lowest calories?', scope));
    expect(answer.statement).toBe('Cheap Bowl has the lowest calories, at 300 kcal.');
  });

  it('reports ties explicitly rather than picking one arbitrarily', () => {
    const twin = makeMeal({ id: 'z-twin', name: 'Twin Bowl', preparationMinutes: 10 });
    const answer = resolved(resolveAnswer('what is the quickest?', scopeOf([CHEAP, MID, twin])));
    expect(answer.citedMealIds).toStrictEqual(['a-cheap', 'z-twin']);
    expect(answer.statement).toContain('share the lowest preparation time');
    expect(answer.figures).toStrictEqual(['10']);
  });

  it('turns a listing opener carrying a field into an ordering, not a superlative', () => {
    // There is no listing-beats-superlative precedence rule. Inferring a single winner from
    // "list the meals by price, cheapest first" answered a narrower question than the one
    // asked AND silently moved the scope from context to eligible. An ordering uses both
    // signals and keeps the opener's scope.
    const answer = resolved(resolveAnswer('show me the cheapest', scopeOf([CHEAP, MID, DEAR])));
    expect(answer.kind).toBe('ordering');
    expect(answer.citedMealIds).toStrictEqual(['a-cheap', 'b-mid', 'c-dear']);
  });
});

describe('the all-candidates-or-refuse rule in gather', () => {
  const unknown = makeMeal({
    id: 'd-unknown',
    name: 'Unknown Dish',
    nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
  });

  it('refuses with field-partially-known when one candidate is null', () => {
    // Ranking the two that are readable and calling the head "the lowest" would be a true
    // sentence about a set the user did not ask about.
    const outcome = resolveAnswer('which has the lowest calories?', scopeOf([CHEAP, MID, unknown]));
    expect(outcome).toStrictEqual({ kind: 'unresolved', reason: 'field-partially-known' });
  });

  it('refuses with field-unknown when no candidate is readable', () => {
    const outcome = resolveAnswer('which has the lowest calories?', scopeOf([unknown]));
    expect(outcome).toStrictEqual({ kind: 'unresolved', reason: 'field-unknown' });
  });

  it('still answers for a field that is never null', () => {
    // Price and preparation time are non-nullable, so an unknown nutrition row must not block
    // a question about them.
    const answer = resolved(resolveAnswer('what is the cheapest?', scopeOf([CHEAP, unknown])));
    expect(answer.citedMealIds).toStrictEqual(['a-cheap']);
  });
});

describe('ordering, listing, count and total', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it('orders every entry and permits every entry figure', () => {
    const answer = resolved(resolveAnswer('rank these by calories', scope));
    expect(answer.kind).toBe('ordering');
    expect(answer.statement).toBe(
      'By calories, lowest first: Cheap Bowl at 300 kcal, Mid Plate at 500 kcal, Dear Feast at 900 kcal.',
    );
    expect(answer.figures).toStrictEqual(['300', '500', '900']);
  });

  it('lists the meals shown and permits only the count', () => {
    const answer = resolved(resolveAnswer('list my options', scope));
    expect(answer.kind).toBe('listing');
    // "of your" rather than a bare count: the number is how many are SHOWN, and retrieval caps
    // that at five. Worded as a total it reads as "you have 3 meals" against a 60-meal catalog.
    expect(answer.statement).toBe('Here are 3 of your meals: Cheap Bowl, Mid Plate, Dear Feast.');
    expect(answer.figures).toStrictEqual(['3']);
    expect(answer.namedMeals).toHaveLength(3);
  });

  it('counts by a diet criterion and names no meal at all', () => {
    const vegan = makeMeal({ id: 'e-vegan', name: 'Vegan Bowl', dietTags: ['vegan'] });
    const answer = resolved(
      resolveAnswer('how many vegan meals are there?', scopeOf([CHEAP, vegan])),
    );
    expect(answer.statement).toBe('1 meal is vegan.');
    expect(answer.figures).toStrictEqual(['1']);
    // TSD 4.9: the answer is a number, so no meal needs describing.
    expect(answer.namedMeals).toStrictEqual([]);
    expect(answer.citedMealIds).toStrictEqual([]);
  });

  it('counts by a meal period', () => {
    const breakfast = makeMeal({ id: 'f-breakfast', mealPeriods: ['breakfast'] });
    const answer = resolved(
      resolveAnswer('how many breakfast meals?', scopeOf([CHEAP, MID, breakfast])),
    );
    expect(answer.figures).toStrictEqual(['1']);
  });

  it('never permits the candidate-set size alongside the count', () => {
    const answer = resolved(resolveAnswer('how many meals?', scopeOf([CHEAP, MID, DEAR])));
    expect(answer.figures).toStrictEqual(['3']);
    expect(answer.figures).toHaveLength(1);
  });

  it('totals with cent arithmetic and permits the parts and the sum', () => {
    const answer = resolved(resolveAnswer('what would all of these cost?', scope));
    expect(answer.kind).toBe('total');
    // The field name is not the grammatical subject: "The total calories ... is" does not
    // agree, and one template has to read correctly for all six fields.
    expect(answer.statement).toBe('The meals shown come to $30.00 in total.');
    expect(answer.figures).toStrictEqual(['5.00', '10.00', '15.00', '30.00']);
  });
});

describe('figures come from the formatted string, never the raw number', () => {
  it('permits the dollars-and-cents spelling and not the cent count', () => {
    const answer = resolved(resolveAnswer('what is the cheapest?', scopeOf([CHEAP, MID])));
    expect(answer.figures).toStrictEqual(['5.00']);
    // 500 is the stored value. A reader never sees it, so it must not be permitted.
    expect(answer.figures).not.toContain('500');
  });

  it('formats each field the way TSD 4.9 spells it', () => {
    expect(formatAnswerValue('price', 1010)).toBe('$10.10');
    expect(formatAnswerValue('preparation-time', 22)).toBe('22 min');
    expect(formatAnswerValue('calories', 540)).toBe('540 kcal');
    expect(formatAnswerValue('protein', 31)).toBe('31 g');
    expect(formatAnswerValue('carbohydrates', 31)).toBe('31 g');
    expect(formatAnswerValue('fat', 31)).toBe('31 g');
  });
});

describe('questions the domain will not answer', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it.each([
    ['', 'empty-question'],
    ['   ', 'empty-question'],
    ['what is the weather like', 'no-intent'],
    // Deliberate: "???" is not an empty question - the user typed something, it simply
    // contains no word this lexicon knows. `empty-question` is reserved for no input at all.
    ['???', 'no-intent'],
    ['hello there', 'greeting'],
    ['what can you do?', 'greeting'],
  ] as const)('answers %o with %s', (question, reason) => {
    expect(resolveAnswer(question, scope)).toStrictEqual({ kind: 'unresolved', reason });
  });

  it('refuses a question naming two different fields', () => {
    expect(resolveAnswer('what is the price and the calories?', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'ambiguous-intent',
    });
  });

  it('refuses a question demanding two directions', () => {
    expect(resolveAnswer('what is the cheapest and the most expensive?', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'ambiguous-intent',
    });
  });

  it('refuses a field with nothing to do with it', () => {
    expect(resolveAnswer('calories?', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'incomplete-intent',
    });
  });

  it('refuses an ordering that names no field', () => {
    expect(resolveAnswer('sort these', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'incomplete-intent',
    });
  });

  it('refuses a numeric threshold rather than answering a different question', () => {
    // PRD 7.4 offers "How many are under $10?" but TSD 4.9 defines no numeric criterion. The
    // dangerous failure is not refusing - it is answering with the size of the whole set.
    const outcome = resolveAnswer('how many are under $10?', scope);
    expect(outcome).toStrictEqual({ kind: 'unresolved', reason: 'incomplete-intent' });
  });

  it('refuses when the scoped set is empty', () => {
    expect(resolveAnswer('what is the cheapest?', scopeOf([]))).toStrictEqual({
      kind: 'unresolved',
      reason: 'no-candidates',
    });
    expect(resolveAnswer('list my options', scopeOf([CHEAP], []))).toStrictEqual({
      kind: 'unresolved',
      reason: 'no-candidates',
    });
  });
});

describe('a criterion narrows the set instead of being discarded', () => {
  const vegan = makeMeal({ id: 'a-vegan', name: 'Vegan Bowl', dietTags: ['vegan'] });
  const veggie = makeMeal({ id: 'b-veggie', name: 'Veg Pie', dietTags: ['vegetarian'] });
  const meaty = makeMeal({ id: 'c-meaty', name: 'Steak Dinner', dietTags: ['regular'] });
  const scope = scopeOf([vegan, veggie, meaty]);

  it('lists only the meals matching the criterion the question named', () => {
    // The defect this replaces: the classifier extracted `vegan`, `decide` threw it away, and
    // the answer listed the steak. Every id was cited and the only figure was permitted, so
    // containment could not have caught it - the sentence was simply about the wrong meals.
    const answer = resolved(resolveAnswer('what vegan options do I have?', scope));
    expect(answer.kind).toBe('listing');
    expect(answer.citedMealIds).toStrictEqual(['a-vegan']);
    expect(answer.statement).toBe('Here is 1 of your vegan meals: Vegan Bowl.');
  });

  it('counts by diet SATISFACTION, not by the literal tag', () => {
    // TSD 4.5 makes a vegan dish satisfy a vegetarian user, and calls the asymmetry
    // intentional. Testing `dietTags.includes('vegetarian')` would report 1 here and
    // contradict the module every other part of the system consults.
    const answer = resolved(resolveAnswer('how many vegetarian meals are there?', scope));
    expect(answer.figures).toStrictEqual(['2']);
  });

  it('counts zero as an answer rather than refusing', () => {
    const answer = resolved(
      resolveAnswer('how many vegan meals are there?', scopeOf([veggie, meaty])),
    );
    expect(answer.statement).toBe('0 meals are vegan.');
  });

  it('refuses two criteria rather than silently counting everything', () => {
    // Two criteria collapse to "no criterion", and without this the answer was the size of
    // the whole eligible set presented as the count of a narrowed one.
    expect(resolveAnswer('how many vegan breakfast meals are there?', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'ambiguous-intent',
    });
  });
});

describe('a classified signal is never silently discarded', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it.each([
    ['how many calories are in these'],
    ['how many minutes do these take'],
    ['how many meals cost the least'],
  ] as const)('refuses the field-valued count %o', (question) => {
    // TSD 4.9 defines no field-valued count. Before this, every one of these answered
    // "3 meals match your preferences." - fluent, confident, and about a different question.
    expect(resolveAnswer(question, scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'incomplete-intent',
    });
  });

  it('turns a listing carrying a field into an ordering rather than dropping the field', () => {
    const answer = resolved(resolveAnswer('list these by calories', scope));
    expect(answer.kind).toBe('ordering');
    expect(answer.statement).toContain('By calories, lowest first');
  });

  it('refuses a listing carrying a direction it has nothing to sort by', () => {
    expect(resolveAnswer('show me the highest', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'incomplete-intent',
    });
  });

  it('refuses a total carrying a direction, which a sum has no use for', () => {
    expect(resolveAnswer('what is the total cheapest', scope)).toStrictEqual({
      kind: 'unresolved',
      reason: 'incomplete-intent',
    });
  });
});

describe('comparatives', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it.each([
    ['which is cheaper', 'Cheap Bowl'],
    ['which is faster', 'Cheap Bowl'],
    ['what is the priciest', 'Dear Feast'],
  ] as const)('resolves %o', (question, winner) => {
    // All three reached no lexicon term at all and classified as `no-intent`.
    expect(resolved(resolveAnswer(question, scope)).statement).toContain(winner);
  });
});

describe('the lexicon compiles longest-phrase-first', () => {
  it('orders every table by descending token count', () => {
    // Token claiming is only correct if the longer phrase is offered first - that is what
    // makes `preparation time` beat `time`. With the current tables every sub-phrase resolves
    // to the same value as its parent, so no behavioural test can observe the claiming
    // itself; this pins the precondition it depends on, which is what can be pinned.
    for (const table of [COMPILED_SENSES, COMPILED_SHAPES, COMPILED_CRITERIA]) {
      const widths = table.map((term) => term.tokens.length);
      expect(widths).toStrictEqual([...widths].sort((left, right) => right - left));
    }
  });
});

describe('classification detail', () => {
  const scope = scopeOf([CHEAP, MID, DEAR]);

  it('reads "preparation time" as one phrase', () => {
    // Token claiming is what stops the inner `time` matching again. With the present tables
    // both spellings name the same field, so this asserts the outcome rather than the
    // mechanism; the mechanism matters for any future term whose sub-phrase differs.
    const answer = resolved(resolveAnswer('rank these by preparation time', scope));
    expect(answer.statement).toContain('By preparation time');
  });

  it.each([
    ['rank these by prep time', 'By preparation time'],
    ['rank these by cooking time', 'By preparation time'],
    ['rank these by carbs', 'By carbohydrates'],
    ['rank these by energy', 'By calories'],
  ] as const)('reads %o as %s', (question, expected) => {
    expect(resolved(resolveAnswer(question, scope)).statement).toContain(expected);
  });

  it.each([
    ['rank these by calories'],
    ['which has the fewest calories'],
    ['what is the lowest calories'],
  ] as const)('resolves the PLURAL spelling %o, not only the singular', (question) => {
    // The trap that cost six tests: `compileTerms` singularises every phrase, and
    // `singularize` folds `-ies` to `-y`, so the word "calories" arrives as `calory` and never
    // as `calorie`. A lexicon holding only the singular matched nothing, and every calorie
    // question fell through to `incomplete-intent`. Plurals that fold regularly - carbs,
    // minutes, options - were never affected, which is what made this one easy to miss.
    // Asserting the STATEMENT, not merely that something resolved: the old version passed
    // for "how many xyzzy are in these" too, so it would still have passed with the
    // `calories` entry deleted from the lexicon.
    expect(resolved(resolveAnswer(question, scope)).statement).toMatch(/kcal/);
  });

  it.each([
    ['rank these by carbs', 'By carbohydrates'],
    ['rank these by minutes', 'By preparation time'],
    ['list my options', 'Here are'],
  ] as const)('resolves the regularly folding plural %o', (question, expected) => {
    expect(resolved(resolveAnswer(question, scope)).statement).toContain(expected);
  });

  it('is unaffected by surrounding stop words and punctuation', () => {
    const plain = resolved(resolveAnswer('what is the cheapest?', scope));
    const chatty = resolved(resolveAnswer('Hi! So, what is the cheapest one for me?', scope));
    expect(chatty.statement).toBe(plain.statement);
  });
});
