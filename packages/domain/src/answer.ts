/**
 * Answer resolvers (TSD 4.9, SDD 9.1).
 *
 * The centrepiece. **The domain computes the answer; the model only phrases it.** Every number
 * a user will read is decided here, by code a test can pin, and `figures` is the exhaustive
 * list of numbers the phrasing is permitted to contain.
 *
 * Two rules carry almost all the risk:
 *
 * 1. **The scope rule.** A superlative and a count assert something about the user's whole
 *    eligible set; an ordering, a listing and a total describe what is in front of them.
 *    Resolving a superlative over `context` produces "the cheapest meal is X" where X is merely
 *    the cheapest of five - a sentence that reads as true and is false.
 * 2. **All candidates or refuse.** `gather` will not rank a subset. A figure the domain cannot
 *    establish for every candidate is not reported at all.
 */

import type { Meal } from '@nutritime/contracts';
import { MAX_CHAT_CONTEXT_MEALS } from './chat-retrieval.js';
import type { ChatRetrievalResult } from './chat-retrieval.js';
import { formatMoney, sumMoney } from './money.js';
import { compareIds, singularize, tokenize } from './text.js';
import {
  ANSWER_FIELDS,
  COMPILED_CRITERIA,
  COMPILED_GREETINGS,
  COMPILED_SENSES,
  COMPILED_SHAPES,
  COMPILED_THRESHOLDS,
  FIELD_LABELS,
} from './answer-lexicon.js';
import { isDietCompatible } from './diet.js';
import type {
  AnswerField,
  AnswerKind,
  CompiledTerm,
  CountCriterion,
  Direction,
  ResolvedCriterion,
  ShapeKind,
} from './answer-lexicon.js';

export { ANSWER_FIELDS };
export type { AnswerField, AnswerKind, Direction };

export interface RankedMeal {
  readonly meal: Meal;
  readonly value: number;
  /** `"$10.10"`, `"22 min"`, `"540 kcal"`, `"31 g"`. */
  readonly formatted: string;
}

export interface ResolvedAnswer {
  readonly kind: AnswerKind;
  /** One complete sentence, already correct. The model rephrases; it does not compute. */
  readonly statement: string;
  /** Every number the statement is permitted to contain. Empty forbids all of them. */
  readonly figures: readonly string[];
  readonly citedMealIds: readonly string[];
  /** The meals the prompt may describe (§5.6). */
  readonly namedMeals: readonly Meal[];
}

export type UnresolvedReason =
  | 'empty-question'
  | 'no-intent'
  | 'incomplete-intent'
  | 'ambiguous-intent'
  | 'field-unknown'
  | 'field-partially-known'
  | 'no-candidates'
  | 'greeting';

export interface UnresolvedAnswer {
  readonly kind: 'unresolved';
  readonly reason: UnresolvedReason;
}

export type AnswerOutcome = ResolvedAnswer | UnresolvedAnswer;

const unresolved = (reason: UnresolvedReason): UnresolvedAnswer => ({ kind: 'unresolved', reason });

// ------------------------------------------------------------------- fields

/** `null` means the catalog does not know, and TSD 7.4 forbids treating that as a zero. */
function readField(field: AnswerField, meal: Meal): number | null {
  switch (field) {
    case 'price':
      return meal.price.amountCents;
    case 'preparation-time':
      return meal.preparationMinutes;
    case 'calories':
      return meal.nutrition.calories;
    case 'protein':
      return meal.nutrition.proteinGrams;
    case 'carbohydrates':
      return meal.nutrition.carbsGrams;
    case 'fat':
      return meal.nutrition.fatGrams;
  }
}

export function formatAnswerValue(field: AnswerField, value: number): string {
  switch (field) {
    case 'price':
      // Formatting, not constructing: `formatMoney` takes the interface, so a summed total
      // above a single meal's schema ceiling still renders.
      return formatMoney({ amountCents: value, currency: 'USD' });
    case 'preparation-time':
      return `${String(value)} min`;
    case 'calories':
      return `${String(value)} kcal`;
    case 'protein':
    case 'carbohydrates':
    case 'fat':
      return `${String(value)} g`;
  }
}

/** Numbers exactly as a reader will see them: `"$10.10"` permits `"10.10"`, not `"1010"`. */
function figuresIn(formatted: string): string[] {
  return formatted.match(/\d+(?:\.\d+)?/g) ?? [];
}

// --------------------------------------------------------------- classifying

interface Intent {
  readonly shape: ShapeKind | null;
  readonly field: AnswerField | null;
  readonly direction: Direction | null;
  readonly criterion: CountCriterion | null;
  readonly greeting: boolean;
  readonly threshold: boolean;
  readonly ambiguous: boolean;
}

