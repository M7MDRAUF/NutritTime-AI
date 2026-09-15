import { describe, expect, it } from 'vitest';
import type { UnresolvedReason } from '@nutritime/domain';
import { deniedClaimIn } from './claimDenylist.js';
import * as chatCopyModule from './chatCopy.js';

const { CHAT_COPY, copyForUnresolved } = chatCopyModule;

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
 * And the sharpest part: `chat.integration.test.ts` asserts that a **model** emitting that same
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
 *  - it covers **every phrase in `DENIED_CLAIMS` by construction** — TSD §5.7's sixteen plus the
 *    PRD §7.3 extensions, twenty-two when this was written — so it cannot fall behind the list the
 *    way a transcribed regex did. The count is named as history, not asserted: CONTRACTS AMENDMENT 2
 *    forbids a consumer asserting `DENIED_CLAIMS.length`, and the list has already grown once.
 *
 * A test rather than a runtime check, because the copy is a compile-time constant: a runtime guard
 * on a frozen string would be dead code that reads as diligence.
 *
 * ---
 *
 * **What changed here, and why the first version of this file was only half a fix.** The sweep used
 * to run a **hand-written list of three** `CHAT_COPY` keys. All three of the module's keys were on
 * it, so nothing escaped — but a **fourth** key was *opt-in to the guard*, and the P28 audit
 * measured exactly that: a new key carrying verbatim *"Every meal I can show you is allergen free."*
 * failed **0 of 866** server tests, with the mutation proved loaded rather than inert.
 *
 * `Plan.md`'s R-70 is the risk that *"a guard aimed at one source of text does not cover another"*.
 * A hand-list is that same risk one level up — the guard covers the strings someone remembered to
 * list — and the mobile half of R-70 had already been converted from a list to a **walk** at P23
 * (`apps/mobile/src/features/assistant/assistantCopy.test.ts`), so one side was fixed structurally
 * and this side was left in the shape the risk is about.
 *
 * The walk below is that file's mechanism, ported rather than reinvented: two implementations of one
 * guard is how this project's failure-to-outcome mapping ended up in three copies with two diverged.
 * Two deliberate differences, both stated with their reasons where they appear: it walks the **module
 * namespace** rather than named objects, and it carries the **path** of each string so a failure says
 * which key broke.
 */

/**
 * Every string the module exports, **collected by WALKING it, not by listing keys.**
 *
 * A walk cannot be forgotten. Adding a key to `CHAT_COPY` — or a whole new exported copy constant —
 * now joins the sweep with no edit here, which is the property the hand-list did not have.
 *
 * The root is the **module namespace object** rather than `CHAT_COPY` itself. The mobile port walks
 * two named objects, which closes "a new key" and leaves "a new exported constant" open; the
 * namespace closes both, and it is the same mechanism applied one level out. The one hole a walk
 * cannot close by itself is a string returned from a **function** — a namespace walk skips
 * `copyForUnresolved` — so the sweep calls it for every reason below, and the export-shape assertion
 * further down fails if a second exported function ever arrives.
 *
 * `null` and numbers are skipped rather than stringified: nothing in this module is either today, and
 * a walk that coerced them would report `"null"` as user-facing copy.
 */
type SweptString = readonly [path: string, text: string];

function collectStrings(path: string, value: unknown, into: SweptString[]): void {
  if (typeof value === 'string') {
    into.push([path, value]);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectStrings(`${path}.${key}`, nested, into);
  }
}

function everyExportedString(): readonly SweptString[] {
  const found: SweptString[] = [];
  collectStrings('chatCopy', chatCopyModule, found);
  return found;
}

/**
 * The eight reasons, with completeness enforced by the COMPILER rather than by transcription.
 *
 * `satisfies Record<UnresolvedReason, true>` means a ninth member added to TSD §4.9's union is a
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

/**
 * `copyForUnresolved` is the real entry point — the route never reads `CHAT_COPY` directly for an
 * unresolved answer — so sweeping the constants alone would leave the mapping free to return
 * something unvetted. Its private `COPY_FOR_REASON` table is deliberately **not** walked: going
 * through the function tests what a caller can actually receive, and a table the walk reached would
 * pass even if the function stopped reading it.
 */
const UNRESOLVED_STRINGS: readonly SweptString[] = REASONS.map((reason) => [
  `copyForUnresolved(${reason})`,
  copyForUnresolved(reason),
]);

const SWEPT: readonly SweptString[] = [...everyExportedString(), ...UNRESOLVED_STRINGS];

