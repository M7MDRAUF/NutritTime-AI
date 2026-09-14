/**
 * Figure extraction for containment check 3 - the ungrounded figure (TSD 5.7).
 *
 * This is the check no word-level check can replace. Thirty-five probes against `gemma3:4b`
 * found it answering four of six comparison questions wrongly WITH the correct data in
 * context, and every one of those replies was a wrong number inside fluent, polite,
 * well-formed prose: no denied claim, no uncited id, no unnamed meal. Only the number was
 * false, so only a figure comparison discards the reply.
 *
 * What the user reads is a STRING, so comparison in `containment.ts` is string identity after
 * normalisation with no numeric equivalence - `22` and `22.0` are different figures,
 * deliberately, because the reader sees one of them and not the other (TSD 5.7). Everything
 * here exists to produce the strings that comparison runs on.
 *
 * And what must be extracted is what a reader sees, because TSD 4.9 derives the PERMITTED set
 * from the FORMATTED strings: `$10.10` permits `10.10`, `22 min` permits `22`. So this module
 * reads `$10.10` as `10.10` and `22 min` as `22` - the same side of the same string.
 */

/**
 * The digit-run pattern, verbatim from TSD 5.7. The repeating group matters: `1,234.50` is
 * ONE figure, not three, and `$1,234` is exactly what a total-cost answer contains. A naive
 * `\d+` passes most cases and then shatters a grouped thousand into `1`, `234` and `50`, none
 * of which the domain ever permitted - so a correct total would be discarded and a wrong one
 * that happened to reuse those digits would not be.
 *
 * There are deliberately no word boundaries around it, as TSD 5.7 writes it, and that is not a
 * cosmetic detail. `\b` does not sit between `0` and `g`, so wrapping this pattern in `\b`
 * makes `20g` and `540kcal` yield NO figure at all - and writing a nutrition figure without a
 * space is the ordinary way a model writes one. Check 3 would then find nothing to object to
 * and pass an invented number to the user, which is the exact failure this module exists to
 * prevent. Three adjacency rows in `figures.test.ts` hold this open; before they existed, a
 * `\b` around this pattern failed none of them.
 *
 * The cost of having no boundaries is that a digit inside a word (`omega3`) also yields a
 * figure. That over-extracts rather than under-extracts, and over-extraction only ever
 * discards a reply.
 */
const DIGIT_RUN = String.raw`\d+(?:[.,]\d+)*`;

/**
 * Spelled cardinals, TSD 5.7's scope exactly: units zero-nine, teens, and tens with an
 * optional following unit. No hundreds, no thousands - those are not in the document and
 * inventing them here would be inventing a rule (BRIEF 9).
 *
 * The value sits beside the word rather than being computed from an index, so a reader can
 * check the table against the document line by line, and the alternation below is generated
 * from these keys - a word can therefore never be matched without a value.
 *
 * `ten` is in the teens table. TSD 5.7 says "teens", which taken as eleven-nineteen would
 * leave `ten` with no reading at all, and "ten minutes" in a reply would then carry no figure
 * for check 3 to reject. Reading "teens" as ten-nineteen leaves 0-19 with no hole, which is
 * the only reading under which this check covers the range it claims to.
 */
const UNIT_VALUES: ReadonlyMap<string, number> = new Map([
  ['zero', 0],
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
]);

const TEEN_VALUES: ReadonlyMap<string, number> = new Map([
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
]);

const TENS_VALUES: ReadonlyMap<string, number> = new Map([
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
]);

/**
 * `one` is excluded as a STANDALONE figure - TSD 5.7's reason is that it is far more often an
 * article than a count ("one of the meals", "one hour"), so treating it as a figure would
 * discard almost every correct reply.
 *
 * The exclusion is applied on the standalone-unit branch only, AFTER the tens branch has had
 * its chance to consume the word, which is why `twenty one` still yields `21`. Applying it
 * earlier - dropping the word wherever it appears - would turn `twenty one` into `20` and let
 * `21` through ungrounded. That interaction is the subtlest thing in this file.
 */
const EXCLUDED_STANDALONE_UNIT = 'one';

/**
 * A hyphen separates a tens word from its unit, as a space does. TSD 5.7 writes the form as
 * `twenty two`, but check 2 in the same section flattens every non-alphanumeric run to a
 * space before matching, so a hyphen is a separator by the document's own convention - and a
 * model writes `twenty-two`. Nothing else in this pattern treats `-` specially.
 */
const CARDINAL_SEPARATOR = String.raw`[\s-]+`;

const TENS_WITH_UNIT =
  `(${[...TENS_VALUES.keys()].join('|')})` +
  `(?:${CARDINAL_SEPARATOR}(${[...UNIT_VALUES.keys()].join('|')}))?`;
