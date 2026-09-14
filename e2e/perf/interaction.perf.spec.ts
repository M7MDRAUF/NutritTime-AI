/**
 * T-25-02 — local navigation, search and filtering, against PRD §10.1's ≤ 150 ms.
 *
 * **The qualifier "over the meals already loaded" is load-bearing, and of the three operations
 * the row names, exactly one is local.** `exploreFilters.ts:8-10` states the design outright —
 * "No filtering logic lives here. The chips choose parameters; the server filters, through the
 * domain" — and `useMealSearch.ts` debounces the text 300 ms and then issues `client.listMeals`
 * over HTTP. `SavedScreen.tsx` has no search box at all. So:
 *
 *  - **navigation** is local and is measured against 150 ms;
 *  - **search** is a 300 ms design constant (`SEARCH_DEBOUNCE_MS`, SDD §11) followed by a round
 *    trip, and is reported as two parts that must never be summed and quoted against 150 ms;
 *  - **filtering** is the same round trip with the debounce at 0.
 *
 * **A keystroke-to-results figure would miss 150 ms by construction** — the deliberate debounce
 * alone is double the budget — and P25 Part 5 then forbids relaxing the target, so an unexamined
 * execution of this row would freeze a false limitation into the record. The inverse lie is just
 * as available: measuring only tab navigation and titling the row with PRD's full wording, so a
 * reader believes search was measured at 150 ms. Neither is done here.
 *
 * **Boundary for navigation:** the capture-phase `pointerdown` on the tab control, to the frame
 * after the destination screen's root test id first has a client rect. Keyed on the rect and not
 * on the node, because a visited tab screen stays mounted and is hidden by a `display: none`
 * ancestor — a presence-keyed boundary would fire once and never again.
 *
 * **Three runs of ten interactions, not three interactions.** One garbage-collection pause or one
 * missed frame is 16–50 ms, a third of the budget, so three samples would disagree with each other
 * by more than the quantity under test. Part 4's three runs are three *sessions*; each reports its
 * own median over ten interactions, and the median-and-worst is taken across the three.
 */

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import {
  armInteraction,
  armRowChange,
  installInstrument,
  readFetches,
  readMarks,
  requireMark,
  waitForMark,
} from './instrument.js';
import { seedBeforeFirstScript } from './seed.js';
import { emit, emitNote, emitProbe, median, worst } from './stats.js';

const RUNS = 3;
const REPETITIONS = 10;
const TARGET_MS = 150;
const BOUNDARY_TIMEOUT_MS = 20_000;
/** SDD §11 and `useMealSearch.ts`'s `SEARCH_DEBOUNCE_MS`. A constant, not a measurement. */
const DESIGN_DEBOUNCE_MS = 300;

/** The five tabs, with the root test id each destination paints. */
const TABS = [
  { tab: 'Home', screen: 'home-screen' },
  { tab: 'Explore', screen: 'explore-screen' },
  { tab: 'Assistant', screen: 'assistant-screen' },
  { tab: 'Saved', screen: 'saved-screen' },
  { tab: 'Settings', screen: 'settings-screen' },
] as const;

async function enterWarmApp(
  browser: Browser,
  busyWaitMs = 0,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await seedBeforeFirstScript(page, { aiEnabled: false });
  await installInstrument(page, busyWaitMs);
  await page.goto('/');
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 30_000 });

  // A warm-up lap of every tab, so no measured interaction pays a first lazy mount. React
  // Navigation renders a tab screen on first visit and keeps it mounted, so the first tap is a
  // different measurement and must not be averaged in.
  for (const { tab, screen } of TABS) {
    await page.getByRole('tab', { name: tab }).click();
    await expect(page.getByTestId(screen)).toBeVisible({ timeout: BOUNDARY_TIMEOUT_MS });
  }
  await page.getByRole('tab', { name: 'Home' }).click();
  await expect(page.getByTestId('home-screen')).toBeVisible();

  return {
    page,
    close: async () => {
      await context.close();
    },
  };
}

/** One tap: arm, click, wait for the page's own stamp, read it. */
async function measureTabTap(page: Page, tab: string, screen: string): Promise<number> {
  await armInteraction(page, screen);
  await page.getByRole('tab', { name: tab }).click();
  await waitForMark(page, 'paint', BOUNDARY_TIMEOUT_MS);
  const marks = await readMarks(page);
  return requireMark(marks, 'paint') - requireMark(marks, 't0');
}

