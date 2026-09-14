/**
 * The `favorites` store's state, actions, reducer and selectors (T-16-01).
 *
 * TSD 6.3 prints this store as its worked example for the three store invariants, and it names this
 * store when it explains the third: "Favouriting an already-favourite meal must return the same
 * object — that is what suppresses both the re-render and the storage write." So **every branch
 * below that changes nothing returns `state` identically**, and `favoritesState.test.ts` proves each
 * one with `toBe`. `toEqual` passes on a freshly allocated object and is therefore not a test of
 * this property at all.
 *
 * **The bound is enforced HERE, not only at the storage edge.** P14 shipped a CRITICAL defect of
 * exactly this shape: a store held a value its own key's schema rejected, `repository.set` does not
 * re-validate ("a typed-caller bug, not a storage condition"), the write persisted, and the next
 * launch quarantined the whole entry and **erased the user's allergy list**. The rule that follows
 * is the one this module is built around: *a reducer must never be able to produce a value its own
 * key cannot store.* Two consequences:
 *
 *  - `favorites/added` and `favorites/toggled` **refuse** at `MAX_FAVORITES` rather than dropping
 *    the oldest entry. TSD 6.4: bounds are refusals on write, because every entry under this key is
 *    something the user chose, and a save that silently deleted one would destroy data the user has
 *    already been shown. The screen says so and offers no retry (T-16-05).
 *  - A **blank id is refused**, because `favoriteIdsSchema` rejects a zero-length string. One empty
 *    string reaching disk would quarantine the whole key and cost the user *every* favourite — and
 *    a blank id can only ever arrive from a caller, since `kebabIdSchema` admits no meal id that is
 *    empty or whitespace.
 *
 * `saveBlocked` on the store status stays the backstop for a value that arrives some other way. It
 * is not the primary guard.
 */

import { STORAGE_BOUNDS } from '../../infrastructure/storage/definitions.js';
import type { StoreConfig } from '../createStore.js';

export interface FavoritesState {
  readonly ids: readonly string[];
}

/** Namespaced `slice/verb-past-tense` types (TSD 6.3 invariant 1): `favorites/added`, not `ADD`. */
export type FavoritesAction =
  | { readonly type: 'favorites/added'; readonly mealId: string }
  | { readonly type: 'favorites/removed'; readonly mealId: string }
  | { readonly type: 'favorites/toggled'; readonly mealId: string }
  | { readonly type: 'favorites/cleared' };

/** Action creators only. A component never constructs an action literal (TSD 6.3 invariant 2). */
export const favoritesActions = {
  add: (mealId: string): FavoritesAction => ({ type: 'favorites/added', mealId }),
  remove: (mealId: string): FavoritesAction => ({ type: 'favorites/removed', mealId }),
  toggle: (mealId: string): FavoritesAction => ({ type: 'favorites/toggled', mealId }),
  clear: (): FavoritesAction => ({ type: 'favorites/cleared' }),
};

/**
 * The bound from TSD 6.4, re-exported so a screen need not import storage definitions.
 *
 * **Imported, never retyped.** Annotated `number` rather than left as the literal `200` on purpose:
 * a caller that narrowed to the literal would be a second place the figure lives, and the point of
 * re-exporting it is that there is exactly one.
 */
export const MAX_FAVORITES: number = STORAGE_BOUNDS.favorites;

export function selectFavoriteIds(state: FavoritesState): readonly string[] {
  return state.ids;
}

export function isFavorite(state: FavoritesState, mealId: string): boolean {
  return state.ids.includes(mealId);
}

/**
 * True when one more favourite could not be stored. Drives T-16-05's message.
 *
 * `>=`, not `===`: a list recovered from a build that predated the reducer's refusal could arrive
 * longer than the bound, and such a list is still full. `===` would report room the repository
 * would then refuse to use.
 */
export function selectAtFavoritesBound(state: FavoritesState): boolean {
  return state.ids.length >= MAX_FAVORITES;
}

/**
 * An id `favoriteIdsSchema` can actually store, and that could name a meal.
 *
 * The empty-string case is the storability guard the module docstring describes. Whitespace is
 * refused with it because `kebabIdSchema` is `/^[a-z0-9]+(-[a-z0-9]+)*$/` — no meal id contains a
 * space — so a whitespace id is the same class of non-id, just one the schema happens to tolerate.
 *
 * The id is **not trimmed**. A favourite is a key looked up against a catalog record, and trimming
 * would invent a different id and quietly favourite something else.
 */
function isStorableMealId(mealId: string): boolean {
  return mealId.trim() !== '';
}

