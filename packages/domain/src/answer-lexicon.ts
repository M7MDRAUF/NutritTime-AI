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
  ['option', 'listing'],
  /*
    **The "what ... can I eat" family, spelled out because matching is CONTIGUOUS.**

    `claimMatches` walks token positions, so a phrase only matches when its tokens are adjacent.
    `what can i eat` therefore does NOT match "what **meals** can I eat" - one inserted noun and
    the question falls through to `no-intent`. That was measured at P28 on the most natural
    phrasing of the question this app is named after: "what can i eat right now" resolved and
    "what meals can i eat right now" refused, which is the kind of difference no user would
    forgive or understand.

    Listed as whole phrases rather than solved with a gap-tolerant matcher on purpose: a matcher
    that skipped tokens would let "what can i NOT eat" match too, and inverting a question about
    allergies is the one mistake this domain must never make. Each entry here is a decision a
    reader can check, which is what TSD 4.9 asks the lexicon to be.

    Longest-first compilation means these claim their tokens before the bare `eat`.
  */
  ['what can i eat', 'listing'],
  ['what meal can i eat', 'listing'],
  ['what meals can i eat', 'listing'],
  ['which meal can i eat', 'listing'],
  ['which meals can i eat', 'listing'],
  ['what food can i eat', 'listing'],
  ['what can i have', 'listing'],
  ['what meal can i have', 'listing'],
  ['what meals can i have', 'listing'],
  /*
    **With an interposed "that", which is how the question was actually typed.**

    "what meals THAT i can eat right now" - not textbook English, and the exact phrasing a real
    user produced on first contact with the assistant. Contiguous matching means it shares no
    phrase with the entries above, so it refused while its neighbour answered.

    Kept as explicit entries rather than by teaching `tokenize` to drop filler words. Dropping
    fillers would make these free, and it would also make "what can i NOT eat" collapse onto
    "what can i eat" the day someone added `not` to the same list - and inverting a question about
    what a user may eat is the one mistake this domain must never make. An explicit table cannot
    do that by accident.
  */
  ['what meal that i can eat', 'listing'],
  ['what meals that i can eat', 'listing'],
  ['what meal that i can have', 'listing'],
  ['what meals that i can have', 'listing'],
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
export type ResolvedCriterion =
  | { readonly sort: 'diet'; readonly tag: DietTag }
  | { readonly sort: 'period'; readonly period: MealPeriod };

/**
 * What the LEXICON can emit, which is a superset of what anything downstream may read.
 *
 * The split is the point: `ResolvedCriterion` has no relative variant, so every consumer that
 * reads `.period` is a compile error until `answer.ts` has normalised `'current-period'` away.
 * The invariant was a comment first and the compiler rejected three readers immediately - which
 * is a better guard than the comment was.
 */
export type CountCriterion =
  | ResolvedCriterion
  /**
   * **"right now" - the period the question was asked in, not a period it names (P28).**
   *
   * A third variant rather than a `MealPeriod` value, because which period this means is not
   * known when the lexicon is compiled. `answer.ts` normalises it to a `'period'` criterion
   * against `ChatRetrievalResult.currentPeriod` before anything reads it, so nothing downstream
   * - `matchesCriterion` included - ever sees this shape.
   *
   * It exists because *"what can I eat right now?"* was the one question this app is named after
   * and could not answer, while *"what can I eat for breakfast"* already worked. The gap was
   * never the shape: PRD 7.4's **Listing** covers a criterion-scoped list and TSD 4.9 already
   * had period criteria. Nobody could say which period "now" was.
   */
  | { readonly sort: 'current-period' };

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
  /*
    Relative time, resolved against the period the client sent with the question.

    Every one of these is a phrase a person actually types when they mean "at this moment", and
    the list is deliberately short: each entry is unambiguous about meaning NOW. "today" and
    "tonight" are NOT here - "what can I eat today" spans every period rather than the current
    one, and "tonight" names the evening whether or not it is evening yet, so both would answer a
    different question from the one asked. Adding them needs a period-range criterion, which
    TSD 4.9 does not define.
  */
  ['right now', { sort: 'current-period' }],
  ['now', { sort: 'current-period' }],
  ['at the moment', { sort: 'current-period' }],
  ['at this time of day', { sort: 'current-period' }],
  ['this time of day', { sort: 'current-period' }],
  ['currently', { sort: 'current-period' }],
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
