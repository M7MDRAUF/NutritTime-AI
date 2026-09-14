import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import {
  ASSISTANT_PAINT_MS,
  askQuestion,
  expectNothingPending,
  expectRetrievalGap,
  formatCents,
  openAssistant,
} from '../support/assistant.js';

/**
 * A superlative, answered with citations that go somewhere (T-21-09). TSD §8.4 case 5.
 *
 * **`AI_FAKE=true` is a real code path, which is what makes this evidence.** TSD §5.5 and
 * `playwright.config.ts` both say it: the route, retrieval, the domain's resolution, the prompt
 * build and containment all execute, and only the HTTP call to Ollama is replaced by an echo of
 * `resolved.statement`. So the sentence this spec reads off the screen was computed by
 * `resolveAnswer` over the real 60-record catalog, and the citations were resolved from
 * `namedMeals` by id — the same code a real model would have been wrapped around.
 *
 * **The trap this file is written against: "a citation appeared" proves almost nothing.** Two
 * things have to be true before the acceptance means anything, and neither follows from a
 * non-empty citation list:
 *
 *  1. **It is the RIGHT meal.** The superlative is resolved over `scope.eligible` — the user's
 *     whole eligible set — and not over the five retrieved `scope.context` meals (TSD §4.9's scope
 *     rule). **The two give different answers for the question below, and that gap is DERIVED ON
 *     EVERY RUN rather than measured once into a comment** — `expectRetrievalGap`. P21 recorded
 *     $6.50 against $2.50 and was right; a figure in a comment is true on the day it is written,
 *     and this one is load-bearing for the whole containment design. So asserting *which* meal is
 *     cited **is** the scope-rule control: a spec that only counted citations would pass against a
 *     server answering "the cheapest meal is X" about a set the user did not ask about — a sentence
 *     that reads as true and is false.
 *  2. **It is reachable.** `NAVIGATION_ORIGINS` includes `'assistant'` for this screen and nothing
 *     else, so a citation is a link by design. A citation that cannot be followed is a decoration,
 *     and nothing in the dom suite can tell the two apart: it renders the row against a stub and
 *     asserts the handler was called, never that a `MealDetails` for that id came up.
 *
 * **The expected meal is derived from the catalog, not written down.** `home-allergy.spec.ts`
 * reads its peanut meals off the server for the same reason: a hard-coded id makes the spec
 * silently invalid the day the catalog changes, instead of loudly wrong. The derivation below is a
 * hand-transcribed statement of two documented rules rather than a call into the code under test —
 * eligibility is TSD §4.8's three safety filters and the winner is TSD §4.9's superlative — and
 * the seeded profile every one of them depends on is asserted rather than assumed.
 */

/** TSD §5.1 and the client's `DEFAULT_API_BASE_URL`. An e2e spec asserts from outside the app. */
const API = 'http://127.0.0.1:4000';

/** TSD §6.4's key name, restated here for the same reason `appPhase.ts` restates it. */
const PREFERENCES_KEY = '@nutritime/preferences/v1';

/**
 * PRD §7.4's own superlative example, taken from the table verbatim.
 *
 * Verified against the lexicon rather than trusted: `cheapest` is one entry of `SENSE_TERMS` and
 * carries a field (`price`) and a direction (`lowest`) in one word, which is what `decide` needs
 * to classify a question with no shape term as a superlative. None of the other three words
 * reaches a threshold, shape, criterion or greeting term, so nothing competes for them.
 */
const SUPERLATIVE = 'What is the cheapest?';

interface CatalogMeal {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly price: { readonly amountCents: number };
  readonly allergenTags: readonly string[];
  readonly dietTags: readonly string[];
}

/**
 * The whole catalog, paged until `total` is satisfied rather than for a fixed two pages.
 *
 * `total` is the count after filtering and before paging (Plan C-02), so the loop's own exit
 * condition is the server's statement about how many there are — a catalog that grew past the
 * pages a spec happened to ask for would otherwise silently shrink the set this spec reasons over.
 */
