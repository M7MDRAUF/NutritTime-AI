# NutriTime AI — local run procedure

**T-26-06.** SDD §2.3 made executable: a clean machine can follow this from top to bottom and end
with the app running, the gate green, and both production builds attempted.

Per **A-06** the deployment target is the developer's own machine. There is no hosting provider, no
container, no staging environment and no remote — so "deploying" this project means running it
locally, and this file is the whole of the procedure. Anything below that reads as a limitation is
recorded as one rather than smoothed over.

Every figure here is read from a manifest or a specification, not from the machine this was written
on. No path on any particular computer appears in this file, and no secret does either: the one
file that holds configuration (`.env`) is gitignored by design, and the USDA archive lives outside
the repository by design (TSD §7.4). Both are described below by variable name and shape.

---

## 1. Prerequisites

| Thing            | Requirement                             | Where the requirement is written                            |
| ---------------- | --------------------------------------- | ----------------------------------------------------------- |
| Node.js          | `>=22.13.0 <25`                         | `package.json` → `engines.node`; TSD §2.1                   |
| npm              | Whatever ships with that Node           | —                                                           |
| Ollama + a model | **Optional.** `gemma3:4b`               | SDD §2.2 — "Gemma 3:4B is optional at runtime"              |
| Chromium         | Installed by the E2E suite, not by hand | `e2e/package.json` → `install:browsers`                     |
| Expo CLI         | **Nothing to install globally**         | `expo` is a dependency of `apps/mobile`; see the note below |

**Do not install Expo globally.** SDD §2.3 lists "Expo CLI" as a prerequisite, but
`apps/mobile/package.json` declares `expo` as a dependency and its `start` script is plain
`expo start`, so `npm --workspace apps/mobile run start` reaches the local copy. A globally
installed CLI at a different version is a second toolchain that TSD §2.1 does not pin.

Verify Node before anything else, because every later step's failure mode is worse than this one's:

```bash
node --version      # must satisfy >=22.13.0 <25
npm --version
```

---

## 2. First-time setup

```bash
npm ci
cp .env.example .env
```

`npm ci` and not `npm install`: it installs exactly what `package-lock.json` records and fails if
the lockfile and the manifests disagree. `npm install` would quietly re-resolve and can move a
version TSD §2.1 pins.

It installs the root workspaces only — `apps/*` and `packages/*`. **`e2e/` is deliberately outside
the workspaces** (TSD §2.1, `e2e/package.json`): `@playwright/test` pulls browser binaries and the
root lockfile stays free of them. It has its own install, in §6.

There is no build step for development. `npm run dev:server` runs the TypeScript sources through
`tsx`, and Metro compiles the app.

---

## 3. Configuration

`.env` is gitignored and never committed. Copy `.env.example`, which carries every variable with a
safe default and the reasoning next to the two that have traps. The authority for the table is
TSD §5.2; everything is parsed once with Zod at boot into a frozen object, and a value that fails
validation **stops the server** rather than being coerced.

| Variable                        | Type                | Default                     |
| ------------------------------- | ------------------- | --------------------------- |
| `PORT`                          | integer 1–65535     | `4000`                      |
| `AI_ENABLED`                    | boolean             | `true`                      |
| `AI_FAKE`                       | boolean             | `false`                     |
| `OLLAMA_BASE_URL`               | url                 | `http://localhost:11434`    |
| `OLLAMA_MODEL`                  | non-empty string    | `gemma3:4b`                 |
| `AI_KEEP_ALIVE`                 | duration string     | `30m`                       |
| `OLLAMA_CHAT_TIMEOUT_MS`        | integer 1000–120000 | `30000`                     |
| `OLLAMA_EXPLANATION_TIMEOUT_MS` | integer 1000–60000  | `12000`                     |
| `USDA_DATASET_PATH`             | directory path      | unset — build-time only, §8 |

Two of these will cost you an afternoon if you get them wrong, and both are documented in
TSD §5.2 rather than being folklore:

- **`AI_KEEP_ALIVE` must carry a unit suffix** — `ms`, `s`, `m` or `h`. A bare `30` is rejected at
  boot with `AI_KEEP_ALIVE=30 means 30 seconds; write 30m for 30 minutes.` Ollama reads a bare
  number as seconds, so without that check the model would evict between questions and resurface
  as an ordinary timeout.
- **It is `AI_KEEP_ALIVE`, not `OLLAMA_KEEP_ALIVE`.** The latter is Ollama's own server-side
  variable, read by `ollama serve`. Setting that one instead has no effect here and produces no
  error, which is the worst combination available.

---

## 4. The three ways to run it

SDD §2.3's table, unchanged. The mode is chosen by configuration, not by a build flag:

| Mode        | Setting                           | Behaviour                                                                                    |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| **Full**    | `AI_ENABLED=true`, Ollama running | Explanations and assistant answers are phrased by Gemma                                      |
| **No AI**   | `AI_ENABLED=false`                | Recommendations use fallback text; the assistant answers `503 ai_disabled`                   |
| **Fake AI** | `AI_FAKE=true`                    | The model call is replaced by a deterministic echo of the answer the domain already resolved |

