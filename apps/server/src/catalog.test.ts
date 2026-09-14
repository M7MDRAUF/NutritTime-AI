import { describe, expect, it } from 'vitest';
import type { Meal } from '@nutritime/contracts';
import { isCanonicalAllergen } from '@nutritime/domain';
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

/**
 * The message from a call that MUST throw.
 *
 * Not `try { … expect.unreachable() } catch {}`, which `config.test.ts` documents as unsafe:
 * the marker's own throw is caught by the very catch that then asserts on it, so the assertion
 * can run against `"expected \"expected a CatalogError\" not to be reached"` and pass no matter
 * what the function did. The two cases below were sound only by accident - `record 1` does not
 * appear in the marker's text - and P08's phase report claims the shape was eliminated.
 */
function messageFromThrow(run: () => unknown): string {
  let caught: unknown;
  let threw = false;
  try {
    run();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, 'expected the call to throw').toBe(true);
  expect(caught).toBeInstanceOf(CatalogError);
  return caught instanceof Error ? caught.message : String(caught);
}

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
    const message = messageFromThrow(() => buildCatalog(broken));
    expect(message).toContain('record 1');
    expect(message).toContain('preparationMinutes');
  });

  it('reports every failing record, not just the first', () => {
    const broken = [
      { ...meal({ id: 'a' }), preparationMinutes: -1 },
      { ...meal({ id: 'b' }), price: { amountCents: -1, currency: 'USD' } },
    ];
    const message = messageFromThrow(() => buildCatalog(broken));
    expect(message).toContain('record 0');
    expect(message).toContain('record 1');
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

describe('R-16: every allergen tag is canonical, re-asserted at BOOT', () => {
  /**
   * **A misspelled declared allergen tag resolves to nothing.** `mealSchema` types
   * `allergenTags` as `z.array(z.string())`, so `treenut` validates, satisfies the superRefine,
   * and then matches no canonical allergen - a meal that should be rejected for a declared
   * tree-nut allergy is offered instead, and nothing anywhere says so. R-16 rates the hazard
   * High for exactly that reason: the tag's presence makes the record look reviewed.
   *
   * `packages/catalog/seed.ts` checks the hand-authored `allergenAdditions` at SEED time. That
   * is not this check. The committed `meals.json` is what the server serves; it can be edited,
   * re-generated, or written by a seed path that sets a tag outside `allergenAdditions`, none of
   * which re-runs the seed. So boot re-checks, against the domain's own predicate.
   */
  it('accepts the canonical taxonomy', () => {
    const catalog = buildCatalog([meal({ id: 'a', allergenTags: ['peanut', 'tree-nut', 'milk'] })]);
    expect(catalog.meals[0]?.allergenTags).toStrictEqual(['peanut', 'tree-nut', 'milk']);
  });

  it.each([
    ['treenut', 'tree-nut misspelled as one word'],
    ['peanuts', 'the plural, which the matcher does not know'],
    ['dairy', 'a common synonym that is not the canonical tag'],
    ['Peanut', 'the right word in the wrong case'],
  ] as const)('refuses %s (%s)', (tag, _why) => {
    expect(() => buildCatalog([meal({ id: 'a', allergenTags: [tag] })])).toThrow(CatalogError);
  });

  it('names the record index, the field path AND the offending tag', () => {
    // The index and the path for the same reason every other failure carries them, and the tag
    // itself because the whole failure mode is that it reads like a real allergen.
    const message = messageFromThrow(() =>
      buildCatalog([
        meal({ id: 'a' }),
        meal({ id: 'b', allergenTags: ['peanut', 'treenut'] }),
        meal({ id: 'c' }),
      ]),
    );
    expect(message).toContain('record 1.allergenTags.1');
    expect(message).toContain('treenut');
    expect(message).toContain('canonical allergen taxonomy');
    // Only the offending entry, not the valid one beside it.
    expect(message).not.toContain('record 1.allergenTags.0');
    expect(message).not.toContain('record 0');
  });

  it('holds for the real committed catalog, and the check is not vacuous', async () => {
    const { seededCatalog } = await import('@nutritime/catalog');
    const catalog = buildCatalog(seededCatalog);
    const tags = catalog.meals.flatMap((record) => [...record.allergenTags]);
    // Without this the assertion below would pass over sixty empty arrays and prove nothing.
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.filter((tag) => !isCanonicalAllergen(tag))).toStrictEqual([]);
  });
});
