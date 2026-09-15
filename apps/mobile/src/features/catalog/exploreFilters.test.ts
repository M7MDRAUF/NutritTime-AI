import { describe, expect, it } from 'vitest';
import { BUDGET_BANDS, DIET_TAGS, MEAL_PERIODS } from '@nutritime/contracts';
import { BUDGET_BAND_MAX_CENTS } from '@nutritime/domain';
import {
  EXPLORE_CHIPS,
  EXPLORE_PAGE_SIZE,
  NO_FILTERS,
  activeFilterCount,
  exploreQueryKey,
  isChipSelected,
  isLastPage,
  queryFrom,
  toggleChip,
} from './exploreFilters.js';

/**
 * T-13-03's acceptance is "each chip maps to an allowlisted parameter", and that is a claim about
 * this module alone — so it is asserted here, without rendering anything.
 *
 * The allowlist is `QUERY_KEYS` in `apps/server/src/routes/meals.ts`: page, pageSize, period, diet,
 * maxPriceCents, query. §11.3 ignores an unknown parameter and answers 400 for a wrong-typed one,
 * so a chip that produced `period=` on a screen where the user chose no period would be a 400.
 */

const ALLOWLISTED = ['page', 'pageSize', 'period', 'diet', 'maxPriceCents', 'query'] as const;

describe('the chip set', () => {
  it('covers every period, diet and budget the contracts declare, and nothing else', () => {
    // Derived from the contracts rather than listed, so a new `DietTag` appears as a chip without
    // anyone remembering to add one — and a chip for a value that no longer exists fails here.
    const byGroup = (group: string) =>
      EXPLORE_CHIPS.filter((chip) => chip.group === group).map((chip) => chip.value);
    expect(byGroup('period')).toStrictEqual([...MEAL_PERIODS]);
    expect(byGroup('diet')).toStrictEqual([...DIET_TAGS]);
    expect(byGroup('budget')).toStrictEqual([...BUDGET_BANDS]);
    expect(EXPLORE_CHIPS).toHaveLength(
      MEAL_PERIODS.length + DIET_TAGS.length + BUDGET_BANDS.length,
    );
  });

  it('labels a budget band by its ceiling, not by its name', () => {
    // "Low" and "Medium" are indistinguishable without tapping both. The ceiling is the fact.
    const labels = EXPLORE_CHIPS.filter((chip) => chip.group === 'budget').map(
      (chip) => chip.label,
    );
    expect(labels).toStrictEqual(['Under $9', 'Under $16', 'Any price']);
  });

  it('reads a hyphenated diet as words', () => {
    const labels = EXPLORE_CHIPS.filter((chip) => chip.group === 'diet').map((chip) => chip.label);
    expect(labels).toContain('Halal preference');
    expect(labels).toContain('Gluten aware');
    for (const label of labels) {
      expect(label).not.toContain('-');
    }
  });
});

describe('queryFrom', () => {
  it('sends only allowlisted keys, for every combination of chips', () => {
    // Exhaustive rather than sampled: 4 periods x 5 diets x 3 budgets x 2 search states = 120
    // queries, and a stray key in any of them is a 400 the user would see as "nothing matched".
    for (const period of [...MEAL_PERIODS, null] as const) {
      for (const diet of [...DIET_TAGS, null] as const) {
        for (const budget of [...BUDGET_BANDS, null] as const) {
          for (const search of ['', 'rice']) {
            const query = queryFrom(search, { period, diet, budget });
            for (const key of Object.keys(query)) {
              expect(ALLOWLISTED, `${key} is not allowlisted`).toContain(key);
            }
          }
        }
      }
    }
  });

  it('omits a key entirely rather than sending an empty value', () => {
    const query = queryFrom('', NO_FILTERS);
    expect(query).toStrictEqual({ page: 1, pageSize: EXPLORE_PAGE_SIZE });
    // Not `{ period: undefined }`: `Object.keys` would still list it and `encodeMealQuery` would
    // have to know to skip it.
    expect(Object.keys(query)).not.toContain('period');
    expect(Object.keys(query)).not.toContain('query');
  });

  it('trims the search text and drops it when only whitespace remains', () => {
    expect(queryFrom('  rice  ', NO_FILTERS).query).toBe('rice');
    expect(Object.keys(queryFrom('   ', NO_FILTERS))).not.toContain('query');
  });

  it('maps low and medium to their ceilings in cents', () => {
    expect(queryFrom('', { ...NO_FILTERS, budget: 'low' }).maxPriceCents).toBe(900);
    expect(queryFrom('', { ...NO_FILTERS, budget: 'medium' }).maxPriceCents).toBe(1600);
  });

  it('sends NO maxPriceCents for the high band', () => {
    // `BUDGET_BAND_MAX_CENTS.high` is `Number.MAX_SAFE_INTEGER` - a real ceiling in the scoring
    // policy, where it means "never over budget", and a meaningless one in a URL. Asserted rather
    // than left to a reader, because sending it would WORK and would put 9007199254740991 in a
    // query string and a log line.
    expect(BUDGET_BAND_MAX_CENTS.high).toBe(Number.MAX_SAFE_INTEGER);
    const query = queryFrom('', { ...NO_FILTERS, budget: 'high' });
    expect(Object.keys(query)).not.toContain('maxPriceCents');
  });

  it('always sends its own page size rather than relying on the server default', () => {
    // A screen whose page size is whatever the server currently defaults to has no page size of
    // its own, and `initialNumToRender` is chosen against this figure.
    expect(queryFrom('x', NO_FILTERS).pageSize).toBe(EXPLORE_PAGE_SIZE);
    expect(queryFrom('x', NO_FILTERS, 3).page).toBe(3);
  });
});

