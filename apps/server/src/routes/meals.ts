/**
 * The meals routes (TSD 5.4, Plan C-02 and C-03).
 *
 * **This module ranks nothing and filters nothing by its own rules.** Relevance comes from
 * `queryMeals` and diet compatibility from `isDietCompatible`, both in the domain, because the
 * catalog screen and the assistant must never disagree about which meals match a phrase - which
 * is the entire reason TSD 4.7 gives for relevance having one implementation and two callers.
 *
 * A route that re-implemented either would be a second source of truth that passes its own
 * tests.
 */

import { Router } from 'express';
import type { Request, Response, Router as ExpressRouter } from 'express';
import { DIET_TAGS, MEAL_PERIODS } from '@nutritime/contracts';
import type { Meal, MealListResponse } from '@nutritime/contracts';
import { compareIds, isDietCompatible, normalizeText, queryMeals } from '@nutritime/domain';
import { z } from 'zod';
import type { Catalog } from '../catalog.js';
import { ApiError, detailsFromIssues } from '../errors.js';

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * The allowlist IS the contract (TSD 5.4).
 *
 * Every parameter optional; a wrong type or an out-of-range value is a 400 naming the
 * parameter. An UNKNOWN parameter is ignored rather than rejected, which is why the known keys
 * are picked out before parsing instead of handing Zod a `strictObject` over `req.query`.
 */
const QUERY_KEYS = ['page', 'pageSize', 'period', 'diet', 'maxPriceCents', 'query'] as const;

/** Decimal digits only, for the same reason the config loader insists on them. */
const positiveInteger = (min: number, max?: number) => {
  const base = z
    .string()
    .trim()
    .regex(/^\d+$/, 'expected a whole number in decimal digits')
    .transform((value) => Number(value));
  return max === undefined
    ? base.pipe(z.number().int().min(min))
    : base.pipe(z.number().int().min(min).max(max));
};

const querySchema = z.strictObject({
  page: positiveInteger(1).optional(),
  pageSize: positiveInteger(1, MAX_PAGE_SIZE).optional(),
  period: z.enum(MEAL_PERIODS).optional(),
  diet: z.enum(DIET_TAGS).optional(),
  maxPriceCents: positiveInteger(0).optional(),
  query: z.string().trim().min(1).max(100).optional(),
});

export type MealQuery = z.infer<typeof querySchema>;

/**
 * Only the allowlisted keys, and only when a single string arrived.
 *
 * Express parses `?page=1&page=2` into an ARRAY. Coercing that would pick one silently; a 400
 * naming the parameter is the honest answer, and Zod produces it because an array is not a
 * string.
 */
function pickKnown(raw: Request['query']): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of QUERY_KEYS) {
    const value = raw[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
}

export function parseMealQuery(raw: Request['query']): MealQuery {
  const result = querySchema.safeParse(pickKnown(raw));
  if (!result.success) {
    throw new ApiError('invalid_request', detailsFromIssues(result.error.issues));
  }
  return result.data;
}

/**
 * Conjunctive across every supplied filter (Plan C-02).
 *
 * Diet goes through `isDietCompatible` rather than `dietTags.includes`, so a vegan meal is
 * offered to a user filtering for vegetarian - TSD 4.5 calls that asymmetry intentional, and a
 * literal tag test would contradict the module the rest of the system reads.
 */
export function filterMeals(meals: readonly Meal[], query: MealQuery): readonly Meal[] {
  return meals.filter((meal) => {
    if (query.period !== undefined && !meal.mealPeriods.includes(query.period)) {
      return false;
    }
    if (query.diet !== undefined && !isDietCompatible(query.diet, [...meal.dietTags])) {
      return false;
    }
    if (query.maxPriceCents !== undefined && meal.price.amountCents > query.maxPriceCents) {
      return false;
    }
    return true;
  });
}

/**
 * Relevance when `query` is present, name ascending otherwise.
 *
 * Name order is computed over `normalizeText` output and tie-broken by id, not by
 * `localeCompare`: a locale-aware comparison depends on the machine's collation, and an
 * endpoint whose page boundaries move between two machines is one no test can pin.
 */
export function sortMeals(meals: readonly Meal[], query: MealQuery): readonly Meal[] {
  if (query.query !== undefined) {
    // Score-0 meals are dropped by `queryMeals`, which is the documented behaviour: a search
    // that matches nothing returns nothing rather than the whole catalog in arbitrary order.
    return queryMeals(meals, query.query).map((match) => match.meal);
  }
  return [...meals].sort((left, right) => {
    const byName =
      normalizeText(left.name) < normalizeText(right.name)
        ? -1
        : normalizeText(left.name) > normalizeText(right.name)
          ? 1
          : 0;
    return byName !== 0 ? byName : compareIds(left.id, right.id);
  });
}

export interface Page {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly meals: readonly Meal[];
}

/** `total` is the count AFTER filtering and BEFORE paging (Plan C-02). */
export function paginate(meals: readonly Meal[], query: MealQuery): Page {
  const page = query.page ?? DEFAULT_PAGE;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const start = (page - 1) * pageSize;
  return { page, pageSize, total: meals.length, meals: meals.slice(start, start + pageSize) };
}

export function mealsRouter(catalog: Catalog): ExpressRouter {
  const router = Router();

  router.get('/', (request: Request, response: Response) => {
    const query = parseMealQuery(request.query);
    const page = paginate(sortMeals(filterMeals(catalog.meals, query), query), query);
    const body: MealListResponse = {
      meals: page.meals,
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
    };
    // An empty result is a successful answer to a narrow question: 200 with `meals: []`,
    // never a 404 (Plan C-02).
    response.json(body);
  });

  router.get('/:mealId', (request: Request, response: Response) => {
    // Express types a path parameter as `string | string[] | undefined`. Only a single string
    // can name a meal, so anything else is simply not found rather than a type to coerce.
    const mealId = request.params['mealId'];
    const meal = typeof mealId === 'string' ? catalog.byId.get(mealId) : undefined;
    if (meal === undefined) {
      // Not an empty success. An unknown id is a different fact from a meal with no fields.
      throw new ApiError('meal_not_found');
    }
    response.json(meal);
  });

  return router;
}
