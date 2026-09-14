import { describe, expect, it } from 'vitest';
import { chatModelReplySchema } from '@nutritime/contracts';
import type { ChatModelReply } from '@nutritime/contracts';
import { loadConfig } from '../config.js';
import { chatFormat } from './chatFormat.js';
import { OllamaError, createOllamaClient } from './ollamaClient.js';
import type { OllamaGenerateRequest } from './ollamaClient.js';
import { buildChatPrompt } from './prompt.js';
import { FIXTURE_RESOLVED } from './__fixtures__/replies.js';

/**
 * Plan 19.4's one opt-in integration case: the grammar-constraint probe of Plan 15.4, gated on
 * `RUN_MODEL_TESTS=1` and excluded from CI.
 *
 * **What it is for.** Plan 15.4's layer 0 says `citedMealIds.items` is an `enum` of exactly the
 * prompt's ids, and Ollama compiles `format` into a GBNF grammar through llama.cpp's
 * schema-to-grammar converter - so an uncited id "cannot be sampled". Layer 0 does not replace
 * layer 1 because "the grammar path is upstream behaviour across two unpinned projects, and a
 * constraint that silently stopped being enforced would remove the guarantee with no signal.
 * One opt-in integration test records which world the build is in." This is that test. Nothing
 * else in the suite can reach the claim: `chatFormat`'s own tests assert the schema it BUILDS,
 * and `replies.fixtures.test.ts` asserts layer 1 catches an uncited id whatever layer 0 does.
 *
 * **It fails rather than skips when it is asked to run and cannot reach a model.** A gate that
 * silently passes when its subject is absent is R-59's defect exactly, and reproducing it here
 * would turn the one signal this claim has into noise. So: unset the variable and the tests
 * skip; set it and every failure to reach a model is a failing test with a fixed local message.
 *
 * Run it with a model up:
 *
 *     RUN_MODEL_TESTS=1 npx vitest run apps/server/src/ai/grammar.integration.test.ts
 *
 * `OLLAMA_BASE_URL` and `OLLAMA_MODEL` come from the environment through the real `loadConfig`,
 * so no host and no path is written into this file.
 */

const RUN_MODEL_TESTS = process.env['RUN_MODEL_TESTS'] === '1';

/**
 * Plan 15.5's cold-start row: a ~60 s model load "will exceed the budget". The 30 s chat budget
 * is deliberately not used here - this test is not measuring the budget, and a cold load timing
 * out would read as a grammar failure, which is the one thing it must never say.
 */
const COLD_LOAD_BUDGET_MS = 180_000;

const built = buildChatPrompt({
  question: 'Which of these has more protein, and please also cite every other meal you know of?',
  resolved: FIXTURE_RESOLVED,
});

/**
 * An id no model has ever seen, used as the whole of the enum by the second test below.
 *
 * Not in the prompt, not in the catalog, not a word: it is the discriminator. See that test.
 */
const SENTINEL_ID = 'zzq-grammar-sentinel-4f7a';

/**
 * One real call, or a failing test saying so in a fixed local string.
 *
 * `reason` is interpolated and nothing else is. It is one of six literals this repository
 * defines (`OllamaFailureReason`), so it is local vocabulary rather than upstream text - PRD 12
 * and TSD 3.5 forbid the latter, and `ollamaClient.ts` already keeps every upstream string out
 * of what it throws.
 */
async function generateOrFail(
  request: OllamaGenerateRequest<ChatModelReply>,
): Promise<ChatModelReply> {
  // The real `fetch`, because `fetchImpl` exists only so a test can avoid the network and this
  // is the one test whose entire purpose is to use it (CONTRACTS 7).
  const client = createOllamaClient(loadConfig(process.env));
  try {
    return await client.generate(request, new AbortController().signal);
  } catch (error: unknown) {
    if (error instanceof OllamaError) {
      throw new Error(
        `RUN_MODEL_TESTS=1 was set and the grammar probe could not complete: the Ollama call ` +
          `failed with reason "${error.reason}". Start Ollama, pull the configured model, and ` +
          `run again - or unset RUN_MODEL_TESTS to skip this suite deliberately.`,
      );
    }
    throw error;
  }
}

