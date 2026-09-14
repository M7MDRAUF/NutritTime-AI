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
  /**
   * **Two reporters, and T-24-01 adds none — which is a decision, not an omission.**
   *
   * `list` is the run's own console output and the thing a phase gate reads (Plan §19.5's
   * "End-to-end tests | `npm run test:e2e`"); with four projects it prefixes every line with the
   * viewport, so a failure that exists only at 320 is legible without opening anything. `html` is
   * the artefact the word "Report" in T-24-02…T-24-07's evidence column names, and it is the only
   * reporter that carries the `retain-on-failure` trace and the failure screenshot — which is to
   * say the only one that answers "why did it fail" rather than "what failed".
   *
   * The three candidates for a third were each rejected for a reader that does not exist in this
   * build: `json` — nothing in this repository parses a results file, and P25 measures latency
   * inside the page rather than from a test's wall-clock duration, so a results file would be an
   * artefact written for nobody; `blob` — it exists to merge shards, and `workers: 1` with
   * `fullyParallel: false` means there is exactly one; `github` — CONTRACTS Amendment 13 records
   * that `git remote -v` is empty, so no Actions run can exist to annotate. A reporter nobody
   * reads is not a deliverable, and adding one would make the reporting line of T-24-01 look
   * discharged while changing nothing a human sees.
   */
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
   * **Mobile-first viewports. The four-viewport matrix T-24-01 asks for, with a reason each.**
   *
   * A width is on this list because a specific layout claim is only observable at it, never to
   * make the matrix look thorough: every project multiplies the whole suite's runtime by one, and
   * `workers: 1` means that cost is serial.
   *
   * **The mis-citation this docstring used to carry, corrected rather than deleted.** It said
   * these widths are "what PRD §10.5 and Plan §19.5 ask for". **PRD §10.5 names no viewport at
   * all** — it is the accessibility section: roles and labels, the 48 dp target, text scaling,
   * colour independence, AA contrast. Neither does PRD, TSD or SDD anywhere else; the string
   * `viewport` does not occur in any of the three. The only document that names widths is
   * **Plan §19.5** ("`npm run test:e2e` at 320 / 375 / 414 / 768 px") and **Plan §20** ("Supported
   * viewports | 320 · 375 · 414 · 768 px"). Left as it was, the wrong half of that citation would
   * have sent the next reader to a section that cannot settle the question.
   *
   * **Every one of the four is a phone or tablet width, and no desktop width is here.** Plan §19.5
   * calls the row "Mobile viewport tests", and the four figures are named four times:
   *
   * ```
   * Plan.md:1373  | T-22-07 | No unintended horizontal scroll at 320/375/414/768 px |
   * Plan.md:2486  | T-22-07 | §20 | Layout | No horizontal scroll at 320/375/414/768 px |
   * Plan.md:2752  | Mobile viewport tests | `npm run test:e2e` at 320 / 375 / 414 / 768 px |
   * Plan.md:2778  | Supported viewports | 320 · 375 · 414 · 768 px, verified by screenshot |
   * ```
   *
   * Quoted with their lines rather than summarised, because the first draft of this matrix carried
   * a `desktop-1280` project taken from memory and dropped 414 — a width four rows of Plan.md
   * require. A figure in this file should be checkable without trusting that somebody checked it.
   *
   * The two P13 projects stay where they were and the two new ones are appended, so this reads as
   * an extension of the P13 harness rather than a rewrite of it (T-24-01). Declaration order is
   * therefore 375, 768, 320, 414; nothing depends on it, and `phone-375` stays the project every
   * other wave-6 agent pins so that a new viewport here cannot move anyone else's totals.
   */
  projects: [
    {
      /**
       * The iPhone SE / 13 mini width, and the suite's default: every other wave-6 agent pins
       * `--project=phone-375`, so this is the project a failure is first read at.
       *
       * It is also where `isLargeText`'s row-into-column reflow actually runs, which no wider
       * viewport exercises.
       */
      name: 'phone-375',
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      /**
       * Where the layout has to stop being a phone (Plan §20's tablet width).
       *
       * Paired with 375 rather than standing alone: a single viewport cannot show a reflow, and a
       * breakpoint is only observable as a difference between two runs of the same assertion.
       */
      name: 'tablet-768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      /**
       * **The narrowest width Plan §20 supports, and the one where an overflow is silent.**
       *
       * `apps/mobile/dist/index.html` ships react-native-web's recommended reset, which sets
       * `body { overflow: hidden }` so that `ScrollView` owns scrolling — verified in the built
       * export, not assumed. The consequence is that content too wide for the body is **clipped
       * with no scrollbar**: at 320 a control pushed past the edge is simply unreachable, and
       * nothing about the page says so. Plan §20's "every screen usable at 320 px without a
       * horizontal scrollbar" is therefore an assertion that has to be made at 320 itself; at 375
       * the same defect has 55 px of slack to hide in.
       *
       * 568 is the matching height (iPhone SE 1st generation), which also makes this the shortest
       * viewport — so a fixed footer overlapping the last card shows up here first.
       *
       * **What this project does NOT do, stated so the next reader does not assume it.** Running
       * the suite at 320 px is a precondition for T-22-07, not a discharge of it: no spec in
       * `e2e/specs/` mentions `scrollWidth`, `clientWidth` or `overflow` — the count is zero — so
       * nothing currently fails when something is clipped. And because the clipping happens at an
       * inner `overflow: hidden` box rather than at the document, `body.scrollWidth >
       * body.clientWidth` is the wrong probe: it is false under the very defect it is reached for.
       * The assertion has to be element-level; H1's report says which element.
       */
      name: 'phone-320',
      use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 568 } },
    },
    {
      /**
       * **The widest phone Plan §20 supports (iPhone XR/11's logical 414 × 896).**
       *
       * It is the one width of the four where nothing is tight, which is exactly what makes it a
       * control rather than padding: an assertion that fails at 320 and passes here is a layout
       * defect, while one that fails at both is a broken assertion. Without it the suite's widths
       * jump 375 → 768 and a single-column layout that begins to break up somewhere in between
       * has no run to show it.
       */
      name: 'phone-414',
      use: { ...devices['Desktop Chrome'], viewport: { width: 414, height: 896 } },
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
