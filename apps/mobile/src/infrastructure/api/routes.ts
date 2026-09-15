/**
 * The route table (TSD 6.5 and 5.4): one entry per endpoint, carrying its path, its method, its
 * deadline and the decoder for its response.
 *
 * Keeping the four together is what stops them drifting. A deadline in the client and a path in
 * a screen is how a route ends up with the wrong budget, and a decoder written at the call site
 * is how two screens end up disagreeing about what a `Meal` is.
 *
 * **Every `Meal` is decoded by `mealSchema` from `@nutritime/contracts`** — the same schema the
 * server validates its catalog with at boot. That is the whole point of a single contracts
 * package (Plan 12.3): the two cannot disagree, because there is only one definition.
 *
 * The response *envelopes* — `{ meals, page, pageSize, total }` and the two below — have no
 * schema in `packages/contracts`, and `apps/mobile` cannot declare `zod` without breaking
 * TSD 2.3 rule 2. They are read here by explicit narrowing: unknown fields are IGNORED rather
 * than rejected, because A-08 records API versioning as additive within v1 and a client that
 * refused a field the server added would break on a change the server was entitled to make.
 * (`mealSchema` is strict about a `Meal`; that is the contracts owner's decision, not this file's.)
 */

import { MEAL_PERIODS, SCORE_REASON_KINDS, mealSchema } from '@nutritime/contracts';
import type {
  BudgetBand,
  ChatResponse,
  Citation,
  DietTag,
  Meal,
  MealListResponse,
  MealPeriod,
  NutritionGoal,
  Recommendation,
  RecommendationResponse,
  ScoreReason,
} from '@nutritime/contracts';

/**
 * The server's default `PORT` is 4000 (`.env.example`), and A-06 records the deployment target
 * as the developer's own machine, so `localhost` is the server for the web export and the
 * simulator alike. **No document names a base URL for the mobile client**; this is the default a
 * caller may override, and `createApiClient` takes it as configuration rather than reading an
 * environment variable, so nothing about the bundle's contents is decided in this file.
 */
export const DEFAULT_API_BASE_URL = 'http://localhost:4000';

export const API_BASE_PATH = '/api/v1';

/**
 * TSD 6.5's deadline table, verbatim. **Each is above the server's own budget at the documented
 * defaults** (`OLLAMA_EXPLANATION_TIMEOUT_MS=12000` < 15 s, `OLLAMA_CHAT_TIMEOUT_MS=30000` < 30 s)
 * so the client
 * never gives up before the server would: the server's explanation timeout is 12 s
 * (`OLLAMA_EXPLANATION_TIMEOUT_MS`) under a 15 s recommendation deadline, and its chat timeout
 * is 30 s (`OLLAMA_CHAT_TIMEOUT_MS`) under a 35 s one. A client that timed out first would
 * report a failure for a request that was about to succeed.
 */
export const ROUTE_TIMEOUTS_MS = {
  listMeals: 10_000,
  getMeal: 10_000,
  recommend: 15_000,
  ask: 35_000,
} as const;

export type RouteName = keyof typeof ROUTE_TIMEOUTS_MS;

/** The allowlisted query parameters of TSD 5.4. All optional; an unknown one is not sendable. */
export interface MealQuery {
  readonly page?: number;
  readonly pageSize?: number;
  readonly period?: MealPeriod;
  readonly diet?: DietTag;
  readonly maxPriceCents?: number;
  readonly query?: string;
}

/**
 * Build the query string by hand rather than with `URLSearchParams`.
 *
 * React Native's URL polyfill is partial and has historically differed from the web's on empty
 * values and encoding; a query string is not worth depending on that. `encodeURIComponent` is in
 * Hermes, in every browser and in Node, and it is the only escaping this needs.
 *
 * `query` carries the user's own search text. It goes in the URL because TSD 5.4 puts it there —
 * and it is never logged, here or anywhere in this client (PRD 10.3).
 */
