import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The route into the Assistant screen, shared by TSD §8.4's cases 5 and 6 (T-21-09).
 *
 * **Shared because both specs have to agree on how the screen is reached, and one of the two ways
 * in is broken.** R-44: a cold `goto` of a path is rewritten to `/home` on the web export, so
 * `page.goto('/assistant')` would land on Home and fail for a reason that has nothing to do with
 * the assistant — `explore.spec.ts` pins that with a live `test.fail`. Tapping the tab is the path
 * every user takes and the only one that works, so it lives here rather than being retyped, where
 * the second copy could quietly be a `goto`.
 *
 * Nothing in here seeds storage: `enterApp` owns the phase gate, and the AI switch these specs
 * turn is reached through Settings rather than through `localStorage`, because a journey through
 * the app is the claim worth making.
 */

/** Long enough for a cold static bundle plus the first request; short enough to fail rather than hang. */
export const ASSISTANT_PAINT_MS = 20_000;

/**
 * Tap the Assistant tab and wait for the screen a user actually meets.
 *
 * `assistant-idle` rather than only `assistant-screen`, for the reason `explore.spec.ts` gives on
 * the same pair: the root test id would be satisfied by a mounted component that rendered nothing
 * usable, while idle is the empty transcript plus a field to type into.
 */
export async function openAssistant(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Assistant' }).click();
  await expect(page.getByTestId('assistant-screen')).toBeVisible({ timeout: ASSISTANT_PAINT_MS });
  await expect(page.getByTestId('assistant-idle')).toBeVisible();
  await expect(page.getByTestId('assistant-question')).toBeVisible();
}

/** `input, textarea`: the question field is a `multiline` `FormField`, so it is a textarea. */
export function questionField(page: Page): Locator {
  return page.getByTestId('assistant-question').locator('input, textarea');
}

/**
 * PRD FR-015's bound, restated here because an e2e spec asserts from outside the app.
 *
 * It is the number `assistant-remaining` counts down from, and the one `chatRequestSchema` caps
 * the question at server-side. Stated rather than read off the screen: a counter that reported
 * its own idea of the limit would agree with itself.
 */
export const MAX_QUESTION = 500;

/**
 * Type a question and press Ask.
 *
 * **The remaining-character count is asserted between the two**, and that is not decoration: it is
 * the one cheap observation that the text reached React state rather than only the DOM node.
 * `fill` sets a value and dispatches an event; a field whose `onChangeText` was not wired would
 * still show the text and would send an empty question, and the failure would surface as a
 * validation message nobody could explain. The count is `MAX_QUESTION - question.length`, so it
 * can only be right if the screen is holding the same string the browser is showing.
 */
export async function askQuestion(page: Page, question: string): Promise<void> {
  await expect(page.getByTestId('assistant-remaining')).toContainText(
    `${String(MAX_QUESTION)} characters left`,
  );
  await questionField(page).fill(question);
  await expect(
    page.getByTestId('assistant-remaining'),
    "the count is derived from the screen's own state, so it agrees with the typed text only if the field is bound",
  ).toContainText(`${String(MAX_QUESTION - question.length)} characters left`);
  await page.getByTestId('assistant-ask').click();
}

/**
 * Nothing on screen is still working (T-21-09: "does not hang").
 *
 * **`role="progressbar"` is the spinner, and there is exactly one place in the app it can come
 * from.** `AccessibleButton` renders an `ActivityIndicator` when `loading`, react-native-web 0.21
 * gives that `role="progressbar"`, and `assistant-ask` is the **only** button in the whole mobile
 * app that is ever passed `loading` — so a progressbar anywhere on the page is this screen's
 * spinner, still turning. A page-wide locator is therefore the right scope rather than a sloppy
 * one: it also catches a spinner left behind on a screen the user has navigated away from, which a
 * locator scoped to the assistant would miss.
 *
 * Three assertions and not one, because each would survive the loss of the others: the spinner is
 * the thing a user sees, `aria-busy` is what a screen reader is told, and an inert button is what
 * a second press meets. A screen that finished and left any one of the three set has told the user
 * it is still working.
 */
export async function expectNothingPending(page: Page): Promise<void> {
  await expect(page.getByRole('progressbar'), 'a spinner is still on screen').toHaveCount(0);
  await expect(page.getByTestId('assistant-ask')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('assistant-ask')).toBeEnabled();
}
