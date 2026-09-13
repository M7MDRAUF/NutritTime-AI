/**
 * The seed pipeline (TSD 7.2), run by hand with `npm run seed`.
 *
 * Never in CI and never at boot. It reaches the network and a 16 MB archive on a machine-local
 * path, and it writes two files that are then committed and reviewed. The running app talks to
 * neither TheMealDB nor USDA.
 *
 * The seven steps of TSD 7.2 are the seven sections below, in order. Two of them will stop the
 * run rather than produce a file:
 *
 * - a missing `USDA_DATASET_PATH` stops immediately, because there is no second nutrition
 *   source to fall back to (T-07-06);
 * - any record failing `mealSchema` aborts the write, so a half-valid catalog never lands.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { inferAllergensFromIngredients } from '@nutritime/domain';
import { AUTHORED_MEALS } from './src/seed/authoring.js';
import type { AuthoredMeal } from './src/seed/authoring.js';
import { deriveNutrition, indexNutritionSource } from './src/seed/derive.js';
import { mapRawMeal } from './src/seed/map.js';
import type { MappedMeal } from './src/seed/map.js';
import { filterByCategory, lookupMeal, THEMEALDB_ATTRIBUTION } from './src/seed/themealdb.js';
import {
  buildNutritionSource,
  nutritionSourcePath,
  readUsdaDataset,
  resolveUsdaDatasetPath,
  writeNutritionSource,
} from './src/seed/usda-dataset.js';

export const CATALOG_VERSION = '1.0.0';
export const EXPECTED_MEAL_COUNT = 60;

/**
 * Which categories the catalog is drawn from, and how many of each.
 *
 * Spread deliberately: breakfast dishes so the breakfast period is not empty, a vegan block so
 * the strictest diet has real options, and enough cuisines that the allergen lexicon is
 * exercised by more than one tradition. Candidates are taken in ascending id order, so the
 * same sixty come back on every run.
 */
const CATEGORY_PLAN: readonly (readonly [string, number])[] = [
  ['Breakfast', 7],
  ['Vegetarian', 9],
  ['Vegan', 5],
  ['Chicken', 7],
  ['Beef', 5],
  ['Seafood', 7],
  ['Pasta', 5],
  ['Dessert', 7],
  ['Side', 4],
  ['Starter', 4],
];

function fail(message: string): never {
  throw new Error(message);
}

/** Step 1 and 2: select, then look each one up in full. */
async function fetchMeals(): Promise<readonly MappedMeal[]> {
  const mapped: MappedMeal[] = [];
  for (const [category, take] of CATEGORY_PLAN) {
    const summaries = [...(await filterByCategory(category))].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (summaries.length < take) {
      fail(
        `category ${category} returned ${String(summaries.length)} meals, needed ${String(take)}`,
      );
    }
    for (const summary of summaries.slice(0, take)) {
      // Always lookup.php: a filter response is a summary and carries no ingredients.
      const raw = await lookupMeal(summary.id);
      if (raw === null) {
        fail(`lookup returned no data for ${summary.id} (${summary.name})`);
      }
      const record = mapRawMeal(raw);
      if (record === null) {
        fail(`meal ${summary.id} (${summary.name}) is missing a name, ingredients or steps`);
      }
      mapped.push(record);
    }
  }
  return mapped;
}

/**
 * Step 4: derived tags, then the hand review.
 *
 * The union, never the override. A reviewer adds what inference missed; nothing in the
 * authoring table can take a tag away, because the one thing a person is most likely to get
 * wrong is deciding an allergen is not really there.
 */
function reviewedAllergens(meal: MappedMeal, authored: AuthoredMeal): readonly string[] {
  const derived = inferAllergensFromIngredients(meal.ingredients.map((item) => item.name));
  return [...new Set([...derived, ...(authored.allergenAdditions ?? [])])].sort();
}

/**
 * Step 5: the authored fields.
 *
 * `gluten-aware` is derived from the reviewed allergen tags rather than authored, so the two
 * can never contradict each other. A hand-typed `gluten-aware` on a dish whose tags say wheat
 * is exactly the kind of quiet disagreement that reaches a user as a safe-looking meal.
 */
