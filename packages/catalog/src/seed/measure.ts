/**
 * Measure string to grams (T-07-08, TSD 7.4 step 2).
 *
 * The contract is the return type. Every path ends in either a gram figure or a named
 * failure; there is no third option, no default and no zero standing in for "unknown". That
 * matters because of T-07-09's stop-condition override: one ingredient whose measure does not
 * parse makes the whole meal's nutrition `null`. A failure a caller could mistake for a
 * quantity - `0`, `NaN`, a guessed average - would silently produce a complete-looking meal
 * built on a missing ingredient, which the Plan calls worse than no number at all.
 *
 * `normalizeText` from the domain is deliberately NOT used here. It collapses every
 * non-alphanumeric run to a space, which would turn `1/2` into `1 2` and `1.5` into `1 5`. It
 * is the right primitive for ingredient names and the wrong one for quantities.
 *
 * Conversion policy, and why it is strict:
 *
 *   - **Mass units convert unconditionally.** A gram is a gram whatever the food.
 *   - **Volume units require a per-ingredient density.** A millilitre is not a gram: a cup of
 *     water is 237 g, a cup of flour about 125 g, a cup of honey about 337 g. Defaulting to
 *     water would understate flour by nearly half while looking perfectly plausible, which is
 *     exactly the quiet error Plan.md R-03 names. So a volume measure on an ingredient with
 *     no declared density fails.
 *   - **Countable and vague units require a per-ingredient gram weight.** `3 cloves` converts
 *     only because garlic declares what a clove weighs. `1 tin` declares nothing, so it
 *     fails - the behaviour T-07-08's acceptance row names explicitly.
 *
 * The unit table is closed. An unrecognised unit fails rather than falling through to a count,
 * so a typo cannot quietly acquire a gram weight meant for something else.
 */

/** Why a measure could not be converted. Each value is a distinct, actionable defect. */
export type MeasureFailureKind =
  | 'empty-measure'
  | 'ambiguous-range'
  | 'unparsable-quantity'
  | 'non-positive-quantity'
  | 'missing-density'
  | 'missing-unit-weight'
  | 'vague-measure'
  | 'unknown-unit';

/** How the grams were arrived at. Carried so a derived figure stays explainable. */
export type MeasureBasis = 'mass' | 'volume' | 'count';

export interface MeasureSuccess {
  readonly ok: true;
  readonly grams: number;
  readonly basis: MeasureBasis;
  /** The normalised unit the quantity was read in, for traceability. */
  readonly unit: string;
  readonly quantity: number;
}

export interface MeasureFailure {
  readonly ok: false;
  readonly kind: MeasureFailureKind;
  readonly reason: string;
}

/** Grams, or a named failure. Never both, never neither. */
export type MeasureResult = MeasureSuccess | MeasureFailure;

/**
 * The per-ingredient facts a measure may need. Absent data is a failure, not a default: an
 * ingredient earns a volume or count conversion by declaring what it weighs.
 */
export interface IngredientMeasureData {
  /** Grams per millilitre. Without it, no volume unit converts for this ingredient. */
  readonly gramsPerMillilitre?: number;
  /**
   * Grams for one of a countable or vague unit, keyed by the normalised unit word - `clove`,
   * `egg`, `slice`, `tin`. The key `item` covers a bare count carrying no unit at all.
   */
  readonly gramsPerUnit?: Readonly<Record<string, number>>;
}

/** The unit key a bare quantity such as `2` is read as. */
export const BARE_COUNT_UNIT = 'item';

/** US customary, defined from the cup so the table cannot drift out of proportion. */
const MILLILITRES_PER_CUP = 236.5882365;
const MILLILITRES_PER_TABLESPOON = MILLILITRES_PER_CUP / 16;
const MILLILITRES_PER_TEASPOON = MILLILITRES_PER_TABLESPOON / 3;
const MILLILITRES_PER_FLUID_OUNCE = MILLILITRES_PER_CUP / 8;

const GRAMS_PER_UNIT_OF_MASS: Readonly<Record<string, number>> = {
  g: 1,
  gm: 1,
  gms: 1,
  gr: 1,
  gram: 1,
  grams: 1,
  gramme: 1,
  grammes: 1,
  kg: 1000,
  kgs: 1000,
  kilo: 1000,
  kilos: 1000,
  kilogram: 1000,
  kilograms: 1000,
  oz: 28.349523125,
  ozs: 28.349523125,
  ounce: 28.349523125,
  ounces: 28.349523125,
  lb: 453.59237,
  lbs: 453.59237,
  pound: 453.59237,
  pounds: 453.59237,
};

