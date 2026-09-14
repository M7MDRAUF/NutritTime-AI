import { describe, expect, it } from 'vitest';
import type { ChatModelReply } from '@nutritime/contracts';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import type { FetchLike } from './ollamaClient.js';
import {
  CHEAPEST_SAFE,
  FIXED_NOW,
  MIXED_CATALOG,
  SUPERLATIVE_QUESTION,
  ask,
  expectedErrorBody,
  nameOnlyReply,
} from '../routes/__fixtures__/chatHarness.js';
import type { Harness, ModelStub } from '../routes/__fixtures__/chatHarness.js';

/**
 * T-25-05 and the sequential half of T-25-06: **the request after a failed one.**
 *
 * PRD 10.1, verbatim: *"A cold model load takes roughly a minute and will exceed the assistant's
 * timeout. The first request after a restart may legitimately fail and then recover on its own."*
 * SDD 9.7 says the same and calls it designed degradation. Plan 14's R-05 is the risk row.
 *
 * **What no existing suite asserts is the SECOND request.** Every failure case in
 * `chat.test.ts`, `chat.integration.test.ts` and `lane-contention.integration.test.ts` drives one
 * request and reads its response; recovery is a property of a *pair*, and a pair is the only
 * shape that can distinguish "the model was slow once" from "the server is now stuck". So each
 * test below asserts the first response, the second response, and the provider call count -
 * only the count proves the second request reached the model rather than being refused on the
 * way. The measured gap: mutating `aiLane.ts` to hold `occupied` after every call reddens
 * **nothing in either chat suite** and eleven tests in the explanation lane's.
 *
 * **The discriminating half is that the second response is not `ai_busy`.** A lane that leaked
 * its single flight on the timeout path answers every later question 503 for the life of the
 * process, and PRD 10.1's "recover on its own" is then false with no other visible symptom:
 * both states are a 503 the client is told to retry, and only the code separates them.
 *
 * **What is NOT here, and must not be inferred from what is.** There is no model on this
 * machine (CONTRACTS AMENDMENT 12), so nothing below measures a real ~60 s load. A hung socket
 * is a *stand-in for the shape* of that failure - the budget expires and the call is abandoned -
 * and the figure in PRD 10.1's sentence is untested. `docs/performance/reliability.md` records
 * that as a limitation rather than quoting a fake number as a latency.
 *
 * **The socket is the only thing replaced** (TSD 5.5's argument for `AI_FAKE`, applied one layer
 * lower through `AppOptions.fetchImpl`): the real `createAiLane`, `createAiProvider`,
 * `createOllamaClient`, `buildChatPrompt` and `containReply` all run, so a reply that passes
 * here would pass against a model, and the two-stage decode's truncation check is live.
 *
 * Fixtures, the catalog, the request builder and the error-body shape come from
 * `../routes/__fixtures__/chatHarness.js` rather than being rebuilt - T-25-06 says extend, and a
 * second copy of a 200-line harness is the drift that file was extracted to prevent. Only the
 * **staged** model is new, because `ModelBehaviour` there is one behaviour for the life of a
 * test and every claim below needs the second call to behave differently from the first.
 */

// ------------------------------------------------------------------ the model, one call at a time

/** What the socket does on call N. `hangs` never settles until `release()`. */
type Stage =
  | { readonly kind: 'hangs'; readonly thenAnswers: ChatModelReply }
  | { readonly kind: 'rejects' }
  | { readonly kind: 'answers'; readonly reply: ChatModelReply }
  | { readonly kind: 'truncates'; readonly reply: ChatModelReply };

