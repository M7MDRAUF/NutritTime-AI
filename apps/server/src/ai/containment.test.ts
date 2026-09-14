import { describe, expect, it } from 'vitest';
import { chatModelReplySchema, mealObjectSchema } from '@nutritime/contracts';
import type { ChatModelReply, Meal } from '@nutritime/contracts';
import { resolveAnswer } from '@nutritime/domain';
import type { ChatRetrievalResult, ResolvedAnswer } from '@nutritime/domain';

import { buildCatalog } from '../catalog.js';
import { buildContainmentGround, containExplanation, containReply } from './containment.js';
import { EVIDENCE_MAX } from './containment.js';
import type { ContainmentGround, ContainmentVerdict } from './containment.js';

/**
 * Plan 19.3's `containment` row: uncited id · each denylist phrase including a negated one · a
 * wrong number in clean prose · a spelled cardinal · **empty permitted set forbids every
 * figure** · an unnamed meal.
 *
 * **Fixture provenance (BRIEF 6.3).** There are no recorded real replies to draw on - the nine
 * recorded fixtures are T-19-10, another agent's task - so the standard here is *adversarial to
 * a checklist*, and the checklist was written from TSD 5.7, TSD 4.9 and Plan 15.4 before
 * `containment.ts` existed. Nothing below was sampled from what the implementation happens to
 * produce. The attack shapes, each with its source:
 *
 *  1. an id the prompt never carried (TSD 5.7 check 1);
 *  2. a correct superlative whose winner is OUTSIDE `scope.context` - Plan R-21. Built by
 *     running the domain's own `resolveAnswer`, so the fixture comes from TSD 4.9's scope rule
 *     rather than from this file's imagination;
 *  3. a denied claim, and the same claim negated (TSD 5.7: negation is not an exemption);
 *  4. a wrong number inside fluent, polite prose - the `gemma3:4b` mode TSD 5.7 records;
 *  5. the same, spelled ("twenty two");
 *  6. an empty permitted set (TSD 4.9's Figures paragraph, T-19-09);
 *  7. a digit in a prompt meal NAME, which TSD 5.7 permits into the answer;
 *  8. a meal name recalled from training (check 4);
 *  9. a forbidden name that is a raw substring of a permitted one - `Ham` in `Hamburger`;
 * 10. two catalog meals sharing a word - `Chicken Salad` permitted, `Chicken Curry` not;
 * 11. a forbidden name nested in a permitted one, as a strict prefix and as a strict suffix -
 *     the overlap artefact TSD 4.9's claim rule exists for;
 * 12. a forbidden name that STRADDLES the edge of a claimed span, which a destructive mask
 *     would miss;
 * 13. two permitted names where the shorter nests in the longer, pinning longest-first;
 * 14. two violations in one reply, at each adjacent check boundary (order is behaviour);
 * 15. `answered: false`, which must not switch containment off;
 * 16. the schema's own extremes - no citations, a one-character answer, 700 characters.
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
  nutritionProvenance: { origin: 'usda-derived', dataset: 'FNDDS', servings: 2, reason: null },
};

const meal = (id: string, name: string, over: Partial<Meal> = {}): Meal => ({
  ...BASE,
  id,
  name,
  ...over,
});

const HAMBURGER = meal('m-burger', 'Hamburger Deluxe');
const HAM = meal('m-ham', 'Ham');
const CHICKEN_SALAD = meal('m-csalad', 'Chicken Salad');
const CHICKEN_CURRY = meal('m-ccurry', 'Chicken Curry');
const SEVEN_SPICE = meal('m-7spice', '7-Spice Chicken');
const MANDAZI = meal('m-mandazi', 'Home-made Mandazi');
const TRAINING_RECALL = meal('m-tikka', 'Chicken Tikka Masala');
const PUNCTUATION_ONLY = meal('m-punct', '!!!');
const TEA = meal('m-tea', 'Tea');
const AMPERSAND = meal('m-amp', 'Broccoli & Stilton Soup');

const resolvedOf = (over: Partial<ResolvedAnswer>): ResolvedAnswer => ({
  kind: 'superlative',
  statement: 'unused by containment',
  figures: [],
  citedMealIds: [],
  namedMeals: [],
  ...over,
});

const reply = (over: Partial<ChatModelReply> = {}): ChatModelReply => ({
  answered: true,
  answer: 'The Chicken Salad is on your list.',
  citedMealIds: [],
  ...over,
});

/**
 * Check 4's own matching form, re-derived here from TSD 5.7's three steps rather than imported
 * from `containment.ts`: a test that borrowed the subject's normaliser could not notice the
 * subject changing it (BRIEF 6.3).
 */
const nameKeyOf = (name: string): string => ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** Narrows for `rule`/`evidence` and fails the test rather than the type system. */
function discarded(verdict: ContainmentVerdict): { rule: string; evidence: string } {
  if (verdict.contained) {
    throw new Error('expected the reply to be discarded, but it was contained');
  }
  return { rule: verdict.rule, evidence: verdict.evidence };
}

