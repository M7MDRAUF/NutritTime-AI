import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import { createApp } from '../app.js';
import { buildCatalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import type { FetchLike } from './ollamaClient.js';

/**
 * The one property of `app.ts`'s wiring that no single router can prove: **the chat lane and the
 * explanation lane contend with each other.**
 *
 * TSD 5.5 says "one AI call at a time, **process-wide**". `createAiLane()` is per-instance, so
 * dependency injection cannot express process-wide on its own — what it can express is that every
 * consumer shares ONE lane, and `index.ts` creates exactly one app. This file is the whole of the
 * evidence for that, and it lives here rather than in either route's suite because neither route
 * can see the other.
 *
 * **Why the obvious assertion would not have worked.** The tempting test is "hold the lane with
 * one request, fire the other, assert it degraded". That passes under the very bug it is written
 * for: with a lane per router the second request acquires its OWN lane, calls a hanging model, and
 * degrades anyway — just slowly, after its own timeout. The observable outcome is identical.
 *
 * So both tests below assert something a second lane would change:
 *
 *  - the **provider call count**, because a shared lane refuses the second caller BEFORE `fn`
 *    runs, so the model is contacted exactly once;
 *  - the **error code**, because a refused caller gets `ai_busy` immediately while a caller with
 *    its own lane gets `ai_unavailable` from a timeout. Both are 503, and only the code separates
 *    them.
 *
 * A test asserting that two CHAT requests contend would pass with a lane per router, which is
 * exactly the bug. That is why one of the two requests is always a recommendation.
 */

const catalog = buildCatalog(seededCatalog);

/** Both budgets at the schema's floor, so a held lane resolves in a second rather than thirty. */
const config = loadConfig({
  AI_ENABLED: 'true',
  AI_FAKE: 'false',
  OLLAMA_CHAT_TIMEOUT_MS: '1000',
  OLLAMA_EXPLANATION_TIMEOUT_MS: '1000',
});

interface Held {
  readonly fetchImpl: FetchLike;
  /** How many times the model was actually contacted. */
  calls(): number;
  /** Let every in-flight call finish, so the suite does not leave a pending timer behind. */
  release(): void;
}

/**
 * A `fetchImpl` that hangs until released.
 *
 * It resolves rather than rejects on release, with a reply that will fail containment — which is
 * deliberate and harmless: **neither test asserts the first request's outcome.** The first request
 * exists only to occupy the lane, and a reply that is refused is a cleaner end state than one that
 * happens to pass, because it cannot be mistaken for the thing under test.
 */
function heldModel(): Held {
  let count = 0;
  const releases: (() => void)[] = [];
  return {
    fetchImpl: (): Promise<Response> => {
      count += 1;
      return new Promise<Response>((resolve) => {
        releases.push(() => {
          resolve(
            new globalThis.Response(
              JSON.stringify({ response: '{"answered":true,"answer":"x","citedMealIds":[]}' }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        });
      });
    },
    calls: () => count,
    release: () => {
      for (const done of releases.splice(0)) {
        done();
      }
    },
  };
}

const chatBody = {
  question: 'which is cheapest?',
  preferences: { diet: 'regular', allergies: [], dislikedIngredients: [] },
};

const recommendationBody = {
  mealPeriod: 'lunch',
  aiEnabled: true,
  preferences: {
    diet: 'regular',
    allergies: [],
    goal: 'balanced',
    budget: 'high',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
};

/** Long enough for the first request to reach `fetch` and take the lane. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

describe('the chat and explanation lanes contend for one process-wide lane', () => {
  it('refuses the explanation lane while chat holds it, WITHOUT contacting the model again', async () => {
    const held = heldModel();
    const app = createApp({ config, catalog, sink: () => undefined, fetchImpl: held.fetchImpl });

    const chat = request(app).post('/api/v1/chat').send(chatBody);
    // Not awaited: it is holding the lane on purpose.
    void chat.catch(() => undefined);
    await settle();
    expect(held.calls()).toBe(1);

    const recommendations = await request(app)
      .post('/api/v1/recommendations')
      .send(recommendationBody);

    // The request still succeeds — PRD FR-009: a failed explanation never fails the request.
    expect(recommendations.status).toBe(200);
    const sources: unknown[] = recommendations.body.recommendations.map(
      (entry: { explanationSource: unknown }) => entry.explanationSource,
    );
    expect(sources).toStrictEqual(['fallback', 'fallback', 'fallback']);

    /**
     * **This is the assertion a second lane would break.** A shared lane rejects with
     * `AiBusyError` before `fn` runs, so the model is never contacted for an explanation. With a
     * lane per router the three explanations would have called it and timed out, and the
     * `'fallback'` assertion above would still have passed.
     */
    expect(held.calls()).toBe(1);

    held.release();
    await chat.catch(() => undefined);
  });

  it('answers a second AI caller with ai_busy, not with a timeout', async () => {
    const held = heldModel();
    const app = createApp({ config, catalog, sink: () => undefined, fetchImpl: held.fetchImpl });

    const recommendations = request(app).post('/api/v1/recommendations').send(recommendationBody);
    void recommendations.catch(() => undefined);
    await settle();
    expect(held.calls()).toBe(1);

    const chat = await request(app).post('/api/v1/chat').send(chatBody);

    expect(chat.status).toBe(503);
    /**
     * **`ai_busy`, not `ai_unavailable`, is the discriminating half.** Both are 503 and both are
     * retryable, so a status assertion alone would pass under a lane per router — where this
     * request would have got its own lane, hung, and returned `ai_unavailable` from the timeout.
     * Only the code says "someone else is using the model" rather than "the model is broken".
     */
    expect(chat.body.error.code).toBe('ai_busy');
    // Plan 11.6: no answer text on any failure path.
    expect(chat.body.answer).toBeUndefined();
    expect(held.calls()).toBe(1);

    held.release();
    await recommendations.catch(() => undefined);
  });
});

/**
 * **`app.ts` hands each router a `sink`, and for the explanation lane nothing checked that it
 * did.** A vacuity audit measured it: replacing `recommendationsRouter`'s `sink` with
 * `() => undefined` in `app.ts` failed **0 of 824 tests**, so the explanation lane's entire
 * TSD 5.8 log line could vanish unnoticed. The same mutation on `chatRouter` failed 3.
 *
 * The cause is a gap between two layers rather than a weak assertion: every explanation log test
 * mounts **its own** express app to get at the router directly, and none of them goes through
 * `createApp` — so the wiring in `app.ts` was the one link in the chain with no test above it.
 *
 * This file already owns the question "what does `app.ts` hand the routers", which is why the
 * check lives here rather than beside the lane's own suite.
 */
describe('app.ts hands the sink to both AI lanes', () => {
  it('writes an explanation-lane AI log line through createApp', async () => {
    const lines: string[] = [];
    // `AI_FAKE` is a real code path (TSD 5.5): retrieval, resolution, prompt build and containment
    // all execute and only the HTTP call is replaced, so the lane reaches its logging branch.
    const faked = loadConfig({ AI_ENABLED: 'true', AI_FAKE: 'true' });
    const app = createApp({
      config: faked,
      catalog,
      sink: (line) => lines.push(line),
    });

    const response = await request(app).post('/api/v1/recommendations').send(recommendationBody);
    expect(response.status).toBe(200);

    const ai = lines
      .map((line): unknown => JSON.parse(line))
      .filter(
        (line): line is { lane: string; outcome: string; durationMs: number } =>
          typeof line === 'object' && line !== null && 'lane' in line,
      );

    /**
     * At least one line, from THIS lane. Asserting merely "some AI line exists" would pass if the
     * chat lane had written it, and the chat side is already covered — the mutation this test
     * exists for removes the sink from the recommendations router alone.
     */
    const explanation = ai.filter((line) => line.lane === 'explanation');
    expect(explanation.length).toBeGreaterThan(0);
    for (const line of explanation) {
      expect(line.outcome).toBe('ok');
    }
  });
});
