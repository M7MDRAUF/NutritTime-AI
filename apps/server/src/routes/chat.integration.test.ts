import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { ChatModelReply } from '@nutritime/contracts';
import { CHAT_COPY } from '../ai/chatCopy.js';
import type { Catalog } from '../catalog.js';
import {
  ask,
  CHAT_PATH,
  CHEAPEST_SAFE,
  expectedErrorBody,
  firstOf,
  harness,
  MIXED_CATALOG,
  nameOnlyReply,
  ORDERING_QUESTION,
  PEANUT_MEAL,
  PEANUT_ONLY_CATALOG,
  PEANUT_TAGGED,
  SAFE_PARTNERS,
  sendRaw,
  SUPERLATIVE_QUESTION,
  UNRESOLVABLE_QUESTION,
} from './__fixtures__/chatHarness.js';
import type { AskOptions, Harness } from './__fixtures__/chatHarness.js';

/**
 * T-21-08 - every case in Plan 11.6's `Tests` row, driven through `createApp`.
 *
 * **Why this suite exists beside `chat.test.ts`, which already has 38 tests.** That file mounts
 * `chatRouter` directly with a stub provider, so it sees the route and nothing else. This one
 * goes through `createApp`, which means every assertion below also crosses TSD 5.3's six layers
 * in order - `cors`, the request log line, `express.json`'s 64 KB cap, the routes, the 404
 * handler and the error handler that turns an `ApiError` into a body. **A route can be perfectly
 * correct and still answer wrongly through a stack** - a body rejected before the route runs, a
 * log line written after it, a 404 for a path the router never claimed - and only this layer
 * sees that.
 *
 * **The stack's own contracts are asserted next door**, in
 * `chat.middleware.integration.test.ts`: `cors` on this route, the 404 for a chat path no route
 * claims, and TSD 5.8's two log lines. This file reached 1052 lines against Plan 17.1's 350-line
 * cap and was split on the SUBJECT rather than granted an exception - Plan 11.6's contract here,
 * TSD 5.3 and 5.8's stack there - which is how `recommendations.integration.test.ts` was handled
 * at 1136 in the same wave, and `contrast.test.ts` before it. The construction the two halves
 * share then moved once more, into `./__fixtures__/chatHarness.ts`, because a 210-line block
 * copied into two files drifts and the drift is invisible - this wave found one mapping in three
 * files with two already diverged.
 *
 * **What stays HERE is every control, and that is the line the harness may not cross.** A control
 * separated from the claim it controls is how a discriminating test quietly becomes a decorative
 * one, so the allergen argument is one `describe` below: the no-allergy control that proves the
 * peanut meal was reachable, the whole-outbound-body assertion, and the discard of a reply that
 * cites it anyway. The harness supplies the fixture and the request builder; it holds no
 * `expect` and asserts nothing. Same for containment's contained-reply control and step 4's
 * three-distinct-copies control.
 *
 * **The model is driven through `fetchImpl`, not through a stub provider** (`AppOptions.fetchImpl`
 * exists for exactly this). So the REAL `createAiProvider`, the REAL `createOllamaClient` and the
 * REAL `createAiLane` all run: the two-stage decode, the grammar this route sends, the
 * single-flight lane and `containReply` are all live, and the only thing replaced is the socket.
 * That is what makes a hostile reply here evidence rather than a mock - and it is also how the
 * suite reads the OUTBOUND request, which is the only place a test can see what the model was
 * allowed to know.
 *
 * `AI_FAKE=true` is the second way in and gets one test of its own: it executes retrieval,
 * resolution, prompt build and containment for real, and must reach no socket at all.
 *
 * **What is deliberately NOT here.** `apps/server/src/ai/lane-contention.integration.test.ts`
 * already proves the chat lane and the explanation lane share ONE lane, with the two assertions
 * that discriminate (the provider is contacted exactly once, and the refused caller gets
 * `ai_busy` rather than `ai_unavailable` from its own timeout). A chat-to-chat contention test
 * **would pass with a lane per router**, so the case below is scoped to Plan 11.6's wording and
 * defers the cross-lane property to that file rather than restating it weaker.
 *
 * ## Plan 11.6 `Tests` row - the checklist, and where each case is covered
 *
 * | Plan 11.6 case | Test |
 * |---|---|
 * | Allergen exclusion from context **and** citations | `is in NEITHER the outbound prompt nor the citations once declared`, with `carries the peanut meal in BOTH when no allergy is declared - the control` and `discards a reply that cites the excluded meal anyway` |
 * | `answered: false` + `200` + `source: "local"` when filters exclude everything, with no model call | `answers 200 answered:false source:local and contacts no model` |
 * | ...same when no resolver matches | `answers 200 answered:false source:local for a question no resolver matches` |
 * | `goal`/`budget` -> 400 | `rejects \`goal\` in preferences with a 400 that names only the path` · `rejects \`budget\` in preferences` |
 * | a reply citing an unretrieved id discarded | `discards a reply that cites an id the prompt never carried` |
 * | a reply quoting an unresolved figure discarded | `discards a reply that quotes a figure the domain did not resolve` |
 * | a safety claim discarded | `discards a reply that makes a safety claim` |
 * | a meal named but not in the prompt discarded | `discards a reply that names a meal the prompt does not carry` |
 * | `AI_ENABLED=false` -> `ai_disabled` | `answers 503 ai_disabled for a question that needs phrasing` |
 * | second concurrent request -> `ai_busy` | `answers a second chat request ai_busy while the first holds the lane` |
 *
 * Plan 19.4's chat-relevant rows - the happy path, `details` naming the field, the two `goal` /
 * `budget` rows, `ai_disabled`, `ai_busy`, both `answered: false` rows with the call count, and a
 * 65 KB body - are the same cases plus `rejects a 65 KB body before the route ever runs`.
 *
 * Fixtures come from `./__fixtures__/chatHarness.ts` and are **read out of the seeded catalog at
 * runtime** (BRIEF 6.3): the peanut fixture is selected by its `allergenTags`, never by a
 * hard-coded id. The `describe('the fixtures...')` block below is what makes that loud - it
 * asserts the tag, the two dearer partners, the strictly-ascending prices and the distinct names
 * the other suites depend on, so a catalog change fails here rather than quietly invalidating an
 * assertion elsewhere.
 */

