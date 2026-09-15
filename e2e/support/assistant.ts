import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The route into the Assistant screen, shared by TSD §8.4's cases 5 and 6 (T-21-09).
 *
 * **Shared because both specs have to agree on how the screen is reached.** Tapping the tab is the
 * path every user takes, and both of TSD §8.4's cases are journeys through the app, so it lives
 * here rather than being retyped — where the second copy could drift from the first.
 *
 * **R-44 is CLOSED, and the reason recorded here before is retracted.** This docblock used to say
 * *"one of the two ways in is broken"* — that a cold `page.goto('/assistant')` is rewritten to
 * `/home` on the web export, *"pinned with a live `test.fail`"*. Neither half holds:
 *
 *  - `explore.spec.ts` now asserts the opposite, in a `test.describe` titled
 *    **`'a cold URL loads its own screen (T-22-03)'`**, and its docblock above that block reads
 *    *"**R-44, closed — and `test.fail` is gone, which is exactly what it was kept for** (T-22-03)"*.
 *    The cause was never in `linking.ts`: `NavigationContainer` resolved the URL once, at a first
 *    mount that held only `Splash`, and the font gate now holds that mount.
 *  - There is no `test.fail` in `explore.spec.ts`. `grep -rn "test\.fail(" e2e/specs/` returns
 *    exactly one hit in the whole suite and it is `text-clipping.spec.ts` (R-72).
 *
 * So a cold `goto` into a route is **not** broken, and nobody should route around it. The one
 * narrower fact that survives is about a single path: `/splash` cannot restore, because `Splash` is
 * in the navigator only during `hydrating` and the hydration gate renders instead of the navigator
 * — `explore.spec.ts` asserts that as the degradation it is, in
 * `'/splash degrades to the app rather than stranding the user on a boot surface'`. Quoting those
 * titles rather than citing their lines, per §6.1q.
 *
 * (Cited by quoted text because the old sentence is why this matters: a support module telling the
 * next author that `page.goto` is broken would have had them building around a defect that was
 * closed at P22.)
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
 * `1010` as `"$10.10"` — `formatMoney`'s output, hand-transcribed.
 *
 * Transcribed rather than imported, and the tsconfig is what makes that a rule rather than a
 * preference: `e2e/tsconfig.json` deliberately resolves no `@nutritime/*` path, because "a spec
 * that imported the domain could assert against the same code it is supposed to be checking from
 * the outside". So the format a user reads is stated here, and a drift in either direction fails.
 */
export function formatCents(amountCents: number): string {
  const dollars = Math.trunc(amountCents / 100);
  const cents = amountCents % 100;
  return `$${String(dollars)}.${String(cents).padStart(2, '0')}`;
}

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
 *
 * **Every one of the three is an ABSENCE, which is the shape that rots silently.** `toHaveCount(0)`
 * against a role the library has stopped emitting passes forever and says nothing; so does
 * `aria-busy="false"` on a prop that is no longer wired. So `expectPending` below asserts the same
 * three locators in their other reading, and `assistant-disabled.spec.ts` calls it while a request
 * is deliberately held open. Measured: with `role="progressbar"` rewritten to `"presentation"` in
 * the served bundle — what a react-native-web upgrade looks like from outside — `expectPending`
 * fails and `expectNothingPending` passes. Without that pair, the guard that caught P21's stuck
 * spinner would be the next thing in this suite to become decoration.
 */
export async function expectNothingPending(page: Page): Promise<void> {
  await expect(page.getByRole('progressbar'), 'a spinner is still on screen').toHaveCount(0);
  await expect(page.getByTestId('assistant-ask')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('assistant-ask')).toBeEnabled();
}

/**
 * The positive half: the screen IS working, and every carrier of that says so (T-21-09).
 *
 * Not a nicety and not a duplicate — it is what makes `expectNothingPending` falsifiable. Each
 * assertion is the exact negation of one of that function's three, on the same locator, so a
 * locator that has quietly stopped matching anything fails here instead of passing there.
 *
 * `-pending` is asserted as well as the button's state because the two are different claims: the
 * words in the transcript are what tells the user *what* is being waited for (PRD §12), and the
 * button's `busy`/inert pair is what stops a second press.
 */
export async function expectPending(page: Page, turnId: number): Promise<void> {
  await expect(page.getByTestId(`assistant-turn-${String(turnId)}-pending`)).toBeVisible();
  await expect(page.getByRole('progressbar'), 'the spinner must be visible in flight').toHaveCount(
    1,
  );
  await expect(page.getByTestId('assistant-ask')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('assistant-ask')).toBeDisabled();
}

