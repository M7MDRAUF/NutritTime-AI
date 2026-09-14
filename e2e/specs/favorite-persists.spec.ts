import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * A favourite survives a reload (T-16-08), through the real UI in a real browser.
 *
 * **What this proves that no other suite can.** `favoritesState.test.ts` proves the reducer and
 * `MealDetails.dom.test.tsx` proves the heart dispatches, both against memory. Neither has run the
 * projection: reducer → `StorageProvider`'s queued write → the AsyncStorage web driver →
 * `localStorage` → a real page load → `decodeEnvelope` → hydration → a rendered row. That lane is
 * what PRD FR-012's "persists" and PRD §13's "favorites … survive a restart" are about, and a
 * reload is the only thing in this project that exercises it.
 *
 * **Read back from BOTH Saved and `localStorage`**, because the two failing together is a
 * different defect from either alone: a row with no stored id means the list never reached the disk
 * and is gone at the next launch, and a stored id with no row means the write worked and hydration
 * or the feed dropped it. One assertion cannot tell those apart, and each has its own fix.
 *
 * **Two controls, load-bearing rather than scene-setting.** Saved's empty state is asserted BEFORE
 * the favourite, or "it is in Saved after the reload" would also be satisfied by a screen showing
 * the whole catalog; and a second meal, never touched, is carried to the end, so the mandated probe
 * — the reload assertion pointed at a meal never saved — is re-run on every pass.
 *
 * Three harness lessons are obeyed rather than re-learned: **the app opens on HomeTab**, so every
 * screen is reached by tapping a tab; **no `addInitScript`**, which runs in every new document and
 * would have this spec delete the data it is about (`enterApp` loads, seeds and reloads once, and
 * nothing after that touches storage but the app); and **never a DOM row count as a set size**
 * (R-45) — every comparison below is by id.
 */

/** A cold bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/** TSD §6.4's key and schema version, restated rather than imported: this spec asserts from
 * OUTSIDE the app, so a drift between the two must fail here rather than be shared away. */
const FAVORITES_KEY = '@nutritime/favorites/v1';
const EXPECTED_SCHEMA_VERSION = 1;

/**
 * Words that could only appear under this key if a meal — or the user — had been stored beside the
 * ids. A screen that cached the fetched meal there would render identically; only the raw payload
 * can catch it.
 */
const MUST_NOT_APPEAR = [
  'allergies',
  'ingredients',
  'provenance',
  'priceMinor',
  'mealTimes',
] as const;

/** `envelope.ts`'s own guard, restated: a type predicate, so nothing here needs an `as`. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface StoredEnvelope {
  /** Top-level fields, sorted. TSD §6.4 fixes them at exactly three. */
  readonly fields: readonly string[];
  readonly schemaVersion: unknown;
  readonly updatedAt: unknown;
  readonly value: unknown;
}

async function rawFavorites(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), FAVORITES_KEY);
}

async function storedEnvelope(page: Page): Promise<StoredEnvelope | null> {
  const raw = await rawFavorites(page);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`the favourites key holds ${raw}, which is not an envelope`);
  }
  return {
    fields: Object.keys(parsed).sort(),
    schemaVersion: parsed['schemaVersion'],
    updatedAt: parsed['updatedAt'],
    value: parsed['value'],
  };
}

/**
 * The stored ids, or `[]` when the key is absent. **Throws rather than coerces a non-string**,
 * because "ids only" is one of the claims: a meal object in that array must fail the spec loudly
 * rather than be filtered quietly out of it.
 */
async function storedFavoriteIds(page: Page): Promise<readonly string[]> {
  const envelope = await storedEnvelope(page);
  if (envelope === null) {
    return [];
  }
  const value = envelope.value;
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

/**
 * Every meal id Explore is showing — **scoped inside `explore-list`, and that is not tidiness.**
 *
 * `HomeScreen` renders each recommendation as `recommendation-<id>` wrapping a `MealCard` whose own
 * testID is `meal-<id>`, React Navigation keeps the Home tab MOUNTED behind Explore, and the
 * details screen's `meal-details-*` ids share the prefix — so `[data-testid^="meal-"]` unscoped
 * returns Home's cards FIRST. The first version of this spec was unscoped and its click timed out
 * for that reason: it had picked `home-made-mandazi` off Home, Explore's card is painted over that
 * point, and Playwright's hit test correctly refused. Home's rows measured y=222/713/1204 at h=463
 * while Explore's sat at y=354/769/1184 at h=407, interleaved.
 */
function exploreRows(page: Page): Locator {
  return page.getByTestId('explore-list').locator('[data-testid^="meal-"]');
}

async function exploreMealIds(page: Page): Promise<readonly string[]> {
  const rows = await exploreRows(page).all();
  const ids: string[] = [];
  for (const row of rows) {
    const id = ((await row.getAttribute('data-testid')) ?? '').slice('meal-'.length);
    if (id !== '') {
      ids.push(id);
    }
  }
  return ids;
}

function requireId(ids: readonly string[], index: number): string {
  const id = ids[index];
  if (id === undefined) {
    throw new Error(`Explore rendered ${String(ids.length)} meals; this spec needs two`);
  }
  return id;
}

/** One favourite's row in Saved, addressed by id — never by position (R-45). */
function savedRow(page: Page, mealId: string): Locator {
  return page.getByTestId(`saved-favorite-${mealId}`);
}

/** Saved, with its favourites section settled — an absence read mid-fetch is "not yet", not "not there". */
async function openSaved(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByTestId('saved-favorites-loading')).toBeHidden({ timeout: FIRST_PAINT_MS });
}

