# Reliability — cold-model behaviour and failure injection

**Rows:** T-25-05 (cold model), T-25-06 (failure injection).
**Authorities:** PRD §10.1, §10.2, §12, §13 · SDD §9.7, §10 · TSD §3.5, §5.5, §5.8 · Plan §15.5.
**Not an authority:** `PRD §15.5` does not exist — PRD section 15 is _Dependencies and
Assumptions_ and has no subsections. The logging rule is TSD §5.8, the requirement behind it is
PRD §10.3, and the AI lane's execution row is Plan §15.5.

This file records what was **measured**, and — with equal weight — what was not. P25's whole value
is that the SLO table stops being a claim, so a number produced by a fake and presented as a model
latency would re-break exactly what the phase exists to fix. A missed or unreachable target is
recorded as a known limitation and never by relaxing the target.

---

## 1. The claim under test

PRD §10.1, verbatim:

> A cold model load takes roughly a minute and will exceed the assistant's timeout. The first
> request after a restart may legitimately fail and then recover on its own. The UI shows a
> loading state after 200 ms and an AI-progress message after 2 s.

SDD §9.7 restates it and names it: _"A cold load will exceed the budget. The first request after a
restart may legitimately 503 and then recover on its own. This is designed degradation, and the UI
says so."_ Plan §14's R-05 is the risk row and `AI_KEEP_ALIVE=30m` the mitigation.

That is **four separable claims**, and they are not equally reachable on this machine.

| #   | Claim                                                                                                                    | Status                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1   | The first request 503s when the model is not loaded                                                                      | **Verified** — §2                        |
| 2   | A later request succeeds with no user action beyond retrying                                                             | **Verified** — §2                        |
| 3   | The 503 is a _temporary-condition_ message with a working retry, never a broken-feature one and never an upstream string | **Verified** — §3                        |
| 4   | The UI shows a loading state after 200 ms and an AI-progress message after 2 s                                           | **NOT MET on the assistant lane** — §4   |
| —   | A cold load takes _roughly a minute_                                                                                     | **Not measured. Unmeasurable here** — §6 |

---

## 2. The 503-then-recover sequence — verified

`apps/server/src/ai/coldStart.integration.test.ts` drives the sequence through `createApp`, so the
real `createAiLane`, `createAiProvider`, `createOllamaClient`, `buildChatPrompt` and `containReply`
all execute and only the socket is replaced (`AppOptions.fetchImpl`; TSD §5.5's argument for
`AI_FAKE`, applied one layer lower). Three pairs are driven:

| First call                                | First response       | Log `outcome` | Second call | Second response        |
| ----------------------------------------- | -------------------- | ------------- | ----------- | ---------------------- |
| never settles                             | 503 `ai_unavailable` | `timeout`     | answers     | 200, `source: 'gemma'` |
| `fetch` rejects (Ollama stopped)          | 503 `ai_unavailable` | `unreachable` | answers     | 200, `source: 'gemma'` |
| `done_reason: 'length'` on parseable JSON | 503 `ai_unavailable` | `schema`      | answers     | 200, `source: 'gemma'` |

Plus the busy case: while one call is held, a second request is 503 `ai_busy` with **no AI log
line** and **no socket**, and the request after the held one is released is 200.

**Why the second response is the load-bearing half.** Recovery is a property of a _pair_. A lane
that leaked its single flight when the budget expired would answer every later question 503 for
the life of the process, and PRD §10.1's "recover on its own" would be false with no other visible
symptom — `ai_busy` and `ai_unavailable` are both 503 and both retryable, and only the code
separates them. Each test therefore asserts the first response, the second response, **and the
provider call count**, because only the count proves the second request reached the model rather
than being refused before `fn` ran.

