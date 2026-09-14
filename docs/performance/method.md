# P25 measurement method

Every figure in `measurements.md` is produced by the harness in `e2e/perf/`. This file is the
method: what each boundary is, why it is the honest one, what the instrument is, and what would
make each figure a lie. It exists because **a performance figure with no method is worth less than
no figure, because it will be quoted later as if it were one.**

Two rules govern the whole lane, both from `Plan.md` P25:

- **Part 4.** Repeat each measurement three times; record median and worst. Both are reported for
  every figure, with the three raw values beside them — three samples give a median with no
  dispersion estimate at all, and a reader who cannot see the spread cannot tell a stable figure
  from a lucky one.
- **Part 5.** A missed target is recorded as a known limitation, **never** by relaxing the target.
  Nothing in `e2e/perf/stats.ts` rounds, and the verdict is printed for the median _and_ the worst
  so a marginal figure cannot become a clean pass in a later quotation.

---

## 0. The instrument, and why it is not a Playwright assertion

`await expect(locator).toBeVisible()` polls. A figure taken with `Date.now()` around one therefore
carries the harness's poll interval as though it were the app's latency: tolerable against a 2500 ms
budget, fatal against a 150 ms one — and using two different instruments for two rows of one SLO
table makes the table unreadable.

So every boundary is stamped **inside the page**, by an event listener or a `MutationObserver`
installed through `page.addInitScript` before any app code runs (`e2e/perf/instrument.ts`).
Playwright only reads the numbers afterwards, so its polling sits outside the measured interval.
Playwright assertions are still used, but only _after_ the mark is taken, as confirmation that the
instrument stamped the state it claims.

Node-side figures use `performance.now()` from `node:perf_hooks` around one `fetch`, with the
response body drained before the clock stops.

**Toolbox:** `@playwright/test` ^1.59.1, `tsx`, and Node's own `performance` — TSD §2.1's pins and
nothing else. No Lighthouse, no autocannon, no benchmarking library.

## 0.1 The lane's own config, and the pinned viewport

`e2e/playwright.config.ts` sets `testDir: './specs'`, so a perf spec outside that directory is
never collected — and that file is spine, being edited this wave to add two viewport projects. A
project list that grew between run 1 and run 3 would silently change the sample, which is the
confound the fleet brief's §6.1a exists to forbid. So `e2e/perf/perf.config.ts` transcribes the
`phone-375` project (375 × 812, Desktop Chrome) from `e2e/playwright.config.ts`'s own `projects`
list — by name rather than by line, because that file is being edited this wave — and every run is
additionally pinned with `--project=phone-375`. That file now carries four projects and its own
comment saying every wave-6 agent pins `phone-375`, which confirms the pin was the right call.

The two servers are started by `globalSetup` rather than by `webServer`, and that is a repair:
the suite's `npm --prefix .. run dev:server` is four processes deep on Windows and the kill at the
end of a run did not reach the last of them. This lane's first outing left an API listening on port
4000 for twenty minutes. `globalSetup` spawns each server as one process, `globalTeardown` stops
exactly what it started, and either port is **reused and left alone** if a concurrent acceptance
suite run is already holding it.

## 0.2 The probe rule, applied to a timing harness

For every figure: _if the app got twice as slow, would this harness report it?_ A timing harness
that prints a constant is the performance lane's version of a test that cannot fail. So each row
carries a sensitivity probe that injects a delay and shows the number move, and every injection is
a **load-time substitution** — `page.addInitScript`, `page.route`, or the environment of a server
this lane spawned itself. **No repository file is opened for writing at any point.**

Two probes are stronger than a moved number, and both are in `measurements.md`: lowering
`OLLAMA_CHAT_TIMEOUT_MS` moves the T-25-04 figure from 30 s to 4 s, and a chip tap costs 30 ms or
317 ms depending only on whether the search box holds text — a pair no single constant satisfies.

---

## 1. T-25-01 — app start to usable Home (PRD §10.1, ≤ 2.5 s)

**Observable.** Three recommendation cards in the document:
`[data-testid^="recommendation-"]`, count ≥ 3.

**Why that, and not the two cheaper candidates.**

- _First paint_ is dishonest. `SplashSurface` paints while `useFonts` and hydration are still
  running, so a first-paint figure measures the bundle's first byte of work and nothing the user
  came for.
