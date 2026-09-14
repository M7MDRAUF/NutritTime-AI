import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * Web storage parity, in a real browser (T-22-06, TSD §6.4, Plan §20's web-storage row, D-01).
 *
 * **What this proves that no Vitest suite can.** `webStorage.test.ts` and `webHydration.test.ts`
 * drive the same driver against the same `localStorage` API, but they stop at the repository: no
 * navigator, no store queue, no rendered surface. The claims below are about what the USER sees
 * when the device refuses a write — the bound notice with no retry, the truncation notice that says
 * the shorter list is already saved, the save-error notice that does offer a retry — and each of
 * those is a lane that runs from a reducer through `createStore`'s queue to `localStorage` and back
 * out through a hydration and a screen. A refusal the storage layer reports correctly and no screen
 * shows is the same thing to a user as no refusal at all.
 *
 * **Every claim is read off the DISK as well as the screen**, for the reason `settings-reset.spec.ts`
 * states: a dispatch empties or fills the screen before any write is attempted, so screen and disk
 * agreeing is a claim rather than a tautology, and each failing alone is a different defect.
 *
 * **A quota-exhausted origin is DRIVEN, not simulated.** `fillOrigin` finds the browser's real
 * quota by measurement and leaves no room to grow, so the refusal below comes from Chromium rather
 * than from a stub. No figure is named: the quota differs by browser, profile and disk, and a
 * hard-coded one would stop exhausting anything the day it changed and leave the test green.
 *
 * Harness lessons obeyed rather than re-learned: **the app opens on HomeTab** and every screen is
 * reached by tapping a tab (web deep linking does not work — R-44); **no `addInitScript`**, which
 * runs in every new document and would re-seed across the reloads these tests depend on.
 */

/** A cold bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/**
 * TSD §6.4's keys and figures, restated rather than imported — this spec asserts from OUTSIDE the
 * app, so a drift between the document and the code must fail here rather than be shared away.
 */
const KEYS = {
  meta: '@nutritime/meta',
  onboarding: '@nutritime/onboarding',
  preferences: '@nutritime/preferences/v1',
  favorites: '@nutritime/favorites/v1',
  customMeals: '@nutritime/custom-meals/v1',
  ui: '@nutritime/ui/v1',
} as const;
const QUARANTINE_KEY = '@nutritime/quarantine/v1';
const BOUND = 200;

/** `repository.ts`'s fixed local copy. Never a driver string, never a quota figure (PRD §12). */
const WRITE_FAILED_MESSAGE = 'That change could not be saved.';

const SEEDED_PREFERENCES = {
  schemaVersion: 1,
  diet: 'regular',
  allergies: [],
  goal: 'balanced',
  budget: 'medium',
  dislikedIngredients: [],
  mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
  aiEnabled: true,
  themeMode: 'system',
} as const;

/** `envelope.ts`'s own guard, restated: a type predicate, so nothing here needs an `as`. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rawKey(page: Page, key: string): Promise<string | null> {
  return page.evaluate((name) => window.localStorage.getItem(name), key);
}

/** One key's `value`. **Throws** on anything that is not TSD §6.4's three-field envelope. */
async function storedValue(page: Page, key: string): Promise<unknown> {
  const raw = await rawKey(page, key);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`${key} holds ${raw}, which is not an envelope`);
  }
  expect(Object.keys(parsed).sort(), `${key} must hold TSD §6.4's envelope`).toStrictEqual([
    'schemaVersion',
    'updatedAt',
    'value',
  ]);
  return parsed['value'];
}

async function storedFavoriteIds(page: Page): Promise<readonly string[]> {
  const value = await storedValue(page, KEYS.favorites);
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`the favourites value is ${typeof value}, not a list of ids`);
  }
  return value.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string') {
      throw new Error(`favourite ${String(index)} is stored as ${typeof entry}, not an id`);
    }
    return entry;
  });
}

/** `n` distinct ids that are NOT catalog meals, so none can be confused with the one under test. */
function fillerIds(n: number): readonly string[] {
  return Array.from({ length: n }, (_unused, index) => `seeded-favourite-${String(index)}`);
}

/** Two real catalog ids, read from the server so a catalog change cannot invalidate the spec. */
async function catalogIds(page: Page): Promise<readonly string[]> {
  const response = await page.request.get('http://127.0.0.1:4000/api/v1/meals?pageSize=3&page=1');
  expect(response.ok(), 'the catalog must be reachable for this spec').toBe(true);
  const body = (await response.json()) as { readonly meals: readonly { readonly id: string }[] };
  const ids = body.meals.map((meal) => meal.id);
  expect(ids.length, 'this spec needs a catalog meal to open').toBeGreaterThan(0);
  return ids;
}

