/**
 * A private API instance for the Node-side P25 measurements, started and stopped by the caller.
 *
 * **Why a private instance rather than the suite's server on port 4000.** Four other agents are
 * running the acceptance suite in this tree. A port held by a measurement run is a failure they
 * cannot diagnose, and a measurement taken against a server three other runs are hammering is not
 * a measurement. So: a high port nobody else uses, started for one script, killed in a `finally`.
 * `stop()` is called on every exit path, including a throw, and `assertPortFree` refuses to start
 * if something is already listening rather than quietly attaching to it.
 *
 * **It is also the only way to read the server's own log line.** TSD §5.8's structured line goes to
 * stdout, and Playwright owns the stdout of a `webServer` it started. A child process this script
 * spawned is one whose stdout it can parse — which is what turns "the server says 12 ms" from a
 * claim into a figure.
 *
 * `tsx` (TSD §2.1, root devDependencies) runs the entry point directly. Not `tsx watch`: a watcher
 * left behind is exactly the long-lived process the wave brief forbids.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..');
const ENTRY_POINT = resolve(REPOSITORY_ROOT, 'apps', 'server', 'src', 'index.ts');

export interface ApiInstance {
  readonly port: number;
  /** Every line the server wrote to stdout, in order. */
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
  stop: () => Promise<void>;
}

/** Refuse to start on an occupied port. Attaching to a sibling's server would silently pass. */
export async function assertPortFree(port: number): Promise<void> {
  const occupied = await new Promise<boolean>((settle) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean): void => {
      socket.destroy();
      settle(value);
    };
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.setTimeout(1_000, () => {
      finish(false);
    });
  });
  if (occupied) {
    throw new Error(`port ${String(port)} is already in use; refusing to measure against it`);
  }
}

async function waitForHealth(port: number, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet. The deadline below is the only thing that ends this loop.
    }
    if (Date.now() > until) {
      throw new Error(
        `server on ${String(port)} did not answer /health within ${String(deadlineMs)} ms`,
      );
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

/** Start the real server entry point with an explicit environment. */
export async function startApi(
  port: number,
  env: Readonly<Record<string, string>>,
): Promise<ApiInstance> {
  await assertPortFree(port);
  const stdout: string[] = [];
  const stderr: string[] = [];
  // The type is left to inference. Annotating it `ChildProcessWithoutNullStreams` was wrong and
  // `tsc` said so: `stdio: ['ignore', 'pipe', 'pipe']` gives a null `stdin`, so the precise type
  // is `ChildProcessByStdio<null, Readable, Readable>`. Inference gets it exactly right and an
  // `as` to paper over the mismatch would have asserted a writable stdin that does not exist.
  const child = spawn(
    process.execPath,
    [resolve(REPOSITORY_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ENTRY_POINT],
    {
      cwd: REPOSITORY_ROOT,
      // A fresh, explicit environment for the measured variables, over the inherited one.
      env: { ...process.env, PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const collect = (buffer: string[]) => (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '') {
        buffer.push(line);
      }
    }
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.killed) {
      return;
    }
    const exited = new Promise<void>((settle) => {
      child.once('exit', () => {
        settle();
      });
    });
    child.kill();
    await exited;
  };

  try {
    await waitForHealth(port, 60_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, stdout, stderr, stop };
}

/**
 * A forwarding proxy that adds a fixed delay, used as the sensitivity probe for a server figure.
 *
 * The delay is applied before the request is forwarded, so the measured interval grows by it. A
 * harness that reports the same number through a 500 ms proxy is not measuring the server.
 */
export function startDelayProxy(port: number, targetPort: number, delayMs: number): Server {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const upstream = await fetch(
              `http://127.0.0.1:${String(targetPort)}${request.url ?? '/'}`,
              {
                method: request.method ?? 'GET',
                headers: { 'content-type': 'application/json' },
                ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
              },
            );
            const body = Buffer.from(await upstream.arrayBuffer());
            response.writeHead(upstream.status, { 'content-type': 'application/json' }).end(body);
          } catch {
            response.writeHead(502).end('{}');
          }
        })();
      }, delayMs);
    });
  });
  server.listen(port, '127.0.0.1');
  return server;
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((settle) => {
    server.close(() => {
      settle();
    });
  });
}

