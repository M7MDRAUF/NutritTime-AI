import { describe, expect, it } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import type { ChatModelReply, Meal } from '@nutritime/contracts';
import { CHAT_COPY } from '../ai/chatCopy.js';
import { OllamaAbortError, OllamaError } from '../ai/ollamaClient.js';
import type { FetchLike, OllamaFailureReason } from '../ai/ollamaClient.js';
import { createAiProvider } from '../ai/provider.js';
import type { AiProvider, Generation } from '../ai/provider.js';
import { createAiLane } from '../aiLane.js';
import type { AiLane } from '../aiLane.js';
import { buildCatalog } from '../catalog.js';
import type { Catalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import { INTERNAL_ERROR_BODY, isApiError } from '../errors.js';
import { chatRouter } from './chat.js';

/**
 * Plan C-05 at unit level. The integration suite (`chat.integration.test.ts`) is another agent's.
 *
 * **Every test drives the real router over real HTTP with a real lane**, because the claims here
 * are about what the ROUTE does: BRIEF 6.2.1 - a test that reads a module cannot test the
 * module's behaviour. Only the provider is a stub, and the two claims that matter most are
 * negative ones: the provider is **not invoked** on the deterministic paths, and no 503 carries
 * answer text.
 *
 * **The stub provider parses the fixture through `generation.decode`**, which is the real
 * `chatModelReplySchema`, and rejects with `OllamaError('schema')` when it fails - exactly what
 * `ollamaClient.ts` does at the same stage. A stub looser than the real path would make every
 * test here evidence of less than it appears to be (BRIEF 7.4), and it also means no `as` is
 * needed to produce a `Promise<T>`: `parsed.data` already is one.
 *
 * Fixtures are **records from the seeded catalog**, not hand-written meals: BRIEF 6.3 - a fixture
 * drawn from the same mind as the code under test tests the code against its author's
 * imagination. The reply fixtures are adversarial and written to TSD 5.7's four checks.
 */

const seeded = buildCatalog(seededCatalog);

function mealFixture(id: string): Meal {
  const meal = seeded.byId.get(id);
  if (meal === undefined) {
    throw new Error(`fixture meal is not in the seeded catalog: ${id}`);
  }
  return meal;
}

/** A sub-catalog, so eligibility and the forbidden-name set are controlled per test. */
function catalogOf(...ids: readonly string[]): Catalog {
  const meals = ids.map(mealFixture);
  return { meals, byId: new Map(meals.map((meal) => [meal.id, meal])), version: seeded.version };
}

/** 250c / 20 min, 550c / 40 min, 1400c / 240 min. Distinct on every answerable field. */
const CHEAPEST = mealFixture('red-onion-pickle');
const MIDDLE = mealFixture('breakfast-potatoes');
const DEAREST = mealFixture('beef-brisket-pot-roast');
const THREE_MEALS = catalogOf(CHEAPEST.id, MIDDLE.id, DEAREST.id);
/** Both carry the `peanut` allergen tag, so a peanut allergy empties `eligible`. */
const PEANUT_ONLY = catalogOf('pad-see-ew', 'rocky-road-fudge');

interface ProviderStub {
  readonly provider: AiProvider;
  /** How many times the route asked for a generation. The whole point of T-21-02. */
  calls(): number;
}

function replyingProvider(reply: unknown): ProviderStub {
  let calls = 0;
  const provider = <T>(generation: Generation<T>): Promise<T> => {
    calls += 1;
    const parsed = generation.decode.safeParse(reply);
    return parsed.success
      ? Promise.resolve(parsed.data)
      : Promise.reject(new OllamaError('schema'));
  };
  return { provider, calls: () => calls };
}

function failingProvider(error: unknown): ProviderStub {
  let calls = 0;
  const provider = <T>(): Promise<T> => {
    calls += 1;
    return Promise.reject(error);
  };
  return { provider, calls: () => calls };
}

/** Never settles, so the lane's own deadline is what ends the call. */
function silentProvider(): ProviderStub {
  let calls = 0;
  const provider = <T>(): Promise<T> => {
    calls += 1;
    return new Promise<T>(() => undefined);
  };
  return { provider, calls: () => calls };
}

/**
 * The clock the route reads, stepping a fixed amount per read.
 *
 * `durationMs` is therefore **exactly** assertable rather than a range: the route takes two reads
 * per logged call, so the duration is one step and the line's timestamp is the second reading. A
 * mutant that hardcodes a duration, reads the clock a third time, or reaches for `Date.now()`
 * fails on the number rather than being invisible behind `expect.any(Number)`.
 */
const CLOCK_BASE = Date.parse('2026-09-13T10:20:30.400Z');
const CLOCK_STEP_MS = 1_000;

function steppingClock(): () => Date {
  let reads = 0;
  return () => {
    const at = new Date(CLOCK_BASE + reads * CLOCK_STEP_MS);
    reads += 1;
    return at;
  };
}

/** The line a single AI call must produce, in full. `toStrictEqual` is what catches a leak. */
function expectedAiLine(outcome: string): Record<string, unknown> {
  return {
    timestamp: new Date(CLOCK_BASE + CLOCK_STEP_MS).toISOString(),
    level: outcome === 'ok' ? 'info' : 'warn',
    lane: 'chat',
    durationMs: CLOCK_STEP_MS,
    outcome,
  };
}

interface Harness {
  readonly app: express.Express;
  readonly lane: AiLane;
  /** Every line the route wrote, in order. Nothing else writes to this sink. */
  readonly lines: readonly string[];
}

/**
 * The router behind `express.json()` and an `ApiError` handler.
 *
 * Deliberately **not** `createApp`: that mounts the recommendations router, whose signature
 * another agent is changing this wave, and a unit suite that cannot run while a neighbour is
 * mid-edit is a unit suite nobody trusts. The dispatch below is the same two branches
 * `app.ts`'s handler takes for these errors, and the status and body come from `ApiError`
 * itself, so nothing about the mapping is re-implemented here.
 */
function harness(options: {
  readonly catalog?: Catalog;
  readonly env?: NodeJS.ProcessEnv;
  readonly provider: AiProvider;
  readonly lane?: AiLane;
}): Harness {
  const lane = options.lane ?? createAiLane();
  const lines: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/chat',
    chatRouter({
      catalog: options.catalog ?? THREE_MEALS,
      config: loadConfig(options.env ?? {}),
      lane,
      provider: options.provider,
      sink: (line) => lines.push(line),
      now: steppingClock(),
    }),
  );
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    if (isApiError(error)) {
      response.status(error.status).json(error.toBody());
      return;
    }
    response.status(500).json(INTERNAL_ERROR_BODY);
  });
  return { app, lane, lines };
}

