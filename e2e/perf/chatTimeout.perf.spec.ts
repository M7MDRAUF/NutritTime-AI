/**
 * T-25-04's user-visible half: the timeout is a STATE, not a hang — and it is the right state.
 *
 * `chatTimeout.ts` measures the server side: a stalled upstream, the real provider path, 503
 * `ai_unavailable` at ~30 s with an AI log line reading `outcome: "timeout"`. This file measures
 * what the person holding the phone gets, and it makes one distinction that a check for "an error
 * appeared" would miss entirely.
 *
 * **The client's deadline is 35 s and the server's is 30 s, and the ordering is the assertion.**
 * `ROUTE_TIMEOUTS_MS.ask = 35_000` against `OLLAMA_CHAT_TIMEOUT_MS = 30_000`: the client must never
 * give up first. If it did, `failureFor` would map its own `timeout` to the **offline** failure
 * (`useAssistant.ts:147-148`) and the user would be told the server could not be reached, when the
 * truth is that the model ran out of time — a different message for the same event, and one that
 * sends them to check their connection. So the two arms here are:
 *
 *  - **31 s** — past the server's budget, inside the client's. Expect the `unavailable` surface.
 *  - **36 s** — past the client's budget too. Expect the `offline` surface, because the client
 *    fired first. This is the probe: it is the same harness reporting a *different* state, which
 *    is what makes the first arm a measurement rather than the only thing it can print.
 *
 * The stall is injected with `page.route` — a load-time substitution at the network layer (§6.1i),
 * with no repository file opened for writing and no server reconfigured. The body the route
 * fulfils with is `ApiError('ai_unavailable').body`'s exact shape from `apps/server/src/errors.ts`.
 */

import { expect, test } from '@playwright/test';
import type { Browser } from '@playwright/test';
import {
  armInteraction,
  installInstrument,
  readFetches,
  readMarks,
  requireMark,
  waitForMark,
} from './instrument.js';
import { seedBeforeFirstScript } from './seed.js';
import { emit, emitNote } from './stats.js';

const RUNS = 3;
/** `apps/server/src/config.ts` DEFAULTS.OLLAMA_CHAT_TIMEOUT_MS. */
const SERVER_BUDGET_MS = 30_000;
/** `apps/mobile/src/infrastructure/api/routes.ts` ROUTE_TIMEOUTS_MS.ask. */
const CLIENT_DEADLINE_MS = 35_000;
/** Between the two, so the server's budget is what expires. */
const STALL_INSIDE_MS = 31_000;
/** Past both, so the client's own deadline is what expires. */
const STALL_BEYOND_MS = 36_000;
const PAINT_TIMEOUT_MS = 60_000;

/** The 503 body the real server sends. `errors.ts:49-58`, with `ai_unavailable`'s fixed copy. */
const AI_UNAVAILABLE_BODY = JSON.stringify({
  error: {
    code: 'ai_unavailable',
    message: 'The assistant is unavailable right now.',
    retryable: true,
  },
});

interface FailureSample {
  /** The stalled response arriving → the failure surface painted. The UI's own cost. */
  readonly uiMs: number;
  /** Ask pressed → the failure surface painted. Dominated by the injected stall. */
  readonly totalMs: number;
  /** Which of the six assistant failure surfaces appeared. */
  readonly surface: string;
}

