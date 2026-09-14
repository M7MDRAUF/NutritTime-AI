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
   * `Settings` has no screen until P18, so the route into the form from there does not exist yet —
   * which is why this is `test.fixme` rather than a weakened assertion. The body is the real one,
   * written now so T-18-02 turns it on by registering a screen rather than by having to work out
   * what to assert. The dom suite covers the mechanism meanwhile (`Home.dom.test.tsx`, "discards
   * the meals on screen the moment an allergy changes").
   */
  test.fixme('adding an allergy from the dietary form clears what is on Home', async ({ page }) => {
    await onboardWith(page, []);
    await expect(page.getByTestId('home-recommendations')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const before = await recommendedIds(page);
    expect(before.length).toBeGreaterThan(0);

    // The route T-18-02 will provide: Settings -> edit preferences.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByTestId('settings-edit-preferences').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('chip-allergy-peanut').click();
    await page.getByTestId('dietary-setup-save').click();

    // Back on Home, the previous set must be gone rather than replaced when the new one lands.
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    const after = await recommendedIds(page);
    expect(after).not.toStrictEqual(before);
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
