/**
 * The Express application (TSD 5.3).
 *
 * Middleware order IS behaviour, not taste. The body limit has to precede the routes or a 65 KB
 * payload is parsed before anyone refuses it; the log line has to wrap the routes or a failed
 * request is never logged; the error handler has to be last or Express's own HTML error page
 * answers instead of the fixed JSON shape.
 *
 * No rate limiter, no helmet, no request-id header (SDD 12): this binds to localhost for one
 * user, and each of those would be defence against a threat this deployment does not have.
 *
 * `createApp` takes its config and catalog as parameters and reads no environment, so a test
 * builds a server with a two-meal catalog and never touches `process.env`.
 */

import cors from 'cors';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Catalog } from './catalog.js';
import type { ServerConfig } from './config.js';
import { ApiError, INTERNAL_ERROR_BODY, isApiError } from './errors.js';
import { consoleSink, errorLogLine, framesOf, requestLogLine } from './logging.js';
import type { LogSink } from './logging.js';
import { createAiLane } from './aiLane.js';
import { createAiProvider } from './ai/provider.js';
import type { FetchLike } from './ai/ollamaClient.js';
import { chatRouter } from './routes/chat.js';
import { mealsRouter } from './routes/meals.js';
import { recommendationsRouter } from './routes/recommendations.js';

export const JSON_BODY_LIMIT = '64kb';

/**
 * The `status` Express attaches to its own body-parser errors, read without a cast.
 *
 * `in` narrowing gives the property a type, so this needs no assertion - which matters because
 * an `as` here would be exactly the kind of unchecked claim about untrusted input that this
 * handler exists to contain.
 */
function readStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/**
 * The Expo web origins, plus the API port's own siblings. Credentials off (TSD 5.3).
 *
 * **Both spellings of every port, which `19006` was missing.** It had only the `localhost` form
 * while 8081 and the API port each had both, so an app served on `http://127.0.0.1:19006` was
 * blocked by CORS — and P13's first end-to-end run found it exactly that way: every data spec fell
 * into "Working offline" while the screen itself was correct.
 *
 * `localhost` and `127.0.0.1` are DIFFERENT origins to a browser, so one without the other is an
 * allowlist that depends on how the developer happened to type the address. Derived from one list
 * of ports now, rather than written out, so a third port cannot arrive half-covered.
 */
const WEB_PORTS = [
  /** Expo's Metro dev server. */
  8081 /** Expo web, and where `expo export`'s static build is served. */, 19006,
] as const;

function corsOrigins(config: ServerConfig): readonly string[] {
  return [config.PORT, ...WEB_PORTS].flatMap((port) => [
    `http://localhost:${String(port)}`,
    `http://127.0.0.1:${String(port)}`,
  ]);
}

/**
 * Record the prefix a router is mounted at, for the log line.
 *
 * `request.baseUrl` cannot be read when the line is written: Express sets it while dispatching
 * into a router and RESTORES it afterwards, so by the time the `finish` event fires it is `''`
 * again and a detail request logged `/:mealId` - losing the prefix, and making two different
 * endpoints indistinguishable in the log. Captured on the way in instead.
 */
function mountedAt(prefix: string) {
  return (_request: Request, response: Response, next: NextFunction): void => {
    response.locals['mountPath'] = prefix;
    next();
  };
}

/**
 * The mount prefix joined to the router-relative path.
 *
 * A collection route's own path is `'/'`, so a naive concatenation logged
 * `/api/v1/meals/` with a trailing slash the TSD does not use. Dropped here rather than in the
 * routers, because it is a property of how the two halves join.
 */
function routeTemplateOf(request: Request, response: Response): string {
  if (request.route === undefined) {
    return '(unmatched)';
  }
  const mount =
    typeof response.locals['mountPath'] === 'string' ? response.locals['mountPath'] : '';
  const relative = String(request.route.path);
  return `${mount}${relative === '/' ? '' : relative}`;
}

export interface AppOptions {
  readonly config: ServerConfig;
  readonly catalog: Catalog;
  readonly sink?: LogSink;
  readonly now?: () => Date;
  /**
   * Injected so an integration test can drive the REAL provider, client and lane without a
   * network - which is what makes such a test evidence rather than a mock (TSD 5.5's argument
   * for `AI_FAKE`, applied one layer lower).
   *
   * **The lane and the provider are deliberately NOT injectable.** `createApp` builds exactly one
   * of each, below, and that is the only reason "one AI call at a time, process-wide" holds. An
   * option to pass a second lane in would make the single-flight guarantee a convention rather
   * than a property of the code.
   */
  readonly fetchImpl?: FetchLike;
}

export interface ErrorHandlerOptions {
  readonly sink: LogSink;
  readonly now: () => Date;
}