- _The period heading_ is dishonest in the opposite direction, and it is the tempting one because
  it is fast and cannot fail. `home-period` renders from `mealPeriodForDate` on the first render
  before any request exists, and `apps/mobile/src/features/home/useRecommendations.ts:11-16` says
  so: T-15-01's acceptance is that the heading is there **with the server down**. A figure ending
  there would be true with no server at all — a number nothing could falsify.
- _Three cards_ is the product: PRD §7.1 (`PRD.md:91`) says "Return the top three", and this is
  the only state `HomeScreen` reaches at `state.kind === 'loaded'`. It is the first moment Home is
  usable for the thing Home exists to do.

Keyed on the **nodes** and not on their text: `useFonts` loads four Inter faces, and a text-keyed
boundary could be satisfied by text painted in the fallback family.

**Boundary events.** `performance.timeOrigin` (the navigation's start) → the `MutationObserver`
callback on which the third card node is present.

**"After first launch" is a reading, and it is recorded as one.** The literal first launch cannot
reach Home: P14 gave the app an onboarding gate and an empty device correctly lands on Onboarding
(`e2e/support/appPhase.ts` exists for exactly this). The reading measured is _a launch of an
already-onboarded device_.

**Cold, and cold in a specific way.** A fresh browser context, an empty HTTP cache, and the
onboarding + preferences envelope written by an **init script** so that **one** navigation is both
the first and the measured one. The obvious sequence — load, seed, load — parses the 1.7 MiB bundle
twice in one renderer and the second parse hits V8's in-process code cache; that variant is
measured separately as an attribution row (T-25-01d) and is roughly half the cold figure. The API
is warm, because the catalog is resident after boot (SDD §11) and a cold-boot figure would be
measuring `readFileSync` of `meals.json`, which no user experiences.

**Runs.** Three, each in its own fresh context.

**Build.** The Expo web export at `apps/mobile/dist`, served by `e2e/serveExport.mjs`.

**Confounds, and one prediction that the measurement refuted.**

- `e2e/serveExport.mjs` sends `Cache-Control: no-store` and no compression of any kind, against an
  export of 4.3 MB whose main bundle decodes to 1710 KiB. The prior methodology work predicted this
  would dominate the figure and make it describe the fixture rather than the app. **Measured, it
  does not:** the bundle's whole transfer is 13–16 ms of a ~215 ms total, because the server is on
  loopback. The sub-figure is reported anyway (T-25-01a/b) so the split is on the record, but the
  harness is not the dominant term and compression would not change the verdict. The file must
  still not be changed to flatter a measurement.
- The figure excludes browser process launch. There is **no native figure** — no instrument and no
  harness exist for the native build, and the web figure must not stand in for it.
- Under `AI_FAKE=true` with `aiEnabled: true`, the explanation lane runs a deterministic echo. See
  `measurements.md`'s limitation L-1: on a machine with a warm model this figure would be larger by
  the explanation step, and PRD §10.1's own explanation row puts that at ~5 s.

**What would make the figure a lie.** Ending the boundary at `home-period`; measuring the second
navigation in a warm renderer and calling it app start; running without pinning the viewport.

---

## 2. T-25-02 — local navigation, search, filtering (PRD §10.1, ≤ 150 ms)

**The qualifier "over the meals already loaded" is load-bearing, and of the three operations the
row names, exactly one is local.** `apps/mobile/src/features/catalog/exploreFilters.ts:8-10` states
the design outright — "No filtering logic lives here. The chips choose parameters; the server
filters, through the domain" — and `useMealSearch.ts` debounces the text 300 ms and then issues
`client.listMeals` over HTTP. `SavedScreen.tsx` has no search box at all. So the row is split:

### 2a. Navigation — the one measured against 150 ms

**Observable.** The destination screen's root test id (`home-screen`, `explore-screen`,
`assistant-screen`, `saved-screen`, `settings-screen`) having a client rect.

Keyed on `getClientRects().length > 0` and **not** on the node's presence: a visited tab screen
stays mounted and is hidden by a `display: none` ancestor, so a presence-keyed boundary would fire
on the first visit and never again.

**Boundary events.** Capture-phase `pointerdown` on the tab control → the `requestAnimationFrame`
after the destination first has a rect, so the figure includes one frame of paint. rAF granularity
is ~16.7 ms, which is 11 % of this budget, and it is **not subtracted**.

