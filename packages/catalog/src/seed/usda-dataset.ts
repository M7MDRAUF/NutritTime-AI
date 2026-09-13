/**
 * USDA FoodData Central dataset parser and `nutrition-source.json` emitter
 * (T-07-06, TSD 7.4).
 *
 * The archive is NOT in the repository and must never enter it: 15.7 MB of CSV holding
 * 122,330 rows for 1,882 ingredients, of which the catalog uses a few dozen. The seed script
 * reads it by path from `USDA_DATASET_PATH` at build time and emits the small committed
 * subset, so the derivation stays reproducible without shipping the archive (TSD 7.4,
 * "Committed artifact").
 *
 * Nutrient codes, confirmed against `nutrient.csv` in this archive rather than assumed - the
 * value file's "Nutrient code" column holds FDC's `nutrient_nbr`, not its `id`, so 208 is
 * energy even though the row whose `id` is 208 is something else entirely:
 *
 *     "1008","Energy","KCAL","208","300.0"
 *     "1003","Protein","G","203","600.0"
 *     "1004","Total lipid (fat)","G","204","800.0"
 *     "1005","Carbohydrate, by difference","G","205","1110.0"
 *
 * `verifyNutrientCodes` re-checks that mapping from the shipped file at build time, so a
 * dataset refresh that renumbered anything fails loudly instead of silently reading fat as
 * carbohydrate. All values are per 100 g.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCsv } from './csv.js';
import { resolveIngredient } from './ingredient-resolver.js';

/** The archive's vintage, recorded in every record's `nutritionProvenance.dataset`. */
export const USDA_DATASET_VINTAGE = '2022-10-28';

/** The human-readable dataset label carried into `nutritionProvenance.dataset`. */
export const USDA_DATASET_LABEL = `USDA FNDDS supporting data ${USDA_DATASET_VINTAGE}`;

export const USDA_VALUE_FILENAME = 'fndds_ingredient_nutrient_value.csv';
export const USDA_NUTRIENT_FILENAME = 'nutrient.csv';

/** The committed subset, relative to `packages/catalog`. */
export const NUTRITION_SOURCE_FILENAME = 'nutrition-source.json';

/** FDC `nutrient_nbr` values for the four macros TSD 7.4 derives from. */
export const NUTRIENT_CODES = {
  kcal: '208',
  proteinGrams: '203',
  carbsGrams: '205',
  fatGrams: '204',
} as const;

export type MacroKey = keyof typeof NUTRIENT_CODES;

/**
 * Evaluation order for the four macros. Also the deterministic tie-break when the macro rows
 * of one ingredient disagree about which FDC record they came from.
 */
export const MACRO_KEYS: readonly MacroKey[] = ['kcal', 'proteinGrams', 'carbsGrams', 'fatGrams'];

/** The value file's header, verbatim. Checked so a reshaped file cannot be misread. */
const EXPECTED_VALUE_HEADER: readonly string[] = [
  'ingredient code',
  'Ingredient description',
  'Nutrient code',
  'Nutrient value',
  'Nutrient value source',
  'FDC ID',
  'Derivation code',
  'SR AddMod year',
  'Foundation year acquired',
  'Start date',
  'End date',
];

const VALUE_COLUMN = {
  ingredientCode: 0,
  ingredientDescription: 1,
  nutrientCode: 2,
  nutrientValue: 3,
  nutrientValueSource: 4,
  fdcId: 5,
} as const;

const NUTRIENT_COLUMN = { name: 1, unitName: 2, nutrientNumber: 3 } as const;

/** The unit each macro must be published in, per `nutrient.csv`. */
const EXPECTED_NUTRIENT_UNITS: Readonly<Record<MacroKey, string>> = {
  kcal: 'KCAL',
  proteinGrams: 'G',
  carbsGrams: 'G',
  fatGrams: 'G',
};

/** One macro reading, with the provenance the row it came from actually carried. */
export interface MacroFigure {
  /** Per 100 g. */
  readonly value: number;
  /** `null` where the dataset publishes no FDC ID for this row - 45 rows do not. */
  readonly fdcId: string | null;
  readonly sourceLabel: string;
}

