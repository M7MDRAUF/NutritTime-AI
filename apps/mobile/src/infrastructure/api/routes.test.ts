import { describe, expect, it } from 'vitest';
import { chatRequestSchema, recommendationRequestSchema } from '@nutritime/contracts';
import {
  API_BASE_PATH,
  CHAT_PATH,
  DEFAULT_API_BASE_URL,
  HEALTH_PATH,
  RECOMMENDATIONS_PATH,
  ROUTE_TIMEOUTS_MS,
  decodeChatResponse,
  decodeMeal,
  decodeMealListResponse,
  decodeRecommendationResponse,
  encodeMealQuery,
  mealPath,
  mealsPath,
} from './routes.js';
import type { ChatRequest, RecommendationRequest } from './routes.js';
import { wireMeal as meal } from './__fixtures__/wire.js';

describe('the deadline table', () => {
  // TSD 6.5's table, and the reason each number is what it is.
  it('matches TSD 6.5 exactly', () => {
    expect(ROUTE_TIMEOUTS_MS).toEqual({
      listMeals: 10_000,
      getMeal: 10_000,
      recommend: 15_000,
      ask: 35_000,
    });
  });

  it('sits above the server’s own budget on both AI routes', () => {
    // `OLLAMA_EXPLANATION_TIMEOUT_MS=12000` and `OLLAMA_CHAT_TIMEOUT_MS=30000` (.env.example).
    // A client that gave up first would report a failure for a request about to succeed.
    expect(ROUTE_TIMEOUTS_MS.recommend).toBeGreaterThan(12_000);
    expect(ROUTE_TIMEOUTS_MS.ask).toBeGreaterThan(30_000);
  });
});

describe('paths', () => {
  it('uses the v1 prefix the server mounts, and an unversioned /health', () => {
    expect(API_BASE_PATH).toBe('/api/v1');
    expect(RECOMMENDATIONS_PATH).toBe('/api/v1/recommendations');
    expect(CHAT_PATH).toBe('/api/v1/chat');
    expect(HEALTH_PATH).toBe('/health');
    expect(DEFAULT_API_BASE_URL).toBe('http://localhost:4000');
  });

  it('escapes a meal id so it cannot become a path of its own', () => {
    expect(mealPath('greek-yogurt-bowl')).toBe('/api/v1/meals/greek-yogurt-bowl');
    expect(mealPath('../health')).toBe('/api/v1/meals/..%2Fhealth');
  });

  it('emits no query string when there is nothing to send', () => {
    expect(encodeMealQuery({})).toBe('');
    expect(mealsPath({})).toBe('/api/v1/meals');
  });

  it('sends only the allowlisted parameters, in a stable order', () => {
    expect(
      encodeMealQuery({
        page: 2,
        pageSize: 20,
        period: 'lunch',
        diet: 'vegan',
        maxPriceCents: 900,
        query: 'lentil',
      }),
    ).toBe('?page=2&pageSize=20&period=lunch&diet=vegan&maxPriceCents=900&query=lentil');
  });

  it('escapes a search phrase rather than letting it shape the URL', () => {
    expect(encodeMealQuery({ query: 'chicken & rice?x=1' })).toBe(
      '?query=chicken%20%26%20rice%3Fx%3D1',
    );
  });

  it('omits an absent parameter instead of sending it empty', () => {
    expect(encodeMealQuery({ page: 1, query: undefined })).toBe('?page=1');
  });
});

describe('request bodies', () => {
  // Stronger than a type alias: it fails if this module and the contracts schema ever disagree
  // about what the server will accept.
  it('a RecommendationRequest is accepted by recommendationRequestSchema', () => {
    const request: RecommendationRequest = {
      mealPeriod: 'lunch',
      aiEnabled: true,
      preferences: {
        diet: 'vegetarian',
        allergies: ['peanut'],
        goal: 'high-protein',
        budget: 'medium',
        dislikedIngredients: ['mushroom'],
      },
      favoriteMealIds: ['greek-yogurt-bowl'],
    };
    expect(recommendationRequestSchema.safeParse(request).success).toBe(true);
  });

  it('a ChatRequest is accepted by chatRequestSchema, and carries no goal or budget', () => {
    const request: ChatRequest = {
      question: 'What is the highest protein lunch?',
      preferences: { diet: 'vegan', allergies: [], dislikedIngredients: [] },
    };
    expect(chatRequestSchema.safeParse(request).success).toBe(true);
    // TSD 5.4 makes an extra field a 400, and that is what keeps a field nobody reads from
    // eventually being believed.
    expect(
      chatRequestSchema.safeParse({
        ...request,
        preferences: { ...request.preferences, goal: 'balanced' },
      }).success,
    ).toBe(false);
  });
});