async function readCatalog(page: Page): Promise<readonly CatalogMeal[]> {
  const all: CatalogMeal[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let pageNumber = 1; all.length < total; pageNumber += 1) {
    const response = await page.request.get(
      `${API}/api/v1/meals?pageSize=50&page=${String(pageNumber)}`,
    );
    expect(response.ok(), 'the catalog must be readable for this spec to mean anything').toBe(true);
    const body = (await response.json()) as {
      readonly meals: readonly CatalogMeal[];
      readonly total: number;
    };
    total = body.total;
    if (body.meals.length === 0) {
      break;
    }
    all.push(...body.meals);
  }
  expect(all.length, 'every page the server counted must have been read').toBe(total);
  return all;
}

interface Superlative {
  /** Every meal tied for the lowest price. All of them are cited; `citedMealIds` is the winners. */
  readonly winners: readonly CatalogMeal[];
  /** The cheapest meal that did NOT win, so "the winner is named" has something to exclude. */
  readonly runnerUp: CatalogMeal;
}

/**
 * The cheapest eligible meal, derived from the catalog under the rules the documents fix.
 *
 * **Eligibility is TSD §4.8 steps 1–3**, and with the profile the `app` fixture seeds each of the
 * collapses to something this function can state: no declared allergy, so step 1 rejects nothing;
 * `diet: 'regular'`, whose accepted-tag list is empty and therefore admits every meal (TSD §4.5),
 * so step 2 rejects nothing; and `available` is the whole of step 3. Step 4 demotes rather than
 * excludes, and a superlative is scoped to `eligible`, so the disliked-ingredient partition cannot
 * move the answer either. **Every clause of that is asserted against the stored profile before
 * this result is used** — see the test body — because a derivation whose assumptions are not
 * checked is a second implementation that agrees with nothing.
 *
 * **The winner is TSD §4.9's superlative**: the extreme over the eligible set, with every tie
 * included, which is what `citedMealIds` carries. `price.amountCents` is a required integer on
 * `mealSchema`, so `gather`'s "all candidates or refuse" rule cannot fire on this field and the
 * question is always answerable — which is the reason a price superlative is the one asked here.
 */
function cheapestEligible(catalog: readonly CatalogMeal[]): Superlative {
  const eligible = catalog.filter((meal) => meal.available);
  expect(eligible.length, 'the catalog must offer an available meal').toBeGreaterThan(0);

  const lowest = Math.min(...eligible.map((meal) => meal.price.amountCents));
  const winners = eligible.filter((meal) => meal.price.amountCents === lowest);
  const others = eligible
    .filter((meal) => meal.price.amountCents > lowest)
    .sort((left, right) => left.price.amountCents - right.price.amountCents);
  const runnerUp = others[0];
  /**
   * Without a runner-up there is nothing for the answer to have got wrong, and the assertion that
   * the winner is named would be satisfied by a server that named the whole catalog.
   */
  expect(
    runnerUp,
    'every eligible meal costs the same, so this spec could not tell a right answer from a wrong one',
  ).not.toBeUndefined();
  if (runnerUp === undefined) {
    throw new Error('unreachable: the assertion above fails first');
  }
  return { winners, runnerUp };
}

/** The preference envelope as it sits on the device, so the derivation's assumptions are checked. */
async function storedPreferences(page: Page): Promise<Readonly<Record<string, unknown>>> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), PREFERENCES_KEY);
  expect(raw, 'the profile must be on the device').not.toBeNull();
  const envelope: unknown = JSON.parse(raw ?? 'null');
  const value =
    typeof envelope === 'object' && envelope !== null
      ? (envelope as { readonly value?: unknown }).value
      : undefined;
  if (typeof value !== 'object' || value === null) {
    throw new Error('the stored preference envelope carries no value object');
  }
  return value as Readonly<Record<string, unknown>>;
}

