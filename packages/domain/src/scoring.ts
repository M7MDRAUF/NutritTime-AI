/**
 * Recommendation scoring (TSD 4.6, PRD FR-007, FR-008).
 *
 * Two rules govern everything here. **Hard rejections happen before scoring** - no number of
 * points can make an allergen-conflicting meal appear - and **the result is deterministic**:
 * identical input and catalog version produce identical scores in an identical order, which
 * is what makes the whole feature testable.
 */

import type {
  BudgetBand,
  DietTag,
  Meal,
  MealPeriod,
  NutritionGoal,
  ScoreReason,
  ScoreReasonKind,
} from '@nutritime/contracts';
import { hasAllergenConflict } from './allergens.js';
import { isDietCompatible } from './diet.js';
import {
  compareIds,
  containsTokenSequence,
  singularize,
  tokenize,
  tokenizeSegments,
} from './text.js';

export const RECOMMENDATION_WEIGHTS = {
  mealPeriodMatch: 30,
  dietCompatible: 20,
  goalMatchMax: 15,
  budgetMatchMax: 15,
  previousLike: 10,
  preparationTimeFitMax: 5,
  localAvailability: 5,
  dislikedIngredientPenalty: -50,
} as const;

export const SCORE_BOUNDS = { min: 0, max: 100 } as const;

export const GOAL_BANDS = {
  /** Grams of protein, best band first. */
  highProtein: [
    { minGrams: 25, points: 15 },
    { minGrams: 15, points: 10 },
    { minGrams: 8, points: 5 },
  ],
  /** Kcal ceiling, best band first. */
  lowerCalorie: [
    { maxKcal: 400, points: 15 },
    { maxKcal: 600, points: 10 },
    { maxKcal: 800, points: 5 },
  ],
  /** Balanced rewards a meal sitting in a moderate calorie range. */
  balanced: { minKcal: 350, maxKcal: 700, insidePoints: 15, outsidePoints: 7 },
} as const;

export const BUDGET_BAND_MAX_CENTS = {
  low: 900,
  medium: 1600,
  high: Number.MAX_SAFE_INTEGER,
} as const;

/** A meal just above the ceiling still scores something. Expressed as a fraction, not a float. */
export const BUDGET_TOLERANCE = { numerator: 5, denominator: 4, points: 7 } as const;

/** Preparation time in minutes, fastest band first. */
export const PREPARATION_TIME_BANDS = [
  { maxMinutes: 15, points: 5 },
  { maxMinutes: 30, points: 3 },
  { maxMinutes: 45, points: 1 },
] as const;

export const MAX_RECOMMENDATIONS = 3;

export interface RecommendationPreferences {
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly goal: NutritionGoal;
  readonly budget: BudgetBand;
  readonly dislikedIngredients: readonly string[];
}

export interface RecommendationContext {
  readonly period: MealPeriod;
  readonly preferences: RecommendationPreferences;
  readonly favoriteMealIds: readonly string[];
}

export interface ScoredMeal {
  readonly meal: Meal;
  readonly score: number;
  readonly scoreReasons: readonly ScoreReason[];
}

export type RejectionReason = 'allergen-conflict' | 'diet-incompatible' | 'unavailable';

export interface RejectedMeal {
  readonly meal: Meal;
  readonly reason: RejectionReason;
  readonly detail: string;
}

export interface RecommendationResult {
  readonly candidates: readonly ScoredMeal[];
  readonly selected: readonly ScoredMeal[];
  readonly rejected: readonly RejectedMeal[];
}

interface PolicyResult {
  readonly points: number;
  readonly detail: string;
}

const MAX_LISTED_AVOIDED = 3;

/**
 * Which disliked ingredients this meal contains.
 *
 * Whole-token matching through the shared text primitives, so `nut` never matches `minute`
 * and a user who dislikes `onion` is not surprised by `spring onions`, which they are.
 */
