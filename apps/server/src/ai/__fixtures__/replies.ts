/**
 * The nine recorded model replies of Plan 15.5's Fixtures row, plus the hand-authored scenario
 * they are judged against (T-19-10: "nine fixtures, each with an asserted verdict").
 *
 * **These are adversarial-to-a-checklist, not sampled reality, and the distinction is stated
 * rather than blurred.** No recorded `gemma3:4b` reply exists on the machine this was written
 * on, so Brief 6.3's second standard applies: each envelope below was written from the ATTACK
 * NAME in Plan 15.5 and the clause in TSD 5.5 or 5.7 that says what should catch it - never
 * sampled from what the implementation happens to produce. Brief 6.3 exists because a
 * 40,000-draft differential fuzz reported zero mismatches and structurally could not have
 * tested the one constraint with no runtime guard: its generator drew its enum values from the
 * same constants the production code did. So `description` on every fixture names the document
 * clause its attack comes from, and that traceability is what to audit this file by.
 *
 * **Raw Ollama envelopes, not decoded replies.** TSD 5.5's envelope carries the model's JSON as
 * a *string*, and four of the nine are caught inside the two-stage decode - so a fixture shaped
 * as a `ChatModelReply` could not express them at all. `envelope` is exactly what a fake
 * `fetchImpl` serialises as the response body.
 *
 * **What is hand-authored and what is not.** `FIXTURE_MEALS` and `FIXTURE_RESOLVED` are; the
 * `ContainmentGround` is NOT, and must not be added here. The test calls the real
 * `buildContainmentGround(FIXTURE_RESOLVED, FIXTURE_MEALS)`, because hand-authoring the ground
 * would skip the derivation - the piece most likely to be wrong, and the piece R-21 is designed
 * out of. Hand-authored inputs, real derivation.
 *
 * Synthetic rather than the shipped 60-record catalog on purpose. Plan 19.1 makes the real
 * catalog the fixture for domain and integration tests and that is right there; here the point
 * is a permitted/forbidden split with properties chosen by hand.
 */

import type {
  DietTag,
  Meal,
  MealPeriod,
  NutritionProvenance,
  NutritionSummary,
  Provenance,
} from '@nutritime/contracts';
import type { ResolvedAnswer } from '@nutritime/domain';

import type { ContainmentRule } from '../containment.js';
import type { OllamaFailureReason } from '../ollamaClient.js';

export interface ReplyFixture {
  readonly name: string;
  /** The attack shape, in words, traceable to a document clause. */
  readonly description: string;
  readonly envelope: { readonly response: string; readonly done_reason?: string | null };
  readonly expected:
    | { readonly outcome: 'contained' }
    | { readonly outcome: 'decode-failure'; readonly reason: OllamaFailureReason }
    | { readonly outcome: 'refused'; readonly rule: ContainmentRule };
}

// ------------------------------------------------------- the synthetic scenario

/** Unlike anything upstream: these records came from nowhere but this file. */
const PROVENANCE: Provenance = {
  themealdbId: null,
  sourceUrl: null,
  imageSource: null,
  licenceConfirmed: false,
};

const DERIVED: NutritionProvenance = {
  origin: 'usda-derived',
  dataset: 'hand-authored fixture, no dataset',
  servings: 2,
  reason: null,
};

/** TSD 7.4's all-or-nothing rule: `unavailable` requires all-null values and a reason. */
const UNAVAILABLE: NutritionProvenance = {
  origin: 'unavailable',
  dataset: null,
  servings: null,
  reason: 'Hand-authored fixture record carrying no nutrition.',
};

const ALL_NULL: NutritionSummary = {
  calories: null,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
};

interface FixtureMealInput {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mealPeriods: readonly MealPeriod[];
  readonly dietTags: readonly DietTag[];
  readonly allergenTags: readonly string[];
  readonly nutrition: NutritionSummary;
  readonly amountCents: number;
  readonly preparationMinutes: number;
}