// ------------------------------------------------------------------------------------ the tests

describe('the fixtures are the thing they claim to be', () => {
  it('found peanut-tagged records by tag, and two dearer peanut-free partners', () => {
    expect(PEANUT_TAGGED.length).toBeGreaterThan(0);
    for (const meal of PEANUT_TAGGED) {
      expect(meal.allergenTags).toContain('peanut');
    }
    expect(SAFE_PARTNERS).toHaveLength(2);
    // Strictly ascending, so `cheapest` has exactly one winner in each of the two runs below
    // and the ordering answer has one order.
    const prices = [PEANUT_MEAL, ...SAFE_PARTNERS].map((meal) => meal.price.amountCents);
    expect(prices[0]).toBeLessThan(prices[1] ?? 0);
    expect(prices[1]).toBeLessThan(prices[2] ?? 0);
    // The peanut meal is available, so it is excluded by the ALLERGY and not by availability.
    expect(PEANUT_MEAL.available).toBe(true);
  });

  it('gives the three fixtures names no substring check can confuse', () => {
    // Check 4 matches on a flattened name, so a name contained in another would make
    // `discards a reply that names a meal the prompt does not carry` unreadable.
    const names = [PEANUT_MEAL, ...SAFE_PARTNERS].map((meal) => meal.name.toLowerCase());
    expect(new Set(names).size).toBe(3);
    for (const name of names) {
      expect(names.filter((other) => other.includes(name))).toHaveLength(1);
    }
  });
});