/**
 * Every occurrence of every term, claiming the token positions it consumes.
 *
 * Claiming is what makes `preparation time` beat `time`: the longer phrase is offered first
 * (the lexicon is compiled longest-first), it takes both positions, and the shorter rule then
 * finds nothing unclaimed to match.
 */
function claimMatches<T>(
  tokens: readonly string[],
  terms: readonly CompiledTerm<T>[],
  claimed: Set<number>,
): T[] {
  const found: T[] = [];
  for (const term of terms) {
    const width = term.tokens.length;
    for (let start = 0; start + width <= tokens.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < width; offset += 1) {
        // noUncheckedIndexedAccess: both reads are `string | undefined`, and two undefined
        // reads must never compare equal and count as a match.
        const actual = tokens[start + offset];
        const expected = term.tokens[offset];
        if (
          actual === undefined ||
          expected === undefined ||
          actual !== expected ||
          claimed.has(start + offset)
        ) {
          matched = false;
          break;
        }
      }
      if (matched) {
        for (let offset = 0; offset < width; offset += 1) {
          claimed.add(start + offset);
        }
        found.push(term.value);
      }
    }
  }
  return found;
}

function only<T>(values: readonly T[]): { readonly value: T | null; readonly ambiguous: boolean } {
  const distinct = [...new Set(values)];
  const head = distinct[0];
  return {
    value: distinct.length === 1 && head !== undefined ? head : null,
    ambiguous: distinct.length > 1,
  };
}

function classify(question: string): Intent {
  const tokens = tokenize(question).map(singularize);
  const claimed = new Set<number>();

  // Order matters. Thresholds first so `more than` is claimed as a comparison rather than as
  // the direction term `more`; shapes before senses so `how much in total` is not eaten
  // piecemeal; greetings last, since a greeting is only consulted when nothing else matched.
  const thresholds = claimMatches(tokens, COMPILED_THRESHOLDS, claimed);
  const shapes = claimMatches(tokens, COMPILED_SHAPES, claimed);
  const senses = claimMatches(tokens, COMPILED_SENSES, claimed);
  const criteria = claimMatches(tokens, COMPILED_CRITERIA, claimed);
  const greetings = claimMatches(tokens, COMPILED_GREETINGS, claimed);

  const shape = only(shapes);
  const field = only(senses.map((sense) => sense.field).filter((f) => f !== undefined));
  const direction = only(senses.map((sense) => sense.direction).filter((d) => d !== undefined));
  const criterion = only(criteria);

  return {
    shape: shape.value,
    field: field.value,
    direction: direction.value,
    criterion: criterion.value,
    greeting: greetings.length > 0,
    threshold: thresholds.length > 0,
    // `criterion.ambiguous` belongs here as much as the others. Leaving it out made "how many
    // vegan breakfast meals" collapse to no criterion at all and answer with the size of the
    // whole set - a confident number for a question nobody asked.
    ambiguous: shape.ambiguous || field.ambiguous || direction.ambiguous || criterion.ambiguous,
  };
}

// ----------------------------------------------------------------- gathering

type GatherOutcome =
  | { readonly ok: true; readonly ranked: readonly RankedMeal[] }
  | { readonly ok: false; readonly reason: 'field-unknown' | 'field-partially-known' };

/**
 * Read `field` from every candidate, or refuse.
 *
 * Ranking only the readable ones and calling the head "the cheapest" would be a true sentence
 * about a set the user did not ask about. `field-unknown` when nothing was readable,
 * `field-partially-known` when the gap is partial - the second is the more dangerous case and
 * the one a naive implementation silently papers over.
 */
function gather(
  candidates: readonly Meal[],
  field: AnswerField,
  direction: Direction,
): GatherOutcome {
  const ranked: RankedMeal[] = [];
  let unreadable = 0;

  for (const meal of candidates) {
    const value = readField(field, meal);
    if (value === null) {
      unreadable += 1;
      continue;
    }
    ranked.push({ meal, value, formatted: formatAnswerValue(field, value) });
  }

  if (unreadable > 0) {
    return { ok: false, reason: ranked.length === 0 ? 'field-unknown' : 'field-partially-known' };
  }

  ranked.sort(
    (left, right) =>
      (direction === 'lowest' ? left.value - right.value : right.value - left.value) ||
      compareIds(left.meal.id, right.meal.id),
  );
  return { ok: true, ranked };
}

// ---------------------------------------------------------------- resolution

