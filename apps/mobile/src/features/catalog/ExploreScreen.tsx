/**
 * Explore — the tracer slice (T-13-01 … T-13-05).
 *
 * TSD §6.8: data is `GET /meals`, states are loading, empty and local-only. This screen is the
 * first one that runs the whole vertical — device, context, API client, HTTP, domain, catalog — and
 * it is built single-threaded on purpose, so that when it breaks it is obvious which layer broke.
 *
 * **It filters nothing and ranks nothing.** Chips choose query parameters, the server filters, and
 * relevance comes from `queryMeals` in the domain with one implementation and two callers
 * (TSD §4.7). A screen that narrowed its own list would be a third source of truth that agreed with
 * neither, and it would pass its own tests while doing it.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { MEAL_PERIODS } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { formatMoney } from '@nutritime/domain';
import {
  AppText,
  Chip,
  EmptyState,
  ErrorState,
  OfflineState,
  MealCard,
  SearchField,
} from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { readStringParam, readUnionParam } from '../../navigation/routes.js';
import {
  EXPLORE_CHIPS,
  NO_FILTERS,
  activeFilterCount,
  isChipSelected,
  toggleChip,
} from './exploreFilters.js';
import type { ExploreFilters } from './exploreFilters.js';
import { useMealSearch } from './useMealSearch.js';

/**
 * How many rows `FlatList` builds before the first paint.
 *
 * Eight rather than the page's twenty: a card is tall, so twenty is more than any phone shows and
 * building them all is work the user waits through for nothing. `windowSize` keeps two screens of
 * rows either side, which is what stops a fast scroll showing blanks.
 */
const INITIAL_ROWS = 8;

export interface ExploreScreenProps extends ScreenProps<'Explore'> {
  /** Injected in tests so the 300 ms debounce is not waited out in real time. */
  readonly debounceMs?: number;
}