function matchedDislikedIngredients(meal: Meal, disliked: readonly string[]): string[] {
  // Segmented, not merely tokenised: `tokenizeSegments` is what stops the disliked term
  // `milk chocolate` matching the ingredient `"milk, chocolate"` across the comma. TSD 4.1
  // names that exact pair, and the allergen module segments for the same reason.
  const haystacks = meal.ingredients.flatMap((item) =>
    tokenizeSegments(item.name).map((segment) => segment.map(singularize)),
  );
  const seen = new Set<string>();
  const found: string[] = [];
  for (const term of disliked) {
    const needle = tokenize(term).map(singularize);
    if (needle.length === 0) {
      continue;
    }
    // `dislikedIngredients` is free user text, so `mushroom` and `mushrooms` both arrive and
    // fold to one needle. Counting them separately charges -100 for a single dislike, which
    // moves a meal down the ranking and can drive the total to the 0 clamp.
    const key = needle.join(' ');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (haystacks.some((tokens) => containsTokenSequence(tokens, needle))) {
      found.push(term);
    }
  }
  return found;
}

function describeAvoided(matched: readonly string[]): string {
  const listed = matched.slice(0, MAX_LISTED_AVOIDED).join(', ');
  const rest = matched.length - MAX_LISTED_AVOIDED;
  return rest > 0
    ? `Contains ${listed} and ${String(rest)} more you avoid`
    : `Contains ${listed}, which you avoid`;
}

/**
 * `mealSchema` guarantees each nutrient is a non-negative integer in range or `null`, so
 * `null` is the only unknown. An earlier version also coerced a non-finite value to `null`,
 * which made the reason read "not available" for a number that was present but wrong - a
 * false statement, and PRD FR-006 is emphatic that "not available" means unknown.
 */
function scoreGoal(goal: NutritionGoal, meal: Meal): PolicyResult {
  const calories = meal.nutrition.calories;
  const protein = meal.nutrition.proteinGrams;

  switch (goal) {
    case 'high-protein': {
      if (protein === null) {
        // Unknown never becomes zero-by-default in a way that reads as a real measurement.
        return { points: 0, detail: 'Protein content not available' };
      }
      const band = GOAL_BANDS.highProtein.find((entry) => protein >= entry.minGrams);
      return { points: band?.points ?? 0, detail: `${String(protein)} g protein per serving` };
    }
    case 'lower-calorie': {
      if (calories === null) {
        return { points: 0, detail: 'Calorie content not available' };
      }
      const band = GOAL_BANDS.lowerCalorie.find((entry) => calories <= entry.maxKcal);
      return { points: band?.points ?? 0, detail: `${String(calories)} kcal per serving` };
    }
    case 'balanced': {
      if (calories === null) {
        return { points: 0, detail: 'Calorie content not available' };
      }
      const inside =
        calories >= GOAL_BANDS.balanced.minKcal && calories <= GOAL_BANDS.balanced.maxKcal;
      return {
        points: inside ? GOAL_BANDS.balanced.insidePoints : GOAL_BANDS.balanced.outsidePoints,
        detail: `${String(calories)} kcal per serving`,
      };
    }
  }
}

function scoreBudget(band: BudgetBand, meal: Meal): PolicyResult {
  const ceiling = BUDGET_BAND_MAX_CENTS[band];
  const price = meal.price.amountCents;
  if (price <= ceiling) {
    return { points: RECOMMENDATION_WEIGHTS.budgetMatchMax, detail: `Inside the ${band} budget` };
  }
  // Integer arithmetic on purpose: `price <= ceiling * 1.25` makes the boundary a coin flip.
  const withinTolerance =
    price * BUDGET_TOLERANCE.denominator <= ceiling * BUDGET_TOLERANCE.numerator;
  return withinTolerance
    ? { points: BUDGET_TOLERANCE.points, detail: `Just above the ${band} budget` }
    : { points: 0, detail: `Above the ${band} budget` };
}

type Policy = (context: RecommendationContext, meal: Meal) => PolicyResult;

