import { describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { seededCatalog } from '@nutritime/catalog';
import type { Meal, ScoreReasonKind } from '@nutritime/contracts';
import { effectiveAllergenTags, isDietCompatible } from '@nutritime/domain';
import type { AiProvider } from '../ai/provider.js';
import { createAiLane } from '../aiLane.js';
import { JSON_BODY_LIMIT, createErrorHandler } from '../app.js';
import { buildCatalog } from '../catalog.js';
import type { Catalog } from '../catalog.js';
import { loadConfig } from '../config.js';
import type { ServerConfig } from '../config.js';
import { fallbackExplanation, recommendationsRouter } from './recommendations.js';

/**
 * Plan C-04's test list: the safety path, the response contract, validation, and the deterministic
 * explanation builder. **Nothing in this file consults a model.**
 *
 * The first suite is the one this endpoint exists to get right. Everything else here is a
 * contract detail; an allergen-conflicting meal reaching a response is the failure the whole
 * product is built to prevent, so it is tested through the HTTP boundary and not only in the
 * domain where `recommend` already has its own suite.
 *
 * **P20's explanation-lane suites are in `recommendations.explanation.integration.test.ts`.** This
 * file reached 1136 lines against a §17.1 exception granted at 459, which is the ground
 * `contrast.test.ts` was split on rather than re-approved ("42% past a cap it was already exempt
 * from, which is how an exception becomes a blanket"). The seam is the model: the gate, the
 * containment verdicts, the shared budget, the stopped-Ollama case, `AI_FAKE` and the AI log line
 * all need a provider, a lane, a clock and a sink, and none of them belongs beside PRD §13's
 * safety evidence. Two things stayed deliberately: **the allergen hard rejection keeps its
 * synthetic catalog and the allergy-free control in the same file**, because a control separated
 * from the claim it controls is how the first version of the peanut test came to be unfailable;
 * and no test here mocks or spies on anything.
 *
 * **`mount` rather than `createApp`, and every assertion is unchanged by it.** The router's deps
 * are an object carrying a lane, a provider, a sink and a clock (CONTRACTS AMENDMENT 5 and 7), and
 * `app.ts` is the only place that constructs them - so a test needing a specific provider cannot
 * get one through `createApp`, which takes none. `mount` installs the REAL router, the REAL body
 * parser at the REAL limit and the REAL error handler, which is everything the assertions below
 * touch; the CORS layer and the request log line are asserted in `boot.integration.test.ts` and
 * `logging.test.ts`, where they belong.
 */

const catalog = buildCatalog(seededCatalog);

interface Mounted {
  readonly catalog: Catalog;
  readonly config: ServerConfig;
  readonly provider: AiProvider;
}

function mount(options: Mounted): Express {
  const sink = (): void => undefined;
  const now = (): Date => new Date();
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(
    '/api/v1/recommendations',
    recommendationsRouter({
      catalog: options.catalog,
      config: options.config,
      lane: createAiLane(),
      provider: options.provider,
      sink,
      now,
    }),
  );
  app.use(createErrorHandler({ sink, now }));
  return app;
}

/**
 * The provider for every test that is not about the model.
 *
 * It **rejects rather than resolving**, so no test in this file can reach a network or a real
 * Ollama by accident: the suite's verdicts must not depend on whether the developer running it
 * happens to have a model loaded. The gate means it is never called at all for an
 * `aiEnabled: false` request, which is what keeps the pre-P20 suites byte-identical in
 * behaviour - and if the gate ever opened by mistake, this rejects and the explanation degrades
 * to the template rather than silently contacting localhost.
 */
const offlineProvider: AiProvider = () =>
  Promise.reject(new Error('no model is configured for this test'));

const app = mount({ catalog, config: loadConfig({}), provider: offlineProvider });

interface Body {
  readonly mealPeriod: string;
  readonly aiEnabled: boolean;
  readonly preferences: {
    readonly diet: string;
    readonly allergies: readonly string[];
    readonly goal: string;
    readonly budget: string;
    readonly dislikedIngredients: readonly string[];
  };
  readonly favoriteMealIds: readonly string[];
}

const body = (overrides: Partial<Body> = {}): Body => ({
  mealPeriod: 'dinner',
  aiEnabled: false,
  preferences: {
    diet: 'regular',
    allergies: [],
    goal: 'balanced',
    budget: 'high',
    dislikedIngredients: [],
  },
  favoriteMealIds: [],
  ...overrides,
});

const post = (payload: unknown) =>
  request(app)
    .post('/api/v1/recommendations')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(payload));

