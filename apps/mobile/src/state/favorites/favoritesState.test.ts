import { describe, expect, it } from 'vitest';
import { STORAGE_BOUNDS, STORAGE_DEFINITIONS } from '../../infrastructure/storage/definitions.js';
import {
  MAX_FAVORITES,
  favoritesActions,
  favoritesReducer,
  favoritesStoreConfig,
  isFavorite,
  selectAtFavoritesBound,
  selectFavoriteIds,
} from './favoritesState.js';
import type { FavoritesState } from './favoritesState.js';

/**
 * T-16-01 and T-16-05. The store TSD 6.3 prints as its worked example.
 *
 * T-16-01's acceptance is "toggle is idempotent and reference-preserving", T-16-05's is "at 200 the
 * write is refused". Both are properties of this reducer — and the bound is asserted **against the
 * repository's own `bound` and schema**, not against the number 200, because the claim is "this
 * reducer cannot produce a value this key would refuse" and only the real definition can answer it.
 *
 * Identity is asserted with `toBe`. `toEqual` and `toStrictEqual` both pass on a freshly allocated
 * equal object, so neither detects the defect these assertions exist to catch — a branch returning
 * `{ ...state }`. Probed: that break fails one assertion, reading "expected { ids: [ 'meal-a' ] } to
 * be { ids: [ 'meal-a' ] }".
 */

/** From the real fallback, not a hand-typed `[]`, so the shape is the one hydration produces. */
const base: FavoritesState = favoritesStoreConfig.create(STORAGE_DEFINITIONS.favorites.fallback());

// The key's own bound and schema, as the repository applies them. A write is refused when the bound
// is not the identity on the value, so together these two are what "storable" actually means.
const boundFavorites = STORAGE_DEFINITIONS.favorites.bound;
const favoritesSchema = STORAGE_DEFINITIONS.favorites.schema;

/**
 * A state reached by real `add` dispatches, never by hand-assembling `ids` (BRIEF 6.2). A bound test
 * on a fabricated 200-long array proves only that the selector reads `length`; 200 real adds prove
 * the reducer reaches the bound and then refuses there.
 */
function stateWithCount(count: number): FavoritesState {
  let state = base;
  for (let index = 0; index < count; index += 1) {
    state = favoritesReducer(state, favoritesActions.add(`meal-${index}`));
  }
  return state;
}

describe('the action contract (TSD 6.3 invariants 1 and 2)', () => {
  it('uses namespaced slice/verb-past-tense types', () => {
    // Other modules code against these exact strings, and an action name is part of this store's
    // public surface. `'ADD'` would compile and break every consumer.
    expect(favoritesActions.add('a').type).toBe('favorites/added');
    expect(favoritesActions.remove('a').type).toBe('favorites/removed');
    expect(favoritesActions.toggle('a').type).toBe('favorites/toggled');
    expect(favoritesActions.clear().type).toBe('favorites/cleared');
  });
});

describe('reference preservation — every branch that changes nothing returns state IDENTICALLY', () => {
  const withOne = favoritesReducer(base, favoritesActions.add('meal-a'));
  const atBound = stateWithCount(MAX_FAVORITES);

  it.each([
    ['adding an id already present', withOne, favoritesActions.add('meal-a')],
    ['removing an id not present', withOne, favoritesActions.remove('meal-z')],
    ['removing from an empty list', base, favoritesActions.remove('meal-a')],
    ['clearing an already-empty list', base, favoritesActions.clear()],
    ['an add refused by the bound', atBound, favoritesActions.add('meal-new')],
    ['a toggle refused by the bound', atBound, favoritesActions.toggle('meal-new')],
    ['adding an empty id', base, favoritesActions.add('')],
    ['adding a whitespace-only id', base, favoritesActions.add('   ')],
    // Toggle inherits both refusals by delegating. A toggle of a PRESENT id is deliberately absent
    // from this list: that is a removal, and a removal must allocate.
    ['toggling an empty id', base, favoritesActions.toggle('')],
  ])('%s returns state identically', (_case, state, action) => {
    // `toBe`: identity suppresses the re-render AND the storage write; an equal-but-new object
    // does neither.
    expect(favoritesReducer(state, action)).toBe(state);
  });

  it.each([
    ['a first add', base, favoritesActions.add('meal-a')],
    ['a real removal', withOne, favoritesActions.remove('meal-a')],
    ['a clear of a non-empty list', withOne, favoritesActions.clear()],
    ['a toggle that adds', base, favoritesActions.toggle('meal-a')],
    ['a toggle that removes', withOne, favoritesActions.toggle('meal-a')],
    ['a removal at the bound', atBound, favoritesActions.remove('meal-0')],
  ])('%s does NOT preserve the reference', (_case, state, action) => {
    // The controls, and not decoration: without them a reducer whose every branch returned `state`
    // would pass every assertion above. A real change MUST allocate — that is what writes.
    expect(favoritesReducer(state, action)).not.toBe(state);
  });
});

