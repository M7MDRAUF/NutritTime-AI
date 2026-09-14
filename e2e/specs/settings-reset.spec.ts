import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * Settings, its four destructive actions, and the full reset — in a real browser (T-18-03 …
 * T-18-07, PRD FR-014, PRD §13).
 *
 * **What this proves that no other suite can.** `Settings.dom.test.tsx` proves the screen
 * dispatches, `resetData.test.ts` proves the clearing covers every key, and
 * `DataResetProvider.dom.test.tsx` proves the unmount re-runs hydration — all three against the
 * in-memory driver, with no navigator above them. None of them has run the lane that matters here:
 * a confirmation the user presses → a reducer → `StorageProvider`'s queued write → the
 * AsyncStorage web driver → `localStorage` → a real page load → `decodeEnvelope` → hydration → the
 * boot phase → a rendered screen. T-18-07's acceptance is "Both destructive paths asserted,
 * including cancellation", and T-18-06's is "All six keys cleared; app returns to onboarding":
 * neither is a statement about memory.
 *
 * **Every claim is read off the DISK as well as the screen.** The two failing together is a
 * different defect from either alone, and this screen has a documented way to produce each: a
 * dispatch empties the list on screen before any write is attempted, so a clear whose write was
 * refused — or dispatched against a key whose read was `unavailable`, which is never written over
 * by design — looks exactly like a clear that worked and hands every favourite back at the next
 * launch. `StoreStatusNotices` exists for that gap, and the storage reads below are what would
 * fail if it ever went quiet.
 *
 * **A cancel is asserted on the DATA, never on the closed sheet.** `settings-cancel` and
 * `settings-confirm` both call `close()`, so "the sheet went away" is satisfied identically by the
 * wrong one being wired: it is the data still being on the screen and still being on the disk that
 * tells the two buttons apart. That is this spec's version of the rule `custom-meal-crud.spec.ts`
 * applies to its delete.
 *
 * **A confirm is asserted on what it did NOT remove.** T-18-05's real content is the scoping: four
 * buttons sit in one list, and "clear favourites" deleting the meals a user wrote themselves is the
 * silent-destruction shape this phase is full of. So each clear is followed by a read of the other
 * two sets, off the disk.
 *
 * **Three consequences of the reset mechanism are built against rather than discovered.**
 * CONTRACTS §8's amendments: `resetAll()` is fire-and-forget (the caller is unmounted before a key
 * is removed), `resetting` is `false` everywhere a consumer can read it (so nothing here waits on a
 * spinner or a disabled button — a control gated on it could never fire), and the remount is a
 * conditional unmount rather than a keyed one. What a user sees during the clear is the fallback
 * splash, and what they see afterwards is onboarding; both are asserted, and nothing in between is.
 *
 * **The six keys do NOT stay absent, and this spec says so out loud.** Plan T-18-06's acceptance
 * reads "All six keys cleared", and they are — then five of them are re-created within the same
 * frame by the fresh mount, holding their own fallbacks: `createStore`'s projection effect writes
 * on mount, and `StorageProvider` records a launch in `meta`. Measured, not assumed (see
 * `## FINDINGS` in this agent's report). An assertion that each key is *absent* would therefore be
 * red against a correct app, so the claim made here is the stronger one it was standing in for:
 * **no pre-reset value survives anywhere in `localStorage`**, every key that came back holds
 * exactly its documented default, and `meta` proves the removal really happened — see
 * `MUST_NOT_SURVIVE` and the `meta` case below.
 *
 * Four harness lessons are obeyed rather than re-learned: **the app opens on HomeTab**, so every
 * screen is reached by tapping a tab (a `goto('/settings')` was measured landing on `/home` with
 * Settings never mounted, which is R-44 and is why the disclaimer probe below uses the onboarding
 * phase instead); **no `addInitScript`**, which runs in every new document including the reload at
 * the end of the reset test and would re-seed the data that test is about; **never a DOM row count
 * as a set size** (R-45) — every comparison is by id; and **selectors are scoped to the screen**,
 * because Home stays mounted behind Settings and its cards share the `meal-` prefix.
 */

/** A cold bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/**
 * TSD §6.4's six keys and the quarantine ledger, restated rather than imported: this spec asserts
 * from OUTSIDE the app, so a drift between these names and `definitions.ts` must fail here rather
 * than be shared away. `STORAGE_KEY_NAMES` is the app's own witness that six is still six; this
 * table is the harness's.
 */
const KEYS = {
  meta: '@nutritime/meta',
  onboarding: '@nutritime/onboarding',
  preferences: '@nutritime/preferences/v1',
  favorites: '@nutritime/favorites/v1',
  customMeals: '@nutritime/custom-meals/v1',
  ui: '@nutritime/ui/v1',
} as const;

/** Not a `StorageKeyName`: it has no definition and no store, and FR-014 still means it. */
const QUARANTINE_KEY = '@nutritime/quarantine/v1';

/** `settingsCopy.ts`'s confirmation titles, restated from outside for the same reason. */
const TITLES = {
  favorites: 'Clear your favourites?',
  customMeals: 'Delete the meals you created?',
  preferences: 'Reset your preferences?',
  all: 'Erase everything on this device?',
} as const;

/** `semantic.ts`'s `surface.canvas` in each scheme, as the browser paints it. */
const CANVAS = { light: 'rgb(236, 253, 245)', dark: 'rgb(10, 23, 20)' } as const;

/** The seeded `meta.firstLaunchAt`. Deliberately years old, so its survival is unmistakable. */
const SEEDED_FIRST_LAUNCH = '2020-01-01T00:00:00.000Z';

/**
 * One valid `CustomMeal`, seeded rather than typed into the form.
 *
 * **Seeding is legitimate here and is not legitimate in `custom-meal-crud.spec.ts`.** That spec's
 * claim is that the form writes a record the storage edge accepts, so a seeded record would beg its
 * question. This spec's claims are about clearing and about scope, and for those the record's
 * provenance is irrelevant — what matters is that it is really on the disk and really hydrates,
 * which the "(1)" in the button label and the row in Saved both prove before anything is cleared.
 *
 * It satisfies `customMealSchema`: `source: 'user'` with `nutritionProvenance.origin: 'user'`,
 * all-null nutrition with a null serving count, and both timestamps ISO. A record that did not
 * would be quarantined at hydration and the pre-state assertions would fail loudly.
 */
const CUSTOM_MEAL = {
  id: 'seeded-lentil-stew',
  name: 'Seeded lentil stew',
  description: 'Seeded by the settings spec.',
  mealPeriods: ['lunch'],
  ingredients: [{ name: 'Red lentils', measure: '200 g' }],
  instructions: ['Simmer the lentils until soft.'],
  allergenTags: [],
  dietTags: ['vegetarian'],
  nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
  price: { amountCents: 450, currency: 'USD' },
  preparationMinutes: 35,
  imageUrl: null,
  available: true,
  source: 'user',
  provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
  nutritionProvenance: { origin: 'user', dataset: null, servings: null, reason: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

/**
 * The seeded profile, chosen so that **every field the four actions touch is observably
 * non-default**.
 *
 * `DEFAULT_PREFERENCES` is `aiEnabled: true` and `themeMode: 'system'`, so seeding those values
 * would make "the preferences were reset" indistinguishable from "nothing happened" on the two
 * controls Settings actually renders. Seeded the other way round, the reset is visible on the
 * screen as well as on the disk — which is what PRD §13 asks of a destructive action.
 */
const SEEDED_PREFERENCES = {
  schemaVersion: 1,
  diet: 'vegetarian',
  allergies: ['peanut'],
  goal: 'balanced',
  budget: 'medium',
  dislikedIngredients: [],
  mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
  aiEnabled: false,
  themeMode: 'dark',
} as const;

/**
 * Exact fragments of the seeded state. **Not one of them may be anywhere in `localStorage` after a
 * full reset** — the whole store is scanned, not only the seven keys, so a stray key holding a copy
 * fails too. Written as JSON fragments rather than bare words so that a default value which
 * happens to contain a substring cannot satisfy them by accident.
 */
const MUST_NOT_SURVIVE = [
  '"diet":"vegetarian"',
  '"peanut"',
  '"themeMode":"dark"',
  '"aiEnabled":false',
  CUSTOM_MEAL.id,
  CUSTOM_MEAL.name,
  SEEDED_FIRST_LAUNCH,
  'seeded-quarantine-payload',
] as const;

/** `envelope.ts`'s own guard, restated: a type predicate, so nothing here needs an `as`. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function rawKey(page: Page, key: string): Promise<string | null> {
  return page.evaluate((name) => window.localStorage.getItem(name), key);
}

/**
 * One key's `value`, or `null` when the key is absent. **Throws on a payload that is not TSD
 * §6.4's three-field envelope**, because such a key is one hydration quarantines at the next launch
 * and it must fail this spec loudly rather than read as an empty set.
 */
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

/** The stored favourite ids. Throws on a non-string entry rather than filtering it away. */
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

/** The stored custom meal ids. Throws on a non-record entry, for `storedValue`'s reason. */
async function storedCustomMealIds(page: Page): Promise<readonly string[]> {
  const value = await storedValue(page, KEYS.customMeals);
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`the custom meals value is ${typeof value}, not a list of records`);
  }
  return value.map((entry: unknown, index: number) => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') {
      throw new Error(`custom meal ${String(index)} is stored without a string id`);
    }
    return entry['id'];
  });
}