**Runs.** Three sessions of **ten** taps each, cycling all five tabs; each session reports its own
median, and Part 4's median-and-worst is taken across the three session medians. Three single taps
would not do: one garbage-collection pause or one missed frame is 16–50 ms, a third of the budget,
so three samples would disagree with each other by more than the quantity under test. A warm-up lap
of every tab precedes each session, so no sample pays a first lazy mount.

**Warm.** The app at the `app` boot phase, every tab already visited once, `aiEnabled: false`.

### 2b. Search — not local, and no document sets a figure for it

Reported as two parts that **must never be summed and quoted against 150 ms**: last keystroke →
request dispatched, which is `SEARCH_DEBOUNCE_MS = 300` (SDD §11) and is a design constant rather
than a latency; and request dispatched → rows painted, which is a round trip.

Typed with `pressSequentially`, not `fill`: `fill` sets the value and dispatches one input event
with no keydown at all, so there would be no keystroke to measure from.

### 2c. Filtering — the same round trip, measured in both states

Two rows, because the delay is keyed on something other than what the docstring claims. See
`measurements.md`'s F-1.

**What would make the figure a lie.** Measuring keystroke-to-results and reporting it against
150 ms: it would miss by construction, because the deliberate debounce alone is double the budget,
and Part 5 would then freeze a false limitation into the record permanently. The inverse lie is
just as available — measuring only tab navigation and titling the row with PRD's full wording, so a
reader believes search was measured at 150 ms.

---

## 3. T-25-03 — recommendations without AI (PRD §10.1, ≤ 2 s)

**"Without AI" is two states and the record names which one.** Either `aiEnabled: false` in the
request body — the user's own switch, sent from preferences by `useRecommendations` — or
`AI_ENABLED=false` on the server. The figure is the **former**, because it is the state a user can
actually put themselves in, and because the server-level flag additionally suppresses the chat route
and so measures a different product.

**Three figures, because they answer different questions.**

| Figure                        | Boundary                                                                              | Instrument                                               |
| ----------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| T-25-03 (the one against 2 s) | the page's `fetch` for `/api/v1/recommendations` leaving → third card in the document | in-page `fetch` wrapper + `MutationObserver`             |
| T-25-03s                      | wall clock around one `fetch`, body drained                                           | `node:perf_hooks` in `e2e/perf/apiLatency.ts`            |
| T-25-03t                      | the same requests as the server measured them                                         | `durationMs` from TSD §5.8's structured request log line |

The bundle download and parse are deliberately **outside** T-25-03's boundary: those are T-25-01,
and including them here would report app start twice under two different targets.

**Reading the server's own line is why `apiLatency.ts` starts a private instance.** Playwright owns
the stdout of a `webServer` it started; a child process the script spawned is one whose stdout it
can parse. That instance runs on a high port (4471) so a concurrent acceptance-suite run on 4000 is
never touched, and it is killed in a `finally`.

**Warm.** One request after boot is issued and **discarded** — it measured 21–45 ms server-side
against 5–6 ms for the measured three, so averaging it in would produce a "warm" figure that is
neither warm nor cold.

**Confound found by measurement.** The first draft read the log lines immediately after `fetch`
resolved and took the last three. The line is emitted on the response's `finish` event, which fires
_after_ `fetch` resolves, so the slice contained the warm-up plus two runs — and reported a server
duration of 32 ms against a client wall clock of 11.4 ms, which is impossible. A figure that cannot
be true is the useful kind of wrong. `waitForDurations` now blocks until the expected count arrives.

**What would make the figure a lie.** Taking it with `aiEnabled: true` and calling it "without AI";
or including app start.

---

## 4. T-25-04 — warm chat latency and the 30 s timeout (PRD §10.1)

**There is no model on this machine.** Nothing listens on 11434 and `gemma3:4b` is not installed.
So PRD §10.1's row splits into one figure that is measurable and one that is not, and the two are
kept strictly apart.

### 4a. The ~11 s warm figure — UNMEASURED

Not measured, and **not approximated**. `AI_FAKE` replaces only the HTTP call to Ollama with a
deterministic echo, so a latency taken under it is the latency of the echo. It cannot be corrected
for, scaled, or annotated into usefulness. A number produced that way and presented as a model
latency would destroy the only thing this phase exists to produce, so none is produced.

The one adjacent figure that _is_ reported — T-25-03u, the recommendations path with
`aiEnabled: true` under `AI_FAKE` — is labelled a **lower bound** for the same reason: the prompt
build, the schema validation and the containment run; only inference is missing.

### 4b. The hard 30 s timeout — measured, against the real provider path

