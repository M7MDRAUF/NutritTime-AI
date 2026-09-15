/**
 * The Explore filters, and the one function that turns them into a `MealQuery` (T-13-03).
 *
 * Pure and separate from the screen, because §11.3's rule — every chip maps to an **allowlisted**
 * query parameter — is a claim about this mapping and nothing else. A test can then enumerate every
 * chip and assert the parameter it produces, without rendering anything.
 *
 * **No filtering logic lives here.** The chips choose parameters; the server filters, through the
 * domain. TSD §4.7 gives relevance one implementation and two callers for exactly this reason, and
 * a screen that narrowed the list itself would be a third source of truth that passes its own tests.
 */

import { BUDGET_BANDS, DIET_TAGS, MEAL_PERIODS } from '@nutritime/contracts';
import type { BudgetBand, DietTag, MealPeriod } from '@nutritime/contracts';
import { BUDGET_BAND_MAX_CENTS } from '@nutritime/domain';
import type { MealQuery } from '../../infrastructure/api/routes.js';

export interface ExploreFilters {
  readonly period: MealPeriod | null;
  readonly diet: DietTag | null;
  readonly budget: BudgetBand | null;
}

export const NO_FILTERS: ExploreFilters = { period: null, diet: null, budget: null };

/**
 * How many meals a page holds.
 *
 * 20 is the server's own default (`DEFAULT_PAGE_SIZE`), sent explicitly rather than relied upon:
 * a screen whose page size is whatever the server currently defaults to has no page size of its
 * own, and `FlatList`'s `initialNumToRender` is chosen against this figure.
 */
export const EXPLORE_PAGE_SIZE = 20;

/**
 * Every chip a user can tap, in render order, with the label it shows.
 *
 * One flat list rather than three, so the screen renders chips without knowing how many groups
 * exist and a new group cannot be forgotten in the layout. `group` is what makes a tap exclusive
 * within its row: tapping `lunch` replaces `breakfast` rather than adding to it, because the query
 * parameter holds one value.
 */
export const EXPLORE_CHIPS = [
  ...MEAL_PERIODS.map((value) => ({ group: 'period' as const, value, label: titleCase(value) })),
  ...DIET_TAGS.map((value) => ({ group: 'diet' as const, value, label: dietLabel(value) })),
  ...BUDGET_BANDS.map((value) => ({ group: 'budget' as const, value, label: budgetLabel(value) })),
] as const satisfies ReadonlyArray<{
  readonly group: keyof ExploreFilters;
  readonly value: string;
  readonly label: string;
}>;

export type ExploreChip = (typeof EXPLORE_CHIPS)[number];

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `halal-preference` and `gluten-aware` read badly title-cased with the hyphen left in. */
function dietLabel(value: DietTag): string {
  return titleCase(value.replace('-', ' '));
}

/**
 * The band's ceiling, in whole dollars, as its own label.
 *
 * "Under $9" says what the filter does; "Low" does not, and a user cannot tell "Low" from "Medium"
 * without tapping both. `high` is the exception — it has no ceiling, so it is named by what it
 * means instead.
 */
function budgetLabel(value: BudgetBand): string {
  if (value === 'high') {
    return 'Any price';
  }
  return `Under $${String(Math.round(BUDGET_BAND_MAX_CENTS[value] / 100))}`;
}

/**
 * The filters and the search text as one `MealQuery`.
 *
 * **A null filter contributes no key at all**, rather than a key with an empty value: §11.3 says an
 * unknown parameter is ignored and a wrong-typed one is a 400, so `period=` would be a 400 on a
 * screen where the user simply has not chosen a period.
 *
 * **`budget: 'high'` also contributes nothing**, and that is a judgement rather than an omission.
 * `BUDGET_BAND_MAX_CENTS.high` is `Number.MAX_SAFE_INTEGER` — a real ceiling in the scoring policy,
 * where it means "never over budget", and a meaningless one in a query string. Sending it would
 * work and would put 9007199254740991 in a URL and a log line. "Any price" is the absence of the
 * parameter, which is what the chip's label says.
 */
export function queryFrom(search: string, filters: ExploreFilters, page = 1): MealQuery {
  const trimmed = search.trim();
  return {
    page,
    pageSize: EXPLORE_PAGE_SIZE,
    ...(trimmed === '' ? {} : { query: trimmed }),
    ...(filters.period === null ? {} : { period: filters.period }),
    ...(filters.diet === null ? {} : { diet: filters.diet }),
    ...(filters.budget === null || filters.budget === 'high'
      ? {}
      : { maxPriceCents: BUDGET_BAND_MAX_CENTS[filters.budget] }),
  };
}

/**
 * The identity of a result set: the trimmed search text and the three filters, and nothing else.
 *
 * **Paging needs a name for "the same query", and this is it (R-73).** A page is only ever a page
 * *of something*, so appending page 2 to a list requires knowing that the list it is appended to
 * came from the same request parameters. Without such a name the only available check is "is this
 * the newest request", which is true of a page-2 response that arrives after a filter change.
 *
 * `JSON.stringify` of a fixed-order tuple rather than a joined string, because a delimiter can
 * appear in the search text: `search = 'a|b'` with no filters and `search = 'a'` with a filter
 * spelled `b` would collide under `'|'`. `JSON.stringify` escapes the quote and the separator, so
 * two different inputs cannot produce one key — which is asserted, including on adversarial text.
 *
 * The search text is **trimmed**, so `'rice '` and `'rice'` are one query. That is what stops a
 * trailing space re-issuing the request for the page already loaded and appending it twice.
 */
export function exploreQueryKey(search: string, filters: ExploreFilters): string {
  return JSON.stringify([search.trim(), filters.period, filters.diet, filters.budget]);
}

/**
 * Was that the last page? **Two independent conditions, and both are needed.**
 *
 * `loadedAfter >= total` is the server's own answer — `meals.ts`'s `total` is the count after
 * filtering and before paging, so it is the size of the set being walked.
 *
 * `received < EXPLORE_PAGE_SIZE` is the answer that does not trust it. A `total` larger than the
 * catalogue can actually deliver would leave `loadedAfter < total` true forever, and a list that
 * asks for the next page forever is a request loop, not a bug a user can wait out. A short page —
 * an empty one included — has no successor whatever `total` claims.
 *
 * Neither condition alone is satisfied by a constant, which is why both are asserted separately.
 */
export function isLastPage(received: number, loadedAfter: number, total: number): boolean {
  return received < EXPLORE_PAGE_SIZE || loadedAfter >= total;
}

/** Tapping the chip that is already on turns it off — a filter must be removable by the same tap. */
export function toggleChip(filters: ExploreFilters, chip: ExploreChip): ExploreFilters {
  const current: string | null = filters[chip.group];
  const next = current === chip.value ? null : chip.value;
  return { ...filters, [chip.group]: next };
}

export function isChipSelected(filters: ExploreFilters, chip: ExploreChip): boolean {
  return filters[chip.group] === chip.value;
}

export function activeFilterCount(filters: ExploreFilters): number {
  return [filters.period, filters.diet, filters.budget].filter((one) => one !== null).length;
}