async function storedPreferences(page: Page): Promise<Readonly<Record<string, unknown>>> {
  const value = await storedValue(page, KEYS.preferences);
  if (!isRecord(value)) {
    throw new Error(`the preferences value is ${typeof value}, not a record`);
  }
  return value;
}

/** Every key in the store, so a pre-reset value cannot hide under a key this spec did not name. */
async function dumpStorage(page: Page): Promise<Readonly<Record<string, string>>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null) {
        out[key] = window.localStorage.getItem(key) ?? '';
      }
    }
    return out;
  });
}

/**
 * Load once, seed all seven keys, reload. **Not `addInitScript`**, which runs in every new document
 * and would re-seed across the reload the reset test ends with — deleting that test's evidence.
 */
async function seedApp(page: Page, favouriteIds: readonly string[]): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ({ keys, quarantineKey, meal, favourites, preferences, firstLaunchAt }) => {
      const at = new Date().toISOString();
      const envelope = (value: unknown): string =>
        JSON.stringify({ schemaVersion: 1, updatedAt: at, value });
      window.localStorage.clear();
      window.localStorage.setItem(keys.meta, envelope({ firstLaunchAt, lastLaunchAt: at }));
      window.localStorage.setItem(keys.onboarding, envelope({ completed: true }));
      window.localStorage.setItem(keys.preferences, envelope(preferences));
      window.localStorage.setItem(keys.favorites, envelope(favourites));
      window.localStorage.setItem(keys.customMeals, envelope([meal]));
      window.localStorage.setItem(
        keys.ui,
        envelope({ lastTab: 'home', disclaimerAcknowledged: true }),
      );
      // The ledger holds the raw bytes of a value that failed its schema, which is still the
      // user's data — FR-014's "all local data" covers it, and nothing else in the app removes it.
      window.localStorage.setItem(
        quarantineKey,
        JSON.stringify([{ key: keys.preferences, at, raw: 'seeded-quarantine-payload' }]),
      );
    },
    {
      keys: KEYS,
      quarantineKey: QUARANTINE_KEY,
      meal: CUSTOM_MEAL,
      favourites: favouriteIds,
      preferences: SEEDED_PREFERENCES,
      firstLaunchAt: SEEDED_FIRST_LAUNCH,
    },
  );
  await page.reload();
  // The tab bar only exists in the `app` phase, so its presence IS the assertion that the seed was
  // accepted rather than quarantined.
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** Two real catalog ids, read from the server so a catalog change cannot invalidate the spec. */
async function catalogIds(page: Page): Promise<readonly string[]> {
  const response = await page.request.get('http://127.0.0.1:4000/api/v1/meals?pageSize=3&page=1');
  expect(response.ok(), 'the catalog must be reachable for the favourites to resolve').toBe(true);
  const body = (await response.json()) as { readonly meals: readonly { readonly id: string }[] };
  const ids = body.meals.map((meal) => meal.id).slice(0, 2);
  expect(ids.length, 'this spec needs two catalog meals to favourite').toBe(2);
  return ids;
}

