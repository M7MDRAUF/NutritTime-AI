/**
 * The `preferences` store's state, actions, reducer and selectors (T-14-01).
 *
 * **This is the slice every safety decision in the product reads**, so two things here are not
 * negotiable:
 *
 *  1. **`allergiesRevision`.** FR-003 requires that changing allergies discards the recommendations
 *     currently on screen. A screen cannot detect that by comparing arrays — `['peanut']` and a new
 *     `['peanut']` are different objects with equal contents, and an effect keyed on the array
 *     re-requests on every unrelated preference change. A counter that increments **only** when the
 *     effective allergy set changes is the signal, and it is derived here rather than in a screen
 *     so that every screen gets the same answer. See `selectAllergyFingerprint`.
 *  2. **Reference-preserving reducers** (TSD §6.3 invariant 3). An action that changes nothing
 *     returns `state` *identically*, which suppresses the re-render AND the storage write.
 *
 * Allergies are normalised through the domain on the way in, so the store never holds a value the
 * matcher cannot use. That is the containment R-30 names: a free-text allergy reaching the server is
 * matched only literally, and the fix is that the UI never produces one.
 */

import { normalizeAllergen } from '@nutritime/domain';
import type {
  BudgetBand,
  DietTag,
  NutritionGoal,
  ThemeMode,
  UserPreferences,
} from '@nutritime/contracts';
import { MAX_DISLIKES } from '../../features/onboarding/dietaryValidation.js';
import type { StoreConfig } from '../createStore.js';

export interface PreferencesState {
  readonly preferences: UserPreferences;
  /**
   * Increments when the effective allergy set changes, and at no other time.
   *
   * The number itself means nothing; only a change in it does. Screens key their request effect on
   * this rather than on `allergies`, which is what makes FR-003's invalidation a property of the
   * store rather than a convention screens have to remember.
   */
  readonly allergiesRevision: number;
}

export type PreferencesAction =
  | { readonly type: 'preferences/nameChanged'; readonly name: string }
  | { readonly type: 'preferences/dietChanged'; readonly diet: DietTag }
  | { readonly type: 'preferences/allergiesChanged'; readonly allergies: readonly string[] }
  | { readonly type: 'preferences/goalChanged'; readonly goal: NutritionGoal }
  | { readonly type: 'preferences/budgetChanged'; readonly budget: BudgetBand }
  | {
      readonly type: 'preferences/dislikedIngredientsChanged';
      readonly dislikedIngredients: readonly string[];
    }
  | {
      readonly type: 'preferences/mealTimeChanged';
      readonly period: 'breakfast' | 'lunch' | 'dinner';
      readonly time: string;
    }
  | { readonly type: 'preferences/aiEnabledChanged'; readonly aiEnabled: boolean }
  | { readonly type: 'preferences/themeModeChanged'; readonly themeMode: ThemeMode }
  | { readonly type: 'preferences/replaced'; readonly preferences: UserPreferences };

/** Action creators only. A component never constructs an action literal (TSD §6.3 invariant 2). */
export const preferencesActions = {
  changeName: (name: string): PreferencesAction => ({ type: 'preferences/nameChanged', name }),
  changeDiet: (diet: DietTag): PreferencesAction => ({ type: 'preferences/dietChanged', diet }),
  changeAllergies: (allergies: readonly string[]): PreferencesAction => ({
    type: 'preferences/allergiesChanged',
    allergies,
  }),
  changeGoal: (goal: NutritionGoal): PreferencesAction => ({
    type: 'preferences/goalChanged',
    goal,
  }),
  changeBudget: (budget: BudgetBand): PreferencesAction => ({
    type: 'preferences/budgetChanged',
    budget,
  }),
  changeDislikedIngredients: (dislikedIngredients: readonly string[]): PreferencesAction => ({
    type: 'preferences/dislikedIngredientsChanged',
    dislikedIngredients,
  }),
  changeMealTime: (period: 'breakfast' | 'lunch' | 'dinner', time: string): PreferencesAction => ({
    type: 'preferences/mealTimeChanged',
    period,
    time,
  }),
  changeAiEnabled: (aiEnabled: boolean): PreferencesAction => ({
    type: 'preferences/aiEnabledChanged',
    aiEnabled,
  }),
  changeThemeMode: (themeMode: ThemeMode): PreferencesAction => ({
    type: 'preferences/themeModeChanged',
    themeMode,
  }),
  replace: (preferences: UserPreferences): PreferencesAction => ({
    type: 'preferences/replaced',
    preferences,
  }),
};