describe('step 1 - the body is parsed before anything else (Plan 11.6 validation)', () => {
  it('rejects `goal` in preferences with a 400 that names only the path', async () => {
    const harnessed = harness();
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      extraPreferences: { goal: 'high-protein' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.retryable).toBe(false);
    expect(Object.keys(response.body.error.details)).toStrictEqual(['preferences']);
    /**
     * **Fixed local copy, and only the PATH taken from the issue.** `errors.ts` records that Zod
     * renders `unrecognized_keys` as `Unrecognized key: "peanut"` - the submitted key echoed
     * verbatim into a body, which on this route could be the allergy list itself (PRD 10.3). So
     * the message must be this module's own string and must not name the offending key.
     */
    expect(response.body.error.details.preferences).toStrictEqual(['unexpected field']);
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('goal');
    expect(serialised).not.toContain('high-protein');
    expect(serialised).not.toContain('Unrecognized');
    expect(response.body.answer).toBeUndefined();
    expect(harnessed.model.calls()).toBe(0);
  });

  it('rejects `budget` in preferences', async () => {
    const harnessed = harness();
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      extraPreferences: { budget: 'medium' },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.details.preferences).toStrictEqual(['unexpected field']);
    expect(JSON.stringify(response.body)).not.toContain('budget');
    expect(harnessed.model.calls()).toBe(0);
  });

  it('names the missing field in `details` (Plan 19.4)', async () => {
    const harnessed = harness();
    const response = await request(harnessed.app)
      .post(CHAT_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ preferences: { diet: 'regular', allergies: [] } }));

    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.details)).toContain('question');
    expect(Object.keys(response.body.error.details)).toContain('preferences.dislikedIngredients');
  });

  it('rejects a body that is valid JSON but not an object', async () => {
    const harnessed = harness();
    const response = await sendRaw(harnessed, '[1,2,3]');

    // `express.json` is `strict`, so an ARRAY parses and reaches the schema - which rejects it
    // at the root. A route reading `request.body.question` off an array would have read
    // `undefined` and gone on.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(Object.keys(response.body.error.details)).toStrictEqual(['(root)']);
    expect(harnessed.model.calls()).toBe(0);
  });

  it('rejects a body that is a bare JSON scalar', async () => {
    const harnessed = harness();
    const response = await sendRaw(harnessed, '"just a string"');

    // Refused by `express.json`'s own strict mode, one layer before the route - so this is a
    // middleware assertion and not a schema one, and it lands on the error handler's 4xx branch.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(harnessed.model.calls()).toBe(0);
  });

  it('rejects a malformed JSON body without echoing any of it', async () => {
    const harnessed = harness();
    const token = 'qzxvmarkerone';
    const response = await sendRaw(harnessed, `{"question": "${token}"`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.details).toStrictEqual({
      body: ['the request body could not be read'],
    });
    // A `SyntaxError` from `JSON.parse` quotes the fragment it choked on. Nothing of it reaches
    // the body or the log (TSD 3.5, PRD 10.3).
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(harnessed.lines.join('\n')).not.toContain(token);
  });

  it('rejects a 65 KB body before the route ever runs', async () => {
    const harnessed = harness();
    const token = 'qzxvmarkertwo';
    // The token sits INSIDE the oversized question, so a body that leaked into a log or a body
    // would show it. A rejected body is exactly where a naive logger dumps one.
    const response = await sendRaw(
      harnessed,
      JSON.stringify({
        question: `${token}${'x'.repeat(65 * 1024)}`,
        preferences: { diet: 'regular', allergies: [], dislikedIngredients: [] },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.retryable).toBe(false);
    expect(response.body.error.details).toStrictEqual({
      body: ['the request body is too large'],
    });
    expect(response.body.answer).toBeUndefined();
    expect(harnessed.model.calls()).toBe(0);
    // TSD 5.8 and SDD 13 promise one line per request, and the logger is registered before the
    // parser precisely so a rejected body still gets one.
    expect(harnessed.lines).toHaveLength(1);
    expect(harnessed.lines.join('\n')).not.toContain(token);
  });
});