/** Settings, reached by tapping. Deep links land on Home (R-44), measured again for this spec. */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/** The painted canvas of the Settings scroll view — the theme's user-visible consequence. */
async function canvasColour(page: Page): Promise<string> {
  return page
    .getByTestId('settings-screen')
    .evaluate((element) => window.getComputedStyle(element).backgroundColor);
}

function clearButton(page: Page, id: 'favorites' | 'customMeals' | 'preferences'): Locator {
  return page.getByTestId(`settings-clear-${id}`);
}

/**
 * Open one confirmation and assert **nothing was destroyed by opening it**.
 *
 * A clear dispatched from the destructive button rather than from the sheet's confirm would pass
 * every assertion a test made only after pressing confirm.
 */
async function openConfirmation(
  page: Page,
  id: keyof typeof TITLES,
  favourites: readonly string[],
): Promise<void> {
  const trigger = id === 'all' ? page.getByTestId('settings-reset-all') : clearButton(page, id);
  await trigger.click();
  const sheet = page.getByTestId('settings-confirm-sheet');
  await expect(sheet).toBeVisible();
  // The copy belongs to the action pressed. One `pending` id makes that true by construction; this
  // is what would fail if it ever stopped being.
  await expect(sheet).toContainText(TITLES[id]);
  // Both sets, off the disk, while the sheet is merely OPEN.
  expect(await storedFavoriteIds(page), 'the sheet is open, not confirmed').toStrictEqual([
    ...favourites,
  ]);
  expect(await storedCustomMealIds(page), 'the sheet is open, not confirmed').toStrictEqual([
    CUSTOM_MEAL.id,
  ]);
}

