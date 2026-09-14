import { describe, expect, it } from 'vitest';
import { parseClockTime } from '@nutritime/domain';
import { clockTimeSchema, userPreferencesSchema } from '@nutritime/contracts';
import type { UserPreferences } from '@nutritime/contracts';
import {
  DEFAULT_PREFERENCES,
  STORAGE_DEFINITIONS,
} from '../../infrastructure/storage/definitions.js';
import { MAX_DISLIKES, MAX_NAME_LENGTH } from '../../features/onboarding/dietaryValidation.js';
import {
  canonicalAllergies,
  isStorableClockTime,
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

  it('is bounded to what the schema will take, for the callers that are not a field', () => {
    // The form cannot produce a 61st character (`maxLength`), so this is the guard for `replace`:
    // a name past the bound is a profile the next launch quarantines, allergy list included.
    const long = preferencesReducer(base, preferencesActions.changeName('N'.repeat(80)));
    expect(long.preferences.name).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe('a replacement that changes nothing is still reference-preserving', () => {
  it('recognises the profile it already holds, whatever order its keys are in', () => {
    /**
     * **The order is not cosmetic here.** This comparison used to be `JSON.stringify` on both
     * sides, which makes key order part of the answer — and the order really does vary: `withName`
     * appends `name` when a user first sets one, while the same profile read back from disk arrives
     * in `userPreferencesSchema`'s declared order, with `name` second. So a restored backup of the
     * profile already in the store read as a change, re-rendered every screen keyed on preferences
     * and queued a write of a value identical to the one on disk.
     *
     * The literal below is deliberately in the schema's order, because that is the shape
     * `repository.get` hands to `create` — a hydrated profile, replaced by itself.
     */
    const hydrated = preferencesStoreConfig.create({
      schemaVersion: 1,
      name: 'Sam',
      diet: 'regular',
      allergies: ['peanut'],
      goal: 'balanced',
      budget: 'medium',
      dislikedIngredients: ['okra'],
      mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
      aiEnabled: true,
      themeMode: 'system',
    });

    expect(preferencesReducer(hydrated, preferencesActions.replace(hydrated.preferences))).toBe(
      hydrated,
    );
  });

  it('and a replacement that changes ONE field does not — the control', () => {
    // Without this, a branch returning `state` from every replacement would pass the assertion
    // above and silently ignore a restored backup.
    const next = preferencesReducer(
      base,
      preferencesActions.replace({ ...DEFAULT_PREFERENCES, budget: 'high' }),
    );
    expect(next).not.toBe(base);
    expect(next.preferences.budget).toBe('high');
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

/**
 * **P14's CRITICAL, pinned at last — the three guards that repair it, each driven by the hostile
 * input it exists for.**
 *
 * The defect: this store held a value `userPreferencesSchema` rejects, `repository.set` does not
 * re-validate, the write reached the disk, and the next launch quarantined the whole `preferences`
 * entry and rebuilt it from `DEFAULT_PREFERENCES` — **erasing the declared allergy list** while the
 * separate `onboarding` key survived, so the app opened on Home and filtered by nothing.
 *
 * Two audits found all three repairs unguarded: every dispatch in this file used four dislikes, a
 * valid time and already-canonical allergies, so deleting any of the three left the suite green,
 * and `userPreferencesSchema` appeared nowhere under `state/`. Modelled on
 * `onboardingState.test.ts`, which does exactly this for a store where the bug never happened.
 *
 * Every case below asserts **both** directions: that the raw input really is a value the schema
 * rejects — without that control the success assertion is vacuous — and that what the reducer makes
 * of it is one the schema accepts.
 */
describe('the store cannot hold a value userPreferencesSchema rejects', () => {
  /** The PROJECTION is what reaches the disk, so the projection is what gets parsed. */
  const accepts = (state: PreferencesState): boolean =>
    userPreferencesSchema.safeParse(preferencesStoreConfig.project(state)).success;

  const rejects = (preferences: unknown): boolean =>
    !userPreferencesSchema.safeParse(preferences).success;

  /** 40 distinct ingredients: past the bound, and none of them a duplicate of another. */
  const FORTY = Array.from({ length: 40 }, (_, index) => `ingredient-${String(index)}`);

  it('parses against the schema the storage layer itself applies, not a restatement of it', () => {
    // If the `preferences` key were ever re-pointed at a copy, every assertion below would still
    // pass while the real read path diverged. This is the line that would notice.
    expect(STORAGE_DEFINITIONS.preferences.schema).toBe(userPreferencesSchema);
    expect(accepts(base)).toBe(true);
  });

  it('restates the schema bounds it caps to, and they are still the schema bounds', () => {
    /**
     * `MAX_DISLIKES` and `MAX_NAME_LENGTH` are copies of `userPreferencesSchema`'s own `.max(30)`
     * and `.max(60)`, kept in a feature module so the form can enforce them before a value is
     * stored. A copy that drifts is worse than no copy: the reducer would cap to a bound the schema
     * no longer has, and the profile would be quarantined anyway. Asserted in both directions, so
     * neither an over-tight nor an over-loose constant survives.
     */
    const withDislikes = (count: number): unknown => ({
      ...DEFAULT_PREFERENCES,
      dislikedIngredients: FORTY.slice(0, count),
    });
    expect(rejects(withDislikes(MAX_DISLIKES))).toBe(false);
    expect(rejects(withDislikes(MAX_DISLIKES + 1))).toBe(true);

    expect(rejects({ ...DEFAULT_PREFERENCES, name: 'N'.repeat(MAX_NAME_LENGTH) })).toBe(false);
    expect(rejects({ ...DEFAULT_PREFERENCES, name: 'N'.repeat(MAX_NAME_LENGTH + 1) })).toBe(true);
  });

  it('caps the dislike list, so a 31st ingredient never becomes an unstorable profile', () => {
    expect(rejects({ ...DEFAULT_PREFERENCES, dislikedIngredients: FORTY })).toBe(true);

    const next = preferencesReducer(
      base,
      preferencesActions.changeDislikedIngredients([...FORTY, '   ', 'ingredient-0']),
    );

    expect(next.preferences.dislikedIngredients).toHaveLength(MAX_DISLIKES);
    // The schema types each entry `z.string().min(1)`, so a blank is as unstorable as a 31st.
    expect(next.preferences.dislikedIngredients).not.toContain('');
    expect(accepts(next)).toBe(true);
  });

  it.each([
    ['08:', 'half-typed'],
    ['8:00', 'unpadded hour'],
    ['24:00', 'hour out of range'],
    ['23:60', 'minute out of range'],
    ['', 'empty'],
    ['noon', 'not a time at all'],
  ])('refuses %s (%s) rather than storing it', (time) => {
    expect(
      rejects({
        ...DEFAULT_PREFERENCES,
        mealTimes: { ...DEFAULT_PREFERENCES.mealTimes, breakfast: time },
      }),
    ).toBe(true);

    const next = preferencesReducer(base, preferencesActions.changeMealTime('breakfast', time));

    expect(accepts(next)).toBe(true);
    expect(next.preferences.mealTimes.breakfast).toBe(DEFAULT_PREFERENCES.mealTimes.breakfast);
    // Refused, not partially applied: `toBe` is the same identity contract as every other no-op,
    // and it is what keeps the write queue from ever seeing this value.
    expect(next).toBe(base);
  });

  it('still takes a real time — the control for the six refusals above', () => {
    // Without this, a branch that refused EVERY meal time would pass all six and the user could
    // never change when they eat.
    const next = preferencesReducer(base, preferencesActions.changeMealTime('breakfast', '07:15'));
    expect(next.preferences.mealTimes.breakfast).toBe('07:15');
    expect(accepts(next)).toBe(true);
  });

  it('sanitises EVERY field of a wholesale replacement, not two of them', () => {
    /**
     * The branch a restored backup or a future import takes — and the one still open after P14.
     * It canonicalised allergies and capped dislikes and did nothing else, so an unparseable meal
     * time, a name past the schema's 60 characters and a blank dislike all went straight through
     * into a profile the next launch would quarantine whole.
     */
    const hostile: UserPreferences = {
      schemaVersion: 1,
      name: 'N'.repeat(80),
      diet: 'vegan',
      allergies: ['PEANUTS', 'dairy', 'cilantro', 'peanut'],
      goal: 'high-protein',
      budget: 'low',
      dislikedIngredients: [...FORTY, '  ', 'ingredient-0'],
      mealTimes: { breakfast: '08:', lunch: '12:30', dinner: '99:99' },
      aiEnabled: false,
      themeMode: 'dark',
    };
    expect(rejects(hostile)).toBe(true);

    const next = preferencesReducer(base, preferencesActions.replace(hostile));

    expect(accepts(next)).toBe(true);
    expect(next.preferences.name).toHaveLength(MAX_NAME_LENGTH);
    expect(next.preferences.dislikedIngredients).toHaveLength(MAX_DISLIKES);
    expect(next.preferences.dislikedIngredients).not.toContain('');
    // Unknown term dropped, spellings collapsed, sorted (R-30).
    expect(next.preferences.allergies).toStrictEqual(['milk', 'peanut']);
    // An unreadable time falls back to the one already stored; a readable one is taken.
    expect(next.preferences.mealTimes.breakfast).toBe(DEFAULT_PREFERENCES.mealTimes.breakfast);
    expect(next.preferences.mealTimes.dinner).toBe(DEFAULT_PREFERENCES.mealTimes.dinner);
    expect(next.preferences.mealTimes.lunch).toBe('12:30');

    /**
     * And every field that was already fine arrives intact, from its own source.
     *
     * The branch is written out field by field now, which is the shape that cannot carry an
     * unexamined value in — and is also the shape where a transposed line (`budget` taken from
     * `goal`) would be invisible to a schema check, because both are valid enums.
     */
    expect(next.preferences.diet).toBe('vegan');
    expect(next.preferences.goal).toBe('high-protein');
    expect(next.preferences.budget).toBe('low');
    expect(next.preferences.aiEnabled).toBe(false);
    expect(next.preferences.themeMode).toBe('dark');
    expect(next.preferences.schemaVersion).toBe(1);
  });

  it('drops a whitespace-only name on replacement rather than storing an empty one', () => {
    // `name` is optional, not nullable: absent means never told, and `''` is a third state the
    // schema does not have.
    const next = preferencesReducer(
      base,
      preferencesActions.replace({ ...DEFAULT_PREFERENCES, name: '   ' }),
    );
    expect('name' in next.preferences).toBe(false);
    expect(accepts(next)).toBe(true);
  });

  it('cleans the list on the way IN from storage as well', () => {
    // Hydration is the third write path into `dislikedIngredients`, and a profile written before
    // the cap existed comes back through it.
    const created = preferencesStoreConfig.create({
      ...DEFAULT_PREFERENCES,
      dislikedIngredients: FORTY,
    });
    expect(created.preferences.dislikedIngredients).toHaveLength(MAX_DISLIKES);
    expect(accepts(created)).toBe(true);
  });
});

/**
 * The store keeps the project's THIRD copy of the clock pattern (`meal-period.ts`,
 * `dietaryValidation.ts`, and `STORABLE_CLOCK` here), and the justification written at that site is
 * that a test asserts the copies agree. **None did.** This is that assertion, and it is the reason
 * the duplication is allowed to stand: a store must not import a feature module, but it must not
 * drift from the domain either.
 */
describe('STORABLE_CLOCK is the same rule as the domain parser and the contract schema', () => {
  it.each(['00:00', '08:00', '12:30', '19:00', '23:59'])(
    'accepts %s, as both of the others do',
    (value) => {
      expect(isStorableClockTime(value)).toBe(true);
      expect(() => parseClockTime(value)).not.toThrow();
      expect(clockTimeSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['8:00', '08:0', '24:00', '23:60', '08:00 ', '0800', 'noon', ''])(
    'rejects %s, as both of the others do',
    (value) => {
      expect(isStorableClockTime(value)).toBe(false);
      expect(() => parseClockTime(value)).toThrow();
      expect(clockTimeSchema.safeParse(value).success).toBe(false);
    },
  );
});
