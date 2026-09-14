import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { queryAllByRole } from '@testing-library/dom';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { conflictingAllergens, effectiveAllergenTags, formatMoney } from '@nutritime/domain';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { ApiProvider } from '../../infrastructure/api/ApiProvider.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { NUTRITION_UNAVAILABLE } from '../../shared/components/index.js';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import { callsOf, memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import { MAX_FAVORITES, favoritesStore } from '../../state/favorites/index.js';
import { preferencesActions, preferencesStore } from '../../state/preferences/index.js';
import { MealDetailsScreen } from './MealDetailsScreen.js';

/**
 * `MealDetailsScreen` — T-16-02 … T-16-07.
 *
 * **The allergen assertions are why this file exists, and they are built rather than hoped for.**
 * Plan §6.1's finding was that three of four earlier safety assertions could not fail, because they
 * were written against 60 records the phase did not choose. So:
 *
 *  - the conflicting meal is the REAL `pad-see-ew`, and a control asserts up front that it carries
 *    peanut — if the catalog changes, this file fails loudly rather than quietly passing;
 *  - a second fixture strips its declared `allergenTags` entirely, so only the domain's inference
 *    from `peanut oil` can find the conflict. A screen that intersected `meal.allergenTags` with
 *    the user's allergies would pass every other test in this file and fail that one;
 *  - the negative control is the SAME mounted tree with the allergy withdrawn, not a different
 *    render, so the notice is proved to follow the preferences store rather than the meal.
 *
 * **Ingredients and instructions are counted as well as read**, which R-45 forbids for a
 * `FlatList` and permits here: this screen renders them into a plain `View`, so there is no
 * `initialNumToRender` budget for a count to be measuring instead of the data.
 */

const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((record) =>
  mealSchema.parse(record),
);

function record(id: string): Meal {
  const found = CATALOG.find((meal) => meal.id === id);
  if (found === undefined) {
    throw new Error(`the seeded catalog has no record ${id}`);
  }
  return found;
}

/** Declared `peanut`, and `peanut oil` in the ingredient list — probed against `meals.json`. */
const PEANUT_MEAL = record('pad-see-ew');

/**
 * The same real record with its declared tags removed.
 *
 * The one fixture in this file, and it exists to make exactly one claim falsifiable: with no tag
 * to intersect, only `conflictingAllergens`' inference from the ingredient names can find the
 * peanut. A different id, because two records sharing one id is a state the app never has.
 */
const INFERRED_PEANUT_MEAL: Meal = {
  ...PEANUT_MEAL,
  id: 'peanut-by-ingredient',
  allergenTags: [],
};

/** A record with no peanut by either measure, for the "no notice" half of the control. */
const CLEAN_MEAL: Meal =
  CATALOG.find((meal) => !effectiveAllergenTags(meal).has('peanut')) ?? PEANUT_MEAL;

const CLOCK = (): string => '2026-09-13T12:00:00.000Z';

function notFoundError(): ApiClientError {
  // Assembled with the wire status rather than hand-waved: `useMealDetails` keys `notFound` on the
  // HTTP status, so a test that carried any other status would be asserting a different branch.
  return new ApiClientError({
    kind: 'server',
    status: 404,
    code: 'meal_not_found',
    retryable: false,
    wire: null,
    route: 'getMeal',
  });
}

/**
 * `count` distinct ids `favoriteIdsSchema` accepts, with `seed` first.
 *
 * Parameterised on the count because three different lengths carry three different meanings here:
 * `MAX_FAVORITES` is the bound, `MAX_FAVORITES + 1` is the over-long entry a read TRUNCATES, and a
 * seeded first element is how this meal gets to be already-favourited at the bound.
 */
function favoriteIds(count: number, seed: readonly string[] = []): readonly string[] {
  const ids: string[] = [...seed];
  for (let index = ids.length; index < count; index += 1) {
    ids.push(`filler-${String(index)}`);
  }
  return ids;
}

function storedEnvelope(value: unknown): string {
  return encodeEnvelope(STORAGE_SCHEMA_VERSION, value, CLOCK());
}

