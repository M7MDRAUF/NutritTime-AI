/** The complete error taxonomy (TSD 3.5). Five codes, no more. */
export const API_ERROR_CODES = [
  'invalid_request',
  'meal_not_found',
  'ai_disabled',
  'ai_unavailable',
  'ai_busy',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, readonly string[]>>;
  };
}

/** Status and retryability are properties of the code, not of the call site. */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  meal_not_found: 404,
  ai_disabled: 503,
  ai_unavailable: 503,
  ai_busy: 503,
};

export const API_ERROR_RETRYABLE: Readonly<Record<ApiErrorCode, boolean>> = {
  invalid_request: false,
  meal_not_found: false,
  ai_disabled: false,
  ai_unavailable: true,
  ai_busy: true,
};
