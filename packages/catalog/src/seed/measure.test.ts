import { describe, expect, it } from 'vitest';

import { BARE_COUNT_UNIT, parseMeasureToGrams } from './measure.js';
import type { IngredientMeasureData, MeasureResult } from './measure.js';

/**
 * Plan.md T-07-08 acceptance: `1/4 cup`, `1 1/2 tsp`, `3 cloves` and `1 lb` convert, and
 * `1 tin` without a gram weight fails loudly.
 *
 * Most of this file is failure paths, on purpose. A measure parser that converts the eight
 * easy cases and quietly returns something plausible for the ninth is the exact defect
 * T-07-09's all-or-nothing rule exists to catch, so every refusal is asserted by kind rather
 * than merely by "not ok".
 */

/** A liquid: water density, so a cup is 236.6 g. */
const WATER: IngredientMeasureData = { gramsPerMillilitre: 1 };

/** Garlic: a clove has a declared weight, nothing else does. */
const GARLIC: IngredientMeasureData = { gramsPerUnit: { clove: 3 } };

function grams(result: MeasureResult): number {
  if (!result.ok) {
    throw new Error(`expected a converted measure, got ${result.kind}: ${result.reason}`);
  }
  return result.grams;
}

describe('parseMeasureToGrams - mass units', () => {
  it('converts grams and kilograms', () => {
    expect(grams(parseMeasureToGrams('400g'))).toBe(400);
    expect(grams(parseMeasureToGrams('400 g'))).toBe(400);
    expect(grams(parseMeasureToGrams('1.5 kg'))).toBe(1500);
  });

  it('converts one pound to 453.59237 g', () => {
    expect(grams(parseMeasureToGrams('1 lb'))).toBeCloseTo(453.59237, 5);
  });

  it('converts ounces', () => {
    expect(grams(parseMeasureToGrams('4 oz'))).toBeCloseTo(113.3980925, 6);
  });

  it('converts a mass unit with no density declared, because a gram needs no density', () => {
    expect(grams(parseMeasureToGrams('200 grams'))).toBe(200);
  });

  it('ignores a full stop written after a unit', () => {
    expect(grams(parseMeasureToGrams('2 oz.'))).toBeCloseTo(56.69904625, 6);
  });
});

describe('parseMeasureToGrams - quantities', () => {
  it('reads a simple fraction', () => {
    // 1/4 cup of water = 236.5882365 / 4.
    expect(grams(parseMeasureToGrams('1/4 cup', WATER))).toBeCloseTo(59.147059125, 6);
  });

  it('reads a mixed number', () => {
    // 1 1/2 tsp = 1.5 x 4.92892159375 ml.
    expect(grams(parseMeasureToGrams('1 1/2 tsp', WATER))).toBeCloseTo(7.393382390625, 6);
  });

  it('reads a decimal', () => {
    expect(grams(parseMeasureToGrams('0.5 kg'))).toBe(500);
  });

  it('reads a vulgar fraction, alone and as part of a mixed number', () => {
    expect(grams(parseMeasureToGrams('½ cup', WATER))).toBeCloseTo(118.29411825, 6);
    expect(grams(parseMeasureToGrams('1½ cup', WATER))).toBeCloseTo(354.88235475, 6);
  });

  it('treats a unit with no leading number as one of that unit', () => {
    // "Dash" means one dash. That is a reading of English, not a guess about weight - the
    // gram figure still comes from the unit table and the declared density.
    const dash = parseMeasureToGrams('Dash', WATER);
    const oneDash = parseMeasureToGrams('1 dash', WATER);
    expect(grams(dash)).toBe(grams(oneDash));
  });

  it('refuses a range rather than picking an end or averaging', () => {
    for (const measure of ['2-3 tbsp', '1 to 2 cups', '2 – 3 tsp']) {
      const result = parseMeasureToGrams(measure, WATER);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('ambiguous-range');
      }
    }
  });

  it('refuses a zero or negative quantity instead of contributing nothing silently', () => {
    const zero = parseMeasureToGrams('0 g');
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.kind).toBe('non-positive-quantity');
    }
  });

  it('refuses an empty measure', () => {
    const result = parseMeasureToGrams('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('empty-measure');
    }
  });
});

describe('parseMeasureToGrams - volume needs a density', () => {
  it('converts a cup for an ingredient that declares its density', () => {
    expect(grams(parseMeasureToGrams('1 cup', WATER))).toBeCloseTo(236.5882365, 6);
  });

  it('scales by the declared density rather than assuming water', () => {
    // Flour at 0.53 g/ml: a cup is about 125 g, not 237 g. Assuming water would nearly
    // double it, which is Plan.md R-03's "a wrong density scales one ingredient".
    const flour: IngredientMeasureData = { gramsPerMillilitre: 0.53 };
    expect(grams(parseMeasureToGrams('1 cup', flour))).toBeCloseTo(125.391765345, 6);
  });

  it('refuses a volume when the ingredient declares no density', () => {
    const result = parseMeasureToGrams('1 cup');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing-density');
      expect(result.reason).toContain('millilitre');
    }
  });

  it('keeps tsp, tbsp and cup in exact proportion', () => {
    const cup = grams(parseMeasureToGrams('1 cup', WATER));
    const tablespoon = grams(parseMeasureToGrams('1 tbsp', WATER));
    const teaspoon = grams(parseMeasureToGrams('1 tsp', WATER));
    expect(tablespoon * 16).toBeCloseTo(cup, 9);
    expect(teaspoon * 3).toBeCloseTo(tablespoon, 9);
  });
});