describe('step 2 - filters exclude everything (Plan 11.6, Plan 19.4)', () => {
  it('answers 200 answered:false source:local and contacts no model', async () => {
    const harnessed = harness({
      catalog: PEANUT_ONLY_CATALOG,
      behaviour: { kind: 'reply', reply: nameOnlyReply([PEANUT_MEAL]) },
    });
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      answered: false,
      answer: CHAT_COPY.noEligibleMeals,
      citations: [],
      source: 'local',
    });
    /**
     * **The body assertion above is not enough, and that is the finding this row exists for.** A
     * sibling agent found that calling the provider on the empty-eligible path left the response
     * body matching EXACTLY - the reply is discarded and the local copy answered either way - and
     * only a call count caught it. So: zero.
     */
    expect(harnessed.model.calls()).toBe(0);
  });

  it('would have reached the model without the allergy - the control', async () => {
    // The control that makes the case above non-vacuous: same catalog, same question, no
    // allergy. `unreachable` rather than a reply, so the evidence is that a SOCKET was asked
    // for - which can only happen past steps 2, 3 and 4.
    const harnessed = harness({ catalog: PEANUT_ONLY_CATALOG });
    const response = await ask(harnessed, { question: SUPERLATIVE_QUESTION });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_unavailable');
    expect(harnessed.model.calls()).toBe(1);
  });
});

describe('step 3 - no resolver matches (Plan 11.6, Plan 19.4)', () => {
  it('answers 200 answered:false source:local for a question no resolver matches', async () => {
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply([CHEAPEST_SAFE]) },
    });
    const response = await ask(harnessed, { question: UNRESOLVABLE_QUESTION });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      answered: false,
      answer: CHAT_COPY.noInformation,
      citations: [],
      source: 'local',
    });
    expect(harnessed.model.calls()).toBe(0);
  });

  it('answers a capability question from the same copy as a greeting (R-22)', async () => {
    // PRD 7.4 lists Capability as its own shape; TSD 4.9 has no `capability` reason, so the
    // route cannot give them different words. Pinned so the collision is visible rather than
    // looking like an accident.
    const harnessed = harness();
    const response = await ask(harnessed, { question: 'what can you do?' });

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe(CHAT_COPY.greeting);
    expect(harnessed.model.calls()).toBe(0);
  });

  it('would have reached the model for a question that DOES resolve - the control', async () => {
    const harnessed = harness();
    const response = await ask(harnessed, { question: SUPERLATIVE_QUESTION });

    expect(response.status).toBe(503);
    expect(harnessed.model.calls()).toBe(1);
  });
});