/**
 * `evidence` names the offending **token** and is bounded, at every rule.
 *
 * Called at **all four** checks and both explanation checks. The version this replaces was
 * called at two of four, neither of them check 1 - and check 1 is the only site whose value the
 * MODEL authors, so the one guard that mattered was the one nobody applied. A helper used at
 * half the call sites is not a guard.
 *
 * The bound is `EVIDENCE_MAX`, imported rather than restated. The version this replaces
 * asserted a literal `60`, which no document defines; `EVIDENCE_MAX` is derived from
 * `mealObjectSchema`'s own `name` ceiling and that derivation is itself asserted below.
 */
function expectBoundedEvidence(verdict: ContainmentVerdict, answer: string): void {
  const { evidence } = discarded(verdict);
  // Non-empty: an `evidence` that named nothing would be worse than none.
  expect(evidence.length).toBeGreaterThan(0);
  expect(evidence.length).toBeLessThanOrEqual(EVIDENCE_MAX);
  // Never the answer (or, on the explanation lane, the reason). A cited id legitimately equals
  // itself, so the invariant that holds at all six sites is about the PROSE, not the token.
  expect(evidence).not.toBe(answer);
}

describe('check 1 - citations (TSD 5.7 check 1)', () => {
  const ground = buildContainmentGround(
    resolvedOf({ namedMeals: [CHICKEN_SALAD], citedMealIds: [CHICKEN_SALAD.id] }),
    [CHICKEN_SALAD, CHICKEN_CURRY],
  );

  it('discards an id the prompt never carried, naming that id as the evidence', () => {
    const answer = 'The Chicken Salad is on your list.';
    const verdict = containReply(reply({ answer, citedMealIds: ['m-ccurry'] }), ground);
    expect(discarded(verdict)).toEqual({ rule: 'uncited-meal', evidence: 'm-ccurry' });
    expectBoundedEvidence(verdict, answer);
  });

  /**
   * **Check 1's `evidence` is the only value the model authors freely, so it is the only one a
   * bound has to save.** `chatModelReplySchema` types a cited id `z.string().min(1).max(200)`,
   * and on a `count` question `chatFormat` emits **no `enum`** - an empty `promptMealIds` gives
   * `{ type: 'string', maxLength: 200 }`. So 200 characters of prose in that slot is a reply the
   * schema admits, and the schema check below proves it rather than asserting it.
   *
   * A model's answer derives from the user's question, so unbounded this field would carry a
   * question at one remove - TSD 5.8's first prohibition.
   */
  it('bounds a 200-character cited id that the schema admits', () => {
    const prose =
      'the best option today is probably the lighter one with chicken since you said you ' +
      'wanted something quick to make this evening so I would suggest going with that one';
    const forged = prose.slice(0, 200).padEnd(200, '.');
    expect(forged).toHaveLength(200);
    const answer = 'You have 3 meals.';
    const given = reply({ answer, citedMealIds: [forged] });
    // The reply is schema-valid: this is not a shape the pipeline would already have rejected.
    expect(chatModelReplySchema.safeParse(given).success).toBe(true);

    const verdict = containReply(given, ground);
    expect(discarded(verdict).rule).toBe('uncited-meal');
    // The fix, stated directly: the 200 characters the model wrote do not survive whole.
    // Length first, so an unbounded `discard` fails with the number in the message.
    expect(discarded(verdict).evidence).toHaveLength(EVIDENCE_MAX);
    expect(discarded(verdict).evidence).not.toBe(forged);
    expectBoundedEvidence(verdict, answer);
  });

  it('accepts an id the prompt carried', () => {
    expect(containReply(reply({ citedMealIds: [CHICKEN_SALAD.id] }), ground).contained).toBe(true);
  });

  it('forbids every citation when the prompt carried no meals at all (a count answer)', () => {
    const countGround = buildContainmentGround(resolvedOf({ kind: 'count', figures: ['3'] }), [
      CHICKEN_SALAD,
    ]);
    expect(countGround.promptMealIds).toEqual([]);
    const verdict = containReply(
      reply({ answer: 'You have 3 meals.', citedMealIds: [CHICKEN_SALAD.id] }),
      countGround,
    );
    expect(discarded(verdict).rule).toBe('uncited-meal');
  });
});

/**
 * **R-21, and this test is the whole of its repair.**
 *
 * A superlative asserts something about the user's whole eligible set, so TSD 4.9 resolves it
 * over `scope.eligible`; `context` is merely the five that ranked. The winner is therefore
 * routinely outside `context`. Comparing citations against the retrieved five would discard
 * every correct superlative whose winner did not happen to rank - an assistant mysteriously
 * unable to answer its most common question.
 *
 * The fixture is built by the domain, not by hand: `resolveAnswer` decides the winner, and the
 * precondition (winner in `namedMeals`, winner NOT in `context`) is asserted rather than
 * assumed. The second half is the control - the same reply against a ground whose ids are the
 * context ids is discarded, so no constant verdict can satisfy both halves.
 */