/**
 * The last middleware, lifted out of `createApp` so its two leak-capable branches can be driven.
 *
 * **This was an anonymous inline closure, and that is why nothing tested it.** The `500` branch
 * and the `headersSent` branch are the only two places in the server where an arbitrary upstream
 * string is in scope, and the suite reached neither: `errors.test.ts` asserted
 * `INTERNAL_ERROR_BODY` as a constant and `logging.test.ts` asserted `errorLogLine` as a pure
 * function, with nothing connecting either to the code that calls them. Replacing
 * `INTERNAL_ERROR_BODY` with `String(error)` here left all 138 tests green - verbatim the defect
 * P08's phase report records as fixed.
 *
 * `headersSent` is unreachable through the routes this server mounts today (every handler
 * responds last and throws before it), so naming the handler is what makes that branch testable
 * at all. It stops being hypothetical at P21, where the chat lane writes before it can fail.
 *
 * Four parameters, because Express identifies an error handler by arity. `_next` is unused and
 * must stay declared.
 */
export function createErrorHandler(
  options: ErrorHandlerOptions,
): (error: unknown, request: Request, response: Response, next: NextFunction) => void {
  const { sink, now } = options;

  /** Name and frames only - never the message, and never `String(error)` (PRD 10.3, TSD 3.5). */
  const logUnexpected = (error: unknown): void => {
    sink(
      errorLogLine(
        {
          errorName: error instanceof Error ? error.name : typeof error,
          frames: framesOf(error),
        },
        now(),
      ),
    );
  };

  return (error: unknown, _request: Request, response: Response, _next: NextFunction): void => {
    if (response.headersSent) {
      // NOT `next(error)`: that delegates to Express's own final handler, which prints the
      // full stack - message included - to stderr, outside the sink where no test can see it.
      // The response is already committed, so the only correct action is to log safely and
      // end it. A second `response.json` here would throw ERR_HTTP_HEADERS_SENT on top of the
      // error being handled.
      logUnexpected(error);
      response.destroy();
      return;
    }
    if (isApiError(error)) {
      response.locals['errorCode'] = error.code;
      response.status(error.status).json(error.toBody());
      return;
    }
    // **Classify on the STATUS, not on the constructor.** Matching only `413` and
    // `SyntaxError`+400 left every other body-parser failure falling through to the 500 branch:
    // a `Content-Encoding: gzip` header with a non-gzip body answered
    // `500 internal_error` at log level `error`, which reports a malformed request as a server
    // fault - and any client can produce it at will. TSD 3.5 assigns a body that fails
    // validation to `invalid_request`.
    const status = readStatus(error);
    if (status !== undefined && status >= 400 && status < 500) {
      // **A malformed escape in the PATH is not a body problem.** `/api/v1/meals/%zz` reaches
      // here as a `URIError` carrying status 400, thrown by Express's own param decoder before
      // any handler runs - and answering `{ body: ['the request body could not be read'] }` sent
      // the client looking at the body of a GET that has none. `instanceof URIError` is exact
      // rather than a guess at a message: nothing else in this stack throws one.
      const clientError =
        error instanceof URIError
          ? new ApiError('invalid_request', { path: ['the request path could not be decoded'] })
          : new ApiError('invalid_request', {
              body: [
                status === 413
                  ? 'the request body is too large'
                  : 'the request body could not be read',
              ],
            });
      response.locals['errorCode'] = clientError.code;
      response.status(clientError.status).json(clientError.toBody());
      return;
    }

    // Anything else: a 500 with a FIXED message, and the error's NAME and FRAMES logged - never
    // its message, and never `String(error)`. zlib says "incorrect header check"; a future
    // `new Error(\`no match for "${question}"\`)` would say something far worse, and TSD 3.5
    // forbids upstream text in a log line as firmly as in a response body. PRD 12 says the same
    // of the body: "Stack traces and raw provider errors never reach the user."
    response.locals['errorCode'] = 'internal_error';
    logUnexpected(error);
    response.status(500).json(INTERNAL_ERROR_BODY);
  };
}

