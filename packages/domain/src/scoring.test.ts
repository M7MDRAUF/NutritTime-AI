import { describe, expect, it } from 'vitest';
import type { Meal, ScoreReasonKind } from '@nutritime/contracts';
import { SCORE_REASON_KINDS } from '@nutritime/contracts';
import {
  BUDGET_BAND_MAX_CENTS,
  GOAL_BANDS,
  MAX_RECOMMENDATIONS,
  PREPARATION_TIME_BANDS,
  RECOMMENDATION_WEIGHTS,
  SCORE_BOUNDS,
  recommend,
  scoreMeal,
} from './scoring.js';
import type { RecommendationContext } from './scoring.js';

/**
 * Band edges, the clamp, and the tie-break. A scoring function is wrong at its boundaries if
 * it is wrong anywhere, and "deterministic" is a claim that has to be asserted rather than
 * assumed.
 */

const meal = (overrides: Partial<Meal> = {}): Meal => ({
  id: 'meal-base',
  name: 'Base Meal',
  description: 'A plain meal',
  mealPeriods: ['lunch'],
  ingredients: [{ name: 'rice', measure: '200 g' }],
  instructions: ['Cook.'],
  allergenTags: [],
  dietTags: ['vegetarian'],
  nutrition: { calories: 500, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 },
  price: { amountCents: 1000, currency: 'USD' },
  preparationMinutes: 20,
  imageUrl: null,
  available: true,
  source: 'local',
  catalogVersion: '1.0.0',
  provenance: { themealdbId: null, sourceUrl: null, imageSource: null, licenceConfirmed: false },
  nutritionProvenance: {
    origin: 'usda-derived',
    dataset: 'FNDDS 2022-10-28',
    servings: 2,
    reason: null,
  },
  ...overrides,
});

