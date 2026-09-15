import type { Express } from 'express';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import type { ChatModelReply, Meal } from '@nutritime/contracts';
import { compareIds } from '@nutritime/domain';
import type { FetchLike } from '../../ai/ollamaClient.js';
import { createApp } from '../../app.js';
import { buildCatalog } from '../../catalog.js';
import type { Catalog } from '../../catalog.js';
import { loadConfig } from '../../config.js';

/**
 * The shared harness for `POST /api/v1/chat`'s two integration suites - fixtures, the socket-less
 * model, the application and the request builders. **Construction only: not one assertion.**
 *
 * **Why it exists, and it is not the line count.** `chat.integration.test.ts` and
 * `chat.middleware.integration.test.ts` were split out of one 1052-line file and both needed this
 * whole block, so it was copied - and a copied block drifts. This wave found exactly that: one
 * mapping lived in three files and **two of them had already diverged**, on the single value whose
 * purpose is to separate "the caller cancelled" from "the model is absent". Nothing could have
 * caught it, because no suite can assert anything about a constant in a file it does not import.
 * A 210-line harness in two copies would go the same way, invisibly. Here there is one copy, and
 * both suites import it.
 *
 * **What may NOT move in here: a control.** A control separated from the claim it controls is how
 * a discriminating test quietly becomes a decorative one, so every control stays in the suite
 * that makes the claim - the allergen block's no-allergy control and its outbound-body
 * assertion, containment's contained-reply control, and step 4's three-distinct-copies control.
 * This file holds no `expect`, and the moment it does, that line has left the argument it belongs
 * to. `seeded`, `byPriceThenId`, `envelope` and `stubModel` stay private for the same reason in
 * the other direction: `harness` is the only way to build an app, so the two suites cannot drift
 * on how one is constructed.
 *
 * **`__fixtures__/`, not `__tests__/`.** TSD 8.1 mandates co-located tests and BRIEF 6.4 forbids a
 * `__tests__/` directory; a fixture module beside the suites is the existing convention
 * (`src/__fixtures__/bootBadCatalog.ts`, `src/ai/__fixtures__/replies.ts`).
 *
 * Fixtures are **read out of the seeded catalog at runtime** (BRIEF 6.3): the peanut fixture is
 * selected by its `allergenTags`, never by a hard-coded id, so a catalog change makes
 * `chat.integration.test.ts`'s `describe('the fixtures...')` block fail loudly instead of quietly
 * invalidating an assertion.
 */

const seeded = buildCatalog(seededCatalog);

/** Throws rather than returning `undefined`: a vanished fixture must be loud, not defaulted. */
export function firstOf<T>(values: readonly T[], what: string): T {
  const first = values[0];
  if (first === undefined) {
    throw new Error(`the fixture this suite is built on is missing: ${what}`);
  }
  return first;
}

const byPriceThenId = (a: Meal, b: Meal): number =>
  a.price.amountCents - b.price.amountCents || compareIds(a.id, b.id);

/**
 * The peanut-tagged records, **found by their tag**.
 *
 * Plan 11.6's allergen row is the one case a hard-coded id could silently invalidate: rename or
 * re-tag the meal and the test goes on asserting that an id nothing serves is absent.
 */
export const PEANUT_TAGGED = [...seeded.meals]
  .filter((meal) => meal.allergenTags.includes('peanut'))
  .sort(byPriceThenId);

export const PEANUT_MEAL = firstOf(PEANUT_TAGGED, 'a peanut-tagged meal');

/**
 * Two peanut-free partners, both **dearer than** `PEANUT_MEAL`.
 *
 * Dearer is the load-bearing half. `what is the cheapest?` is scoped to `eligible`, so with no
 * allergy declared the peanut meal WINS - which is what makes the exclusion non-vacuous. An
 * exclusion asserted against a set that would not have contained the meal anyway proves nothing,
 * and that exact vacuity was found and repaired in the e2e peanut spec.
 */
export const SAFE_PARTNERS = [...seeded.meals]
  .filter(
    (meal) =>
      meal.available &&
      !meal.allergenTags.includes('peanut') &&
      !meal.ingredients.some((ingredient) => /peanut/i.test(ingredient.name)) &&
      meal.price.amountCents > PEANUT_MEAL.price.amountCents,
  )
  .sort(byPriceThenId)
  .slice(0, 2);

export const CHEAPEST_SAFE = firstOf(
  SAFE_PARTNERS,
  'a peanut-free meal dearer than the peanut one',
);

/** One peanut meal and two safe ones, prices strictly ascending. */
export const MIXED_CATALOG = buildCatalog([PEANUT_MEAL, ...SAFE_PARTNERS]);

/** Nothing but peanut: a declared peanut allergy empties `eligible` whatever else is set. */
export const PEANUT_ONLY_CATALOG = buildCatalog([...PEANUT_TAGGED]);

/** Scoped to `scope.eligible` (TSD 4.9's scope rule), so the winner may be outside `context`. */
export const SUPERLATIVE_QUESTION = 'what is the cheapest?';
/** Scoped to `scope.context` - which is what makes "exclusion from CONTEXT" observable here. */
export const ORDERING_QUESTION = 'rank these by price';
/** `no-intent`: resolves to nothing, so step 3 answers and step 5 is never reached. */
export const UNRESOLVABLE_QUESTION = 'tell me about the weather';

// ------------------------------------------------------------------ the model, without a socket

export type ModelBehaviour =
  | { readonly kind: 'reply'; readonly reply: unknown }
  | { readonly kind: 'hold' }
  | { readonly kind: 'unreachable' };

