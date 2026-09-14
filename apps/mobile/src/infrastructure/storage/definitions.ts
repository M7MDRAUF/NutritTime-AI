/**
 * What this app stores: six keys, their value shapes, their schemas and their fallbacks
 * (TSD 6.4; Plan 12.1 names this file and gives it to the frontend owner).
 *
 * Three things are decided here rather than read off a document, each labelled where it appears:
 *
 *  - **X-14 — `customMealSchema`.** TSD 3.2 calls `CustomMeal` "same shape as Meal, with
 *    nutrition optional", but `ValueSchema<CustomMeal> = mealSchema` does not compile. Resolved
 *    below by DELEGATING to `mealSchema` rather than restating it. See `customMealSchema`.
 *  - **A-09 — `DEFAULT_PREFERENCES`.** Plan-introduced. No document names the constant or its
 *    contents.
 *  - **Plan-introduced shapes.** `meta`, `onboarding` and `ui` are named as keys by TSD 6.4 and
 *    their contents are specified nowhere. What each holds is chosen here and reported.
 *
 * **No Zod in this file, or anywhere in `apps/mobile`.** TSD 2.3 rule 2 makes `packages/contracts`
 * the only package with a third-party runtime dependency, and `apps/mobile/package.json` does not
 * declare `zod`. Every shape contracts already owns is validated by the contracts schema; the four
 * plan-introduced shapes below are each one explicit guard, not a validator to be extended.
 */

import { mealSchema, userPreferencesSchema } from '@nutritime/contracts';
import type { CustomMeal, UserPreferences, ValueSchema } from '@nutritime/contracts';
import { QUARANTINE_KEY, isRecord, isTimestamp } from './envelope.js';
import type { RepositoryDefinition } from './repository.js';

export { QUARANTINE_KEY };

/** TSD 6.4, verbatim. */
export const STORAGE_KEYS = {
  meta: '@nutritime/meta',
  onboarding: '@nutritime/onboarding',
  preferences: '@nutritime/preferences/v1',
  favorites: '@nutritime/favorites/v1',
  customMeals: '@nutritime/custom-meals/v1',
  ui: '@nutritime/ui/v1',
} as const;
export type StorageKeyName = keyof typeof STORAGE_KEYS;

/** Hydration order, and the runtime witness that "six keys" is still six. */
export const STORAGE_KEY_NAMES = [
  'meta',
  'onboarding',
  'preferences',
  'favorites',
  'customMeals',
  'ui',
] as const satisfies readonly StorageKeyName[];

/** TSD 6.4, verbatim. Refused on write, truncated on read — see `repository.ts`. */
export const STORAGE_BOUNDS = { favorites: 200, customMeals: 200 } as const;

// ------------------------------------------------------------- plan-introduced value shapes

/**
 * The `meta` key. TSD 6.3 says it "is written once at boot through its repository directly" and
 * no document says what it holds.
 *
 * Two instants, and deliberately nothing else. **No name, no question, no allergy list** — PRD
 * 10.3 forbids those reaching a log line, and a `meta` record is the one key with no reason to
 * carry user data at all. Both are nullable so the fallback needs no clock: `hydrate.ts` fills
 * them from the runtime clock at boot, which keeps `fallback()` pure and the tests deterministic.
 */
export interface StoredMeta {
  readonly firstLaunchAt: string | null;
  readonly lastLaunchAt: string | null;
}

/** The `onboarding` key: the completion gate T-14-02 reads, and nothing more. */
export interface StoredOnboarding {
  readonly completed: boolean;
}

/**
 * The `ui` key. `lastTab` and the disclaimer flag are plan-introduced (A-09); T-18-01 owns them.
 *
 * `lastTab` holds a LOGICAL tab id, not a React Navigation route name — TSD 6.2 already spells
 * navigation origins that way (`NAVIGATION_ORIGINS = ['home', 'explore', 'saved', 'assistant']`).
 * A persisted route name would couple a stored record to the navigator's naming, so a rename in
 * `navigation/routes.ts` would quietly invalidate every user's last tab.
 */
export const UI_TABS = ['home', 'explore', 'assistant', 'saved', 'settings'] as const;
export type UiTab = (typeof UI_TABS)[number];

export interface StoredUi {
  readonly lastTab: UiTab | null;
  readonly disclaimerAcknowledged: boolean;
}

/** The value type behind each key. TSD 6.3's `StorageValues[K]` is this map. */
export interface StorageValues {
  readonly meta: StoredMeta;
  readonly onboarding: StoredOnboarding;
  readonly preferences: UserPreferences;
  readonly favorites: readonly string[];
  readonly customMeals: readonly CustomMeal[];
  readonly ui: StoredUi;
}

// ------------------------------------------------------------------------------ X-14

/**
 * The placeholder `catalogVersion` a custom meal borrows to be checked by `mealSchema`.
 *
 * A `CustomMeal` belongs to no catalog, which is exactly why TSD 3.2 omits the field. It is
 * added before validation and discarded after, so it never reaches storage or a screen.
 */
