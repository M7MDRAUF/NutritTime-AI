/**
 * The recommendations route (TSD 5.4, Plan C-04).
 *
 * **The safety path ran without a model first, and that ordering is what P20 spends.** Allergen
 * and diet rejection was proved end to end at P10 with `explanationSource` pinned to the constant
 * `'fallback'`; this phase turns that constant into a real value against a green baseline.
 *
 * **This endpoint has no 503** (Plan C-04). An explanation that times out, fails containment or
 * cannot reach the model degrades to `explanationSource: "fallback"` and the request still
 * succeeds: a recommendation is useful without prose, and PRD FR-009 says the feature degrades
 * rather than fails. Nothing in the explanation lane may change the status, the meals, their
 * order, the scores or the `scoreReasons` - only `explanation` and `explanationSource`.
 *
 * **The client sends `mealPeriod`; the server holds no clock** (TSD 5.4). Deriving it here as
 * well would compute one fact along two paths that can disagree across a minute boundary or a
 * timezone read.
 */

import { Router } from 'express';
import type { Request, Response, Router as ExpressRouter } from 'express';
import { recommendationRequestSchema, SCORE_REASON_KINDS } from '@nutritime/contracts';
import type { Recommendation, RecommendationResponse } from '@nutritime/contracts';
import { recommend } from '@nutritime/domain';
import type { ScoredMeal } from '@nutritime/domain';
import { explainRecommendation } from '../ai/explanation.js';
import type { ExplainedReason } from '../ai/explanation.js';
import type { AiProvider } from '../ai/provider.js';
import type { AiLane } from '../aiLane.js';
import type { Catalog } from '../catalog.js';
import type { ServerConfig } from '../config.js';
import { ApiError, detailsFromIssues } from '../errors.js';
import { aiLogLine, errorLogLine, framesOf } from '../logging.js';
import type { AiOutcome, LogSink } from '../logging.js';

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

/**
 * The sentence served if `fallbackExplanation` itself throws.
 *
 * It is deliberately the same sentence `fallbackExplanation` returns when no policy scored in a
 * meal's favour, and honest for the same reason: `recommend` hard-rejects every diet-incompatible
 * and allergen-conflicting meal before scoring, so "it fits your preferences" is the one claim
 * true of anything this route can return. Fixed local copy, per PRD 12.
 *
 * The template builder cannot throw on input `recommend` produced - every field it reads is
 * required by `ScoredMeal`. It is here because the alternative to a one-line initialiser is a 500
 * on this endpoint, which would mean a failure in the *explanation* lane took the recommendations
 * down with it: the exact inversion of PRD FR-009.
 */
const LAST_RESORT_EXPLANATION = 'This one fits your preferences.';

function toRecommendation(scored: ScoredMeal, explained: ExplainedReason): Recommendation {
  return {
    meal: scored.meal,
    score: scored.score,
    // Carried for debugging, per T-10-03: a score with no reasons is a number nobody can check.
    //
    // **No assertion here, and the assertion that used to be here is RETRACTED.** This line read
    // `scored.scoreReasons as readonly ScoreReason[]` with no reason stated, and both sides were
    // already the same type: `ScoredMeal.scoreReasons` (`packages/domain/src/scoring.ts`,
    // `export interface ScoredMeal`) and `Recommendation.scoreReasons`
    // (`packages/contracts/src/core.ts`, `export interface Recommendation`) are both
    // `readonly ScoreReason[]` of the one `ScoreReason` that `@nutritime/contracts` declares and
    // that `scoring.ts` imports from there. So the cast asserted nothing today and disarmed the
    // only check that matters tomorrow: the day the domain's reason shape diverges from the wire
    // contract's, an assertion turns a compile error into a silently wrong `POST /recommendations`
    // body. Measured, not argued - `tsc --noEmit -p apps/server` is exit 0 without it, and with the
    // cast gone but its import kept the only error is TS6196 on `ScoreReason` itself, which is the
    // proof that the type was imported into this module for nothing but the cast.
    scoreReasons: scored.scoreReasons,
    explanation: explained.explanation,
    explanationSource: explained.explanationSource,
  };
}

export interface RecommendationsRouterDeps {
  readonly catalog: Catalog;
  readonly config: ServerConfig;
  readonly lane: AiLane;
  readonly provider: AiProvider;
  readonly sink: LogSink;
  readonly now: () => Date;
}

