import { describe, expect, it, vi } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { transportError } from '../../infrastructure/api/errors.js';
import { NAVIGATION_ORIGINS } from '../../navigation/routes.js';
import type { ScreenComponent } from '../../navigation/registry.js';
import { AssistantScreen } from './AssistantScreen.js';
import { ASSISTANT_COPY, ASSISTANT_FAILURE_COPY } from './assistantCopy.js';
import {
  NO_INFORMATION_TEXT,
  QUESTION,
  answer,
  deferredClient,
  iconsIn,
  noInformation,
  renderAssistant,
  serverError,
} from './__testing__/assistantHarness.js';

/**
 * T-21-06 and T-21-07 — what the user sees. The request half is `AssistantRequest.dom.test.tsx`.
 *
 * **Every claim here is paired, so no single constant satisfies both halves** (BRIEF §6.2 shape 2).
 * The citation block is checked by an answer that has citations *and* one that has none. The
 * answered-false state is checked against the unavailable state in **both directions**, so copy
 * collapsed to one string reddens rather than passing twice. And every absence assertion sits
 * beside a presence assertion, so a screen that rendered nothing at all fails rather than passes.
 *
 * It also carries **PRD §10.1's two waiting thresholds** and **T-23-06's composition with them**.
 */

/**
 * PRD §10.1's two figures, transcribed from the document — "a loading state after 200 ms and an
 * AI-progress message after 2 s" — and **deliberately not imported**. `AssistantScreen` reads them
 * from `features/home/useRecommendations.ts`, so the repository holds one copy of each number and
 * this file states independently what the document says (BRIEF §6.1g). `Home.dom.test.tsx:682-687`
 * records the cost of the imported version: `LOADING_AFTER_MS` set to 200 000, or the whole
 * threshold block deleted, shipped green.
 */
const LOADING_AT_MS = 200;
const AI_PROGRESS_AT_MS = 2_000;