`AI_FAKE` is not a test mock. It is a real code path in the server selected by config, so the
route, retrieval, resolution and containment all execute exactly as in production and only the
phrasing step is substituted. That is why the E2E suite and CI use it and why a pass under it is
worth something.

For **Full** mode only:

```bash
ollama pull gemma3:4b
ollama serve          # if it is not already running as a service
```

Nothing probes Ollama at boot (TSD §5.1 step 5): an outage degrades one feature and must not block
startup. So a server that starts tells you nothing about whether the model is reachable.

---

## 5. Running it

**On macOS and Linux:**

```bash
npm run dev
```

**On Windows, use two terminals instead:**

```bash
npm run dev:server     # terminal 1
npm run dev:mobile     # terminal 2
```

`npm run dev` is `npm run dev:server & npm run dev:mobile`. That `&` backgrounds the first command
in a POSIX shell, but npm's default script shell on Windows is `cmd.exe`, where `&` is a
**sequential** separator — so the second command waits for the first, `tsx watch` never exits, and
the Expo dev server never starts. Measured, not assumed: under `cmd.exe`, `A & B` with a 2.5-second
`A` printed `A` before `B` and took 2.6 seconds in total. Two terminals is the portable procedure.

What should be listening:

| Port    | What                                          |
| ------- | --------------------------------------------- |
| `4000`  | the API (`PORT`), bound to `127.0.0.1` only   |
| `8081`  | Expo's Metro dev server                       |
| `19006` | Expo web, and where a static export is served |

The API binds `127.0.0.1` deliberately and not `0.0.0.0`
(`apps/server/src/index.ts` → `LISTEN_HOST`). TSD §2.1 drops `helmet` and `express-rate-limit`
specifically because the server is local-only, and PRD §10.3 promises the user their question goes
only to a server on the same machine. Binding every interface would remove the control those
documents rely on while the two defences they waived are also absent. Do not change it to make a
phone on the same Wi-Fi reach it.

The browser treats `localhost` and `127.0.0.1` as different origins, and the server's CORS
allowlist covers both on all three ports above. Use whichever you like; do not add a fourth port
to make something work — that is loosening a security boundary for convenience.

Confirm the API is up:

```bash
curl http://127.0.0.1:4000/health
# {"status":"ok","catalogVersion":"…","mealCount":…}
```

`/health` probes nothing downstream. It answers `ok` with Ollama stopped, which is the point.

---

## 6. Verifying it

### The gate

```bash
npm run check
```

That is `format:check && lint && typecheck && test`, and TSD §2.4 makes it **the single gate —
nothing else is required to pass before committing**. `npm run test:e2e` is a separate script and
is not part of it.

**Read the skipped count, not just the passed count.** Two conditional skips exist and they mean
different things:

| Skipped | Gate                | What it hides                                                              |
| ------- | ------------------- | -------------------------------------------------------------------------- |
| 2       | `RUN_MODEL_TESTS=1` | the grammar-constraint probe, which needs a real model (TSD §8.3)          |
| 7       | `USDA_DATASET_PATH` | the real-archive derivation tests in `packages/catalog/src/seed/` — see §8 |

So **2 skipped is the full run and 9 skipped is not**, and the suite total differs between the two
by seven. This is risk **R-59** in Plan §23 (Risk Register). If your number is 9 and you
expected the full suite, the archive is missing — you have not run the USDA derivation checks,
and nothing else in the output will tell you so.

### The end-to-end suite

Playwright starts both servers itself, so do not start them by hand — but it serves a **static
export**, which you have to build first:

```bash
npm run build:web                                  # writes apps/mobile/dist
npm --prefix e2e ci                                # e2e has its own lockfile
npm --prefix e2e run install:browsers              # Chromium, once per machine
npm run test:e2e
```

Order matters. `e2e/serveExport.mjs` exits 1 with `Run: npm run build:web` when
`apps/mobile/dist` is absent, rather than serving 404s and making every spec fail as
"element not found" — which would send you reading the app instead of the missing build.

The suite needs no model: `e2e/playwright.config.ts` sets `AI_FAKE=true` for the API it starts,
and deliberately leaves `OLLAMA_BASE_URL` unset so the fake path cannot quietly fall through to a
real call.

---

## 7. Production builds

```bash
npm run build:server    # tsc -p apps/server/tsconfig.build.json  ->  apps/server/dist
npm run build:web       # expo export --platform web --output-dir dist  ->  apps/mobile/dist
```

