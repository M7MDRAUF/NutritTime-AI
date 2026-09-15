# T-25-02 — what is local, what is a round trip, and what PRD §10.1 asks for

Taken 2026-09-14, second pass. **`measurements.md` and `method.md` in this directory are the first
pass and are not restated here.** That pass measured local tab navigation at **13.0 ms median /
17.1 ms worst against ≤ 150 ms — PASS** and established that neither search nor filtering is local.
This file answers the question that left open, which is the one §10.1's wording actually poses:

> _"Local navigation, search, filtering | ≤ 150 ms **over the meals already loaded**"_ — `PRD.md`,
> the table under "10.1 Speed".

**Is there any boundary in this build that happens over the meals already loaded?** Establishing
that, rather than assuming it either way, is what this pass is for. `R-59` applies here as it
applies to every figure in this directory: these numbers describe one Windows 11 machine, an Expo
web export served over loopback, with about fifteen other agents writing this tree at the time.

**Plan P25 Part 5:** a missed target is a known limitation, never a relaxed target. Nothing below
is rounded, nothing below is asserted against a target no document sets, and one figure this lane
took is **withdrawn** rather than reported, in §2c.

---

## 1. What is actually local — established, not assumed

Four boundaries in the Explore path involve no network at all, and none of them is the same thing
as "search" or "filtering":

| #       | Boundary                                                               | Local?                                                    | Why                                                                                                                                                               |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-0** | tab `pointerdown` → destination screen's first painted frame           | yes                                                       | measured by the first pass; React Navigation swaps a mounted subtree                                                                                              |
| **L-a** | filter chip `pointerdown` → the chip's own `aria-checked` flip         | yes                                                       | `ExploreScreen.tsx`'s `setFilters` → `toggleChip` → `isChipSelected` → `Chip`'s `aria-checked`. Pure React state; no request is in the interval                   |
| **L-b** | keystroke `keydown` → the "Clear search" control's first painted frame | yes                                                       | `SearchField.tsx` renders that control only when `value !== ''`, so the first character into an empty box is a local re-render observable from outside            |
| **L-c** | `fetch` settled → the new `meal-*` rows painted                        | yes, **and the closest boundary here to §10.1's wording** | the server has already answered; what remains is body read, `zod` validation in the api client, and `FlatList` building `initialNumToRender = 8` of a 20-row page |

**And what is NOT local, which is the answer to the row as written.**
`apps/mobile/src/features/catalog/exploreFilters.ts` says it in its own header — _"No filtering
logic lives here. The chips choose parameters; the server filters, through the domain."_ A chip tap
produces a `MealQuery` and `useMealSearch` issues `client.listMeals` over HTTP. There is **no code
path in `apps/mobile` that narrows a list of meals the device already holds.** So:

- **the chip's own state is local; the filtering is not.**
- **the keystroke's echo is local; the search is not.**
- **the render of a page of meals is local; obtaining that page is not.**

`SavedScreen.tsx` — the one screen whose meals genuinely are on the device — has no search box and
no local narrowing either (`filter(` occurs zero times in it), so it offers neither of the two
operations the row names.

---

## 2. Figures

Three runs, median and worst across them (P25 Part 4). Every boundary is stamped **inside the
page** by `e2e/perf/instrument.ts` rather than around a Playwright assertion — the first pass's
reasoning, adopted unchanged so these numbers are comparable with `measurements.md`'s. Spec:
`e2e/perf/interaction2.perf.spec.ts`. Conditions for every figure below: Expo web export in
`apps/mobile/dist` as built **17:28:51**, served by `e2e/serveExport.mjs` on 19006; API on 4000
with `AI_FAKE=true`; viewport **phone-375**; `aiEnabled: false`; warm app; both servers started and
stopped by this lane; nothing else driving Playwright; 7 concurrent `node.exe`.

### 2a. Local — measured against ≤ 150 ms

| Id       | Boundary                                                                    | Target | Runs (ms)                         | Median   | Worst    | Verdict  |
| -------- | --------------------------------------------------------------------------- | ------ | --------------------------------- | -------- | -------- | -------- |
| T-25-02i | filter chip: `pointerdown` → its own `aria-checked` flip, painted           | 150    | 11.4, 10.6, 11.5                  | **11.4** | **11.5** | **PASS** |
| T-25-02j | search keystroke: `keydown` → clear control painted                         | 150    | 9.5, 11.5, 9.4                    | **9.5**  | **11.5** | **PASS** |
| T-25-02k | `fetch` settled → new meal rows painted (**the "already loaded" boundary**) | 150    | 10.5, 15.8, 11.6, 16.7, 8.3, 18.0 | **11.6** | **18.0** | **PASS** |