/** Ollama's envelope, with the model's JSON carried as a STRING (TSD 5.5). */
function envelope(reply: ChatModelReply, doneReason?: string): Response {
  return new globalThis.Response(
    JSON.stringify({
      response: JSON.stringify(reply),
      ...(doneReason === undefined ? {} : { done_reason: doneReason }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

interface Staged extends Harness {
  /** Let every hung call finish, so no test leaves a pending socket behind. */
  release(): void;
}

/**
 * An app whose model behaves differently on each call. A call past the end of `stages` is
 * counted and rejected, never silently answered, so an extra request cannot pass unnoticed.
 */
function stagedApp(stages: readonly Stage[], env: NodeJS.ProcessEnv = {}): Staged {
  let calls = 0;
  const bodies: string[] = [];
  const releases: (() => void)[] = [];
  const lines: string[] = [];

  const fetchImpl: FetchLike = (_input, init) => {
    const stage = stages[calls];
    calls += 1;
    bodies.push(typeof init.body === 'string' ? init.body : '');
    if (stage === undefined) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (stage.kind === 'rejects') {
      // What a stopped Ollama actually does: `fetch` rejects. `ollamaClient.ts` turns it into
      // `OllamaError('unreachable')` without reading the rejection.
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (stage.kind === 'answers') {
      return Promise.resolve(envelope(stage.reply));
    }
    if (stage.kind === 'truncates') {
      // Parseable JSON that is still a truncation - TSD 5.5 checks `done_reason` BEFORE the
      // inner parse for exactly this case.
      return Promise.resolve(envelope(stage.reply, 'length'));
    }
    const answered = stage.thenAnswers;
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(envelope(answered)));
    });
  };

  const model: ModelStub = {
    fetchImpl,
    calls: () => calls,
    outbound: () => bodies,
    release: () => {
      for (const done of releases.splice(0)) {
        done();
      }
    },
  };

  const app = createApp({
    config: loadConfig({ OLLAMA_CHAT_TIMEOUT_MS: '1000', ...env }),
    catalog: MIXED_CATALOG,
    sink: (line) => lines.push(line),
    now: () => FIXED_NOW,
    fetchImpl,
  });

  return { app, lines, model, release: model.release };
}

// ------------------------------------------------------------------------------ the expectations

/** A peanut allergy over `MIXED_CATALOG`, so the superlative resolves to exactly one meal. */
const COLD_ASK = { question: SUPERLATIVE_QUESTION, allergies: ['peanut'] } as const;

/** Names the winner, cites its id, quotes no figure: contained for this prompt by construction. */
const WARM_REPLY = nameOnlyReply([CHEAPEST_SAFE]);

/**
 * The whole of a successful body. Citations come from the FIXTURE, not from `WARM_REPLY` - a
 * citation is resolved from `resolved.namedMeals` by id and is never read out of the reply
 * (T-21-03), so the reply is the wrong authority for what they should be.
 */
const WARM_BODY = {
  answered: true,
  answer: WARM_REPLY.answer,
  citations: [{ mealId: CHEAPEST_SAFE.id, name: CHEAPEST_SAFE.name }],
  source: 'gemma',
};

/**
 * TSD 5.8's AI line, **hand-transcribed from the document** rather than read back from
 * `aiLogLine` (BRIEF 6.1g). `durationMs` is `0` because `FIXED_NOW` is fixed, not stepping.
 */
function aiLine(outcome: string): Record<string, unknown> {
  return {
    timestamp: FIXED_NOW.toISOString(),
    level: outcome === 'ok' ? 'info' : 'warn',
    lane: 'chat',
    durationMs: 0,
    outcome,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every AI line the sink received, in order. The request lines are `app.ts`'s and are not these. */
function aiLines(staged: Staged): Record<string, unknown>[] {
  return staged.lines
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .filter((line) => 'lane' in line);
}

/** Long enough for a not-awaited request to reach `fetch` and take the lane. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

// ------------------------------------------------------------------------------------- the tests

describe('the cold load - the first request may fail and the next one recovers', () => {
  it('503s the request that outlives the budget, then answers the next one', async () => {
    const staged = stagedApp([
      { kind: 'hangs', thenAnswers: WARM_REPLY },
      { kind: 'answers', reply: WARM_REPLY },
    ]);

    const cold = await ask(staged, COLD_ASK);
    expect(cold.status).toBe(503);
    // PRD 12 and TSD 3.5: `errors.ts`'s fixed local copy, `retryable: true` (a temporary
    // condition, which is what drives the client's retry), and no answer text. `toStrictEqual`
    // is what catches a fifth field carrying a cause.
    expect(cold.body).toStrictEqual(
      expectedErrorBody('ai_unavailable', 'The assistant is unavailable right now.', true),
    );

    const warm = await ask(staged, COLD_ASK);

    // **The assertion the whole file exists for.** A lane that leaked its single flight when the
    // budget expired answers this `ai_busy` - a 503 the client is also told to retry, forever -
    // and PRD 10.1's "recover on its own" would be false with no other symptom.
    expect(warm.status).toBe(200);
    expect(warm.body).toStrictEqual(WARM_BODY);

    // Two sockets: the abandoned one and the one that answered. Proves the second request
    // reached the model rather than being refused before `fn` ran or served from anything cached
    // (SDD 9.7: "Nothing is cached").
    expect(staged.model.calls()).toBe(2);

    staged.release();
  });

  it('logs `timeout` then `ok`, and neither line carries the question or the answer', async () => {
    const staged = stagedApp([
      { kind: 'hangs', thenAnswers: WARM_REPLY },
      { kind: 'answers', reply: WARM_REPLY },
    ]);

    await ask(staged, COLD_ASK);
    await ask(staged, COLD_ASK);

    // One line per call, in order, each exactly TSD 5.8's three fields plus the two every line
    // carries. An abandoned call still gets its line: `outcome: 'timeout'` is how an operator
    // tells a cold load from a stopped model, which is the whole reason the field exists.
    expect(aiLines(staged)).toStrictEqual([aiLine('timeout'), aiLine('ok')]);

    /**
     * TSD 5.8 ("Never logged: prompts, questions, answers, allergy lists, names"), PRD 10.3 and
     * Plan 15.5. **`PRD 15.5` does not exist** - PRD section 15 is Dependencies and Assumptions.
     * Asserted over EVERY line, not only the AI ones, because the request line and the error
     * handler write to the same sink and a leak through either is the same leak.
     */
    const written = staged.lines.join('\n');
    expect(written).not.toContain(SUPERLATIVE_QUESTION);
    expect(written).not.toContain('peanut');
    expect(written).not.toContain(CHEAPEST_SAFE.name);
    expect(written).not.toContain(WARM_REPLY.answer);

    staged.release();
  });
});

describe('failure injection - the model goes away and comes back', () => {
  it('reports a stopped Ollama as `unreachable`, then answers once it is back', async () => {
    const staged = stagedApp([{ kind: 'rejects' }, { kind: 'answers', reply: WARM_REPLY }]);

    const stopped = await ask(staged, COLD_ASK);
    expect(stopped.status).toBe(503);
    expect(stopped.body).toStrictEqual(
      expectedErrorBody('ai_unavailable', 'The assistant is unavailable right now.', true),
    );

    const restarted = await ask(staged, COLD_ASK);
    expect(restarted.status).toBe(200);
    expect(restarted.body).toStrictEqual(WARM_BODY);
    expect(staged.model.calls()).toBe(2);

    // `unreachable`, not `timeout`: an operator reading `timeout` here would go looking at the
    // budget for a process that is not running. And nothing of the rejection reaches either
    // surface - a real `fetch` failure reads `connect ECONNREFUSED 127.0.0.1:11434` (TSD 3.5).
    expect(aiLines(staged)).toStrictEqual([aiLine('unreachable'), aiLine('ok')]);
    const everything = JSON.stringify(stopped.body) + staged.lines.join('\n');
    expect(everything).not.toContain('fetch failed');
    expect(everything).not.toContain('ECONNREFUSED');
  });

  it('refuses a PARSEABLE truncated reply and does not poison the next request', async () => {
    const staged = stagedApp([
      { kind: 'truncates', reply: WARM_REPLY },
      { kind: 'answers', reply: WARM_REPLY },
    ]);

    const truncated = await ask(staged, COLD_ASK);

    // **The reply decodes cleanly and is still refused.** A truncated reply can be valid JSON,
    // which is the shape a model short of context produces - the case nearest a cold or evicted
    // model, and one `ollamaClient.test.ts` reaches only one layer down with no route above it.
    expect(truncated.status).toBe(503);
    expect(truncated.body).toStrictEqual(
      expectedErrorBody('ai_unavailable', 'The assistant is unavailable right now.', true),
    );
    // Not a partial success: none of the reply is shown rather than part of it (Plan 15.3).
    expect(JSON.stringify(truncated.body)).not.toContain(CHEAPEST_SAFE.name);

    const after = await ask(staged, COLD_ASK);
    expect(after.status).toBe(200);
    expect(after.body).toStrictEqual(WARM_BODY);
    expect(staged.model.calls()).toBe(2);

    // `schema` for a truncation is `ai/outcome.ts`'s deliberate choice among five closed values,
    // and it is the one that file calls its least comfortable. Pinned here so the choice is a
    // decision rather than an accident.
    expect(aiLines(staged)).toStrictEqual([aiLine('schema'), aiLine('ok')]);
  });
});

describe('a busy lane is a different state from an absent model, and it recovers too', () => {
  it('answers `ai_busy` with no AI log line, then serves the next request', async () => {
    // The real 30 s chat budget, so the held call cannot time out and turn this into the test
    // above by accident. It is released explicitly instead.
    const staged = stagedApp(
      [
        { kind: 'hangs', thenAnswers: WARM_REPLY },
        { kind: 'answers', reply: WARM_REPLY },
      ],
      { OLLAMA_CHAT_TIMEOUT_MS: '30000' },
    );

    const holding = ask(staged, COLD_ASK);
    void holding.catch(() => undefined);
    await settle();
    expect(staged.model.calls()).toBe(1);

    const before = aiLines(staged).length;
    const busy = await ask(staged, COLD_ASK);

    expect(busy.status).toBe(503);
    // **The code, not the status.** `ai_busy` and `ai_unavailable` are both 503 and both
    // retryable; only the code says "someone else is using the model" rather than "the model is
    // broken", and `apps/mobile/.../useAssistant.ts` maps the two to different words and a
    // different action (T-21-07).
    expect(busy.body).toStrictEqual(
      expectedErrorBody('ai_busy', 'The assistant is busy with another question.', true),
    );
    // The refused caller never reached a socket, and wrote no AI line: `aiLane.run` rejects
    // before `fn` runs, so a `durationMs` here would time a call that did not happen
    // (`ai/outcome.ts`). The rejection is a property of the REQUEST and `app.ts` logs it as one.
    expect(staged.model.calls()).toBe(1);
    expect(aiLines(staged)).toHaveLength(before);

    staged.release();
    expect((await holding).status).toBe(200);

    // And the lane is free for the next question with no user action but asking again.
    const next = await ask(staged, COLD_ASK);
    expect(next.status).toBe(200);
    expect(next.body).toStrictEqual(WARM_BODY);
    expect(staged.model.calls()).toBe(2);
  });
});
