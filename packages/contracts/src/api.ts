import type { Citation, Meal, MealPeriod, Recommendation } from './core.js';

/**
 * Wire contracts (TSD 3.4). Success responses carry the payload directly - there is no
 * envelope, because there is one client and it does not need a request id to correlate
 * anything (SDD 7.1).
 */

export interface MealListResponse {
  readonly meals: readonly Meal[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface RecommendationResponse {
  readonly mealPeriod: MealPeriod;
  readonly recommendations: readonly Recommendation[];
}

export interface ChatResponse {
  readonly answered: boolean;
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly source: 'gemma' | 'local';
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly catalogVersion: string;
  readonly mealCount: number;
}
