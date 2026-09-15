import { describe, expect, it, vi } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { MEAL_PERIODS } from '@nutritime/contracts';
import { STORAGE_KEYS } from '../../infrastructure/storage/definitions.js';
import { ASSISTANT_COPY, ASSISTANT_FAILURE_COPY, ASSISTANT_MAX_QUESTION } from './assistantCopy.js';
import {
  ANSWER_TEXT,
  QUESTION,
  answer,
  deferredClient,
  renderAssistant,
  serverError,
} from './__testing__/assistantHarness.js';

/**
 * T-21-05 — the bound, what leaves the device, and what is never written down.
 *
 * Separated from `Assistant.dom.test.tsx` so neither file passes SQG-09's 350 lines. The split is
 * along a real seam: this file is about the **request**, that one is about the **render**.
 *
 * The two claims that carry the task are each asserted by a pair, because a single case is
 * satisfiable by an implementation that always refuses or always sends: a question at exactly the
 * bound is sent and one character over is not; a whole ask-and-answer cycle writes nothing *while*
 * demonstrably having produced an answer.
 */

/**
 * PRD §10.1's second threshold, transcribed from the document ("an AI-progress message after
 * 2 s") rather than imported from the module that implements it — the reasoning is
 * `Assistant.dom.test.tsx`'s and `Home.dom.test.tsx:682-687`'s (BRIEF §6.1g).
 */
const AI_PROGRESS_AT_MS = 2_000;

