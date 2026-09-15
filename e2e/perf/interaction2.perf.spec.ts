/**
 * T-25-02, second pass — **what is actually local**, and what is a round trip wearing PRD §10.1's
 * wording. Full reasoning, every figure and the divergence: `docs/performance/interaction.md`.
 *
 * `interaction.perf.spec.ts` (READ-ONLY here) measured tab navigation against ≤ 150 ms and
 * established that neither search nor filtering is local. This file measures the three boundaries
 * it did not: **L-a** a chip's own `aria-checked` flip (`setFilters` → `isChipSelected`, no request
 * in the interval, and the whole of what is local about filtering); **L-b** a keystroke's echo,
 * observable because the first character into an empty box mounts `SearchField.tsx`'s clear
 * control; **L-c** the list render, `fetch` settled → new `meal-*` rows painted, the closest
 * boundary in this build to the row's own words. The composite paths are re-measured against **no
 * target** — a defect figure that gets quoted must be reproducible by a second harness, and
 * `useMealSearch.ts`'s `trimmed === '' || page > 1 ? 0 : debounceMs` keys the delay on whether the
 * box holds TEXT rather than on WHAT CHANGED, against its own docstring four lines above. RNW's
 * `Pressable` fires `onPress` on release, so a `pointerdown`-keyed boundary contains the driver's
 * down→up gap; `up` is stamped and REQUIRED, so a missing stamp fails rather than printing 0.
 * Marks come from `instrument.ts` and figures from `stats.ts`, so these are comparable with
 * `measurements.md`'s; the only addition is that `up` stamp, registered from here. `instrument.ts`
 * is not edited and nothing outside this file is written at any point (§6.1i).
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
import { emit, emitNote, emitProbe, median } from './stats.js';

const RUNS = 3;
const REPS = 5; // interactions per session; one missed frame is 16 ms of a 150 ms budget
const TARGET_MS = 150;
const BOUNDARY_TIMEOUT_MS = 20_000;
const CHIP = 'chip-diet-vegetarian';
const CLEAR = '[aria-label="Clear search"]'; // SearchField.tsx's CLEAR_LABEL, as RNW 0.21 renders it
const MEALS = '/api/v1/meals';
const CONFOUND =
  'Expo web export in apps/mobile/dist via e2e/serveExport.mjs, rebuilt by another agent at ' +
  '17:25 with the paging rewrite of this wave in it; viewport phone-375; aiEnabled=false; API ' +
  'on 4000, AI_FAKE=true; warm app; ~15 other agents active in this tree.';

interface SessionOptions {
  /** `apiDelayMs` is added to every meals request; `cpuRate` is CDP throttling, 1 being none. */
  readonly busyWaitMs?: number;
  readonly apiDelayMs?: number;
  readonly cpuRate?: number;
}
/** `gapMs` is `pointerdown`→`pointerup` and is inside `totalMs`; a keystroke has no pointer. */
interface LocalSample {
  readonly totalMs: number;
  readonly gapMs: number | undefined;
}
/** `totalMs` is `pointerdown`→rows painted (composite); `renderMs` is `fetch` settled→rows (L-c). */
interface TripSample {
  readonly totalMs: number;
  readonly renderMs: number;
}

/** Stamp `up` into the instrument's own marks, so the down→up gap is visible per interaction. */
function stampPointerUp(): void {
  document.addEventListener(
    'pointerup',
    () => {
      const state = window.__nutritimePerf;
      if (state !== undefined && state.marks['up'] === undefined) {
        state.marks['up'] = performance.now();
      }
    },
    true,
  );
}

/**
 * `body` against a warm Explore screen with rows on it. **Both arms of every probe pass through
 * the `page.route` interceptor**, delay 0 included, so a difference is the stall and not it.
 */