Measured gap this closed: holding `occupied` true after every call in `apps/server/src/aiLane.ts`
reddened **nothing in either chat suite** before this file existed (eleven tests in the explanation
lane's own suite caught it, which is the recommendation path, not the assistant path).

---

## 3. What the user is shown — verified, at both ends

PRD §12 and TSD §3.5: a user-facing error message is fixed local copy — never an exception
message, a driver string, a server string or `String(error)`.

**Server end.** The 503 body is exactly `{ error: { code, message, retryable } }` with
`errors.ts`'s fixed copy and `retryable: true`; asserted with `toStrictEqual`, so a fourth field
carrying a cause fails. Nothing of the transport reaches it: a real stopped Ollama rejects with
`TypeError: fetch failed` over `connect ECONNREFUSED 127.0.0.1:11434`, and neither string appears
in the body **or in any log line**.

**Client end.** `apps/mobile/src/features/assistant/useAssistant.ts` maps `ai_unavailable` to the
`unavailable` failure, whose copy in `assistantCopy.ts` is _"The assistant could not be reached"_
with `actionLabel: 'Try again'` — a temporary condition with a working retry. `ai_disabled` maps to
`disabled`, whose `actionLabel` is `null`. Both are HTTP 503 and the status cannot tell them apart.

Measured: changing that one mapping entry to `disabled` — which is what would show a user a
broken-feature message with no retry during a cold load — reddens **5 of 18** tests in
`apps/mobile/src/features/assistant/`. The claim is pinned, not merely present.

**Nothing personal is logged on either path.** TSD §5.8, PRD §10.3, Plan §15.5. The AI lines carry
exactly `timestamp`, `level`, `lane`, `durationMs`, `outcome`; the question, the allergy list, the
answer and the winning meal's name appear in no line. Measured: appending the question to the sink
on the chat failure path reddens 6 tests in `apps/server/src/routes/chat.test.ts` and, before this
file existed, **0** at the integration layer.

---

## 4. Known limitation — PRD §10.1's staged loading is not on the assistant lane

PRD §10.1's third sentence is about the assistant: it follows two sentences about the assistant's
timeout. The two thresholds it names are implemented in
`apps/mobile/src/features/home/useRecommendations.ts` (`LOADING_AFTER_MS = 200`,
`AI_PROGRESS_AFTER_MS = 2_000`) and **nowhere else**.

`apps/mobile/src/features/assistant/useAssistant.ts` exposes `pending` as a plain boolean set
synchronously when the request starts, and `apps/mobile/src/features/assistant/AssistantTurnRow.tsx`
renders `ASSISTANT_COPY.submitting` immediately and unchanged for the life of the call. There is no
200 ms gate and no second stage.

**What that costs a user during the case this row exists for.** A question asked while the model is
cold shows one unchanging sentence for up to the full 30 s chat budget and then a failure. SDD §9.7
says of exactly this state _"This is designed degradation, and the UI says so"_ — and on the
assistant screen it does not say so. The inversion is worth stating: the two thresholds are
implemented on the lane whose whole budget is ~2 s, where a 2 s progress message can barely fire,
and absent from the lane whose budget is 30 s.

Recorded as a limitation, not fixed: the change is in `useAssistant.ts` and `AssistantTurnRow.tsx`,
which this row does not own, and the copy for a second stage is user-facing text PRD §12 governs.

---

## 5. Failure injection — what the existing coverage would catch

T-25-06 names three failure modes. Each already had coverage, so each was **measured** before
anything was added: a mutation was substituted at load time (no repository file was opened for
writing) and the existing suites were run. Counts are per mutation, run alone.

| Failure mode                       | Mutation                                                                        | Existing tests reddened                     |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| Ollama stopped / unreachable       | drop `OllamaError` from `chatFailure`'s `ai_unavailable` arm (`routes/chat.ts`) | **12** — 3 integration, 9 unit              |
| Another call in flight (`ai_busy`) | `new ApiError('ai_busy')` → `ai_unavailable` (`routes/chat.ts`)                 | **5** — 3 integration, 2 unit               |
| Corrupt storage entry              | make a corrupt key throw out of `decodeOne` (`storage/hydrate.ts`)              | **13** of 219                               |
| Server unreachable from the app    | `transportError(route, 'unreachable')` → `'unreadable'` (`api/client.ts`)       | **1** of 219                                |
| …and its retry flag                | `retryable: kind !== 'unreadable'` → `false` (`api/errors.ts`)                  | **3** of 219 unit; **0** of 46 screen tests |

None of the five is zero, so none of the three named modes is a guard nothing would notice the loss
of. What the measurements did surface is in §5.1.

### 5.1 Two things the numbers say that the code does not

**A screen's local-only retry does not read `ApiClientError.retryable`.** Flipping that flag to
`false` reddens 0 of the 46 `features/home` + `features/catalog` screen tests, while a `throw` at
the same site reddens 3 — including one named _"offers a retry on both failure states"_. So the
line executes and the flag is simply not consulted: every failure state offers a retry
unconditionally. That is defensible for a transport failure (retrying may well help) and it means
the field is a diagnosis rather than a control on those screens. The assistant screen does it the
other way, in code, through `actionLabel: string | null`.

**A mutation to `api/client.ts` is inert in screen tests.** `Home.dom.test.tsx` injects a stub
`ApiClient` and constructs `transportError(...)` directly, so `client.ts`'s fetch `catch` never
runs there. A 0-of-N against that file from a screen suite means "my mutation could not execute",
not "nothing pins this" (BRIEF §6.1k).

---

## 6. Could not verify

- **A real cold model load.** There is no model on this machine. Nothing here measures the ~60 s
  figure in PRD §10.1, and no figure is offered in its place — a hung socket reproduces the
  _shape_ of the failure (the budget expires, the call is abandoned, the lane is released) and
  says nothing about its duration. Verifying the figure needs `gemma3:4b` pulled, the server
  restarted, and one request timed; that belongs to a manual pass, not to a test.
- **`AI_KEEP_ALIVE=30m` actually keeping the model resident.** It is passed through to Ollama as a
  duration string and asserted on the outbound body; whether Ollama honours it, and therefore
  whether the ~60 s load really is avoided after a quiet gap, is upstream behaviour no test here
  can see.
- **Eviction of a `localStorage` origin.** Plan §10.2's web note names quota _and_ eviction. Quota
  is driven against a real origin by T-22-06's suites; no way was found to make a browser or jsdom
  evict from inside a test, and no document defines what the app should do when it happens.
- **The assistant's end-to-end cold-start journey in a browser.** The five tests above stop at the
  HTTP boundary. A spec that asks a question, sees the 503 state, taps _Try again_ and gets an
  answer would close claim 3 at the surface a user touches; `e2e/**` is another row's.
