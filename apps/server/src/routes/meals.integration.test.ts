import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import { queryMeals } from '@nutritime/domain';
import { createApp } from '../app.js';
import { buildCatalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import { MAX_PAGE_SIZE } from './meals.js';

/**
 * Plan C-02 and C-03, test lists in full.
 *
 * The assertion that matters most is the ranking one: the route must produce the order
 * `queryMeals` produces, not an order of its own that happens to look sensible. TSD 4.7 gives
 * relevance one implementation and two callers precisely so the catalog screen and the
 * assistant cannot disagree about what matches a phrase, and a route with its own comparator
 * would pass its own tests while breaking that.
 */

const catalog = buildCatalog(seededCatalog);
const app = createApp({ config: loadConfig({}), catalog, sink: () => undefined });

const get = (path: string) => request(app).get(path).set('Accept', 'application/json');

describe('GET /api/v1/meals - the happy path', () => {
  it('returns the first page with the default size and the full total', async () => {
    const response = await get('/api/v1/meals');
    expect(response.status).toBe(200);
    expect(response.body.page).toBe(1);
    expect(response.body.pageSize).toBe(20);
    expect(response.body.total).toBe(60);
    expect(response.body.meals).toHaveLength(20);
  });

  it('orders by name ascending when no query is given', async () => {
    const response = await get('/api/v1/meals?pageSize=50');
    const names: string[] = response.body.meals.map((meal: { name: string }) => meal.name);
    const sorted = [...names].sort((left, right) =>
      left.toLowerCase() < right.toLowerCase()
        ? -1
        : left.toLowerCase() > right.toLowerCase()
          ? 1
          : 0,
    );
    expect(names).toStrictEqual(sorted);
  });

  it('serialises a null nutrient as null, never as 0', async () => {
    // 53 of the 60 records carry four nulls. A `0` on screen reads as "this meal has no
    // calories", which is the one thing PRD FR-006 forbids.
    const response = await get('/api/v1/meals?pageSize=50');
    const unavailable = response.body.meals.filter(
      (meal: { nutritionProvenance: { origin: string } }) =>
        meal.nutritionProvenance.origin === 'unavailable',
    );
    expect(unavailable.length).toBeGreaterThan(0);
    for (const meal of unavailable) {
      expect(meal.nutrition).toStrictEqual({
        calories: null,
        proteinGrams: null,
        carbsGrams: null,
        fatGrams: null,
      });
    }
  });
});

describe('filtering is conjunctive', () => {
  it('filters by period alone', async () => {
    const response = await get('/api/v1/meals?period=breakfast&pageSize=50');
    expect(response.body.meals.length).toBeGreaterThan(0);
    for (const meal of response.body.meals) {
      expect(meal.mealPeriods).toContain('breakfast');
    }
  });

  it('filters by diet through TSD 4.5 satisfaction, not a literal tag test', async () => {
    // A vegan meal satisfies a vegetarian filter. `dietTags.includes('vegetarian')` would drop
    // it and contradict the module every other part of the system reads.
    const response = await get('/api/v1/meals?diet=vegetarian&pageSize=50');
    const tags: string[][] = response.body.meals.map(
      (meal: { dietTags: string[] }) => meal.dietTags,
    );
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.some((entry) => entry.includes('vegan'))).toBe(true);
    for (const entry of tags) {
      expect(entry.includes('vegetarian') || entry.includes('vegan')).toBe(true);
    }
  });

  it('filters by maxPriceCents inclusively', async () => {
    const response = await get('/api/v1/meals?maxPriceCents=500&pageSize=50');
    for (const meal of response.body.meals) {
      expect(meal.price.amountCents).toBeLessThanOrEqual(500);
    }
    expect(
      response.body.meals.some(
        (meal: { price: { amountCents: number } }) => meal.price.amountCents === 500,
      ),
    ).toBe(true);
  });

  it('combines filters with AND, never OR', async () => {
    const both = await get('/api/v1/meals?period=dinner&diet=vegan&pageSize=50');
    const periodOnly = await get('/api/v1/meals?period=dinner&pageSize=50');
    expect(both.body.total).toBeLessThanOrEqual(periodOnly.body.total);
    for (const meal of both.body.meals) {
      expect(meal.mealPeriods).toContain('dinner');
      expect(meal.dietTags).toContain('vegan');
    }
  });

  it('computes total AFTER filtering and before paging', async () => {
    const filtered = await get('/api/v1/meals?period=breakfast&pageSize=2');
    const all = await get('/api/v1/meals?period=breakfast&pageSize=50');
    expect(filtered.body.total).toBe(all.body.meals.length);
    expect(filtered.body.total).toBeLessThan(60);
    expect(filtered.body.meals).toHaveLength(Math.min(2, filtered.body.total));
  });

  it('returns 200 with an empty array when nothing matches, never 404', async () => {
    const response = await get('/api/v1/meals?maxPriceCents=1&pageSize=50');
    expect(response.status).toBe(200);
    expect(response.body.meals).toStrictEqual([]);
    expect(response.body.total).toBe(0);
  });
});