const context = (overrides: Partial<RecommendationContext> = {}): RecommendationContext => ({
  period: 'lunch',
  preferences: {
    diet: 'vegetarian',
    allergies: [],
    goal: 'balanced',
    budget: 'medium',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
  ...overrides,
});

const pointsFor = (kind: ScoreReasonKind, scored: ReturnType<typeof scoreMeal>): number =>
  scored.scoreReasons.find((reason) => reason.kind === kind)?.points ?? Number.NaN;

const detailFor = (kind: ScoreReasonKind, scored: ReturnType<typeof scoreMeal>): string =>
  scored.scoreReasons.find((reason) => reason.kind === kind)?.detail ?? '';

describe('every policy reports a reason', () => {
  it('produces exactly the eight reasons, in declaration order', () => {
    const scored = scoreMeal(context(), meal());
    expect(scored.scoreReasons.map((r) => r.kind)).toEqual([
      'meal-period-match',
      'diet-match',
      'goal-match',
      'budget-match',
      'previous-like',
      'preparation-time-fit',
      'local-availability',
      'disliked-ingredient',
    ]);
  });

  it('emits the reasons in the order the contract declares, not merely in some fixed order', () => {
    // The literal list above is re-typed here from the contract. Comparing against
    // SCORE_REASON_KINDS itself is what catches a reorder in core.ts, which the literal
    // list would silently disagree with.
    const scored = scoreMeal(context(), meal());
    expect(scored.scoreReasons.map((r) => r.kind)).toEqual([...SCORE_REASON_KINDS]);
  });
});

describe('the declared weights and the band tables agree', () => {
  // `goalMatchMax` and `preparationTimeFitMax` are never read by the scorer - the points
  // actually awarded are the literals inside the band tables. Without these assertions the
  // two constants could drift away from the tables and nothing would fail, which is exactly
  // the scattering SDD 8.2 says the weight object exists to prevent.
  it('the best goal band pays goalMatchMax', () => {
    expect(GOAL_BANDS.highProtein[0].points).toBe(RECOMMENDATION_WEIGHTS.goalMatchMax);
    expect(GOAL_BANDS.lowerCalorie[0].points).toBe(RECOMMENDATION_WEIGHTS.goalMatchMax);
    expect(GOAL_BANDS.balanced.insidePoints).toBe(RECOMMENDATION_WEIGHTS.goalMatchMax);
  });

  it('the fastest preparation band pays preparationTimeFitMax', () => {
    expect(PREPARATION_TIME_BANDS[0].points).toBe(RECOMMENDATION_WEIGHTS.preparationTimeFitMax);
  });

  it('the positive weights sum to exactly SCORE_BOUNDS.max', () => {
    // This is why the upper clamp is unreachable today. If a weight ever rises, this fails
    // here - where the reason is legible - rather than silently making the clamp live.
    const positive = Object.values(RECOMMENDATION_WEIGHTS).filter((w) => w > 0);
    expect(positive.reduce((total, w) => total + w, 0)).toBe(SCORE_BOUNDS.max);
  });
});

describe('diet match', () => {
  // Only reachable through `scoreMeal`: `recommend` hard-rejects an incompatible meal before
  // scoring, so nothing else in the suite can exercise the 0 branch of the second-largest
  // weight in the table.
  it('awards the full weight when the meal fits the declared diet', () => {
    expect(pointsFor('diet-match', scoreMeal(context(), meal()))).toBe(
      RECOMMENDATION_WEIGHTS.dietCompatible,
    );
  });

  it('awards the full weight when a stricter meal satisfies a looser diet', () => {
    // A vegan meal satisfies a vegetarian user; the reverse does not hold.
    const scored = scoreMeal(context(), meal({ dietTags: ['vegan'] }));
    expect(pointsFor('diet-match', scored)).toBe(RECOMMENDATION_WEIGHTS.dietCompatible);
  });

  it('awards nothing when the meal does not fit, and says so', () => {
    const strict = context({
      preferences: { ...context().preferences, diet: 'vegan' },
    });
    const scored = scoreMeal(strict, meal({ dietTags: ['vegetarian'] }));
    expect(pointsFor('diet-match', scored)).toBe(0);
    expect(detailFor('diet-match', scored)).toContain('diet');
  });
});

describe('meal-period match', () => {
  it('awards the full weight for a matching period and nothing otherwise', () => {
    expect(pointsFor('meal-period-match', scoreMeal(context(), meal()))).toBe(
      RECOMMENDATION_WEIGHTS.mealPeriodMatch,
    );
    expect(
      pointsFor('meal-period-match', scoreMeal(context({ period: 'breakfast' }), meal())),
    ).toBe(0);
  });
});

describe('goal bands', () => {
  const proteinAt = (proteinGrams: number | null) =>
    pointsFor(
      'goal-match',
      scoreMeal(
        context({
          preferences: { ...context().preferences, goal: 'high-protein' },
        }),
        meal({ nutrition: { calories: 500, proteinGrams, carbsGrams: 60, fatGrams: 10 } }),
      ),
    );

  it.each([
    [25, 15],
    [24, 10],
    [15, 10],
    [14, 5],
    [8, 5],
    [7, 0],
    [0, 0],
  ])('scores %i g of protein as %i points', (grams, expected) => {
    expect(proteinAt(grams)).toBe(expected);
  });

  const caloriesAt = (calories: number | null) =>
    pointsFor(
      'goal-match',
      scoreMeal(
        context({ preferences: { ...context().preferences, goal: 'lower-calorie' } }),
        meal({ nutrition: { calories, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 } }),
      ),
    );

  it.each([
    [400, 15],
    [401, 10],
    [600, 10],
    [601, 5],
    [800, 5],
    [801, 0],
  ])('scores %i kcal as %i points for lower-calorie', (kcal, expected) => {
    expect(caloriesAt(kcal)).toBe(expected);
  });

  const balancedAt = (calories: number) =>
    pointsFor(
      'goal-match',
      scoreMeal(
        context(),
        meal({ nutrition: { calories, proteinGrams: 20, carbsGrams: 60, fatGrams: 10 } }),
      ),
    );

  it.each([
    [350, 15],
    [700, 15],
    [349, 7],
    [701, 7],
  ])('scores %i kcal as %i points for balanced', (kcal, expected) => {
    expect(balancedAt(kcal)).toBe(expected);
  });

  it('scores an unknown nutrient as zero and says it is unavailable', () => {
    // The distinction that matters: zero points because unknown, not zero because low.
    // Reading it as "low protein" would rank an unmeasured meal as a bad one.
    const scored = scoreMeal(
      context({ preferences: { ...context().preferences, goal: 'high-protein' } }),
      meal({ nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null } }),
    );
    expect(pointsFor('goal-match', scored)).toBe(0);
    expect(detailFor('goal-match', scored)).toMatch(/not available/i);
  });

  it.each([['lower-calorie'], ['balanced']] as const)(
    'scores an unknown calorie count as zero for %s too',
    (goal) => {
      // Each goal branch carries its own `null` guard and its own detail string, so proving
      // high-protein proves nothing about these two. `balanced` is the trap: its non-null
      // path pays 7 points for being outside the range, so a missing guard would quietly
      // award 7 for a meal whose calories nobody knows.
      const scored = scoreMeal(
        context({ preferences: { ...context().preferences, goal } }),
        meal({
          nutrition: { calories: null, proteinGrams: null, carbsGrams: null, fatGrams: null },
        }),
      );
      expect(pointsFor('goal-match', scored)).toBe(0);
      expect(detailFor('goal-match', scored)).toMatch(/not available/i);
    },
  );
});

