# NutriTime AI — Technical Specification

- **Version:** 1.2.0
- **Date:** 2026-09-13
- **Author:** Mohammad Ra'uf Naser Albatayneh
- **Status:** Active
- **Related:** `PRD.md` (what and why), `SDD.md` (architecture and rationale)

> Version 1.2.0 amends §3.2, §3.3 and §7: `Meal` gains provenance and nutrition-provenance fields,
> `mealSchema` enforces the all-or-nothing nutrition rule, §7.2 is rewritten against the real
> TheMealDB API, and a new §7.4 defines the USDA derivation contract.
>
> Version 1.1.0 amended §6.6 only: the typeface is fixed rather than deferred.

## 1. How to read this document

Three documents, three jobs:

| Document | Owns | Answers |
|---|---|---|
| `PRD.md` | Behaviour | What must the product do? |
| `SDD.md` | Architecture | What shape is the system, and why that shape? |
| `TSD.md` | Contract | What exactly gets typed? |

**Conflict rule.** On an implementation detail — a signature, a constant, a schema, an algorithm
step — this document wins. On *why* a decision was made, the SDD wins. On what the user experiences,
the PRD wins. A value appears in exactly one of the three; the other two point here.

**Reading conventions.** Every `export` shown is the exact exported symbol. Every constant is the
literal value to type. Every algorithm is numbered steps in execution order. Where a large data table
belongs in source rather than prose, this document specifies its shape and names the file that holds
it; it does not reproduce it.

**What this document does not contain.** Rationale that is already in the SDD, requirements that are
already in the PRD, and prose that would have to be kept in sync with either.

---

## 2. Toolchain and Workspace

### 2.1 Pinned versions

Exact versions, not ranges. These combinations are known to work together.

**Runtime:** Node `>=22.13.0 <25`.

**Root devDependencies**

| Package | Version |
|---|---|
| typescript | 6.0.3 |
| eslint | 9.39.5 |
| typescript-eslint | 8.70.0 |
| @eslint/js | 9.39.5 |
| eslint-config-expo | 57.0.2 |
| eslint-config-prettier | 10.1.8 |
| prettier | 3.9.6 |
| vitest | 5.0.0 |
| @vitest/coverage-v8 | 5.0.0 |
| jsdom | 30.0.1 |
| @testing-library/dom | 10.4.1 |
| @testing-library/jest-dom | 7.0.1 |
| @types/react | 19.2.18 |
| @types/react-dom | 19.2.7 |

Root `overrides`: `{ "react": "19.2.3", "react-dom": "19.2.3" }`. Root has no `dependencies`.

**apps/mobile**

| Package | Version |
|---|---|
| expo | 57.0.21 |
| @expo/metro-runtime | 57.0.15 |
| react | 19.2.3 |
| react-dom | 19.2.3 |
| react-native | 0.86.3 |
| react-native-web | 0.21.2 |
| @react-navigation/native | 7.3.18 |
| @react-navigation/native-stack | 7.18.10 |
| @react-navigation/bottom-tabs | 7.18.18 |
| @react-native-async-storage/async-storage | 2.2.0 |
| react-native-screens | 4.26.2 |
| react-native-safe-area-context | 5.7.0 |
| react-native-gesture-handler | 2.32.0 |
| expo-font, expo-haptics, expo-splash-screen, expo-status-bar, expo-system-ui | 57.x |

No Reanimated and no Worklets. Motion uses React Native's own `Animated`.

**apps/server**

| Package | Version |
|---|---|
| express | 5.2.1 |
| cors | 2.8.6 |
| zod | 4.5.4 |
| tsx (dev) | 4.23.13 |
| supertest (dev) | 7.2.2 |
| @types/express (dev) | 5.0.6 |

No `helmet` and no `express-rate-limit`: the server binds to localhost for one user (SDD §12).

**e2e** — `@playwright/test` ^1.59.1, in its own `package.json` outside the workspace so the root
lockfile stays free of browser binaries.

### 2.2 TypeScript configuration

`tsconfig.base.json`, verbatim:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,

    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "exclude": ["node_modules", "dist", "coverage", "**/*.d.ts"]
}
```

`noUncheckedIndexedAccess` is the load-bearing flag: it makes `array[i]` be `T | undefined`, which is
what forces the explicit `undefined` handling that appears throughout §4.

`apps/mobile/tsconfig.json` extends `["expo/tsconfig.base", "../../tsconfig.base.json"]` and adds the
only path alias in the repo: `"@/*": ["./src/*"]`. It is a TypeScript alias only — Metro does not
resolve it, so runtime imports inside `apps/mobile` are relative. Workspace packages resolve through
npm workspace symlinks (`main: src/index.ts`), never through `paths`.

### 2.3 Package graph

```text
contracts  ->  (zod only)
domain     ->  contracts
server     ->  contracts, domain
mobile     ->  contracts, domain, catalog
catalog    ->  (nothing)
```

Enforced rules:

1. `packages/domain` may not import `express`, `react`, `react-native`, `@react-native-async-storage/*`, `fetch`, or any Ollama client. It is pure TypeScript with no I/O and no clock.
2. `packages/contracts` is the only package with a third-party runtime dependency (`zod`).
3. No package imports `apps/*`.
4. `@react-native-async-storage/async-storage` is imported by exactly one file: `apps/mobile/src/infrastructure/storage/asyncStorageDriver.ts`.
5. No cyclic imports between modules.

### 2.4 Scripts

Root `package.json`:

```json
{
  "scripts": {
    "dev": "npm run dev:server & npm run dev:mobile",
    "dev:server": "tsx watch apps/server/src/index.ts",
    "dev:mobile": "npm --workspace apps/mobile run start",
    "seed": "tsx packages/catalog/seed.ts",
    "typecheck": "tsc --noEmit -p apps/server && tsc --noEmit -p apps/mobile && tsc --noEmit -p packages/domain && tsc --noEmit -p packages/contracts",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "check": "npm run format:check && npm run lint && npm run typecheck && npm run test",
    "build:web": "npm --workspace apps/mobile run build",
    "test:e2e": "npm --prefix e2e test"
  }
}
```

`npm run check` is the single gate. Nothing else is required to pass before committing.

---

## 3. Shared Contracts — `packages/contracts`

Files: `core.ts` (enums and entities), `schemas.ts` (Zod), `api.ts` (wire types), `errors.ts`,
`index.ts` (barrel).

### 3.1 Enumerations

```ts
export const MEAL_PERIODS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export type MealPeriod = (typeof MEAL_PERIODS)[number];

export const DIET_TAGS = [
  'regular',
  'vegetarian',
  'vegan',
  'halal-preference',
  'gluten-aware',
] as const;
export type DietTag = (typeof DIET_TAGS)[number];

export const NUTRITION_GOALS = ['balanced', 'high-protein', 'lower-calorie'] as const;
export type NutritionGoal = (typeof NUTRITION_GOALS)[number];

export const BUDGET_BANDS = ['low', 'medium', 'high'] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export type DataSource = 'local' | 'user';

/** The complete allergen taxonomy. A tag outside this list is not a canonical allergen. */
export const CANONICAL_ALLERGENS = [
  'peanut',
  'tree-nut',
  'milk',
  'egg',
  'soy',
  'wheat',
  'gluten',
  'fish',
  'shellfish',
  'sesame',
] as const;
export type CanonicalAllergen = (typeof CANONICAL_ALLERGENS)[number];

/** The eight scoring policies of §4.6, in evaluation order. */
export const SCORE_REASON_KINDS = [
  'meal-period-match',
  'diet-match',
  'goal-match',
  'budget-match',
  'previous-like',
  'preparation-time-fit',
  'local-availability',
  'disliked-ingredient',
] as const;
export type ScoreReasonKind = (typeof SCORE_REASON_KINDS)[number];
```

`Meal.allergenTags` is typed `readonly string[]`, **not** `CanonicalAllergen[]`. A catalog record may
carry a tag the taxonomy does not know; §4.4 normalises rather than rejects, because rejecting an
unrecognised allergen tag would be the one failure mode this system must never have.

### 3.2 Entities

```ts
export interface Money {
  readonly amountCents: number;
  readonly currency: 'USD';
}

export interface Ingredient {
  readonly name: string;
  readonly measure: string;
}

/**
 * Per serving. Units are implied by the field names: kcal for calories, grams for the rest.
 * `null` means unknown and renders as "Not available" — never 0, never a guess (PRD FR-006).
 */
export interface NutritionSummary {
  readonly calories: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
}

/** Where a catalog record came from. Carried because the upstream licence obliges it. */
export interface Provenance {
  readonly themealdbId: string | null;
  readonly sourceUrl: string | null;
  readonly imageSource: string | null;
  readonly licenceConfirmed: boolean;
}

/**
 * How a record's nutrition was obtained. `servings` is the divisor the per-serving figures were
 * computed with, and is authored — the recipe source publishes none.
 */
export interface NutritionProvenance {
  readonly origin: 'usda-derived' | 'unavailable' | 'user';
  readonly dataset: string | null;
  readonly servings: number | null;
  readonly reason: string | null;
}

export interface Meal {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mealPeriods: readonly MealPeriod[];
  readonly ingredients: readonly Ingredient[];
  readonly instructions: readonly string[];
  readonly allergenTags: readonly string[];
  readonly dietTags: readonly DietTag[];
  readonly nutrition: NutritionSummary;
  readonly price: Money;
  readonly preparationMinutes: number;
  readonly imageUrl: string | null;
  readonly available: boolean;
  readonly source: DataSource;
  readonly catalogVersion: string;
  readonly provenance: Provenance;
  readonly nutritionProvenance: NutritionProvenance;
}

export interface UserPreferences {
  readonly schemaVersion: 1;
  readonly name?: string;
  readonly diet: DietTag;
  readonly allergies: readonly string[];
  readonly goal: NutritionGoal;
  readonly budget: BudgetBand;
  readonly dislikedIngredients: readonly string[];
  readonly mealTimes: {
    readonly breakfast: string;
    readonly lunch: string;
    readonly dinner: string;
  };
  readonly aiEnabled: boolean;
  readonly themeMode: ThemeMode;
}