/** The scope rule, as a table so it can be read at a glance and asserted directly. */
const SCOPE_IS_ELIGIBLE: ReadonlySet<AnswerKind> = new Set<AnswerKind>(['superlative', 'count']);

/**
 * **A listing that names a criterion is a question about the whole eligible set (R-20, P28).**
 *
 * The scope rule's reason is that a superlative must not call something "the cheapest" when it
 * only outranked five. A *criterion* listing has the same problem and the table did not cover it:
 * "what can I eat for dinner" asks about everything the user may eat, not about the five in front
 * of them, so resolving it over `context` under-reports - and **can refuse outright**. Measured at
 * P28: `mealPeriod: 'dinner'` answered *"I do not have that information"* while **38** dinner
 * meals were eligible, because none of the five ranked meals happened to suit dinner. R-20 called
 * that "Low - the sentence is true, merely incomplete"; a false refusal is neither.
 *
 * A listing with NO criterion keeps `context`, and that asymmetry is the point rather than an
 * exception: "here are 5 of your meals" claims nothing about a total, so the five in front of the
 * user are an honest answer to it.
 *
 * **This is an amendment to TSD 4.9's scope table**, which R-20 recorded as the required route and
 * which the user authorised at P28. `count` already scoped to `eligible` and answered the same
 * question correctly ("7 meals suit breakfast"), so the amendment makes the table consistent with
 * itself.
 */
function scopeIsEligible(kind: AnswerKind, criterion: ResolvedCriterion | null): boolean {
  return SCOPE_IS_ELIGIBLE.has(kind) || (kind === 'listing' && criterion !== null);
}

/**
 * Does the meal satisfy the criterion?
 *
 * A diet criterion goes through `isDietCompatible` rather than testing the literal tag,
 * because TSD 4.5 makes `vegan` satisfy a vegetarian and a halal-preference user and calls
 * both asymmetries intentional. Testing `dietTags.includes('vegetarian')` would report a vegan
 * dish as not vegetarian and contradict the module every other part of the system consults.
 */
