import { describe, expect, it } from 'vitest';
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
 */

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

  it('says what is happening while the answer is in flight', async () => {
    const { client, settle } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);

    await screen.ask();
    expect(screen.find('assistant-turn-1-pending')).not.toBeNull();
    // Inert and announced as busy, rather than merely slow: one AI call runs at a time server-side.
    expect(screen.must('assistant-ask').getAttribute('aria-busy')).toBe('true');

    await settle(0, answer());
    expect(screen.find('assistant-turn-1-pending')).toBeNull();
    expect(screen.find('assistant-turn-1-answer')).not.toBeNull();
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
