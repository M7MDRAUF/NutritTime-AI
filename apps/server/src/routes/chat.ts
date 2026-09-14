/**
 * The chat route - `POST /api/v1/chat` (TSD 5.4, Plan C-05).
 *
 * **This is the route the containment architecture exists for.** Five steps run in TSD 5.4's
 * order: parse, retrieve, resolve, check the switch, phrase. The domain decides what is true and
 * the model only writes the sentence (PRD FR-015, SDD 9.1), so no reply reaches UI state without
 * passing `containReply` first.
 *
 * **The step ORDER is TSD 5.4's, and one detail of it is worth stating.** `AI_ENABLED` is
 * checked at step 4 - *after* retrieval and resolution - so a user who has merely switched the
 * model off still gets a real, deterministic answer whenever the domain has one, and only ever
 * sees `ai_disabled` for a question that actually needed phrasing. Hoisting that check above
 * step 2 would turn every answerable question into a 503 and make the assistant look broken to
 * someone who turned off a feature they were not using. (Plan 11.6 is a FIELD contract and not a
 * step order; citing it for the steps is recorded as defect 16 in Plan 18.)
 *
 * **The most expensive mistake available here is calling the model when the domain already
 * answered.** It costs ~11 seconds (PRD 10.1) and reintroduces a fabrication surface for no
 * gain, so steps 2 and 3 return before the provider is ever constructed into a call. That the
 * provider is **not invoked** on those paths is what the tests assert with a spy; a response that
 * merely looks right would pass either way.
 *
 * **`answered: false` is HTTP 200** (TSD 5.4). It is the endpoint answering correctly.
 *
 * **No failure path returns generated prose, and there is no fallback answer** (Plan 15.3, PRD
 * FR-015): a free-text question has no rule-based equivalent, so an unavailable model produces an
 * explicit 503 with no `answer` field at all. That is the difference between this lane and the
 * explanation lane, which has no 503 because a recommendation is useful without prose.
 *
 * **This is the first caller `aiLogLine` has ever had.** TSD 5.8's AI log line has existed in
 * `logging.ts` since P08, asserted as a pure function with nothing connecting it to code that
 * calls it - exactly the shape P08's own audit found for the error handler, surviving that repair
 * only because there was no AI lane to call it yet. One line per AI call now (AMENDMENT 7).
 *
 * **It carries `lane`, `durationMs`, `outcome` and nothing else**, and what keeps it that way is
 * that `AiLogFields` has no parameter anything else could arrive through. The containment `rule`
 * and `evidence` are **never** logged: TSD 5.8 defines no field for either (X-40), and check 1's
 * evidence is model-authored text derived from the question, so logging it logs a question at one
 * remove (PRD 10.3). Assembling the JSON by hand to add a field is the one way round that.
 */

import { Router } from 'express';
import type { Request, Response, Router as ExpressRouter } from 'express';
import { chatModelReplySchema, chatRequestSchema } from '@nutritime/contracts';
import type { ChatModelReply, ChatResponse, Citation, Meal } from '@nutritime/contracts';
import { resolveAnswer, retrieveChatMeals } from '@nutritime/domain';
import type { ResolvedAnswer } from '@nutritime/domain';
import { AiBusyError, AiTimeoutError } from '../aiLane.js';
import type { AiLane } from '../aiLane.js';
import { chatFormat } from '../ai/chatFormat.js';
import { CHAT_COPY, copyForUnresolved } from '../ai/chatCopy.js';
import { buildContainmentGround, containReply } from '../ai/containment.js';
import { OllamaAbortError, OllamaError } from '../ai/ollamaClient.js';
import { outcomeForFailure } from '../ai/outcome.js';
import { buildChatPrompt } from '../ai/prompt.js';
import type { AiProvider, Generation } from '../ai/provider.js';
import type { Catalog } from '../catalog.js';
import type { ServerConfig } from '../config.js';
import { ApiError, detailsFromIssues } from '../errors.js';
import { aiLogLine } from '../logging.js';
import type { AiOutcome, LogSink } from '../logging.js';