describe('exploreQueryKey', () => {
  /**
   * The key is what makes "append page 2 to *this* list" a checkable instruction (R-73), so a
   * collision is not a tidy-up issue — it is two queries' meals in one list.
   */
  it('gives every distinct search-and-filter combination its own key', () => {
    const keys = new Set<string>();
    let combinations = 0;
    for (const period of [...MEAL_PERIODS, null] as const) {
      for (const diet of [...DIET_TAGS, null] as const) {
        for (const budget of [...BUDGET_BANDS, null] as const) {
          for (const search of ['', 'rice', 'ricotta']) {
            keys.add(exploreQueryKey(search, { period, diet, budget }));
            combinations += 1;
          }
        }
      }
    }
    // 5 periods x 6 diets x 4 budgets x 3 searches, all distinct. A key that ignored one of its
    // four inputs would collapse this count and fail here.
    expect(combinations).toBe(
      (MEAL_PERIODS.length + 1) * (DIET_TAGS.length + 1) * (BUDGET_BANDS.length + 1) * 3,
    );
    expect(keys.size).toBe(combinations);
  });

  it('cannot be collided by a separator in the search text', () => {
    /**
     * The adversarial case, and the reason the key is `JSON.stringify` of a tuple rather than a
     * joined string: under `'|'` the search `'a|b'` with no filters and the search `'a'` with a
     * filter spelled `'b'` produce the same characters. The inputs below are written to that
     * attack shape rather than sampled from what the chips happen to produce (BRIEF §6.3).
     */
    const hostile = ['a|b', 'a', 'a"', '","', '],[', 'null', ''];
    const keys = hostile.map((search) => exploreQueryKey(search, NO_FILTERS));
    expect(new Set(keys).size).toBe(hostile.length);
    // And a value that looks like a filter in the text is not one.
    expect(exploreQueryKey('a|b', NO_FILTERS)).not.toBe(
      exploreQueryKey('a', { ...NO_FILTERS, diet: DIET_TAGS[0] ?? 'vegan' }),
    );
  });

  it('treats a trailing space as the same query, because `queryFrom` does', () => {
    // Otherwise `'rice '` is a new query whose page-2 request is issued a second time and folded
    // into the same list. `queryFrom` has always trimmed; only the key had to agree.
    expect(exploreQueryKey('rice ', NO_FILTERS)).toBe(exploreQueryKey('rice', NO_FILTERS));
    expect(exploreQueryKey('  rice  ', NO_FILTERS)).toBe(exploreQueryKey('rice', NO_FILTERS));
    expect(exploreQueryKey('rice', NO_FILTERS)).not.toBe(exploreQueryKey('rico', NO_FILTERS));
  });
});

describe('isLastPage', () => {
  /**
   * Two independent conditions, asserted independently — a single `||` where one side is never
   * exercised is the "control that passes under the mutation" shape (BRIEF §6.2).
   */
  it('says yes on a short page even when the total claims more', () => {
    // The condition that does not trust `total`. A `total` larger than the catalogue can deliver
    // would otherwise leave `loaded < total` true forever, and a list that asks for the next page
    // forever is a request loop rather than a bug a user can wait out.
    expect(isLastPage(EXPLORE_PAGE_SIZE - 1, 19, 999)).toBe(true);
    expect(isLastPage(0, 20, 999)).toBe(true);
  });

  it('says yes on a full page once the total is reached', () => {
    // The server's own answer: 60 records, 20 per page, the third page is the last.
    expect(isLastPage(EXPLORE_PAGE_SIZE, 60, 60)).toBe(true);
    expect(isLastPage(EXPLORE_PAGE_SIZE, 61, 60)).toBe(true);
  });

  it('says no while a full page has been delivered and the total is not reached', () => {
    // The case both conditions have to leave open, or nothing pages at all.
    expect(isLastPage(EXPLORE_PAGE_SIZE, 20, 60)).toBe(false);
    expect(isLastPage(EXPLORE_PAGE_SIZE, 40, 60)).toBe(false);
  });
});

describe('toggleChip', () => {
  const period = EXPLORE_CHIPS.find((chip) => chip.group === 'period');
  const otherPeriod = EXPLORE_CHIPS.filter((chip) => chip.group === 'period')[1];
  const diet = EXPLORE_CHIPS.find((chip) => chip.group === 'diet');

  it('selects, then deselects on a second tap of the same chip', () => {
    // A filter a user cannot remove with the control that applied it is a trap.
    if (period === undefined) {
      throw new Error('no period chip');
    }
    const on = toggleChip(NO_FILTERS, period);
    expect(isChipSelected(on, period)).toBe(true);
    expect(isChipSelected(toggleChip(on, period), period)).toBe(false);
  });

  it('replaces within a group, because the parameter holds one value', () => {
    if (period === undefined || otherPeriod === undefined) {
      throw new Error('need two period chips');
    }
    const second = toggleChip(toggleChip(NO_FILTERS, period), otherPeriod);
    expect(isChipSelected(second, otherPeriod)).toBe(true);
    expect(isChipSelected(second, period)).toBe(false);
    expect(activeFilterCount(second)).toBe(1);
  });

  it('leaves the other groups alone', () => {
    if (period === undefined || diet === undefined) {
      throw new Error('need a period and a diet chip');
    }
    const both = toggleChip(toggleChip(NO_FILTERS, period), diet);
    expect(activeFilterCount(both)).toBe(2);
    expect(isChipSelected(both, period)).toBe(true);
    expect(isChipSelected(both, diet)).toBe(true);
  });
});