describe('the bound is a refusal, and the reducer cannot produce an unstorable value', () => {
  it('adds normally one below the bound', () => {
    const nearly = stateWithCount(MAX_FAVORITES - 1);
    expect(selectAtFavoritesBound(nearly)).toBe(false);
    const full = favoritesReducer(nearly, favoritesActions.add('meal-last'));
    expect(selectFavoriteIds(full)).toHaveLength(MAX_FAVORITES);
    expect(isFavorite(full, 'meal-last')).toBe(true);
    expect(selectAtFavoritesBound(full)).toBe(true);
  });

  it('refuses the 201st favourite instead of dropping the oldest', () => {
    const atBound = stateWithCount(MAX_FAVORITES);
    const refused = favoritesReducer(atBound, favoritesActions.add('meal-new'));

    expect(refused).toBe(atBound);
    expect(isFavorite(refused, 'meal-new')).toBe(false);
    // TSD 6.4: deleting the oldest to make room destroys data the user has already been shown, so
    // the FIRST entry must survive. This is what separates a refusal from a truncation.
    expect(isFavorite(refused, 'meal-0')).toBe(true);
    expect(selectFavoriteIds(refused)).toHaveLength(MAX_FAVORITES);
  });

  it('refuses a toggle-on at the bound too, by the same branch', () => {
    const atBound = stateWithCount(MAX_FAVORITES);
    expect(favoritesReducer(atBound, favoritesActions.toggle('meal-new'))).toBe(atBound);
  });

  it('still REMOVES at the bound — the escape from a full list must work', () => {
    // The bound refuses growth, not the store. A user at 200 whose remove also failed would be
    // stuck forever; CONTRACTS 6 promises "removing a favourite must still work at the bound".
    const atBound = stateWithCount(MAX_FAVORITES);
    const removed = favoritesReducer(atBound, favoritesActions.remove('meal-0'));
    expect(selectFavoriteIds(removed)).toHaveLength(MAX_FAVORITES - 1);
    expect(isFavorite(removed, 'meal-0')).toBe(false);

    // And having made room, the add the bound refused a moment ago now succeeds.
    const added = favoritesReducer(removed, favoritesActions.add('meal-new'));
    expect(isFavorite(added, 'meal-new')).toBe(true);
  });

  it('toggling OFF at the bound works, so the heart is never stuck on', () => {
    const atBound = stateWithCount(MAX_FAVORITES);
    const toggled = favoritesReducer(atBound, favoritesActions.toggle('meal-0'));
    expect(isFavorite(toggled, 'meal-0')).toBe(false);
  });

  it('the repository would ACCEPT every value the reducer can reach', () => {
    // P14 directly. `repository.set` does not re-validate and refuses a write exactly when
    // `bound(value)` is not the value itself, so a rejected value persists and the next launch
    // quarantines the whole key. The claim is not "length <= 200" but "the real `bound` is the
    // identity here, and the real schema parses it".
    const atBound = stateWithCount(MAX_FAVORITES);
    const refused = favoritesReducer(atBound, favoritesActions.add('meal-new'));
    const projected = favoritesStoreConfig.project(refused);

    expect(boundFavorites).toBeDefined();
    expect(boundFavorites?.(projected)).toBe(projected);
    expect(favoritesSchema.safeParse(projected).success).toBe(true);
  });

  it('re-exports the figure from STORAGE_BOUNDS rather than retyping it', () => {
    expect(MAX_FAVORITES).toBe(STORAGE_BOUNDS.favorites);
  });
});

