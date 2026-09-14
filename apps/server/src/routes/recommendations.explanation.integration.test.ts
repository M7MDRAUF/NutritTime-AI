import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import { explanationReplySchema } from '@nutritime/contracts';
import { explainRecommendation } from '../ai/explanation.js';
import { OllamaAbortError } from '../ai/ollamaClient.js';
import type { FetchLike } from '../ai/ollamaClient.js';
import { createAiProvider } from '../ai/provider.js';
import type { AiProvider, Generation } from '../ai/provider.js';
import { createAiLane } from '../aiLane.js';
import type { AiLane } from '../aiLane.js';
import { JSON_BODY_LIMIT, createErrorHandler } from '../app.js';
import { buildCatalog } from '../catalog.js';
import type { Catalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import type { ServerConfig } from '../config.js';
import type { LogSink } from '../logging.js';
import { recommendationsRouter } from './recommendations.js';

/**
 * `explanation.ts` is spied on, **not replaced**: `{ spy: true }` keeps every real
 * implementation and only counts the calls.
 *
 * It exists for one assertion the response body cannot make. The route's gate and
 * `explanation.ts`'s own `AI_ENABLED` check produce an identical response, so with the route's
 * half deleted the suite stayed green (E2 probe 2). The observable difference is that the route
 * **never calls `explainRecommendation` at all**, which is what this counts. A replacing mock
 * would prove the opposite of what BRIEF §6 asks for: the real prompt build, the real id check and
 * the real containment all still run here.
 */
vi.mock('../ai/explanation.js', { spy: true });

/**
 * P20's explanation lane on `POST /api/v1/recommendations` - everything that needs a model.
 *
 * **Split out of `recommendations.integration.test.ts`**, which reached 1136 lines against a
 * §17.1 exception granted at 459. The seam is the model: every suite here supplies a provider, a
 * lane, a clock or a sink, and none of it belongs beside PRD §13's safety evidence - which stays
 * in the original file, with its synthetic catalog and its control, and with no mock anywhere near
 * it. The two files together hold the same 52 tests the one file did.
 *
 * What the route owes, and what each suite pins: explanations are attempted only when the
 * request's `aiEnabled` **and** `AI_ENABLED` are true (TSD §5.4); `'gemma'` only after a reply
 * passes containment (T-20-03, T-20-04); one shared budget for the step (PRD §10.1, AMENDMENT 9);
 * no failure in this lane may change the status, the meals, their order, the scores or the
 * `scoreReasons` (PRD FR-009, Plan C-04); **no 503 on this endpoint**; and one AI log line per
 * call carrying `lane`, `durationMs`, `outcome` and nothing else (TSD §5.8, AMENDMENT 7).
 *
 * The harness is `mount`, duplicated from the original file rather than shared: importing a helper
 * from a `*.test.ts` sibling would register that file's tests here too, and a third non-test
 * module for eighty lines of scaffolding is not on this agent's allowlist. The duplication is
 * reported.
 */

const catalog = buildCatalog(seededCatalog);

interface Mounted {
  readonly catalog: Catalog;
  readonly config: ServerConfig;
  readonly provider: AiProvider;
  /** Defaults to a real lane. Overridden only to drive the route's failure paths. */
  readonly lane?: AiLane;
  /** Defaults to discarding. Overridden by the AI-log-line suite (AMENDMENT 7). */
  readonly sink?: LogSink;
  /** Defaults to the real clock. A **stepping** one where a line's duration is asserted. */
  readonly now?: () => Date;
}

function mount(options: Mounted): Express {
  const sink = options.sink ?? ((): void => undefined);
  const now = options.now ?? ((): Date => new Date());
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(
    '/api/v1/recommendations',
    recommendationsRouter({
      catalog: options.catalog,
      config: options.config,
      lane: options.lane ?? createAiLane(),
      provider: options.provider,
      sink,
      now,
    }),
  );
  app.use(createErrorHandler({ sink, now }));
  return app;
}

/**
 * The provider for every test that is not about the model.
 *
 * It **rejects rather than resolving**, so no test in this file can reach a network or a real
 * Ollama by accident: the suite's verdicts must not depend on whether the developer running it
 * happens to have a model loaded. The gate means it is never called at all for an
 * `aiEnabled: false` request, which is what keeps the pre-P20 suites byte-identical in
 * behaviour - and if the gate ever opened by mistake, this rejects and the explanation degrades
 * to the template rather than silently contacting localhost.
 */
const offlineProvider: AiProvider = () =>
  Promise.reject(new Error('no model is configured for this test'));

const app = mount({ catalog, config: loadConfig({}), provider: offlineProvider });

interface Body {
  readonly mealPeriod: string;
  readonly aiEnabled: boolean;
  readonly preferences: {
    readonly diet: string;
    readonly allergies: readonly string[];
    readonly goal: string;
    readonly budget: string;
    readonly dislikedIngredients: readonly string[];
  };
  readonly favoriteMealIds: readonly string[];
}

const body = (overrides: Partial<Body> = {}): Body => ({
  mealPeriod: 'dinner',
  aiEnabled: false,
  preferences: {
    diet: 'regular',
    allergies: [],
    goal: 'balanced',
    budget: 'high',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
  ...overrides,
});

describe('this endpoint has no 503', () => {
  it('still answers 200 with Ollama unreachable', async () => {
    // Plan C-04: an explanation that cannot reach the model degrades to `fallback` and the
    // request still succeeds. A recommendation is useful without prose.
    //
    // **The one test in this file that uses the platform's own `fetch`.** Port 1 refuses a
    // connection on every supported platform, so this exercises the real transport failure
    // rather than a simulated one - which is why it is kept alongside T-20-06's `fetchImpl`
    // version below, where the elapsed budget has to be measured and therefore has to be
    // deterministic.
    const isolatedConfig = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' });
    const isolated = mount({
      catalog,
      config: isolatedConfig,
      provider: createAiProvider(isolatedConfig),
    });
    const response = await request(isolated)
      .post('/api/v1/recommendations')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body({ aiEnabled: true })));
    expect(response.status).toBe(200);
    for (const entry of response.body.recommendations) {
      expect(entry.explanationSource).toBe('fallback');
    }
  });
});
// ---------------------------------------------------------------- P20: the explanation lane

