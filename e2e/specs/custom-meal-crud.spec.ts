import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { enterApp } from '../support/appPhase.js';

/**
 * The whole custom-meal journey in a real browser (T-17-08, T-17-06, FR-013).
 *
 * **PRD §8.3 verbatim:** "Saved → create through a validated form → the record persists and appears
 * in the list → edit it, and the change survives a restart → delete it after confirmation." That is
 * one test below, in that order, with nothing seeded: every record here was typed into the form.
 *
 * **What this proves that no other suite can.** `mealFormValidation.test.ts` proves the rules,
 * `customMealsState.test.ts` proves the reducer, and `MealForm.dom.test.tsx` proves the screen
 * dispatches — all against memory. None of them has run the projection: form → `composeCustomMeal`
 * → reducer → `StorageProvider`'s queued write → the AsyncStorage web driver → `localStorage` → a
 * real page load → `decodeEnvelope` → hydration → a rendered row. That lane is what T-17-06's
 * "stays deleted after restart" is about, and a reload is the only thing in this project that
 * exercises it.
 *
 * **Every claim is read off the DISK as well as the screen**, because the two failing together is a
 * different defect from either alone: a row with no stored record is gone at the next launch, and a
 * stored record with no row means the write worked and hydration or the list dropped it. One
 * assertion cannot tell those apart and each has its own fix. It also catches the one state this
 * screen's own docstring says every success signal agrees about — a `customMeals` key that read as
 * `unavailable`, where the reducer accepts the record, the write is skipped in silence, and the
 * form closes on a meal that does not exist. `storedIds` is what would fail there.
 *
 * **The cancel path is asserted on the disk too.** A cancel button wired to `onDelete` would close
 * the sheet exactly like the real one, so "the sheet closed" is not a test of it. The record still
 * being there — in the list, and after a reload — is.
 *
 * **Field-boundness is asserted as DOM containment** (PRD §13: "validation errors appear beside the
 * field"): `FormField` renders its `role="alert"` *inside* its own `field-<name>` container, so an
 * error reached through that container is beside its field by construction. For the two list-level
 * errors there is no such container, so the claim is made geometrically instead — see `topOf`.
 *
 * Four harness lessons are obeyed rather than re-learned: **the app opens on HomeTab**, so every
 * screen is reached by tapping; **no `addInitScript`**, which runs in every new document and would
 * have this spec delete the data it is about (`enterApp` loads, seeds and reloads once, and nothing
 * afterwards touches storage but the app); **never a DOM row count as a set size** (R-45) — every
 * comparison is by id; and **selectors are scoped to the screen**, because the stack keeps Saved
 * mounted under `MealForm` and its rows stay in the DOM while the form is on top.
 *
 * **`MealForm` is never reloaded, deliberately.** Its `mealId` is a query param (`linking.ts`) and
 * R-44 records that a query param lands on Home. Every reload below happens on Saved, whose path
 * does restore.
 */

/** A cold bundle plus the first request; short enough to fail rather than hang. */
const FIRST_PAINT_MS = 20_000;

/** TSD §6.4's key and schema version, restated rather than imported: this spec asserts from
 * OUTSIDE the app, so a drift between the two must fail here rather than be shared away. */
const CUSTOM_MEALS_KEY = '@nutritime/custom-meals/v1';
const EXPECTED_SCHEMA_VERSION = 1;

/** `kebabIdSchema` from `packages/contracts/src/schemas.ts`, restated for the same reason. A
 * lowercase v4 UUID satisfies it (CONTRACTS §0), so this is the real bound on a generated id. */
const KEBAB_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** `MEAL_FORM_MESSAGES`' copy for the three rules asserted here, restated from outside the app. */
const MESSAGES = {
  nameRequired: 'Enter a name for this meal.',
  ingredientsRequired: 'Add at least one ingredient.',
  nutritionIncomplete: 'Enter all four nutrition figures, or leave all four blank.',
} as const;

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

async function storedEnvelope(page: Page): Promise<StoredEnvelope | null> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), CUSTOM_MEALS_KEY);
  if (raw === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`the custom meals key holds ${raw}, which is not an envelope`);
  }
  return {
    fields: Object.keys(parsed).sort(),
    schemaVersion: parsed['schemaVersion'],
    updatedAt: parsed['updatedAt'],
    value: parsed['value'],
  };
}