async function inSession<T>(
  browser: Browser,
  options: SessionOptions,
  body: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await seedBeforeFirstScript(page, { aiEnabled: false });
    await installInstrument(page, options.busyWaitMs ?? 0);
    await page.addInitScript(stampPointerUp);

    const apiDelayMs = options.apiDelayMs ?? 0;
    await page.route(`**${MEALS}*`, async (route) => {
      if (apiDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, apiDelayMs));
      }
      await route.continue();
    });
    const cpuRate = options.cpuRate ?? 1;
    if (cpuRate > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    }

    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: 'Explore' }).click();
    await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: BOUNDARY_TIMEOUT_MS });
    // Two settled chip round trips first, so nothing measured pays the filter path's lazy mount.
    // Through `measureTrip`, which waits for the ROWS: `settle` returns at response HEADERS, so
    // under an injected wire delay it leaves the display a step behind the chip and the next
    // detector waits for a change already made — the one failure this lane actually hit.
    await measureTrip(page, () => page.getByTestId(CHIP).click());
    await measureTrip(page, () => page.getByTestId(CHIP).click());
    return await body(page);
  } finally {
    await context.close();
  }
}

/** This interaction's list request, come back: records are pushed in a `finally`, and `armInteraction` cleared the array. */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    (url) => (window.__nutritimePerf?.fetches ?? []).some((one) => one.url.includes(url)),
    MEALS,
    { timeout: BOUNDARY_TIMEOUT_MS },
  );
}

/** One local interaction: arm on a selector, act, read the frame the page stamped. */
async function measureLocal(
  page: Page,
  target: string,
  from: 't0' | 'keyFirst',
  act: () => Promise<void>,
): Promise<LocalSample> {
  await armInteraction(page, target);
  await act();
  await waitForMark(page, 'paint', BOUNDARY_TIMEOUT_MS);
  const marks = await readMarks(page);
  const start = requireMark(marks, from);
  const gapMs = from === 't0' ? requireMark(marks, 'up') - start : undefined;
  return { totalMs: requireMark(marks, 'paint') - start, gapMs };
}
/** L-a: a chip tap's own `aria-checked` flip, search box empty, alternating on and off. */
async function chipStateSession(page: Page): Promise<readonly LocalSample[]> {
  const samples: LocalSample[] = [];
  for (let index = 0; index < REPS; index += 1) {
    // Read from the chip, never from the index: arming on a selector that ALREADY matches would
    // stamp `paint` on the next unrelated mutation and report a near-zero (BRIEF §6.2).
    const wanted =
      (await page.getByTestId(CHIP).getAttribute('aria-checked')) === 'true' ? 'false' : 'true';
    samples.push(
      await measureLocal(page, `[data-testid="${CHIP}"][aria-checked="${wanted}"]`, 't0', () =>
        page.getByTestId(CHIP).click(),
      ),
    );
    await settle(page);
  }
  return samples;
}

/** L-b: the first keystroke into an empty box, to the clear control's first painted frame. */
async function keystrokeSession(page: Page): Promise<readonly LocalSample[]> {
  const samples: LocalSample[] = [];
  const input = page.getByTestId('explore-search').locator('input, textarea');
  await input.click();
  for (let index = 0; index < REPS; index += 1) {
    samples.push(await measureLocal(page, CLEAR, 'keyFirst', () => input.press('c')));
    await settle(page);
    // `fill('')` dispatches one input event and no keydown, so the reset cannot be mistaken for a
    // sample. The empty box then re-requests with the delay at 0.
    await armInteraction(page, null);
    await input.fill('');
    await settle(page);
  }
  return samples;
}

/** One composite interaction, decomposed at the response boundary. */
async function measureTrip(page: Page, act: () => Promise<void>): Promise<TripSample> {
  await armRowChange(page);
  await act();
  await waitForMark(page, 'rowsPaint', BOUNDARY_TIMEOUT_MS);
  const marks = await readMarks(page);
  const request = (await readFetches(page)).find((one) => one.url.includes(MEALS));
  if (request === undefined) {
    throw new Error(`no ${MEALS} request was observed`);
  }
  const rowsPaint = requireMark(marks, 'rowsPaint');
  return { totalMs: rowsPaint - requireMark(marks, 't0'), renderMs: rowsPaint - request.end };
}

const medianOf = (samples: readonly LocalSample[]): number =>
  median(samples.map((one) => one.totalMs));

/** Three chip round trips' render halves, median. Sequential: two in flight share one mark set. */
async function renderMedian(page: Page): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    samples.push((await measureTrip(page, () => page.getByTestId(CHIP).click())).renderMs);
    await settle(page);
  }
  return median(samples);
}