/** Explore, loaded. Tapped rather than deep-linked: web deep linking does not work (R-44). */
async function openExplore(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Explore' }).click();
  await expect(page.getByTestId('explore-list')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

/**
 * The details modal for one catalog meal, loaded far enough that the heart exists. Scoped to the
 * list for `exploreRows`' reason: an unscoped `meal-<id>` resolves to Home's still-mounted card,
 * which is behind Explore and cannot be clicked.
 */
async function openDetailsFromExplore(page: Page, mealId: string): Promise<void> {
  await exploreRows(page)
    .and(page.getByTestId(`meal-${mealId}`))
    .click();
  await expect(page.getByTestId('meal-details-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  // The heart is rendered only in the `loaded` state, so its presence IS the assertion that the
  // request finished — and `meal-details-body` proves it finished with a meal rather than a state.
  await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByTestId('meal-details-favorite')).toBeVisible();
}

interface ChosenMeals {
  readonly chosen: string;
  /** Never touched, so that absence can be told apart from coincidence. */
  readonly control: string;
}

/**
 * The whole journey up to and including the favourite, with the empty-state control taken first.
 *
 * Shared by both tests because both need a favourite that arrived through the UI rather than
 * through a seeded key — a seeded id would prove hydration and nothing about the write.
 */
async function favouriteFirstExploreMeal(page: Page): Promise<ChosenMeals> {
  await enterApp(page);

  // THE CONTROL. Nothing is saved, and Saved says so — in the section that will change, and in
  // storage. Without it the later "it is in Saved" has no baseline to be a change from.
  await openSaved(page);
  await expect(page.getByTestId('saved-favorites-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
  expect(await storedFavoriteIds(page), 'no favourite has been added yet').toStrictEqual([]);

  await openExplore(page);
  const ids = await exploreMealIds(page);
  const chosen = requireId(ids, 0);
  const control = requireId(ids, 1);

  await openDetailsFromExplore(page, chosen);
  const heart = page.getByTestId('meal-details-favorite');
  // The state before the press, in words rather than in colour (PRD §10.5) — and the accessible
  // name says the ACTION, which is what makes the flip below observable at all.
  await expect(heart).toHaveAttribute('aria-label', 'Add to favourites');
  await expect(page.getByTestId('meal-details-favorite-state')).toHaveText(
    'Not in your favourites',
  );

  await heart.click();

  await expect(heart).toHaveAttribute('aria-label', 'Remove from favourites');
  await expect(page.getByTestId('meal-details-favorite-state')).toHaveText('Saved to favourites');
  // No refusal and no failed write on the way through: either would make everything below vacuous.
  await expect(page.getByTestId('meal-details-favorites-full')).toHaveCount(0);
  await expect(page.getByTestId('meal-details-favorites-save-error')).toHaveCount(0);

  await page.getByTestId('meal-details-dismiss').click();
  return { chosen, control };
}

test.describe('a favourite persists', () => {
  test('survives a reload, in Saved and in storage, and its envelope holds ids only', async ({
    page,
  }) => {
    const { chosen, control } = await favouriteFirstExploreMeal(page);

    // Before the reload — the "it worked at all" half, so a later failure is not mistaken for it.
    await openSaved(page);
    await expect(savedRow(page, chosen)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-favorites-empty')).toHaveCount(0);

    /**
     * **The reload.** Load → act → reload once → assert: nothing in this spec clears or seeds
     * storage after `enterApp`, so what survives here survived on its own.
     */
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });

    /**
     * Read back (1) from the screen. **What the reload restores was measured, not assumed:** the
     * URL is `/saved`, the app comes back up ON Saved with `home-screen` never mounted, and the row
     * is already rendered from a fetch made during the load — so R-44 is narrower than it reads,
     * because a **path** does restore the screen and only the **query param** case lands on Home
     * (reported under this agent's findings for T-22-01). The tab is tapped anyway, so `openSaved`
     * stays correct if that changes: on the active tab the click is a no-op, from Home it mounts
     * and fetches. Either way the ids came off the disk.
     */
    await openSaved(page);
    await expect(savedRow(page, chosen)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-favorites-empty')).toHaveCount(0);
    // And the orphan path did not fire: an id that survives but no longer resolves renders "could
    // not be found", a different defect wearing the same green.
    await expect(page.getByTestId('saved-favorites-missing')).toHaveCount(0);

    // THE NEGATIVE CONTROL: if this can pass for `chosen`, the assertion above proves nothing.
    await expect(savedRow(page, control)).toHaveCount(0);

    // Read back (2) from storage: a screen could render from a cache the next launch will not have.
    const envelope = await storedEnvelope(page);
    expect(envelope, 'the favourites key must exist after a reload').not.toBeNull();
    if (envelope === null) {
      return;
    }

    // TSD §6.4's shape: three fields, no more. A fourth is a payload hydration ignores today and
    // quarantines the day the schema tightens.
    expect(envelope.fields).toStrictEqual(['schemaVersion', 'updatedAt', 'value']);
    expect(envelope.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    // An ISO instant, not merely a string: `''` satisfies a `typeof` check and `isTimestamp`
    // rejects it at the next launch, quarantining the whole entry.
    expect(envelope.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // **Ids only, and exactly one.** `toStrictEqual` over `toContain`: a duplicate here would mean
    // hydration re-appended what it had just read, which is how a bounded list fills up on its own.

    expect(await storedFavoriteIds(page)).toStrictEqual([chosen]);

    const raw = await rawFavorites(page);
    expect(raw).not.toBeNull();
    // A meal or a preference set cached under this key would render identically and break at the
    // bound, so the raw payload is checked and not only the parse.
    for (const word of MUST_NOT_APPEAR) {
      expect(raw ?? '', `${word} must not be stored under the favourites key`).not.toContain(word);
    }

    // Read back (3) from the heart, the screen that OWNS the toggle — a distinct claim, because
    // `isFavorite` now runs against a store hydrated off the disk rather than one this session
    // dispatched into. "Not in your favourites" over a meal sitting in Saved is the state FR-012's
    // "idempotent" makes impossible.
    await savedRow(page, chosen).click();
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('meal-details-favorite')).toHaveAttribute(
      'aria-label',
      'Remove from favourites',
    );
    await expect(page.getByTestId('meal-details-favorite-state')).toHaveText('Saved to favourites');
  });

  test('un-favouriting removes it from Saved and from storage, and the removal survives a reload', async ({
    page,
  }) => {
    /**
     * FR-012's other half, and the removal has its own projection: the reducer must ALLOCATE the
     * shorter list, because the new reference is what queues the write. A branch returning the old
     * object would leave the favourite on disk, and it would come back at the next launch — which
     * is exactly the reload at the end of this test.
     */
    const { chosen } = await favouriteFirstExploreMeal(page);

    await openSaved(page);
    const row = savedRow(page, chosen);
    await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(await storedFavoriteIds(page)).toStrictEqual([chosen]);

    // Removed the way a user removes it: back into the meal, and the same heart.
    await row.click();
    await expect(page.getByTestId('meal-details-body')).toBeVisible({ timeout: FIRST_PAINT_MS });
    const heart = page.getByTestId('meal-details-favorite');
    await expect(heart).toHaveAttribute('aria-label', 'Remove from favourites');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-label', 'Add to favourites');
    await page.getByTestId('meal-details-dismiss').click();

    // Gone from the screen, and the empty state is BACK — not merely one row fewer.
    await openSaved(page);
    await expect(page.getByTestId('saved-favorites-empty')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(savedRow(page, chosen)).toHaveCount(0);
    // Gone from storage. The key may remain holding an empty list — that is the write landing, not
    // a leftover — so the claim is about the ids, never the key's presence.
    await expect
      .poll(async () => (await storedFavoriteIds(page)).join(','), { timeout: FIRST_PAINT_MS })
      .toBe('');

    // And the removal persists, which is the assertion a reducer returning the old reference fails.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSaved(page);
    await expect(page.getByTestId('saved-favorites-empty')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(savedRow(page, chosen)).toHaveCount(0);
    expect(await storedFavoriteIds(page)).toStrictEqual([]);
  });
});
