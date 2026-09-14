# P25 measurements — PRD §10.1 against this build

Taken 2026-09-14. **Read `method.md` before quoting any number here.** Every figure carries what was
measured, from which event to which event, how many runs, warm or cold, which build, which viewport,
and what else was running; a figure lifted out of that context is a figure a later reader will
misread.

`R-59` applies to this file as it applies to a gate line: **these figures are machine-specific.**
They describe one Windows 11 machine with no Ollama installed, running an Expo web export over
loopback. Nothing here is a claim about another machine, about CI, or about the native build.

**Plan P25 Part 5:** a missed target is a known limitation, never a relaxed target. Nothing below is
rounded, and where the honest answer is "not measured" it says so.

---

## The four rows

| Row                                    | Target             | Median          | Worst           | Verdict                                                   |
| -------------------------------------- | ------------------ | --------------- | --------------- | --------------------------------------------------------- |
| **T-25-01** app start → usable Home    | ≤ 2 500 ms         | **204.1 ms**    | **207.5 ms**    | **PASS**                                                  |
| **T-25-02** local navigation           | ≤ 150 ms           | **13.0 ms**     | **17.1 ms**     | **PASS**                                                  |
| **T-25-02** search, filtering          | ≤ 150 ms           | —               | —               | **NOT APPLICABLE AS WRITTEN** — neither is local; see F-2 |
| **T-25-03** recommendations without AI | ≤ 2 000 ms         | **24.5 ms**     | **24.6 ms**     | **PASS**                                                  |
| **T-25-04** chat 30 s hard timeout     | 30 000 ms deadline | **30 021.3 ms** | **30 047.0 ms** | **BEHAVES** (+21.3 ms / +47.0 ms)                         |
| **T-25-04** warm chat latency          | ~11 000 ms         | —               | —               | **UNMEASURED** — no model on this machine; see U-1        |

"Worst" is the slowest of the three runs, per Part 4. The T-25-04 row is a **deadline that must
fire**, not a latency budget: ending at 30.02 s is the specified behaviour, and calling it a miss
would be as dishonest as rounding a real miss into a pass. Tolerance ±1 000 ms, a stated judgement —
no document sets one.

---

## Every figure, with its runs

All figures below are from one run of the whole lane on a **quiet machine** (1 concurrent
`node.exe`), taken against the harness exactly as committed. A second full sample under load is in
§Load.

### T-25-01 — app start to three recommendation cards

