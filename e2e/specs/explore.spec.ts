import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * The first end-to-end spec (T-13-07): Explore, against the real server and the real catalog.
 *
 * **What this proves that no other suite can.** The dom suite renders `ExploreScreen` against a
 * stub client in jsdom; the integration suite drives the Express app with supertest. Neither has
 * ever run the two together. This spec is the first thing in the project that exercises
 * device → context → API client → HTTP → route → domain → catalog and back, in a browser, over a
 * real socket, against the actual 60 records.
 *
 * It is also the first thing that can catch a whole class of defect the other two cannot: a query
 * string the client builds and the server's allowlist rejects, a CORS header that is missing, a
 * JSON shape that survives `mealSchema` in a test and not in the bundle, a screen that renders
 * nothing because the export's base URL is wrong.
 */

/** Long enough for a cold static bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/**
 * Open Explore the way a user does: land on the app, tap the Explore tab.
 *
 * **The first run of this suite failed all twelve specs because they assumed `/` was Explore.** It
 * is not: the app opens on `HomeTab`, and at P13 only `Explore` is registered — so `/` correctly
 * renders `PlaceholderScreen` for Home. The accessibility snapshot from that failure is the proof
 * the app was working, not broken:
 *
 *     - heading "Home is not available yet" [level=1]
 *     - tablist:
 *       - tab "Home" [selected]
 *       - tab "Explore"
 *       ...
 *
 * Tapping the tab rather than deep-linking to `/explore`, so these specs exercise the path every
 * user takes and do not depend on the linking config. The deep link gets its own spec below,
 * because it is a separate claim.
 */
async function openExplore(page: Page): Promise<void> {
  // `enterApp` seeds the phase, because P14 gave the app an onboarding gate and an empty device no
  // longer starts on the tabs — which failed all twelve of these specs the moment P14 landed. The
  // journey itself is `onboarding.spec.ts`'s subject, not this file's.
  await enterApp(page);
  await page.getByRole('tab', { name: 'Explore' }).click();
}