const MILLILITRES_PER_UNIT_OF_VOLUME: Readonly<Record<string, number>> = {
  ml: 1,
  mls: 1,
  millilitre: 1,
  millilitres: 1,
  milliliter: 1,
  milliliters: 1,
  cc: 1,
  l: 1000,
  litre: 1000,
  litres: 1000,
  liter: 1000,
  liters: 1000,
  tsp: MILLILITRES_PER_TEASPOON,
  tsps: MILLILITRES_PER_TEASPOON,
  teaspoon: MILLILITRES_PER_TEASPOON,
  teaspoons: MILLILITRES_PER_TEASPOON,
  tbsp: MILLILITRES_PER_TABLESPOON,
  tbsps: MILLILITRES_PER_TABLESPOON,
  tbs: MILLILITRES_PER_TABLESPOON,
  tablespoon: MILLILITRES_PER_TABLESPOON,
  tablespoons: MILLILITRES_PER_TABLESPOON,
  cup: MILLILITRES_PER_CUP,
  cups: MILLILITRES_PER_CUP,
  'fl oz': MILLILITRES_PER_FLUID_OUNCE,
  floz: MILLILITRES_PER_FLUID_OUNCE,
  'fluid ounce': MILLILITRES_PER_FLUID_OUNCE,
  'fluid ounces': MILLILITRES_PER_FLUID_OUNCE,
  // Conventional US definitions: a dash is an eighth of a teaspoon, a pinch half a dash.
  pinch: MILLILITRES_PER_TEASPOON / 16,
  pinches: MILLILITRES_PER_TEASPOON / 16,
  dash: MILLILITRES_PER_TEASPOON / 8,
  dashes: MILLILITRES_PER_TEASPOON / 8,
};

/**
 * Units that count things rather than measure them. Listed so that `1 tin` fails as a
 * countable unit lacking a declared weight - an actionable gap - rather than as an
 * unrecognised word, which is a different defect with a different fix.
 */
const COUNTABLE_UNITS: ReadonlySet<string> = new Set([
  'clove',
  'egg',
  'slice',
  'piece',
  'can',
  'tin',
  'jar',
  'packet',
  'package',
  'sprig',
  'stalk',
  'stick',
  'head',
  'bunch',
  'leaf',
  'leave',
  'fillet',
  'filet',
  'rasher',
  'breast',
  'thigh',
  'wing',
  'strip',
  'cube',
  'sheet',
  'bulb',
  'ear',
  'bar',
  'loaf',
  'roll',
  'bottle',
  'tub',
  'block',
  'wedge',
  'segment',
  'square',
  'link',
  'patty',
  'scoop',
  'portion',
  'serving',
  'medium',
  'large',
  'small',
  'whole',
]);

/**
 * Measures naming no quantity at all. Listed only so the failure reason is precise - each
 * still fails unless the ingredient declares a gram weight for it.
 */
const VAGUE_UNITS: ReadonlySet<string> = new Set([
  'to taste',
  'to serve',
  'for serving',
  'for garnish',
  'garnish',
  'as needed',
  'as required',
  'to season',
  'some',
  'a little',
  'a few',
  'few',
  'splash',
  'drizzle',
  'sprinkle',
  'dollop',
  'handful',
  'knob',
  'optional',
]);

/**
 * Knife-work and state words that can trail a unit in TheMealDB measures: `3 tblsp chopped`,
 * `2 cups halved`, `1 medium finely diced`. They describe the ingredient, never the amount,
 * so removing them from the END of a unit cannot change the quantity.
 *
 * Stripped only from the trailing position and only when the whole unit was not recognised,
 * so a real unit is never eaten. `ground` is here although the bindings table deliberately
 * excludes it from INGREDIENT preparation words - in a measure string it qualifies the food,
 * not the amount.
 */
const TRAILING_PREPARATION: ReadonlySet<string> = new Set([
  'chopped',
  'sliced',
  'diced',
  'minced',
  'grated',
  'shredded',
  'beaten',
  'halved',
  'quartered',
  'crushed',
  'peeled',
  'ground',
  'fresh',
  'freshly',
  'finely',
  'thinly',
  'roughly',
  'coarsely',
  'boiling',
  'melted',
  'softened',
  'drained',
  'rinsed',
  'washed',
  'trimmed',
  'torn',
  'cubed',
  'cut',
  'into',
  'chunks',
  'cubes',
  'pieces',
  'skinless',
  'skinnless',
  'boneless',
  'hot',
  'cold',
  'warm',
  'dried',
  'plus',
  'extra',
  'approx',
  'about',
  'of',
]);