describe('budget bands', () => {
  const budgetAt = (amountCents: number) =>
    pointsFor(
      'budget-match',
      scoreMeal(context(), meal({ price: { amountCents, currency: 'USD' } })),
    );

  it('awards the full weight at and below the ceiling', () => {
    expect(budgetAt(BUDGET_BAND_MAX_CENTS.medium)).toBe(RECOMMENDATION_WEIGHTS.budgetMatchMax);
    expect(budgetAt(1)).toBe(RECOMMENDATION_WEIGHTS.budgetMatchMax);
  });

  it('awards the tolerance at exactly 125 percent of the ceiling', () => {
    // 1600 * 5/4 = 2000. Computed as price*4 <= ceiling*5 so the boundary is exact; the
    // float form (price <= ceiling * 1.25) makes this case a coin flip.
    expect(budgetAt(2000)).toBe(7);
  });

  it('awards nothing one cent beyond the tolerance', () => {
    expect(budgetAt(2001)).toBe(0);
  });

  it('applies the same exact boundary in the low band', () => {
    // 900 * 5/4 = 1125 exactly. Proving the arithmetic once does not prove the ceiling is
    // read from the band the user actually chose.
    const lowBudgetAt = (amountCents: number) =>
      pointsFor(
        'budget-match',
        scoreMeal(
          context({ preferences: { ...context().preferences, budget: 'low' } }),
          meal({ price: { amountCents, currency: 'USD' } }),
        ),
      );
    expect(lowBudgetAt(BUDGET_BAND_MAX_CENTS.low)).toBe(RECOMMENDATION_WEIGHTS.budgetMatchMax);
    expect(lowBudgetAt(BUDGET_BAND_MAX_CENTS.low + 1)).toBe(7);
    expect(lowBudgetAt(1125)).toBe(7);
    expect(lowBudgetAt(1126)).toBe(0);
  });

  it('treats the high band as effectively unbounded', () => {
    const scored = scoreMeal(
      context({ preferences: { ...context().preferences, budget: 'high' } }),
      meal({ price: { amountCents: 99_999, currency: 'USD' } }),
    );
    expect(pointsFor('budget-match', scored)).toBe(RECOMMENDATION_WEIGHTS.budgetMatchMax);
  });
});

describe('preparation-time bands', () => {
  const prepAt = (preparationMinutes: number) =>
    pointsFor('preparation-time-fit', scoreMeal(context(), meal({ preparationMinutes })));

  it.each([
    [15, 5],
    [16, 3],
    [30, 3],
    [31, 1],
    [45, 1],
    [46, 0],
    [0, 5],
  ])('scores %i minutes as %i points', (minutes, expected) => {
    expect(prepAt(minutes)).toBe(expected);
  });
});

describe('favourites and availability', () => {
  it('awards the favourite weight only for a listed id', () => {
    expect(
      pointsFor('previous-like', scoreMeal(context({ favoriteMealIds: ['meal-base'] }), meal())),
    ).toBe(RECOMMENDATION_WEIGHTS.previousLike);
    expect(pointsFor('previous-like', scoreMeal(context(), meal()))).toBe(0);
  });

  it('awards the availability weight only when available', () => {
    expect(pointsFor('local-availability', scoreMeal(context(), meal()))).toBe(
      RECOMMENDATION_WEIGHTS.localAvailability,
    );
    expect(pointsFor('local-availability', scoreMeal(context(), meal({ available: false })))).toBe(
      0,
    );
  });
});

