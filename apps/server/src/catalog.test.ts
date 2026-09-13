import { describe, expect, it } from 'vitest';
import type { Meal } from '@nutritime/contracts';
import { buildCatalog, CatalogError } from './catalog.js';

/**
 * T-08-04: the server must not start on unvalidated safety data, and when it refuses it must
 * name the record INDEX and the failing FIELD PATH.
 *
 * "A record failed" is not actionable against a sixty-record file. The index and the path are
 * what turn a refusal into a fix.
 */

const BASE: Meal = {
  id: 'base-meal',
  name: 'Base',
  description: '',
  mealPeriods: ['lunch'],
  ingredients: [{ name: 'rice', measure: '200 g' }],
  instructions: ['Cook.'],
  allergenTags: [],
  dietTags: ['vegetarian'],
  nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 },
  price: { amountCents: 1000, currency: 'USD' },
  preparationMinutes: 20,
  imageUrl: null,
  available: true,
  source: 'local',
  catalogVersion: '1.0.0',
  provenance: { themealdbId: '1', sourceUrl: null, imageSource: null, licenceConfirmed: false },
  nutritionProvenance: {
    origin: 'usda-derived',
    dataset: 'FNDDS 2022-10-28',
    servings: 2,
    reason: null,
  },
};

const meal = (overrides: Partial<Meal>): Meal => ({ ...BASE, ...overrides });

describe('a valid catalog', () => {
  it('indexes by id and reports the version', () => {
    const catalog = buildCatalog([meal({ id: 'a' }), meal({ id: 'b' })]);
    expect(catalog.meals).toHaveLength(2);
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.byId.get('b')?.id).toBe('b');
    expect(catalog.byId.get('missing')).toBeUndefined();
  });

  it('accepts the real committed catalog', async () => {
    // The same `mealSchema` the seed script uses, so a record cannot pass one and fail the
    // other (TSD 7.3). This is boot validation, run at test time.
    const { seededCatalog } = await import('@nutritime/catalog');
    const catalog = buildCatalog(seededCatalog);
    expect(catalog.meals).toHaveLength(60);
    expect(catalog.version).toBe('1.0.0');
  });
});

describe('a catalog it must refuse', () => {
  it('names the record index and the field path', () => {
    const broken = [meal({ id: 'ok' }), { ...meal({ id: 'bad' }), preparationMinutes: -5 }];
    try {
      buildCatalog(broken);
      expect.unreachable('expected a CatalogError');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('record 1');
      expect(message).toContain('preparationMinutes');
    }
  });

  it('reports every failing record, not just the first', () => {
    const broken = [
      { ...meal({ id: 'a' }), preparationMinutes: -1 },
      { ...meal({ id: 'b' }), price: { amountCents: -1, currency: 'USD' } },
    ];
    try {
      buildCatalog(broken);
      expect.unreachable('expected a CatalogError');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('record 0');
      expect(message).toContain('record 1');
    }
  });

  it('refuses a record that violates the superRefine, not merely the field types', () => {
    // Three known macros and one null: every field is individually valid and the record is
    // still forbidden. This is the check that catches a half-derived nutrition row.
    const partial = {
      ...meal({ id: 'partial' }),
      nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: null },
    };
    expect(() => buildCatalog([partial])).toThrow(CatalogError);
  });

  it.each([
    ['not an array', { meals: [] }],
    ['a string', 'meals'],
    ['null', null],
  ] as const)('refuses %s', (_label, value) => {
    expect(() => buildCatalog(value)).toThrow(CatalogError);
  });

  it('refuses an empty catalog rather than serving nothing', () => {
    // `packages/catalog` ships an empty array before the seed has ever run. An empty catalog
    // is not a working server with no meals; it is a boot that found no data.
    expect(() => buildCatalog([])).toThrow(/empty/);
  });

  it('refuses a duplicate id', () => {
    expect(() => buildCatalog([meal({ id: 'same' }), meal({ id: 'same' })])).toThrow(/duplicate/);
  });

  it('refuses a mixed catalogVersion', () => {
    // A mixed file means two seed runs were spliced together, and `/health` would report a
    // version most records do not carry.
    expect(() =>
      buildCatalog([meal({ id: 'a' }), meal({ id: 'b', catalogVersion: '2.0.0' })]),
    ).toThrow(/mixed catalogVersion/);
  });
});
