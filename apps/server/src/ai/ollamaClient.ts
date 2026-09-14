/**
 * The one place in this server that talks to something outside it (TSD 5.5).
 *
 * Two rules shape every line below, and they both push against the naive implementation.
 *
 * **A truncated reply is not a partial success.** `done_reason: 'length'` means the model stopped
 * mid-sentence, and a sentence that stops mid-claim reads to a user as a finished assertion the
 * model never actually made.
 *
 * **Two separate mutations break two separate things here, and they took three passes to
 * separate.** Both are recorded because this docstring has been wrong twice.
 *
 * 1. **Making the check CONDITIONAL breaks the safety property.** Gate it on a parse or schema
 *    failure - the tempting tidy-up, since it reads as "only bother asking about truncation when
 *    something else went wrong" - and a truncated reply comes back `contained`. Caught by the
 *    clean-boundary fixture, which parses and validates.
 * 2. **Moving the check BELOW the parse breaks the reported reason.** The reply is still refused,
 *    so the user is still safe - but a mid-string truncation then reports `'schema'`, and TSD 5.8's
 *    `outcome` blames the model's JSON for what was really a `num_predict` ceiling. Caught by the
 *    mid-string fixture.
 *
 * So the check is unconditional AND it runs before the parse, for two different reasons, and each
 * has its own fixture. The first draft claimed position was the whole of it; the second claimed
 * position did not matter at all. Neither was true.
 *
 * What makes both mutations look harmless from the armchair is one fact: a truncated reply is
 * frequently valid JSON, because the grammar Ollama compiles from `format` closes brackets on its
 * way out. So the reply always parses, and nothing downstream has anything to object to.
 *
 * **No upstream text escapes this module.** Not into a response body, not into a log line, not
 * into an exception message. An upstream error string is written for whoever operates the
 * upstream service and can carry a hostname, a stack frame, a model name, or a fragment of the
 * request that caused it (`errors.ts`'s own docstring, PRD 12, TSD 3.5). So: never
 * `response.statusText`, never a body fragment, never `String(error)`, never `error.message`
 * from an unknown throw. Every `catch` here is bodiless for that reason, and every message this
 * module can throw is a fixed local string chosen in `FAILURE_MESSAGES` below.
 *
 * The client is **generic**. It knows nothing about chat: the caller supplies `format` and
 * `decode`, so the same client serves the chat lane and the explanation lane (CONTRACTS 7).
 * It also holds no timeout and no concurrency state - `aiLane.ts` owns both, and this module
 * only honours the signal it is handed.
 */

import type { ValueSchema } from '@nutritime/contracts';
import { GENERATION } from '../config.js';
import type { ServerConfig } from '../config.js';

/** The shape of `fetch` this client uses, so a test supplies one without touching a global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type OllamaFailureReason =
  | 'unreachable' // fetch rejected, or the socket died
  | 'http-status' // a non-2xx response
  | 'envelope' // the outer JSON did not parse, or lacked `response`
  | 'empty-reply' // `response.trim() === ''`
  | 'truncated' // `done_reason === 'length'`
  | 'schema'; // inner JSON.parse failed, or the schema rejected it

/**
 * Fixed, local, one per reason.
 *
 * A table rather than an interpolation, because an interpolated message is one edit away from
 * carrying the thing it was written to exclude. Nothing in this map is derived from a response,
 * a body, or a caught error, and `ollamaClient.test.ts` asserts that a distinctive token planted
 * in an upstream status line, body and rejection reaches none of them.
 *
 * These strings reach no user. The route answers 503 `ai_unavailable` with the copy in
 * `errors.ts`; this text exists for the server's own debugging and for TSD 5.8's `outcome`.
 */
const FAILURE_MESSAGES: Readonly<Record<OllamaFailureReason, string>> = {
  unreachable: 'The Ollama request did not reach a server.',
  'http-status': 'Ollama answered with a status outside 2xx.',
  envelope: 'Ollama returned a body that was not a generate envelope.',
  'empty-reply': 'Ollama returned an empty reply.',
  truncated: 'Ollama stopped generating before the reply was complete.',
  schema: 'The model reply did not match its schema.',
};

export class OllamaError extends Error {
  public readonly reason: OllamaFailureReason;

