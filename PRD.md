# NutriTime AI — Product Requirements Document

- **Version:** 2.2.0
- **Date:** 2026-09-13
- **Author:** Mohammad Ra'uf Naser Albatayneh
- **Status:** Active
- **Scope:** private, single-developer, runs locally
- **Stack:** Expo · React Native · TypeScript · React Navigation · AsyncStorage · Node.js · Express · Ollama (Gemma 3:4B)
- **Related:** `SDD.md` (architecture), `TSD.md` (implementation contract)

> Version 2.2.0 amends FR-006, FR-011 and §15: nutrition is now **derived at build time from USDA
> FoodData Central** rather than authored, and both build-time data sources carry explicit attribution
> and licence terms. No runtime dependency is added.
>
> Version 2.1.0 amended §10.5 only: touch-target sizing becomes platform-specific
> (44 pt iOS / 48 dp Android / 24 px web) instead of a universal 44×44. Nothing else changes.
>
> Version 2.0.0 replaced 1.2.0. It narrows the product to what one person can build and run on one
> laptop: cart, checkout, orders, and the USDA nutrition integration are removed, and nutrition
> values now live in the local catalog. Sections that existed to coordinate a team or to deploy to
> production are gone.

## 1. Summary

NutriTime AI recommends a breakfast, lunch, dinner, or snack for right now, based on the time of day
and the user's diet, allergies, disliked ingredients, nutrition goal, and budget. It also answers
free-text questions about the meals available to that user.

Every fact the app states comes from a local, validated meal catalog and from deterministic rules.
Gemma 3:4B is used only to phrase answers the rules have already decided. If the model is
unavailable the app keeps working: recommendations fall back to deterministic text, and the
assistant says it is unavailable rather than inventing an answer.

## 2. Problem

Choosing a meal means comparing ingredients, prices, prep times, and dietary fit across many
options, usually at the moment you are least willing to do it. Recipe databases give you recipes
without dietary structure. Language models give you fluent suggestions and will invent a calorie
count without hesitation.

NutriTime AI splits the responsibility so that no component is asked to do something it is bad at:

| Component | Responsibility |
|---|---|
| `meals.json` | The catalog: names, images, ingredients, tags, nutrition, prices, prep times |
| Rule engine | Filtering and scoring. Every allergy and diet decision |
| Answer resolvers | Computing the answer to a question from catalog data |
| Gemma 3:4B | Phrasing an answer the rules already produced |
| AsyncStorage | The user's own records, on their device |

## 3. Goals

1. Give a relevant, time-appropriate meal recommendation in under two seconds without AI.
2. Make every allergy and diet decision deterministic, testable, and final before the model is reachable.
3. Answer questions about the user's own meal options without fabricating a single fact.
4. Keep working with the model stopped.
5. Stay small enough for one person to hold in their head.

## 4. Non-Goals

- Medical, clinical, or dietary advice, or any guarantee of allergen safety.
- Real payment, real ordering, or delivery.
- Accounts, authentication, or cloud sync.
- Training or fine-tuning a model.
- Free-form AI generation of meals, ingredients, nutrition values, prices, or safety claims.

Non-goals are binding. Adding one back means editing this document first.

## 5. Users

One persona: someone who wants a meal suggestion quickly, has a limited budget, may be vegetarian,
vegan, halal-preferring, or gluten-aware, and wants to save the meals they like and add their own.
They understand this is not medical advice.

## 6. Principles

1. **Safety before personalization.** Allergen exclusion runs before ranking, and before the model.
2. **Facts before phrasing.** The catalog and the rules produce facts; Gemma renders them as English.
3. **Local-first.** The catalog ships with the app. Nothing user-facing needs the network except the model and meal images.
4. **No silent fabrication.** Missing nutrition is `null` and displays as "Not available", never `0`.
5. **Progressive disclosure.** Cards summarize; detail screens elaborate.
6. **Accessible by default.** Labels, contrast, scalable text, and both themes on every interactive element.

## 7. Scope

### 7.1 Area A — Recommendations and Preferences

- Detect the current meal period from the user's configured meal times and local device time.
- Filter the catalog by allergies, diet, disliked ingredients, and availability.
- Score the survivors on meal-period match, diet fit, nutrition goal, budget, favorites, prep time, and availability.
- Return the top three.
- Optionally attach a one-sentence Gemma explanation per recommendation, with deterministic fallback
  text when AI is off, slow, or invalid.
