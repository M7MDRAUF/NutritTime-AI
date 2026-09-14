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
  app.use('/api/v1/meals', mountedAt('/api/v1/meals'), mealsRouter(catalog));
  app.use(
    '/api/v1/recommendations',
    mountedAt('/api/v1/recommendations'),
    recommendationsRouter(catalog, config),
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

  // 5. 404 - the `meal_not_found` shape under the meals route, a plain 404 elsewhere
  app.use((request: Request, response: Response) => {
    // The trailing slash matters: without it `/api/v1/mealsXYZ` answered `meal_not_found`,
    // claiming a meal was missing on a path that names no meal at all.
    if (request.path.startsWith('/api/v1/meals/')) {
      const error = new ApiError('meal_not_found');
      response.locals['errorCode'] = error.code;
      response.status(error.status).json(error.toBody());
      return;
    }
    // `not_found` was a SIXTH wire code, and it carried no `retryable` although
    // `ApiErrorBody` requires one - so the branch every unmatched path lands on, including the
    // not-yet-built chat route, answered with a shape the client cannot parse. TSD 3.5 has five
    // codes; `meal_not_found` is the one that describes "the thing you asked for is not here".
    const missing = new ApiError('meal_not_found');
    response.locals['errorCode'] = missing.code;
    response.status(missing.status).json(missing.toBody());
  });

  // 6. error handler, last
  // Four parameters, because Express identifies an error handler by arity. `_next` is unused
  // and must stay declared.
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) {
      // NOT `next(error)`: that delegates to Express's own final handler, which prints the
      // full stack - message included - to stderr, outside the sink where no test can see it.
      // The response is already committed, so the only correct action is to log safely and
      // end it.
      sink(
        errorLogLine(
          {
            errorName: error instanceof Error ? error.name : typeof error,
            frames: framesOf(error),
          },
          now(),
        ),
      );
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
    // forbids upstream text in a log line as firmly as in a response body.
    response.locals['errorCode'] = 'internal_error';
    sink(
      errorLogLine(
        {
          errorName: error instanceof Error ? error.name : typeof error,
          frames: framesOf(error),
        },
        now(),
      ),
    );
    response.status(500).json(INTERNAL_ERROR_BODY);
  });

  return app;
}