/** The eight policies, in the evaluation order SCORE_REASON_KINDS declares. */
const POLICIES: readonly (readonly [ScoreReasonKind, Policy])[] = [
  [
    'meal-period-match',
    (context, meal) => {
      const matches = meal.mealPeriods.includes(context.period);
      return {
        points: matches ? RECOMMENDATION_WEIGHTS.mealPeriodMatch : 0,
        detail: matches ? `Suits ${context.period}` : `Not usually a ${context.period}`,
      };
    },
  ],
  [
    'diet-match',
    (context, meal) => {
      const compatible = isDietCompatible(context.preferences.diet, [...meal.dietTags]);
      return {
        points: compatible ? RECOMMENDATION_WEIGHTS.dietCompatible : 0,
        detail: compatible ? `Fits ${context.preferences.diet}` : 'Does not fit your diet',
      };
    },
  ],
  ['goal-match', (context, meal) => scoreGoal(context.preferences.goal, meal)],
  ['budget-match', (context, meal) => scoreBudget(context.preferences.budget, meal)],
  [
    'previous-like',
    (context, meal) => {
      const liked = context.favoriteMealIds.includes(meal.id);
      return {
        points: liked ? RECOMMENDATION_WEIGHTS.previousLike : 0,
        detail: liked ? 'One of your favourites' : 'Not yet a favourite',
      };
    },
  ],
  [
    'preparation-time-fit',
    (_context, meal) => {
      const band = PREPARATION_TIME_BANDS.find(
        (entry) => meal.preparationMinutes <= entry.maxMinutes,
      );
      return {
        points: band?.points ?? 0,
        detail: `${String(meal.preparationMinutes)} min to prepare`,
      };
    },
  ],
  [
    'local-availability',
    (_context, meal) => ({
      points: meal.available ? RECOMMENDATION_WEIGHTS.localAvailability : 0,
      detail: meal.available ? 'Available now' : 'Not available now',
    }),
  ],
  [
    'disliked-ingredient',
    (context, meal) => {
      const matched = matchedDislikedIngredients(meal, context.preferences.dislikedIngredients);
      return {
        points: matched.length * RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty,
        detail: matched.length === 0 ? 'No ingredients you avoid' : describeAvoided(matched),
      };
    },
  ],
];

/**
 * `-0` serialises as `0` but fails `Object.is` against it, which makes a comparison fail for a
 * reason nobody finds quickly. Normalised at the one seam where points are recorded.
 */
function normalizeZero(points: number): number {
  return points === 0 ? 0 : points;
}

export function scoreMeal(context: RecommendationContext, meal: Meal): ScoredMeal {
  const scoreReasons: ScoreReason[] = POLICIES.map(([kind, policy]) => {
    const result = policy(context, meal);
    return { kind, points: normalizeZero(result.points), detail: result.detail };
  });
  const raw = scoreReasons.reduce((total, reason) => total + reason.points, 0);
  const score = Math.min(SCORE_BOUNDS.max, Math.max(SCORE_BOUNDS.min, raw));
  return { meal, score, scoreReasons };
}

/** Score descending, then meal id ascending. The tie-break is what makes the order stable. */
function byScoreThenId(a: ScoredMeal, b: ScoredMeal): number {
  return b.score - a.score || compareIds(a.meal.id, b.meal.id);
}

/**
 * The full pipeline: reject, then score, then order, then take three.
 *
 * The three rejections run **before** any scoring, and each records why, so a test can assert
 * the reason rather than merely that a meal is absent.
 */
export function recommend(
  context: RecommendationContext,
  meals: readonly Meal[],
): RecommendationResult {
  const candidates: ScoredMeal[] = [];
  const rejected: RejectedMeal[] = [];

  for (const meal of meals) {
    if (hasAllergenConflict(meal, context.preferences.allergies)) {
      rejected.push({
        meal,
        reason: 'allergen-conflict',
        detail: 'Contains an allergen you declared',
      });
      continue;
    }
    if (!isDietCompatible(context.preferences.diet, [...meal.dietTags])) {
      rejected.push({ meal, reason: 'diet-incompatible', detail: 'Does not fit your diet' });
      continue;
    }
    if (!meal.available) {
      rejected.push({ meal, reason: 'unavailable', detail: 'Not available now' });
      continue;
    }
    candidates.push(scoreMeal(context, meal));
  }

  candidates.sort(byScoreThenId);
  return { candidates, selected: candidates.slice(0, MAX_RECOMMENDATIONS), rejected };
}