interface RenderOptions {
  /** Answers `getMeal`. Defaults to resolving `PEANUT_MEAL`. */
  readonly meal?: Meal;
  readonly failWith?: unknown;
  /** A promise that never settles, for the loading assertion. */
  readonly pending?: boolean;
  readonly params?: unknown;
  readonly allergies?: readonly string[];
  readonly favorites?: readonly string[];
  /** Raw bytes for the favourites key, for the corrupt-entry case. */
  readonly rawFavorites?: string;
  /** Bytes `userPreferencesSchema` rejects, so the entry is quarantined: `entryStatus` `recovered`. */
  readonly corruptPreferences?: boolean;
  /** `multiGet` refuses, so every key reads `unavailable` — `hydrate.ts` says so at the site. */
  readonly driverBlind?: boolean;
  /** Every write refuses, which is how `saveError` is reached without a bound. */
  readonly failWrites?: boolean;
  readonly canGoBack?: boolean;
}

interface NavigationCall {
  readonly name: string;
  readonly params: unknown;
}

interface Harness {
  readonly host: HTMLElement;
  readonly requests: string[];
  readonly navigated: NavigationCall[];
  readonly backs: number[];
  find(testID: string): HTMLElement | null;
  at(testID: string): HTMLElement;
  text(): string;
  label(testID: string): string;
  storedFavorites(): readonly string[];
  /** How many times a write of the favourites key was ATTEMPTED, refused ones included. */
  favoriteWriteAttempts(): number;
  press(testID: string): Promise<void>;
  pressButtonIn(testID: string): Promise<void>;
  setAllergies(allergies: readonly string[]): Promise<void>;
  settle(): Promise<void>;
}

