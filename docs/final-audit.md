# NutriTime AI — Final Whole-Application Audit

**Phase:** P28 · **Verdict: CONDITIONAL GO** · conditions enumerated in part 15.

**Method.** Nine independent read-only auditors on disjoint questions, against the committed tree at
`34cc901`, none permitted to change a repository file. Their reports are the evidence behind every
claim here. The audit's own standard, from `Plan.md` §24: **no claim without evidence**, and _"no
bugs" and "no errors" are not permitted conclusions_ — the permitted conclusion is that all defined
gates pass, with residual risks named.

**What the audit found about its own subject, stated first because it sets the tone.** The nine
auditors found **six false claims in reports written the same day**, a **CRITICAL in the commit under
audit**, and **seven register rows carrying false text**. Three of the false claims were the
coordinator's, one of them inside the correction of an earlier false claim. That is the phase working
as designed: its Value line is _"the only phase whose job is to disbelieve the previous 27."_

---

## 1. Executive summary

The application is feature-complete against its own plan and every defined gate passes. It is not
release-ready without decisions, and two live defects are user-visible on the delivery surface.

| Gate                                      | Result                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `prettier --check .`                      | clean                                                                                   |
| `npm run lint`                            | exit 0                                                                                  |
| `npm run typecheck`                       | exit 0, **7 projects**                                                                  |
| `npm run test`                            | **119 files · 3142 passed · 1 expected fail · 2 skipped**                               |
| `npm audit --audit-level=high`            | exit 0 — 18 moderate, 0 high, 0 critical                                                |
| `npm run build:server` → boot → `/health` | **HTTP 200**, `{"status":"ok","catalogVersion":"1.0.0","mealCount":60}`, Ollama stopped |
| `npm run build:web`                       | exported — 4.3 MB, 19 files, single-page                                                |
| `npm run test:e2e`                        | **276 passed**, four viewport projects                                                  |
| `Plan.md` §17.1                           | **57 rows · 57 files · 0 drifted · 0 missing · 0 dead**                                 |

**Status:** 28 Completed · 11 Partial · 0 Not Started across P22–P27. The 11 Partials are the honest
part: each names what is missing rather than rounding up.

**The single most important finding** is not in the application. `.gitignore`'s bare `build/` matched
the directory holding `apps/server/scripts/stagePackages.mjs` — step 3 of `build:server` — so the
commit that closed R-69 **did not contain the fix**, `git status` stayed clean because an ignored
file is invisible rather than untracked, and on a clean clone the documented build command would have
failed outright. Closed at P28 (R-76). The transferable lesson: **a pre-commit sweep that looks for
files wrongly _included_ will never notice one wrongly _excluded_.**

---

## 2. Implemented scope

All 28 phases have terminal status. **14 of 15 functional requirements are traced to code and to a
test that would fail if the implementation were removed**; the fifteenth is part 3.

Delivered: a pure domain (`text`, `money`, `meal-period`, allergen lexicon and inference, diet
matrix, scoring, relevance, chat retrieval and resolvers); a 60-record validated catalog with USDA
nutrition derivation; an Express server with five endpoints, boot-time catalog validation, and
config read in exactly one file; an Expo/React Native app with ten screens, six storage keys behind
a versioned envelope with quarantine, and a navigator with three boot phases; a grounded assistant
whose answers the **domain** resolves and the model only phrases, behind four containment checks
plus a fifth guard; a web export with deep linking; a four-viewport E2E matrix; and a CI workflow.

**Requirement coverage was measured, not assumed.** For each FR the auditor asked what change to
production code would redden its test, and reported the answer. Strongest: FR-006 (nutrition
all-or-nothing, with a null/zero pair no single constant satisfies), FR-007's core allergen
exclusion, FR-015 (containment check 2).

---

## 3. Missing or incomplete scope