const ask = (harnessed: Harness, question: string, preferences?: unknown) =>
  request(harnessed.app)
    .post('/api/v1/chat')
    .set('Content-Type', 'application/json')
    .send(
      JSON.stringify({
        question,
        preferences: preferences ?? { diet: 'regular', allergies: [], dislikedIngredients: [] },
      }),
    );

const CHEAPEST_QUESTION = 'what is the cheapest?';
const ORDER_QUESTION = 'rank these by price';

/** A reply the domain could have produced, for the success path. */
const goodReply: ChatModelReply = {
  answered: true,
  answer: 'Red onion pickle is the cheapest at $2.50.',
  citedMealIds: [CHEAPEST.id],
};

describe('step 1 - the body is parsed before anything else', () => {
  it('rejects `goal` inside `preferences` with a 400 naming the field, and calls no model', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION, {
      diet: 'regular',
      allergies: [],
      dislikedIngredients: [],
      goal: 'high-protein',
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(Object.keys(response.body.error.details)).toEqual(['preferences']);
    // Neither the submitted key nor its value: `errors.ts` takes the PATH only, and on this
    // route a submitted value could be the allergy list itself (PRD 10.3).
    expect(JSON.stringify(response.body)).not.toContain('high-protein');
    expect(response.body.answer).toBeUndefined();
    expect(stub.calls()).toBe(0);
  });

  it('rejects `budget` inside `preferences`', async () => {
    const response = await ask(
      harness({ provider: replyingProvider(goodReply).provider }),
      CHEAPEST_QUESTION,
      { diet: 'regular', allergies: [], dislikedIngredients: [], budget: 'medium' },
    );
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.details)).toEqual(['preferences']);
  });

  it('rejects a question past 500 characters, naming `question`', async () => {
    const response = await ask(
      harness({ provider: replyingProvider(goodReply).provider }),
      'a'.repeat(501),
    );
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual({ question: ['too large'] });
  });
});

