/**
 * T-25-03's server-side half: recommendations without AI, measured at the socket and in the
 * server's own log line.
 *
 * Run with `npx tsx e2e/perf/apiLatency.ts` from the repository root. It starts one private API
 * instance, measures, and stops it — nothing is left listening.
 *
 * **Two figures, because they answer different questions.** The client-side wall clock around
 * `fetch` is what a caller waits for; `durationMs` from TSD §5.8's structured line is what the
 * pipeline spent. Reported side by side so a miss says where the time went rather than leaving a
 * reader to guess. The browser-observed figure — round trip plus decode plus render — is in
 * `recommendations.perf.spec.ts`.
 *
 * **The `aiEnabled: true` arm is reported and is NOT a model figure.** `AI_FAKE=true` replaces the
 * HTTP call to Ollama with a deterministic echo, so the explanation lane's cost here is prompt
 * construction, schema validation and containment, and nothing else. It is the floor, and it is
 * labelled as one. PRD §10.1 puts a warm explanation at ~5 s.
 */

import { performance } from 'node:perf_hooks';
import { emit, emitNote, emitProbe } from './stats.js';
import {
  closeServer,
  logRecords,
  numberField,
  startApi,
  startDelayProxy,
  stringField,
} from './serverHarness.js';

const RUNS = 3;
const TARGET_MS = 2_000;
/** High ports, so a concurrent acceptance-suite run on 4000/19006 is never touched. */
const API_PORT = 4471;
/**
 * Two proxy ports, not one reused.
 *
 * Closing a server and immediately starting another on the same port left undici's connection
 * pool holding a socket to the dead one, and the next request died `ECONNRESET`. Observed, not
 * anticipated — and worth recording, because the same shape would make a retry look like a flake.
 */
const PROXY_FAST_PORT = 4472;
const PROXY_SLOW_PORT = 4473;
const PROXY_DELAY_MS = 500;

/** `recommendationRequestSchema` is a `z.strictObject`, so every field below is required. */
function requestBody(aiEnabled: boolean): string {
  return JSON.stringify({
    mealPeriod: 'lunch',
    aiEnabled,
    preferences: {
      diet: 'regular',
      allergies: [],
      goal: 'balanced',
      budget: 'medium',
      dislikedIngredients: [],
    },
    favoriteMealIds: [],
  });
}

async function postRecommendations(port: number, aiEnabled: boolean): Promise<number> {
  const startedAt = performance.now();
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/recommendations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:19006' },
    body: requestBody(aiEnabled),
  });
  // Drain the body before stopping the clock: a figure taken at the headers would exclude the
  // payload the caller actually needs.
  const payload: unknown = await response.json();
  const elapsed = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`recommendations answered ${String(response.status)}`);
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('recommendations' in payload) ||
    !Array.isArray(payload.recommendations) ||
    payload.recommendations.length !== 3
  ) {
    throw new Error('recommendations did not return three meals; the figure would be meaningless');
  }
  return elapsed;
}

/**
 * Wait until the server has written `expected` request log lines for this route.
 *
 * **The log line is emitted on the response's `finish` event, which fires after `fetch` resolves**
 * — so reading stdout immediately and taking the last three yielded the WARM-UP plus two runs, and
 * the warm-up is systematically slower. The first draft of this script reported a server duration
 * of 32 ms against a client wall clock of 11.4 ms, which is impossible and is what exposed the
 * off-by-one. A figure that cannot be true is the useful kind of wrong.
 */
async function waitForDurations(
  lines: readonly string[],
  expected: number,
  timeoutMs: number,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (serverDurations(lines).length < expected) {
    if (Date.now() > until) {
      throw new Error(
        `only ${String(serverDurations(lines).length)} of ${String(expected)} log lines arrived`,
      );
    }
    await new Promise((settle) => setTimeout(settle, 20));
  }
}

/** `durationMs` from the request log lines for this route, in order. */
function serverDurations(lines: readonly string[]): readonly number[] {
  const values: number[] = [];
  for (const record of logRecords(lines)) {
    if (stringField(record, 'routeTemplate') === '/api/v1/recommendations') {
      const duration = numberField(record, 'durationMs');
      if (duration !== undefined) {
        values.push(duration);
      }
    }
  }
  return values;
}

