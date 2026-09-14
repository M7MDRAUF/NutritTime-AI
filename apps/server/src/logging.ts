/**
 * Request logging (PRD 10.3, TSD 5.8, Plan 15.5).
 *
 * **The citation, because this module used to carry the wrong one.** "PRD 15.5" is cited widely
 * across this phase and does not exist: PRD section 15 is "Dependencies and Assumptions" and has
 * no subsections. The requirement is PRD 10.3 - "Logs never contain prompts, questions, allergy
 * lists, or names" - and the table spelling it out is Plan 15.5, restated in TSD 5.8.
 *
 * One structured JSON line per request. **Never a prompt, a question, an answer, an allergy
 * list, a name, or a request body** - and the way that rule is kept is that this module has no
 * parameter through which any of them could arrive. A redaction step you have to remember to
 * call is a redaction step that gets forgotten; a function that cannot receive the data cannot
 * leak it.
 *
 * `routeTemplate`, never the concrete path, for the same reason: `/api/v1/meals/chicken-curry`
 * is a record the user asked about, and a log of those is a log of what someone eats.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface RequestLogFields {
  readonly method: string;
  /** The Express route template (`/api/v1/meals/:mealId`), not the concrete URL. */
  readonly routeTemplate: string;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string;
}

/**
 * Which lane an AI log line describes (TSD 5.8's `lane` field).
 *
 * **`AiLaneName`, not `AiLane`.** `aiLane.ts` exports `AiLane` for TSD 5.5's single-flight
 * interface, and two different things under one name in one package is how a route ends up
 * importing the union where it meant the lane. This one is the lane's NAME; the other one runs
 * the call. Renamed before P20 and P21 needed both in the same file and reached for an alias.
 */
export type AiLaneName = 'chat' | 'explanation';
export type AiOutcome = 'ok' | 'timeout' | 'schema' | 'contained' | 'unreachable';

export interface AiLogFields {
  readonly lane: AiLaneName;
  readonly durationMs: number;
  readonly outcome: AiOutcome;
}

/** Where a line goes. Injected so a test can read what was written without capturing stdout. */
export type LogSink = (line: string) => void;

export const consoleSink: LogSink = (line) => {
  // eslint-disable-next-line no-console
  console.log(line);
};

function levelFor(status: number): LogLevel {
  if (status >= 500) {
    return 'error';
  }
  return status >= 400 ? 'warn' : 'info';
}

/**
 * The serialised line.
 *
 * `now` is a parameter rather than a `Date.now()` call, so a test asserts an exact line instead
 * of a regex around a moving timestamp.
 */
export function requestLogLine(fields: RequestLogFields, now: Date): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: levelFor(fields.status),
    method: fields.method,
    routeTemplate: fields.routeTemplate,
    status: fields.status,
    durationMs: fields.durationMs,
    ...(fields.errorCode === undefined ? {} : { errorCode: fields.errorCode }),
  });
}

export function aiLogLine(fields: AiLogFields, now: Date): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: fields.outcome === 'ok' ? 'info' : 'warn',
    lane: fields.lane,
    durationMs: fields.durationMs,
    outcome: fields.outcome,
  });
}

export interface ErrorLogFields {
  /** The error's constructor name. A class name is ours or the platform's, never user text. */
  readonly errorName: string;
  /** Stack FRAMES only, with the message line removed. */
  readonly frames: readonly string[];
}

/**
 * An unexpected throw, serialised without its message.
 *
 * **The message is deliberately dropped.** TSD 3.5 says nothing from an upstream error text
 * reaches a response body *or a log line*, and an error message is exactly that text: zlib
 * says `incorrect header check`, and a future `new Error(\`no match for "${question}"\`)` would
 * put a question - and therefore possibly an allergy - straight into the log.
 *
 * The name and the frames are enough to find the throw; the message is what makes the line
 * unsafe. Writing `String(error)` for an unknown throw is the same hazard with no upper bound.
 */
export function errorLogLine(fields: ErrorLogFields, now: Date): string {
  return JSON.stringify({
    timestamp: now.toISOString(),
    level: 'error',
    message: 'unhandled error',
    errorName: fields.errorName,
    frames: fields.frames,
  });
}

/** Stack frames with the leading message line stripped. */
export function framesOf(error: unknown): readonly string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return [];
  }
  return error.stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .map((line) => line.trim());
}