async function render(options: RenderOptions = {}): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const answer = options.meal ?? PEANUT_MEAL;
  const requests: string[] = [];
  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: (mealId) => {
      requests.push(mealId);
      if (options.pending === true) {
        return new Promise<Meal>(() => undefined);
      }
      return options.failWith === undefined
        ? Promise.resolve(answer)
        : Promise.reject(options.failWith);
    },
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };

  const navigated: NavigationCall[] = [];
  const backs: number[] = [];
  const navigation = {
    navigate: (name: string, params: unknown) => {
      navigated.push({ name, params });
    },
    goBack: () => {
      backs.push(1);
    },
    canGoBack: () => options.canGoBack ?? true,
  };

  const stored: Record<string, string> = {};
  if (options.corruptPreferences === true) {
    // A real quarantine, not a stubbed status: `userPreferencesSchema` rejects this, so
    // `classifyEntry` returns `schema-invalid` and `readEntry` answers with the fallback —
    // `DEFAULT_PREFERENCES`, whose `allergies` is `[]`. That erasure is the defect under test.
    stored[STORAGE_KEYS.preferences] = storedEnvelope({ diet: 'not-a-diet' });
  } else if (options.allergies !== undefined) {
    stored[STORAGE_KEYS.preferences] = storedEnvelope({
      ...DEFAULT_PREFERENCES,
      allergies: options.allergies,
    });
  }
  if (options.rawFavorites !== undefined) {
    stored[STORAGE_KEYS.favorites] = options.rawFavorites;
  } else if (options.favorites !== undefined) {
    stored[STORAGE_KEYS.favorites] = storedEnvelope(options.favorites);
  }

  // Hoisted, so the runtime object is stable: a fresh one would re-run `StorageProvider`'s effect
  // and rebuild every store, which would make a re-render look like a remount.
  const runtime = { driver: memoryDriver(stored), now: CLOCK };
  if (options.driverBlind === true) {
    runtime.driver.failOn.add('multiGet');
  }
  if (options.failWrites === true) {
    runtime.driver.failOn.add('setItem');
  }

  let dispatchRef: ((action: never) => void) | null = null;
  function Capture(): ReactNode {
    dispatchRef = preferencesStore.useDispatch() as (action: never) => void;
    return null;
  }

  const root = createRoot(host);
  await act(async () => {
    root.render(
      <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
        <ApiProvider client={client}>
          <StorageProvider runtime={runtime}>
            <preferencesStore.Provider>
              <favoritesStore.Provider>
                <Capture />
                <MealDetailsScreen
                  route={
                    {
                      key: 'details',
                      name: 'MealDetails',
                      params: options.params ?? { mealId: answer.id },
                    } as never
                  }
                  navigation={navigation as never}
                />
              </favoritesStore.Provider>
            </preferencesStore.Provider>
          </StorageProvider>
        </ApiProvider>
      </ThemeProvider>,
    );
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await settle();

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  const at = (testID: string): HTMLElement => {
    const found = find(testID);
    if (found === null) {
      throw new Error(`no element rendered for testID ${testID}`);
    }
    return found;
  };

  return {
    host,
    requests,
    navigated,
    backs,
    find,
    at,
    text: () => host.textContent ?? '',
    label: (testID) => at(testID).getAttribute('aria-label') ?? '',
    storedFavorites: () => {
      const raw = runtime.driver.store.get(STORAGE_KEYS.favorites);
      if (raw === undefined) {
        return [];
      }
      const parsed: unknown = JSON.parse(raw);
      const value =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { readonly value?: unknown }).value
          : undefined;
      return Array.isArray(value) ? (value as readonly string[]) : [];
    },
    favoriteWriteAttempts: () =>
      callsOf(runtime.driver, 'setItem').filter((key) => key === STORAGE_KEYS.favorites).length,
    press: async (testID) => {
      await act(async () => {
        at(testID).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },
    pressButtonIn: async (testID) => {
      const button = queryAllByRole(at(testID), 'button')[0];
      if (button === undefined) {
        throw new Error(`no button inside ${testID}`);
      }
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await settle();
    },
    setAllergies: async (allergies) => {
      await act(async () => {
        dispatchRef?.(preferencesActions.changeAllergies(allergies) as never);
      });
      await settle();
    },
    settle,
  };
}

describe('MealDetailsScreen — the allergen notice (FR-011, the safety surface)', () => {
  it('has a real catalog record carrying peanut, or every assertion below is vacuous', () => {
    // The control Plan §6.1 demands. Both measures, because the screen calls the domain and the
    // domain unions the declared tags with what the ingredients betray.
    expect(PEANUT_MEAL.allergenTags).toContain('peanut');
    expect(PEANUT_MEAL.ingredients.map((item) => item.name)).toContain('peanut oil');
    expect(conflictingAllergens(PEANUT_MEAL, ['peanut'])).toStrictEqual(['peanut']);

    // And the inference fixture is genuinely tag-free, so the claim it makes is the one intended.
    expect(INFERRED_PEANUT_MEAL.allergenTags).toStrictEqual([]);
    expect(conflictingAllergens(INFERRED_PEANUT_MEAL, ['peanut'])).toStrictEqual(['peanut']);

    // The clean record must be genuinely clean, or the negative control proves nothing.
    expect([...effectiveAllergenTags(CLEAN_MEAL)]).not.toContain('peanut');
  });

  it('NAMES the conflicting allergen to a user who declared it', async () => {
    const view = await render({ meal: PEANUT_MEAL, allergies: ['peanut'] });

    const notice = view.at('meal-details-allergen-conflict');
    // Named, not merely present: "contains allergens" is a sentence the user cannot act on.
    expect(notice.textContent ?? '').toContain('peanut');
    expect(notice.textContent ?? '').toContain('Contains peanut');
    expect(notice.textContent ?? '').toContain('check the label');
  });

  it('finds a conflict the meal does not declare, through the ingredient list', async () => {
    /**
     * **The assertion that proves the domain is being called rather than re-implemented.**
     *
     * This record has `allergenTags: []`. A screen doing its own matching — the obvious
     * `meal.allergenTags.filter((tag) => allergies.includes(tag))` — finds nothing here and shows
     * no notice, while passing the declared-tag test above.
     */
    const view = await render({ meal: INFERRED_PEANUT_MEAL, allergies: ['peanut'] });

    expect(view.at('meal-details-allergen-conflict').textContent ?? '').toContain('peanut');
    // And the tags section honestly says there are none recorded, without claiming safety.
    expect(view.at('meal-details-no-allergen-tags').textContent ?? '').toContain('not a guarantee');
  });

  it('shows NO conflict notice when the same meal meets no declared allergy', async () => {
    // The control, in ONE mounted tree: the allergy is added to the store that is already there,
    // so the notice is proved to follow the preferences store rather than the meal.
    const view = await render({ meal: PEANUT_MEAL, allergies: [] });
    expect(view.find('meal-details-allergen-conflict')).toBeNull();
    // **And no "cannot check your allergies" warning either.** This is the silence that is CORRECT
    // — a clean read of a list the user left empty — and the describe below renders the silence
    // that is not. Without this line the screen could satisfy both by warning always.
    expect(view.find('meal-details-allergies-unknown')).toBeNull();

    await view.setAllergies(['peanut']);
    expect(view.at('meal-details-allergen-conflict').textContent ?? '').toContain('peanut');

    // And back again: withdrawing the allergy withdraws the notice, which a notice keyed on the
    // meal alone would not do.
    await view.setAllergies([]);
    expect(view.find('meal-details-allergen-conflict')).toBeNull();
  });

  it('does not warn about a meal that carries the allergen by neither measure', async () => {
    const view = await render({ meal: CLEAN_MEAL, allergies: ['peanut'] });
    expect(view.find('meal-details-allergen-conflict')).toBeNull();
    expect(view.at('meal-details-name').textContent).toBe(CLEAN_MEAL.name);
  });

  it('puts the notice above the ingredients, not below the method', async () => {
    // The ORDER is the assertion. A warning a user reaches after four paragraphs of method has
    // not warned them, which is the same reasoning T-15-06 applies to Home's disclaimer.
    const view = await render({ meal: PEANUT_MEAL, allergies: ['peanut'] });
    const notice = view.at('meal-details-allergen-conflict');
    const ingredients = view.at('meal-details-ingredients');

    expect(notice.compareDocumentPosition(ingredients) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  it('carries the notice in words and a glyph, never in colour alone', async () => {
    // PRD §10.5. `StatusMessage` requires an icon, so the tone has a shape as well as a tint, and
    // the title names the allergen in words.
    const view = await render({ meal: PEANUT_MEAL, allergies: ['peanut'] });
    const notice = view.at('meal-details-allergen-conflict');

    expect([...notice.querySelectorAll('[data-icon-name]')].length).toBeGreaterThan(0);
    expect(notice.getAttribute('aria-live')).toBe('polite');
  });
});

describe('MealDetailsScreen — when the allergy list itself is not trustworthy', () => {
  /**
   * **The defect these four tests were written for, stated as the user experiences it.**
   *
   * A quarantined `preferences` entry returns `DEFAULT_PREFERENCES`, whose `allergies` is `[]`. So
   * `conflictingAllergens(meal, [])` returns nothing and the conflict notice does not render — on
   * the one screen where a conflicting meal is reachable by design, the only safety control goes
   * quiet and says nothing about having gone quiet. The screen previously could not tell "this user
   * declared no allergies" from "this user's allergy list was erased", and the control test above
   * rendered the second while asserting the first.
   */
  it('WARNS that it cannot check allergies when the stored preferences were reset', async () => {
    const view = await render({ meal: PEANUT_MEAL, corruptPreferences: true });

    const warning = view.at('meal-details-allergies-unknown');
    expect(warning.textContent ?? '').toContain('cannot check your allergies');
    expect(warning.textContent ?? '').toContain('reset');
    // What to do next, which PRD §12 requires and which is the only useful instruction here.
    expect(warning.textContent ?? '').toContain('Set it again');
    // And what still works: the meal's own tags are unaffected and are the thing to read instead.
    expect(view.at('meal-details-allergies-unknown-still-available').textContent ?? '').toContain(
      'allergen tags below',
    );

    // The conflict notice is still absent — the screen cannot conjure an allergy it does not
    // have — which is exactly why the warning has to exist.
    expect(view.find('meal-details-allergen-conflict')).toBeNull();
    // Announced, because it appears after the screen does: the meal is fetched.
    expect(warning.getAttribute('aria-live')).toBe('polite');
  });

  it('puts that warning above the ingredients too', async () => {
    const view = await render({ meal: PEANUT_MEAL, corruptPreferences: true });
    const warning = view.at('meal-details-allergies-unknown');
    const ingredients = view.at('meal-details-ingredients');

    expect(
      warning.compareDocumentPosition(ingredients) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('says nothing has been overwritten when the list could not be read at all', async () => {
    /**
     * `unavailable`, not `recovered`: the driver refused, so what is on disk is unknown and the
     * store will not write over it (TSD §6.3). The two need different copy — one list is gone, the
     * other may be perfectly good — and telling an `unavailable` user to set their allergies again
     * would invite them to overwrite a profile that is still there.
     */
    const view = await render({ meal: PEANUT_MEAL, driverBlind: true });

    const warning = view.at('meal-details-allergies-unknown');
    expect(warning.textContent ?? '').toContain('could not be read');
    expect(warning.textContent ?? '').toContain('Nothing saved has been overwritten');
    expect(warning.textContent ?? '').not.toContain('Set it again');
  });

  it('withdraws the warning and warns about the MEAL once the allergy is set again', async () => {
    // The transition, in one mounted tree: the warning is gated on the list actually being empty,
    // so re-declaring the allergy replaces "cannot check" with the real conflict notice.
    const view = await render({ meal: PEANUT_MEAL, corruptPreferences: true });
    expect(view.find('meal-details-allergies-unknown')).not.toBeNull();
    expect(view.find('meal-details-allergen-conflict')).toBeNull();

    await view.setAllergies(['peanut']);

    expect(view.find('meal-details-allergies-unknown')).toBeNull();
    expect(view.at('meal-details-allergen-conflict').textContent ?? '').toContain(
      'Contains peanut',
    );
  });
});

describe('MealDetailsScreen — the two meanings of `recovered`, and a failed write', () => {
  it('says the favourites list was SHORTENED, not emptied, when the entry overflowed', async () => {
    /**
     * **The copy contradicted the screen.** `EntryStatus` carries one value, `recovered`, for two
     * outcomes: a quarantine, which returns the empty fallback, and an over-long entry TRUNCATED on
     * read (TSD §6.4 — reads truncate, they never refuse). A user whose list was truncated was told
     * it "could not be read, so it was emptied" while 200 favourites rendered below.
     *
     * Driven by a genuinely over-long stored entry, so the status comes from `boundedTo` rather
     * than from a test asserting it.
     */
    const view = await render({ meal: CLEAN_MEAL, favorites: favoriteIds(MAX_FAVORITES + 1) });

    const notice = view.at('meal-details-favorites-recovered').textContent ?? '';
    expect(notice).toContain('shortened');
    expect(notice).toContain(String(MAX_FAVORITES));
    // The wording the other outcome gets, and it must not appear here.
    expect(notice).not.toContain('was emptied');
    expect(notice).not.toContain('were reset');

    // The truncation really is unrecoverable by the time this is read: the mount projection has
    // already written the shorter list back.
    expect(view.storedFavorites()).toHaveLength(MAX_FAVORITES);
    // And the list is genuinely non-empty, which is what makes the wording true.
    expect(view.storedFavorites()[0]).toBe('filler-0');
  });

  it('reports a favourite that could not be saved, and its retry tries the write again', async () => {
    /**
     * The reachable half of the store's save state. `saveBlocked` is not reachable from any screen
     * any more — the reducers refuse at the bound, so `repository.set` is never handed an over-long
     * value — so this surface is driven by a driver that refuses every write, which is the failure
     * that remains and the one a retry can genuinely fix.
     */
    const view = await render({ meal: CLEAN_MEAL, failWrites: true });

    await view.press('meal-details-favorite');

    const error = view.at('meal-details-favorites-save-error');
    expect(error.textContent ?? '').toContain('not saved');
    // The repository's fixed local copy, never a driver string (PRD §15.5).
    expect(error.textContent ?? '').toContain('could not be saved');
    expect(view.text()).not.toContain('driver refused');
    // NOT the full-list surface: the two are mutually exclusive by construction.
    expect(view.find('meal-details-favorites-full')).toBeNull();

    const before = view.favoriteWriteAttempts();
    expect(before).toBeGreaterThan(0);
    await view.pressButtonIn('meal-details-favorites-save-error');
    // A retry that re-attempts the write. A button wired to nothing would leave this equal.
    expect(view.favoriteWriteAttempts()).toBeGreaterThan(before);
  });
});

describe('MealDetailsScreen — FR-011 fields (T-16-02)', () => {
  it('renders all nine listed fields for a real catalog record', async () => {
    const meal = PEANUT_MEAL;
    const view = await render({ meal, allergies: ['peanut'] });

    // 1 — name.
    expect(view.at('meal-details-name').textContent).toBe(meal.name);
    // 2 — image, with the meal named on it for a screen reader.
    expect(meal.imageUrl).not.toBeNull();
    expect(view.label('meal-details-image')).toContain(meal.name);
    // 3 — ingredients, name AND measure, every row.
    const ingredients = view.at('meal-details-ingredients');
    meal.ingredients.forEach((item, index) => {
      const row = view.at(`meal-details-ingredients-${String(index)}`).textContent ?? '';
      expect(row, item.name).toContain(item.name);
      expect(row, item.measure).toContain(item.measure);
    });
    expect(ingredients.querySelectorAll('[data-testid^="meal-details-ingredients-"]').length).toBe(
      meal.ingredients.length,
    );
    // 4 — instructions, every step.
    meal.instructions.forEach((step, index) => {
      expect(view.at(`meal-details-instructions-${String(index)}`).textContent ?? '').toContain(
        step,
      );
    });
    // 5 — price, formatted by the domain so Explore and this screen cannot disagree.
    expect(view.at('meal-details-price').textContent).toBe(formatMoney(meal.price));
    // 6 — prep time.
    expect(view.at('meal-details-prep-time').textContent).toContain(
      String(meal.preparationMinutes),
    );
    // 7 — tags.
    const tags = view.at('meal-details-tags').textContent ?? '';
    for (const tag of meal.dietTags) {
      expect(tags, tag).toContain(tag);
    }
    // 8 — allergen notices: the meal's own tags, AND this user's conflict.
    const allergens = view.at('meal-details-allergen-tags').textContent ?? '';
    for (const tag of meal.allergenTags) {
      expect(allergens, tag).toContain(tag);
    }
    expect(view.find('meal-details-allergen-conflict')).not.toBeNull();
    // 9 — nutrition, through `NutritionPanel`.
    expect(view.find('meal-details-nutrition')).not.toBeNull();
    // Plus FR-011's attribution clause, through `SourceAttribution`.
    const sources = view.at('meal-details-sources').textContent ?? '';
    expect(meal.provenance.themealdbId).not.toBeNull();
    expect(sources).toContain(meal.provenance.themealdbId ?? 'unreachable');
  });

  it('renders unknown nutrition as "Not available", never 0 (FR-006)', async () => {
    // 53 of the 60 records carry all four `null`, so this is the common case rather than an edge.
    const unknown = CATALOG.find((meal) => meal.nutrition.calories === null);
    expect(unknown).toBeDefined();
    const view = await render({ meal: unknown ?? PEANUT_MEAL });

    const panel = view.at('meal-details-nutrition').textContent ?? '';
    expect(panel).toContain(NUTRITION_UNAVAILABLE);
    expect(panel).not.toContain('0 kcal');
  });

  it('says so rather than showing a broken box when a meal has no photograph', async () => {
    const view = await render({ meal: { ...CLEAN_MEAL, imageUrl: null } });
    expect(view.find('meal-details-image')).toBeNull();
    expect(view.at('meal-details-image-missing').textContent ?? '').toContain('No photograph');
  });
});

describe('MealDetailsScreen — states (T-16-06, PRD §12)', () => {
  it('renders a loading message while the request is in flight', async () => {
    const view = await render({ pending: true });
    expect(view.at('meal-details-loading').textContent ?? '').toContain('Loading');
    expect(view.find('meal-details-body')).toBeNull();
    expect(view.requests).toStrictEqual([PEANUT_MEAL.id]);
  });

  it('says the meal is gone for a 404, and offers no retry', async () => {
    /**
     * `notFound` is not an error and it is not local-only. There is nothing to retry — the same
     * request returns the same 404 — so the only affordance is the one that works.
     */
    const view = await render({ failWith: notFoundError(), canGoBack: true });
    const empty = view.at('meal-details-not-found');

    expect(empty.textContent ?? '').toContain('not in the catalog');
    expect(empty.textContent ?? '').toContain('nothing to retry');
    expect(view.find('meal-details-error')).toBeNull();
    expect(view.find('meal-details-offline')).toBeNull();
    // The one button is the way back, not a retry.
    const buttons = queryAllByRole(empty, 'button').map((node) => node.getAttribute('aria-label'));
    expect(buttons).toStrictEqual(['Go back']);

    await view.press('meal-details-not-found-still-available');
    // A press on the note itself does nothing; the action is the button.
    expect(view.backs).toHaveLength(0);
  });

  it('treats an unreachable server as local-only, with the sentence that says what still works', async () => {
    const view = await render({ failWith: transportError('getMeal', 'unreachable') });

    expect(view.text()).toContain('Working offline');
    expect(view.at('meal-details-offline-still-available').textContent ?? '').toContain(
      'still work',
    );
    expect(view.find('meal-details-error')).toBeNull();
  });

  it('reports a refusal as an error, and its retry re-requests the same meal', async () => {
    const view = await render({
      failWith: new ApiClientError({
        kind: 'server',
        status: 500,
        code: null,
        retryable: true,
        wire: null,
        route: 'getMeal',
      }),
    });

    expect(view.at('meal-details-error').textContent ?? '').toContain('could not be loaded');
    expect(view.requests).toHaveLength(1);

    // The retry drives the hook's `nonce`, which is the only thing that re-requests an unchanged
    // id. A screen that rendered the button and wired it to nothing would leave this at one.
    const retry = queryAllByRole(view.at('meal-details-error'), 'button')[0];
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await view.settle();
    expect(view.requests).toStrictEqual([PEANUT_MEAL.id, PEANUT_MEAL.id]);
  });

  it('never renders a wire or exception string', async () => {
    // PRD §12 and BRIEF §3.6: the user-facing copy is this app's, and `ApiClientError.message` is
    // a diagnostic. `API_CLIENT_MESSAGES` phrases are deliberately not reused as screen copy.
    const view = await render({ failWith: new Error('ECONNREFUSED 127.0.0.1:4000') });
    expect(view.text()).not.toContain('ECONNREFUSED');
  });
});

describe('MealDetailsScreen — favourites (T-16-04, T-16-05)', () => {
  it('toggles the favourite, and the projection persists it', async () => {
    const view = await render({ meal: CLEAN_MEAL });

    expect(view.label('meal-details-favorite')).toBe('Add to favourites');
    expect(view.at('meal-details-favorite-state').textContent).toBe('Not in your favourites');

    await view.press('meal-details-favorite');

    // The user-visible consequence AND the stored one: T-16-04's acceptance is "persists across
    // restart", and the projection's write is what a restart reads.
    expect(view.label('meal-details-favorite')).toBe('Remove from favourites');
    expect(view.at('meal-details-favorite-state').textContent).toBe('Saved to favourites');
    expect(view.storedFavorites()).toStrictEqual([CLEAN_MEAL.id]);

    await view.press('meal-details-favorite');
    expect(view.label('meal-details-favorite')).toBe('Add to favourites');
    expect(view.storedFavorites()).toStrictEqual([]);
  });

  it('carries the favourite state as a shape, not only a colour (PRD §10.5)', async () => {
    const view = await render({ meal: CLEAN_MEAL });
    const iconsIn = (): string[] =>
      [...view.at('meal-details-favorite').querySelectorAll('[data-icon-name]')].map(
        (node) => node.getAttribute('data-icon-name') ?? '',
      );

    expect(iconsIn()).toStrictEqual(['heart-outline']);
    await view.press('meal-details-favorite');
    expect(iconsIn()).toStrictEqual(['heart']);
  });

  it('says the list is full at the bound, and offers NO retry (T-16-05)', async () => {
    /**
     * **The refusal is silent in the store, which is why the screen has to speak.** At
     * `MAX_FAVORITES` the reducer returns `state` identically: no write is attempted, so
     * `saveBlocked` never fires and there is nothing for the user to notice.
     *
     * TSD §6.4 — "retrying the same value can never succeed" — so the message carries no action at
     * all. That is the load-bearing assertion here; "nothing was added" is the reducer's doing as
     * much as the screen's, and is asserted for completeness rather than as proof of the guard.
     */
    const view = await render({ meal: CLEAN_MEAL, favorites: favoriteIds(MAX_FAVORITES) });
    const notice = view.at('meal-details-favorites-full');

    expect(notice.textContent ?? '').toContain('full');
    expect(notice.textContent ?? '').toContain(String(MAX_FAVORITES));
    expect(queryAllByRole(notice, 'button')).toStrictEqual([]);
    expect(notice.textContent ?? '').not.toContain('Try again');

    // One surface, not two: the bound and `saveBlocked` share `meal-details-favorites-full`, so a
    // full list must never also raise the retryable save-failure message.
    expect(view.find('meal-details-favorites-save-error')).toBeNull();

    await view.press('meal-details-favorite');
    expect(view.at('meal-details-favorite-state').textContent).toBe('Not in your favourites');
    expect(view.storedFavorites()).toHaveLength(MAX_FAVORITES);
    expect(view.storedFavorites()).not.toContain(CLEAN_MEAL.id);
  });

  it('still REMOVES a favourite at the bound', async () => {
    /**
     * The other half of T-16-05, and the half a guard is most likely to get wrong: a screen that
     * refused every toggle at the bound would leave the user with 200 favourites and no way to
     * remove one, which is a list that can never be shortened.
     */
    const full = favoriteIds(MAX_FAVORITES, [CLEAN_MEAL.id]);
    const view = await render({ meal: CLEAN_MEAL, favorites: full });

    expect(view.label('meal-details-favorite')).toBe('Remove from favourites');
    expect(view.find('meal-details-favorites-full')).toBeNull();

    await view.press('meal-details-favorite');

    expect(view.label('meal-details-favorite')).toBe('Add to favourites');
    expect(view.storedFavorites()).toHaveLength(MAX_FAVORITES - 1);
    expect(view.storedFavorites()).not.toContain(CLEAN_MEAL.id);
  });

  it('tells the user when the stored favourites were reset', async () => {
    /**
     * P14's finding: a reset list the user is not told about is the reset that matters. Driven by
     * real corruption — a payload `favoriteIdsSchema` rejects — so `entryStatus` is `recovered`
     * because the repository decided it, not because a test said so.
     */
    const view = await render({
      meal: CLEAN_MEAL,
      rawFavorites: storedEnvelope({ ids: ['not-an-array'] }),
    });

    const notice = view.at('meal-details-favorites-recovered').textContent ?? '';
    expect(notice).toContain('were reset');
    expect(notice).toContain('was emptied');
    // NOT the truncation wording: a quarantine returns the empty fallback, and the two outcomes
    // share one `EntryStatus` value. Asserted in both directions, here and below.
    expect(notice).not.toContain('shortened');
    expect(view.at('meal-details-favorite-state').textContent).toBe('Not in your favourites');
    expect(view.storedFavorites()).toStrictEqual([]);
  });

  it('offers no favourite control until the meal has loaded', async () => {
    // Favouriting an id the server has not confirmed would store a dead reference; `SavedScreen`
    // then has to render a favourite whose meal does not exist.
    const view = await render({ pending: true });
    expect(view.find('meal-details-favorite')).toBeNull();
  });
});

describe('MealDetailsScreen — dismiss and origin (T-16-07)', () => {
  it('goes back when there is somewhere to go back to', async () => {
    const view = await render({ meal: CLEAN_MEAL, canGoBack: true });
    await view.press('meal-details-dismiss');

    expect(view.backs).toHaveLength(1);
    // `goBack` keeps the list the user was reading, scroll position included, which a `navigate`
    // would throw away.
    expect(view.navigated).toStrictEqual([]);
  });

  it('returns to the ORIGIN tab when the link left nothing behind it', async () => {
    // A deep link straight to `nutritime://meals/<id>?origin=explore` has no previous screen, and
    // that is the case `MealDetailsParams.origin` exists for.
    const view = await render({
      meal: CLEAN_MEAL,
      canGoBack: false,
      params: { mealId: CLEAN_MEAL.id, origin: 'explore' },
    });
    await view.press('meal-details-dismiss');

    expect(view.backs).toHaveLength(0);
    expect(view.navigated).toStrictEqual([{ name: 'Tabs', params: { screen: 'ExploreTab' } }]);
  });

  it('falls back to Home for an origin the route table does not name', async () => {
    /**
     * `readUnionParam` against `NAVIGATION_ORIGINS`, not a cast. A param off a URL is a string the
     * type system never saw, so `origin=../../etc` arrives typed as a `NavigationOrigin` and would
     * otherwise be handed straight to `navigate` as a route name.
     */
    const view = await render({
      meal: CLEAN_MEAL,
      canGoBack: false,
      params: { mealId: CLEAN_MEAL.id, origin: 'nowhere' },
    });
    await view.press('meal-details-dismiss');

    expect(view.navigated).toStrictEqual([{ name: 'Tabs', params: { screen: 'HomeTab' } }]);
  });

  it('requests the id from the params, read rather than trusted', async () => {
    const view = await render({ meal: CLEAN_MEAL, params: { mealId: CLEAN_MEAL.id } });
    expect(view.requests).toStrictEqual([CLEAN_MEAL.id]);
  });
});