/**
 * The canonical, de-duplicated, sorted allergy set — the only form this store keeps.
 *
 * Normalised through the domain's own `normalizeAllergen`, so `'PEANUTS'` and `'peanut'` are one
 * entry and the store cannot hold a value the matcher will not recognise. **A term the taxonomy
 * does not know is dropped rather than kept**: `conflictingAllergens` would match it only as a
 * literal ingredient-name substring, which is R-30's whole problem, and keeping it would make the
 * UI look like it had accepted a protection it cannot provide. `DietarySetupScreen` therefore offers
 * the canonical list rather than a text box, and this is the second half of that guard.
 *
 * Sorted, so the fingerprint below is order-independent: re-selecting the same two allergies in the
 * other order must not read as a change.
 */
export function canonicalAllergies(values: readonly string[]): readonly string[] {
  const canonical = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAllergen(value);
    if (normalized !== null) {
      canonical.add(normalized);
    }
  }
  return [...canonical].sort();
}

/** The comparable form of the allergy set. Equal strings mean an equal set (FR-003). */
export function selectAllergyFingerprint(state: PreferencesState): string {
  /**
   * NUL as the separator, written as an ESCAPE rather than as a raw byte.
   *
   * A literal U+0000 in this file made it binary: `file` reported `data`, and ripgrep's
   * `files_with_matches` mode OMITS binary files - so a search for `allergiesRevision` across
   * the app returned the two files that read it and not the file that defines it. The most
   * safety-critical module in the project was invisible to every content search, while prettier
   * and eslint passed because it parses as one string character.
   *
   * NUL rather than a space or a comma because no canonical allergen can contain one, so the
   * joined string is injective over allergy sets: two different sets cannot produce one
   * fingerprint, which is the whole property FR-003's comparison rests on.
   */
  return state.preferences.allergies.join('\u0000');
}

export function selectPreferences(state: PreferencesState): UserPreferences {
  return state.preferences;
}

/** Exactly the five fields `recommendationRequestSchema` accepts — no more (§11.5). */
export function selectRequestPreferences(state: PreferencesState): {
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly goal: NutritionGoal;
  readonly budget: BudgetBand;
  readonly dislikedIngredients: readonly string[];
} {
  const { diet, allergies, goal, budget, dislikedIngredients } = state.preferences;
  return { diet, allergies, goal, budget, dislikedIngredients };
}

/** `name` is the one optional field: absent means never told, which is not the same as empty. */
function withName(preferences: UserPreferences, name: string): UserPreferences {
  const trimmed = name.trim();
  if (trimmed === '') {
    const { name: _dropped, ...rest } = preferences;
    return rest;
  }
  return { ...preferences, name: trimmed };
}

/**
 * Exactly what `clockTimeSchema` and `parseClockTime` both accept.
 *
 * Duplicated here rather than imported from `dietaryValidation`, deliberately: this is a STORE
 * invariant and the store must not depend on a feature module. `dietaryValidation.test.ts` asserts
 * the same pattern against `parseClockTime` in both directions, and
 * `preferencesState.test.ts` asserts that the two agree.
 */