/**
 * Everything the seed put on the device, asserted present — on the screen and on the disk.
 *
 * Used as the pre-state of every destructive test and re-run after each of the four cancels, which
 * is what makes a cancel's claim about the DATA rather than about a closed sheet.
 */
async function expectSeededDataPresent(page: Page, favourites: readonly string[]): Promise<void> {
  // (1) The screen. The counts are the user's view of these two sets, and they come from the live
  // stores rather than from storage — so screen and disk agreeing is a claim, not a tautology.
  await expect(clearButton(page, 'favorites')).toContainText(
    `Clear favourites (${String(favourites.length)})`,
  );
  await expect(clearButton(page, 'customMeals')).toContainText('Delete my own meals (1)');
  // The two preference fields this screen renders, still as seeded.
  await expect(page.getByTestId('settings-ai-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: Dark');
  expect(await canvasColour(page)).toBe(CANVAS.dark);

  // (2) The disk. A store empties the screen from the dispatch alone, so this is the half that
  // survives a reload — and the half that fails when a write was refused or skipped in silence.
  expect(await storedFavoriteIds(page)).toStrictEqual([...favourites]);
  expect(await storedCustomMealIds(page)).toStrictEqual([CUSTOM_MEAL.id]);
  const preferences = await storedPreferences(page);
  expect(preferences['diet']).toBe('vegetarian');
  expect(preferences['allergies']).toStrictEqual(['peanut']);
  expect(preferences['aiEnabled']).toBe(false);
  expect(preferences['themeMode']).toBe('dark');
  // Still set up: the only path that un-completes onboarding is the full reset.
  expect(await storedValue(page, KEYS.onboarding)).toStrictEqual({ completed: true });
}

test.describe('the two preference switches', () => {
  test('the AI setting is stored, and the chip reports it, in both directions', async ({
    page,
  }) => {
    // T-18-03. `enterApp` seeds `aiEnabled: true`, so the pre-state is asserted rather than assumed
    // — without it "the toggle turned it off" would also be satisfied by a control that does
    // nothing to a setting that was already off.
    await enterApp(page);
    await openSettings(page);
    const toggle = page.getByTestId('settings-ai-toggle');
    // A `checkbox` with a real checked state, not a button that merely looks active: the state is
    // in the accessibility tree, so colour is not the only signal (PRD §10.5).
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect((await storedPreferences(page))['aiEnabled']).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    // Polled, because the write is queued after the reducer — the screen changes first and the disk
    // follows, and it is the disk that decides what the next launch shows.
    await expect
      .poll(async () => (await storedPreferences(page))['aiEnabled'], { timeout: FIRST_PAINT_MS })
      .toBe(false);

    // BACK ON, which is the direction a "turn it off" implementation passes without.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect
      .poll(async () => (await storedPreferences(page))['aiEnabled'], { timeout: FIRST_PAINT_MS })
      .toBe(true);
  });

  test('the theme repaints the canvas in both directions, not only the stored value', async ({
    page,
  }) => {
    /**
     * T-18-04's acceptance is "changes scheme immediately in both directions", and **a test that
     * only read the stored value would have passed against the defect that actually shipped**:
     * `App.tsx` hard-coded `mode="system"`, so the switch dispatched correctly, stored correctly
     * and moved no pixel. So the painted canvas is the assertion and the stored value is the
     * corroboration — in that order.
     */
    await enterApp(page);
    await openSettings(page);
    await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: System');
    expect((await storedPreferences(page))['themeMode']).toBe('system');
    // Chromium's default scheme is light, so `system` resolves light here. Asserted rather than
    // assumed: it is the baseline the two changes below are changes FROM.
    expect(await canvasColour(page)).toBe(CANVAS.light);

    await page.getByTestId('chip-theme-dark').click();
    // The selection is in the accessible NAME as well as in the fill — `ChipRow`'s `selected` alone
    // conveys nothing on the web (react-native-web maps no `accessibilityState` on a button).
    await expect(page.getByTestId('chip-theme-dark')).toHaveAttribute(
      'aria-label',
      'Theme: Dark, selected',
    );
    await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: Dark');
    expect(await canvasColour(page), 'the dark canvas must actually be painted').toBe(CANVAS.dark);
    await expect
      .poll(async () => (await storedPreferences(page))['themeMode'], { timeout: FIRST_PAINT_MS })
      .toBe('dark');

    // THE OTHER DIRECTION. Dark to light, so a one-way wiring fails here.
    await page.getByTestId('chip-theme-light').click();
    await expect(page.getByTestId('chip-theme-light')).toHaveAttribute(
      'aria-label',
      'Theme: Light, selected',
    );
    await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: Light');
    expect(await canvasColour(page), 'the light canvas must actually be painted').toBe(
      CANVAS.light,
    );
    await expect
      .poll(async () => (await storedPreferences(page))['themeMode'], { timeout: FIRST_PAINT_MS })
      .toBe('light');
  });
});

test.describe('every destructive action, cancelled', () => {
  test('cancelling each of the four leaves every set on the screen and on the disk', async ({
    page,
  }) => {
    /**
     * T-18-07, the half that is easy to fake. `settings-cancel` and `settings-confirm` both run
     * `close()`, so the sheet closing is identical whichever is wired to the destruction — and a
     * cancel wired to `confirm` would pass any test that checked the sheet.
     *
     * All four in one test on purpose: a cancel that destroys nothing leaves the next cancel's
     * pre-state intact, so the four share one seed, and the full data assertion is re-run after
     * every one of them.
     */
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);

    for (const id of ['favorites', 'customMeals', 'preferences', 'all'] as const) {
      await openConfirmation(page, id, favourites);
      await page.getByTestId('settings-cancel').click();
      await expect(page.getByTestId('settings-confirm-sheet')).toHaveCount(0);

      // **The claim.** Not the closed sheet: the data, on the screen and on the disk, unchanged.
      await expectSeededDataPresent(page, favourites);
      // And the app is still the app. A cancelled full reset that unmounted the storage subtree
      // would have returned the user to onboarding with their data intact and no way to tell.
      await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
      await expect(page.getByTestId('onboarding-continue')).toHaveCount(0);
    }

    /**
     * And the allergy list itself, in the form that owns it. The Settings screen never renders
     * allergies, so four cancels could leave the one safety-relevant field cleared and every
     * assertion above would still pass. The chip is `toggle`, so its state is `aria-checked`.
     */
    await page.getByTestId('settings-edit-preferences').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('chip-allergy-peanut')).toHaveAttribute('aria-checked', 'true');

    /**
     * It survives the next launch too, which is what "still on the disk" has to mean.
     *
     * **This block asserted the tab bar here until P24, and it passed only because R-44 was
     * unfixed.** The reload happens while the user is on the PUSHED `DietarySetup` screen, which
     * has no tab bar — and a cold load used to rewrite the URL to `/home`, so the tabs appeared and
     * the assertion held. R-44 is closed (`explore.spec.ts` carries the live proof), so a relaunch
     * now restores the screen the user was actually on, and the old line began failing in all four
     * projects. **The spec had encoded the defect as its expectation**, which is the same shape as
     * a docstring that argues for a hole someone has since closed.
     *
     * Restoring the pushed screen is the stronger claim anyway: it lets the one safety-relevant
     * field be read back **after a real relaunch**, which is what this test is ultimately about.
     */
    await page.reload();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('chip-allergy-peanut')).toHaveAttribute('aria-checked', 'true');

    // Then in through the front door, which is a fresh entry rather than a restore, and on to the
    // full data assertion the rest of this test shares.
    await page.goto('/');
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);
  });
});