/**
 * A reply the containment checks accept, written to TSD 5.7's checklist and not sampled from
 * anything this codebase produces (BRIEF 6.3).
 *
 * It carries no digit and no spelled cardinal (check 3 permits only figures the domain
 * resolved, and an empty permitted set forbids every figure), and none of PRD FR-015's claim
 * words (check 2) - spelled out: no `safe`, `healthy`, `treats`, `cures`, `medical`, `doctor`,
 * or `you should`, and no word here contains one of those as a substring either.
 */
const MODEL_REASON = 'A warm bowl that matches what you asked for tonight.';

/** Check 2's shape: a health verdict, which is exactly what a model must not be trusted with. */
const DENIED_REASON = 'A healthy pick for your evening.';

/**
 * Check 3's shape: **a wrong number in clean prose**, which SDD 9.6 records as the failure a
 * word list would have missed on all four wrong answers the evaluation found. `987` is not a
 * figure the domain resolved for any meal in the catalog.
 */
const UNGROUNDED_REASON = 'It carries 987 grams of protein per serving.';

interface ProviderSpy {
  readonly provider: AiProvider;
  /** One entry per call, in order: the meal id that call's generation was about. */
  readonly calls: string[];
}

/**
 * A provider that answers with fixed prose and records what it was asked.
 *
 * **Nothing here is cast.** `Generation<T>`'s `echo` is opaque at this call site, so the meal id
 * is read back through `explanationReplySchema` from `@nutritime/contracts` and the answer is
 * built through the generation's own `decode` - which means a fixture the real path would reject
 * as `'schema'` cannot pass here either, the same argument CONTRACTS AMENDMENT 3 makes for the
 * `AI_FAKE` branch. An `as` would assert a shape this test cannot see (BRIEF 4).
 */
