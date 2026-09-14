import { describe, expect, it } from 'vitest';
import { getByRole } from '@testing-library/dom';
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
   */
  it('posts one question and the three retrieval fields, and no conversation history', async () => {
    const { client, requests, settle } = deferredClient();
    const screen = await renderAssistant(client);

    await screen.type(QUESTION);
    await screen.ask();
    expect(requests[0]).toEqual({
      question: QUESTION,
      preferences: { diet: 'regular', allergies: [], dislikedIngredients: [] },
    });

    await settle(0, answer());
    await screen.type('And the cheapest?');
    await screen.ask();
    // PRD §7.3: each question is answered independently. The second body carries the second
    // question and nothing from the first.
    expect(Object.keys(requests[1] ?? {}).sort()).toEqual(['preferences', 'question']);
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
    expect(screen.find('assistant-turn-1-pending')).not.toBeNull();
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
});
