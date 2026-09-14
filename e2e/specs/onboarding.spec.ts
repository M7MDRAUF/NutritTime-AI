import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * A genuinely empty device, without an init script.
 *
 * **`page.addInitScript` was the first attempt and it broke the reload spec.** It runs in EVERY new
 * document on the page, reloads included — so a spec that onboarded and then reloaded had its
 * storage wiped on the way back in, and the app correctly showed onboarding again. The test was
 * asserting that persistence works while deleting the data.
 *
 * Load, clear, reload: after this the app has booted against an empty store exactly once, and a
 * later `page.reload()` keeps whatever the user did.
 */
async function firstLaunch(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
}

const FIRST_PAINT_MS = 20_000;

test.describe('first launch', () => {
  test('opens onboarding, not the app', async ({ page }) => {
    await firstLaunch(page);

    await expect(page.getByTestId('onboarding-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    /**
     * **The protected screens do not exist**, which is TSD §6.1's guarantee and the whole reason
     * the phase decides the navigator's contents rather than a redirect sitting on top of them.
     * Asserted as an absence of the TAB BAR: if `Tabs` were mounted and merely covered, the tabs
     * would still be in the accessibility tree.
     */
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveCount(0);
    await expect(page.getByTestId('explore-screen')).toHaveCount(0);
  });

  test('shows the safety disclaimer BEFORE asking for an allergy list', async ({ page }) => {
    // FR-007, and the ordering is the point: a disclaimer shown after the allergy form is shown
    // too late to inform the decision it is about.
    await firstLaunch(page);
    await expect(page.getByTestId('onboarding-disclaimer')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByTestId('onboarding-disclaimer')).toContainText('not medical advice');
    await expect(page.getByTestId('field-allergies')).toHaveCount(0);
  });

  test('offers allergies as a fixed list with no text box', async ({ page }) => {
    // R-30's containment, through a browser. A typed term the lexicon does not know would look
    // exactly like protection and provide none.
    await firstLaunch(page);
    await page.getByTestId('onboarding-continue').click();

    const allergies = page.getByTestId('field-allergies');
    await expect(allergies).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(allergies.getByRole('checkbox')).toHaveCount(10);
    await expect(allergies.locator('input, textarea')).toHaveCount(0);
  });

  test('completes the journey and lands in the app', async ({ page }) => {
    await firstLaunch(page);
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

    await page.getByTestId('chip-allergy-peanut').click();
    await page.getByTestId('chip-diet-vegetarian').click();
    await page.getByTestId('dietary-setup-save').click();

    // The phase advanced, so the tabs now exist — which they could not during onboarding.
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('onboarding-screen')).toHaveCount(0);
  });

  test('and the choices survive a reload', async ({ page }) => {
    /**
     * FR-003's "preferences survive restarts", which is the half a unit test cannot reach: it goes
     * through the real envelope, the real AsyncStorage web driver, and a genuine page load.
     */
    await firstLaunch(page);
    await page.getByTestId('onboarding-continue').click();
    await page.getByTestId('chip-allergy-peanut').click();
    await page.getByTestId('chip-diet-vegan').click();
    await page.getByTestId('dietary-setup-save').click();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });

    // A plain reload. `firstLaunch` cleared once, before the journey, so nothing clears now — see
    // the note on that helper for why an init script cannot be used here.
    await page.reload();

    // Straight into the app: onboarding is not shown a second time.
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('onboarding-screen')).toHaveCount(0);

    /**
     * **And the CHOICES survived, which the first version of this spec never checked.**
     *
     * It asserted only that onboarding was not shown again — that is the `onboarding` key. Dropping
     * every `preferences` write would have left it green, while the docstring claimed FR-003's
     * "preferences survive restarts". The allergy has to still be selected, so the form is reopened
     * and read.
     */
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });

    // Read it from storage as well as from the form, because the form could in principle render a
    // default that happened to match.
    const stored = await page.evaluate(() =>
      window.localStorage.getItem('@nutritime/preferences/v1'),
    );
    expect(stored, 'the preferences key must exist after a reload').not.toBeNull();
    const parsed = JSON.parse(stored ?? '{}') as {
      readonly value: { readonly allergies: string[]; readonly diet: string };
    };
    expect(parsed.value.allergies).toStrictEqual(['peanut']);
    expect(parsed.value.diet).toBe('vegan');
  });

  test('a malformed meal time is reported on the field, on blur', async ({ page }) => {
    // T-14-05. Blur-time, bound to the field, and not a banner at the top of the form.
    await firstLaunch(page);
    await page.getByTestId('onboarding-continue').click();

    const breakfast = page.getByTestId('field-breakfast').locator('input');
    await breakfast.fill('08:');
    // Still typing: no complaint yet.
    await expect(page.getByTestId('field-breakfast')).not.toContainText('24-hour');

    await breakfast.blur();
    await expect(page.getByTestId('field-breakfast')).toContainText('24-hour');
    // And nowhere else.
    await expect(page.getByTestId('field-lunch')).not.toContainText('24-hour');
  });
});
