/**
 * Prompt safety (TSD 5.6 "Fencing", SDD 12.1, SDD 12 control 4).
 *
 * The **only** path by which text this project did not write reaches a model prompt. A second
 * path would be a second thing to remember, so there is exactly one, and everything downstream
 * - the prompt builder, the per-request grammar constraint, containment - assumes it ran.
 *
 * No imports, by design. A sanitiser with I/O in reach is a sanitiser somebody eventually asks
 * to log what it sanitised, and what it sanitises is a meal record or the user's question
 * (PRD 10.3, TSD 5.8).
 *
 * **What fencing is and is not.** Delimiting is mitigation, not a guarantee (SDD 12.1). The
 * guarantee is structural: the model cannot widen the meal set, cannot see an unsafe meal, and
 * cannot introduce a figure the domain did not resolve. A successful injection changes the
 * wording of a sentence. This module's job is to make the wording the only thing at stake.
 */

/** TSD 5.6, verbatim. The prompt builder writes these around MEALS and QUESTION. */
export const UNTRUSTED_OPEN = '<<<BEGIN UNTRUSTED>>>';
export const UNTRUSTED_CLOSE = '<<<END UNTRUSTED>>>';

/**
 * Family 1 - the invisibles TSD 5.6 names: C0/C1 controls, soft hyphen, zero-width and
 * directional marks, line/paragraph separators, the BOM.
 *
 * Property escapes rather than a list of code points, because the categories *are* the list:
 * `Cc` is C0 + DEL + C1, and `Cf` is every one of soft hyphen, ZWSP/ZWNJ/ZWJ, LRM/RLM/ALM, the
 * embedding and isolate controls, and U+FEFF. `Zl`/`Zp` are U+2028/U+2029 and nothing else. It
 * also catches the word joiner and the tag block, which are the same hazard under other names.
 *
 * A hand-written class of `\u`-escapes would say the same thing, trip `no-control-regex` on the
 * C0 half of it, and leave a reader no way to answer "is that all of them?".
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Tab and newline are KEPT. A meal's description and ingredient text is legitimately
 * multi-line, and stripping the structure out of it would hand the model a mangled record and
 * call it safety. Both are `Cc`, so they need an explicit exemption from family 1.
 *
 * Carriage return is **not** here: TSD 5.6 keeps "tab and newline", so a CRLF body arrives as
 * LF. That is a deliberate normalisation, not an oversight - a lone CR moves the cursor to the
 * start of the line, which is exactly how a terminal reader gets shown one thing while the
 * prompt holds another.
 */
const KEPT_CONTROLS: ReadonlySet<string> = new Set(['\t', '\n']);

/**
 * Family 2 - TSD 5.6's redaction regex, used exactly as written. The eight-character gap is
 * what makes it more than a literal search: `END-UNTRUSTED`, `end   untrusted` and
 * `UNTRUSTED_END` are the spellings an attacker reaches for, and the literal
 * `<<<END UNTRUSTED>>>` is the one they do not need.
 */
const FENCE_MARKER = /(?:begin|end)[^a-z0-9]{0,8}untrusted|untrusted[^a-z0-9]{0,8}(?:begin|end)/gi;

/**
 * What a marker becomes.
 *
 * It carries alphanumerics on purpose. `[^a-z0-9]{0,8}` cannot span a letter, so a redaction
 * can never splice its neighbours into a fresh marker, and can never fuse the two sides of a
 * removed span into an angle run that family 3 has already been past. An empty replacement
 * does both: `a<END UNTRUSTED<b` would leave `a<<b`.
 */
const REDACTION = '[redacted]';

/**
 * Family 3 - runs of `<` or `>`, which collapse to a single character of the same kind.
 *
 * Two or more, never one. A single angle bracket is ordinary text - a description reading
 * "serve at <70C" must survive intact, and damaging a record to defend against a delimiter
 * nobody wrote would be the wrong trade. The fence markers are `<<<`/`>>>`, so the run is the
 * part that carries the resemblance.
 */
const ANGLE_RUN = /<{2,}|>{2,}/g;

/**
 * Strip, collapse, redact.
 *
 * **Do not "restore the document's order".** TSD 5.6's sentence lists three jobs separated by
 * semicolons - "strips ...; redacts ...; and collapses ..." - and prescribes no execution
 * order. What it does prescribe is the goal: it "redacts anything **resembling** a fence
 * marker". This is the order that reaches that goal, and two constructible inputs decide it:
 *
 * 1. **Strip before redact.** `END UNTRU<ZWSP>STED` carries nothing the redaction regex can
 *    see until the zero-width space is gone. Redacting first puts the words `END UNTRUSTED`
 *    into the prompt with the marker's own spelling.
 * 2. **Collapse before redact.** The tolerated gap is eight non-alphanumerics, so
 *    `END` + nine `>` + `UNTRUSTED` evades the regex; collapsing afterwards then shortens the
 *    gap to one and *emits* `END>UNTRUSTED` into the untrusted block - a string that resembles
 *    a fence marker, and one the same regex redacts on sight when it is written with a single
 *    `>`. Collapsing can only shorten a gap, never lengthen one, so moving it earlier can only
 *    widen redaction's reach: this order opens nothing and closes that case.
 *
 * Reversing either is a behaviour change with a test against it, not a tidy-up.
 *
 * The three families and nothing else: no trim, no case change, no length cap. SDD 12.1 also
 * describes the helper as capping length, and the cap lives where the bound is actually
 * defined - `chatRequestSchema`'s 1-500 characters and the 64 KB body limit - rather than as a
 * figure invented here.
 */
export function neutraliseUntrusted(text: string): string {
  return text
    .replace(INVISIBLE, (character) => (KEPT_CONTROLS.has(character) ? character : ''))
    .replace(ANGLE_RUN, (run) => run.charAt(0))
    .replace(FENCE_MARKER, REDACTION);
}

/**
 * Neutralise, **then** wrap. Wrapping first would feed this module's own markers to its own
 * redaction regex and produce `<[redacted]>` where the boundary should be.
 *
 * The markers sit on their own lines so the body cannot fuse with them: a body ending in `<`
 * would otherwise abut `<<<END UNTRUSTED>>>` and leave the closing marker four brackets deep.
 * Newline is a kept control, so the separators survive family 1.
 */
export function fenceUntrusted(body: string): string {
  return `${UNTRUSTED_OPEN}\n${neutraliseUntrusted(body)}\n${UNTRUSTED_CLOSE}`;
}
