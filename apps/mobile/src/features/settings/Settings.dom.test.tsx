import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { CustomMeal } from '@nutritime/contracts';
import { ThemeProvider, useTheme } from '../../shared/theme/ThemeProvider.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { favoritesStore, selectFavoriteIds } from '../../state/favorites/index.js';
import { customMealsStore, selectCustomMeals } from '../../state/customMeals/index.js';
import { uiActions, uiStore } from '../../state/ui/index.js';
import { onboardingStore } from '../../state/onboarding/index.js';
import { callsOf, memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import { DataResetProvider } from './DataResetProvider.js';
import { SettingsScreen } from './SettingsScreen.js';

/**
 * T-18-02 … T-18-07, against the real stores, the real `DataResetProvider` and a memory driver.
 *
 * **The rule this file is built around: a cancel is asserted against the DATA, never against the
 * closed sheet.** A confirmation nobody tested is a confirmation that might not be wired, and the
 * cancel half is the half that is usually missing — a `Cancel` that closed the sheet *and*
 * dispatched would pass every "the sheet is gone" assertion ever written. So every cancel test
 * below reads the favourite ids, the custom-meal ids and the diet back out of the live stores.
 *
 * **And a clear is asserted against the sets it must NOT touch.** T-18-05's real content is not
 * "favourites went" but "only favourites went": three clears sit in one list, and a handler wired
 * to the wrong action, or one clearing two sets, is the easiest thing here to get silently wrong.
 * Each confirm test therefore asserts the other two sets are unchanged.
 *
 * Nothing is gated on `resetting` and nothing asserts it, deliberately: no consumer of
 * `useDataReset` can be mounted while it is true (that unmount is the reset mechanism), so a test
 * about it could not fail. See the screen's own docstring.
 */

const AT = '2026-09-13T12:00:00.000Z';
const CLOCK = (): string => AT;

/** Stands in for the kind of value the preferences key really holds. */
const ALLERGY = 'peanut';
const FAVORITES = ['chicken-handi', 'beef-lo-mein'] as const;

/** Schema-valid, so the key is not quarantined during hydration and the store really holds it. */
function customMeal(id: string, name: string): CustomMeal {
  return {
    id,
    name,
    description: 'Something the user wrote.',
    mealPeriods: ['breakfast'],
    ingredients: [{ name: 'egg', measure: '3' }],
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
    createdAt: AT,
    updatedAt: AT,
  };
}

const CUSTOM_MEALS = [
  customMeal('house-omelette', 'House omelette'),
  customMeal('lentil-soup', 'Lentil soup'),
];

/**
 * Every key populated with a VALID value, and populated with something the user would recognise.
 *
 * A driver seeded with defaults would make half of this file vacuous: "the diet is still vegan
 * after a cancel" cannot fail if the diet was never vegan.
 */
function seededDriver(): MemoryDriver {
  const driver = memoryDriver({});
  const put = (key: string, value: unknown): void => {
    driver.store.set(key, encodeEnvelope(STORAGE_SCHEMA_VERSION, value, AT));
  };
  put(STORAGE_KEYS.meta, { firstLaunchAt: AT, lastLaunchAt: AT });
  put(STORAGE_KEYS.onboarding, { completed: true });
  put(STORAGE_KEYS.preferences, {
    ...DEFAULT_PREFERENCES,
    diet: 'vegan',
    allergies: [ALLERGY],
    aiEnabled: true,
    themeMode: 'light',
  });
  put(STORAGE_KEYS.favorites, [...FAVORITES]);
  put(STORAGE_KEYS.customMeals, CUSTOM_MEALS);
  put(STORAGE_KEYS.ui, {
    lastTab: 'settings',
    // **Seeded FALSE, always.** A stored `true` is a state no user can produce until the
    // acknowledgement is dispatched, and rendering a value only a test can write is P15's shape.
    // The tests that need `true` dispatch `uiActions.acknowledgeDisclaimer()` — the store's only
    // writer — and let the projection put it on the disk, which is the path a user takes.
    disclaimerAcknowledged: false,
  });
  return driver;
}

interface Navigated {
  readonly name: string;
  readonly params: unknown;
}

/**
 * The whole rendered state, written into the DOM rather than captured in a closure — the
 * convention `createStore.dom.test.tsx` arrived at: a `data-*` attribute is whatever the last
 * commit actually produced, while a captured ref is only as good as the test's guess about flushes.
 */
type AcknowledgeAction = ReturnType<typeof uiActions.acknowledgeDisclaimer>;
let latestUiDispatch: ((action: AcknowledgeAction) => void) | null = null;

function Probe(): ReactNode {
  const { scheme } = useTheme();
  const { preferences } = preferencesStore.useValue();
  const favorites = favoritesStore.useValue();
  const customMeals = customMealsStore.useValue();
  const ui = uiStore.useValue();
  const onboarding = onboardingStore.useValue();
  latestUiDispatch = uiStore.useDispatch();

  return (
    <div
      data-testid="probe"
      data-scheme={scheme}
      data-theme-mode={preferences.themeMode}
      data-ai={String(preferences.aiEnabled)}
      data-diet={preferences.diet}
      data-allergies={preferences.allergies.join(',')}
      data-favorites={selectFavoriteIds(favorites).join(',')}
      data-custom={selectCustomMeals(customMeals)
        .map((meal) => meal.id)
        .join(',')}
      data-disclaimer={String(ui.disclaimerAcknowledged)}
      // Derived exactly as `App.tsx` derives it, from the LIVE onboarding store: T-18-06's
      // acceptance is "app returns to onboarding", so the phase is what has to be asserted.
      data-phase={onboarding.completed ? 'app' : 'onboarding'}
    />
  );
}

/**
 * `ThemeProvider` fed from the stored preference — the wiring T-18-04 needs and `App.tsx` does not
 * have yet (it hard-codes `mode="system"`; see the report's `## NEEDS-INTEGRATION`).
 *
 * Replicated here rather than stubbed, because "changes the scheme immediately" is a claim about
 * the resolved scheme and not about the stored string. `deviceScheme={null}` pins the device out of
 * the answer, so `system` resolves to `light` and a change to `dark` is unambiguous.
 */
function ThemedShell({ children }: { readonly children: ReactNode }): ReactNode {
  const { preferences } = preferencesStore.useValue();
  return (
    <ThemeProvider mode={preferences.themeMode} deviceScheme={null} fontScale={1}>
      {children}
    </ThemeProvider>
  );
}

const MAX_FLUSH_PASSES = 20;

interface Harness {
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  read(attribute: string): string;
  /** The confirmation sheet's text, or `''` when no sheet is open. `Sheet` is a portal. */
  sheetText(): string;
  text(): string;
  press(testID: string): void;
  settle(): Promise<void>;
  settleUntil(done: () => boolean, what: string): Promise<void>;
  readonly navigations: readonly Navigated[];
  readonly driver: MemoryDriver;
}

const mounted: Root[] = [];

afterEach(() => {
  // `Sheet` is a `Modal`, which react-native-web portals into `document.body`. Without this, a
  // sheet left open by one test is found by the next one's query.
  act(() => {
    for (const root of mounted.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
});

async function mount(driver: MemoryDriver): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const navigations: Navigated[] = [];

  const root = createRoot(host);
  mounted.push(root);

  await act(async () => {
    root.render(
      <DataResetProvider runtime={{ driver, now: CLOCK }} fallback={<div data-testid="fallback" />}>
        <preferencesStore.Provider>
          <ThemedShell>
            <favoritesStore.Provider>
              <customMealsStore.Provider>
                <uiStore.Provider>
                  <onboardingStore.Provider>
                    <Probe />
                    <SettingsScreen
                      route={{ key: 's', name: 'Settings', params: undefined } as never}
                      navigation={
                        {
                          navigate: (name: string, params: unknown) => {
                            navigations.push({ name, params });
                          },
                        } as never
                      }
                    />
                  </onboardingStore.Provider>
                </uiStore.Provider>
              </customMealsStore.Provider>
            </favoritesStore.Provider>
          </ThemedShell>
        </preferencesStore.Provider>
      </DataResetProvider>,
    );
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await settle();

  /**
   * **This harness's own tree first, and the body only as the portal fallback.**
   *
   * `Sheet` is a `Modal`, which react-native-web portals into `document.body` rather than into the
   * container this harness created — so a body-rooted query is unavoidable for the sheet. It is
   * also ambiguous the moment two trees are mounted inside one `it`: the query can resolve against
   * the earlier harness, and W10 lost a negative control to exactly that (it had been typing into a
   * previous tree, so the control passed for an unrelated reason).
   *
   * No `it` in this file mounts twice today — verified by counting `await mount(` per test, 18 of
   * 18 with one — so this is a guard against a future edit rather than a live fix. Scoped anyway,
   * because the failure mode is a test that passes for the wrong reason, which is the one kind this
   * suite cannot afford.
   */
  const find = (testID: string): HTMLElement | null => {
    const selector = `[data-testid="${testID}"]`;
    const mine = host.querySelector(selector);
    if (mine instanceof HTMLElement) {
      return mine;
    }
    const portalled = document.body.querySelector(selector);
    return portalled instanceof HTMLElement ? portalled : null;
  };
  const must = (testID: string): HTMLElement => {
    const found = find(testID);
    if (found === null) {
      throw new Error(`no element rendered for testID ${testID}`);
    }
    return found;
  };

  return {
    find,
    must,
    read: (attribute) => must('probe').getAttribute(attribute) ?? '',
    sheetText: () => find('settings-confirm-sheet')?.textContent ?? '',
    text: () => host.textContent ?? '',
    press: (testID) => {
      const target = must(testID);
      act(() => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    },
    settle,
    settleUntil: async (done, what) => {
      for (let pass = 0; pass < MAX_FLUSH_PASSES && !done(); pass += 1) {
        await settle();
      }
      if (!done()) {
        throw new Error(`never settled: ${what}`);
      }
    },
    navigations,
    driver,
  };
}

/** What is on the driver, as one string — for "the allergy list is not on disk any more". */
function diskContents(driver: MemoryDriver): string {
  return [...driver.store.values()].join('|');
}

/**
 * What one key holds ON THE DEVICE, decoded from its envelope.
 *
 * **The store's memory is not the claim.** A confirmed clear empties the list on screen from the
 * dispatch alone; whether it survives the next launch depends on a write that happens afterwards
 * and can fail. V3's mutation — suppress `repository.set` for the favourites key only — leaves
 * every memory assertion green, so each clear is read back from here instead.
 */
function storedValue(driver: MemoryDriver, key: string): unknown {
  const raw = driver.store.get(key);
  if (raw === undefined) {
    throw new Error(`nothing stored at ${key}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('value' in parsed)) {
    throw new Error(`no envelope value at ${key}`);
  }
  return parsed.value;
}

describe('SettingsScreen — preferences, AI and theme', () => {
  it('reaches the P14 form with `returnTo: Settings` instead of rebuilding it', async () => {
    /**
     * T-18-02. The acceptance is "preferences and meal times editable", and Plan §5 P18 fixes HOW:
     * the existing form is reused. So the assertion is the navigation call with its params — and,
     * as the control, that this screen offers no field of its own for a meal time or an allergy. A
     * second copy of the allergy control here would be a second copy of R-30's containment.
     */
    const view = await mount(seededDriver());

    view.press('settings-edit-preferences');

    expect(view.navigations).toEqual([{ name: 'DietarySetup', params: { returnTo: 'Settings' } }]);
    expect(view.find('field-breakfast')).toBeNull();
    expect(view.find('field-allergies')).toBeNull();
    // And no text input at all: a meal time typed here would bypass the draft guard that keeps an
    // unparseable clock value out of the store.
    expect(view.must('settings-screen').querySelector('input, textarea')).toBeNull();
  });

  it('stores the AI preference in both directions, and writes it to the disk', async () => {
    /**
     * T-18-03's acceptance is that the toggle "drives the request's `aiEnabled`" — which is the
     * STORED preference, not the switch's appearance. `selectRequestPreferences` does not carry
     * `aiEnabled`, so the only thing a screen can assert is the value the request lane reads, and
     * the value that survives a restart. Both are checked; the visual state is checked as well,
     * because a stored `false` under a chip that still shows a tick is its own defect.
     */
    const view = await mount(seededDriver());
    expect(view.read('data-ai')).toBe('true');
    expect(view.must('settings-ai-toggle').getAttribute('aria-checked')).toBe('true');

    view.press('settings-ai-toggle');
    await view.settle();

    expect(view.read('data-ai')).toBe('false');
    expect(view.must('settings-ai-toggle').getAttribute('aria-checked')).toBe('false');
    // Read back from the DISK: the claim is that the request lane sees it on the next launch too.
    expect(diskContents(view.driver)).toContain('"aiEnabled":false');

    view.press('settings-ai-toggle');
    await view.settle();

    expect(view.read('data-ai')).toBe('true');
    expect(view.must('settings-ai-toggle').getAttribute('aria-checked')).toBe('true');
    expect(diskContents(view.driver)).toContain('"aiEnabled":true');
  });

  it('changes the resolved scheme immediately, in both directions', async () => {
    /**
     * T-18-04's acceptance, verbatim: "changes scheme immediately in both directions". Asserted on
     * the scheme a `useTheme()` consumer resolves, not on the stored string — `ThemeProvider` takes
     * `mode` as a prop, so a screen that stored the preference and never reached the provider would
     * pass a stored-value assertion and leave the app in the wrong palette.
     *
     * `system` is asserted too, because it is a third choice rather than the absence of one.
     */
    const view = await mount(seededDriver());
    expect(view.read('data-scheme')).toBe('light');

    view.press('chip-theme-dark');
    expect(view.read('data-theme-mode')).toBe('dark');
    expect(view.read('data-scheme')).toBe('dark');

    view.press('chip-theme-light');
    expect(view.read('data-theme-mode')).toBe('light');
    expect(view.read('data-scheme')).toBe('light');

    view.press('chip-theme-system');
    expect(view.read('data-theme-mode')).toBe('system');
    // `deviceScheme` is pinned to `null`, so `system` resolves to light — the documented default.
    expect(view.read('data-scheme')).toBe('light');
  });

  it('says which theme is selected in text and in the accessible name, not just in the tint', async () => {
    /**
     * V7's finding, as a test. `Chip` in the `button` role conveys its selected state through
     * `aria-selected` (invalid on `button`) and `accessibilityState` (unmapped by react-native-web
     * 0.21), so on the web build the fill was the ONLY signal — unreadable to a screen reader and
     * to a colour-blind user alike, which PRD §10.5 forbids.
     *
     * Both carriers are asserted, and both move: the accessible name for assistive technology, the
     * caption for everyone. A test that only read `aria-checked` here would pass on a chip that
     * announces nothing, because a `button`-role chip sets no such attribute.
     */
    const view = await mount(seededDriver());

    expect(view.must('settings-theme-selected').textContent).toBe(
      'Theme: Light. System follows your device.',
    );
    expect(view.must('chip-theme-light').getAttribute('aria-label')).toBe('Theme: Light, selected');
    expect(view.must('chip-theme-dark').getAttribute('aria-label')).toBe('Theme: Dark');

    view.press('chip-theme-dark');

    expect(view.must('settings-theme-selected').textContent).toBe(
      'Theme: Dark. System follows your device.',
    );
    expect(view.must('chip-theme-dark').getAttribute('aria-label')).toBe('Theme: Dark, selected');
    expect(view.must('chip-theme-light').getAttribute('aria-label')).toBe('Theme: Light');
  });

  it('reports the disclaimer as unseen until it is actually acknowledged, then as seen', async () => {
    /**
     * **Driven through `uiActions.acknowledgeDisclaimer()`, not seeded onto the disk.** An earlier
     * version of this test wrote `disclaimerAcknowledged: true` into the driver, which at the time
     * was a state no user could produce — the action had no caller anywhere in the app, so the
     * positive branch was a surface only a test could reach (P15's shape, and V12 was right to
     * call it). The acknowledgement is now dispatched here the way `HomeScreen` dispatches it, and
     * the projection carries it to the disk, so both branches are on the real path.
     */
    const view = await mount(seededDriver());

    expect(view.read('data-disclaimer')).toBe('false');
    expect(view.must('settings-disclaimer').textContent).toContain('have not yet seen');

    await act(async () => {
      latestUiDispatch?.(uiActions.acknowledgeDisclaimer());
    });
    await view.settle();

    expect(view.read('data-disclaimer')).toBe('true');
    expect(view.must('settings-disclaimer').textContent).toBe(
      'You have seen the notice about allergen data being neither complete nor verified.',
    );
    // And it reached the disk, so the next launch reads it back rather than asking again.
    expect(diskContents(view.driver)).toContain('"disclaimerAcknowledged":true');
  });

  it('displays the attribution the licence requires, in the wording the PRD fixes', async () => {
    /**
     * PRD §15: "The app displays the required attribution: *Recipe data and imagery: TheMealDB
     * (https://www.themealdb.com/)*". It appeared in no screen at all until now, which is a licence
     * compliance gap for the data the whole catalog was seeded from — not polish.
     *
     * **`toBe` on the whole sentence, and the literal is written out here rather than imported.**
     * A `toContain` on a fragment would survive exactly the rewording the requirement forbids, and
     * importing `REQUIRED_ATTRIBUTION` would compare the constant with itself — the test has to
     * carry its own copy of the string for the assertion to mean anything.
     */
    const view = await mount(seededDriver());

    expect(view.must('settings-attribution').textContent).toBe(
      'Recipe data and imagery: TheMealDB (https://www.themealdb.com/)',
    );
  });

  it('names every set whose stored copy could not be read', async () => {
    /**
     * `entryStatus: 'unavailable'` means the read failed, so the store writes nothing over the key
     * at all (TSD §6.3) — **a clear dispatched against such a key destroys nothing on the device.**
     * All three clearable sets are named, not just `preferences`: the earlier version of this
     * screen read one status and would have stayed silent while two of the three clears did
     * nothing.
     */
    const driver = seededDriver();
    driver.failOn.add('multiGet');
    const view = await mount(driver);

    const message = view.must('settings-unavailable').textContent ?? '';
    expect(message).toContain('Changes will not be kept');
    expect(message).toContain('your favourites');
    expect(message).toContain('your own meals');
    expect(message).toContain('your preferences');
  });
});

describe('SettingsScreen — every destructive action confirms first', () => {
  it('destroys nothing on the press that opens a confirmation', async () => {
    /**
     * PRD FR-014: "Destructive actions confirm first". Asserted for all four in one test, because
     * the claim is about the set: one button wired straight to its dispatch is the defect, and it
     * would hide behind three that are wired correctly.
     */
    const view = await mount(seededDriver());

    for (const trigger of [
      'settings-clear-favorites',
      'settings-clear-customMeals',
      'settings-clear-preferences',
      'settings-reset-all',
    ]) {
      view.press(trigger);
      await view.settle();

      expect(view.find('settings-confirm-sheet'), trigger).not.toBeNull();
      expect(view.read('data-favorites'), trigger).toBe(FAVORITES.join(','));
      expect(view.read('data-custom'), trigger).toBe('house-omelette,lentil-soup');
      expect(view.read('data-diet'), trigger).toBe('vegan');
      expect(view.read('data-allergies'), trigger).toBe(ALLERGY);
      expect(view.read('data-phase'), trigger).toBe('app');
      // No key was removed either: a selective clear is a dispatch, never a key removal.
      expect(callsOf(view.driver, 'removeItem'), trigger).toEqual([]);

      view.press('settings-cancel');
      await view.settle();
    }
  });

  it('names the set, the count and what is NOT touched, in each confirmation', async () => {
    /**
     * "Are you sure?" is not a confirmation of anything. The copy is the whole safety mechanism
     * here: `Clear favourites` and `Erase all data` are one list apart on this screen.
     */
    const view = await mount(seededDriver());

    view.press('settings-clear-favorites');
    expect(view.sheetText()).toContain('2 favourited meals');
    expect(view.sheetText()).toContain('Your own meals and your preferences are not touched.');
    view.press('settings-cancel');

    view.press('settings-clear-customMeals');
    expect(view.sheetText()).toContain('2 meals');
    expect(view.sheetText()).toContain('cannot be recovered');
    view.press('settings-cancel');

    view.press('settings-clear-preferences');
    expect(view.sheetText()).toContain('empty allergy list');
    // Everything `replace(DEFAULT_PREFERENCES)` actually resets, named. Copy that under-states the
    // scope of a destructive action is a defect: the earlier version omitted three of these.
    for (const field of ['name', 'diet', 'allergies', 'goal', 'budget', 'meal times', 'theme']) {
      expect(view.sheetText(), field).toContain(field);
    }
    view.press('settings-cancel');

    view.press('settings-reset-all');
    expect(view.sheetText()).toContain('taken back through setup');
    expect(view.sheetText()).toContain('cannot be undone');
  });
});

describe('SettingsScreen — favourites clear (T-18-05, T-18-07)', () => {
  it('clears the favourites on confirm, and ONLY the favourites', async () => {
    const view = await mount(seededDriver());
    expect(view.read('data-favorites')).toBe(FAVORITES.join(','));

    view.press('settings-clear-favorites');
    view.press('settings-confirm');
    await view.settle();

    expect(view.read('data-favorites')).toBe('');
    // **And it reached the device.** The dispatch alone empties the list on screen; only the write
    // makes it survive a restart, and that write can be refused (see the next test).
    expect(storedValue(view.driver, STORAGE_KEYS.favorites)).toEqual([]);
    expect(view.find('settings-save-error-favorites')).toBeNull();
    // The rest of T-18-05, and the half that fails silently: a clear removes only what it names.
    expect(view.read('data-custom')).toBe('house-omelette,lentil-soup');
    expect(storedValue(view.driver, STORAGE_KEYS.customMeals)).toHaveLength(2);
    expect(view.read('data-diet')).toBe('vegan');
    expect(view.read('data-allergies')).toBe(ALLERGY);
    expect(diskContents(view.driver)).toContain(ALLERGY);
    expect(view.read('data-phase')).toBe('app');
  });

  it('says so, and offers a retry, when the cleared list could not be written', async () => {
    /**
     * **The defect V3 and V10 found, as a test.** The confirmation says "this removes 2 favourited
     * meals from this device"; the dispatch empties the list on screen; the write is refused; and
     * at the next launch every favourite is back. Silently. This screen previously read only the
     * `preferences` status and never the favourites one, so nothing anywhere said a word.
     *
     * A retry IS offered here, because retrying a refused write can succeed — unlike a bound
     * refusal, where TSD §6.4 says "retrying the same value can never succeed".
     */
    const base = seededDriver();
    const refusing: MemoryDriver = {
      ...base,
      setItem(key: string, value: string): Promise<void> {
        if (key === STORAGE_KEYS.favorites) {
          return Promise.reject(new Error('driver refused setItem'));
        }
        return base.setItem(key, value);
      },
    };
    const view = await mount(refusing);

    view.press('settings-clear-favorites');
    view.press('settings-confirm');
    await view.settleUntil(
      () => view.find('settings-save-error-favorites') !== null,
      'the failed write was never reported',
    );

    const notice = view.must('settings-save-error-favorites');
    expect(notice.textContent).toContain('Your favourites were not saved');
    // The truth the user needs: the screen and the device disagree.
    expect(storedValue(base, STORAGE_KEYS.favorites)).toEqual([...FAVORITES]);
    expect(view.read('data-favorites')).toBe('');
    // A retry, because this one can succeed. And no driver string anywhere (PRD §15.5).
    expect(notice.textContent).toContain('Try again');
    expect(notice.textContent).not.toContain('driver refused');
  });

  it('leaves the favourites provably present on cancel', async () => {
    const view = await mount(seededDriver());

    view.press('settings-clear-favorites');
    view.press('settings-cancel');
    await view.settle();

    // The DATA, not the closed sheet: a cancel that dispatched and closed would pass any
    // assertion about the sheet being gone.
    expect(view.read('data-favorites')).toBe(FAVORITES.join(','));
    expect(view.find('settings-confirm-sheet')).toBeNull();
  });
});

describe('SettingsScreen — custom meals clear (T-18-05, T-18-07)', () => {
  it('deletes the authored meals on confirm, and nothing else', async () => {
    const view = await mount(seededDriver());

    view.press('settings-clear-customMeals');
    view.press('settings-confirm');
    await view.settle();

    expect(view.read('data-custom')).toBe('');
    expect(storedValue(view.driver, STORAGE_KEYS.customMeals)).toEqual([]);
    expect(view.find('settings-save-error-customMeals')).toBeNull();
    expect(view.read('data-favorites')).toBe(FAVORITES.join(','));
    expect(storedValue(view.driver, STORAGE_KEYS.favorites)).toEqual([...FAVORITES]);
    expect(view.read('data-diet')).toBe('vegan');
    expect(view.read('data-allergies')).toBe(ALLERGY);
    expect(diskContents(view.driver)).toContain(ALLERGY);
  });

  it('leaves the authored meals provably present on cancel', async () => {
    const view = await mount(seededDriver());

    view.press('settings-clear-customMeals');
    view.press('settings-cancel');
    await view.settle();

    expect(view.read('data-custom')).toBe('house-omelette,lentil-soup');
  });
});

describe('SettingsScreen — preferences clear (T-18-05, T-18-07)', () => {
  it('puts the preferences back to their defaults on confirm, and nothing else', async () => {
    const view = await mount(seededDriver());

    view.press('settings-clear-preferences');
    view.press('settings-confirm');
    await view.settle();

    expect(view.read('data-diet')).toBe(DEFAULT_PREFERENCES.diet);
    // The allergy list is emptied, which is exactly what the confirmation copy warns about.
    expect(view.read('data-allergies')).toBe('');
    // And on the device, so it does not come back at the next launch.
    expect(storedValue(view.driver, STORAGE_KEYS.preferences)).toMatchObject({
      diet: DEFAULT_PREFERENCES.diet,
      allergies: [],
    });
    expect(diskContents(view.driver)).not.toContain(ALLERGY);
    expect(view.find('settings-save-error-preferences')).toBeNull();
    expect(view.read('data-favorites')).toBe(FAVORITES.join(','));
    expect(storedValue(view.driver, STORAGE_KEYS.favorites)).toEqual([...FAVORITES]);
    expect(view.read('data-custom')).toBe('house-omelette,lentil-soup');
    expect(storedValue(view.driver, STORAGE_KEYS.customMeals)).toHaveLength(2);
    // Not a key removal: the user stays in Settings and the app stays in the `app` phase.
    expect(view.read('data-phase')).toBe('app');
  });

  it('leaves the diet and the allergy list provably present on cancel', async () => {
    const view = await mount(seededDriver());

    view.press('settings-clear-preferences');
    view.press('settings-cancel');
    await view.settle();

    expect(view.read('data-diet')).toBe('vegan');
    expect(view.read('data-allergies')).toBe(ALLERGY);
  });
});

describe('SettingsScreen — full reset (T-18-06, T-18-07)', () => {
  it('erases every key on confirm and returns the app to onboarding', async () => {
    /**
     * T-18-06's acceptance, whole, through the real provider: the subtree is unmounted, the keys
     * are cleared, hydration re-runs and every store re-creates from its fallback. The screen's
     * part is one fire-and-forget `resetAll()` from behind a confirmation — it is the only path
     * that can un-complete onboarding, because the `onboarding` store has no reset action.
     */
    const driver = seededDriver();
    const view = await mount(driver);
    expect(view.read('data-phase')).toBe('app');
    // Acknowledged the way a user does, so the `ui` key really holds `true` before the reset —
    // rather than seeding a value onto the disk that no dispatch could have put there.
    await act(async () => {
      latestUiDispatch?.(uiActions.acknowledgeDisclaimer());
    });
    await view.settle();
    expect(view.read('data-disclaimer')).toBe('true');
    expect(diskContents(driver)).toContain('"disclaimerAcknowledged":true');

    view.press('settings-reset-all');
    view.press('settings-confirm');
    await view.settleUntil(
      () => view.find('probe') !== null && view.read('data-phase') === 'onboarding',
      'the reset never completed',
    );

    expect(view.read('data-phase')).toBe('onboarding');
    expect(view.read('data-diet')).toBe(DEFAULT_PREFERENCES.diet);
    expect(view.read('data-allergies')).toBe('');
    expect(view.read('data-favorites')).toBe('');
    expect(view.read('data-custom')).toBe('');
    expect(view.read('data-disclaimer')).toBe('false');
    // The content is what must not survive; the keys exist again because each store projects its
    // own fallback on the fresh mount, which is what a first launch does.
    expect(diskContents(driver)).not.toContain(ALLERGY);
    expect(diskContents(driver)).not.toContain('house-omelette');
  });

  it('leaves every data set provably present on cancel, with no key removed', async () => {
    const driver = seededDriver();
    const view = await mount(driver);

    await act(async () => {
      latestUiDispatch?.(uiActions.acknowledgeDisclaimer());
    });
    await view.settle();

    view.press('settings-reset-all');
    view.press('settings-cancel');
    await view.settle();

    expect(view.read('data-phase')).toBe('app');
    expect(view.read('data-diet')).toBe('vegan');
    expect(view.read('data-allergies')).toBe(ALLERGY);
    expect(view.read('data-favorites')).toBe(FAVORITES.join(','));
    expect(view.read('data-custom')).toBe('house-omelette,lentil-soup');
    expect(view.read('data-disclaimer')).toBe('true');
    // The strongest form of the claim: the destructive path was not entered at all.
    expect(callsOf(driver, 'removeItem')).toEqual([]);
    expect(diskContents(driver)).toContain(ALLERGY);
  });

  it('names the data sets that survived a partial reset, quoting no driver string', async () => {
    /**
     * A reset that partly failed and said nothing is worse than one that names what it could not
     * remove: the user believes their allergy list is gone while it is still on disk. The message
     * must also survive the unmount that produced it, which is why the provider holds it above the
     * conditional — and it must be built from set labels, never from the exception (PRD §15.5).
     */
    const base = seededDriver();
    const refusing: MemoryDriver = {
      ...base,
      removeItem(key: string): Promise<void> {
        if (key === STORAGE_KEYS.preferences) {
          return Promise.reject(new Error('driver refused removeItem'));
        }
        return base.removeItem(key);
      },
    };
    const view = await mount(refusing);

    view.press('settings-reset-all');
    view.press('settings-confirm');
    await view.settleUntil(
      () => view.find('settings-reset-error') !== null,
      'the failure was never reported',
    );

    const message = view.must('settings-reset-error').textContent ?? '';
    expect(message).toContain('your preferences');
    expect(message).not.toContain('driver refused');
    expect(message).not.toContain(STORAGE_KEYS.preferences);
    /**
     * **The phase must NOT move on a partial failure, and this assertion was inverted until
     * `resetData.ts` was amended.** W7-RESET now clears `onboarding` last and only once everything
     * else is gone, for a reason that lands on this screen: `resetError` is rendered *here*, and
     * `RootNavigator` does not register Settings in the `onboarding` phase — so advancing the
     * phase would move the app to a tree with no surface for its own failure message. It would
     * also drop the user into setup with the data they just asked to erase prefilled into the
     * form. So the app stays set up, on this screen, and says what it could not remove.
     */
    expect(view.read('data-phase')).toBe('app');
    expect(view.find('settings-screen')).not.toBeNull();
    // And the survivor really is still there — the message is not the only claim.
    expect(diskContents(base)).toContain(ALLERGY);
  });
});