/** A user-authored meal. Same shape as Meal, with nutrition optional. */
export interface CustomMeal extends Omit<Meal, 'source' | 'catalogVersion'> {
  readonly source: 'user';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScoreReason {
  readonly kind: ScoreReasonKind;
  readonly points: number;
  readonly detail: string;
}

export interface Recommendation {
  readonly meal: Meal;
  readonly score: number;
  readonly scoreReasons: readonly ScoreReason[];
  readonly explanation: string;
  readonly explanationSource: 'gemma' | 'fallback';
}

export interface Citation {
  readonly mealId: string;
  readonly name: string;
}
```

### 3.3 Schemas

Every value crossing a trust boundary is parsed, never cast. `ValueSchema<T>` is the structural
minimum the codebase depends on, so a schema can be passed across a package edge without importing
Zod's types:

```ts
export interface ValueSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}
```

**Nutrition ranges.** The per-serving invariant is enforced here, because §3.2 deleted the type that
used to carry it (SDD §5.1). The upper bounds catch a hand-authoring slip that would otherwise win
every superlative question with a number the domain genuinely resolved.

```ts
const nutrientSchema = (max: number) => z.number().int().min(0).max(max).nullable();

export const nutritionSummarySchema = z.strictObject({
  calories: nutrientSchema(2000),
  proteinGrams: nutrientSchema(200),
  carbsGrams: nutrientSchema(300),
  fatGrams: nutrientSchema(200),
});

export const moneySchema = z.strictObject({
  amountCents: z.number().int().min(0).max(100_000),
  currency: z.literal('USD'),
});

export const provenanceSchema = z.strictObject({
  themealdbId: z.string().regex(/^\d+$/).nullable(),
  sourceUrl: z.string().url().nullable(),
  imageSource: z.string().max(300).nullable(),
  licenceConfirmed: z.boolean(),
});

export const nutritionProvenanceSchema = z.strictObject({
  origin: z.enum(['usda-derived', 'unavailable', 'user']),
  dataset: z.string().max(120).nullable(),
  servings: z.number().int().min(1).max(24).nullable(),
  reason: z.string().max(200).nullable(),
});

export const mealSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1).max(120),
  description: z.string().max(400),
  mealPeriods: z.array(z.enum(MEAL_PERIODS)).min(1),
  ingredients: z.array(z.strictObject({ name: z.string().min(1), measure: z.string() })).min(1),
  instructions: z.array(z.string().min(1)).min(1),
  allergenTags: z.array(z.string()),
  dietTags: z.array(z.enum(DIET_TAGS)).min(1),
  nutrition: nutritionSummarySchema,
  price: moneySchema,
  preparationMinutes: z.number().int().min(0).max(600),
  imageUrl: z.string().url().nullable(),
  available: z.boolean(),
  source: z.enum(['local', 'user']),
  catalogVersion: z.string().min(1),
  provenance: provenanceSchema,
  nutritionProvenance: nutritionProvenanceSchema,
}).superRefine((meal, ctx) => {
  const values = Object.values(meal.nutrition);
  const known = values.filter((v) => v !== null).length;
  const { origin, dataset, servings, reason } = meal.nutritionProvenance;

  // The all-or-nothing rule, enforced by the schema rather than by convention.
  if (known !== 0 && known !== values.length) {
    ctx.addIssue({ code: 'custom', message: 'nutrition must be wholly known or wholly null' });
  }
  if (origin === 'usda-derived' && (known === 0 || dataset === null || servings === null)) {
    ctx.addIssue({ code: 'custom', message: 'usda-derived requires values, dataset and servings' });
  }
  if (origin === 'unavailable' && (known !== 0 || reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'unavailable requires all-null values and a reason' });
  }
});

export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/);

export const userPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().max(60).optional(),
  diet: z.enum(DIET_TAGS),
  allergies: z.array(z.string().min(1)).max(20),
  goal: z.enum(NUTRITION_GOALS),
  budget: z.enum(BUDGET_BANDS),
  dislikedIngredients: z.array(z.string().min(1)).max(30),
  mealTimes: z.strictObject({
    breakfast: clockTimeSchema,
    lunch: clockTimeSchema,
    dinner: clockTimeSchema,
  }),
  aiEnabled: z.boolean(),
  themeMode: z.enum(THEME_MODES),
});

/** Retrieval preferences — the narrow projection the chat route accepts (§5.4). */
export const retrievalPreferencesSchema = z.strictObject({
  diet: z.enum(DIET_TAGS),
  allergies: z.array(z.string().min(1)).max(20),
  dislikedIngredients: z.array(z.string().min(1)).max(30),
});

export const chatRequestSchema = z.strictObject({
  question: z.string().trim().min(1).max(500),
  preferences: retrievalPreferencesSchema,
});

export const recommendationRequestSchema = z.strictObject({
  mealPeriod: z.enum(MEAL_PERIODS),
  aiEnabled: z.boolean(),
  preferences: z.strictObject({
    diet: z.enum(DIET_TAGS),
    allergies: z.array(z.string().min(1)).max(20),
    goal: z.enum(NUTRITION_GOALS),
    budget: z.enum(BUDGET_BANDS),
    dislikedIngredients: z.array(z.string().min(1)).max(30),
  }),
  favoriteMealIds: z.array(z.string()).max(200),
});

/** What the model is allowed to return. Nothing here can hold a fabricated fact. */
export const chatModelReplySchema = z.strictObject({
  answered: z.boolean(),
  answer: z.string().min(1).max(700),
  citedMealIds: z.array(z.string().min(1).max(200)).max(5),
});