- Onboarding collects the preferences; Settings edits them.

### 7.2 Area B — Saved and Custom Meals

- Add and remove favorites.
- Create, read, update, and delete custom meals through a validated form.
- Everything persists across restarts.
- Clear individual data sets, or reset all local data, after confirmation.

### 7.3 Area C — Grounded Meal Assistant

- Accept a free-text question of 1–500 characters about the user's meal options.
- Retrieve, deterministically and before any model call, the meals relevant to the question that the
  user's allergies, diet, and availability already permit.
- **Resolve the answer in the domain from those meals**, then ask Gemma only to phrase it.
- Show the meals the answer drew on as citations.
- Say "I do not have that information" when the retrieved meals cannot answer the question.
- Report the assistant as unavailable — never substitute a generated answer — when AI is off or
  Ollama cannot be reached.

The assistant reads the catalog on the user's behalf. It is not a nutrition advisor. It may not state
that a meal is allergen-free, safe, or healthy, and it may not give medical or dietary advice:
allergen decisions are already final by the time the model is reachable, and restating them in
generated prose would put a safety claim in the one component that is not authoritative about safety.

Each question is answered independently. No conversation history is sent to or kept by the server;
the on-screen transcript is a display concern only.

### 7.4 What the assistant can answer

The answerable question shapes are bounded by the domain's resolvers. This is a deliberate limit, not
a gap — a question outside the list is answered "I do not have that information" without calling the
model at all.

| Shape | Example |
|---|---|
| Superlative | "Which is quickest?" · "What is the cheapest?" · "Which has the most protein?" |
| Ordering | "Rank these by calories" |
| Listing | "What vegetarian options do I have?" |
| Count | "How many are under $10?" |
| Total | "What would all of these cost?" |
| Capability | "What can you do?" |

Anything else — general nutrition questions, recipe substitutions, health advice, questions about
meals outside the user's eligible set — returns the unavailable-information answer.

## 8. User Journeys

### 8.1 First launch

Splash hydrates persisted state → onboarding is incomplete → the user sets diet, allergies, goal,
budget, disliked ingredients, and meal times → input is validated and persisted → main app.

### 8.2 Recommendation

Home determines the meal period → the rule engine rejects unsafe and incompatible meals → scores and
sorts the rest deterministically → Gemma optionally explains the top three → Home shows them, marked
when the explanation is fallback text → the user opens a detail screen or favorites a meal.

### 8.3 Custom meal CRUD

Saved → create through a validated form → the record persists and appears in the list → edit it, and
the change survives a restart → delete it after confirmation.

### 8.4 Assistant

The user opens the Assistant and types a question → the app sends the question with the stored diet,
allergies, and disliked ingredients → the server hard-rejects meals conflicting with declared
allergies, applies diet compatibility, and excludes unavailable meals → it ranks the survivors
against the question and keeps at most five → **the domain resolves the answer over those meals** →
Gemma phrases it → containment discards any reply that cites a meal outside the set, quotes an
unresolved figure, or makes a safety claim → the app shows the answer with its citations, or an
explicit unavailable message.

## 9. Functional Requirements

### FR-001 — Startup and hydration

Persisted state loads once at startup. Main navigation does not render before hydration completes. A
corrupt storage entry is quarantined and reset individually; it never crashes the app or destroys an
unrelated key.

### FR-002 — Onboarding

Onboarding shows only until it is completed or the user resets their data. The name field is
optional; the preference fields are not.

### FR-003 — Preferences

The user creates and edits their dietary profile. Preferences survive restarts. Changing allergies
discards the recommendations currently on screen and re-runs filtering.

### FR-004 — Meal-period detection

The current time classifies as breakfast, lunch, dinner, or snack using the user's configured meal
anchors with documented windows. Boundary cases are unit tested.

### FR-005 — Catalog retrieval

The client reaches the server through a typed `fetch` adapter. The server serves the validated local
catalog. A request for an unknown meal is a 404, not an empty success.

### FR-006 — Nutrition data

Every catalog meal carries per-serving calories, protein, carbohydrate, and fat, **derived at build
time from USDA FoodData Central** by resolving the meal's own ingredient list against published
per-100 g values.

