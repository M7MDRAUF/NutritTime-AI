/**
 * Nutrition derivation (TSD 7.4, T-07-09).
 *
 * **The all-or-nothing rule lives here.** If any ingredient fails to resolve, or its measure
 * fails to parse, the meal's four values are all `null` and the reason names the ingredient
 * that caused it. No partial sums, no substituted averages, no category defaults.
 *
 * A partial sum is worse than no number, because it looks complete. "480 kcal" computed from
 * nine of a recipe's eleven ingredients is not an approximation a reader can discount - it is
 * simply wrong, and nothing on the screen says so. PRD FR-006 and the T-07-09 stop-condition
 * both forbid it outright.
 */

import type { Ingredient, NutritionProvenance, NutritionSummary } from '@nutritime/contracts';
import { resolveIngredient } from './ingredient-resolver.js';
import { parseMeasureToGrams } from './measure.js';
import { USDA_DATASET_LABEL } from './usda-dataset.js';
import type { NutrientRow, NutritionSource } from './usda-dataset.js';

export interface DerivedNutrition {
  readonly nutrition: NutritionSummary;
  readonly provenance: NutritionProvenance;
  /** Every `fdcId` that contributed, for the T-07-11 traceability assertion. */
  readonly fdcIds: readonly string[];
  /** The USDA ingredient codes that contributed, which exist even where an FDC ID does not. */
  readonly usdaCodes: readonly string[];
}

const UNAVAILABLE: NutritionSummary = {
  calories: null,
  proteinGrams: null,
  carbsGrams: null,
  fatGrams: null,
};

function unavailable(reason: string): DerivedNutrition {
  return {
    nutrition: UNAVAILABLE,
    // No dataset and no servings: `mealSchema`'s superRefine requires both to be absent when
    // the origin is `unavailable`, because neither describes a figure that was never produced.
    provenance: { origin: 'unavailable', dataset: null, servings: null, reason },
    fdcIds: [],
    usdaCodes: [],
  };
}

/**
 * True when all four macros are exactly zero, so this food cannot change any total.
 *
 * Salt and water are the cases that matter. Note the test is on the DATA, not on a list of
 * ingredient names: an ingredient earns this only by publishing four zeroes in the USDA table,
 * so it can never be claimed for a food that actually contributes something.
 */
function isNutritionallyInert(row: NutrientRow): boolean {
  const { kcal, proteinGrams, carbsGrams, fatGrams } = row.per100g;
  return kcal === 0 && proteinGrams === 0 && carbsGrams === 0 && fatGrams === 0;
}

/** Rows keyed for lookup. Built once per run rather than per meal. */
export function indexNutritionSource(source: NutritionSource): ReadonlyMap<string, NutrientRow> {
  return new Map(source.rows.map((row) => [row.key, row]));
}

/**
 * Four macros per serving, or four `null`s and the reason.
 *
 * The arithmetic is deliberately plain: grams for the whole recipe, scaled from the per-100 g
 * figures, divided by the authored serving count, rounded once at the end. Rounding once
 * matters - rounding each ingredient first and summing would drift by several kcal on a
 * nineteen-ingredient recipe, and the schema wants integers.
 */
export function deriveNutrition(
  ingredients: readonly Ingredient[],
  servings: number,
  rowsByKey: ReadonlyMap<string, NutrientRow>,
): DerivedNutrition {
  if (!Number.isInteger(servings) || servings < 1) {
    return unavailable(`the authored serving count ${String(servings)} is not a positive integer`);
  }

  let kcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  const fdcIds = new Set<string>();
  const usdaCodes = new Set<string>();

  for (const ingredient of ingredients) {
    const resolution = resolveIngredient(ingredient.name);
    if (!resolution.ok) {
      return unavailable(`${ingredient.name}: ${resolution.reason}`);
    }

    const row = rowsByKey.get(resolution.key);
    if (row === undefined) {
      // The subset is built from these same names, so this means the subset is stale rather
      // than that the ingredient is unknown. Saying which is the difference between a fix and
      // a hunt.
      return unavailable(
        `${ingredient.name}: resolved to "${resolution.key}", which is absent from the ` +
          'committed nutrition source - rebuild it',
      );
    }

    const measure = parseMeasureToGrams(ingredient.measure, resolution.binding.measure);
    if (!measure.ok) {
      // **The one case where an unparseable measure is not fatal, and it is not an exception
      // to the all-or-nothing rule - it is a consequence of it.**
      //
      // Salt and water publish 0 kcal, 0 protein, 0 carbohydrate and 0 fat per 100 g. Any mass
      // multiplied by zero is zero, so the meal's four totals are provably INDEPENDENT of the
      // quantity this measure failed to state. Reporting them is exact, not an estimate.
      //
      // "Salt - to taste" appears throughout the catalog. Failing the whole meal on it would
      // discard four figures that are demonstrably unaffected by the missing number, which
      // serves nobody. Any ingredient carrying a single non-zero macro still fails here.
      if (isNutritionallyInert(row)) {
        continue;
      }
      return unavailable(`${ingredient.name} "${ingredient.measure}": ${measure.reason}`);
    }

    const hundredths = measure.grams / 100;
    kcal += row.per100g.kcal * hundredths;
    protein += row.per100g.proteinGrams * hundredths;
    carbs += row.per100g.carbsGrams * hundredths;
    fat += row.per100g.fatGrams * hundredths;

    if (row.fdcId !== null) {
      fdcIds.add(row.fdcId);
    }
    usdaCodes.add(row.usdaCode);
  }

  const perServing = (total: number): number => Math.round(total / servings);

  return {
    nutrition: {
      calories: perServing(kcal),
      proteinGrams: perServing(protein),
      carbsGrams: perServing(carbs),
      fatGrams: perServing(fat),
    },
    provenance: {
      origin: 'usda-derived',
      dataset: USDA_DATASET_LABEL,
      // Recorded as authored, not sourced: TheMealDB publishes no serving count, so this
      // number came from a person reading the recipe. It divides all four macros.
      servings,
      reason: null,
    },
    fdcIds: [...fdcIds].sort(),
    usdaCodes: [...usdaCodes].sort(),
  };
}
