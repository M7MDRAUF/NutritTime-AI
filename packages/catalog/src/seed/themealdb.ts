/**
 * TheMealDB client (TSD 7.2 steps 1 and 2).
 *
 * Build-time only. Nothing here runs at boot or in a request: `npm run seed` calls it by hand,
 * the result is committed as `meals.json`, and the running app never talks to this API. That is
 * why the developer key is acceptable and why there is no caching, retry budget or circuit
 * breaker - the failure mode of this module is "a person re-runs the script".
 *
 * The one genuinely dangerous thing the API does is return `meals` as four different types, so
 * that guard is the centre of this file rather than an afterthought.
 */

/** The JSON API. Never the HTML pages - TSD 7.2 step 1 is explicit about that. */
export const THEMEALDB_BASE = 'https://www.themealdb.com/api/json/v1';

/**
 * The published development key. PRD 4 accepts it because this is a private project whose
 * catalog is built once by hand; a public deployment would need a supporter key.
 */
export const THEMEALDB_DEV_KEY = '1';

/** Attribution is a licence condition, not a courtesy (X-12, PRD 15). */
export const THEMEALDB_ATTRIBUTION = 'Recipe data and imagery: TheMealDB';

export type FetchJson = (url: string) => Promise<unknown>;

export interface MealDbOptions {
  readonly key?: string;
  /** Injected so the unit tests never touch the network. */
  readonly fetchJson?: FetchJson;
}

/**
 * **The guard this module exists for.**
 *
 * `meals` comes back as an array of records, the string `"None Found"`, a legacy object, or
 * `null`, depending on the endpoint and whether there was any data. Only the array carries
 * meals; every other shape means no data. Treating a non-array as an array - or trusting
 * `payload.meals.length` - is the defect TSD 7.2 step 2 names outright.
 */
export function mealsArray(payload: unknown): readonly unknown[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const value = (payload as { meals?: unknown }).meals;
  return Array.isArray(value) ? value : [];
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TheMealDB returned ${String(response.status)} for ${url}`);
  }
  return response.json();
}

function endpoint(options: MealDbOptions, path: string): string {
  return `${THEMEALDB_BASE}/${options.key ?? THEMEALDB_DEV_KEY}/${path}`;
}

/** A `filter.php` summary. Deliberately not mapped into a `Meal`: it has no ingredients. */
export interface MealSummary {
  readonly id: string;
  readonly name: string;
}

function readString(record: unknown, key: string): string | null {
  if (typeof record !== 'object' || record === null) {
    return null;
  }
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Candidate ids for a category.
 *
 * Summaries only - TSD 7.2 step 1 requires a `lookup.php` call per meal for the real record,
 * because the API's own guidance is not to trust a filter response for details.
 */
export async function filterByCategory(
  category: string,
  options: MealDbOptions = {},
): Promise<readonly MealSummary[]> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const payload = await fetchJson(
    `${endpoint(options, 'filter.php')}?c=${encodeURIComponent(category)}`,
  );
  const summaries: MealSummary[] = [];
  for (const entry of mealsArray(payload)) {
    const id = readString(entry, 'idMeal');
    const name = readString(entry, 'strMeal');
    if (id !== null && name !== null) {
      summaries.push({ id, name });
    }
  }
  return summaries;
}

/** The full record for one meal, or `null` when the API has no data for that id. */
export async function lookupMeal(
  id: string,
  options: MealDbOptions = {},
): Promise<Record<string, unknown> | null> {
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const payload = await fetchJson(`${endpoint(options, 'lookup.php')}?i=${encodeURIComponent(id)}`);
  const [first] = mealsArray(payload);
  return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
}
