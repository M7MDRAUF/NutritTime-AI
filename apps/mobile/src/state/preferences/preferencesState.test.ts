import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../../infrastructure/storage/definitions.js';
import {
  canonicalAllergies,
  preferencesActions,
  preferencesReducer,
  preferencesStoreConfig,
  selectAllergyFingerprint,
  selectRequestPreferences,
} from './preferencesState.js';
import type { PreferencesState } from './preferencesState.js';

/**
 * T-14-01 and T-14-07. The store that every safety decision reads.
 *
 * The acceptance row for T-14-01 is "an idempotent action returns `state` identically", and the row
 * for T-14-07 is "changing allergies discards on-screen recommendations". Both are properties of
 * this reducer, so both are asserted here — and the second one is asserted as the SIGNAL a screen
 * keys on, because a screen cannot detect the change any other way: `['peanut']` and a fresh
 * `['peanut']` are different objects with equal contents.
 */

const base: PreferencesState = preferencesStoreConfig.create(DEFAULT_PREFERENCES);

describe('canonicalAllergies', () => {
  it('normalises through the domain, so the store cannot hold an unusable term', () => {
    // `'PEANUTS'` is not canonical; `normalizeAllergen` maps it to `'peanut'`. Without this the
    // store would hold a value the matcher does not recognise, which is R-30's failure inside the
    // app instead of over the wire.
    expect(canonicalAllergies(['PEANUTS'])).toStrictEqual(['peanut']);
    expect(canonicalAllergies(['dairy'])).toStrictEqual(['milk']);
  });

  it('de-duplicates after normalising, not before', () => {
    // Two spellings of one allergen are ONE entry. De-duplicating first would keep both.
    expect(canonicalAllergies(['peanut', 'PEANUTS', 'Peanut'])).toStrictEqual(['peanut']);
  });

  it('sorts, so the same set in a different order is the same set', () => {
    expect(canonicalAllergies(['shellfish', 'peanut'])).toStrictEqual(
      canonicalAllergies(['peanut', 'shellfish']),
    );
  });

  it('DROPS a term the taxonomy does not know, rather than keeping it', () => {
    /**
     * `cilantro` is not canonical and infers nothing, so `conflictingAllergens` would match it only
     * as a literal ingredient-name substring — which is R-30. Keeping it in the store would make
     * the UI look as though it had accepted a protection the domain cannot provide.
     *
     * This is only safe because `DietarySetupScreen` offers the canonical list rather than a text
     * box: the pair is the containment, and dropping alone would be data loss.
     */
    expect(canonicalAllergies(['cilantro'])).toStrictEqual([]);
    expect(canonicalAllergies(['peanut', 'cilantro'])).toStrictEqual(['peanut']);
  });

  it('normalises on the way IN from storage', () => {
    // A profile written before this rule existed, or recovered from quarantine, must not put an
    // unusable term into a request.
    const created = preferencesStoreConfig.create({
      ...DEFAULT_PREFERENCES,
      allergies: ['PEANUTS', 'cilantro', 'dairy'],
    });
    expect(created.preferences.allergies).toStrictEqual(['milk', 'peanut']);
  });
});

describe('the reducer preserves references for every no-op', () => {
  it.each([
    ['diet', preferencesActions.changeDiet(DEFAULT_PREFERENCES.diet)],
    ['goal', preferencesActions.changeGoal(DEFAULT_PREFERENCES.goal)],
    ['budget', preferencesActions.changeBudget(DEFAULT_PREFERENCES.budget)],
    ['aiEnabled', preferencesActions.changeAiEnabled(DEFAULT_PREFERENCES.aiEnabled)],
    ['themeMode', preferencesActions.changeThemeMode(DEFAULT_PREFERENCES.themeMode)],
    ['allergies', preferencesActions.changeAllergies(DEFAULT_PREFERENCES.allergies)],
    ['dislikes', preferencesActions.changeDislikedIngredients([])],
    ['mealTime', preferencesActions.changeMealTime('lunch', DEFAULT_PREFERENCES.mealTimes.lunch)],
  ])('%s set to the value it already has returns state identically', (_field, action) => {
    // `toBe`, not `toStrictEqual`. Identity is the contract (TSD 6.3 invariant 3): it is what
    // suppresses the re-render AND the storage write, and an equal-but-new object does neither.
    expect(preferencesReducer(base, action)).toBe(base);
  });

  it('a real change does NOT preserve the reference', () => {
    // The control. Without it, a reducer that returned `state` unconditionally would pass every
    // assertion above.
    expect(preferencesReducer(base, preferencesActions.changeDiet('vegan'))).not.toBe(base);
  });
});