/**
 * Load once, seed the origin, reload. Not `addInitScript`, which would re-seed on every reload.
 *
 * Seeded through the real envelope shape so hydration accepts it: a bare value fails
 * `decodeEnvelope` and lands the spec back on onboarding with no clue why.
 */
async function seedApp(
  page: Page,
  favourites: readonly string[],
  corrupt: Readonly<Record<string, string>> = {},
): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ({ keys, quarantineKey, favouriteIds, preferences, broken }) => {
      const at = new Date().toISOString();
      const envelope = (value: unknown): string =>
        JSON.stringify({ schemaVersion: 1, updatedAt: at, value });
      window.localStorage.clear();
      window.localStorage.setItem(keys.meta, envelope({ firstLaunchAt: at, lastLaunchAt: at }));
      window.localStorage.setItem(keys.onboarding, envelope({ completed: true }));
      window.localStorage.setItem(keys.preferences, envelope(preferences));
      window.localStorage.setItem(keys.favorites, envelope(favouriteIds));
      window.localStorage.setItem(keys.customMeals, envelope([]));
      window.localStorage.setItem(
        keys.ui,
        envelope({ lastTab: 'home', disclaimerAcknowledged: true }),
      );
      window.localStorage.removeItem(quarantineKey);
      // Written LAST, so a corrupt key replaces the sound one rather than being overwritten by it.
      for (const [key, payload] of Object.entries(broken)) {
        window.localStorage.setItem(key, payload);
      }
    },
    {
      keys: KEYS,
      quarantineKey: QUARANTINE_KEY,
      favouriteIds: [...favourites],
      preferences: SEEDED_PREFERENCES,
      broken: corrupt,
    },
  );
  await page.reload();
  // The tab bar only exists in the `app` phase, so its presence IS the assertion that the seed was
  // accepted rather than quarantined wholesale.
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
}

function exploreRows(page: Page): Locator {
  // Scoped to the list: React Navigation keeps Home mounted behind Explore and its cards share the
  // `meal-` prefix, so an unscoped selector resolves to a card that cannot be clicked.
  return page.getByTestId('explore-list').locator('[data-testid^="meal-"]');
}

/** Open one catalog meal's details from Explore, loaded far enough that the heart exists. */
async function openDetails(page: Page, mealId: string): Promise<void> {
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await exploreRows(page)
    .and(page.getByTestId(`meal-${mealId}`))
    .click();
  await expect(page.getByTestId('meal-details-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/**
 * Fill the origin until it has no room to grow, and report whether it really refuses.
 *
 * The browser's quota is found by measurement rather than named, and the caller asserts
 * `refusesGrowth` before relying on the state: a quota accounted in coarse blocks could accept a
 * one-character write even at the limit, and that is a state this spec must report rather than
 * assert around.
 */
async function fillOrigin(page: Page): Promise<{ filler: number; refusesGrowth: boolean }> {
  return page.evaluate(() => {
    const FILLER = 'test-origin-filler';
    const PROBE = 'test-origin-probe';
    window.localStorage.removeItem(FILLER);
    window.localStorage.removeItem(PROBE);
    const fits = (length: number): boolean => {
      try {
        window.localStorage.setItem(FILLER, 'x'.repeat(length));
        return true;
      } catch {
        return false;
      }
    };
    let low = 0;
    let high = 16 * 1024 * 1024;
    if (fits(high)) {
      throw new Error('the origin accepted 16 MB: it has no quota to exhaust');
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) {
        low = middle;
      } else {
        high = middle;
      }
    }
    window.localStorage.setItem(FILLER, 'x'.repeat(low));
    let refusesGrowth = false;
    try {
      window.localStorage.setItem(PROBE, 'y');
      window.localStorage.removeItem(PROBE);
    } catch {
      refusesGrowth = true;
    }
    return { filler: low, refusesGrowth };
  });
}

async function releaseOrigin(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.localStorage.removeItem('test-origin-filler');
  });
}