describe('parseMeasureToGrams - countable units', () => {
  it('converts 3 cloves using the declared clove weight', () => {
    expect(grams(parseMeasureToGrams('3 cloves', GARLIC))).toBe(9);
  });

  it('matches a plural unit against a singular table key', () => {
    expect(grams(parseMeasureToGrams('2 cloves', GARLIC))).toBe(6);
    expect(grams(parseMeasureToGrams('1 clove', GARLIC))).toBe(3);
  });

  it('converts a bare count through the item key', () => {
    const egg: IngredientMeasureData = { gramsPerUnit: { [BARE_COUNT_UNIT]: 50, egg: 50 } };
    expect(grams(parseMeasureToGrams('2', egg))).toBe(100);
    expect(grams(parseMeasureToGrams('2 eggs', egg))).toBe(100);
  });

  it('fails loudly on "1 tin" when no gram weight is declared', () => {
    // The acceptance case. A tin is a real unit of counting and a real gap in the data, so
    // the failure names it as a missing weight rather than as an unrecognised word.
    const result = parseMeasureToGrams('1 tin');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing-unit-weight');
      expect(result.reason).toContain('tin');
    }
  });

  it('converts "1 tin" once a gram weight for a tin is declared', () => {
    const tomatoes: IngredientMeasureData = { gramsPerUnit: { tin: 400 } };
    expect(grams(parseMeasureToGrams('1 tin', tomatoes))).toBe(400);
  });

  it('does not let a declared clove weight rescue an undeclared unit', () => {
    const result = parseMeasureToGrams('2 heads', GARLIC);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('missing-unit-weight');
    }
  });
});

describe('parseMeasureToGrams - vague and unknown units', () => {
  it('refuses a vague measure', () => {
    for (const measure of ['to taste', 'a little', 'handful', 'for garnish']) {
      const result = parseMeasureToGrams(measure, WATER);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe('vague-measure');
      }
    }
  });

  it('lets an ingredient declare a weight for a vague unit it actually knows', () => {
    const butter: IngredientMeasureData = { gramsPerUnit: { knob: 15 } };
    expect(grams(parseMeasureToGrams('1 knob', butter))).toBe(15);
  });

  it('refuses an unrecognised unit rather than treating it as a count', () => {
    // A word nobody recognises must not fall through to the countable path and pick up a
    // weight meant for something else. `tblsp` is NOT such a word - see the test below.
    const result = parseMeasureToGrams('2 blorps', { gramsPerUnit: { tbsp: 15 } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown-unit');
    }
  });

  it('reads the unit spellings TheMealDB actually publishes', () => {
    // `tblsp`, `tbls` and `tbs` are not typos to be refused: they are how the upstream data
    // spells a tablespoon, and they appear in the live catalog ("2 tblsp", "3 tblsp chopped").
    // Refusing them loses real measures for no safety gain.
    for (const spelling of ['2 tbsp', '2 tbls', '2 tblsp', '2 tbs']) {
      expect(grams(parseMeasureToGrams(spelling, WATER))).toBeCloseTo(29.57, 1);
    }
  });

  it('reads a unit carrying a trailing preparation clause', () => {
    // "1 cup chopped" is one cup. The preparation word qualifies the FOOD, not the amount, so
    // dropping it from the end of a unit cannot change the quantity. This reverses an earlier
    // decision to refuse: the density figures are already conventional (R-03), and refusing
    // here discarded real measures across most of the catalog for no accuracy gain.
    expect(grams(parseMeasureToGrams('1 cup chopped', WATER))).toBeCloseTo(236.59, 1);
    expect(grams(parseMeasureToGrams('750 g piece', WATER))).toBe(750);
    expect(grams(parseMeasureToGrams('4 tsp ground', WATER))).toBeCloseTo(19.72, 1);
  });

  it('multiplies a count of sized containers, and never misreads a bare mass as one', () => {
    // `3 400g cans` is 1200 g. The separator in the pattern is what keeps `400g` itself from
    // matching as 4 x 00 and converting to zero grams.
    expect(grams(parseMeasureToGrams('3 400g cans'))).toBe(1200);
    expect(grams(parseMeasureToGrams('400g'))).toBe(400);
    expect(grams(parseMeasureToGrams('1 - 14 ounce can'))).toBeCloseTo(396.89, 1);
  });

  it('reads a hyphenated mixed number as a quantity and a hyphenated range as a range', () => {
    // `2-1/2 cups` is two and a half cups; `2-3 tbsp` is a genuine range and must still fail.
    expect(grams(parseMeasureToGrams('2-1/2 cups', WATER))).toBeCloseTo(591.47, 1);
    expect(parseMeasureToGrams('2-3 tbsp', WATER).ok).toBe(false);
  });

  it('prefers a parenthesised metric amount, which restates the same quantity exactly', () => {
    expect(grams(parseMeasureToGrams('12 ounces (340g)'))).toBe(340);
    expect(grams(parseMeasureToGrams('1 (200g) pack'))).toBe(200);
  });

  it('keeps the first half of a dual-unit measure', () => {
    expect(grams(parseMeasureToGrams('150g/6oz'))).toBe(150);
  });

  it('never returns zero grams on a failure path', () => {
    const failures = [
      parseMeasureToGrams('1 tin'),
      parseMeasureToGrams('to taste'),
      parseMeasureToGrams('1 cup'),
      parseMeasureToGrams('2-3 tbsp'),
      parseMeasureToGrams(''),
    ];
    for (const result of failures) {
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('grams');
    }
  });
});