describe('R-21 - a superlative winner outside scope.context is contained', () => {
  const RANKED: readonly Meal[] = [
    meal('r-1', 'Ranked Pilaf', { price: { amountCents: 1200, currency: 'USD' } }),
    meal('r-2', 'Ranked Gnocchi', { price: { amountCents: 1300, currency: 'USD' } }),
    meal('r-3', 'Ranked Tagine', { price: { amountCents: 1400, currency: 'USD' } }),
    meal('r-4', 'Ranked Laksa', { price: { amountCents: 1500, currency: 'USD' } }),
    meal('r-5', 'Ranked Borscht', { price: { amountCents: 1600, currency: 'USD' } }),
  ];
  const UNRANKED_WINNER = meal('r-6', 'Bargain Congee', {
    price: { amountCents: 300, currency: 'USD' },
  });
  const eligible = [...RANKED, UNRANKED_WINNER];
  const scope: ChatRetrievalResult = { eligible, context: RANKED };

  const outcome = resolveAnswer('which meal has the lowest price?', scope);
  if (outcome.kind === 'unresolved') {
    throw new Error(`fixture precondition failed: ${outcome.reason}`);
  }

  it('the domain really does put the winner outside the retrieved five', () => {
    expect(outcome.namedMeals.map((m) => m.id)).toEqual([UNRANKED_WINNER.id]);
    expect(scope.context.map((m) => m.id)).not.toContain(UNRANKED_WINNER.id);
  });

  it('contains the domain-resolved statement against namedMeals', () => {
    const ground = buildContainmentGround(outcome, eligible);
    const verdict = containReply(
      { answered: true, answer: outcome.statement, citedMealIds: [...outcome.citedMealIds] },
      ground,
    );
    expect(verdict).toEqual({ contained: true });
  });

  it('would discard that same statement if the ground held the context ids (the defect)', () => {
    const asR21 = buildContainmentGround(outcome, eligible);
    const contextGround: ContainmentGround = {
      ...asR21,
      promptMealIds: scope.context.map((m) => m.id),
    };
    const asDefect = containReply(
      { answered: true, answer: outcome.statement, citedMealIds: [...outcome.citedMealIds] },
      contextGround,
    );
    expect(discarded(asDefect).rule).toBe('uncited-meal');
  });
});

describe('check 2 - denied claims (TSD 5.7 check 2)', () => {
  // The list's CONTENT is `claimDenylist.test.ts`'s to own - A8 is extending it under PRD 7.3 -
  // so nothing here asserts `DENIED_CLAIMS` or its length. These assert only that check 2 runs.
  const ground = buildContainmentGround(resolvedOf({ namedMeals: [CHICKEN_SALAD] }), [
    CHICKEN_SALAD,
  ]);

  it.each([
    ['a plain health verdict', 'The Chicken Salad is healthy.'],
    ['negated - not an exemption', 'The Chicken Salad is not healthy.'],
    ['an allergen reassurance', 'The Chicken Salad is allergen free.'],
  ])('discards %s', (_why, answer) => {
    const verdict = containReply(reply({ answer }), ground);
    expect(discarded(verdict).rule).toBe('denied-claim');
    expectBoundedEvidence(verdict, answer);
    // Lifted from the answer verbatim, never summarised out of it - a summary of an answer is
    // still derived from the question that produced it.
    expect(answer.toLowerCase()).toContain(discarded(verdict).evidence.toLowerCase());
  });

  it('keeps a reply whose only near-miss is inside a longer word', () => {
    const answer = 'Food safety is handled in the kitchen, not here.';
    expect(containReply(reply({ answer }), ground).contained).toBe(true);
  });

  it('runs even when the model set answered:false', () => {
    // Otherwise the model could switch containment off with a boolean it controls.
    const verdict = containReply(
      reply({ answered: false, answer: 'I cannot say, but that one is healthy.' }),
      ground,
    );
    expect(discarded(verdict).rule).toBe('denied-claim');
  });
});

