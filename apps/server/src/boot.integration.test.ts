import { spawn, spawnSync } from 'node:child_process';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import { createApp } from './app.js';
import { buildCatalog } from './catalog.js';
import { loadConfig } from './config.js';

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
function bootEntry(entry: string, env: Record<string, string>): BootResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', entry], {
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
  const bootFixture = (fixture: string, port: number): BootResult =>
    bootEntry(CATALOG_FIXTURE_ENTRY, { CATALOG_FIXTURE: fixture, PORT: String(port) });

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
