import { describe, expect, it } from 'vitest';

import {
  buildNutritionSource,
  MACRO_KEYS,
  NUTRIENT_CODES,
  parseUsdaIngredientTable,
  resolveUsdaDatasetPath,
  serializeNutritionSource,
  USDA_DATASET_VINTAGE,
  verifyNutrientCodes,
} from './usda-dataset.js';

/**
 * These fixtures are not invented. Every row below is copied verbatim out of the real
 * `fndds_ingredient_nutrient_value.csv` and `nutrient.csv` of the 2022-10-28 archive,
 * including butter's empty `FDC ID` on the energy row and the three different source labels
 * across its four macros. Synthesising tidier rows would test a file that does not exist and
 * miss exactly the provenance case the emitter has to handle.
 *
 * The full-archive spot checks live in `usda-dataset.integration.test.ts`, which reads the
 * real 15.7 MB file when `USDA_DATASET_PATH` points at it. These unit tests stay portable.
 */

const VALUE_HEADER =
  '"ingredient code","Ingredient description","Nutrient code","Nutrient value",' +
  '"Nutrient value source","FDC ID","Derivation code","SR AddMod year",' +
  '"Foundation year acquired","Start date","End date"';

/** Butter: four macros, three source labels, two FDC records, one of them absent. */
const BUTTER_ROWS = [
  '"1001","Butter, stick, salted","203","0.85","SR Legacy","173410","","1976","0","2019-01-0","2020-12-3"',
  '"1001","Butter, stick, salted","204","82.2","Foundation","790508","A","","2019","2019-01-0","2020-12-3"',
  '"1001","Butter, stick, salted","205","0.06","SR Legacy","173410","NC","1976","0","2019-01-0","2020-12-3"',
  '"1001","Butter, stick, salted","208","743.0","Informed by FDC Foundation and SR Legacy","","","","0","2019-01-0","2020-12-3"',
];

/** Rice: the well-behaved case - one FDC record and one label across all four macros. */
const RICE_ROWS = [
  '"20044","Rice, white, long-grain, regular, raw, enriched","203","7.13","SR Legacy","168877","","1989","0","2019-01-0","2020-12-3"',
  '"20044","Rice, white, long-grain, regular, raw, enriched","204","0.66","SR Legacy","168877","","1989","0","2019-01-0","2020-12-3"',
  '"20044","Rice, white, long-grain, regular, raw, enriched","205","79.95","SR Legacy","168877","NC","1989","0","2019-01-0","2020-12-3"',
  '"20044","Rice, white, long-grain, regular, raw, enriched","208","365.0","SR Legacy","168877","NC","1989","0","2019-01-0","2020-12-3"',
];

const VALUE_CSV = [VALUE_HEADER, ...BUTTER_ROWS, ...RICE_ROWS].join('\r\n');

const NUTRIENT_CSV = [
  '"id","name","unit_name","nutrient_nbr","rank"',
  '"1003","Protein","G","203","600.0"',
  '"1004","Total lipid (fat)","G","204","800.0"',
  '"1005","Carbohydrate, by difference","G","205","1110.0"',
  '"1008","Energy","KCAL","208","300.0"',
].join('\r\n');

describe('verifyNutrientCodes', () => {
  it('confirms the four codes against the archive rather than trusting them', () => {
    expect(() => verifyNutrientCodes(NUTRIENT_CSV)).not.toThrow();
  });

  it('maps each macro to the code the archive publishes it under', () => {
    expect(NUTRIENT_CODES).toEqual({
      kcal: '208',
      proteinGrams: '203',
      carbsGrams: '205',
      fatGrams: '204',
    });
  });

  it('throws when a macro is published in the wrong unit', () => {
    // A refresh that moved energy to kilojoules would otherwise be read as kilocalories and
    // overstate every meal by a factor of four.
    const kilojoules = NUTRIENT_CSV.replace('"Energy","KCAL"', '"Energy","kJ"');
    expect(() => verifyNutrientCodes(kilojoules)).toThrow(/not KCAL/);
  });

  it('throws when a macro code is missing entirely', () => {
    const withoutProtein = NUTRIENT_CSV.split('\r\n')
      .filter((line) => !line.includes('"Protein"'))
      .join('\r\n');
    expect(() => verifyNutrientCodes(withoutProtein)).toThrow(/203/);
  });
});

describe('parseUsdaIngredientTable', () => {
  it('collects the four macros per ingredient with their per-row provenance', () => {
    const dataset = parseUsdaIngredientTable(VALUE_CSV);
    const butter = dataset.ingredients.get('1001');

    expect(butter).toBeDefined();
    expect(butter?.description).toBe('Butter, stick, salted');
    expect(butter?.kcal.value).toBe(743);
    expect(butter?.proteinGrams.value).toBe(0.85);
    expect(butter?.carbsGrams.value).toBe(0.06);
    expect(butter?.fatGrams.value).toBe(82.2);
  });

  it('reads an absent FDC ID as null rather than as an empty identifier', () => {
    const dataset = parseUsdaIngredientTable(VALUE_CSV);
    const butter = dataset.ingredients.get('1001');

    expect(butter?.kcal.fdcId).toBeNull();
    expect(butter?.kcal.sourceLabel).toBe('Informed by FDC Foundation and SR Legacy');
    expect(butter?.proteinGrams.fdcId).toBe('173410');
    expect(butter?.fatGrams.fdcId).toBe('790508');
  });

  it('keeps the comma inside a quoted description intact', () => {
    const dataset = parseUsdaIngredientTable(VALUE_CSV);
    expect(dataset.ingredients.get('20044')?.description).toBe(
      'Rice, white, long-grain, regular, raw, enriched',
    );
  });

  it('reports rather than emits an ingredient missing one of the four macros', () => {
    const partial = [VALUE_HEADER, ...BUTTER_ROWS.slice(0, 3)].join('\r\n');
    const dataset = parseUsdaIngredientTable(partial);

    expect(dataset.ingredients.size).toBe(0);
    expect(dataset.incompleteCodes).toEqual(['1001']);
  });

  it('throws when the header layout has changed', () => {
    const reshaped = VALUE_CSV.replace('"Nutrient value"', '"Nutrient amount"');
    expect(() => parseUsdaIngredientTable(reshaped)).toThrow(/layout has changed/);
  });

  it('throws on a value that is not a usable per-100 g number', () => {
    const corrupt = VALUE_CSV.replace('"743.0"', '"n/a"');
    expect(() => parseUsdaIngredientTable(corrupt)).toThrow(/not a usable per-100 g value/);
  });

  it('records the dataset vintage', () => {
    expect(parseUsdaIngredientTable(VALUE_CSV).vintage).toBe(USDA_DATASET_VINTAGE);
  });
});