describe('the allergen exclusion, from CONTEXT and from CITATIONS (Plan 11.6)', () => {
  /**
   * `rank these by price` is scoped to `scope.context`, so `namedMeals` IS the context and the
   * prompt carries all of it. That is what makes "excluded from context" observable at this
   * layer: the outbound body is the only record of what the model was allowed to know.
   *
   * `what is the cheapest?` would only ever carry the winner, so the same assertion against it
   * would prove the weaker "excluded from the citations" twice over.
   */
  const promptOf = (harnessed: Harness): string => {
    const body = firstOf(harnessed.model.outbound(), 'an outbound model request');
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || !('prompt' in parsed)) {
      throw new Error('the outbound body carried no prompt');
    }
    const { prompt } = parsed;
    return typeof prompt === 'string' ? prompt : '';
  };

  it('carries the peanut meal in BOTH when no allergy is declared - the control', async () => {
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply([PEANUT_MEAL, ...SAFE_PARTNERS]) },
    });
    const response = await ask(harnessed, { question: ORDERING_QUESTION });

    expect(response.status).toBe(200);
    expect(response.body.source).toBe('gemma');
    // The citation could only come back if the id was in the prompt: a `citedMealIds` entry the
    // prompt never carried is discarded by containment check 1, which would be a 503.
    const cited: string[] = response.body.citations.map(
      (citation: { mealId: string }) => citation.mealId,
    );
    expect(cited).toContain(PEANUT_MEAL.id);
    expect(promptOf(harnessed)).toContain(PEANUT_MEAL.name);
  });

  it('is in NEITHER the outbound prompt nor the citations once declared', async () => {
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply(SAFE_PARTNERS) },
    });
    const response = await ask(harnessed, {
      question: ORDERING_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(200);
    const cited: string[] = response.body.citations.map(
      (citation: { mealId: string }) => citation.mealId,
    );
    // Not empty: the exclusion removed the conflicting meal and nothing else, so "absent" is a
    // rejection rather than an empty answer.
    expect(cited).toStrictEqual(SAFE_PARTNERS.map((meal) => meal.id));
    expect(cited).not.toContain(PEANUT_MEAL.id);

    /**
     * **The whole outbound body, not only the prompt.** The id also travels in the grammar
     * (`chatFormat`'s `citedMealIds.items.enum`), so asserting the prompt alone would leave a
     * model able to cite a meal it was never shown. And the allergy TERM itself must not be
     * there either: retrieval consumed it and BRIEF 7.8 gives the prompt no parameter for it.
     */
    const outbound = harnessed.model.outbound().join('\n');
    expect(outbound).not.toContain(PEANUT_MEAL.id);
    expect(outbound).not.toContain(PEANUT_MEAL.name);
    expect(outbound.toLowerCase()).not.toContain('peanut');
  });

  it('discards a reply that cites the excluded meal anyway', async () => {
    // Defence in depth, and the reason citations are compared against the prompt rather than
    // trusted: even if a model returned the excluded id, containment check 1 refuses the whole
    // reply rather than dropping the one citation.
    const harnessed = harness({
      behaviour: {
        kind: 'reply',
        reply: { answered: true, answer: `${CHEAPEST_SAFE.name}.`, citedMealIds: [PEANUT_MEAL.id] },
      },
    });
    const response = await ask(harnessed, {
      question: ORDERING_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_unavailable');
    expect(response.body.answer).toBeUndefined();
  });
});

describe('containment - a failing reply is discarded, never partly used (Plan 11.6)', () => {
  /**
   * With `allergies: ['peanut']` on `MIXED_CATALOG`, `what is the cheapest?` resolves over the
   * two safe meals and `CHEAPEST_SAFE` wins - so the prompt carries exactly one id, one name and
   * one figure, and both the peanut meal's name and the dearer partner's are FORBIDDEN. Every
   * reply below fails exactly one check and passes the ones before it, because check order is
   * 1 -> 2 -> 3 -> 4 and the first failure wins.
   */
  const hostile: readonly (readonly [string, string, ChatModelReply])[] = [
    [
      'cites an id the prompt never carried',
      'uncited-meal',
      {
        answered: true,
        answer: `${CHEAPEST_SAFE.name} is the cheapest.`,
        citedMealIds: ['no-such-meal-in-any-catalog'],
      },
    ],
    [
      'makes a safety claim',
      'denied-claim',
      {
        answered: true,
        answer: `${CHEAPEST_SAFE.name} is a healthy choice and is allergen free.`,
        citedMealIds: [CHEAPEST_SAFE.id],
      },
    ],
    [
      'quotes a figure the domain did not resolve',
      'ungrounded-figure',
      {
        answered: true,
        answer: `${CHEAPEST_SAFE.name} costs $9.99.`,
        citedMealIds: [CHEAPEST_SAFE.id],
      },
    ],
    [
      'names a meal the prompt does not carry',
      'ungrounded-meal',
      {
        answered: true,
        answer: `Try ${PEANUT_MEAL.name} instead.`,
        citedMealIds: [],
      },
    ],
  ];

  for (const [label, rule, reply] of hostile) {
    it(`discards a reply that ${label}`, async () => {
      const harnessed = harness({ behaviour: { kind: 'reply', reply } });
      const response = await ask(harnessed, {
        question: SUPERLATIVE_QUESTION,
        allergies: ['peanut'],
      });

      expect(response.status).toBe(503);
      // The whole body, so a fifth field cannot appear. Plan 11.6: no answer text on any
      // failure path, because a free-text question has no rule-based equivalent.
      expect(response.body).toStrictEqual(
        expectedErrorBody('ai_unavailable', 'The assistant is unavailable right now.', true),
      );
      expect(response.body.answer).toBeUndefined();

      const serialised = JSON.stringify(response.body);
      // Not the answer, not a fragment of it, and not the diagnosis. TSD 5.7: "The client is
      // never told which rule fired" - a containment rule is not something a caller should be
      // able to probe for - and TSD 5.8 defines no field for the evidence.
      expect(serialised).not.toContain(reply.answer);
      for (const word of reply.answer.split(' ').filter((part) => part.length > 4)) {
        expect(serialised).not.toContain(word);
      }
      expect(serialised).not.toContain(rule);
      expect(serialised).not.toContain('rule');
      expect(serialised).not.toContain('evidence');
      // It really did go to the model and come back: the reply was refused, not never fetched.
      expect(harnessed.model.calls()).toBe(1);
    });
  }

  it('answers 200 for the same prompt when the reply is contained - the control', async () => {
    // BRIEF 6.2.2: a control no single constant satisfies. A route answering 503 for every
    // reply passes all four cases above and fails this one.
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply([CHEAPEST_SAFE]) },
    });
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      answered: true,
      answer: `${CHEAPEST_SAFE.name}.`,
      citations: [{ mealId: CHEAPEST_SAFE.id, name: CHEAPEST_SAFE.name }],
      source: 'gemma',
    });
  });
});