/** Additional unit spellings TheMealDB actually publishes. */
const UNIT_SPELLINGS: Readonly<Record<string, string>> = {
  tbls: 'tbsp',
  tblsp: 'tbsp',
  tblspn: 'tbsp',
  tblspoon: 'tbsp',
  tbspn: 'tbsp',
  tsps: 'tsp',
  teasp: 'tsp',
  yolkes: 'yolk',
  litres: 'litre',
};

/** Vulgar fractions, mapped with a leading space so `1/2` reads as the mixed number it is. */
const VULGAR_FRACTIONS: Readonly<Record<string, string>> = {
  '¼': ' 1/4',
  '½': ' 1/2',
  '¾': ' 3/4',
  '⅐': ' 1/7',
  '⅑': ' 1/9',
  '⅒': ' 1/10',
  '⅓': ' 1/3',
  '⅔': ' 2/3',
  '⅕': ' 1/5',
  '⅖': ' 2/5',
  '⅗': ' 3/5',
  '⅘': ' 4/5',
  '⅙': ' 1/6',
  '⅚': ' 5/6',
  '⅛': ' 1/8',
  '⅜': ' 3/8',
  '⅝': ' 5/8',
  '⅞': ' 7/8',
};

/** A mixed number, a bare fraction, or a decimal - longest form first so `1 1/2` wins. */
const QUANTITY_PREFIX = /^(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?|\.\d+)\s*(.*)$/;

/** Two quantities joined by a range marker: `2-3`, `1 to 2`. Deliberately not averaged. */
const RANGE = /^\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d/;

function fail(kind: MeasureFailureKind, reason: string): MeasureFailure {
  return { ok: false, kind, reason };
}

/**
 * Lowercase, expand vulgar fractions, drop unit full stops, collapse whitespace - then repair
 * the handful of shapes TheMealDB publishes that would otherwise read as something else.
 *
 * Each repair below was driven by a measure string in the real 60-meal catalog, and each one
 * is a reading of the text rather than an assumption about weight.
 */
function normalizeMeasure(measure: string): string {
  let text = measure.toLowerCase();
  for (const [glyph, replacement] of Object.entries(VULGAR_FRACTIONS)) {
    text = text.split(glyph).join(replacement);
  }
  text = text
    // `tbsp.` and `oz.` are the same units as `tbsp` and `oz`. A full stop here is never a
    // decimal point, because a decimal point is always followed by a digit.
    .replace(/\.(?!\d)/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // A parenthesised metric amount is the precise one: `12 ounces (340g)`, `1 (200g) pack`.
  // Preferring it loses nothing, because it restates the same quantity exactly.
  const parenthesised = /\(([^)]*\d[^)]*)\)/.exec(text);
  if (parenthesised?.[1] !== undefined && /\d\s*(?:g|kg|ml|l|oz|lb)\b/.test(parenthesised[1])) {
    text = parenthesised[1].trim();
  }
  text = text.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

  // `150g/6oz` is one amount written twice. Keep the METRIC half, whichever side it is on:
  // the catalog publishes `6oz/180g` as well, and keeping the first blindly took the imperial
  // approximation (170.1 g) over the stated 180 g.
  const dual = /^(\d+(?:\.\d+)?\s*[a-z]+)\s*\/\s*(\d[^/]*)$/.exec(text);
  const metric = /^\d+(?:\.\d+)?\s*(?:g|kg|ml|l|gram|grams|kilogram|kilograms)\b/;
  if (dual?.[1] !== undefined && dual[2] !== undefined) {
    const [, left, right] = dual;
    text = metric.test(right) && !metric.test(left) ? right.trim() : left.trim();
  }

  // `2-1/2 cups` and `1-1/2 cups` are MIXED NUMBERS, not ranges: the part after the hyphen is
  // a fraction. `2-3 tbsp` is a genuine range and must stay one, so the fraction is what
  // distinguishes them.
  text = text.replace(/^(\d+)\s*-\s*(\d+\s*\/\s*\d+)/, '$1 $2');

  // `3 400g cans` and `1 - 14 ounce can` are a count of a sized container. Multiplying is
  // exact: three 400 g tins is 1200 g.
  // **The separator must be WHITESPACE.** Two earlier versions of this line were wrong in
  // opposite directions and both were silent:
  //
  //   no separator at all -> `400g` matched as 4 x 00 and converted to ZERO grams;
  //   a hyphen allowed    -> `4-5 pound` matched as 4 x 5 and converted to 9071 g, because
  //                          this rewrite runs before the RANGE guard and so hid the range
  //                          from it. `4-5 pound` is live in the catalog.
  //
  // A hyphen between two numbers means a range in every measure string TheMealDB publishes.
  // Requiring whitespace leaves `3 400g cans` working and lets `4-5 pound` fall through to
  // the RANGE check, which refuses it. `1 - 14 ounce can` is refused too: that is one can, not
  // a range, but refusing a real measure costs one meal its nutrition while multiplying a
  // range ships a number that is wrong by 4x.
  const sized =
    /^(\d+)\s+(\d+(?:\.\d+)?)\s*(g|kg|ml|l|oz|lb|ounce|ounces|pound|pounds|gram|grams)\b/.exec(
      text,
    );
  if (sized?.[1] !== undefined && sized[2] !== undefined && sized[3] !== undefined) {
    text = `${String(Number(sized[1]) * Number(sized[2]))} ${sized[3]}`;
  }

  return text.replace(/\s+/g, ' ').trim();
}

