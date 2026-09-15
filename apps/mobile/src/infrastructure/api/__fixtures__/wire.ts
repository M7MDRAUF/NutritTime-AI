/**
 * Test doubles for the API client: a catalog meal as it arrives on the wire, a `fetch` that
 * answers from a script, and a `fetch` that never answers until its signal aborts.
 *
 * Shared from `__fixtures__/` — the convention `apps/server/src/__fixtures__` already sets — so
 * `routes.test.ts`, `client.test.ts` and `errors.test.ts` agree on what a valid response looks
 * like. Three copies of a `Meal` would drift, and the copy that drifted would be the one making a
 * decoder test pass.
 *
 * **No test here reaches the network** (Plan 19.1). `fetch` is a parameter of `createApiClient`
 * precisely so that stays true.
 */

import type { Meal } from '@nutritime/contracts';
import type { FetchLike } from '../client.js';
import type { ChatRequest, RecommendationRequest } from '../routes.js';

export function wireMeal(overrides: Partial<Meal> = {}): Meal {
  return {
    id: 'greek-yogurt-bowl',
    name: 'Greek yogurt bowl',
    description: 'Thick yogurt, berries, seeds.',
    mealPeriods: ['breakfast'],
    ingredients: [{ name: 'greek yogurt', measure: '200 g' }],
    instructions: ['Spoon the yogurt into a bowl.'],
    allergenTags: ['milk'],
    dietTags: ['vegetarian'],
    nutrition: { calories: 310, proteinGrams: 22, carbsGrams: 30, fatGrams: 11 },
    price: { amountCents: 340, currency: 'USD' },
    preparationMinutes: 5,
    imageUrl: 'https://example.test/bowl.jpg',
    available: true,
    source: 'local',
    catalogVersion: '1.0.0',
    provenance: {
      themealdbId: '52772',
      sourceUrl: 'https://www.themealdb.com/meal/52772',
      imageSource: 'TheMealDB',
      licenceConfirmed: true,
    },
    nutritionProvenance: {
      origin: 'usda-derived',
      dataset: 'FNDDS 2021-2023',
      servings: 1,
      reason: null,
    },
    ...overrides,
  };
}

export interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A `fetch` that answers immediately and records what it was asked for. */
export function stubFetch(respond: (call: Call) => Response): {
  readonly fetch: FetchLike;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(respond({ url, init }));
    },
  };
}

/**
 * A `fetch` that never answers until its signal aborts, then rejects the way a real one does.
 *
 * This is what makes the deadline test prove something: the promise settles only because the
 * signal the client handed over was actually aborted, not because a timer happened to fire.
 */
export const hangingFetch: FetchLike = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal === null || signal === undefined) {
      return;
    }
    signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });

export const RECOMMEND_REQUEST: RecommendationRequest = {
  mealPeriod: 'lunch',
  aiEnabled: true,
  preferences: {
    diet: 'vegetarian',
    allergies: ['peanut'],
    goal: 'high-protein',
    budget: 'medium',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
};

export const CHAT_REQUEST: ChatRequest = {
  question: 'Which lunch has the most protein?',
  // `dinner` while the question says "lunch", deliberately: the two are independent, and a
  // fixture that made them agree could not catch a client that sent the question's word instead
  // of the device's clock.
  mealPeriod: 'dinner',
  preferences: { diet: 'vegetarian', allergies: ['peanut'], dislikedIngredients: [] },
};

export const API_BASE = 'http://localhost:4000';