**Observable and boundary.** `POST /api/v1/chat` leaving → the response arriving. Measured twice:
wall clock at the socket, and `durationMs` from the lane's own TSD §5.8 AI log line.

**The injected delay.** `AI_FAKE=false` and `OLLAMA_BASE_URL` pointed at a stand-in
(`e2e/perf/chatTimeout.ts`) that accepts `POST /api/generate` and **never answers**. The delay is
therefore unbounded and past the budget by construction — and it does not depend on `AI_FAKE` being
able to stall, which it cannot. Everything downstream of the socket is the shipped code:
`createOllamaClient`, `createAiLane`'s single-flight timer, `outcomeForFailure`, `chatFailure`,
`app.ts`'s error handler.

**Three claims, not one**, and each is checked separately:

1. the request **ends** — it is not a hang;
2. it ends at approximately the configured budget;
3. it ends as HTTP 503 `ai_unavailable` **and** the AI log line reads `outcome: "timeout"`.

Claim 3's log line is what proves the provider was reached. `chat.ts` returns at step 2 when nothing
is eligible and at step 3 when the resolver cannot answer, and on both of those paths the provider
is never called at all — a question that took either would answer 200 with no AI line, and would
look like a pass to anything checking only that an error appeared. The question used is a
superlative (PRD §7.4's answerable shapes), and the log-line assertion is what makes that an
observation rather than a hope.

**30 s is a DEADLINE, not a budget, and `stats.ts` distinguishes the two.** A request that ends at
30.03 s has behaved exactly as specified; printing MISS for it would be as dishonest as rounding a
real miss into a pass, in the other direction. The tolerance is **±1000 ms** and it is a judgement
stated rather than a figure read out of a document — no document sets one. It is two-sided on
purpose: a request that ended at 3 s would mean something other than the budget fired.

### 4c. The user-visible state — measured, and it is the _right_ state

`e2e/perf/chatTimeout.perf.spec.ts`. The client's deadline is 35 s
(`ROUTE_TIMEOUTS_MS.ask`) and the server's is 30 s, and **the ordering is the assertion.** If the
client gave up first, `failureFor` would map its own `timeout` to the **offline** failure
(`useAssistant.ts:147-148`) and the user would be told the server could not be reached, when the truth
is that the model ran out of time — a different message for the same event, and one that sends them
to check their connection.

So two arms, injected with `page.route`: a 31 s stall (past the server's budget, inside the
client's) must produce the `unavailable` surface; a 36 s stall (past both) must produce `offline`.
The boundary is the `-failure` **wrapper** `AssistantTurnRow.tsx:165` renders around whichever of
the six surfaces applies, not the expected surface itself — a boundary that only fires on the
expected outcome is one that cannot report the unexpected one.

"Does not hang" is asserted three ways, each of which would survive the loss of the others: no
`role="progressbar"` anywhere on the page, `aria-busy="false"` on the Ask button, and the button
enabled.

---

## 5. What else was running

Eleven other agents were working in this repository concurrently, four of them able to run the
acceptance suite. That is a real confound and it is **measured rather than asserted away**: the
whole lane was run under two load conditions — 19 concurrent `node.exe` processes and 1 — and both
sets of figures are in `measurements.md`. They agree to within a few milliseconds on every row, so
concurrency is not the dominant term for any of them.

One run was interrupted: the concurrent `node.exe` count fell from 19 to 1 mid-measurement and the
`chatTimeout.ts` process was terminated between its figure and its probes. The figure it had already
completed agrees with the two later runs to within 7 ms. Recorded because an unexplained exit code
in a measurement lane is exactly the thing a later reader would otherwise have to guess about.

## 6. Reproducing

From the repository root, with `apps/mobile/dist` already built by `npm run build:web`:

```
cd e2e && npx playwright test --config perf/perf.config.ts --project=phone-375
```

and then, back at the repository root:

```
npx tsx e2e/perf/apiLatency.ts
npx tsx e2e/perf/chatTimeout.ts
```

Those are the commands that produced `measurements.md`, written out rather than wrapped in a
script: `package.json` is spine and this lane does not own a row in it.

The Playwright invocation starts and stops both servers. The two scripts each start and stop their
own private instances on ports 4471–4475 and 11491–11492. Nothing is left listening; the run's own
environment check at the end is what confirms it.

`--project=phone-375` is not optional. An unpinned run would take its sample from whatever projects
the config happens to carry.