/**
 * A deterministic answer: `answered: false`, `source: 'local'`, and **no citations**.
 *
 * Citations are empty rather than the retrieved five because a citation is what an answer *drew
 * on*, and these answers drew on nothing (PRD 7.3: a question the retrieved meals cannot answer
 * "cites nothing"). Listing five meals beside "I do not have that information" would present
 * them as evidence for a refusal.
 */
function localAnswer(answer: string): ChatResponse {
  return { answered: false, answer, citations: [], source: 'local' };
}

/**
 * Citations resolved from `namedMeals` **by id** (TSD 5.4 step 5, T-21-03).
 *
 * **Never parsed out of the answer text**, and the direction of the filter is what guarantees
 * it: the meals are the source and `citedMealIds` is only a membership test, so a name the model
 * wrote into its prose cannot become a citation no matter how confidently it is spelled. Reading
 * a model's sentence for meal names is how a hallucination acquires a link to tap on.
 *
 * Iterating `namedMeals` rather than `citedMealIds` also buys three properties for free: the
 * order is the domain's, so it is stable across identical requests; a repeated id cannot produce
 * a duplicate citation; and there is no id-to-meal lookup that can miss, so no `undefined` to
 * paper over. The cap is structural too - `chatModelReplySchema` bounds `citedMealIds` at five,
 * so the filtered result cannot exceed Plan 11.6's five citations.
 */
function citationsFor(
  namedMeals: readonly Meal[],
  citedMealIds: readonly string[],
): readonly Citation[] {
  const cited = new Set(citedMealIds);
  return namedMeals
    .filter((meal) => cited.has(meal.id))
    .map((meal) => ({ mealId: meal.id, name: meal.name }));
}

/**
 * What a failed AI call becomes on the wire (TSD 3.5, Plan 15.3).
 *
 * `ai_busy` for the lane being occupied; `ai_unavailable` for a timeout, an unreachable or
 * misbehaving model, a reply that failed its schema, and a cancelled call. Every one of them
 * carries `errors.ts`'s fixed local message and **no answer text**.
 *
 * **Anything else is returned unchanged so it becomes a 500**, and that is deliberate rather
 * than a gap. TSD 3.5 lists the causes of `ai_unavailable` exhaustively and a bug in this file
 * is not among them; TSD 5.3 step 6 says anything that is not an `ApiError` is "a 500 with a
 * fixed message and a logged stack". Mapping every throw to `ai_unavailable` would report a
 * healthy-but-broken server as a missing model and make the defect invisible - retryable, even,
 * so the client would cheerfully ask again. The 500 body is `INTERNAL_ERROR_BODY`, which is
 * still fixed local copy with no prose in it.
 */
function chatFailure(error: unknown): unknown {
  if (error instanceof AiBusyError) {
    return new ApiError('ai_busy');
  }
  if (
    error instanceof AiTimeoutError ||
    error instanceof OllamaError ||
    error instanceof OllamaAbortError
  ) {
    return new ApiError('ai_unavailable');
  }
  return error;
}

export interface ChatRouterDeps {
  readonly catalog: Catalog;
  readonly config: ServerConfig;
  readonly lane: AiLane;
  readonly provider: AiProvider;
  readonly sink: LogSink;
  readonly now: () => Date;
}