function spyProvider(reason: string): ProviderSpy {
  const calls: string[] = [];
  const provider: AiProvider = <T>(generation: Generation<T>): Promise<T> => {
    const echo = explanationReplySchema.safeParse(generation.echo);
    if (!echo.success) {
      // Recorded rather than ignored, so the gate assertions below fail with a readable diff
      // instead of a silent `fallback` if the echo's shape ever changes.
      calls.push('(the echo was not an ExplanationReply)');
      return Promise.reject(new Error('the spy could not read the generation echo'));
    }
    calls.push(echo.data.mealId);
    const decoded = generation.decode.safeParse({ mealId: echo.data.mealId, reason });
    if (!decoded.success) {
      return Promise.reject(new Error('the spy built a reply the lane schema rejects'));
    }
    return Promise.resolve(decoded.data);
  };
  return { provider, calls };
}

const aiConfig = (enabled: boolean): ServerConfig =>
  loadConfig({ AI_ENABLED: enabled ? 'true' : 'false' });

const ask = (target: Express, aiEnabled: boolean) =>
  request(target)
    .post('/api/v1/recommendations')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(body({ aiEnabled })));

interface Entry {
  readonly meal: { readonly id: string };
  readonly explanation: string;
  readonly explanationSource: string;
}

const entriesOf = (response: { body: { recommendations: Entry[] } }): Entry[] =>
  response.body.recommendations;

/** Every field EXCEPT the two the explanation lane owns. */
const withoutProse = (response: {
  body: { recommendations: Record<string, unknown>[] };
}): Record<string, unknown>[] =>
  response.body.recommendations.map((entry) => {
    const copy = { ...entry };
    delete copy['explanation'];
    delete copy['explanationSource'];
    return copy;
  });

/** The template text the same request produces with the gate shut - the control for every pair. */
const templateExplanations = async (): Promise<string[]> => {
  const response = await ask(app, false);
  return entriesOf(response).map((entry) => entry.explanation);
};

/** How many times the route entered the explanation lane's entry point. */
const explainCalls = (): number => vi.mocked(explainRecommendation).mock.calls.length;

describe('the two-condition explanation gate (TSD 5.4)', () => {
  beforeEach(() => {
    vi.mocked(explainRecommendation).mockClear();
  });

  /**
   * TSD 5.4: "Explanations are attempted only when `aiEnabled` is true **and** `AI_ENABLED` is
   * true." All four combinations, because three of them are the interesting ones and a happy-path
   * test leaves the gate unproven - **`AI_ENABLED` alone would satisfy a happy-path test while
   * ignoring the switch the user themselves set in Settings.**
   *
   * The provider spy is what makes this stronger than the constant test it replaces: `fallback`
   * can be produced by calling the model and discarding the answer, and a user who turned AI off
   * expecting no model call would never know the difference from the response body.
   */
  it.each([
    { requested: true, configured: true, expected: 'gemma', attempted: true },
    { requested: true, configured: false, expected: 'fallback', attempted: false },
    { requested: false, configured: true, expected: 'fallback', attempted: false },
    { requested: false, configured: false, expected: 'fallback', attempted: false },
  ])(
    'aiEnabled=$requested and AI_ENABLED=$configured gives $expected, provider called: $attempted',
    async ({ requested, configured, expected, attempted }) => {
      const spy = spyProvider(MODEL_REASON);
      const response = await ask(
        mount({ catalog, config: aiConfig(configured), provider: spy.provider }),
        requested,
      );
      expect(response.status).toBe(200);
      const entries = entriesOf(response);
      // More than one, or "a call per recommendation" below would be a claim about one call.
      expect(entries.length).toBeGreaterThan(1);
      for (const entry of entries) {
        expect(entry.explanationSource).toBe(expected);
      }
      /**
       * **One call per recommendation, in response order, and none at all when the gate is
       * shut.** Two mutations die here rather than only one: a gate reading a single switch
       * turns one of the three closed rows red, and explaining with `Promise.all` instead of a
       * loop turns the open row red twice over - the lane is single-flight with no queue, so
       * the other two meals would reject with `AiBusyError` and degrade to the template while
       * the spy recorded a single call.
       */
      expect(spy.calls).toStrictEqual(attempted ? entries.map((entry) => entry.meal.id) : []);
      /**
       * **The route's own half of the gate, pinned independently of `explanation.ts`'s.**
       *
       * `explainRecommendation` returns the same fallback for a disabled `AI_ENABLED` as this
       * route does, so the response body cannot tell the two layers apart - probe 2 deleted the
       * route's check and nothing reddened. This can: with the route's check gone, the route
       * calls the entry point three times where it should call it none. Both layers stay (TSD
       * 5.5's "layer 0 does not replace layer 1"), and now neither rescues the other.
       */
      expect(explainCalls()).toBe(attempted ? entries.length : 0);
    },
  );
});

