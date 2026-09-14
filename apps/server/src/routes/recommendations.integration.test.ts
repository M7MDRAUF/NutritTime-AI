import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import { createApp } from '../app.js';
import { buildCatalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import { fallbackExplanation } from './recommendations.js';

/**
 * Plan C-04, test list in full.
 *
 * The first suite is the one this endpoint exists to get right. Everything else here is a
 * contract detail; an allergen-conflicting meal reaching a response is the failure the whole
 * product is built to prevent, so it is tested through the HTTP boundary and not only in the
 * domain where `recommend` already has its own suite.
 */

const catalog = buildCatalog(seededCatalog);
const app = createApp({ config: loadConfig({}), catalog, sink: () => undefined });

interface Body {
  readonly mealPeriod: string;
  readonly aiEnabled: boolean;
  readonly preferences: {
    readonly diet: string;
    readonly allergies: readonly string[];
    readonly goal: string;
    readonly budget: string;
    readonly dislikedIngredients: readonly string[];
  };
  readonly favoriteMealIds: readonly string[];
}

const body = (overrides: Partial<Body> = {}): Body => ({
  mealPeriod: 'dinner',
  aiEnabled: false,
  preferences: {
    diet: 'regular',
    allergies: [],
    goal: 'balanced',
    budget: 'high',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
  ...overrides,
});

const post = (payload: unknown) =>
  request(app)
    .post('/api/v1/recommendations')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));

describe('the allergen hard rejection, through HTTP', () => {
  it('returns no peanut-tagged meal to a user who declared a peanut allergy', async () => {
    const peanutMeals = catalog.meals.filter((meal) => meal.allergenTags.includes('peanut'));
    expect(peanutMeals.length).toBeGreaterThan(0);

    const response = await post(
      body({
        mealPeriod: 'snack',
        preferences: { ...body().preferences, allergies: ['peanut'] },
        // Favourited deliberately: the +10 must not buy a rejected meal past the filter.
        favoriteMealIds: peanutMeals.map((meal) => meal.id),
      }),
    );
    expect(response.status).toBe(200);
    const returned: string[] = response.body.recommendations.map(
      (entry: { meal: { id: string } }) => entry.meal.id,
    );
    for (const meal of peanutMeals) {
      expect(returned).not.toContain(meal.id);
    }
  });

  it('rejects on an allergen only inferable from the ingredient list', async () => {
    // No declared tag needed: `hasAllergenConflict` works on effective tags, declared union
    // inferred, and checking the declared list alone is how an untagged nut reaches someone.
    const response = await post(
      body({ mealPeriod: 'lunch', preferences: { ...body().preferences, allergies: ['seafood'] } }),
    );
    expect(response.status).toBe(200);
    for (const entry of response.body.recommendations) {
      const ingredients: string = JSON.stringify(entry.meal.ingredients).toLowerCase();
      expect(ingredients).not.toContain('prawn');
      expect(ingredients).not.toContain('salmon');
    }
  });

  it('never returns a diet-incompatible meal', async () => {
    const response = await post(body({ preferences: { ...body().preferences, diet: 'vegan' } }));
    for (const entry of response.body.recommendations) {
      expect(entry.meal.dietTags).toContain('vegan');
    }
  });
});