  public constructor(reason: OllamaFailureReason) {
    super(FAILURE_MESSAGES[reason]);
    // An `Error` subclass inherits `name: 'Error'`, so without this line TSD 5.8's AI log line -
    // whose `outcome` is derived from what was thrown - would report the wrong thing, and so
    // would any `error.name` branch at the call site.
    this.name = 'OllamaError';
    this.reason = reason;
  }
}

/**
 * The call was cancelled, and that is **not** one of the six failure reasons.
 *
 * Every member of `OllamaFailureReason` describes something the UPSTREAM did. Cancellation is
 * something the CALLER did, and there is no honest member for it - so an abort gets its own type
 * rather than being folded into `'unreachable'`. Folding it in would be a lie with a
 * consequence: TSD 5.8's `outcome` would read `unreachable` for a call that actually timed out,
 * which is exactly the mis-report `aiLane.ts` rejects-before-aborting to avoid. The union is
 * pinned by CONTRACTS 7 and may not gain a seventh member, so this is a separate class.
 *
 * **Nothing here assumes this rejection is the one the caller sees.** `aiLane.ts` rejects with
 * `AiTimeoutError` before it aborts, so on the timeout path `Promise.race` has already settled
 * and this error loses. That is fine and deliberate: this module reports what happened to IT and
 * does not try to infer why the signal was aborted.
 *
 * The message is a fixed local string and the original rejection is discarded, so a
 * cancellation cannot become the escape hatch the rest of the file closes.
 */
export class OllamaAbortError extends Error {
  public constructor() {
    super('The Ollama call was aborted by its caller.');
    this.name = 'OllamaAbortError';
  }
}

export interface OllamaGenerateRequest<T> {
  readonly prompt: string;
  /** The per-request JSON Schema. `chatFormat(ids)` on the chat lane. */
  readonly format: unknown;
  /** `chatModelReplySchema` or `explanationReplySchema`. */
  readonly decode: ValueSchema<T>;
}

export interface OllamaClient {
  generate<T>(request: OllamaGenerateRequest<T>, signal: AbortSignal): Promise<T>;
}

/**
 * Stage one of the two-stage decode: Ollama's envelope, which carries the model's JSON as a
 * *string* (TSD 5.5).
 *
 * `done_reason` is normalised to `null` when absent so the truncation check has one shape to
 * compare against. A present-but-non-string `done_reason` is an envelope failure rather than a
 * shrug: if the field this module reads to decide "was this reply finished" arrives as something
 * unexpected, the honest answer is that the body is not an envelope - not that generation
 * completed.
 */
interface GenerateEnvelope {
  readonly response: string;
  readonly doneReason: string | null;
}

/** Hand-rolled rather than Zod: a Zod issue message can quote the value that failed. */
function readEnvelope(value: unknown): GenerateEnvelope | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  if (!('response' in value)) {
    return undefined;
  }
  const response: unknown = value.response;
  if (typeof response !== 'string') {
    return undefined;
  }

  let doneReason: string | null = null;
  if ('done_reason' in value) {
    const raw: unknown = value.done_reason;
    if (typeof raw === 'string') {
      doneReason = raw;
    } else if (raw !== null && raw !== undefined) {
      return undefined;
    }
  }

  return { response, doneReason };
}

/**
 * @param fetchImpl exists so a test drives this client without a network, and for no other
 *   reason (CONTRACTS 7). Every test in `ollamaClient.test.ts` supplies one.
 */