describe('AssistantScreen', () => {
  /**
   * The registration the orchestrator will write is one line, and this is the compile check that
   * it fits: `registerScreen('Assistant', AssistantScreen)` requires exactly this assignability,
   * and a screen whose props drifted from `ScreenProps<'Assistant'>` would fail here rather than
   * in a file this agent does not own.
   */
  it('is assignable to the registry entry for its route', () => {
    const registrable: ScreenComponent<'Assistant'> = AssistantScreen;
    expect(registrable).toBe(AssistantScreen);
  });

  it('opens with nothing asked, a labelled field and a named ask control', async () => {
    const { client, requests } = deferredClient();
    const screen = await renderAssistant(client);

    expect(screen.find('assistant-idle')).not.toBeNull();
    expect(screen.find('assistant-turn-1')).toBeNull();
    expect(requests).toEqual([]);
    // PRD §10.5: every control has a role and a name. `getByRole` throws when either is missing.
    expect(getByRole(screen.host, 'button', { name: ASSISTANT_COPY.askLabel })).toBeDefined();
    expect(screen.input().getAttribute('aria-label')).toContain(ASSISTANT_COPY.questionLabel);
  });

  /**
   * **PRD §10.1: "The UI shows a loading state after 200 ms and an AI-progress message after 2 s."**
   *
   * The assistant implemented neither: one sentence from the first render, unchanged until the
   * request settled — on §10.1's cold-model path, up to that section's 30 s hard timeout.
   *
   * Both thresholds are asserted **in both directions**, because each is a boundary and the reason
   * the first exists is its 199 ms side: below it a message is flicker rather than feedback. It
   * also folds in what a separate in-flight test used to claim — busy from the first millisecond,
   * cleared when the answer lands — which this one wholly subsumes.
   */
  it('shows no loading surface before 200 ms, the retrieval sentence at 200 ms and the model sentence at 2 s', async () => {
    vi.useFakeTimers();
    try {
      const { client, settle } = deferredClient();
      const screen = await renderAssistant(client, QUESTION);
      await screen.ask();

      // The question is echoed immediately — the user is never looking at nothing — but the
      // loading state is not, which is what the first threshold buys.
      expect(screen.must('assistant-turn-1-question').textContent).toContain(QUESTION);
      expect(screen.find('assistant-turn-1-pending'), 'nothing at 0 ms').toBeNull();

      await screen.advance(LOADING_AT_MS - 1);
      expect(screen.find('assistant-turn-1-pending'), 'nothing at 199 ms either').toBeNull();

      await screen.advance(1);
      expect(screen.find('assistant-turn-1-pending')?.textContent).toBe(ASSISTANT_COPY.submitting);

      await screen.advance(AI_PROGRESS_AT_MS - LOADING_AT_MS - 1);
      const at1999 = screen.find('assistant-turn-1-pending')?.textContent;
      expect(at1999, 'still the retrieval sentence at 1 999 ms').toBe(ASSISTANT_COPY.submitting);

      await screen.advance(1);
      expect(screen.find('assistant-turn-1-pending')?.textContent).toBe(ASSISTANT_COPY.aiProgress);
      // The two stages are two different sentences, or the escalation is invisible.
      expect(ASSISTANT_COPY.aiProgress).not.toBe(ASSISTANT_COPY.submitting);

      // **And it terminates.** P21's record is a spec that found the right copy while a spinner
      // sat on screen for ever; an escalation that arrives and never leaves is that defect one
      // stage later. Asserted past the second threshold: it is the escalated state being cleared.
      await settle(0, answer());
      expect(screen.find('assistant-turn-1-pending')).toBeNull();
      expect(screen.find('assistant-turn-1-answer')).not.toBeNull();
      expect(screen.must('assistant-ask').getAttribute('aria-busy')).not.toBe('true');
      expect(screen.host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);

      // Well past both thresholds again with nothing in flight: a timer that survived the answer
      // would put the escalation back.
      await screen.advance(AI_PROGRESS_AT_MS * 2);
      expect(screen.find('assistant-turn-1-pending')).toBeNull();

      /**
       * **And the NEXT question starts from nothing**, which is where "terminates" is observable —
       * a probe is why this block exists. Deleting the two resets in `useRequestProgress` changed
       * **0 of 22**, because within one turn the row is also gated on `state.kind === 'pending'`:
       * an answered turn draws no loading surface however the flags are left. What the resets
       * really govern is the second ask, which would otherwise open at 0 ms already escalated to
       * the model sentence — claiming the model was slow before the request had left. BRIEF
       * §6.1k in its second reading: the mutation was live, the assertion could not reach it.
       */
      await screen.type('And which of them is cheapest?');
      await screen.ask();
      expect(
        screen.find('assistant-turn-2-pending'),
        'the second question opens with no inherited escalation',
      ).toBeNull();
      await screen.advance(LOADING_AT_MS);
      expect(screen.find('assistant-turn-2-pending')?.textContent).toBe(ASSISTANT_COPY.submitting);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * **How the two mechanisms compose** (T-23-06 with PRD §10.1).
   *
   * This suite is a reduce-motion environment with no mock in it: jsdom 30.0.1 implements no
   * `window.matchMedia`, so react-native-web 0.21.2 fail-closes `isReduceMotionEnabled()` to
   * `true` (`AccessibilityInfo/index.js:28`). The premise is asserted, so a polyfill added to
   * `vitest.setup.dom.mts` flips this test's meaning loudly rather than silently.
   *
   * **The spinner goes and the words stay.** A reduce-motion user loses the `progressbar`, gains a
   * still mark, and keeps every stage of §10.1's escalation — the only progress signal left to
   * them. Asserting both in the *same render* is what makes it a composition claim;
   * `AccessibleButton.dom.test.tsx` carries the with-motion direction.
   */
  it('keeps every stage of the escalation when the OS asks for less motion', async () => {
    expect(typeof globalThis.matchMedia, 'jsdom must have no matchMedia here').toBe('undefined');

    vi.useFakeTimers();
    try {
      const { client, settle } = deferredClient();
      const screen = await renderAssistant(client, QUESTION);
      await screen.ask();

      // Reduce-motion is in force: no animation anywhere on the screen, and the wait is marked by
      // a still glyph instead.
      expect(screen.host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
      expect(iconsIn(screen.must('assistant-ask'))).toContain('clock-outline');
      // Still inert and still announced, which is the half no mark carries.
      expect(screen.must('assistant-ask').getAttribute('aria-busy')).toBe('true');

      await screen.advance(LOADING_AT_MS);
      expect(screen.find('assistant-turn-1-pending')?.textContent).toBe(ASSISTANT_COPY.submitting);

      await screen.advance(AI_PROGRESS_AT_MS - LOADING_AT_MS);
      expect(screen.find('assistant-turn-1-pending')?.textContent).toBe(ASSISTANT_COPY.aiProgress);

      await settle(0, answer());
      expect(screen.find('assistant-turn-1-answer')).not.toBeNull();
      expect(iconsIn(screen.must('assistant-ask'))).not.toContain('clock-outline');
      expect(screen.must('assistant-ask').getAttribute('aria-busy')).not.toBe('true');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The new sentence is held to the rule the rest of this feature's prose is held to. It lives in
   * `AssistantTurnRow.tsx` — the placement `HomeScreen.tsx:135` already uses for these two strings
   * — so `assistantCopy.test.ts`'s denied-claim sweep does not reach it, and R-70 is exactly the
   * observation that a guard aimed at model text does not cover our own copy. The two properties
   * that sweep enforces are enforced here. TSD §5.7's phrase list is not transcribed a third time;
   * the integration item moves the string into the swept module instead.
   */
  it('keeps the escalation sentence free of digits and of any claim about the meal', () => {
    const sentence = ASSISTANT_COPY.aiProgress;
    expect(sentence).not.toMatch(/\d/);
    for (const claim of ['safe', 'healthy', 'allergen', 'medical', 'doctor', 'you should']) {
      expect(sentence.toLowerCase()).not.toContain(claim);
    }
    // The control: the needle list can fire, so the sweep above is not vacuous.
    expect('This meal is safe.'.toLowerCase()).toContain('safe');
  });

  /**
   * **T-21-06.** Citations beside the answer, each one reaching the meal.
   *
   * Paired with the no-citation answer below: an implementation that always rendered the block, or
   * never did, fails one of the two.
   */
  it('renders the cited meals beside the answer and opens each one', async () => {
    const { client, settle } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await settle(
      0,
      answer([
        { mealId: 'greek-yogurt-bowl', name: 'Greek yogurt bowl' },
        { mealId: 'lentil-soup', name: 'Lentil soup' },
      ]),
    );

    const citations = screen.must('assistant-turn-1-citations');
    expect(citations.textContent).toContain('Greek yogurt bowl');
    expect(citations.textContent).toContain('Lentil soup');
    expect(getByRole(citations, 'button', { name: 'Lentil soup' })).toBeDefined();

    await screen.press(screen.must('assistant-citation-lentil-soup'));
    expect(screen.navigate).toHaveBeenCalledWith('MealDetails', {
      mealId: 'lentil-soup',
      origin: 'assistant',
    });
    // The origin is not invented here: TSD §6.2's table already carries it for this screen.
    expect([...NAVIGATION_ORIGINS]).toContain('assistant');
  });

  it('renders no citation block for an answer that cited nothing', async () => {
    const { client, settle } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await settle(0, answer([]));

    expect(screen.find('assistant-turn-1-answer')).not.toBeNull();
    expect(screen.find('assistant-turn-1-citations')).toBeNull();
  });

  /**
   * **T-21-07, and the defect the task exists to prevent.**
   *
   * `answered: false` arrives as HTTP 200 with `source: 'local'` — the endpoint answering
   * correctly. It must not be rendered as a failure, and it must not read like an unreachable
   * model. Asserted in both directions, so copy collapsed to a single string reddens: each state's
   * headline must appear in its own render and be **absent** from the other's.
   */
  it('reads differently when the assistant answered and when it could not be reached', async () => {
    const refused = deferredClient();
    const refusedScreen = await renderAssistant(refused.client, QUESTION);
    await refusedScreen.ask();
    await refused.settle(0, noInformation());

    const unreachable = deferredClient();
    const unreachableScreen = await renderAssistant(unreachable.client, QUESTION);
    await unreachableScreen.ask();
    await unreachable.fail(0, serverError('ai_unavailable'));

    const answered = refusedScreen.must('assistant-turn-1-no-information');
    const unavailable = unreachableScreen.must('assistant-turn-1-unavailable');

    // An answer, not a failure: the server's own words are shown and no failure surface is.
    expect(answered.textContent).toContain(NO_INFORMATION_TEXT);
    expect(refusedScreen.find('assistant-turn-1-failure')).toBeNull();
    expect(unreachableScreen.find('assistant-turn-1-failure')).not.toBeNull();

    expect(answered.textContent).toContain(ASSISTANT_COPY.noInformation.title);
    expect(answered.textContent).not.toContain(ASSISTANT_FAILURE_COPY.unavailable.title);
    expect(unavailable.textContent).toContain(ASSISTANT_FAILURE_COPY.unavailable.title);
    expect(unavailable.textContent).not.toContain(ASSISTANT_COPY.noInformation.title);
    expect(answered.textContent).not.toBe(unavailable.textContent);
    // PRD §10.5: the difference is carried by the glyph too, not by tint alone.
    expect(iconsIn(answered)).not.toEqual(iconsIn(unavailable));
  });

  /**
   * The three 503s. `API_ERROR_STATUS` gives `ai_disabled`, `ai_unavailable` and `ai_busy` one
   * status between them, so a screen keyed on the status could not tell them apart — and "the
   * model is off" is not "the model is unreachable" is not "the model is busy".
   */
  it('gives the three 503 conditions three different surfaces', async () => {
    const cases = [
      { code: 'ai_disabled', failure: 'disabled' },
      { code: 'ai_unavailable', failure: 'unavailable' },
      { code: 'ai_busy', failure: 'busy' },
    ] as const;
    const rendered: string[] = [];

    for (const { code, failure } of cases) {
      const { client, fail } = deferredClient();
      const screen = await renderAssistant(client, QUESTION);
      await screen.ask();
      await fail(0, serverError(code));
      const state = screen.must(`assistant-turn-1-${failure}`);
      // PRD §12's three clauses, on each of the three.
      expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY[failure].title);
      expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY[failure].description);
      expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY[failure].stillAvailable);
      rendered.push(state.textContent ?? '');
    }

    expect(new Set(rendered).size).toBe(cases.length);
  });

  it('withholds an action where asking again cannot help', async () => {
    const { client, fail } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await fail(0, serverError('ai_disabled'));

    // The copy says there is nothing to press, and the render agrees. Paired with the retry test
    // in `AssistantRequest.dom.test.tsx`, where `unavailable` does offer one.
    expect(ASSISTANT_FAILURE_COPY.disabled.actionLabel).toBeNull();
    const state = screen.must('assistant-turn-1-disabled');
    expect(state.querySelector('[role="button"]')).toBeNull();
    expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY.disabled.title);
  });

  it('reports an unreachable server as offline, and says what still works', async () => {
    const { client, fail } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await fail(0, transportError('ask', 'unreachable'));

    const state = screen.must('assistant-turn-1-offline');
    expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY.offline.title);
    expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY.offline.stillAvailable);
  });

  /** PRD §12: stack traces and raw provider errors never reach the user. */
  it('shows nothing from the wire, while still showing a state', async () => {
    const { client, fail } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await fail(0, serverError('ai_unavailable'));

    expect(screen.find('assistant-turn-1-unavailable')).not.toBeNull();
    expect(screen.text()).not.toContain('ECONNREFUSED');
    expect(screen.text()).not.toContain('private.sock');
  });
});
