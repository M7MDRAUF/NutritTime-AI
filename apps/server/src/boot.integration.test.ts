import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';
import type { Request, Response } from 'express';
import { seededCatalog } from '@nutritime/catalog';
import type { Meal } from '@nutritime/contracts';
import { createApp, createErrorHandler } from './app.js';
import { buildCatalog } from './catalog.js';
import type { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { INTERNAL_ERROR_BODY } from './errors.js';

/**
 * T-08-09: the three boot behaviours, plus the route and middleware contracts of TSD 5.3.
 *
 * The exit-code cases genuinely need a child process. A test that only asserts `loadConfig`
 * throws proves the validator works; it does not prove the PROCESS refuses to start, and the
 * whole point of TSD 5.1 is that a misconfigured server must not come up looking healthy.
 */

const SERVER_ENTRY = path.resolve(import.meta.dirname, 'index.ts');
const CATALOG_FIXTURE_ENTRY = path.resolve(
  import.meta.dirname,
  '__fixtures__',
  'bootBadCatalog.ts',
);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

interface BootResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Boot a real entry point with a given environment and report how it exited.
 *
 * `process.env` is spread in deliberately - a child process must inherit an ambient
 * environment to be a realistic boot. It is the second reader of `process.env` in this package,
 * against T-08-02's "exactly one file"; recorded rather than hidden, because the alternative is
 * a child that cannot find `tsx`. Every case below sets the variables it depends on explicitly
 * so an inherited `.env` cannot decide the outcome.
 */
function bootEntry(
  entry: string,
  env: Record<string, string>,
  args: readonly string[] = [],
): BootResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 60000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const boot = (env: Record<string, string>): BootResult => bootEntry(SERVER_ENTRY, env);

/** A free localhost port, so a boot case cannot collide with a developer's own server. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

const app = createApp({
  config: loadConfig({}),
  catalog: buildCatalog(seededCatalog),
  // Discard log lines: this suite asserts responses, and `logging.test.ts` owns the format.
  sink: () => undefined,
});

describe('GET /health', () => {
  it('returns 200 with the catalog identity', async () => {
    const response = await request(app).get('/health').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      status: 'ok',
      catalogVersion: '1.0.0',
      mealCount: 60,
    });
  });

  it('probes no dependency, so Ollama being stopped cannot affect it', async () => {
    // Pointed at a port nothing is listening on. If health probed the model this would fail;
    // TSD 5.1 step 5 says an outage degrades a feature and must not block startup.
    const isolated = createApp({
      config: loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:1' }),
      catalog: buildCatalog(seededCatalog),
      sink: () => undefined,
    });
    const response = await request(isolated).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});

describe('middleware contracts', () => {
  it('rejects a body over the 64 kb limit as invalid_request', async () => {
    const oversized = { note: 'x'.repeat(65 * 1024) };
    const response = await request(app)
      .post('/api/v1/meals')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(oversized));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(response.body.error.retryable).toBe(false);
  });

  it('accepts a body under the limit', async () => {
    // Under the limit it reaches the 404 handler rather than the body-size branch, which is
    // how we know the limit is what rejected the case above.
    const response = await request(app)
      .post('/api/v1/meals')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ note: 'x'.repeat(1024) }));
    expect(response.status).toBe(404);
  });

  it('answers an unknown meals path with the meal_not_found shape', async () => {
    const response = await request(app).get('/api/v1/meals/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('meal_not_found');
  });

  it('answers an unknown path with a DECLARED error code, not a sixth one', async () => {
    // This branch used to emit `not_found`, which is not among TSD 3.5's five codes and carried
    // no `retryable` although `ApiErrorBody` requires one - so the path every unmatched request
    // lands on answered with a shape the client cannot parse.
    const response = await request(app).get('/nope');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('meal_not_found');
    expect(response.body.error.retryable).toBe(false);
    expect(typeof response.body.error.message).toBe('string');
  });

  it('sets cors headers for an allowed origin and omits credentials', async () => {
    const response = await request(app).get('/health').set('Origin', 'http://localhost:8081');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows BOTH spellings of every port it allows at all', async () => {
    /**
     * **`localhost` and `127.0.0.1` are different origins to a browser**, so an allowlist carrying
     * one without the other depends on how the developer happened to type the address.
     *
     * `19006` had only the `localhost` form, and P13's first end-to-end run found it the hard way:
     * the web export served on `http://127.0.0.1:19006` was CORS-blocked, so every data spec fell
     * into "Working offline" while the screen itself was perfectly correct. Enumerated as pairs
     * here, because that is the property — not "19006 works", which the old single assertion on
     * 8081 could not have told anyone about.
     */
    for (const port of [4000, 8081, 19006]) {
      for (const host of ['localhost', '127.0.0.1']) {
        const origin = `http://${host}:${String(port)}`;
        const response = await request(app).get('/health').set('Origin', origin);
        expect(
          response.headers['access-control-allow-origin'],
          `${origin} must be allowed - a browser blocks the request when this header is absent`,
        ).toBe(origin);
      }
    }
  });

  it('still refuses an origin that is not on the list', async () => {
    // The pair rule above must not have widened into "anything on the loopback".
    const response = await request(app).get('/health').set('Origin', 'http://127.0.0.1:4173');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never advertises the framework', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('reports malformed JSON as invalid_request, not as a 500', async () => {
    const response = await request(app)
      .post('/api/v1/meals')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });
});