export function createApp(options: AppOptions): Express {
  const { config, catalog } = options;
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? ((): Date => new Date());

  const app = express();
  app.disable('x-powered-by');

  // 1. cors
  // Copied, not aliased: `cors` takes a mutable array, and handing it the module's own
  // readonly list would let a library write through it.
  app.use(cors({ origin: [...corsOrigins(config)], credentials: false }));

  // 2. the request log line, written on response finish so it can carry the status.
  //
  // **Registered BEFORE the body parser, which is a deliberate departure from TSD 5.3's
  // numbering.** A body-parser failure calls `next(err)`, Express then skips every remaining
  // non-error middleware, and with the logger at position 3 the `finish` listener was never
  // registered - so an oversized body, malformed JSON and a bad charset each produced a 400
  // and ZERO log lines, while TSD 5.8 and SDD 13 both promise one line per request.
  //
  // Nothing in §5.3's own rationale is weakened: the reason the cap must precede the routes is
  // that a cap applied after parsing is not a cap, and the logger is not a parser. It reads
  // nothing from the body.
  app.use((request: Request, response: Response, next: NextFunction) => {
    const startedAt = Date.now();
    response.on('finish', () => {
      sink(
        requestLogLine(
          {
            method: request.method,
            // `route` is only populated once a route has matched; an unmatched request logs
            // `(unmatched)` rather than its concrete path, which would be the user's data.
            //
            // The mount prefix is prepended because `route.path` is ROUTER-RELATIVE: under
            // the meals router a detail request reports `/:mealId`, so without it the list and
            // detail endpoints share one template. Flagged at P08 as a trap for this phase.
            routeTemplate: routeTemplateOf(request, response),
            status: response.statusCode,
            durationMs: Date.now() - startedAt,
            ...(typeof response.locals['errorCode'] === 'string'
              ? { errorCode: response.locals['errorCode'] }
              : {}),
          },
          now(),
        ),
      );
    });
    next();
  });

  // 3. body parsing, bounded
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // 4. routes.
  //
  // Mounted as routers so each contract lives in its own module, and so the 404 handler below
  // still owns every path neither of them claims.
  // **Exactly ONE lane and ONE provider, shared by both AI routes.**
  //
  // TSD 5.5 says "one AI call at a time, process-wide". `createAiLane()` is per-instance, so
  // dependency injection cannot express "process-wide" on its own - what it CAN express is that
  // every consumer shares one object, and `index.ts` creates exactly one app. That is the whole
  // of the guarantee, and it is a divergence in KIND from the document's wording rather than in
  // effect (recorded at P19).
  //
  // The property to protect is that the chat lane and the explanation lane **contend with each
  // other**: a second concurrent AI call gets `ai_busy` whichever route it arrived on. A test
  // proving two CHAT requests contend would pass with a lane per router, which is exactly the
  // bug - so the test fires a chat request and a recommendation-with-explanation together.
  const lane = createAiLane();
  const provider = createAiProvider(config, options.fetchImpl);

  app.use('/api/v1/meals', mountedAt('/api/v1/meals'), mealsRouter(catalog));
  app.use(
    '/api/v1/recommendations',
    mountedAt('/api/v1/recommendations'),
    recommendationsRouter({ catalog, config, lane, provider, sink, now }),
  );
  app.use(
    '/api/v1/chat',
    mountedAt('/api/v1/chat'),
    chatRouter({ catalog, config, lane, provider, sink, now }),
  );

  app.get('/health', (_request: Request, response: Response) => {
    // **Probes nothing.** A health check that fails because Ollama is stopped tells the
    // operator the server is down when it is serving every non-AI route perfectly (TSD 5.1
    // step 5).
    response.json({
      status: 'ok',
      catalogVersion: catalog.version,
      mealCount: catalog.meals.length,
    });
  });

  // 5. 404 - every unmatched path, with the only 404 code TSD 3.5 defines
  app.use((_request: Request, response: Response) => {
    /*
      **One branch, because the two this used to have were byte-identical (R-84).**

      It read `if (request.path.startsWith('/api/v1/meals/'))` and then built the same
      `new ApiError('meal_not_found')` the fall-through built, over a comment explaining at length
      why "the trailing slash matters: without it `/api/v1/mealsXYZ` answered `meal_not_found`,
      claiming a meal was missing on a path that names no meal at all". **Deleting the branch
      failed 0 of 2617 tests** - it was decoration, and the comment argued for a distinction the
      code had abandoned. The same shape as F-6: an explanation outliving the behaviour it
      described.

      Worth keeping the history, because the branch was not pointless when written - it was trying
      to avoid exactly the defect this handler still has.

      **What it still gets wrong, and why it is not fixed here.** `GET /` answers *"That meal could
      not be found."* on a server whose root names no meal. TSD 3.5 fixes the wire codes at
      **five** and its table maps 404 to `meal_not_found` alone, so there is no code for "that
      route does not exist" - and a sixth was tried once and reverted, because it carried no
      `retryable` while `ApiErrorBody` requires one. Inventing the code is a document amendment and
      a stop condition, so it is recorded as R-84 instead.

      **Not reachable from the app**: `routes.ts` only ever calls paths that exist, so this text
      reaches a person poking the API directly, never a user reading a screen. That is what keeps
      it a MINOR rather than a false statement in the interface.

      The meals router answers an unknown *id* itself (`meals.ts`, `throw new ApiError('meal_not_found')`),
      where the message is both true and useful. This handler is only what is left over.
    */
    const missing = new ApiError('meal_not_found');
    response.locals['errorCode'] = missing.code;
    response.status(missing.status).json(missing.toBody());
  });

  // 6. error handler, last. The same function a test mounts directly, so what the suite drives
  // is what this app installs.
  app.use(createErrorHandler({ sink, now }));

  return app;
}