export interface UsdaIngredient {
  readonly code: string;
  readonly description: string;
  readonly kcal: MacroFigure;
  readonly proteinGrams: MacroFigure;
  readonly carbsGrams: MacroFigure;
  readonly fatGrams: MacroFigure;
}

export interface UsdaDataset {
  readonly vintage: string;
  readonly ingredients: ReadonlyMap<string, UsdaIngredient>;
  /**
   * Ingredient codes seen carrying some, but not all four, macros. Reported rather than
   * emitted with a hole: a partial ingredient is exactly what TSD 7.4's all-or-nothing rule
   * forbids from ever reaching a meal. Measured as empty on the 2022-10-28 archive.
   */
  readonly incompleteCodes: readonly string[];
}

/** A row of the committed subset. Shape per TSD 7.4, with `fdcId` nullable - see below. */
export interface NutrientRow {
  /** The canonical ingredient key the resolver files this food under. */
  readonly key: string;
  /** The USDA food description, verbatim. */
  readonly description: string;
  /** The USDA ingredient code this row was read from. */
  readonly usdaCode: string;
  /**
   * **Divergence from TSD 7.4, which declares `readonly fdcId: string`.**
   *
   * The archive does not publish an FDC ID for every row. Measured on the 2022-10-28 file:
   * 45 of 1,882 ingredients carry an empty `FDC ID` on at least one macro, and 44 carry none
   * on any - among them olive oil, unsalted butter and the canola, corn, peanut and soybean
   * oils, which a recipe catalog cannot avoid. Their provenance survives in `sourceLabel`
   * instead.
   *
   * `null` says that honestly. An empty string would be a fabricated identifier wearing the
   * shape of a real one, which is the failure mode this project refuses everywhere else.
   * Reported rather than resolved here: TSD 7.4 is the authority and should decide.
   */
  readonly fdcId: string | null;
  readonly sourceLabel: string;
  readonly per100g: {
    readonly kcal: number;
    readonly proteinGrams: number;
    readonly carbsGrams: number;
    readonly fatGrams: number;
  };
}

/** The committed `nutrition-source.json`. */
export interface NutritionSource {
  readonly dataset: string;
  readonly vintage: string;
  readonly rows: readonly NutrientRow[];
}

export interface UnresolvedIngredient {
  readonly name: string;
  readonly kind: string;
  readonly reason: string;
}

export interface NutritionSourceBuild {
  readonly source: NutritionSource;
  /**
   * Names that resolved to no dataset row. Returned rather than thrown so one run reports
   * every gap at once; the caller decides, and T-07-09 turns any gap into four `null`s for
   * the meals that use it.
   */
  readonly unresolved: readonly UnresolvedIngredient[];
  /** Places where provenance had to be collapsed or is missing. Never silent. */
  readonly traceabilityNotes: readonly string[];
}

function requireCell(row: readonly string[], index: number, context: string): string {
  const cell = row[index];
  // noUncheckedIndexedAccess: a short row is a real possibility in a 122,330-row file, and
  // reading `undefined` as an empty value would quietly shift every later column.
  if (cell === undefined) {
    throw new Error(`${context}: expected a value in column ${index}, found a short row`);
  }
  return cell;
}

/**
 * Confirm the four nutrient codes against the archive's own `nutrient.csv`, by number, name
 * and unit. Throws on any mismatch.
 */
export function verifyNutrientCodes(nutrientCsvText: string): void {
  const rows = parseCsv(nutrientCsvText);
  const [header, ...dataRows] = rows;
  if (header === undefined) {
    throw new Error(`${USDA_NUTRIENT_FILENAME} is empty`);
  }

  const byNumber = new Map<string, { name: string; unit: string }>();
  for (const row of dataRows) {
    const number = requireCell(row, NUTRIENT_COLUMN.nutrientNumber, USDA_NUTRIENT_FILENAME);
    byNumber.set(number, {
      name: requireCell(row, NUTRIENT_COLUMN.name, USDA_NUTRIENT_FILENAME),
      unit: requireCell(row, NUTRIENT_COLUMN.unitName, USDA_NUTRIENT_FILENAME),
    });
  }

  for (const macro of MACRO_KEYS) {
    const code = NUTRIENT_CODES[macro];
    const entry = byNumber.get(code);
    if (entry === undefined) {
      throw new Error(
        `${USDA_NUTRIENT_FILENAME} carries no nutrient numbered ${code}, expected for ${macro}`,
      );
    }
    const expectedUnit = EXPECTED_NUTRIENT_UNITS[macro];
    if (entry.unit !== expectedUnit) {
      throw new Error(
        `nutrient ${code} (${entry.name}) is published in ${entry.unit}, not ${expectedUnit}; ` +
          `${macro} would be derived in the wrong unit`,
      );
    }
  }
}