export function ExploreScreen({ route, navigation, debounceMs }: ExploreScreenProps): ReactNode {
  const client = useApiClient();
  const { colors, components, isLargeText } = useTheme();

  /**
   * Deep-link params seed the initial state and are then owned by the screen.
   *
   * `ExploreParams` carries `query` and `period` (TSD §6.2), so `nutritime://explore?query=rice`
   * has to arrive in the search box. Read once as the initial value rather than tracked: a screen
   * that re-derived its state from `route.params` on every render would fight the user's typing.
   * Both initialisers are lazy for that reason — the URL is read at mount and never again.
   *
   * **Read through the route table's own readers, never off `route.params` as typed** (TSD §6.2,
   * T-22-05). Both of these are *query* params, so `?query=a&query=b` parses to a `string[]` where
   * the param list says `string` — a value the type system never saw. `readStringParam` refuses an
   * array rather than joining it or taking the first, because there is no honest single answer to
   * which one the user meant; an empty box is honest, a search for `a,b` is not. `period` is a
   * union, so it goes through `readUnionParam` against `MEAL_PERIODS`: `?period=brunch` has to be
   * refused too, not only `?period=lunch&period=dinner`, or an unknown value would reach
   * `queryFrom` and §11.3 makes a wrong-typed parameter a 400 — the screen would show the user an
   * error for a filter they never chose. Plan §20: "Array-valued or unexpected params rejected,
   * never coerced."
   */
  const [search, setSearch] = useState(() => readStringParam(route.params, 'query') ?? '');
  const [filters, setFilters] = useState<ExploreFilters>(() => ({
    ...NO_FILTERS,
    period: readUnionParam(route.params, 'period', MEAL_PERIODS) ?? null,
  }));

  const state = useMealSearch({
    client,
    search,
    filters,
    ...(debounceMs === undefined ? {} : { debounceMs }),
  });

  const openMeal = useCallback(
    (meal: Meal) => {
      navigation.navigate('MealDetails', { mealId: meal.id, origin: 'explore' });
    },
    [navigation],
  );

  /**
   * `keyExtractor` returns the meal's id, never the index.
   *
   * An index key makes React reuse the row that happens to sit in position 3 when the list
   * changes, so a search that reorders results shows the previous meal's image under the new
   * meal's name until the image loads. The id is stable and unique — `buildCatalog` refuses a
   * duplicate at boot, so this cannot collide.
   */
  const keyExtractor = useCallback((meal: Meal) => meal.id, []);

  const renderRow = useCallback(
    ({ item }: ListRenderItemInfo<Meal>) => <MealRow meal={item} onOpen={openMeal} />,
    [openMeal],
  );

  const chips = useMemo(
    () => (
      // Wraps rather than scrolls horizontally: a row of chips that scrolls hides the filters at
      // its end, and at a 2x font scale there is no row long enough to hold them anyway.
      <View
        testID="explore-filters"
        accessibilityRole="toolbar"
        accessibilityLabel={`Filters, ${String(activeFilterCount(filters))} active`}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}
      >
        {EXPLORE_CHIPS.map((chip) => (
          <Chip
            key={`${chip.group}-${chip.value}`}
            testID={`chip-${chip.group}-${chip.value}`}
            label={chip.label}
            toggle
            selected={isChipSelected(filters, chip)}
            onPress={() => {
              setFilters((current) => toggleChip(current, chip));
            }}
          />
        ))}
      </View>
    ),
    [filters, components.card.gap],
  );

  return (
    <View
      testID="explore-screen"
      style={{
        backgroundColor: colors.surface.canvas,
        flex: 1,
        gap: components.card.gap,
        padding: components.card.padding,
      }}
    >
      <SearchField
        testID="explore-search"
        value={search}
        onChangeText={setSearch}
        placeholder="Search meals and ingredients"
        accessibilityLabel="Search meals"
      />

      {chips}

      {state.kind === 'loading' ? (
        // No spinner and no skeleton list: PRD §12 wants the message to say what is happening, and
        // a skeleton that turns out to be an empty result has told the user something false.
        <AppText variant="body" tone="secondary" testID="explore-loading">
          Loading meals…
        </AppText>
      ) : null}

      {state.kind === 'unreachable' ? (
        <OfflineState
          testID="explore-offline"
          stillAvailable="Your saved meals and your own recipes are on this device and still work."
        />
      ) : null}

      {state.kind === 'failed' ? (
        <ErrorState
          testID="explore-error"
          description="The meal list could not be loaded."
          stillAvailable="Your saved meals and your own recipes still work."
          onRetry={() => {
            // Re-running the effect without changing the query: nudging `search` through its own
            // value would be a no-op, so the retry re-mounts the list by identity instead.
            setSearch((current) => current);
            setFilters((current) => ({ ...current }));
          }}
        />
      ) : null}

      {state.kind === 'loaded' && state.meals.length === 0 ? (
        <EmptyState
          testID="explore-empty"
          description={
            activeFilterCount(filters) > 0 || search.trim() !== ''
              ? 'No meals match this search and these filters. Try removing one.'
              : 'The catalog is empty.'
          }
        />
      ) : null}

      {state.kind === 'loaded' && state.meals.length > 0 ? (
        <FlatList
          testID="explore-list"
          data={state.meals}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          initialNumToRender={INITIAL_ROWS}
          windowSize={isLargeText ? 3 : 5}
          maxToRenderPerBatch={INITIAL_ROWS}
          removeClippedSubviews={false}
          ItemSeparatorComponent={null}
          contentContainerStyle={{ gap: components.card.gap }}
          accessibilityLabel={`${String(state.total)} meals`}
        />
      ) : null}
    </View>
  );
}

interface MealRowProps {
  readonly meal: Meal;
  readonly onOpen: (meal: Meal) => void;
}

/**
 * One row, actually memoised (T-13-04).
 *
 * `MealCard` takes six props and a handler, so without `memo` every visible row re-renders
 * whenever the screen does — which is on every keystroke, since `search` is screen state.
 *
 * The memo boundary has to sit HERE rather than around `MealCard` at the call site, because
 * `formatMoney` and the `onPress` closure both allocate: formatting inside the parent would hand
 * `MealCard` a fresh `priceLabel` string and a fresh function on every render and defeat the memo
 * it was supposed to be protected by. `onOpen` is the screen's `useCallback`, so it is stable
 * across keystrokes, and `meal` is a catalog object the list re-uses by reference — so the default
 * shallow comparison is exactly right and no custom comparator is needed.
 */
const MealRow = memo(function MealRow({ meal, onOpen }: MealRowProps): ReactNode {
  const onPress = useCallback(() => {
    onOpen(meal);
  }, [meal, onOpen]);

  return (
    <MealCard
      testID={`meal-${meal.id}`}
      name={meal.name}
      imageUrl={meal.imageUrl}
      // `formatMoney` is the domain's, so the catalog screen and the details screen cannot
      // disagree about how $8.50 is written.
      priceLabel={formatMoney(meal.price)}
      preparationMinutes={meal.preparationMinutes}
      tags={meal.dietTags}
      unavailable={!meal.available}
      onPress={onPress}
    />
  );
});