describe('no response body carries upstream text', () => {
  it('keeps error messages to the fixed local strings', async () => {
    const responses = await Promise.all([
      request(app).get('/api/v1/meals/nope'),
      request(app).get('/nope'),
      request(app).post('/api/v1/meals').set('Content-Type', 'application/json').send('{"broken":'),
    ]);
    for (const response of responses) {
      const body = JSON.stringify(response.body);
      // A stack frame, a file path, an Express internal or a JSON parser's own complaint are
      // all written for whoever operates the server, not for whoever called it.
      expect(body).not.toMatch(/node_modules|at Object\.|SyntaxError|ECONNREFUSED|\bat \w+:\d+/);
    }
  });
});

describe('boot refuses rather than starting wrong', () => {
  it('exits non-zero for AI_KEEP_ALIVE=30 and says what 30 means', () => {
    const { status, stderr } = boot({ AI_KEEP_ALIVE: '30', PORT: '4117' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('AI_KEEP_ALIVE');
    expect(stderr).toContain('30m');
  });

  it('exits non-zero for a port outside the range', () => {
    const { status, stderr } = boot({ PORT: '70000' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('PORT');
  });

  it('exits non-zero for an unreadable boolean', () => {
    const { status, stderr } = boot({ AI_ENABLED: 'maybe', PORT: '4118' });
    expect(status).not.toBe(0);
    expect(stderr).toContain('AI_ENABLED');
  });
});

describe('an invalid catalog stops the process', () => {
  /**
   * T-08-09's third boot behaviour, asserted at the PROCESS level.
   *
   * The previous version of this block called `buildCatalog` in-process and said so in a
   * comment - which proves the validator works and says nothing about whether the process
   * refuses to start. T-08-09, its acceptance row, Plan section 19.4 and TSD section 8.3 all
   * ask for the exit code. It boots the real `bootstrap()` over a fixture rather than
   * corrupting committed data.
   */
  // The fixture shape travels as an ARGUMENT, not as an environment variable: the fixture used
  // to read `process.env['CATALOG_FIXTURE']`, which made it a third, unregistered reader of the
  // environment inside `apps/server` against T-08-02's "exactly one file".
  const bootFixture = (fixture: string, port: number): BootResult =>
    bootEntry(CATALOG_FIXTURE_ENTRY, { PORT: String(port) }, [fixture]);

  it('exits non-zero naming the record index and the field path', async () => {
    const { status, stderr } = bootFixture('field', await freePort());
    expect(status).not.toBe(0);
    expect(stderr).toContain('record 1');
    expect(stderr).toContain('preparationMinutes');
    expect(stderr).not.toContain('listening');
  });

  it.each([
    ['empty', /empty/],
    ['not-array', /did not parse as an array/],
    ['duplicate', /duplicate meal id/],
    ['mixed-version', /mixed catalogVersion/],
    ['superrefine', /wholly known or wholly null/],
  ] as const)('exits non-zero for the %s catalog', async (fixture, expected) => {
    const { status, stderr } = bootFixture(fixture, await freePort());
    expect(status).not.toBe(0);
    expect(stderr).toMatch(expected);
  });

  it('exits non-zero for an allergen tag outside the canonical taxonomy', async () => {
    /**
     * **R-16, re-asserted at boot and not only at seed time.** `mealSchema` types
     * `allergenTags` as `z.array(z.string())`, so `treenut` validates, passes the superRefine,
     * and then resolves to no canonical allergen at all - a meal that should be rejected for a
     * declared tree-nut allergy is offered instead, and the failure is silent.
     *
     * The seed script's check is seed-time and covers only the hand-authored additions. The
     * committed file is what this server serves, and it can be edited without the seed ever
     * running again, so the refusal has to happen where the data is loaded.
     */
    const { status, stderr } = bootFixture('allergen-tag', await freePort());
    expect(status).not.toBe(0);
    expect(stderr).toContain('record 1');
    expect(stderr).toContain('allergenTags');
    // The tag itself, because the whole failure mode is that it looks like a real allergen.
    expect(stderr).toContain('treenut');
    expect(stderr).not.toContain('listening');
  });

  it('never echoes a record’s own content, only its index and path', async () => {
    const { stderr } = bootFixture('field', await freePort());
    // A meal name is data about what the user can eat. The index and the path are what an
    // operator needs; the record itself is not.
    expect(stderr).not.toContain('English Breakfast');
    expect(stderr).not.toContain('Sausages');
  });
});

describe('the listening socket', () => {
  it('binds 127.0.0.1, and records the host it bound', async () => {
    // TSD 2.1 drops helmet and express-rate-limit because "the server binds to localhost for
    // one user", SDD 12 opens on the same premise, and PRD 10.3 promises the user their
    // question goes "only to a server on the same machine". Passing no host binds 0.0.0.0 and
    // removes the control those three documents rely on - which is what it did.
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the server never announced itself')),
          30000,
        );
        child.stdout.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (text.includes('listening')) {
            clearTimeout(timer);
            resolve(text);
          }
        });
        child.on('error', reject);
      });
      expect(line).toContain('"host":"127.0.0.1"');
      expect(line).toContain(`"port":${String(port)}`);

      // And it really is reachable on loopback rather than merely claiming to be.
      await new Promise<void>((resolve, reject) => {
        const probe = connect(port, '127.0.0.1');
        probe.on('connect', () => {
          probe.destroy();
          resolve();
        });
        probe.on('error', reject);
      });
    } finally {
      child.kill();
    }
  });

  it('exits non-zero when the port is already taken', async () => {
    // The defect this pins: Node reports this as an `error` EVENT, not a throw, and with no
    // listener the process printed `"listening"`, kept running, and then exited ZERO while
    // another process answered every request on that port. The only signal an operator got was
    // a lie.
    //
    // Asserted on the exit code and the reason, which are the guarantees. On Windows the
    // `listening` callback fires before the late EADDRINUSE, so a success line can still appear
    // before the refusal; that ordering is the platform's and not something this code can
    // prevent without a second round trip. The refusal itself is deterministic.
    const port = await freePort();
    const squatter = createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      const { status, stderr } = boot({ PORT: String(port) });
      expect(status).not.toBe(0);
      expect(stderr).toContain('already in use');
      expect(stderr).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('the log lines the server actually writes', () => {
  /**
   * **Nothing in the suite observed a real log line before this.** Every case passed
   * `sink: () => undefined`, and `logging.test.ts` exercises only the pure serialiser - so two
   * MAJOR defects lived here unseen: a body-parser failure produced ZERO lines, and the 500
   * line carried zlib's own message.
   */
  const withCapture = (): { lines: string[]; app: ReturnType<typeof createApp> } => {
    const lines: string[] = [];
    return {
      lines,
      app: createApp({
        config: loadConfig({}),
        catalog: buildCatalog(seededCatalog),
        sink: (line) => lines.push(line),
        now: () => new Date('2026-09-13T10:20:30.400Z'),
      }),
    };
  };

  it('writes exactly one line for a served request', async () => {
    const { lines, app: captured } = withCapture();
    await request(captured).get('/health');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toStrictEqual({
      timestamp: '2026-09-13T10:20:30.400Z',
      level: 'info',
      method: 'GET',
      routeTemplate: '/health',
      status: 200,
      durationMs: expect.any(Number),
    });
  });

  it('writes exactly one line for a REJECTED BODY, which used to write none', async () => {
    // The defect: `express.json` was mounted before the logger, so a body-parser failure called
    // `next(err)`, Express skipped every remaining non-error middleware, the `finish` listener
    // was never registered, and an oversized body produced a 400 with no log line at all -
    // while TSD 5.8 and SDD 13 both promise one line per request.
    for (const body of ['{"broken":', JSON.stringify({ note: 'x'.repeat(65 * 1024) })]) {
      const { lines, app: captured } = withCapture();
      await request(captured)
        .post('/api/v1/meals')
        .set('Content-Type', 'application/json')
        .send(body);
      expect(lines).toHaveLength(1);
      const parsed: unknown = JSON.parse(lines[0] ?? '{}');
      expect(parsed).toMatchObject({ status: 400, errorCode: 'invalid_request', level: 'warn' });
    }
  });

  it('never writes the concrete path, only the route template', async () => {
    const { lines, app: captured } = withCapture();
    await request(captured).get('/api/v1/meals/chicken-curry?note=allergic-to-peanuts');
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    // A meal id is a record of what someone asked to eat; a query string can be anything.
    expect(line).not.toContain('chicken-curry');
    expect(line).not.toContain('peanuts');
    // Since P09 this path MATCHES the detail route, so the template is the parameterised one
    // rather than `(unmatched)`. That is the point of logging a template: the same line shape
    // whichever meal was asked for.
    expect(line).toContain('"routeTemplate":"/api/v1/meals/:mealId"');
  });

  it('still writes (unmatched) for a path no route claims', async () => {
    const { lines, app: captured } = withCapture();
    await request(captured).get('/nothing/here?secret=peanut');
    expect(lines[0] ?? '').toContain('"routeTemplate":"(unmatched)"');
    expect(lines[0] ?? '').not.toContain('peanut');
  });

  it('reports a malformed content-encoding as a client error, not a server fault', async () => {
    // Matching only 413 and SyntaxError+400 left every other body-parser failure falling to the
    // 500 branch, so any client could make the server report its own fault at log level error.
    const { lines, app: captured } = withCapture();
    const response = await request(captured)
      .post('/api/v1/meals')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('not-gzip-at-all');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
    expect(lines.join('\n')).not.toContain('incorrect header check');
  });

  it('omits an allow-origin header for a disallowed origin', async () => {
    const { app: captured } = withCapture();
    const response = await request(captured)
      .get('/health')
      .set('Origin', 'http://evil.example.com');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('an UNEXPECTED throw, driven through the app rather than asserted as a constant', () => {
  /**
   * **T-08-06's and T-08-08's one leak-capable path, which no test drove.**
   *
   * `errors.test.ts` asserted `INTERNAL_ERROR_BODY` as a value and `logging.test.ts` asserted
   * `errorLogLine` as a pure function; nothing connected either to `app.ts`. Replacing
   * `INTERNAL_ERROR_BODY` at the 500 branch with `String(error)`, and `errorLogLine(...)` with
   * `String(error)`, left the whole suite green - which is verbatim the defect P08's phase
   * report records as fixed. The `Content-Encoding: gzip` case above names the 500 branch but is
   * deliberately reclassified to 400, so its `not.toContain('incorrect header check')` passes
   * with no 500 line to inspect at all.
   *
   * PRD 12 is the authority for the body ("Stack traces and raw provider errors never reach the
   * user") and PRD 10.3 for the line ("Logs never contain prompts, questions, allergy lists, or
   * names"). Neither is PRD 15.5, which does not exist - PRD section 15 is "Dependencies and
   * Assumptions" and has no subsections. The redaction TABLE is Plan 15.5 and TSD 5.8.
   */
  const AT = new Date('2026-09-13T10:20:30.400Z');

  /**
   * What a real throw will carry once there is a route that can compose one (P21's chat lane).
   * Every fragment of this string is asserted absent from both the body and the log.
   */
  const UPSTREAM = 'no match for "does the korma contain peanuts?" - Jane Doe is allergic';
  const LEAKS = ['peanut', 'korma', 'Jane', 'allergic', 'no match for'] as const;

  /**
   * The real catalog with the one read the list route makes turned into a throw.
   *
   * A genuine non-`ApiError` from inside a real route handler, through the real middleware
   * stack - not a hand-called error handler. `byId` and `version` stay real so nothing else
   * about the app changes.
   */
  function explodingCatalog(): Catalog {
    const real = buildCatalog(seededCatalog);
    return {
      get meals(): readonly Meal[] {
        throw new Error(UPSTREAM);
      },
      byId: real.byId,
      version: real.version,
    };
  }

  function appThatThrows(): { lines: string[]; app: ReturnType<typeof createApp> } {
    const lines: string[] = [];
    return {
      lines,
      app: createApp({
        config: loadConfig({}),
        catalog: explodingCatalog(),
        sink: (line) => lines.push(line),
        now: () => AT,
      }),
    };
  }

  it('answers the FIXED local body, carrying no part of the thrown text', async () => {
    const { app: captured } = appThatThrows();
    const response = await request(captured).get('/api/v1/meals');

    expect(response.status).toBe(500);
    expect(response.body).toStrictEqual(INTERNAL_ERROR_BODY);
    // `toStrictEqual` alone would still pass if an extra key were added; the raw text is what
    // proves no fragment of the message survived anywhere in the payload.
    for (const leak of LEAKS) {
      expect(response.text, `the 500 body must not carry "${leak}"`).not.toContain(leak);
    }
  });

  it('logs the throw by NAME and FRAMES, never its message', async () => {
    const { lines, app: captured } = appThatThrows();
    await request(captured).get('/api/v1/meals');

    // Two lines: the error line the handler writes, then the request line on finish.
    expect(lines).toHaveLength(2);
    const joined = lines.join('\n');
    for (const leak of LEAKS) {
      expect(joined, `no log line may carry "${leak}"`).not.toContain(leak);
    }

    const errorLine = lines[0] ?? '';
    expect(errorLine).toContain('"message":"unhandled error"');
    expect(errorLine).toContain('"errorName":"Error"');
    expect(errorLine).toContain('"level":"error"');
    // Frames are what locate the throw, and they are the part that must survive.
    expect(errorLine).toMatch(/"frames":\["at /);

    const requestLine = lines[1] ?? '';
    expect(JSON.parse(requestLine)).toMatchObject({
      level: 'error',
      status: 500,
      errorCode: 'internal_error',
      routeTemplate: '/api/v1/meals',
    });
  });

  it('does not answer a SECOND time when the response is already committed', async () => {
    /**
     * The `headersSent` branch. No route this server mounts can reach it today - every handler
     * responds last and fails before it - which is exactly why the handler is a named export
     * rather than an anonymous closure: this is the same function `createApp` installs, mounted
     * behind a route that writes and then fails, which is what P21's streaming chat lane will
     * be.
     *
     * A second `response.json` here would throw `ERR_HTTP_HEADERS_SENT` on top of the error
     * being handled, and delegating to `next(error)` would print the full stack - message
     * included - to stderr, outside the sink where no test can see it.
     */
    const lines: string[] = [];
    // The committed `Response` itself, kept so the assertions can read what the handler did to
    // it. The wire cannot tell the two branches apart: `res.end()` on an already-ended response
    // does not throw and does not reach the client, so a test that only reads `response.text`
    // stays green with the `headersSent` guard deleted - which is how this branch stayed
    // untested in the first place.
    let committed: Response | undefined;
    const probe = express();
    probe.get('/committed', (_request: Request, response: Response) => {
      committed = response;
      response.status(200).json({ ok: true });
      throw new Error(UPSTREAM);
    });
    probe.use(createErrorHandler({ sink: (line) => lines.push(line), now: () => AT }));

    const response = await request(probe).get('/committed');

    expect(response.status).toBe(200);
    // Byte-exact: a 500 body appended after the committed one would show up here.
    expect(response.text).toBe('{"ok":true}');
    // The branch RETURNS before the 500 path, so the 500 path's stamp never happened: no
    // `errorCode` on a response that already carries its own status. This is the assertion that
    // fails when the `headersSent` guard is removed - `response.text` alone does not, because
    // `res.end()` on an ended response neither throws nor reaches the client.
    //
    // `response.destroy()` is deliberately NOT asserted: superagent closes the connection at the
    // end of the request either way, so `destroyed` is true whether the handler called it or
    // not, and an assertion no production change can break is decoration.
    expect(committed?.locals['errorCode']).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0] ?? '').toContain('"message":"unhandled error"');
    expect(lines[0] ?? '').toContain('"errorName":"Error"');
    for (const leak of LEAKS) {
      expect(lines[0] ?? '', `the committed-response log must not carry "${leak}"`).not.toContain(
        leak,
      );
    }
  });
});
