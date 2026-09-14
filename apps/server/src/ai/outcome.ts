/**
 * The one mapping from a failure to TSD 5.8's `outcome`, shared by both AI lanes.
 *
 * **It lived in THREE files for one wave, and two of them had already diverged.** That is why this
 * module exists, and the count matters: the first version of this docstring said "two", which was
 * the orchestrator's belief when the extraction began and was wrong before the day was out.
 *
 * The chat route wrote it, the recommendations route transcribed it by hand, and the explanation
 * lane wrote a third independently. The third **already disagreed** on `OllamaAbortError` -
 * `undefined` in one, `'unreachable'` in another - which is the single value whose whole purpose
 * is to separate "the caller cancelled" from "the model is absent".
 *
 * Nothing could have caught it. Each route's tests assert its own lines against its own
 * expectations, so there is **no assertion any of the three suites could make about a constant in
 * a file it does not import**: the copies could drift apart indefinitely with every suite green,
 * while an operator read `schema` from one lane and `unreachable` from another for one cause.
 *
 * Three independent authors reached for the same collapse, which says the distinction is hard to
 * hold rather than that anyone was careless - and is the argument for making it unrepresentable
 * instead of writing a fourth careful copy.
 *
 * A test for that divergence was the obvious repair and it is the wrong one - there is no
 * assertion either suite could make about a constant in a file it does not import. **One copy
 * makes the divergence unrepresentable**, which is a better outcome than a test that notices it.
 *
 * ---
 *
 * `OllamaFailureReason` (six, TSD 5.5) to `AiOutcome` (five, TSD 5.8) - and **four of the six have
 * no exact home, which is a divergence between two sections of one document** (recorded as a
 * conflict row rather than resolved here).
 *
 * `AiOutcome` is TSD 5.8's closed set and `logging.ts` is a spine file, so a sixth value is not
 * available and inventing one would be a document amendment. The line drawn instead is the only
 * one the five outcomes support - **did a usable response come back?** `unreachable` is *nothing
 * usable arrived from the transport*, which `http-status` joins because a non-2xx is the service
 * declining to serve and nothing was generated. `schema` is *a response arrived and could not be
 * used as a structured reply*, which `envelope`, `empty-reply` and `truncated` join because none
 * can be turned into a reply this server will read.
 *
 * **What that loses, stated plainly, because a log field nobody can act on is worse than none:**
 * an operator seeing `schema` cannot tell a malformed envelope from a token-capped reply from a
 * Zod rejection, and the three have different fixes - an Ollama version, `GENERATION.numPredict`,
 * and the prompt or `format` respectively. `truncated` is the least comfortable of the four:
 * TSD 5.5 notes a truncated reply "can still be parseable JSON", so calling it `schema` names a
 * symptom it may not have. It is still the least wrong of five: `timeout` would send the reader to
 * the deadline when the cause is the token ceiling, and `unreachable` would report a model that
 * answered as absent.
 */

import { AiTimeoutError } from '../aiLane.js';
import { OllamaAbortError, OllamaError } from './ollamaClient.js';
import type { OllamaFailureReason } from './ollamaClient.js';
import type { AiOutcome } from '../logging.js';

/** Keyed by reason, so a seventh `OllamaFailureReason` is a **compile error**. */
const OUTCOME_FOR_REASON: Readonly<Record<OllamaFailureReason, AiOutcome>> = {
  unreachable: 'unreachable',
  'http-status': 'unreachable',
  envelope: 'schema',
  'empty-reply': 'schema',
  truncated: 'schema',
  schema: 'schema',
};

/**
 * The outcome to log for a failed AI call, or `undefined` for **no line at all**.
 *
 * **`AiBusyError` writes no AI log line, and that is the considered answer rather than an
 * omission.** TSD 5.8 says "AI calls add `lane`, `durationMs`, `outcome`" - a busy rejection is
 * not an AI call. `aiLane.run` rejects before `fn` is ever invoked, so the model was never
 * reached, and a `durationMs` for a call that did not happen is a fabricated measurement: an
 * operator reading a lane's latency would be averaging in a fleet of ~0 ms entries for calls that
 * never ran. There is also no outcome for it in the closed set, and folding it into `unreachable`
 * would report a stopped model when the truth is a busy one - verbatim the defect recorded on the
 * abort side of the same race. The rejection is not invisible: it is a property of the REQUEST,
 * and `app.ts`'s per-request line already carries it as `status: 503` with
 * `errorCode: 'ai_busy'`.
 *
 * **An unrecognised throw writes no line either**, for the same reason: it is a defect, not one of
 * five outcomes, and `app.ts`'s error handler records its name and frames. Choosing a value from
 * the closed set for it would be a fabricated classification.
 *
 * `OllamaAbortError` is `unreachable` - nothing usable arrived.
 *
 * **And that is not in tension with refusing to fold a BUSY lane into `unreachable`, though it
 * reads that way.** The two are different situations, and the difference is whether a call
 * happened. An abort means the model **was** contacted and nothing usable came back, which is what
 * `unreachable` says. A busy lane means the model was **never** contacted, so `unreachable` would
 * assert something false about a service that may be answering another caller perfectly.
 *
 * The reason an abort cannot be mistaken for a timeout is the race ordering stated above: the lane
 * rejects with `AiTimeoutError` **before** it aborts, so on the timeout path that rejection wins
 * and never reaches this branch. `OllamaAbortError` is therefore **not reachable through either
 * route today** - it is mapped so the function is total, not because a path is known to reach it.
 *
 * (Cross-reference added after an agent read the two paragraphs together and found them
 * contradictory. They were reconcilable and the file did not say how, which is the same defect as
 * a comment that is simply wrong.)
 */
export function outcomeForFailure(error: unknown): AiOutcome | undefined {
  if (error instanceof AiTimeoutError) {
    return 'timeout';
  }
  if (error instanceof OllamaAbortError) {
    return 'unreachable';
  }
  if (error instanceof OllamaError) {
    return OUTCOME_FOR_REASON[error.reason];
  }
  return undefined;
}
