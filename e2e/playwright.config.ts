import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end harness (T-13-07), built at P13 rather than P24.
 *
 * Six later tasks name a Playwright report as their evidence — T-15-07's peanut exclusion,
 * T-16-04's favourite surviving a reload, T-17-05's delete, T-21-06's citations, T-22-06's
 * `localStorage` bounds, and T-18-06's full reset. Building the harness at P24 would leave every
 * one of them unverifiable at the moment it was written, which is the same mistake as writing the
 * assertion after the code.
 *
 * **It lives outside the npm workspaces on purpose** (TSD §2.1): `@playwright/test` pulls browser
 * binaries, and the root lockfile stays free of them. `npm --prefix e2e test` is the only way in.
 *
 * **Two servers, started by Playwright itself.** The Expo web export is static, so it needs a file
 * server; the API is a separate process on 4000. `webServer` accepts a list, and both are declared
 * here rather than in a script so a spec cannot be run against a stale build by accident.
 */

/** TSD §5.1. The client's `DEFAULT_API_BASE_URL` is the same figure. */
const API_PORT = 4000;
/**
 * **19006, because that is an origin the server's CORS allowlist already trusts.**
 *
 * The first run served the export on 4173 and every data spec fell into "Working offline" — the
 * screen was right and the request was blocked. `corsOrigins` allows the API port's own siblings
 * plus Expo's web ports (8081, 19006), which is exactly what TSD §5.3 specifies, so the fix was
 * the harness rather than the server: a static export IS the Expo web app, just built instead of
 * dev-served, and 19006 is the port Expo serves it on.
 *
 * Widening the allowlist would have been the wrong move. SDD §12 makes the deployment target the
 * developer's own machine served by Expo, so an arbitrary port is not a deployment this project
 * has — and adding one to satisfy a test would have loosened a real security boundary to make a
 * harness convenient.
 */
const WEB_PORT = 19_006;

export default defineConfig({
  testDir: './specs',
  // One worker. The API is a single process holding one catalog and, from P19, one model lane with
  // a concurrency of 1 — parallel specs would queue behind each other and time out looking like
  // flakes.
  workers: 1,
  fullyParallel: false,
  // A failing assertion is a defect to read, not to retry until it passes. CI reruns nothing.
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    // Kept only for a failure, because a trace per passing spec is hundreds of megabytes for
    // nothing.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  /**
   * Mobile-first viewports, which is what PRD §10.5 and Plan §19.5 ask for.
   *
   * 375 is the iPhone SE/13 mini width and the narrowest phone worth supporting; 768 is where the
   * layout has to stop being a phone. The two together catch the reflow bugs a single desktop
   * viewport hides — and `isLargeText` reflows a row into a column, so the narrow one is where
   * that path actually runs.
   */
  projects: [
    {
      name: 'phone-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
  ],

  webServer: [
    {
      /**
       * The API, with `AI_FAKE=true`.
       *
       * §5.5 makes `AI_FAKE` a real code path selected by config, not a test mock: the route,
       * retrieval, grounding and refusal logic all run, and only the model call is replaced by a
       * deterministic echo. So a spec that passes here has exercised everything except the weights.
       */
      command: 'npm --prefix .. run dev:server',
      url: `http://127.0.0.1:${String(API_PORT)}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: {
        AI_FAKE: 'true',
        PORT: String(API_PORT),
        // Deliberately absent: OLLAMA_BASE_URL. `AI_FAKE` must not need a model to be reachable,
        // and leaving it unset proves the fake path does not quietly fall through to a real call.
      },
    },
    {
      // `npx serve` is not a dependency: `expo export` writes a plain static tree, so Node's own
      // http server is enough and adds nothing to install.
      command: 'node ./serveExport.mjs',
      url: `http://127.0.0.1:${String(WEB_PORT)}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
      env: { WEB_PORT: String(WEB_PORT) },
    },
  ],
});
