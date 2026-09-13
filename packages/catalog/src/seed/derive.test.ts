import { describe, expect, it } from 'vitest';
import type { Ingredient } from '@nutritime/contracts';
import { deriveNutrition, indexNutritionSource } from './derive.js';
import type { NutrientRow, NutritionSource } from './usda-dataset.js';

/**
 * T-07-09's acceptance: **one unresolved ingredient yields four `null`s, `origin: unavailable`,
 * and a reason naming the ingredient. No partial sums.**
 *
 * That rule is the whole contract. A partial sum is worse than no number, because it looks
 * complete: "480 kcal" computed from nine of eleven ingredients is not an approximation a
 * reader can discount, and nothing on the screen says so.
 *
 * The fixtures below use round figures so the arithmetic can be checked by eye rather than
 * trusted.
 */

const row = (
  key: string,
  per100g: NutrientRow['per100g'],
  overrides: Partial<NutrientRow> = {},
): NutrientRow => ({
  key,
  description: `${key} (fixture)`,
  usdaCode: '9999',
  fdcId: '123456',
  sourceLabel: 'Fixture',
  per100g,
  ...overrides,
});

const SOURCE: NutritionSource = {
  dataset: 'fixture',
  vintage: '2022-10-28',
  rows: [
    // 100 kcal / 10 g protein / 20 g carbs / 5 g fat per 100 g - deliberately round.
    row('white rice', { kcal: 100, proteinGrams: 10, carbsGrams: 20, fatGrams: 5 }),
    row('butter', { kcal: 700, proteinGrams: 1, carbsGrams: 0, fatGrams: 80 }),
    // Salt: four exact zeroes. The inert case.
    row('salt', { kcal: 0, proteinGrams: 0, carbsGrams: 0, fatGrams: 0 }, { fdcId: null }),
  ],
};

const rows = indexNutritionSource(SOURCE);
const ingredient = (name: string, measure: string): Ingredient => ({ name, measure });

describe('a resolvable meal derives per serving', () => {
  it('scales from per-100 g figures and divides by the authored serving count', () => {
    // 200 g rice = 2 x (100/10/20/5) = 200 kcal, 20 P, 40 C, 10 F. Over 2 servings: halve.
    const result = deriveNutrition([ingredient('white rice', '200g')], 2, rows);
    expect(result.provenance.origin).toBe('usda-derived');
    expect(result.nutrition).toStrictEqual({
      calories: 100,
      proteinGrams: 10,
      carbsGrams: 20,
      fatGrams: 5,
    });
  });

  it('rounds once at the end, not per ingredient', () => {
    // 3 x 33 g of rice is 99 g = 99 kcal exactly; rounding each 33 g to 33 kcal first would
    // also give 99, so use a figure where the difference shows: 10 g = 10 kcal, 7 g = 7 kcal,
    // over 3 servings -> 17/3 = 5.67 -> 6. Per-ingredient rounding gives 3 + 2 = 5.
    const result = deriveNutrition(
      [ingredient('white rice', '10g'), ingredient('white rice', '7g')],
      3,
      rows,
    );
    expect(result.nutrition.calories).toBe(6);
  });

  it('records the dataset and the servings as authored, with no reason', () => {
    const result = deriveNutrition([ingredient('white rice', '100g')], 4, rows);
    expect(result.provenance.dataset).toContain('2022-10-28');
    expect(result.provenance.servings).toBe(4);
    expect(result.provenance.reason).toBeNull();
  });

  it('reports every contributing fdcId and usda code for traceability', () => {
    const result = deriveNutrition(
      [ingredient('white rice', '100g'), ingredient('butter', '50g')],
      1,
      rows,
    );
    expect(result.fdcIds).toStrictEqual(['123456']);
    expect(result.usdaCodes).toStrictEqual(['9999']);
  });
});