describe('step 2 - an empty eligible set answers locally, with no model call', () => {
  it('answers 200 `answered: false` from local copy and never asks the provider', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(
      harness({ catalog: PEANUT_ONLY, provider: stub.provider }),
      CHEAPEST_QUESTION,
      { diet: 'regular', allergies: ['peanut'], dislikedIngredients: [] },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      answered: false,
      answer: CHAT_COPY.noEligibleMeals,
      citations: [],
      source: 'local',
    });
    // The assertion T-21-02 exists for. A response that merely looked right would pass without
    // it, and the ~11 s and the fabrication surface would both be back.
    expect(stub.calls()).toBe(0);
  });
});

describe('step 3 - an unresolved question answers locally, with no model call', () => {
  it('answers a greeting from `CHAT_COPY.greeting` and never asks the provider', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ provider: stub.provider }), 'hello');

    expect(response.status).toBe(200);
    expect(response.body.answered).toBe(false);
    expect(response.body.answer).toBe(CHAT_COPY.greeting);
    expect(response.body.source).toBe('local');
    expect(response.body.citations).toEqual([]);
    expect(stub.calls()).toBe(0);
  });

  it('answers a Capability question with the SAME string as a greeting (R-22)', async () => {
    // PRD 7.4 lists Capability as its own shape; TSD 4.9 has no `capability` reason, so
    // `answer-lexicon.ts` classifies "what can you do" as a greeting term. The route cannot
    // distinguish them, and this test pins that it does not pretend to.
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ provider: stub.provider }), 'what can you do?');

    expect(response.body.answer).toBe(CHAT_COPY.greeting);
    expect(stub.calls()).toBe(0);
  });

  it('refuses a numeric-threshold count with the no-information copy (X-15)', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ provider: stub.provider }), 'how many are under $10?');

    expect(response.status).toBe(200);
    expect(response.body.answered).toBe(false);
    expect(response.body.answer).toBe(CHAT_COPY.noInformation);
    expect(stub.calls()).toBe(0);
  });

  it('gives the three local outcomes three different strings', () => {
    // The control BRIEF 6.2.2 asks for: no single constant satisfies all three, so a mutant
    // returning one copy string everywhere fails here as well as above.
    const copies = [CHAT_COPY.noEligibleMeals, CHAT_COPY.noInformation, CHAT_COPY.greeting];
    expect(new Set(copies).size).toBe(3);
    // And none of them is a health verdict or names a figure.
    for (const copy of copies) {
      expect(copy).not.toMatch(/\d/);
      expect(copy.toLowerCase()).not.toMatch(/\b(safe|healthy|unhealthy|medical|you should)\b/);
    }
  });
});

describe('step 4 - `AI_ENABLED` is checked AFTER retrieval and resolution', () => {
  const off = { AI_ENABLED: 'false' };

  it('still answers a greeting deterministically when the model is switched off', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ env: off, provider: stub.provider }), 'hello');

    expect(response.status).toBe(200);
    expect(response.body.answer).toBe(CHAT_COPY.greeting);
    expect(stub.calls()).toBe(0);
  });

  it('still answers an empty eligible set when the model is switched off', async () => {
    const response = await ask(
      harness({ catalog: PEANUT_ONLY, env: off, provider: replyingProvider(goodReply).provider }),
      CHEAPEST_QUESTION,
      { diet: 'regular', allergies: ['peanut'], dislikedIngredients: [] },
    );
    expect(response.status).toBe(200);
    expect(response.body.answer).toBe(CHAT_COPY.noEligibleMeals);
  });

  it('answers 503 `ai_disabled` with no answer text when a question NEEDS phrasing', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ env: off, provider: stub.provider }), CHEAPEST_QUESTION);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_disabled');
    expect(response.body.error.retryable).toBe(false);
    expect(response.body.answer).toBeUndefined();
    expect(stub.calls()).toBe(0);
  });
});

