import { describe, expect, it } from 'vitest';
import { chatModelReplySchema, mealSchema } from '@nutritime/contracts';
import type { ChatModelReply } from '@nutritime/contracts';
import { loadConfig } from '../config.js';
import { chatFormat } from './chatFormat.js';
import { deniedClaimIn, flattenForMatching } from './claimDenylist.js';
import { buildContainmentGround, containReply } from './containment.js';
import { OllamaError, createOllamaClient } from './ollamaClient.js';
import type { FetchLike } from './ollamaClient.js';
import { buildChatPrompt } from './prompt.js';
import { FIXTURE_MEALS, FIXTURE_RESOLVED, REPLY_FIXTURES } from './__fixtures__/replies.js';
import type { ReplyFixture } from './__fixtures__/replies.js';

/**
 * T-19-10 - nine fixtures, each with an asserted verdict (Plan 17's T-19-10 row, Plan 19.5's
 * evidence row for it, Plan 15.5's Fixtures row).
 *
 * **The real path, not a re-implementation of it.** Every fixture goes through
 * `createOllamaClient(...).generate` with a fake `fetchImpl` returning the envelope, and then
 * through `containReply` against a ground built by the real `buildContainmentGround`. A test
 * that decided the verdict itself would assert its own arithmetic (Brief 6.2.1).
 *
 * **The fixtures are adversarial to a checklist, not sampled reality.** There is no recorded
 * `gemma3:4b` reply on this machine; the standard and its consequences are written out in
 * `__fixtures__/replies.ts`. That file is where the attack shapes live and this one is where the
 * verdicts are asserted - and the verdicts are asserted TWICE, from two files, because a
 * fixture file carrying both the attack and its own expected answer cannot be caught lying.
 * `EXPECTED_VERDICTS` below is the independent copy.
 *
 * **What a passing run here does NOT prove.** Layer 0 of Plan 15.4 - that Ollama compiles
 * `citedMealIds.items.enum` into a grammar an uncited id cannot be sampled from - is upstream
 * behaviour and unreachable without a model. `grammar.integration.test.ts` is the only thing
 * that can record it, and it is gated on `RUN_MODEL_TESTS=1`. What this file proves is that
 * layer 1 catches an uncited id whatever layer 0 is doing.
 */

/** Through the real parser, so the client is driven by a config `loadConfig` can produce. */
const config = loadConfig({
  OLLAMA_BASE_URL: 'http://ollama.test:11434',
  OLLAMA_MODEL: 'gemma3:4b',
  AI_KEEP_ALIVE: '30m',
});

/**
 * Real derivation over hand-authored inputs. The `ContainmentGround` is deliberately NOT a
 * fixture: hand-authoring it would skip the ground builder, which is the piece most likely to be
 * wrong and the piece R-21 is designed out of.
 */
const ground = buildContainmentGround(FIXTURE_RESOLVED, FIXTURE_MEALS);

/** The real prompt builder, so the ids the format constrains come from the same place. */
const built = buildChatPrompt({
  question: 'Which of these has more protein?',
  resolved: FIXTURE_RESOLVED,
});

/**
 * The verdicts, restated independently of the fixture file: name, order and expected outcome.
 *
 * A `toHaveLength(9)` alone passes when one attack is silently replaced by a duplicate of
 * another, so the names are asserted against this literal list too - and the expected verdict
 * travels with each name, which makes an edit to either file fail.
 */
const EXPECTED_VERDICTS: readonly (readonly [string, ReplyFixture['expected']])[] = [
  ['valid', { outcome: 'contained' }],
  ['malformed-json', { outcome: 'decode-failure', reason: 'schema' }],
  ['extra-field', { outcome: 'decode-failure', reason: 'schema' }],
  ['uncited-id', { outcome: 'refused', rule: 'uncited-meal' }],
  ['denied-claim', { outcome: 'refused', rule: 'denied-claim' }],
  ['wrong-figure', { outcome: 'refused', rule: 'ungrounded-figure' }],
  ['unnamed-meal', { outcome: 'refused', rule: 'ungrounded-meal' }],
  ['truncated', { outcome: 'decode-failure', reason: 'truncated' }],
  ['empty', { outcome: 'decode-failure', reason: 'empty-reply' }],
];

const FIXTURE_NAMES = EXPECTED_VERDICTS.map(([name]) => name);

/** Every fixture actually driven through the real path, in order. Read by the last test. */
const DRIVEN: string[] = [];

function fixtureNamed(name: string): ReplyFixture {
  const found = REPLY_FIXTURES.find((fixture) => fixture.name === name);
  if (found === undefined) {
    throw new Error(`no fixture named ${name}`);
  }
  return found;
}