/** Map a spelling variant onto the unit it means, leaving anything unknown untouched. */
function canonicalUnit(unit: string): string {
  return UNIT_SPELLINGS[unit] ?? unit;
}

/**
 * The unit, with trailing preparation words removed.
 *
 * Strips as far as the empty string, because a measure like `1 chopped` or `2 sliced` is ALL
 * preparation: the quantity counts the ingredient itself, so the remaining unit is the bare
 * count. Stopping at one word left `chopped` standing as an unrecognised unit and failed
 * measures that plainly say "one onion".
 */
function withoutTrailingPreparation(unit: string): string {
  const words = unit.split(' ').filter((word) => word !== '');
  while (words.length > 0 && TRAILING_PREPARATION.has(words[words.length - 1] ?? '')) {
    words.pop();
  }
  return words.join(' ');
}

/** Parse a mixed number, fraction or decimal. Returns null when the text is not a quantity. */
function parseQuantity(text: string): number | null {
  const compact = text.replace(/\s*\/\s*/g, '/');

  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(compact);
  if (mixed !== null) {
    const [, whole, numerator, denominator] = mixed;
    if (whole === undefined || numerator === undefined || denominator === undefined) {
      return null;
    }
    const divisor = Number(denominator);
    return divisor === 0 ? null : Number(whole) + Number(numerator) / divisor;
  }

  const fraction = /^(\d+)\/(\d+)$/.exec(compact);
  if (fraction !== null) {
    const [, numerator, denominator] = fraction;
    if (numerator === undefined || denominator === undefined) {
      return null;
    }
    const divisor = Number(denominator);
    return divisor === 0 ? null : Number(numerator) / divisor;
  }

  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(compact)) {
    const value = Number(compact);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * Plurals whose singular a trailing-`s` trim cannot reach.
 *
 * `leaves` folded to `leave`, so a binding declaring `leaf: 0.5` was never consulted and
 * `6 leaves` of basil failed with the gram weight sitting right there in the table.
 */
const IRREGULAR_UNIT_PLURALS: Readonly<Record<string, string>> = {
  leaves: 'leaf',
  loaves: 'loaf',
  halves: 'half',
  knives: 'knife',
};

/** Naive plural trim, so a `gramsPerUnit` table may be keyed in the singular alone. */
function singularUnit(unit: string): string {
  const irregular = IRREGULAR_UNIT_PLURALS[unit];
  if (irregular !== undefined) {
    return irregular;
  }
  if (unit.length > 3 && /(?:ch|sh|ss|x|z)es$/.test(unit)) {
    return unit.slice(0, -2);
  }
  if (unit.length > 2 && unit.endsWith('s') && !unit.endsWith('ss')) {
    return unit.slice(0, -1);
  }
  return unit;
}

/**
 * Convert a TheMealDB measure string to grams for one ingredient.
 *
 * `data` carries that ingredient's density and countable gram weights. Omitting it restricts
 * the parse to mass units, which is the correct behaviour for an ingredient nothing is known
 * about: it converts `400g` and refuses `1 cup`.
 */
export function parseMeasureToGrams(
  measure: string,
  data: IngredientMeasureData = {},
): MeasureResult {
  const text = normalizeMeasure(measure);
  if (text === '') {
    return fail('empty-measure', 'the measure is empty');
  }

  // Checked before the quantity is read: `2-3 tbsp` otherwise parses as `2`, silently
  // dropping the upper bound and understating the ingredient.
  if (RANGE.test(text)) {
    return fail(
      'ambiguous-range',
      `"${measure}" names a range of quantities; choosing one of them would be a guess`,
    );
  }

  const match = QUANTITY_PREFIX.exec(text);

  // No leading number - `Dash`, `Pinch`, `To taste`. One of the unit is meant. That is a
  // reading of English, not an assumption about weight: the gram figure still has to come
  // from the unit table or from the ingredient's own declared weight.
  const quantityText = match?.[1] ?? '1';
  let unit = (match === null ? text : (match[2] ?? '')).trim();

  const quantity = parseQuantity(quantityText);
  if (quantity === null) {
    return fail('unparsable-quantity', `"${measure}" does not begin with a readable quantity`);
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return fail(
      'non-positive-quantity',
      `"${measure}" resolves to a quantity of ${quantity}, which is not a usable amount`,
    );
  }

  // Try the unit as written, then with spelling variants mapped, then with trailing
  // preparation words removed, then as its leading word alone - `750g piece` and `1 litre hot`
  // are a mass and a volume with a noun trailing them.
  const candidates = [
    unit,
    canonicalUnit(unit),
    canonicalUnit(withoutTrailingPreparation(unit)),
    canonicalUnit(unit.split(' ')[0] ?? ''),
  ];
  const known = (candidate: string): boolean =>
    GRAMS_PER_UNIT_OF_MASS[candidate] !== undefined ||
    MILLILITRES_PER_UNIT_OF_VOLUME[candidate] !== undefined ||
    COUNTABLE_UNITS.has(candidate) ||
    COUNTABLE_UNITS.has(singularUnit(candidate)) ||
    VAGUE_UNITS.has(candidate);
  const resolved = candidates.find((candidate) => candidate !== '' && known(candidate));
  if (resolved !== undefined) {
    unit = resolved;
  } else if (withoutTrailingPreparation(unit) === '') {
    // `1 chopped`, `2 sliced`, `Minced`, `Grated`: the unit is ALL preparation, so the
    // quantity counts the ingredient itself and the unit is the bare count. Filtering the
    // empty string out of the candidates left `chopped` standing as an unrecognised unit and
    // failed measures that plainly say "one onion" - it blocked 15 of the 55 unavailable
    // records, which is the single largest cause of unavailability in the catalog.
    unit = '';
  }

  const gramsPerUnitOfMass = GRAMS_PER_UNIT_OF_MASS[unit];
  if (gramsPerUnitOfMass !== undefined) {
    return { ok: true, grams: quantity * gramsPerUnitOfMass, basis: 'mass', unit, quantity };
  }

  const millilitresPerUnit = MILLILITRES_PER_UNIT_OF_VOLUME[unit];
  if (millilitresPerUnit !== undefined) {
    const density = data.gramsPerMillilitre;
    if (density === undefined) {
      return fail(
        'missing-density',
        `"${measure}" is a volume and this ingredient declares no grams per millilitre; ` +
          'a millilitre is not a gram, and assuming water would be a guess',
      );
    }
    return {
      ok: true,
      grams: quantity * millilitresPerUnit * density,
      basis: 'volume',
      unit,
      quantity,
    };
  }

  // A bare quantity with no unit is a count of the ingredient itself: `2` eggs.
  const countUnit = unit === '' ? BARE_COUNT_UNIT : unit;
  const declared = data.gramsPerUnit;
  const gramsPerCountedUnit = declared?.[countUnit] ?? declared?.[singularUnit(countUnit)];
  if (gramsPerCountedUnit !== undefined) {
    return {
      ok: true,
      grams: quantity * gramsPerCountedUnit,
      basis: 'count',
      unit: countUnit,
      quantity,
    };
  }

  if (VAGUE_UNITS.has(countUnit)) {
    return fail(
      'vague-measure',
      `"${measure}" names no measurable quantity, and this ingredient declares no gram ` +
        `weight for "${countUnit}"`,
    );
  }

  if (countUnit === BARE_COUNT_UNIT) {
    return fail(
      'missing-unit-weight',
      `"${measure}" is a bare count, and this ingredient declares no gram weight per item`,
    );
  }

  if (COUNTABLE_UNITS.has(countUnit) || COUNTABLE_UNITS.has(singularUnit(countUnit))) {
    return fail(
      'missing-unit-weight',
      `"${measure}" counts in "${countUnit}", and this ingredient declares no gram weight ` +
        'for one of them',
    );
  }

  return fail(
    'unknown-unit',
    `"${measure}" uses the unit "${countUnit}", which is not a known mass, volume or ` +
      'countable unit',
  );
}
