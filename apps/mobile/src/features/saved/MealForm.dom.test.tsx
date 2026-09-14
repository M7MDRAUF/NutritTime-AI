import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom';
import type { CustomMeal } from '@nutritime/contracts';
import { conflictingAllergens } from '@nutritime/domain';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { customMealsStore } from '../../state/customMeals/index.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import {
  STORAGE_BOUNDS,
  STORAGE_DEFINITIONS,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import { decodeEnvelope, encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import {
  MEAL_FORM_MESSAGES as M,
  MEAL_ID_PATTERN,
  nutrientRangeMessage,
} from './mealFormValidation.js';
import { MealFormScreen } from './MealFormScreen.js';

/**
 * T-17-03 … T-17-07, through the real store, the real validation module and a memory driver.
 *
 * **Everything is read back through the storage schema, not through the store.** `storedMeals`
 * decodes the envelope the driver holds and parses it with `STORAGE_DEFINITIONS.customMeals.schema`
 * — the same schema the read path applies on the next launch. That is the assertion P14 needed and
 * did not have: "the store updated" would have been green while the value written was one the key
 * could not read back, which is how a user's data was erased at a launch nobody connected to the
 * save that caused it.
 *
 * **A refused create is silent**: the reducer returns `state` identically, `dispatch` returns
 * `void`, and `saveBlocked` never fires because no write is attempted. So every save assertion here
 * is about what is on disk and what is on screen afterwards — never about the press having happened.
 */

const FIRST = '2026-09-13T10:00:00.000Z';
const LATER = '2026-09-14T19:05:00.000Z';
/** A v4-shaped id, so a stubbed `crypto.randomUUID` survives `generateMealId`'s own check. */
const FIXED_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

let clockValue = FIRST;
const clock = (): string => clockValue;

/** A complete, schema-valid stored record. Nutrition all-null: the case FR-006 permits. */
function customMeal(overrides: Partial<CustomMeal> = {}): CustomMeal {
  return {
    id: 'house-omelette',
    name: 'House omelette',
    description: 'Three eggs, folded.',
    mealPeriods: ['breakfast'],
    ingredients: [{ name: 'Egg', measure: '3' }],
    instructions: ['Beat the eggs.', 'Fold in the pan.'],
    allergenTags: ['egg'],
    dietTags: ['vegetarian'],
    nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
    price: { amountCents: 450, currency: 'USD' },
    preparationMinutes: 10,
    imageUrl: null,
    available: true,
    source: 'user',
    provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
    nutritionProvenance: { origin: 'user', dataset: null, servings: null, reason: null },
    createdAt: FIRST,
    updatedAt: FIRST,
    ...overrides,
  };
}

/**
 * The device's bytes for both keys this screen reads.
 *
 * The `preferences` entry is the full `userPreferencesSchema` shape, because a partial one is
 * quarantined on read and the allergy list would silently become `[]` — which would make the
 * conflict test green for the wrong reason (no conflict, because no declared allergy).
 */
function seeded(meals: readonly CustomMeal[], allergies: readonly string[]): MemoryDriver {
  const store: Record<string, string> = {};
  if (meals.length > 0) {
    store[STORAGE_KEYS.customMeals] = encodeEnvelope(STORAGE_SCHEMA_VERSION, meals, FIRST);
  }
  if (allergies.length > 0) {
    store[STORAGE_KEYS.preferences] = encodeEnvelope(
      STORAGE_SCHEMA_VERSION,
      {
        schemaVersion: STORAGE_SCHEMA_VERSION,
        diet: 'regular',
        allergies,
        goal: 'balanced',
        budget: 'medium',
        dislikedIngredients: [],
        mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
        aiEnabled: true,
        themeMode: 'system',
      },
      FIRST,
    );
  }
  return memoryDriver(store);
}

interface Harness {
  readonly driver: MemoryDriver;
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  text(): string;
  /** What is on the device, read back through the key's own schema. */
  stored(): readonly CustomMeal[];
  goBacks(): number;
  navigations(): readonly { readonly route: string; readonly params: unknown }[];
  settle(): Promise<void>;
}

let open: { readonly root: Root; readonly host: HTMLElement }[] = [];

afterEach(() => {
  // Every query below is rooted at `document.body`, because `Sheet` is a `Modal` and
  // react-native-web portals a `Modal` into the body rather than into the container. So a tree
  // left mounted would be found by the next test in this file — hence a real unmount.
  for (const one of open) {
    act(() => {
      one.root.unmount();
    });
    one.host.remove();
  }
  open = [];
  vi.unstubAllGlobals();
  clockValue = FIRST;
});

async function render(options: {
  readonly mealId?: string;
  readonly meals?: readonly CustomMeal[];
  /** Declared allergies, seeded into the `preferences` key the conflict notice reads. */
  readonly allergies?: readonly string[];
  readonly driver?: MemoryDriver;
  /** `false` puts the screen first in the stack — the deep-link case (V13). */
  readonly canGoBack?: boolean;
}): Promise<Harness> {
  const driver = options.driver ?? seeded(options.meals ?? [], options.allergies ?? []);
  const host = document.createElement('div');
  document.body.appendChild(host);
  let goBacks = 0;
  const navigations: { readonly route: string; readonly params: unknown }[] = [];

  const tree: ReactNode = (
    <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
      <StorageProvider runtime={{ driver, now: clock }}>
        <preferencesStore.Provider>
          <customMealsStore.Provider>
            <MealFormScreen
              route={
                {
                  key: 'form',
                  name: 'MealForm',
                  params: options.mealId === undefined ? undefined : { mealId: options.mealId },
                } as never
              }
              navigation={
                {
                  goBack: () => {
                    goBacks += 1;
                  },
                  canGoBack: () => options.canGoBack ?? true,
                  navigate: (route: string, params: unknown) => {
                    navigations.push({ route, params });
                  },
                } as never
              }
            />
          </customMealsStore.Provider>
        </preferencesStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );

  const root = createRoot(host);
  open.push({ root, host });
  await act(async () => {
    root.render(tree);
  });

  /**
   * This tree first, then the body.
   *
   * The body fallback is what finds `Sheet`: it is a `Modal`, and react-native-web portals a
   * `Modal` out of the container into `document.body`. But a body-only query is **ambiguous the
   * moment two trees are mounted at once** — it returns whichever appears first in the document,
   * which is how the negative control below originally typed into the previous harness's fields
   * and then read that harness's conflict notice. Own host first removes the ambiguity for every
   * query except the portal, where only one sheet is ever open.
   */
  const find = (testID: string): HTMLElement | null => {
    const found =
      host.querySelector(`[data-testid="${testID}"]`) ??
      document.body.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    driver,
    find,
    must: (testID) => {
      const found = find(testID);
      if (found === null) {
        throw new Error(`no element for testID ${testID}`);
      }
      return found;
    },
    text: () => document.body.textContent ?? '',
    stored: () => storedMeals(driver),
    goBacks: () => goBacks,
    navigations: () => navigations,
    settle: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

/**
 * The stored list, decoded and parsed the way the next launch will parse it.
 *
 * A throw rather than a fallback: a record that does not satisfy its own key's schema is the P14
 * defect, and a test that quietly returned `[]` for it would report "nothing was saved" for the
 * most dangerous outcome there is.
 */
function storedMeals(driver: MemoryDriver): readonly CustomMeal[] {
  const raw = driver.store.get(STORAGE_KEYS.customMeals);
  if (raw === undefined) {
    return [];
  }
  const decoded = decodeEnvelope(raw);
  if (!decoded.ok) {
    throw new Error(`the stored custom meals could not be decoded: ${decoded.reason}`);
  }
  const parsed = STORAGE_DEFINITIONS.customMeals.schema.safeParse(decoded.envelope.value);
  if (!parsed.success) {
    throw new Error('what was written does not satisfy the customMeals schema');
  }
  return parsed.data;
}

function press(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function inputIn(container: HTMLElement): HTMLElement {
  const found = container.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no input rendered');
  }
  return found;
}

function typeIn(view: Harness, testID: string, value: string): void {
  const field = inputIn(view.must(testID));
  act(() => {
    fireEvent.change(field, { target: { value } });
  });
}

/**
 * A real focus then a real blur, which is what `FormField`'s own suite does. `fireEvent.blur`
 * fires a non-bubbling event on an element that was never focused, so react-native-web's
 * `TextInput` never sees it.
 */
function blurField(target: HTMLElement): void {
  act(() => {
    target.focus();
  });
  act(() => {
    target.blur();
  });
}

function fieldText(view: Harness, testID: string): string {
  return view.must(testID).textContent ?? '';
}

/** Everything `mealSchema` requires, and nothing more: nutrition stays blank (FR-006). */
function fillValidDraft(view: Harness): void {
  typeIn(view, 'field-name', 'Overnight oats');
  press(view.must('chip-period-breakfast'));
  press(view.must('chip-diet-vegetarian'));
  typeIn(view, 'field-ingredient-0-name', 'Rolled oats');
  typeIn(view, 'field-ingredient-0-measure', '80 g');
  typeIn(view, 'field-instruction-0', 'Combine the oats and milk, then chill.');
  typeIn(view, 'field-price', '4.50');
  typeIn(view, 'field-minutes', '10');
}

describe('MealFormScreen — create (T-17-03)', () => {
  it('opens as a create form with nothing wrong yet, and states the nutrition rule first', async () => {
    const view = await render({});

    expect(view.text()).toContain('New meal');
    // S-43: no field has been visited, so no field is in error — a form that greets a new user
    // with four complaints is a form they leave.
    expect(view.text()).not.toContain(M.nameRequired);
    expect(view.text()).not.toContain(M.ingredientsRequired);
    expect(view.text()).not.toContain(M.priceRequired);
    // FR-006's all-or-nothing rule, said BEFORE anyone can break it.
    expect(view.text()).toContain('Leave all four blank');
    expect(view.text()).toContain(nutrientRangeMessage('caloriesText'));
    // Nothing to delete on a meal that does not exist yet.
    expect(view.find('meal-form-delete')).toBeNull();
  });

  it('saves one record with a UUID id that its own storage schema accepts, then closes', async () => {
    const view = await render({});
    fillValidDraft(view);

    // Not one byte of the draft has reached storage yet, which is the whole point of holding it
    // in screen state: P14's screen dispatched every keystroke and the store held anything.
    await view.settle();
    expect(view.stored()).toHaveLength(0);

    press(view.must('meal-form-save'));
    await view.settle();

    const stored = view.stored();
    expect(stored).toHaveLength(1);
    const saved = stored[0];
    expect(saved?.name).toBe('Overnight oats');
    // FR-013: "IDs are UUID strings" — and lowercase, so `kebabIdSchema` accepts it too.
    expect(saved?.id).toMatch(MEAL_ID_PATTERN);
    expect(saved?.source).toBe('user');
    expect(saved?.nutritionProvenance.origin).toBe('user');
    expect(saved?.nutrition.calories).toBeNull();
    expect(saved?.price.amountCents).toBe(450);
    // The injected clock, not the wall clock.
    expect(saved?.createdAt).toBe(FIRST);
    expect(saved?.updatedAt).toBe(FIRST);
    // Closed only because the record landed; the confirmation is what decides this.
    expect(view.goBacks()).toBe(1);
    expect(view.find('meal-form-save-failed')).toBeNull();
    /**
     * The third refusal cause — a record `customMealSchema` rejects — asserted as unreachable
     * here. `composeCustomMeal` runs that same schema before returning, so its refusal would show
     * as `notSaveable` beside the name and nothing would be dispatched. Its absence, together with
     * `storedMeals` throwing rather than returning when the written value fails that schema, is
     * what says the field rules and the storage schema still agree.
     */
    expect(fieldText(view, 'field-name')).not.toContain(M.notSaveable);
  });

  it('saves once when Save is pressed twice', async () => {
    /**
     * A create composes a **fresh id** every time, so a second press the screen let through would
     * be a second record the reducer accepts without complaint — the duplication this screen
     * exists to prevent, invisible until the user opens Saved and finds their meal twice.
     * `goBack` is not instantaneous, so the form is still on screen and still pressable.
     */
    const view = await render({});
    fillValidDraft(view);

    press(view.must('meal-form-save'));
    await view.settle();
    press(view.must('meal-form-save'));
    await view.settle();

    expect(view.stored()).toHaveLength(1);
    expect(view.goBacks()).toBe(1);
  });
});

describe('MealFormScreen — validation (T-17-05, FR-013)', () => {
  it('refuses a missing name, beside the name field and nowhere else', async () => {
    const view = await render({});
    fillValidDraft(view);
    typeIn(view, 'field-name', '   ');

    press(view.must('meal-form-save'));

    expect(fieldText(view, 'field-name')).toContain(M.nameRequired);
    expect(fieldText(view, 'field-price')).not.toContain(M.nameRequired);
    expect(fieldText(view, 'field-minutes')).not.toContain(M.nameRequired);
    expect(fieldText(view, 'field-ingredient-0-name')).not.toContain(M.nameRequired);
    // And nothing was saved or navigated away from.
    expect(view.stored()).toHaveLength(0);
    expect(view.goBacks()).toBe(0);
  });

  it('refuses an empty ingredient list', async () => {
    const view = await render({});
    fillValidDraft(view);
    press(view.must('remove-ingredient-0'));

    press(view.must('meal-form-save'));

    expect(view.must('error-ingredients').textContent).toContain(M.ingredientsRequired);
    expect(view.stored()).toHaveLength(0);
  });

  it('refuses a negative price and a negative preparation time, each on its own field', async () => {
    const view = await render({});
    fillValidDraft(view);
    typeIn(view, 'field-price', '-4.50');
    typeIn(view, 'field-minutes', '-10');

    press(view.must('meal-form-save'));

    expect(fieldText(view, 'field-price')).toContain(M.negative);
    expect(fieldText(view, 'field-minutes')).toContain(M.negative);
    expect(view.stored()).toHaveLength(0);
  });

  it('refuses an unreadable price and a price with too many decimals', async () => {
    const view = await render({});
    fillValidDraft(view);

    typeIn(view, 'field-price', '4.505');
    press(view.must('meal-form-save'));
    expect(fieldText(view, 'field-price')).toContain(M.pricePrecision);

    typeIn(view, 'field-price', 'free');
    expect(fieldText(view, 'field-price')).toContain(M.priceFormat);
    expect(view.stored()).toHaveLength(0);
  });

  it('refuses a preparation time outside the schema bound', async () => {
    const view = await render({});
    fillValidDraft(view);
    typeIn(view, 'field-minutes', '900');

    press(view.must('meal-form-save'));

    expect(fieldText(view, 'field-minutes')).toContain(M.minutesRange);
    expect(view.stored()).toHaveLength(0);
  });

  it('refuses a meal with no steps, which FR-013 omits and mealSchema requires', async () => {
    const view = await render({});
    fillValidDraft(view);
    press(view.must('remove-instruction-0'));

    press(view.must('meal-form-save'));

    expect(view.must('error-instructions').textContent).toContain(M.instructionsRequired);
    expect(view.stored()).toHaveLength(0);
  });

  it('refuses a time of day and a diet tag that were never chosen', async () => {
    const view = await render({});
    typeIn(view, 'field-name', 'Overnight oats');

    press(view.must('meal-form-save'));

    expect(view.must('error-mealPeriods').textContent).toContain(M.mealPeriodsRequired);
    expect(view.must('error-dietTags').textContent).toContain(M.dietTagsRequired);
  });

  it('refuses three-of-four nutrition figures on each blank figure, and takes all four', async () => {
    /**
     * FR-006's all-or-nothing rule, which `mealSchema.superRefine` also enforces. A meal whose
     * nutrition is three-quarters known is a meal whose nutrition is unknown — and the error has
     * to land on the box the user still has to fill, not on the three they already did.
     */
    const view = await render({});
    fillValidDraft(view);
    typeIn(view, 'field-calories', '320');
    typeIn(view, 'field-protein', '12');
    typeIn(view, 'field-carbs', '48');

    press(view.must('meal-form-save'));

    expect(fieldText(view, 'field-fat')).toContain(M.nutritionIncomplete);
    expect(fieldText(view, 'field-calories')).not.toContain(M.nutritionIncomplete);
    expect(view.stored()).toHaveLength(0);

    typeIn(view, 'field-fat', '9');
    typeIn(view, 'field-servings', '2');
    press(view.must('meal-form-save'));
    await view.settle();

    const stored = view.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.nutrition).toEqual({
      calories: 320,
      proteinGrams: 12,
      carbsGrams: 48,
      fatGrams: 9,
    });
    expect(stored[0]?.nutritionProvenance.servings).toBe(2);
  });

  it('says nothing mid-keystroke, complains on blur, and forgives on the next keystroke', async () => {
    // S-43, which P14 recorded: a half-typed value is not a wrong value, it is an unfinished one.
    const view = await render({});
    const price = inputIn(view.must('field-price'));

    act(() => {
      fireEvent.change(price, { target: { value: '4.' } });
    });
    expect(view.text()).not.toContain(M.priceFormat);

    blurField(price);
    expect(fieldText(view, 'field-price')).toContain(M.priceFormat);

    act(() => {
      fireEvent.change(price, { target: { value: '4.5' } });
    });
    expect(view.text()).not.toContain(M.priceFormat);
  });

  it('announces each error as an alert and labels every field it renders', async () => {
    const view = await render({});
    const name = inputIn(view.must('field-name'));
    blurField(name);

    expect(getByRole(view.must('field-name'), 'alert')).toBeTruthy();
    // The error is part of the field's accessible NAME too, which is what iOS and Android read.
    expect(name.getAttribute('aria-label') ?? '').toContain(M.nameRequired);

    // Every input on the screen is labelled — a sweep, because one unlabelled box in a form this
    // long is a box a screen-reader user cannot identify.
    const inputs = Array.from(view.must('meal-form-screen').querySelectorAll('input, textarea'));
    expect(inputs.length).toBeGreaterThan(10);
    for (const input of inputs) {
      expect(input.getAttribute('aria-label') ?? '').not.toBe('');
    }
  });
});

describe('MealFormScreen — a key that cannot be written (entryStatus unavailable)', () => {
  /**
   * **The CRITICAL this group exists for.** `unavailable` means the read failed, so `createStore`
   * refuses to write over bytes it could not read (TSD §6.3) — and it refuses *silently*:
   * `saveError` stays null and `saveBlocked` stays false, because no write is ever attempted. The
   * reducer still accepts the record, so `hasCustomMeal` still finds it: every signal the
   * confirmation can see says the save worked, and the meal is gone at the next launch.
   *
   * `failOn.add('multiGet')` rather than `getItem`: boot hydration is one `multiGet`
   * (`hydrate.ts:107`) and a failure there is what marks every key `unavailable` in the snapshot
   * `createStore` reads. `getItem` drives `repository.get`, which is not on this lane.
   */
  function unreadable(): MemoryDriver {
    const driver = memoryDriver({});
    driver.failOn.add('multiGet');
    return driver;
  }

  it('says so before anything is typed', async () => {
    const view = await render({ driver: unreadable() });

    expect(view.find('meal-form-unavailable')).not.toBeNull();
    expect(view.text()).toContain('cannot be saved right now');
  });

  it('refuses the save, does not close, and never claims it worked', async () => {
    const view = await render({ driver: unreadable() });
    fillValidDraft(view);

    press(view.must('meal-form-save'));
    await view.settle();

    // The form is still here with the draft intact, and the message names the real cause.
    expect(view.find('meal-form-unstorable')).not.toBeNull();
    expect(view.must('meal-form-unstorable').textContent).toContain('could not be read');
    expect(inputIn(view.must('field-name')).getAttribute('value')).toBe('Overnight oats');
    expect(view.goBacks()).toBe(0);
    expect(view.navigations()).toHaveLength(0);
    // Nothing was written, and nothing was even attempted: the guard is before the dispatch.
    expect(view.driver.calls.some((call) => call.startsWith('setItem'))).toBe(false);
    // And the two success-shaped surfaces stayed away.
    expect(view.find('meal-form-save-failed')).toBeNull();
  });

  it('renders not-found for an edit link, which is why the delete guard cannot fire', async () => {
    /**
     * The other half of the same state, and the reason `unstorable`'s delete branch is
     * unreachable through the UI: a key that could not be read yields the fallback `[]`, so there
     * is no record to open in edit mode in the first place. The guard stays in `onDelete` because
     * the rule is the same either way; this test is what documents why no test can reach it.
     */
    const view = await render({ mealId: 'house-omelette', driver: unreadable() });

    expect(view.find('meal-form-not-found')).not.toBeNull();
    expect(view.find('meal-form-delete')).toBeNull();
  });
});

describe('MealFormScreen — the allergen conflict (FR-004, TSD §4.4)', () => {
  /** Declared `peanut`, and the conflict findable ONLY by inference from this name. */
  const PEANUT_INGREDIENT = 'Peanut butter';

  it('has a fixture the domain finds by ingredient name alone, with no tag to intersect', () => {
    /**
     * Without this precondition the conflict test below would stay green for a screen that merely
     * intersected `allergenTags` with the user's list — the mutation `MealDetailsBody` measured at
     * 24 of 25 tests still passing. With no tag ticked, only the domain's inference can find it.
     */
    expect(
      conflictingAllergens({ allergenTags: [], ingredients: [{ name: PEANUT_INGREDIENT }] }, [
        'peanut',
      ]),
    ).toStrictEqual(['peanut']);
  });

  it('names the conflict for a declared allergy the draft only implies', async () => {
    const view = await render({ allergies: ['peanut'] });
    typeIn(view, 'field-name', 'Satay sauce');
    typeIn(view, 'field-ingredient-0-name', PEANUT_INGREDIENT);

    const notice = view.must('meal-form-allergen-conflict');
    // Named in TEXT, not carried by colour (PRD §10.5), and announced when it appears.
    expect(notice.textContent ?? '').toContain('peanut');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    // No allergen chip was ticked: this came from the ingredient name through the domain.
    expect(view.must('chip-allergen-peanut').getAttribute('aria-checked')).toBe('false');
  });

  it('shows no conflict for a clean draft, even with the allergy declared', async () => {
    // Half the negative control. Without it, a notice rendered unconditionally would pass the
    // test above. One harness per test, deliberately — see `find`'s note.
    const view = await render({ allergies: ['peanut'] });
    typeIn(view, 'field-ingredient-0-name', 'Rolled oats');

    expect(view.find('meal-form-allergen-conflict')).toBeNull();
  });

  it('shows no conflict for a peanut draft when no allergy is declared', async () => {
    // The other half: the notice is about THIS user, not about the meal.
    const view = await render({});
    typeIn(view, 'field-ingredient-0-name', PEANUT_INGREDIENT);

    expect(view.find('meal-form-allergen-conflict')).toBeNull();
  });

  it('does not promise filtering the app cannot do', async () => {
    /**
     * The caption is the sentence a user relies on, so its claim is pinned. Custom meals are not
     * in the recommendation set — the server serves the catalog — so "used to keep this meal away
     * from anyone with that allergy" promised a filter that never runs.
     */
    const view = await render({});

    expect(view.text()).not.toContain('keep this meal away');
    expect(view.text()).toContain('do not filter your suggestions');
  });
});

describe('MealFormScreen — the refusal a screen reader can hear (V7)', () => {
  it('summarises the refusal in one announced message, not fourteen silent alerts', async () => {
    const view = await render({});

    press(view.must('meal-form-save'));

    const summary = view.must('meal-form-invalid');
    expect(summary.getAttribute('aria-live')).toBe('polite');
    expect(summary.textContent ?? '').toContain('fields need attention');
    // The fields still carry their own errors; the summary is the lede, not a replacement.
    expect(fieldText(view, 'field-name')).toContain(M.nameRequired);
  });

  it('announces again on a second press, instead of sitting there already mounted', async () => {
    /**
     * `StatusMessage` announces from a mount effect (`AccessibilityInfo.announceForAccessibility`
     * on iOS), so an unchanged, already-mounted message says nothing the second time — which is
     * the dead button again for anyone who pressed Save twice. The `key` is what remounts it, and
     * a new DOM node is how that is observable from here.
     */
    const view = await render({});

    press(view.must('meal-form-save'));
    const first = view.must('meal-form-invalid');
    press(view.must('meal-form-save'));
    const second = view.must('meal-form-invalid');

    expect(second).not.toBe(first);
  });
});

describe('MealFormScreen — leaving (V13)', () => {
  it('goes to the Saved tab when there is nothing beneath it', async () => {
    // `MealForm` is deep-linkable, so it can be first in the stack — and `goBack()` is then a
    // no-op that leaves the user on a form they have already saved.
    const view = await render({ canGoBack: false });
    fillValidDraft(view);

    press(view.must('meal-form-save'));
    await view.settle();

    expect(view.stored()).toHaveLength(1);
    expect(view.goBacks()).toBe(0);
    expect(view.navigations()).toStrictEqual([{ route: 'Tabs', params: { screen: 'SavedTab' } }]);
  });
});

describe('MealFormScreen — a create the store refuses (CONTRACTS §2)', () => {
  it('keeps the form open and says so when the id cannot be made unique', async () => {
    /**
     * The reachable refused-create path, and the one that proves the press is never treated as
     * success. `generateMealId` is pinned to an id the store already holds, so
     * `composeCustomMeal`'s five attempts against the REAL `existingIds` all collide and it
     * refuses before anything is dispatched.
     *
     * Had the screen passed `existingIds: []`, compose would have succeeded, the reducer would
     * have refused the duplicate by returning `state` identically — no error, no failed dispatch —
     * and a form that closed on the press would have told the user their meal was saved when it
     * was not. That is the P14 shape, and both halves are probed in the report.
     */
    vi.stubGlobal('crypto', { randomUUID: () => FIXED_ID });
    const view = await render({ meals: [customMeal({ id: FIXED_ID })] });
    fillValidDraft(view);

    press(view.must('meal-form-save'));
    await view.settle();

    // The form is still here, the message is on it, and the user's typing is intact.
    expect(view.find('meal-form-screen')).not.toBeNull();
    expect(view.goBacks()).toBe(0);
    expect(fieldText(view, 'field-name')).toContain(M.idCollision);
    expect(inputIn(view.must('field-name')).getAttribute('value')).toBe('Overnight oats');
    // And the record that was already there is untouched — no second entry, no overwrite.
    const stored = view.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('House omelette');
    /**
     * **The guard blocked the path, so the backstop never had to.** `meal-form-save-failed` is the
     * confirmation's surface for a refusal that gets past the pre-dispatch guards; its absence
     * here is what proves the collision was caught *before* anything was dispatched, rather than
     * after by the thing that exists in case it is not. Asserted rather than commented, so the
     * claim fails if `existingIds` ever stops being the store's real list.
     */
    expect(view.find('meal-form-save-failed')).toBeNull();
  });
});

describe('MealFormScreen — edit (T-17-04)', () => {
  it('preloads the stored record rather than opening blank', async () => {
    const view = await render({ mealId: 'house-omelette', meals: [customMeal()] });

    expect(view.text()).toContain('Edit meal');
    expect(inputIn(view.must('field-name')).getAttribute('value')).toBe('House omelette');
    // Minor units are derived, never typed: the round trip is exact.
    expect(inputIn(view.must('field-price')).getAttribute('value')).toBe('4.50');
    expect(inputIn(view.must('field-minutes')).getAttribute('value')).toBe('10');
    expect(inputIn(view.must('field-ingredient-0-name')).getAttribute('value')).toBe('Egg');
    expect(view.must('chip-diet-vegetarian').getAttribute('aria-checked')).toBe('true');
    expect(view.must('chip-allergen-egg').getAttribute('aria-checked')).toBe('true');
    expect(view.find('meal-form-delete')).not.toBeNull();
  });

  it('replaces the record in place, keeping createdAt and moving updatedAt', async () => {
    const view = await render({
      mealId: 'house-omelette',
      meals: [customMeal(), customMeal({ id: 'second', name: 'Second meal' })],
    });

    typeIn(view, 'field-name', 'House omelette, improved');
    clockValue = LATER;
    press(view.must('meal-form-save'));
    await view.settle();

    const stored = view.stored();
    // Two records, in the user's order — an update is not an insert and never re-sorts.
    expect(stored.map((meal) => meal.id)).toEqual(['house-omelette', 'second']);
    expect(stored[0]?.name).toBe('House omelette, improved');
    expect(stored[0]?.createdAt).toBe(FIRST);
    expect(stored[0]?.updatedAt).toBe(LATER);
    expect(view.goBacks()).toBe(1);
  });

  it('renders not-found for a mealId the store does not have', async () => {
    // A stale deep link, or a record deleted elsewhere. An empty create form wearing an edit
    // title would invite the user to retype a meal they may still have.
    const view = await render({ mealId: 'no-such-meal', meals: [customMeal()] });

    expect(view.find('meal-form-not-found')).not.toBeNull();
    expect(view.text()).toContain('That meal is not here');
    expect(view.text()).not.toContain('Edit meal');
    expect(view.find('field-name')).toBeNull();
    expect(view.find('meal-form-save')).toBeNull();
    // And it did not quietly delete anything on the way.
    expect(view.stored()).toHaveLength(1);
  });
});

describe('MealFormScreen — delete behind its confirmation (T-17-06)', () => {
  it('deletes on confirmation, and the shorter list is what reaches the device', async () => {
    const view = await render({
      mealId: 'house-omelette',
      meals: [customMeal(), customMeal({ id: 'second', name: 'Second meal' })],
    });

    // Nothing has happened yet: the sheet is not open and both meals are there.
    expect(view.find('meal-form-delete-sheet')).toBeNull();
    press(view.must('meal-form-delete'));
    expect(view.find('meal-form-delete-sheet')).not.toBeNull();

    press(view.must('meal-form-delete-confirm'));
    await view.settle();

    // The projection, not the store: T-17-06's acceptance is "stays deleted after restart", and
    // this is the half a dom test can prove — the shorter list is on the device.
    expect(view.stored().map((meal) => meal.id)).toEqual(['second']);
    expect(view.goBacks()).toBe(1);
    /**
     * The delete confirmation's own unreachability assertion, the pair of the create one: a
     * `deleted` for a present id cannot be refused — the reducer filters the array — so
     * `meal-form-delete-failed` must never appear on a delete that was dispatched. If the reducer
     * ever stops removing what it was asked to, this line is what says so.
     */
    expect(view.find('meal-form-delete-failed')).toBeNull();
  });

  it('leaves the meal provably present when the confirmation is cancelled', async () => {
    /**
     * The path a confirmation exists for. Asserted on the MEAL rather than on the closed sheet: a
     * sheet that closes while the delete has already been dispatched looks exactly like a cancel
     * and is a deletion the user refused.
     */
    const view = await render({ mealId: 'house-omelette', meals: [customMeal()] });

    press(view.must('meal-form-delete'));
    press(view.must('meal-form-delete-cancel'));
    await view.settle();

    expect(view.stored().map((meal) => meal.id)).toEqual(['house-omelette']);
    // Still editable, still named, still not navigated away from.
    expect(inputIn(view.must('field-name')).getAttribute('value')).toBe('House omelette');
    expect(view.find('meal-form-not-found')).toBeNull();
    expect(view.goBacks()).toBe(0);
  });
});

describe('MealFormScreen — the 200 bound (T-17-07, TSD §6.4)', () => {
  /** A full list, built rather than hoped for: the bound is only testable at the bound. */
  function fullList(): readonly CustomMeal[] {
    return Array.from({ length: STORAGE_BOUNDS.customMeals }, (_unused, index) =>
      customMeal({ id: `meal-${String(index)}`, name: `Meal ${String(index)}` }),
    );
  }

  it('refuses a create with a clear message and no retry, and writes nothing', async () => {
    const view = await render({ meals: fullList() });

    const notice = view.must('meal-form-bound');
    expect(notice.textContent).toContain('full');
    expect(notice.textContent).toContain('Delete one to make room');
    // The bound is named from STORAGE_BOUNDS, so a retyped literal in the copy would fail here.
    expect(notice.textContent).toContain(String(STORAGE_BOUNDS.customMeals));
    /**
     * **"No retry" asserted as the absence of a control, not of a word** — `MealDetails`'
     * stronger form. Text can be reworded while a button stays, and a button is the thing that
     * would be dead: `StatusMessage` renders its action as `role="button"`.
     */
    expect(queryAllByRole(notice, 'button')).toHaveLength(0);

    fillValidDraft(view);
    press(view.must('meal-form-save'));
    await view.settle();

    // Still 200, and the 201st is nowhere.
    const stored = view.stored();
    expect(stored).toHaveLength(STORAGE_BOUNDS.customMeals);
    expect(stored.some((meal) => meal.name === 'Overnight oats')).toBe(false);
    expect(view.goBacks()).toBe(0);
    /**
     * And the user read the RIGHT explanation. This is what the pre-dispatch bound check buys:
     * without it the create reaches a reducer that refuses it silently, the confirmation catches
     * that, and the message becomes "this meal was not saved" — true, but no help at all.
     */
    expect(view.find('meal-form-save-failed')).toBeNull();
  });

  it('still saves an edit at the bound, because an edit stores no additional record', async () => {
    // A naive bound check blocks this, stranding a user with 200 meals and no way to fix one.
    const view = await render({ mealId: 'meal-7', meals: fullList() });

    typeIn(view, 'field-name', 'Meal seven, corrected');
    clockValue = LATER;
    press(view.must('meal-form-save'));
    await view.settle();

    const stored = view.stored();
    expect(stored).toHaveLength(STORAGE_BOUNDS.customMeals);
    expect(stored[7]?.name).toBe('Meal seven, corrected');
    expect(stored[7]?.updatedAt).toBe(LATER);
    expect(view.find('meal-form-bound')).toBeNull();
    expect(view.goBacks()).toBe(1);
  });

  it('still deletes at the bound, which is the only way back under it', async () => {
    // The bound has no bearing on a delete, and this is the action a user at 200 has to be able to
    // take — the bound notice tells them to take it.
    const view = await render({ mealId: 'meal-3', meals: fullList() });

    press(view.must('meal-form-delete'));
    press(view.must('meal-form-delete-confirm'));
    await view.settle();

    const stored = view.stored();
    expect(stored).toHaveLength(STORAGE_BOUNDS.customMeals - 1);
    expect(stored.some((meal) => meal.id === 'meal-3')).toBe(false);
    expect(view.goBacks()).toBe(1);
  });
});
