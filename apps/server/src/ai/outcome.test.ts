import { describe, expect, it } from 'vitest';
import { AiBusyError, AiTimeoutError } from '../aiLane.js';
import { OllamaAbortError, OllamaError } from './ollamaClient.js';
import type { OllamaFailureReason } from './ollamaClient.js';
import type { AiOutcome } from '../logging.js';
import { outcomeForFailure } from './outcome.js';

/**
 * `outcome.ts` was extracted mid-wave to make a three-way divergence unrepresentable, and shipped
 * **with no test of its own**. A privacy auditor then measured what that cost: mapping
 * `OllamaAbortError` to `undefined`, to `'timeout'`, or even to **`'ok'`** left **0 of 136 tests
 * failing**.
 *
 * **And the reason is the more useful half.** `explanation.test.ts` computed its expectation by
 * calling the function under test — `fellBack(outcomeForFailure(error))` — so its assertions were
 * true of whatever the mapping happened to be. That pattern was mistaken for the
 * derive-don't-restate discipline used elsewhere in this project, where a test reads bounds out of
 * `chatModelReplySchema` rather than retyping `700`. The difference is the authority: deriving from
 * a **different** source pins a contract, and deriving from **the subject** pins nothing.
 *
 * The value left unpinned was `OllamaAbortError` — precisely the one the three pre-extraction
 * copies had already diverged on. So the deduplication removed the divergence and left the value
 * free to drift on its own.
 *
 * Hence the shape below: **a literal transcription**, in the test, of what the mapping is intended
 * to be. It is deliberately typed rather than imported, and the key-set assertion is what catches a
 * seventh reason arriving with no decision made about it.
 */

/**
 * Transcribed by hand from TSD 5.5's six reasons and 5.8's five outcomes, per the rule
 * `outcome.ts` states: **did a usable response come back?**
 *
 * Not imported from the module. If this table and the module disagree, one of them is wrong and
 * that is the point of having both.
 */
const INTENDED: Readonly<Record<OllamaFailureReason, AiOutcome>> = {
  // Nothing usable arrived from the transport.
  unreachable: 'unreachable',
  // A non-2xx is the service declining to serve; nothing was generated.
  'http-status': 'unreachable',
  // A response arrived and cannot be read as a structured reply.
  envelope: 'schema',
  'empty-reply': 'schema',
  truncated: 'schema',
  schema: 'schema',
};

/** The six reasons, listed rather than derived, so a seventh fails the key-set assertion below. */
const REASONS: readonly OllamaFailureReason[] = [
  'unreachable',
  'http-status',
  'envelope',
  'empty-reply',
  'truncated',
  'schema',
];

describe('outcomeForFailure maps a client failure to TSD 5.8 outcome', () => {
  it('covers exactly the six reasons TSD 5.5 declares, and no more', () => {
    // Catches a seventh reason added to `OllamaFailureReason` with no decision recorded here, and
    // a reason deleted from the module's own record while this table still lists it.
    expect(Object.keys(INTENDED).sort()).toStrictEqual([...REASONS].sort());
  });

  it.each(REASONS)('maps %s to its intended outcome', (reason) => {
    expect(outcomeForFailure(new OllamaError(reason))).toBe(INTENDED[reason]);
  });
});

describe('the three failures that are not client failures', () => {
  it('maps a lane timeout to timeout', () => {
    expect(outcomeForFailure(new AiTimeoutError())).toBe('timeout');
  });

  /**
   * **This is the assertion whose absence the auditor found**, and the value the three copies had
   * already diverged on.
   *
   * `unreachable` and not `timeout`: an abort means the model WAS contacted and nothing usable came
   * back. The lane rejects with `AiTimeoutError` before it aborts, so a timed-out caller never
   * reaches this branch — which is why the branch is mapped for totality rather than because a
   * path is known to reach it.
   */
  it('maps an aborted call to unreachable, not to a timeout and not to nothing', () => {
    expect(outcomeForFailure(new OllamaAbortError())).toBe('unreachable');
  });

  /**
   * **No line at all**, which is a considered answer and not an omission. A busy lane means the
   * model was never contacted, so a `durationMs` would time a call that did not happen and
   * `unreachable` would report a stopped model when the truth is a busy one. The rejection is
   * still visible: it is a property of the REQUEST, carried by `app.ts`'s per-request line as
   * `status: 503` with `errorCode: 'ai_busy'`.
   */
  it('writes no line for a busy lane', () => {
    expect(outcomeForFailure(new AiBusyError())).toBeUndefined();
  });
});

describe('anything unrecognised writes no line rather than a fabricated classification', () => {
  it.each([
    ['a plain Error', new Error('boom')],
    ['a TypeError', new TypeError('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['an object shaped like an error', { name: 'OllamaError', reason: 'schema' }],
  ])('returns undefined for %s', (_name, error) => {
    expect(outcomeForFailure(error)).toBeUndefined();
  });

  /**
   * The last row above is the one that matters: a **duck-typed** object carrying the right property
   * names must not be classified, because `outcomeForFailure` narrows on `instanceof` and a value
   * that merely looks like an `OllamaError` did not come from this client. Reading `.reason` off an
   * arbitrary object would let an unrelated throw choose a log outcome.
   */
  it('does not trust a duck-typed error, only instanceof', () => {
    const impostor = { reason: 'unreachable' as const, name: 'OllamaError', message: '' };
    expect(outcomeForFailure(impostor)).toBeUndefined();
    // Control: the real thing with the same reason IS classified, so the assertion above is about
    // the type and not about the value.
    expect(outcomeForFailure(new OllamaError('unreachable'))).toBe('unreachable');
  });
});