describe('explanationSource is earned rather than asserted (T-20-03, T-20-04)', () => {
  it('surfaces the model sentence as gemma when the reply passes containment', async () => {
    const spy = spyProvider(MODEL_REASON);
    const response = await ask(
      mount({ catalog, config: aiConfig(true), provider: spy.provider }),
      true,
    );
    const entries = entriesOf(response);
    for (const entry of entries) {
      expect(entry.explanationSource).toBe('gemma');
      expect(entry.explanation).toBe(MODEL_REASON);
    }
    // The control that makes the pair unsatisfiable by one constant: the same request with the
    // gate shut returns the template, so `gemma` above is a real difference in the response and
    // not a relabelling of text the route was going to send anyway.
    expect(await templateExplanations()).not.toContain(MODEL_REASON);
  });

  it.each([
    ['a denied health claim', DENIED_REASON],
    ['a figure the domain never resolved', UNGROUNDED_REASON],
  ])('falls back to the template text on %s', async (_label, reason) => {
    const spy = spyProvider(reason);
    const response = await ask(
      mount({ catalog, config: aiConfig(true), provider: spy.provider }),
      true,
    );
    expect(response.status).toBe(200);
    const entries = entriesOf(response);
    // The model WAS consulted, so `fallback` here is containment's verdict and not the gate's.
    expect(spy.calls).toHaveLength(entries.length);
    expect(entries.map((entry) => entry.explanationSource)).toStrictEqual(
      entries.map(() => 'fallback'),
    );
    expect(entries.map((entry) => entry.explanation)).toStrictEqual(await templateExplanations());
  });

  it('is deterministic with AI on and a deterministic model', async () => {
    const spy = spyProvider(MODEL_REASON);
    const target = mount({ catalog, config: aiConfig(true), provider: spy.provider });
    const first = await ask(target, true);
    const second = await ask(target, true);
    expect(second.body).toStrictEqual(first.body);
    // Not vacuous: a route that fell back on both runs would also be identical twice.
    expect(entriesOf(first).map((entry) => entry.explanationSource)).toStrictEqual(
      entriesOf(first).map(() => 'gemma'),
    );
  });

  it('changes nothing but the prose, however the model answers', async () => {
    // PRD FR-009 and Plan C-04: the explanation lane may set `explanation` and
    // `explanationSource` and NOTHING else. Asserted against the no-AI response field by field,
    // because "the meals are the same" is the claim a reordering or a rescoring would break
    // silently - the client would show three plausible cards in the wrong order.
    const baseline = await ask(app, false);
    for (const reason of [MODEL_REASON, DENIED_REASON, UNGROUNDED_REASON]) {
      const response = await ask(
        mount({ catalog, config: aiConfig(true), provider: spyProvider(reason).provider }),
        true,
      );
      expect(response.status).toBe(baseline.status);
      expect(response.body.mealPeriod).toBe(baseline.body.mealPeriod);
      expect(withoutProse(response)).toStrictEqual(withoutProse(baseline));
    }
  });
});

/**
 * TSD 6.5's per-route client deadline for `POST /api/v1/recommendations`. **The only budget any
 * document states for this whole endpoint** - TSD 5.2's 12 s is per explanation CALL, and Plan
 * C-04 states none - and 6.5 introduces it as the figure "set above the server's own budget so
 * the client never gives up before the server would", so the server finishing inside it is what
 * PRD 13's "inside the budget" can mean here.
 *
 * It is not a soft bound. Three recommendations are explained one at a time against a 12 s
 * per-call budget, so a route that waited out the budget on a stopped model would take 36 s and
 * fail this by a factor of two.
 */
const RECOMMENDATIONS_CLIENT_DEADLINE_MS = 15000;