test.describe('each confirmed clear removes only what it names', () => {
  test('clearing favourites leaves the custom meals and the preferences on the disk', async ({
    page,
  }) => {
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);

    await openConfirmation(page, 'favorites', favourites);
    await page.getByTestId('settings-confirm').click();
    await expect(page.getByTestId('settings-confirm-sheet')).toHaveCount(0);

    // Gone, on the screen and on the disk.
    await expect(clearButton(page, 'favorites')).toContainText('Clear favourites (0)');
    await expect
      .poll(async () => (await storedFavoriteIds(page)).join(','), { timeout: FIRST_PAINT_MS })
      .toBe('');

    /** **T-18-05's real content.** The other two sets are untouched — on the disk, not in memory. */
    expect(await storedCustomMealIds(page)).toStrictEqual([CUSTOM_MEAL.id]);
    const preferences = await storedPreferences(page);
    expect(preferences['diet']).toBe('vegetarian');
    expect(preferences['allergies']).toStrictEqual(['peanut']);
    expect(preferences['themeMode']).toBe('dark');
    // And on the screen, in the section that would have emptied with them.
    await expect(clearButton(page, 'customMeals')).toContainText('Delete my own meals (1)');
    await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: Dark');

    // Across a reload: the shorter list is what queues the write, so a reducer returning the old
    // reference would hand every favourite back here — and the untouched sets must still be here.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSettings(page);
    await expect(clearButton(page, 'favorites')).toContainText('Clear favourites (0)');
    await expect(clearButton(page, 'customMeals')).toContainText('Delete my own meals (1)');
    expect(await storedFavoriteIds(page)).toStrictEqual([]);
    expect(await storedCustomMealIds(page)).toStrictEqual([CUSTOM_MEAL.id]);
  });

  test('deleting the created meals leaves the favourites and the preferences on the disk', async ({
    page,
  }) => {
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);

    await openConfirmation(page, 'customMeals', favourites);
    await page.getByTestId('settings-confirm').click();
    await expect(page.getByTestId('settings-confirm-sheet')).toHaveCount(0);

    await expect(clearButton(page, 'customMeals')).toContainText('Delete my own meals (0)');
    await expect
      .poll(async () => (await storedCustomMealIds(page)).join(','), { timeout: FIRST_PAINT_MS })
      .toBe('');

    expect(await storedFavoriteIds(page)).toStrictEqual([...favourites]);
    const preferences = await storedPreferences(page);
    expect(preferences['allergies']).toStrictEqual(['peanut']);
    expect(preferences['aiEnabled']).toBe(false);
    await expect(clearButton(page, 'favorites')).toContainText(
      `Clear favourites (${String(favourites.length)})`,
    );

    // The list the user reads it off, and the independent empty state that proves the section —
    // not the whole screen — is what emptied.
    await page.getByRole('tab', { name: 'Saved' }).click();
    await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-custom-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(
      page.getByTestId('saved-custom').getByTestId(`saved-recipe-${CUSTOM_MEAL.id}`),
    ).toHaveCount(0);
    await expect(page.getByTestId('saved-favorites-empty')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSettings(page);
    expect(await storedCustomMealIds(page)).toStrictEqual([]);
    expect(await storedFavoriteIds(page)).toStrictEqual([...favourites]);
  });

  test('resetting the preferences leaves the favourites and the created meals on the disk', async ({
    page,
  }) => {
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);

    await openConfirmation(page, 'preferences', favourites);
    // The copy names every field `DEFAULT_PREFERENCES` replaces, including the empty allergy list —
    // a destructive action whose confirmation under-states its scope is a defect, not brevity.
    await expect(page.getByTestId('settings-confirm-sheet')).toContainText(
      'including an empty allergy list',
    );
    await page.getByTestId('settings-confirm').click();
    await expect(page.getByTestId('settings-confirm-sheet')).toHaveCount(0);

    // (1) The screen, in both controls it renders — and the canvas repaints, because `themeMode`
    // went back to `system`, which resolves light here.
    await expect(page.getByTestId('settings-ai-toggle')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('settings-theme-selected')).toContainText('Theme: System');
    expect(await canvasColour(page)).toBe(CANVAS.light);

    // (2) The disk, including the field no Settings control shows.
    await expect
      .poll(async () => (await storedPreferences(page))['diet'], { timeout: FIRST_PAINT_MS })
      .toBe('regular');
    const preferences = await storedPreferences(page);
    expect(preferences['allergies']).toStrictEqual([]);
    expect(preferences['aiEnabled']).toBe(true);
    expect(preferences['themeMode']).toBe('system');

    // (3) The allergy list in the form that owns it — the user-visible half of the sentence the
    // confirmation promised, and the safety-relevant one.
    await page.getByTestId('settings-edit-preferences').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('chip-allergy-peanut')).toHaveAttribute('aria-checked', 'false');
    await page.goBack();

    // The other two sets are untouched.
    await openSettings(page);
    expect(await storedFavoriteIds(page)).toStrictEqual([...favourites]);
    expect(await storedCustomMealIds(page)).toStrictEqual([CUSTOM_MEAL.id]);
    await expect(clearButton(page, 'customMeals')).toContainText('Delete my own meals (1)');
    await expect(clearButton(page, 'favorites')).toContainText(
      `Clear favourites (${String(favourites.length)})`,
    );
  });
});