describe('an unstorable id never reaches the list', () => {
  it('the schema really does reject an empty-string id', () => {
    // The premise of the guard, checked rather than assumed: if this ever became `true` the refusal
    // above would be caution rather than containment.
    expect(favoritesSchema.safeParse(['']).success).toBe(false);
    expect(favoritesSchema.safeParse(['meal-a']).success).toBe(true);
  });

  it('refuses a blank id, because one empty string quarantines the whole key', () => {
    // A blank `mealId` is reachable: `MealDetails` params off a deep link are strings the type
    // system never saw, and a stored `''` makes the next launch reject and quarantine the entry,
    // costing the user EVERY favourite — P14's failure on a different key.
    for (const blank of ['', ' ', '\t']) {
      const after = favoritesReducer(base, favoritesActions.add(blank));
      expect(after).toBe(base);
      expect(favoritesSchema.safeParse(favoritesStoreConfig.project(after)).success).toBe(true);
    }
  });

  it('does not trim a real id, because an id is a lookup key', () => {
    // Trimming would favourite a DIFFERENT meal than the one tapped. Only blankness is refused.
    const spaced = favoritesReducer(base, favoritesActions.add(' meal-a '));
    expect(selectFavoriteIds(spaced)).toStrictEqual([' meal-a ']);
    expect(isFavorite(spaced, 'meal-a')).toBe(false);
  });
});

describe('toggle is exactly add-or-remove', () => {
  it('equals add when the id is absent', () => {
    expect(favoritesReducer(base, favoritesActions.toggle('meal-a'))).toStrictEqual(
      favoritesReducer(base, favoritesActions.add('meal-a')),
    );
  });

  it('equals remove when the id is present', () => {
    const withTwo = stateWithCount(2);
    expect(favoritesReducer(withTwo, favoritesActions.toggle('meal-0'))).toStrictEqual(
      favoritesReducer(withTwo, favoritesActions.remove('meal-0')),
    );
  });

  it('twice returns to the starting VALUE, and necessarily not to its reference', () => {
    /**
     * FR-012: "Adding and removing a favorite is idempotent and persists."
     *
     * By value, and it **cannot** be by reference — a property of a correct reducer, not a gap here.
     * Each toggle is a real change, so each must allocate: the allocation is what re-renders the
     * heart and queues the shorter list to disk. A reducer handing back the original object on the
     * way out would suppress the write that removes the favourite, and it would return on the next
     * launch. So the two `not.toBe`s are a REQUIREMENT, not a tolerated artefact.
     */
    const once = favoritesReducer(base, favoritesActions.toggle('meal-a'));
    const twice = favoritesReducer(once, favoritesActions.toggle('meal-a'));

    expect(twice).toStrictEqual(base);
    expect(selectFavoriteIds(twice)).toStrictEqual([]);
    expect(twice).not.toBe(base);
    expect(twice).not.toBe(once);
  });

  it('is idempotent over an odd number of toggles', () => {
    // Three toggles equal one. A toggle written as "insert, then maybe insert again" passes the
    // two-toggle test above and fails this one.
    const once = favoritesReducer(base, favoritesActions.toggle('meal-a'));
    const thrice = favoritesReducer(
      favoritesReducer(once, favoritesActions.toggle('meal-a')),
      favoritesActions.toggle('meal-a'),
    );
    expect(thrice).toStrictEqual(once);
  });

  it('round-trips a whole list without disturbing its neighbours', () => {
    const three = stateWithCount(3);
    const off = favoritesReducer(three, favoritesActions.toggle('meal-1'));
    const on = favoritesReducer(off, favoritesActions.toggle('meal-1'));
    // Newest-first means a re-added id returns to the FRONT, not to where it was — stated here
    // rather than discovered later on the Saved screen.
    expect(selectFavoriteIds(off)).toStrictEqual(['meal-2', 'meal-0']);
    expect(selectFavoriteIds(on)).toStrictEqual(['meal-1', 'meal-2', 'meal-0']);
  });
});

describe('order — newest first, because the Saved screen renders this list', () => {
  it('prepends, so the meal just favourited is the first row', () => {
    const three = stateWithCount(3);
    expect(selectFavoriteIds(three)).toStrictEqual(['meal-2', 'meal-1', 'meal-0']);
  });

  it('and the read truncation therefore keeps the NEWEST 200, not the oldest', () => {
    // Reads truncate rather than refuse (TSD 6.4) and `boundedTo` keeps the first `max`, so with
    // prepend order an over-long list from an earlier build loses its OLDEST entries. Asserted
    // through the repository's real `bound`, because that is the function that decides.
    const overlong = ['newest', ...Array.from({ length: MAX_FAVORITES }, (_v, i) => `old-${i}`)];
    const truncated = boundFavorites?.(overlong) ?? overlong;
    expect(truncated).toHaveLength(MAX_FAVORITES);
    expect(truncated.includes('newest')).toBe(true);
    expect(truncated.includes(`old-${MAX_FAVORITES - 1}`)).toBe(false);
  });
});

