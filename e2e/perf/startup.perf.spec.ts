/**
 * T-25-01 — app start to usable Home, against PRD §10.1's ≤ 2.5 s.
 *
 * **"Usable" is a definition this file has to state and defend, because PRD §10.1 does not give
 * one and the three candidates are far apart.**
 *
 *  - *First paint* is dishonest. `SplashSurface` paints while `useFonts` and hydration are still
 *    running, so a first-paint figure measures the bundle's first byte of work and nothing the
 *    user came for.
 *  - *The period heading* is dishonest in the opposite direction, and it is the tempting one
 *    because it is fast and cannot fail: `home-period` renders from `mealPeriodForDate` on the
 *    FIRST render before any request exists, and `useRecommendations.ts:11-16` says so — T-15-01's
 *    acceptance is that the heading is there *with the server down*. A figure ending there would
 *    be true with no server at all, which is a number nothing could falsify.
 *  - *Three recommendation cards present* is what PRD §13 calls the product, it is the only state
 *    `HomeScreen` reaches at `state.kind === 'loaded'`, and it is the first moment Home is usable
 *    for the thing Home exists to do. That is the boundary used here.
 *
 * **"After first launch" cannot mean the literal first launch.** P14 gave the app an onboarding
 * gate, so an empty device correctly lands on Onboarding and never reaches Home at all
 * (`e2e/support/appPhase.ts` exists for exactly this). The reading measured here is *a launch of
 * an already-onboarded device*, and it is recorded as a reading rather than assumed.
 *
 * **What this figure is NOT.** It is the Expo web export served by `e2e/serveExport.mjs`, which
 * sends `Cache-Control: no-store` and no compression of any kind — so every measured navigation
 * re-downloads a 4.3 MB uncompressed bundle. Both properties are correct for a test fixture ("a
 * spec must never read the previous build's bundle") and `serveExport.mjs` must not be changed to
 * flatter a measurement. The figure is therefore split: bytes-on-the-wire up to the bundle's
 * `responseEnd`, and the app's own work from there to three cards. There is no native figure.
 */

import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  installInstrument,
  readMarks,
  readNavigationTiming,
  requireMark,
  waitForMark,
} from './instrument.js';
import { seedBeforeFirstScript } from './seed.js';
import { emit, emitNote, emitProbe } from './stats.js';

/** Plan P25 Part 4. */
const RUNS = 3;
/** PRD §10.1, transcribed in CONTRACTS Amendment 12. */
const TARGET_MS = 2_500;
/** Generous: a failure to reach the boundary must read as a failure, not as a slow figure. */
const BOUNDARY_TIMEOUT_MS = 60_000;
/** Expo writes the web bundle under this path. */
const BUNDLE_GLOB = '**/_expo/static/js/**';

interface StartSample {
  /** Navigation start → three recommendation cards in the document. */
  readonly totalMs: number;
  /** Navigation start → the main bundle finished arriving. Harness-dependent. */
  readonly transferMs: number;
  /** Bundle arrival → three cards. The part the app itself owns. */
  readonly appWorkMs: number;
  readonly bundleDecodedBytes: number;
}

/**
 * Which launch is being measured, and the difference is not small.
 *
 * - `cold` — a fresh context, an empty HTTP cache, storage seeded from an init script, and
 *   **one** navigation. This is the figure reported against 2.5 s.
 * - `second-navigation` — the SAME seeding, but with one navigation already made, so the measured
 *   one is the second parse of the same 1.7 MiB bundle in one renderer and hits V8's in-process
 *   code cache. Measured only to attribute that difference, and never reported as app start.
 *
 * Seeding is identical in both arms, so the warm renderer is the only variable. The first draft of
 * this arm used the sequence an e2e helper naturally produces — load, `page.evaluate` the seed,
 * load — and it **timed out once in four runs**: the app is on Onboarding during that first
 * navigation, and its own hydration can write its defaults back over the seed, after which the
 * measured navigation lands on Onboarding again and the third card never appears. A flaky arm in a
 * measurement harness is worse than a missing attribution, so the race is removed rather than
 * retried.
 */
type StartMode = 'cold' | 'second-navigation';

interface StartOptions {
  readonly aiEnabled: boolean;
  readonly mode?: StartMode;
  /** Injected stall on the bundle response. The sensitivity probe (§6.1i). */
  readonly bundleDelayMs?: number;
  /** Route the bundle through an interceptor even at zero delay, so a probe pair is comparable. */
  readonly intercept?: boolean;
}