describe('sorting by relevance', () => {
  it('matches the order queryMeals produces, exactly', async () => {
    const response = await get('/api/v1/meals?query=chicken&pageSize=50');
    const expected = queryMeals(catalog.meals, 'chicken').map((match) => match.meal.id);
    const actual: string[] = response.body.meals.map((meal: { id: string }) => meal.id);
    expect(actual).toStrictEqual(expected);
    expect(expected.length).toBeGreaterThan(1);
  });

  it('omits score-zero meals rather than returning the whole catalog', async () => {
    const response = await get('/api/v1/meals?query=chicken&pageSize=50');
    expect(response.body.total).toBeLessThan(60);
    expect(response.body.total).toBeGreaterThan(0);
  });

  it('applies filters before ranking', async () => {
    const response = await get('/api/v1/meals?query=soup&diet=vegetarian&pageSize=50');
    for (const meal of response.body.meals) {
      expect(meal.dietTags.includes('vegetarian') || meal.dietTags.includes('vegan')).toBe(true);
    }
  });

  it('returns an empty page for a query that matches nothing', async () => {
    const response = await get('/api/v1/meals?query=zzzzzzzz');
    expect(response.status).toBe(200);
    expect(response.body.meals).toStrictEqual([]);
  });
});

describe('pagination', () => {
  it('pages without overlap or gaps', async () => {
    const first = await get('/api/v1/meals?page=1&pageSize=25');
    const second = await get('/api/v1/meals?page=2&pageSize=25');
    const third = await get('/api/v1/meals?page=3&pageSize=25');
    const ids = [
      ...first.body.meals.map((meal: { id: string }) => meal.id),
      ...second.body.meals.map((meal: { id: string }) => meal.id),
      ...third.body.meals.map((meal: { id: string }) => meal.id),
    ];
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  });

  it('returns an empty page past the end, not an error', async () => {
    const response = await get('/api/v1/meals?page=99');
    expect(response.status).toBe(200);
    expect(response.body.meals).toStrictEqual([]);
    expect(response.body.total).toBe(60);
  });

  it.each([1, MAX_PAGE_SIZE])('accepts pageSize %i', async (pageSize) => {
    const response = await get(`/api/v1/meals?pageSize=${String(pageSize)}`);
    expect(response.status).toBe(200);
    expect(response.body.pageSize).toBe(pageSize);
  });
});

describe('query validation', () => {
  it.each([
    ['pageSize=51', 'pageSize'],
    ['pageSize=0', 'pageSize'],
    ['page=0', 'page'],
    ['page=-1', 'page'],
    ['page=1.5', 'page'],
    ['maxPriceCents=-1', 'maxPriceCents'],
    ['period=brunch', 'period'],
    ['diet=keto', 'diet'],
    ['query=', 'query'],
  ])('rejects %s with a 400 naming the parameter', async (queryString, parameter) => {
    const response = await get(`/api/v1/meals?${queryString}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(Object.keys(response.body.error.details ?? {})).toContain(parameter);
  });

  it('ignores an unknown parameter rather than rejecting it', async () => {
    // The allowlist IS the contract (TSD 5.4): a client that sends a stale parameter keeps
    // working, which is the opposite of a strictObject over the query string.
    const response = await get('/api/v1/meals?sortBy=price&nonsense=1&utm_source=x');
    expect(response.status).toBe(200);
    expect(response.body.total).toBe(60);
  });

  it('rejects a repeated parameter rather than silently choosing one', async () => {
    // Express parses `?page=1&page=2` into an array. Picking one would be a guess.
    const response = await get('/api/v1/meals?page=1&page=2');
    expect(response.status).toBe(400);
  });

  it('never echoes a submitted value in the details', async () => {
    const response = await get('/api/v1/meals?query=&diet=i-am-allergic-to-peanuts');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('peanuts');
  });
});

describe('GET /api/v1/meals/:mealId', () => {
  it('returns the full record for a known id', async () => {
    const known = catalog.meals[0];
    expect(known).toBeDefined();
    const response = await get(`/api/v1/meals/${known?.id ?? ''}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(known?.id);
    expect(response.body.ingredients.length).toBeGreaterThan(0);
    expect(response.body.provenance.themealdbId).toMatch(/^\d+$/);
  });

  it('returns 404 meal_not_found for an unknown id, not an empty success', async () => {
    const response = await get('/api/v1/meals/no-such-meal');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('meal_not_found');
    expect(response.body.error.retryable).toBe(false);
  });

  it('round-trips a URL-encoded id', async () => {
    const known = catalog.meals.find((meal) => meal.id.includes('-'));
    expect(known).toBeDefined();
    const encoded = encodeURIComponent(known?.id ?? '');
    const response = await get(`/api/v1/meals/${encoded}`);
    expect(response.status).toBe(200);
    expect(response.body.id).toBe(known?.id);
  });

  it('preserves null nutrition through serialisation', async () => {
    const unavailable = catalog.meals.find(
      (meal) => meal.nutritionProvenance.origin === 'unavailable',
    );
    expect(unavailable).toBeDefined();
    const response = await get(`/api/v1/meals/${unavailable?.id ?? ''}`);
    expect(response.body.nutrition.calories).toBeNull();
    expect(response.body.nutritionProvenance.reason).not.toBeNull();
  });
});

describe('the log line carries the mounted route template', () => {
  it('distinguishes the list route from the detail route', async () => {
    // Flagged at P08: `route.path` is ROUTER-RELATIVE, so without the mount prefix a detail
    // request logged `/:mealId` and the two endpoints were indistinguishable in the log.
    const lines: string[] = [];
    const captured = createApp({
      config: loadConfig({}),
      catalog,
      sink: (line) => lines.push(line),
    });
    await request(captured).get('/api/v1/meals');
    await request(captured).get(`/api/v1/meals/${catalog.meals[0]?.id ?? ''}`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"routeTemplate":"/api/v1/meals/"');
    expect(lines[1]).toContain('"routeTemplate":"/api/v1/meals/:mealId"');
    // ...and still never the concrete id.
    expect(lines[1]).not.toContain(catalog.meals[0]?.id ?? 'IMPOSSIBLE');
  });
});