test.describe('Explore, end to end', () => {
  test('loads the catalog from the running server and renders rows', async ({ page }) => {
    await openExplore(page);

    const list = page.getByTestId('explore-list');
    await expect(list).toBeVisible({ timeout: FIRST_PAINT_MS });

    // The loading state must be GONE, not merely covered. A screen that renders both has told the
    // user two things at once.
    await expect(page.getByTestId('explore-loading')).toBeHidden();
    await expect(page.getByTestId('explore-offline')).toBeHidden();
    await expect(page.getByTestId('explore-error')).toBeHidden();

    // At least one real card, addressed by the id the server sent rather than by position.
    const cards = page.locator('[data-testid^="meal-"]');
    expect(await cards.count()).toBeGreaterThan(0);
  });

  test('a search narrows the set, and the server does the narrowing', async ({ page }) => {
    await openExplore(page);
    await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });

    /**
     * **The identity of the rendered set, not its size.**
     *
     * The first version of this spec compared `count()` before and after and failed with
     * "Expected: not 8" — because 8 is `initialNumToRender`. `FlatList` puts only its window in the
     * DOM, so the row count measures the LIST's rendering budget and never the result set: an
     * unfiltered catalog of 60 and a search matching 12 both render 8 rows. The assertion could not
     * have passed for the right reason.
     *
     * The ids can only change if the server returned a different set, which is the actual claim.
     */
    /**
     * **Scoped to the Explore screen, and it was not before.**
     *
     * `HomeScreen` gives each of its cards a `meal-<id>` test id too, and Home stays mounted behind
     * Explore — a tab navigator does not unmount the tab you left. So a page-wide
     * `[data-testid^="meal-"]` collected three of Home's ids along with Explore's, and this
     * comparison was measuring a set it did not intend. The claim it makes still held, which is why
     * it went unnoticed; it held for the wrong reason.
     *
     * Found while another spec was being written against the same selector, where the "first
     * Explore row" turned out to be one of Home's cards and Playwright's hit test correctly
     * refused to click something covered by another screen.
     */
    const idsNow = async (): Promise<string[]> =>
      (await page.getByTestId('explore-screen').locator('[data-testid^="meal-"]').all()).reduce<
        Promise<string[]>
      >(
        async (carry, row) => [...(await carry), (await row.getAttribute('data-testid')) ?? ''],
        Promise.resolve([]),
      );
    const before = await idsNow();
    expect(before.length).toBeGreaterThan(0);

    // Typed character by character, so the 300 ms debounce is exercised for real rather than
    // bypassed by setting the value in one go.
    const input = page.getByTestId('explore-search').locator('input');
    await input.fill('');
    await input.pressSequentially('chicken', { delay: 40 });

    // A different set, or an empty state - both are correct answers to a search, and asserting a
    // specific count would be asserting the catalog's contents rather than the search working.
    await expect
      .poll(
        async () => {
          if (await page.getByTestId('explore-empty').isVisible()) {
            return 'empty';
          }
          return (await idsNow()).join(',');
        },
        { timeout: FIRST_PAINT_MS },
      )
      .not.toBe(before.join(','));
  });

  test('a diet chip filters through the domain, not the screen', async ({ page }) => {
    await openExplore(page);
    await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/meals')) {
        requests.push(request.url());
      }
    });

    await page.getByTestId('chip-diet-vegan').click();

    // The parameter went over the wire. That is the claim: the screen asks, the server filters.
    await expect.poll(() => requests.some((url) => url.includes('diet=vegan'))).toBe(true);

    // And a vegetarian filter must return vegan meals too, because TSD §4.5 says a vegan meal
    // satisfies a vegetarian request - the rule a route re-implementing `isDietCompatible` would
    // get wrong, and one only the real domain can be trusted for.
    await page.getByTestId('chip-diet-vegan').click();
    await page.getByTestId('chip-diet-vegetarian').click();
    await expect.poll(() => requests.some((url) => url.includes('diet=vegetarian'))).toBe(true);
  });

  test('shows the local-only state when the API is unreachable, and says what still works', async ({
    page,
  }) => {
    // PRD §10.2: the app is useful with no server. Simulated by failing the route in the browser
    // rather than by stopping the server, so the other specs in this file are unaffected.
    await page.route('**/api/v1/meals**', async (route) => {
      await route.abort('connectionrefused');
    });
    await openExplore(page);

    const offline = page.getByTestId('explore-offline');
    await expect(offline).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(offline).toContainText('Working offline');
    await expect(offline).toContainText('still work');
    // Never the other wording (S-23): the server is on the same machine and can be down while the
    // device's connection is perfect.
    await expect(offline).not.toContainText("You're offline");
    // And no error state alongside it: unreachable is not a failure to report.
    await expect(page.getByTestId('explore-error')).toBeHidden();
  });

  test('never shows a raw provider string, even on a 500', async ({ page }) => {
    // TSD §3.5 / PRD §12. Fulfilled with a body carrying something that must not be rendered.
    await page.route('**/api/v1/meals**', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'internal_error',
            message: 'ECONNREFUSED /var/run/private.sock',
            retryable: false,
          },
        }),
      });
    });
    await openExplore(page);

    await expect(page.getByTestId('explore-error')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('private.sock');
  });

  test('the five tabs are reachable, from the landing screen', async ({ page }) => {
    await enterApp(page);

    // Real icons now (A-11), so a tab is addressed by its accessible NAME rather than its glyph -
    // which also asserts that the icon contributes nothing to that name, since it is `aria-hidden`.
    for (const name of ['Home', 'Explore', 'Assistant', 'Saved', 'Settings']) {
      await expect(page.getByRole('tab', { name })).toBeVisible({ timeout: FIRST_PAINT_MS });
    }
    // Home is the initial tab and P15 registered it, so Home's own screen is what renders. This
    // assertion used to look for "Home is not available yet" and was correct until P15 landed —
    // kept and updated rather than deleted, because a registry with a screen behind it is the
    // stronger claim.
    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    /**
     * **Updated at P17, for the second time, and the pattern is the point.**
     *
     * This looked for "Home is not available yet" until P15 registered Home, and for "Saved is not
     * available yet" until P17 registered Saved. Each time the assertion was *correct* when
     * written and the registry is what changed under it — so it gets updated to the stronger
     * claim rather than deleted, exactly as the Home line above was.
     *
     * The stronger claim here is both sections with their own empty states, because that is
     * T-17-02's actual acceptance ("two sections with independent empty states") and it is the half
     * a placeholder assertion could never have reached.
     */
    await page.getByRole('tab', { name: 'Saved' }).click();
    await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-favorites-empty')).toBeVisible();
    await expect(page.getByTestId('saved-custom-empty')).toBeVisible();
    // Still the registry working: `Assistant` has no screen until P19, so the placeholder names it.
    await page.getByRole('tab', { name: 'Assistant' }).click();
    await expect(
      page.getByRole('heading', { name: /Assistant is not available yet/ }),
    ).toBeVisible();
  });

  /**
   * **Known broken on web, and kept rather than deleted (R-44).**
   *
   * `/explore?query=chicken` lands on Home. `routes.test.ts` and `linking.dom.test.ts` both pass —
   * `getStateFromPath` parses the path correctly in isolation — so what is missing is the wiring
   * between the browser's URL and that parse. Adding `window.location.origin` to `prefixes` was
   * the obvious candidate and changed nothing, so the cause is **not yet identified**.
   *
   * **R-44 is narrower than its own wording, and this comment says so rather than repeating it.**
   * A **path** does restore: `favorite-persists.spec.ts` reloads on `/saved` and the app comes back
   * up on Saved with the row already fetched. A **cold `goto`** of a path is rewritten to `/home`
   * (`settings-reset.spec.ts` measured `goto('/settings')` doing exactly that, with Settings never
   * mounted). It is the **query-param** case below that lands on Home, which is why
   * `custom-meal-crud.spec.ts` never reloads `MealForm` — its `mealId` is a query param.
   *
   * **`test.fail`, not `test.fixme`, and the difference is the whole point of keeping this test.**
   * `fixme` **skips**: the body never runs, so it cannot tell T-22-01 and T-22-02 anything — they
   * could fix web linking and the suite would stay silent until a human deleted the marker, and
   * meanwhile the assertions below would be dead code that had never once executed against the
   * real export. `test.fail` runs the body, records the failure as expected so the suite stays
   * green, and **turns red the moment the deep link starts working** — an unexpected pass is a
   * failure. That is the same shape P18 used for R-53 with vitest's `it.fails`.
   */
  test.fail('a deep link opens Explore with its query already applied', async ({ page }) => {
    await page.goto('/explore?query=chicken');

    await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('explore-search').locator('input')).toHaveValue('chicken');
  });
});