test.describe('the bound, in a real browser', () => {
  test('a full list REFUSES the add, says so, and offers no retry', async ({ page }) => {
    // T-22-06's first half. The refusal is decided from the hydrated list, so this is the whole
    // lane: seeded bytes → `decodeEnvelope` → hydration → the store → a rendered notice.
    const seeded = fillerIds(BOUND);
    await seedApp(page, seeded);
    const [mealId = ''] = await catalogIds(page);
    await openDetails(page, mealId);

    const notice = page.getByTestId('meal-details-favorites-full');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Your favourites list is full');
    await expect(notice).toContainText(`You have ${String(BOUND)} favourites`);
    // **No retry, and that is the claim TSD §6.4 makes**: retrying the same value can never
    // succeed, so a button here would be a lie in the interface.
    await expect(notice.getByRole('button')).toHaveCount(0);
    // The truncation notice is a different outcome and must not be showing as well.
    await expect(page.getByTestId('meal-details-favorites-recovered')).toHaveCount(0);

    // Pressing anyway changes nothing, on the screen or on the disk.
    await page.getByTestId('meal-details-favorite').click({ force: true });
    await expect(page.getByTestId('meal-details-favorite-state')).toHaveText(
      'Not in your favourites',
    );
    const stored = await storedFavoriteIds(page);
    expect(stored).toStrictEqual([...seeded]);
    expect(stored).not.toContain(mealId);
  });

  test('ONE BELOW the bound the add succeeds and no notice appears', async ({ page }) => {
    /**
     * **The other half of the pair, and no single behaviour satisfies both.** "A notice appears
     * when the list is full" is also true of a screen that always shows it, and "the add is
     * refused" is also true of one that never saves. The two tests differ by one seeded id, so the
     * boundary itself is what is being asserted — and the write is read back off `localStorage`,
     * because a heart that flips from a dispatch alone proves nothing about the disk.
     */
    const seeded = fillerIds(BOUND - 1);
    await seedApp(page, seeded);
    const [mealId = ''] = await catalogIds(page);
    await openDetails(page, mealId);

    await expect(page.getByTestId('meal-details-favorites-full')).toHaveCount(0);
    await expect(page.getByTestId('meal-details-favorites-recovered')).toHaveCount(0);

    await page.getByTestId('meal-details-favorite').click();
    await expect(page.getByTestId('meal-details-favorite-state')).toHaveText('Saved to favourites');
    await expect(page.getByTestId('meal-details-favorites-save-error')).toHaveCount(0);

    await expect.poll(async () => (await storedFavoriteIds(page)).length).toBe(BOUND);
    expect(await storedFavoriteIds(page)).toContain(mealId);
  });

  test('an over-long stored list is TRUNCATED on read, and the shorter list is on disk', async ({
    page,
  }) => {
    /**
     * T-22-06's second half, and the asymmetry TSD §6.4 makes deliberate: the write above is
     * refused, this read is truncated. Refusing here would make an over-long entry permanently
     * unreadable, and the copy says the shorter list "has already been saved" — which this test
     * reads off `localStorage` rather than taking the screen's word for.
     */
    const seeded = fillerIds(BOUND + 1);
    await seedApp(page, seeded);
    const [mealId = ''] = await catalogIds(page);
    await openDetails(page, mealId);

    const notice = page.getByTestId('meal-details-favorites-recovered');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Your favourites list was shortened');
    await expect(notice).toContainText('The shorter list has already been saved');
    // NOT the emptied wording: a quarantined list returns the empty fallback, a truncated one does
    // not, and one `recovered` status carries both.
    await expect(notice).not.toContainText('Your saved favourites were reset');

    const stored = await storedFavoriteIds(page);
    expect(stored).toHaveLength(BOUND);
    /**
     * **Which 200 survived, checked against what the copy claims.** The notice says "the newest 200
     * were kept and the oldest dropped", and the stored list is newest-FIRST — `favorites/added`
     * prepends — so keeping the head of the list is keeping the newest. The first draft of this
     * assertion had the direction backwards and reddened on a correct app: `seeded[0]` is the newest
     * id, not the oldest. Written as head-kept / tail-dropped, it is the assertion that would fail
     * if the bound ever truncated from the other end and silently contradicted the sentence the
     * user is reading.
     */
    expect(stored[0]).toBe(seeded[0]);
    expect(stored).not.toContain(seeded[BOUND]);
  });
});