export function favoritesReducer(state: FavoritesState, action: FavoritesAction): FavoritesState {
  switch (action.type) {
    case 'favorites/added': {
      if (!isStorableMealId(action.mealId)) {
        return state;
      }
      if (isFavorite(state, action.mealId)) {
        return state;
      }
      // The refusal. See the module docstring: the alternative is a value this key cannot store.
      if (selectAtFavoritesBound(state)) {
        return state;
      }
      /**
       * **Newest first**, and the Saved screen renders this order, so a user will notice.
       *
       * No document fixes it; the choice is recorded in the report under JUDGEMENTS. Prepending,
       * because:
       *
       *  - the newest favourite is the one the user just acted on, and with 200 of them an appended
       *    entry lands 200 rows below the fold, which reads as the save having failed;
       *  - reads TRUNCATE rather than refuse (TSD 6.4) and `boundedTo` keeps the FIRST `max`, so
       *    for an over-long list written by an earlier build, prepend order means the newest 200
       *    survive. Losing the oldest is the less surprising loss.
       *
       * What it costs: every existing row shifts by one on an add. Acceptable, because the add
       * happens in the `MealDetails` modal rather than inside the Saved list, and the list is keyed
       * by meal id, so React re-orders rows rather than re-mounting them.
       */
      return { ids: [action.mealId, ...state.ids] };
    }

    case 'favorites/removed': {
      if (!isFavorite(state, action.mealId)) {
        return state;
      }
      // `filter` rather than a splice at the found index, because it removes every occurrence. The
      // reducer cannot create a duplicate and `create` drops the ones already on disk, but a remove
      // that left a second copy behind would make an un-favourited meal come back on the next launch.
      return { ids: state.ids.filter((id) => id !== action.mealId) };
    }

    case 'favorites/toggled': {
      /**
       * **Toggle is exactly add-or-remove, by delegation rather than by re-implementation.**
       *
       * Written this way so it cannot drift: the bound refusal, the blank-id refusal, the ordering
       * and the reference preservation are all inherited from the two branches above, and a rule
       * added to `added` later applies to `toggled` without anyone remembering to repeat it.
       */
      return favoritesReducer(
        state,
        isFavorite(state, action.mealId)
          ? favoritesActions.remove(action.mealId)
          : favoritesActions.add(action.mealId),
      );
    }

    case 'favorites/cleared': {
      // Reference-preserving like every other branch: clearing an already-empty list writes nothing
      // and re-renders nothing. T-18-05 dispatches this from Settings behind a confirmation.
      if (state.ids.length === 0) {
        return state;
      }
      return { ids: [] };
    }
  }
}

/**
 * De-duplicated, keeping the FIRST occurrence of each id.
 *
 * **A duplicate id on disk is not corruption** — `definitions.ts` says so, and says why: the shape
 * is one `favoriteIdsSchema` can represent, and quarantining the key would cost the user every
 * favourite they have in order to fix one they cannot see. It then points here: "TSD 6.3's
 * reference-preserving reducer is where set semantics belong."
 *
 * So this store keeps them out, and that choice is deliberate rather than defensive. Keeping them
 * would make `isFavorite` answer true for an id the user favourited once, give the Saved screen two
 * rows with the same React key, and make the heart on `MealDetails` need two taps to clear.
 * Dropping them does change what the next projection writes — but a repeated id carries no
 * information the first one does not, so nothing the user chose is lost. That is the whole
 * difference between this and truncating on read, which would drop a meal the user actually picked.
 *
 * `Set` iterates in first-insertion order, which under the prepend rule above is newest-first, so
 * de-duplicating never reorders the list. Returns `ids` **identically** when there is nothing to
 * drop, so the common case allocates nothing and `create` stays the no-op TSD 6.3 prints.
 */
function withoutDuplicates(ids: readonly string[]): readonly string[] {
  const unique = new Set(ids);
  return unique.size === ids.length ? ids : [...unique];
}

export const favoritesStoreConfig = {
  name: 'favorites',
  key: 'favorites',
  create: (persisted) => ({ ids: withoutDuplicates(persisted) }),
  reducer: favoritesReducer,
  // The raw id list, which is exactly what `favoriteIdsSchema` validates — not `state`, and not a
  // wrapper. Identity is preserved, so `boundedTo` (which refuses a write when `bound(value)` is
  // not the value itself) returns it unchanged and an in-bounds save is never refused wrongly.
  project: (state) => state.ids,
} satisfies StoreConfig<'favorites', FavoritesState, FavoritesAction>;