describe('the allergen hard rejection, through HTTP', () => {
  it('returns no peanut-tagged meal to a user who declared a peanut allergy', async () => {
    const peanutMeals = catalog.meals.filter((meal) => meal.allergenTags.includes('peanut'));
    expect(peanutMeals.length).toBeGreaterThan(0);

    const response = await post(
      body({
        mealPeriod: 'snack',
        preferences: { ...body().preferences, allergies: ['peanut'] },
        // Favourited deliberately: the +10 must not buy a rejected meal past the filter.
        favoriteMealIds: peanutMeals.map((meal) => meal.id),
      }),
    );
    expect(response.status).toBe(200);
    const returned: string[] = response.body.recommendations.map(
      (entry: { meal: { id: string } }) => entry.meal.id,
    );
    for (const meal of peanutMeals) {
      expect(returned).not.toContain(meal.id);
    }
  });

  /**
   * **This needs a catalog the seed does not contain, and that is the finding.**
   *
   * The version this replaces posted `allergies: ['seafood']` and asserted that the top three
   * happened to contain no prawn or salmon. Three things were wrong with it at once:
   *
   * 1. `seafood` is not a canonical allergen - `normalizeAllergen('seafood')` returns `null`,
   *    and the canonical terms are `shellfish` and `fish`. The request excluded NOTHING, so the
   *    test would have passed with the allergen filter deleted outright.
   * 2. Only three meals come back, so "no prawn in the top three" is a claim about scoring, not
   *    about rejection.
   * 3. Of the sixty seeded records, exactly two carry a tag they do not declare - and both are
   *    `gluten` implied by a declared `wheat`, which is the implication table rather than
   *    ingredient inference. **No seeded meal can exercise this path at all.**
   *
   * So the catalog is built for the purpose: one meal whose `allergenTags` is empty and whose
   * ingredient list alone implies `shellfish`, and one that implies nothing. Two meals both fit
   * inside the three the endpoint returns, which turns the assertion from "did not appear" -
   * satisfiable by a low score - into "was rejected", with the allergy-free run as the control
   * proving the meal was reachable to begin with.
   */
  describe('an allergen present ONLY in the ingredient list', () => {
    // Taken from the VALIDATED catalog, not from `seededCatalog` - which the package types as
    // `unknown` on purpose, because nothing may treat raw JSON as a `Meal` before `mealSchema`
    // has seen it. Throwing here rather than falling back keeps a vanished fixture loud: a
    // silent default would leave this suite testing a meal it invented.
    const base = catalog.byId.get('baingan-bharta');
    if (base === undefined) {
      throw new Error('fixture meal "baingan-bharta" is missing from the seeded catalog');
    }

    const variant = (id: string, name: string, firstIngredient: string): Meal => {
      const source = structuredClone(base);
      return {
        ...source,
        id,
        name,
        // Declared empty ON PURPOSE. A record like this is the one a tag review cannot catch by
        // reading tags, and it is how an untagged prawn reaches someone who cannot eat one.
        allergenTags: [],
        ingredients: [{ name: firstIngredient, measure: '200 g' }, ...source.ingredients],
      };
    };

    const inferenceCatalog = buildCatalog([
      variant('untagged-prawn-dish', 'Untagged Prawn Dish', 'King Prawns'),
      variant('plain-lentil-dish', 'Plain Lentil Dish', 'Red Lentils'),
    ]);
    const inferenceApp = mount({
      catalog: inferenceCatalog,
      config: loadConfig({}),
      provider: offlineProvider,
    });

    const ask = (allergies: readonly string[]) =>
      request(inferenceApp)
        .post('/api/v1/recommendations')
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify(
            body({ mealPeriod: 'lunch', preferences: { ...body().preferences, allergies } }),
          ),
        );

    it('declares no tag, so a rejection can only have come from inference', () => {
      const prawn = inferenceCatalog.byId.get('untagged-prawn-dish');
      expect(prawn).toBeDefined();
      expect(prawn?.allergenTags).toStrictEqual([]);
      expect(prawn === undefined ? [] : [...effectiveAllergenTags(prawn)]).toContain('shellfish');
    });

    it('returns the meal when no allergy is declared - the control', async () => {
      const response = await ask([]);
      expect(response.status).toBe(200);
      const ids: string[] = response.body.recommendations.map(
        (entry: { meal: { id: string } }) => entry.meal.id,
      );
      expect(ids).toContain('untagged-prawn-dish');
      expect(ids).toContain('plain-lentil-dish');
    });

    it('rejects it for a declared shellfish allergy, keeping the other meal', async () => {
      const response = await ask(['shellfish']);
      expect(response.status).toBe(200);
      const ids: string[] = response.body.recommendations.map(
        (entry: { meal: { id: string } }) => entry.meal.id,
      );
      expect(ids).not.toContain('untagged-prawn-dish');
      // Not an empty response: the filter removed the conflicting meal and nothing else.
      expect(ids).toStrictEqual(['plain-lentil-dish']);
    });

    it('protects a user who typed a non-canonical but recognisable word', async () => {
      // `seafood` is NOT a canonical allergen - `normalizeAllergen('seafood')` is `null` - and
      // TSD 5.5 types `allergies` as free strings, so a preferences screen or a person can send
      // it. It rejects anyway, through `conflictingAllergens` path 3: the term's own inference
      // (`fish`, `shellfish`) overlaps the meal's effective tags.
      //
      // I expected this to FAIL when I wrote it, on the reasoning that a null canonical form
      // protects nobody. Path 3 exists precisely for the everyday word, and pinning it here
      // stops a later simplification from removing the only thing standing between the word a
      // person actually types and a prawn.
      const response = await ask(['seafood']);
      const ids: string[] = response.body.recommendations.map(
        (entry: { meal: { id: string } }) => entry.meal.id,
      );
      expect(ids).toStrictEqual(['plain-lentil-dish']);
    });

    it('protects only by literal name for a word the lexicon does not know (R-30)', async () => {
      // The honest limit of a free-text allergy field, stated as a test rather than left to be
      // discovered. `coriander` matches because an ingredient is literally named "Coriander
      // Leaves" (path 2). `cilantro` is the SAME PLANT and matches nothing: it is not canonical,
      // it infers nothing, and the word does not appear in the ingredient list.
      //
      // Not a defect in this route and not fixable here - the fix is either a lexicon entry or a
      // narrowed contract, and narrowing `allergies` is a TSD 5.5 amendment. **R-30: the
      // containment is that P14 offers the canonical list rather than a text box.**
      const [known, unknown] = await Promise.all([ask(['coriander']), ask(['cilantro'])]);
      const idsOf = (response: { body: { recommendations: { meal: { id: string } }[] } }) =>
        response.body.recommendations.map((entry) => entry.meal.id);
      expect(idsOf(known)).toStrictEqual([]);
      expect(idsOf(unknown)).toHaveLength(2);
    });
  });

  it.each(['vegan', 'vegetarian', 'gluten-aware'] as const)(
    'never returns a meal incompatible with diet=%s',
    async (diet) => {
      const response = await post(body({ preferences: { ...body().preferences, diet } }));
      expect(response.status).toBe(200);
      expect(response.body.recommendations.length).toBeGreaterThan(0);
      for (const entry of response.body.recommendations) {
        // Asserted through `isDietCompatible`, not `dietTags.includes(diet)`. The literal test
        // passes for `vegan` by luck and is WRONG for `vegetarian`, where a vegan meal is a
        // correct answer carrying no `vegetarian` tag - so the strict version of this assertion
        // would have failed a route that behaved correctly.
        expect(isDietCompatible(diet, entry.meal.dietTags)).toBe(true);
      }
    },
  );
});

