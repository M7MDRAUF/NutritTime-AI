import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The allergy exclusion, visible end to end (T-15-08). TSD §8.4 case 2.
 *
 * **This is the one spec in the suite that is about safety rather than about behaviour.** Everything
 * it exercises has already been asserted somewhere else — the domain's rejection in
 * `allergens.test.ts`, the route's in `recommendations.integration.test.ts`, the screen's in
 * `Home.dom.test.tsx`. What none of those can show is the three of them agreeing: a request the
 * client builds, a filter the server applies, and a list the browser paints.
 *
 * The peanut meal is found from the page rather than hard-coded, so the spec cannot be quietly
 * invalidated by a catalog change.
 */

const FIRST_PAINT_MS = 20_000;

async function onboardWith(page: Page, allergens: readonly string[]): Promise<void> {
  // Load, clear, reload — never `addInitScript`, which would re-clear on the reload later in this
  // file and make a persistence assertion delete its own evidence.
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await page.getByTestId('onboarding-continue').click();
  await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  for (const allergen of allergens) {
    await page.getByTestId(`chip-allergy-${allergen}`).click();
  }
  await page.getByTestId('dietary-setup-save').click();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** Every meal id Home is currently showing. */
async function recommendedIds(page: Page): Promise<string[]> {
  const rows = await page.locator('[data-testid^="recommendation-"]').all();
  const ids: string[] = [];
  for (const row of rows) {
    const testId = await row.getAttribute('data-testid');
    ids.push((testId ?? '').replace('recommendation-', ''));
  }
  return ids;
}

test.describe('the allergy exclusion, end to end', () => {
  test('Home shows meals for a user with no allergies', async ({ page }) => {
    // The control. Without it, the exclusion below could pass because Home shows nothing at all.
    await onboardWith(page, []);
    await expect(page.getByTestId('home-recommendations')).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect((await recommendedIds(page)).length).toBeGreaterThan(0);
  });

  test('no peanut-tagged meal reaches Home for a declared peanut allergy', async ({ page }) => {
    /**
     * Read from the SERVER rather than from a fixture: the catalog's peanut meals are whatever the
     * seeded data says they are, so this spec cannot be invalidated by the catalog changing under
     * it, and it fails loudly if the catalog stops having any.
     */
    const response = await page.request.get(
      'http://127.0.0.1:4000/api/v1/meals?pageSize=50&page=1',
    );
    expect(response.ok()).toBe(true);
    const firstPage = (await response.json()) as {
      readonly meals: readonly { readonly id: string; readonly allergenTags: readonly string[] }[];
      readonly total: number;
    };
    const second = await page.request.get('http://127.0.0.1:4000/api/v1/meals?pageSize=50&page=2');
    const secondPage = (await second.json()) as { readonly meals: typeof firstPage.meals };
    const all = [...firstPage.meals, ...secondPage.meals];

    const peanutIds = all.filter((meal) => meal.allergenTags.includes('peanut')).map((m) => m.id);
    expect(
      peanutIds.length,
      'the catalog must contain a peanut meal for this to mean anything',
    ).toBeGreaterThan(0);

    await onboardWith(page, ['peanut']);
    await expect(
      page.getByTestId('home-recommendations').or(page.getByTestId('home-empty')),
    ).toBeVisible({ timeout: FIRST_PAINT_MS });

    const shown = await recommendedIds(page);
    for (const id of peanutIds) {
      expect(shown, `${id} must not be recommended`).not.toContain(id);
    }
  });

  /**
   * FR-003 through a browser — and the first version of this spec **changed no allergy at all**.
   *
   * It was named for the requirement, tapped the Settings tab, and asserted the placeholder
   * heading. Nothing about FR-003 could have failed it, while P13's report closed by saying this was
   * where FR-003 would stop being argued about.
   *
   * P14 then parked it as `test.fixme` because `Settings` had no screen and the route into the form
   * did not exist. **T-18-02 built the screen, so this is a live test now**, and it keeps every
   * claim the parked body made while closing the two holes it could not reach:
   *
   *  1. **The allergen is chosen from the catalog rather than named.** The parked body tapped
   *     `peanut` and then asserted `after !== before`, which is **vacuous whenever none of the three
   *     meals on screen carries peanut** — adding an allergy only removes meals, so if the shown set
   *     is peanut-free the server legitimately returns the same three and the assertion fails
   *     against a correct app. Measured: the three meals Home shows on a default profile were
   *     `home-made-mandazi`, `chocolate-gateau` and `eton-mess`, none of them peanut. So the
   *     allergen is the one carried by the most of the meals actually on screen, read from the
   *     server the way the peanut test above reads it.
   *  2. **The discard is observed, not inferred.** FR-003 is "discards the recommendations currently
   *     on screen **and** re-runs filtering", and a test that only compares before with after
   *     asserts the second half. The re-request is held at the network edge, so the state between
   *     the two is visible: `home-recommendations` renders only in `loaded`, and while the new
   *     request is in flight the old meals must be gone rather than left on screen under a
   *     preference set that rules them out. That is the half `useRecommendations` sets to `pending`
   *     *before* it asks, and the half a stale-list defect would fail.
   *
   * The dispatch happens on the CHIP, not on Save — the form writes each toggle straight to the
   * store — and Home is mounted behind the Settings tab the whole time, so the gate is installed
   * before the chip is tapped or the response would already have landed.
   */
  test('adding an allergy from the dietary form clears what is on Home', async ({ page }) => {
    await onboardWith(page, []);
    await expect(page.getByTestId('home-recommendations')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const before = await recommendedIds(page);
    expect(before.length).toBeGreaterThan(0);

    /** The catalog, from the SERVER, so a catalog change cannot quietly invalidate this. */
    const catalog: { readonly id: string; readonly allergenTags: readonly string[] }[] = [];
    for (const pageNumber of [1, 2]) {
      const response = await page.request.get(
        `http://127.0.0.1:4000/api/v1/meals?pageSize=50&page=${String(pageNumber)}`,
      );
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as { readonly meals: typeof catalog };
      catalog.push(...body.meals);
    }
    const tagsOf = (mealId: string): readonly string[] =>
      catalog.find((meal) => meal.id === mealId)?.allergenTags ?? [];

    /**
     * The allergen the chips offer that rules out the most of what is on screen right now.
     * `CANONICAL_ALLERGENS` from `packages/contracts`, restated: this spec asserts from outside the
     * app, and the list is also exactly the set of chips `DietarySetupScreen` renders (R-30).
     */
    const choices = [
      'peanut',
      'tree-nut',
      'milk',
      'egg',
      'soy',
      'wheat',
      'gluten',
      'fish',
      'shellfish',
      'sesame',
    ] as const;
    const ranked = choices
      .map((allergen) => ({
        allergen,
        conflicting: before.filter((mealId) => tagsOf(mealId).includes(allergen)),
      }))
      .sort((left, right) => right.conflicting.length - left.conflicting.length);
    const chosen = ranked[0];
    expect(
      chosen?.conflicting.length ?? 0,
      'none of the meals on screen carries any allergen the form offers, so this test would be vacuous',
    ).toBeGreaterThan(0);
    if (chosen === undefined) {
      return;
    }

    /**
     * The re-request, held open until this test releases it. A duration would be a figure no
     * document gives and a flake waiting to happen; a gate is an ordering.
     */
    // Declared with a no-op rather than `null`: the assignment happens inside the executor
    // callback, which TypeScript's control-flow analysis cannot see through.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/v1/recommendations**', async (route) => {
      await gate;
      await route.continue();
    });

    // The route T-18-02 provides: Settings -> edit preferences.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('settings-edit-preferences').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId(`chip-allergy-${chosen.allergen}`).click();
    await page.getByTestId('dietary-setup-save').click();
    // `returnTo: 'Settings'` makes Save a `goBack`, so the form returns here rather than completing
    // onboarding a second time.
    await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

    /**
     * **DISCARDED.** Back on Home with the new request still in flight: the previous meals are gone
     * rather than being left on screen until they are replaced. A screen that kept them would show
     * this user meals their own declared allergy rules out.
     */
    await page.getByRole('tab', { name: 'Home' }).click();
    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-recommendations')).toHaveCount(0);
    expect(await recommendedIds(page), 'the old set must not survive the change').toStrictEqual([]);

    /** **RE-FILTERED.** The response is allowed through, and what comes back obeys the new list. */
    release();
    await expect(
      page.getByTestId('home-recommendations').or(page.getByTestId('home-empty')),
    ).toBeVisible({ timeout: FIRST_PAINT_MS });
    const after = await recommendedIds(page);
    // The claim the parked body made, kept.
    expect(after).not.toStrictEqual(before);
    // And the claims it could not make: every conflicting meal that WAS on screen is gone, and
    // nothing carrying the new allergen came back in its place.
    for (const mealId of chosen.conflicting) {
      expect(
        after,
        `${mealId} conflicts with ${chosen.allergen} and must not come back`,
      ).not.toContain(mealId);
    }
    for (const mealId of after) {
      expect(
        tagsOf(mealId),
        `${mealId} was recommended although it carries ${chosen.allergen}`,
      ).not.toContain(chosen.allergen);
    }
  });

  test('the disclaimer is on Home, above the meals', async ({ page }) => {
    // FR-007 / T-15-06, in a real browser at a real viewport.
    await onboardWith(page, []);
    const disclaimer = page.getByTestId('home-disclaimer');
    await expect(disclaimer).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(disclaimer).toContainText('not medical advice');

    const disclaimerBox = await disclaimer.boundingBox();
    const meals = await page.getByTestId('home-recommendations').boundingBox();
    expect(disclaimerBox).not.toBeNull();
    expect(meals).not.toBeNull();
    if (disclaimerBox !== null && meals !== null) {
      // Geometry, not document order: what matters is that it is above them on the screen.
      expect(disclaimerBox.y).toBeLessThan(meals.y);
    }
  });

  test('the meal period is shown even with the API dead', async ({ page }) => {
    // T-15-01's acceptance, in a browser: computed on the device, so nothing about it needs the
    // server. Onboarded first, then the route is killed, so the app is past the phase gate.
    await onboardWith(page, []);
    await page.route('**/api/v1/recommendations', async (route) => {
      await route.abort('connectionrefused');
    });
    await page.reload();

    await expect(page.getByTestId('home-period')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-offline')).toBeVisible();
    await expect(page.getByTestId('home-period')).not.toBeEmpty();
  });
});