/**
 * Build the per-ingredient macro table from the value CSV.
 *
 * Takes text rather than a path so the parse is testable on a handful of rows without the
 * 15.7 MB archive. Only ingredients carrying all four macros are returned.
 */
export function parseUsdaIngredientTable(csvText: string): UsdaDataset {
  const rows = parseCsv(csvText);
  const [header, ...dataRows] = rows;
  if (header === undefined) {
    throw new Error(`${USDA_VALUE_FILENAME} is empty`);
  }
  if (header.length !== EXPECTED_VALUE_HEADER.length) {
    throw new Error(
      `${USDA_VALUE_FILENAME} has ${header.length} columns, expected ` +
        `${EXPECTED_VALUE_HEADER.length}: the file layout has changed`,
    );
  }
  for (const [index, expected] of EXPECTED_VALUE_HEADER.entries()) {
    if (header[index] !== expected) {
      throw new Error(
        `${USDA_VALUE_FILENAME} column ${index} is "${String(header[index])}", expected ` +
          `"${expected}": the file layout has changed`,
      );
    }
  }

  const codeToMacro = new Map<string, MacroKey>(
    MACRO_KEYS.map((macro) => [NUTRIENT_CODES[macro], macro]),
  );

  const descriptions = new Map<string, string>();
  const collected = new Map<string, Map<MacroKey, MacroFigure>>();

  for (const row of dataRows) {
    const nutrientCode = requireCell(row, VALUE_COLUMN.nutrientCode, USDA_VALUE_FILENAME);
    const macro = codeToMacro.get(nutrientCode);
    if (macro === undefined) {
      continue;
    }

    const code = requireCell(row, VALUE_COLUMN.ingredientCode, USDA_VALUE_FILENAME);
    const rawValue = requireCell(row, VALUE_COLUMN.nutrientValue, USDA_VALUE_FILENAME);
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `ingredient ${code} publishes "${rawValue}" for nutrient ${nutrientCode}, ` +
          'which is not a usable per-100 g value',
      );
    }

    const fdcId = requireCell(row, VALUE_COLUMN.fdcId, USDA_VALUE_FILENAME).trim();
    descriptions.set(
      code,
      requireCell(row, VALUE_COLUMN.ingredientDescription, USDA_VALUE_FILENAME),
    );

    const macros = collected.get(code) ?? new Map<MacroKey, MacroFigure>();
    macros.set(macro, {
      value,
      fdcId: fdcId === '' ? null : fdcId,
      sourceLabel: requireCell(row, VALUE_COLUMN.nutrientValueSource, USDA_VALUE_FILENAME),
    });
    collected.set(code, macros);
  }

  const ingredients = new Map<string, UsdaIngredient>();
  const incompleteCodes: string[] = [];

  for (const [code, macros] of collected) {
    const kcal = macros.get('kcal');
    const proteinGrams = macros.get('proteinGrams');
    const carbsGrams = macros.get('carbsGrams');
    const fatGrams = macros.get('fatGrams');
    const description = descriptions.get(code);

    if (
      kcal === undefined ||
      proteinGrams === undefined ||
      carbsGrams === undefined ||
      fatGrams === undefined ||
      description === undefined
    ) {
      incompleteCodes.push(code);
      continue;
    }
    ingredients.set(code, { code, description, kcal, proteinGrams, carbsGrams, fatGrams });
  }

  return { vintage: USDA_DATASET_VINTAGE, ingredients, incompleteCodes };
}

/**
 * Read `USDA_DATASET_PATH` from an environment.
 *
 * T-07-06's stop-condition override: if the variable is unset or the archive is missing, stop
 * and record a blocker. Do not fall back to any other nutrition source. So this throws, and
 * the message says which variable and which file.
 */