describe('the response shape', () => {
  it('returns at most three, ordered by score descending then id ascending', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(response.body.mealPeriod).toBe('dinner');
    const entries: { score: number; meal: { id: string } }[] = response.body.recommendations;
    expect(entries.length).toBeLessThanOrEqual(3);
    expect(entries.length).toBeGreaterThan(0);
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      expect(previous.score).toBeGreaterThanOrEqual(current.score);
      if (previous.score === current.score) {
        expect(previous.meal.id < current.meal.id).toBe(true);
      }
    }
  });

  it('breaks a real tie on id ascending, not on catalog order', async () => {
    // **The suite above could never reach this branch.** `lunch` + `vegan` is a request that
    // does: `baingan-bharta` and `fasoliyyeh-bi-z-zayt-syrian-green-beans-with-olive-oil` both
    // score 71, and `b` sorts before `f`. Asserted as an exact pair rather than "is sorted",
    // because a comparator falling back to catalog order would still look sorted.
    const response = await post(
      body({ mealPeriod: 'lunch', preferences: { ...body().preferences, diet: 'vegan' } }),
    );
    const entries: { score: number; meal: { id: string } }[] = response.body.recommendations;
    const [first, second] = entries;
    expect(first?.score).toBe(second?.score);
    expect(first?.meal.id).toBe('baingan-bharta');
    expect(second?.meal.id).toBe('fasoliyyeh-bi-z-zayt-syrian-green-beans-with-olive-oil');
  });

  it('carries scoreReasons so a score can be checked rather than trusted', async () => {
    const response = await post(body());
    const first = response.body.recommendations[0];
    expect(first.scoreReasons).toHaveLength(8);
    expect(first.scoreReasons.map((reason: { kind: string }) => reason.kind)).toContain(
      'meal-period-match',
    );
  });

  it('marks every explanation as fallback when the request asks for no AI', async () => {
    // Plan C-04's test row, and now only half of what it used to assert: the `aiEnabled: true`
    // arm belonged to a phase where `explanationSource` was a constant, and pinning `fallback`
    // on both arms would forbid exactly the behaviour T-20-04 adds. The four-combination gate
    // suite below replaces it, with a provider spy - which is a stronger claim than this one
    // ever made, because "no model call happened" is the property the user cares about and this
    // test could not see it.
    const response = await post(body({ aiEnabled: false }));
    for (const entry of response.body.recommendations) {
      expect(entry.explanationSource).toBe('fallback');
      expect(entry.explanation.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic across identical requests', async () => {
    const first = await post(body({ favoriteMealIds: [] }));
    const second = await post(body({ favoriteMealIds: [] }));
    expect(second.body).toStrictEqual(first.body);
  });

  it('reports a null nutrient as zero points with the not-available detail', async () => {
    const response = await post(
      body({ preferences: { ...body().preferences, goal: 'high-protein' } }),
    );
    const unavailable = response.body.recommendations.find(
      (entry: { meal: { nutritionProvenance: { origin: string } } }) =>
        entry.meal.nutritionProvenance.origin === 'unavailable',
    );
    // Asserted, not assumed. Wrapping the body in `if (unavailable !== undefined)` made the whole
    // test vacuous the moment scoring moved a record: it would have gone on passing while
    // checking nothing. 53 of the 60 seeded records have no nutrition, so this is the common
    // case rather than a lucky one.
    expect(unavailable).toBeDefined();
    const goal = unavailable.scoreReasons.find(
      (reason: { kind: string }) => reason.kind === 'goal-match',
    );
    expect(goal.points).toBe(0);
    expect(goal.detail).toMatch(/not available/i);
  });
});