describe('allergiesRevision — the FR-003 signal', () => {
  it('moves when the allergy set actually changes', () => {
    const next = preferencesReducer(base, preferencesActions.changeAllergies(['peanut']));
    expect(next.allergiesRevision).toBe(base.allergiesRevision + 1);
    expect(next.preferences.allergies).toStrictEqual(['peanut']);
  });

  it('does NOT move for a different spelling of the same set', () => {
    /**
     * The case that would make FR-003's invalidation fire on a no-op. A user who re-types `PEANUTS`
     * when `peanut` is already selected has changed nothing, and discarding a screen full of
     * recommendations would train them to distrust it.
     */
    const withPeanut = preferencesReducer(base, preferencesActions.changeAllergies(['peanut']));
    const again = preferencesReducer(withPeanut, preferencesActions.changeAllergies(['PEANUTS']));
    expect(again).toBe(withPeanut);
    expect(again.allergiesRevision).toBe(withPeanut.allergiesRevision);
  });

  it('does NOT move for a reordering of the same set', () => {
    const two = preferencesReducer(
      base,
      preferencesActions.changeAllergies(['peanut', 'shellfish']),
    );
    const reordered = preferencesReducer(
      two,
      preferencesActions.changeAllergies(['shellfish', 'peanut']),
    );
    expect(reordered).toBe(two);
  });

  it('does NOT move when some OTHER preference changes', () => {
    // The other half of the signal's usefulness: if it moved on every dispatch, a screen keying on
    // it would re-request whenever the user changed their theme.
    const after = preferencesReducer(base, preferencesActions.changeBudget('low'));
    expect(after.allergiesRevision).toBe(base.allergiesRevision);
    const afterName = preferencesReducer(after, preferencesActions.changeName('Sam'));
    expect(afterName.allergiesRevision).toBe(base.allergiesRevision);
  });

  it('moves when REMOVING an allergy, not only when adding one', () => {
    // Removing is the direction that makes MORE meals eligible, so a screen that only invalidated
    // on additions would keep showing a needlessly narrow list. Both directions are changes.
    const withPeanut = preferencesReducer(base, preferencesActions.changeAllergies(['peanut']));
    const cleared = preferencesReducer(withPeanut, preferencesActions.changeAllergies([]));
    expect(cleared.allergiesRevision).toBe(withPeanut.allergiesRevision + 1);
  });

  it('moves on a wholesale replacement whose allergy set differs', () => {
    const replaced = preferencesReducer(
      base,
      preferencesActions.replace({ ...DEFAULT_PREFERENCES, allergies: ['fish'] }),
    );
    expect(replaced.allergiesRevision).toBe(base.allergiesRevision + 1);
  });

  it('and not on a replacement whose allergy set is equal', () => {
    const replaced = preferencesReducer(
      base,
      preferencesActions.replace({ ...DEFAULT_PREFERENCES, budget: 'low' }),
    );
    expect(replaced.allergiesRevision).toBe(base.allergiesRevision);
    expect(replaced.preferences.budget).toBe('low');
  });

  it('gives a fingerprint that is equal exactly when the set is', () => {
    const a = preferencesReducer(base, preferencesActions.changeAllergies(['peanut', 'milk']));
    const b = preferencesReducer(base, preferencesActions.changeAllergies(['milk', 'PEANUTS']));
    expect(selectAllergyFingerprint(a)).toBe(selectAllergyFingerprint(b));

    const c = preferencesReducer(base, preferencesActions.changeAllergies(['peanut']));
    expect(selectAllergyFingerprint(c)).not.toBe(selectAllergyFingerprint(a));
  });
});

describe('name is the one optional field', () => {
  it('is absent rather than empty when cleared', () => {
    // A default name would be a name stored without ever being told one (S-20). Clearing it must
    // return to absent, not to `''` — the schema types it optional, not nullable.
    const named = preferencesReducer(base, preferencesActions.changeName('Sam'));
    expect(named.preferences.name).toBe('Sam');

    const cleared = preferencesReducer(named, preferencesActions.changeName('   '));
    expect('name' in cleared.preferences).toBe(false);
  });

  it('trims, so a trailing space is not a change', () => {
    const named = preferencesReducer(base, preferencesActions.changeName('Sam'));
    expect(preferencesReducer(named, preferencesActions.changeName('  Sam  '))).toBe(named);
  });
});

describe('dislikes are free text, unlike allergies', () => {
  it('keeps a term no taxonomy knows', () => {
    // The asymmetry is the point: a dislike is a preference matched by token against ingredient
    // names, so `cilantro` is a perfectly good dislike and a useless allergy.
    const next = preferencesReducer(
      base,
      preferencesActions.changeDislikedIngredients(['cilantro', ' okra ', '', 'cilantro']),
    );
    expect(next.preferences.dislikedIngredients).toStrictEqual(['cilantro', 'okra']);
  });
});

describe('selectRequestPreferences', () => {
  it('sends exactly the five fields the endpoint accepts, and no more', () => {
    /**
     * §11.5 validates the body with `z.strictObject`, so ONE extra field is a 400 — and P10's suite
     * proves `themeMode` is rejected. A selector that spread the whole profile would send `name`,
     * `mealTimes`, `aiEnabled` and `themeMode`: the request would fail, and a user's NAME would
     * have been put on the wire for no reason.
     */
    const named = preferencesReducer(base, preferencesActions.changeName('Sam'));
    expect(Object.keys(selectRequestPreferences(named)).sort()).toStrictEqual([
      'allergies',
      'budget',
      'diet',
      'dislikedIngredients',
      'goal',
    ]);
  });
});