describe('check 3 - ungrounded figures (TSD 5.7 check 3)', () => {
  const ground = buildContainmentGround(
    resolvedOf({ namedMeals: [CHICKEN_SALAD], figures: ['22'] }),
    [CHICKEN_SALAD],
  );

  it('discards a wrong number inside fluent, well-formed prose', () => {
    const answer = 'Great choice - the Chicken Salad takes about 45 minutes to put together.';
    const verdict = containReply(reply({ answer }), ground);
    expect(discarded(verdict)).toEqual({ rule: 'ungrounded-figure', evidence: '45' });
    expectBoundedEvidence(verdict, answer);
  });

  it('discards a spelled cardinal just as it discards the digits', () => {
    const answer = 'The Chicken Salad needs about twenty five minutes.';
    expect(discarded(containReply(reply({ answer }), ground)).evidence).toBe('25');
  });

  it('accepts the figure the domain resolved', () => {
    const answer = 'The Chicken Salad takes 22 minutes.';
    expect(containReply(reply({ answer }), ground).contained).toBe(true);
  });

  it('does not treat 22.0 as 22 - comparison is string identity after normalisation', () => {
    const answer = 'The Chicken Salad takes 22.0 minutes.';
    expect(discarded(containReply(reply({ answer }), ground)).evidence).toBe('22.0');
  });

  /**
   * **T-19-09 - the stop-condition row, and the single most likely implementation error in the
   * phase.** `permittedFigures` empty must FORBID every figure, not skip the check.
   *
   * `if (permittedFigures.length > 0) { ... }` passes every test anyone would write naturally,
   * because every natural fixture has figures. It disables check 3 exactly when a meal's
   * nutrition is unknown - 53 of the 60 seeded records - which is when the model is most likely
   * to invent a number. Hence a named test with an empty set on both the chat and the
   * explanation lane.
   */
  describe('T-19-09 - an empty permitted set forbids every figure', () => {
    const empty = buildContainmentGround(resolvedOf({ namedMeals: [CHICKEN_SALAD] }), [
      CHICKEN_SALAD,
    ]);

    it('has genuinely no permitted figure', () => {
      expect(empty.permittedFigures).toEqual([]);
    });

    it.each([
      ['a digit', 'The Chicken Salad has 31 g of protein.', '31'],
      ['a spelled cardinal', 'The Chicken Salad has thirty one grams.', '31'],
      ['a lone zero', 'The Chicken Salad has 0 g of fat.', '0'],
    ])('discards %s', (_why, answer, evidence) => {
      expect(discarded(containReply(reply({ answer }), empty))).toEqual({
        rule: 'ungrounded-figure',
        evidence,
      });
    });

    it('accepts a figure-free answer, so the check is not simply always failing', () => {
      const answer = 'The Chicken Salad is on your list for lunch.';
      expect(containReply(reply({ answer }), empty).contained).toBe(true);
    });

    it('forbids every figure on the explanation lane too', () => {
      expect(discarded(containExplanation('It brings 31 g of protein.', [])).rule).toBe(
        'ungrounded-figure',
      );
      expect(containExplanation('It suits your lunch slot.', []).contained).toBe(true);
    });
  });

  /**
   * **`digitsIn`, not `quotedFigures`, over the prompt's meal names** - `containment.ts`'s
   * permitted-set construction. M1 found it unpinned: swapping the two loosened check 3 with
   * 428 tests green, in the direction that lets a model quote a number the domain never
   * resolved.
   *
   * The existing `7-Spice Chicken` fixture cannot catch it, because that name carries a literal
   * **digit** and both functions find `7` in it - it discriminates nothing. The two differ only
   * on a name that **spells** a cardinal: `digitsIn` finds nothing there, `quotedFigures` finds
   * `7`, so the permitted set is empty under the shipped code and `['7']` under the mutant.
   *
   * **Synthetic by necessity, and latent rather than live.** No seeded name spells a cardinal or
   * carries a digit, so neither this fixture nor `7-Spice Chicken` can be drawn from the
   * catalog. It is the same latency already recorded as a MINOR: TSD 5.7's meal-name clause says
   * "digits" while the answer side also reads spelled cardinals, so a meal whose NAME spells a
   * number cannot be named in any answer. The narrow set is what TSD 5.7 specifies, and the
   * loose one admits an ungrounded figure - which is why the narrow set is the one asserted.
   */
  it('takes only DIGITS from a prompt meal name, never a spelled cardinal in it', () => {
    const SPELLED = meal('m-spelled', 'Seven Spice Chicken');
    const named = buildContainmentGround(resolvedOf({ namedMeals: [SPELLED] }), [SPELLED]);
    // The oracle: `quotedFigures` would have put `7` in here.
    expect(named.permittedFigures).toEqual([]);

    // And the consequence for a verdict, so the gap is pinned at both levels.
    const answer = 'The Seven Spice Chicken has 7 g of protein.';
    expect(discarded(containReply(reply({ answer }), named))).toEqual({
      rule: 'ungrounded-figure',
      evidence: '7',
    });
  });

  it('permits a digit that appears in a prompt meal NAME, normalised', () => {
    // Without TSD 5.7's meal-name clause every answer naming `7-Spice Chicken` is discarded.
    const named = buildContainmentGround(resolvedOf({ namedMeals: [SEVEN_SPICE] }), [SEVEN_SPICE]);
    expect(named.permittedFigures).toEqual(['7']);
    const answer = 'The 7-Spice Chicken is on your list.';
    expect(containReply(reply({ answer }), named).contained).toBe(true);
  });
});

