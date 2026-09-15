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
 *
 * **And it does not exclude a meal for a declared allergy either — that is the design, not a gap**
 * (T-24-03). PRD FR-010 gives this screen "searches by meal name and filters by meal period, diet
 * tag, and price band" and no allergen clause; FR-007's allergen rejection is scoped to
 * *recommendations*; FR-011 puts the "allergen notices" on the detail screen. `TSD.md` §8.4 case 2
 * says a declared peanut allergy keeps a meal "off Home and out of Explore", which contradicts all
 * three — and PRD outranks TSD. What FR-007 does require of the UI is a *general safety
 * disclaimer*, which is the surface added below.
 *
 * **A row-level allergen notice would be the honest next step and it is a stop condition here.**
 * `MealCard`'s props are fixed by TSD §6.7 — that is why R-56 (`IconButton` wanting
 * `accessibilityState`) is an open user decision rather than a task — so a per-row "contains a
 * declared allergen" flag needs a §6.7 props amendment before any code. It is recorded, not built.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, View } from 'react-native';
import type { ListRenderItemInfo } from 'react-native';
import { MEAL_PERIODS } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { formatMoney } from '@nutritime/domain';
import {
  AccessibleButton,
  AppText,
  Chip,
  EmptyState,
  ErrorState,
  OfflineState,
  MealCard,
  SearchField,
  StatusMessage,
} from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { readStringParam, readUnionParam } from '../../navigation/routes.js';
import { MEAL_QUERY_MAX_LENGTH } from '@nutritime/contracts';
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
   *
   * **The length is bounded here too, and that is R-74's second door (closed at P28).** A user
   * cannot type past `MEAL_QUERY_MAX_LENGTH` — `SearchField` slices `onChangeText` — but a URL
   * bypasses the field entirely, and a 101-character `?query=` was measured reaching the request
   * intact (`param=101 sent=101`), answering `400 invalid_request` and rendering an error state
   * whose retry repeated the same rejected request. So the user met a server error for a length
   * the interface never let them reach.
   *
   * **Truncated, not refused, because the two doors must agree.** The 101st character a user types
   * is dropped; the 101st character a link carries is now dropped the same way, so one input has
   * one answer. An array param stays a *refusal* for the opposite reason: there is no honest single
   * answer to which of `a` and `b` was meant, while there is an honest answer to a too-long string
   * and the field already gives it. `storage/definitions.ts` split the same way on its own
   * evidence — refused on write, truncated on read — and a URL is a read.
   */
  const [search, setSearch] = useState(() =>
    (readStringParam(route.params, 'query') ?? '').slice(0, MEAL_QUERY_MAX_LENGTH),
  );
  const [filters, setFilters] = useState<ExploreFilters>(() => ({
    ...NO_FILTERS,
    period: readUnionParam(route.params, 'period', MEAL_PERIODS) ?? null,
  }));

  const { state, appending, canLoadMore, loadMore, retry } = useMealSearch({
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

  /**
   * The affordance R-73 says is missing, and it is a BUTTON as well as an `onEndReached`.
   *
   * `FlatList` fires `onEndReached` from scroll and layout metrics, so paging by scroll alone puts
   * the two thirds of the catalogue past page 1 behind a gesture: a keyboard user, a screen-reader
   * user moving by element, and the jsdom suite all reach the list's end and stop. A footer control
   * is reachable by every one of them, and it is the seam that makes paging testable without a
   * faked scroll. `loading` rather than a second row, because `AccessibleButton` keeps its label,
   * sets `aria-busy` and drops `onPress` — so it announces "busy" instead of losing its accessible
   * name at the moment the user is waiting on it, and a second press cannot double-request.
   */
  const footer = useMemo(() => {
    if (!canLoadMore && !appending) {
      return null;
    }
    return (
      <View style={{ paddingTop: components.card.gap }}>
        <AccessibleButton
          testID="explore-more"
          label="Show more meals"
          accessibilityHint="Adds the next page of meals to the list."
          loading={appending}
          onPress={loadMore}
          fullWidth
        />
      </View>
    );
  }, [canLoadMore, appending, loadMore, components.card.gap]);

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

      {/*
        **FR-007's safety disclaimer, which is what T-24-03 actually left unmet.**
        PRD FR-007: "The UI carries a general safety disclaimer." "disclaimer" appears once in the
        PRD, nowhere in SDD or TSD, and `Plan.md` scopes it to T-15-06 — Home. So Explore had none,
        on the one screen that shows every record in the catalogue.

        Above the results, because a qualification below them qualifies nothing; unconditional,
        because it is a property of the screen and not of a response. The title and the closing
        sentence are `HomeScreen.tsx`'s — one voice for one requirement. The middle clause is NOT:
        Home says suggestions "are filtered using the allergies you set", which is true there and
        false here, and a screen claiming a filter it does not apply is worse than a silent one.
        No `announceOnMount`, for Home's reason: it is there before the user is, so it reads in
        document order and an alert would interrupt for something that has not changed.
      */}
      <StatusMessage
        testID="explore-disclaimer"
        tone="info"
        icon="info"
        title="Check the label if it matters"
        description="Explore lists the whole catalog, so these meals are not filtered by the allergies you set, and the catalog is neither complete nor verified. This is not medical advice."
      />

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
          // **This handler used to do nothing, and its comment argued for it** (BRIEF §6.1j): it
          // said the retry "re-mounts the list by identity" and replaced `filters` with a fresh
          // object, but `useMealSearch`'s effect never depended on that object — only on the search
          // text and the three filter primitives, which the retry left untouched. The hook now owns
          // a retry that the effect watches, and that resets to the first page.
          onRetry={retry}
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
          /*
            **`flex: 1` so the list claims what is left rather than its own content's height.**

            Without it react-native-web gives the scroller `flex: 1 1 auto`, a basis of its own
            CONTENT — the paged catalogue, some 3 500 px — which in a cramped column is shrunk from
            rather than grown into. `flex: 1` normalises to `1 1 0%`, which is the shape a filling
            pane should have.

            **It is NOT what makes the list zero pixels tall at 320 px (R-82), and the first
            version of this comment claimed it was.** Measured after the change: the basis really
            is `0%` and `flex-grow` really is 1, and the height is still 0 — because there is
            nothing left to grow into. `explore-screen` is **513 px** at 320 × 568 (568 less the
            55 px bar) and its three `flex-grow: 0` siblings already exceed it: search **50**,
            `explore-filters` **328**, `explore-disclaimer` **258** — **636 in 513**. A filling
            pane with a zero basis gets zero when the fixed siblings have taken everything, and the
            list renders `aria-label="20 meals"` at height 0: present, populated, announced, and
            invisible.

            So this line is right and insufficient, and the remainder is R-82: a design question
            about how much of a 568 px screen a notice and three chip groups may take, not a flex
            bug. The notice cannot simply move into `ListHeaderComponent` — it is required in every
            state, including before the first response, where there is no list to put a header on.
          */
          style={{ flex: 1 }}
          data={state.meals}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          initialNumToRender={INITIAL_ROWS}
          windowSize={isLargeText ? 3 : 5}
          maxToRenderPerBatch={INITIAL_ROWS}
          removeClippedSubviews={false}
          ItemSeparatorComponent={null}
          contentContainerStyle={{ gap: components.card.gap }}
          /*
            **The count announced is the count in the list, never the catalogue's** (R-73).

            This read `state.total` — the server's count after filtering and BEFORE paging, so
            sixty over a twenty-row list. To the one user who cannot see the list's length for
            themselves that is a statement of fact, and it was false by forty. `state.meals.length`
            is what has been loaded and so what moving through the list reaches. It is still the
            RESULT-SET size and not the DOM row count: eight rows stay mounted, and announcing
            eight would be the same defect in the other direction. R-45 names that distinction.
          */
          accessibilityLabel={`${String(state.meals.length)} meals`}
          /*
            `onEndReached` pages on scroll; the footer button pages for everyone else. Both go
            through `loadMore`, a no-op unless another page exists and none is in flight, so the
            repeated fire `FlatList` is known for cannot double-request.

            **Paging does not move the render budget.** `data` grows to sixty; `initialNumToRender`
            and `maxToRenderPerBatch` stay at eight, so what is MOUNTED — and the number of remote
            images requested — is bounded by the window, not the result set (R-45, T-22-08).
          */
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={footer}
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
