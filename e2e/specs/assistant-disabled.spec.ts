import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import {
  ASSISTANT_PAINT_MS,
  askQuestion,
  expectNothingPending,
  expectPending,
  openAssistant,
} from '../support/assistant.js';

/**
 * AI switched off, and the screen does not hang (T-21-09). TSD §8.4 case 6.
 *
 * **"Does not hang" is the substance of this file, and it is a separate claim from "shows the
 * message".** A spinner with no terminal state is the failure mode a user cannot distinguish from
 * a broken app — they wait, nothing arrives, and nothing tells them it is over. A test that found
 * the turned-off text and stopped there would pass while a spinner sat beside it forever, which is
 * why the acceptance says "does not hang" rather than "shows the message". So the terminal state
 * is asserted **within a bound**, and the absence of every pending affordance is asserted
 * **afterwards**.
 *
 * **There are two AI switches and they belong to two different people.**
 *
 *  1. **The user's own**, `preferences.aiEnabled`, gated in `useAssistant` before the client is
 *     called: no request leaves the device, and the turned-off state renders. It is reachable
 *     through the real UI — Settings has the toggle — so this spec drives it that way rather than
 *     seeding storage. A journey through the app is the stronger claim and it is the one a user
 *     takes.
 *  2. **The operator's**, `config.AI_ENABLED` on the server, checked at TSD §5.4's step 4 and
 *     arriving as a 503 `ai_disabled`.
 *
 * **This harness structurally cannot reach the second one, and this file does not pretend to.**
 * `playwright.config.ts` starts the API with `AI_FAKE: 'true'` and does not set `AI_ENABLED`, whose
 * default is `true` (`apps/server/src/config.ts`) — and the server's environment is fixed when
 * Playwright starts it, so no spec can turn that switch off. Faking a 503 with `page.route` would
 * assert the client's own error table against a body this spec wrote, which is a fixture drawn
 * from the same source as the code it checks. The route's 503 mapping is covered where it can be
 * covered honestly, in `apps/server/src/routes/chat.integration.test.ts`; the e2e layer covers
 * path 1. See this task's report under `## COULD NOT VERIFY`.
 *
 * **The paired control is in this file rather than in `assistant.spec.ts`**, and it is the half
 * that makes the gate's absence observable both ways: a gate removed altogether lets a request
 * through, and a gate wired to a constant answers nothing at all. One page, one question, one
 * field different — the shape `home-allergy.spec.ts` uses for the same reason.
 */

/**
 * The bound the terminal state has to arrive inside, and it is deliberately not the 20 s used for
 * a first paint.
 *
 * Five seconds is an order of magnitude below the chat budget (30 s, `OLLAMA_CHAT_TIMEOUT_MS`) and
 * the client's own 35 s deadline, so it is not a figure the network path could be waiting on: what
 * it discriminates is a screen that **settled** from one that is still going. No document fixes a
 * number for a local state transition because there is nothing to fix — the gate does no I/O at
 * all — so this is a ceiling chosen to be generous and still meaningful, not a performance
 * assertion.
 */
const TERMINAL_MS = 5_000;

/** PRD §7.4's superlative example, the same question both halves of the control ask. */
const QUESTION = 'What is the cheapest?';

/** Settings owns the user's AI switch (T-18-03), and this is the journey into it. */
async function setUseAi(page: Page, enabled: boolean): Promise<void> {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: ASSISTANT_PAINT_MS });
  const toggle = page.getByTestId('settings-ai-toggle');
  // The pre-state, asserted rather than assumed: without it "the toggle turned it off" would also
  // be satisfied by a control that does nothing to a setting that was already off.
  await expect(toggle).toHaveAttribute('aria-checked', enabled ? 'false' : 'true');
  await toggle.click();
  // A `checkbox` with a real checked state rather than a button that merely looks active, so this
  // reads the store through the accessibility tree rather than through a tint (PRD §10.5).
  await expect(toggle).toHaveAttribute('aria-checked', enabled ? 'true' : 'false');
}