export function chatRouter(deps: ChatRouterDeps): ExpressRouter {
  const { catalog, config, lane, now, provider, sink } = deps;
  const router = Router();

  /**
   * One AI log line, through `aiLogLine` rather than assembled here.
   *
   * **Both readings come from the injected `now`**, which is why `durationMs` is exactly
   * assertable: `logging.ts` takes the clock as a parameter precisely so "a test asserts an exact
   * line instead of a regex around a moving timestamp", and a duration measured from a second
   * clock could disagree with the timestamp on the same line. Exactly two reads per call.
   */
  function logAiCall(startedAt: Date, outcome: AiOutcome): void {
    const finishedAt = now();
    sink(
      aiLogLine(
        { lane: 'chat', durationMs: finishedAt.getTime() - startedAt.getTime(), outcome },
        finishedAt,
      ),
    );
  }

  /**
   * Step 5 - phrase the resolved answer through the lane, then contain the reply.
   *
   * **The ground comes from `buildContainmentGround(resolved, catalog.meals)`**, so citations are
   * compared against `resolved.namedMeals` and never against the five retrieved meals (R-21).
   * A superlative resolves over `scope.eligible` (TSD 4.9's scope rule), so its winner is
   * routinely *outside* `scope.context` - a check written against the retrieved five would
   * discard every correct superlative whose winner did not happen to rank.
   *
   * **`echo` is TSD 5.5's fake reply, built here because only this scope holds the resolved
   * answer.** `{ answered: true, answer: resolved.statement, citedMealIds: resolved.citedMealIds }`
   * passes containment **by construction** - the domain computed every part of it - and that is
   * the point rather than a convenience: if this reply ever fails containment, containment has a
   * false positive and that is a real defect, not a fixture to adjust. Per AMENDMENT 3 the fake
   * now validates the echo against `decode`, so an over-700-character statement or a sixth
   * citation fails as `OllamaError('schema')` rather than echoing; retrieval's five-meal cap
   * makes both unreachable today.
   *
   * The reply's `answered` flag is **not** read. The domain already resolved an answer, so the
   * question is settled before the model sees it; treating a model's boolean as authority over
   * whether the domain answered would be exactly the inversion BRIEF 7.1 forbids.
   */
  async function phrase(question: string, resolved: ResolvedAnswer): Promise<ChatResponse> {
    const built = buildChatPrompt({ question, resolved });
    const ground = buildContainmentGround(resolved, catalog.meals);

    const generation: Generation<ChatModelReply> = {
      prompt: built.prompt,
      format: chatFormat(built.promptMealIds),
      decode: chatModelReplySchema,
      echo: {
        answered: true,
        answer: resolved.statement,
        citedMealIds: resolved.citedMealIds,
      },
    };

    // Taken before the lane is entered, so the duration covers the whole attempt rather than
    // only the part that succeeded. A busy rejection never reaches a log line, so this read
    // being slightly early costs nothing there.
    const startedAt = now();

    let reply: ChatModelReply;
    try {
      reply = await lane.run(
        (signal) => provider(generation, signal),
        // The CHAT budget (30 s), never the explanation one. Two budgets, deliberately not
        // unified (BRIEF 7.5).
        config.OLLAMA_CHAT_TIMEOUT_MS,
      );
    } catch (error) {
      // **One error, two independent classifications, and they are deliberately not one
      // function.** `outcomeForFailure` is TSD 5.8's log `outcome` and is **shared with the
      // explanation lane** (`ai/outcome.ts`) - it lived in both routes for one wave and nothing
      // could have caught a divergence, because neither suite can assert about a constant in a
      // file it does not import. `chatFailure` below is TSD 3.5's wire code and stays local,
      // because the two lanes genuinely differ there: this one answers 503 and the explanation
      // lane has no 503 at all (Plan C-04). `undefined` means no line - see `ai/outcome.ts`.
      const outcome = outcomeForFailure(error);
      if (outcome !== undefined) {
        logAiCall(startedAt, outcome);
      }
      throw chatFailure(error);
    }

    // Outside the `try` on purpose: a containment failure is this server's own verdict, not
    // something the lane threw, and routing it through `chatFailure` would make the mapping
    // read as if the model had reported it.
    const verdict = containReply(reply, ground);
    if (!verdict.contained) {
      // `verdict.rule` and `verdict.evidence` are read by nothing here, and the log line below
      // is where that matters. TSD 5.7: "The client is never told which rule fired" - a
      // containment rule is not something a caller should be able to probe for - and TSD 5.8
      // gives no log field for either (X-40). `contained` is the whole of what is recorded.
      logAiCall(startedAt, 'contained');
      throw new ApiError('ai_unavailable');
    }

    const citations = citationsFor(resolved.namedMeals, reply.citedMealIds);

    /**
     * **A resolved answer with no citations is discarded: PRD 7.3 requires the meals be shown.**
     *
     * "Show the meals the answer drew on as citations" is a requirement, and the four checks above
     * cannot enforce it. Check 1 verifies that no cited id is OUTSIDE the prompt's ids; an empty
     * `citedMealIds` has no id outside anything, so it passes -- vacuously, in exactly the way
     * T-19-09's acceptance warned about for figures ("an empty permitted set forbids every figure;
     * it does not skip the check"). The same vacuity, on the other axis, was missed.
     *
     * **It is reachable against a real model.** TSD 5.5's per-request schema constrains citation
     * *values* through an `enum` of this prompt's ids and says nothing about the array's minimum
     * length, so `[]` is a schema-valid reply. `AI_FAKE` cannot produce it -- the echo carries
     * `resolved.citedMealIds` by construction -- which is why nine phases of `AI_FAKE` evidence
     * could not have found this. Found at P24 by an agent reading the route rather than running it.
     *
     * **Discarded rather than repaired, and the alternative is recorded.** `resolved` holds a true
     * statement and its own `citedMealIds`, so substituting them would give the user a better
     * answer than a 503 does. That path is deliberately NOT taken here: TSD 5.7 specifies discard
     * for an unusable reply, every other containment failure on this route answers `ai_unavailable`,
     * and inventing a second degradation shape would be this route deciding product behaviour no
     * document describes. The substitution is worth considering and belongs to the user (R-71).
     *
     * **The condition reads OUR data, never the model's.** `containReply`'s docstring: making a
     * check conditional on a boolean the model controls "would hand the model a switch for turning
     * containment off". So the guard is `resolved.namedMeals`, computed by the domain before the
     * model was reachable -- not `reply.answered`, and not `reply.citedMealIds` alone.
     *
     * An answer that legitimately draws on no meal is unaffected: TSD 4.9's `count` carries no
     * meals, so `namedMeals` is empty, so there is nothing to show and nothing to require.
     *
     * The outcome is `'contained'` because that is what happened -- an ungrounded reply was
     * discarded -- and TSD 5.8 defines no other value for it. TSD 5.7's "the client is never told
     * which rule fired" is why the 503 carries no detail.
     */
    if (citations.length === 0 && resolved.namedMeals.length > 0) {
      logAiCall(startedAt, 'contained');
      throw new ApiError('ai_unavailable');
    }

    logAiCall(startedAt, 'ok');

    return {
      answered: true,
      answer: reply.answer,
      citations,
      source: 'gemma',
    };
  }

  router.post('/', async (request: Request, response: Response) => {
    // Step 1 - parse. `z.strictObject`, so `goal` or `budget` inside `preferences` is a 400 and
    // not a silent ignore (TSD 5.4, Plan 11.6): retrieval does not read either, and a required
    // field that changes nothing is a field that will eventually be believed. `details` carries
    // the field PATHS and a message `errors.ts` chose - never the submitted value, which on this
    // route could be the allergy list itself (PRD 10.3).
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('invalid_request', detailsFromIssues(parsed.error.issues));
    }
    const { question, preferences } = parsed.data;

    // Step 2 - retrieve. Allergen rejection on EFFECTIVE tags, diet compatibility and
    // availability all run here, deterministically, before the model is reachable (PRD FR-015,
    // TSD 4.8). The user's allergy list is consumed at this line and enters no prompt.
    const scope = retrieveChatMeals({ question, preferences, meals: catalog.meals });
    if (scope.eligible.length === 0) {
      response.json(localAnswer(CHAT_COPY.noEligibleMeals));
      return;
    }

    // Step 3 - resolve. The domain computes the answer; this is the step the model cannot
    // reach past.
    const outcome = resolveAnswer(question, scope);
    if (outcome.kind === 'unresolved') {
      response.json(localAnswer(copyForUnresolved(outcome.reason)));
      return;
    }

    // Step 4 - the switch, checked here and NOT earlier. See the header.
    if (!config.AI_ENABLED) {
      throw new ApiError('ai_disabled');
    }

    // Step 5. Nothing has been written to the response yet, so a failure below is still free to
    // become a clean 503 through `app.ts`'s error handler.
    response.json(await phrase(question, outcome));
  });

  return router;
}