describe('create and project — the two edges the stored value crosses', () => {
  it('keeps one entry per id, in first-occurrence order', () => {
    // `definitions.ts` states that a duplicate id is NOT corruption and points here: "TSD 6.3's
    // reference-preserving reducer is where set semantics belong." Kept, a duplicate would give the
    // Saved screen two rows with the same React key and make the heart need two taps to clear.
    const created = favoritesStoreConfig.create(['meal-b', 'meal-a', 'meal-b', 'meal-a']);
    expect(selectFavoriteIds(created)).toStrictEqual(['meal-b', 'meal-a']);
  });

  it('renders one row per meal the user saved, with no colliding key', () => {
    // As a ROW COUNT: this block's first probe showed the remove alone is not enough, because
    // `filter` clears every occurrence, so a reducer keeping duplicates still ends empty and those
    // assertions pass either way. A kept duplicate costs two Saved rows with one React key.
    const created = favoritesStoreConfig.create(['meal-a', 'meal-a']);
    const ids = selectFavoriteIds(created);
    expect(ids).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);

    const removed = favoritesReducer(created, favoritesActions.remove('meal-a'));
    expect(isFavorite(removed, 'meal-a')).toBe(false);
    expect(selectFavoriteIds(removed)).toStrictEqual([]);
  });

  it('returns the persisted array identically when there is nothing to drop', () => {
    // The common case must allocate nothing, so `create` stays the no-op TSD 6.3 prints.
    const persisted: readonly string[] = ['meal-a', 'meal-b'];
    expect(favoritesStoreConfig.create(persisted).ids).toBe(persisted);
  });

  it('accepts the fallback, and the fallback is empty', () => {
    expect(selectFavoriteIds(base)).toStrictEqual([]);
    expect(selectAtFavoritesBound(base)).toBe(false);
  });

  it('projects the raw id list, and round-trips back into an identical state', () => {
    const three = stateWithCount(3);
    const projected = favoritesStoreConfig.project(three);
    // Not `state` and not a wrapper: `favoriteIdsSchema` takes only an array of non-empty strings,
    // so a projection returning the state object would quarantine the key on the very next launch.
    expect(projected).toBe(three.ids);
    const parsed = favoritesSchema.safeParse(projected);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(favoritesStoreConfig.create(parsed.data)).toStrictEqual(three);
    }
  });
});

describe('selectors', () => {
  it('selectFavoriteIds hands back the stored array itself', () => {
    // A selector that copied would defeat the memoisation reference preservation exists for.
    const three = stateWithCount(3);
    expect(selectFavoriteIds(three)).toBe(three.ids);
  });

  it('isFavorite answers for present and absent ids', () => {
    const one = favoritesReducer(base, favoritesActions.add('meal-a'));
    expect(isFavorite(one, 'meal-a')).toBe(true);
    expect(isFavorite(one, 'meal-b')).toBe(false);
    expect(isFavorite(base, 'meal-a')).toBe(false);
  });

  it('selectAtFavoritesBound reports full only at or above the bound', () => {
    expect(selectAtFavoritesBound(stateWithCount(MAX_FAVORITES - 1))).toBe(false);
    expect(selectAtFavoritesBound(stateWithCount(MAX_FAVORITES))).toBe(true);
    // The over-long case a recovered list produces. `>=` not `===`, or the screen offers room the
    // repository then refuses to use.
    expect(
      selectAtFavoritesBound({
        ids: Array.from({ length: MAX_FAVORITES + 5 }, (_v, i) => `old-${i}`),
      }),
    ).toBe(true);
  });
});

describe('cleared', () => {
  it('empties a populated list', () => {
    const three = stateWithCount(3);
    const cleared = favoritesReducer(three, favoritesActions.clear());
    expect(selectFavoriteIds(cleared)).toStrictEqual([]);
    expect(cleared).not.toBe(three);
    // T-18-05 clears favourites from Settings through this action, so the projection must still be
    // a storable empty list rather than a removed key.
    expect(favoritesSchema.safeParse(favoritesStoreConfig.project(cleared)).success).toBe(true);
  });
});