/**
 * Fills only the fields no attack touches; every value an attack depends on is written out per
 * record below. The records are `mealSchema`-valid and the test asserts it - a scenario the
 * catalog could not hold would say nothing about the shipped one.
 */
const meal = (input: FixtureMealInput): Meal => ({
  id: input.id,
  name: input.name,
  description: input.description,
  mealPeriods: input.mealPeriods,
  ingredients: [{ name: 'fixture ingredient', measure: 'one portion' }],
  instructions: ['Hand-authored fixture: no real preparation.'],
  allergenTags: input.allergenTags,
  dietTags: input.dietTags,
  nutrition: input.nutrition,
  price: { amountCents: input.amountCents, currency: 'USD' },
  preparationMinutes: input.preparationMinutes,
  imageUrl: null,
  available: true,
  source: 'local',
  catalogVersion: '0.0.0-fixture',
  nutritionProvenance: input.nutrition.calories === null ? UNAVAILABLE : DERIVED,
  provenance: PROVENANCE,
});

/** Permitted. The runner-up, so the permitted figure set has two entries rather than one. */
const TAGINE: Meal = meal({
  id: 'fx-chickpea-tagine',
  name: 'Chickpea Tagine',
  description: 'Chickpeas slow-cooked with apricot and warm spice.',
  mealPeriods: ['lunch', 'dinner'],
  dietTags: ['vegan'],
  allergenTags: [],
  nutrition: { calories: 520, proteinGrams: 24, carbsGrams: 62, fatGrams: 14 },
  amountCents: 725,
  preparationMinutes: 40,
});

const SALMON: Meal = meal({
  id: 'fx-grilled-salmon-plate',
  name: 'Grilled Salmon Plate',
  description: 'Salmon fillet with a lemon crust and steamed green beans.',
  mealPeriods: ['dinner'],
  dietTags: ['regular'],
  allergenTags: ['fish'],
  nutrition: { calories: 480, proteinGrams: 32, carbsGrams: 18, fatGrams: 26 },
  amountCents: 1050,
  preparationMinutes: 25,
});

/**
 * Forbidden, and the name is chosen rather than incidental: `Mushroom Congee` shares no word and
 * no substring with either permitted name. Containment masks the spans a permitted name accounts
 * for before check 4, and a mask can only exempt a forbidden name lying INSIDE a permitted one -
 * so no overlap makes the unnamed-meal fixture a test of check 4 rather than of the mask, and
 * the test asserts that property rather than trusting this comment. All-null nutrition because
 * that is 53 of the 60 shipped records (TSD 5.7).
 */
const CONGEE: Meal = meal({
  id: 'fx-mushroom-congee',
  name: 'Mushroom Congee',
  description: 'Rice porridge simmered with mushrooms and ginger.',
  mealPeriods: ['breakfast'],
  dietTags: ['vegan'],
  allergenTags: [],
  nutrition: ALL_NULL,
  amountCents: 480,
  preparationMinutes: 55,
});

/** Forbidden, and a second one on purpose: a one-entry forbidden set is a set of one shape. */
const LENTIL: Meal = meal({
  id: 'fx-lentil-soup',
  name: 'Lentil Soup',
  description: 'Red lentils with carrot and cumin.',
  mealPeriods: ['lunch'],
  dietTags: ['vegan'],
  allergenTags: [],
  nutrition: { calories: 310, proteinGrams: 18, carbsGrams: 44, fatGrams: 6 },
  amountCents: 615,
  preparationMinutes: 35,
});

/** Catalog order, which is the order `forbiddenMealNames` is derived in. */
export const FIXTURE_MEALS: readonly Meal[] = [SALMON, TAGINE, CONGEE, LENTIL];

