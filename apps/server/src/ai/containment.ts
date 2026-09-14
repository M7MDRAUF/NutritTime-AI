/**
 * Containment - the four checks TSD 5.7 runs over every model reply before anything is shown.
 *
 * A reply failing any one check is **discarded - never repaired, never partially used**
 * (TSD 5.7). No path here rewrites an answer, drops an offending sentence or salvages a
 * citation: a repair would put this module in the business of authoring a sentence, and the
 * design is that the domain computes and the model only phrases (BRIEF 7.1).
 *
 * **What the checks are for.** Thirty-five probes against `gemma3:4b` (TSD 5.7) found it
 * answering four of six comparison questions wrongly with the correct data in context - every
 * one a wrong *number* in fluent, well-formed prose, with no denied claim, no uncited id and no
 * unnamed meal. So check 3 carries the safety claim, and 1, 2 and 4 close the other three ways
 * a reply can assert something the domain never computed.
 *
 * **Order is behaviour, not taste: 1 then 2 then 3 then 4, first failure winning.** TSD 5.7
 * states the checks in that order, and `rule` is part of the verdict a caller can observe, so a
 * rule that varied with check order would make the same reply produce two different verdicts.
 * BRIEF 7.3: a containment failure you cannot reproduce is one you cannot fix.
 *
 * **`evidence` exists because TSD 5.7's `ContainmentVerdict` declares it** - that is the whole
 * of its authority. Its consumer is a **developer reading a test failure**, which is why it
 * names the offending token rather than restating the verdict.
 *
 * **It has no log line, and P21 must not give it one.** TSD 5.8 fixes the AI log line at
 * `lane`, `durationMs` and `outcome`: there is no `rule` field and no `evidence` field, and
 * `logging.ts`'s `AiLogFields` has no parameter for either - deliberately, because a function
 * that cannot receive the data cannot leak it. An earlier version of this comment claimed the
 * route logs the rule "(TSD 5.8)", which was false, and a false citation is how a privacy rule
 * gets broken by someone following a comment. Check 1's `evidence` is a string the MODEL wrote;
 * a model's answer derives from the user's question, so logging it logs a question at one
 * remove, which is TSD 5.8's first prohibition. TSD 5.7 keeps it from a caller too: "The client
 * is never told which rule fired."
 *
 * `EVIDENCE_MAX` bounds every value, as **defence in depth and not the primary control** - the
 * primary control is that nothing logs it.
 *
 * `DENIED_CLAIMS` lives in `claimDenylist.ts` and figure extraction in `figures.ts`, so a
 * change to either is a change to one file with its own suite. Nothing here restates them.
 */

import type { ChatModelReply, Meal } from '@nutritime/contracts';
import type { ResolvedAnswer } from '@nutritime/domain';

import { deniedClaimIn, flattenForMatching } from './claimDenylist.js';
import { normaliseFigure, quotedFigures } from './figures.js';

export type ContainmentRule =
  'uncited-meal' | 'denied-claim' | 'ungrounded-figure' | 'ungrounded-meal';

export type ContainmentVerdict =
  | { readonly contained: true }
  | { readonly contained: false; readonly rule: ContainmentRule; readonly evidence: string };

export interface ContainmentGround {
  /** Ids the prompt carried. Check 1 compares `citedMealIds` against these. */
  readonly promptMealIds: readonly string[];
  /** Names the prompt carried. Check 4 permits these. */
  readonly promptMealNames: readonly string[];
  /** `resolved.figures` plus digits appearing in the prompt's meal NAMES. Already normalised. */
  readonly permittedFigures: readonly string[];
  /** Catalog meal names NOT in the prompt. Check 4 forbids these. */
  readonly forbiddenMealNames: readonly string[];
}

/** Frozen and shared: `containReply` must not mutate what it is given or what it hands back. */
const CONTAINED: ContainmentVerdict = Object.freeze({ contained: true as const });