**FR-010's "results page locally" clause has no implementation and no test (R-73).**
`exploreFilters.ts` exports `queryFrom(search, filters, page = 1)`; `useMealSearch.ts` never passes
the third argument; `ExploreScreen.tsx` has no `onEndReached` and no page state. With
`EXPLORE_PAGE_SIZE = 20` against 60 records, **plain browsing reaches 20 of 60 meals.** Search and
the filter chips re-query and so surface other records — the meals are not lost, the _browse_ path
is bounded.

The same screen announces `accessibilityLabel={`${state.total} meals`}` — the **unfiltered 60** over
a 20-row list. Swapping to `state.meals.length` reddens **0 of 19**, because the test stub always
sets `total: meals.length`: a fixture drawn from the same shape as the code.

**The eleven Partial rows, each with its gap:** T-22-03 (9 of 10 deep-link paths; `/splash` is a
free choice, not an impossibility) · T-22-08 (bundle measured, lazy image loading not built) ·
T-23-01 (role/label audit — **its gap is named nowhere and its "Audit table" evidence does not
exist**; the hollowest row in the set) · T-23-03 (no screen rendered above `fontScale 1`, no
screenshots) · T-23-05 (focus half built on the meal form only) · T-23-07 (the tool's pre-delivery
checklist is not evidenced "in full") · T-24-03 (Explore excludes nothing — see part 6) · T-25-02
(search and filtering are not local, so the row does not describe this architecture) · T-25-04 (warm
chat latency unmeasurable without a model) · T-25-05 (3 of PRD §10.1's 4 cold-start claims) ·
T-26-01 (no Run URL can exist).

---

## 4. Out-of-scope items confirmed absent

- **`FS_N` (D-04)** — grepped across source, tests, docs, JSON and YAML: **absent**.
- **No dependency beyond TSD §2.1's pins.** Every declared dependency is installed at its declared
  version. One trap was checked and dismissed: root `node_modules/zod` is 4.6.4 against a 4.5.4 pin,
  which is a **hoisted dev/peer** while both declaring workspaces carry 4.5.4 nested.
- **No bundler.** R-69's fix declined `esbuild`/`tsup` as a stop condition, and `esbuild` remains
  only a transitive dependency of `tsx` and `vitest`.
- **No secret and no machine-local path** in any committed file. `.env` and `*.csv` gitignored; the
  USDA archive stays outside the repository, read by variable.
- **Hosting, blue/green and provider deployment** (A-06) — absent, as scoped.

---

## 5. Architecture compliance

**Five of the six `Plan.md` §12.2 dependency rules hold; rule 6 does not hold at source level. Two
of six are enforced such that a divergence would fail something.** That distinction is the finding —
a rule holding by luck and a rule holding by construction are different facts, and the audit was
instructed to report them separately.

**Cycles: 1 source cycle, 0 runtime cycles**, by Tarjan SCC over 306 files and 1016 edges, run over
all edges and over value edges separately. The cycle is
`saved/mealRecord.ts` ↔ `saved/mealFormValidation.ts`, harmless **only** because one side is
`import type` under `verbatimModuleSyntax`; making it a value import fails 0 of 292 tests, so nothing
would notice. Method limits stated: runtime-built specifiers, `node_modules`, Metro platform
extensions and the staged `dist` graph are out of reach. No graph tool was installed — that would be
an unpinned dependency.

**Duplicated domain logic — one instance where a divergence would be undetectable.**
`features/home/HomeScreen.tsx` holds a second, unimported copy of `packages/domain`'s
`MAX_RECOMMENDATIONS`. Changing it 3→4 fails **0 of 38**; 3→2 fails 5. No fixture ever supplies a
fourth recommendation, so the "no fourth card" guard's own case never runs.

`NUTRIENT_LIMITS` is also duplicated but **pinned both ways**. The failure-to-outcome mapping that
once existed in three copies with two already diverged is now one file with a hand-transcribed
table. **No production module duplicates a domain rule.**

**A staleness gap in the new build:** `stagePackages.mjs` throws when `packages/*/dist` is absent and
**never when it is stale**, and no gate executes `apps/server/dist/index.js`, so stale staged output
would ship green. Today the staged copy is byte-identical to source output, 18 of 18 files.

---

## 6. Contract compliance

**All five endpoints match their contract block** — `GET /health`, `GET /api/v1/meals`,
`GET /api/v1/meals/{mealId}`, `POST /api/v1/recommendations`, `POST /api/v1/chat` — verified field
by field, status by status, across 20 load-time mutations run one at a time against a 207-test
baseline.

**One divergence changes a response a user sees (R-74).** `meals.ts` bounds `query` at
`.max(100)`; `SearchField.tsx` sets **no `maxLength`** and `queryFrom` forwards the text unbounded.
So 101 pasted characters answer **400 `invalid_request`**, which the screen renders as Explore's
**error** state — not "no meals match" — with a retry that repeats the rejected request. The bound
itself is unpinned: deleting `.max(100)` reddens **0 of 173**, with a control on the same line
reddening 4, so the line executes and nothing asserts it.

**T-24-03 is Partial, and the reason is a citation the coordinator invented.** The acceptance reads
_"Peanut allergy excludes meals from Home **and** Explore."_ Explore excludes nothing — by design,
and PRD FR-007/FR-010/FR-011 back that design, while `TSD.md`'s "out of Explore" wording contradicts
both. The row was marked Completed on the reading that _"Explore lists the whole catalogue, so what
is asserted there is the notice, not absence"_ — **a sentence attributed to `Plan.md` that is not in
`Plan.md`.** The behaviour is right; the row's status was licensed by a fabricated quote and is now
Partial with the divergence recorded.

Minor: the name-sort tie-break in `meals.ts` is unreachable (zero normalised name collisions in 60
records); a dead 404 branch in `app.ts` with a comment that is false of the code; and `Plan.md`
§11.1's duplicate-submission row is false for the two AI endpoints, because one shared `AiLane`
makes a concurrent duplicate a 503 `ai_busy`.

---

## 7. Test and build evidence

Part 1's table is the full gate, executed in one sitting. Beyond it:

- **+368 tests** over P21's close (2774 → 3142); e2e **70 → 276** as the matrix went from two
  viewport projects to four.
- **The one expected fail** is R-53's `it.fails`, and **R-72's `test.fail(width < 768)`** is
  conditional so it asserts both halves — clipped below 768, whole at 768. Both were verified to
  still pin what they claim.
- **R-59 is closed on the gate itself**, measured in three states: archive present → 7 passed;
  absent with `CI` unset → 7 skipped, exit 0; absent with `CI=1` → **7 failed, exit 1**, each naming
  `USDA_DATASET_PATH`. No silent seven-test shortfall.
- **`e2e/perf/**` was linted but not typechecked** until P28 — the `e2e/tsconfig.json` include list
  had failed this way once before, for `support/**`. The list is gone; `tsc -p e2e` now sees 13 files
  there and is clean.
- **`npm run test -- a11y` matches no file** and appears twice in `Plan.md`, so **P23 cannot run its
  own Part 4 as written.** Executed: `No test files found, exiting with code 1`. The working command
  is in part 11.

---

## 8. AI / Ollama assessment

**T-28-06 passes. All four containment checks are live, reachable and order-pinned**, each with a
measured redden count, and every historically-loose part of check 4's coverage predicate reddens
independently. The two vacuity traps this module exists for were both re-probed: the empty-permitted-set
short-circuit reddens 5, and the `\b`-wrapped digit run — which once failed **0 of 75** — reddens 3.

**Prompts are clean.** No allergy parameter exists to pass: `ChatPromptInput` has two fields and tsc
enforces it. Appending allergen tags to a meal block reddens T-19-03's absence test. The boundary is
stated rather than glossed: the structured allergy list never enters a prompt, and the user's own
question does, by design.

**Logs are clean.** All five sink sites go through field-fixed builders, `AiLogFields` has no slot
for a containment rule or its evidence, and five separate leak mutations redden 2/6/4/22/1. The
`PRD §15.5` mis-citation that once reached 18 files has **zero live occurrences** — its last survivor
was removed this window, and the sweep now returns only negative statements about it.

**One MAJOR, structural rather than live (R-70).** The server-side denied-claim sweep is still a
hand-written list of three. All three of `CHAT_COPY`'s keys are on it, so nothing escapes today — but
a fourth key carrying _"Every meal I can show you is allergen free."_ fails **0 of 866** server
tests, with the mutation proved loaded. The mobile sweep was converted to a **walk** at P23 and
reddens the same mutation. **One half of the risk was fixed structurally and the other left in the
shape the risk is about.**

**And widening the sweep is not free (R-75).** `HomeScreen.tsx` ships FR-007's required _"This is not
medical advice."_, which `deniedClaimIn` **flags**, because negation is deliberately not an
exemption. Closing R-70 on both sides needs a vetted-exemption mechanism, not a wider net.

**A gap this phase closed (X-49).** An empty `citedMealIds` passed all four checks — check 1 only
asks whether a cited id is _outside_ the prompt's ids — so a resolved answer could ship with
`citations: []` against PRD §7.3. Reachable against a real model, since the per-request schema
constrains citation _values_ and not the array's length. **Unreachable under `AI_FAKE`**, whose echo
carries the domain's own citations by construction, which is why nine phases of evidence were
consistent with it. Guarded in the route, keyed on our data and never on `reply.answered`. Two costs
recorded: TSD §5.7's "four checks" is now five, and the guard **masks** check 1 at the route layer —
with check 1 dead alone the route suites stay green.

**Could not be verified, and is not claimed:** a real `gemma3:4b` pass; whether the nine `RULES`
clauses steer a model; the grammar `enum`'s upstream enforcement; warm latency. **No `AI_FAKE`
evidence backs any liveness claim in this section.**

---

## 9. UI/UX and design-system assessment

**T-28-07 is Partial. Colour literals: 0 violations. Both themes: pass, strongly. The checklist: 4 of
5 evidenced, focus Partial.**

Every colour hit outside the token layer is a comment, a compositor self-check, or a
prettier-ignored generator artefact kept as evidence of what the generator recommended. `mode` is a
prop and not a global read, and dark is authored rather than derived — both verified.

**Three MAJORs, all evidence gaps rather than user-visible defects:**

- **Nothing enforces the colour-literal ban.** Adding `'#FF00FF'` to a screen changes **0 of 1048**
  tests, with a control reddening. The tree is clean by discipline, not by gate.
- **The app's only rendered focus indicator is unpinned.** Setting `borderWidthFocused` to
  `stroke.hairline` deletes it and changes **0 of 1048**; the two assertions that look like they
  cover it read their expectation **out of the token** (§6.1g circularity).
- **`DECISIONS.md` §5 rejects the generator's `outline: none` on the reason that `focusRing` "is
  always visible and 3:1" — and `focusRing` has zero consumers** outside the token file. An invented
  rationale, which is exactly the failure mode T-27-03 exists to catch, and it is why the focus
  checklist item reads as run.

**`DECISIONS.md` otherwise holds:** no verdict lacks a reason, two gaps are honestly recorded as "no
reason recorded", and the two entries added this window keep a distinction that should not be
collapsed — streaming text was **adopted and is architecturally impossible** (`stream: false` is
fixed in TSD §5.5), while the dietary-setup error summary was **adopted and is simply unbuilt**. One
needs a decision; the other needs a commit.

TSD §6.7's inventory is verified at **sixteen** components. No seventeenth; a proposal to count a
`FlatList` was withdrawn once it was pointed out that a framework list primitive is not a §6.7
component.

---

## 10. Mobile-web assessment

**`Plan.md` §20 is not fully evidenced: 18 of 22 rows evidenced, 2 NOT MET, 2 unevidenced.** NOT MET:
`Semantic HTML` (part 11) and `Asset optimisation` (the eager-image finding in part 12).
Unevidenced: `Keyboard navigation` and `Soft keyboard`.

**T-22-07 is genuinely evidenced** — 11 surfaces × 4 widths = 44 measurements, 0 clipped
horizontally — and the observable had to be built, because the obvious one passes under the defect:
a button 216 px outside a 320 px viewport leaves `body.scrollWidth - clientWidth` at **0**.
react-native-web clips at **every `View`**, so the export's `body { overflow: hidden }` is only the
outermost layer — a mechanism both the config comment and the fleet contract had stated wrongly while
reaching the right conclusion.

The row's volunteered caveat that "the app branches on width nowhere, so the matrix is four
measurements of one tree" **understates its own evidence**: `@react-navigation/bottom-tabs` branches
at 768 internally, which is precisely how R-72 hides at the widest width.

**R-44 is closed** — a query-param deep link now lands on its screen with the URL kept, re-measured
independently against a live rival `ui.lastTab`, and the `test.fail` that pinned it is gone.
**R-51 and R-53 were both wrong in the safe direction**: the web driver turns a quota refusal into a
rejection, so the write-latch is impossible on the export and the reset race is native-only.

---

## 11. Accessibility assessment

**`Plan.md` §23 is not fully evidenced, and two defects are user-visible.**

- **R-50: there is no error boundary anywhere in `apps/mobile`.** Measured: zero
  `componentDidCatch`, `ErrorBoundary` or `getDerivedStateFromError` in source; `App.tsx` has no
  class component at any level. **Any throw during render unmounts the whole tree, which on the web
  is a white page with no control and no route back.** P22's own plan called an `ErrorBoundary`
  around the navigator _"this phase's most valuable single task"_ — and `docs/phase-reports/P22.md`,
  written by the coordinator, **never mentions it.** That omission is this audit's clearest
  self-indictment.
- **R-77: no `main` landmark on any screen.** Zero `role="main"` in the built export, against one
  heading on Home. A screen-reader user has no skip-to-content target and must traverse the tab bar
  and header on every navigation. This is why §20's `Semantic HTML` row is NOT MET.
- **R-73's false announcement** (part 3) — "60 meals" over a 20-row list.
- **Four assertive alerts with no lede** on a refused Save on the onboarding form.
- **R-72** — five tab labels clipped at 320/375/414 px. The audit re-measured the gap as
  **`needed 14 / given 10`**; the register row said 12/10, so **four pixels are lost, not two**. A
  third remedy nobody has measured exists: `tabBarLabelPosition: 'beside-icon'`, the variant that
  already works at 768.

**Contrast coverage excludes the navigation chrome.** `navigation-contrast.test.ts`'s slot list is
four hand-written entries against 12 `colors.*` references under `navigation/`, with no derivation
guard — the same "a missing row looks like a passing one" hole its two neighbours were rewritten to
remove, in the file written for that very defect. The audit then measured the pixels anyway:
**7.68/7.58 light, 10.72/6.43 dark, all ≥ 4.5 at every width.** The fix does land; the guard is what
is thin.

**X-47's premise was false and the correction shrinks it.** `.focus(` has **zero** occurrences in any
production file; it appears only in tests, and one test names a `.focus()` on the summary as the
mutation it probes **against**. So neither form moves focus, the Plan's "preserved on validation
failure" is honoured everywhere, and the difference between the two forms is **the summary alone** —
a commit, not a ruling. The coordinator supplied the false half by relaying another report's claim
without measuring it.

**The working accessibility command**, since the documented one matches no file:

```bash
npx vitest run apps/mobile/src/shared/theme/{contrast,component-contrast,navigation-contrast,contrast-exemptions,touch-target,typography}.test.ts
```

**6 files / 476 passed.**

**Not dischargeable here:** the manual screen-reader traversal of the five tabs that §23 requires.
No screen reader exists on this machine and it was not approximated.

---

## 12. Known defects and limitations

**User-visible, open:**

| Id   | Defect                                                                                   |
| ---- | ---------------------------------------------------------------------------------------- |
| R-50 | No error boundary — any render throw is a white page on the web                          |
| R-73 | 20 of 60 meals reachable by browsing; the list announces 60                              |
| R-77 | No `main` landmark on any screen                                                         |
| R-74 | A 101-character search shows a server error with a retry that cannot succeed             |
| R-72 | Five tab labels clipped at all three phone widths (`needed 14 / given 10`)               |
| R-61 | Four failure branches a user can reach that nothing asserts; 11 of 129 testIDs unqueried |

**Structural, no live defect:** R-70's server-side sweep shape · R-75's exemption problem · the
unpinned colour ban and focus indicator · the unenforced `camelCase` convention · the
`MAX_RECOMMENDATIONS` duplicate · `stagePackages.mjs`'s staleness gap.

**Twelve stale or false comments**, the worst being a surviving copy of the false
_"react-native-web 0.21 maps neither from the other"_ claim in the **newest** file of the group —
copied forward _after_ the fix round, which is how a retracted rationale propagates. Two production
`as` casts are holes; three non-null assertions carry no reason and **`no-non-null-assertion` is not
in the ESLint config**, so `eslint 0` cannot see them. And `eslint.config.mjs` contains an actual
`'no-console': 'off'` for test files — the exact mistake the file forbids in bold three times over,
currently costless because the tree has no `console.debug` or `console.trace`.

**Seven register rows were found to carry false text this window** — R-44 (symptoms and its own
marker type), R-46, R-51, R-53, R-55 (count _and_ its justification, then a third clause), R-62 (two
undercounts, then wrong line numbers in its own correction), R-72's figure. **A risk row is a
hypothesis with a date on it.**

---

## 13. Technical debt

- **Two plan documents and one ambiguous citation style.** "Plan §N" is ambiguous between `Plan.md`
  and the execution plan, and it caused three of the coordinator's six citation errors. Worse:
  briefs cited **`TSD.md` §11** and **`TSD.md` §12.2** for the contract blocks and the dependency
  rules, and **TSD has neither section** — both live in `Plan.md`, the lowest-ranked document, which
  inverts every "which side is wrong" judgement built on them.
- **Line-number citations into living documents.** Corrected in code, still present in two e2e files
  where all nine have expired by +11, and once inside a register row's own correction.
- **`Plan.md` §22's traceability matrix is wrong in four places**, including two test files that do
  not exist — one differing from the real file only in case, so it resolves here and **fails on a
  case-sensitive runner**.
- **R-61's mitigation defers to `AX3-DEADCODE.md`, which is not in the repository** — it exists only
  in a different session's scratchpad. A register row pointing at an enumeration no reader can open.
- **T-28-05's own task-list row says "every component"** while its acceptance says "every file, not
  components only"; under the narrower wording **32 of 57 §17.1 rows fall out of scope**.
- **Two generated data files** (`meals.json` 5621 lines, `nutrition-source.json` 1488) sit inside
  T-28-05's `packages/**` scope with no rows, and **no document defines a generated-file exclusion**.
- **`eslint-config-expo` is pinned and imported by nothing**; `eslint-plugin-import` is present only
  as its transitive, which makes X-10's premise true of the declaration and false of the tree.

---

## 14. Deployment readiness

**The artefacts run.** `build:server` boots and answers `/health` with `mealCount` 60 with Ollama
stopped; `build:web` exports 4.3 MB across 19 files and `e2e/serveExport.mjs` serves `/`, `/settings`
and `/explore?query=chicken` at 200 including the 1.8 MB bundle. R-69 is closed and its fix is now
actually committed (R-76).

**No CI run exists and none can.** `git remote -v` is empty: no forge, so no push, so no Actions run,
so **no Run URL**. Nothing was fabricated, no remote was added, and no local runner was installed —
`act` is not in TSD §2.1. The workflow is authored, YAML-validated (`bash -n` 13/13) and every step
was executed locally in its own order. **T-26-01 is therefore Partial by evidence, not by artefact.**

**Not executed:** `npm ci` from a clean checkout; the gate as _workflow steps_ rather than as
orchestrator commands; any Linux run. `e2e/package.json`'s `install:browsers` omits `--with-deps`,
which a clean Linux runner would need.

`docs/RUNBOOK.md` told its reader in four places that `build:server` was broken and to use
`dev:server` instead — written before the fix landed and corrected only when this audit found it.

---

## 15. Residual risks, and the verdict

### Verdict: **CONDITIONAL GO**

Every defined gate passes, with the evidence in part 1. The conditions below are what stands between
this and an unqualified GO. They are enumerated rather than summarised, because the plan's own
standard is that a CONDITIONAL GO naming its conditions is a better artefact than a GO that pretends
they were settled.

**Conditions — defects, in the order I would fix them:**

1. **R-50 — add an error boundary around the navigator.** It is the only finding here that turns any
   render throw into a white page with no route back, on the surface P22 makes first-class. P22's own
   plan called it that phase's most valuable task and it was never built or mentioned.
2. **R-70 — convert the server-side denied-claim sweep to a walk**, as the mobile side already is.
   Ten lines, a pattern already proven in the tree, and it closes the one structural hole in the
   guard that exists because a peanut-allergic user must never read "allergen free" from our own copy.
3. **R-73 — decide Explore's paging**, and separately change one line so the announced count is the
   rendered count.
4. **R-77 and R-74** — a `main` landmark, and a `maxLength` on the search field.
5. **R-72** — measure `tabBarLabelPosition: 'beside-icon'` before attempting anything else.

**Conditions — decisions only you can make.** Twenty-one register rows are marked **User decision**.
The ones that change code or documents materially: **X-26** (five files at exactly 350 and five more
at 349 — one word decides ten files) · **X-46** (TSD §2.4's script block differs from the tree four
ways, one introduced deliberately and disclosed) · **X-47**'s remaining half (may a summary ever take
focus?) · **X-48** (two PRD §10.1 rows cannot both hold under the shipped `aiEnabled: true`) ·
**X-49** (amend TSD §5.7 to five checks, or move the fifth into `containReply`) · **R-71** (should a
contained-out reply fall back to the domain's answer?) · **R-75** (build a vetted-exemption
mechanism?) · plus the older **R-52, R-53, R-56, R-60, X-31, X-34, X-35** and the **TSD §2.1
amendment**, still recorded in `Plan.md` only.

**Residual risks accepted by this verdict:**

- **No real model has ever run against this build.** Every AI claim rests on `AI_FAKE`, which is a
  real server path and not a real model, and whose echo passes containment **by construction** —
  which is exactly why the empty-citation defect survived nine phases. `Plan.md` §19.6 registers the
  manual `gemma3:4b` check and it is not discharged.
- **No performance figure involves a model.** The 204 ms start figure is correct _for a machine with
  no model_ and would not hold with one (X-48).
- **No clean-checkout run, no Linux run, no CI run.**
- **No screen-reader traversal.**
- **Rule 6 of six does not hold at source level**, and four of six are unenforced.
- **The audit sampled.** Sixty substantive claims were checked and six were false; the rest of the
  project's claims were not individually re-verified. That is a bound on this verdict, not a
  guarantee behind it.

**What this verdict does not say.** It does not say the application has no defects. Six false claims
in same-day reports, a CRITICAL in the commit under audit, and seven false register rows are the
measured rate at which this project's own records drift from its tree — and the audit that found them
sampled rather than exhausted. The permitted conclusion is the one stated: **all defined gates pass,
and the risks above are named.**