/**
 * `scope.context` for a question that matches no meal lexically — the other half of R-21.
 *
 * **Why this is here at all.** R-21 says a superlative's winner is routinely *outside* the five
 * retrieved meals, so containment must compare citations against `resolved.namedMeals`. The whole
 * design rests on that gap existing for the question `assistant.spec.ts` asks, and P21 established
 * it by measuring the two prices once and writing them into a comment. A measured number in a
 * comment is true on the day it is written: reseed the catalog, reorder `meals.json`, make the
 * cheapest meal unavailable, and the spec keeps passing while the claim it is evidence for has
 * quietly stopped holding. So the gap is derived on every run instead.
 *
 * **It reads `meals.json`, and that is DATA rather than the code under test.** `e2e/tsconfig.json`
 * resolves no `@nutritime/*` path on purpose — "a spec that imported the domain could assert
 * against the same code it is supposed to be checking from the outside" — and nothing here imports
 * a module. This file is the server's own input: `buildCatalog` walks `seeded.entries()` and pushes
 * in file order, so `catalog.meals` IS this array, and `chat.ts` hands exactly that to
 * `retrieveChatMeals`. The caller asserts `allIds` against the ids the API serves, so "this file is
 * what the server loaded" is checked rather than assumed.
 *
 * **The prefix is TSD §4.8's step 7, hand-transcribed.** With the profile `enterApp` seeds — no
 * allergy, `diet: 'regular'`, no disliked ingredients — steps 1, 2 and 4 are vacuous and step 3
 * (`available`) is the whole filter; a question that matches nothing lexically falls through to
 * step 7, which takes the eligible set in partition order, capped at five. One partition, input
 * order, so the prefix is the first five available records in this file. The caller asserts the
 * lexical miss against the server's own relevance ranking (`GET /meals?query=…` → `total: 0`)
 * rather than assuming it.
 */
export interface LexicalMissContext {
  /** Every id in file order, so the caller can check this file against the served catalog. */
  readonly allIds: readonly string[];
  /** The five ids a `context`-scoped ground would have carried. */
  readonly ids: readonly string[];
  /** The meal a `context`-scoped superlative would have named instead of the real winner. */
  readonly cheapest: { readonly id: string; readonly name: string; readonly amountCents: number };
}

/** `MAX_CHAT_CONTEXT_MEALS` (TSD §4.8), restated because an e2e spec asserts from outside. */
const MAX_CONTEXT_MEALS = 5;

interface CatalogRecord {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly amountCents: number;
}

/** A type predicate rather than an `as`: the file is untrusted data at this boundary. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrowed by hand, field by field, so a shape change says so loudly instead of reading `NaN`. */
function catalogRecord(record: unknown, index: number): CatalogRecord {
  const fields = isRecord(record) ? record : {};
  const price = fields['price'];
  const amountCents = isRecord(price) ? price['amountCents'] : undefined;
  const id = fields['id'];
  const name = fields['name'];
  const available = fields['available'];
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof available !== 'boolean' ||
    typeof amountCents !== 'number'
  ) {
    throw new Error(`meals.json record ${String(index)} does not carry id/name/available/price`);
  }
  return { id, name, available, amountCents };
}

export function lexicalMissContext(): LexicalMissContext {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'packages',
    'catalog',
    'meals.json',
  );
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('meals.json did not parse as an array of records');
  }
  const records = parsed.map(catalogRecord);
  const context = records.filter((record) => record.available).slice(0, MAX_CONTEXT_MEALS);
  expect(context.length, 'the catalog must offer five available meals').toBe(MAX_CONTEXT_MEALS);
  const cheapest = [...context].sort((left, right) => left.amountCents - right.amountCents)[0];
  if (cheapest === undefined) {
    throw new Error('unreachable: the assertion above fails on an empty prefix');
  }
  return {
    allIds: records.map((record) => record.id),
    ids: context.map((record) => record.id),
    cheapest: { id: cheapest.id, name: cheapest.name, amountCents: cheapest.amountCents },
  };
}

/**
 * R-21 asserted rather than quoted: the superlative's winner is OUTSIDE the retrieved five.
 *
 * Three statements, and TSD §8.4 case 5 is only evidence for the containment design while all
 * three hold:
 *
 *  1. **`meals.json` is the array the server loaded** — the served ids are compared against the
 *     file's, so `lexicalMissContext`'s reading of the file order is checked, not assumed;
 *  2. **the question matches no meal lexically** — read off the server's own relevance ranking
 *     (`GET /meals?query=…` → `total: 0`), which is §4.7, the same function retrieval ranks with
 *     at step 5, rather than a hand claim about the lexicon;
 *  3. **the winner is not in the prefix** — the risk row itself.
 *
 * If the third ever stops holding, containment could be rewritten against `scope.context` and
 * every other assertion in that spec would still pass. That is precisely the state R-21 was
 * raised to prevent, and precisely the state a comment carrying two measured prices cannot
 * detect. P21 measured $6.50 against $2.50 and was right; this is the same fact with a test
 * attached.
 */
export async function expectRetrievalGap(
  page: Page,
  apiBaseUrl: string,
  question: string,
  servedIds: readonly string[],
  winnerIds: readonly string[],
): Promise<LexicalMissContext> {
  const context = lexicalMissContext();
  expect(
    [...context.allIds].sort(),
    'meals.json must be the catalog the server loaded, or the prefix here is not scope.context',
  ).toStrictEqual([...servedIds].sort());

  const ranked = await page.request.get(
    `${apiBaseUrl}/api/v1/meals?query=${encodeURIComponent(question)}`,
  );
  expect(ranked.ok(), 'the relevance ranking must be readable').toBe(true);
  expect(
    ((await ranked.json()) as { readonly total: number }).total,
    'this question must match no meal lexically, or scope.context is a ranking and not step 7s prefix',
  ).toBe(0);

  expect(winnerIds.length, 'a superlative must have at least one winner').toBeGreaterThan(0);
  for (const id of winnerIds) {
    expect(
      context.ids,
      `R-21 needs the winner OUTSIDE the retrieved five; ${id} is one of them, so the spec no longer proves the containment scope`,
    ).not.toContain(id);
  }
  return context;
}
