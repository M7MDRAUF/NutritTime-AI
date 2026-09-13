/**
 * Mapping a TheMealDB record into the catalog shape (TSD 7.2 step 3).
 *
 * Everything here is a transcription. Nothing is invented, nothing is guessed, and where the
 * upstream field is absent the result is `null` rather than a plausible-looking default -
 * `provenance` exists to say what is known about where a record came from, so filling a gap
 * would defeat its only purpose.
 *
 * `strCreativeCommonsConfirmed` is `"Yes"` for none of the 60 records in the current catalog
 * and `strImageSource` is absent for all of them. That is not a bug in this mapper; it is what
 * the API returns, and recording it faithfully is the point (X-12).
 */

import type { Ingredient, Provenance } from '@nutritime/contracts';
import { kebabCase } from '@nutritime/domain';

/** TheMealDB publishes exactly twenty ingredient/measure slots, most of them empty. */
const INGREDIENT_SLOTS = 20;

/** The intermediate: everything derivable from upstream, before anything is authored. */
export interface MappedMeal {
  readonly id: string;
  readonly name: string;
  readonly ingredients: readonly Ingredient[];
  readonly instructions: readonly string[];
  readonly imageUrl: string | null;
  readonly provenance: Provenance;
  /** Carried for the authoring step only. Neither is part of `Meal`. */
  readonly category: string | null;
  readonly area: string | null;
}

function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** An http(s) URL, or `null`. `provenanceSchema` rejects anything else, so filter here. */
function readUrl(raw: Record<string, unknown>, key: string): string | null {
  const value = readString(raw, key);
  if (value === null) {
    return null;
  }
  return value.startsWith('https://') || value.startsWith('http://') ? value : null;
}

/**
 * The ingredient list, in upstream order.
 *
 * A slot counts only when it names an ingredient. An empty measure is kept as an empty string
 * rather than dropped: "to taste" items genuinely have no measure, and the measure parser is
 * the right place to decide that, not this one.
 */
export function readIngredients(raw: Record<string, unknown>): readonly Ingredient[] {
  const ingredients: Ingredient[] = [];
  for (let slot = 1; slot <= INGREDIENT_SLOTS; slot += 1) {
    const name = readString(raw, `strIngredient${String(slot)}`);
    if (name === null) {
      continue;
    }
    ingredients.push({ name, measure: readString(raw, `strMeasure${String(slot)}`) ?? '' });
  }
  return ingredients;
}

/**
 * Instructions split into steps on line breaks only.
 *
 * Never on sentence punctuation: "Bake for 1.5 hours" and "Heat to 180 C. Add the onions"
 * cannot be told apart by a full stop, and a wrongly split step reads as two half-instructions.
 * Four of the sixty records are a single unbroken paragraph; one long step is correct for those
 * and the schema asks only for at least one.
 */
export function readInstructions(raw: Record<string, unknown>): readonly string[] {
  const blob = readString(raw, 'strInstructions');
  if (blob === null) {
    return [];
  }
  return (
    blob
      .split(String.fromCharCode(10))
      .map((line) => line.replace(/\s+$/, '').trim())
      // Some records number their own steps; an empty "STEP 4" marker line carries nothing.
      .filter((line) => line !== '' && !/^step\s*\d+$/i.test(line))
  );
}

/**
 * One raw record, or `null` when it is too incomplete to be a meal.
 *
 * Returning `null` rather than throwing lets the seed script report every unusable record in
 * one run instead of stopping at the first.
 */
export function mapRawMeal(raw: Record<string, unknown>): MappedMeal | null {
  const name = readString(raw, 'strMeal');
  const themealdbId = readString(raw, 'idMeal');
  if (name === null || themealdbId === null || !/^\d+$/.test(themealdbId)) {
    return null;
  }

  const ingredients = readIngredients(raw);
  const instructions = readInstructions(raw);
  if (ingredients.length === 0 || instructions.length === 0) {
    return null;
  }

  return {
    id: kebabCase(name),
    name,
    ingredients,
    instructions,
    imageUrl: readUrl(raw, 'strMealThumb'),
    provenance: {
      themealdbId,
      sourceUrl: readUrl(raw, 'strSource'),
      imageSource: readString(raw, 'strImageSource'),
      // Only the literal "Yes" counts. Anything else - absent, empty, "No" - is not a
      // confirmation, and a licence flag that guesses is worse than one that says no.
      licenceConfirmed: readString(raw, 'strCreativeCommonsConfirmed') === 'Yes',
    },
    category: readString(raw, 'strCategory'),
    area: readString(raw, 'strArea'),
  };
}