export function resolveUsdaDatasetPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = env['USDA_DATASET_PATH'];
  if (configured === undefined || configured.trim() === '') {
    throw new Error(
      'USDA_DATASET_PATH is not set. TSD 7.4 derives nutrition from the USDA FoodData ' +
        'Central supporting-data archive and Plan.md T-07-06 forbids any other source, so ' +
        'there is nothing to fall back to. Set it in .env to the extracted archive directory.',
    );
  }
  return configured.trim();
}

/** Read and verify the archive from disk. The one function here that touches the file system. */
export function readUsdaDataset(datasetPath: string): UsdaDataset {
  const nutrientPath = join(datasetPath, USDA_NUTRIENT_FILENAME);
  const valuePath = join(datasetPath, USDA_VALUE_FILENAME);

  let nutrientCsv: string;
  let valueCsv: string;
  try {
    nutrientCsv = readFileSync(nutrientPath, 'utf8');
    valueCsv = readFileSync(valuePath, 'utf8');
  } catch (cause) {
    throw new Error(
      `the USDA archive is not readable at ${datasetPath}. Expected ` +
        `${USDA_NUTRIENT_FILENAME} and ${USDA_VALUE_FILENAME} there. ` +
        'Plan.md T-07-06 stops rather than substituting another nutrition source.',
      { cause },
    );
  }

  verifyNutrientCodes(nutrientCsv);
  return parseUsdaIngredientTable(valueCsv);
}

/**
 * Collapse four per-macro provenances into the single pair TSD 7.4's `NutrientRow` declares.
 *
 * The dataset mostly agrees with the TSD: 1,880 of 1,882 ingredients quote one FDC record for
 * all four macros. Two do not - butter (code 1001) takes its fat from FDC 790508 "Foundation"
 * and its protein and carbohydrate from FDC 173410 "SR Legacy" - so a rule is needed, and it
 * must be deterministic and visible rather than incidental.
 *
 * The rule: the macro backing the most macros' FDC ID wins, ties broken by `MACRO_KEYS`
 * order; its ID and its label are kept together so the pair stays coherent. Every collapse
 * that loses information emits a note.
 */