export function createOllamaClient(
  config: ServerConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): OllamaClient {
  // `OLLAMA_BASE_URL` has already had its trailing slashes stripped by `loadConfig`, so this is
  // not re-stripped here. One owner for that rule; two would eventually disagree.
  const url = `${config.OLLAMA_BASE_URL}/api/generate`;

  async function generate<T>(request: OllamaGenerateRequest<T>, signal: AbortSignal): Promise<T> {
    /**
     * TSD 5.5's body, field for field, and **nothing else**. A `system`, `template`, `raw` or
     * `images` field creeping in would change what the model is asked without changing the
     * prompt the containment ground was built from, so the test asserts this object with a
     * `toStrictEqual` against a fully-specified expectation rather than spot-checking fields.
     *
     * `keep_alive` is `config.AI_KEEP_ALIVE` **passed through as the duration string** - not
     * parsed, not converted. Ollama reads a bare number as SECONDS, so sending a converted
     * number would recreate precisely the eviction TSD 5.2 rejects the bare form at boot to
     * prevent: the model evicted between questions, and the next question paying a ~60-second
     * cold load disguised as an ordinary timeout.
     *
     * The model is `config.OLLAMA_MODEL` and the keep-alive `config.AI_KEEP_ALIVE`. TSD 5.5's
     * snippet spells these `config.ollamaModel` and `config.aiKeepAlive` (TSD.md:1156, 1160),
     * which contradicts TSD 5.2's own configuration table and the shipped `ServerConfig`. 5.2 is
     * the section that specifies configuration, so 5.2 wins; the divergence is reported, not
     * fixed here.
     */
    const body = {
      model: config.OLLAMA_MODEL,
      prompt: request.prompt,
      stream: false,
      format: request.format,
      keep_alive: config.AI_KEEP_ALIVE,
      options: {
        num_ctx: GENERATION.numCtx,
        num_predict: GENERATION.numPredict,
        temperature: GENERATION.temperature,
        seed: GENERATION.seed,
      },
    };

    let response: Response;
    try {
      // **Exactly one call, on every path.** Plan 15.5's Retry/repair row is `none` on either
      // lane: a schema violation is a failure, not the first attempt of a repair loop. There is
      // no surrounding loop, and there is no pre-flight `signal.aborted` short-circuit either -
      // `fetch` already rejects immediately on an aborted signal and the catch below turns that
      // into the same `OllamaAbortError`, so a branch reproducing it would be code no test could
      // tell apart from its absence.
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch {
      // Bodiless. A real `fetch` rejection is `TypeError: fetch failed` over
      // `connect ECONNREFUSED 127.0.0.1:11434` - a host and a port, which is upstream detail and
      // stops here.
      throw signal.aborted ? new OllamaAbortError() : new OllamaError('unreachable');
    }

    if (!response.ok) {
      // **The body is deliberately not read.** Reading a failure body for detail is how upstream
      // text gets in, and there is nothing in it this server is allowed to use: the reason is
      // `'http-status'` regardless of what Ollama wrote. `statusText` is not read for the same
      // reason. The test asserts `response.bodyUsed` is still false afterwards.
      throw new OllamaError('http-status');
    }

    let envelopeText: string;
    try {
      envelopeText = await response.text();
    } catch {
      // The status line arrived and the body did not: the socket died mid-response, which is
      // `'unreachable'`'s second clause rather than a malformed envelope.
      throw signal.aborted ? new OllamaAbortError() : new OllamaError('unreachable');
    }

    let envelopeValue: unknown;
    try {
      // `text()` then `JSON.parse`, not `response.json()`. `json()`'s own rejection message
      // quotes the start of the body it could not parse - `Unexpected token 'x', "<html>..." is
      // not valid JSON` - so letting it escape would publish a body fragment through the one
      // channel this module is built to keep closed.
      envelopeValue = JSON.parse(envelopeText);
    } catch {
      throw new OllamaError('envelope');
    }

    const envelope = readEnvelope(envelopeValue);
    if (envelope === undefined) {
      throw new OllamaError('envelope');
    }

    if (envelope.response.trim() === '') {
      throw new OllamaError('empty-reply');
    }

    // **Unconditional AND before the parse, for two different reasons.** See the file docstring:
    // gating this on a parse or schema failure returns a truncated reply as `contained` (the
    // clean-boundary fixture catches it), and moving it below the parse still refuses the reply but
    // reports `'schema'` for a `num_predict` ceiling (the mid-string fixture catches that).
    if (envelope.doneReason === 'length') {
      throw new OllamaError('truncated');
    }

    let replyValue: unknown;
    try {
      replyValue = JSON.parse(envelope.response);
    } catch {
      throw new OllamaError('schema');
    }

    const decoded = request.decode.safeParse(replyValue);
    if (!decoded.success) {
      // No repair prompt, no second attempt. A schema violation is a failure (Plan 15.5).
      throw new OllamaError('schema');
    }
    return decoded.data;
  }

  return { generate };
}
