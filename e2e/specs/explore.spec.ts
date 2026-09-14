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
    /**
     * **Updated at P21, for the third time, and this is the last of them.**
     *
     * It looked for "Home is not available yet" until P15, "Saved is not available yet" until P17,
     * and "Assistant is not available yet" until P21 registered the final screen. Each version was
     * correct when written and the registry changed under it — so each was replaced by the stronger
     * claim, never deleted.
     *
     * The stronger claim here is the screen's **idle** state rather than merely its root, because
     * `assistant-screen` would be satisfied by a mounted component that rendered nothing usable.
     * Idle is the state a user actually meets: a question field they can type into, with nothing
     * asked yet.
     *
     * With this line, **every route in `SCREEN_ROUTE_NAMES` has a screen behind it** and
     * `PlaceholderScreen` is unreachable through the app.
     */
    await page.getByRole('tab', { name: 'Assistant' }).click();
    await expect(page.getByTestId('assistant-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('assistant-idle')).toBeVisible();
    await expect(page.getByTestId('assistant-question')).toBeVisible();
  });

  /**
   * **R-44, closed — and `test.fail` is gone, which is exactly what it was kept for** (T-22-03).
   *
   * The cause was never in `linking.ts`. `App.tsx` mounted `NavigationContainer` above
   * `<RootNavigator phase={fontsReady ? phase : 'hydrating'} />`, and the container resolves the
   * URL **once**, at its first mount, against whatever routes the stack then holds — only
   * `Splash`, because on the web a `Font.loadAsync` fetch always loses to a synchronous
   * `localStorage` read. `StackRouter` discarded the parsed `Tabs` route as unknown and the
   * address bar was rewritten to `/home`. The font gate now holds the container's MOUNT.
   *
   * **Two of R-44's recorded symptoms were wrong, and both change these tests.**
   *  1. "A path does restore." None did. `/saved` looked right because `ui.lastTab` was feeding
   *     `TabNavigator`'s `initialRouteName` — the right screen for an unrelated reason. So every
   *     case seeds a RIVAL tab, and `beats the stored tab` proves that seed is live.
   *  2. The old body had no `enterApp`, so it could not have passed even once fixed: P14 added the
   *     onboarding gate after it was written, and an empty device holds no `Tabs` route at all.
   *
   * **`toHaveURL` on every case**, because the recorded symptom includes the URL being *rewritten*:
   * a screen assertion alone passes for an app that landed correctly and then lied about where.
   */
  test.describe('a cold URL loads its own screen (T-22-03)', () => {
    /** TSD §5.1, stated as `assistant.spec.ts` states it — a spec asserts from outside the app. */
    const API = 'http://127.0.0.1:4000';
    /** TSD §6.4's key name, restated for the same reason `appPhase.ts` restates its two. */
    const UI_KEY = '@nutritime/ui/v1';

    /**
     * The ten `ROUTE_PATHS` entries, less `/splash` which has its own case below.
     *
     * `rival` is a stored tab the URL does **not** name, so no row can be won by
     * `initialRouteName` defaulting onto the right screen. `seed: false` means a genuinely empty
     * device, which is the only phase `Onboarding` exists in (TSD §6.1). `{id}` is filled from the
     * catalog — a hard-coded meal id would make this a fixture rather than a URL.
     */
    const COLD_PATHS = [
      { url: '/home', screen: 'home-screen', rival: 'settings', seed: true },
      { url: '/explore', screen: 'explore-screen', rival: 'settings', seed: true },
      { url: '/assistant', screen: 'assistant-screen', rival: 'settings', seed: true },
      { url: '/saved', screen: 'saved-screen', rival: 'settings', seed: true },
      { url: '/settings', screen: 'settings-screen', rival: 'saved', seed: true },
      { url: '/meal-form', screen: 'meal-form-screen', rival: 'saved', seed: true },
      { url: '/meal-details/{id}', screen: 'meal-details-screen', rival: 'saved', seed: true },
      { url: '/dietary-setup', screen: 'dietary-setup-screen', rival: 'saved', seed: true },
      { url: '/onboarding', screen: 'onboarding-screen', rival: 'home', seed: false },
    ] as const;

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

    /** A real catalog id, read from the running server. */
    async function firstMealId(page: Page): Promise<string> {
      const response = await page.request.get(`${API}/api/v1/meals?pageSize=1&page=1`);
      expect(response.ok(), 'the catalog must be readable for this case to mean anything').toBe(
        true,
      );
      const body = (await response.json()) as { readonly meals: readonly { id: string }[] };
      const [first] = body.meals;
      if (first === undefined) {
        throw new Error('the catalog answered with no meals; this case cannot mean anything');
      }
      return first.id;
    }

    for (const { url, screen, rival, seed } of COLD_PATHS) {
      test(`${url} opens ${screen}`, async ({ page }) => {
        const target = url.includes('{id}')
          ? url.replace('{id}', await firstMealId(page))
          : url.toString();
        if (seed) {
          // A cold deep link into the app phase is a RETURNING user's link: the device already
          // holds the onboarding answer, and `goto` is still a full document load at that URL.
          await enterApp(page);
          await seedTab(page, rival);
        }

        await page.goto(target);

        await expect(page.getByTestId(screen)).toBeVisible({ timeout: FIRST_PAINT_MS });
        await expect(page).toHaveURL(target);
      });
    }

    test('beats the stored tab, so the right screen is not a coincidence', async ({ page }) => {
      await enterApp(page);
      await seedTab(page, 'settings');

      // The seed is LIVE: with no path to obey, `initialRouteName` opens Settings. Without this
      // half, "the URL won" would be indistinguishable from "the stored tab agreed".
      await page.goto('/');
      await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

      // Same seed, a path naming another tab — and the path wins, screen and address bar both.
      await page.goto('/saved');
      await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page).toHaveURL('/saved');
    });

    /**
     * **`/splash` is the one of the ten that cannot restore, and that is TSD §6.1 rather than a
     * defect here.** `Splash` is in the navigator only during `hydrating`, and the hydration gate
     * renders INSTEAD of the navigator — so the phase has always settled by the time the container
     * mounts, and `Splash` is not a route it can resolve to. Asserted as the degradation it is.
     */
    test('/splash degrades to the app rather than stranding the user on a boot surface', async ({
      page,
    }) => {
      await enterApp(page);

      await page.goto('/splash');

      await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page).not.toHaveURL('/splash');
    });

    test('applies a query param from the URL, which is R-44 verbatim', async ({ page }) => {
      await enterApp(page);
      await seedTab(page, 'settings');

      await page.goto('/explore?query=chicken');

      await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByTestId('explore-search').locator('input')).toHaveValue('chicken');
      await expect(page).toHaveURL('/explore?query=chicken');
    });
  });

  /**
   * **T-24-03's second surface — and Explore's correct behaviour is the OPPOSITE of Home's.**
   *
   * `home-allergy.spec.ts` asserts that a conflicting meal is **absent** from the three
   * recommendations. This block asserts that the same meal is **present** in Explore and that the
   * user is told about the conflict when they open it. Both halves are the one acceptance row, and
   * asserting absence here would pin a defect as the design.
   *
   * **The authority, because two documents disagree and the code sides with the higher one.**
   * `TSD.md` §8.4 case 2 says a declared peanut allergy keeps peanut meals "off Home and **out of
   * Explore**". `PRD.md` FR-007 scopes the rejection to *candidates* — the recommendation path —
   * and FR-010 gives Explore a search and three filters with no allergy among them; FR-011 puts the
   * allergen notice on the **detail** screen. PRD outranks TSD, and the shipped code is
   * unambiguous on the same side: `GET /api/v1/meals`' parameter allowlist
   * (`apps/server/src/routes/meals.ts`) has no `allergies` key at all, `ExploreScreen`'s docstring
   * says it "filters nothing and ranks nothing", and `MealDetailsBody`'s own user-facing copy reads
   * *"The catalog lists every meal, which is how you reached it."* TSD §8.4's wording is recorded as
   * a divergence in this phase's report; it is not repaired by a test that fails against a correct
   * app.
   *
   * **The fixture is hard-named from the catalog, not asked of the domain.** Deriving "the peanut
   * meals" from `allergenTags` — which is what the filter itself consults — would let a change that
   * broke the exclusion quietly shrink the fixture set instead of reddening anything.
   * `pad-see-ew` is named because `packages/catalog/meals.json` records it with
   * `allergenTags: ["egg","gluten","peanut","shellfish","soy","wheat"]` **and** `peanut oil` among
   * its ingredients, so it conflicts by both of `conflictingAllergens`' first two paths.
   *
   * **`peanut` is canonical**, which R-30 makes a thing to check rather than assume:
   * `CANONICAL_ALLERGENS` in `packages/contracts/src/core.ts` lists it, and
   * `allergen-lexicon.ts` carries `peanut butter`, `peanut oil` and `peanut sauce`. A spec written
   * around `cilantro` would pass or fail for reasons that have nothing to do with this surface.
   */
  test.describe('a declared allergy does not empty the catalogue (T-24-03)', () => {
    /** TSD §5.1, restated as the specs above restate it: a spec asserts from outside the app. */
    const API = 'http://127.0.0.1:4000';

    /** Hard-named from `packages/catalog/meals.json`, for the reason in the block docstring. */
    const PEANUT_MEAL = { id: 'pad-see-ew', name: 'Pad See Ew' } as const;
    /**
     * A second catalog record with no peanut, so "shows a notice" cannot be true of every meal.
     * `allergenTags` is `["milk"]` — it carries an allergen, just not the declared one, which is a
     * sharper control than a record with no tags at all.
     *
     * The casing is the catalog's own (`Stilton soup`, not `Stilton Soup`): the first version of
     * this constant was title-cased from memory and failed on `meal-details-name`. Transcribed.
     */
    const CLEAN_MEAL = { id: 'broccoli-stilton-soup', name: 'Broccoli & Stilton soup' } as const;

    /** Search by name and open the row, which is the path a browsing user actually takes. */
    async function openFromExplore(
      page: Page,
      meal: { readonly id: string; readonly name: string },
    ): Promise<void> {
      /**
       * **`MealDetails` is a stack screen ABOVE the tab bar, so there is no tab to tap from it.**
       * Measured, not assumed: calling this twice in one test timed out on
       * `getByRole('tab', { name: 'Explore' })` with the details screen showing. Browser back is
       * also the gesture a web user actually has, and the assertion that Explore came back is what
       * stops a failed navigation being read as a missing notice two lines later.
       */
      if (await page.getByTestId('meal-details-screen').isVisible()) {
        await page.goBack();
        await expect(page.getByTestId('explore-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
      }
      await page.getByRole('tab', { name: 'Explore' }).click();
      const input = page.getByTestId('explore-search').locator('input');
      await input.fill('');
      await input.pressSequentially(meal.name, { delay: 20 });
      // Scoped to the Explore screen: Home stays mounted behind it and gives its own cards the
      // same `meal-<id>` ids, so a page-wide selector can match a covered row it cannot click.
      const row = page.getByTestId('explore-screen').getByTestId(`meal-${meal.id}`);
      await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
      await row.click();
      await expect(page.getByTestId('meal-details-screen')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByTestId('meal-details-name')).toHaveText(meal.name);
    }

    /**
     * **The "and" of T-24-03, in one profile across two surfaces.**
     *
     * The same declared allergy is put to both endpoints the app uses, and they must answer
     * *differently*: the catalogue still lists the meal, the recommendation set does not contain
     * it. No single constant satisfies that pair — a server whose allergen filter is dead fails the
     * second assertion, and one that filtered the catalogue too would fail the first.
     *
     * The browser half is the claim a route-level test cannot make: the row is really painted for a
     * user whose stored profile declares the allergy, at this viewport, through the real bundle.
     */
    test('Explore still lists a conflicting meal that Home will not recommend', async ({
      page,
    }) => {
      await enterApp(page, { allergies: ['peanut'] });

      const declared = {
        diet: 'regular',
        allergies: ['peanut'],
        goal: 'balanced',
        budget: 'low',
        dislikedIngredients: [],
      } as const;

      // Explore's own data path, with the allergy declared: the meal is there.
      const listed = await page.request.get(
        `${API}/api/v1/meals?query=${encodeURIComponent(PEANUT_MEAL.name)}`,
      );
      expect(listed.ok()).toBe(true);
      const listedBody = (await listed.json()) as { readonly meals: readonly { id: string }[] };
      expect(
        listedBody.meals.map((meal) => meal.id),
        'the catalogue must still carry the meal, or Explore is filtering and FR-010 is wrong',
      ).toContain(PEANUT_MEAL.id);

      // The recommendation path, same declared allergy: the meal is not there. This is the half a
      // dead allergen filter fails, and it is asserted here so the two answers sit side by side.
      const recommended = await page.request.post(`${API}/api/v1/recommendations`, {
        data: { mealPeriod: 'lunch', aiEnabled: false, preferences: declared, favoriteMealIds: [] },
      });
      expect(recommended.ok()).toBe(true);
      const recommendedBody = (await recommended.json()) as {
        readonly recommendations: readonly { readonly meal: { readonly id: string } }[];
      };
      expect(
        recommendedBody.recommendations.map((entry) => entry.meal.id),
        `${PEANUT_MEAL.id} conflicts with a declared peanut allergy and must not be recommended`,
      ).not.toContain(PEANUT_MEAL.id);

      // And the row is really on screen, not merely in a response body.
      await page.getByRole('tab', { name: 'Explore' }).click();
      const input = page.getByTestId('explore-search').locator('input');
      await input.fill('');
      await input.pressSequentially(PEANUT_MEAL.name, { delay: 20 });
      await expect(
        page.getByTestId('explore-screen').getByTestId(`meal-${PEANUT_MEAL.id}`),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByTestId('explore-empty')).toBeHidden();
    });

    /**
     * **What Explore is asserted for is the NOTICE, and it has to be NAMED rather than present.**
     *
     * "Contains allergens" is a sentence the user cannot act on, so the assertion is on the word
     * `peanut` appearing in the notice — which is also what separates the real
     * `conflictingAllergens` call from a screen doing its own tag intersection.
     *
     * Two cases here and one in the test below, because any one of them alone proves nothing:
     *  1. the conflicting meal under a declared peanut allergy — the notice, naming peanut;
     *  2. a peanut-free catalog record under the same declared allergy — no notice, which a "warn
     *     on every meal while any allergy is declared" constant fails;
     *  3. the SAME meal with the allergy withdrawn — no notice, which an "always warn" constant
     *     fails. That one is the test below, because it needs a different stored profile.
     */
    test('opening it from Explore names the conflicting allergen', async ({ page }) => {
      await enterApp(page, { allergies: ['peanut'] });
      await openFromExplore(page, PEANUT_MEAL);

      const notice = page.getByTestId('meal-details-allergen-conflict');
      await expect(notice).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(notice, 'the notice must name the allergen, not merely exist').toContainText(
        'peanut',
      );
      // And it must not read as a safety guarantee (PRD §6, PRD §7.3): the copy sends the user to
      // the label rather than telling them the screen has settled it.
      await expect(notice).toContainText('check the label');

      // Case 2: another record, same declared allergy, no conflict — so the notice is keyed on the
      // meal and not on the profile.
      await openFromExplore(page, CLEAN_MEAL);
      await expect(page.getByTestId('meal-details-allergen-conflict')).toHaveCount(0);
    });

    test('and withdraws the notice when no allergy is declared', async ({ page }) => {
      // Case 3, one field different from the test above: same meal, same route, no allergy.
      await enterApp(page, { allergies: [] });
      await openFromExplore(page, PEANUT_MEAL);

      await expect(page.getByTestId('meal-details-allergen-conflict')).toHaveCount(0);
      // And no "this screen cannot check your allergies" either: an empty list that was read
      // cleanly is not an unknown one, and that warning here would say something false.
      await expect(page.getByTestId('meal-details-allergies-unknown')).toHaveCount(0);
      // The meal's own allergen tags are still shown — a different statement from a conflict, and
      // FR-011 lists them among the detail screen's fields.
      await expect(page.getByTestId('meal-details-allergen-tags')).toBeVisible();
    });
  });
});