describe('the response shape', () => {
  it('returns at most three, ordered by score descending then id ascending', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(response.body.mealPeriod).toBe('dinner');
    const entries: { score: number; meal: { id: string } }[] = response.body.recommendations;
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries.length).toBeGreaterThan(0);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      expect(previous.score).toBeGreaterThanOrEqual(current.score);
      if (previous.score === current.score) {
        expect(previous.meal.id < current.meal.id).toBe(true);
      }
    }
  });

  it('carries scoreReasons so a score can be checked rather than trusted', async () => {
    const response = await post(body());
    const first = response.body.recommendations[0];
    expect(first.scoreReasons).toHaveLength(8);
    expect(first.scoreReasons.map((reason: { kind: string }) => reason.kind)).toContain(
      'meal-period-match',
    );
  });

  it('marks every explanation as fallback in this phase', async () => {
    // No model exists until P19, so `gemma` would be a lie about where the prose came from.
    for (const aiEnabled of [true, false]) {
      const response = await post(body({ aiEnabled }));
      for (const entry of response.body.recommendations) {
        expect(entry.explanationSource).toBe('fallback');
        expect(entry.explanation.length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic across identical requests', async () => {
    const first = await post(body({ favoriteMealIds: [] }));
    const second = await post(body({ favoriteMealIds: [] }));
    expect(second.body).toStrictEqual(first.body);
  });

  it('reports a null nutrient as zero points with the not-available detail', async () => {
    const response = await post(
      body({ preferences: { ...body().preferences, goal: 'high-protein' } }),
    );
    const unavailable = response.body.recommendations.find(
      (entry: { meal: { nutritionProvenance: { origin: string } } }) =>
        entry.meal.nutritionProvenance.origin === 'unavailable',
    );
    if (unavailable !== undefined) {
      const goal = unavailable.scoreReasons.find(
        (reason: { kind: string }) => reason.kind === 'goal-match',
      );
      expect(goal.points).toBe(0);
      expect(goal.detail).toMatch(/not available/i);
    }
  });
});

describe('validation', () => {
  it('rejects an extra field with a 400 naming it', async () => {
    const response = await post({ ...body(), sneaky: true });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('requires mealPeriod, because the server holds no clock', async () => {
    const { mealPeriod: _unused, ...withoutPeriod } = body();
    const response = await post(withoutPeriod);
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.details ?? {})).toContain('mealPeriod');
  });

  it.each(['brunch', '', 'LUNCH', 123])('rejects mealPeriod=%o', async (mealPeriod) => {
    const response = await post({ ...body(), mealPeriod });
    expect(response.status).toBe(400);
  });

  it('rejects a preference field the narrow projection does not accept', async () => {
    const response = await post({
      ...body(),
      preferences: { ...body().preferences, themeMode: 'dark' },
    });
    expect(response.status).toBe(400);
  });

  it('never echoes a submitted value in the details', async () => {
    const response = await post({
      ...body(),
      preferences: { ...body().preferences, diet: 'i-am-allergic-to-peanuts' },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('peanuts');
  });
});

describe('this endpoint has no 503', () => {
  it('still answers 200 with Ollama unreachable', async () => {
    // Plan C-04: an explanation that cannot reach the model degrades to `fallback` and the
    // request still succeeds. A recommendation is useful without prose.
    const isolated = createApp({
      config: loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' }),
      catalog,
      sink: () => undefined,
    });
    const response = await request(isolated)
      .post('/api/v1/recommendations')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body({ aiEnabled: true })));
    expect(response.status).toBe(200);
    for (const entry of response.body.recommendations) {
      expect(entry.explanationSource).toBe('fallback');
    }
  });
});

describe('fallbackExplanation', () => {
  const scored = (points: readonly number[]) => ({
    meal: catalog.meals[0]!,
    score: points.reduce((total, value) => total + value, 0),
    scoreReasons: points.map((value, index) => ({
      kind: 'meal-period-match' as const,
      points: value,
      detail: `Reason ${String(index)}`,
    })),
  });

  it('cites the highest-scoring reasons, in points order', () => {
    expect(fallbackExplanation(scored([5, 30, 20]))).toBe('Reason 1, reason 2, and reason 0.');
  });

  it('cites at most three, so it reads as prose rather than a list', () => {
    expect(fallbackExplanation(scored([30, 20, 15, 10, 5]))).toBe(
      'Reason 0, reason 1, and reason 2.',
    );
  });

  it('omits a reason that scored nothing', () => {
    expect(fallbackExplanation(scored([30, 0, 0]))).toBe('Reason 0.');
  });

  it('says only what the data supports when every policy scored zero', () => {
    // Inventing a reason here would make `explanationSource: 'fallback'` a euphemism.
    expect(fallbackExplanation(scored([0, 0]))).toBe('This one fits your preferences.');
  });

  it('is deterministic for equal points, using declaration order as the tie-break', () => {
    const first = fallbackExplanation(scored([10, 10, 10]));
    expect(first).toBe(fallbackExplanation(scored([10, 10, 10])));
    expect(first).toBe('Reason 0, reason 1, and reason 2.');
  });
});