describe('step 5 - phrasing, and citations resolved by id', () => {
  it('answers 200 with `source: "gemma"` and the cited meal', async () => {
    const stub = replyingProvider(goodReply);
    const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      answered: true,
      answer: goodReply.answer,
      citations: [{ mealId: CHEAPEST.id, name: CHEAPEST.name }],
      source: 'gemma',
    });
    expect(stub.calls()).toBe(1);
  });

  it('ignores a meal NAMED in the answer text but not cited by id (T-21-03)', async () => {
    // `rank these by price` resolves as `ordering` over `scope.context`, so all three meals are
    // in `namedMeals` and check 4 permits all three names. The reply names two of them in prose
    // and cites exactly one. A citation list parsed out of the text would carry two entries -
    // which is how a hallucinated meal acquires a link to tap on.
    const stub = replyingProvider({
      answered: true,
      answer: `${CHEAPEST.name} comes first, then ${MIDDLE.name}.`,
      citedMealIds: [CHEAPEST.id],
    });
    const response = await ask(harness({ provider: stub.provider }), ORDER_QUESTION);

    expect(response.status).toBe(200);
    expect(response.body.citations).toEqual([{ mealId: CHEAPEST.id, name: CHEAPEST.name }]);
    expect(response.body.answer).toContain(MIDDLE.name);
  });

  it('does not let the model decide that the question was answered', async () => {
    // The domain resolved an answer, so `answered` is settled before the model sees it. A reply
    // claiming otherwise is phrasing, not authority (BRIEF 7.1).
    const stub = replyingProvider({ ...goodReply, answered: false });
    const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION);

    expect(response.status).toBe(200);
    expect(response.body.answered).toBe(true);
  });

  it('de-duplicates a repeated citation and keeps the domain order', async () => {
    const stub = replyingProvider({
      answered: true,
      answer: `${CHEAPEST.name} then ${MIDDLE.name}.`,
      citedMealIds: [MIDDLE.id, CHEAPEST.id, MIDDLE.id],
    });
    const response = await ask(harness({ provider: stub.provider }), ORDER_QUESTION);

    expect(response.body.citations).toEqual([
      { mealId: CHEAPEST.id, name: CHEAPEST.name },
      { mealId: MIDDLE.id, name: MIDDLE.name },
    ]);
  });

  it('passes containment by construction under `AI_FAKE`, with no fetch', async () => {
    // TSD 5.5's echo, produced by the REAL provider. If this ever fails containment, containment
    // has a false positive - that is a defect, not a fixture to adjust.
    const fetchImpl: FetchLike = () => {
      throw new Error('the AI_FAKE branch must not reach the network');
    };
    const response = await ask(
      harness({
        env: { AI_FAKE: 'true' },
        provider: createAiProvider(loadConfig({ AI_FAKE: 'true' }), fetchImpl),
      }),
      CHEAPEST_QUESTION,
    );

    expect(response.status).toBe(200);
    expect(response.body.answered).toBe(true);
    expect(response.body.source).toBe('gemma');
    expect(response.body.citations).toEqual([{ mealId: CHEAPEST.id, name: CHEAPEST.name }]);
    // The echo IS the resolved statement, so the answer must name the winner and its figure.
    expect(response.body.answer).toContain(CHEAPEST.name);
  });
});

describe('containment - a failing reply is discarded, never partly used', () => {
  const cases: readonly (readonly [string, ChatModelReply])[] = [
    [
      'an id the prompt never carried',
      { answered: true, answer: `${CHEAPEST.name} is the cheapest.`, citedMealIds: ['meal-nope'] },
    ],
    [
      'a denied claim',
      { answered: true, answer: `${CHEAPEST.name} is a healthy choice.`, citedMealIds: [] },
    ],
    [
      'a figure the domain did not resolve',
      { answered: true, answer: `${CHEAPEST.name} costs $9.99.`, citedMealIds: [CHEAPEST.id] },
    ],
    [
      'a meal the answer is not about',
      { answered: true, answer: `Try ${DEAREST.name} instead.`, citedMealIds: [] },
    ],
  ];

  for (const [label, reply] of cases) {
    it(`answers 503 ai_unavailable with no answer text for ${label}`, async () => {
      const stub = replyingProvider(reply);
      const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION);

      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('ai_unavailable');
      expect(response.body.error.retryable).toBe(true);
      // Plan 15.3: no failure path returns generated prose. Not the answer, not a fragment of
      // it, and not the rule that fired (TSD 5.7) or its evidence (TSD 5.8 has no field).
      expect(response.body.answer).toBeUndefined();
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(reply.answer);
      expect(serialised).not.toContain('rule');
      expect(serialised).not.toContain('evidence');
      expect(stub.calls()).toBe(1);
    });
  }
});