describe('disliked ingredients', () => {
  const withDislikes = (dislikedIngredients: string[], ingredients: string[]) =>
    scoreMeal(
      context({ preferences: { ...context().preferences, dislikedIngredients } }),
      meal({ ingredients: ingredients.map((name) => ({ name, measure: '1' })) }),
    );

  it('penalises once per matching disliked TERM, not once per matching ingredient', () => {
    expect(
      pointsFor('disliked-ingredient', withDislikes(['mushroom'], ['mushrooms', 'rice'])),
    ).toBe(RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty);
    expect(
      pointsFor(
        'disliked-ingredient',
        withDislikes(['mushroom', 'onion'], ['mushrooms', 'onions']),
      ),
    ).toBe(RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty * 2);
  });

  it('charges one term once however many ingredients it matches', () => {
    // The earlier fixtures had one term per ingredient, so they could not tell the two
    // readings apart. One dislike is one dislike: a dish is not three times worse for
    // naming onion three ways.
    expect(
      pointsFor(
        'disliked-ingredient',
        withDislikes(['onion'], ['Spring onions', 'Red onion', 'Onion powder']),
      ),
    ).toBe(RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty);
  });

  it('charges one dislike once when the user types it in two forms', () => {
    // `dislikedIngredients` is free user text. Before de-duplication this scored -100 for a
    // single dislike, which changes the ranking and can drive the total to the 0 clamp.
    expect(
      pointsFor('disliked-ingredient', withDislikes(['mushroom', 'mushrooms'], ['mushrooms'])),
    ).toBe(RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty);
  });

  it('does not match a multi-word term across a separator inside one ingredient', () => {
    // TSD 4.1 names this pair: `"milk, chocolate"` is two segments, so the disliked term
    // `milk chocolate` must not match it. Tokenising without segmenting reports a dislike
    // the dish does not contain.
    expect(
      pointsFor('disliked-ingredient', withDislikes(['milk chocolate'], ['milk, chocolate'])),
    ).toBe(0);
    // The same term against a genuine single-segment ingredient still matches.
    expect(
      pointsFor('disliked-ingredient', withDislikes(['milk chocolate'], ['milk chocolate'])),
    ).toBe(RECOMMENDATION_WEIGHTS.dislikedIngredientPenalty);
  });

  it('matches whole tokens only', () => {
    // 'nut' must not match 'minute'. The shared text primitives guarantee this; the test
    // pins it at the point where a user would notice.
    expect(pointsFor('disliked-ingredient', withDislikes(['nut'], ['minute steak']))).toBe(0);
  });

  it('reports zero as zero, never as negative zero', () => {
    const scored = withDislikes([], ['rice']);
    expect(Object.is(pointsFor('disliked-ingredient', scored), 0)).toBe(true);
  });

  it('names what was avoided', () => {
    expect(detailFor('disliked-ingredient', withDislikes(['mushroom'], ['mushrooms']))).toContain(
      'mushroom',
    );
  });
});

describe('the total score', () => {
  it('clamps a heavily penalised meal to zero rather than going negative', () => {
    const scored = scoreMeal(
      context({
        preferences: { ...context().preferences, dislikedIngredients: ['rice', 'pea', 'carrot'] },
      }),
      meal({
        ingredients: [
          { name: 'rice', measure: '1' },
          { name: 'peas', measure: '1' },
          { name: 'carrots', measure: '1' },
        ],
      }),
    );
    expect(scored.score).toBe(0);
  });

  it('reaches exactly the upper bound when every policy pays its maximum', () => {
    // `toBeLessThanOrEqual(100)` passed at 0, 42 or 99 too. The perfect meal scores exactly
    // 100 - 30 + 20 + 15 + 15 + 10 + 5 + 5 - which is the sum asserted above, so the upper
    // clamp is unreachable by construction rather than merely untriggered.
    const scored = scoreMeal(
      context({ favoriteMealIds: ['meal-base'] }),
      meal({ preparationMinutes: 10, price: { amountCents: 100, currency: 'USD' } }),
    );
    expect(scored.score).toBe(SCORE_BOUNDS.max);
  });
});