T-25-02i is three sessions of five taps, alternating the chip on and off — fifteen taps spanning
**8.7 to 13.1 ms**. T-25-02j is three sessions of five keystrokes with the box emptied between
them, spanning **3.3 to 14.9 ms**. T-25-02k is six samples, two per session.

The `pointerdown` → `pointerup` gap the driver itself contributes is **0.60 ms** median and sits
**inside** T-25-02i rather than being subtracted from it. rAF granularity (~16.7 ms) is likewise
not subtracted, which matters more than the figures do: **all three medians are smaller than one
frame**, so what T-25-02i/j/k really establish is that each of these boundaries completes within
the first frame after the event, an order of magnitude inside the budget.

**A PASS here is not a PASS for the row.** T-25-02i and T-25-02j are the local halves of a filter
and a keystroke; the operations §10.1 names are the composites in §2b. T-25-02k is the only one of
the three that is work over meals the page holds, and even it begins when the server's response
headers arrive — so it is the app's own cost of a page it was just handed, not the cost of
narrowing a catalogue that was already there. See §4.

### 2b. Round trips — measured, labelled, and against no target

**No document sets a threshold for a server-side search or filter, and inventing one is out of
bounds.** P25 Part 5 forbids relaxing a target; it equally forbids manufacturing one. Each figure
is reported with its boundary named and **no verdict**.

| Id        | Boundary                                                       | Target | Runs (ms)           | Median    | Worst     |
| --------- | -------------------------------------------------------------- | ------ | ------------------- | --------- | --------- |
| T-25-02g2 | filter chip, box **empty**: `pointerdown` → rows painted       | none   | 30.8, 34.2, 28.6    | **30.8**  | **34.2**  |
| T-25-02h2 | filter chip, **text in the box**: `pointerdown` → rows painted | none   | 335.8, 333.9, 330.7 | **333.9** | **335.8** |

The first pass's split of the search path — **302.1 ms** of deliberate debounce plus **10.4 ms** of
round trip — is `measurements.md`'s T-25-02e/f and is not re-measured here. **Those two must never
be summed and quoted against 150 ms**: the debounce alone is double the budget, so a
keystroke-to-results figure misses the target by construction, and Part 5 would then freeze a false
limitation into the record permanently.

### 2c. Withdrawn — the paging figure, and why a negative number is worth more than a plausible one

`ExploreScreen.tsx` gained an `onEndReached` and a "Show more meals" button in this wave, closing
R-73's unreachable two thirds of the catalogue. **PRD FR-010's clause is _"Results page
locally"_** — and the implementation fetches page 2 over HTTP, so it belongs in §2b. This lane
measured it, got 29–31 ms across three runs, and has **withdrawn the figure**, because a fourth run
reported its render half as **−14.8 ms**.

A negative interval is not noise; it is the detector firing before the response. The shared
instrument stamps when the set of `meal-*` test ids **changes**, and pressing the footer re-renders
the list — the button goes `aria-busy` — so `FlatList` can reveal more of the twenty rows it
**already holds** before page 2 arrives. Both halves of that figure were therefore measuring
whichever of two events happened first, and in three runs of four the plausible one won.