describe('validation', () => {
  it('rejects an extra field with a 400 naming it', async () => {
    const response = await post({ ...body(), sneaky: true });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_request');
  });

  it('requires mealPeriod, because the server holds no clock', async () => {
    const { mealPeriod: _unused, ...withoutPeriod } = body();
    const response = await post(withoutPeriod);
    expect(response.status).toBe(400);
    expect(Object.keys(response.body.error.details ?? {})).toContain('mealPeriod');
  });

  it.each(['brunch', '', 'LUNCH', 123])('rejects mealPeriod=%o', async (mealPeriod) => {
    const response = await post({ ...body(), mealPeriod });
    expect(response.status).toBe(400);
  });

  it('rejects a preference field the narrow projection does not accept', async () => {
    const response = await post({
      ...body(),
      preferences: { ...body().preferences, themeMode: 'dark' },
    });
    expect(response.status).toBe(400);
  });

  it('never echoes a submitted value in the details', async () => {
    const response = await post({
      ...body(),
      preferences: { ...body().preferences, diet: 'i-am-allergic-to-peanuts' },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('peanuts');
  });
});
describe('fallbackExplanation', () => {
  const scored = (points: readonly number[]) => ({
    meal: catalog.meals[0]!,
    score: points.reduce((total, value) => total + value, 0),
    scoreReasons: points.map((value, index) => ({
      kind: 'meal-period-match' as const,
      points: value,
      detail: `Reason ${String(index)}`,
    })),
  });

  /** For the cases where the KIND matters and not only the points. */
  const withKinds = (reasons: readonly (readonly [ScoreReasonKind, number, string])[]) => ({
    meal: catalog.meals[0]!,
    score: reasons.reduce((total, [, points]) => total + points, 0),
    scoreReasons: reasons.map(([kind, points, detail]) => ({ kind, points, detail })),
  });

  it('cites the highest-scoring reasons, in points order', () => {
    expect(fallbackExplanation(scored([5, 30, 20]))).toBe('Reason 1, reason 2, and reason 0.');
  });

  it('cites at most three, so it reads as prose rather than a list', () => {
    expect(fallbackExplanation(scored([30, 20, 15, 10, 5]))).toBe(
      'Reason 0, reason 1, and reason 2.',
    );
  });

  it('omits a reason that scored nothing', () => {
    expect(fallbackExplanation(scored([30, 0, 0]))).toBe('Reason 0.');
  });

  it('says only what the data supports when every policy scored zero', () => {
    // Inventing a reason here would make `explanationSource: 'fallback'` a euphemism.
    expect(fallbackExplanation(scored([0, 0]))).toBe('This one fits your preferences.');
  });

  it('is deterministic for equal points', () => {
    const first = fallbackExplanation(scored([10, 10, 10]));
    expect(first).toBe(fallbackExplanation(scored([10, 10, 10])));
    expect(first).toBe('Reason 0, reason 1, and reason 2.');
  });

  it('breaks a points tie on SCORE_REASON_KINDS order, not on array position', () => {
    // **The test above cannot tell the two apart**, because its reasons all carry the same kind
    // and `scoreMeal` happens to emit them in declaration order - so array position and kind
    // order coincide and either implementation passes. Here the array is deliberately in the
    // REVERSE of declaration order: `budget-match` is declared before `local-availability`, so a
    // comparator keyed on the contract puts the budget reason first, and one keyed on the index
    // puts availability first.
    expect(
      fallbackExplanation(
        withKinds([
          ['local-availability', 10, 'Available locally'],
          ['budget-match', 10, 'Inside your budget'],
        ]),
      ),
    ).toBe('Inside your budget, and available locally.');
  });

  it('cites the penalty alongside the positives, rather than only the good news', () => {
    // **This is the dishonesty the P09/P10 verification found.** Filtering to `points > 0`
    // excluded `disliked-ingredient`, whose points are never positive - so a meal penalised -50
    // was explained entirely in its favour. A score of 3 out of 100 read as two reasons to eat
    // it, with the one thing the user asked to avoid the only fact left out.
    expect(
      fallbackExplanation(
        withKinds([
          ['meal-period-match', 30, 'Suits lunch'],
          ['diet-match', 20, 'Fits vegan'],
          ['disliked-ingredient', -50, 'Contains mushrooms, which you dislike'],
        ]),
      ),
    ).toBe('Suits lunch, and fits vegan, though contains mushrooms, which you dislike.');
  });

  it('cites the heaviest penalty when there is more than one', () => {
    expect(
      fallbackExplanation(
        withKinds([
          ['meal-period-match', 30, 'Suits lunch'],
          ['disliked-ingredient', -10, 'Contains onion, which you dislike'],
          ['local-availability', -50, 'Not stocked nearby'],
        ]),
      ),
    ).toBe('Suits lunch, though not stocked nearby.');
  });

  it('still names the penalty when nothing at all scored in the meal favour', () => {
    expect(
      fallbackExplanation(
        withKinds([
          ['meal-period-match', 0, 'Not usually a lunch'],
          ['disliked-ingredient', -50, 'Contains mushrooms, which you dislike'],
        ]),
      ),
    ).toBe('Contains mushrooms, which you dislike, but it fits your other preferences.');
  });
});