describe('check 4 - ungrounded meals (TSD 5.7 check 4)', () => {
  const ground = buildContainmentGround(resolvedOf({ namedMeals: [HAMBURGER, CHICKEN_SALAD] }), [
    HAMBURGER,
    CHICKEN_SALAD,
    HAM,
    CHICKEN_CURRY,
    MANDAZI,
    TRAINING_RECALL,
    PUNCTUATION_ONLY,
    TEA,
  ]);

  it('discards a name recalled from training rather than from the context', () => {
    const answer = 'You could try the Chicken Tikka Masala instead.';
    const verdict = containReply(reply({ answer }), ground);
    expect(discarded(verdict)).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'Chicken Tikka Masala',
    });
    expectBoundedEvidence(verdict, answer);
  });

  it('does not fire on a forbidden name that is only a substring of a permitted one', () => {
    // `Ham` is a catalog meal and is NOT in the prompt; `Hamburger Deluxe` is. An `includes`
    // implementation reads `ham` inside `hamburger` and throws away a correct reply.
    const answer = 'The Hamburger Deluxe is the pick on your list.';
    expect(containReply(reply({ answer }), ground).contained).toBe(true);
  });

  it('does not fire on a forbidden name buried inside an ordinary word', () => {
    // `Tea` is a catalog meal not in the prompt, and `instead` contains `tea`. This is the case
    // that keeps the word-boundary wrap load-bearing on its own: the coverage rule below
    // rescues a forbidden name hidden inside a PERMITTED NAME, but `instead` is not one, so
    // nothing but the wrap stops a raw `includes` discarding this reply.
    const answer = 'The Chicken Salad is a good choice instead.';
    expect(containReply(reply({ answer }), ground)).toEqual({ contained: true });
  });

  it('does not fire when a permitted and a forbidden meal share a word', () => {
    // `Chicken Salad` is permitted, `Chicken Curry` is not. A token-level implementation
    // forbids the word `Chicken` and discards every reply that names the salad.
    const answer = 'The Chicken Salad is on your list.';
    expect(containReply(reply({ answer }), ground).contained).toBe(true);
  });

  it('matches a forbidden name whatever punctuation the model wrote it with', () => {
    // The catalog writes `Home-made Mandazi`; a model writes `Home made Mandazi`. Both sides
    // are flattened, so a hyphen is not a hiding place - and surrounding punctuation does not
    // stop a mid-sentence match either.
    for (const answer of [
      'Try the Home-made Mandazi.',
      'Try the Home made Mandazi.',
      'Try the "Home-made Mandazi", which is quick.',
    ]) {
      expect(discarded(containReply(reply({ answer }), ground)).evidence).toBe('Home-made Mandazi');
    }
    const curry = 'The Chicken Curry - a favourite - is also good.';
    expect(discarded(containReply(reply({ answer: curry }), ground)).evidence).toBe(
      'Chicken Curry',
    );
  });

  it('never forbids a catalog name that flattens to nothing', () => {
    // `!!!` flattens to blank, which every answer contains. Left in the forbidden set it would
    // discard every reply the server ever produced.
    expect(ground.forbiddenMealNames).not.toContain('!!!');
    expect(containReply(reply({ answer: 'Anything at all.' }), ground).contained).toBe(true);
  });

  /**
   * **The `&` versus `and` trace, asserted rather than asserted-about.** Three seeded records
   * carry `&`, and flattening turns it into a separator rather than the word `and` - so a model
   * writing `and` produces a string the flattened name does not match. The orchestrator's
   * ruling is not to normalise it, because an `&`-to-`and` expansion is a fourth normalisation
   * step TSD 5.7 does not list. These three cases pin what that costs, in both directions.
   */
  it('costs no false 503 when the & record IS in the prompt', () => {
    const permitted = buildContainmentGround(resolvedOf({ namedMeals: [AMPERSAND] }), [
      AMPERSAND,
      CHICKEN_CURRY,
    ]);
    const answer = 'The Broccoli and Stilton Soup is on your list.';
    expect(containReply(reply({ answer }), permitted)).toEqual({ contained: true });
  });

  it('misses the & record when it is forbidden and the model writes and (recorded MINOR)', () => {
    const forbidden = buildContainmentGround(resolvedOf({ namedMeals: [CHICKEN_SALAD] }), [
      CHICKEN_SALAD,
      AMPERSAND,
    ]);
    expect(forbidden.forbiddenMealNames).toEqual(['Broccoli & Stilton Soup']);
    // The documented gap: `and` is a word, `&` is a separator, so the phrases differ.
    const withAnd = 'You might like the Broccoli and Stilton Soup.';
    expect(containReply(reply({ answer: withAnd }), forbidden)).toEqual({ contained: true });
    // The control that shows the check is not simply broken for this record.
    const withSymbol = 'You might like the Broccoli & Stilton Soup.';
    expect(discarded(containReply(reply({ answer: withSymbol }), forbidden)).evidence).toBe(
      'Broccoli & Stilton Soup',
    );
  });

  it('still fires when a permitted name and a forbidden name are both present', () => {
    // The control that keeps the exemption honest. Masking everything would pass without it.
    const answer = 'The Chicken Salad is on your list, but the Chicken Tikka Masala is not.';
    expect(discarded(containReply(reply({ answer }), ground))).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'Chicken Tikka Masala',
    });
  });
});

/**
 * **Check 4's overlap rule** - TSD 4.9's claim mechanism applied to check 4, per the
 * orchestrator's reading note: a forbidden occurrence lying *entirely* inside the occurrence of
 * a name the prompt DID carry is an artefact of English spelling, not a second meal reference.
 *
 * Every case below is a shape the ruling names, plus the two the ruling asked me to find: the
 * ordering case that distinguishes longest-first from shortest-first, and the straddle case that
 * distinguishes a coverage test from a destructive mask.
 */