test.describe('the assistant with AI switched off', () => {
  test('answers from the device within a bounded time, sends nothing, and leaves nothing spinning', async ({
    app,
    page,
  }) => {
    /**
     * Every chat request, recorded through `page.route` rather than through `page.on('request')`.
     *
     * A route handler is called while the request is held, so anything the client sent has been
     * recorded by the time the screen can have reacted to a response — which is what makes
     * "nothing was sent" an assertion rather than a hope about event ordering. `continue()`, so a
     * request that does get through behaves normally and the control below is unaffected.
     */
    const chatRequests: string[] = [];
    /**
     * Armed only for the control ask at the end; `null` lets a request straight through.
     *
     * **Held, not faked.** The request is delayed and then `continue()`d, so the body the screen
     * finally renders is the real server's. That is the difference between this and the 503 this
     * file refuses to fabricate: delaying a real round trip observes a state the app genuinely
     * has, while inventing a response would assert the client's error table against a body this
     * spec wrote.
     */
    let held: Promise<void> | null = null;
    let release: () => void = () => undefined;
    await page.route('**/api/v1/chat', async (route) => {
      const method = route.request().method();
      /*
        The CORS preflight is the browser's, not the app's. The export is served from 19006 and the
        API listens on 4000 (`playwright.config.ts` explains why those two ports), and
        `Content-Type: application/json` is not a safelisted value, so an `OPTIONS` may precede
        every `POST`. Counting it would make "nothing was sent" a statement about the browser's
        network stack rather than about the client's decision.
      */
      if (method !== 'OPTIONS') {
        chatRequests.push(method);
      }
      if (held !== null) {
        await held;
      }
      await route.continue();
    });

    /*
      `app()` is called AFTER `page.route` above, not before, and the fixture is a function for
      exactly that reason (`fixtures.ts:60-67`): the chat route has to be installed before the app's
      first boot or the no-request assertion would be watching a page that had already asked.
      `appPhase.ts` seeds `aiEnabled: true`, which `setUseAi` asserts before it toggles.
    */
    await app();
    await setUseAi(page, false);
    await openAssistant(page);

    const startedAt = Date.now();
    await askQuestion(page, QUESTION);

    /**
     * The turn exists. `ask` appends it and `send` decides its state in the same commit, so this
     * is the earliest point at which the gate has certainly run — and it is the synchronisation
     * point the no-request assertion below stands on.
     */
    await expect(page.getByTestId('assistant-turn-1')).toBeVisible({ timeout: TERMINAL_MS });

    /**
     * **NO REQUEST AT ALL** (PRD §7.3: report the assistant as unavailable when AI is off).
     *
     * This is the claim the client-side gate exists to make. It is not "the request failed" and it
     * is not "the response was ignored": the device knows the answer already, so it spends no
     * round trip to learn it, and `ChatRequest` deliberately has no `aiEnabled` field a server
     * could be asked to decide with.
     */
    expect(
      chatRequests,
      'AI is off, so the device already knows the answer and must not ask the server',
    ).toStrictEqual([]);

    /**
     * **TERMINAL, INSIDE THE BOUND.** The half of the acceptance that says "does not hang".
     */
    const disabled = page.getByTestId('assistant-turn-1-disabled');
    await expect(disabled).toBeVisible({ timeout: TERMINAL_MS });
    const elapsed = Date.now() - startedAt;
    expect(
      elapsed,
      `the turned-off state took ${String(elapsed)} ms to arrive, which is not a settled screen`,
    ).toBeLessThan(TERMINAL_MS);

    /**
     * **AND NOTHING IS STILL WORKING.** Asserted after the terminal state rather than instead of
     * it: a screen that shows the message and keeps its spinner has told the user both that it
     * finished and that it did not.
     */
    await expect(page.getByTestId('assistant-turn-1-pending')).toHaveCount(0);
    await expectNothingPending(page);

    /**
     * **The right words, and not the two sets it must never be confused with** (T-21-07).
     *
     * `unavailable` means the model could not be reached and `no-information` means the assistant
     * answered and does not know — neither is true here, and either would tell this user something
     * false about their own switch. The turned-off copy also names both switches, because it is
     * the one state both of them reach.
     */
    await expect(disabled).toContainText('The assistant is turned off');
    await expect(disabled).toContainText('switched off in Settings');
    await expect(page.getByTestId('assistant-turn-1-disabled-still-available')).toContainText(
      'still work',
    );
    await expect(page.getByTestId('assistant-turn-1-unavailable')).toHaveCount(0);
    await expect(page.getByTestId('assistant-turn-1-no-information')).toHaveCount(0);
    await expect(page.getByTestId('assistant-turn-1-answer')).toHaveCount(0);

    /**
     * No way on from here, and that is deliberate rather than missing: `actionLabel` is `null` for
     * this failure, because a "Try again" against a model the user switched off is a control that
     * cannot work.
     */
    await expect(disabled.getByRole('button')).toHaveCount(0);

    /**
     * **THE CONTROL — the same question, on the same page, with the switch back on.**
     *
     * Without it the assertions above are satisfied by a gate that refuses everything, or by an
     * Ask button that never asks: "no request was sent" is trivially true of a screen that cannot
     * send one. It also pins the property `useAssistant` claims for gating at the choke point
     * rather than at mount — the preference is read **when the question is asked**, so a switch
     * flipped after the screen was mounted is honoured.
     */
    await setUseAi(page, true);
    await page.getByRole('tab', { name: 'Assistant' }).click();
    await expect(page.getByTestId('assistant-screen')).toBeVisible({ timeout: ASSISTANT_PAINT_MS });
    // A tab navigator does not unmount the tab you left, so the first turn is still there — which
    // is also what makes the next turn's id 2 rather than 1. If this ever fails, the id below is
    // what changed and the failure says so here instead of there.
    await expect(page.getByTestId('assistant-turn-1-disabled')).toBeVisible();

    /**
     * **And the working state is asserted before the settled one**, which is what stops the three
     * `expectNothingPending` assertions from being unfalsifiable.
     *
     * All three of them are absences — no progressbar, `aria-busy="false"`, an enabled button —
     * and an absence passes just as happily against a locator that has stopped matching anything.
     * `role="progressbar"` in particular is react-native-web's, not this app's: an upgrade that
     * renamed it would leave the assertion green forever, and the guard that caught P21's stuck
     * spinner would be decoration. Holding this one request open is the only point in either spec
     * where the app is observably mid-flight, so it is where the three locators get to prove they
     * can read the other value.
     */
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await askQuestion(page, QUESTION);
    await expectPending(page, 2);
    release();
    held = null;

    await expect(page.getByTestId('assistant-turn-2-answer')).toBeVisible({
      timeout: ASSISTANT_PAINT_MS,
    });
    await expect(page.getByTestId('assistant-turn-2-disabled')).toHaveCount(0);
    expect(
      chatRequests,
      'with AI on, the same question must reach the server — otherwise the assertions above are about a screen that cannot ask at all',
    ).toStrictEqual(['POST']);
    // And the second turn settles too, so "does not hang" is a claim about the screen rather than
    // about the branch that never made a request.
    await expect(page.getByTestId('assistant-turn-2-pending')).toHaveCount(0);
    await expectNothingPending(page);
  });
});