Nothing is estimated. If any ingredient cannot be resolved to a published food, or its measure cannot
be converted to grams, then **all four values for that meal are `null`** and the reason is recorded.
Partial sums are not reported: a meal whose nutrition is three-quarters known is a meal whose
nutrition is unknown.

A serving count is the divisor for all four values and the recipe source does not publish one, so it
is authored per meal and **recorded as authored**, never presented as measured.

A user-created meal may leave any value unset. An unset value is `null` and renders as "Not
available" — never `0`, and never a guess. There is one nutrition source, so no two screens can
disagree about one meal.

### FR-007 — Recommendation safety

Any candidate matching a declared allergen is rejected before scoring. AI cannot override a
rejection. The UI carries a general safety disclaimer.

### FR-008 — Scoring

Scoring is deterministic for identical input and catalog version. Ties break on score descending,
then meal ID ascending. Score reasons are available for tests and development.

### FR-009 — AI explanation

The model receives only approved candidate fields. Its output is validated against a schema with Zod.
A timeout, a parse failure, a schema failure, or an unreachable model produces deterministic fallback
text, and the recommendation still succeeds.

### FR-010 — Explore and search

The user searches by meal name and filters by meal period, diet tag, and price band. Input is
debounced. Results page locally.

### FR-011 — Meal details

The detail screen shows name, image, ingredients, instructions, price, prep time, tags, allergen
notices, and nutrition. Unknown nutrition displays as "Not available".

The screen also displays **source attribution** for the recipe and image, and states where the
nutrition figures came from — including the serving count they were divided by, and the fact that the
serving count was authored. A figure the user cannot trace is a figure the user cannot check.

### FR-012 — Favorites

Adding and removing a favorite is idempotent and persists.

### FR-013 — Custom meal CRUD

The user creates, reads, updates, and deletes custom meals. IDs are UUID strings. The form rejects a
missing name, an empty ingredient list, negative numbers, and invalid prices or times.

### FR-014 — Settings and reset

The user edits preferences and meal times, enables or disables AI, switches theme mode, clears
individual data sets, and resets all local data. Destructive actions confirm first.

### FR-015 — Grounded meal assistant

- The user asks a free-text question of 1–500 characters.
- Allergen rejection, diet compatibility, and availability exclusion run deterministically before the
  model is called, using the same rules as FR-007.
- The request carries only what retrieval needs — `diet`, `allergies`, `dislikedIngredients` — and
  rejects any other field.
- **The domain resolves the answer from the retrieved meals. The model is given that answer and asked
  only to phrase it.** It does not decide what is true.
- Every citation belongs to the retrieved set. A reply citing anything else is discarded, not shown.
- A reply quoting a figure the domain did not resolve is discarded. So is one asserting that a meal is
  allergen-free, safe, or healthy, and so is one naming a meal the answer is not about.
- General food, nutrition, or health knowledge is never used.
- The assistant reports that it does not have the information rather than produce an unsourced answer.
- An unavailable model produces an explicit unavailable message. There is no fallback answer, because
  a free-text question has no rule-based equivalent.
- When the user's own filters leave no eligible meal, the app says so without calling the model.

## 10. Non-Functional Requirements

### 10.1 Speed

| Path | Target |
|---|---|
| App start to usable Home | ≤ 2.5 s after first launch |
| Local navigation, search, filtering | ≤ 150 ms over the meals already loaded |
| Recommendations without AI | ≤ 2 s |
| Recommendation explanation, warm model | ~5 s, hard timeout 12 s |
| Assistant answer, warm model | ~11 s, hard timeout 30 s |

A cold model load takes roughly a minute and will exceed the assistant's timeout. The first request
after a restart may legitimately fail and then recover on its own. The UI shows a loading state after
200 ms and an AI-progress message after 2 s.

### 10.2 Reliability

- No network or model failure crashes the app. Every network call has a timeout.
- Core features work with no network at all. Only the model and remote meal images need one.
- User records survive restarts. Storage schemas are versioned and migrate forward.
- Favorites and custom meals are bounded at 200 each. A write past the bound is refused with a clear
  message rather than silently deleting the user's oldest entry.

### 10.3 Security and privacy

- No secrets in the mobile bundle or the repository.
- Every request body and every model reply is validated with Zod.
- Request bodies are capped at 64 KB.
- Logs never contain prompts, questions, allergy lists, or names.
- Nothing leaves the device except the question and the preference fields the assistant needs, and
  those go only to a server on the same machine.