export interface ModelStub {
  readonly fetchImpl: FetchLike;
  /** How many times a socket was asked for. Zero is the assertion Plan 11.6 turns on. */
  calls(): number;
  /** Every outbound body verbatim - the prompt AND the grammar it was sent with. */
  outbound(): readonly string[];
  /** Release a held call, so no test leaves a pending timer behind. */
  release(): void;
}

/** Ollama's envelope, with the model's JSON carried as a STRING (TSD 5.5). */
function envelope(reply: unknown): Response {
  return new globalThis.Response(JSON.stringify({ response: JSON.stringify(reply) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubModel(behaviour: ModelBehaviour): ModelStub {
  let calls = 0;
  const bodies: string[] = [];
  const releases: (() => void)[] = [];

  const fetchImpl: FetchLike = (_input, init) => {
    calls += 1;
    bodies.push(typeof init.body === 'string' ? init.body : '');
    if (behaviour.kind === 'reply') {
      return Promise.resolve(envelope(behaviour.reply));
    }
    if (behaviour.kind === 'unreachable') {
      // What a stopped Ollama actually does: `fetch` rejects. The client turns it into
      // `OllamaError('unreachable')` without reading the rejection, which is the property
      // `ollamaClient.test.ts` owns; here it only has to be a real failure.
      return Promise.reject(new TypeError('fetch failed'));
    }
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(envelope({ answered: true, answer: 'x', citedMealIds: [] })));
    });
  };

  return {
    fetchImpl,
    calls: () => calls,
    outbound: () => bodies,
    release: () => {
      for (const done of releases.splice(0)) {
        done();
      }
    },
  };
}

/**
 * A reply that passes containment for ANY prompt whose named meals are `meals`.
 *
 * Their exact names, their exact ids, and **no figure at all** - so check 3 has nothing to
 * object to whatever the domain resolved. Built from the FIXTURE rather than from what the
 * domain produced, so it is not a restatement of the code under test.
 */
export function nameOnlyReply(meals: readonly Meal[]): ChatModelReply {
  return {
    answered: true,
    answer: `${meals.map((meal) => meal.name).join(', then ')}.`,
    citedMealIds: meals.map((meal) => meal.id),
  };
}

// ------------------------------------------------------------------------------- the application

/**
 * Fixed, not stepping. Three consumers read this clock through `createApp` - the request log
 * line, the route's AI log line and the error handler - so a stepping clock would make every
 * timestamp depend on how many of them ran. Fixed makes the AI line's `durationMs` exactly `0`
 * and every timestamp exact, which is what lets the assertions be `toStrictEqual`.
 */
export const FIXED_NOW = new Date('2026-09-14T08:15:00.000Z');

export interface Harness {
  readonly app: Express;
  /** Every line the sink received, in order. Nothing else writes to it. */
  readonly lines: readonly string[];
  readonly model: ModelStub;
}

export function harness(
  options: {
    readonly catalog?: Catalog;
    readonly env?: NodeJS.ProcessEnv;
    readonly behaviour?: ModelBehaviour;
  } = {},
): Harness {
  // `unreachable` by default, so a test that reaches the model unexpectedly answers 503 rather
  // than contacting whatever happens to be listening on the developer's machine.
  const model = stubModel(options.behaviour ?? { kind: 'unreachable' });
  const lines: string[] = [];
  const app = createApp({
    // The schema's floor, so a held lane resolves in a second rather than thirty.
    config: loadConfig({ OLLAMA_CHAT_TIMEOUT_MS: '1000', ...options.env }),
    catalog: options.catalog ?? MIXED_CATALOG,
    sink: (line) => lines.push(line),
    now: () => FIXED_NOW,
    fetchImpl: model.fetchImpl,
  });
  return { app, lines, model };
}

export const CHAT_PATH = '/api/v1/chat';

export interface AskOptions {
  readonly question: string;
  /** Overridden only by the tests whose subject is the period itself. */
  readonly mealPeriod?: string;
  readonly allergies?: readonly string[];
  readonly diet?: string;
  readonly dislikedIngredients?: readonly string[];
  /** For the `goal` / `budget` rejections: a key `retrievalPreferencesSchema` does not accept. */
  readonly extraPreferences?: Readonly<Record<string, unknown>>;
  /** A query string, so the CONCRETE path differs from the route template. */
  readonly query?: string;
}

export const ask = (harnessed: Harness, options: AskOptions) =>
  request(harnessed.app)
    .post(options.query === undefined ? CHAT_PATH : `${CHAT_PATH}?${options.query}`)
    .set('Content-Type', 'application/json')
    .send(
      JSON.stringify({
        question: options.question,
        // Every harnessed request carries a period, because the schema requires one. `lunch` is
        // the default rather than the current time: a suite whose bodies changed with the clock
        // would pass or fail depending on when it ran.
        mealPeriod: options.mealPeriod ?? 'lunch',
        preferences: {
          diet: options.diet ?? 'regular',
          allergies: options.allergies ?? [],
          dislikedIngredients: options.dislikedIngredients ?? [],
          ...options.extraPreferences,
        },
      }),
    );

export const sendRaw = (harnessed: Harness, body: string) =>
  request(harnessed.app).post(CHAT_PATH).set('Content-Type', 'application/json').send(body);

/** The whole of a 503 body. `toStrictEqual` is what catches a fifth field. */
export const expectedErrorBody = (code: string, message: string, retryable: boolean) => ({
  error: { code, message, retryable },
});
