/**
 * T-25-04 — the 30 s chat timeout, measured. **The warm latency figure is not measured here and
 * cannot be measured on this machine.**
 *
 * Run with `npx tsx e2e/perf/chatTimeout.ts` from the repository root.
 *
 * **There is no model on this machine.** Nothing listens on 11434 and `OLLAMA_MODEL` defaults to
 * `gemma3:4b`, which is not present. PRD §10.1 puts a warm assistant answer at ~11 s; that figure
 * is the latency of inference, and inference is the one thing absent. So this script deliberately
 * measures only what is measurable, and the two halves of PRD §10.1's row are kept apart:
 *
 *  - **the hard 30 s timeout** — falsifiable, and measured below against the REAL provider path
 *    with a stalled upstream: `AI_FAKE=false`, `OLLAMA_BASE_URL` pointed at a server that accepts
 *    `POST /api/generate` and never answers. Everything downstream of the socket is the shipped
 *    code: `createOllamaClient`, `createAiLane`'s single-flight and timer, `outcomeForFailure`,
 *    `chatFailure`, `app.ts`'s error handler.
 *  - **the ~11 s warm figure** — UNMEASURED, and recorded as unmeasured with the reason. A number
 *    produced by `AI_FAKE` would be the latency of a deterministic echo. It cannot be corrected
 *    for, scaled, or annotated into usefulness, and quoting one as a model latency would destroy
 *    the only thing this phase exists to produce.
 *
 * **What "the timeout behaves" means precisely, and it is three claims, not one:** the request
 * ENDS (it is not a hang), it ends at approximately the configured budget, and it ends as HTTP 503
 * `ai_unavailable` with the server's own AI log line reading `outcome: "timeout"`. The log line is
 * what proves the provider was actually reached — a question the domain merely refused would
 * answer 200 with no AI call at all, and would look like a pass to anything checking only for an
 * error.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { emit, emitNote, emitProbe, median, worst } from './stats.js';
import { closeServer, logRecords, numberField, startApi, stringField } from './serverHarness.js';

const RUNS = 3;
/** PRD §10.1's hard timeout, and `config.ts`'s `OLLAMA_CHAT_TIMEOUT_MS` default. */
const CHAT_TIMEOUT_MS = 30_000;
/** The probe's budget: small enough to be fast, far enough from 30 s to be unmistakable. */
const PROBE_TIMEOUT_MS = 4_000;
/**
 * How far past 30 s still counts as the deadline having behaved.
 *
 * One second, and it is a judgement stated rather than a figure read out of a document: no
 * document sets a tolerance for the timeout. It is two-sided — a request that ended at 3 s would
 * mean something other than the budget fired, which is a defect and not a fast pass.
 */
const TOLERANCE_MS = 1_000;
const API_PORT = 4474;
const PROBE_API_PORT = 4475;
const UPSTREAM_PORT = 11_491;
const PROBE_UPSTREAM_PORT = 11_492;

/**
 * A question the domain RESOLVES, so step 5 runs and the provider is reached.
 *
 * `chat.ts` returns at step 2 when nothing is eligible and at step 3 when the resolver cannot
 * answer, and on both of those paths the provider "is never constructed into a call". A question
 * that took either path would produce a 200 and no AI log line, and a timeout measurement built on
 * it would be measuring nothing. PRD §7.4 lists a superlative as one of six answerable shapes; the
 * assertion that the AI log line exists is what makes this an observation rather than a hope.
 */
const QUESTION = 'What is the cheapest lunch?';

function chatBody(): string {
  return JSON.stringify({
    question: QUESTION,
    preferences: { diet: 'regular', allergies: [], dislikedIngredients: [] },
  });
}

/**
 * An Ollama stand-in.
 *
 * `null` for `respondAfterMs` means: accept the request, hold the socket open, and never answer.
 * That is the injected delay — unbounded, so it is past any budget by construction, and it does
 * not depend on `AI_FAKE` being able to stall (it cannot: the fake returns immediately).
 */
function startUpstream(port: number, respondAfterMs: number | null, replyJson: string): Server {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (respondAfterMs === null) {
        // Deliberately nothing. The socket stays open until the client's AbortSignal closes it.
        return;
      }
      setTimeout(() => {
        // TSD §5.5's envelope: `response` carries the model's JSON as a STRING.
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ response: replyJson, done_reason: 'stop' }));
      }, respondAfterMs);
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