describe('T-20-06 - with Ollama stopped (PRD 13, Plan C-04)', () => {
  /**
   * **"Ollama stopped" is simulated at the transport boundary and that is stated rather than
   * implied.** A test cannot stop a service on the developer's machine, and one that tried
   * would pass or fail on what happened to be running. This rejects the way an unreachable
   * socket does - `fetch` rejecting with a `TypeError`, not answering with a status - and
   * everything above it is real: the real `createAiProvider`, the real Ollama client, its real
   * `'unreachable'` classification, the real lane and the real route. Plan 19.6 registers a run
   * against a genuinely stopped Ollama as a separate manual check.
   */
  const stoppedOllama = (): { readonly fetchImpl: FetchLike; readonly count: () => number } => {
    let calls = 0;
    return {
      fetchImpl: () => {
        calls += 1;
        return Promise.reject(new TypeError('fetch failed'));
      },
      count: () => calls,
    };
  };

  it('answers 200, marks every explanation fallback, and finishes inside the budget', async () => {
    const stopped = stoppedOllama();
    const config = loadConfig({});
    const target = mount({
      catalog,
      config,
      provider: createAiProvider(config, stopped.fetchImpl),
    });

    const startedAt = Date.now();
    const response = await ask(target, true);
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    const entries = entriesOf(response);
    // The real client was reached once per recommendation: the fallbacks below are a failed
    // model call and not a gate that quietly skipped it.
    expect(stopped.count()).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.explanationSource).toBe('fallback');
      expect(entry.explanation.length).toBeGreaterThan(0);
    }
    expect(entries.map((entry) => entry.explanation)).toStrictEqual(await templateExplanations());
    expect(elapsed).toBeLessThan(RECOMMENDATIONS_CLIENT_DEADLINE_MS);
  });

  it('answers 200 rather than 500 when the explanation lane fails outright', async () => {
    // A 500 here would mean a broken model takes the whole feature down, which is the exact
    // inversion of PRD FR-009. The lane is replaced with one that rejects every call, which is
    // the most hostile thing the route's deps can do to it short of the template builder itself
    // throwing - and that one is covered by a mutation probe, since no conforming dependency
    // can produce it.
    const brokenLane: AiLane = { run: () => Promise.reject(new Error('the lane itself failed')) };
    const spy = spyProvider(MODEL_REASON);
    const response = await ask(
      mount({ catalog, config: aiConfig(true), lane: brokenLane, provider: spy.provider }),
      true,
    );
    expect(response.status).toBe(200);
    const entries = entriesOf(response);
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.explanationSource).toBe('fallback');
    }
    // The lane never ran the call, so the provider cannot have been reached.
    expect(spy.calls).toStrictEqual([]);
    expect(entries.map((entry) => entry.explanation)).toStrictEqual(await templateExplanations());
  });
});

describe('under AI_FAKE (T-20-05)', () => {
  it('runs the route, the lane and containment without touching the network', async () => {
    /**
     * `explanationSource` is deliberately NOT pinned here.
     *
     * The fake returns the echo, which is the template sentence the route computed - so whether
     * it earns `gemma` depends on whether the domain's own `detail` strings quote a figure
     * containment permits, which is `explanation.ts`'s and `containment.ts`'s business rather
     * than this route's. What this route owns is that the whole path executed and no HTTP call
     * happened, and both are asserted exactly.
     */
    let fetches = 0;
    const fetchImpl: FetchLike = () => {
      fetches += 1;
      return Promise.reject(new TypeError('fetch failed'));
    };
    const config = loadConfig({ AI_FAKE: 'true' });
    const response = await ask(
      mount({ catalog, config, provider: createAiProvider(config, fetchImpl) }),
      true,
    );
    expect(response.status).toBe(200);
    expect(fetches).toBe(0);
    const entries = entriesOf(response);
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries) {
      expect(entry.explanation.length).toBeGreaterThan(0);
      expect(['gemma', 'fallback']).toContain(entry.explanationSource);
    }
  });
});

// --------------------------------------- P20 follow-up: shared budget and the AI log line

/**
 * A provider that takes a known slice of the budget and honours its signal.
 *
 * It rejects with `OllamaAbortError` on abort because that is what both real branches do - the
 * platform `fetch` rejects an aborted request and `ollamaClient` maps it there (AMENDMENT 1) - so
 * a test of the budget is not a test of a fake that is gentler than the code it stands in for.
 * The lane rejects with `AiTimeoutError` before it aborts, so that rejection loses the race; this
 * one exists to release the timer.
 */