test.describe('quarantine, in a real browser', () => {
  test('two corrupt keys are recorded under their own reasons; the other four load', async ({
    page,
  }) => {
    /**
     * **Two keys, two different reasons, one boot.** One corrupt key would prove isolation from the
     * sound keys; two prove the ledger keeps them apart, which is the claim a collapsed reason
     * mapping would break while still looking recovered. `unreadable` is not JSON at all;
     * `envelope-invalid` is JSON whose envelope is wrong — the two halves TSD §6.4's decode stage
     * fails in.
     */
    const unreadable = '{"schemaVersion":1,"updated';
    const envelopeInvalid = JSON.stringify({ schemaVersion: 1, value: { lastTab: 'home' } });
    await seedApp(page, ['seeded-favourite-0'], {
      [KEYS.customMeals]: unreadable,
      [KEYS.ui]: envelopeInvalid,
    });

    // The app booted at all, which is the first claim: a rejected hydration is a splash screen
    // that never leaves.
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();

    // The bytes survived where TSD §6.4 puts them, under the reason that produced them. This is
    // what Plan §10.2 calls the rollback equivalent, and it is the half a user can never see.
    const ledger = await rawKey(page, QUARANTINE_KEY);
    expect(ledger, 'the ledger holds the raw bytes of the keys it removed').toContain(unreadable);
    expect(ledger).toContain('"reason":"unreadable"');
    expect(ledger).toContain('"reason":"envelope-invalid"');
    expect(ledger).toContain(KEYS.ui);

    /**
     * **The corrupt bytes are gone, but the key is NOT absent — and that is R-54, not a defect.**
     * Hydration removes the live key; `createStore`'s mount projection then writes every store's
     * key back at the same launch, so by the first moment a spec can look, `customMeals` holds a
     * valid envelope around the empty fallback. An earlier draft asserted `toBeNull()` here and
     * reddened on a correct app. The removal itself is proved where it can be observed without a
     * store above it — `webHydration.test.ts` — and what belongs here is the user-visible outcome:
     * the corruption is gone, the key is readable, and nothing else was touched.
     */
    expect(await rawKey(page, KEYS.customMeals)).not.toBe(unreadable);
    expect(await storedValue(page, KEYS.customMeals)).toStrictEqual([]);
    expect(await rawKey(page, KEYS.ui)).not.toBe(envelopeInvalid);

    // And the four it did not touch are intact, values included.
    expect(await storedFavoriteIds(page)).toStrictEqual(['seeded-favourite-0']);
    expect(await storedValue(page, KEYS.onboarding)).toStrictEqual({ completed: true });
    const preferences = await storedValue(page, KEYS.preferences);
    expect(isRecord(preferences) && preferences['diet']).toBe('regular');
  });
});

test.describe('a quota-exhausted origin, in a real browser', () => {
  test('a refused write is reported with a retry, never as a full list', async ({ page }) => {
    /**
     * **The mapping this task exists to pin down.** A browser quota is not the app's bound: TSD
     * §6.4's `bound-exceeded` means the app's own declared limit and is presented with no retry,
     * while a quota refusal is the one storage failure a retry genuinely may fix once the user has
     * freed space. Reporting one as the other would take away the only control that helps them.
     */
    await enterApp(page);
    await openSettings(page);
    const toggle = page.getByTestId('settings-ai-toggle');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    const { refusesGrowth } = await fillOrigin(page);
    expect(
      refusesGrowth,
      'the origin must refuse a one-character write for this test to mean anything',
    ).toBe(true);

    await toggle.click();

    const notice = page.getByTestId('settings-save-error-preferences');
    await expect(notice).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(notice).toContainText('Your preferences were not saved');
    await expect(notice).toContainText(WRITE_FAILED_MESSAGE);
    // NOT the bound wording, and a retry IS offered.
    await expect(notice).not.toContainText('That list is full');
    await expect(notice.getByRole('button', { name: 'Try again' })).toBeVisible();
    // Nothing the browser said reaches the user: no quota, no figure.
    await expect(notice).not.toContainText('quota');
    await expect(notice).not.toContainText('code unit');

    // The screen shows the new state from the dispatch alone; the disk still holds the old one,
    // which is exactly the gap this notice exists to close.
    const stored = await storedValue(page, KEYS.preferences);
    expect(isRecord(stored) && stored['aiEnabled']).toBe(true);

    // And the retry is honest: with room freed, the same button lands the write.
    await releaseOrigin(page);
    await notice.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByTestId('settings-save-error-preferences')).toHaveCount(0);
    await expect
      .poll(async () => {
        const after = await storedValue(page, KEYS.preferences);
        return isRecord(after) ? after['aiEnabled'] : 'missing';
      })
      .toBe(false);
  });
});