interface ChatOutcome {
  readonly elapsedMs: number;
  readonly status: number;
  readonly code: string | undefined;
}

async function postChat(port: number): Promise<ChatOutcome> {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:19006' },
    body: chatBody(),
  });
  const payload: unknown = await response.json();
  const elapsedMs = performance.now() - startedAt;
  const code =
    typeof payload === 'object' && payload !== null && 'error' in payload
      ? readCode(payload.error)
      : undefined;
  return { elapsedMs, status: response.status, code };
}

function readCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The chat lane's AI log lines (TSD §5.8): `lane`, `durationMs`, `outcome`, and nothing else. */
function chatAiLines(
  lines: readonly string[],
): readonly { readonly durationMs: number; readonly outcome: string }[] {
  const found: { durationMs: number; outcome: string }[] = [];
  for (const record of logRecords(lines)) {
    if (stringField(record, 'lane') !== 'chat') {
      continue;
    }
    const durationMs = numberField(record, 'durationMs');
    const outcome = stringField(record, 'outcome');
    if (durationMs !== undefined && outcome !== undefined) {
      found.push({ durationMs, outcome });
    }
  }
  return found;
}

async function waitForAiLines(
  lines: readonly string[],
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (chatAiLines(lines).length < expected) {
    if (Date.now() > until) {
      throw new Error(
        `only ${String(chatAiLines(lines).length)} of ${String(expected)} chat AI log lines arrived`,
      );
    }
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

/** A reply that is schema-valid and ungrounded, so containment rejects it. See the probe below. */
const UNGROUNDED_REPLY = JSON.stringify({
  answered: true,
  answer: 'Everything on this menu is healthy.',
  citedMealIds: [],
});

async function main(): Promise<void> {
  emitNote(
    'T-25-04',
    'warm chat latency: UNMEASURED. No model is present on this machine — nothing listens on ' +
      '11434 and gemma3:4b is not installed — so PRD §10.1’s ~11 s figure has no instrument here. ' +
      'It is NOT approximated from AI_FAKE, which replaces the HTTP call with a deterministic echo.',
  );

  // ---------------------------------------------------------------- the figure
  const upstream = startUpstream(UPSTREAM_PORT, null, '');
  const api = await startApi(API_PORT, {
    AI_FAKE: 'false',
    AI_ENABLED: 'true',
    OLLAMA_BASE_URL: `http://127.0.0.1:${String(UPSTREAM_PORT)}`,
  });
  const elapsed: number[] = [];
  const laneDurations: number[] = [];
  try {
    for (let run = 0; run < RUNS; run += 1) {
      const outcome = await postChat(API_PORT);
      if (outcome.status !== 503 || outcome.code !== 'ai_unavailable') {
        throw new Error(
          `expected 503 ai_unavailable, got ${String(outcome.status)} / ${outcome.code ?? 'no code'}`,
        );
      }
      elapsed.push(outcome.elapsedMs);
    }
    await waitForAiLines(api.stdout, RUNS, 10_000);
    const lines = chatAiLines(api.stdout).slice(0, RUNS);
    for (const line of lines) {
      if (line.outcome !== 'timeout') {
        // A 503 alone would also be produced by an unreachable upstream or a containment failure.
        // The outcome is what distinguishes the timeout from every other way of failing.
        throw new Error(`expected outcome "timeout", got "${line.outcome}"`);
      }
      laneDurations.push(line.durationMs);
    }
  } finally {
    await api.stop();
    await closeServer(upstream);
  }

  emit({
    row: 'T-25-04',
    what: 'POST /api/v1/chat with a STALLED upstream -> 503 ai_unavailable (the 30 s hard timeout)',
    targetMs: CHAT_TIMEOUT_MS,
    kind: 'deadline',
    toleranceMs: TOLERANCE_MS,
    runsMs: elapsed,
    note:
      `private server on port ${String(API_PORT)} with AI_FAKE=false and OLLAMA_BASE_URL pointed ` +
      `at a stand-in on ${String(UPSTREAM_PORT)} that accepts POST /api/generate and NEVER ` +
      'answers — the injected delay is unbounded, so it is past the budget by construction. Real ' +
      'provider path throughout: createOllamaClient, createAiLane’s single-flight timer, ' +
      'outcomeForFailure, app.ts’s error handler. Three sequential runs (the lane is ' +
      'concurrency-1). Every run verified as HTTP 503 with code ai_unavailable AND a TSD §5.8 AI ' +
      'log line reading outcome "timeout" — the log line is what proves the provider was reached ' +
      'rather than the domain having refused the question. The target is a CEILING the request ' +
      'must not exceed, not a figure to be under: ending well before 30 s would mean the budget ' +
      'is not the thing that fired. Eleven other agents active in this tree.',
  });
  emit({
    row: 'T-25-04a',
    what: 'the same three, as the lane measured them (TSD §5.8 durationMs, outcome=timeout)',
    targetMs: CHAT_TIMEOUT_MS,
    kind: 'deadline',
    toleranceMs: TOLERANCE_MS,
    runsMs: laneDurations,
    note: 'taken before the lane is entered and read on the failure path, so it covers the whole attempt.',
  });
  emitNote(
    'T-25-04',
    `NOT A HANG: every one of ${String(RUNS)} runs ended with a response. Client-observed overshoot ` +
      `past the ${String(CHAT_TIMEOUT_MS)} ms budget: median ${(median(elapsed) - CHAT_TIMEOUT_MS).toFixed(1)} ms, ` +
      `worst ${(worst(elapsed) - CHAT_TIMEOUT_MS).toFixed(1)} ms.`,
  );

  // -------------------------------------------------- probe 1: the budget moves the figure
  const probeUpstream = startUpstream(PROBE_UPSTREAM_PORT, null, '');
  const probeApi = await startApi(PROBE_API_PORT, {
    AI_FAKE: 'false',
    AI_ENABLED: 'true',
    OLLAMA_BASE_URL: `http://127.0.0.1:${String(PROBE_UPSTREAM_PORT)}`,
    OLLAMA_CHAT_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
  });
  try {
    const shortBudget = await postChat(PROBE_API_PORT);
    if (shortBudget.status !== 503 || shortBudget.code !== 'ai_unavailable') {
      throw new Error('the short-budget run did not end as 503 ai_unavailable');
    }
    emitProbe(
      'T-25-04',
      `OLLAMA_CHAT_TIMEOUT_MS lowered to ${String(PROBE_TIMEOUT_MS)} against the same stalled upstream`,
      PROBE_TIMEOUT_MS - CHAT_TIMEOUT_MS,
      median(elapsed),
      shortBudget.elapsedMs,
    );
    if (shortBudget.elapsedMs > CHAT_TIMEOUT_MS / 2) {
      throw new Error(
        'the figure did not follow the configured budget; the harness is reporting a constant',
      );
    }

    // ------------------------- probe 2: a fast upstream is distinguished from a timeout
    await closeServer(probeUpstream);
    const fastUpstream = startUpstream(PROBE_UPSTREAM_PORT, 500, UNGROUNDED_REPLY);
    try {
      const before = chatAiLines(probeApi.stdout).length;
      const fast = await postChat(PROBE_API_PORT);
      await waitForAiLines(probeApi.stdout, before + 1, 10_000);
      const line = chatAiLines(probeApi.stdout)[before];
      if (line === undefined) {
        throw new Error('no AI log line for the fast-upstream run');
      }
      emitNote(
        'T-25-04',
        `probe 2 — an upstream answering in 500 ms with an UNGROUNDED reply: ` +
          `${fast.elapsedMs.toFixed(1)} ms, HTTP ${String(fast.status)} ${fast.code ?? ''}, ` +
          `outcome "${line.outcome}". The harness reports a different number AND a different ` +
          'outcome, so "timeout" above is a measurement and not the only thing it can print. ' +
          '(Ungrounded on purpose: this lane has no model, so no reply this script can author ' +
          'would pass containment against a statement the domain computed.)',
      );
      if (line.outcome === 'timeout') {
        throw new Error('a 500 ms upstream was reported as a timeout; the outcome is not measured');
      }
    } finally {
      await closeServer(fastUpstream);
    }
  } finally {
    await probeApi.stop();
    process.stdout.write(
      `STOPPED private APIs on ports ${String(API_PORT)} and ${String(PROBE_API_PORT)}, and both upstream stand-ins\n`,
    );
  }
}

await main();