function slowProvider(delayMs: number, reason: string): ProviderSpy {
  const calls: string[] = [];
  const provider: AiProvider = <T>(generation: Generation<T>, signal: AbortSignal): Promise<T> => {
    const echo = explanationReplySchema.safeParse(generation.echo);
    if (!echo.success) {
      return Promise.reject(new Error('the spy could not read the generation echo'));
    }
    calls.push(echo.data.mealId);
    const decoded = generation.decode.safeParse({ mealId: echo.data.mealId, reason });
    if (!decoded.success) {
      return Promise.reject(new Error('the spy built a reply the lane schema rejects'));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(decoded.data);
      }, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new OllamaAbortError());
      });
    });
  };
  return { provider, calls };
}

describe('the explanation budget is shared by the whole step (PRD 10.1)', () => {
  /**
   * PRD 10.1's table is per-path and its explanation row is singular, so
   * `OLLAMA_EXPLANATION_TIMEOUT_MS` bounds **the explanation step of one request**, not each
   * meal. Three meals share it; a meal whose turn arrives after it is spent takes the template.
   *
   * **Driven as a budget, not as a number.** A test asserting `12000` appears somewhere would
   * prove nothing. The configured budget is 1200 ms and each call consumes 800 ms, so the shared
   * reading predicts: meal 1 succeeds at ~800 ms, meal 2 starts with ~400 ms and is timed out by
   * the lane at ~1200 ms, meal 3 is never called. The per-meal reading predicts three calls of
   * 800 ms and ~2400 ms elapsed. **2000 ms separates the two**, which is what makes the elapsed
   * assertion evidence rather than decoration.
   *
   * **The clock is frozen on purpose.** The budget reads `Date.now()` while the log line reads
   * the injected `now`, following `app.ts`'s request logger. If the budget were switched to the
   * injected clock, `deadline - now()` would never shrink, all three meals would be called and
   * this test would go red on every assertion below.
   */
  it('spends one budget across three meals, then falls back without calling the model', async () => {
    const spy = slowProvider(800, MODEL_REASON);
    const collected = collect();
    const target = mount({
      catalog,
      config: loadConfig({ OLLAMA_EXPLANATION_TIMEOUT_MS: '1200' }),
      provider: spy.provider,
      sink: collected.sink,
      now: steppingClock(),
    });

    const startedAt = Date.now();
    const response = await ask(target, true);
    const elapsed = Date.now() - startedAt;

    expect(response.status).toBe(200);
    const entries = entriesOf(response);
    expect(entries.length).toBe(3);
    // (b) fewer calls than meals - the later ones never reached the model.
    expect(spy.calls.length).toBeLessThan(entries.length);
    expect(spy.calls.length).toBeGreaterThan(0);
    // (a) the later meals fall back, and the FIRST does not: degradation is progressive within
    // one response, which is PRD FR-009's claim happening inside a single body rather than
    // between two requests.
    expect(entries[0]?.explanationSource).toBe('gemma');
    expect(entries[entries.length - 1]?.explanationSource).toBe('fallback');
    // (c) bounded, and bounded below what three independent per-meal budgets would cost.
    expect(elapsed).toBeLessThan(2000);
    /**
     * **The assertion an elapsed bound alone cannot make.** Handing each meal the full budget
     * while still skipping the third would finish in ~1600 ms and satisfy every assertion above,
     * so the elapsed bound is not on its own evidence that the budget is *shared*. These lines
     * are: meal 1 answered inside its share (`ok`), meal 2 was handed what was left and the lane
     * cut it off (`timeout`), meal 3 was never called (no third line). A per-meal budget logs
     * `ok` twice or three times instead.
     */
    expect(durationsOf(collected.lines)).toStrictEqual([CLOCK_STEP_MS, CLOCK_STEP_MS]);
    expect(collected.lines).toStrictEqual([aiLine('ok', 0), aiLine('timeout', 1)]);
  });
});