/**
 * The ceiling on an `evidence` value, derived rather than chosen.
 *
 * A legitimate value is one of four things - a cited meal id, a denied phrase, a figure, or a
 * meal name - and the longest is a meal name, which `mealObjectSchema` fixes at
 * `z.string().min(1).max(120)`. So 120 is the document's own ceiling on the longest thing this
 * field can legitimately hold, and no real value is ever truncated. Catalog ids are
 * `kebabIdSchema` slugs of the name and fit the same bound; the longest seeded name and id are
 * 59 and 57 characters. The derivation and both figures are asserted in the test.
 *
 * **Why a bound is needed.** `chatModelReplySchema` types a cited id
 * `z.string().min(1).max(200)`, and on a `count` question `chatFormat` emits **no `enum`** (an
 * empty `promptMealIds` gives `{ type: 'string', maxLength: 200 }`), so check 1's value is the
 * one the MODEL authors freely - 200 characters of anything. Unbounded, this field carries model
 * prose, which is the user's question at one remove. The bound keeps the field honest about
 * being a token, so the header's claim is one the code supports.
 */
export const EVIDENCE_MAX = 120;

/**
 * The single construction site for a failing verdict, which is the only reason the bound holds.
 *
 * Truncating at each call site would be four places to remember and one place to forget, and
 * the forgotten one would be check 1 - the only site whose value the model controls. A helper
 * applied at some call sites is not a guard.
 */
const discard = (rule: ContainmentRule, evidence: string): ContainmentVerdict => ({
  contained: false,
  rule,
  evidence: evidence.slice(0, EVIDENCE_MAX),
});

/**
 * TSD 5.7's digit-run pattern. The repeating group matters: `1,234.50` is one figure.
 *
 * Deliberately **not** `quotedFigures`. TSD 5.7 permits "any **digits** appearing in the
 * prompt's meal names", and `quotedFigures` also reads spelled cardinals - so running it here
 * would permit `7` because a meal is called `Seven Spice Chicken`, a figure no document permits,
 * and loose is the dangerous direction for check 3. The cost of the literal reading is in the A7
 * report: a meal whose NAME spells a cardinal cannot be named in any answer. No seeded one does.
 *
 * **The two functions differ only on a name that SPELLS a cardinal**, which is why the test
 * asserts a permitted set built from `Seven Spice Chicken` and not from `7-Spice Chicken`: the
 * latter carries a literal digit that both functions find, so it discriminates nothing. Swapping
 * this for `quotedFigures` once passed the whole suite.
 */
const DIGIT_RUN = /\d+(?:[.,]\d+)*/g;

/** `String.match` resets `lastIndex` itself, so the shared regex is safe and needs no guard. */
function digitsIn(name: string): readonly string[] {
  return (name.match(DIGIT_RUN) ?? []).map(normaliseFigure);
}

/**
 * A name in the form check 4 matches on: `claimDenylist.ts`'s flattener, whose space-wrap is
 * what makes matching whole-word. Shared with check 2 rather than re-rolled here, because two
 * normalisers meant to agree and drifting is a defect nothing would notice.
 */
const nameKey = (name: string): string => flattenForMatching(name);

/** A half-open character range in a flattened answer. */
interface Span {
  readonly start: number;
  readonly end: number;
}

const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

const covers = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

/**
 * Every occurrence of a flattened, space-wrapped name in a flattened answer, as the span of the
 * name itself - the wrapping spaces are left OUTSIDE the span on purpose, so two names sharing
 * one separator (`" a "` twice in `" a a "`) are both found and neither hides the other.
 */
function occurrences(flat: string, key: string): readonly Span[] {
  const core = key.trim();
  if (core === '') {
    return [];
  }
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const at = flat.indexOf(key, from);
    if (at < 0) {
      return spans;
    }
    spans.push({ start: at + 1, end: at + 1 + core.length });
    from = at + 1;
  }
}

/**
 * The spans of the answer that a name the prompt DID carry accounts for, claimed
 * **longest-name-first**, skipping any position already claimed.
 *
 * TSD 4.9's own mechanism, lifted from its classifier: "Compile every term longest-phrase-first.
 * Walk them in that order; when a phrase matches, **claim** its token positions so a shorter
 * phrase inside it cannot also match." Same collision - `English Breakfast` sits inside
 * `Full English Breakfast` and both are shipped records - so the document states problem and
 * solution together.
 *
 * Longest-first is load-bearing. If `English Breakfast` claimed first, the occurrence of
 * `Full English Breakfast` would overlap it and be skipped, leaving `full` unclaimed - and a
 * forbidden `Full English` would fire on text that is wholly a permitted name.
 */