describe('recommend', () => {
  const vegan = meal({ id: 'meal-a-vegan', dietTags: ['vegan'], name: 'A' });
  const veggie = meal({ id: 'meal-b-veggie', dietTags: ['vegetarian'], name: 'B' });
  const meaty = meal({ id: 'meal-c-meaty', dietTags: ['regular'], name: 'C' });
  const gone = meal({ id: 'meal-d-gone', dietTags: ['vegetarian'], available: false });
  const nutty = meal({
    id: 'meal-e-nutty',
    dietTags: ['vegetarian'],
    ingredients: [{ name: 'peanut butter', measure: '2 tbsp' }],
  });

  it('rejects for allergen conflict before anything else, with the reason recorded', () => {
    const result = recommend(
      context({ preferences: { ...context().preferences, allergies: ['peanut'] } }),
      [nutty],
    );
    expect(result.selected).toHaveLength(0);
    expect(result.rejected).toEqual([expect.objectContaining({ reason: 'allergen-conflict' })]);
  });

  it('records each rejection reason distinctly', () => {
    const result = recommend(
      context({ preferences: { ...context().preferences, allergies: ['peanut'] } }),
      [nutty, meaty, gone, veggie],
    );
    expect(result.rejected.map((r) => r.reason).sort()).toEqual([
      'allergen-conflict',
      'diet-incompatible',
      'unavailable',
    ]);
    expect(result.selected.map((s) => s.meal.id)).toEqual(['meal-b-veggie']);
  });

  it('returns at most the configured number of recommendations', () => {
    const many = Array.from({ length: 10 }, (_unused, index) =>
      meal({ id: `meal-${String(index).padStart(2, '0')}`, dietTags: ['vegetarian'] }),
    );

    /**
     * **Three, hand-transcribed from PRD §7.1's "Return the top three" — NOT read from
     * `MAX_RECOMMENDATIONS`.**
     *
     * This assertion was `toHaveLength(MAX_RECOMMENDATIONS)` until P28, which let the subject
     * define its own expectation: changing the constant to four would have kept it green, and
     * there was no literal cap anywhere in this file. BRIEF §6.1g — reading a bound out of the
     * module under test restates the implementation in test syntax, and it is the same shape as
     * `fellBack(outcomeForFailure(error))`, which was once praised as discipline and was its
     * opposite.
     *
     * The second assertion pins the constant to the document, so a drift in EITHER direction
     * fails: the behaviour against the requirement, and the constant against the requirement.
     */
    expect(recommend(context(), many).selected).toHaveLength(3);
    expect(MAX_RECOMMENDATIONS).toBe(3);
  });

  it('breaks a tie by meal id ascending', () => {
    // Identical meals but for the id: the order must be the id order, every time.
    const tied = [
      meal({ id: 'meal-zz', dietTags: ['vegetarian'] }),
      meal({ id: 'meal-aa', dietTags: ['vegetarian'] }),
      meal({ id: 'meal-mm', dietTags: ['vegetarian'] }),
    ];
    expect(recommend(context(), tied).selected.map((s) => s.meal.id)).toEqual([
      'meal-aa',
      'meal-mm',
      'meal-zz',
    ]);
  });

  it('is deterministic: the same input twice gives a deeply equal result', () => {
    const meals = [vegan, veggie, meaty, gone, nutty];
    const first = recommend(context({ favoriteMealIds: ['meal-a-vegan'] }), meals);
    const second = recommend(context({ favoriteMealIds: ['meal-a-vegan'] }), meals);
    expect(first).toEqual(second);
    expect(first.selected.map((s) => s.score)).toEqual(second.selected.map((s) => s.score));
  });

  it('does not let a high score rescue a rejected meal', () => {
    // The favourite weight cannot buy its way past an allergen.
    const result = recommend(
      context({
        favoriteMealIds: ['meal-e-nutty'],
        preferences: { ...context().preferences, allergies: ['peanut'] },
      }),
      [nutty],
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.selected).toHaveLength(0);
  });
});