/**
 * The clock the route reads, stepping a fixed amount per read.
 *
 * **Read from `chat.test.ts:112` rather than invented**: the chat lane already solved this and two
 * conventions for one field would be worse than none. A *frozen* clock was the first version here
 * and it made `durationMs` vacuous - every line came out `0`, so hardcoding the zero the route
 * never computes failed nothing. Stepping makes the number **exactly** assertable rather than a
 * range: this route takes two reads per meal that enters the lane - one before the call, one when
 * the line is written - so every duration is precisely one step, while the timestamps advance and
 * therefore also pin the read ORDER.
 *
 * A meal that never enters the lane (the gate shut, or the budget spent) reads the clock not at
 * all, and a meal that enters and is refused by a busy lane reads it once and writes nothing -
 * so the only suites whose timestamps shift are the ones asserting lines, and in those every
 * preceding meal took exactly two reads.
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

/**
 * The nth AI line this route emits, in full, as bytes.
 *
 * `index` is the line's position, and the timestamp follows from it: the nth line is written on
 * the route's `2n + 1`th clock read, and its duration is the one step between that read and the
 * `2n`th.
 */
const aiLine = (outcome: string, index: number): string =>
  [
    `{"timestamp":"${new Date(CLOCK_BASE + (2 * index + 1) * CLOCK_STEP_MS).toISOString()}"`,
    `"level":"${outcome === 'ok' ? 'info' : 'warn'}"`,
    '"lane":"explanation"',
    `"durationMs":${String(CLOCK_STEP_MS)}`,
    `"outcome":"${outcome}"}`,
  ].join(',');

/**
 * Just the durations, so a wrong one fails with **the numbers** rather than inside a string diff.
 *
 * Extracted by regex rather than `JSON.parse(...) as …`: an `as` here would assert a shape this
 * test cannot see (BRIEF §4), and the exact-byte assertions above are what police the rest of the
 * line. A line with no `durationMs` contributes nothing, so a missing field shows up as a shorter
 * array rather than as a `NaN`.
 */
const durationsOf = (lines: readonly string[]): number[] =>
  lines.flatMap((line) => {
    const digits = /"durationMs":(\d+)/.exec(line)?.[1];
    return digits === undefined ? [] : [Number(digits)];
  });

interface Collected {
  readonly sink: LogSink;
  readonly lines: string[];
}

const collect = (): Collected => {
  const lines: string[] = [];
  return { sink: (line) => lines.push(line), lines };
};

/**
 * TSD 5.8's AI log line, on this lane, for the first time.
 *
 * **`aiLogLine` has existed since P08 and had no caller at all** — asserted as a pure function for
 * eleven phases while the line it serialises was never written by this server (AMENDMENT 7). That
 * is verbatim the shape P08's own audit found for `errorLogLine` and it survived that repair only
 * because there was no AI lane yet.
 *
 * Every assertion here is an **exact string**, which is what makes "the line carries `lane`,
 * `durationMs`, `outcome` and nothing else" checkable: a field added later — a meal name, a
 * containment `rule`, its `evidence`, a prompt — fails these rather than passing a loose matcher
 * (TSD 5.8, PRD 10.3, X-40).
 */
