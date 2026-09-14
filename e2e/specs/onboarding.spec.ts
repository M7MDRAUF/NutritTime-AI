import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';

/**
 * TSD §8.4 flow 1: **first launch → onboarding → Home shows recommendations** (T-24-02).
 *
 * **It is also the spec that proves T-24-01's fixtures work.** `emptyDevice` is the cold
 * first-launch phase, and this file is its only caller that goes on to use the app afterwards — so
 * a fixture that cleared too much (an init script re-clearing on every document) or too little
 * would fail here and nowhere else. The local `firstLaunch` helper it replaces was one of five
 * copies of load-clear-reload across the suite.
 *
 * **This spec clicks through the form and never seeds.** `appPhase.ts` settles that and it is not
 * revisited here: the journey is the thing under test, so `enterApp`'s seeded shortcut would skip
 * exactly the six interactions the flow is about.
 *
 * The last leg — that Home then paints recommendations — was missing until T-24-02: the file ended
 * at the tab bar appearing, which is the phase gate opening rather than the product working.
 */

const FIRST_PAINT_MS = 20_000;

/**
 * A local wall-clock instant inside the DEFAULT lunch window (`mealTimes.lunch` is `12:30`; the
 * domain's window opens 90 minutes before the anchor and closes 120 after).
 *
 * **Only the recommendations test needs it, and it needs it for a reason the earlier tests do
 * not.** That test compares the three cards on screen against the three the SERVER returns for the
 * same request, and the request carries a meal period the device derives from its own clock
 * (TSD §5.4 keeps the clock off the server). Without a fixed instant the spec would have to read
 * the period off the screen it is checking, which pins nothing — the screen would be agreeing with
 * itself. With one, the period is a value this file states and `home-period` is an assertion.
 *
 * The date is arbitrary; the time is not. `setFixedTime` leaves timers running, so nothing else
 * about the app changes.
 */
const INSIDE_THE_LUNCH_WINDOW = new Date(2026, 0, 15, 12, 30, 0);

/** The API's own origin. Duplicated from `playwright.config.ts`, as `home-allergy.spec.ts` does. */
const RECOMMENDATIONS_URL = 'http://127.0.0.1:4000/api/v1/recommendations';

/**
 * `DEFAULT_PREFERENCES` as the recommendation request carries it, hand-transcribed from
 * `apps/mobile/src/infrastructure/storage/definitions.ts`.
 *
 * **Transcribed rather than derived, deliberately.** An e2e spec asserts from outside the app and
 * cannot import its constants — and reading the body off the app's own request would pin nothing:
 * the expectation would agree with whatever the app happened to send. Stated here, the two
 * disagree loudly if a default ever changes, which is the whole reason for having both.
 *
 * `mealTimes`, `aiEnabled` and `themeMode` are absent because the wire shape does not carry them:
 * the server holds no clock, so `recommendationRequestSchema` rejects `mealTimes` outright, and
 * `aiEnabled` is a sibling of `preferences` rather than a member of it.
 */
const DEFAULT_PROFILE_ON_THE_WIRE = {
  diet: 'regular',
  allergies: [],
  goal: 'balanced',
  budget: 'medium',
  dislikedIngredients: [],
} as const;

interface ServerChoice {
  readonly id: string;
  readonly name: string;
  readonly explanation: string;
}

/** What the API recommends for the default profile at lunch, in the order it ranked them. */
async function lunchRecommendations(page: Page): Promise<readonly ServerChoice[]> {
  const response = await page.request.post(RECOMMENDATIONS_URL, {
    data: {
      mealPeriod: 'lunch',
      aiEnabled: true,
      preferences: DEFAULT_PROFILE_ON_THE_WIRE,
      favoriteMealIds: [],
    },
  });
  expect(response.ok(), 'the API answers the request the app makes').toBe(true);
  const body = (await response.json()) as {
    readonly recommendations: readonly {
      readonly meal: { readonly id: string; readonly name: string };
      readonly explanation: string;
    }[];
  };
  return body.recommendations.map((one) => ({
    id: one.meal.id,
    name: one.meal.name,
    explanation: one.explanation,
  }));
}