const TEENS = `(${[...TEEN_VALUES.keys()].join('|')})`;
const UNITS = `(${[...UNIT_VALUES.keys()].join('|')})`;

/**
 * One pass over the text, not two. "The order found" is then the regex engine's own
 * left-to-right order and no sort is needed - and a sort by anything other than position
 * would make `containment.ts`'s evidence name a token other than the one that failed.
 *
 * Capture groups: 1 digit run · 2 tens word · 3 unit following a tens word · 4 teen word ·
 * 5 standalone unit.
 *
 * The trailing `\b` is what stops a shorter word matching inside a longer one: `nine` inside
 * `nineteen`, `ten` inside `often`, `one` inside `oneself`. The leading `\b` stops the same
 * thing at the front (`one` inside `someone`). The tens branch is written first because it is
 * the only branch that consumes two words; the greedy optional unit is what makes it consume
 * `two` in `twenty two` rather than leaving it to be read separately.
 */
const FIGURE_PATTERN = new RegExp(
  `(${DIGIT_RUN})|\\b(?:${TENS_WITH_UNIT}|${TEENS}|${UNITS})\\b`,
  'gi',
);

/**
 * The figure one match names, unnormalised, or `undefined` when the match names none.
 *
 * Every `undefined` table lookup below is unreachable, because `FIGURE_PATTERN` is generated
 * from these tables' own keys. Each returns no figure rather than a guessed one, so an
 * impossible case cannot invent a number the answer did not contain.
 */
function figureIn(match: RegExpMatchArray): string | undefined {
  const digits = match[1];
  if (digits !== undefined) {
    return digits;
  }

  const tensWord = match[2];
  if (tensWord !== undefined) {
    const tens = TENS_VALUES.get(tensWord.toLowerCase());
    const unitWord = match[3];
    // A unit after a tens word is a count, never an article, so `one` is NOT excluded here.
    const unit = unitWord === undefined ? 0 : UNIT_VALUES.get(unitWord.toLowerCase());
    if (tens === undefined || unit === undefined) {
      return undefined;
    }
    return String(tens + unit);
  }

  const teenWord = match[4];
  if (teenWord !== undefined) {
    const teen = TEEN_VALUES.get(teenWord.toLowerCase());
    return teen === undefined ? undefined : String(teen);
  }

  const unitWord = match[5];
  if (unitWord === undefined || unitWord.toLowerCase() === EXCLUDED_STANDALONE_UNIT) {
    return undefined;
  }
  const unit = UNIT_VALUES.get(unitWord.toLowerCase());
  return unit === undefined ? undefined : String(unit);
}

/**
 * Every figure the text quotes, already normalised, in the order found.
 *
 * Repeats are kept and nothing is de-duplicated or sorted. De-duplicating would be harmless
 * to the verdict, since check 3 compares each figure against the permitted set independently,
 * but sorting would not: the first figure to fail is the evidence the server logs, and after a
 * sort that would be a different token from the one the reader would have seen first.
 */
export function quotedFigures(text: string): readonly string[] {
  const figures: string[] = [];
  // `matchAll` works from its own copy of the pattern, so the module-level `lastIndex` of
  // `FIGURE_PATTERN` stays at zero and two calls cannot interfere with each other.
  for (const match of text.matchAll(FIGURE_PATTERN)) {
    const figure = figureIn(match);
    if (figure !== undefined) {
      figures.push(normaliseFigure(figure));
    }
  }
  return figures;
}

/**
 * Strip grouping commas; keep the decimal point.
 *
 * That `,` is grouping and `.` is the decimal point is not a guess about locales. Every figure
 * in the permitted set comes from the domain's own formatters, and `formatMoney`
 * (`packages/domain/src/money.ts`) writes `1010` as `"$10.10"` - a full stop for the decimal
 * and no grouping separator at all. Stripping `,` is therefore exactly what lets a model's
 * `$1,234.50` match the domain's `$1234.50`, which is the only reason this rule exists.
 *
 * A European rendering (`1.234,50`) is read as a grouped `1.23450` and will match nothing, so
 * the reply is discarded. That is the safe direction: this module may reject a reply a user
 * would have found correct, but it must never admit a figure the domain did not compute.
 * Reading `1.234,50` as 1234.50 would mean guessing which separator the model meant, and a
 * wrong guess admits a false number.
 *
 * Also the normaliser `containment.ts` runs over the permitted set. It is a no-op on anything
 * the domain produced, since TSD 4.9's figures never carry a separator, and it is idempotent,
 * so normalising an already-normalised set is safe.
 */
export function normaliseFigure(figure: string): string {
  return figure.replace(/,/g, '');
}