async function measureFailure(browser: Browser, stallMs: number): Promise<FailureSample> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await seedBeforeFirstScript(page, { aiEnabled: true });
    await installInstrument(page);

    await page.route('**/api/v1/chat', async (route) => {
      await new Promise((settle) => setTimeout(settle, stallMs));
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: AI_UNAVAILABLE_BODY,
      });
    });

    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Assistant' })).toBeVisible({ timeout: 30_000 });

    // Inlined rather than imported from `e2e/support/assistant.ts`: that file is read-only to this
    // lane and another agent may be editing it this wave, and a measured sample must not change
    // because a helper did. The three steps are the same ones it takes.
    await page.getByRole('tab', { name: 'Assistant' }).click();
    await expect(page.getByTestId('assistant-idle')).toBeVisible({ timeout: 30_000 });
    await page
      .getByTestId('assistant-question')
      .locator('input, textarea')
      .fill('What is the cheapest lunch?');

    // `-failure` is the WRAPPER `AssistantTurnRow.tsx:165` renders around whichever of the six
    // failure surfaces applies, so it is one boundary for every arm of this test. Which surface
    // appeared is read out of it afterwards — a boundary keyed on `-unavailable` itself could not
    // have observed the probe arm below, and a test whose boundary only fires on the expected
    // outcome is a test that cannot report the unexpected one.
    await armInteraction(page, 'assistant-turn-1-failure');
    await page.getByTestId('assistant-ask').click();
    await waitForMark(page, 'paint', PAINT_TIMEOUT_MS);

    const marks = await readMarks(page);
    const surface = await page.evaluate(() => {
      const node = document.querySelector(
        '[data-testid="assistant-turn-1-failure"] [data-testid^="assistant-turn-1-"]',
      );
      return node?.getAttribute('data-testid') ?? 'none';
    });

    // "Does not hang", asserted the way `e2e/support/assistant.ts` argues it must be: three
    // observations, each of which would survive the loss of the others.
    await expect(page.getByRole('progressbar'), 'a spinner is still on screen').toHaveCount(0);
    await expect(page.getByTestId('assistant-ask')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByTestId('assistant-ask')).toBeEnabled();

    const painted = requireMark(marks, 'paint');
    // When the 503 reached the page, in the page's own clock. Taken from the instrument's `fetch`
    // wrapper rather than from a `page.evaluate` inside the route handler: evaluating in the page
    // while one of its requests is parked is a needless way to make a measurement depend on the
    // harness's own scheduling.
    const settled = (await readFetches(page)).find((record) => record.url.includes('/api/v1/chat'));
    if (settled === undefined) {
      throw new Error('no /api/v1/chat request was observed');
    }
    return {
      uiMs: painted - settled.end,
      totalMs: painted - requireMark(marks, 't0'),
      surface,
    };
  } finally {
    await context.close();
  }
}

test('T-25-04 a stall past the SERVER budget surfaces as unavailable, not offline', async ({
  browser,
}) => {
  const samples: FailureSample[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    samples.push(await measureFailure(browser, STALL_INSIDE_MS));
  }

  for (const sample of samples) {
    expect(
      sample.surface,
      'a 503 ai_unavailable must reach the unavailable surface. The offline surface would mean the client gave up first and told the user their connection was at fault',
    ).toBe('assistant-turn-1-unavailable');
  }

  emit({
    row: 'T-25-04b',
    what: 'the 503 arriving -> the assistant-unavailable surface painted (the UI’s own cost)',
    targetMs: null,
    runsMs: samples.map((sample) => sample.uiMs),
    note:
      `page.route stalls **/api/v1/chat for ${String(STALL_INSIDE_MS)} ms — past the server's ` +
      `${String(SERVER_BUDGET_MS)} ms budget and inside the client's ${String(CLIENT_DEADLINE_MS)} ` +
      'ms deadline — then fulfils with the exact 503 ai_unavailable body from ' +
      'apps/server/src/errors.ts. Viewport phone-375, web export, aiEnabled=true. No documented ' +
      'target for this interval; it is reported because "the timeout behaves" is a claim about a ' +
      'STATE appearing, and how long the state takes to appear is the part of it a user feels.',
  });
  emit({
    row: 'T-25-04c',
    what: 'attribution: Ask pressed -> failure surface painted (dominated by the injected stall)',
    targetMs: null,
    runsMs: samples.map((sample) => sample.totalMs),
    note: `includes the injected ${String(STALL_INSIDE_MS)} ms. Not a product figure.`,
  });
  emitNote(
    'T-25-04',
    `NOT A HANG, in the browser: all ${String(RUNS)} runs reached ` +
      'assistant-turn-1-unavailable with no progressbar on the page, aria-busy="false" on the Ask ' +
      'button and the button enabled.',
  );
});

/**
 * The probe: the same harness, one number changed, a different state reported.
 *
 * 36 s is past the client's own 35 s deadline, so `failureFor` sees its `timeout` and maps it to
 * the offline surface. If this arm ALSO produced `unavailable`, the assertion above would be
 * satisfied by any failure at all and would be proving nothing about which one.
 */
test('T-25-04 probe: a stall past the CLIENT deadline surfaces as offline instead', async ({
  browser,
}) => {
  const sample = await measureFailure(browser, STALL_BEYOND_MS);
  emitNote(
    'T-25-04',
    `probe — stall raised to ${String(STALL_BEYOND_MS)} ms, past the client's ` +
      `${String(CLIENT_DEADLINE_MS)} ms deadline: the surface became "${sample.surface}" after ` +
      `${sample.totalMs.toFixed(1)} ms. The 31 s arm reports "unavailable" and this one does not, ` +
      'so the surface is measured rather than assumed.',
  );
  expect(
    sample.surface,
    'past the client deadline the client fires first, and its timeout maps to the offline surface (useAssistant.ts:147)',
  ).toBe('assistant-turn-1-offline');
  expect(
    sample.totalMs,
    'the client must give up at its own deadline rather than waiting for a response that never comes',
  ).toBeLessThan(STALL_BEYOND_MS);
});