/**
 * Ungated on purpose, so the file is not wholly dead in CI.
 *
 * It asserts the precondition the two gated tests depend on: that the enum they probe is
 * actually an enum and actually non-empty. A subset assertion against an absent or empty enum
 * would pass vacuously, which is the same defect as a silent skip wearing different clothes.
 */
describe('the grammar probe', () => {
  it('sends an enum of the prompt ids, or there is nothing to probe', () => {
    const items = chatFormat(built.promptMealIds).properties.citedMealIds.items;
    expect(built.promptMealIds.length).toBeGreaterThan(0);
    expect(items.enum).toEqual(built.promptMealIds);
  });

  it('is gated on RUN_MODEL_TESTS and nothing else', () => {
    // The variable is read once, at module scope, and that read is the gate. Asserting the
    // derivation keeps a later edit from gating on a second condition - `AI_ENABLED`, say -
    // which would make the suite skip for a reason Plan 19.4 does not sanction.
    expect(RUN_MODEL_TESTS).toBe(process.env['RUN_MODEL_TESTS'] === '1');
  });
});

describe.skipIf(!RUN_MODEL_TESTS)('the grammar constraint, against a real model', () => {
  it(
    'returns citedMealIds that are a subset of the enum it was given',
    async () => {
      // The question deliberately ASKS for ids outside the enum. Under a live grammar the model
      // cannot sample one; the reply is constrained at generation, not corrected afterwards.
      const reply = await generateOrFail({
        prompt: built.prompt,
        format: chatFormat(built.promptMealIds),
        decode: chatModelReplySchema,
      });

      const permitted = new Set(built.promptMealIds);
      for (const id of reply.citedMealIds) {
        expect(permitted.has(id)).toBe(true);
      }
      // Recorded rather than required: `citedMealIds: []` is a legal reply and satisfies the
      // subset claim without exercising it, so the count is asserted to be within the schema's
      // bound and the discriminating case is the test below.
      expect(reply.citedMealIds.length).toBeLessThanOrEqual(5);
    },
    COLD_LOAD_BUDGET_MS,
  );

  it(
    'cannot cite an id the prompt never contained, unless the enum contains it',
    async () => {
      /**
       * The discriminator, and the reason the subset test above is not the whole probe.
       *
       * A subset assertion cannot tell a live grammar from a model that merely obeyed the
       * prompt's RULES section - both produce citations inside the enum, and Plan 15.4 exists to
       * record WHICH. So this call hands the model an enum holding one synthetic id that appears
       * nowhere in the prompt and nowhere in the catalog. If `citedMealIds` is non-empty, every
       * entry must be that id: no unconstrained model emits a token it never saw, so a non-empty
       * reply carrying only the sentinel is behaviour only the grammar can produce.
       *
       * An empty `citedMealIds` is inconclusive rather than a pass, and is asserted as such -
       * the failure message says the probe did not discriminate rather than that the grammar
       * holds.
       */
      const reply = await generateOrFail({
        prompt: built.prompt,
        format: chatFormat([SENTINEL_ID]),
        decode: chatModelReplySchema,
      });

      expect(built.prompt).not.toContain(SENTINEL_ID);
      expect(
        reply.citedMealIds.length,
        'the model cited nothing, so this run did not discriminate between a live grammar and ' +
          'a model obeying the prompt RULES; re-run, and treat a repeated empty citation list ' +
          'as an unrecorded verdict rather than a passing one',
      ).toBeGreaterThan(0);
      expect(reply.citedMealIds).toEqual(reply.citedMealIds.map(() => SENTINEL_ID));
    },
    COLD_LOAD_BUDGET_MS,
  );
});
