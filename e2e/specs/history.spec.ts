import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * Browser back and forward, across the tabs and across the modal (T-22-04, Plan §20).
 *
 * **Two halves with opposite histories, and the spec keeps them apart on purpose.**
 *
 * The **modal** was already correct before this task, measured: opening `MealDetails` grew
 * `history.length`, Back closed it, Forward reopened it. It is asserted here anyway, because "we
 * looked and it worked" is an observation and this phase's signature defect is a behaviour nothing
 * would notice the loss of. The probe that deletes the modal's push reddens `the modal` block.
 *
 * The **tabs** were broken, and the cause was a library default rather than anything this
 * repository had written: `TabRouter` defaults to `backBehavior: 'firstRoute'`, which holds the
 * navigator's own history at `[HomeTab, current]`, and `useLinking` pushes a browser entry only
 * when that history GROWS. So the first tab change pushed and every later one replaced — one Back
 * jumped from Settings to Home past two tabs the user had opened, the second Back left the site,
 * and Forward had nothing to return to. `TabNavigator` now sets `backBehavior="history"`; the
 * decision, the four alternatives and the cost are written out there.
 *
 * **Every case asserts the URL, the screen, AND the entry count.** The URL alone is satisfied by a
 * rewrite that navigated nowhere; the screen alone is R-44's trap, where `/saved` "worked" because
 * `ui.lastTab` was feeding `initialRouteName` — the right screen for an unrelated reason. And the
 * count is what separates "one Back works" from "four tabs are four entries", which is the whole
 * defect.
 */

/** Long enough for a cold static bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/** TSD §5.1, stated as the other specs state it — a spec asserts from outside the app. */
const API = 'http://127.0.0.1:4000';

/** TSD §6.4's key name, restated for the reason `appPhase.ts` restates its two. */
const UI_KEY = '@nutritime/ui/v1';

/**
 * The browser's own entry count, which is the number under test.
 *
 * `window.history.length` rather than a count of `goBack()` calls that happened to work: the
 * defect was that three of four tab changes called `replaceState`, and a replace is invisible to
 * anything except this number and the entry it overwrote.
 */
async function entries(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

/** Written through the real envelope, so hydration accepts it rather than quarantining it. */
async function seedTab(page: Page, lastTab: string): Promise<void> {
  await page.evaluate(
    ({ key, tab }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          value: { lastTab: tab, disclaimerAcknowledged: false },
        }),
      );
    },
    { key: UI_KEY, tab: lastTab },
  );
}

/** A real catalog id, read from the running server — a hard-coded one would be a fixture. */
async function firstMealId(page: Page): Promise<string> {
  const response = await page.request.get(`${API}/api/v1/meals?pageSize=1&page=1`);
  expect(response.ok(), 'the catalog must be readable for this case to mean anything').toBe(true);
  const body = (await response.json()) as { readonly meals: readonly { id: string }[] };
  const [first] = body.meals;
  if (first === undefined) {
    throw new Error('the catalog answered with no meals; this case cannot mean anything');
  }
  return first.id;
}

/**
 * Explore's rows, scoped INSIDE `explore-list` — not tidiness, and `favorite-persists.spec.ts`
 * paid for the lesson: Home stays mounted behind Explore and its cards share the `meal-` prefix,
 * so an unscoped selector returns a card painted over by Explore that Playwright correctly
 * refuses to click.
 */
function exploreRows(page: Page): Locator {
  return page.getByTestId('explore-list').locator('[data-testid^="meal-"]');
}

/** One tab, tapped the way a user taps it, waited for by its own screen. */
async function openTab(page: Page, name: string, screen: string, path: string): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByTestId(screen)).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page).toHaveURL(path);
}

/** The four tabs after Home, in the order a user walks them. */
const WALK = [
  { name: 'Explore', screen: 'explore-screen', path: '/explore' },
  { name: 'Assistant', screen: 'assistant-screen', path: '/assistant' },
  { name: 'Saved', screen: 'saved-screen', path: '/saved' },
  { name: 'Settings', screen: 'settings-screen', path: '/settings' },
] as const;

test.describe('browser back across the tabs', () => {
  test('gives every tab visit its own entry, and Back walks them in reverse', async ({ page }) => {
    await enterApp(page);
    await expect(page).toHaveURL('/home');
    const base = await entries(page);
    // Read from the running harness rather than typed out: "still the site" must not depend on a
    // port this spec restates.
    const origin = new URL(page.url()).origin;

    for (const [index, { name, screen, path }] of WALK.entries()) {
      await openTab(page, name, screen, path);
      expect(
        (await entries(page)) - base,
        `${name} added no history entry — only the first tab change pushed`,
      ).toBe(index + 1);
    }

    /**
     * **Four Backs, and the second one is the assertion that matters most.** Under the default the
     * first Back landed on Home, which is a plausible screen, and the second left the site
     * entirely — so the app is checked to still BE on screen part-way through, not only at the end.
     */
    const backwards = [
      { screen: 'saved-screen', path: '/saved' },
      { screen: 'assistant-screen', path: '/assistant' },
      { screen: 'explore-screen', path: '/explore' },
      { screen: 'home-screen', path: '/home' },
    ] as const;
    for (const { screen, path } of backwards) {
      await page.goBack();
      await expect(page.getByTestId(screen)).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page).toHaveURL(path);
      // Still the app, and still THIS app — checked at every step, because two Backs in was the
      // point of no return and a spec that only looked at the end would have missed it.
      expect(page.url(), 'Back left the site').toContain(origin);
      await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
    }
  });

  test('Forward returns to the tab that Back left', async ({ page }) => {
    await enterApp(page);
    await openTab(page, 'Explore', 'explore-screen', '/explore');
    await openTab(page, 'Saved', 'saved-screen', '/saved');

    await page.goBack();
    await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL('/explore');

    // Forward was dead under the default: with nothing pushed there was nothing ahead to return
    // to, so the button was grey on every tab change after the first.
    await page.goForward();
    await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL('/saved');
  });

  test('does not stack a second entry for a tab already visited', async ({ page }) => {
    /**
     * **The control no constant satisfies.** `'history'` de-duplicates: returning to a tab already
     * in the history MOVES it rather than stacking a copy, so the entry count must not grow. "Push
     * on every change" (`'fullHistory'`) fails here, "push on the first change only" (the default)
     * fails the walk above, and Back is asserted to reach the tab visited BEFORE the return, so a
     * navigator that simply stopped pushing fails too.
     */
    await enterApp(page);
    await openTab(page, 'Explore', 'explore-screen', '/explore');
    await openTab(page, 'Saved', 'saved-screen', '/saved');
    const afterWalk = await entries(page);

    await openTab(page, 'Explore', 'explore-screen', '/explore');
    expect(await entries(page), 'a return visit stacked a second entry').toBe(afterWalk);

    await page.goBack();
    await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL('/saved');
  });
});