test('T-25-02 what is local: a chip’s own state and a keystroke’s echo', async ({ browser }) => {
  const chipMedians: number[] = [];
  const keyMedians: number[] = [];
  const gaps: number[] = [];

  for (let run = 0; run < RUNS; run += 1) {
    await inSession(browser, {}, async (page) => {
      const chips = await chipStateSession(page);
      const keys = await keystrokeSession(page);
      chipMedians.push(medianOf(chips));
      keyMedians.push(medianOf(keys));
      gaps.push(median(chips.flatMap((one) => (one.gapMs === undefined ? [] : [one.gapMs]))));
      const raw = (set: readonly LocalSample[]): string =>
        set.map((one) => one.totalMs.toFixed(1)).join(', ');
      emitNote('T-25-02L', `session ${String(run + 1)}: chip ${raw(chips)} | key ${raw(keys)}`);
    });
  }

  emit({
    row: 'T-25-02i',
    what: 'LOCAL — filter chip: pointerdown → the chip’s own aria-checked flip, first painted frame',
    targetMs: TARGET_MS,
    runsMs: chipMedians,
    note: `three sessions of ${String(REPS)} taps, alternating on and off, search box EMPTY. The whole of what is local about filtering: setFilters → isChipSelected → aria-checked, no request in the interval. It is NOT the row's "over the meals already loaded" — no narrowing happens on the device at all. Every raw tap is in the NOTE lines above. Median pointerdown→pointerup gap over the chip taps ${median(gaps).toFixed(2)} ms, inside the figure; the mark is REQUIRED on a pointer boundary, so a missing one fails rather than printing 0.0 — which is how the first version of this figure was caught reporting a masked zero for the keystroke samples, where no pointer event exists. rAF granularity ~16.7 ms is not subtracted. ${CONFOUND}`,
  });
  emit({
    row: 'T-25-02j',
    what: 'LOCAL — search keystroke: keydown → the "Clear search" control’s first painted frame',
    targetMs: TARGET_MS,
    runsMs: keyMedians,
    note: `the first character into an empty box mounts SearchField.tsx's clear control, so this is the keystroke's local render and nothing else — the 300 ms debounce has not elapsed and no request has gone out. ${CONFOUND}`,
  });
});