### 10.4 Maintainability

- Strict TypeScript. No new `any`.
- Files stay under 350 lines. A file past it is doing too much.
- Domain logic lives in the domain package, never copied into a screen or an adapter.

### 10.5 Accessibility

- Every control has an accessibility role and label, and a touch target of at least **44×44 points
  on iOS, 48×48 dp on Android, and 24×24 CSS pixels on the web build** (with the WCAG 2.2 Target Size
  exceptions). 48 dp satisfies all three, so it is the single value to build to.
- Text scales with the device setting without clipping.
- Color is never the only carrier of status.
- Both themes meet WCAG AA contrast where measurable.

## 11. Screens

Splash · Onboarding · Dietary Setup · Home · Explore · Meal Details · Saved · Create/Edit Meal ·
Assistant · Settings

Five tabs: **Home · Explore · Assistant · Saved · Settings**. Detail and form screens sit on a typed
native stack.

## 12. Error States

Every data-driven screen implements: loading, empty, local-only (server unreachable), validation
error, and AI unavailable. Each message says what happened, what still works, and what to do next.
Stack traces and raw provider errors never reach the user.

## 13. Acceptance Criteria

**Recommendations**

- With a peanut allergy declared, no returned candidate carries a peanut allergen tag.
- Identical input and catalog version produce identical scores and ordering.
- With Ollama stopped, recommendations still return, with fallback explanations, inside the budget.
- Invalid model JSON never reaches UI state.

**Saved and custom meals**

- Preferences, favorites, and custom meals survive a restart.
- Create, edit, and delete all work through the UI and the storage layer; deleted records stay deleted.
- Validation errors appear beside the field that caused them.
- A corrupt entry under one key does not erase valid preferences under another.

**Assistant**

- With a peanut allergy declared, no meal carrying that allergen appears in the grounding context or
  in any citation.
- A question the retrieved meals cannot answer reports the information as unavailable and cites nothing.
- A reply citing a meal outside the retrieved set is discarded and never reaches UI state.
- A reply quoting a figure the domain did not resolve is discarded.
- A reply asserting that a meal is allergen-free, safe, or healthy is discarded.
- A reply naming a meal the answer is not about is discarded.
- With AI disabled or Ollama unreachable, the user sees an explicit unavailable message.
- When the user's filters exclude every meal, the response says so without calling the model.

## 14. Risks

| Risk | Mitigation |
|---|---|
| The model is slow or absent on a 16 GB laptop | Gemma 3:4B, small prompts, one call at a time, keep-alive, hard timeouts, deterministic fallbacks |
| The model states something false | The domain resolves the answer; containment discards unresolved figures and safety claims |
| An allergen slips through a mistagged record | Allergen matching unions declared tags with tags inferred from ingredient names, plus unit tests |
| Scope creep | Section 4 is binding |

## 15. Dependencies and Assumptions

- Ollama runs locally with `gemma3:4b` pulled. The app is expected to work with it stopped.
- **TheMealDB** supplies recipes, ingredients and images. It is a **build-time tool**, not a runtime
  dependency; only meal images are still fetched from their URLs at runtime. The development key is
  used, which its documentation limits to development and learning — consistent with §4, which rules
  out public release. The app displays the required attribution: *Recipe data and imagery: TheMealDB
  (https://www.themealdb.com/)*, and preserves any source, image-source and licence metadata the
  record carries.
- **USDA FoodData Central** supplies nutrition, also at build time, from a downloaded dataset rather
  than an API. No key, no network call at runtime, no request in the user's path. USDA FoodData
  Central is United States Government work in the public domain.
- Neither data source appears in the running system. Both are consumed once, by a script run by hand,
  and the result is committed.
- AsyncStorage is unencrypted and therefore holds only non-sensitive records.

## 16. Definition of Done

A feature is done when its acceptance criteria pass, its screens handle loading, empty, success, and
error, it works in both themes with accessibility metadata, and `npm run check` is green.

## 17. References

- Expo — https://docs.expo.dev/
- React Navigation TypeScript — https://reactnavigation.org/docs/typescript/
- AsyncStorage — https://react-native-async-storage.github.io/
- Ollama structured outputs — https://docs.ollama.com/capabilities/structured-outputs
- TheMealDB, for seeding only — https://themealdb.com/docs_api_guide.php