async function main(): Promise<void> {
  const api = await startApi(API_PORT, {
    AI_FAKE: 'true',
    AI_ENABLED: 'true',
    // Deliberately absent, exactly as e2e/playwright.config.ts leaves it: OLLAMA_BASE_URL.
  });
  try {
    // One warm-up call, discarded. The first request after boot pays the in-memory index's first
    // touch and V8's first optimisation pass; averaging it in produces a "warm" figure that is
    // neither warm nor cold.
    await postRecommendations(API_PORT, false);
    await waitForDurations(api.stdout, 1, 5_000);
    const afterWarmup = serverDurations(api.stdout).length;

    const noAi: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      noAi.push(await postRecommendations(API_PORT, false));
    }
    await waitForDurations(api.stdout, afterWarmup + RUNS, 5_000);
    const noAiServer = serverDurations(api.stdout).slice(afterWarmup, afterWarmup + RUNS);
    const afterNoAi = afterWarmup + RUNS;

    const withFake: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      withFake.push(await postRecommendations(API_PORT, true));
    }
    await waitForDurations(api.stdout, afterNoAi + RUNS, 5_000);
    const withFakeServer = serverDurations(api.stdout).slice(afterNoAi, afterNoAi + RUNS);

    emit({
      row: 'T-25-03s',
      what: 'POST /api/v1/recommendations, aiEnabled=false — wall clock at the socket',
      targetMs: TARGET_MS,
      runsMs: noAi,
      note:
        `private server instance on port ${String(API_PORT)} started by this script and stopped ` +
        'in a finally; AI_FAKE=true, AI_ENABLED=true, OLLAMA_BASE_URL unset; node fetch over ' +
        'loopback, body drained before the clock stops; one warm-up request discarded (catalog ' +
        'resident after boot, SDD §11); aiEnabled=false in the body, which is the user’s own ' +
        'switch and the state PRD §10.1’s "without AI" row describes; eleven other agents active ' +
        'in this tree, four of them able to run the acceptance suite concurrently.',
    });
    emit({
      row: 'T-25-03t',
      what: 'the same three requests as the SERVER measured them (TSD §5.8 durationMs)',
      targetMs: TARGET_MS,
      runsMs: noAiServer,
      note:
        'read out of the structured request log line this script’s own child process wrote. The ' +
        'gap to T-25-03s is connection setup, JSON serialisation and loopback transfer.',
    });
    emit({
      row: 'T-25-03u',
      what: 'POST /api/v1/recommendations, aiEnabled=true UNDER AI_FAKE — a floor, not a model figure',
      targetMs: null,
      runsMs: withFake,
      note:
        'AI_FAKE replaces only the HTTP call to Ollama, so the explanation lane still builds three ' +
        'prompts, validates three replies against explanationReplySchema and runs containment on ' +
        'each. What is missing is inference. PRD §10.1 puts a warm explanation at ~5 s with a hard ' +
        '12 s timeout, so this figure is a LOWER BOUND on the AI-enabled path and must never be ' +
        'quoted as that path’s latency.',
    });
    emitNote(
      'T-25-03',
      `server-side durations, aiEnabled=true under AI_FAKE: ${withFakeServer
        .map((value) => value.toFixed(1))
        .join(', ')} ms; the discarded warm-up request measured ${
        serverDurations(api.stdout)[0]?.toFixed(1) ?? 'n/a'
      } ms server-side, which is why it is discarded`,
    );

    // --- sensitivity. Both arms go through a forwarding proxy, so the difference between them is
    // the injected delay and not the proxy's own overhead.
    const fast = startDelayProxy(PROXY_FAST_PORT, API_PORT, 0);
    const slow = startDelayProxy(PROXY_SLOW_PORT, API_PORT, PROXY_DELAY_MS);
    let baseline: number;
    let probed: number;
    try {
      await postRecommendations(PROXY_FAST_PORT, false);
      baseline = await postRecommendations(PROXY_FAST_PORT, false);
      await postRecommendations(PROXY_SLOW_PORT, false);
      probed = await postRecommendations(PROXY_SLOW_PORT, false);
    } finally {
      await closeServer(fast);
      await closeServer(slow);
    }
    emitProbe(
      'T-25-03',
      `a forwarding proxy that delays the request by ${String(PROXY_DELAY_MS)} ms`,
      PROXY_DELAY_MS,
      baseline,
      probed,
    );
    if (probed - baseline < PROXY_DELAY_MS / 2) {
      throw new Error(
        `the harness did not report an injected ${String(PROXY_DELAY_MS)} ms delay; it is not measuring the request`,
      );
    }
  } finally {
    await api.stop();
    process.stdout.write(`STOPPED private API on port ${String(API_PORT)}\n`);
  }
}

await main();
