# NutriTime AI

A private, solo, local-only mobile application that recommends meals appropriate to the time of day.
It runs on one laptop: an Expo / React Native app (iOS, Android and a web export) talking to an
Express API on `127.0.0.1`. There is no hosted backend, no account, no database and no analytics.
Every recommendation is computed from a catalog that ships inside the repository, filtered against
the user's diet, allergies, budget and goal, and scored by a pure domain package with no clock, no
I/O and no network of its own.

A local Gemma 3 model adds a grounded assistant and phrases the one-line explanation on a meal card.
It is **phrasing, never deciding**: the domain resolves what is true, the model puts it into a
sentence, and every reply is schema-checked and containment-checked before a user sees it. That is
why the model is optional — see [Prerequisites](#prerequisites).

- Requirements, screens and error copy: [`PRD.md`](PRD.md)
- Architecture and the local run story: [`SDD.md`](SDD.md)
- Contracts, tokens, routes and test tiers: [`TSD.md`](TSD.md)
- Phase-by-phase execution record: [`Plan.md`](Plan.md)
- **The full operational procedure, with troubleshooting: [`docs/RUNBOOK.md`](docs/RUNBOOK.md)**

This file is the short entry point. `docs/RUNBOOK.md` is the long one, and where the two describe
the same step, it has the detail — ports, CORS, the static-export ordering, catalog regeneration.

---

## Prerequisites

| Thing                | Requirement                             | Where the requirement is written                                                                                              |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Node.js              | `>=22.13.0 <25`                         | [`package.json`](package.json) → `engines.node`, and `TSD.md` §2.1                                                            |
| npm                  | whatever ships with that Node           | —                                                                                                                             |
| Expo CLI             | **nothing to install globally**         | `expo` is a dependency of `apps/mobile`; its `start` script is plain `expo start`, so the workspace copy is the one that runs |
| Ollama + `gemma3:4b` | **optional**                            | `SDD.md` §2.2 — "Gemma 3:4B is optional at runtime and slow when cold"                                                        |
| Chromium             | installed by the E2E suite, not by hand | [`e2e/package.json`](e2e/package.json) → `install:browsers`                                                                   |

The version range is read from the manifest and the toolchain pins, not from whatever Node happens
to be on your PATH. Check it first, because every later failure is harder to read than this one:

```bash
node --version
npm --version
```

### The app works without Ollama

This is the part worth reading before you install anything. `SDD.md` §2.2 requires the application
to be demonstrable with Ollama stopped, and it is:

- **Recommendations are deterministic and model-free.** Period detection, allergen rejection, diet
  compatibility, scoring and tie-breaking all live in `packages/domain`, which imports no network
  client. With no model, a card still appears — it carries fallback explanation text instead of a
  phrased one, and the card says so.
- **The assistant degrades to an explicit unavailable state**, never to a blank screen and never to
  a guess. With `AI_ENABLED=false` the chat route answers `503 ai_disabled`; with the model simply
  unreachable or slow, the screen shows the AI-unavailable state and says what still works.
- **Nothing probes Ollama at boot.** The server starts and `/health` answers `ok` with Ollama
  stopped, so a healthy server tells you nothing about the model either way.

Install Ollama only for the Full mode below.

---

## Install

```bash
npm ci
cp .env.example .env
```

`npm ci` rather than `npm install`: it installs exactly what `package-lock.json` records and fails
if the lockfile and the manifests disagree, where `npm install` can quietly re-resolve a version
that `TSD.md` §2.1 pins. (`SDD.md` §2.3 writes `npm install`; either populates the tree, and `npm ci`
is what CI runs.)

There is no build step for development: `dev:server` runs the TypeScript sources through `tsx`, and
Metro compiles the app.

### `e2e/` is deliberately outside the npm workspaces — it needs its own install

The root `workspaces` field covers `apps/*` and `packages/*` only. `e2e/` has its own
`package.json` and its own lockfile, so that `@playwright/test` and its browser binaries never
enter the root lockfile (`TSD.md` §2.1).

**A clean machine that runs only the root install will find `npm run test:e2e` broken.** That is not
a bad checkout. Before the first E2E run:

```bash
npm --prefix e2e ci                      # e2e's own dependencies
npm --prefix e2e run install:browsers    # Chromium, once per machine
```

`.env` is gitignored and is never committed; `.env.example` is the committed template, and
`TSD.md` §5.2 is the authority on all eight variables, their types, defaults and validation. One of
them is worth knowing before you edit it: the keep-alive variable is `AI_KEEP_ALIVE`, **not**
`OLLAMA_KEEP_ALIVE` — the latter is Ollama's own daemon variable, and two variables sharing one name
across two scopes fail silently. A bare integer is rejected at boot; write `30m`, not `30`.

`USDA_DATASET_PATH` is build-time only (`npm run seed`) and the running server never reads it. The
archive it names lives **outside the repository by design** and is not required to run, build or
test the application. It affects one thing only: the test total (see
[Test commands](#test-commands)).

---

## The three run modes

From `SDD.md` §2.3, and each one is a real server code path selected by configuration — not a build
flag and not a test mock:

| Mode        | Setting                           | Behaviour                                                                                    |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| **Full**    | `AI_ENABLED=true`, Ollama running | Explanations and assistant answers are phrased by Gemma                                      |
| **No AI**   | `AI_ENABLED=false`                | Recommendations use fallback text; the assistant answers `503 ai_disabled`                   |
| **Fake AI** | `AI_FAKE=true`                    | The model call is replaced by a deterministic echo of the answer the domain already resolved |

The two switches mean different things and are read in different places, which is why there are
three modes and not two: `AI_ENABLED=false` is a product state the user can see, while `AI_FAKE=true`
substitutes only the outbound HTTP call. Under Fake AI the route, retrieval, resolution, prompt
construction and containment all execute exactly as in production. That is what makes a pass under
it evidence rather than theatre, and it is why the E2E suite and CI — neither of which has a model —
use it.

Start it — one command, every platform:

```bash
npm run dev            # API + Expo dev server
```

<sub>This said "two terminals on Windows" until P28, because `npm run dev` used to be
`dev:server & dev:mobile` and `cmd.exe` treats `&` as a _sequential_ separator, so the Expo server
never started. `package.json` has run `node scripts/dev.mjs` since P26, which spawns both children
itself; only the prose was left behind. `dev:server` and `dev:mobile` still exist if you want them
in separate terminals.</sub>

For Full mode only:

```bash
ollama pull gemma3:4b
ollama serve           # if it is not already running as a service
```

Then `curl http://127.0.0.1:4000/health`. The API binds `127.0.0.1` on purpose; `docs/RUNBOOK.md` §5
explains why that must not be widened, and lists the three ports involved.

---

## Test commands

| Command                               | What it does                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                       | **The single gate**: `format:check && lint && typecheck && test`. `TSD.md` §2.4 makes this the one thing that has to pass                    |
| `npm run test`                        | The Vitest suite — three projects (`unit`, `integration`, `dom`)                                                                             |
| `npm run test -- <path or substring>` | One file or one area, e.g. `npm run test -- packages/domain/src/money.test.ts`                                                               |
| `npm run typecheck`                   | `tsc --noEmit` across all six projects plus `e2e`                                                                                            |
| `npm run lint`                        | ESLint over the repository, import boundaries included                                                                                       |
| `npm run format:check`                | Prettier, check-only                                                                                                                         |
| `npm run test:e2e`                    | Playwright, from `e2e/` — **needs the two extra installs above, plus `npm run build:web` first**, because the suite serves the static export |

`npm run test:e2e` is a separate script and is **not** inside `npm run check`. `e2e/serveExport.mjs`
exits with `Run: npm run build:web` when `apps/mobile/dist` is missing, rather than serving 404s and
making every spec fail as "element not found".

### Two caveats, and they are the difference between trusting this file and being misled by it

**1 — The suite's test total is machine-specific. Yours differing is not a broken checkout.**

Two `describe.skipIf` gates hide tests behind environment variables:

| Skipped | Gate                | What it hides                                                                                                |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| 7       | `USDA_DATASET_PATH` | the real-archive nutrition-derivation checks in `packages/catalog/src/seed/usda-dataset.integration.test.ts` |
| 2       | `RUN_MODEL_TESTS=1` | the grammar-constraint probe in `apps/server/src/ai/grammar.integration.test.ts`, which needs a real model   |

So **2 skipped is a full run and 9 skipped is not**, and the two totals differ by seven. The USDA
archive is a large FoodData Central export that cannot be committed and lives outside the repository
by design (`TSD.md` §7.4 reads it by path; `.gitignore` refuses `*.csv` so a stray copy cannot land
in the tree). **Read the skipped count, not only the passed count** — if yours is 9 and you expected
a full run, you have not exercised the derivation checks and nothing else in the output says so.
This is risk **R-59** in `Plan.md` §23.

**2 — Two commands printed in the planning documents match no file. They are not repeated here.**

Both run, and both find nothing:

- `npm run test -- a11y` (`Plan.md` §19.5 and P23's Part 4) — no path in the repository contains
  `a11y`. Vitest prints `No test files found, exiting with code 1`.
- `npm run test -- saved-meals customMeals` (`Plan.md` §18, P17) — the `customMeals` half matches
  `apps/mobile/src/state/customMeals/`, but nothing contains `saved-meals`, so the saved-meals
  feature suites are never reached. They live under `apps/mobile/src/features/saved/`.

This is risk **R-62**. Which document is wrong is the user's call, so neither command was corrected
and neither is quoted above as if it worked. Every command in the tables above was either executed
or read directly from [`package.json`](package.json).

---

## Repository layout

| Path                  | What lives there                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `apps/mobile/`        | Expo / React Native app: features, navigation, shared components, theme, storage                          |
| `apps/server/`        | Express API, the AI lane, config, logging and the fixed error copy                                        |
| `packages/contracts/` | Zod schemas and wire types shared by both apps                                                            |
| `packages/domain/`    | Pure logic — periods, allergens, diet, scoring, retrieval, answer resolvers. No clock, no I/O, no network |
| `packages/catalog/`   | The meal catalog and the seed pipeline that produces it                                                   |
| `e2e/`                | Playwright suite, outside the workspaces                                                                  |
| `design-system/`      | Generated design artefacts and [`DECISIONS.md`](design-system/DECISIONS.md), the adopt/reject record      |
| `docs/`               | [`RUNBOOK.md`](docs/RUNBOOK.md), phase reports, performance notes                                         |

Import boundaries are linted, not merely documented: `apps/server` may not import from
`apps/mobile` or the reverse, and `packages/domain` may not reach a clock, I/O or the network. The
boundary is the design — an ESLint disable is not the way past it.

## Attribution and scope

Meal source data and photography come from [TheMealDB](https://themealdb.com/), used for seeding
only, and attribution is required wherever a seeded meal is shown. TheMealDB carries no nutrition
data; nutrition is derived at build time from USDA FoodData Central and is `null` where it cannot be
established — the UI renders "Not available", never `0`.

Nothing here is medical or dietary advice. Allergen handling is a best-effort filter over
ingredient text, not a safety certification; the in-app disclaimer says so, and it is shown before
the allergy form and above the recommendations rather than after them.