/** The decoded reply a fixture carries, for the assertions that need the answer text. */
function replyOf(name: string): ChatModelReply {
  const parsed: unknown = JSON.parse(fixtureNamed(name).envelope.response);
  const decoded = chatModelReplySchema.safeParse(parsed);
  if (!decoded.success) {
    throw new Error(`fixture ${name} does not decode`);
  }
  return decoded.data;
}

interface Run {
  readonly outcome: ReplyFixture['expected'];
  readonly fetchCalls: number;
  /**
   * How many times containment was consulted on this run.
   *
   * Incremented on the line immediately before the real `containReply`, so a zero is a true
   * statement about the composed path: the client rejected and containment was never reached.
   * Four of the nine never get there, and that is the property - not an artefact of this driver.
   */
  readonly containmentCalls: number;
}

/**
 * The two real steps, composed the way the chat route composes them: decode, then contain.
 * Nothing here decides a verdict; it only reports which of the two stages produced one.
 */
async function drive(fixture: ReplyFixture): Promise<Run> {
  let fetchCalls = 0;
  let containmentCalls = 0;

  const fetchImpl: FetchLike = () => {
    fetchCalls += 1;
    return Promise.resolve(
      new Response(JSON.stringify(fixture.envelope), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  const client = createOllamaClient(config, fetchImpl);
  let reply: ChatModelReply;
  try {
    reply = await client.generate(
      {
        prompt: built.prompt,
        format: chatFormat(built.promptMealIds),
        decode: chatModelReplySchema,
      },
      new AbortController().signal,
    );
  } catch (error: unknown) {
    // Narrowed, not cast: anything else is a failure this driver must not disguise as a verdict.
    if (!(error instanceof OllamaError)) {
      throw error;
    }
    return {
      outcome: { outcome: 'decode-failure', reason: error.reason },
      fetchCalls,
      containmentCalls,
    };
  }

  containmentCalls += 1;
  const verdict = containReply(reply, ground);
  return {
    outcome: verdict.contained
      ? { outcome: 'contained' }
      : { outcome: 'refused', rule: verdict.rule },
    fetchCalls,
    containmentCalls,
  };
}

describe('the nine recorded reply fixtures', () => {
  it('is exactly nine attacks, by name and in order', () => {
    expect(REPLY_FIXTURES).toHaveLength(9);
    expect(REPLY_FIXTURES.map((fixture) => fixture.name)).toEqual(FIXTURE_NAMES);
    // A duplicate would satisfy the length and the set of expected verdicts while deleting an
    // attack, so uniqueness is asserted rather than assumed from the list above.
    expect(new Set(FIXTURE_NAMES).size).toBe(9);
  });

  it('carries the verdict this file expects, for every one of them', () => {
    expect(REPLY_FIXTURES.map((fixture) => [fixture.name, fixture.expected])).toEqual(
      EXPECTED_VERDICTS.map(([name, expected]) => [name, expected]),
    );
  });

  it('traces every attack to a document clause', () => {
    for (const fixture of REPLY_FIXTURES) {
      // Brief 6.3: a fixture whose provenance is not written down is a fixture nobody can audit
      // for having been drawn from the implementation it tests.
      expect(fixture.description.length).toBeGreaterThan(80);
      expect(fixture.description).toMatch(/TSD|SDD|Plan|Brief/);
    }
  });
});

describe('the hand-authored scenario', () => {
  it('holds records the shipped catalog could hold', () => {
    // A synthetic scenario the catalog would reject is a scenario whose verdicts say nothing
    // about the shipped one (TSD 7.4's all-or-nothing nutrition rule included).
    for (const meal of FIXTURE_MEALS) {
      expect(mealSchema.safeParse(meal).success).toBe(true);
    }
  });

  it('derives the ground the four checks need', () => {
    expect(ground.promptMealIds).toEqual(['fx-grilled-salmon-plate', 'fx-chickpea-tagine']);
    expect(ground.promptMealNames).toEqual(['Grilled Salmon Plate', 'Chickpea Tagine']);
    // Bare digit strings, from TSD 4.9's FORMATTED values. Neither prompt name carries a digit,
    // so nothing is added on the name side - and `9` is absent, which is the control on reading
    // a spelled cardinal out of `Tagine`.
    expect(ground.permittedFigures).toEqual(['32', '24']);
    expect(ground.forbiddenMealNames).toEqual(['Mushroom Congee', 'Lentil Soup']);
  });

  it('forbids names no mask over a permitted name could exempt', () => {
    // The unnamed-meal fixture must test check 4 and not containment's longest-first masking of
    // permitted names. A mask can only exempt a forbidden occurrence lying INSIDE a permitted
    // name's occurrence, so this asserts the property the fixture depends on rather than
    // trusting a comment in the fixture file.
    for (const forbidden of ground.forbiddenMealNames) {
      for (const permitted of ground.promptMealNames) {
        expect(flattenForMatching(permitted)).not.toContain(flattenForMatching(forbidden).trim());
        expect(flattenForMatching(forbidden)).not.toContain(flattenForMatching(permitted).trim());
      }
    }
  });

  it('constrains the model to the same ids the ground permits', () => {
    // Plan 15.4's layer 0 and layer 1 must agree about the id set, or the grammar forbids what
    // containment permits. `promptMealIds` reaches the model through `chatFormat`'s enum and
    // reaches containment through the ground; both are asserted to be the one list.
    expect(built.promptMealIds).toEqual(ground.promptMealIds);
    expect(chatFormat(built.promptMealIds).properties.citedMealIds.items.enum).toEqual(
      ground.promptMealIds,
    );
  });
});

describe('each fixture through the real client and the real containment', () => {
  it.each(REPLY_FIXTURES)('$name', async (fixture) => {
    const run = await drive(fixture);
    DRIVEN.push(fixture.name);

    expect(run.outcome).toEqual(fixture.expected);

    // Plan 15.5's Retry/repair row is `none` on either lane: one call on every path, including
    // the four that fail to decode.
    expect(run.fetchCalls).toBe(1);

    // A decode failure must never reach containment. TSD 5.5's decode is the first gate and a
    // reply that fails it is not a reply.
    expect(run.containmentCalls).toBe(fixture.expected.outcome === 'decode-failure' ? 0 : 1);
  });
});

describe('the claims a table of outcomes cannot express', () => {
  it('would have shown the truncated reply, but for done_reason', () => {
    // The naive implementation's exact case: parseable, schema-valid, and contained. Only TSD
    // 5.5 step 3 stands between it and a user, which is why it must be checked BEFORE the inner
    // parse. A fixture that was truncated AND malformed could not prove this.
    const truncated = fixtureNamed('truncated');
    const parsed: unknown = JSON.parse(truncated.envelope.response);
    const decoded = chatModelReplySchema.safeParse(parsed);
    expect(decoded.success).toBe(true);
    if (decoded.success) {
      expect(containReply(decoded.data, ground)).toEqual({ contained: true });
    }
    expect(truncated.envelope.done_reason).toBe('length');
  });

  it('catches malformed JSON at the parse and the extra field at the schema', () => {
    // Both report `schema`, because TSD 5.5 step 4 folds the inner parse and the Zod rejection
    // into one reason. So the LAYER that catches each is not observable from the failure reason
    // and is asserted here directly.
    expect(() => JSON.parse(fixtureNamed('malformed-json').envelope.response)).toThrow();

    const extra: unknown = JSON.parse(fixtureNamed('extra-field').envelope.response);
    expect(extra).toHaveProperty('proteinGrams');
    expect(chatModelReplySchema.safeParse(extra).success).toBe(false);
  });

  it('carries a phrase the denylist owns, without asserting the denylist', () => {
    // `deniedClaimIn` is consumed rather than `DENIED_CLAIMS` counted: the list has grown from
    // 16 documented entries to 19 under PRD 7.3, and a length assertion here would break on a
    // change that is A8's to make.
    expect(deniedClaimIn(replyOf('denied-claim').answer)).toBeDefined();
    expect(deniedClaimIn(replyOf('valid').answer)).toBeUndefined();
  });

  it('reports the offending token and never the sentence it came from', () => {
    // TSD 5.7: the client is never told which rule fired, so `evidence` exists for the server's
    // own log - and TSD 5.8 forbids logging an answer. Each evidence value below is asserted to
    // be the single token, present in the answer, and not to carry the answer.
    const cases = [
      ['uncited-id', 'fx-mushroom-congee'],
      ['wrong-figure', '34'],
      ['unnamed-meal', 'Mushroom Congee'],
    ] as const;

    for (const [name, token] of cases) {
      const reply = replyOf(name);
      const verdict = containReply(reply, ground);
      expect(verdict.contained).toBe(false);
      if (!verdict.contained) {
        expect(verdict.evidence).toBe(token);
        expect(verdict.evidence).not.toContain(reply.answer);
      }
    }
  });

  it('drove every fixture through the real path', () => {
    // Without this, emptying the body of the loop above leaves the suite green: the outcome
    // assertions would simply stop happening, and nothing else executes the client. That is
    // Brief 6.2.4's shape - a test can pass in isolation and be dead in its file - so the run
    // is recorded and the record is checked. Declaration order is the run order here; the file
    // sets no `sequence.shuffle`.
    expect(DRIVEN).toEqual(FIXTURE_NAMES);
  });
});
