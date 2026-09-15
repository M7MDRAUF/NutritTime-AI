/**
 * Saved — favourites and the user's own recipes, two sections that fail independently (T-17-02).
 *
 * TSD §6.8 gives this screen two data sources and one state: "favorites + customMeals stores", and
 * "empty (per section)". **Per section is the whole design.** One empty state for both halves would
 * answer neither question they ask: a user with three recipes and no favourites would be told the
 * screen is empty while looking at three recipes. So both sections are always rendered, each renders
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
 * `conflictingAllergens` against the declared allergy list; `SavedMealRow.tsx` renders it.
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
 * **One `SectionList`, and the rows are windowed (T-22-08).** This screen used to map every row into
 * one `ScrollView`, and the rationale that stood here — two `FlatList`s in one scroll container is
 * the nested-virtualised-list breakage, TSD §6.4 bounds each list at 200, "so the worst case is
 * bounded" — was right about the hazard and wrong about the conclusion. **Bounded is not small:**
 * every favourite is a catalog meal, so twenty favourites mounted twenty remote TheMealDB
 * photographs at once against a bound of 200, and `loading="lazy"` cannot help — react-native-web
 * 0.21.2 requests the bytes from a detached `new window.Image()` the moment an `<Image>` mounts, so
 * mounting the row *is* the request and the only deferral available is not building the row.
 *
 * The nesting hazard is real and is the reason the list is at the ROOT rather than one per section:
 *
 *  - a `FlatList` inside each section is the nested case, and react-native-web 0.21.2 ships the
 *    warning about it **commented out** (`vendor/react-native/VirtualizedList/index.js`, pending
 *    necolas/react-native-web#2239), so it would arrive with no diagnostic at all;
 *  - `_isNestedWithSameOrientation()` tests a context a plain `ScrollView` does not provide, so the
 *    inner list would believe it is top-level and keep its own `_scrollMetrics`;
 *  - `Saved.dom.test.tsx` asserts that the scrolling element is **this** one, by identity.
 *
 * A `SectionList` is React Native's own recommended "another VirtualizedList-backed container" and
 * a framework primitive rather than a seventeenth TSD §6.7 component. The `Sheet` is its sibling
 * inside a plain `View`, which provides no scroll context and therefore adds no nesting.
 *
 * **No `initialNumToRender` is set here, deliberately.** No document sets a render budget for Saved,
 * and Explore's eight has its own reasoning in its own file for rows of a different height. So the
 * library's own default applies — `initialNumToRenderOrDefault` in
 * `vendor/react-native/VirtualizedList/index.js` returns 10 — a figure read from the code rather
 * than a threshold this project invented.
 *
 * **What windowing costs, stated rather than buried.** A section header is a cell, so a header far
 * down a long first section is not mounted at the first paint; in a browser it mounts as the user
 * scrolls to it. T-17-02's four combinations cannot be bitten by that — an empty, loading or failed
 * section contributes two cells, so the other header is always inside the first window — but a
 * `recovered` notice in the SECOND section of a user with nine or more favourites is now spoken
 * when they reach it rather than on arrival.
 */