| Id       | What                                                                                         | Target | Runs (ms)           | Median    | Worst     |
| -------- | -------------------------------------------------------------------------------------------- | ------ | ------------------- | --------- | --------- |
| T-25-01  | navigation start → 3 cards, `aiEnabled: true` (AI_FAKE)                                      | 2 500  | 207.5, 204.1, 199.3 | **204.1** | **207.5** |
| T-25-01c | the same with `aiEnabled: false`                                                             | 2 500  | 199.7, 197.2, 199.6 | 199.6     | 199.7     |
| T-25-01a | sub-figure: navigation start → main bundle `responseEnd` (**harness**)                       | —      | 11.9, 13.1, 11.5    | 11.9      | 13.1      |
| T-25-01b | sub-figure: bundle arrival → 3 cards (**the app's own work**)                                | —      | 195.6, 191.0, 187.8 | 191.0     | 195.6     |
| T-25-01d | attribution: the _second_ navigation in one context (warm V8 code cache) — **not app start** | —      | 102.2, 100.8, 101.2 | 101.2     | 102.2     |

Main bundle: **1 711 KiB** decoded. Cold context, empty HTTP cache, one navigation, envelope seeded
from an init script.

T-25-01d is here because it is the number a naïve harness would have reported. The load-seed-load
sequence an e2e helper naturally produces measures the _second_ parse of the bundle in one renderer
and comes out at **half** the cold figure. It is not app start and is not offered as one.

### T-25-02 — navigation, search, filtering

| Id       | What                                                                      | Target | Runs (ms)           | Median   | Worst    |
| -------- | ------------------------------------------------------------------------- | ------ | ------------------- | -------- | -------- |
| T-25-02  | tab `pointerdown` → destination's first painted frame — **local**         | 150    | 13.0, 13.0, 13.0    | **13.0** | **13.0** |
| T-25-02  | the worst single tap within each session                                  | 150    | 17.1, 16.4, 16.0    | 16.4     | **17.1** |
| T-25-02e | search: last keystroke → request dispatched (**the deliberate debounce**) | none   | 302.1, 303.0, 301.9 | 302.1    | 303.0    |
| T-25-02f | search: request dispatched → rows painted (**round trip**)                | none   | 9.2, 10.4, 10.5     | 10.4     | 10.5     |
| T-25-02g | filter chip, search box **empty**: `pointerdown` → rows painted           | none   | 30.5, 31.6, 30.7    | 30.7     | 31.6     |
| T-25-02h | filter chip, **text in the search box**: `pointerdown` → rows painted     | none   | 314.3, 331.7, 330.9 | 330.9    | 331.7    |

Three sessions of **ten** taps each across all five tabs; the 30 taps together gave median 13.0 ms
and worst 17.1 ms. The first tap of each session is consistently 16–17 ms and the rest ~13 ms, even
though a warm-up lap of all five tabs precedes every session — so that first tap is a real and
repeatable cost of re-entering a session rather than a lazy mount, and it is what the "worst" row
above reports. Both figures are an order of magnitude inside the budget either way.

T-25-02e at 302.1 ms is `SEARCH_DEBOUNCE_MS = 300` (SDD §11) doing exactly what it was built to do.
It is **not** a latency and must never be summed with T-25-02f and quoted against 150 ms.

### T-25-03 — recommendations without AI (`aiEnabled: false` in the request body)

| Id       | What                                                                   | Target | Runs (ms)        | Median   | Worst    |
| -------- | ---------------------------------------------------------------------- | ------ | ---------------- | -------- | -------- |
| T-25-03  | user-observed: request dispatched → 3 cards rendered                   | 2 000  | 24.3, 24.5, 24.6 | **24.5** | **24.6** |
| T-25-03a | attribution: the HTTP round trip alone, as the page saw it             | —      | 17.1, 16.3, 17.2 | 17.1     | 17.2     |
| T-25-03s | server-side: wall clock at the socket, body drained                    | 2 000  | 9.4, 7.1, 5.8    | 7.1      | 9.4      |
| T-25-03t | the same three as the **server** measured them (TSD §5.8 `durationMs`) | 2 000  | 6.0, 6.0, 5.0    | 6.0      | 6.0      |
| T-25-03u | `aiEnabled: true` under `AI_FAKE` — **a floor, not a model figure**    | —      | 8.9, 5.8, 5.9    | 5.9      | 8.9      |

The discarded warm-up request measured **20 ms** server-side against 5–6 ms for the measured three,
which is why it is discarded.

T-25-03u is reported only as a **lower bound**: the prompt build, `explanationReplySchema` validation
and containment all run; inference does not. PRD §10.1 puts a warm explanation at ~5 s with a hard
12 s timeout, so nothing about T-25-03u constrains the AI-enabled path.

### T-25-04 — the chat timeout

| Id       | What                                                                            | Target          | Runs (ms)                    | Median       | Worst        |
| -------- | ------------------------------------------------------------------------------- | --------------- | ---------------------------- | ------------ | ------------ |
| T-25-04  | `POST /api/v1/chat`, stalled upstream → 503 `ai_unavailable`                    | 30 000 deadline | 30 047.0, 30 021.3, 30 019.5 | **30 021.3** | **30 047.0** |
| T-25-04a | the same three as the **lane** measured them (`outcome: "timeout"`)             | 30 000 deadline | 30 020.0, 30 018.0, 30 012.0 | 30 018.0     | 30 020.0     |
| T-25-04b | the 503 arriving → the `unavailable` surface painted (**the UI's own cost**)    | none            | 4.8, 4.6, 17.0               | 4.8          | 17.0         |
| T-25-04c | attribution: Ask pressed → failure surface painted (includes the injected 31 s) | —               | 31 027.6, 31 027.6, 31 028.8 | 31 027.6     | 31 028.8     |

**Not a hang, proven at both tiers.** Server side: all three runs ended with a response,
overshooting the 30 000 ms budget by a median of 21.3 ms and a worst of 47.0 ms, and every one of
them carried HTTP 503 `ai_unavailable` **and** an AI log line reading `outcome: "timeout"`. Browser
side: all three runs reached `assistant-turn-1-unavailable` with no `role="progressbar"` anywhere on
the page, `aria-busy="false"` on the Ask button, and the button enabled.

**And it is the right state.** A 31 s stall — past the server's 30 s budget, inside the client's
35 s deadline — produces the `unavailable` surface. Raising the stall to 36 s, past the client's own
deadline, produces `offline` at 35 011.4 ms instead, because the client fires first and `failureFor`
maps its `timeout` to the offline surface (`useAssistant.ts:147-148`). That ordering is the whole
reason `ROUTE_TIMEOUTS_MS.ask = 35_000` exceeds `OLLAMA_CHAT_TIMEOUT_MS = 30_000`, and it is now
measured rather than assumed.

---

## Sensitivity probes

Every figure was re-measured with a delay injected at load time — `page.addInitScript`,
`page.route`, or the environment of a server this lane spawned. **No repository file was written at
any point.** A harness that reports the same number under an injected stall is not measuring the
thing it claims.

| Row      | Injection                                                                   | Baseline      | Probed                           | Moved                                          |
| -------- | --------------------------------------------------------------------------- | ------------- | -------------------------------- | ---------------------------------------------- |
| T-25-01  | 600 ms stall on `**/_expo/static/js/**`                                     | 201.9 ms      | 814.8 ms                         | **+612.9 ms**                                  |
| T-25-02  | 80 ms synchronous stall inside the stamped `pointerdown` handler            | 13.2 ms       | 85.3 ms                          | **+72.1 ms**                                   |
| T-25-03  | 400 ms stall on `**/api/v1/recommendations`                                 | 24.8 ms       | 420.8 ms                         | **+396.0 ms**                                  |
| T-25-03s | a forwarding proxy that delays the request by 500 ms                        | 14.7 ms       | 523.6 ms                         | **+508.9 ms**                                  |
| T-25-04  | `OLLAMA_CHAT_TIMEOUT_MS` lowered to 4 000 against the same stalled upstream | 30 021.3 ms   | 4 033.5 ms                       | **−25 987.8 ms**                               |
| T-25-04  | upstream answering in 500 ms instead of never                               | 30 021.3 ms   | 523.7 ms, `outcome: "contained"` | a different number **and** a different outcome |
| T-25-04c | stall raised from 31 s to 36 s                                              | `unavailable` | `offline` at 35 011.4 ms         | a different **state**                          |

Both arms of each browser probe pass through the same interceptor, so the difference between them is
the injected stall and not Playwright's interception overhead.

The last three rows are the strongest of the set, because they move something other than a
magnitude. The T-25-04 budget probe shows the figure following the _configured_ deadline rather than
printing 30 000; the 500 ms upstream shows the harness distinguishing `timeout` from `contained`; and
the 36 s stall shows it distinguishing two different user-visible states. T-25-02g against T-25-02h
is the same shape at the interaction tier: a control pair no single constant satisfies — 30.7 ms and
330.9 ms for the same chip tap.

---

## Load — what else was running

The whole lane was run under two conditions, because eleven other agents were working in this
repository concurrently and four of them could run the acceptance suite. Rather than note the
confound and move on, it was measured.

| Row                     | 19 concurrent `node.exe` | 1 concurrent `node.exe` |
| ----------------------- | ------------------------ | ----------------------- |
| T-25-01 median / worst  | 210.3 / 211.8 ms         | 204.1 / 207.5 ms        |
| T-25-01c median / worst | 213.3 / 214.9 ms         | 199.6 / 199.7 ms        |
| T-25-02 median / worst  | 12.9 / 13.1 ms           | 13.0 / 13.0 ms          |
| T-25-03 median / worst  | 27.1 / 29.5 ms           | 24.5 / 24.6 ms          |
| T-25-03s median / worst | 7.1 / 7.6 ms             | 7.1 / 9.4 ms            |
| T-25-04 median / worst  | 30 028.5 / 30 042.9 ms   | 30 021.3 / 30 047.0 ms  |

Every row agrees between the two conditions to within a few milliseconds, and the differences do not
run consistently in one direction. Concurrency is not the dominant term for any figure here, and no
verdict in this file depends on which sample is read. The loaded sample is retained because "eleven
agents were running" is otherwise an excuse rather than a measurement.

One run was interrupted rather than merely slowed: the concurrent `node.exe` count fell from 19 to 1
mid-measurement and the `chatTimeout.ts` process was terminated between its figure and its probes,
exiting 1 with no diagnostic. The figure it had already completed (median 30 028.5 ms) agrees with
two later runs to within 7 ms. Recorded because an unexplained exit code in a measurement lane is
exactly the thing a later reader would otherwise have to guess about.

---

## Unmeasured — U rows

**U-1. T-25-04's warm chat latency (~11 s) is not measured, and it is not approximated.** There is
no model on this machine: nothing listens on 11434 and `gemma3:4b` is not installed. `AI_FAKE`
replaces only the HTTP call to Ollama with a deterministic echo, so any latency taken under it is
the latency of the echo — it cannot be corrected for, scaled, or annotated into usefulness. A number
produced that way and presented as a model latency would destroy the only thing this phase exists to
produce. **Obtaining this figure requires a real `gemma3:4b` and is a manual check**, and it is
registered nowhere in `Plan.md` §19.6 while the adjacent cold-model row is.

**U-2. Native app start.** No instrument, no harness, and Plan §21.3 puts the native build outside
CI as manual ("Native | `expo` development build | Manual, outside CI"). The T-25-01 figure is the
Expo web export and must not stand in for the native one.

**U-3. Browser process launch.** T-25-01 starts at the document's `timeOrigin`, so the cost of
launching the browser is outside it. On a phone that cost is real and is not reported here.

**U-4. `AI_KEEP_ALIVE=30m` residency.** Unverifiable without waiting the gap, and no run here waited
one. Stated so that no reader takes a passing chat figure as evidence for it.

---

## Findings — F rows

**F-1 (MAJOR). A filter chip pays the 300 ms text debounce, and the docstring beside the line says
it does not.** `apps/mobile/src/features/catalog/useMealSearch.ts:110` reads
`const delay = search.trim() === '' ? 0 : debounceMs;` — the delay is keyed on whether the **search
text** is empty, not on **what changed**. The docstring immediately above it says: "A chip tap is a
discrete, deliberate action and waiting 300 ms after one makes the interface feel broken — the chip
is visibly selected and nothing happens… a filter change fires immediately and a text change waits,
which is why the timer is declared here and set to 0 for everything but `search`." The measured pair
is T-25-02g at **30.7 ms** with an empty box and T-25-02h at **330.9 ms** with text in it, for the
same chip tap, and it reproduced on every run of this lane. So a user who has typed a search and then
taps a diet chip gets exactly the experience the comment describes as broken. The comment is the
likeliest reason this survived: it explains the line's intent so confidently that a reader stops
looking. This is a behaviour-and-comment divergence for the owning agent to resolve, not something
this lane may edit — `apps/mobile/**` is read-only to it.

**F-2 (MAJOR, already on the record). PRD §10.1's "local navigation, search, filtering ≤ 150 ms over
the meals already loaded" describes an architecture the app does not have.**
`apps/mobile/src/features/catalog/exploreFilters.ts:8-10` states it: "No filtering logic lives here.
The chips choose parameters; the server filters, through the domain." `useMealSearch.ts` debounces
the text 300 ms and then issues `client.listMeals` over HTTP. `SavedScreen.tsx` has no search box.
Of the three operations that row names, **only navigation is local**, and it is the only one measured
against 150 ms above. Search and filtering are reported as split figures with **no target asserted**,
because no document sets a threshold for a server-side search and inventing one is out of bounds.
A keystroke-to-results figure would miss 150 ms by construction — the deliberate debounce alone is
double the budget — and Part 5 would then freeze that false limitation into the record permanently.
PRD outranks SDD, so this is a defect to report rather than a document to edit, and SDD §11's own
"Search debounces at ~300 ms" is the lower document already describing the design that contradicts
the higher one.

**F-3 (MAJOR). PRD §10.1's app-start row and its explanation row cannot both hold in the app's
default configuration.** `DEFAULT_PREFERENCES` ships `aiEnabled: true`
(`apps/mobile/src/infrastructure/storage/definitions.ts:276`), so Home's request carries
`aiEnabled: true` by default. `apps/server/src/routes/recommendations.ts:282-288` awaits
`explain(...)` for each of the three selected meals **sequentially, before `response.json(body)`**,
so the response a user waits for contains the explanation step. PRD §10.1 puts a warm explanation at
**~5 s** with a hard 12 s timeout, and app start at **≤ 2.5 s**. Under the definition of "usable"
defended in `method.md` §1 — three recommendation cards present, which is PRD §7.1's "Return the top
three" — a default-configuration launch against a warm model therefore cannot meet 2.5 s, by PRD's
own figures. PRD §13's acceptance line for this path points the same way without settling it: "With
Ollama stopped, recommendations still return, with fallback explanations, **inside the budget**"
states the budget for the model-absent case and says nothing about the model-present one. **This is
not measured here and cannot be**: there is no model, so the measured T-25-01 figure of 204.1 ms
runs the explanation lane's deterministic echo and is optimistic against any machine that has one.
Recorded as an analytic divergence between two rows of one document, for the orchestrator to resolve
at PRD level — either by stating that the app-start target assumes AI disabled, or by stating that
"usable" means something earlier than the cards. Relaxing either figure is forbidden by Part 5;
stating which reading is intended is not.

**F-4 (MINOR). The prior methodology's central prediction about T-25-01 was wrong, and the
measurement is why we know.** It predicted that `e2e/serveExport.mjs`'s `Cache-Control: no-store`
and total absence of compression, against a 4.3 MB export, would dominate any app-start figure and
make it describe the fixture rather than the app — by "a margin comparable to the 2.5 s budget
itself". Measured: the main bundle's whole transfer is **11.9 ms** of a 204.1 ms total, because the
server is on loopback, where compression would cost CPU rather than save time. The prediction was
sound reasoning about a networked server and simply does not apply here. Recorded because the
mitigation it recommended — labelling the total a pessimistic upper bound — would have understated a
comfortable pass, and because the sub-figures that settle it (T-25-01a/b) were worth keeping anyway.

**F-5 (MINOR). `e2e/tsconfig.json`'s `include` does not cover `e2e/perf/**`, so this harness is
linted but not typechecked by the project gate.** `npx tsc -p e2e --listFiles --noEmit` lists **zero**
files under `e2e/perf/`. That is verbatim the defect the file's own comment records for `support/**`:
"A new support module no spec imports yet was outside the program altogether — ESLint saw the file,
`tsc -p e2e` did not." The harness typechecks clean under the same compiler options applied directly
(see this lane's report), but `npm run check` would not notice a type error in it — and it did
contain one, which only the direct invocation caught. `e2e/tsconfig.json` is spine; the one-line fix
is filed for the orchestrator.

---

## Limitations — L rows, for `Plan.md` §23

Part 5 requires a missed target to become a known limitation. **No target in PRD §10.1 was measured
as missed on this machine.** The limitations below are about the _coverage_ of the measurement rather
than a figure falling short, and they belong in the risk register for that reason.

- **L-1.** The warm chat latency (~11 s) and the warm explanation latency (~5 s) are unmeasured and
  unmeasurable without a real `gemma3:4b`. Every AI-path figure in this file is a lower bound taken
  under `AI_FAKE`. See U-1, and F-3 for what that means for T-25-01.
- **L-2.** Every figure is the Expo web export on one Windows machine over loopback. There is no
  native figure (U-2) and no CI figure. R-59's warning about machine-specific numbers applies to
  this file in full.
- **L-3.** The measured build is `apps/mobile/dist` as written at **2026-09-14 14:39:12**, and **23
  files under `apps/mobile/src` were modified after it** — among them the production files
  `AssistantScreen.tsx`, `AssistantTurnRow.tsx`, `MealDetailsScreen.tsx`, `DietarySetupScreen.tsx`
  and `register.ts`. Eleven agents were writing this tree concurrently. The export was deliberately
  **not** rebuilt: `apps/**` is outside this lane's write scope, and swapping the bundle would have
  broken any concurrent acceptance-suite run mid-flight. So the T-25-01, T-25-02 and T-25-04b/c
  figures describe the app as of that export, not as of the tree at the time of writing. A re-run
  once the wave's builds settle is cheap — the harness is committed and the commands are in
  `method.md` §6 — and is the right way to close this rather than treating these numbers as final.
- **L-4.** T-25-05 (cold-model 503-then-recover) and T-25-06 (failure injection) are **not** in this
  file. They are separate Plan rows and were not this lane's assignment; T-25-05 in particular needs
  a real Ollama to unload and is registered as manual in Plan §19.6. `reliability.md` in this
  directory covers those two rows and was written by another agent in the same wave; this file does
  not depend on it and has not been reconciled against it.