describe('step 4 - the AI gate is checked AFTER retrieval and resolution (Plan 11.6)', () => {
  const off = { AI_ENABLED: 'false' };

  it('answers 503 ai_disabled for a question that needs phrasing', async () => {
    const harnessed = harness({ env: off });
    const response = await ask(harnessed, { question: SUPERLATIVE_QUESTION });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual(
      expectedErrorBody('ai_disabled', 'The assistant is turned off.', false),
    );
    expect(response.body.answer).toBeUndefined();
    expect(harnessed.model.calls()).toBe(0);
  });

  /**
   * **This is the case that matters more, and it is what the step ORDER buys.**
   *
   * TSD 5.4 puts the `AI_ENABLED` check at step 4 - after retrieval and after resolution - so
   * every answer the route can give WITHOUT phrasing still comes back 200 with the model
   * switched off. Hoisting the check above step 2 turns each of these into a 503 and makes the
   * assistant look broken to someone who turned off a feature they were not using.
   *
   * These three are the complete set of pre-gate answers: an empty eligible set (step 2), and an
   * `UnresolvedAnswer` in either of its two copy shapes (step 3). A question the domain
   * RESOLVES is deliberately not among them - PRD 7.3 says to "report the assistant as
   * unavailable, never substitute a generated answer, when AI is off", and FR-015 says there is
   * no fallback answer - so the 503 above is the documented behaviour rather than a gap.
   */
  const preGate: readonly (readonly [string, AskOptions, Catalog, string])[] = [
    [
      'an empty eligible set',
      { question: SUPERLATIVE_QUESTION, allergies: ['peanut'] },
      PEANUT_ONLY_CATALOG,
      CHAT_COPY.noEligibleMeals,
    ],
    [
      'a question no resolver matches',
      { question: UNRESOLVABLE_QUESTION },
      MIXED_CATALOG,
      CHAT_COPY.noInformation,
    ],
    ['a capability question', { question: 'what can you do?' }, MIXED_CATALOG, CHAT_COPY.greeting],
  ];

  for (const [label, askOptions, catalog, copy] of preGate) {
    it(`still answers 200 for ${label} with AI_ENABLED=false`, async () => {
      const harnessed = harness({ catalog, env: off });
      const response = await ask(harnessed, askOptions);

      expect(response.status).toBe(200);
      expect(response.body).toStrictEqual({
        answered: false,
        answer: copy,
        citations: [],
        source: 'local',
      });
      expect(harnessed.model.calls()).toBe(0);
    });
  }

  it('gives the three pre-gate answers three different strings', () => {
    // So a mutant answering one copy string everywhere fails here as well as above.
    expect(new Set(preGate.map(([, , , copy]) => copy)).size).toBe(3);
  });
});