export function recommendationsRouter(deps: RecommendationsRouterDeps): ExpressRouter {
  const { catalog, config, lane, now, provider, sink } = deps;
  const router = Router();

  /**
   * One AI log line (TSD 5.8), written exactly as `chat.ts` writes its own so the two lanes are
   * comparable: `lane`, `durationMs`, `outcome` and nothing else - never a prompt, a meal name,
   * an explanation, a containment `rule` or its `evidence` (TSD 5.8, PRD 10.3, X-40). Both
   * readings come from the injected `now`, so one line's duration and timestamp cannot come from
   * two clocks that disagree, and a test asserts an exact line.
   */
  function logAiCall(startedAt: Date, outcome: AiOutcome): void {
    const finishedAt = now();
    sink(
      aiLogLine(
        { lane: 'explanation', durationMs: finishedAt.getTime() - startedAt.getTime(), outcome },
        finishedAt,
      ),
    );
  }

  /**
   * One recommendation's prose, and the only place in this route that can produce `'gemma'`.
   *
   * **`attempt` is the two-condition gate of TSD 5.4**, and it is the PRIMARY of the two layers
   * that enforce it: §5.4 places the gate here, and the route is the only thing that can see the
   * *request's* `aiEnabled`. `explanation.ts` checks `AI_ENABLED` again as defence for a future
   * caller - TSD 5.5 establishes that pattern ("layer 0 does not replace layer 1") - and each
   * layer is pinned by its own test: this one by the `explainRecommendation` call-count spy, since
   * **when either condition is false that function is not called at all**, which is the
   * consequence the second layer cannot produce.
   *
   * **`remainingMs` is the request's share of the explanation budget, not this meal's.** See the
   * loop below.
   *
   * **One `try` covering both statements, and both of its failure modes are real.**
   * `explainRecommendation` is contracted never to throw (CONTRACTS 10), so catching it is
   * defence against a module this route does not own regressing - and `fallback` still holds the
   * template text by then, so the user loses the model's phrasing and nothing else. If the
   * template builder is what threw, `fallback` is still the last-resort sentence. Neither may cost
   * a 200, and both log by name and frames only - never a message, never `String(error)` (PRD 12,
   * TSD 3.5) - the way `createErrorHandler` does it.
   */
  async function explain(
    scored: ScoredMeal,
    attempt: boolean,
    remainingMs: number,
  ): Promise<ExplainedReason> {
    let fallback = LAST_RESORT_EXPLANATION;
    try {
      fallback = fallbackExplanation(scored);
      if (!attempt || remainingMs <= 0) {
        return { explanation: fallback, explanationSource: 'fallback' };
      }

      const startedAt = now();
      const explained = await explainRecommendation({
        scored,
        // The remaining budget, handed down as the per-call timeout so the lane's own abort
        // enforces it. See the loop below for why the budget is shared.
        config: { ...config, OLLAMA_EXPLANATION_TIMEOUT_MS: remainingMs },
        lane,
        provider,
        fallback,
      });

      /**
       * **`outcome` is read from the reply (AMENDMENT 8a), no longer inferred here.**
       *
       * This was a decorator around the `lane` dep, because `explainRecommendation` swallows every
       * failure by contract and the route could not see WHICH one happened - and logging a guess
       * would be the fabricated classification `chat.ts` refused to write. The decorator existed
       * for one more reason: `explanation.ts` held a private third copy of the mapping that
       * disagreed with `ai/outcome.ts` on `OllamaAbortError`, so reading this field would have
       * taken the explanation lane OFF the shared function. `explanation.ts:51` now imports
       * `outcomeForFailure`, so the field and the decorator would give the same answer from the
       * same code - and the field gives it without this route reaching around a module it does not
       * own. Both lanes reach TSD 5.8's one mapping, by one path each.
       *
       * `undefined` means write nothing, and it is the honest value for all three of its cases: no
       * call was attempted, the lane was busy so `fn` never ran, or the rejection is not one of
       * 5.8's five. A `durationMs` for a call that did not happen would be a fabricated
       * measurement (C1's ruling on `ai_busy`, which both lanes must share or the field says
       * nothing).
       *
       * `durationMs` now spans the prompt build and containment as well as the model round trip.
       * Those are microseconds against a budget in seconds, and the alternative is the route
       * timing a call it no longer watches.
       */
      if (explained.outcome !== undefined) {
        logAiCall(startedAt, explained.outcome);
      }
      return explained;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      sink(errorLogLine({ errorName, frames: framesOf(error) }, now()));
      return { explanation: fallback, explanationSource: 'fallback' };
    }
  }

  router.post('/', async (request: Request, response: Response) => {
    const parsed = recommendationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // `z.strictObject`, so an extra field is a 400 rather than being ignored. The request
      // body is a contract the client is expected to know; a query string is not.
      throw new ApiError('invalid_request', detailsFromIssues(parsed.error.issues));
    }

    const { mealPeriod, aiEnabled, preferences, favoriteMealIds } = parsed.data;
    const result = recommend({ period: mealPeriod, preferences, favoriteMealIds }, catalog.meals);

    // **No re-filtering and no re-ranking here.** `recommend` decided the set, the order and
    // the scores; this route explains them. A second policy at this layer is a second answer to
    // a question the domain has already answered.
    const attempt = aiEnabled && config.AI_ENABLED;

    /**
     * Explained **one at a time, against ONE shared deadline for the whole step**.
     *
     * Sequential because the lane is single-flight process-wide with no queue (TSD 5.5): three
     * concurrent calls would take one turn and reject the other two with `AiBusyError`, silently
     * degrading two of every three recommendations while the model sat idle between them.
     *
     * **Shared because `OLLAMA_EXPLANATION_TIMEOUT_MS` bounds the explanation STEP, not one
     * meal.** PRD 10.1's table is per-path throughout - "App start to usable Home", "Local
     * navigation", "Recommendations without AI ≤ 2 s" - and its explanation row reads
     * "Recommendation explanation, warm model ~5 s, hard timeout 12 s", singular, among those. A
     * per-meal reading puts the warm case at ~15 s against a table predicting ~5 s and exceeds
     * TSD 6.5's 15 s client deadline by 2.4x, at which point the client gives up before the
     * server answers and the user sees a transport failure instead of the degradation PRD FR-009
     * promises. Shared, the first meal may get a model sentence and the other two fall back -
     * FR-009 happening *within one response*. A meal whose turn arrives with nothing left gets
     * its template text with **no model call**.
     *
     * **`Date.now()` here, and the injected `now()` on the log line**, both following `app.ts`'s
     * request logger: a test that freezes the clock to assert an exact log line must not thereby
     * switch off a bound whose job is to keep a slow model inside the *client's* deadline.
     */
    const deadline = Date.now() + config.OLLAMA_EXPLANATION_TIMEOUT_MS;
    const recommendations: Recommendation[] = [];
    for (const scored of result.selected) {
      const explained = await explain(scored, attempt, deadline - Date.now());
      recommendations.push(toRecommendation(scored, explained));
    }

    const body: RecommendationResponse = { mealPeriod, recommendations };
    response.json(body);
  });

  return router;
}
