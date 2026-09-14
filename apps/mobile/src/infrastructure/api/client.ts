/**
 * The API client (TSD 6.5, T-12-13). **Exactly three outcomes, and no coerced success.**
 *
 * 1. the decoded value;
 * 2. an `ApiClientError` carrying the server's error envelope **verbatim** — a code this build
 *    has never heard of still arrives intact, which X-20 requires;
 * 3. a transport failure mapped to 503 unreachable / 504 timeout / 502 unreadable.
 *
 * The failure half lives in `errors.ts`, including the rule that **nothing from the wire reaches
 * a user-visible message**. The rule this file carries is the other one:
 *
 * **The caller's `AbortSignal` is forwarded to an internal controller, never passed through.**
 * `fetch` reports every abort the same way, so a cancelled screen and an expired deadline are
 * indistinguishable at the catch site unless this module records which one it fired. Handing the
 * caller's signal straight to `fetch` also means the client cannot abort at all without aborting
 * something it does not own. A cancelled request therefore raises the caller's own `AbortError`,
 * never an `ApiClientError`: cancellation is the caller's action, not a fourth outcome.
 *
 * **Nothing here logs.** The search text, the question and the preference fields all pass through
 * this file, and PRD 10.3 forbids any of them reaching a log line.
 */

import type {
  ChatResponse,
  Meal,
  MealListResponse,
  RecommendationResponse,
} from '@nutritime/contracts';
import type { ChatRequest, MealQuery, RecommendationRequest, RouteName } from './routes.js';
import {
  CHAT_PATH,
  DEFAULT_API_BASE_URL,
  RECOMMENDATIONS_PATH,
  ROUTE_TIMEOUTS_MS,
  decodeChatResponse,
  decodeMeal,
  decodeMealListResponse,
  decodeRecommendationResponse,
  mealPath,
  mealsPath,
} from './routes.js';
import {
  ApiClientError,
  cancellation,
  isApiClientError,
  readErrorEnvelope,
  transportError,
} from './errors.js';

/** TSD 6.5, verbatim. Every method takes the caller's signal; none of them takes a timeout. */
export interface ApiClient {
  listMeals(query: MealQuery, signal: AbortSignal): Promise<MealListResponse>;
  getMeal(mealId: string, signal: AbortSignal): Promise<Meal>;
  recommend(request: RecommendationRequest, signal: AbortSignal): Promise<RecommendationResponse>;
  ask(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}

/** The shape of `fetch` this client uses, so a test supplies one without touching a global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientConfig {
  /** No default is read from the environment here — see `DEFAULT_API_BASE_URL`. */
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
}

/** Named `RouteRequest` rather than `Request`: the DOM's own `Request` is a different thing. */
interface RouteRequest {
  readonly route: RouteName;
  readonly path: string;
  readonly body?: unknown;
}

/**
 * `text()` then `JSON.parse`, rather than `response.json()`.
 *
 * `json()` collapses "the body was empty" and "the body was HTML from something in the middle"
 * into one opaque rejection thrown from inside `fetch`, where it is indistinguishable from a
 * transport failure. Reading the text first keeps the two apart.
 */
function parseJson(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (text.trim() === '') {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function createApiClient(config: ApiClientConfig = {}): ApiClient {
  const baseUrl = (config.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const fetchImpl: FetchLike = config.fetch ?? ((input, init) => fetch(input, init));

  async function send<T>(
    request: RouteRequest,
    decode: (body: unknown) => T | null,
    signal: AbortSignal,
  ): Promise<T> {
    // Already cancelled before anything started. Answering with the caller's own abort — rather
    // than firing a request nobody is waiting for — is both cheaper and more honest.
    if (signal.aborted) {
      throw cancellation(signal);
    }

    const controller = new AbortController();
    // Which of the two aborts fired, recorded HERE because `fetch` cannot tell the catch site.
    let firedBy: 'caller' | 'timeout' | null = null;

    const onCallerAbort = (): void => {
      firedBy = 'caller';
      controller.abort();
    };
    signal.addEventListener('abort', onCallerAbort);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      firedBy = 'timeout';
      controller.abort();
    }, ROUTE_TIMEOUTS_MS[request.route]);

    try {
      const post = request.body !== undefined;
      const response = await fetchImpl(`${baseUrl}${request.path}`, {
        method: post ? 'POST' : 'GET',
        // Deliberately nothing else. A custom header would make every GET preflighted.
        headers: post
          ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
        ...(post ? { body: JSON.stringify(request.body) } : {}),
        signal: controller.signal,
      });

      // The deadline covers the body too: headers can arrive promptly and the stream then hang.
      const parsed = parseJson(await response.text());

      if (!response.ok) {
        const wire = parsed.ok ? readErrorEnvelope(parsed.value) : null;
        if (wire === null) {
          // An error status whose body is not an envelope. The STATUS is preserved rather than
          // flattened to 502: it is the one piece of diagnosis that did arrive, and TSD 6.5's
          // 502 describes a transport failure, which this is not.
          throw new ApiClientError({
            kind: 'unreadable',
            status: response.status,
            code: null,
            retryable: response.status >= 500,
            wire: null,
            route: request.route,
          });
        }
        throw new ApiClientError({
          kind: 'server',
          status: response.status,
          code: wire.code,
          retryable: wire.retryable,
          wire,
          route: request.route,
        });
      }

      const decoded = parsed.ok ? decode(parsed.value) : null;
      if (decoded === null) {
        // **No coerced success.** A 200 whose body does not decode is a failure, not a partial
        // value a screen has to guess about.
        throw transportError(request.route, 'unreadable');
      }
      return decoded;
    } catch (cause: unknown) {
      // Already classified above — rethrown untouched, or the mapping below would relabel a
      // clean 404 as a network failure.
      if (isApiClientError(cause)) {
        throw cause;
      }
      if (firedBy === 'caller') {
        throw cancellation(signal);
      }
      if (firedBy === 'timeout') {
        throw transportError(request.route, 'timeout');
      }
      // Anything else `fetch` rejects with: DNS, refused connection, TLS, a dropped socket. The
      // cause is not inspected and not attached — its message is written for whoever operates
      // the network, not for the person holding the phone.
      throw transportError(request.route, 'unreachable');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onCallerAbort);
    }
  }

  return {
    listMeals(query: MealQuery, signal: AbortSignal): Promise<MealListResponse> {
      return send({ route: 'listMeals', path: mealsPath(query) }, decodeMealListResponse, signal);
    },

    getMeal(mealId: string, signal: AbortSignal): Promise<Meal> {
      return send({ route: 'getMeal', path: mealPath(mealId) }, decodeMeal, signal);
    },

    recommend(
      request: RecommendationRequest,
      signal: AbortSignal,
    ): Promise<RecommendationResponse> {
      return send(
        { route: 'recommend', path: RECOMMENDATIONS_PATH, body: request },
        decodeRecommendationResponse,
        signal,
      );
    },

    /**
     * `POST /api/v1/chat` is served from P21 (TSD 5.4 declares it; `apps/server` mounts the meals
     * and recommendations routers today). Until then this method reaches a path the server does
     * not claim and gets the plain 404 body, which arrives as `kind: 'unreadable'` with the status
     * intact — not a crash, and not a coerced success.
     */
    ask(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse> {
      return send({ route: 'ask', path: CHAT_PATH, body: request }, decodeChatResponse, signal);
    },
  };
}