export function encodeMealQuery(query: MealQuery): string {
  const parts: string[] = [];
  const add = (key: string, value: string | number | undefined): void => {
    if (value !== undefined) {
      parts.push(`${key}=${encodeURIComponent(String(value))}`);
    }
  };
  add('page', query.page);
  add('pageSize', query.pageSize);
  add('period', query.period);
  add('diet', query.diet);
  add('maxPriceCents', query.maxPriceCents);
  add('query', query.query);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export function mealsPath(query: MealQuery): string {
  return `${API_BASE_PATH}/meals${encodeMealQuery(query)}`;
}

/** A meal id is a path SEGMENT, so it is escaped. An id with a slash must not become a path. */
export function mealPath(mealId: string): string {
  return `${API_BASE_PATH}/meals/${encodeURIComponent(mealId)}`;
}

export const RECOMMENDATIONS_PATH = `${API_BASE_PATH}/recommendations`;
export const CHAT_PATH = `${API_BASE_PATH}/chat`;
export const HEALTH_PATH = '/health';

// ------------------------------------------------------------------------- request bodies

/**
 * TSD 6.5 names `RecommendationRequest` and `ChatRequest` in `ApiClient`'s signature, and
 * `packages/contracts` exports **neither type** — only the schemas that describe them. They are
 * declared here, structurally identical to `recommendationRequestSchema` and `chatRequestSchema`,
 * and they belong in `contracts/src/api.ts` beside the response types they pair with.
 *
 * The fields are `readonly` where the schemas' inferred types are not, because every caller holds
 * a `UserPreferences` whose arrays are already `readonly` (TSD 3.2) — a mutable parameter type
 * would make every call site copy an array or reach for a cast.
 *
 * `routes.test.ts` parses a value of each type with the contracts schema. That is a stronger
 * guard than a type alias: it fails if the schema and this declaration ever disagree about what
 * the server will accept, which a `z.infer` alias could not, since it would simply follow along.
 */
export interface RecommendationRequestPreferences {
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly goal: NutritionGoal;
  readonly budget: BudgetBand;
  readonly dislikedIngredients: readonly string[];
}

export interface RecommendationRequest {
  /** The CLIENT sends the period; the server holds no clock (TSD 5.4). */
  readonly mealPeriod: MealPeriod;
  readonly aiEnabled: boolean;
  readonly preferences: RecommendationRequestPreferences;
  readonly favoriteMealIds: readonly string[];
}

/**
 * `preferences` is deliberately narrower than the recommendation body: retrieval does not read
 * `goal` or `budget`, and TSD 5.4 makes sending either a 400. Nothing leaves the device except
 * the question and the three fields below (PRD 10.3).
 */
export interface ChatRequestPreferences {
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly dislikedIngredients: readonly string[];
}

export interface ChatRequest {
  readonly question: string;
  /**
   * What "now" is, computed on this device (TSD 5.4: the server holds no clock).
   *
   * Added at P28 with `chatRequestSchema`'s own new field. **The divergence was caught by a test,
   * not by the compiler** - `routes.test.ts` parses a value of this type with the real schema,
   * and it failed the moment the schema gained a field this interface lacked. That is the guard
   * this declaration's docstring promises, doing exactly its job; the duplication itself is
   * R-78's shape and stays recorded rather than fixed here.
   */
  readonly mealPeriod: MealPeriod;
  readonly preferences: ChatRequestPreferences;
}

// ------------------------------------------------------------------------- decoders

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readEach<T>(value: unknown, decode: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const items: readonly unknown[] = value;
  const decoded: T[] = [];
  for (const item of items) {
    const one = decode(item);
    if (one === null) {
      return null;
    }
    decoded.push(one);
  }
  return decoded;
}

export function decodeMeal(value: unknown): Meal | null {
  const parsed = mealSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function decodeMealListResponse(value: unknown): MealListResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const meals = readEach(value['meals'], decodeMeal);
  const page = readNumber(value['page']);
  const pageSize = readNumber(value['pageSize']);
  const total = readNumber(value['total']);
  if (meals === null || page === null || pageSize === null || total === null) {
    return null;
  }
  return { meals, page, pageSize, total };
}

function decodeScoreReason(value: unknown): ScoreReason | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = value['kind'];
  const points = readNumber(value['points']);
  const detail = readString(value['detail']);
  if (typeof kind !== 'string' || points === null || detail === null) {
    return null;
  }
  const known = SCORE_REASON_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? null : { kind: known, points, detail };
}

function decodeRecommendation(value: unknown): Recommendation | null {
  if (!isRecord(value)) {
    return null;
  }
  const meal = decodeMeal(value['meal']);
  const score = readNumber(value['score']);
  const scoreReasons = readEach(value['scoreReasons'], decodeScoreReason);
  const explanation = readString(value['explanation']);
  const source = value['explanationSource'];
  if (meal === null || score === null || scoreReasons === null || explanation === null) {
    return null;
  }
  if (source !== 'gemma' && source !== 'fallback') {
    return null;
  }
  return { meal, score, scoreReasons, explanation, explanationSource: source };
}

export function decodeRecommendationResponse(value: unknown): RecommendationResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const mealPeriod = MEAL_PERIODS.find((candidate): boolean => candidate === value['mealPeriod']);
  const recommendations = readEach(value['recommendations'], decodeRecommendation);
  if (mealPeriod === undefined || recommendations === null) {
    return null;
  }
  return { mealPeriod, recommendations };
}

function decodeCitation(value: unknown): Citation | null {
  if (!isRecord(value)) {
    return null;
  }
  const mealId = readString(value['mealId']);
  const name = readString(value['name']);
  return mealId === null || name === null ? null : { mealId, name };
}

/**
 * `answered: false` is a successful decode (TSD 5.4: it is the endpoint answering correctly, not
 * failing), so nothing here treats it as an error. The screen presents it.
 */
export function decodeChatResponse(value: unknown): ChatResponse | null {
  if (!isRecord(value)) {
    return null;
  }
  const answered = value['answered'];
  const answer = readString(value['answer']);
  const citations = readEach(value['citations'], decodeCitation);
  const source = value['source'];
  if (typeof answered !== 'boolean' || answer === null || citations === null) {
    return null;
  }
  if (source !== 'gemma' && source !== 'local') {
    return null;
  }
  return { answered, answer, citations, source };
}