describe('step 5 - the lane, and the second concurrent request (Plan 11.6)', () => {
  /** Long enough for the first request to reach `fetch` and claim the single flight. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  it('answers a second chat request ai_busy while the first holds the lane', async () => {
    /**
     * **Scoped to Plan 11.6's wording, and weaker than it looks - deliberately.** Two CHAT
     * requests would contend with a lane per router too, so this proves single-flight on ONE
     * lane and nothing about "process-wide". The cross-lane property - a chat request and a
     * recommendation-with-explanation contending, with the provider contacted exactly once and
     * `ai_busy` rather than a timeout's `ai_unavailable` - is
     * `apps/server/src/ai/lane-contention.integration.test.ts`, and is not restated here.
     */
    const harnessed = harness({ behaviour: { kind: 'hold' } });

    const first = ask(harnessed, { question: SUPERLATIVE_QUESTION });
    void first.catch(() => undefined);
    await settle();
    expect(harnessed.model.calls()).toBe(1);

    const second = await ask(harnessed, { question: SUPERLATIVE_QUESTION });

    expect(second.status).toBe(503);
    expect(second.body).toStrictEqual(
      expectedErrorBody('ai_busy', 'The assistant is busy with another question.', true),
    );
    expect(second.body.answer).toBeUndefined();
    // The refusal happened before `fn` ran, so the model was not contacted a second time.
    expect(harnessed.model.calls()).toBe(1);

    harnessed.model.release();
    await first.catch(() => undefined);
  });

  it('answers the happy path 200 with source gemma and citations resolved by id', async () => {
    const harnessed = harness({
      behaviour: { kind: 'reply', reply: nameOnlyReply([PEANUT_MEAL, ...SAFE_PARTNERS]) },
    });
    const response = await ask(harnessed, { question: ORDERING_QUESTION });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      answered: true,
      answer: `${[PEANUT_MEAL, ...SAFE_PARTNERS].map((meal) => meal.name).join(', then ')}.`,
      citations: [PEANUT_MEAL, ...SAFE_PARTNERS].map((meal) => ({
        mealId: meal.id,
        name: meal.name,
      })),
      source: 'gemma',
    });
    expect(harnessed.model.calls()).toBe(1);
  });

  it('runs the whole path under AI_FAKE without reaching a socket', async () => {
    // TSD 5.5's echo IS the resolved statement, so retrieval, resolution, the prompt build and
    // containment all run for real and the reply passes by construction. If this ever fails
    // containment, containment has a false positive - a defect, not a fixture to adjust.
    const harnessed = harness({ env: { AI_FAKE: 'true' } });
    const response = await ask(harnessed, {
      question: SUPERLATIVE_QUESTION,
      allergies: ['peanut'],
    });

    expect(response.status).toBe(200);
    expect(response.body.answered).toBe(true);
    expect(response.body.source).toBe('gemma');
    expect(response.body.answer).toContain(CHEAPEST_SAFE.name);
    expect(response.body.citations).toStrictEqual([
      { mealId: CHEAPEST_SAFE.id, name: CHEAPEST_SAFE.name },
    ]);
    expect(harnessed.model.calls()).toBe(0);
  });

  it('answers 503 ai_unavailable when the model cannot be reached', async () => {
    const harnessed = harness({ behaviour: { kind: 'unreachable' } });
    const response = await ask(harnessed, { question: SUPERLATIVE_QUESTION });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual(
      expectedErrorBody('ai_unavailable', 'The assistant is unavailable right now.', true),
    );
    // Nothing of the rejection reaches the body: a real `fetch` failure reads
    // `TypeError: fetch failed` over `connect ECONNREFUSED 127.0.0.1:11434`.
    expect(JSON.stringify(response.body)).not.toContain('fetch failed');
  });
});