export const CUSTOM_MEAL_CATALOG_VERSION = 'user-authored';

/**
 * **X-14, resolved: `customMealSchema` is authored, and it delegates.**
 *
 * `CustomMeal` is `Omit<Meal, 'source' | 'catalogVersion'>` plus `source: 'user'` and two
 * timestamps, so `ValueSchema<CustomMeal> = mealSchema` cannot compile: `mealSchema` demands a
 * `catalogVersion` a custom meal has not got and, being a `strictObject`, rejects the two
 * timestamps it has. The fix is not a second schema. This one lifts off the two fields
 * `mealSchema` does not know about, hands everything else to `mealSchema`, and reassembles —
 * so the `superRefine` that carries the real invariants (all-or-nothing nutrition, and
 * `source: 'user'` implying `nutritionProvenance.origin: 'user'`) applies to a user-authored
 * meal exactly as it does to a catalog record. Restating those rules here is precisely the
 * duplication Plan 12.3 calls a gate failure.
 *
 * On the prose half of X-14: "nutrition optional" is already true and needs no type change.
 * `NutritionSummary`'s four fields are `number | null`, and `mealSchema`'s `user` branch accepts
 * an all-null set with no `servings` — so a user may leave nutrition unset (PRD FR-006) while a
 * catalog record may not. **The TSD prose is not wrong, it is loosely worded**: "optional" there
 * means "may be wholly null", not "may be absent". Worth correcting to say so, since the current
 * wording is what invited the impossible `ValueSchema<CustomMeal> = mealSchema`. No TSD change is
 * required for this task, and none was made.
 */
export const customMealSchema: ValueSchema<CustomMeal> = {
  safeParse(value: unknown) {
    if (!isRecord(value)) {
      return { success: false };
    }
    const { createdAt, updatedAt, ...rest } = value;
    if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) {
      return { success: false };
    }
    // Checked before delegating: `mealSchema` permits `source: 'local'`, and a catalog record
    // stored under the custom-meals key would be user data this app never let the user author.
    if (rest['source'] !== 'user') {
      return { success: false };
    }
    const parsed = mealSchema.safeParse({ ...rest, catalogVersion: CUSTOM_MEAL_CATALOG_VERSION });
    if (!parsed.success) {
      return { success: false };
    }
    const { catalogVersion: _placeholder, ...meal } = parsed.data;
    return { success: true, data: { ...meal, source: 'user', createdAt, updatedAt } };
  },
};

// ------------------------------------------------------------------- plan-introduced schemas

const FAILURE = { success: false } as const;

function isTimestampOrNull(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

const storedMetaSchema: ValueSchema<StoredMeta> = {
  safeParse(value: unknown) {
    if (!isRecord(value)) {
      return FAILURE;
    }
    const firstLaunchAt = value['firstLaunchAt'];
    const lastLaunchAt = value['lastLaunchAt'];
    if (!isTimestampOrNull(firstLaunchAt) || !isTimestampOrNull(lastLaunchAt)) {
      return FAILURE;
    }
    return { success: true, data: { firstLaunchAt, lastLaunchAt } };
  },
};

const storedOnboardingSchema: ValueSchema<StoredOnboarding> = {
  safeParse(value: unknown) {
    if (!isRecord(value) || typeof value['completed'] !== 'boolean') {
      return FAILURE;
    }
    return { success: true, data: { completed: value['completed'] } };
  },
};

const storedUiSchema: ValueSchema<StoredUi> = {
  safeParse(value: unknown) {
    if (!isRecord(value)) {
      return FAILURE;
    }
    const lastTab = value['lastTab'];
    const disclaimerAcknowledged = value['disclaimerAcknowledged'];
    if (typeof disclaimerAcknowledged !== 'boolean' || !isUiTabOrNull(lastTab)) {
      return FAILURE;
    }
    return { success: true, data: { lastTab, disclaimerAcknowledged } };
  },
};

function isUiTabOrNull(value: unknown): value is UiTab | null {
  return value === null || (typeof value === 'string' && UI_TABS.some((tab) => tab === value));
}

/**
 * Favourite meal ids. Ids only — never a meal, and never anything about the user.
 *
 * A duplicate id is NOT treated as corruption. It is a shape this schema can represent, and
 * quarantining the key would cost the user every favourite they have to fix one they cannot see;
 * TSD 6.3's reference-preserving reducer is where set semantics belong. The schema validates the
 * shape, which is the only thing it can do without destroying data.
 */
const favoriteIdsSchema: ValueSchema<readonly string[]> = {
  safeParse(value: unknown) {
    if (!Array.isArray(value)) {
      return FAILURE;
    }
    const items: readonly unknown[] = value;
    const ids: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string' || item.length === 0) {
        return FAILURE;
      }
      ids.push(item);
    }
    return { success: true, data: ids };
  },
};

