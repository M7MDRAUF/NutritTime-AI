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
 * The peanut meals are read from the SERVER rather than hard-coded, so the spec cannot be quietly
 * invalidated by a catalog change and fails loudly if the catalog stops having any. What that on
 * its own does not buy is **reachability** — that one of them would have been recommended at all —
 * and reachability is what makes "it is gone" a claim rather than a coincidence. See the profile
 * above the peanut test for the two settings that buy it and for the vacuity they repair.
 */

const FIRST_PAINT_MS = 20_000;

/**
 * A local wall-clock instant inside the DEFAULT lunch window (`mealTimes.lunch` is `12:30`, and the
 * domain's window runs from 90 minutes before the anchor to 120 after).
 *
 * **Why the clock and not the meal times.** The period is derived on the device from the wall clock
 * and the user's own anchors, so a spec that needs a particular period has to own one of the two.
 * Moving the anchors through the form was tried first and is not available: `dietaryValidation`
 * requires breakfast < lunch < dinner, so an anchor triple built around "now" is rejected outright
 * whenever "now" is close to either end of the day — this suite would have been red between 00:00
 * and 00:01 and again at 23:59. Fixing the clock instead leaves every preference at its documented
 * default, and `setFixedTime` keeps timers running, so nothing else about the app changes.
 *
 * The date is arbitrary and the time is not: `home-period` is asserted to read `Lunch` immediately
 * afterwards, so a timezone or a changed default that moved the app out of the lunch window fails
 * loudly here rather than silently restoring the vacuity this test exists to repair.
 */
const INSIDE_THE_LUNCH_WINDOW = new Date(2026, 0, 15, 12, 30, 0);

interface OnboardingProfile {
  /** Narrowed through the form's own chips, because the budget band changes the ranking. */
  readonly budget?: 'low' | 'medium' | 'high';
  /** Freeze the device clock at {@link INSIDE_THE_LUNCH_WINDOW} before the app first boots. */
  readonly atLunchtime?: boolean;
}

async function onboardWith(
  page: Page,
  allergens: readonly string[],
  profile: OnboardingProfile = {},
): Promise<void> {
  if (profile.atLunchtime === true) {
    // Before the first `goto`: the period is computed on mount, so a clock set afterwards would be
    // read only by a later re-render and this would depend on the order of two unrelated things.
    await page.clock.setFixedTime(INSIDE_THE_LUNCH_WINDOW);
  }
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
  if (profile.budget !== undefined) {
    await page.getByTestId(`chip-budget-${profile.budget}`).click();
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

  /**
   * **The profile that makes the exclusion observable, and why it is not the default one.**
   *
   * The first version of this test onboarded with the DEFAULT budget and whatever period the clock
   * happened to fall in, and was therefore vacuous in exactly the way `Home.dom.test.tsx`'s first
   * peanut test was: re-derived against the real catalog through the real `recommend()`, the top
   * three are **byte-identical with and without a peanut allergy at every period on the medium
   * band**, because `pad-see-ew` ranks 4th of 60 at lunch and `rocky-road-fudge` 6th at snack.
   * Deleting the server's allergen rejection outright would have left it green.
   *
   * Two things have to be true for "it is gone" to mean anything, and neither is true by default:
   *
   *  1. **The low budget**, which lifts `pad-see-ew` (73) into the top three at lunch.
   *  2. **The lunch period**, which is the only period where a peanut meal makes the cut on that
   *     band — and the period is derived on the device, so a spec that does not own it is a spec
   *     whose meaning changes with the time of day it runs at.
   *
   * The budget goes through the chips a user actually taps; the period comes from a fixed device
   * clock, for the reason recorded on INSIDE_THE_LUNCH_WINDOW. Neither is trusted: the control
   * below asserts the period on screen and then asserts that a peanut meal really is among the
   * three, so if a catalog change ever pushes it back out, the CONTROL fails loudly instead of the
   * claim going quietly vacuous again.
   */
  const PEANUT_REACHABLE: OnboardingProfile = { budget: 'low', atLunchtime: true };

  test('a peanut meal Home does recommend is gone once the allergy is declared', async ({
    page,
  }) => {
    /**
     * Read from the SERVER rather than from a fixture: the catalog's peanut meals are whatever the
     * seeded data says they are, so this spec cannot be invalidated by the catalog changing under
     * it, and it fails loudly if the catalog stops having any.
     */
    const all: { readonly id: string; readonly allergenTags: readonly string[] }[] = [];
    for (const pageNumber of [1, 2]) {
      const response = await page.request.get(
        `http://127.0.0.1:4000/api/v1/meals?pageSize=50&page=${String(pageNumber)}`,
      );
      expect(response.ok()).toBe(true);
      const body = (await response.json()) as { readonly meals: typeof all };
      all.push(...body.meals);
    }

    const peanutIds = all.filter((meal) => meal.allergenTags.includes('peanut')).map((m) => m.id);
    expect(
      peanutIds.length,
      'the catalog must contain a peanut meal for this to mean anything',
    ).toBeGreaterThan(0);

    /**
     * **The control, and it is the half without which the rest asserts nothing.** A meal that was
     * never going to be in the three is "excluded" by a server with no filter at all.
     */
    await onboardWith(page, [], PEANUT_REACHABLE);
    await expect(page.getByTestId('home-recommendations')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(
      page.getByTestId('home-period'),
      'the fixed clock must land inside the default lunch window, or the ranking this test relies on is not the one being measured',
    ).toContainText('Lunch');

    const without = await recommendedIds(page);
    const reachable = without.filter((id) => peanutIds.includes(id));
    expect(
      reachable,
      `a peanut meal must be IN the three for its removal to be observable — Home offered ${without.join(', ')} and the catalog's peanut meals are ${peanutIds.join(', ')}`,
    ).not.toHaveLength(0);

    /**
     * The same profile, one field different. Everything that could move the ranking — budget,
     * goal, diet, the meal times, the period they produce — is held still, so the only explanation
     * for a meal leaving the list is the allergy.
     */
    await onboardWith(page, ['peanut'], PEANUT_REACHABLE);
    await expect(
      page.getByTestId('home-recommendations').or(page.getByTestId('home-empty')),
    ).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-period')).toContainText('Lunch');

    const shown = await recommendedIds(page);
    for (const id of reachable) {
      expect(
        shown,
        `${id} was recommended to this exact profile without the allergy, so its absence now is the rule working`,
      ).not.toContain(id);
    }
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