/**
 * The stored records, or `[]` when the key is absent. **Throws rather than coerces**: `customMeals`
 * holds whole records, so a string or a null in that array is a record hydration will quarantine at
 * the next launch, and it must fail this spec loudly rather than be filtered quietly out of it.
 */
async function storedMeals(page: Page): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const envelope = await storedEnvelope(page);
  if (envelope === null) {
    return [];
  }
  const value = envelope.value;
  if (!Array.isArray(value)) {
    throw new Error(`the custom meals value is ${typeof value}, not a list of records`);
  }
  return value.map((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      throw new Error(`custom meal ${String(index)} is stored as ${typeof entry}, not a record`);
    }
    return entry;
  });
}

async function storedIds(page: Page): Promise<readonly string[]> {
  const meals = await storedMeals(page);
  return meals.map((meal, index) => {
    const id = meal['id'];
    if (typeof id !== 'string') {
      throw new Error(`custom meal ${String(index)} has ${typeof id} for an id, not a string`);
    }
    return id;
  });
}

/** The one stored record. `length !== 1` is a failure and not a pick: a create that ran twice is
 * the duplication `onSave`'s `done` latch exists to prevent, and it must not be read past. */
async function onlyStoredMeal(page: Page): Promise<Readonly<Record<string, unknown>>> {
  const meals = await storedMeals(page);
  const only = meals[0];
  if (meals.length !== 1 || only === undefined) {
    throw new Error(`expected exactly one stored custom meal, found ${String(meals.length)}`);
  }
  return only;
}

/**
 * The one stored record's allergen tags. **Throws rather than coerces**, exactly as `storedIds`
 * does: a tag stored as a number is a record `customMealSchema` quarantines at the next launch,
 * and it has to fail this spec loudly rather than be filtered quietly out of a comparison.
 */
async function storedAllergenTags(page: Page): Promise<readonly string[]> {
  const tags = (await onlyStoredMeal(page))['allergenTags'];
  if (!Array.isArray(tags)) {
    throw new Error(`allergenTags is stored as ${typeof tags}, not a list`);
  }
  return tags.map((tag: unknown, index: number) => {
    if (typeof tag !== 'string') {
      throw new Error(`allergen tag ${String(index)} is stored as ${typeof tag}, not a string`);
    }
    return tag;
  });
}

function text(meal: Readonly<Record<string, unknown>>, name: string): string {
  const value = meal[name];
  if (typeof value !== 'string') {
    throw new Error(`${name} is stored as ${typeof value}, not a string`);
  }
  return value;
}

/**
 * `MealForm`, in **either** state it can be mounted in.
 *
 * The delete confirmation removes the record, so on the render between the dispatch and the
 * effect's `leave()` the screen is `meal-form-not-found` rather than `meal-form-screen`. A helper
 * that only looked for the latter would call the form gone while it was still covering the tab bar.
 */
function mealForm(page: Page): Locator {
  return page.locator('[data-testid="meal-form-screen"], [data-testid="meal-form-not-found"]');
}

/** One custom meal's row, scoped to the custom section and addressed by id — never by position. */
function recipeRow(page: Page, mealId: string): Locator {
  // **Scoped to the screen, not to `saved-custom`, since P28's `SectionList` root.** The rows
  // are cells of the ROOT list now, so the section container cannot contain them — the old
  // scope matched nothing. `saved-recipe-` is the custom section's own prefix, so nothing else
  // matches.
  return page.getByTestId('saved-screen').getByTestId(`saved-recipe-${mealId}`);
}

/**
 * The allergen conflict marker for one custom row.
 *
 * **A SIBLING of the card, not a child of it**, so it cannot be reached through `recipeRow`:
 * `SavedMealRow` renders the warning *above* the card on purpose, because a screen reader reaches
 * children in order and a warning after the thing it warns about arrives too late. Scoped to
 * `saved-custom` for `customRowIds`' reason — `FavoritesSection` renders its own rows, with their
 * own markers, in the same screen.
 */
