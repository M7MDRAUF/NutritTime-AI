/**
 * Boot (TSD 5.1).
 *
 * The five steps in order: environment, catalog, in-memory index, middleware and routes,
 * listen. Steps 1 and 2 can each end the process, and both do it with a non-zero exit and the
 * offending thing named - a server that starts on configuration it could not parse, or on
 * safety data it could not validate, is worse than one that refuses to start, because it looks
 * like it is working.
 *
 * **Ollama is never probed here.** An outage degrades one feature; it must not block startup.
 */

import { pathToFileURL } from 'node:url';
import { seededCatalog } from '@nutritime/catalog';
import { createApp } from './app.js';
import { buildCatalog } from './catalog.js';
import { loadConfig } from './config.js';

/**
 * The interface this server listens on, and it is not a detail.
 *
 * TSD 2.1 drops `helmet` and `express-rate-limit` with the reason "the server binds to
 * localhost for one user (SDD 12)", SDD 12 opens "the threat surface is small: a local
 * server", and PRD 10.3 promises the user that their question and preferences "go only to a
 * server on the same machine".
 *
 * Passing no host makes Express bind `0.0.0.0` - every interface. That leaves the mitigating
 * control those three documents rely on absent while the two defences it waived are also
 * absent, so on any shared network the API, and at P21 the chat endpoint carrying questions
 * and allergy lists, is reachable from the LAN.
 */
export const LISTEN_HOST = '127.0.0.1';

function die(message: string): never {
  // stderr, not stdout: the structured request log owns stdout, and a boot failure is not a
  // request. Exit 1 so a supervisor or a test can tell refusal from a clean shutdown.
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export interface BootstrapOptions {
  /**
   * The catalog data, defaulting to the committed one.
   *
   * A seam, not a convenience: TSD 5.1 step 2 requires the PROCESS to exit non-zero on an
   * invalid record, and the only way to prove that without corrupting committed data is to
   * boot this same entry point over a deliberately broken fixture. `createApp` already takes
   * its catalog as a parameter for the same reason.
   */
  readonly seeded?: unknown;
}

export function bootstrap(options: BootstrapOptions = {}): void {
  const config = (() => {
    try {
      return loadConfig();
    } catch (error) {
      return die(error instanceof Error ? error.message : String(error));
    }
  })();

  const catalog = (() => {
    try {
      return buildCatalog(options.seeded ?? seededCatalog);
    } catch (error) {
      return die(error instanceof Error ? error.message : String(error));
    }
  })();

  const app = createApp({ config, catalog });

  const server = app.listen(config.PORT, LISTEN_HOST, () => {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'listening',
        host: LISTEN_HOST,
        port: config.PORT,
        catalogVersion: catalog.version,
        mealCount: catalog.meals.length,
        aiEnabled: config.AI_ENABLED,
      })}\n`,
    );
  });

  /**
   * Without this, a port already in use is SILENT.
   *
   * Node emits the failure as an `error` event on the server, not as a throw. With no listener
   * the default handler applies - and because the listen callback had already been queued, the
   * process printed `"listening"` and carried on serving nothing while another process answered
   * every request on that port. The only signal an operator got was a lie, which is the exact
   * failure TSD 5.1 exists to prevent.
   */
  server.on('error', (error: NodeJS.ErrnoException) => {
    const reason =
      error.code === 'EADDRINUSE'
        ? `port ${String(config.PORT)} is already in use on ${LISTEN_HOST}`
        : `could not listen on ${LISTEN_HOST}:${String(config.PORT)} (${error.code ?? 'unknown'})`;
    die(reason);
  });
}

/**
 * Boot only when this file IS the process entry point.
 *
 * Previously the call was unconditional, so any `import './index.js'` - a test, a tool, a
 * future script - started a listening server as a side effect of being read.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap();
}
