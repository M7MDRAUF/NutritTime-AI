/**
 * The P25 measurement lane's Playwright config.
 *
 * **Why a second config and not the suite's.** `e2e/playwright.config.ts` sets
 * `testDir: './specs'`, so a spec outside that directory is never collected — and that config is
 * spine (BRIEF §3), owned this wave by the agent adding `phone-320` and `desktop-1280`
 * (CONTRACTS Amendment 11). Pointing the measurement lane at a config that is being edited
 * mid-wave is exactly the confound §6.1a exists to forbid: a project list that grows between run 1
 * and run 3 silently changes the sample. So the `phone-375` project below is **transcribed** from
 * `e2e/playwright.config.ts`'s own `projects` list — cited by name rather than by line, because
 * that file is being edited as this is written — and every run is still pinned with
 * `--project=phone-375`. That file now carries four projects and a comment of its own saying every
 * wave-6 agent pins `phone-375`, which is confirmation rather than coincidence.
 *
 * **The two servers are started by `globalSetup` rather than by `webServer`, and that is a repair
 * rather than a preference.** The suite's `npm --prefix .. run dev:server` is cmd -> bash(npm) ->
 * node(tsx watch) -> node(server) on Windows, and the kill at the end of a run did not reach the
 * last of those: this lane's first outing left an API listening on port 4000 for twenty minutes,
 * which is exactly the failure another agent cannot diagnose. `globalSetup` spawns each server as
 * ONE process and `globalTeardown` stops precisely what was started — and reuses, without ever
 * stopping, anything a concurrent acceptance-suite run is already holding on either port.
 *
 * `testMatch` is narrowed to `*.perf.spec.ts` so the plain `.ts` modules in this directory are
 * never collected as specs: the shared instrument, the reporting helpers, the server harness, the
 * two setup hooks, and the two Node-side measurement scripts, which are run with `tsx`.
 */

import { defineConfig, devices } from '@playwright/test';

/**
 * An origin the server's CORS allowlist already trusts (TSD §5.3), and the port `globalSetup.ts`
 * serves the export on. The API's own port lives there too, since nothing here addresses it.
 */
const WEB_PORT = 19_006;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.perf\.spec\.ts$/,
  // One worker, and nothing parallel. A second browser sharing this machine's CPU with a timing
  // run is not a measurement.
  workers: 1,
  fullyParallel: false,
  // A measurement that failed is a measurement to read. A retry would silently report the fastest
  // of two attempts.
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  // T-25-04's stalled-upstream runs are 30 s each by construction, and a start measurement takes
  // three cold navigations of a 4.3 MB uncompressed bundle.
  timeout: 240_000,

  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    // All off. A trace writes to disk during the interval being measured.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },

  projects: [
    {
      name: 'phone-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
  ],

  // Not `webServer`. See serverHarness.ts's note: the suite's `npm --prefix .. run dev:server`
  // is four processes deep on Windows and the kill at the end of a run did not reach the last of
  // them — this lane left a server on port 4000 for twenty minutes on its first outing. These two
  // hooks spawn each server as ONE process and stop exactly what they started, reusing (and
  // leaving alone) anything a concurrent acceptance-suite run is already holding.
  globalSetup: './globalSetup.ts',
  globalTeardown: './globalTeardown.ts',
});
