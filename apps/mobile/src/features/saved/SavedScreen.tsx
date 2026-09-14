/**
 * Saved — favourites and the user's own recipes, two sections that fail independently (T-17-02).
 *
 * TSD §6.8 gives this screen two data sources and one state: "favorites + customMeals stores", and
 * "empty (per section)". **Per section is the whole design.** One empty state for both halves would
 * answer neither question they ask: a user with three recipes and no favourites would be told the
 * screen is empty while looking at three recipes. So both sections are always mounted, each renders
 * its own state, and `SavedParams.section` decides only which of them comes FIRST. A switcher was
 * the alternative and was rejected — with one section on screen at a time, "empty per section" and
 * "empty per screen" are indistinguishable, to the user and to a test alike.
 *
 * **`section` is read through `readUnionParam`, never off `route.params` as typed** — it can arrive
 * from `nutritime://saved?section=custom`, where it is whatever the URL said. Re-derived every
 * render rather than seeded into state the way Explore seeds its search box: nothing here is owned
 * by the user, so there is no typing for a re-derivation to fight.
 *
 * **Where a tap goes, and why the two rows go to different screens.** A favourite opens
 * `MealDetails` with `origin: 'saved'`; one of the user's own recipes opens `MealForm` in edit mode.
 * TSD §6.8 assigns `MealDetails` the data source `GET /meals/:id` and `MealForm` the `customMeals`
 * store, and a user-authored meal carries a UUID the server has never heard of — routing it to
 * `MealDetails` would make "not-found" mean two different things on one screen: a catalog record
 * that no longer exists, and a meal that exists and is on this device. PRD §8.3's journey for a
 * record the user wrote is "edit it", which is `MealForm`.
 *
 * **A favourite can outlive its meal, and that must not break the section.** The store holds ids and
 * never meals, so a favourited id can name a catalog record that no longer exists — `favoritesFeed.ts`
 * owns that problem and its docstring carries the reasoning, including why the fetch and the
 * grouping of its three outcomes must stay in one module.
 *
 * **Saved is a list of things the user chose to keep, so a conflict here is MARKED — in both
 * sections.** That is the rule, and it is the line between this screen and Explore: a browse list
 * deliberately does not mark every conflicting meal, because marking a whole catalog the user is
 * merely scanning teaches them to ignore the mark. A keep-list is the opposite case. The user has
 * already chosen these, the form told them that declaring an allergen keeps conflicting meals away
 * from them, and a favourited catalog meal and a recipe they wrote themselves are equally capable of
 * conflicting — a user can tick "peanut" on their own recipe. Both are checked with the domain's
 * `conflictingAllergens` against the declared allergy list; `SavedSections.tsx` renders it.
 *
 * **The two stores' `entryStatus` is read, and `unavailable` is not `recovered`.** `unavailable`
 * means the key could not be read, so `createStore` refuses to write over it (TSD §6.3) — silently,
 * because `saveError` and `saveBlocked` both stay clear. Left unsaid, this screen would show an empty
 * list it has no grounds for and the user's next recipe would be lost at the following launch with
 * nothing having warned them.
 *
 * **The custom section has no loading and no local-only state, deliberately.** It reads a store that
 * is already hydrated before any screen renders — `StorageProvider` renders no children until the
 * snapshot exists — so there is no request to wait on and no server to be unreachable from. A
 * spinner there would be a control that can never be observed, guarded by a test that cannot fail.
 *
 * **Rows are mapped, not virtualised.** Both sections must be on screen at once for their empty
 * states to be independent, and two `FlatList`s in one scroll container is the nested-virtualised-
 * list breakage React Native warns about. TSD §6.4 bounds each list at 200, so the worst case is
 * bounded; a single `SectionList` is the proposed follow-up if that bound proves slow on a device.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { AppText } from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { SAVED_SECTIONS, readUnionParam } from '../../navigation/routes.js';
import {
  favoritesActions,
  favoritesStore,
  selectFavoriteIds,
} from '../../state/favorites/index.js';
import {
  customMealsStore,
  selectAtCustomMealsBound,
  selectCustomMeals,
} from '../../state/customMeals/index.js';
import { preferencesStore, selectPreferences } from '../../state/preferences/index.js';
import { useFavoriteMeals } from './favoritesFeed.js';
import { CustomSection } from './CustomSection.js';
import { FavoritesSection } from './FavoritesSection.js';

export function SavedScreen({ route, navigation }: ScreenProps<'Saved'>): ReactNode {
  const client = useApiClient();
  const { colors, components } = useTheme();

  const favorites = favoritesStore.useValue();
  const favoritesStatus = favoritesStore.useStatus();
  const favoritesDispatch = favoritesStore.useDispatch();
  const customMeals = customMealsStore.useValue();
  const customStatus = customMealsStore.useStatus();

  /**
   * The **declared** allergies, not `canonicalAllergies(...)` — and **S-42 says the opposite about a
   * different path**, so the distinction has to be written down rather than inferred.
   *
   * S-42 drops a term the lexicon does not know, and its reasoning is about a **protection**: such a
   * term "matches only as a literal ingredient-name substring (R-30), so keeping it would make the
   * UI look as though it had accepted a protection the domain cannot provide". That is right for the
   * request path, where the app filters and ranks and the user reads the result as "these are safe
   * for me".
   *
   * This path produces a **warning**, which inverts the argument. A literal ingredient-name match is
   * exactly the signal worth having here: a user who declared "peanut butter" should see the marker
   * on a recipe whose ingredient says "Peanut butter", and canonicalising first would delete that
   * input and silently show them nothing. The costs are asymmetric in the same direction — a missed
   * marker on a conflicting meal is a safety failure, while an extra marker is a sentence the user
   * can read and dismiss.
   *
   * It is also lossless to pass the raw list: `conflictingAllergens` normalises each term itself
   * (`singularKebabCase`, then `normalizeAllergen`, falling back to the literal), so pre-canonicalising
   * can only remove inputs it would otherwise have used — never improve the match.
   */
  const allergies = selectPreferences(preferencesStore.useValue()).allergies;

  const ids = selectFavoriteIds(favorites);
  const [nonce, setNonce] = useState(0);
  const feed = useFavoriteMeals(client, ids, nonce);

  const openFavorite = useCallback(
    (mealId: string) => {
      navigation.navigate('MealDetails', { mealId, origin: 'saved' });
    },
    [navigation],
  );

  const openCustom = useCallback(
    (mealId: string) => {
      navigation.navigate('MealForm', { mealId });
    },
    [navigation],
  );

  /**
   * Create: `MealForm` with **no `mealId`**, which the route table defines as create mode.
   *
   * `{}` rather than no second argument at all: React Navigation focuses an existing route of that
   * name, and passing params replaces the ones it is holding. Omitting them would leave a `mealId`
   * from a previous edit in place, and "New meal" would open that meal's form.
   */
  const createMeal = useCallback(() => {
    navigation.navigate('MealForm', {});
  }, [navigation]);

  const retryFavorites = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  const forget = useCallback(
    (mealId: string) => {
      favoritesDispatch(favoritesActions.remove(mealId));
    },
    [favoritesDispatch],
  );

  const section = readUnionParam(route.params, 'section', SAVED_SECTIONS) ?? 'favorites';

  /**
   * **`key` on both sections, because the two render POSITIONS swap and React reconciles by index.**
   *
   * `section` decides which of the two comes first, so changing it puts a different component type
   * at each position. Without a stable key React unmounts and remounts **both** — and since P23
   * both carry live-region notices, a remount **re-speaks** them. Measured at P23: a `section`
   * change re-announced both reset notices, which is a screen reader interrupting the user to
   * repeat something they already heard because they navigated.
   *
   * The keys are on the ELEMENTS rather than on the positions on purpose: a key at the position
   * would still be index-based and would reconcile a `FavoritesSection` into a `CustomSection`.
   */
  const favoritesSection = (
    <FavoritesSection
      key="favorites"
      feed={feed}
      entryStatus={favoritesStatus.entryStatus}
      allergies={allergies}
      onOpen={openFavorite}
      onRetry={retryFavorites}
      onForget={forget}
    />
  );
  const customSection = (
    <CustomSection
      key="custom"
      meals={selectCustomMeals(customMeals)}
      atBound={selectAtCustomMealsBound(customMeals)}
      entryStatus={customStatus.entryStatus}
      allergies={allergies}
      onOpen={openCustom}
      onCreate={createMeal}
    />
  );

  return (
    <ScrollView
      testID="saved-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
    >
      <AppText variant="title" level={1} testID="saved-heading">
        Saved
      </AppText>
      {section === 'custom' ? customSection : favoritesSection}
      {section === 'custom' ? favoritesSection : customSection}
    </ScrollView>
  );
}
