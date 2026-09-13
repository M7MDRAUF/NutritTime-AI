import { describe, expect, it } from 'vitest';
import type { Meal } from '@nutritime/contracts';
import { MAX_CHAT_CONTEXT_MEALS, retrieveChatMeals } from './chat-retrieval.js';
import type { ChatRetrievalInput, RetrievalPreferences } from './chat-retrieval.js';

/**
 * Plan.md 19.3 requires five vectors here: safety before ranking, dislike demoting rather than
 * excluding, the no-lexical-match fallback, the five-cap, and an empty eligible set.
 *
 * The one that matters most is the first. Retrieval decides what the model is allowed to see,
 * so a meal that escapes these filters is a meal the assistant can describe to someone who
 * must not eat it.
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

const prefs = (overrides: Partial<RetrievalPreferences> = {}): RetrievalPreferences => ({
  diet: 'vegetarian',
  allergies: [],
  dislikedIngredients: [],
  ...overrides,
});

const retrieve = (overrides: Partial<ChatRetrievalInput>) =>
  retrieveChatMeals({ question: '', preferences: prefs(), meals: [], ...overrides });

const idsOf = (meals: readonly Meal[]): readonly string[] => meals.map((meal) => meal.id);

describe('safety runs before ranking', () => {
  it('rejects a meal whose declared tag conflicts, however well it matches the question', () => {
    const peanutStew = makeMeal({
      id: 'peanut-stew',
      name: 'Peanut Stew',
      allergenTags: ['peanut'],
    });
    const result = retrieve({
      question: 'peanut stew',
      preferences: prefs({ allergies: ['peanut'] }),
      meals: [peanutStew],
    });
    // The perfect lexical match. Ranking never gets to see it.
    expect(result.eligible).toStrictEqual([]);
    expect(result.context).toStrictEqual([]);
  });

  it('rejects a meal whose allergen is only inferable from its ingredients', () => {
    // No declared tag at all. `hasAllergenConflict` works on effective tags - declared union
    // inferred - and checking the declared list alone is how an untagged nut reaches someone
    // who cannot eat one.
    const untagged = makeMeal({
      id: 'untagged-satay',
      name: 'Satay Noodles',
      allergenTags: [],
      ingredients: [{ name: 'Peanut butter', measure: '2 tbsp' }],
    });
    expect(
      retrieve({ meals: [untagged], preferences: prefs({ allergies: ['peanut'] }) }).eligible,
    ).toStrictEqual([]);
  });

  it('drops diet-incompatible and unavailable meals', () => {
    const meaty = makeMeal({ id: 'meaty', dietTags: ['regular'] });
    const gone = makeMeal({ id: 'gone', available: false });
    const fine = makeMeal({ id: 'fine' });
    expect(idsOf(retrieve({ meals: [meaty, gone, fine] }).eligible)).toStrictEqual(['fine']);
  });
});

describe('a disliked ingredient demotes and never excludes', () => {
  const withOnion = makeMeal({
    id: 'a-with-onion',
    name: 'Onion Soup',
    ingredients: [{ name: 'Onions', measure: '2' }],
  });
  const withoutOnion = makeMeal({ id: 'z-without-onion', name: 'Tomato Soup' });

  it('keeps a disliked meal eligible and sorts it behind one without', () => {
    const result = retrieve({
      question: 'soup',
      meals: [withOnion, withoutOnion],
      preferences: prefs({ dislikedIngredients: ['onion'] }),
    });
    expect(idsOf(result.eligible)).toStrictEqual(['a-with-onion', 'z-without-onion']);
    // Both match "soup" equally, and the disliked one sorts first by id. The partition is
    // what puts it second, so this would pass by accident if ordering were left to the ranker.
    expect(idsOf(result.context)).toStrictEqual(['z-without-onion', 'a-with-onion']);
  });

  it('still answers a user whose every eligible meal contains the disliked ingredient', () => {
    // The reason a dislike is a penalty in 4.6 and a demotion here rather than a filter:
    // excluding would leave this user with nothing at all.
    const result = retrieve({
      question: 'soup',
      meals: [withOnion],
      preferences: prefs({ dislikedIngredients: ['onion'] }),
    });
    expect(idsOf(result.eligible)).toStrictEqual(['a-with-onion']);
    expect(idsOf(result.context)).toStrictEqual(['a-with-onion']);
  });
});

describe('the context set', () => {
  const many = Array.from({ length: 9 }, (_unused, index) =>
    makeMeal({ id: `meal-${String(index)}`, name: `Curry ${String(index)}` }),
  );

  it('caps at five when many meals match lexically', () => {
    const result = retrieve({ question: 'curry', meals: many });
    expect(result.eligible).toHaveLength(9);
    expect(result.context).toHaveLength(MAX_CHAT_CONTEXT_MEALS);
  });

  it('caps at five when nothing matches and the fallback supplies the set', () => {
    const result = retrieve({ question: 'is that quick', meals: many });
    expect(result.context).toHaveLength(MAX_CHAT_CONTEXT_MEALS);
  });

  it('falls back to the eligible set when the question names no meal', () => {
    // A general question matches no name, and a grounded answer beats a refusal.
    const result = retrieve({ question: 'what is quick', meals: many });
    expect(idsOf(result.context)).toStrictEqual(idsOf(many.slice(0, MAX_CHAT_CONTEXT_MEALS)));
  });

  it('prefers a lexical match over the fallback even when only one meal matches', () => {
    // Distinct names, so exactly one meal matches. The `many` fixture cannot show this: every
    // one of those is named "Curry N", so "curry 7" matches all nine and merely ranks meal-7
    // first. A real match exists, so the fallback must not pad the context back up to five.
    const distinct = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map((name) =>
      makeMeal({ id: name.toLowerCase(), name }),
    );
    expect(idsOf(retrieve({ question: 'gamma', meals: distinct }).context)).toStrictEqual([
      'gamma',
    ]);
  });

  it('keeps the partition order in the fallback path too', () => {
    const disliked = makeMeal({ id: 'a-disliked', ingredients: [{ name: 'Onion', measure: '1' }] });
    const liked = makeMeal({ id: 'z-liked' });
    const result = retrieve({
      question: 'something unrelated entirely',
      meals: [disliked, liked],
      preferences: prefs({ dislikedIngredients: ['onion'] }),
    });
    expect(idsOf(result.context)).toStrictEqual(['z-liked', 'a-disliked']);
  });
});

describe('an empty eligible set', () => {
  it('returns both sets empty rather than throwing', () => {
    const result = retrieve({
      question: 'anything',
      meals: [makeMeal({ id: 'meaty', dietTags: ['regular'] })],
      preferences: prefs({ diet: 'vegan' }),
    });
    expect(result.eligible).toStrictEqual([]);
    expect(result.context).toStrictEqual([]);
  });

  it('returns both sets empty for an empty catalog', () => {
    expect(retrieve({ meals: [] })).toStrictEqual({ eligible: [], context: [] });
  });
});

describe('eligible and context are genuinely different sets', () => {
  it('keeps every eligible meal while capping the context, so a superlative can outrank it', () => {
    // This is the property 4.9 depends on. If retrieval returned only the five, a superlative
    // would answer over five and claim it answered over everything.
    const meals = Array.from({ length: 12 }, (_unused, index) =>
      makeMeal({ id: `meal-${String(index).padStart(2, '0')}` }),
    );
    const result = retrieve({ question: 'no match here', meals });
    expect(result.eligible).toHaveLength(12);
    expect(result.context).toHaveLength(MAX_CHAT_CONTEXT_MEALS);
  });
});