export const explanationReplySchema = z.strictObject({
  mealId: z.string().min(1),
  reason: z.string().min(1).max(240),
});
```

`z.strictObject` everywhere a body is parsed: an unexpected field is a 400, not a silent ignore.

### 3.4 Wire contracts

```ts
export interface MealListResponse {
  readonly meals: readonly Meal[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface RecommendationResponse {
  readonly mealPeriod: MealPeriod;
  readonly recommendations: readonly Recommendation[];
}

export interface ChatResponse {
  readonly answered: boolean;
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly source: 'gemma' | 'local';
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, readonly string[]>>;
  };
}
```

Success responses carry the payload directly — no envelope (SDD §7.1).

### 3.5 Error codes

```ts
export const API_ERROR_CODES = [
  'invalid_request',
  'meal_not_found',
  'ai_disabled',
  'ai_unavailable',
  'ai_busy',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
```

| Status | Code | Cause | `retryable` |
|---|---|---|---|
| 400 | `invalid_request` | Body failed schema validation. `details` carries field paths | `false` |
| 404 | `meal_not_found` | Unknown meal id | `false` |
| 503 | `ai_disabled` | `AI_ENABLED=false` | `false` |
| 503 | `ai_unavailable` | Model unreachable, timed out, returned an unparseable reply, or the reply failed containment | `true` |
| 503 | `ai_busy` | Another AI call is in flight | `true` |

Messages are fixed local strings. Nothing from an upstream error text reaches a response body or a
log line.

---

## 4. Domain — `packages/domain`

Pure functions. No I/O, no clock, no React, no Express. Every function here is directly unit testable
and every one of them is tested (§8.2).

Modules: `text.ts`, `money.ts`, `meal-period.ts`, `allergens.ts`, `allergen-lexicon.ts`, `diet.ts`,
`scoring.ts`, `relevance.ts`, `chat-retrieval.ts`, `answer.ts`, `answer-lexicon.ts`.

### 4.1 Text primitives — `text.ts`

```ts
export function normalizeText(value: string): string;
export function tokenize(value: string): string[];
export function tokenizeSegments(value: string): string[][];
export function singularize(token: string): string;
export function kebabCase(value: string): string;
export function singularKebabCase(value: string): string;
export function compareIds(a: string, b: string): number;
export function containsTokenSequence(haystack: readonly string[], needle: readonly string[]): boolean;
```

`normalizeText`: NFD-normalise, strip diacritics (`/\p{Diacritic}/gu`), lowercase, replace every run
of non-`[a-z0-9]` with a single space, trim. So `"Crème Brûlée"` → `"creme brulee"`.

`tokenize`: `normalizeText`, then split on space. Empty input yields `[]`, not `['']`.

`tokenizeSegments`: split the raw string on `/[,;:()[\]{}/|]+/` **first**, then tokenize each segment.
This is what stops a multi-word phrase from matching across a comma — `"milk, chocolate"` must not
match the phrase rule for `"milk chocolate"`.

`singularize`: `-ies` → `-y` (length > 4); `(ss|zz|x|ch|sh|o)es` → drop `es` (length > 4); trailing
`s` → drop, unless the word ends `ss` or `us` (length > 3). Otherwise unchanged. Deliberately naive:
it runs on ingredient nouns, not prose.

`compareIds`: `-1 | 0 | 1` by code-unit order. Used as the universal tie-break so that ordering is
stable across every sort in the system.

`containsTokenSequence`: true when `needle` appears as a contiguous run in `haystack`. Whole tokens
only — never a substring match, because substring matching is how `"nut"` matches `"minute"`.

### 4.2 Money — `money.ts`

```ts
export function money(amountCents: number): Money;
export function addMoney(a: Money, b: Money): Money;
export function sumMoney(values: readonly Money[]): Money;
export function formatMoney(value: Money): string;   // 1010 -> "$10.10"
```

Integer cents throughout. No floating-point arithmetic on money at any point, including in tests.

### 4.3 Meal-period detection — `meal-period.ts`

Satisfies PRD FR-004. Called only by the mobile app (§5.4 explains why the server never runs it).

```ts
export const MEAL_PERIOD_WINDOW = { minutesBeforeAnchor: 90, minutesAfterAnchor: 120 } as const;
export const MEAL_PERIOD_PRIORITY = ['breakfast', 'lunch', 'dinner'] as const;
export const MINUTES_PER_DAY = 1440;

export type AnchoredMealPeriod = (typeof MEAL_PERIOD_PRIORITY)[number];
export interface MealTimes { readonly breakfast: string; readonly lunch: string; readonly dinner: string }

export function parseClockTime(value: string): number;           // "13:05" -> 785; throws RangeError otherwise
export function mealPeriodForMinutes(minutes: number, mealTimes: MealTimes): MealPeriod;
export function mealPeriodForDate(localTime: Date, mealTimes: MealTimes): MealPeriod;
```

Algorithm for `mealPeriodForMinutes`:

1. Wrap `minutes` into `[0, 1440)`. The wrap handles negatives correctly — `((n % 1440) + 1440) % 1440`, not `n % 1440`.
2. For each of `breakfast`, `lunch`, `dinner` in that order:
   a. `anchor = parseClockTime(mealTimes[period])`.
   b. `offset = withinDay(minutes - anchor + 720) - 720` — the shortest **signed** distance from anchor to now, in `[-720, 720)`. Negative means before the anchor.
   c. In-window when `offset >= -90 && offset <= 120`. **Both ends inclusive.**
   d. Track the smallest `|offset|` seen.
3. Return the period with the smallest `|offset|`. A strict `<` comparison means that on an exact tie the earlier entry of `MEAL_PERIOD_PRIORITY` wins.
4. If no window matched, return `'snack'`.

The signed-offset step is what makes windows wrap midnight with no special case: a 23:30 dinner
anchor and a 00:15 clock produce `offset = 45`, in-window, without any date arithmetic.

Required boundary vectors (§8.2): exactly `anchor - 90` → in; `anchor - 91` → out; exactly
`anchor + 120` → in; `anchor + 121` → out; a time equidistant between two anchors → the earlier
period; 00:00 with a 23:30 anchor; a time in no window → `'snack'`.

### 4.4 Allergens — `allergens.ts`, `allergen-lexicon.ts`

The one module where a defect is a safety issue. Satisfies PRD FR-007 and FR-015.

```ts
export interface AllergenSubject {
  readonly allergenTags: readonly string[];
  readonly ingredients: readonly { readonly name: string }[];
}

export function isCanonicalAllergen(value: string): value is CanonicalAllergen;
export function normalizeAllergen(value: string): CanonicalAllergen | null;
export function inferAllergensFromIngredients(names: readonly string[]): ReadonlySet<CanonicalAllergen>;
export function closeAllergenImplications(tags: ReadonlySet<CanonicalAllergen>): ReadonlySet<CanonicalAllergen>;
export function effectiveAllergenTags(subject: AllergenSubject): ReadonlySet<string>;
export function conflictingAllergens(subject: AllergenSubject, userAllergies: readonly string[]): string[];
export function hasAllergenConflict(subject: AllergenSubject, userAllergies: readonly string[]): boolean;
```

**Lexicon shape.** `allergen-lexicon.ts` holds three tables. They are data, and they live in that
file rather than in this document:

```ts
/** A tag implies another. `wheat` implies `gluten`. */
export const ALLERGEN_IMPLICATIONS: Partial<Record<CanonicalAllergen, readonly CanonicalAllergen[]>>;

/** Multi-word rules, compiled longest-first. `tags: []` is a SUPPRESSOR. */
export const ALLERGEN_PHRASES: readonly { tokens: readonly string[]; tags: readonly CanonicalAllergen[] }[];

/** Single words -> the allergens they carry. A word may carry several. */
export const ALLERGEN_TOKENS: Record<string, readonly CanonicalAllergen[]>;
```

Suppressors are the mechanism that prevents the false positives this design would otherwise produce
in bulk. `coconut` is in the tree-nut token list, so `"coconut milk"` needs a phrase rule tagging it
`tree-nut` and nothing else; `"water chestnut"` needs a rule with `tags: []` so that `chestnut` never
fires; `"oat milk"`, `"rice flour"`, and `"gluten free"` are all suppressors for the same reason.

**Inference algorithm** (`inferAllergensFromIngredients`), per ingredient name:

1. Split the name into segments (`tokenizeSegments`), then singularise each token.
2. For each segment: run the phrase pass first. Every `ALLERGEN_PHRASES` entry that matches marks its tokens **consumed** and contributes its tags (a suppressor contributes nothing but still consumes).
3. Then the token pass: for each token **not consumed**, add every allergen in `ALLERGEN_TOKENS[token]`.
4. Finally run the phrase pass once more over the whole name unsegmented, so a phrase that legitimately spans a segment boundary is not lost.

The asymmetry in step 4 is deliberate: suppression is segment-scoped so it cannot silently reach
across a comma, while addition is not, because failing to add an allergen is the dangerous direction.

**Effective tags** (`effectiveAllergenTags`): declared ∪ inferred, then implication-closed.

1. For each declared tag: `singularKebabCase` it, keep the literal in the result set, and if it is canonical add it to the canonical set; if it is not canonical, run inference on it (so a record tagged `"peanuts"` or `"almond"` still resolves).
2. Add everything inferred from the ingredient names.
3. Close under `ALLERGEN_IMPLICATIONS` to a fixpoint.
4. Return the union of closed canonical tags and the raw literals.

**Conflict detection** (`conflictingAllergens`) — three independent paths, any one of which is a
conflict, returned sorted:

1. The user's allergy, canonicalised, is in the meal's effective tag set.
2. The allergy term appears literally as a token sequence in an ingredient name. This catches an
   allergy the taxonomy has never heard of — `"cilantro"` — which is the case the whole of §4.4
   otherwise misses.
3. The allergy term is ambiguous (`normalizeAllergen` returns `null`) but inference over it produces
   a tag the meal has.

`hasAllergenConflict` is `conflictingAllergens(...).length > 0`. It runs before scoring (§4.6) and
before retrieval hands anything to the model (§4.8). No downstream step can reverse it.

### 4.5 Diet compatibility — `diet.ts`

```ts
/** User diet -> meal tags that satisfy it. Empty means no requirement. */
const SATISFIED_BY: Record<DietTag, readonly DietTag[]> = {
  regular: [],
  vegetarian: ['vegetarian', 'vegan'],
  vegan: ['vegan'],
  'halal-preference': ['halal-preference', 'vegan'],
  'gluten-aware': ['gluten-aware'],
};

export function isDietCompatible(userDiet: DietTag, mealDietTags: readonly DietTag[]): boolean;
export function unmetDietRequirement(userDiet: DietTag, mealDietTags: readonly DietTag[]): readonly DietTag[];
```

Two asymmetries, both intentional and both tested: vegan satisfies vegetarian but not the reverse;
vegan satisfies halal-preference but vegetarian does not.

### 4.6 Scoring — `scoring.ts`

Satisfies PRD FR-008. Deterministic for identical input and catalog version.

```ts
export const RECOMMENDATION_WEIGHTS = {
  mealPeriodMatch: 30,
  dietCompatible: 20,
  goalMatchMax: 15,
  budgetMatchMax: 15,
  previousLike: 10,
  preparationTimeFitMax: 5,
  localAvailability: 5,
  dislikedIngredientPenalty: -50,
} as const;

export const SCORE_BOUNDS = { min: 0, max: 100 } as const;

export const GOAL_BANDS = {
  highProtein: [
    { minGrams: 25, points: 15 },
    { minGrams: 15, points: 10 },
    { minGrams: 8, points: 5 },
  ],
  lowerCalorie: [
    { maxKcal: 400, points: 15 },
    { maxKcal: 600, points: 10 },
    { maxKcal: 800, points: 5 },
  ],
  balanced: { minKcal: 350, maxKcal: 700, insidePoints: 15, outsidePoints: 7 },
} as const;

export const BUDGET_BAND_MAX_CENTS = { low: 900, medium: 1600, high: Number.MAX_SAFE_INTEGER } as const;
export const BUDGET_TOLERANCE = { numerator: 5, denominator: 4, points: 7 } as const;

export const PREPARATION_TIME_BANDS = [
  { maxMinutes: 15, points: 5 },
  { maxMinutes: 30, points: 3 },
  { maxMinutes: 45, points: 1 },
] as const;

export const MAX_RECOMMENDATIONS = 3;
```

Per-policy rules:

| Policy | Rule |
|---|---|
| `meal-period-match` | `meal.mealPeriods.includes(period)` → 30, else 0 |
| `diet-match` | `isDietCompatible` → 20, else 0 |
| `goal-match` | See below |
| `budget-match` | `price <= ceiling` → 15. Else `price * 4 <= ceiling * 5` → 7. Else 0 |
| `previous-like` | Meal id is in `favoriteMealIds` → 10, else 0 |
| `preparation-time-fit` | First band whose `maxMinutes >= preparationMinutes` → its points. Over 45 → 0 |
| `local-availability` | `meal.available` → 5, else 0 |
| `disliked-ingredient` | `matchCount * -50` |

`goal-match`: read the relevant nutrient; if `null`, **0 points with the detail "not available"** —
never a default and never a guess. `high-protein` takes the first band whose `minGrams` the value
meets; `lower-calorie` the first whose `maxKcal` it is under; `balanced` awards 15 inside
350–700 kcal and 7 outside.

The budget tolerance is integer arithmetic (`price * 4 <= ceiling * 5`), not `price <= ceiling * 1.25`.
A meal at exactly 125% of the ceiling must score 7, and floating-point makes that a coin flip.

Pipeline:

```ts
export interface RecommendationContext {
  readonly period: MealPeriod;
  readonly preferences: RecommendationPreferences;
  readonly favoriteMealIds: readonly string[];
}

export interface ScoredMeal {
  readonly meal: Meal;
  readonly score: number;
  readonly scoreReasons: readonly ScoreReason[];
}

export type RejectionReason = 'allergen-conflict' | 'diet-incompatible' | 'unavailable';

export interface RecommendationResult {
  readonly candidates: readonly ScoredMeal[];
  readonly selected: readonly ScoredMeal[];
  readonly rejected: readonly { meal: Meal; reason: RejectionReason; detail: string }[];
}

export function scoreMeal(context: RecommendationContext, meal: Meal): ScoredMeal;
export function recommend(context: RecommendationContext, meals: readonly Meal[]): RecommendationResult;
```

`recommend`, in order: hard-reject allergen conflicts → hard-reject diet incompatibility →
hard-reject unavailable → score the rest → clamp each to 0–100 → sort by score descending then
`compareIds` ascending → take 3. Rejections carry their reason so a test can assert *why* a meal was
dropped, not merely that it was.

Normalise `-0` to `0` at the point a policy's points are recorded. It is a real hazard: `-0` serialises
as `0` but fails `Object.is` against it, which makes a snapshot test fail for a reason nobody will
find quickly.

### 4.7 Relevance ranking — `relevance.ts`

One implementation, two callers: `GET /api/v1/meals?query=` and chat retrieval (§4.8). That is the
point — the catalog screen and the assistant can never disagree about which meals match a phrase.

```ts
export const RELEVANCE_WEIGHTS = {
  namePhrase: 25,
  nameToken: 10,
  namePrefix: 5,
  ingredientToken: 4,
  tagToken: 3,
  descriptionToken: 2,
} as const;

export const MIN_PREFIX_LENGTH = 3;
export const STOP_WORDS: ReadonlySet<string>;   // ~40 entries, in-file

export interface MealMatch { readonly meal: Meal; readonly score: number }
export function queryMeals(meals: readonly Meal[], query: string): readonly MealMatch[];
```

Algorithm:

1. Tokenize and singularise the query; drop stop words. No tokens left → return `[]`.
2. Build (and memoise per meal) an index: name as a token **array** (order matters for the phrase
   check), and `Set`s for ingredient tokens, description tokens, and tags (diet tags ∪ meal periods).
3. Per query token, sum: name token 10 **or else** name prefix 5 — mutually exclusive, and a prefix
   only counts at `MIN_PREFIX_LENGTH` or longer; plus ingredient 4, tag 3, description 2, each
   independently.
4. If the running score is `> 0` **and** the query tokens appear as a contiguous run in the name
   array, add the 25-point phrase bonus. The score-is-positive guard stops a pure stop-word query
   from earning a phrase bonus against nothing.
5. Drop meals scoring 0 entirely. Sort by score descending, then `compareIds`.

### 4.8 Chat retrieval — `chat-retrieval.ts`

Pure. Runs before any model call (PRD FR-015).

```ts
export const MAX_CHAT_CONTEXT_MEALS = 5;

export interface ChatRetrievalInput {
  readonly question: string;
  readonly preferences: RetrievalPreferences;   // diet, allergies, dislikedIngredients
  readonly meals: readonly Meal[];
}

export interface ChatRetrievalResult {
  readonly eligible: readonly Meal[];   // everything that survived the filters
  readonly context: readonly Meal[];    // <= 5, ranked; what the resolver runs over
}

export function retrieveChatMeals(input: ChatRetrievalInput): ChatRetrievalResult;
```

Steps:

1. Hard-reject allergen conflicts, on **effective** tags (§4.4) — declared ∪ inferred, never declared alone.
2. Drop diet-incompatible meals (§4.5).
3. Drop unavailable meals.
4. Partition the survivors: meals containing a disliked ingredient sort behind those without. **Demote, do not exclude** — this matches the penalty role in §4.6, and excluding would leave a user whose every eligible meal contains one disliked ingredient with no answer at all.
5. Rank each partition with `queryMeals` (§4.7).
6. Take the first 5 across the two partitions, preferred first.
7. If nothing matched lexically, fall back to the eligible set in partition order, still capped at 5. A general question ("what is quick?") matches no meal name, and a grounded answer beats a refusal.

Both outputs are returned because §4.9 needs both: a superlative must be resolved over everything the
user could have, not merely over the five that happened to rank.

### 4.9 Answer resolvers — `answer.ts`, `answer-lexicon.ts`

The centrepiece. The domain computes the answer; the model only phrases it (SDD §9.1).

```ts
export const ANSWER_FIELDS = [
  'price',
  'preparation-time',
  'calories',
  'protein',
  'carbohydrates',
  'fat',
] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

export type Direction = 'lowest' | 'highest';
export type AnswerKind = 'superlative' | 'ordering' | 'listing' | 'count' | 'total';

export interface RankedMeal {
  readonly meal: Meal;
  readonly value: number;
  readonly formatted: string;   // "$10.10", "22 min", "540 kcal", "31 g"
}

export interface ResolvedAnswer {
  readonly kind: AnswerKind;
  readonly statement: string;            // one complete sentence, already correct
  readonly figures: readonly string[];   // every number the statement is permitted to contain
  readonly citedMealIds: readonly string[];
  readonly namedMeals: readonly Meal[];  // the meals the prompt may describe (§5.6)
}

export type UnresolvedReason =
  | 'empty-question'
  | 'no-intent'
  | 'incomplete-intent'
  | 'ambiguous-intent'
  | 'field-unknown'
  | 'field-partially-known'
  | 'no-candidates'
  | 'greeting';

export interface UnresolvedAnswer {
  readonly kind: 'unresolved';
  readonly reason: UnresolvedReason;
}

export type AnswerOutcome = ResolvedAnswer | UnresolvedAnswer;

export function resolveAnswer(question: string, scope: ChatRetrievalResult): AnswerOutcome;
```

**Classification** is a keyword lexicon, not a regex and not a model. `answer-lexicon.ts` holds four
tables — sense terms (field and/or direction), shape terms (`count` / `total` / `ordering` /
`listing`), greeting terms, and count criteria (diet tag, meal period). Matching:

1. Tokenize and singularise the question.
2. Compile every term longest-phrase-first. Walk them in that order; when a phrase matches, **claim**
   its token positions so a shorter phrase inside it cannot also match. This is what makes
   `"preparation time"` beat `"time"` without an ordering hack.
3. More than one shape, more than one field, or conflicting directions → `ambiguous-intent`.
4. No shape, no field, no direction → `greeting` if a greeting term matched, else `no-intent`.
5. A shape needing a field that has none → `incomplete-intent`.

**Resolution** per kind, all through one `gather(candidates, field, direction)` helper:

- `gather` reads the field from every candidate. **If any candidate's value is `null`, it refuses** —
  `field-unknown` when none were readable, `field-partially-known` when some were. Ranking a subset
  and calling it "the cheapest" would be a true sentence about a set the user did not ask about.
- Sort with `compareIds` as the tie-break, so the answer is stable.
- `superlative` → the head, plus explicit ties. `ordering` → all entries. `count` → an integer.
  `total` → `sumMoney`. `listing` → the meals shown.

**Scope rule.** `superlative` and `count` assert something about the user's whole eligible set, so
they resolve over `scope.eligible`. `ordering`, `listing`, and `total` describe what is in front of
the user, so they resolve over `scope.context`. Getting this backwards produces the subtlest bug in
the system: "the cheapest meal is X" where X is merely the cheapest of five.

**Figures.** `figures` is derived from the **formatted** strings, never the raw numbers — `1010`
becomes `"$10.10"`, and `"10.10"` is what a reader will see, so `"10.10"` is what must be permitted.
Per kind: superlative → the winner's figure only; ordering and total → every entry's figure plus the
total; count → the count only, never the candidate count; listing → the number shown.

`figures` being empty is meaningful: it forbids **every** number in the answer. §5.7 must not treat
empty as "skip the check".

**`namedMeals`** is the resolution of conflict 1(a): the meals the prompt is allowed to describe.
Superlative → winner and ties. Ordering → entries. Listing → shown meals. Total → entries. Count →
**empty**, because the answer is a number and no meal needs describing.

---

## 5. Server — `apps/server`

### 5.1 Boot sequence

1. Parse and validate the environment (§5.2). A failure exits non-zero with the offending variable named.
2. Load `meals.json` and validate every record against `mealSchema`. A failure exits non-zero with the record index and the failing field path. The server does not start on unvalidated safety data (SDD §5.3).
3. Build the in-memory catalog: the array, plus a `Map<string, Meal>` by id.
4. Mount middleware (§5.3), then routes (§5.4).
5. Listen. **Ollama is never probed at boot** — an outage degrades a feature, it does not block startup.

### 5.2 Configuration

Parsed once with Zod at boot into a frozen object. No `process.env` read anywhere else.

| Variable | Type | Default | Notes |
|---|---|---|---|
| `PORT` | integer 1–65535 | `4000` | |
| `AI_ENABLED` | boolean | `true` | `false` → chat returns `ai_disabled`; recommendations use fallback text |
| `AI_FAKE` | boolean | `false` | Replaces the model call with a deterministic echo (§5.5) |
| `OLLAMA_BASE_URL` | url | `http://localhost:11434` | Trailing slashes stripped |
| `OLLAMA_MODEL` | non-empty string | `gemma3:4b` | |
| `AI_KEEP_ALIVE` | duration string | `30m` | See below |
| `OLLAMA_CHAT_TIMEOUT_MS` | integer 1000–120000 | `30000` | |
| `OLLAMA_EXPLANATION_TIMEOUT_MS` | integer 1000–60000 | `12000` | |

**`AI_KEEP_ALIVE` is validated against `/^\d+(ms|s|m|h)$/` and a bare integer is rejected at boot**
with the message: `AI_KEEP_ALIVE=30 means 30 seconds; write 30m for 30 minutes.` Ollama reads a bare
number as seconds, so `30` would evict the model between questions and resurface as a ~60-second cold
load disguised as an ordinary timeout — a config error that costs an afternoon to trace.

The variable is **not** named `OLLAMA_KEEP_ALIVE`: that is Ollama's own server-side environment
variable, read by `ollama serve`. Two variables with one name in two scopes fail silently — set it in
the wrong place and nothing happens, with no error to notice. `OLLAMA_BASE_URL` and `OLLAMA_MODEL`
keep their prefix; neither collides (Ollama's own host variable is `OLLAMA_HOST`).

Generation parameters are **constants, not configuration** — they change what the model writes, not
where it runs, so they belong in source next to the prompt they were tuned against:

```ts
export const GENERATION = { numCtx: 4096, numPredict: 300, temperature: 0, seed: 7 } as const;
```

`temperature: 0` with a fixed `seed` because this lane restates a decided answer and has no creative
requirement; a containment failure you cannot reproduce is one you cannot fix. Reproducibility holds
for one model, one Ollama version, one machine — it is a debugging property, not a guarantee, and no
test asserts on exact model wording.

### 5.3 Middleware

In order:

1. `cors` — origin allowlist from `PORT` siblings plus the Expo dev server; credentials off.
2. `express.json({ limit: '64kb' })`.
3. Request log line (§5.8).
4. Routes.
5. 404 handler → `meal_not_found` shape for `/api/v1/meals/*`, a plain 404 otherwise.
6. Error handler → maps a thrown `ApiError` to its status; anything else is a 500 with a fixed message and a logged stack.

No rate limiter, no helmet, no request-id header (SDD §12).

### 5.4 Route contracts

```http
GET  /health
GET  /api/v1/meals
GET  /api/v1/meals/:mealId
POST /api/v1/recommendations
POST /api/v1/chat
```

**`GET /health`** → `200 { "status": "ok", "catalogVersion": "1.0.0", "mealCount": 60 }`. No dependency probing.

**`GET /api/v1/meals`** — query params, all optional, all allowlisted:

| Param | Type | Rule |
|---|---|---|
| `page` | integer | ≥ 1, default 1 |
| `pageSize` | integer | 1–50, default 20 |
| `period` | `MealPeriod` | |
| `diet` | `DietTag` | |
| `maxPriceCents` | integer | ≥ 0 |
| `query` | string | 1–100 chars |

Filter, then sort: by relevance when `query` is present (§4.7), by name ascending otherwise. Then
paginate. Returns `MealListResponse`. An unknown query parameter is ignored, not an error — the
allowlist is the contract.

**`GET /api/v1/meals/:mealId`** → `Meal`, or 404 `meal_not_found`.

**`POST /api/v1/recommendations`** — body per `recommendationRequestSchema`:

```json
{
  "mealPeriod": "lunch",
  "aiEnabled": true,
  "preferences": {
    "diet": "vegetarian",
    "allergies": ["peanut"],
    "goal": "high-protein",
    "budget": "medium",
    "dislikedIngredients": ["mushroom"]
  },
  "favoriteMealIds": ["meal-greek-yogurt-bowl"]
}
```

**The client sends `mealPeriod`; it does not send a timestamp or `mealTimes`.** Home must display the
current period before any request returns and with the server down, so the app computes it from
§4.3 regardless. Sending a timestamp and having the server recompute would derive one fact along two
paths that can disagree — across a minute boundary, on a timezone read, or because one of two copies
of `mealTimes` is stale. Derive it once, pass the result. **The server therefore holds no clock and
no timezone logic on any path.** This is safe because no trust boundary is crossed: the clock and the
preferences are both the user's own, and the schema validates `mealPeriod` against four values.

Response: `RecommendationResponse`. Explanations are attempted only when `aiEnabled` is true **and**
`AI_ENABLED` is true; a failure yields `explanationSource: "fallback"` and the request still succeeds.

**`POST /api/v1/chat`** — body per `chatRequestSchema`. `preferences` accepts exactly `diet`,
`allergies`, `dislikedIngredients`; anything else is a 400. `goal` and `budget` are absent because
retrieval does not read them, and a required field that changes nothing is a field that will
eventually be believed.

Handler:

1. Parse the body → 400 on failure.
2. `retrieveChatMeals` (§4.8). Empty `eligible` → `200 { answered: false, answer: <no-eligible-meals copy>, citations: [], source: "local" }`. **No model call.**
3. `resolveAnswer` (§4.9). `UnresolvedAnswer` → `200 { answered: false, ... , source: "local" }`. **No model call.**
4. `AI_ENABLED === false` → 503 `ai_disabled`.
5. Phrase through the AI lane (§5.5). Success → `200 { answered: true, answer, citations, source: "gemma" }`, citations resolved from `namedMeals` by id. Failure → 503 `ai_unavailable` or `ai_busy`.

`answered: false` is HTTP 200. It is the endpoint answering correctly, not failing.

### 5.5 The AI lane

**Single-flight.** One AI call at a time, process-wide. A second concurrent request returns 503
`ai_busy` immediately — no queue. On a single-user local app, waiting behind another inference is not
a state worth building machinery for.

```ts
export interface AiLane {
  run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T>;
}
```

`run` rejects with `AiBusyError` when occupied, `AiTimeoutError` when the deadline passes. The
`AbortController` is always cleaned up in a `finally`.

**`AI_FAKE`.** A real code path selected by config, not a test mock: the route, retrieval,
resolution, prompt construction, and containment all execute exactly as in production, and only the
HTTP call to Ollama is replaced by a function returning
`{ answered: true, answer: resolved.statement, citedMealIds: resolved.citedMealIds }`. That reply
passes containment by construction, which is the point — CI has no model, and the assistant is the
feature most worth covering.

**Ollama request.** `POST {OLLAMA_BASE_URL}/api/generate`, headers
`{accept: application/json, content-type: application/json}`:

```ts
{
  model: config.ollamaModel,
  prompt,                       // the string from §5.6, nothing else
  stream: false,
  format: chatFormat(promptMealIds),   // built per request, below
  keep_alive: config.aiKeepAlive,   // the duration string, passed through
  options: {
    num_ctx: GENERATION.numCtx,
    num_predict: GENERATION.numPredict,
    temperature: GENERATION.temperature,
    seed: GENERATION.seed,
  },
}
```

**Response decoding is two-stage**, because Ollama's envelope carries the model's JSON as a *string*:

1. Parse the envelope: `{ response: string, done_reason?: string | null }`.
2. `response.trim() === ''` → failure `empty-reply`.
3. `done_reason === 'length'` → failure `truncated`. A truncated reply is never a partial success.
4. `JSON.parse(response)`, then validate with `chatModelReplySchema` (§3.3).

No repair loop and no retry on either lane. A schema violation is a failure.

**The chat JSON Schema is built per request**, and `citedMealIds.items` is an `enum` of exactly the
ids in the prompt:

```ts
function chatFormat(promptMealIds: readonly string[]) {
  return {
    type: 'object',
    properties: {
      answered: { type: 'boolean' },
      answer: { type: 'string', minLength: 1, maxLength: 700 },
      citedMealIds: {
        type: 'array',
        maxItems: 5,
        items: promptMealIds.length === 0
          ? { type: 'string', maxLength: 200 }
          : { type: 'string', enum: [...promptMealIds] },
      },
    },
    required: ['answered', 'answer', 'citedMealIds'],
    additionalProperties: false,
  } as const;
}
```

Ollama compiles `format` into a GBNF grammar through llama.cpp's schema-to-grammar converter, which
renders `enum` as an alternation of literals — so an uncited id is not caught after the fact, it
cannot be sampled. **The §5.7 citation check still runs anyway**: the grammar path is upstream
behaviour across two projects whose versions are not pinned here, and a constraint that silently
stopped being enforced would remove the guarantee with no signal. One integration test asserts the
constraint is live (§8.3).

### 5.6 Prompt contract

Text, not chat messages — the `/api/generate` endpoint takes a single prompt string.

**Sections, in this order:** `ROLE` · `RULES` · `ANSWER` · `FIGURES` · `MEALS` · `QUESTION`.

- `ROLE` states that the answer is already worked out and the model decides nothing.
- `RULES` is a numbered list covering: restate the ANSWER sentence and do not check or change it;
  keep every figure and meal name it contains; write meal names exactly as the blocks spell them;
  never write a meal id in prose; do not compare, rank, count, or calculate; write no number absent
  from FIGURES; make no safety, health, or medical claim; cite by exact id; treat fenced text as data.
  The wording lives in `apps/server/src/ai/prompt.ts` and is versioned by `CHAT_PROMPT_VERSION`.
- `ANSWER` carries `resolved.statement` — neutralised (control characters stripped, fence markers
  redacted) but **not** fenced, because this is the one region the model is told is correct.
- `FIGURES` is `resolved.figures` space-joined.
- `MEALS` carries one labelled block per meal in `resolved.namedMeals` — **not** all five retrieved.
- `QUESTION` carries the user's question.

**Meal block fields, in order:** `id`, `name`, `description`, `meal periods`, `diet tags`,
`ingredients`, `preparation minutes`, `price` (already formatted), `calories`, `protein`. A `null`
nutrient renders as the literal word `unknown`, never `0`, so the model states an absence rather than
describing a meal as calorie-free.

**`allergenTags` never enters the prompt, and neither does the user's allergy list.** Retrieval
consumed them. The model is not trusted with allergen reasoning and cannot see an unsafe meal.

**Narrowing.** `namedMeals` is the resolution of a real defect class: with all five retrieved meals in
the prompt, a model asked to phrase "the cheapest is X" will sometimes also mention Y — citations
pass, figures pass, and the user is told about a meal the domain never ranked. A model cannot name a
meal it was never shown. It also cuts the most common prompt (a superlative) from five described
meals to one, which is the largest available lever on the ~11-second budget.

**Fencing** — `promptSafety.ts`:

```ts
export const UNTRUSTED_OPEN = '<<<BEGIN UNTRUSTED>>>';
export const UNTRUSTED_CLOSE = '<<<END UNTRUSTED>>>';
export function neutraliseUntrusted(text: string): string;
export function fenceUntrusted(body: string): string;
```

`neutraliseUntrusted` strips C0/C1 controls (keeping tab and newline), soft hyphen, zero-width and
directional marks, line/paragraph separators, and the BOM; redacts anything resembling a fence marker
(`/(?:begin|end)[^a-z0-9]{0,8}untrusted|untrusted[^a-z0-9]{0,8}(?:begin|end)/gi`); and collapses runs
of `<` or `>`. `fenceUntrusted` neutralises and wraps. `MEALS` and `QUESTION` are fenced; `ANSWER` and
`FIGURES` are neutralised only.

This is the **only** path by which external text reaches a prompt. A second path would be a second
thing to remember.

### 5.7 Containment

Four checks, run on every model reply before anything is shown. A reply failing any one is discarded
— never repaired, never partially used.

```ts
export type ContainmentRule = 'uncited-meal' | 'denied-claim' | 'ungrounded-figure' | 'ungrounded-meal';
export type ContainmentVerdict =
  | { readonly contained: true }
  | { readonly contained: false; readonly rule: ContainmentRule; readonly evidence: string };

export function containReply(reply: ChatModelReply, ground: ContainmentGround): ContainmentVerdict;
```

**1. Citations.** Every `citedMealIds` entry must be an id present in the prompt. Defence in depth
behind §5.5's grammar constraint.

**2. Denied claim.** `DENIED_CLAIMS` in `apps/server/src/ai/claimDenylist.ts` — the terms PRD FR-015
forbids, with their inflections: *allergen free, allergy free, safe, unsafe, healthy, healthier,
healthiest, cures, treats, medically, doctor, doctors, prescribes, prescribed, you should eat, you
should avoid*. Matching flattens the answer (lowercase, non-alphanumeric → single space, wrap in
spaces) and tests for `" phrase "`, so it is whole-word and cannot fire inside a longer word.
**Negation is not an exemption**: "this is not healthy" is still a health verdict.

**3. Ungrounded figure.** Every number in the answer must appear in the permitted set.

```ts
export function quotedFigures(text: string): readonly string[];
export function normaliseFigure(figure: string): string;   // strips grouping commas; keeps the decimal point
```

Extraction covers digit runs (`/\d+(?:[.,]\d+)*/g`) **and spelled cardinals** — units zero–nine,
teens, and tens with an optional following unit ("twenty two" → `22`). `"one"` is excluded as a
standalone figure, because it is far more often an article than a count. Comparison is **string
identity after normalisation**: no numeric equivalence, so `22` and `22.0` are different figures.
That is intentional — the user sees a string.

The permitted set is `resolved.figures` plus any digits appearing in the prompt's meal *names*.
**An empty permitted set forbids every figure; it does not skip the check** — which is exactly the
case when a meal's nutrition is all `null`.

This check is why the model's word choice is not the threat model. Thirty-five probes against
`gemma3:4b` found it answering four of six comparison questions wrongly with the correct data in
context — each a wrong *number* in fluent prose that every word-level check passes.

**4. Ungrounded meal.** The answer must not contain the name of a meal that is not in the prompt.
Catches a name recalled from the model's own training rather than from the context.

The same checks 2 and 3 run over the explanation lane's `reason` field. A failure there falls back to
template text and the recommendation still succeeds; a failure on the chat lane is 503
`ai_unavailable`. The client is never told which rule fired — a containment rule is not something a
caller should be able to probe for.

### 5.8 Logging

One structured JSON line per request: `timestamp`, `level`, `method`, `routeTemplate` (the template,
never the concrete path), `status`, `durationMs`, and `errorCode` when set. AI calls add `lane`
(`chat` | `explanation`), `durationMs`, and `outcome` (`ok` | `timeout` | `schema` | `contained` |
`unreachable`).

Never logged: prompts, questions, answers, allergy lists, names, or request bodies.

---

## 6. Mobile — `apps/mobile`

### 6.1 Boot and hydration

Satisfies PRD FR-001. Three phases, and the phase determines which screens exist — not a redirect on
top of a mounted tree:

```ts
export type BootPhase = 'hydrating' | 'onboarding' | 'app';
```

1. `hydrating` — only `Splash` is registered. One `multiGet` across all six keys plus the quarantine key, then six independent decodes. A failure on one key never affects another and hydration never rejects.
2. `onboarding` — `Onboarding` and `DietarySetup`, gestures disabled.
3. `app` — the tab navigator plus the stack screens.

Protected navigation cannot render before hydration completes, because during `hydrating` those
screens are not in the navigator at all.

### 6.2 Navigation

One route table is the source of truth: `src/navigation/routes.ts`.

```ts
export type RootParamList = {
  Splash: undefined;
  Onboarding: undefined;
  DietarySetup: DietarySetupParams | undefined;
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  HomeTab: NavigatorScreenParams<HomeStackParamList> | undefined;
  Home: undefined;
  ExploreTab: NavigatorScreenParams<ExploreStackParamList> | undefined;
  Explore: ExploreParams | undefined;
  AssistantTab: NavigatorScreenParams<AssistantStackParamList> | undefined;
  Assistant: AssistantParams | undefined;
  SavedTab: NavigatorScreenParams<SavedStackParamList> | undefined;
  Saved: SavedParams | undefined;
  MealForm: MealFormParams | undefined;
  MealDetails: MealDetailsParams;
  Settings: undefined;
};
export type RouteName = keyof RootParamList;

export interface DietarySetupParams { readonly returnTo: 'Onboarding' | 'Settings' }
export interface ExploreParams { readonly query?: string; readonly period?: MealPeriod }
export interface AssistantParams { readonly seedQuestion?: string }
export interface SavedParams { readonly section?: 'favorites' | 'custom' }
export interface MealFormParams { readonly mealId?: string }
export interface MealDetailsParams { readonly mealId: string; readonly origin?: NavigationOrigin }

export const NAVIGATION_ORIGINS = ['home', 'explore', 'saved', 'assistant'] as const;
export const SAVED_SECTIONS = ['favorites', 'custom'] as const;
```

A runtime mirror distinguishes leaf screens from navigator containers, so the two can never drift:

```ts
const ROUTE_KINDS = { /* every RouteName -> 'screen' | 'container' */ }
  as const satisfies Record<RouteName, 'screen' | 'container'>;

export type ScreenRouteName = { [K in RouteName]: (typeof ROUTE_KINDS)[K] extends 'screen' ? K : never }[RouteName];
export const SCREEN_ROUTE_NAMES: readonly ScreenRouteName[];
```

**Screen registry.** Features register their screens; `navigation/` never imports `features/`. This
is what keeps the navigation layer from depending on every feature in the app:

```ts
export type ScreenComponent<K extends ScreenRouteName> = ComponentType<{
  readonly route: RouteProp<RootParamList, K>;
  readonly navigation: NavigationProp<RootParamList>;
}>;

export function registerScreen<K extends ScreenRouteName>(name: K, component: ScreenComponent<K>): void;
export function screenFor<K extends ScreenRouteName>(name: K): ScreenComponent<K>;
```

`screenFor` returns a stable wrapper that reads the registry through `useSyncExternalStore` and
renders a placeholder when nothing is registered. Every `Stack.Screen component=` is `screenFor(name)`,
never a direct feature import.

**Deep-link params are validated at runtime**, because types cannot cover a URL-parsed string:

```ts
export function readStringParam(params: unknown, key: string): string | undefined;
export function readUnionParam<T extends string>(params: unknown, key: string, allowed: readonly T[]): T | undefined;
```

`readStringParam` rejects arrays, which is what a repeated query key produces. The `as const` arrays
above exist as the runtime witnesses these functions check against.

**Tabs:** Home · Explore · Assistant (centre) · Saved · Settings. `MealDetails` presents modally.

### 6.3 State stores

One factory, five configurations. No per-store boilerplate.

```ts
export interface StoreConfig<K extends StorageKeyName, S, A extends { type: string }> {
  readonly name: string;
  readonly key: K;
  readonly create: (persisted: StorageValues[K]) => S;
  readonly reducer: (state: S, action: A) => S;
  readonly project?: (state: S) => StorageValues[K];
}

export interface Store<S, A> {
  readonly Provider: (props: { children: ReactNode }) => ReactElement;
  readonly useValue: () => S;
  readonly useDispatch: () => Dispatch<A>;
  readonly useStatus: () => StoreStatus;
}

export function createStore<K extends StorageKeyName, S, A extends { type: string }>(
  config: StoreConfig<K, S, A>,
): Store<S, A>;
```

`StoreStatus` is `{ hydrated, entryStatus, saving, saveError, saveBlocked, retrySave }`.
`saveBlocked` is true when the write was refused for exceeding a bound (§6.4), which is the case the
UI must present differently — there is nothing to retry.

Three contexts per store (value, dispatch, status) is the memoisation strategy: a component reading
only `useDispatch` does not re-render when the value changes.

**Three invariants**, each of which the tests check:

1. **Namespaced action types**, `slice/verb-past-tense`: `'favorites/added'`, not `'ADD'`.
2. **Action creators only.** Components never construct an action literal.
3. **Reference-preserving reducers.** An idempotent action returns `state` *identically*. Favouriting
   an already-favourite meal must return the same object — that is what suppresses both the re-render
   and the storage write.

Worked example — `state/favorites/favoritesState.ts`:

```ts
export interface FavoritesState { readonly ids: readonly string[] }

export type FavoritesAction =
  | { readonly type: 'favorites/added'; readonly mealId: string }
  | { readonly type: 'favorites/removed'; readonly mealId: string }
  | { readonly type: 'favorites/toggled'; readonly mealId: string }
  | { readonly type: 'favorites/cleared' };

export const favoritesActions = {
  add: (mealId: string): FavoritesAction => ({ type: 'favorites/added', mealId }),
  remove: (mealId: string): FavoritesAction => ({ type: 'favorites/removed', mealId }),
  toggle: (mealId: string): FavoritesAction => ({ type: 'favorites/toggled', mealId }),
  clear: (): FavoritesAction => ({ type: 'favorites/cleared' }),
};

export function favoritesReducer(state: FavoritesState, action: FavoritesAction): FavoritesState;
export function selectFavoriteIds(state: FavoritesState): readonly string[];
export function isFavorite(state: FavoritesState, mealId: string): boolean;

export const favoritesStoreConfig = {
  name: 'favorites',
  key: 'favorites',
  create: (persisted) => ({ ids: persisted }),
  reducer: favoritesReducer,
  project: (state) => state.ids,
} satisfies StoreConfig<'favorites', FavoritesState, FavoritesAction>;
```

Stores: `onboarding`, `preferences`, `favorites`, `customMeals`, `ui`. The sixth storage key,
`meta`, has no store: it is written once at boot through its repository directly.

Persistence runs through a
per-store queue that coalesces writes, exposes `{saving, error}`, and **never writes over a key whose
read status is `unavailable`**.

### 6.4 Storage

```ts
export const STORAGE_KEYS = {
  meta: '@nutritime/meta',
  onboarding: '@nutritime/onboarding',
  preferences: '@nutritime/preferences/v1',
  favorites: '@nutritime/favorites/v1',
  customMeals: '@nutritime/custom-meals/v1',
  ui: '@nutritime/ui/v1',
} as const;
export type StorageKeyName = keyof typeof STORAGE_KEYS;
export const QUARANTINE_KEY = '@nutritime/quarantine/v1';

export const STORAGE_BOUNDS = { favorites: 200, customMeals: 200 } as const;
```

Every value is stored inside an envelope, so a schema version travels with the data:

```ts
export interface StorageEnvelope {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly value: unknown;
}
```

```ts
export interface Repository<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
  clear(): Promise<void>;
}

export interface StorageDriver {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
}

export interface RepositoryDefinition<T> {
  readonly key: string;
  readonly schemaVersion: number;
  readonly schema: ValueSchema<T>;
  readonly fallback: () => T;
  readonly migrations?: Readonly<Record<number, (previous: unknown) => unknown>>;
  readonly bound?: (value: T) => T;
}

export type EntryStatus = 'loaded' | 'default' | 'recovered' | 'unavailable';
export type StorageWriteFailure = 'write-failed' | 'bound-exceeded';
export class StorageWriteError extends Error { readonly key: string; readonly reason: StorageWriteFailure }

export function createRepository<T>(definition: RepositoryDefinition<T>, runtime: RepositoryRuntime): Repository<T>;
```

**Read path:** decode envelope → migrate → validate → bound. Any failure quarantines the raw value
under `QUARANTINE_KEY` (bounded, and never surfaced to the UI), removes the live key, and returns the
fallback with status `recovered`. One key's corruption never touches another's.

**Migration gate:** only `schemaVersion - 1` migrates, and only when a migration function for the
current version exists. Anything older is quarantined rather than guessed at.

**Bounds are refusals, not truncations.** A write that would exceed 200 favourites or 200 custom
meals throws `StorageWriteError('bound-exceeded')` and the UI shows a message with no retry button —
retrying the same value can never succeed. Every entry under these keys is something the user chose
or authored, so a save that silently deleted the oldest one would destroy data the user has already
been shown. **Reads still truncate** and report `recovered`: an over-long entry already on disk is a
fact to recover from, and refusing there would make it permanently unreadable.

`@react-native-async-storage/async-storage` is imported by exactly one file:
`asyncStorageDriver.ts`, a four-method pass-through.

### 6.5 API client

```ts
export interface ApiClient {
  listMeals(query: MealQuery, signal: AbortSignal): Promise<MealListResponse>;
  getMeal(mealId: string, signal: AbortSignal): Promise<Meal>;
  recommend(request: RecommendationRequest, signal: AbortSignal): Promise<RecommendationResponse>;
  ask(request: ChatRequest, signal: AbortSignal): Promise<ChatResponse>;
}
```

Per-route deadlines, each set above the server's own budget so the client never gives up before the
server would:

| Route | Client timeout |
|---|---|
| `GET /api/v1/meals` | 10 s |
| `GET /api/v1/meals/:id` | 10 s |
| `POST /api/v1/recommendations` | 15 s |
| `POST /api/v1/chat` | 35 s |

**Exactly three outcomes**, with no coerced success: the parsed value; an `ApiClientError` carrying
the server's own error envelope verbatim (a code this build has never heard of still arrives intact);
or a transport failure mapped to 503 unreachable / 504 timeout / 502 unreadable.

Two rules that matter more than they look:

1. **Nothing from the wire reaches a user-visible message.** Every message is a fixed local string;
   only the status and the code carry diagnosis. A server error text rendered into a toast is how
   internal detail leaks into a screenshot.
2. **The caller's `AbortSignal` is forwarded to an internal controller, never passed through.**
   Otherwise the client's own timeout abort is indistinguishable from the caller's cancellation, and
   a cancelled screen shows a timeout error.

Headers are `{Accept: application/json}` and, for POST, `{Content-Type: application/json}` —
deliberately nothing else. A custom header would make every GET preflighted.

### 6.6 Theme

Three layers, `src/shared/theme/`:

1. **`primitive.ts`** — raw scales, importable only within the theme directory: `palette`, `space`, `radius`, `stroke`, `duration`, `easing`, `opacity`, `typeScale`, `touch`, `zIndex`.
2. **`semantic.ts`** — roles, not colours. One `SemanticTokens` interface with `surface`, `content`, `accent`, `status`, `statusSurface`, `border`, `scrim`, `effect`; two maps typed by it, so a token missing from dark is a compile error. **Dark is authored, not inverted.**
3. **`component.ts`** — `buildComponentTokens(color: SemanticTokens): ComponentTokens` for button, field, card, chip, sheet, toast, badge, divider, focus ring.

**Typeface.** `Inter` for both headings and body, falling back to the platform system face — SF on
iOS, Roboto on Android — whenever the web font has not loaded. One family carries the entire
hierarchy through weight rather than through a second typeface: 800 for headlines at −0.5 letter
spacing, 600 for subheadings, 400 for body at a 24 px line height, 700 uppercase at +1 tracking for
labels. A display serif is not used for body text at any size, on any screen.

```ts
export function resolveScheme(mode: ThemeMode, systemScheme: ColorScheme | null): ColorScheme;
export function useTheme(): Theme;
```

`mode` is a **prop** on `ThemeProvider`, not internal state: the stored preference lives in
`preferences.themeMode`, so there is one source of truth. The type scale responds to the OS font
scale via `useWindowDimensions().fontScale`.

Feature code contains no colour literals. A contrast test asserts the WCAG AA pairings in both
schemes.

### 6.7 Shared components

Every one takes an optional `testID`. Every state component takes `stillAvailable` — the sentence
that says what still works, which PRD §12 requires.

| Component | Props |
|---|---|
| `AccessibleButton` | `{ label; onPress; variant?; disabled?; loading?; icon?; fullWidth?; accessibilityLabel?; accessibilityHint? }` |
| `AppText` | `{ variant?; tone?; numeric?; level?; align?; children }` |
| `Chip` | `{ label; selected?; toggle?; onPress?; disabled?; accessibilityLabel? }` |
| `Divider` | `{ spacing?; inset? }` |
| `EmptyState` | `{ title?; description?; stillAvailable?; actionLabel?; onAction? }` |
| `ErrorState` | `{ title?; description?; stillAvailable?; retryLabel?; onRetry?; secondaryActionLabel?; onSecondaryAction? }` |
| `FormField` | `{ label; value; onChangeText; error?; hint?; placeholder?; required?; multiline?; maxLength?; keyboardType?; autoCapitalize?; onBlur? }` |
| `Icon` | `{ name: IconName; size?; color?; accessibilityLabel? }` |
| `IconButton` | `{ icon; accessibilityLabel; onPress; disabled?; size? }` |
| `MealCard` | `{ name; imageUrl; priceLabel; preparationMinutes; tags?; reason?; unavailable?; onPress }` |
| `NutritionBadge` | `{ label: string; amount: number \| null; unit: 'kcal' \| 'g' }` |
| `OfflineState` | `{ title?; description?; stillAvailable?; retryLabel?; onRetry? }` |
| `SearchField` | `{ value; onChangeText; onSubmit?; placeholder?; accessibilityLabel? }` |
| `Sheet` | `{ visible; onClose; title; children; hideTitle? }` |
| `StatusMessage` | `{ tone; icon; title; description; stillAvailable?; actionLabel?; onAction?; announceOnMount? }` |
| `Toast` | `{ message; visible; onDismiss; tone?; actionLabel?; onAction?; durationMs? }` |

`NutritionBadge` renders `"Not available"` when `amount` is `null` — never `0` (PRD FR-006, FR-011).
`description` on every state component is user-facing copy, never an exception message.

### 6.8 Screens

| Screen | Route | Data | States |
|---|---|---|---|
| Splash | `Splash` | hydration | loading |
| Onboarding | `Onboarding` | — | — |
| Dietary Setup | `DietarySetup` | preferences store | validation error |
| Home | `Home` | `POST /recommendations` | loading, empty, local-only, AI-fallback notice |
| Explore | `Explore` | `GET /meals` | loading, empty, local-only |
| Meal Details | `MealDetails` | `GET /meals/:id` | loading, not-found, local-only |
| Saved | `Saved` | favorites + customMeals stores | empty (per section) |
| Create/Edit Meal | `MealForm` | customMeals store | validation error, bound-exceeded |
| Assistant | `Assistant` | `POST /chat` | loading, unavailable, answered-false |
| Settings | `Settings` | preferences + ui stores | confirm-destructive |

Home computes the meal period locally through §4.3 and renders it before the request resolves.

---

## 7. Catalog — `packages/catalog`

### 7.1 Contract

`meals.json` holds 60 records, each satisfying `mealSchema` (§3.3), with `catalogVersion: "1.0.0"`
and `source: "local"`. It is exported untyped and validated at the boundary:

```ts
export const seededCatalog: unknown;
```

### 7.2 Seed pipeline

`packages/catalog/seed.ts`, run by hand via `npm run seed`. Never in CI, never at boot.

1. **Select** candidates with `GET /api/json/v1/{key}/filter.php`, then call
   `GET /api/json/v1/{key}/lookup.php?i={id}` **once per meal** for the full record. Filter responses
   are summaries and the API's own guidance is to look up details rather than trust them. Use the
   JSON API; never scrape HTML.
2. **Guard the response.** `meals` may be an array, a string, a legacy object, or `null`:

   ```ts
   function mealsArray(payload: unknown): readonly unknown[] {
     if (typeof payload !== 'object' || payload === null) return [];
     const value = (payload as { meals?: unknown }).meals;
     return Array.isArray(value) ? value : [];   // string | object | null -> no data
   }
   ```

   A no-data or rate-limited reply is not an array. Treating one as an array is the defect this step
   exists to prevent.
3. **Map** into the `Meal` shape — name, description, ingredients, instructions, image URL — and
   capture `provenance` from `idMeal`, `strSource`, `strImageSource` and
   `strCreativeCommonsConfirmed`. The licence requires these to be preserved where present.
4. Derive `allergenTags` from the ingredient list using §4.4, then **correct them by hand**. This is
   the one field where a mistake is a safety issue, so the generated value is a starting point and
   the committed value is reviewed.
5. Assign `dietTags`, `mealPeriods`, `price`, `preparationMinutes`.
6. **Derive `nutrition`** per §7.4. Never author a figure.
7. Validate every record against `mealSchema` and write `meals.json`. A failure aborts the write.

Image URLs still point at TheMealDB, which is why the app fetches images directly. A broken image is
a broken image; it changes no decision the app makes.

### 7.3 Validation gate

Boot revalidates (§5.1). The seed script and the server use the same schema, so a record cannot pass
one and fail the other.

### 7.4 Nutrition derivation contract

Nutrition is computed from published data, never authored. PRD FR-006 is satisfied here.

**Source.** `fndds_ingredient_nutrient_value.csv` from USDA FoodData Central's supporting-data
release — 1,882 ingredients, all carrying all four macros, values **per 100 g**. Nutrient codes:
`208` kcal, `203` protein, `204` fat, `205` carbohydrate. The archive is **not** committed; the seed
script reads it by path from `USDA_DATASET_PATH` and emits a derived subset.

**Committed artifact.** `packages/catalog/nutrition-source.json` — only the ingredients the catalog
actually uses:

```ts
export interface NutrientRow {
  readonly key: string;            // normalised ingredient key
  readonly description: string;    // USDA food description, verbatim
  readonly fdcId: string;
  readonly sourceLabel: string;    // e.g. "SR Legacy"
  readonly per100g: {
    readonly kcal: number;
    readonly proteinGrams: number;
    readonly carbsGrams: number;
    readonly fatGrams: number;
  };
}
```

Every derived figure is therefore traceable to an `fdcId`, and the derivation is reproducible without
the 16 MB archive.

**Algorithm, per meal:**

1. Normalise each ingredient name with §4.1's `normalizeText` plus `singularize`, then apply the
   alias map (British → US spellings, `aubergine → eggplant`, `challots → shallots`, and the
   compound-phrase reductions). Resolve against `NutrientRow.key`.
2. Parse the measure to grams: a unit table (`g`, `kg`, `ml`, `l`, `oz`, `lb`, `cup`, `tbsp`, `tsp`)
   plus a per-ingredient gram-weight map for countable and vague units (`3 cloves`, `1 tin`).
   Fractions (`1/4`) and mixed numbers (`1 1/2`) are supported.
3. Sum each macro across ingredients: `value += per100g.x * grams / 100`.
4. Divide by `servings`, round to the nearest integer, and clamp to §3.3's ranges.

**The all-or-nothing rule.** If any ingredient fails at step 1 or 2, the meal's four values are all
`null`, `nutritionProvenance.origin` is `unavailable`, and `reason` names the ingredient that failed.
No partial sums, no substituted averages, no category defaults. This is the same refusal `gather`
makes in §4.9: a figure the domain cannot fully establish is not reported.

**Servings are authored.** The recipe source publishes no serving count, and it divides all four
values, so an error scales a meal's whole nutrition proportionally. It is recorded in
`nutritionProvenance.servings` and surfaced in the UI (PRD FR-011) as an authored number rather than
a measured one.

**Where the risk actually lives.** Not in the nutrient table, which is authoritative and versioned,
but in steps 1 and 2 and in the serving count. Tests target exactly those: a known ingredient list
whose arithmetic is checked by hand, an unresolvable ingredient forcing `unavailable`, and each
supported unit converted.

---

## 8. Testing

### 8.1 Tiers

| Tier | Files | Environment |
|---|---|---|
| unit | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | node |
| integration | `**/*.integration.test.ts` | node |
| dom | `apps/mobile/src/**/*.dom.test.tsx` | jsdom |
| e2e | `e2e/specs/*.spec.ts` | Playwright |

The `react-native` npm package ships Flow-typed source that esbuild cannot strip, so anything
importing it is untestable under Vitest in node. The `dom` project aliases
`react-native` → `react-native-web` (plain compiled JS) and inlines the navigation and gesture
packages so the alias applies transitively:

```ts
{
  resolve: { alias: { 'react-native': '<root>/node_modules/react-native-web' } },
  test: {
    name: 'dom',
    environment: 'jsdom',
    server: { deps: { inline: [/@react-navigation\//, /react-native-screens/, /react-native-safe-area-context/, /react-native-gesture-handler/] } },
    include: ['apps/mobile/src/**/*.dom.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.dom.mts'],
  },
}
```

The DOM setup file mocks `expo-haptics` and backs AsyncStorage with an in-memory `Map`.

No coverage thresholds. Coverage is reported and read, not enforced.

### 8.2 Required unit vectors

| Module | Must cover |
|---|---|
| `text` | diacritic stripping; segment split on each punctuation class; `singularize` on `-ies`, `-ches`, `-ss`, `-us`; `containsTokenSequence` rejecting a substring match |
| `meal-period` | the seven boundary vectors in §4.3 |
| `allergens` | a suppressor (`coconut milk` → tree-nut only; `water chestnut` → nothing); phrase-beats-token; wheat → gluten closure; an unknown user allergy matched by ingredient name; an ambiguous term; a declared non-canonical tag |
| `diet` | all 5 × 5 pairs; both asymmetries explicitly |
| `scoring` | each policy at each band edge; a `null` nutrient scoring 0 with the "not available" detail; budget at exactly 125% of ceiling; the 0–100 clamp; tie-break on equal scores; every hard-reject reason |
| `relevance` | token-vs-prefix exclusivity; prefix below 3 chars; phrase bonus; stop-words-only query; score-0 omission |
| `chat-retrieval` | safety before ranking; dislike demotion not exclusion; the no-lexical-match fallback; the 5-cap; empty eligible |
| `answer` | every intent; ambiguity → unresolved; the `gather` refusal on a partially-`null` field; superlative scoped to `eligible` and listing scoped to `context`; figures from formatted strings; `namedMeals` empty for `count` |
| `containment` | an uncited id; each denylist phrase including a negated one; a wrong number in clean prose; a spelled cardinal; an empty permitted set forbidding every figure; an ungrounded meal name |
| `promptSafety` | control-character stripping; fence-marker redaction; angle-run collapsing |
| storage | envelope round-trip; each of the five failure reasons quarantining; the `schemaVersion - 1` gate accepting and `-2` refusing; bound refusal on write and truncation on read |
| stores | reference preservation on an idempotent action; hydration not clobbering a pre-hydration edit |

### 8.3 Integration

Supertest against the real Express app with `AI_FAKE=true`:

- Each route's happy path.
- 400 on a malformed body, with `details` naming the field.
- 400 when the chat body carries `goal` or `budget`.
- 404 on an unknown meal id.
- 503 `ai_disabled` when `AI_ENABLED=false`.
- 503 `ai_busy` on a second concurrent AI request.
- `answered: false`, HTTP 200, `source: "local"` when filters exclude everything.
- `answered: false`, HTTP 200 and **no model call** when the question matches no resolver.
- The server exits non-zero on an invalid catalog record.
- The server exits non-zero on `AI_KEEP_ALIVE=30`.

One test is opt-in and requires a real model (`RUN_MODEL_TESTS=1`): **the grammar constraint probe** —
send a prompt and assert the reply cannot contain an id outside the `enum`. It records which world
the build is in (§5.5); it does not gate CI.

### 8.4 End-to-end

Playwright against the Expo web build with `AI_FAKE=true`:

1. First launch → onboarding → Home shows recommendations.
2. A declared peanut allergy keeps peanut meals off Home and out of Explore.
3. Favouriting a meal survives a reload.
4. Custom meal create → edit → delete.
5. The assistant answers a superlative question and shows its citations.
6. With AI disabled, the assistant shows the unavailable message and does not hang.

---

## 9. Traceability

| Requirement | Module | Test |
|---|---|---|
| FR-001 Startup and hydration | `mobile/state/hydration`, `infrastructure/storage/hydration` | `hydration.integration.test.ts`; E2E 1 |
| FR-002 Onboarding | `mobile/features/onboarding`, `state/onboarding` | `onboardingState.test.ts`; E2E 1 |
| FR-003 Preferences | `state/preferences`, `storage/definitions` | `preferencesState.test.ts` |
| FR-004 Meal-period detection | `domain/meal-period.ts` | `meal-period.test.ts` (7 boundary vectors) |
| FR-005 Catalog retrieval | `server/routes/meals.ts`, `mobile/infrastructure/api` | `meals.integration.test.ts`, `httpTransport.integration.test.ts` |
| FR-006 Nutrition data | `contracts/schemas.ts`, `shared/components/NutritionBadge` | `mealSchema.test.ts` (range bounds), `NutritionBadge.dom.test.tsx` |
| FR-007 Recommendation safety | `domain/allergens.ts`, `domain/scoring.ts` | `allergens.test.ts`, `scoring.test.ts`; E2E 2 |
| FR-008 Scoring | `domain/scoring.ts` | `scoring.test.ts` (bands, clamp, tie-break) |
| FR-009 AI explanation | `server/ai/explanation.ts`, `server/aiLane.ts` | `explanation.integration.test.ts` |
| FR-010 Explore and search | `domain/relevance.ts`, `server/routes/meals.ts` | `relevance.test.ts`, `meals.integration.test.ts` |
| FR-011 Meal details | `mobile/features/catalog/MealDetailsScreen` | `MealDetails.dom.test.tsx` |
| FR-012 Favorites | `state/favorites`, `storage/definitions` | `favoritesState.test.ts`; E2E 3 |
| FR-013 Custom meal CRUD | `state/customMeals`, `features/saved-meals/MealForm` | `customMealsState.test.ts`; E2E 4 |
| FR-014 Settings and reset | `features/settings`, `storage` | `settings.dom.test.tsx` |
| FR-015 Grounded assistant | `domain/chat-retrieval.ts`, `domain/answer.ts`, `server/ai/containment.ts`, `server/routes/chat.ts` | `chat-retrieval.test.ts`, `answer.test.ts`, `containment.test.ts`, `chat.integration.test.ts`; E2E 5, 6 |

Every module in §4–§7 appears here. A module that does not is either dead scope or a missing
requirement.

---

## 10. Build order

Five phases (SDD §18), expanded. Do not start the next while the previous is red.

**Phase 1 — Foundation and domain.**
Workspace, §2.2 tsconfig, ESLint, Prettier, Vitest projects (§8.1) → `packages/contracts` (§3) →
`packages/domain` in dependency order: `text` → `money` → `meal-period` → `allergen-lexicon` →
`allergens` → `diet` → `scoring` → `relevance` → `chat-retrieval` → `answer-lexicon` → `answer` →
`packages/catalog` with `meals.json` authored and `seed.ts` (§7).
**Done when:** `npm run check` is green and every row of §8.2's domain entries has a test.

**Phase 2 — Server.**
Config (§5.2) including the `AI_KEEP_ALIVE` validator → boot and catalog validation (§5.1) →
middleware (§5.3) → `GET /health`, `GET /api/v1/meals`, `GET /api/v1/meals/:id` →
`POST /api/v1/recommendations` without AI.
**Done when:** §8.3's non-AI cases pass and the server refuses to boot on an invalid catalog.

**Phase 3 — Mobile shell.**
Expo app → theme (§6.6) → shared components (§6.7) → storage (§6.4) → store factory and the five stores
(§6.3) → navigation and registry (§6.2) → API client (§6.5) → boot phases (§6.1).
**Done when:** navigation and storage tests pass and the app boots to an empty Home.

**Phase 4 — Features.**
Onboarding and dietary setup → Home and recommendations → Explore and meal details → Saved with
favourites and custom-meal CRUD → Settings and reset.
**Done when:** each feature's PRD §13 criteria pass, in both themes, with accessibility metadata.

**Phase 5 — The assistant.**
Prompt safety (§5.6) → prompt builder → Ollama client and per-request schema (§5.5) → containment
(§5.7) → `AI_FAKE` → chat route (§5.4) → explanation lane on recommendations → Assistant screen →
E2E suite (§8.4) → CI.
**Done when:** §8.4 passes with `AI_FAKE=true`, and passes by hand against a real `gemma3:4b`.