**`build:server` compiles but does not currently produce a runnable artefact.** This is risk
**R-69** in Plan §23 (Risk Register) and it is open:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<repo>/packages/contracts/src/core.js'
imported from '<repo>/packages/contracts/src/index.ts'
```

`packages/contracts`, `packages/domain` and `packages/catalog` each declare `main: src/index.ts`
and no script emits any of them, so the emitted `@nutritime/*` specifiers resolve to uncompiled
TypeScript. `build:server` exiting 0 therefore proves compilation and nothing about runnability.
Until R-69 is fixed, **run the server through `npm run dev:server`**, which goes through `tsx` and
needs no build. The web export is unaffected — Metro bundles the packages from source.

---

## 8. Regenerating the catalog (optional, build-time only)

You almost certainly do not need this. `packages/catalog/meals.json` and
`packages/catalog/nutrition-source.json` are **committed**, and the running app reads those. TSD
§7.4 keeps the derivation reproducible without the 16 MB source archive precisely so that a clean
machine is not blocked on it.

If you do need to re-derive nutrition:

1. Obtain USDA FoodData Central's **FNDDS supporting-data** release and extract it. The directory
   must contain `fndds_ingredient_nutrient_value.csv` and `nutrient.csv`. The vintage this project
   derived from is `2022-10-28`.
2. **Keep it outside the repository.** `.gitignore` refuses `*.csv` for exactly this reason, and
   TSD §7.4 states the archive is not committed.
3. Point `USDA_DATASET_PATH` at that directory in `.env` — an absolute path to the extracted
   directory, with no filename on the end:

   ```
   USDA_DATASET_PATH=/absolute/path/to/the/extracted/fndds/directory
   ```

4. `npm run seed`

`USDA_DATASET_PATH` is read by the seed script and by the archive tests. It is **not** read by the
running server. A missing or blank value is a hard stop with a named error, never a fallback to
another nutrition source — Plan T-07-06 forbids any second source, so there is nothing to fall
back to.

Setting it also changes what `npm run check` reports: `vitest.config.mts` loads `.env` into the
environment, so the seven archive tests in §6's table start running and the skipped count drops
from 9 to 2. That is R-59 seen from the other side.

---

## 9. Continuous integration

`.github/workflows/ci.yml` is one job on push and pull request, running the sequence SDD §16 and
Plan §21.2 specify: `npm ci` → `npm run check` → `build:server` → `build:web` → `test:e2e` with
`AI_FAKE=true`, then `npm audit --audit-level=high`, then a boot of the server artefact against
`/health`.

**It has never run, and it cannot.** There is no git remote (A-02, B-03): this is a private,
solo, local-only project with no forge behind it, so no push can happen and no Actions run can
exist. Every step in that file was executed locally in the same order instead, and the P26 phase
report records each command with its real output. Nothing in this repository claims a run URL,
because there is none to claim.

Two steps in it are known to behave in ways worth knowing before you ever connect a remote:

- the **USDA preflight fails the job** when `USDA_DATASET_PATH` is not provisioned on the runner,
  by design — see §6 and R-59. The escape is an explicit edit to `USDA_ARCHIVE_POLICY` in the
  workflow itself, so an archive-less run is a reviewable line in version control rather than a
  silent seven-test shortfall.
- the **`/health` step fails** until R-69 is fixed, for the reason in §7. It is written correct and
  left red rather than written to pass.

---

## 10. Troubleshooting

| Symptom                                                      | Cause and fix                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Server exits at boot naming a variable                       | A `.env` value failed Zod validation (TSD §5.2). The message names the variable; it is refusing on purpose.      |
| Server exits at boot naming a meal record                    | An invalid catalog record. TSD §5.1 step 2 requires a non-zero exit rather than serving unvalidated safety data. |
| `AI_KEEP_ALIVE=30` rejected                                  | Correct behaviour. Write `30m`. See §3.                                                                          |
| Model answers nothing and the keep-alive setting looks right | You may have set `OLLAMA_KEEP_ALIVE`, which configures Ollama's daemon and not this app. See §3.                 |
| Assistant returns `503 ai_disabled`                          | `AI_ENABLED=false`. That is No-AI mode, not a fault.                                                             |
| First assistant question after a restart times out           | A cold model load takes roughly a minute and exceeds the 30 s budget. It recovers on its own; ask again.         |
| Every E2E spec shows "Working offline"                       | The web origin is not one the API's CORS allowlist trusts. Serve on 19006; do not widen the allowlist.           |
| E2E run dies with `No web export at …`                       | `npm run build:web` has not been run since the last clean. See §6.                                               |
| `npm run dev` starts the API and nothing else, on Windows    | `cmd.exe` treats `&` as sequential. Use two terminals. See §5.                                                   |
| `node apps/server/dist/index.js` cannot find `./core.js`     | R-69. Use `npm run dev:server`. See §7.                                                                          |
| `npm run check` reports a total you do not recognise         | Compare the **skipped** count against §6's table before anything else.                                           |

---

## 11. Known limitations of this procedure

1. **No CI run exists and none can**, for the reason in §9. The workflow is validated structurally
   and by local execution of each step, which is weaker evidence than a run and is recorded as such.
2. **The server artefact does not boot** (R-69, §7). Development and the E2E suite are unaffected
   because both run from source.
3. **Nothing here has been executed on Linux.** The commands are POSIX-portable and
   `.gitattributes` normalises line endings to LF so `format:check` survives a clone on any
   platform, but the CI job would be this repository's first Linux run of the suite.
4. **The USDA archive cannot be provisioned automatically.** It is 16 MB, uncommittable by design,
   and with no forge there is no cache, artifact store or release asset to fetch it from. §8 is a
   manual step and §6's skipped-count table is how you tell whether it was taken.