async function measureSession(page: Page): Promise<readonly number[]> {
  const samples: number[] = [];
  for (let index = 0; index < REPETITIONS; index += 1) {
    // Cycle forward through the five tabs, so each sample is a different destination and no
    // single screen's cost dominates the session median.
    const next = TABS[(index + 1) % TABS.length];
    if (next === undefined) {
      throw new Error('tab table is empty');
    }
    samples.push(await measureTabTap(page, next.tab, next.screen));
  }
  return samples;
}

test('T-25-02 local tab navigation', async ({ browser }) => {
  const sessionMedians: number[] = [];
  const sessionWorsts: number[] = [];
  const all: number[] = [];

  for (let run = 0; run < RUNS; run += 1) {
    const { page, close } = await enterWarmApp(browser);
    try {
      const samples = await measureSession(page);
      sessionMedians.push(median(samples));
      sessionWorsts.push(worst(samples));
      all.push(...samples);
      emitNote(
        'T-25-02',
        `session ${String(run + 1)} raw (${String(REPETITIONS)} taps): ${samples
          .map((value) => value.toFixed(1))
          .join(', ')}`,
      );
    } finally {
      await close();
    }
  }

  emit({
    row: 'T-25-02',
    what: 'tab pointerdown -> destination screen’s first painted frame (LOCAL navigation)',
    targetMs: TARGET_MS,
    runsMs: sessionMedians,
    note:
      'three sessions, each the median of ten taps cycling all five tabs; a warm-up lap precedes ' +
      'every session so no sample pays a first lazy mount. Boundary stamped in-page: capture-phase ' +
      'pointerdown, then the requestAnimationFrame after the destination root first has a client ' +
      'rect (so it includes one frame of paint). Web export served by e2e/serveExport.mjs, ' +
      'viewport phone-375, aiEnabled=false, API warm on 4000 with AI_FAKE=true. rAF granularity ' +
      'is ~16.7 ms, which is 11% of this budget and is not subtracted. Eleven other agents active.',
  });
  emit({
    row: 'T-25-02',
    what: 'worst tap within each session (the figure Part 4 calls "worst")',
    targetMs: TARGET_MS,
    runsMs: sessionWorsts,
    note: 'the slowest single tap of each session of ten, which is what a user meets occasionally.',
  });
  emitNote(
    'T-25-02',
    `all ${String(all.length)} taps: median ${median(all).toFixed(1)} ms, worst ${worst(all).toFixed(1)} ms`,
  );
});

/**
 * Wait for Explore to hold rows, and name the state it reached if it does not.
 *
 * `ExploreScreen` renders five mutually exclusive states and only one of them has a list. A bare
 * `toBeVisible('explore-list')` reports "element not found", which sends the reader looking at the
 * locator when the answer is that the screen is offline, empty or still loading — the same
 * complaint `serveExport.mjs` records about a server that 404s everything.
 */
async function openExploreList(page: Page): Promise<void> {
  const states = ['explore-list', 'explore-empty', 'explore-offline', 'explore-error'] as const;
  await page
    .locator(states.map((id) => `[data-testid="${id}"]`).join(', '))
    .first()
    .waitFor({ state: 'visible', timeout: BOUNDARY_TIMEOUT_MS });
  for (const id of states) {
    if ((await page.getByTestId(id).count()) > 0) {
      if (id !== 'explore-list') {
        throw new Error(`Explore reached '${id}' rather than a list of rows`);
      }
      return;
    }
  }
  throw new Error('Explore reached no terminal state');
}

/** One armed interaction's outcome: what the page stamped, and when the request went out. */
async function readInteraction(
  page: Page,
  from: 't0' | 'keyLast',
): Promise<{ readonly dispatchMs: number; readonly totalMs: number }> {
  await waitForMark(page, 'rowsPaint', BOUNDARY_TIMEOUT_MS);
  const marks = await readMarks(page);
  const request = (await readFetches(page)).find((record) => record.url.includes('/api/v1/meals'));
  if (request === undefined) {
    throw new Error('no /api/v1/meals request was observed');
  }
  const start = requireMark(marks, from);
  return {
    dispatchMs: request.start - start,
    totalMs: requireMark(marks, 'rowsPaint') - start,
  };
}