import { useCallback, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { SectionList, View } from 'react-native';
import type { SectionListData, SectionListRenderItemInfo } from 'react-native';
import { AccessibleButton, AppText, Sheet } from '../../shared/components/index.js';
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
import { CustomRowView, CustomSectionHeader, customRowKey, customRows } from './CustomSection.js';
import type { CustomRow } from './CustomSection.js';
import {
  FavoriteRowView,
  FavoritesSectionFooter,
  FavoritesSectionHeader,
  favoriteRowKey,
  favoriteRows,
} from './FavoritesSection.js';
import type { FavoriteRow } from './FavoritesSection.js';

/**
 * One row of either section.
 *
 * A single `SectionList` means one `renderItem` and one `keyExtractor` for both kinds of row, so the
 * two are a tagged union rather than two shapes to tell apart by their fields. Each arm's key and
 * its renderer stay in the section's own file; only the dispatch is here.
 */
type SavedRow = FavoriteRow | CustomRow;

/** `SectionT` — the discriminator the three render callbacks switch on. */
interface SavedSection {
  readonly key: 'favorites' | 'custom';
}

type SavedSectionData = SectionListData<SavedRow, SavedSection>;

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

  /**
   * Which orphan the user has asked to remove, pending confirmation.
   *
   * **An orphan removal is confirmed, and it is the most irreversible removal in the app.** PRD
   * FR-014 requires destructive actions to confirm first, and un-favouriting an ordinary meal is
   * cheap to undo — open it again and tap the heart. This one cannot be undone at all: the catalog
   * no longer has the record, so there is no screen anywhere in the app that can reach it to
   * re-favourite it, and only a hand-run reseed could bring it back. A single id is still the
   * user's choice, and "small" is not the same as "reversible".
   *
   * It lives here rather than in `FavoritesSection` because the button that sets it and the list it
   * removes from are now two different render callbacks of one `SectionList`.
   */
  const [pendingForget, setPendingForget] = useState<string | null>(null);

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

  const closeSheet = useCallback(() => {
    setPendingForget(null);
  }, []);

  const confirmForget = useCallback(() => {
    if (pendingForget !== null) {
      favoritesDispatch(favoritesActions.remove(pendingForget));
    }
    setPendingForget(null);
  }, [pendingForget, favoritesDispatch]);

  const section = readUnionParam(route.params, 'section', SAVED_SECTIONS) ?? 'favorites';

  const recipes = selectCustomMeals(customMeals);
  const favoritesSection: SavedSectionData = { key: 'favorites', data: favoriteRows(feed) };
  const customSection: SavedSectionData = { key: 'custom', data: customRows(recipes) };

  /**
   * **The section `key`s carry the identity the two elements used to carry.**
   *
   * `section` decides which of the two comes first, so a swap reorders the list's children. The
   * flattened cells are keyed `'<section key>:header'`, `'<section key>:footer'` and
   * `'<section key>:<row key>'` (`VirtualizedSectionList`'s `_subExtractor`), so React reorders
   * keyed children and moves the DOM nodes rather than rebuilding them. That matters for more than
   * churn: since P23 both sections carry `role="alert"` notices, and an alert is re-spoken every
   * time its node is inserted — a screen-reader user who switches section would otherwise be
   * interrupted to hear a recovery they have already heard. `Saved.dom.test.tsx` asserts the
   * notice's node identity across a swap.
   */
  const sections: readonly SavedSectionData[] =
    section === 'custom' ? [customSection, favoritesSection] : [favoritesSection, customSection];

  const keyExtractor = useCallback(
    (item: SavedRow): string =>
      item.kind === 'favorite' ? favoriteRowKey(item) : customRowKey(item),
    [],
  );

  const renderRow = useCallback(
    ({ item }: SectionListRenderItemInfo<SavedRow, SavedSection>): ReactElement =>
      item.kind === 'favorite' ? (
        <FavoriteRowView row={item} allergies={allergies} onOpen={openFavorite} />
      ) : (
        <CustomRowView row={item} allergies={allergies} onOpen={openCustom} />
      ),
    [allergies, openFavorite, openCustom],
  );

  const renderSectionHeader = ({ section: data }: { section: SavedSectionData }): ReactElement =>
    data.key === 'favorites' ? (
      <FavoritesSectionHeader
        feed={feed}
        entryStatus={favoritesStatus.entryStatus}
        onRetry={retryFavorites}
      />
    ) : (
      <CustomSectionHeader
        count={recipes.length}
        atBound={selectAtCustomMealsBound(customMeals)}
        entryStatus={customStatus.entryStatus}
        onCreate={createMeal}
      />
    );

  /**
   * Only the favourites section has a footer, and the custom section returning `null` is not a stub.
   *
   * The three things that belong after the rows — the `missing` notice, the orphan rows and the
   * `unresolved` notice — all come from a fetch, and the custom section makes none.
   */
  const renderSectionFooter = ({
    section: data,
  }: {
    section: SavedSectionData;
  }): ReactElement | null =>
    data.key === 'favorites' ? (
      <FavoritesSectionFooter
        feed={feed}
        onRetry={retryFavorites}
        onRequestForget={setPendingForget}
      />
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface.canvas }}>
      <SectionList<SavedRow, SavedSection>
        testID="saved-screen"
        sections={sections}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        renderSectionHeader={renderSectionHeader}
        renderSectionFooter={renderSectionFooter}
        ListHeaderComponent={
          <AppText variant="title" level={1} testID="saved-heading">
            Saved
          </AppText>
        }
        // Both are explicit because their defaults are platform-dependent and this screen must
        // behave the same on the web surface as on a device: sticky headers default to true on iOS
        // and would overlay the rows this design puts under them, and `removeClippedSubviews`
        // defaults to true on Android, where React Native's own documentation warns it can produce
        // missing content. Neither was reachable from a `ScrollView`, so neither is a change.
        stickySectionHeadersEnabled={false}
        removeClippedSubviews={false}
        style={{ backgroundColor: colors.surface.canvas }}
        contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
      />
      <Sheet
        testID="saved-forget-sheet"
        visible={pendingForget !== null}
        onClose={closeSheet}
        title="Remove this favourite?"
      >
        <View style={{ gap: components.card.gap }}>
          <AppText variant="body" tone="secondary">
            This meal is no longer in the catalog, so it cannot be added back later. Removing it
            clears it from your list and changes nothing else.
          </AppText>
          <AccessibleButton
            testID="saved-forget-confirm"
            label="Remove"
            variant="destructive"
            onPress={confirmForget}
          />
          <AccessibleButton
            testID="saved-forget-cancel"
            label="Keep it"
            variant="ghost"
            onPress={closeSheet}
          />
        </View>
      </Sheet>
    </View>
  );
}