describe('check 4 - the overlap rule (TSD 4.9 claim mechanism)', () => {
  const TIKKA = meal('m-tikka-full', 'Chicken Tikka Masala');
  const TIKKA_PREFIX = meal('m-tikka-p', 'Chicken Tikka');
  const TIKKA_SUFFIX = meal('m-tikka-s', 'Tikka Masala');
  const MASALA_DOSA = meal('m-dosa', 'Masala Dosa');
  const catalog = [TIKKA, TIKKA_PREFIX, TIKKA_SUFFIX, MASALA_DOSA, CHICKEN_CURRY];
  const ground = buildContainmentGround(resolvedOf({ namedMeals: [TIKKA] }), catalog);

  it('forbids the three overlapping names and permits the one the prompt carried', () => {
    // The precondition: without it every assertion below could pass vacuously.
    expect(ground.forbiddenMealNames).toEqual([
      'Chicken Tikka',
      'Tikka Masala',
      'Masala Dosa',
      'Chicken Curry',
    ]);
  });

  it.each([
    ['a strict prefix of the permitted name', 'The Chicken Tikka Masala is on your list.'],
    ['a strict suffix, same answer', 'Your list has the Chicken Tikka Masala.'],
    ['the name at the very start of the answer', 'Chicken Tikka Masala is on your list.'],
    ['the name at the very end of the answer', 'On your list: Chicken Tikka Masala'],
  ])('exempts %s', (_why, answer) => {
    expect(containReply(reply({ answer }), ground)).toEqual({ contained: true });
  });

  it('still fires on a forbidden name outside every claimed span', () => {
    const answer = 'The Chicken Tikka Masala is on your list; the Chicken Curry is not.';
    expect(discarded(containReply(reply({ answer }), ground)).evidence).toBe('Chicken Curry');
  });

  /**
   * **The straddle case.** A destructive "blank the permitted spans and re-scan" implementation
   * passes this: `masala` is blanked, so `Masala Dosa` is never found. Coverage fires, because
   * `dosa` was never claimed. This is the case that decides between the two implementations, and
   * it is why the exemption is a coverage test over occurrences rather than a mask.
   */
  it('fires on a forbidden name that straddles the edge of a claimed span', () => {
    const answer = 'Try the Chicken Tikka Masala Dosa.';
    expect(discarded(containReply(reply({ answer }), ground))).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'Masala Dosa',
    });
  });

  /**
   * **The CLAIMING pass's predicate, not the verdict's** - `containment.ts`'s `overlaps` at the
   * `claimed.push` guard. M1 found it unpinned: swapping it for `covers` flipped a check-4
   * verdict with 428 tests green, and also killed the purpose of the longest-first sort.
   *
   * This is a different site from the straddle case above, which pins the VERDICT's `covers`.
   * Here two PERMITTED names partially overlap each other in the answer: `Chicken Tikka Masala`
   * and `Masala Dosa` are both in the prompt, and the answer `"Chicken Tikka Masala Dosa"`
   * contains an occurrence of each, sharing the word `masala`.
   *
   * Longest-first claims `chicken tikka masala`. The `masala dosa` occurrence then partially
   * overlaps that claim without being covered by it, and `overlaps` **skips** it - so the
   * claimed region stays equal to exactly one permitted name's text. Under `covers` it would be
   * pushed instead, unioning the two spans and claiming `dosa`, a word the winning name never
   * spelled - which is the straddle hole reappearing one level up, in the claim rather than in
   * the verdict. A forbidden `Dosa` would then be exempt.
   */
  it('claims one region per permitted name, so overlapping permitted names cannot union', () => {
    const DOSA = meal('m-dosa-only', 'Dosa');
    const overlapping = buildContainmentGround(resolvedOf({ namedMeals: [TIKKA, MASALA_DOSA] }), [
      TIKKA,
      MASALA_DOSA,
      DOSA,
    ]);
    // The precondition: `Dosa` is the forbidden one, and both longer names are permitted.
    expect(overlapping.forbiddenMealNames).toEqual(['Dosa']);

    const answer = 'Try the Chicken Tikka Masala Dosa.';
    expect(discarded(containReply(reply({ answer }), overlapping))).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'Dosa',
    });
  });

  /**
   * **The ordering case.** Two permitted names where the shorter nests in the longer, and a
   * forbidden name that overlaps the longer but not the shorter.
   *
   * Longest-first claims `full english breakfast`, so the forbidden `Full English` is covered.
   * Shortest-first claims `english breakfast` first; the longer name's occurrence then overlaps
   * an existing claim and is skipped, leaving `full` unclaimed - and `Full English` fires on text
   * that is wholly a permitted name. This is the case the ruling asked me to build.
   */
  it('claims longest-name-first, so an overlapping forbidden name stays covered', () => {
    const SHORT = meal('m-eb', 'English Breakfast');
    const LONG = meal('m-feb', 'Full English Breakfast');
    const OVERLAP = meal('m-fe', 'Full English');
    const ordered = buildContainmentGround(resolvedOf({ namedMeals: [SHORT, LONG] }), [
      SHORT,
      LONG,
      OVERLAP,
    ]);
    expect(ordered.forbiddenMealNames).toEqual(['Full English']);
    const answer = 'You have the Full English Breakfast and the English Breakfast.';
    expect(containReply(reply({ answer }), ordered)).toEqual({ contained: true });
  });

  /**
   * **Every occurrence, not the first.** D3's counterexample family: the exemption is
   * per-occurrence, so the search has to be too. A forbidden name can appear twice - once
   * covered by a permitted name's span and once on its own - and the uncovered one is a real
   * out-of-context reference.
   *
   * All three strings are built from the shipped seed rather than typed here, so a rename of
   * either record turns the precondition red instead of making the case vacuous.
   *
   * The third row is the one that exercises `occurrences`' advance: the two occurrences of
   * `English Breakfast` SHARE the separator space between them, so a scan that skipped past a
   * whole match rather than one character past its start would never see the second.
   */
  it.each([
    [
      'D3: covered occurrence first, uncovered second',
      (full: string, short: string) => `The ${full} is great, and ${short} is also available`,
    ],
    [
      'the mirror: uncovered occurrence first, covered second',
      (full: string, short: string) => `${short} is available, and the ${full} is great`,
    ],
    [
      'adjacent repetition, the two occurrences sharing one separator',
      (full: string, short: string) => `${full} ${short}`,
    ],
  ])('discards %s', async (_why, build) => {
    const { seededCatalog } = await import('@nutritime/catalog');
    const meals = buildCatalog(seededCatalog).meals;
    const short = meals.find((candidate) => candidate.name === 'English Breakfast');
    const full = meals.find((candidate) => candidate.name === 'Full English Breakfast');
    if (short === undefined || full === undefined) {
      throw new Error('fixture precondition failed: the seeded nesting pair is gone');
    }
    const seeded = buildContainmentGround(resolvedOf({ namedMeals: [full] }), meals);
    const answer = build(full.name, short.name);
    // The precondition: the covered occurrence really is inside the permitted name, so the
    // case is about the SECOND occurrence and not about the exemption failing outright.
    expect(answer).toContain(full.name);

    const verdict = containReply(reply({ answer }), seeded);
    expect(discarded(verdict)).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'English Breakfast',
    });
    expectBoundedEvidence(verdict, answer);
  });

  /**
   * The repaired defect, on the catalog the server actually serves. Still driven from the seed
   * rather than a hand-typed string, and it still asserts that the nesting pair is exactly one
   * record, so a rename of either record turns it red instead of quietly passing.
   */
  it('is live on the seeded catalog - Full English Breakfast is now answerable', async () => {
    // `seededCatalog` is typed `unknown` on purpose, so it goes through the server's own boot
    // validator rather than a cast - the same route `catalog.test.ts` takes.
    const { seededCatalog } = await import('@nutritime/catalog');
    const meals = buildCatalog(seededCatalog).meals;
    const nesting = meals.filter(
      (candidate) =>
        candidate.name !== 'English Breakfast' &&
        nameKeyOf(candidate.name).includes(nameKeyOf('English Breakfast')),
    );
    expect(nesting.map((candidate) => candidate.name)).toEqual(['Full English Breakfast']);

    const full = nesting[0];
    if (full === undefined) {
      throw new Error('fixture precondition failed: no nesting record');
    }
    const seeded = buildContainmentGround(resolvedOf({ namedMeals: [full] }), meals);
    expect(seeded.forbiddenMealNames).toContain('English Breakfast');
    expect(containReply(reply({ answer: `The ${full.name} is on your list.` }), seeded)).toEqual({
      contained: true,
    });

    // And the control on the same real ground: a genuinely absent seeded meal still fires.
    const withOther = `The ${full.name} is on your list, but the Beef Wellington is not.`;
    expect(discarded(containReply(reply({ answer: withOther }), seeded))).toEqual({
      rule: 'ungrounded-meal',
      evidence: 'Beef Wellington',
    });
  });
});

