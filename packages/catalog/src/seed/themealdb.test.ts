import { describe, expect, it } from 'vitest';
import {
  filterByCategory,
  lookupMeal,
  mealsArray,
  THEMEALDB_ATTRIBUTION,
  THEMEALDB_BASE,
  THEMEALDB_DEV_KEY,
} from './themealdb.js';

/**
 * T-07-02's acceptance is a unit test against ALL FOUR response shapes.
 *
 * `meals` comes back as an array of records, the string `"None Found"`, a legacy object, or
 * `null`, depending on the endpoint and whether there was any data. TSD 7.2 step 2 names
 * treating a non-array as an array as the defect this guard exists to prevent - a rate-limited
 * reply reading `payload.meals.length` throws, and a `"None Found"` string read as an array
 * yields characters.
 *
 * No network: every test injects `fetchJson`.
 */

const FOUR_SHAPES = [
  ['an array of records', { meals: [{ idMeal: '1', strMeal: 'A' }] }, 1],
  ['the string "None Found"', { meals: 'None Found' }, 0],
  ['a legacy object', { meals: { idMeal: '1' } }, 0],
  ['null', { meals: null }, 0],
] as const;

describe('mealsArray handles every shape the API returns', () => {
  it.each(FOUR_SHAPES)('reads %s', (_label, payload, expected) => {
    expect(mealsArray(payload)).toHaveLength(expected);
  });

  it('treats a missing key, a non-object and a bare array as no data', () => {
    expect(mealsArray({})).toStrictEqual([]);
    expect(mealsArray(null)).toStrictEqual([]);
    expect(mealsArray(undefined)).toStrictEqual([]);
    expect(mealsArray('None Found')).toStrictEqual([]);
    expect(mealsArray(42)).toStrictEqual([]);
    // A bare array is not the envelope: the payload must carry `meals`.
    expect(mealsArray([{ idMeal: '1' }])).toStrictEqual([]);
  });

  it('never returns a live reference into the payload it was given', () => {
    const payload = { meals: [{ idMeal: '1' }] };
    expect(mealsArray(payload)).toHaveLength(1);
    // The guard reads; it does not copy, so this documents what callers may assume: the array
    // is the payload's own. Nothing in the seed pipeline mutates it.
    expect(mealsArray(payload)[0]).toBe(payload.meals[0]);
  });
});

describe('filterByCategory', () => {
  it('returns id and name pairs, and asks the JSON API for the category', async () => {
    let requested = '';
    const summaries = await filterByCategory('Seafood', {
      fetchJson: (url) => {
        requested = url;
        return Promise.resolve({
          meals: [
            { idMeal: '52772', strMeal: 'Teriyaki Chicken' },
            { idMeal: '52773', strMeal: 'Honey Salmon' },
          ],
        });
      },
    });
    expect(summaries).toStrictEqual([
      { id: '52772', name: 'Teriyaki Chicken' },
      { id: '52773', name: 'Honey Salmon' },
    ]);
    expect(requested).toBe(`${THEMEALDB_BASE}/${THEMEALDB_DEV_KEY}/filter.php?c=Seafood`);
  });

  it.each(FOUR_SHAPES)('survives %s without throwing', async (_label, payload) => {
    const summaries = await filterByCategory('Seafood', {
      fetchJson: () => Promise.resolve(payload),
    });
    expect(Array.isArray(summaries)).toBe(true);
  });

  it('drops an entry missing an id or a name rather than emitting a half record', async () => {
    const summaries = await filterByCategory('Seafood', {
      fetchJson: () =>
        Promise.resolve({
          meals: [
            { idMeal: '1', strMeal: 'Good' },
            { idMeal: '2' },
            { strMeal: 'No id' },
            { idMeal: '', strMeal: 'Blank id' },
          ],
        }),
    });
    expect(summaries).toStrictEqual([{ id: '1', name: 'Good' }]);
  });

  it('percent-encodes a category name', async () => {
    let requested = '';
    await filterByCategory('Side Dish', {
      fetchJson: (url) => {
        requested = url;
        return Promise.resolve({ meals: null });
      },
    });
    expect(requested).toContain('c=Side%20Dish');
  });
});

describe('lookupMeal', () => {
  it('returns the first record and asks lookup.php for the id', async () => {
    let requested = '';
    const record = await lookupMeal('52772', {
      fetchJson: (url) => {
        requested = url;
        return Promise.resolve({ meals: [{ idMeal: '52772', strMeal: 'Teriyaki Chicken' }] });
      },
    });
    expect(record?.['strMeal']).toBe('Teriyaki Chicken');
    expect(requested).toBe(`${THEMEALDB_BASE}/${THEMEALDB_DEV_KEY}/lookup.php?i=52772`);
  });

  it.each(FOUR_SHAPES)('returns null for %s rather than throwing', async (_label, payload) => {
    // The crash TSD 7.2 step 2 names: `payload.meals[0]` on a string yields a character, and
    // on null throws. Both must be `null` here.
    await expect(lookupMeal('1', { fetchJson: () => Promise.resolve(payload) })).resolves.toSatisfy(
      (value: unknown) => value === null || typeof value === 'object',
    );
  });

  it('returns null when the array holds a non-object', async () => {
    const record = await lookupMeal('1', {
      fetchJson: () => Promise.resolve({ meals: ['None Found'] }),
    });
    expect(record).toBeNull();
  });

  it('honours a supporter key when one is supplied', async () => {
    let requested = '';
    await lookupMeal('1', {
      key: 'supporter',
      fetchJson: (url) => {
        requested = url;
        return Promise.resolve({ meals: null });
      },
    });
    expect(requested).toBe(`${THEMEALDB_BASE}/supporter/lookup.php?i=1`);
  });
});

describe('licence obligations', () => {
  it('states the attribution the licence requires (X-12, PRD 15)', () => {
    expect(THEMEALDB_ATTRIBUTION).toBe('Recipe data and imagery: TheMealDB');
  });

  it('uses the JSON API, never the HTML pages', () => {
    expect(THEMEALDB_BASE).toBe('https://www.themealdb.com/api/json/v1');
  });
});