const STORABLE_CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isStorableClockTime(value: string): boolean {
  return STORABLE_CLOCK.test(value);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function preferencesReducer(
  state: PreferencesState,
  action: PreferencesAction,
): PreferencesState {
  switch (action.type) {
    case 'preferences/nameChanged': {
      const next = withName(state.preferences, action.name);
      // `withName` allocates, so identity has to be compared on the field rather than the object.
      if (next.name === state.preferences.name) {
        return state;
      }
      return { ...state, preferences: next };
    }

    case 'preferences/dietChanged': {
      if (state.preferences.diet === action.diet) {
        return state;
      }
      return { ...state, preferences: { ...state.preferences, diet: action.diet } };
    }

    case 'preferences/allergiesChanged': {
      const allergies = canonicalAllergies(action.allergies);
      /**
       * **The only place `allergiesRevision` moves**, and only on a real change.
       *
       * Compared after normalisation, so typing `'PEANUTS'` when `'peanut'` is already selected is
       * not a change and does not discard a screen full of recommendations. A revision that
       * incremented on every dispatch would make FR-003's invalidation fire on a no-op, which
       * trains a user to distrust the screen.
       */
      if (sameList(state.preferences.allergies, allergies)) {
        return state;
      }
      return {
        preferences: { ...state.preferences, allergies },
        allergiesRevision: state.allergiesRevision + 1,
      };
    }

    case 'preferences/goalChanged': {
      if (state.preferences.goal === action.goal) {
        return state;
      }
      return { ...state, preferences: { ...state.preferences, goal: action.goal } };
    }

    case 'preferences/budgetChanged': {
      if (state.preferences.budget === action.budget) {
        return state;
      }
      return { ...state, preferences: { ...state.preferences, budget: action.budget } };
    }

    case 'preferences/dislikedIngredientsChanged': {
      // Trimmed and de-duplicated, but NOT normalised against a taxonomy: a dislike is free text by
      // design (it is a preference, not a safety filter), and `matchedDislikedIngredients` matches
      // it by token against ingredient names.
      /**
       * **Capped at `MAX_DISLIKES`, because the store must never hold a value its own schema
       * rejects.**
       *
       * `userPreferencesSchema` bounds this list at 30. Without the cap, a 31st dislike was written
       * to disk, quarantined on the next launch, and the whole `preferences` entry replaced by
       * defaults — **silently erasing the user's allergy list** while `onboarding.completed`
       * survived on its own key, so the app went straight to Home and filtered by nothing.
       *
       * The form also has a rule for it now, so the user is told. This is the belt: a screen can
       * forget a rule, and a reducer that cannot produce an unstorable value is what makes that
       * forgetting survivable.
       */
      const cleaned = [
        ...new Set(action.dislikedIngredients.map((one) => one.trim()).filter((one) => one !== '')),
      ].slice(0, MAX_DISLIKES);
      if (sameList(state.preferences.dislikedIngredients, cleaned)) {
        return state;
      }
      return {
        ...state,
        preferences: { ...state.preferences, dislikedIngredients: cleaned },
      };
    }

    case 'preferences/mealTimeChanged': {
      /**
       * **A value the domain cannot parse is refused, not stored.**
       *
       * `parseClockTime` throws `RangeError` on anything that is not zero-padded `HH:mm`, and
       * `useRecommendations` calls `mealPeriodForDate` during render — so a half-typed `'08:'` in
       * the store crashed Home, which sits mounted beneath the dietary form in the `app` phase.
       * There is no error boundary in this app, so React unmounted the tree. The same value also
       * failed `userPreferencesSchema` and took the whole `preferences` key to quarantine on the
       * next launch.
       *
       * `DietarySetupScreen` keeps the half-typed text in its own draft state, so the user still
       * types freely and sees their own characters; what reaches the store is only ever a time.
       */
      if (!isStorableClockTime(action.time)) {
        return state;
      }
      if (state.preferences.mealTimes[action.period] === action.time) {
        return state;
      }
      return {
        ...state,
        preferences: {
          ...state.preferences,
          mealTimes: { ...state.preferences.mealTimes, [action.period]: action.time },
        },
      };
    }

    case 'preferences/aiEnabledChanged': {
      if (state.preferences.aiEnabled === action.aiEnabled) {
        return state;
      }
      return { ...state, preferences: { ...state.preferences, aiEnabled: action.aiEnabled } };
    }

    case 'preferences/themeModeChanged': {
      if (state.preferences.themeMode === action.themeMode) {
        return state;
      }
      return { ...state, preferences: { ...state.preferences, themeMode: action.themeMode } };
    }

    case 'preferences/replaced': {
      const allergies = canonicalAllergies(action.preferences.allergies);
      const changed = !sameList(state.preferences.allergies, allergies);
      const next: UserPreferences = {
        ...action.preferences,
        allergies,
        // The same two sanitisations the field actions apply. A replacement is the path a restored
        // backup or a future import takes, and it must not be the way an unstorable value gets in.
        dislikedIngredients: action.preferences.dislikedIngredients.slice(0, MAX_DISLIKES),
      };
      // Reference-preserving, like every other branch (TSD 6.3 invariant 3). An identical
      // replacement used to allocate and therefore trigger a storage write.
      if (!changed && JSON.stringify(next) === JSON.stringify(state.preferences)) {
        return state;
      }
      return {
        preferences: next,
        // A wholesale replacement still has to move the revision when the allergy set differs —
        // otherwise restoring a backup, or a future import, would leave stale recommendations up.
        allergiesRevision: changed ? state.allergiesRevision + 1 : state.allergiesRevision,
      };
    }
  }
}

export const preferencesStoreConfig = {
  name: 'preferences',
  key: 'preferences',
  // Normalised on the way IN as well: a profile stored before the canonical rule existed, or
  // recovered from quarantine, must not put an unusable allergy term into a request.
  create: (persisted) => ({
    preferences: {
      ...persisted,
      allergies: canonicalAllergies(persisted.allergies),
      dislikedIngredients: persisted.dislikedIngredients.slice(0, MAX_DISLIKES),
    },
    allergiesRevision: 0,
  }),
  reducer: preferencesReducer,
  project: (state) => state.preferences,
} satisfies StoreConfig<'preferences', PreferencesState, PreferencesAction>;