function conflictMarker(page: Page, mealId: string): Locator {
  // **Same rescope, and this one is a WEAKER guarantee than it was — say so rather than let a
  // reader assume otherwise.** `saved-conflict-<id>` is rendered by BOTH sections
  // (`SavedMealRow.tsx`), so the container was what disambiguated them; after P28's
  // `SectionList` root it is the id alone. A custom meal's UUID cannot collide with a catalog
  // slug, so it holds — but it holds on the id space, not on the DOM.
  return page.getByTestId('saved-screen').getByTestId(`saved-conflict-${mealId}`);
}

/**
 * Every custom meal the list is showing. **Scoped inside `saved-custom`, and that is not tidiness:**
 * the root stack keeps `Tabs` mounted under `MealForm`, so these rows are in the DOM the whole time
 * the form is open, and `FavoritesSection` renders its own rows in the same screen.
 */
async function customRowIds(page: Page): Promise<readonly string[]> {
  const rows = await page
    .getByTestId('saved-screen')
    .locator('[data-testid^="saved-recipe-"]')
    .all();
  const ids: string[] = [];
  for (const row of rows) {
    const id = ((await row.getAttribute('data-testid')) ?? '').slice('saved-recipe-'.length);
    if (id !== '') {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Saved, with its custom section on screen. Tapped rather than deep-linked (R-44).
 *
 * **The form is asserted gone first, for two reasons.** `MealForm` covers the tab bar, so the click
 * below would time out on a hit test rather than say what was wrong; and Saved's rows are mounted
 * under it, so every assertion after this one would be reading a screen the user is not looking at.
 */
async function openSaved(page: Page): Promise<void> {
  await expect(mealForm(page)).toHaveCount(0, { timeout: FIRST_PAINT_MS });
  await page.getByRole('tab', { name: 'Saved' }).click();
  await expect(page.getByTestId('saved-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByTestId('saved-custom')).toBeVisible({ timeout: FIRST_PAINT_MS });
}

function field(page: Page, name: string): Locator {
  return page.getByTestId(`field-${name}`);
}

function input(page: Page, name: string): Locator {
  // `input, textarea`: a `multiline` `FormField` is a textarea, and description and steps are.
  return field(page, name).locator('input, textarea').first();
}

async function fill(page: Page, name: string, value: string): Promise<void> {
  await input(page, name).fill(value);
}

/**
 * A field's own error. `FormField` renders its `role="alert"` INSIDE the `field-<name>` container,
 * so reaching it through that container is what "beside the field" means in a DOM.
 */
function fieldError(page: Page, name: string): Locator {
  return field(page, name).getByRole('alert');
}

/**
 * One error message and nothing else in its row.
 *
 * Every error surface in this form is an `Icon` beside a `Text`, and the icon is a glyph in an icon
 * font — so its private-use codepoint is part of the row's `textContent` and a bare `toHaveText`
 * fails on a character no user reads (the first run of this spec did, on `U+F5D6`). Matched as "the
 * decorative mark, then exactly this sentence", which keeps the assertion **exact**: a second
 * message appended to the same row, or a truncated one, still fails it — which `toContainText`
 * would not.
 */
function exactly(message: string): RegExp {
  return new RegExp(`^\\P{ASCII}?${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'u');
}

/** A locator's top edge, for the one claim that has no container to lean on. */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('the element has no box, so it is not rendered');
  }
  return box.y;
}

interface Nutrition {
  readonly calories: string;
  readonly protein: string;
  readonly carbs: string;
  readonly fat: string;
  readonly servings: string;
}

interface MealDraft {
  readonly name: string;
  readonly price: string;
  readonly minutes: string;
  readonly ingredient: string;
  readonly step: string;
  /** `null` leaves all four figures and the serving count blank — FR-006's other branch. */
  readonly nutrition: Nutrition | null;
}

const FULL_NUTRITION: Nutrition = {
  calories: '520',
  protein: '30',
  carbs: '60',
  fat: '18',
  servings: '2',
};

const VALID: MealDraft = {
  name: 'Lentil stew from my kitchen',
  price: '4.50',
  minutes: '35',
  ingredient: 'Red lentils',
  step: 'Simmer the lentils until soft, then season.',
  nutrition: FULL_NUTRITION,
};

/** Chosen so neither name is a substring of the other: the edit assertion checks for the absence
 * of the old one, and `toContainText` cannot tell "Stew" from "Stew, revised". */
const EDITED_NAME = 'Spiced chickpea bowl';

/** A create form, confirmed to be one: a preloaded edit form would make every fill below an edit. */
async function openNewMealForm(page: Page): Promise<void> {
  await page.getByTestId('saved-new-meal').click();
  await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.getByTestId('meal-form-delete')).toHaveCount(0);
}

/**
 * Every required field, plus nutrition when the draft has it.
 *
 * The chips are tapped rather than typed because they are a fixed list (R-30), and only in create
 * mode: `draftFromCustomMeal` restores the selections, so a tap in edit mode would clear them.
 */
async function fillMealForm(page: Page, draft: MealDraft): Promise<void> {
  await fill(page, 'name', draft.name);
  await page.getByTestId('chip-period-lunch').click();
  await page.getByTestId('chip-diet-vegetarian').click();
  await fill(page, 'ingredient-0-name', draft.ingredient);
  await fill(page, 'ingredient-0-measure', '200 g');
  await fill(page, 'instruction-0', draft.step);
  await fill(page, 'price', draft.price);
  await fill(page, 'minutes', draft.minutes);
  const nutrition = draft.nutrition;
  if (nutrition !== null) {
    await fill(page, 'calories', nutrition.calories);
    await fill(page, 'protein', nutrition.protein);
    await fill(page, 'carbs', nutrition.carbs);
    await fill(page, 'fat', nutrition.fat);
    await fill(page, 'servings', nutrition.servings);
  }
}

/**
 * Save, and the screen leaves.
 *
 * **Leaving IS the success signal**, and that is the screen's own design rather than a convenience
 * here: no outcome message it can render ever reports a success, because a save that worked has
 * already navigated away. A refused save keeps the form mounted, which is what this fails on.
 */
async function saveAndLeave(page: Page): Promise<void> {
  await page.getByTestId('meal-form-save').click();
  await expect(mealForm(page)).toHaveCount(0, { timeout: FIRST_PAINT_MS });
}

/** The create half of the journey, for the tests that are about what happens afterwards. */
async function createOneMeal(page: Page): Promise<string> {
  await enterApp(page);
  await openSaved(page);
  await expect(page.getByTestId('saved-custom-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
  await openNewMealForm(page);
  await fillMealForm(page, VALID);
  await saveAndLeave(page);
  await openSaved(page);
  const mealId = text(await onlyStoredMeal(page), 'id');
  await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
  return mealId;
}

test.describe('a custom meal, through the real form', () => {
  test('created, listed, edited across a reload, then deleted behind its confirmation', async ({
    page,
  }) => {
    await enterApp(page);

    /**
     * THE CONTROL, taken before anything is written. The custom section says it is empty and so
     * does the disk — without it, "the meal is in Saved" would also be satisfied by a list that
     * showed everything, and "it is on the disk" by a key that was already populated.
     */
    await openSaved(page);
    await expect(page.getByTestId('saved-custom-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
    expect(await storedIds(page), 'nothing has been created yet').toStrictEqual([]);
    expect(await customRowIds(page)).toStrictEqual([]);

    await openNewMealForm(page);
    await fillMealForm(page, VALID);
    await saveAndLeave(page);

    // (1) The screen. The EMPTY STATE IS GONE, which is a change rather than a coincidence.
    await openSaved(page);
    await expect(page.getByTestId('saved-custom-empty')).toHaveCount(0);
    const created = await onlyStoredMeal(page);
    const mealId = text(created, 'id');
    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(recipeRow(page, mealId)).toContainText(VALID.name);
    // One row, by id. A second would be the duplicate create `done` and `pendingSave` prevent.
    expect(await customRowIds(page)).toStrictEqual([mealId]);

    // (2) The envelope. TSD §6.4's shape: three fields, no more. A fourth is a payload hydration
    // ignores today and quarantines the day the schema tightens.
    const envelope = await storedEnvelope(page);
    expect(envelope, 'the custom meals key must exist after a create').not.toBeNull();
    if (envelope === null) {
      return;
    }
    expect(envelope.fields).toStrictEqual(['schemaVersion', 'updatedAt', 'value']);
    expect(envelope.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    // An ISO instant, not merely a string: `''` satisfies a `typeof` check and `isTimestamp`
    // rejects it at the next launch, quarantining every custom meal the user has authored.
    expect(envelope.updatedAt).toMatch(ISO_INSTANT);

    /**
     * (3) The record. `kebabIdSchema` is what `mealSchema.id` enforces, so an id outside it is a
     * record the storage edge refuses — and `composeCustomMeal`'s own backstop would have turned
     * that into a save the user was told about, which means an id here that fails this is an id
     * the reducer accepted and nothing rejected.
     */
    expect(mealId).toMatch(KEBAB_ID);
    expect(created['source']).toBe('user');
    // `CustomMeal` is `Omit<Meal, 'source' | 'catalogVersion'>`: a catalog version on a record the
    // user typed would mean it was built from a catalog meal rather than from this form.
    expect(created['catalogVersion']).toBeUndefined();
    const provenance = created['nutritionProvenance'];
    expect(isRecord(provenance), 'nutritionProvenance must be an object').toBe(true);
    if (!isRecord(provenance)) {
      return;
    }
    // `mealSchema.superRefine`: `source: 'user'` ⇒ this origin. The two disagreeing is a record
    // that fails validation at the storage edge with no field to point at.
    expect(provenance['origin']).toBe('user');
    expect(provenance['servings']).toBe(2);
    expect(created['nutrition']).toStrictEqual({
      calories: 520,
      proteinGrams: 30,
      carbsGrams: 60,
      fatGrams: 18,
    });
    // Both timestamps at ONE instant on create (`createRecord` stamps them from a single `now()`),
    // which is what makes "updatedAt moved" readable after the edit rather than merely plausible.
    const createdAt = text(created, 'createdAt');
    expect(createdAt).toMatch(ISO_INSTANT);
    expect(text(created, 'updatedAt')).toBe(createdAt);

    /** THE EDIT. Reached by tapping the row, which CONTRACTS §10 routes to `MealForm`. */
    await recipeRow(page, mealId).click();
    await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    // Edit mode, preloaded. An empty create form wearing an edit title would make the rename below
    // a second create, and the assertions after it would be about the wrong record.
    await expect(input(page, 'name')).toHaveValue(VALID.name);
    await expect(page.getByTestId('meal-form-delete')).toBeVisible();
    await fill(page, 'name', EDITED_NAME);
    await saveAndLeave(page);

    await openSaved(page);
    await expect(recipeRow(page, mealId)).toContainText(EDITED_NAME);

    /**
     * THE RELOAD. Load → act → reload once → assert: nothing in this spec seeds or clears storage
     * after `enterApp`, so what survives here survived on its own.
     */
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSaved(page);

    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(recipeRow(page, mealId)).toContainText(EDITED_NAME);
    // The edit REPLACED the record rather than adding one: the old name is nowhere on the row, and
    // there is still exactly one row.
    await expect(recipeRow(page, mealId)).not.toContainText(VALID.name);
    expect(await customRowIds(page)).toStrictEqual([mealId]);
    // THE NEGATIVE CONTROL: if a row can be found for a meal that was never created, the
    // assertions above prove nothing.
    await expect(recipeRow(page, `${mealId}-never-created`)).toHaveCount(0);

    const edited = await onlyStoredMeal(page);
    expect(text(edited, 'id'), 'an edit keeps the id').toBe(mealId);
    expect(text(edited, 'name')).toBe(EDITED_NAME);
    // **`createdAt` preserved and `updatedAt` moved** — two halves of one claim. A re-stamped
    // `createdAt` loses when the user wrote this; a frozen `updatedAt` makes every later
    // conflict-resolution or ordering decision read the wrong record as the newer one.
    expect(text(edited, 'createdAt'), 'createdAt survives an edit').toBe(createdAt);
    const editedAt = text(edited, 'updatedAt');
    expect(editedAt > createdAt, `updatedAt ${editedAt} must be after createdAt ${createdAt}`).toBe(
      true,
    );
    expect(edited['source']).toBe('user');

    /** THE DELETE, behind its confirmation (FR-014, T-17-06). */
    await recipeRow(page, mealId).click();
    await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('meal-form-delete').click();
    await expect(page.getByTestId('meal-form-delete-sheet')).toBeVisible();
    // **Nothing is deleted by OPENING the confirmation.** A delete dispatched from the destructive
    // button would still pass a test that only read the disk after the confirm.
    //
    // **Measured (P24): this read can never be the assertion that REPORTS that defect**, and the
    // reason is the screen's shape rather than an oversight here. The sheet is rendered inside the
    // `existing === undefined ? null : …` fragment, so a record deleted early takes the sheet with
    // it and the `toBeVisible` above fails first. Reading the disk before that wait instead would
    // be weaker, not stronger: the write is queued asynchronously, so an immediate read would pass
    // while a delete was still in flight. Kept as the statement of intent, with the knowledge that
    // the sheet's own presence is what discriminates.
    expect(await storedIds(page), 'the sheet is open, not confirmed').toStrictEqual([mealId]);

    await page.getByTestId('meal-form-delete-confirm').click();
    await expect(mealForm(page)).toHaveCount(0, { timeout: FIRST_PAINT_MS });

    await openSaved(page);
    await expect(page.getByTestId('saved-custom-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(recipeRow(page, mealId)).toHaveCount(0);
    // The key may remain holding an empty list — that is the write landing, not a leftover — so
    // the claim is about the records, never the key's presence.
    await expect
      .poll(async () => (await storedIds(page)).join(','), { timeout: FIRST_PAINT_MS })
      .toBe('');

    /**
     * T-17-06's acceptance in full: **stays deleted after restart.** This is the assertion a
     * reducer that returned the old array reference fails — the shorter list is what queues the
     * write, so a missing allocation leaves the record on disk and it comes back at the next
     * launch, which reads as the app undoing the user.
     */
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSaved(page);
    await expect(page.getByTestId('saved-custom-empty')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(recipeRow(page, mealId)).toHaveCount(0);
    expect(await customRowIds(page)).toStrictEqual([]);
    expect(await storedIds(page)).toStrictEqual([]);
  });

  test('cancelling the delete keeps the meal in the list, on the disk, and after a reload', async ({
    page,
  }) => {
    const mealId = await createOneMeal(page);

    await recipeRow(page, mealId).click();
    await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.getByTestId('meal-form-delete').click();
    await expect(page.getByTestId('meal-form-delete-sheet')).toBeVisible();
    await page.getByTestId('meal-form-delete-cancel').click();
    await expect(page.getByTestId('meal-form-delete-sheet')).toHaveCount(0);

    /**
     * **The sheet closing is not the claim.** A cancel wired to `onDelete` would close the sheet
     * in exactly the same way — `onDelete` begins with `setConfirmingDelete(false)` — and
     * everything below is what tells the two buttons apart.
     */
    await expect(page.getByTestId('meal-form-screen')).toBeVisible();
    // Still the EDIT form for this record: a cancel that deleted it would leave `existing`
    // undefined and this screen would be `meal-form-not-found` with no name field at all.
    await expect(input(page, 'name')).toHaveValue(VALID.name);
    expect(await storedIds(page), 'a cancelled delete writes nothing').toStrictEqual([mealId]);

    // Back to the list the way a user leaves a form they did not save.
    await page.goBack();
    await openSaved(page);
    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.getByTestId('saved-custom-empty')).toHaveCount(0);
    expect(await customRowIds(page)).toStrictEqual([mealId]);

    // And it is still there at the next launch, which is what "still on the disk" has to mean: a
    // cancel that wrote the shorter list would leave this row on screen from memory and lose it.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSaved(page);
    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(recipeRow(page, mealId)).toContainText(VALID.name);
    expect(await storedIds(page)).toStrictEqual([mealId]);
  });

  test('a missing name and an empty ingredient list are each refused beside their own field', async ({
    page,
  }) => {
    await enterApp(page);
    await openSaved(page);
    await openNewMealForm(page);

    // Everything valid EXCEPT the name, so the message below can only be about the name — and so
    // that "it did not save" is about that one rule rather than about nine unfilled boxes.
    await fillMealForm(page, { ...VALID, name: '' });
    await page.getByTestId('meal-form-save').click();

    // Beside its field, as DOM containment: this alert is INSIDE `field-name`.
    await expect(fieldError(page, 'name')).toHaveText(exactly(MESSAGES.nameRequired));
    // And nowhere else. A form that painted every message under every field would satisfy the
    // line above; this is what makes it field-BOUND rather than merely present.
    await expect(page.getByTestId('error-ingredients')).toHaveCount(0);
    await expect(fieldError(page, 'price')).toHaveCount(0);
    await expect(fieldError(page, 'minutes')).toHaveCount(0);
    await expect(fieldError(page, 'servings')).toHaveCount(0);
    // The form is still here and nothing reached the disk.
    await expect(page.getByTestId('meal-form-screen')).toBeVisible();
    expect(await storedIds(page), 'an invalid form writes nothing').toStrictEqual([]);

    /**
     * The second case FR-013 names. `mealSchema` requires `.min(1)` ingredients and a row with a
     * blank name is not an ingredient, so the row is removed outright — an empty LIST, which is
     * the state the rule is about.
     */
    await fill(page, 'name', VALID.name);
    await page.getByTestId('remove-ingredient-0').click();
    await expect(field(page, 'ingredient-0-name')).toHaveCount(0);
    await page.getByTestId('meal-form-save').click();

    await expect(page.getByTestId('error-ingredients')).toHaveText(
      exactly(MESSAGES.ingredientsRequired),
    );
    // The name is corrected, so its error is forgiven (S-43) — and this is also the negative half
    // of the claim above: the ingredients message did not land on the name field.
    await expect(fieldError(page, 'name')).toHaveCount(0);
    expect(await storedIds(page)).toStrictEqual([]);

    /**
     * **A list-level error has no `FormField` container to sit inside**, so its position is the
     * only thing that can carry "beside the field": it is below the name box and above "Add an
     * ingredient", which is the ingredients block. A message rendered at the top of the form, or
     * pooled with the others above Save, fails this.
     */
    const errorTop = await topOf(page.getByTestId('error-ingredients'));
    expect(errorTop).toBeGreaterThan(await topOf(field(page, 'name')));
    expect(errorTop).toBeLessThan(await topOf(page.getByTestId('add-ingredient')));
  });

  test('nutrition is all-or-nothing: three of four is refused, four blanks store nulls', async ({
    page,
  }) => {
    await enterApp(page);
    await openSaved(page);
    await openNewMealForm(page);

    /**
     * Three figures and a serving count. `mealSchema.superRefine` refuses this record, so a form
     * that let it through would reach a reducer that returns `state` identically — no error, no
     * failed dispatch, and the user's meal simply gone. Getting this wrong is what a save that
     * silently fails looks like, which is why FR-006 is asserted here and not only in a unit test.
     */
    await fillMealForm(page, { ...VALID, nutrition: { ...FULL_NUTRITION, fat: '' } });
    await page.getByTestId('meal-form-save').click();

    await expect(fieldError(page, 'fat')).toHaveText(exactly(MESSAGES.nutritionIncomplete));
    // On the blank figure, and on NONE of the three that were filled: a rule reported against a
    // box the user already filled in is a rule they cannot act on.
    await expect(fieldError(page, 'calories')).toHaveCount(0);
    await expect(fieldError(page, 'protein')).toHaveCount(0);
    await expect(fieldError(page, 'carbs')).toHaveCount(0);
    await expect(fieldError(page, 'name')).toHaveCount(0);
    await expect(page.getByTestId('meal-form-screen')).toBeVisible();
    expect(await storedIds(page), 'a three-of-four record must not be written').toStrictEqual([]);

    // The other branch of the same rule: all four blank AND the serving count cleared, which SAVES
    // — a divisor with nothing to divide is refused, so the count has to go too.
    for (const box of ['calories', 'protein', 'carbs', 'servings']) {
      await fill(page, box, '');
    }
    await saveAndLeave(page);

    await openSaved(page);
    const saved = await onlyStoredMeal(page);
    /**
     * **`null`s, not zeroes and not absent keys.** `0 kcal` is a claim about the meal that nobody
     * made, and a missing key is a record `customMealSchema` rejects — which quarantines the whole
     * list at the next launch and takes every other meal the user wrote with it.
     */
    expect(saved['nutrition']).toStrictEqual({
      calories: null,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
    });
    const provenance = saved['nutritionProvenance'];
    expect(isRecord(provenance), 'nutritionProvenance must be an object').toBe(true);
    if (!isRecord(provenance)) {
      return;
    }
    expect(provenance['origin']).toBe('user');
    expect(provenance['servings'], 'no figures means no serving count').toBeNull();
    await expect(recipeRow(page, text(saved, 'id'))).toBeVisible({ timeout: FIRST_PAINT_MS });
  });

  /**
   * The allergen warning on a record the user wrote, carried through the disk (T-17-02, FR-007).
   *
   * **This is the claim about a custom meal that no other suite can make.** `Saved.dom.test.tsx`
   * renders the row marker and `MealForm.dom.test.tsx` renders the form's notice, but both seed a
   * record straight into the store — so neither has run `allergenTags` through `composeCustomMeal`
   * → the reducer → the queued write → `localStorage` → `decodeEnvelope` → hydration → a rendered
   * row. A projection that dropped the field would leave every one of those tests green and take
   * the warning off a recipe the user tagged themselves: behaviour that exists and that nothing
   * would notice the loss of, which is this project's recurring defect shape.
   *
   * **The conflict is reachable ONLY through the stored tag, deliberately.** `VALID`'s one
   * ingredient is `Red lentils`, so both of `conflictingAllergens`' other paths — the allergy named
   * literally in an ingredient, and an ambiguous term whose inference overlaps the tags — find
   * nothing, and a declared `peanut` can match `subject.allergenTags` and nothing else. A record
   * whose tags were lost therefore shows no marker at all rather than a marker by another route.
   *
   * **Routing is why this test lives here and not in a details spec.** Tapping a custom meal opens
   * `MealForm`, never `MealDetailsScreen`, so `MealDetailsBody`'s allergen block — the other place
   * that reads `allergenTags` — is unreachable for a meal the user authored. The form's notice and
   * the Saved row's marker are the whole of the surface, and both are asserted below.
   */
  test('a declared allergen tagged on a custom meal is warned about in the form and marked in Saved, across a reload', async ({
    page,
  }) => {
    await enterApp(page, { allergies: ['peanut'] });
    await openSaved(page);
    await openNewMealForm(page);
    await fillMealForm(page, VALID);

    // THE CONTROL, on this same draft and before the tag exists. Without it, "the notice appears"
    // would also be satisfied by a form that warns about every meal.
    await expect(page.getByTestId('meal-form-allergen-conflict')).toHaveCount(0);
    await page.getByTestId('chip-allergen-peanut').click();
    // On the tap that makes it true, before any save — which is what the screen claims to do.
    await expect(page.getByTestId('meal-form-allergen-conflict')).toBeVisible();
    await saveAndLeave(page);

    await openSaved(page);
    const mealId = text(await onlyStoredMeal(page), 'id');
    expect(await storedAllergenTags(page), 'the tag reached the disk').toStrictEqual(['peanut']);
    await expect(conflictMarker(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });

    /** THE RELOAD. What is marked below is a hydrated record, not this session's draft. */
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: FIRST_PAINT_MS });
    await openSaved(page);
    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(conflictMarker(page, mealId)).toBeVisible();
    // The allergen is NAMED: "contains an allergen" is not actionable, and the user may have
    // declared several (PRD §10.5 — the glyph and the colour are both redundant with the words).
    await expect(conflictMarker(page, mealId)).toContainText('peanut');
    expect(await storedAllergenTags(page)).toStrictEqual(['peanut']);

    /**
     * THE NEGATIVE CONTROL, taken on the hydrated record rather than on a second meal: untick the
     * one tag and both surfaces go quiet. A marker rendered for every row, or a notice that is
     * really about the declared allergy rather than about this meal, passes everything above.
     */
    await recipeRow(page, mealId).click();
    await expect(page.getByTestId('meal-form-screen')).toBeVisible({ timeout: FIRST_PAINT_MS });
    // `draftFromCustomMeal` restored the selection off the disk, so this notice is the STORED tag
    // talking — the chips are not re-tapped in edit mode, which would clear them.
    await expect(page.getByTestId('meal-form-allergen-conflict')).toBeVisible();
    await page.getByTestId('chip-allergen-peanut').click();
    await expect(page.getByTestId('meal-form-allergen-conflict')).toHaveCount(0);
    await saveAndLeave(page);

    await openSaved(page);
    await expect(recipeRow(page, mealId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(conflictMarker(page, mealId)).toHaveCount(0);
    expect(await storedAllergenTags(page)).toStrictEqual([]);
  });
});