function collapseProvenance(
  ingredient: UsdaIngredient,
  key: string,
): { fdcId: string | null; sourceLabel: string; notes: string[] } {
  const figures = MACRO_KEYS.map((macro) => ({ macro, figure: ingredient[macro] }));
  const notes: string[] = [];

  const counts = new Map<string, number>();
  for (const { figure } of figures) {
    if (figure.fdcId !== null) {
      counts.set(figure.fdcId, (counts.get(figure.fdcId) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    const first = figures[0];
    const label = first === undefined ? 'unknown' : first.figure.sourceLabel;
    notes.push(
      `${key} (USDA ${ingredient.code}, "${ingredient.description}") publishes no FDC ID for ` +
        `any of its four macros; provenance rests on the source label "${label}" alone`,
    );
    return { fdcId: null, sourceLabel: label, notes };
  }

  let chosen = figures[0];
  let best = -1;
  for (const entry of figures) {
    const count = entry.figure.fdcId === null ? -1 : (counts.get(entry.figure.fdcId) ?? 0);
    if (count > best) {
      best = count;
      chosen = entry;
    }
  }
  if (chosen === undefined) {
    throw new Error(`${key} has no macro figures to collapse`);
  }

  if (counts.size > 1) {
    const detail = figures
      .map(({ macro, figure }) => `${macro}=${figure.fdcId ?? 'none'}`)
      .join(', ');
    notes.push(
      `${key} (USDA ${ingredient.code}, "${ingredient.description}") draws its macros from ` +
        `more than one FDC record (${detail}); the emitted row quotes ` +
        `${chosen.figure.fdcId ?? 'none'} from ${chosen.macro}`,
    );
  } else if (figures.some(({ figure }) => figure.fdcId === null)) {
    notes.push(
      `${key} (USDA ${ingredient.code}) publishes no FDC ID for some macros; the emitted row ` +
        `quotes ${chosen.figure.fdcId ?? 'none'} from ${chosen.macro}`,
    );
  }

  return { fdcId: chosen.figure.fdcId, sourceLabel: chosen.figure.sourceLabel, notes };
}

/**
 * Build the committed subset for exactly the ingredient names the catalog uses.
 *
 * Names are resolved through `resolveIngredient`, so a name that does not resolve is reported
 * rather than approximated. Two names for one food produce one row. Rows are sorted by key so
 * the committed file has a stable diff across runs.
 */
export function buildNutritionSource(
  dataset: UsdaDataset,
  ingredientNames: Iterable<string>,
): NutritionSourceBuild {
  const rowsByKey = new Map<string, NutrientRow>();
  const unresolved: UnresolvedIngredient[] = [];
  const seenUnresolved = new Set<string>();
  const traceabilityNotes: string[] = [];

  for (const name of ingredientNames) {
    const resolution = resolveIngredient(name);
    if (!resolution.ok) {
      if (!seenUnresolved.has(name)) {
        seenUnresolved.add(name);
        unresolved.push({ name, kind: resolution.kind, reason: resolution.reason });
      }
      continue;
    }

    const { key, binding } = resolution;
    if (rowsByKey.has(key)) {
      continue;
    }

    const ingredient = dataset.ingredients.get(binding.usdaCode);
    if (ingredient === undefined) {
      throw new Error(
        `"${name}" is bound to USDA ingredient code ${binding.usdaCode}, which the ` +
          `${dataset.vintage} dataset does not carry with all four macros. The binding in ` +
          'ingredient-bindings.ts is stale.',
      );
    }

    // The binding records the description it was made against. A dataset refresh that reuses
    // a code for a different food would otherwise repoint an ingredient in silence.
    if (ingredient.description !== binding.usdaDescription) {
      throw new Error(
        `USDA ingredient code ${binding.usdaCode} now describes ` +
          `"${ingredient.description}" but was bound to "${binding.usdaDescription}" for ` +
          `"${key}". Re-verify the binding before deriving anything from it.`,
      );
    }

    const { fdcId, sourceLabel, notes } = collapseProvenance(ingredient, key);
    traceabilityNotes.push(...notes);

    rowsByKey.set(key, {
      key,
      description: ingredient.description,
      usdaCode: ingredient.code,
      fdcId,
      sourceLabel,
      per100g: {
        kcal: ingredient.kcal.value,
        proteinGrams: ingredient.proteinGrams.value,
        carbsGrams: ingredient.carbsGrams.value,
        fatGrams: ingredient.fatGrams.value,
      },
    });
  }

  const rows = [...rowsByKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    source: { dataset: USDA_DATASET_LABEL, vintage: dataset.vintage, rows },
    unresolved,
    traceabilityNotes,
  };
}

/**
 * Serialise the committed subset. Separate from the write so a caller can inspect the text,
 * and so a test never needs to touch the file system.
 */
export function serializeNutritionSource(source: NutritionSource): string {
  return `${JSON.stringify(source, null, 2)}\n`;
}

/** Where the committed subset lives, given the `packages/catalog` directory. */
export function nutritionSourcePath(packageDirectory: string): string {
  return join(packageDirectory, NUTRITION_SOURCE_FILENAME);
}

/**
 * Write the committed subset.
 *
 * Refuses to write a subset that is missing ingredients the catalog asked for. A short
 * `nutrition-source.json` is not a smaller correct file - it is a file that will make meals
 * derive as `unavailable` for a reason nobody recorded, and the gap is invisible once the run
 * has scrolled past. The caller either fixes the bindings or passes `allowUnresolved` to say
 * the gaps are known and accepted.
 */
export function writeNutritionSource(
  build: NutritionSourceBuild,
  filePath: string,
  options: { readonly allowUnresolved?: boolean } = {},
): void {
  if (build.unresolved.length > 0 && options.allowUnresolved !== true) {
    const detail = build.unresolved.map(({ name, kind }) => `${name} (${kind})`).join(', ');
    throw new Error(
      `${build.unresolved.length} ingredient(s) did not resolve to a dataset row: ${detail}. ` +
        'Add a binding, or pass allowUnresolved to accept that the meals using them will ' +
        'derive as unavailable.',
    );
  }
  writeFileSync(filePath, serializeNutritionSource(build.source), 'utf8');
}
