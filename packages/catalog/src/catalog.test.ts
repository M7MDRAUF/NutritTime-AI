import { describe, expect, it } from 'vitest';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { seededCatalog } from './index.js';
import nutritionSource from '../nutrition-source.json' with { type: 'json' };

/**
 * The committed catalog, checked as data rather than as code (T-07-11).
 *
 * This suite is the boot validation of TSD 7.3 run at test time: the server and the seed script
 * use the same `mealSchema`, so a record that passes here cannot fail there. Everything else
 * below exists because schema validity is not the same as being RIGHT - a record can satisfy
 * every type and still claim a calorie count nothing produced.
 */

const records: readonly unknown[] = Array.isArray(seededCatalog) ? seededCatalog : [];

/** Parsed once. A record that fails here fails every later assertion anyway. */
const meals: readonly Meal[] = records.map((record, index) => {
  const result = mealSchema.safeParse(record);
  if (!result.success) {
    throw new Error(`record ${String(index)} fails mealSchema: ${result.error.message}`);
  }
  return result.data as Meal;
});

describe('the committed catalog', () => {
  it('holds exactly 60 records', () => {
    expect(records).toHaveLength(60);
  });

  it('validates every record against mealSchema, superRefine included', () => {
    // Not a formality: the superRefine is what forbids a record from carrying three known
    // macros and one null, or from claiming `usda-derived` without a dataset and a serving
    // count. Parsing all 60 above is the assertion; this names it.
    expect(meals).toHaveLength(60);
  });

  it('gives every record a unique, kebab-case id', () => {
    const ids = meals.map((meal) => meal.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('marks every record as local catalog data at one version', () => {
    for (const meal of meals) {
      expect(meal.source).toBe('local');
      expect(meal.catalogVersion).toBe('1.0.0');
      expect(meal.mealPeriods.length).toBeGreaterThan(0);
      expect(meal.dietTags.length).toBeGreaterThan(0);
      expect(meal.ingredients.length).toBeGreaterThan(0);
      expect(meal.instructions.length).toBeGreaterThan(0);
    }
  });

  it('carries upstream provenance on every record (X-12)', () => {
    for (const meal of meals) {
      // Attribution is a licence condition. The upstream id is the one field TheMealDB always
      // supplies, so it is the one this can require; `sourceUrl` is absent for 19 of the 60
      // and `licenceConfirmed` is false for all of them, which is what the API actually says.
      expect(meal.provenance.themealdbId).toMatch(/^\d+$/);
    }
  });
});

describe('nutrition is derived or absent, never invented', () => {
  const derived = meals.filter((meal) => meal.nutritionProvenance.origin === 'usda-derived');
  const unavailable = meals.filter((meal) => meal.nutritionProvenance.origin === 'unavailable');

  it('splits cleanly between derived and unavailable, with nothing else', () => {
    expect(derived.length + unavailable.length).toBe(meals.length);
  });

  it('derives nutrition for exactly the 7 records coverage currently reaches', () => {
    // EXACT, not a floor. A `>= 3` assertion cannot tell 5 from 3, so it would stay green
    // while coverage regressed - and coverage is the number this phase is weakest on. When the
    // catalog-coverage pass raises it, this number moves deliberately and the diff says so.
    //
    // 7 of 60 is not a target; it is what the binding table currently reaches. The cause is
    // recorded in P07.md: FNDDS carries no row at all for rosemary, mint, saffron, cardamom,
    // allspice, bay leaf, garam masala, fenugreek, shallots, toor dal, ghee or celeriac, and
    // one such ingredient blanks a whole meal under TSD 7.4's all-or-nothing rule.
    expect(derived).toHaveLength(7);
  });

  it('never reports 0 where it means unknown', () => {
    // The failure this forbids: a meal whose nutrition could not be derived showing four
    // zeroes, which reads on screen as "this meal has no calories".
    for (const meal of unavailable) {
      expect(meal.nutrition).toStrictEqual({
        calories: null,
        proteinGrams: null,
        carbsGrams: null,
        fatGrams: null,
      });
      expect(meal.nutritionProvenance.reason).not.toBeNull();
      expect(meal.nutritionProvenance.dataset).toBeNull();
      expect(meal.nutritionProvenance.servings).toBeNull();
    }
  });

  it('is wholly known or wholly null on every record - never partial', () => {
    for (const meal of meals) {
      const values = [
        meal.nutrition.calories,
        meal.nutrition.proteinGrams,
        meal.nutrition.carbsGrams,
        meal.nutrition.fatGrams,
      ];
      const known = values.filter((value) => value !== null).length;
      expect([0, values.length]).toContain(known);
    }
  });

  it('records the dataset and the authored serving count on every derived record', () => {
    for (const meal of derived) {
      expect(meal.nutritionProvenance.dataset).toContain('2022-10-28');
      // The serving count divides all four macros and TheMealDB publishes none, so it is
      // authored. Recording it is what stops a reader mistaking it for a sourced figure.
      expect(meal.nutritionProvenance.servings).toBeGreaterThanOrEqual(1);
      expect(meal.nutritionProvenance.reason).toBeNull();
    }
  });

  it('names the ingredient that blocked every unavailable record', () => {
    for (const meal of unavailable) {
      // A reason that does not NAME the ingredient is a reason nobody can act on. Asserting a
      // length alone let any sentence pass; this checks the reason actually quotes one of the
      // meal's own ingredient names.
      const reason = meal.nutritionProvenance.reason ?? '';
      const named = meal.ingredients.some((item) => reason.includes(item.name));
      expect(named, `${meal.id}: "${reason}"`).toBe(true);
    }
  });
});

describe('every derived figure is traceable to the published table', () => {
  const rows = nutritionSource.rows;

  it('commits a nutrient row for the ingredients the catalog actually uses', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(nutritionSource.vintage).toBe('2022-10-28');
  });

  it('gives every row a USDA ingredient code and per-100 g macros', () => {
    for (const row of rows) {
      expect(row.usdaCode).toMatch(/^\d+$/);
      expect(row.per100g.kcal).toBeGreaterThanOrEqual(0);
      expect(typeof row.per100g.proteinGrams).toBe('number');
      expect(typeof row.per100g.carbsGrams).toBe('number');
      expect(typeof row.per100g.fatGrams).toBe('number');
    }
  });

  it('records an FDC id wherever the archive publishes one, and null where it does not', () => {
    // TSD 7.4 declares `fdcId: string`. The archive does not honour that: 44 of its 1,882
    // ingredients publish no FDC ID on any macro, olive oil among them. `null` says so; an
    // empty string would be a fabricated identifier wearing the shape of a real one. The
    // `usdaCode` above is what keeps such a row traceable. Recorded as a divergence, not fixed
    // by inventing a value.
    for (const row of rows) {
      expect(row.fdcId === null || /^\d+$/.test(row.fdcId)).toBe(true);
      expect(row.sourceLabel.length).toBeGreaterThan(0);
    }
    expect(rows.some((row) => row.fdcId !== null)).toBe(true);
  });
});

describe('three meals verified by hand against the per-100 g table', () => {
  const byId = (id: string): Meal => {
    const meal = meals.find((candidate) => candidate.id === id);
    if (meal === undefined) {
      throw new Error(`no meal ${id}`);
    }
    return meal;
  };

  /**
   * All three worked independently from `nutrition-source.json`'s per-100 g figures and the
   * raw measure strings, doing each unit conversion by hand rather than calling `derive.ts`.
   *
   * An earlier version of this block named three meals and actually worked only one, and that
   * one used 0.85 g/ml for granulated sugar where the binding declares 0.845 - so the "hand
   * check" was checking a different computation from the one the code performs. Both rounded
   * to the same integer, which is exactly why it went unnoticed.
   */

  it('Home-made Mandazi: 750 g flour + 6 tbsp sugar + 2 eggs + 1 cup milk over 8 servings', () => {
    //   self raising flour 359 kcal/100 g  x 750.00 g        = 2692.50
    //   granulated sugar   401             x  74.97 g        =  300.63   (6 x 14.7868 ml x 0.845)
    //   eggs               143             x 100.00 g        =  143.00   (2 x 50 g)
    //   whole milk          61             x 243.69 g        =  148.65   (236.5882 ml x 1.03)
    //                                                 total  = 3284.77 / 8 = 410.60 -> 411
    const meal = byId('home-made-mandazi');
    expect(meal.nutritionProvenance.servings).toBe(8);
    expect(meal.nutrition.calories).toBe(411);
    expect(meal.nutrition.proteinGrams).toBe(11); // 85.99 / 8 = 10.75
    expect(meal.nutrition.carbsGrams).toBe(83); // 665.91 / 8 = 83.24
    expect(meal.nutrition.fatGrams).toBe(4); // 30.30 / 8 = 3.79
  });

  it('Chocolate Gateau: chocolate, butter, milk, 5 eggs, sugar and flour over 10 servings', () => {
    //   dark chocolate     550 kcal/100 g  x 250.00 g        = 1375.00
    //   butter             743             x 175.00 g        = 1300.25
    //   whole milk          61             x  30.46 g        =   18.58   (2 x 14.7868 ml x 1.03)
    //   eggs               143             x 250.00 g        =  357.50   (5 x 50 g)
    //   granulated sugar   401             x 175.00 g        =  701.75
    //   all purpose flour  366             x 125.00 g        =  457.50
    //                                                 total  = 4210.58 / 10 = 421.06 -> 421
    const meal = byId('chocolate-gateau');
    expect(meal.nutritionProvenance.servings).toBe(10);
    expect(meal.nutrition.calories).toBe(421);
    expect(meal.nutrition.proteinGrams).toBe(6); // 59.83 / 10 = 5.98
    expect(meal.nutrition.carbsGrams).toBe(42); // 424.77 / 10 = 42.48
    expect(meal.nutrition.fatGrams).toBe(25); // 252.63 / 10 = 25.26
  });

  it('Chicken Enchilada Casserole: the meal a density correction moved by 11 percent', () => {
    //   enchilada sauce     30 kcal/100 g  x 396.89 g        =  119.07   (14 oz)
    //   monterey jack      373             x 339.27 g        = 1265.47   (3 x 236.5882 ml x 0.478)
    //   corn tortillas     218             x 156.00 g        =  340.08   (6 x 26 g)
    //   chicken breast     120             x 348.00 g        =  417.60   (2 x 174 g)
    //                                                 total  = 2142.22 / 6 = 357.04 -> 357
    //
    // Worth its own test because the cheese is 59% of the energy and its density is AUTHORED.
    // At the 0.4 g/ml this table first carried, the meal derived 323 kcal; USDA's own portion
    // data gives 1 cup shredded = 113 g, i.e. 0.478, and the figure moved to 357. Nothing
    // downstream could have detected the first number was wrong (R-03).
    const meal = byId('chicken-enchilada-casserole');
    expect(meal.nutritionProvenance.servings).toBe(6);
    expect(meal.nutrition.calories).toBe(357);
    expect(meal.nutrition.proteinGrams).toBe(29); // 172.71 / 6 = 28.79
    expect(meal.nutrition.carbsGrams).toBe(15); // 91.27 / 6 = 15.21
    expect(meal.nutrition.fatGrams).toBe(20); // 119.91 / 6 = 19.99
  });
});

describe('the hand review recorded in the authoring table reached the records', () => {
  const tagsOf = (id: string): readonly string[] =>
    meals.find((meal) => meal.id === id)?.allergenTags ?? [];

  it('tags sesame on the tahini dish whose ingredient list omits the tahini', () => {
    expect(tagsOf('roasted-eggplant-with-tahini-pine-nuts-and-lentils')).toContain('sesame');
  });

  it('tags wheat on the cannelloni whose pasta appears only in its name', () => {
    // The ingredient list says "Cannellini Beans" - one letter from the pasta, and a legume.
    expect(tagsOf('spinach-ricotta-cannelloni')).toContain('wheat');
  });

  it('tags milk on the dish whose only dairy is fromage frais', () => {
    expect(tagsOf('chilli-prawn-linguine')).toContain('milk');
  });

  it('derives gluten-aware from the reviewed tags rather than authoring it', () => {
    for (const meal of meals) {
      const glutenFree =
        !meal.allergenTags.includes('gluten') && !meal.allergenTags.includes('wheat');
      expect(meal.dietTags.includes('gluten-aware')).toBe(glutenFree);
    }
  });
});
