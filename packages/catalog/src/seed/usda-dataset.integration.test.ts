import { describe, expect, it } from 'vitest';

import {
  buildNutritionSource,
  MACRO_KEYS,
  readUsdaDataset,
  resolveUsdaDatasetPath,
} from './usda-dataset.js';
import { INGREDIENT_BINDINGS } from './ingredient-bindings.js';

/**
 * The real-archive checks (T-07-06).
 *
 * Separated from the unit tests because they read a 15.7 MB file from a machine-local path
 * outside the repository. The unit suite has to pass anywhere; this suite only runs where the
 * archive is present, and skips cleanly where it is not - that is why it must never be the
 * only place a behaviour is tested.
 *
 * Run it with the path set:
 *
 *     USDA_DATASET_PATH=... npx vitest run --project integration packages/catalog
 */

const datasetPath = process.env['USDA_DATASET_PATH'];
const archiveAvailable = datasetPath !== undefined && datasetPath.trim() !== '';

describe.skipIf(!archiveAvailable)('the real USDA archive', () => {
  // Lazy on purpose. `describe.skipIf` skips the TESTS, not the describe body, so reading the
  // archive here would throw during collection on a machine without it - which is exactly the
  // case the skip exists to handle. Memoised so the 15.7 MB parse still happens once.
  let parsed: ReturnType<typeof readUsdaDataset> | undefined;
  const loadDataset = (): ReturnType<typeof readUsdaDataset> => {
    parsed ??= readUsdaDataset(resolveUsdaDatasetPath(process.env));
    return parsed;
  };

  it('carries 1,882 ingredients, every one of them with all four macros', () => {
    // TSD 7.4 states this outright. Asserting it turns the claim into a check: if a refreshed
    // archive drops a macro anywhere, the number moves and this fails.
    expect(loadDataset().ingredients.size).toBe(1882);
    expect(loadDataset().incompleteCodes).toEqual([]);
  });

  it('matches the butter spot check', () => {
    const butter = loadDataset().ingredients.get('1001');
    expect(butter?.description).toBe('Butter, stick, salted');
    expect(butter?.kcal.value).toBe(743);
    expect(butter?.proteinGrams.value).toBe(0.85);
    expect(butter?.carbsGrams.value).toBe(0.06);
    expect(butter?.fatGrams.value).toBe(82.2);
  });

  it('matches the raw long-grain rice spot check', () => {
    const rice = loadDataset().ingredients.get('20044');
    expect(rice?.description).toBe('Rice, white, long-grain, regular, raw, enriched');
    expect(rice?.kcal.value).toBe(365);
    expect(rice?.proteinGrams.value).toBe(7.13);
    expect(rice?.carbsGrams.value).toBe(79.95);
    expect(rice?.fatGrams.value).toBe(0.66);
  });

  it('reports how provenance is distributed across the archive', () => {
    let withoutAnyFdcId = 0;
    let withSomeMissingFdcId = 0;
    let withSplitFdcId = 0;

    for (const ingredient of loadDataset().ingredients.values()) {
      const ids = MACRO_KEYS.map((macro) => ingredient[macro].fdcId);
      const present = ids.filter((id): id is string => id !== null);
      if (present.length === 0) {
        withoutAnyFdcId += 1;
      }
      if (present.length !== ids.length) {
        withSomeMissingFdcId += 1;
      }
      if (new Set(present).size > 1) {
        withSplitFdcId += 1;
      }
    }

    console.log(
      `[USDA ${loadDataset().vintage}] ingredients=${loadDataset().ingredients.size} ` +
        `allFourMacros=${loadDataset().ingredients.size} ` +
        `noFdcIdAtAll=${withoutAnyFdcId} someMacroMissingFdcId=${withSomeMissingFdcId} ` +
        `splitAcrossFdcRecords=${withSplitFdcId}`,
    );

    // TSD 7.4 declares `NutrientRow.fdcId` a plain string. These counts are the measured
    // reason that cannot hold for every ingredient - see the note on `NutrientRow.fdcId`.
    expect(withoutAnyFdcId).toBeGreaterThan(0);
    expect(withSplitFdcId).toBeGreaterThan(0);
  });

  it('binds every curated ingredient to a code the archive actually carries', () => {
    // The binding table is verified against the real file here, so a typo in a code is
    // caught once rather than at the moment a meal derives to `unavailable`.
    const missing: string[] = [];
    const misdescribed: string[] = [];

    for (const [key, binding] of INGREDIENT_BINDINGS) {
      const ingredient = loadDataset().ingredients.get(binding.usdaCode);
      if (ingredient === undefined) {
        missing.push(`${key} -> ${binding.usdaCode}`);
      } else if (ingredient.description !== binding.usdaDescription) {
        misdescribed.push(`${key}: "${binding.usdaDescription}" != "${ingredient.description}"`);
      }
    }

    expect(missing).toEqual([]);
    expect(misdescribed).toEqual([]);
  });

  it('builds a committed subset holding only the ingredients asked for', () => {
    const names = ['Butter', 'Olive Oil', 'Aubergine', 'Courgettes', 'Prawns', 'Rice'];
    const build = buildNutritionSource(loadDataset(), names);

    expect(build.unresolved).toEqual([]);
    expect(build.source.rows.map((row) => row.key)).toEqual([
      'butter',
      'eggplant',
      'olive oil',
      'rice',
      'shrimp',
      'zucchini',
    ]);

    console.log(
      `[subset] ${build.source.rows.length} rows from ${loadDataset().ingredients.size} ingredients; ` +
        `notes=${build.traceabilityNotes.length}`,
    );
    for (const note of build.traceabilityNotes) {
      console.log(`  note: ${note}`);
    }

    for (const row of build.source.rows) {
      console.log(
        `  ${row.key.padEnd(12)} usda=${row.usdaCode.padEnd(7)} fdcId=${String(row.fdcId).padEnd(7)} ` +
          `kcal=${row.per100g.kcal} protein=${row.per100g.proteinGrams} ` +
          `carbs=${row.per100g.carbsGrams} fat=${row.per100g.fatGrams} [${row.sourceLabel}]`,
      );
    }
  });

  it('emits olive oil with a null fdcId rather than an invented one', () => {
    // Olive oil is one of the 44 ingredients the archive publishes no FDC ID for, and it is
    // unavoidable in a recipe catalog. `null` is the honest value; `""` would be a fabricated
    // identifier. This is the TSD 7.4 divergence, exercised on the real data.
    const build = buildNutritionSource(loadDataset(), ['Olive Oil']);
    const oliveOil = build.source.rows[0];

    expect(oliveOil?.fdcId).toBeNull();
    expect(oliveOil?.sourceLabel.length).toBeGreaterThan(0);
    expect(build.traceabilityNotes.join(' ')).toContain('publishes no FDC ID');
  });
});