/**
 * **Order is behaviour, not taste.** Each row violates two adjacent checks, so swapping any
 * neighbouring pair turns at least one row red. A single row would leave two of the three
 * boundaries unpinned.
 */
describe('check order is 1 then 2 then 3 then 4, first failure wins', () => {
  const ground = buildContainmentGround(
    resolvedOf({ namedMeals: [CHICKEN_SALAD], figures: ['22'] }),
    [CHICKEN_SALAD, CHICKEN_CURRY, TRAINING_RECALL],
  );

  it.each([
    [
      '1 before 2',
      reply({ answer: 'The Chicken Salad is healthy.', citedMealIds: ['m-ccurry'] }),
      'uncited-meal',
    ],
    ['2 before 3', reply({ answer: 'It is healthy and takes 45 minutes.' }), 'denied-claim'],
    [
      '3 before 4',
      reply({ answer: 'The Chicken Tikka Masala takes 45 minutes.' }),
      'ungrounded-figure',
    ],
  ])('reports %s', (_why, given, rule) => {
    expect(discarded(containReply(given, ground)).rule).toBe(rule);
  });
});

describe('containReply is total and side-effect free', () => {
  const ground = buildContainmentGround(
    resolvedOf({ namedMeals: [CHICKEN_SALAD], figures: ['22'] }),
    [CHICKEN_SALAD, CHICKEN_CURRY],
  );
  const SENTINEL = 'the kitchen prepares your order with care and attention every day ';
  // No trim: `slice` alone makes the length exactly 700, which is the schema's own ceiling.
  const padded = (payload: string): string => `${payload} ${SENTINEL.repeat(12)}`.slice(0, 700);

  it.each([
    ['no citations at all', reply({ answer: 'Lunch is ready.', citedMealIds: [] })],
    ['a one-character answer', reply({ answer: 'x' })],
    ['a 700-character answer', reply({ answer: padded('Everything looks good.') })],
  ])('does not throw on %s', (_why, given) => {
    expect(() => containReply(given, ground)).not.toThrow();
  });

  it('keeps evidence to the offending token even on a 700-character answer', () => {
    const answer = padded('It has 999 grams of protein.');
    expect(answer.length).toBe(700);
    const verdict = containReply(reply({ answer }), ground);
    expect(discarded(verdict).evidence).toBe('999');
    expect(verdict.contained).toBe(false);
    expectBoundedEvidence(verdict, answer);
    expect(discarded(verdict).evidence).not.toContain('kitchen');
  });

  it('mutates neither the reply nor the ground', () => {
    const given = reply({ answer: 'It is healthy.', citedMealIds: ['m-ccurry'] });
    const replyBefore = structuredClone(given);
    const groundBefore = structuredClone(ground);
    containReply(given, ground);
    expect(given).toEqual(replyBefore);
    expect(ground).toEqual(groundBefore);
  });
});