describe('all-or-nothing: one failure blanks the whole meal', () => {
  const expectUnavailable = (result: ReturnType<typeof deriveNutrition>, naming: string): void => {
    expect(result.nutrition).toStrictEqual({
      calories: null,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: null,
    });
    expect(result.provenance.origin).toBe('unavailable');
    // `superRefine` forbids a dataset or a serving count on an unavailable record: neither
    // describes a figure that was never produced.
    expect(result.provenance.dataset).toBeNull();
    expect(result.provenance.servings).toBeNull();
    expect(result.provenance.reason).toContain(naming);
  };

  it('blanks all four when ONE ingredient does not resolve, and names it', () => {
    // The other two resolve and would sum to a plausible figure. That figure must not appear.
    expectUnavailable(
      deriveNutrition(
        [
          ingredient('white rice', '100g'),
          ingredient('Bay Leaves', '2'),
          ingredient('butter', '50g'),
        ],
        2,
        rows,
      ),
      'Bay Leaves',
    );
  });

  it('blanks all four when ONE measure does not parse, and names it', () => {
    expectUnavailable(
      deriveNutrition(
        [ingredient('white rice', '100g'), ingredient('butter', '2-3 tbsp')],
        2,
        rows,
      ),
      'butter',
    );
  });

  it('blanks all four when an ingredient is absent from the committed subset', () => {
    // Distinct from "unknown ingredient": the name resolved, so the subset is stale. Saying
    // which is the difference between a fix and a hunt.
    const partial = indexNutritionSource({ ...SOURCE, rows: [SOURCE.rows[1]!] });
    expectUnavailable(
      deriveNutrition([ingredient('white rice', '100g')], 2, partial),
      'rebuild it',
    );
  });

  it('refuses a serving count that is not a positive integer', () => {
    for (const servings of [0, -1, 2.5, Number.NaN]) {
      const result = deriveNutrition([ingredient('white rice', '100g')], servings, rows);
      expect(result.provenance.origin).toBe('unavailable');
      expect(result.nutrition.calories).toBeNull();
    }
  });

  it('never emits a partial sum under any failure', () => {
    const failures = [
      deriveNutrition([ingredient('white rice', '100g'), ingredient('nope', '1g')], 1, rows),
      deriveNutrition([ingredient('white rice', 'to taste')], 1, rows),
      deriveNutrition([ingredient('white rice', '100g')], 0, rows),
    ];
    for (const result of failures) {
      const values = Object.values(result.nutrition);
      expect(values.every((value) => value === null)).toBe(true);
      // Never 0 for unknown: four zeroes read on screen as "this meal has no calories".
      expect(values.some((value) => value === 0)).toBe(false);
    }
  });
});

describe('the nutritionally inert exemption', () => {
  it('lets an all-zero ingredient survive an unparseable measure', () => {
    // Salt publishes four exact zeroes, so any mass times zero is zero: the totals are
    // provably independent of the quantity "to taste" failed to state. Reporting them is
    // exact, not an estimate - which is why this is a consequence of the all-or-nothing rule
    // rather than an exception to it.
    const result = deriveNutrition(
      [ingredient('white rice', '200g'), ingredient('salt', 'to taste')],
      2,
      rows,
    );
    expect(result.provenance.origin).toBe('usda-derived');
    expect(result.nutrition).toStrictEqual({
      calories: 100,
      proteinGrams: 10,
      carbsGrams: 20,
      fatGrams: 5,
    });
  });

  it('does NOT extend to an ingredient carrying a single non-zero macro', () => {
    // One calorie is enough to make the missing quantity matter. The test is on the DATA, so
    // the exemption can never be claimed for a food that contributes something.
    const nearlyInert = indexNutritionSource({
      ...SOURCE,
      rows: [
        ...SOURCE.rows,
        row('pepper', { kcal: 0, proteinGrams: 0, carbsGrams: 0.1, fatGrams: 0 }),
      ],
    });
    const result = deriveNutrition(
      [ingredient('white rice', '200g'), ingredient('pepper', 'to taste')],
      2,
      nearlyInert,
    );
    expect(result.provenance.origin).toBe('unavailable');
    expect(result.provenance.reason).toContain('pepper');
  });

  it('still fails when the inert ingredient does not RESOLVE at all', () => {
    // The exemption covers an unparseable measure on a known food. An unknown name is a
    // different failure: nothing proves it is inert.
    const result = deriveNutrition([ingredient('rock salt', 'to taste')], 1, rows);
    expect(result.provenance.origin).toBe('unavailable');
  });
});

describe('determinism', () => {
  it('produces an identical result for identical input', () => {
    const meal = [ingredient('white rice', '200g'), ingredient('butter', '30g')];
    expect(deriveNutrition(meal, 2, rows)).toStrictEqual(deriveNutrition(meal, 2, rows));
  });
});
