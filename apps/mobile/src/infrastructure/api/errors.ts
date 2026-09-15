/**
 * How this client reports a failure (TSD 6.5) — the error type, the four fixed local messages,
 * and the reader for the server's own error envelope.
 *
 * **Nothing from the wire reaches a user-visible message.** `ApiClientError.message` is one of the
 * four strings chosen below; the diagnosis lives in `status` and `code`. The server already
 * guarantees its own messages are fixed local strings (`apps/server/src/errors.ts`), and the point
 * of this file is that the client does not start forwarding them anyway — the day one of those
 * messages quotes an upstream detail is the day it appears in a screenshot.
 *
 * **Nothing here logs.** The search text, the question and the preference fields all pass through
 * this module's caller, and PRD 10.3 forbids any of them reaching a log line.
 */

import type { RouteName } from './routes.js';

export type ApiClientFailureKind = 'server' | 'unreachable' | 'timeout' | 'unreadable';

/**
 * **Fixed. Local. And a user sees NONE of them — the count is zero, not four.**
 *
 * The previous sentence here read *"the only strings a user ever sees from this client"*, and it is
 * **retracted**: it was false in the safe direction, which is the direction that invites a reader to
 * treat these as product copy and improve them. Measured over the tree rather than asserted —
 * `grep -rn "API_CLIENT_MESSAGES" apps/ e2e/ packages/` returns this declaration, the
 * `ApiClientError` constructor below, and **test files only**; and every production consumer of the
 * error reads `kind`, `status`, `code` or `retryable` and never `.message`
 * (`useMealSearch.ts`, `useRecommendations.ts`, `useMealDetails.ts`, `favoritesFeed.ts`,
 * `useAssistant.ts`, whose `failureFor` docblock states the rule outright: *"Nothing from
 * `error.message` or `error.wire` is ever rendered"*). `MealDetails.dom.test.tsx` pins the design in
 * the same words — *"`API_CLIENT_MESSAGES` phrases are deliberately not reused as screen copy"*.
 *
 * So what these four are is the value of `ApiClientError.message`: a **diagnostic**, deliberately
 * uninformative about the cause, in the same spirit as the server's own table. Every screen keys its
 * own copy off `code` and `status` — PRD 12 requires each screen to say what still works, which is
 * a sentence only the screen knows, and that is why none of these four is ever rendered.
 *
 * **Not to be reconciled with `WireErrorEnvelope.message`'s *"Never render this"* below — they are
 * two different strings and neither docstring contradicts the other.** These four are local and
 * chosen here; that one is the server's own text arriving over the wire and reachable only as
 * `ApiClientError.wire.message`. The P28 hygiene audit recorded them as a self-contradiction in one
 * file on the premise that both docstrings describe these four; they do not. Recorded so the next
 * reader does not "fix" the disagreement by weakening the true half.
 */
export const API_CLIENT_MESSAGES: Readonly<Record<ApiClientFailureKind, string>> = {
  server: 'The request could not be completed.',
  unreachable: 'The server could not be reached.',
  timeout: 'The request took too long.',
  unreadable: 'The response could not be read.',
};

/** TSD 6.5's transport mapping: 503 unreachable / 504 timeout / 502 unreadable. */
/**
 * **`kind` does not determine `status`, and `unreadable` is where that bites.**
 *
 * An error RESPONSE whose body is not an envelope keeps the wire status - a 404 stays 404 - while
 * an undecodable 200 gets the value below. Both are deliberate: the first preserves the only true
 * fact the server gave, and the second has no status worth reporting. The consequence is that a
 * screen keying on `kind` alone will see more than one status under `unreadable`, so this table is
 * a DEFAULT rather than an invariant.
 */
export const TRANSPORT_STATUS: Readonly<Record<'unreachable' | 'timeout' | 'unreadable', number>> =
  {
    unreachable: 503,
    timeout: 504,
    unreadable: 502,
  };

/**
 * The server's error body, exactly as it arrived.
 *
 * `code` is `string`, not `ApiErrorCode`: parsing it against the five-code union would turn the
 * server's own 500 body into an unreadable response, because `internal_error` is a sixth code the
 * union does not name (X-20). An unknown code arrives intact and a screen that does not recognise
 * it falls back to its generic copy.
 */
export interface WireErrorEnvelope {
  readonly code: string;
  /** **Diagnostic only. Never render this.** See the module comment. */
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, readonly string[]>>;
}

export interface ApiClientErrorInit {
  readonly kind: ApiClientFailureKind;
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;
  readonly wire: WireErrorEnvelope | null;
  readonly route: RouteName;
}

export class ApiClientError extends Error {
  public readonly kind: ApiClientFailureKind;
  public readonly status: number;
  public readonly code: string | null;
  public readonly retryable: boolean;
  public readonly wire: WireErrorEnvelope | null;
  public readonly route: RouteName;

  public constructor(init: ApiClientErrorInit) {
    super(API_CLIENT_MESSAGES[init.kind]);
    this.name = 'ApiClientError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.wire = init.wire;
    this.route = init.route;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

export function transportError(
  route: RouteName,
  kind: 'unreachable' | 'timeout' | 'unreadable',
): ApiClientError {
  return new ApiClientError({
    kind,
    status: TRANSPORT_STATUS[kind],
    code: null,
    // A timed-out or unreachable request may well succeed later; a response this build cannot
    // read will not become readable by asking again.
    retryable: kind !== 'unreadable',
    wire: null,
    route,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDetails(value: unknown): Readonly<Record<string, readonly string[]>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const details: Record<string, readonly string[]> = {};
  for (const [field, messages] of Object.entries(value)) {
    if (!Array.isArray(messages)) {
      return null;
    }
    const items: readonly unknown[] = messages;
    const texts: string[] = [];
    for (const item of items) {
      if (typeof item !== 'string') {
        return null;
      }
      texts.push(item);
    }
    details[field] = texts;
  }
  return details;
}

/**
 * Read `{ error: { code, message, retryable, details? } }`, or answer `null`.
 *
 * Malformed `details` do not sink the envelope: the code and the retry flag are what a screen
 * acts on, and losing them because a field-path map was the wrong shape would turn a clean 400
 * into an unreadable response.
 */
export function readErrorEnvelope(body: unknown): WireErrorEnvelope | null {
  if (!isRecord(body) || !isRecord(body['error'])) {
    return null;
  }
  const error = body['error'];
  const code = error['code'];
  const message = error['message'];
  const retryable = error['retryable'];
  if (typeof code !== 'string' || typeof message !== 'string' || typeof retryable !== 'boolean') {
    return null;
  }
  if (error['details'] === undefined) {
    return { code, message, retryable };
  }
  const details = readDetails(error['details']);
  return details === null ? { code, message, retryable } : { code, message, retryable, details };
}

/**
 * The error a cancelled request raises.
 *
 * The caller's own reason when it gave one, so `controller.abort(new Superseded())` survives the
 * round trip. `signal.reason` is a `DOMException` in the no-argument case, which is an `Error` in
 * some runtimes and not in others — hence the fallback rather than a cast.
 */
export function cancellation(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('The request was cancelled.');
  error.name = 'AbortError';
  return error;
}