describe('buildNutritionSource', () => {
  const dataset = parseUsdaIngredientTable(VALUE_CSV);

  it('emits only the ingredients asked for, each with its four per-100 g macros', () => {
    const build = buildNutritionSource(dataset, ['Butter', 'Rice']);

    expect(build.source.rows).toHaveLength(2);
    expect(build.source.vintage).toBe('2022-10-28');

    const rice = build.source.rows.find((row) => row.key === 'rice');
    expect(rice?.per100g).toEqual({
      kcal: 365,
      proteinGrams: 7.13,
      carbsGrams: 79.95,
      fatGrams: 0.66,
    });
    expect(rice?.fdcId).toBe('168877');
    expect(rice?.sourceLabel).toBe('SR Legacy');
  });

  it('collapses a split provenance deterministically and says so', () => {
    // Butter's macros come from two FDC records and one row with none. The majority record
    // wins - 173410 backs protein and carbohydrate - and the collapse is reported rather
    // than performed silently.
    const build = buildNutritionSource(dataset, ['Butter']);
    const butter = build.source.rows[0];

    expect(butter?.fdcId).toBe('173410');
    expect(butter?.sourceLabel).toBe('SR Legacy');
    expect(build.traceabilityNotes).toHaveLength(1);
    expect(build.traceabilityNotes[0]).toContain('more than one FDC record');
  });

  it('emits one row when two names mean the same food', () => {
    const build = buildNutritionSource(dataset, ['Butter', 'butter', 'BUTTER']);
    expect(build.source.rows).toHaveLength(1);
  });

  it('reports an unresolved name instead of approximating it', () => {
    const build = buildNutritionSource(dataset, ['Rice', 'Sriracha Aioli']);

    expect(build.source.rows).toHaveLength(1);
    expect(build.unresolved).toEqual([
      expect.objectContaining({ name: 'Sriracha Aioli', kind: 'unknown-ingredient' }),
    ]);
  });

  it('throws when a binding points at a code the dataset no longer carries', () => {
    const withoutRice = [VALUE_HEADER, ...BUTTER_ROWS].join('\r\n');
    expect(() => buildNutritionSource(parseUsdaIngredientTable(withoutRice), ['Rice'])).toThrow(
      /binding in ingredient-bindings.ts is stale/,
    );
  });

  it('throws when a code has been reassigned to a different food', () => {
    // The guard against a silent repoint: the code still exists, so nothing else would
    // notice, but it now describes something the binding was never verified against.
    const renamed = VALUE_CSV.split('Rice, white, long-grain, regular, raw, enriched').join(
      'Rice, brown, long-grain, raw',
    );
    expect(() => buildNutritionSource(parseUsdaIngredientTable(renamed), ['Rice'])).toThrow(
      /Re-verify the binding/,
    );
  });

  it('sorts rows by key so the committed file has a stable diff', () => {
    const build = buildNutritionSource(dataset, ['Rice', 'Butter']);
    expect(build.source.rows.map((row) => row.key)).toEqual(['butter', 'rice']);
  });

  it('serialises to JSON ending in a newline', () => {
    const build = buildNutritionSource(dataset, ['Rice']);
    const text = serializeNutritionSource(build.source);

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(build.source);
  });

  it('carries an fdcId or an explicit null on every emitted row', () => {
    const build = buildNutritionSource(dataset, ['Butter', 'Rice']);
    for (const row of build.source.rows) {
      expect(row.sourceLabel.length).toBeGreaterThan(0);
      expect(row.usdaCode.length).toBeGreaterThan(0);
      // Never an empty string: absence is null, presence is a real identifier.
      expect(row.fdcId).not.toBe('');
    }
  });
});

describe('resolveUsdaDatasetPath', () => {
  it('returns the configured path', () => {
    expect(resolveUsdaDatasetPath({ USDA_DATASET_PATH: 'C:\\data\\usda' })).toBe('C:\\data\\usda');
  });

  it('stops with a blocker rather than falling back to another source', () => {
    // T-07-06's stop-condition override, stated in the message so whoever hits it reads the
    // rule rather than inventing a fallback.
    for (const env of [{}, { USDA_DATASET_PATH: '' }, { USDA_DATASET_PATH: '   ' }]) {
      expect(() => resolveUsdaDatasetPath(env)).toThrow(/USDA_DATASET_PATH is not set/);
    }
  });
});

describe('macro key order', () => {
  it('is fixed, because it is the tie-break when provenance is collapsed', () => {
    expect(MACRO_KEYS).toEqual(['kcal', 'proteinGrams', 'carbsGrams', 'fatGrams']);
  });
});