test.describe('the full reset', () => {
  test('returns the app to onboarding, and no seeded value survives anywhere', async ({ page }) => {
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);
    // The ledger is on the device before the reset, so its removal below is a change.
    expect(await rawKey(page, QUARANTINE_KEY)).toContain('seeded-quarantine-payload');

    await openConfirmation(page, 'all', favourites);
    await page.getByTestId('settings-confirm').click();

    /**
     * **T-18-06's second clause, and the only observable this spec waits on.** `resetAll()` is
     * fire-and-forget and `resetting` is `false` everywhere a consumer can read it, so there is no
     * spinner and no disabled button to wait for — the user is unmounted along with the whole
     * storage subtree, and the next thing they see is the fallback splash and then onboarding.
     *
     * Reaching onboarding is also this spec's proof that the clear did not partially fail:
     * `clearAllStorage` clears `onboarding` LAST and only when everything else is already gone, so
     * a surviving key would have left the app in the `app` phase with `settings-reset-error` on
     * screen rather than here.
     */
    await expect(page.getByTestId('onboarding-continue')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveCount(0);
    await expect(page.getByTestId('settings-screen')).toHaveCount(0);

    /**
     * **Every key, iterated — and the claim is "nothing of the user's survived", not "the key is
     * absent".** Five of the six keys are re-created within the same frame by the fresh mount, each
     * holding its own fallback: `createStore`'s projection effect writes on mount, and
     * `StorageProvider` records a launch in `meta`. Measured, and reported as a finding against
     * T-18-06's acceptance wording. So each key must be absent OR hold exactly its documented
     * default, and `MUST_NOT_SURVIVE` below closes the gap that leaves.
     */
    const after = await dumpStorage(page);
    const defaults: Readonly<Record<string, unknown>> = {
      [KEYS.onboarding]: { completed: false },
      [KEYS.favorites]: [],
      [KEYS.customMeals]: [],
      [KEYS.ui]: { lastTab: null, disclaimerAcknowledged: false },
      [KEYS.preferences]: {
        schemaVersion: 1,
        diet: 'regular',
        allergies: [],
        goal: 'balanced',
        budget: 'medium',
        dislikedIngredients: [],
        mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
        aiEnabled: true,
        themeMode: 'system',
      },
    };
    for (const key of [
      KEYS.onboarding,
      KEYS.preferences,
      KEYS.favorites,
      KEYS.customMeals,
      KEYS.ui,
    ]) {
      const value = await storedValue(page, key);
      if (value !== null) {
        expect(value, `${key} came back holding something other than its fallback`).toStrictEqual(
          defaults[key],
        );
      }
    }

    /**
     * **`meta` is the proof that the keys were REMOVED rather than overwritten.** `recordLaunch`
     * preserves `firstLaunchAt` when it finds one (`entry.value.firstLaunchAt ?? at`), so a
     * `firstLaunchAt` equal to `lastLaunchAt` — and not the seeded 2020 instant — can only mean
     * hydration read no `meta` key at all. An overwrite would have kept 2020.
     */
    const meta = await storedValue(page, KEYS.meta);
    if (meta !== null) {
      expect(isRecord(meta)).toBe(true);
      if (isRecord(meta)) {
        expect(meta['firstLaunchAt'], 'the seeded launch history must not survive').not.toBe(
          SEEDED_FIRST_LAUNCH,
        );
        expect(meta['firstLaunchAt'], 'a re-created meta records this launch as the first').toBe(
          meta['lastLaunchAt'],
        );
      }
    }

    // The ledger has no store to re-create it, so this one really is absent — and it holds the one
    // payload a user is least likely to know exists.
    expect(await rawKey(page, QUARANTINE_KEY)).toBeNull();

    /**
     * **And nothing of the seeded state is anywhere in the store.** The whole of `localStorage` is
     * scanned rather than the seven keys, so a stray key holding a copy fails too — which is the
     * assertion "every key is absent" was standing in for.
     */
    const everything = Object.entries(after)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    for (const fragment of MUST_NOT_SURVIVE) {
      expect(everything, `${fragment} survived a confirmed full reset`).not.toContain(fragment);
    }

    /**
     * **And it is still onboarding at the next launch.** A reset that only moved the in-memory
     * boot phase would put the user back in the app here, holding the data they asked to destroy.
     */
    await page.reload();
    await expect(page.getByTestId('onboarding-continue')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveCount(0);
    const reloaded = Object.entries(await dumpStorage(page))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    for (const fragment of MUST_NOT_SURVIVE) {
      expect(reloaded, `${fragment} came back at the next launch`).not.toContain(fragment);
    }
  });

  test('a preference changed a moment earlier is not resurrected by the reset', async ({
    page,
  }) => {
    /**
     * **F-W7-RESET-1, in a browser, by the exact gesture that reproduced it.** An earlier version
     * of `DataResetProvider` kept the storage subtree mounted and remounted it with a changing
     * `key` after the clear, so a store write already in flight landed *after* the removals: the
     * user confirmed "erase everything", the app returned to onboarding, and `preferences` came
     * back holding their real diet and allergy list — silently, because the write belonged to a
     * store instance the remount had already discarded. CONTRACTS §8 records it as reachable "by
     * toggling the theme or the AI switch and then confirming the reset — on the same screen", and
     * that is what this does: the theme is changed and the reset is confirmed **without waiting for
     * the write**, so the queued write and the removals overlap.
     *
     * CONTRACTS §8 also records that the race is **narrowed, not closed** — a write settling after
     * the final read-back still lands, and closing that needs a cancellable driver write (an
     * amendment, not a code change) or R-51's queue-drained signal. So a failure here is a real
     * defect and a pass is not a proof of impossibility; what it does prove is that the ordering
     * the current mechanism relies on holds through a real browser, a real driver and a real
     * `localStorage`, which is the only place that ordering exists.
     */
    const favourites = await catalogIds(page);
    await seedApp(page, favourites);
    await openSettings(page);
    await expectSeededDataPresent(page, favourites);

    // Queue a write, then confirm the erase immediately. Nothing is awaited in between on purpose:
    // waiting for the write to land would test the sequential case, which is the easy one.
    await page.getByTestId('chip-theme-light').click();
    await page.getByTestId('settings-reset-all').click();
    await page.getByTestId('settings-confirm').click();

    await expect(page.getByTestId('onboarding-continue')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByRole('tab', { name: 'Home' })).toHaveCount(0);

    // Both the seeded profile AND the value the in-flight write carried. `'"themeMode":"light"'`
    // is the resurrection marker: it exists nowhere on the device except in that queued write.
    const survivors = Object.entries(await dumpStorage(page))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    for (const fragment of [...MUST_NOT_SURVIVE, '"themeMode":"light"']) {
      expect(survivors, `${fragment} was resurrected by a write in flight`).not.toContain(fragment);
    }

    // And it stays gone at the next launch, which is where the original defect became visible.
    await page.reload();
    await expect(page.getByTestId('onboarding-continue')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const reloaded = Object.entries(await dumpStorage(page))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    for (const fragment of [...MUST_NOT_SURVIVE, '"themeMode":"light"']) {
      expect(reloaded, `${fragment} came back at the next launch`).not.toContain(fragment);
    }
  });
});

test.describe('the disclaimer acknowledgement', () => {
  test('is false until Home has rendered it, and true in Settings afterwards', async ({ page }) => {
    /**
     * T-18-01's other half, and the one thing only an end-to-end run can prove.
     *
     * `uiActions.acknowledgeDisclaimer()` had **no caller at all** until integration: the action
     * existed, the flag had a schema, a default and this Settings surface, and nothing dispatched
     * it — so Settings told every user they had not seen the allergen notice, which was false for
     * anyone who had opened Home. The dispatch now lives in `HomeScreenWithFocus`, the wrapper the
     * registry registers, and **no screen test mounts that wrapper**: `Home.dom.test.tsx` renders
     * `HomeScreen` and passes `onDisclaimerShown` in as a prop, which proves the callback and not
     * the wiring.
     *
     * **The negative is taken before Home has ever existed**, which needs an ordering: the app
     * opens on HomeTab and a `goto('/settings')` was measured landing on `/home` (R-44), so the
     * ordering used is the onboarding phase, where `RootNavigator` registers no `Tabs` at all and
     * `HomeScreenWithFocus` therefore cannot have mounted. Nothing is seeded: this is the journey a
     * new device takes.
     */
    await page.goto('/');
    await page.evaluate(() => {
      window.localStorage.clear();
    });
    await page.reload();
    await page.getByTestId('onboarding-continue').click();
    await expect(page.getByTestId('dietary-setup-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });

    // THE NEGATIVE, and it is a written key rather than an absence: the `ui` store persists its
    // fallback on mount, so the flag is stored as `false` while the user is still in setup. An
    // assertion that merely tolerated a missing key would also pass against a key holding `true`.
    await expect
      .poll(async () => JSON.stringify(await storedValue(page, KEYS.ui)), {
        timeout: FIRST_PAINT_MS,
      })
      .toBe(JSON.stringify({ lastTab: null, disclaimerAcknowledged: false }));
    await expect(page.getByTestId('home-screen')).toHaveCount(0);

    // Home, and the notice FR-007 requires on it. This mount is the whole mechanism under test.
    await page.getByTestId('dietary-setup-save').click();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-disclaimer')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('home-disclaimer')).toContainText('not medical advice');

    // (1) Settings says it has been seen.
    await openSettings(page);
    await expect(page.getByTestId('settings-disclaimer')).toHaveText(
      'You have seen the notice about allergen data being neither complete nor verified.',
    );

    // (2) And the flag is on the disk, so the next launch says the same. A screen reading a store
    // that never persisted would satisfy (1) alone and reset itself at the next launch.
    await expect
      .poll(
        async () => {
          const value = await storedValue(page, KEYS.ui);
          return isRecord(value) ? value['disclaimerAcknowledged'] : null;
        },
        { timeout: FIRST_PAINT_MS },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSettings(page);
    await expect(page.getByTestId('settings-disclaimer')).toHaveText(
      'You have seen the notice about allergen data being neither complete nor verified.',
    );
  });
});