describe('the AI log line on the explanation lane (TSD 5.8, AMENDMENT 7)', () => {
  const withSink = (
    collected: Collected,
    provider: AiProvider,
    lane?: AiLane,
    config?: ServerConfig,
  ) =>
    mount({
      catalog,
      config: config ?? aiConfig(true),
      provider,
      ...(lane === undefined ? {} : { lane }),
      sink: collected.sink,
      now: steppingClock(),
    });

  it('writes one ok line per contained reply, and nothing about the meal', async () => {
    const collected = collect();
    const response = await ask(withSink(collected, spyProvider(MODEL_REASON).provider), true);
    const entries = entriesOf(response);
    // The one measured field in TSD 5.8's line, asserted as an exact number and asserted FIRST:
    // a hardcoded duration, a third clock read or a reach for `Date.now()` then fails with the
    // figures rather than inside the byte diff below, which truncates and buries them.
    expect(durationsOf(collected.lines)).toStrictEqual(entries.map(() => CLOCK_STEP_MS));
    expect(collected.lines).toStrictEqual(entries.map((_entry, index) => aiLine('ok', index)));
    // Explicit as well as implied by the exact match above, because this is the requirement and
    // not a side effect of it.
    expect(collected.lines.join('\n')).not.toContain(MODEL_REASON);
    for (const entry of entries) {
      expect(collected.lines.join('\n')).not.toContain(entry.meal.id);
    }
  });

  it('writes contained when the model answered and the reply was discarded', async () => {
    const collected = collect();
    const response = await ask(withSink(collected, spyProvider(DENIED_REASON).provider), true);
    // `contained` rather than a guess: the call returned, so it was not a transport failure, and
    // `explainRecommendation` discards a reply for containment or a mismatched `mealId` only.
    expect(collected.lines).toStrictEqual(
      entriesOf(response).map((_entry, index) => aiLine('contained', index)),
    );
  });

  it('writes unreachable when the model could not be reached', async () => {
    const collected = collect();
    const config = loadConfig({});
    const response = await ask(
      withSink(
        collected,
        createAiProvider(config, () => Promise.reject(new TypeError('fetch failed'))),
        undefined,
        config,
      ),
      true,
    );
    expect(durationsOf(collected.lines)).toStrictEqual(
      entriesOf(response).map(() => CLOCK_STEP_MS),
    );
    expect(collected.lines).toStrictEqual(
      entriesOf(response).map((_entry, index) => aiLine('unreachable', index)),
    );
  });

  it('writes nothing at all when the gate is shut - there was no AI call', async () => {
    const collected = collect();
    await ask(withSink(collected, offlineProvider), false);
    expect(collected.lines).toStrictEqual([]);
  });

  it('logs a broken explainRecommendation by name and frames, and still answers 200', async () => {
    /**
     * The route's defensive `catch`, driven the only way it can be reached: a dependency that
     * breaks its contract. `explainRecommendation` is contracted never to throw (CONTRACTS 10),
     * so no conforming module reaches this branch - and a branch whose only evidence is a
     * mutation probe is one a reader cannot check. `mockRejectedValueOnce` applies to the FIRST
     * meal only and the real implementation resumes for the rest, which also pins the blast
     * radius: one broken explanation is not three.
     *
     * The message is a deliberate trap. `errorLogLine` drops it (PRD 12, TSD 3.5) and this
     * asserts that it stayed dropped on this path too.
     */
    const collected = collect();
    vi.mocked(explainRecommendation).mockRejectedValueOnce(
      new RangeError('upstream text that must never be logged'),
    );
    const response = await ask(withSink(collected, spyProvider(MODEL_REASON).provider), true);

    expect(response.status).toBe(200);
    const entries = entriesOf(response);
    expect(entries[0]?.explanationSource).toBe('fallback');
    expect(entries[0]?.explanation.length).toBeGreaterThan(0);
    expect(entries[1]?.explanationSource).toBe('gemma');
    expect(collected.lines[0]).toContain('"errorName":"RangeError"');
    expect(collected.lines.join('\n')).not.toContain('upstream text that must never be logged');
    // No AI line for that meal: the lane was never entered, so there was no call to measure.
    expect(collected.lines.filter((line) => line.includes('"lane":"explanation"'))).toHaveLength(
      entries.length - 1,
    );
  });

  it('writes nothing when the lane was busy, because no call was made', async () => {
    // `chat.ts`'s ruling, matched here: `aiLane.run` rejects before `fn` runs, so a `durationMs`
    // for a busy rejection would be a fabricated measurement, and there is no outcome for it in
    // TSD 5.8's closed set. The request is not invisible - `app.ts` logs it as a request.
    const lane = createAiLane();
    let release: () => void = () => undefined;
    const holding = lane.run<never>(
      () =>
        new Promise<never>((_resolve, reject) => {
          release = () => {
            reject(new Error('the test released the lane'));
          };
        }),
      5000,
    );
    holding.catch(() => undefined);

    const collected = collect();
    const spy = spyProvider(MODEL_REASON);
    const response = await ask(withSink(collected, spy.provider, lane), true);
    release();
    await holding.catch(() => undefined);

    expect(response.status).toBe(200);
    for (const entry of entriesOf(response)) {
      expect(entry.explanationSource).toBe('fallback');
    }
    // The lane rejected before `fn` ran, so the model was never reached.
    expect(spy.calls).toStrictEqual([]);
    expect(collected.lines).toStrictEqual([]);
  });
});