/**
 * An `ordering` rather than a `superlative` so that TWO figures are permitted and a wrong number
 * has somewhere plausible to hide: `34` sits next to a permitted `32`, the shape SDD 9.1
 * measured. A single-figure scenario would make any wrong number look obviously out of place -
 * the opposite of the threat.
 *
 * `figures` are bare normalised digit strings because TSD 4.9 derives them from the FORMATTED
 * value, and `"32 g"` yields `32`. `namedMeals` carries only the two the statement names (TSD
 * 5.6), so `CONGEE` and `LENTIL` are the forbidden set check 4 is built from.
 */
export const FIXTURE_RESOLVED: ResolvedAnswer = {
  kind: 'ordering',
  statement: 'By protein, highest first: Grilled Salmon Plate at 32 g, Chickpea Tagine at 24 g.',
  figures: ['32', '24'],
  citedMealIds: [SALMON.id, TAGINE.id],
  namedMeals: [SALMON, TAGINE],
};

// ------------------------------------------------------------------ the nine

/**
 * The well-formed, fully grounded reply the eight attacks are each one deviation from.
 *
 * `often` is in it on purpose: TSD 5.7 reads spelled cardinals as figures and `often` carries
 * the letters of `ten`, so a figure extractor without word boundaries reads `10` out of it and
 * discards this correct reply. `figures.ts` names exactly this word in its own docstring, and
 * the control belongs in the fixture that would pay for losing it.
 */
const GROUNDED_ANSWER =
  'Grilled Salmon Plate leads on protein at 32 g; Chickpea Tagine, often a close second, ' +
  'sits at 24 g.';

const reply = (answer: string, citedMealIds: readonly string[]): string =>
  JSON.stringify({ answered: true, answer, citedMealIds });

/**
 * Plan 15.5's nine, in Plan 15.5's order. The list is exact - that row names nine attacks, and
 * there is no tenth here and no eighth missing.
 *
 * Each attack is ONE deviation from `GROUNDED_ANSWER`. Checks run 1 then 2 then 3 then 4 with
 * the first failure winning, so a fixture carrying two attacks would assert a verdict that
 * survives deleting the later check - and each `description` says which checks cannot fire.
 */
