import { describe, expect, it } from 'vitest';
import type { UnresolvedReason } from '@nutritime/domain';
import { deniedClaimIn } from './claimDenylist.js';
import { CHAT_COPY, copyForUnresolved } from './chatCopy.js';

/**
 * **Containment guards what the MODEL says and never guarded what we say.** That is the hole this
 * file closes, and it was reachable.
 *
 * A vacuity audit measured it: `CHAT_COPY`'s three strings were asserted only as
 * `toBe(CHAT_COPY.x)` — a constant compared to itself, which is BRIEF §6.1g's circular shape — and
 * the one non-circular guard's regex reached 9 of `DENIED_CLAIMS`' 22 phrases. So rewriting
 * `greeting` to
 *
 *     'Hello. Every meal I can show you is allergen free...'
 *
 * failed **0 of 824 tests**. A peanut-allergic user asking "what can you do?" would have read that
 * every meal is allergen free, from the server's own copy, with no model involved.
 *
 * And the sharpest part: `chat.integration.test.ts:438` asserts that a **model** emitting that same
 * phrase is discarded with a 503. The identical sentence was forbidden from the model and permitted
 * from us — so the architecture's threat model had a side it never looked at.
 *
 * ---
 *
 * **The guard is `deniedClaimIn`, the same function containment uses on model replies.** Two
 * reasons it is the right instrument rather than a hand-written regex:
 *
 *  - it is an **independent authority**, so this is not §6.1g again. The copy and the denylist share
 *    no source, and a drift in either fails against the other.
 *  - it covers **all 22 phrases by construction** — TSD 5.7's sixteen plus the six PRD 7.3
 *    extensions — so it cannot fall behind the list the way a transcribed regex did.
 *
 * A test rather than a runtime check, because the copy is a compile-time constant: a runtime guard
 * on a frozen string would be dead code that reads as diligence.
 */

/**
 * The eight reasons, with completeness enforced by the COMPILER rather than by transcription.
 *
 * `satisfies Record<UnresolvedReason, true>` means a ninth member added to TSD 4.9's union is a
 * **compile error here** — the object would be missing a key — so new copy cannot arrive untested.
 * `REASONS` is separately typed `readonly UnresolvedReason[]`, so every entry must be a real
 * reason, and the test below ties the two together at runtime. No `as` anywhere.
 */
const REASON_TABLE = {
  'empty-question': true,
  'no-intent': true,
  'incomplete-intent': true,
  'ambiguous-intent': true,
  'field-unknown': true,
  'field-partially-known': true,
  'no-candidates': true,
  greeting: true,
} as const satisfies Record<UnresolvedReason, true>;

const REASONS: readonly UnresolvedReason[] = [
  'empty-question',
  'no-intent',
  'incomplete-intent',
  'ambiguous-intent',
  'field-unknown',
  'field-partially-known',
  'no-candidates',
  'greeting',
];

/** Every string a user can receive from this module, with the name a failure should print. */
const USER_FACING: readonly (readonly [string, string])[] = [
  ['noEligibleMeals', CHAT_COPY.noEligibleMeals],
  ['noInformation', CHAT_COPY.noInformation],
  ['greeting', CHAT_COPY.greeting],
];

describe('server-authored chat copy is held to the same claims the model is', () => {
  it.each(USER_FACING)('CHAT_COPY.%s makes no denied claim', (_name, copy) => {
    expect(deniedClaimIn(copy)).toBeUndefined();
  });

  /**
   * The control, without which every assertion here would pass on an empty denylist or a
   * `deniedClaimIn` that always returned `undefined`. It uses the phrase from the measured
   * mutation, so this fails if the guard ever stops recognising the exact sentence that motivated
   * the file.
   */
  it('and the guard would catch the sentence that motivated this file', () => {
    const mutant = 'Hello. Every meal I can show you is allergen free and safe to eat.';
    expect(deniedClaimIn(mutant)).toBeDefined();
  });

  /**
   * `copyForUnresolved` is the real entry point — the route never reads `CHAT_COPY` directly for an
   * unresolved answer — so covering the constants alone would leave a mapping free to return
   * something unvetted.
   */
  it.each(REASONS)('copyForUnresolved(%s) makes no denied claim', (reason) => {
    expect(deniedClaimIn(copyForUnresolved(reason))).toBeUndefined();
  });

  it('checks every reason the union declares, and says so at runtime too', () => {
    expect([...REASONS].sort()).toStrictEqual(Object.keys(REASON_TABLE).sort());
  });
});
