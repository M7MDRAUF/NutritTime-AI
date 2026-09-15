/**
 * Answer lexicon (TSD 4.9).
 *
 * A keyword lexicon, deliberately: not a regex, and emphatically not a model. The assistant is
 * only allowed to phrase an answer the domain has already computed, so the step that decides
 * WHAT is being asked has to be inspectable and testable. Every entry here is a decision a
 * reader can check.
 *
 * The type vocabulary lives in this file rather than in `answer.ts` because the tables are
 * typed in terms of it and `answer.ts` imports the tables - putting the types the other way
 * round would make the two modules circular. `answer.ts` re-exports them, so a consumer of
 * `@nutritime/domain` sees the surface TSD 4.9 describes.
 */

import type { DietTag, MealPeriod } from '@nutritime/contracts';
import { singularize, tokenize } from './text.js';

export const ANSWER_FIELDS = [
  'price',
  'preparation-time',
  'calories',
  'protein',
  'carbohydrates',
  'fat',
] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

export type Direction = 'lowest' | 'highest';

/**
 * The kinds a SHAPE TERM can name. `superlative` is deliberately absent: no word in the shape
 * table means "superlative" - it is inferred from a field and a direction together, so giving
 * the two the same type would let `decide` switch on a case that can never arrive.
 */
export type ShapeKind = 'ordering' | 'listing' | 'count' | 'total';

export type AnswerKind = ShapeKind | 'superlative';

/** How a field reads inside a sentence. */
export const FIELD_LABELS: Readonly<Record<AnswerField, string>> = {
  price: 'price',
  'preparation-time': 'preparation time',
  calories: 'calories',
  protein: 'protein',
  carbohydrates: 'carbohydrates',
  fat: 'fat',
};

/**
 * A sense term names a field, a direction, or both.
 *
 * `cheapest` carries both, which is the common case and the reason the two are one table: a
 * user asking for the cheapest meal has stated a field and a direction in one word.
 */
export interface Sense {
  readonly field?: AnswerField;
  readonly direction?: Direction;
}

export const SENSE_TERMS: readonly (readonly [string, Sense])[] = [
  // Field and direction together.
  ['cheapest', { field: 'price', direction: 'lowest' }],
  ['least expensive', { field: 'price', direction: 'lowest' }],
  ['most expensive', { field: 'price', direction: 'highest' }],
  ['dearest', { field: 'price', direction: 'highest' }],
  ['quickest', { field: 'preparation-time', direction: 'lowest' }],
  ['fastest', { field: 'preparation-time', direction: 'lowest' }],
  ['slowest', { field: 'preparation-time', direction: 'highest' }],
  ['longest to make', { field: 'preparation-time', direction: 'highest' }],
  ['lightest', { field: 'calories', direction: 'lowest' }],
  ['heaviest', { field: 'calories', direction: 'highest' }],

  // Field alone. `preparation time` must be compiled before `time`, which the longest-first
  // ordering and token claiming together guarantee.
  ['preparation time', { field: 'preparation-time' }],
  ['prep time', { field: 'preparation-time' }],
  ['cooking time', { field: 'preparation-time' }],
  ['cook time', { field: 'preparation-time' }],
  ['time to make', { field: 'preparation-time' }],
  ['time', { field: 'preparation-time' }],
  ['minute', { field: 'preparation-time' }],
  ['price', { field: 'price' }],
  ['cost', { field: 'price' }],
  // BOTH spellings are needed, and the plural is the one that matters. `compileTerms`
  // singularises each phrase, and `singularize` folds `-ies` to `-y`: `calories` becomes
  // `calory`, NOT `calorie`. Listing only the singular meant the commonest nutrition word a
  // user can type matched nothing at all, and every calorie question fell through to
  // `incomplete-intent`.
  ['calorie', { field: 'calories' }],
  ['calories', { field: 'calories' }],
  ['kcal', { field: 'calories' }],
  ['energy', { field: 'calories' }],
  ['protein', { field: 'protein' }],
  ['carbohydrate', { field: 'carbohydrates' }],
  ['carb', { field: 'carbohydrates' }],
  ['fat', { field: 'fat' }],

  // Comparatives. Without these "which is cheaper" and "which is faster" reach no term at
  // all and classify as `no-intent`. `cheaper than` is in the threshold table and is matched
  // first, so the bare comparative here cannot swallow it.
  ['cheaper', { field: 'price', direction: 'lowest' }],
  ['pricier', { field: 'price', direction: 'highest' }],
  ['priciest', { field: 'price', direction: 'highest' }],
  ['faster', { field: 'preparation-time', direction: 'lowest' }],
  ['quicker', { field: 'preparation-time', direction: 'lowest' }],
  ['slower', { field: 'preparation-time', direction: 'highest' }],
  // Direction alone, for a question that names its field separately: "which has the most
  // protein".
  ['lowest', { direction: 'lowest' }],
  ['least', { direction: 'lowest' }],
  ['lower', { direction: 'lowest' }],
  ['smallest', { direction: 'lowest' }],
  ['fewest', { direction: 'lowest' }],
  // `shortest` and `longest` are the words a duration attracts, and their absence was measured:
  // "which has the lowest price" resolved while "which has the shortest preparation time" did
  // not, on the same shape, because `lowest` was here and `shortest` was not. Bare directions
  // rather than `preparation-time` senses on purpose - "the shortest ingredient list" is a
  // sentence someone may yet write, and pinning the field here would answer it about the clock.
  // (`longest to make` above stays: it is a longer phrase, so it claims its tokens first.)
  ['shortest', { direction: 'lowest' }],
  ['highest', { direction: 'highest' }],
  ['most', { direction: 'highest' }],
  ['more', { direction: 'highest' }],
  ['largest', { direction: 'highest' }],
  ['biggest', { direction: 'highest' }],
  ['longest', { direction: 'highest' }],
];