function claimPermittedNames(flat: string, promptMealNames: readonly string[]): readonly Span[] {
  const keys = promptMealNames
    .map(nameKey)
    .filter((key) => key.trim() !== '')
    .sort((a, b) => b.length - a.length);
  const claimed: Span[] = [];
  for (const key of keys) {
    for (const span of occurrences(flat, key)) {
      if (!claimed.some((held) => overlaps(held, span))) {
        claimed.push(span);
      }
    }
  }
  return claimed;
}

/**
 * The ground truth a reply is measured against, built once per request from the domain's
 * resolution and the catalog.
 *
 * **R-21 is designed out here rather than guarded against.** `promptMealIds` comes from
 * `resolved.namedMeals` - the meals the prompt actually carried (TSD 5.6) - and this function
 * is not given `scope.context` at all, so comparing citations against the five retrieved meals
 * is not expressible. That matters because a superlative asserts something about the user's
 * whole eligible set and therefore resolves over `scope.eligible` (TSD 4.9's scope rule), so
 * its winner is *routinely* outside `context`. A check written against the retrieved five would
 * discard every correct superlative whose winner did not happen to rank - an assistant
 * mysteriously unable to answer its most common question.
 */
export function buildContainmentGround(
  resolved: ResolvedAnswer,
  allMeals: readonly Meal[],
): ContainmentGround {
  const promptMealIds = resolved.namedMeals.map((meal) => meal.id);
  const promptMealNames = resolved.namedMeals.map((meal) => meal.name);

  /**
   * `resolved.figures` first, then the names' digits. TSD 4.9 derives `figures` from the
   * FORMATTED strings, so they are already normalised and `normaliseFigure` is a no-op on them
   * (it is idempotent, so applying it is safe) - but it is load-bearing on the name side, where
   * a model-facing name may carry a grouped figure. De-duplicated because TSD 5.7 calls this a
   * permitted *set* and a duplicate would only make a log line harder to read; membership is
   * all check 3 ever asks.
   */
  const permittedFigures = [
    ...new Set([
      ...resolved.figures.map(normaliseFigure),
      ...promptMealNames.flatMap((name) => digitsIn(name)),
    ]),
  ];

  /**
   * Catalog names minus the prompt's, compared on the flattened key rather than the raw string.
   *
   * Two meals sharing a flattened name - `Dal fry` and `Dal Fry`, say - are indistinguishable
   * to check 4, so if either is in the prompt the other must not be forbidden: it could never
   * be detected on its own, and leaving it in would discard every correct reply naming the one
   * that IS permitted.
   *
   * A name that flattens to nothing is dropped for the same reason at the limit. `mealSchema`
   * only requires a non-empty name, so `"!!!"` is a loadable record, and its key is a bare
   * space that every answer contains - it would discard every reply the server ever produced.
   */
  const permitted = new Set(promptMealNames.map(nameKey));
  const forbiddenMealNames: string[] = [];
  const seen = new Set<string>();
  for (const meal of allMeals) {
    const key = nameKey(meal.name);
    if (key.trim() === '' || permitted.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    forbiddenMealNames.push(meal.name);
  }

  return { promptMealIds, promptMealNames, permittedFigures, forbiddenMealNames };
}

/**
 * Check 1 - citations. Defence in depth behind TSD 5.5's grammar constraint (Plan 15.4 layer 0),
 * which is upstream behaviour across two unpinned projects: a constraint that silently stopped
 * being enforced would remove the guarantee with no signal.
 *
 * An empty `promptMealIds` forbids every citation, correctly rather than incidentally - a
 * `count` answer carries no meals at all (TSD 4.9), so no citation on it can be grounded.
 */
function checkCitations(
  citedMealIds: readonly string[],
  promptMealIds: readonly string[],
): ContainmentVerdict {
  const permitted = new Set(promptMealIds);
  for (const id of citedMealIds) {
    if (!permitted.has(id)) {
      return discard('uncited-meal', id);
    }
  }
  return CONTAINED;
}

/**
 * Check 2 - denied claim. The list and its matching rules are `claimDenylist.ts`'s; this is the
 * site that runs them. `deniedClaimIn` returns the matched phrase, which is exactly the token
 * `evidence` may carry.
 */
function checkDeniedClaim(text: string): ContainmentVerdict {
  const phrase = deniedClaimIn(text);
  return phrase === undefined ? CONTAINED : discard('denied-claim', phrase);
}

/**
 * Check 3 - ungrounded figure. **An empty permitted set forbids every figure; it does not skip
 * the check** (TSD 5.7, TSD 4.9's Figures paragraph, Plan T-19-09's stop-condition row).
 *
 * There is no `if (permittedFigures.length > 0)` above the loop and there must never be one.
 * That guard passes every test anyone writes naturally, because every natural fixture has
 * figures - and it disables containment exactly when a meal's nutrition is all `null`, which is
 * 53 of the 60 seeded records, and exactly when the model is most likely to invent a number.
 * The empty set is a *decision* the domain made about that answer, not an absence of one.
 *
 * `normaliseFigure` over the permitted set because `containExplanation`'s caller computes its
 * own set (P20) and a grouped figure there must still match. It is idempotent, so a set the
 * domain already normalised is unchanged.
 */
function checkFigures(text: string, permittedFigures: readonly string[]): ContainmentVerdict {
  const permitted = new Set(permittedFigures.map(normaliseFigure));
  for (const figure of quotedFigures(text)) {
    if (!permitted.has(figure)) {
      return discard('ungrounded-figure', figure);
    }
  }
  return CONTAINED;
}

/**
 * Check 4 - ungrounded meal. Catches a name recalled from the model's own training rather than
 * from the context (TSD 5.7). Three mechanisms, each closing a different false verdict:
 *
 * 1. **Whole-word**, via the space-wrapping flattener. `Ham` and `Hamburger Deluxe` are both
 *    seeded records; a raw `includes` reads `ham` inside `hamburger` and discards a correct
 *    reply about a meal that IS in the prompt.
 * 2. **Whole-phrase.** `Chicken Salad` may be in the prompt while `Chicken Curry` is not, and a
 *    token-level check would forbid the word `Chicken` and discard every reply naming the salad.
 * 3. **A forbidden occurrence wholly covered by a permitted name's occurrence is not a
 *    reference to that meal.** `English Breakfast` and `Full English Breakfast` are both shipped
 *    records, so without this the second is permanently unanswerable - a deterministic 503 for
 *    one of sixty meals, since `temperature: 0` and `seed: 7` make it reproducible rather than
 *    recoverable by asking again. The mechanism is the one TSD 4.9 describes, applied in
 *    `claimPermittedNames`.
 *
 * **Mechanism 3's authority is contested, and this is a recorded divergence.** TSD 4.9 states
 * the longest-phrase-first claim rule for the **classifier over the user's question**, not for
 * containment over the **answer**; TSD 5.7 does not cite it. So the borrowing is an argument by
 * analogy, not a citation, and the behaviour DIVERGES from a literal reading of 5.7 check 4 -
 * under which an answer naming `Full English Breakfast` does contain the name `English
 * Breakfast`. It is recorded rather than resolved here because resolving it is a **user
 * decision** between two options: amend TSD 5.7 check 4 to state the covered-occurrence
 * exemption, or rename one of the two catalog records so the collision does not exist. Do not
 * settle it by editing a document. What is verified either way: exactly one collision exists in
 * the sixty seeded records, and the exemption provably cannot admit a real out-of-context
 * reference (see below).
 *
 * **The exemption is per-occurrence, so the search is too - every occurrence, never the
 * first.** A forbidden name can appear twice, once inside a permitted name's span and once on
 * its own, and the second is a real reference: `"The Full English Breakfast is great, and
 * English Breakfast is also available"`. Returning on the first *covered* occurrence would pass
 * that string. Both orderings and the adjacent case are asserted.
 *
 * **Every part of this exemption needs its own oracle, because each part is independently
 * mutable and the others rescue it.** That is not a guess; it is the record. The exemption has
 * been wrong in four different places, each found by a different reader after the previous fix
 * looked complete:
 *
 * | Part | How it was wrong | Pinned by |
 * |---|---|---|
 * | the exemption's shape | a destructive mask missed a name straddling the span edge | the `Masala Dosa` straddle case |
 * | the claim order | shortest-first left part of a permitted name unclaimed | the two-permitted-names ordering case |
 * | the search | only the first occurrence was examined | D3's repetition case, both orderings |
 * | the verdict predicate | `covers` versus `overlaps` at each of TWO sites | the straddle case (verdict) and the overlapping-permitted-names case (claim) |
 *
 * The lesson for whoever edits this next: a green suite says nothing about a part of this
 * exemption unless there is a fixture that fails when *that part alone* changes. Four of the
 * five above were mutations that left the whole suite green.
 *
 * **Why (3) cannot be abused, which is the question that decides it.** For a forbidden
 * occurrence to be exempt it must lie *entirely* inside the span of a permitted name the answer
 * actually spells out - so the text at those positions IS the permitted name, character for
 * character after flattening, and the shorter name's occurrence inside it is an artefact of
 * English spelling rather than a second meal reference. No string smuggles a genuine
 * out-of-context reference through: add any word of the model's own and part of the forbidden
 * occurrence falls outside the claimed span, where `covers` refuses the exemption.
 *
 * That argument holds only because the exemption is a **coverage test over occurrences** rather
 * than a mask. Blanking the permitted spans out of the answer and re-scanning the remainder
 * reads the same until a forbidden name *straddles* the boundary: with `Chicken Tikka Masala`
 * permitted and `Masala Dosa` forbidden, `"Chicken Tikka Masala Dosa"` leaves `masala` blanked,
 * so a mask never finds `Masala Dosa` and the reference passes. Coverage fires on it, because
 * `dosa` was never claimed. That case is asserted.
 *
 * Catalog order is preserved in `forbiddenMealNames`, so the reported name is a function of the
 * catalog rather than of where in the sentence the model put it - the same reason
 * `deniedClaimIn` returns list order rather than text position (TSD 5.8).
 */
function checkUngroundedMeal(
  text: string,
  promptMealNames: readonly string[],
  forbiddenMealNames: readonly string[],
): ContainmentVerdict {
  const flat = flattenForMatching(text);
  const claimed = claimPermittedNames(flat, promptMealNames);
  for (const name of forbiddenMealNames) {
    for (const span of occurrences(flat, nameKey(name))) {
      if (!claimed.some((held) => covers(held, span))) {
        return discard('ungrounded-meal', name);
      }
    }
  }
  return CONTAINED;
}

/**
 * All four checks over one chat reply, in TSD 5.7's order, first failure winning.
 *
 * Written as an ordered list rather than four nested `if`s so the order is one legible line
 * each and a reordering is visible in a diff.
 *
 * **`reply.answered` is not consulted.** Containment runs over the answer text whatever the
 * model claimed about it: making any check conditional on a boolean the model controls would
 * hand the model a switch for turning containment off. The route decides what to *show* on
 * `answered: false` (TSD 5.4); this decides whether the reply may be used at all.
 *
 * Total by construction - every branch returns a verdict and nothing here can throw for any
 * `ChatModelReply` the schema admits, including an empty `citedMealIds` and a 700-character
 * answer. Nothing is written to `reply` or `ground`.
 */
export function containReply(reply: ChatModelReply, ground: ContainmentGround): ContainmentVerdict {
  const checks: readonly (() => ContainmentVerdict)[] = [
    () => checkCitations(reply.citedMealIds, ground.promptMealIds),
    () => checkDeniedClaim(reply.answer),
    () => checkFigures(reply.answer, ground.permittedFigures),
    () => checkUngroundedMeal(reply.answer, ground.promptMealNames, ground.forbiddenMealNames),
  ];
  for (const check of checks) {
    const verdict = check();
    if (!verdict.contained) {
      return verdict;
    }
  }
  return CONTAINED;
}

/**
 * Checks 2 and 3 only, over the explanation lane's `reason` (TSD 5.7's last paragraph).
 *
 * Checks 1 and 4 are absent because neither has ground truth on this lane: an explanation
 * carries no citations, and it names the one meal it is explaining with no catalog in scope to
 * say which other names would be forbidden. Check 4 over an empty forbidden set would look like
 * a check and be one only by accident.
 *
 * A failure here is not a 503: P20 falls back to template text and the recommendation still
 * succeeds (TSD 5.7, Plan C-04), which is why this returns a verdict rather than throwing.
 */
export function containExplanation(
  reason: string,
  permittedFigures: readonly string[],
): ContainmentVerdict {
  const claim = checkDeniedClaim(reason);
  if (!claim.contained) {
    return claim;
  }
  return checkFigures(reason, permittedFigures);
}