test.describe('browser back across the modal', () => {
  test('pushes an entry, is dismissed by Back, and is reopened by Forward', async ({ page }) => {
    /**
     * **This half was already correct, and the assertion exists so that stops being an
     * observation.** `MealDetails` is a root-stack push (`presentation: 'modal'`), the stack's
     * history grows by one, and `useLinking` pushes — none of which the tab fix touches. Breaking
     * the push is one of this task's probes precisely because a passing test proves nothing about
     * a behaviour nobody could lose.
     */
    await enterApp(page);
    await openTab(page, 'Explore', 'explore-screen', '/explore');
    await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const beforeOpen = await entries(page);

    const first = exploreRows(page).first();
    const mealId = ((await first.getAttribute('data-testid')) ?? '').slice('meal-'.length);
    expect(mealId, 'Explore rendered no meal to open').not.toBe('');
    await first.click();

    await expect(page.getByTestId('meal-details-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    // `meal-details-body` rather than the screen alone: the screen is present in every state, and
    // a modal over a failed fetch would satisfy a root-only assertion.
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL(new RegExp(`/meal-details/${mealId}`));
    expect(await entries(page), 'opening the modal pushed no history entry').toBe(beforeOpen + 1);

    await page.goBack();
    // GONE, not merely covered: a modal still in the DOM over Explore would read as dismissed.
    await expect(page.getByTestId('meal-details-screen')).toHaveCount(0);
    await expect(page.getByTestId('explore-screen')).toBeVisible();
    await expect(page).toHaveURL('/explore');

    await page.goForward();
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL(new RegExp(`/meal-details/${mealId}`));
  });
});

test.describe('a deep link, the stored tab, and what is underneath', () => {
  test('lets a tab URL win over the stored tab, and Back returns to that URL', async ({ page }) => {
    /**
     * **The conflict `ui.lastTab` creates with the address bar, resolved and asserted.** A URL
     * naming a tab wins, because React Navigation builds initial state from the path and applies
     * `initialRouteName` only where the path is silent — `explore.spec.ts` owns that claim. What
     * belongs here is what happens NEXT: the deep-linked tab must be an entry to come back to.
     *
     * This is also where the default's second symptom showed up without any deep link at all.
     * Under `'firstRoute'` a restored or deep-linked tab makes the navigator's history
     * `[HomeTab, thatTab]` while the browser holds one entry, so the first tab press SHRINKS it,
     * `useLinking` answers with `history.go(-1)` against an entry that does not exist, and **the
     * address bar stays on `/settings` while Home renders**.
     */
    await enterApp(page);
    await seedTab(page, 'saved');

    await page.goto('/settings');
    await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

    await openTab(page, 'Home', 'home-screen', '/home');

    await page.goBack();
    await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page).toHaveURL('/settings');
  });

  test('dismisses a cold-loaded modal to its origin, not to the tab behind it', async ({
    page,
  }) => {
    /**
     * **This records a decision T-22-04 DECLINED, and it is the assertion that would redden if
     * someone took it.** Adding `initialRouteName: 'Tabs'` to the root linking config would put
     * the tab navigator under a cold-loaded modal. It cannot change browser Back — a cold load is
     * one entry whatever the navigator holds — but it would make `canGoBack()` true, and
     * `MealDetailsScreen`'s dismiss is `canGoBack() ? goBack() : navigate('Tabs', { screen:
     * ORIGIN_TABS[origin] })` (T-16-07). So the `origin` branch would die and the modal would
     * dismiss to whatever tab happened to be underneath — here the stored `saved`, which is the
     * RECIPIENT's last tab and has nothing to do with the link they followed.
     *
     * Both directions are asserted, so "always Explore" and "always Home" both fail: a link
     * carrying `origin=explore` dismisses to Explore, and one carrying no origin dismisses to
     * Home (`DEFAULT_ORIGIN`). The stored tab is seeded to `saved` in both, and must win neither.
     */
    await enterApp(page);
    await seedTab(page, 'saved');
    const mealId = await firstMealId(page);

    await page.goto(`/meal-details/${mealId}?origin=explore`);
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('meal-details-dismiss').click();
    await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-screen')).toHaveCount(0);

    await page.goto(`/meal-details/${mealId}`);
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('meal-details-dismiss').click();
    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-screen')).toHaveCount(0);
  });
});
