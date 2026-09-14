/**
 * The recommendations route (TSD 5.4, Plan C-04).
 *
 * **No model anywhere in this phase, and that is deliberate.** The safety path - allergen and
 * diet rejection before any scoring - is proved end to end before a model is introduced, so
 * when P19 adds one there is a green baseline to compare against rather than two new variables
 * at once.
 *
 * **This endpoint has no 503** (Plan C-04). An explanation that times out, fails containment or
 * cannot reach the model degrades to `explanationSource: "fallback"` and the request still
 * succeeds: a recommendation is useful without prose, and PRD FR-009 says the feature degrades
 * rather than fails.
 *
 * **The client sends `mealPeriod`; the server holds no clock** (TSD 5.4). Deriving it here as
 * well would compute one fact along two paths that can disagree across a minute boundary or a
 * timezone read.
 */

import { Router } from 'express';
import type { Request, Response, Router as ExpressRouter } from 'express';
import { recommendationRequestSchema, SCORE_REASON_KINDS } from '@nutritime/contracts';
import type { Recommendation, RecommendationResponse, ScoreReason } from '@nutritime/contracts';
import { recommend } from '@nutritime/domain';
import type { ScoredMeal } from '@nutritime/domain';
import type { Catalog } from '../catalog.js';
import type { ServerConfig } from '../config.js';
import { ApiError, detailsFromIssues } from '../errors.js';

/** How many reasons a fallback sentence may cite. Three reads as prose; five reads as a list. */
const MAX_CITED_REASONS = 3;

/**
 * A deterministic explanation, built from the score reasons the domain already produced.
 *
 * Not a model sentence and not a template with a number substituted into it: every clause is a
 * `detail` string the scoring policy wrote, so the explanation cannot claim anything the score
 * did not. That is what makes `explanationSource: 'fallback'` honest rather than a euphemism.
 *
 * Reasons are taken in descending points, tie-broken on `SCORE_REASON_KINDS.indexOf` rather
 * than on the array index - the two coincide today only because `scoreMeal` happens to emit
 * reasons in declaration order, and a docstring that names one while the code keys the other is
 * a claim waiting to become false.
 */
function lowerFirst(detail: string): string {
  return detail.charAt(0).toLowerCase() + detail.slice(1);
}

export function fallbackExplanation(scored: ScoredMeal): string {
  const ordered = scored.scoreReasons.map((reason, index) => ({ reason, index }));

  const cited = ordered
    .filter((entry) => entry.reason.points > 0)
    .sort(
      (left, right) =>
        right.reason.points - left.reason.points ||
        SCORE_REASON_KINDS.indexOf(left.reason.kind) -
          SCORE_REASON_KINDS.indexOf(right.reason.kind),
    )
    .slice(0, MAX_CITED_REASONS)
    .map((entry) => entry.reason.detail);

  /**
   * **The penalty is cited too, and leaving it out was a real dishonesty.**
   *
   * Filtering to `points > 0` excluded `disliked-ingredient`, whose points are always at or
   * below zero - so a meal penalised -50 was explained entirely in positives. A recommendation
   * scoring 3 out of 100 read as three reasons in favour, with the one thing the user had
   * explicitly asked to avoid the only fact omitted.
   *
   * The module's claim was that the explanation cannot say anything the score did not. That was
   * true of what it said and false of what it left out, which is the harder failure to notice.
   */
  const penalty = ordered
    .filter((entry) => entry.reason.points < 0)
    .sort((left, right) => left.reason.points - right.reason.points)
    .map((entry) => entry.reason.detail)[0];

  if (cited.length === 0) {
    // Unreachable through the route - `recommend` hard-rejects diet-incompatible and
    // unavailable meals, so every selected meal already carries diet-match and availability
    // points. Kept because `fallbackExplanation` is exported and a future caller may not have
    // filtered first.
    return penalty === undefined
      ? 'This one fits your preferences.'
      : `${penalty}, but it fits your other preferences.`;
  }

  const [first, ...rest] = cited;
  const head = first ?? '';
  const tail = rest.map(lowerFirst);
  const positives =
    tail.length === 0
      ? head
      : tail.length === 1
        ? `${head}, and ${tail[0] ?? ''}`
        : `${head}, ${tail.slice(0, -1).join(', ')}, and ${tail[tail.length - 1] ?? ''}`;

  return penalty === undefined ? `${positives}.` : `${positives}, though ${lowerFirst(penalty)}.`;
}

function toRecommendation(scored: ScoredMeal): Recommendation {
  return {
    meal: scored.meal,
    score: scored.score,
    // Carried for debugging, per T-10-03: a score with no reasons is a number nobody can check.
    scoreReasons: scored.scoreReasons as readonly ScoreReason[],
    explanation: fallbackExplanation(scored),
    // Always `fallback` in this phase. P19 sets `gemma` only when a reply passes containment.
    explanationSource: 'fallback',
  };
}

export function recommendationsRouter(catalog: Catalog, _config: ServerConfig): ExpressRouter {
  const router = Router();

  router.post('/', (request: Request, response: Response) => {
    const parsed = recommendationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // `z.strictObject`, so an extra field is a 400 rather than being ignored. The request
      // body is a contract the client is expected to know; a query string is not.
      throw new ApiError('invalid_request', detailsFromIssues(parsed.error.issues));
    }

    const { mealPeriod, preferences, favoriteMealIds } = parsed.data;
    const result = recommend({ period: mealPeriod, preferences, favoriteMealIds }, catalog.meals);

    const body: RecommendationResponse = {
      mealPeriod,
      recommendations: result.selected.map(toRecommendation),
    };
    response.json(body);
  });

  return router;
}