describe('server-authored chat copy is held to the same claims the model is', () => {
  it.each(SWEPT)('%s makes no denied claim', (_path, text) => {
    expect(deniedClaimIn(text)).toBeUndefined();
  });

  /**
   * **The anti-vacuity control, and the reason it is a COUNT.** A walk that silently found nothing
   * would satisfy every "contains no denied claim" assertion above — `it.each([])` contributes no
   * cases, and a sweep of zero strings is clean by definition. That is T-19-09's lesson on the other
   * axis: *"an empty permitted set forbids every figure; it does not skip the check"*.
   *
   * The floor is `REASONS.length`, a different authority from the copy module: the eight reasons are
   * TSD §4.9's union, so the walk must reach strictly more strings than there are reasons — it can
   * only do that by having reached the constants too.
   */
  it('actually reaches strings, so none of the sweeps above can pass vacuously', () => {
    expect(SWEPT.length).toBeGreaterThan(REASONS.length);
    expect(everyExportedString().length).toBeGreaterThanOrEqual(Object.keys(CHAT_COPY).length);
    for (const [path, text] of SWEPT) {
      expect(text.trim(), `${path} is blank`).not.toBe('');
    }
  });

  /**
   * **The property the hand-list did not have, stated as an assertion.** Every exported value that
   * is not a function must have been reached by the walk, so a new exported copy constant either
   * joins the sweep or fails here by name. The old list could satisfy neither: it named three keys
   * and could not see a fourth.
   */
  it('leaves no exported value outside the walk', () => {
    const escaped = Object.entries(chatCopyModule)
      .filter(([, value]) => typeof value !== 'function')
      .filter(
        ([name]) =>
          !SWEPT.some(
            ([path]) => path === `chatCopy.${name}` || path.startsWith(`chatCopy.${name}.`),
          ),
      )
      .map(([name]) => name);
    expect(escaped).toEqual([]);
  });

  /**
   * The hole a walk cannot close on its own: a **function** that returns copy. `copyForUnresolved`
   * is swept by being called for all eight reasons, and this assertion fails if a second exported
   * function arrives — which is the moment someone has to decide how its output gets swept.
   */
  it('exports exactly one function, whose output is swept by calling it', () => {
    const functions = Object.entries(chatCopyModule)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(functions).toEqual(['copyForUnresolved']);
  });

  /**
   * Every `CHAT_COPY` key contributes at least one swept string, checked per key rather than by a
   * total, so a walk that reached the object and stopped part-way through it fails by key name.
   * Written as a prefix match so nesting a group of strings under a key stays covered.
   */
  it.each(Object.keys(CHAT_COPY))('CHAT_COPY.%s is reached by the walk', (key) => {
    const reached = SWEPT.filter(
      ([path]) =>
        path === `chatCopy.CHAT_COPY.${key}` || path.startsWith(`chatCopy.CHAT_COPY.${key}.`),
    );
    expect(reached.length).toBeGreaterThan(0);
  });

  it('checks every reason the union declares, and says so at runtime too', () => {
    expect([...REASONS].sort()).toStrictEqual(Object.keys(REASON_TABLE).sort());
    expect(UNRESOLVED_STRINGS).toHaveLength(REASONS.length);
  });

  /**
   * **The module's own no-digit claim, which nothing asserted.** `chatCopy.ts`'s docstring says
   * *"none of them carries a digit"*, and that is the same asymmetry R-70 is about on the figure
   * axis rather than the claim axis: TSD §5.7 check 3 forbids a model from emitting a number that is
   * not in the permitted set, and server copy never passes through containment at all. A figure
   * authored into `noEligibleMeals` would reach the user ungrounded and unchallenged.
   */
  it('carries no digit in any string, so no figure can be read off a reply', () => {
    for (const [path, text] of SWEPT) {
      expect(text, `${path} carries a digit`).not.toMatch(/\d/);
    }
  });
});

/**
 * **The controls, without which every assertion above would pass on an empty denylist or a
 * `deniedClaimIn` that always returned `undefined`.** Each sentence here was run through the real
 * guard and its verdict recorded, rather than quoted from a brief (BRIEF §6.1c).
 */
describe('the guard the sweep depends on', () => {
  it('catches the sentence that motivated this file, and names the phrase', () => {
    const mutant = 'Hello. Every meal I can show you is allergen free and safe to eat.';
    expect(deniedClaimIn(mutant)).toBe('allergen free');
    expect(deniedClaimIn('Every meal I can show you is allergen free.')).toBe('allergen free');
  });

  it('does not fire inside a longer word', () => {
    // `treats`, `safe` and `safely` are all on the list; none of them is a token here.
    expect(deniedClaimIn('Food safety, treatment and handling unsafely.')).toBeUndefined();
    expect(deniedClaimIn('A healthful tagine with none of the nine.')).toBeUndefined();
  });

  /**
   * **Negation is not an exemption** (TSD §5.7), and this pair is also the reason the sweep stops at
   * this module. `Plan.md`'s R-75 records it: `HomeScreen.tsx` ships FR-007's **required** *"This is
   * not medical advice."* and the guard flags it, because `claimDenylist.ts` carries
   * `medical`/`medically` and exempting negations would let *"not unhealthy"* through. Widening this
   * sweep to every copy source therefore needs a vetted-exemption mechanism, which is an open user
   * decision — so what is asserted here is that the guard really does flag that sentence, which is
   * the fact the decision rests on.
   */
  it('treats a negated claim as a claim, which is why the sweep is not widened', () => {
    expect(deniedClaimIn('This is not healthy.')).toBe('healthy');
    expect(deniedClaimIn('This is not medical advice.')).toBe('medical');
  });
});