export const SHAPE_TERMS: readonly (readonly [string, ShapeKind])[] = [
  ['how many', 'count'],
  ['how much in total', 'total'],
  ['count', 'count'],
  ['altogether', 'total'],
  ['in total', 'total'],
  ['all of these', 'total'],
  ['all of them', 'total'],
  ['total', 'total'],
  ['combined', 'total'],
  ['sum', 'total'],
  ['sort', 'ordering'],
  ['sorted', 'ordering'],
  ['order by', 'ordering'],
  ['rank', 'ordering'],
  ['ranked', 'ordering'],
  ['list', 'listing'],
  ['show me', 'listing'],
  ['what can i eat', 'listing'],
  ['option', 'listing'],
];

/**
 * Comparisons against a number. **Matching one of these makes the question unanswerable**, and
 * that is the point.
 *
 * PRD 7.4 offers "How many are under $10?" as a supported count, but the criterion table TSD
 * 4.9 defines holds diet tags and meal periods only - there is no numeric threshold in it.
 * Without this table that question classifies as a bare `count` and is answered with the size
 * of the whole eligible set: a confident number, phrased as an answer, to a question nobody
 * asked. Failing closed is the only honest option until the threshold criterion is specified.
 *
 * Checked before the sense table so `more than` is claimed here rather than as the direction
 * term `more`.
 */
export const THRESHOLD_TERMS: readonly string[] = [
  'under',
  'over',
  'below',
  'above',
  'less than',
  'fewer than',
  'more than',
  'cheaper than',
  'at most',
  'at least',
  'no more than',
  'up to',
];

export const GREETING_TERMS: readonly string[] = [
  'hello',
  'hi',
  'hey',
  'thanks',
  'thank you',
  'good morning',
  'good afternoon',
  'good evening',
  'how are you',
  'cheers',
  // PRD 7.4 lists Capability ("What can you do?") as its own shape, but TSD 4.9 defines no
  // capability kind. `greeting` is the closest declared outcome, and the route answers it with
  // a canned line rather than a model call, which is the behaviour PRD describes.
  'what can you do',
  'what can you tell me',
];

/** What a `count` question can count. A criterion narrows the eligible set; it is not a field. */
export type CountCriterion =
  | { readonly sort: 'diet'; readonly tag: DietTag }
  | { readonly sort: 'period'; readonly period: MealPeriod };

export const COUNT_CRITERIA: readonly (readonly [string, CountCriterion])[] = [
  ['vegan', { sort: 'diet', tag: 'vegan' }],
  ['vegetarian', { sort: 'diet', tag: 'vegetarian' }],
  ['gluten aware', { sort: 'diet', tag: 'gluten-aware' }],
  ['gluten free', { sort: 'diet', tag: 'gluten-aware' }],
  ['halal', { sort: 'diet', tag: 'halal-preference' }],
  ['breakfast', { sort: 'period', period: 'breakfast' }],
  ['lunch', { sort: 'period', period: 'lunch' }],
  ['dinner', { sort: 'period', period: 'dinner' }],
  ['snack', { sort: 'period', period: 'snack' }],
];

/** A lexicon entry reduced to the tokens the classifier will actually compare against. */
export interface CompiledTerm<T> {
  readonly phrase: string;
  readonly tokens: readonly string[];
  readonly value: T;
}

/**
 * Tokenise and singularise every phrase, then order longest-phrase-first.
 *
 * Unlike the allergen lexicon, this ordering IS load-bearing: `answer.ts` claims a matched
 * phrase's token positions, so the first rule to match a position wins it outright. That is
 * what makes `preparation time` beat `time` without an ordering hack, and it only works if the
 * longer phrase is offered first.
 */
export function compileTerms<T>(entries: readonly (readonly [string, T])[]): CompiledTerm<T>[] {
  return entries
    .map(([phrase, value]) => ({
      phrase,
      tokens: tokenize(phrase).map(singularize),
      value,
    }))
    .filter((term) => term.tokens.length > 0)
    .sort((left, right) => right.tokens.length - left.tokens.length);
}

export const COMPILED_SENSES: readonly CompiledTerm<Sense>[] = compileTerms(SENSE_TERMS);
export const COMPILED_SHAPES: readonly CompiledTerm<ShapeKind>[] = compileTerms(SHAPE_TERMS);
export const COMPILED_CRITERIA: readonly CompiledTerm<CountCriterion>[] =
  compileTerms(COUNT_CRITERIA);
export const COMPILED_GREETINGS: readonly CompiledTerm<true>[] = compileTerms(
  GREETING_TERMS.map((term) => [term, true] as const),
);
export const COMPILED_THRESHOLDS: readonly CompiledTerm<true>[] = compileTerms(
  THRESHOLD_TERMS.map((term) => [term, true] as const),
);