export const REPLY_FIXTURES: readonly ReplyFixture[] = [
  {
    name: 'valid',
    description:
      'Everything grounded: citations from the prompt, both figures permitted, only permitted ' +
      'names, no denied claim. The control the other eight are measured against, and no single ' +
      'constant return can satisfy it alongside them (Brief 6.2.2).',
    envelope: {
      response: reply(GROUNDED_ANSWER, ['fx-grilled-salmon-plate', 'fx-chickpea-tagine']),
    },
    expected: { outcome: 'contained' },
  },
  {
    name: 'malformed-json',
    description:
      'The inner JSON is cut mid-object, so `JSON.parse` of `response` throws. TSD 5.5 step 4; ' +
      'the client reports `schema`, which that union shares with a Zod rejection.',
    envelope: {
      response: '{"answered":true,"answer":"Grilled Salmon Plate leads on protein at 32 g."',
    },
    expected: { outcome: 'decode-failure', reason: 'schema' },
  },
  {
    name: 'extra-field',
    description:
      'Parses, and carries every required field plus `proteinGrams` - a fabricated NUMBER ' +
      'beside the prose, which any caller spreading the reply would publish. Zod rejects it, ' +
      'because `chatModelReplySchema` is a `z.strictObject` (TSD 3.3, TSD 5.5 step 4).',
    envelope: {
      response:
        '{"answered":true,"answer":"Grilled Salmon Plate leads on protein at 32 g.",' +
        '"citedMealIds":["fx-grilled-salmon-plate"],"proteinGrams":34}',
    },
    expected: { outcome: 'decode-failure', reason: 'schema' },
  },
  {
    name: 'uncited-id',
    description:
      'A citation for `fx-mushroom-congee`, a real catalog id the prompt did not carry - so it ' +
      'looks legitimate rather than garbage. TSD 5.7 check 1 - the defence in depth behind TSD ' +
      '5.5 grammar constraint. The answer names nothing forbidden and quotes only a permitted ' +
      'figure, so check 1 is the only one that can fire.',
    envelope: {
      response: reply('Grilled Salmon Plate leads on protein at 32 g.', [
        'fx-grilled-salmon-plate',
        'fx-mushroom-congee',
      ]),
    },
    expected: { outcome: 'refused', rule: 'uncited-meal' },
  },
  {
    name: 'denied-claim',
    description:
      'Two traps at once, neither obvious on a skim. `healthy-sounding` reads as one hedging ' +
      'adjective, but TSD 5.7 flattens every non-alphanumeric run to a space, so the denied ' +
      'word is whole and present; and the sentence NEGATES it, which TSD 5.7 says in those ' +
      'words is not an exemption. No digit, no cardinal, no forbidden name - check 2 only.',
    envelope: {
      response: reply(
        'Neither option is especially healthy-sounding, but Grilled Salmon Plate is the ' +
          'higher-protein pick.',
        ['fx-grilled-salmon-plate'],
      ),
    },
    expected: { outcome: 'refused', rule: 'denied-claim' },
  },
  {
    name: 'wrong-figure',
    description:
      'The fixture the phase exists for. SDD 9.1 measured `gemma3:4b` answering four of six ' +
      'comparison questions wrongly WITH the correct data in context, each a wrong number in ' +
      'fluent prose. So: `34` is a near-miss of the permitted `32`; `10` is arithmetic the ' +
      'model performed and got wrong, since 32 less 24 is 8; the names are exact; the citations ' +
      'are valid; no denied claim. Every word-level check passes; only TSD 5.7 check 3 sees it.',
    envelope: {
      response: reply(
        'Grilled Salmon Plate has 34 g of protein, about 10 g more than Chickpea Tagine.',
        ['fx-grilled-salmon-plate', 'fx-chickpea-tagine'],
      ),
    },
    expected: { outcome: 'refused', rule: 'ungrounded-figure' },
  },
  {
    name: 'unnamed-meal',
    description:
      'Names `Mushroom Congee`, a catalog meal the prompt did not carry - TSD 5.7 check 4, "a ' +
      'name recalled from the model own training rather than from the context". It shares no ' +
      'substring with either permitted name, so no masking can exempt it; the citation is valid ' +
      'and there is no figure, so check 4 is the only one that can fire.',
    envelope: {
      response: reply('Mushroom Congee would be the gentler choice for a light evening.', [
        'fx-grilled-salmon-plate',
      ]),
    },
    expected: { outcome: 'refused', rule: 'ungrounded-meal' },
  },
  {
    name: 'truncated',
    description:
      'Cut on a CLEAN JSON boundary: the envelope parses, the schema validates, and the content ' +
      'would pass all four containment checks - only `done_reason: "length"` marks it. That is ' +
      'the whole of TSD 5.5 step 3: a decoder that parses first has a well-formed reply in hand ' +
      'and nothing left to object to. The prose stops mid-clause, which a user reads as a ' +
      'finished assertion the model never made.',
    envelope: {
      response: reply(
        'Grilled Salmon Plate leads on protein at 32 g, ahead of Chickpea Tagine at 24 g, ' +
          'which means the salmon is the better pick if you are',
        ['fx-grilled-salmon-plate', 'fx-chickpea-tagine'],
      ),
      done_reason: 'length',
    },
    expected: { outcome: 'decode-failure', reason: 'truncated' },
  },
  {
    name: 'empty',
    description:
      'Whitespace only, not the empty string - TSD 5.5 step 2 is `response.trim() === ""`, and ' +
      'a fixture of `""` would pass a decoder that dropped the trim. No `done_reason` either.',
    envelope: { response: '   \n  ' },
    expected: { outcome: 'decode-failure', reason: 'empty-reply' },
  },
];