describe('decodeMeal', () => {
  it('accepts a meal from the wire', () => {
    expect(decodeMeal(meal())).toEqual(meal());
  });

  it('refuses a meal the shared schema refuses, rather than coercing it', () => {
    // The range bound is the only defence against a derivation slip that would otherwise win
    // every superlative question (TSD 3.3).
    expect(
      decodeMeal(
        meal({ nutrition: { calories: 99_999, proteinGrams: 1, carbsGrams: 1, fatGrams: 1 } }),
      ),
    ).toBeNull();
    expect(decodeMeal(meal({ mealPeriods: [] }))).toBeNull();
    expect(decodeMeal({ id: 'x' })).toBeNull();
    expect(decodeMeal(null)).toBeNull();
  });
});

describe('decodeMealListResponse', () => {
  it('accepts a page of meals', () => {
    const body = { meals: [meal()], page: 1, pageSize: 20, total: 60 };
    expect(decodeMealListResponse(body)).toEqual(body);
  });

  it('accepts an empty page', () => {
    const body = { meals: [], page: 3, pageSize: 20, total: 0 };
    expect(decodeMealListResponse(body)).toEqual(body);
  });

  it('IGNORES a field the server added, because v1 is additive (A-08)', () => {
    const decoded = decodeMealListResponse({
      meals: [],
      page: 1,
      pageSize: 20,
      total: 0,
      nextCursor: 'abc',
    });
    expect(decoded).toEqual({ meals: [], page: 1, pageSize: 20, total: 0 });
  });

  it.each([
    ['no meals array', { page: 1, pageSize: 20, total: 0 }],
    ['a meals array holding a non-meal', { meals: [{ id: 'x' }], page: 1, pageSize: 20, total: 0 }],
    ['a string page', { meals: [], page: '1', pageSize: 20, total: 0 }],
    ['a NaN total', { meals: [], page: 1, pageSize: 20, total: Number.NaN }],
    ['not an object at all', 'meals'],
  ])('refuses %s', (_name, body) => {
    expect(decodeMealListResponse(body)).toBeNull();
  });
});

describe('decodeRecommendationResponse', () => {
  const recommendation = {
    meal: meal(),
    score: 74,
    scoreReasons: [{ kind: 'diet-match', points: 20, detail: 'Fits a vegetarian diet.' }],
    explanation: 'High in protein and quick to make.',
    explanationSource: 'fallback',
  };

  it('accepts a response and keeps the score reasons', () => {
    const body = { mealPeriod: 'lunch', recommendations: [recommendation] };
    expect(decodeRecommendationResponse(body)).toEqual(body);
  });

  it('accepts an empty recommendation list', () => {
    expect(decodeRecommendationResponse({ mealPeriod: 'snack', recommendations: [] })).toEqual({
      mealPeriod: 'snack',
      recommendations: [],
    });
  });

  it.each([
    ['an unknown meal period', { mealPeriod: 'brunch', recommendations: [] }],
    [
      'an invented score-reason kind',
      {
        mealPeriod: 'lunch',
        recommendations: [
          { ...recommendation, scoreReasons: [{ kind: 'vibes', points: 1, detail: 'x' }] },
        ],
      },
    ],
    [
      'an explanation source outside the two the contract names',
      { mealPeriod: 'lunch', recommendations: [{ ...recommendation, explanationSource: 'gpt' }] },
    ],
    [
      'a missing explanation',
      { mealPeriod: 'lunch', recommendations: [{ ...recommendation, explanation: undefined }] },
    ],
  ])('refuses %s', (_name, body) => {
    expect(decodeRecommendationResponse(body)).toBeNull();
  });
});

describe('decodeChatResponse', () => {
  it('accepts an answered reply with citations', () => {
    const body = {
      answered: true,
      answer: 'The lentil soup has the most protein.',
      citations: [{ mealId: 'my-lentil-soup', name: 'My lentil soup' }],
      source: 'gemma',
    };
    expect(decodeChatResponse(body)).toEqual(body);
  });

  it('accepts `answered: false` as a SUCCESS, because that is the endpoint answering', () => {
    // TSD 5.4: `answered: false` is HTTP 200 and is not a failure. Treating it as one here
    // would turn a correct answer into an error state.
    const body = { answered: false, answer: 'I do not have that.', citations: [], source: 'local' };
    expect(decodeChatResponse(body)).toEqual(body);
  });

  it.each([
    ['an unknown source', { answered: true, answer: 'a', citations: [], source: 'openai' }],
    ['a non-boolean answered', { answered: 'yes', answer: 'a', citations: [], source: 'local' }],
    [
      'a citation missing its name',
      {
        answered: true,
        answer: 'a',
        citations: [{ mealId: 'x' }],
        source: 'local',
      },
    ],
  ])('refuses %s', (_name, body) => {
    expect(decodeChatResponse(body)).toBeNull();
  });
});
