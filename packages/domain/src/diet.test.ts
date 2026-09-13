import { describe, expect, it } from 'vitest';
import { isDietCompatible, unmetDietRequirement } from './diet.js';
import type { DietTag } from '@nutritime/contracts';

/**
 * Plan.md 19.3 requires all 25 user-diet x meal-tag pairs asserted, and both asymmetries
 * named. The 25 are kept as a matrix rather than 25 hand-written cases so that the policy is
 * readable in one glance and an edit to SATISFIED_BY that is not also made here fails cell by
 * cell, naming the exact pair it changed.
 */

const USER_DIETS: readonly DietTag[] = [
  'regular',
  'vegetarian',
  'vegan',
  'halal-preference',
  'gluten-aware',
];

/** The five columns of a matrix row, in the order documented on COMPATIBILITY. */
type MatrixRow = readonly [boolean, boolean, boolean, boolean, boolean];

/**
 * The full 5x5 matrix, every cell written out. Rows are the user's diet; columns are the
 * single tag the meal carries, always in this order:
 *
 *   regular | vegetarian | vegan | halal-preference | gluten-aware
 *
 * Read down the `vegan` column to see asymmetry 1 and 2 at once: a vegan meal is accepted by
 * a vegetarian and by a halal-preference user, while the `vegetarian` column is accepted by
 * neither a vegan nor a halal-preference user.
 */
const COMPATIBILITY: Record<DietTag, MatrixRow> = {
  regular: [true, true, true, true, true],
  vegetarian: [false, true, true, false, false],
  vegan: [false, false, true, false, false],
  'halal-preference': [false, false, true, true, false],
  'gluten-aware': [false, false, false, false, true],
};

type DietPair = [userDiet: DietTag, mealTag: DietTag, compatible: boolean];

/**
 * The matrix flattened to 25 cases. The row is destructured rather than indexed: under
 * `noUncheckedIndexedAccess`, `row[column]` on a fixed-length tuple is `boolean | undefined`,
 * while destructuring keeps each cell a plain `boolean`.
 */
const ALL_PAIRS: readonly DietPair[] = USER_DIETS.flatMap((userDiet): DietPair[] => {
  const [regular, vegetarian, vegan, halalPreference, glutenAware] = COMPATIBILITY[userDiet];
  return [
    [userDiet, 'regular', regular],
    [userDiet, 'vegetarian', vegetarian],
    [userDiet, 'vegan', vegan],
    [userDiet, 'halal-preference', halalPreference],
    [userDiet, 'gluten-aware', glutenAware],
  ];
});

/** Every diet except `regular`, i.e. every diet that actually carries a requirement. */
const RESTRICTED_DIETS: readonly DietTag[] = [
  'vegetarian',
  'vegan',
  'halal-preference',
  'gluten-aware',
];

describe('the 25 user-diet x meal-tag pairs', () => {
  it('covers all five diets against all five single-tag meals', () => {
    expect(ALL_PAIRS).toHaveLength(25);
  });

  it.each(ALL_PAIRS)(
    'a %s user and a meal tagged %s are compatible: %s',
    (userDiet, mealTag, compatible) => {
      expect(isDietCompatible(userDiet, [mealTag])).toBe(compatible);
    },
  );
});

describe('vegan satisfies vegetarian, but vegetarian does not satisfy vegan', () => {
  it('a vegetarian user accepts a meal tagged vegan', () => {
    expect(isDietCompatible('vegetarian', ['vegan'])).toBe(true);
  });

  it('a vegan user rejects a meal tagged vegetarian', () => {
    // A vegetarian dish may contain dairy or egg, so the relation does not run both ways.
    expect(isDietCompatible('vegan', ['vegetarian'])).toBe(false);
  });
});

describe('vegan satisfies halal-preference, but vegetarian does not', () => {
  it('a halal-preference user accepts a meal tagged vegan', () => {
    expect(isDietCompatible('halal-preference', ['vegan'])).toBe(true);
  });

  it('a halal-preference user rejects a meal tagged vegetarian', () => {
    // A vegetarian dish may still carry alcohol or non-halal rennet; a vegan one does not.
    expect(isDietCompatible('halal-preference', ['vegetarian'])).toBe(false);
  });
});

describe('a meal carrying more than one diet tag', () => {
  it('satisfies a vegetarian user when tagged both vegetarian and vegan', () => {
    expect(isDietCompatible('vegetarian', ['vegetarian', 'vegan'])).toBe(true);
  });

  it('needs only one accepted tag, whatever else it carries', () => {
    expect(isDietCompatible('gluten-aware', ['vegan', 'gluten-aware'])).toBe(true);
  });

  it('stays incompatible when none of its tags is accepted', () => {
    expect(isDietCompatible('vegan', ['vegetarian', 'gluten-aware'])).toBe(false);
  });
});

describe('a meal carrying no diet tags at all', () => {
  it('satisfies a regular user, whose requirement list is empty', () => {
    expect(isDietCompatible('regular', [])).toBe(true);
  });

  it.each(RESTRICTED_DIETS)('does not satisfy a %s user', (userDiet) => {
    expect(isDietCompatible(userDiet, [])).toBe(false);
  });
});

describe('unmetDietRequirement', () => {
  it('is empty whenever the meal is already compatible', () => {
    expect(unmetDietRequirement('regular', [])).toEqual([]);
    expect(unmetDietRequirement('vegetarian', ['vegan'])).toEqual([]);
    expect(unmetDietRequirement('gluten-aware', ['gluten-aware'])).toEqual([]);
  });

  it('is empty for a regular user even when the meal carries an unrelated tag', () => {
    expect(unmetDietRequirement('regular', ['vegetarian'])).toEqual([]);
  });

  it('reports the whole requirement rather than the part the meal is missing', () => {
    // A meal tagged `vegetarian` alone would have satisfied a vegetarian user, yet the
    // requirement is still reported whole: this string is shown to the user as "what this
    // meal would need to be", not as a diff.
    expect(unmetDietRequirement('vegetarian', ['gluten-aware'])).toEqual(['vegetarian', 'vegan']);
    expect(unmetDietRequirement('vegan', ['vegetarian'])).toEqual(['vegan']);
    expect(unmetDietRequirement('halal-preference', ['vegetarian'])).toEqual([
      'halal-preference',
      'vegan',
    ]);
    expect(unmetDietRequirement('gluten-aware', [])).toEqual(['gluten-aware']);
  });

  it.each(ALL_PAIRS)(
    'for a %s user and a meal tagged %s, an empty requirement matches compatibility: %s',
    (userDiet, mealTag, compatible) => {
      expect(unmetDietRequirement(userDiet, [mealTag]).length === 0).toBe(compatible);
    },
  );
});