describe('error mapping - a failed call is a 503 with fixed copy', () => {
  it('answers 503 `ai_busy` while the lane is occupied, without calling the provider', async () => {
    const lane = createAiLane();
    const stub = replyingProvider(goodReply);
    // The lane is claimed synchronously by `run`, so this is deterministic rather than a race:
    // by the time the request is issued the single flight is already taken.
    let release = (): void => undefined;
    const held = lane.run(() => new Promise<void>((resolve) => (release = resolve)), 5_000);

    const response = await ask(harness({ lane, provider: stub.provider }), CHEAPEST_QUESTION);
    release();
    await held;

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_busy');
    expect(response.body.error.retryable).toBe(true);
    expect(response.body.answer).toBeUndefined();
    expect(stub.calls()).toBe(0);
  });

  it('answers 503 `ai_unavailable` when the model is unreachable', async () => {
    const stub = failingProvider(new OllamaError('unreachable'));
    const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_unavailable');
    expect(response.body.answer).toBeUndefined();
    // The client is told nothing about the cause: `errors.ts`'s fixed local message only.
    expect(response.body.error.message).toBe('The assistant is unavailable right now.');
  });

  it('answers 503 `ai_unavailable` on the CHAT budget when the call never returns', async () => {
    const stub = silentProvider();
    const response = await ask(
      harness({ env: { OLLAMA_CHAT_TIMEOUT_MS: '1000' }, provider: stub.provider }),
      CHEAPEST_QUESTION,
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('ai_unavailable');
    expect(stub.calls()).toBe(1);
  });

  it('writes no AI log line when the lane was busy, because no call happened', async () => {
    const lane = createAiLane();
    let release = (): void => undefined;
    const held = lane.run(() => new Promise<void>((resolve) => (release = resolve)), 5_000);
    const harnessed = harness({ lane, provider: replyingProvider(goodReply).provider });

    const response = await ask(harnessed, CHEAPEST_QUESTION);
    release();
    await held;

    expect(response.body.error.code).toBe('ai_busy');
    // `aiLane.run` rejects before `fn` is invoked, so a `durationMs` here would time a call that
    // never ran. The rejection is a property of the request, and `app.ts` logs it as one.
    expect(harnessed.lines).toStrictEqual([]);
  });

  it('lets an unexpected throw become a 500, not a retryable `ai_unavailable`', async () => {
    // TSD 3.5 lists the causes of `ai_unavailable` exhaustively and a bug in the route is not
    // among them. Reporting one as a missing model would make the defect invisible - retryable,
    // even, so the client would ask again.
    const stub = failingProvider(new TypeError('a defect, not an outage'));
    const response = await ask(harness({ provider: stub.provider }), CHEAPEST_QUESTION);

    expect(response.status).toBe(500);
    expect(response.body).toEqual(INTERNAL_ERROR_BODY);
    expect(JSON.stringify(response.body)).not.toContain('a defect, not an outage');
  });
});

/**
 * **The WIRE code per cause - the half two rounds of log-outcome work left unpinned.**
 *
 * `OllamaAbortError`'s log `outcome` is asserted twice (`outcome.test.ts` and the explanation
 * lane's suite) and its **wire code was asserted nowhere**: dropping it from `chatFailure` failed
 * 0 of 824 tests, turning a cancelled call into `500 internal_error`.
 *
 * That is the difference PRD 12 exists for, and it is not cosmetic. `503 ai_unavailable` is
 * **retryable** and reads "The assistant is unavailable right now."; `500 internal_error` is
 * **non-retryable** and reads "Something went wrong." - so the user is told the app is broken and
 * the client's retry affordance disappears, for a call that merely stopped.
 *
 * **The code is asserted, not the status**, because the two 503s and the 500 are three different
 * user-facing states and a status alone cannot tell `ai_busy` from `ai_unavailable`. And the
 * unrecognised-throw row sits in the **same table** on purpose: without it every assertion here
 * is satisfied by a `chatFailure` that maps everything to `ai_unavailable`, which is a worse
 * implementation than the one under test (TSD 5.3 step 6 - a non-`ApiError` is a 500).
 */
describe('the wire code a failed AI call produces', () => {
  const wireCases: readonly (readonly [string, unknown, number, string, boolean, string])[] = [
    [
      'an unreachable model',
      new OllamaError('unreachable'),
      503,
      'ai_unavailable',
      true,
      'The assistant is unavailable right now.',
    ],
    [
      'a truncated reply',
      new OllamaError('truncated'),
      503,
      'ai_unavailable',
      true,
      'The assistant is unavailable right now.',
    ],
    [
      // AMENDMENT 1: cancellation is what the CALLER did, and it is none of the six reasons.
      'a cancelled call',
      new OllamaAbortError(),
      503,
      'ai_unavailable',
      true,
      'The assistant is unavailable right now.',
    ],
    [
      // The control. A defect is not an outage, so it must NOT become a retryable 503.
      'an unrecognised throw',
      new TypeError('a defect, not an outage'),
      500,
      'internal_error',
      false,
      'Something went wrong.',
    ],
  ];

  for (const [label, error, status, code, retryable, message] of wireCases) {
    it(`answers ${String(status)} \`${code}\` for ${label}`, async () => {
      const harnessed = harness({ provider: failingProvider(error).provider });
      const response = await ask(harnessed, CHEAPEST_QUESTION);

      // **The code first, deliberately.** A status alone cannot tell `ai_busy` from
      // `ai_unavailable`, and asserting it first made the failure message read "expected 500 to
      // be 503" - which names the symptom rather than the state the user is put in.
      expect(response.body.error.code).toBe(code);
      expect(response.status).toBe(status);
      expect(response.body.error.retryable).toBe(retryable);
      // Fixed local copy either way (PRD 12, TSD 3.5) - and no answer text on any of them.
      expect(response.body.error.message).toBe(message);
      expect(response.body.answer).toBeUndefined();
    });
  }

  it('does not give every cause the same code, so the control is not vacuous', () => {
    const codes = new Set(wireCases.map(([, , , code]) => code));
    expect([...codes].sort()).toStrictEqual(['ai_unavailable', 'internal_error']);
  });
});

/**
 * TSD 5.8's AI log line - and **this route is its first caller ever**. `aiLogLine` has been in
 * `logging.ts` since P08, asserted as a pure function by `logging.test.ts` and called by nothing,
 * so until now the server never wrote the line the document requires. These tests are what
 * connects the two.
 *
 * Every assertion is a `toStrictEqual` on the **parsed** object, not three field checks: a fourth
 * key is the leak that matters, and only whole-object equality sees one.
 */
describe('the AI log line', () => {
  it('writes exactly one `ok` line on the success path', async () => {
    const harnessed = harness({ provider: replyingProvider(goodReply).provider });
    const response = await ask(harnessed, CHEAPEST_QUESTION);

    expect(response.status).toBe(200);
    expect(harnessed.lines).toHaveLength(1);
    expect(JSON.parse(harnessed.lines[0] ?? '')).toStrictEqual(expectedAiLine('ok'));
  });

  it('writes `contained` - and neither the rule nor the evidence - on a containment failure', async () => {
    const harnessed = harness({
      provider: replyingProvider({
        answered: true,
        answer: `${CHEAPEST.name} is a healthy choice.`,
        citedMealIds: [],
      }).provider,
    });
    const response = await ask(harnessed, CHEAPEST_QUESTION);

    expect(response.status).toBe(503);
    expect(harnessed.lines).toHaveLength(1);
    expect(JSON.parse(harnessed.lines[0] ?? '')).toStrictEqual(expectedAiLine('contained'));
    // X-40: TSD 5.8 has no field for either, and `evidence` here would be the denied phrase -
    // model-authored text derived from the user's question.
    expect(harnessed.lines[0]).not.toContain('denied-claim');
    expect(harnessed.lines[0]).not.toContain('healthy');
  });

  it('writes `timeout` when the chat budget ends the call', async () => {
    const harnessed = harness({
      env: { OLLAMA_CHAT_TIMEOUT_MS: '1000' },
      provider: silentProvider().provider,
    });
    const response = await ask(harnessed, CHEAPEST_QUESTION);

    expect(response.body.error.code).toBe('ai_unavailable');
    expect(JSON.parse(harnessed.lines[0] ?? '')).toStrictEqual(expectedAiLine('timeout'));
  });

  /**
   * The six-into-five mapping, one case per `OllamaFailureReason`.
   *
   * `http-status` collapses into `unreachable` and `envelope` / `empty-reply` / `truncated` into
   * `schema`, because TSD 5.8's set is closed at five and TSD 5.5's is six. The table is the
   * record of that decision: a reason silently remapped later fails here.
   */
  const reasonOutcomes: readonly (readonly [OllamaFailureReason, string])[] = [
    ['unreachable', 'unreachable'],
    ['http-status', 'unreachable'],
    ['envelope', 'schema'],
    ['empty-reply', 'schema'],
    ['truncated', 'schema'],
    ['schema', 'schema'],
  ];

  for (const [reason, outcome] of reasonOutcomes) {
    it(`maps the \`${reason}\` failure to outcome \`${outcome}\``, async () => {
      const harnessed = harness({ provider: failingProvider(new OllamaError(reason)).provider });
      const response = await ask(harnessed, CHEAPEST_QUESTION);

      expect(response.body.error.code).toBe('ai_unavailable');
      expect(harnessed.lines).toHaveLength(1);
      expect(JSON.parse(harnessed.lines[0] ?? '')).toStrictEqual(expectedAiLine(outcome));
    });
  }

  it('distinguishes `unreachable` from `schema`, so the collapse is not to one value', () => {
    // The control BRIEF 6.2.2 asks for: a mutant returning one outcome for every reason passes
    // three of the six cases above, and fails this.
    const outcomes = new Set(reasonOutcomes.map(([, outcome]) => outcome));
    expect([...outcomes].sort()).toStrictEqual(['schema', 'unreachable']);
  });

  it('writes no line on any path where the model was never called', async () => {
    const parse = harness({ provider: replyingProvider(goodReply).provider });
    await ask(parse, CHEAPEST_QUESTION, { diet: 'regular', allergies: [], goal: 'balanced' });
    expect(parse.lines).toStrictEqual([]);

    const empty = harness({ catalog: PEANUT_ONLY, provider: replyingProvider(goodReply).provider });
    await ask(empty, CHEAPEST_QUESTION, {
      diet: 'regular',
      allergies: ['peanut'],
      dislikedIngredients: [],
    });
    expect(empty.lines).toStrictEqual([]);

    const unresolved = harness({ provider: replyingProvider(goodReply).provider });
    await ask(unresolved, 'hello');
    expect(unresolved.lines).toStrictEqual([]);

    const disabled = harness({
      env: { AI_ENABLED: 'false' },
      provider: replyingProvider(goodReply).provider,
    });
    await ask(disabled, CHEAPEST_QUESTION);
    expect(disabled.lines).toStrictEqual([]);
  });

  it('writes no line for an unrecognised throw, which is a defect and not an outcome', async () => {
    const harnessed = harness({ provider: failingProvider(new TypeError('boom')).provider });
    const response = await ask(harnessed, CHEAPEST_QUESTION);

    expect(response.status).toBe(500);
    // Choosing one of five outcomes for a route defect would be a fabricated classification.
    // `app.ts`'s error handler records the name and frames, which is the honest record.
    expect(harnessed.lines).toStrictEqual([]);
  });

  /**
   * The planted-token test, the same technique `ollamaClient.ts` used to verify the abort-reason
   * discard: put a distinctive string in the question and another in the model's answer, then
   * assert neither appears in anything the sink received. Stronger than reading the code,
   * because it would catch a leak through a path nobody thought to look at.
   */
  it('lets neither the question nor the answer reach the sink', async () => {
    const questionToken = 'zzqqxxjjkkwq';
    const answerToken = 'wwvvuuttssna';
    const harnessed = harness({
      provider: replyingProvider({
        answered: true,
        answer: `${CHEAPEST.name} is the cheapest at $2.50. ${answerToken}`,
        citedMealIds: [CHEAPEST.id],
      }).provider,
    });

    const response = await ask(harnessed, `${CHEAPEST_QUESTION} ${questionToken}`);

    // The tokens really are in play: the request carried one and the response carries the other.
    expect(response.status).toBe(200);
    expect(response.body.answer).toContain(answerToken);
    expect(harnessed.lines).toHaveLength(1);
    const everything = harnessed.lines.join('\n');
    expect(everything).not.toContain(questionToken);
    expect(everything).not.toContain(answerToken);
    expect(everything).not.toContain(CHEAPEST.name);
    expect(everything).not.toContain('peanut');
  });
});