A correct boundary needs a row **count** crossing twenty, which `instrument.ts` does not express
and which this lane may not add to it (that file is another agent's). Recorded as unmeasured rather
than reported at 30 ms. The same reasoning does **not** threaten T-25-02k: a chip tap replaces the
list's data and does not change the list's layout, its id set can only change when the new page
commits, and all eighteen samples across three runs were positive and inside 8–24 ms.

### 2d. Stability across runs — because three samples have no dispersion estimate

| Id        | run A (API not ours) | run B | run C | **run D (reported above)** |
| --------- | -------------------- | ----- | ----- | -------------------------- |
| T-25-02i  | —                    | 12.6  | 12.2  | **11.4**                   |
| T-25-02j  | —                    | 6.5   | 7.9   | **9.5**                    |
| T-25-02k  | 15.9                 | 10.8  | 19.1  | **11.6**                   |
| T-25-02g2 | 34.7                 | 31.0  | 46.1  | **30.8**                   |
| T-25-02h2 | 333.9                | 330.9 | 347.7 | **333.9**                  |

Four independent runs, medians in ms. **Run D is the one reported**, because it is the last run
after the last edit to the spec (BRIEF §6.1o's addendum: a measurement has a timestamp and an edit
invalidates it). Runs B, C and D each owned both servers and ran with nothing else driving
Playwright; run A's API was a sibling agent's process (see L-7) and its T-25-02i/j are absent
because that run predates those two boundaries. Every row agrees to within a few ms except
T-25-02k (10.8–19.1) and T-25-02g2 (28.6–48.6 across raw samples), and no verdict in this file
turns on which run is read.

---

## 3. The debounce defect — and it survived the rewrite that edited its own line

**A filter chip pays the 300 ms text debounce, and the docstring beside the line says it does
not.** `apps/mobile/src/features/catalog/useMealSearch.ts` reads:

```ts
const delay = trimmed === '' || page > 1 ? 0 : debounceMs;
```

The delay is keyed on whether the **search box holds text** (and on the page number), never on
**what changed**. Four lines above it, the same file says:

> _"So a filter change fires immediately and a text change waits, which is why the timer is
> declared here and set to 0 for everything but `search`."_

The measured pair is **T-25-02g2 at 30.8 ms** with an empty box against **T-25-02h2 at 333.9 ms**
with text in it, **for the same chip tap** — a difference of **303.1 ms** — and it reproduced on
every run of this lane and of the first one. A user who has typed a search and then taps a diet
chip gets exactly the experience the comment describes as broken, and **that is the difference
between passing and missing 150 ms for anyone who has typed.**

**Which version was measured, because the file changed three times while this was being taken.**

| When                     | `useMealSearch.ts` sha256 | The delay expression                            | The docstring                                      |
| ------------------------ | ------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| before this wave         | `c06ff9a9…725a1c2d`       | `search.trim() === '' ? 0 : debounceMs`         | claims a filter change fires immediately           |
| paging rewrite, 17:18    | `5b36c737…bd95874f`       | `trimmed === '' \|\| page > 1 ? 0 : debounceMs` | same claim, plus a new paragraph exempting page 2+ |
| 17:28:55                 | `115417c4…07d3d61`        | unchanged from the row above                    | unchanged                                          |
| current at writing 17:33 | `cda581ec…f9c90907`       | unchanged from the row above                    | unchanged                                          |

The reported figures are against the export built at **17:28:51**, so the measured bundle carries
the second row and the tree now carries the fourth. **The delay expression is byte-identical across
rows two to four**, which is why one measurement covers all three; the line has moved from `:110`
to `:251` to `:260`, which is why it is quoted here instead of cited (§6.1q).

So the defect **survived the rewrite that edited its own line.** The paging work extended the
exemption list from one case to two, reasoned explicitly in a new docstring paragraph about which
changes should skip the wait — _"A page request is not typing either"_ — and still did not add the
filter case the same docstring has claimed since P13. That is §6.1j's mechanism caught in the act:
the comment explains the intent so confidently that two authors in a row stopped looking at the
condition.

**This lane did not fix it.** `apps/mobile/**` is outside its write scope and that file belongs to
the paging agent this wave. Filed as F-6 in §6.

---

## 4. The row versus the architecture

**PRD outranks everything here, so this is a divergence to record and not a document to edit.**

§10.1's row describes an architecture the build does not have. Of the three operations it names one
is local (navigation), and the qualifier _"over the meals already loaded"_ is satisfied by **no**
search or filter path in the app, because none exists. SDD §11 — the lower document — already
describes the design that contradicts the higher one: _"Search debounces at ~300 ms, and a stale
request is aborted when the query or screen changes."_ And PRD FR-010's own _"Results page
locally"_ is implemented as a page request to the server (§2c).

**There is no register row for this.** Read at 17:36 and again at 17:46 today, both times the
same: `Plan.md` §7.3's conflict register ends at **X-49** and §23's risk register at **R-78**, and
`already loaded` occurs **zero** times in `Plan.md`. Neither register contains a row about §10.1's
locality assumption: searching for `150 ms`, `server filters` and `not local` returns only
T-25-02's own two task rows, which moved from lines 1441 and 2608 to 1442 and 2609 between those
two reads — §6.1q, in the ten minutes it took to write this paragraph. The nearest existing rows are **X-48** (two
_other_ rows of §10.1 that cannot both hold, also a Performance Engineer / user-decision row) and
**R-73** (FR-010's _"Results page locally"_ clause having no implementation — half-closed by this
wave's paging, which implements paging but not locally). **This lane may not edit `Plan.md`**, so
the row is proposed rather than filed:

> **X-50 (proposed).** PRD §10.1's _"Local navigation, search, filtering ≤ 150 ms over the meals
> already loaded"_ describes a local catalogue the app does not implement.
> `apps/mobile/src/features/catalog/exploreFilters.ts` states the opposite in its header — _"No
> filtering logic lives here. The chips choose parameters; the server filters, through the
> domain"_ — and `useMealSearch.ts` debounces the text and then issues `client.listMeals` per
> settled query, so every search and every filter is a round trip. PRD FR-010's _"Results page
> locally"_ is implemented the same way. **Certainty:** certain, read from both files and measured
> (`docs/performance/interaction.md` §1–§2). **Impact:** the row cannot be given a verdict as
> written; only navigation and the local sub-boundaries in §1 can, and all of those pass by an
> order of magnitude. **Resolution:** the user decides whether §10.1 means the app should hold the
> catalogue and narrow it on the device — a real architectural change, and one TSD §4.7's "one
> implementation, two callers" rule argues against, because a screen that narrowed its own list
> would be a third source of relevance — or whether the row should say what the build does and set
> a separate, stated budget for a server-backed query. **Relaxing 150 ms is forbidden either way**
> (P25 Part 5); stating which reading is intended is not. Owner: Performance Engineer /
> **user decision**.

---

## 5. Sensitivity probes — every figure can move, and one of them must not

A timing harness that reports a constant is the performance lane's version of a test that cannot
fail. Every injection is at **load time** — `page.addInitScript`, `page.route`, or a CDP throttle
on the context — and **no repository file was opened for writing at any point** (§6.1i). Both arms
of every probe pass through the same `page.route` interceptor, so the difference between them is
the injected stall and not Playwright's interception overhead.

| Figure    | Injection                                                | Baseline | Probed    | Moved      | What it proves                                                 |
| --------- | -------------------------------------------------------- | -------- | --------- | ---------- | -------------------------------------------------------------- |
| T-25-02i  | 80 ms synchronous stall inside the stamped `pointerdown` | 11.3     | 87.4      | **+76.1**  | the local figure answers to local work                         |
| T-25-02i  | **250 ms on every `/api/v1/meals` request**              | 11.3     | 11.0      | **−0.3**   | **it does not answer to the wire — the locality claim itself** |
| T-25-02g2 | the same 250 ms, on the composite path                   | 30.8     | **289.8** | +259.0     | the wire moves the round trip, in the same session             |
| T-25-02k  | **8× CPU throttling** (Chromium CDP)                     | 12.8     | 265.8     | **+253.0** | the render figure answers to the CPU                           |

**Rows two and three are the strongest of the set**, because together they move nothing and
everything: the chip's own state is unmoved by a 250 ms wire delay that pushes the composite path
from 30.8 ms to 289.8 ms, measured in the **same browser session**. That is a control pair no
single constant satisfies, and it is what turns "the chip's own state is local" from a reading of
the source into a measurement. The 80 ms stall recovers 76.1 of its 80 ms on a 150 ms budget, so
the harness can distinguish a pass from a miss at the granularity the row needs.

**The CPU probe is also a limitation, stated here rather than buried.** Across four runs the
throttled list render measured **101.7, 238.5, 265.8 and 288.6 ms** — so it is both unstable under
throttling and, in three of four runs, **outside** the 150 ms that the same boundary passes at
11.6 ms unthrottled. PRD §10.1 names no device class, so this is not a miss against the row. It is
evidence that T-25-02k's comfortable pass is a statement about this CPU, exactly as R-59 warns, and
the honest reading of §2a is "inside one frame on this machine" rather than "inside 150 ms
anywhere".

**A harness bug this discipline caught.** The first version of T-25-02i reported a
`pointerdown`→`pointerup` gap of `0.0 ms`. That was not a measurement: the mark was absent for the
keystroke samples, where no pointer event exists, and the reader defaulted a missing mark to zero.
The mark is now **required** on a pointer boundary, so an absent one fails the run — which is how
the real gap (0.60 ms) became a number. That is BRIEF §6.2's second shape, a control that the
mutation it exists to catch passes, found in the measuring instrument rather than in the product;
§2c is the second instance in the same harness.

---

## 6. Findings to file

**F-6 (MAJOR — the first pass's F-1, re-measured in the rewritten file, and still open).** The
chip-pays-the-text-debounce defect, with its false docstring still attached, survived the paging
rewrite that edited its own line. The file is
`apps/mobile/src/features/catalog/useMealSearch.ts`; the numbers are §3's. A fix has to key the
delay on _what changed_ rather than on whether the box holds text, which means the effect must know
which dependency moved — a ref holding the previous `trimmed`, or two effects instead of one.
**Not fixed here:** `apps/mobile/**` is outside this lane's write scope and that file is another
agent's this wave. **And when it is fixed the docstring must be rewritten, not left** (§6.1j): it
currently argues _for_ the defect, which is the likeliest reason the defect has outlived two
authors.

**F-7 (MINOR — this closes the first pass's F-5).** `e2e/tsconfig.json`'s `include` is now
`["**/*.ts"]`, excluding only installed packages and Playwright's two output directories, so
`e2e/perf/**` **is** in the program and `npm run check` does typecheck this harness —
`npm run typecheck`'s last clause is `tsc --noEmit -p e2e`, and `npx tsc -p e2e --noEmit
--listFiles` names 14 files under `e2e/perf/`, `interaction2.perf.spec.ts` among them. F-5 in
`measurements.md` should be read as closed; that file is read-only to this lane and has not been
touched.

**F-8 (MINOR — a comment that reads like a fact about the query).** The first pass's spec documents
its step choices as _"60 meals, 19 vegetarian, 11 matching 'chick'"_. Counted directly out of
`packages/catalog/meals.json`: **60 meals, 19 tagged `vegetarian`, 9 tagged `vegan`, 0 tagged
both**. So 19 is right about the _tag_ and wrong about the _query_ — `packages/domain`'s diet
matrix maps a vegetarian user to `['vegetarian', 'vegan']` ("`vegan` satisfies `vegetarian`, but
`vegetarian` does not satisfy `vegan`"), so a `diet=vegetarian` request matches **28** records and
`total` after filtering is 28, not 19. Neither pass's figures depend on it — both detect a row
change by comparing test ids, not counts — but a settle written against "19 meals" failed on the
first attempt, which is how the discrepancy surfaced. Recorded because §6.1c's rule is that an
example is checked before it is used, and because `explore-list`'s `aria-label` has meanwhile
changed from `state.total` to `state.meals.length` (R-73's other half), so a reader reconciling
these two numbers in the DOM will now find a third.

**F-9 (MINOR — the shared row detector cannot see a paging append).** `e2e/perf/instrument.ts`'s
`rowsArmed` boundary fires when the `meal-*` id set changes, which a footer press can satisfy from
virtualization before the appended page arrives. §2c has the evidence. Whoever owns that file could
add a count-crossing boundary; this lane withdrew the figure instead of adding one to a file it
does not own.

---

## 7. Limitations

- **L-5. The row cannot be given a verdict as written, and no measurement will change that.** See
  §4. What is measured here is every boundary in the app that the row can honestly be read as
  naming; what is unmeasurable is a local search or filter over a loaded catalogue, because no such
  path exists.
- **L-6. Machine-specific, and the CPU probe says by how much.** Every figure is the Expo web
  export on one Windows machine over loopback. Under an 8× CPU throttle the local list render
  measured 101.7–288.6 ms across four runs, so §2a's passes are statements about this CPU (R-59).
  There is no native figure and no CI figure.
- **L-7. On one of the four runs the API was not this lane's own process.** The harness reuses, and
  never stops, a server another agent is already holding. On run A this lane's own API spawn found
  port 4000 taken, printed `port 4000 is already in use`, and exited; the health check was then
  answered by a sibling agent's `tsx` server. Same catalog, same route, same sources — but not the
  same process. **Runs B, C and D, including the reported run, started and stopped both servers
  themselves**, and the teardown lines (`STOPPED web on port 19006`, `STOPPED api on port 4000`)
  are in each log. Nothing was left listening: checked before and after every run.
- **L-8. Fifteen agents were writing this tree, and one run was destroyed by it.** A run taken
  while the export server on 19006 belonged to another agent died mid-flight with
  `ERR_CONNECTION_REFUSED` when that agent's server was killed — BRIEF §6.1m exactly — and its
  numbers are discarded rather than reported. Every reported run was preceded by a check for
  `chrome-headless-shell` processes and for listeners on 19006 and 4000, and the lane waited
  (twice, several minutes each) until both were clear.
- **L-9. The measured bundle is one build, and the tree moved around it.** `apps/mobile/dist` was
  rebuilt by another agent at 17:25 and again at **17:28:51**; every reported figure is against the
  latter, whose `index.html` mtime was identical before and after the run, so all three sessions of
  every figure loaded the same bytes. `useMealSearch.ts` was then edited twice more without a
  rebuild — §3's table reconciles the versions, and the expression under test is identical across
  them. `ExploreScreen.tsx` and `SearchField.tsx` were both edited in this wave and are in the
  measured bundle.
- **L-10. T-25-02i and T-25-02j are halves, not operations.** Neither is what a user calls
  "filtering" or "searching"; each is the part of one that happens without the network. They are
  reported against 150 ms because they are local and the row's target is for local work, and the
  verdict line in §2a says what it does and does not settle. Reading either as "filtering meets
  150 ms" would be the inverse of the lie the first pass refused — measuring only the local half
  and titling it with the row's full wording.