test.describe('the assistant answers a superlative, and its citations go somewhere', () => {
  test('the cheapest eligible meal is the answer, is the citation, and the citation opens it', async ({
    app,
    page,
  }) => {
    const catalog = await readCatalog(page);
    const { winners, runnerUp } = cheapestEligible(catalog);

    // **R-21, re-derived on this run.** Everything below is evidence for the containment design
    // only while the winner is outside the retrieved five; `expectRetrievalGap` asserts that and
    // the two premises it rests on.
    const context = await expectRetrievalGap(
      page,
      API,
      SUPERLATIVE,
      catalog.map((meal) => meal.id),
      winners.map((meal) => meal.id),
    );

    await app();

    /**
     * **The profile the derivation above assumes, read off the device.**
     *
     * `cheapestEligible` reduces TSD §4.8's three filters to "available" only because this exact
     * profile makes the other two vacuous. If `appPhase.ts` ever seeds an allergy or a narrower diet,
     * that reduction becomes wrong and the expected winner becomes a different meal — and this
     * spec would then fail on the answer with no hint that its own arithmetic was the problem.
     * These four lines are what turn that into a failure that says so.
     */
    const preferences = await storedPreferences(page);
    expect(preferences['diet'], 'a narrower diet would filter the eligible set').toBe('regular');
    expect(preferences['allergies'], 'a declared allergy would reject meals').toStrictEqual([]);
    expect(preferences['aiEnabled'], 'the client gates locally on this').toBe(true);

    /** Every `GET /meals/:id`, so the meal the citation opened is identified by id and not by look. */
    const detailRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (/^\/api\/v1\/meals\/[^/]+$/.test(url.pathname)) {
        detailRequests.push(url.pathname);
      }
    });

    await openAssistant(page);
    await askQuestion(page, SUPERLATIVE);

    const turn = page.getByTestId('assistant-turn-1');
    await expect(turn).toBeVisible({ timeout: ASSISTANT_PAINT_MS });
    // The question, echoed back as typed. The transcript is the screen's own state and this is the
    // only place it exists (PRD §7.3, §10.3).
    await expect(turn.getByTestId('assistant-turn-1-question')).toHaveText(SUPERLATIVE);

    const answer = page.getByTestId('assistant-turn-1-answer');
    await expect(answer).toBeVisible({ timeout: ASSISTANT_PAINT_MS });

    /**
     * **The three states this must not be**, asserted rather than left to the answer's presence.
     *
     * `answered: false` is a 200 and a correct outcome, and a failure is a 503 — a screen that
     * rendered the answer alongside either has told the user two things at once, and the pair a
     * user cannot be allowed to confuse is exactly the one T-21-07 exists for. `-pending` gone is
     * the same claim `explore.spec.ts` makes about its loading state.
     */
    await expect(page.getByTestId('assistant-turn-1-no-information')).toHaveCount(0);
    await expect(page.getByTestId('assistant-turn-1-failure')).toHaveCount(0);
    await expect(page.getByTestId('assistant-turn-1-pending')).toHaveCount(0);
    await expectNothingPending(page);

    /**
     * **The sentence names the winner and its figure, and does not name the runner-up.**
     *
     * The figure matters as much as the name: containment permits only the figures the domain
     * resolved (`ResolvedAnswer.figures`), so a price on screen that the domain did not compute
     * would have been discarded rather than shown — and asserting the one it did resolve is what
     * makes "the domain decided and the model only phrased it" observable from outside.
     *
     * **The runner-up's absence is NOT the scope-rule control**, and this comment used to say it
     * was. Measured at P24 by resolving over `scope.context` in the server's module graph: the
     * reply becomes _"Fruit and Cream Cheese Breakfast Pastries has the lowest price, at $6.50."_,
     * which never names the runner-up — so that assertion **passed** under the exact mutation it
     * claimed to catch, and `toContainText(winner.name)` is what reddened. The runner-up's absence
     * is the control for an answer naming more than it resolved; the control for the wrong SCOPE is
     * `context.cheapest.name`, asserted after it.
     *
     * **Two of these four are fake-dependent** (BRIEF §7.4). The **absences** are contract-backed:
     * a catalog name outside `namedMeals` is in `forbiddenMealNames`, so check 4 discards such a
     * reply and the request 503s. The **presences** are not — nothing obliges a model to spell the
     * name or the figure, and they hold because `AI_FAKE` echoes `resolved.statement` verbatim.
     * Kept, because under the fake they are the only proof the sentence is the domain's; Plan
     * §19.6's manual `gemma3:4b` check should expect these two, and only these two, to need
     * re-reading. Recorded at P24.
     */
    for (const winner of winners) {
      await expect(answer, 'the cheapest eligible meal must be the one named').toContainText(
        winner.name,
      );
    }
    const first = winners[0];
    if (first === undefined) {
      throw new Error('unreachable: cheapestEligible asserts a non-empty winner set');
    }
    await expect(answer).toContainText(formatCents(first.price.amountCents));
    await expect(
      answer,
      `${runnerUp.name} is not the cheapest, so an answer that names it is answering about the wrong set`,
    ).not.toContainText(runnerUp.name);
    await expect(
      answer,
      `${context.cheapest.name} is only the cheapest of the five RETRIEVED meals, so an answer naming it was resolved over context instead of eligible`,
    ).not.toContainText(context.cheapest.name);

    /**
     * **The citations are exactly the winners.** Not "at least one", and not "a subset": the route
     * resolves them from `namedMeals` by id, which for a superlative is the tie set, so a sixth
     * citation or a missing one is a real divergence. An id set comparison also catches a citation
     * parsed out of the answer text (T-21-03), which would bring along whatever the prose named.
     *
     * **Fake-dependent too, and this is the sharper case.** `citationsFor` filters `namedMeals` by
     * the reply's `citedMealIds`, and check 1 rejects only ids the prompt did NOT carry — an
     * **empty** `citedMealIds` passes every check. A real model that cites nothing would yield 200,
     * `answered: true` and no citation block, reddening this with no defect in the app; `AI_FAKE`
     * echoes `resolved.citedMealIds`, which is why it is green. Reported at P24 as a finding about
     * `chat.ts` rather than worked around here: whether a resolved answer may carry no citations is
     * a question for PRD §7.3 ("Show the meals the answer drew on as citations").
     */
    const citations = page.getByTestId('assistant-turn-1-citations');
    await expect(citations).toBeVisible();
    const cited = await citations.locator('[data-testid^="assistant-citation-"]').all();
    const citedIds: string[] = [];
    for (const button of cited) {
      citedIds.push(
        ((await button.getAttribute('data-testid')) ?? '').replace('assistant-citation-', ''),
      );
    }
    expect([...citedIds].sort()).toStrictEqual([...winners.map((meal) => meal.id)].sort());

    // The visible label is the meal's name, because `AccessibleButton` defaults the accessible
    // name to the label and a name that differed from the text would be two statements about one
    // control.
    for (const winner of winners) {
      await expect(page.getByTestId(`assistant-citation-${winner.id}`)).toContainText(winner.name);
    }

    /**
     * **Followed, which is the assertion the acceptance is actually about.**
     *
     * `origin: 'assistant'` exists in `NAVIGATION_ORIGINS` for this one screen, and until a
     * citation is pressed nothing in the suite has ever exercised it. The landing is identified
     * twice: by the name the detail screen renders, and by the id the app asked the server for —
     * the second is the one a screen that rendered the right name from the wrong record could not
     * satisfy.
     */
    await page.getByTestId(`assistant-citation-${first.id}`).click();
    await expect(page.getByTestId('meal-details-screen')).toBeVisible({
      timeout: ASSISTANT_PAINT_MS,
    });
    // The body renders only in the `loaded` state, so its presence is the assertion that the
    // request finished with a meal rather than with a state.
    await expect(page.getByTestId('meal-details-body')).toBeVisible({
      timeout: ASSISTANT_PAINT_MS,
    });
    await expect(page.getByTestId('meal-details-name')).toHaveText(first.name);
    await expect(page.getByTestId('meal-details-price')).toContainText(
      formatCents(first.price.amountCents),
    );
    expect(
      detailRequests,
      'the screen must have fetched the cited meal, not a meal that merely looks like it',
    ).toContain(`/api/v1/meals/${first.id}`);
  });
});