describe('containExplanation runs checks 2 and 3 only (TSD 5.7 last paragraph)', () => {
  it('discards a denied claim in a reason', () => {
    const reason = 'A healthy pick for you.';
    const verdict = containExplanation(reason, ['22']);
    expect(discarded(verdict).rule).toBe('denied-claim');
    expectBoundedEvidence(verdict, reason);
  });

  it('discards an ungrounded figure in a reason', () => {
    const reason = 'It has 45 g of protein.';
    const verdict = containExplanation(reason, ['22']);
    expect(discarded(verdict).rule).toBe('ungrounded-figure');
    expectBoundedEvidence(verdict, reason);
  });

  it('reports the claim before the figure', () => {
    expect(discarded(containExplanation('A healthy 45 g of protein.', [])).rule).toBe(
      'denied-claim',
    );
  });

  it('does not run check 4 - a meal name in a reason is not its business', () => {
    // P20 has no catalog to compare against, and the explanation names the meal it explains.
    expect(containExplanation('Chicken Tikka Masala suits your lunch slot.', []).contained).toBe(
      true,
    );
  });

  it('normalises the permitted set it is handed, so a grouped figure still matches', () => {
    // P20 computes its own permitted set, so the normalisation here is load-bearing rather
    // than a no-op: without it a grouped permitted figure matches nothing.
    expect(containExplanation('It costs $1,234.50 in total.', ['1,234.50']).contained).toBe(true);
  });
});

describe('buildContainmentGround', () => {
  it('takes ids and names from namedMeals, and forbids the rest of the catalog', () => {
    const ground = buildContainmentGround(resolvedOf({ namedMeals: [CHICKEN_SALAD] }), [
      CHICKEN_SALAD,
      CHICKEN_CURRY,
      HAM,
    ]);
    expect(ground.promptMealIds).toEqual([CHICKEN_SALAD.id]);
    expect(ground.promptMealNames).toEqual([CHICKEN_SALAD.name]);
    expect(ground.forbiddenMealNames).toEqual([CHICKEN_CURRY.name, HAM.name]);
  });

  it('adds the prompt names digits to resolved.figures rather than replacing them', () => {
    const ground = buildContainmentGround(
      resolvedOf({ namedMeals: [SEVEN_SPICE], figures: ['10.10'] }),
      [SEVEN_SPICE],
    );
    expect([...ground.permittedFigures].sort()).toEqual(['10.10', '7']);
  });
});

/**
 * **Where `EVIDENCE_MAX` comes from.** BRIEF 9 forbids inventing a figure, so the bound is not
 * chosen here - it is `mealObjectSchema`'s own ceiling on a meal name, which is the longest
 * thing an `evidence` value can legitimately hold. These assertions are the derivation, so the
 * constant cannot drift from the schema it was taken from, and the figures quoted in
 * `containment.ts`'s docstring cannot rot.
 */
describe('EVIDENCE_MAX is derived, not chosen', () => {
  it('is exactly the schema ceiling on a meal name', () => {
    expect(mealObjectSchema.shape.name.safeParse('a'.repeat(EVIDENCE_MAX)).success).toBe(true);
    expect(mealObjectSchema.shape.name.safeParse('a'.repeat(EVIDENCE_MAX + 1)).success).toBe(false);
  });

  it('truncates no legitimate value in the shipped catalog', async () => {
    const { seededCatalog } = await import('@nutritime/catalog');
    const meals = buildCatalog(seededCatalog).meals;
    // The figures `containment.ts` cites, pinned so the comment cannot go stale.
    expect(Math.max(...meals.map((candidate) => candidate.name.length))).toBe(59);
    expect(Math.max(...meals.map((candidate) => candidate.id.length))).toBe(57);
    for (const candidate of meals) {
      expect(candidate.name.length).toBeLessThanOrEqual(EVIDENCE_MAX);
      expect(candidate.id.length).toBeLessThanOrEqual(EVIDENCE_MAX);
    }
  });
});