describe('the Assistant request', () => {
  /**
   * **T-21-05.** The field's own bound, and the one behind it.
   *
   * `maxLength` is what a typing user feels; it cannot be the whole guard, because
   * `AssistantParams.seedQuestion` (TSD §6.2) arrives from a URL and never passes a keyboard.
   */
  it('caps the field at the bound and refuses to send an over-long seeded question', async () => {
    const { client, requests } = deferredClient();
    const overLong = await renderAssistant(client, 'a'.repeat(ASSISTANT_MAX_QUESTION + 1));

    expect(overLong.input().getAttribute('maxlength')).toBe(String(ASSISTANT_MAX_QUESTION));

    await overLong.ask();
    expect(requests).toEqual([]);
    expect(overLong.find('assistant-turn-1')).toBeNull();
    expect(overLong.text()).toContain(String(ASSISTANT_MAX_QUESTION));

    const exact = deferredClient();
    const atBound = await renderAssistant(exact.client, 'a'.repeat(ASSISTANT_MAX_QUESTION));
    await atBound.ask();
    expect(exact.requests).toHaveLength(1);
    expect(atBound.find('assistant-turn-1')).not.toBeNull();
  });

  it('sends nothing at all for an empty question', async () => {
    const { client, requests } = deferredClient();
    const screen = await renderAssistant(client);
    await screen.ask();
    expect(requests).toEqual([]);
    expect(screen.text()).toContain(ASSISTANT_COPY.emptyQuestion);
  });

  /**
   * The body, exactly. `toEqual` fails on an extra key, so this is also the assertion that `goal`
   * and `budget` do not travel — the 400 TSD §5.4 promises and the client's job to avoid.
   *
   * **`mealPeriod` joined the body at P28** and is asserted as a MEMBER of `MEAL_PERIODS` rather
   * than as a literal, because the value is whatever this device's clock makes it and a literal
   * would make the test pass or fail by the hour. What matters here is that it travels, that it
   * is a period the schema accepts, and — below — that it is the only new key.
   */
  it('posts one question, the period, the three retrieval fields, and no history', async () => {
    const { client, requests, settle } = deferredClient();
    const screen = await renderAssistant(client);

    await screen.type(QUESTION);
    await screen.ask();
    expect(requests[0]?.question).toBe(QUESTION);
    expect(requests[0]?.preferences).toEqual({
      diet: 'regular',
      allergies: [],
      dislikedIngredients: [],
    });
    expect(MEAL_PERIODS).toContain(requests[0]?.mealPeriod);
    // Still the WHOLE body, which is what catches a fifth key: the period is added to the
    // expectation from the request itself, so every OTHER key must match exactly.
    expect(requests[0]).toEqual({
      question: QUESTION,
      mealPeriod: requests[0]?.mealPeriod,
      preferences: { diet: 'regular', allergies: [], dislikedIngredients: [] },
    });

    await settle(0, answer());
    await screen.type('And the cheapest?');
    await screen.ask();
    // PRD §7.3: each question is answered independently. The second body carries the second
    // question and nothing from the first.
    expect(Object.keys(requests[1] ?? {}).sort()).toEqual([
      'mealPeriod',
      'preferences',
      'question',
    ]);
    expect(requests[1]?.question).toBe('And the cheapest?');
    expect(JSON.stringify(requests[1])).not.toContain(QUESTION);
  });

  /**
   * **The user's own AI switch, honoured without a request** (PRD §7.3:111 — "when AI is off").
   *
   * The assertion that catches this is **the call count, not the rendered state**: a screen that
   * rendered the turned-off banner while still calling the model would look correct and be wrong,
   * and only `requests` at zero sees it. The control is the same screen with the switch back on,
   * so no implementation that always refuses — or always sends — passes both halves.
   *
   * `setAiEnabled` dispatches through the real reducer *after* mount, which also pins that the
   * gate reads the current preference rather than one captured when the screen mounted.
   */
  it('makes no request at all when the user has switched AI off, and does when it is on', async () => {
    const { client, requests } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);

    await screen.setAiEnabled(false);
    await screen.ask();
    expect(requests).toEqual([]);
    // The state the user sees for it, which is the one PRD §7.3 names — not a failure of the
    // request, because no request was made.
    const state = screen.must('assistant-turn-1-disabled');
    expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY.disabled.title);
    expect(state.textContent).toContain(ASSISTANT_FAILURE_COPY.disabled.stillAvailable);

    // The control: switch it back on and the same screen does make the request.
    await screen.setAiEnabled(true);
    await screen.type(QUESTION);
    await screen.ask();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.question).toBe(QUESTION);
    // And the request still carries no `aiEnabled`: the gate is local, not a new wire field.
    expect(Object.keys(requests[0]?.preferences ?? {}).sort()).toEqual([
      'allergies',
      'diet',
      'dislikedIngredients',
    ]);
  });

  /** A retry cannot get past the gate either: `send` is the single choke point. */
  it('refuses a retry while the user has AI switched off', async () => {
    const { client, requests, fail } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await fail(0, serverError('ai_unavailable'));
    expect(requests).toHaveLength(1);

    await screen.setAiEnabled(false);
    await screen.press(
      getByRole(screen.must('assistant-turn-1-unavailable'), 'button', {
        name: ASSISTANT_FAILURE_COPY.unavailable.actionLabel ?? '',
      }),
    );

    expect(requests).toHaveLength(1);
    expect(screen.find('assistant-turn-1-disabled')).not.toBeNull();
    expect(screen.find('assistant-turn-1-unavailable')).toBeNull();
  });

  it('re-asks the same question in place when the state offers an action', async () => {
    const { client, requests, fail } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    await screen.ask();
    await fail(0, serverError('ai_unavailable'));

    const action = ASSISTANT_FAILURE_COPY.unavailable.actionLabel ?? '';
    expect(action).not.toBe('');
    await screen.press(
      getByRole(screen.must('assistant-turn-1-unavailable'), 'button', { name: action }),
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]?.question).toBe(QUESTION);
    // In place: one turn, not two, so a retried failure does not double the transcript.
    expect(screen.find('assistant-turn-2')).toBeNull();

    /**
     * The turn is in flight again, read off the two carriers that hold **from the first
     * millisecond**.
     *
     * This used to assert `assistant-turn-1-pending`, which is no longer the right witness at
     * 0 ms: PRD §10.1 puts the loading *message* 200 ms after the request starts, so on a real
     * clock that element does not exist yet and asserting it would have been a race that passed
     * for the wrong reason. The failure surface being gone and the button being busy are the
     * claims this test is actually about — the retry replaced the state rather than stacking on
     * it. The 200 ms surface itself is pinned on a fake clock in `Assistant.dom.test.tsx`.
     */
    expect(screen.find('assistant-turn-1-unavailable')).toBeNull();
    expect(screen.must('assistant-ask').getAttribute('aria-busy')).toBe('true');
  });

  /**
   * **The transcript is a display concern only** (PRD §7.3), and a stored question is what PRD
   * §10.3 forbids. Both halves are pinned: a whole ask-and-answer cycle writes nothing, and no key
   * exists for this feature to write to.
   */
  it('writes nothing to storage across a whole question and answer', async () => {
    const { client, settle } = deferredClient();
    const screen = await renderAssistant(client, QUESTION);
    const before = screen.driver.calls.filter((call) => call.startsWith('setItem')).length;

    await screen.ask();
    await settle(0, answer([{ mealId: 'lentil-soup', name: 'Lentil soup' }]));

    // The presence control: the answer really did arrive, so "nothing was written" is a statement
    // about a screen that did its work rather than about one that did nothing.
    expect(screen.must('assistant-turn-1-answer').textContent).toContain(ANSWER_TEXT);
    const after = screen.driver.calls.filter((call) => call.startsWith('setItem')).length;
    expect(after).toBe(before);
    for (const stored of screen.driver.store.values()) {
      expect(stored).not.toContain(QUESTION);
      expect(stored).not.toContain(ANSWER_TEXT);
    }
  });

  it('has no storage key it could persist a transcript under', async () => {
    const { client } = deferredClient();
    await renderAssistant(client);
    const keys = [...Object.keys(STORAGE_KEYS), ...Object.values(STORAGE_KEYS)].join(' ');
    for (const word of ['assistant', 'chat', 'transcript', 'question', 'answer']) {
      expect(keys.toLowerCase()).not.toContain(word);
    }
    // The control: the registry is not empty, so the sweep above is over real keys.
    expect(Object.keys(STORAGE_KEYS).length).toBeGreaterThan(0);
  });
  /**
   * The other half of PRD §10.1's second threshold: **"the model" is a claim, and it is only
   * made when the model was actually asked.** Here rather than in the render suite because what it
   * asserts is that *nothing left the device* — which is this file's seam.
   *
   * `useAssistant` gates the user's own AI switch before any request and before `pending` is ever
   * set, so with AI off there is no pending turn and no escalation at any elapsed time. Home needs
   * an explicit `aiEnabled` ternary on its AI timer for this; this screen gets it from the gate,
   * and that is worth pinning rather than assuming — a refactor that set `pending` before the gate
   * would promise a model that was never contacted, and nothing else would notice.
   */
  it('never promises model progress when the user has AI switched off', async () => {
    vi.useFakeTimers();
    try {
      const { client, requests } = deferredClient();
      const screen = await renderAssistant(client, QUESTION);
      await screen.setAiEnabled(false);
      await screen.ask();
      await screen.advance(AI_PROGRESS_AT_MS * 5);

      expect(requests).toEqual([]);
      expect(screen.find('assistant-turn-1-pending')).toBeNull();
      expect(screen.text()).not.toContain(ASSISTANT_COPY.aiProgress);
      // The presence control: the turn exists and says what happened, so this is a screen that
      // answered rather than one that rendered nothing at all.
      expect(screen.find('assistant-turn-1-disabled')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