test.describe('first launch', () => {
  test('opens onboarding, not the app', async ({ page, emptyDevice }) => {
    await emptyDevice();

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

  test('shows the safety disclaimer BEFORE asking for an allergy list', async ({
    page,
    emptyDevice,
  }) => {
    // FR-007, and the ordering is the point: a disclaimer shown after the allergy form is shown
    // too late to inform the decision it is about.
    await emptyDevice();
    await expect(page.getByTestId('onboarding-disclaimer')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(page.getByTestId('onboarding-disclaimer')).toContainText('not medical advice');
    await expect(page.getByTestId('field-allergies')).toHaveCount(0);
  });

  test('offers allergies as a fixed list with no text box', async ({ page, emptyDevice }) => {
    // R-30's containment, through a browser. A typed term the lexicon does not know would look
    // exactly like protection and provide none.
    await emptyDevice();
    await page.getByTestId('onboarding-continue').click();

    const allergies = page.getByTestId('field-allergies');
    await expect(allergies).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(allergies.getByRole('checkbox')).toHaveCount(10);
    await expect(allergies.locator('input, textarea')).toHaveCount(0);
  });

  test('completes the journey and lands in the app', async ({ page, emptyDevice }) => {
    await emptyDevice();
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

    await page.getByTestId('chip-allergy-peanut').click();
    await page.getByTestId('chip-diet-vegetarian').click();
    await page.getByTestId('dietary-setup-save').click();

    // The phase advanced, so the tabs now exist — which they could not during onboarding.
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('onboarding-screen')).toHaveCount(0);
  });

  test('and the choices survive a reload', async ({ page, emptyDevice }) => {
    /**
     * FR-003's "preferences survive restarts", which is the half a unit test cannot reach: it goes
     * through the real envelope, the real AsyncStorage web driver, and a genuine page load.
     */
    await emptyDevice();
    await page.getByTestId('onboarding-continue').click();
    await page.getByTestId('chip-allergy-peanut').click();
    await page.getByTestId('chip-diet-vegan').click();
    await page.getByTestId('dietary-setup-save').click();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });

    // A plain reload. `emptyDevice` cleared once, before the journey, so nothing clears now — see
    // the note on that fixture for why an init script cannot be used here.
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

  test('and Home then shows the three recommendations the server chose', async ({
    page,
    emptyDevice,
  }) => {
    /**
     * **The leg that makes this TSD §8.4 flow 1 rather than TSD §6.1's phase gate.**
     *
     * "Home shows recommendations" cannot be asserted as "something is on the screen": the loading
     * line, the offline panel and the empty state are all *something*, and three placeholder cards
     * would satisfy a count. So the expectation comes from a **different authority than the
     * screen** — the server is asked the same question and its answer is what the cards are
     * checked against. A client that requested the wrong period, dropped the response, re-sorted
     * it, or painted its own text fails; a screen agreeing with itself cannot pass.
     */
    // Before the first load. The period is computed on mount, so a clock set afterwards would be
    // read only by some later re-render and this test would depend on the order of two unrelated
    // things.
    await page.clock.setFixedTime(INSIDE_THE_LUNCH_WINDOW);
    await emptyDevice();

    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    /**
     * **Saved with nothing selected, which is the point rather than laziness.** Every preference is
     * then the documented default (`DEFAULT_PREFERENCES`), so {@link DEFAULT_PROFILE_ON_THE_WIRE}
     * can state the request this file expects the app to make instead of reading it off the app.
     */
    await page.getByTestId('dietary-setup-save').click();

    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-screen')).toBeVisible();
    // The heading the fixed clock puts the device in. Derived on the device, never sent by the
    // server (TSD §5.4) — so this is the assertion that the request below was built for the right
    // time of day, and `toHaveText` rather than `toContainText` because the default profile sets
    // no name and the heading is the whole string.
    await expect(page.getByTestId('home-period')).toHaveText('Lunch');

    /**
     * Awaited BEFORE the server is asked, and not for tidiness: TSD §5.5 gives this process one AI
     * lane with a concurrency of 1, so a second recommendation request in flight while the app's
     * own is running would be answered with template explanations and the two answers could
     * legitimately differ. Letting the app finish first makes the comparison about painting rather
     * than about a race.
     */
    await expect(page.getByTestId('home-recommendations')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const chosen = await lunchRecommendations(page);
    expect(chosen, 'PRD §13 and TSD §11.5: the response is fixed at three').toHaveLength(3);

    const cards = page.locator('[data-testid^="recommendation-"]');
    await expect(cards).toHaveCount(chosen.length);
    for (const [index, choice] of chosen.entries()) {
      const card = cards.nth(index);
      // Position by position, so a client that painted the right three in the wrong order fails:
      // the response is ranked, and the top recommendation is the one a user reads first.
      await expect(card, "the server's order is the painted order").toHaveAttribute(
        'data-testid',
        `recommendation-${choice.id}`,
      );
      await expect(card).toContainText(choice.name);
      /**
       * FR-009's sentence, on the card it belongs to. Its SOURCE is deliberately not asserted:
       * under `AI_FAKE` the provider echoes the resolved text, so `explanationSource` is `gemma`
       * with exactly the words the fallback would have used, and a spec that asserted either the
       * badge or the label would be asserting a property of the fake rather than of the product.
       * The text is the part a user reads and the part the fake does not invent.
       */
      await expect(card).toContainText(choice.explanation);
    }
  });

  test('a malformed meal time is reported on the field, on blur', async ({ page, emptyDevice }) => {
    // T-14-05. Blur-time, bound to the field, and not a banner at the top of the form.
    await emptyDevice();
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