const customMealsSchema: ValueSchema<readonly CustomMeal[]> = {
  safeParse(value: unknown) {
    if (!Array.isArray(value)) {
      return FAILURE;
    }
    const items: readonly unknown[] = value;
    const meals: CustomMeal[] = [];
    for (const item of items) {
      const parsed = customMealSchema.safeParse(item);
      if (!parsed.success) {
        return FAILURE;
      }
      meals.push(parsed.data);
    }
    return { success: true, data: meals };
  },
};

// --------------------------------------------------------------------------- A-09

/**
 * **A-09 — plan-introduced.** No document names this constant or fixes its contents; Plan 7.2
 * records it as a symbol the plan invented so a task could name a file instead of gesturing at
 * one, and says to rename it freely.
 *
 * Every field is the least presumptuous value that still satisfies `userPreferencesSchema`:
 *
 *  - `name` is **absent**, not empty. It is the one optional field in `UserPreferences`, and a
 *    default name would be a name this app stored without being told one (PRD 10.3).
 *  - `diet: 'regular'`, `allergies: []`, `dislikedIngredients: []` — an assumed restriction is a
 *    worse failure than none: it would silently hide meals the user can eat, and an assumed
 *    allergy would teach them to distrust the filter.
 *  - `goal: 'balanced'`, `budget: 'medium'` — the middle of each enumeration, so scoring's
 *    goal and budget policies (TSD 4.6) start neutral rather than pulling the first list.
 *  - `mealTimes` — chosen here. The windows are anchor−90 to anchor+120 (TSD 4.3), so these
 *    anchors cover 06:30–10:00, 11:00–14:30 and 17:30–21:00 and leave the gaps as `snack`,
 *    which is the behaviour FR-004 describes. The user edits them in Dietary Setup.
 *  - `aiEnabled: true` — the assistant and AI explanations are PRD 7.3's headline feature, and
 *    both already degrade to a local answer when the model is unreachable (TSD 5.4).
 *  - `themeMode: 'system'` — matches `userInterfaceStyle: 'automatic'` in `app.json`.
 */
export const DEFAULT_PREFERENCES = {
  schemaVersion: 1,
  diet: 'regular',
  allergies: [],
  goal: 'balanced',
  budget: 'medium',
  dislikedIngredients: [],
  mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
  aiEnabled: true,
  themeMode: 'system',
} as const satisfies UserPreferences;

export const DEFAULT_META: StoredMeta = { firstLaunchAt: null, lastLaunchAt: null };
export const DEFAULT_ONBOARDING: StoredOnboarding = { completed: false };
export const DEFAULT_UI: StoredUi = { lastTab: null, disclaimerAcknowledged: false };

/**
 * Bounded to `max`, **returning the value itself when it fits**.
 *
 * That identity is load-bearing, not an optimisation: `repository.ts` refuses a write exactly
 * when `bound(value) !== value`, so a version of this that always allocated would refuse every
 * save of a favourite.
 */
function boundedTo<T>(max: number): (value: readonly T[]) => readonly T[] {
  return (value) => (value.length <= max ? value : value.slice(0, max));
}

// --------------------------------------------------------------------- the six definitions

/**
 * Every key is at schema version 1, because every key is new in this build.
 *
 * The migration gate is therefore unexercised by the shipped definitions — which is correct, and
 * is why `repository.test.ts` proves the `−1` accepted / `−2` refused vectors against a test
 * definition at version 3. Authoring a migration for a version that never shipped would be
 * fabricating the data it claims to convert.
 */
export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_DEFINITIONS: {
  readonly [K in StorageKeyName]: RepositoryDefinition<StorageValues[K]>;
} = {
  meta: {
    key: STORAGE_KEYS.meta,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    schema: storedMetaSchema,
    fallback: () => DEFAULT_META,
  },
  onboarding: {
    key: STORAGE_KEYS.onboarding,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    schema: storedOnboardingSchema,
    fallback: () => DEFAULT_ONBOARDING,
  },
  preferences: {
    key: STORAGE_KEYS.preferences,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    // The contracts schema, not a copy of it. One definition of a preference set is parsed at
    // the storage edge and at the server edge (Plan 12.3).
    schema: userPreferencesSchema,
    fallback: () => DEFAULT_PREFERENCES,
  },
  favorites: {
    key: STORAGE_KEYS.favorites,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    schema: favoriteIdsSchema,
    fallback: () => [],
    bound: boundedTo(STORAGE_BOUNDS.favorites),
  },
  customMeals: {
    key: STORAGE_KEYS.customMeals,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    schema: customMealsSchema,
    fallback: () => [],
    bound: boundedTo(STORAGE_BOUNDS.customMeals),
  },
  ui: {
    key: STORAGE_KEYS.ui,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    schema: storedUiSchema,
    fallback: () => DEFAULT_UI,
  },
};
