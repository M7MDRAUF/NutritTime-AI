/**
 * T-25-03 — recommendations without AI, against PRD §10.1's ≤ 2 s.
 *
 * **"Without AI" is two different states, and the record has to name which one.** Either
 * `aiEnabled: false` in the request body — the user's own switch, sent from preferences by
 * `useRecommendations` — or `AI_ENABLED=false` on the server. The figure here is the former,
 * because it is the state a user can actually put themselves in, and because the server-level flag
 * additionally suppresses the chat route and so measures a different product.
 *
 * **What is measured here is the USER-observed figure**, which is the one PRD §10.1's row means:
 * a user waits for recommendations, and the wait includes the round trip, the client decode
 * through `mealSchema` and the render — none of which a server-side duration contains. The
 * server-side figure for the same request is taken separately by `apiLatency.ts`, against a
 * private server instance whose stdout can be read, and the two are reported side by side so a
 * miss says where the time went instead of leaving a reader to guess.
 *
 * Boundary: the `fetch` for `/api/v1/recommendations` leaving the page, to the frame on which the
 * third recommendation card is in the document. The bundle download and parse are deliberately
 * outside it — those belong to T-25-01, and including them here would report app start twice under
 * two different targets.
 */

import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  installInstrument,
  readFetches,
  readMarks,
  requireMark,
  waitForMark,
} from './instrument.js';
import { seedBeforeFirstScript } from './seed.js';
import { emit, emitNote, emitProbe } from './stats.js';

const RUNS = 3;
const TARGET_MS = 2_000;
const BOUNDARY_TIMEOUT_MS = 60_000;
const RECOMMENDATIONS_URL = '**/api/v1/recommendations';

interface RecommendationSample {
  /** Request dispatched → three cards in the document. */
  readonly observedMs: number;
  /** Request dispatched → response settled, as the page saw it. */
  readonly roundTripMs: number;
}

async function measure(browser: Browser, injectedDelayMs: number): Promise<RecommendationSample> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await seedBeforeFirstScript(page, { aiEnabled: false });
    await installInstrument(page);

    // Always through the interceptor, at zero delay for the baseline, so the probe pair differs
    // only by the injected stall and not by Playwright's interception overhead.
    await page.route(RECOMMENDATIONS_URL, async (route) => {
      if (injectedDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, injectedDelayMs));
      }
      await route.continue();
    });

    await page.goto('/');
    await waitForMark(page, 'cards3', BOUNDARY_TIMEOUT_MS);
    const marks = await readMarks(page);
    const fetches = await readFetches(page);

    await expect(page.locator('[data-testid^="recommendation-"]')).toHaveCount(3);

    const request = fetches.find((record) => record.url.includes('/api/v1/recommendations'));
    if (request === undefined) {
      throw new Error('no /api/v1/recommendations request was observed');
    }
    return {
      observedMs: requireMark(marks, 'cards3') - request.start,
      roundTripMs: request.end - request.start,
    };
  } finally {
    await context.close();
  }
}

const METHOD =
  'aiEnabled=false in the seeded preferences, so the request body carries the user’s own switch ' +
  'off and no explanation lane runs. Boundary: the page’s own fetch dispatch for ' +
  '/api/v1/recommendations to the MutationObserver frame carrying the third recommendation card — ' +
  'bundle download and parse are OUTSIDE it, because those are T-25-01. Web export served by ' +
  'e2e/serveExport.mjs; viewport phone-375; API warm on port 4000 (catalog resident after boot, ' +
  'SDD §11 — a cold-boot figure would be measuring readFileSync of meals.json, which no user ' +
  'experiences); every run goes through a zero-delay page.route interceptor so the probe pair is ' +
  'comparable; eleven other agents active in the tree.';

test('T-25-03 recommendations without AI, user-observed', async ({ browser }) => {
  const samples: RecommendationSample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await measure(browser, 0));
  }

  emit({
    row: 'T-25-03',
    what: 'recommendations request dispatched -> three cards rendered (aiEnabled=false)',
    targetMs: TARGET_MS,
    runsMs: samples.map((sample) => sample.observedMs),
    note: METHOD,
  });
  emit({
    row: 'T-25-03a',
    what: 'attribution: the HTTP round trip alone, as the page saw it',
    targetMs: null,
    runsMs: samples.map((sample) => sample.roundTripMs),
    note: 'dispatch to response settled. The remainder of T-25-03 is decode plus render.',
  });
  emitNote(
    'T-25-03',
    'the server-side duration for the same request is in apiLatency.ts’s output, taken against a ' +
      'private instance whose structured log line can be read.',
  );
});

/**
 * The sensitivity probe.
 *
 * A 400 ms stall injected into the recommendations response at the network layer, through
 * `page.route` — a load-time substitution (§6.1i), with no repository file opened for writing.
 */
test('T-25-03 probe: a 400 ms stall on the response moves the figure', async ({ browser }) => {
  const baseline = await measure(browser, 0);
  const probed = await measure(browser, 400);
  emitProbe(
    'T-25-03',
    'page.route stall on **/api/v1/recommendations',
    400,
    baseline.observedMs,
    probed.observedMs,
  );
  expect(
    probed.observedMs - baseline.observedMs,
    'the harness must report an injected 400 ms stall on the recommendations response',
  ).toBeGreaterThan(200);
});
