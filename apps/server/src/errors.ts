/**
 * The one way this server reports a failure (TSD 3.5).
 *
 * **No upstream text ever reaches a response body or a log line.** Messages are fixed local
 * strings chosen here. An upstream error string is written for whoever operates the upstream
 * service, and it can carry a hostname, a stack frame, a model name, or a fragment of the
 * request that caused it - none of which belongs in a reply to a user, and some of which would
 * breach §15.5's rule that a prompt is never logged.
 */

import { API_ERROR_RETRYABLE, API_ERROR_STATUS } from '@nutritime/contracts';
import type { ApiErrorBody, ApiErrorCode } from '@nutritime/contracts';

/** Fixed, local, user-facing. Deliberately uninformative about the cause. */
const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  invalid_request: 'The request was not valid.',
  meal_not_found: 'That meal could not be found.',
  ai_disabled: 'The assistant is turned off.',
  ai_unavailable: 'The assistant is unavailable right now.',
  ai_busy: 'The assistant is busy with another question.',
};

/**
 * Status and retryability are properties of the CODE, not of the call site.
 *
 * That is why they are looked up rather than passed: a route cannot accidentally report the
 * same condition as 400 in one place and 503 in another.
 */
export class ApiError extends Error {
  public readonly code: ApiErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;
  public readonly details?: Readonly<Record<string, readonly string[]>>;

  public constructor(code: ApiErrorCode, details?: Readonly<Record<string, readonly string[]>>) {
    super(MESSAGES[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.retryable = API_ERROR_RETRYABLE[code];
    if (details !== undefined) {
      this.details = details;
    }
  }

  public toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: MESSAGES[this.code],
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** The body for an unexpected throw: a 500 with a fixed message and no detail at all. */
export const INTERNAL_ERROR_BODY = {
  error: {
    code: 'internal_error',
    message: 'Something went wrong.',
    retryable: false,
  },
} as const;

/**
 * Fixed messages keyed by Zod issue code.
 *
 * **Zod's own message is not always safe to forward.** `unrecognized_keys` renders as
 * `Unrecognized key: "peanut"` - the submitted key, echoed verbatim into a response body and
 * therefore into anything that logs one. `invalid_value` and `invalid_format` can quote the
 * received value too. So the message is chosen here by code, and the only thing taken from the
 * issue is its PATH.
 */
const ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_type: 'wrong type',
  invalid_value: 'not one of the permitted values',
  invalid_format: 'wrong format',
  too_big: 'too large',
  too_small: 'too small',
  not_multiple_of: 'not a permitted step',
  unrecognized_keys: 'unexpected field',
  invalid_union: 'does not match any permitted shape',
  invalid_key: 'unexpected key',
  invalid_element: 'unexpected element',
  custom: 'not valid',
};

const FALLBACK_ISSUE_MESSAGE = 'not valid';

export interface IssueLike {
  readonly code?: string;
  readonly path: readonly (string | number | symbol)[];
}

/**
 * Field paths from a Zod failure, shaped for `details`.
 *
 * **Only the PATHS, and a message this module chose.** Never the submitted value. A validation
 * error that echoes what the user sent would put a question - and therefore possibly an
 * allergy - into a response body, which PRD 10.3 and TSD 3.5 both forbid.
 */
export function detailsFromIssues(
  issues: readonly IssueLike[],
): Readonly<Record<string, readonly string[]>> {
  const grouped: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.map((segment) => String(segment)).join('.') || '(root)';
    const message =
      (issue.code === undefined ? undefined : ISSUE_MESSAGES[issue.code]) ?? FALLBACK_ISSUE_MESSAGE;
    const bucket = grouped[key];
    if (bucket === undefined) {
      grouped[key] = [message];
    } else if (!bucket.includes(message)) {
      bucket.push(message);
    }
  }
  return grouped;
}