/** Structured log lines the server wrote, parsed. Unparseable lines are dropped, not guessed at. */
export function logRecords(lines: readonly string[]): readonly Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        records.push({ ...parsed });
      }
    } catch {
      // Boot banners and stack traces are not JSON. Not an error.
    }
  }
  return records;
}

/** A numeric field of a parsed log record, or `undefined`. Never a coerced zero. */
export function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// The perf lane's own webServer replacement.
//
// **Why this exists instead of Playwright's `webServer`.** The suite's config starts the API with
// `npm --prefix .. run dev:server`, which on Windows is cmd -> bash(npm) -> node(tsx watch) ->
// node(server): four levels, and the kill at the end of a run did not reach the last one. A first
// measurement run of this lane left a server listening on 4000 for twenty minutes, which is
// precisely the port another agent cannot diagnose. Observed, not theorised — it is in this
// agent's own report.
//
// So the perf lane spawns the entry point DIRECTLY, one process per server, and kills what it
// started. `stopStarted` reports what it stopped, and the run's own environment check afterwards
// is what confirms it.
//
// **It reuses, and never stops, a server it did not start.** Four other agents can be running the
// acceptance suite. If 4000 already answers `/health`, this attaches to it — and leaves it exactly
// as it was found.

const STATIC_SERVER = resolve(import.meta.dirname, '..', 'serveExport.mjs');

interface StartedServer {
  readonly label: string;
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const started: StartedServer[] = [];

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (!(await answers(url))) {
    if (Date.now() > until) {
      throw new Error(`${url} did not answer within ${String(deadlineMs)} ms`);
    }
    await new Promise((settle) => setTimeout(settle, 100));
  }
}

function spawnDirect(
  label: string,
  port: number,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): StartedServer {
  const child = spawn(process.execPath, [...args], {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return {
    label,
    port,
    stop: async () => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      const exited = new Promise<void>((settle) => {
        child.once('exit', () => {
          settle();
        });
      });
      child.kill();
      await exited;
    },
  };
}

/** Start the API and the static export server, reusing either if it is already answering. */
export async function startMeasurementServers(apiPort: number, webPort: number): Promise<void> {
  const apiHealth = `http://127.0.0.1:${String(apiPort)}/health`;
  if (!(await answers(apiHealth))) {
    started.push(
      spawnDirect(
        'api',
        apiPort,
        [resolve(REPOSITORY_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), ENTRY_POINT],
        {
          PORT: String(apiPort),
          AI_FAKE: 'true',
          // Deliberately absent, exactly as e2e/playwright.config.ts leaves it: OLLAMA_BASE_URL.
        },
      ),
    );
    await waitForUrl(apiHealth, 60_000);
  } else {
    process.stdout.write(
      `REUSING an API already answering on ${String(apiPort)}; it will be left running\n`,
    );
  }

  const webRoot = `http://127.0.0.1:${String(webPort)}`;
  if (!(await answers(webRoot))) {
    started.push(spawnDirect('web', webPort, [STATIC_SERVER], { WEB_PORT: String(webPort) }));
    await waitForUrl(webRoot, 60_000);
  } else {
    process.stdout.write(
      `REUSING a web export already served on ${String(webPort)}; it will be left running\n`,
    );
  }
}

/** Stop only what `startMeasurementServers` started, and say so. */
export async function stopMeasurementServers(): Promise<void> {
  while (started.length > 0) {
    const server = started.pop();
    if (server !== undefined) {
      await server.stop();
      process.stdout.write(`STOPPED ${server.label} on port ${String(server.port)}\n`);
    }
  }
}