test('T-25-02 search and filtering, split into debounce and round trip', async ({ browser }) => {
  const debounces: number[] = [];
  const searchTrips: number[] = [];
  const chipEmptyBox: number[] = [];
  const chipWithText: number[] = [];

  for (let run = 0; run < RUNS; run += 1) {
    const { page, close } = await enterWarmApp(browser);
    try {
      await page.getByRole('tab', { name: 'Explore' }).click();
      await openExploreList(page);

      // --- (1) a chip tap with the search box EMPTY. `useMealSearch.ts:110` sets the delay to 0
      // when the search text is blank, so this is the no-debounce path.
      //
      // The three steps are chosen so every one of them provably changes the rendered row set,
      // read off `packages/catalog/meals.json`: 60 meals, 19 vegetarian, 11 matching "chick" and
      // 1 that is both. 20 rows -> 19 -> 1 -> 11. A step that left the ids identical would hang
      // the detector rather than report a zero, which is the failure mode to avoid.
      await armRowChange(page);
      await page.getByTestId('chip-diet-vegetarian').click();
      chipEmptyBox.push((await readInteraction(page, 't0')).totalMs);

      // --- (2) search. `pressSequentially`, not `fill`: `fill` sets the value and dispatches one
      // input event with no keydown at all, so there would be no keystroke to measure from.
      await armRowChange(page);
      await page
        .getByTestId('explore-search')
        .locator('input, textarea')
        .pressSequentially('chick');
      const search = await readInteraction(page, 'keyLast');
      debounces.push(search.dispatchMs);
      searchTrips.push(search.totalMs - search.dispatchMs);

      // --- (3) the SAME chip action with text now in the box: tapping the selected diet chip
      // again clears it. See the emitted note — this is the pair, and no single constant
      // satisfies both halves of it.
      await armRowChange(page);
      await page.getByTestId('chip-diet-vegetarian').click();
      chipWithText.push((await readInteraction(page, 't0')).totalMs);
    } finally {
      await close();
    }
  }

  emit({
    row: 'T-25-02e',
    what: 'search: last keystroke -> request dispatched (the DELIBERATE debounce)',
    targetMs: null,
    runsMs: debounces,
    note:
      `SEARCH_DEBOUNCE_MS = ${String(DESIGN_DEBOUNCE_MS)} (SDD §11) is a design constant, not a ` +
      'latency. It is reported so that nobody sums it with the round trip below and quotes the ' +
      'total against PRD §10.1’s 150 ms, which would record a false miss of a target that was ' +
      'never about the debounce.',
  });
  emit({
    row: 'T-25-02f',
    what: 'search: request dispatched -> result rows painted (a ROUND TRIP, not local)',
    targetMs: null,
    runsMs: searchTrips,
    note:
      'no document sets a threshold for a server-side search; PRD §10.1’s 150 ms is written for a ' +
      'local operation over "the meals already loaded", and no such path exists in the app. None ' +
      'is asserted here.',
  });
  emit({
    row: 'T-25-02g',
    what: 'filter chip with the search box EMPTY: pointerdown -> rows painted (no debounce)',
    targetMs: null,
    runsMs: chipEmptyBox,
    note: 'server-side filtering through the domain (exploreFilters.ts:8-10). No documented target.',
  });
  emit({
    row: 'T-25-02h',
    what: 'filter chip with TEXT in the search box: pointerdown -> rows painted',
    targetMs: null,
    runsMs: chipWithText,
    note:
      'the same chip action as T-25-02g, differing only in whether the search box holds text. ' +
      'useMealSearch.ts:110 reads `search.trim() === "" ? 0 : debounceMs`, so the delay is keyed ' +
      'on the TEXT and not on what changed — and the docstring immediately above it says "a ' +
      'filter change fires immediately and a text change waits ... set to 0 for everything but ' +
      '`search`", which is not what the line does. Measured rather than asserted.',
  });
  emitNote(
    'T-25-02',
    'T-25-02g/h are the control pair: a chip tap costs ' +
      `${median(chipEmptyBox).toFixed(1)} ms with an empty box and ` +
      `${median(chipWithText).toFixed(1)} ms with text in it, and no constant satisfies both.`,
  );
});

/**
 * The sensitivity probe for the navigation figure.
 *
 * The stall is burned inside the capture-phase `pointerdown` handler **after** t0 is stamped, so
 * it lands inside the measured interval. Injected at load time through `addInitScript` (§6.1i): no
 * repository file is opened for writing at any point.
 */
test('T-25-02 probe: an 80 ms stall inside the tap moves the figure', async ({ browser }) => {
  const baselineSession = await enterWarmApp(browser, 0);
  let baseline: number;
  try {
    baseline = median(await measureSession(baselineSession.page));
  } finally {
    await baselineSession.close();
  }

  const probedSession = await enterWarmApp(browser, 80);
  let probed: number;
  try {
    probed = median(await measureSession(probedSession.page));
  } finally {
    await probedSession.close();
  }

  emitProbe(
    'T-25-02',
    'synchronous 80 ms stall inside the stamped pointerdown handler',
    80,
    baseline,
    probed,
  );
  expect(
    probed - baseline,
    'the harness must report an injected 80 ms stall on a 150 ms budget, or it cannot distinguish a pass from a miss',
  ).toBeGreaterThan(40);
});