function matchesCriterion(meal: Meal, criterion: ResolvedCriterion): boolean {
  return criterion.sort === 'diet'
    ? isDietCompatible(criterion.tag, [...meal.dietTags])
    : meal.mealPeriods.includes(criterion.period);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function nameList(meals: readonly Meal[]): string {
  return meals.map((meal) => meal.name).join(', ');
}

/** How a criterion reads inside a sentence, with the identifier hyphen removed. */
function criterionLabel(criterion: ResolvedCriterion): string {
  return criterion.sort === 'diet' ? criterion.tag.replaceAll('-', ' ') : criterion.period;
}

/** The verb has to agree, or the assistant opens with "1 meal are vegan." */
function criterionPhrase(criterion: ResolvedCriterion, count: number): string {
  const singular = count === 1;
  return criterion.sort === 'diet'
    ? `${singular ? 'is' : 'are'} ${criterionLabel(criterion)}`
    : `${singular ? 'suits' : 'suit'} ${criterion.period}`;
}

/**
 * A decided question, carrying exactly what its kind needs.
 *
 * The union is what lets the resolvers run without a single cast: an `ordering` branch holds a
 * `field` and a `direction` because the type says so, not because an earlier `if` happened to
 * check. Every variant carries `criterion`, because **a signal the classifier extracted must
 * never be silently dropped** - see `decide`.
 */
type Decision =
  | { readonly ok: false; readonly reason: UnresolvedReason }
  | {
      readonly ok: true;
      readonly kind: 'count' | 'listing';
      readonly criterion: CountCriterion | null;
    }
  | {
      readonly ok: true;
      readonly kind: 'superlative' | 'ordering';
      readonly field: AnswerField;
      readonly direction: Direction;
      readonly criterion: CountCriterion | null;
    }
  | {
      readonly ok: true;
      readonly kind: 'total';
      readonly field: AnswerField;
      readonly criterion: CountCriterion | null;
    };

/**
 * Decide the kind, or say why the question cannot be answered.
 *
 * **The governing rule is that no extracted signal may be discarded.** Either a field, a
 * direction and a criterion are all used, or the question is refused. Dropping one produces the
 * worst failure this module can have: a fluent, confidently-worded answer to a question the
 * user did not ask. "How many calories are in these" must not become "3 meals match your
 * preferences", and "what vegan options do I have" must not list the meat dishes.
 *
 * There is no listing-beats-superlative precedence rule any more. A listing opener carrying a
 * field becomes an ORDERING, which uses both signals and keeps the opener's scope; inferring a
 * single winner from "list the meals by price, cheapest first" answered a narrower question
 * than the one asked, and silently changed the scope from context to eligible while doing it.
 */
function decide(intent: Intent): Decision {
  if (intent.threshold) {
    return { ok: false, reason: 'incomplete-intent' };
  }
  if (intent.ambiguous) {
    return { ok: false, reason: 'ambiguous-intent' };
  }
  if (intent.shape === null && intent.field === null && intent.direction === null) {
    return { ok: false, reason: intent.greeting ? 'greeting' : 'no-intent' };
  }

  const criterion = intent.criterion;

  switch (intent.shape) {
    case 'count':
      // TSD 4.9 defines no field-valued and no directional count. Refusing is the only option
      // that does not answer a different question.
      return intent.field !== null || intent.direction !== null
        ? { ok: false, reason: 'incomplete-intent' }
        : { ok: true, kind: 'count', criterion };

    case 'listing':
      if (intent.field !== null) {
        // "list these by calories" is a sorted list, not an unordered one.
        return {
          ok: true,
          kind: 'ordering',
          field: intent.field,
          direction: intent.direction ?? 'lowest',
          criterion,
        };
      }
      // A direction with nothing to sort by names no question.
      return intent.direction !== null
        ? { ok: false, reason: 'incomplete-intent' }
        : { ok: true, kind: 'listing', criterion };

    case 'ordering':
      return intent.field === null
        ? { ok: false, reason: 'incomplete-intent' }
        : {
            ok: true,
            kind: 'ordering',
            field: intent.field,
            direction: intent.direction ?? 'lowest',
            criterion,
          };

    case 'total':
      // A direction has no meaning for a sum, so carrying one means the question was not
      // understood rather than that it can be ignored.
      return intent.field === null || intent.direction !== null
        ? { ok: false, reason: 'incomplete-intent' }
        : { ok: true, kind: 'total', field: intent.field, criterion };

    case null:
      // No shape word. A field AND a direction together is a superlative; either alone states
      // a subject without saying what to do with it.
      return intent.field !== null && intent.direction !== null
        ? {
            ok: true,
            kind: 'superlative',
            field: intent.field,
            direction: intent.direction,
            criterion,
          }
        : { ok: false, reason: 'incomplete-intent' };
  }
}

/** Numbers a reader will actually see, de-duplicated so a repeat is not listed twice. */
function permit(figures: readonly string[]): readonly string[] {
  return [...new Set(figures)];
}

export function resolveAnswer(question: string, scope: ChatRetrievalResult): AnswerOutcome {
  if (question.trim() === '') {
    return unresolved('empty-question');
  }

  const decision = decide(classify(question));
  if (!decision.ok) {
    return unresolved(decision.reason);
  }

  /**
   * **"right now" becomes a concrete period here, and nowhere else.**
   *
   * The lexicon cannot know which period `now` is - it is compiled once, and the answer depends
   * on when the question was asked - so it emits `{ sort: 'current-period' }` and this is the one
   * place that resolves it, against the period the CLIENT sent (TSD 5.4: the server holds no
   * clock). Normalising here rather than in `matchesCriterion` keeps the relative form out of
   * every downstream reader: by the time anything tests a meal, the criterion is an ordinary
   * `'period'` one and behaves exactly as `"for breakfast"` does.
   *
   * It has to happen BEFORE the scope rule, because the scope now depends on whether a criterion
   * is present (R-20).
   */
  const criterion: ResolvedCriterion | null =
    decision.criterion?.sort === 'current-period'
      ? { sort: 'period', period: scope.currentPeriod }
      : decision.criterion;

  // THE SCOPE RULE. A superlative, a count and a CRITERION LISTING speak about everything the user
  // could have; a bare ordering, listing or total describes what is in front of them.
  const scoped = scopeIsEligible(decision.kind, criterion) ? scope.eligible : scope.context;
  if (scoped.length === 0) {
    return unresolved('no-candidates');
  }

  const candidates =
    criterion === null ? scoped : scoped.filter((meal) => matchesCriterion(meal, criterion));

  // A count of zero is an answer ("0 meals are vegan"); an empty set to describe is not.
  if (candidates.length === 0 && decision.kind !== 'count') {
    return unresolved('no-candidates');
  }

  switch (decision.kind) {
    case 'count': {
      return {
        kind: decision.kind,
        statement:
          criterion === null
            ? `${plural(candidates.length, 'meal')} ${
                candidates.length === 1 ? 'matches' : 'match'
              } your preferences.`
            : `${plural(candidates.length, 'meal')} ${criterionPhrase(criterion, candidates.length)}.`,
        // The count only - never the size of the set it was drawn from.
        figures: [String(candidates.length)],
        citedMealIds: [],
        // Empty on purpose: the answer is a number, and no meal needs describing.
        namedMeals: [],
      };
    }

    case 'listing': {
      /*
        "of your" rather than a bare count: the number is how many are being SHOWN. Worded as a
        total it would read as "you have 5 meals" against a sixty-meal catalog.

        **A criterion listing now selects from the whole eligible set (R-20) and so has to cap
        what it shows.** Before P28 the cap came for free, because retrieval had already trimmed
        the context to five; a dinner listing over `eligible` could otherwise name 38 meals in one
        sentence, hand 38 blocks to the prompt, and exceed the grammar's five-citation ceiling.
        So the list is trimmed here and **the sentence names both numbers** - which is exactly the
        containment R-20's row proposed ("wording makes the number visibly a count of what is
        shown rather than a total").

        When everything matched fits, the second number is omitted: "5 of your 5 dinner meals"
        answers a question nobody asked.
      */
      const shown = candidates.slice(0, MAX_CHAT_CONTEXT_MEALS);
      const subject = criterion === null ? 'meals' : `${criterionLabel(criterion)} meals`;
      const total = candidates.length;
      const scopePhrase =
        shown.length === total ? `your ${subject}` : `your ${String(total)} ${subject}`;
      return {
        kind: decision.kind,
        statement: `Here ${shown.length === 1 ? 'is' : 'are'} ${String(
          shown.length,
        )} of ${scopePhrase}: ${nameList(shown)}.`,
        // BOTH numbers are permitted when they differ, or containment check 3 would discard a
        // sentence the domain itself composed.
        figures: permit([String(shown.length), String(total)]),
        citedMealIds: shown.map((meal) => meal.id),
        namedMeals: [...shown],
      };
    }

    case 'superlative': {
      const { field, direction } = decision;
      const outcome = gather(candidates, field, direction);
      if (!outcome.ok) {
        return unresolved(outcome.reason);
      }
      const head = outcome.ranked[0];
      if (head === undefined) {
        return unresolved('no-candidates');
      }
      const winners = outcome.ranked.filter((entry) => entry.value === head.value);
      const meals = winners.map((entry) => entry.meal);
      const label = FIELD_LABELS[field];
      return {
        kind: decision.kind,
        statement:
          winners.length === 1
            ? `${head.meal.name} has the ${direction} ${label}, at ${head.formatted}.`
            : `${meals
                .map((meal) => meal.name)
                .join(' and ')} share the ${direction} ${label}, at ${head.formatted}.`,
        // The winner's figure only. A runner-up's number is not in the sentence, so it must
        // not be permitted into it.
        figures: permit(figuresIn(head.formatted)),
        citedMealIds: meals.map((meal) => meal.id),
        namedMeals: meals,
      };
    }

    case 'ordering': {
      const { field, direction } = decision;
      const outcome = gather(candidates, field, direction);
      if (!outcome.ok) {
        return unresolved(outcome.reason);
      }
      const entries = outcome.ranked;
      const body = entries.map((entry) => `${entry.meal.name} at ${entry.formatted}`).join(', ');
      return {
        kind: decision.kind,
        statement: `By ${FIELD_LABELS[field]}, ${direction} first: ${body}.`,
        figures: permit(entries.flatMap((entry) => figuresIn(entry.formatted))),
        citedMealIds: entries.map((entry) => entry.meal.id),
        namedMeals: entries.map((entry) => entry.meal),
      };
    }

    case 'total': {
      const { field } = decision;
      const outcome = gather(candidates, field, 'lowest');
      if (!outcome.ok) {
        return unresolved(outcome.reason);
      }
      const entries = outcome.ranked;
      // `sumMoney` for money, because cent arithmetic is its job (TSD 4.2). Every other field
      // is a non-negative integer by schema, so a plain sum is exact.
      const total =
        field === 'price'
          ? sumMoney(entries.map((entry) => entry.meal.price)).amountCents
          : entries.reduce((running, entry) => running + entry.value, 0);
      const totalFormatted = formatAnswerValue(field, total);
      return {
        kind: decision.kind,
        // Phrased so the field name is not the grammatical subject: "The total calories ... is"
        // does not agree, and every field has to read correctly through one template.
        statement: `The meals shown come to ${totalFormatted} in total.`,
        figures: permit([
          ...entries.flatMap((entry) => figuresIn(entry.formatted)),
          ...figuresIn(totalFormatted),
        ]),
        citedMealIds: entries.map((entry) => entry.meal.id),
        namedMeals: entries.map((entry) => entry.meal),
      };
    }
  }
}