async function measureStart(browser: Browser, options: StartOptions): Promise<StartSample> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await seedBeforeFirstScript(page, { aiEnabled: options.aiEnabled });

    if ((options.mode ?? 'cold') !== 'cold') {
      // One unmeasured navigation, purely to warm the renderer. Waited out to the tab bar so the
      // second navigation starts from a settled app rather than from a half-hydrated one.
      await page.goto('/');
      await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 30_000 });
    }

    await installInstrument(page);

    if (options.intercept === true) {
      const delay = options.bundleDelayMs ?? 0;
      await page.route(BUNDLE_GLOB, async (route) => {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        await route.continue();
      });
    }

    // The measured navigation. On the `cold` path this is the context's FIRST navigation, so the
    // bundle is downloaded and parsed cold, with the envelope already in storage.
    await page.goto('/');
    await waitForMark(page, 'cards3', BOUNDARY_TIMEOUT_MS);
    const marks = await readMarks(page);
    const timing = await readNavigationTiming(page);

    // After the fact, and deliberately so: a Playwright assertion is confirmation that the
    // instrument stamped the state it claims, never part of the interval.
    await expect(page.getByTestId('home-recommendations')).toBeVisible();
    await expect(page.locator('[data-testid^="recommendation-"]')).toHaveCount(3);

    const totalMs = requireMark(marks, 'cards3');
    return {
      totalMs,
      transferMs: timing.bundleResponseEnd,
      appWorkMs: totalMs - timing.bundleResponseEnd,
      bundleDecodedBytes: timing.bundleDecodedBytes,
    };
  } finally {
    await context.close();
  }
}

const METHOD_AI_ON =
  'COLD: fresh browser context, empty HTTP cache, ONE navigation, storage seeded from an init ' +
  'script so no earlier parse warms V8. Web export (apps/mobile/dist, built before this run) ' +
  'served by e2e/serveExport.mjs with Cache-Control: no-store and NO compression; viewport ' +
  'phone-375 (375x812, Desktop Chrome); boundary = navigation start (performance.timeOrigin) to ' +
  'the MutationObserver frame on which the third [data-testid^="recommendation-"] node is in the ' +
  'document; the seeded envelope makes this a launch of an ALREADY-ONBOARDED device; API warm on ' +
  'port 4000 with AI_FAKE=true and OLLAMA_BASE_URL unset; aiEnabled=true in preferences, so the ' +
  'explanation lane runs its deterministic echo rather than a model — this figure is OPTIMISTIC ' +
  'against a machine that has one; eleven other agents active in the tree.';

const METHOD_AI_OFF =
  'as above but aiEnabled=false in the seeded preferences, so no explanation lane runs at all. ' +
  'This is the only one of the two figures that is independent of whether a model is present.';

test('T-25-01 app start to three recommendation cards, AI enabled', async ({ browser }) => {
  const samples: StartSample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await measureStart(browser, { aiEnabled: true }));
  }

  emit({
    row: 'T-25-01',
    what: 'navigation start -> three recommendation cards (aiEnabled=true, AI_FAKE)',
    targetMs: TARGET_MS,
    runsMs: samples.map((sample) => sample.totalMs),
    note: METHOD_AI_ON,
  });
  emit({
    row: 'T-25-01a',
    what: 'sub-figure: navigation start -> main bundle responseEnd (HARNESS, not the app)',
    targetMs: null,
    runsMs: samples.map((sample) => sample.transferMs),
    note: 'uncompressed, no-store; this half describes e2e/serveExport.mjs, not the product.',
  });
  emit({
    row: 'T-25-01b',
    what: 'sub-figure: main bundle responseEnd -> three cards (the app’s own work)',
    targetMs: null,
    runsMs: samples.map((sample) => sample.appWorkMs),
    note: 'parse, hydrate, fonts, one recommendations round trip, render.',
  });
  emitNote(
    'T-25-01',
    `main bundle decoded size ${String(Math.round((samples[0]?.bundleDecodedBytes ?? 0) / 1024))} KiB`,
  );

  // Attribution, not a figure: how much of the cold number is the cold parse.
  const warm: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    warm.push(
      (await measureStart(browser, { aiEnabled: true, mode: 'second-navigation' })).totalMs,
    );
  }
  emit({
    row: 'T-25-01d',
    what: 'attribution: the SECOND navigation in one context (warm V8 code cache) — not app start',
    targetMs: null,
    runsMs: warm,
    note:
      'the load-seed-load sequence an e2e helper naturally produces. Reported only so the gap ' +
      'between this and the cold figure is on the record rather than hidden inside it.',
  });
});

test('T-25-01 app start to three recommendation cards, AI disabled', async ({ browser }) => {
  const samples: StartSample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await measureStart(browser, { aiEnabled: false }));
  }
  emit({
    row: 'T-25-01c',
    what: 'navigation start -> three recommendation cards (aiEnabled=false)',
    targetMs: TARGET_MS,
    runsMs: samples.map((sample) => sample.totalMs),
    note: METHOD_AI_OFF,
  });
});

/**
 * The sensitivity probe.
 *
 * **Both arms go through the route interceptor**, so the difference between them is the injected
 * stall and not Playwright's interception overhead. A harness whose number does not move under a
 * 600 ms stall on the bundle is not measuring app start.
 */
test('T-25-01 probe: a 600 ms stall on the bundle moves the figure', async ({ browser }) => {
  const baseline = await measureStart(browser, {
    aiEnabled: true,
    intercept: true,
    bundleDelayMs: 0,
  });
  const probed = await measureStart(browser, {
    aiEnabled: true,
    intercept: true,
    bundleDelayMs: 600,
  });
  emitProbe(
    'T-25-01',
    'page.route stall on **/_expo/static/js/** (load-time substitution, no file written)',
    600,
    baseline.totalMs,
    probed.totalMs,
  );
  expect(
    probed.totalMs - baseline.totalMs,
    'the harness must report an injected 600 ms stall; a timing harness that reports a constant is a test that cannot fail',
  ).toBeGreaterThan(300);
});