function dietTags(authored: AuthoredMeal, allergenTags: readonly string[]): Meal['dietTags'] {
  const glutenFree = !allergenTags.includes('gluten') && !allergenTags.includes('wheat');
  return glutenFree ? [authored.diet, 'gluten-aware'] : [authored.diet];
}

async function main(): Promise<void> {
  // Step 0 - the dataset, before anything else. T-07-06 stops here rather than falling back.
  const datasetPath = resolveUsdaDatasetPath(process.env);
  const dataset = readUsdaDataset(datasetPath);
  console.log(`USDA ${dataset.vintage}: ${String(dataset.ingredients.size)} ingredients`);

  const mapped = await fetchMeals();
  console.log(`TheMealDB: ${String(mapped.length)} meals mapped`);
  if (mapped.length !== EXPECTED_MEAL_COUNT) {
    fail(`expected ${String(EXPECTED_MEAL_COUNT)} meals, got ${String(mapped.length)}`);
  }

  const ids = new Set(mapped.map((meal) => meal.id));
  if (ids.size !== mapped.length) {
    fail('two meals produced the same id');
  }
  const unauthored = mapped.filter((meal) => AUTHORED_MEALS[meal.id] === undefined);
  if (unauthored.length > 0) {
    // Loudly, because the alternative is a record with no serving count quietly deriving as
    // unavailable, or worse, a default price nobody chose.
    fail(`no authoring entry for: ${unauthored.map((meal) => meal.id).join(', ')}`);
  }

  // Step 6a - the committed nutrient subset, for exactly the ingredients these meals use.
  const names = mapped.flatMap((meal) => meal.ingredients.map((item) => item.name));
  const build = buildNutritionSource(dataset, names);
  for (const note of build.traceabilityNotes) {
    console.log(`  trace: ${note}`);
  }
  if (build.unresolved.length > 0) {
    console.log(`  ${String(build.unresolved.length)} ingredient name(s) did not resolve:`);
    for (const entry of build.unresolved) {
      console.log(`    ${entry.name} (${entry.kind})`);
    }
  }
  const rowsByKey = indexNutritionSource(build.source);

  // Step 6b - derive, all-or-nothing per meal.
  const meals: Meal[] = [];
  let derivedCount = 0;
  for (const record of mapped) {
    const authored = AUTHORED_MEALS[record.id];
    if (authored === undefined) {
      fail(`unreachable: ${record.id} lost its authoring entry`);
    }
    const allergenTags = reviewedAllergens(record, authored);
    const derived = deriveNutrition(record.ingredients, authored.servings, rowsByKey);
    if (derived.provenance.origin === 'usda-derived') {
      derivedCount += 1;
    }

    meals.push({
      id: record.id,
      name: record.name,
      description: authored.description,
      mealPeriods: authored.mealPeriods,
      ingredients: record.ingredients,
      instructions: record.instructions,
      allergenTags,
      dietTags: dietTags(authored, allergenTags),
      nutrition: derived.nutrition,
      price: { amountCents: authored.priceCents, currency: 'USD' },
      preparationMinutes: authored.preparationMinutes,
      imageUrl: record.imageUrl,
      available: true,
      source: 'local',
      catalogVersion: CATALOG_VERSION,
      provenance: record.provenance,
      nutritionProvenance: derived.provenance,
    });
  }

  // Step 7 - validate every record, then write. A single failure aborts both files.
  const failures: string[] = [];
  for (const meal of meals) {
    const result = mealSchema.safeParse(meal);
    if (!result.success) {
      failures.push(
        `${meal.id}: ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      );
    }
  }
  if (failures.length > 0) {
    fail(`${String(failures.length)} record(s) failed mealSchema:\n  ${failures.join('\n  ')}`);
  }

  const packageDirectory = path.resolve(import.meta.dirname);
  writeNutritionSource(build, nutritionSourcePath(packageDirectory), { allowUnresolved: true });
  writeFileSync(
    path.join(packageDirectory, 'meals.json'),
    `${JSON.stringify(meals, null, 2)}\n`,
    'utf8',
  );

  console.log(`\nwrote meals.json (${String(meals.length)} records)`);
  console.log(`  nutrition derived for ${String(derivedCount)} of ${String(meals.length)}`);
  console.log(`  ${String(build.source.rows.length)} nutrient rows committed`);
  console.log(`  ${THEMEALDB_ATTRIBUTION}`);
}

await main();