test('T-25-02 round trips: the same actions end to end, and the debounce defect', async ({
  browser,
}) => {
  const chipEmpty: number[] = [];
  const chipText: number[] = [];
  const renders: number[] = [];

  for (let run = 0; run < RUNS; run += 1) {
    await inSession(browser, {}, async (page) => {
      const input = page.getByTestId('explore-search').locator('input, textarea');
      // (1) chip tap, box EMPTY — `useMealSearch.ts` puts the delay at 0 when the box is empty.
      const empty = await measureTrip(page, () => page.getByTestId(CHIP).click());
      chipEmpty.push(empty.totalMs);
      renders.push(empty.renderMs);

      // (2) type, so the box holds text. Vegetarian is on: 19 meals, then 1 also matching "chick".
      await armInteraction(page, null);
      await input.pressSequentially('chick');
      await settle(page);
      await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: BOUNDARY_TIMEOUT_MS });

      // (3) the SAME chip action, differing only in that the box now holds text.
      const withText = await measureTrip(page, () => page.getByTestId(CHIP).click());
      chipText.push(withText.totalMs);
      renders.push(withText.renderMs);
    });
  }

  emit({
    row: 'T-25-02k',
    what: 'LOCAL — list render: fetch settled → the new meal rows painted',
    targetMs: TARGET_MS,
    runsMs: renders,
    note: `the closest boundary in this build to PRD §10.1's "over the meals already loaded": the server has answered and what remains is the app's own work — body read, zod validation in the api client, FlatList building initialNumToRender=8 of a 20-row page. It starts when window.fetch's promise SETTLES, which is response headers, so the body's transfer over loopback is inside it. Six samples across three sessions. ${CONFOUND}`,
  });
  // **No paging figure, deliberately.** A "Show more meals" tap was measured and withdrawn: the
  // shared detector stamps when the `meal-*` id set CHANGES, and pressing the footer re-renders the
  // list (the button goes busy) so `FlatList` can reveal more of the twenty rows it already holds
  // before page 2 arrives. One run of three put the boundary BEFORE the response and reported a
  // render half of -14.8 ms. A correct boundary needs a count, which `instrument.ts` does not offer
  // and this lane may not add to it. See docs/performance/interaction.md.
  emit({
    row: 'T-25-02g2',
    what: 'ROUND TRIP — filter chip, search box EMPTY: pointerdown → rows painted',
    targetMs: null,
    runsMs: chipEmpty,
    note: 'no target, and not because one was hard to find: PRD §10.1\'s 150 ms is written for an operation "over the meals already loaded", and exploreFilters.ts\'s own header says "No filtering logic lives here. The chips choose parameters; the server filters, through the domain." A figure that crosses HTTP is not what that row sets a threshold for, and inventing one is out of bounds (P25 Part 5).',
  });
  emit({
    row: 'T-25-02h2',
    what: 'ROUND TRIP — filter chip, TEXT in the search box: pointerdown → rows painted',
    targetMs: null,
    runsMs: chipText,
    note: `the same chip action as T-25-02g2, differing only in whether the box holds text. useMealSearch.ts keys the delay on the TEXT (and on the page number) and not on what changed, so this path pays SEARCH_DEBOUNCE_MS = 300 — which the docstring above it says it does not. Measured against the PAGING REWRITE that landed in this wave, which edited that very line to exempt page 2 and beyond, and left the filter case paying. Difference of medians ${(median(chipText) - median(chipEmpty)).toFixed(1)} ms.`,
  });
  expect(
    median(chipText) - median(chipEmpty),
    'the debounce defect must reproduce, or this lane is quoting a figure it cannot obtain',
  ).toBeGreaterThan(200);
});

test('T-25-02 probes: a stall in the tap, a delay on the wire, a throttled CPU', async ({
  browser,
}) => {
  const base = await inSession(browser, {}, async (page) => ({
    chip: medianOf(await chipStateSession(page)),
    render: await renderMedian(page),
  }));

  // (a) 80 ms burned inside the stamped pointerdown handler, AFTER t0, so it lands inside the
  // measured interval. Load-time injection; nothing in the repository is opened for writing.
  const stalled = await inSession(browser, { busyWaitMs: 80 }, async (page) =>
    medianOf(await chipStateSession(page)),
  );
  emitProbe('T-25-02i', '80 ms stall inside the stamped pointerdown', 80, base.chip, stalled);
  expect(
    stalled - base.chip,
    'a local figure that does not move under an injected 80 ms stall is not a measurement',
  ).toBeGreaterThan(40);
  // (b) 250 ms on every /api/v1/meals request. The composite path must move by it and the LOCAL
  // chip figure must NOT — which is the locality claim itself, measured rather than reasoned.
  const delayed = await inSession(browser, { apiDelayMs: 250 }, async (page) => ({
    trip: (await measureTrip(page, () => page.getByTestId(CHIP).click())).totalMs,
    chip: medianOf(await chipStateSession(page)),
  }));
  emitProbe('T-25-02i', '250 ms on /api/v1/meals (LOCAL chip state)', 0, base.chip, delayed.chip);
  emitNote(
    'T-25-02',
    `under that same 250 ms wire delay the composite chip→rows path measured ${delayed.trip.toFixed(1)} ms. The wire moves the round trip and leaves the chip's own state alone: the locality of T-25-02i is measured, not assumed.`,
  );
  expect(
    Math.abs(delayed.chip - base.chip),
    'the chip’s own state flip must be insensitive to the wire, or it is not local',
  ).toBeLessThan(40);
  // (c) CPU throttling, which is what a render-bound figure should answer to.
  const throttled = await inSession(browser, { cpuRate: 8 }, (page) => renderMedian(page));
  emitProbe('T-25-02k', '8x CPU throttling (Chromium CDP)', 0, base.render, throttled);
  expect(
    throttled - base.render,
    'a list-render figure that does not move under an 8x CPU throttle is measuring something else',
  ).toBeGreaterThan(5);
});
