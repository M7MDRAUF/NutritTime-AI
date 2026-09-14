import { describe, expect, it } from 'vitest';

import { normaliseFigure, quotedFigures } from './figures.js';

/**
 * TSD 5.7 check 3 and Plan 19.3's `containment` row: *a wrong number in clean prose* and
 * *a spelled cardinal*.
 *
 * Every row below was written from TSD 5.7 and TSD 4.9's Figures paragraph BEFORE the module
 * existed, and none of it was sampled from what the implementation happens to produce
 * (BRIEF 6.3). The prose rows are written to a checklist of attack shapes rather than to
 * illustrate a happy path:
 *
 *   1. a wrong number inside fluent, polite, well-formed prose - the gemma3:4b failure mode
 *      TSD 5.7 records, and the only one no word-level check sees;
 *   2. a grouped thousand (`$1,234.50`), which is what a total-cost answer contains and what
 *      a naive `/\d+/g` shatters into three figures;
 *   3. money with cents (`$10.10`), which TSD 4.9 says must be permitted as `10.10`;
 *   4. a spelled cardinal, spaced and hyphenated, capitalised and not;
 *   5. `one` as an article against `twenty one` as a count;
 *   6. a cardinal word buried inside an ordinary word (`often`, `someone`, `none`);
 *   7. a European decimal comma, which must NOT be quietly read as a decimal point;
 *   8. a sentence-final full stop directly after a figure;
 *   9. digits and cardinals interleaved, to pin the order;
 *  10. `twenty one hundred`, a compound TSD 5.7 puts out of scope.
 */
interface Row {
  readonly why: string;
  readonly input: string;
  readonly expected: readonly string[];
}

const DIGIT_ROWS: readonly Row[] = [
  { why: '`22 min` yields `22` (TSD 4.9)', input: 'It takes 22 min to prepare.', expected: ['22'] },
  { why: '`$10.10` yields `10.10` (TSD 4.9)', input: 'The price is $10.10.', expected: ['10.10'] },
  {
    why: 'a grouped thousand is ONE figure, comma stripped',
    input: 'Those meals come to $1,234.50 in total.',
    expected: ['1234.50'],
  },
  {
    why: 'a grouped thousand with no cents is still one figure',
    input: 'Those meals come to $1,234 in total.',
    expected: ['1234'],
  },
  {
    why: 'a millions-grouped figure keeps every group together',
    input: '1,234,567 is one figure',
    expected: ['1234567'],
  },
  {
    why: 'a sentence-final full stop is not part of the figure',
    input: 'It takes 22 minutes.',
    expected: ['22'],
  },
  { why: 'zero is a figure', input: 'It has 0 g of fat.', expected: ['0'] },
  /**
   * The three adjacency rows. TSD 5.7 writes the digit pattern with NO word boundaries, and
   * `540kcal` or `20g` is the ORDINARY way a model writes a nutrition figure - not an exotic
   * one. Wrapping the digit run in `\b` makes each of these yield NOTHING, because `\b` does
   * not sit between `0` and `g`, and check 3 then finds no figure to object to and passes an
   * invented number to the user. Until these rows existed, that mutation failed none of this
   * file's tests: the rule was documented in `figures.ts` and asserted nowhere.
   */
  {
    why: 'a digit run touching a letter AFTER it still yields the figure',
    input: 'It has 20g of protein.',
    expected: ['20'],
  },
  {
    why: 'the same shape a model writes for calories',
    input: 'That is 540kcal in total.',
    expected: ['540'],
  },
  {
    why: 'a digit run touching a letter BEFORE it, as an unhyphenated meal name writes it',
    input: 'The Omega3 Salmon is the one you mean.',
    expected: ['3'],
  },
  {
    why: 'the order is the order found, never sorted',
    input: 'Choose 9 or 7.',
    expected: ['9', '7'],
  },
  {
    why: 'a repeated figure is kept, not de-duplicated',
    input: '22 minutes, and 22 minutes again',
    expected: ['22', '22'],
  },
  {
    why: 'the digit-run group repeats, so a dotted run is one figure',
    input: 'menu version 1.0.0',
    expected: ['1.0.0'],
  },
  {
    why: 'a European decimal comma is read as grouping and so will match nothing',
    input: 'Priced at 10,10 euros',
    expected: ['1010'],
  },
  { why: 'no figures at all', input: 'No numbers in this sentence.', expected: [] },
  { why: 'the empty string', input: '', expected: [] },
];

const CARDINAL_ROWS: readonly Row[] = [
  { why: 'zero', input: 'zero', expected: ['0'] },
  { why: 'two', input: 'two', expected: ['2'] },
  { why: 'three', input: 'three', expected: ['3'] },
  { why: 'four', input: 'four', expected: ['4'] },
  { why: 'five', input: 'five', expected: ['5'] },
  { why: 'six', input: 'six', expected: ['6'] },
  { why: 'seven', input: 'seven', expected: ['7'] },
  { why: 'eight', input: 'eight', expected: ['8'] },
  { why: 'nine', input: 'nine', expected: ['9'] },
  { why: 'ten - a hole here would leave "ten minutes" ungrounded', input: 'ten', expected: ['10'] },
  { why: 'eleven', input: 'eleven', expected: ['11'] },
  { why: 'twelve', input: 'twelve', expected: ['12'] },
  { why: 'thirteen', input: 'thirteen', expected: ['13'] },
  { why: 'fourteen', input: 'fourteen', expected: ['14'] },
  { why: 'fifteen', input: 'fifteen', expected: ['15'] },
  { why: 'sixteen', input: 'sixteen', expected: ['16'] },
  { why: 'seventeen', input: 'seventeen', expected: ['17'] },
  { why: 'eighteen', input: 'eighteen', expected: ['18'] },
  {
    why: 'nineteen - not `nine`, because the trailing boundary rejects a prefix',
    input: 'nineteen',
    expected: ['19'],
  },
  { why: 'twenty, a tens word with no following unit', input: 'twenty', expected: ['20'] },
  { why: 'thirty', input: 'thirty', expected: ['30'] },
  { why: 'forty - spelled without the `u`', input: 'forty', expected: ['40'] },
  { why: 'fifty', input: 'fifty', expected: ['50'] },
  { why: 'sixty', input: 'sixty', expected: ['60'] },
  { why: 'seventy', input: 'seventy', expected: ['70'] },
  { why: 'eighty', input: 'eighty', expected: ['80'] },
  { why: 'ninety - not `nine`, and not `nineteen`', input: 'ninety', expected: ['90'] },
  {
    why: 'a tens word with a following unit is one figure',
    input: 'It takes twenty two minutes to prepare.',
    expected: ['22'],
  },
  {
    why: 'the hyphenated spelling a model actually writes',
    input: 'It takes twenty-two minutes to prepare.',
    expected: ['22'],
  },
  {
    why: 'a capitalised cardinal at the start of a sentence',
    input: 'Twenty minutes is all it needs.',
    expected: ['20'],
  },
  { why: 'forty five', input: 'forty five', expected: ['45'] },
  { why: 'ninety nine', input: 'ninety nine', expected: ['99'] },
  {
    why: 'the tens word consumes its unit rather than emitting two figures',
    input: 'thirty four',
    expected: ['34'],
  },
];

const ONE_ROWS: readonly Row[] = [
  {
    why: '`one` alone is excluded: it is an article far more often than a count',
    input: 'one',
    expected: [],
  },
  {
    why: '`one` as an article carries no figure',
    input: 'There is one meal that fits, and one hour to cook it.',
    expected: [],
  },
  {
    why: 'but `twenty one` is a count and yields 21, not 20',
    input: 'twenty one',
    expected: ['21'],
  },
  { why: 'and the hyphenated form too', input: 'twenty-one', expected: ['21'] },
  {
    why: 'the compound is consumed first, then a later standalone `one` is still excluded',
    input: 'It takes twenty one minutes, not one hour.',
    expected: ['21'],
  },
  {
    why: 'hundreds are out of TSD 5.7 scope, so `twenty one hundred` is `21` and never `2100`',
    input: 'That is twenty one hundred calories.',
    expected: ['21'],
  },
];

/**
 * The load-bearing rows here are the ones whose hidden cardinal is really there and is NOT
 * `one`. Two ways a negative row can look like a control without being one:
 *
 *   1. the near-miss word does not actually contain the cardinal. `none` is `n-o-n-e` and does
 *      not contain `nine` at all, so it can never have proved anything about boundaries. It is
 *      replaced below by `canine`, which does contain `nine`.
 *   2. the cardinal it hides is `one`, which the standalone exclusion drops whether or not the
 *      boundaries are there. `oneself` and `someone` stay green with `\b` removed for that
 *      reason (BRIEF 6.2, shape 2); they are kept as documentation of intent, not as controls.
 *
 * `often` and `attention` hide `ten`, `weighty` hides `eighty` at the front, `canine` hides
 * `nine` in the middle, `nines` and `sixteenth` hide one at the back. None of those is
 * excluded, so each goes red the moment `\b` is dropped.
 */
const BOUNDARY_ROWS: readonly Row[] = [
  {
    why: '`often` contains `ten` and must not yield 10',
    input: 'I often suggest a salad.',
    expected: [],
  },
  { why: '`canine` contains `nine` and must not yield 9', input: 'A canine ate it.', expected: [] },
  { why: '`oneself` must not match `one`', input: 'Oneself is not a number.', expected: [] },
  { why: '`someone` must not match `one`', input: 'Someone asked about the menu.', expected: [] },
  { why: '`attention` contains `ten`', input: 'It needs attention.', expected: [] },
  {
    why: '`weighty` ends in `eighty`, so the LEADING boundary carries this one',
    input: 'It is a weighty portion.',
    expected: [],
  },
  {
    why: '`sixteenth` is an ordinal, not a cardinal',
    input: 'The sixteenth of the month.',
    expected: [],
  },
  { why: '`nines` is not `nine`', input: 'Dressed to the nines.', expected: [] },
];

const ORDER_ROWS: readonly Row[] = [
  {
    why: 'a cardinal before a digit run keeps that order - two concatenated passes would not',
    input: 'Twenty two meals cost 5 dollars.',
    expected: ['22', '5'],
  },
  {
    why: 'and a digit run before a cardinal keeps the reverse order',
    input: '5 dollars buys twenty two meals.',
    expected: ['5', '22'],
  },
  {
    why: 'digits, cardinals and a repeat, all in the order read',
    input: 'The $10.10 plate takes twenty two minutes; 22 is the figure.',
    expected: ['10.10', '22', '22'],
  },
  {
    why: 'a spelled count and a grouped total in one answer, in the order read',
    input: 'Those five meals come to $1,234.50 in total.',
    expected: ['5', '1234.50'],
  },
];

describe('quotedFigures - digit runs', () => {
  for (const row of DIGIT_ROWS) {
    it(`${row.why}: ${JSON.stringify(row.input)}`, () => {
      expect(quotedFigures(row.input)).toEqual(row.expected);
    });
  }
});

describe('quotedFigures - spelled cardinals', () => {
  for (const row of CARDINAL_ROWS) {
    it(`${row.why}: ${JSON.stringify(row.input)}`, () => {
      expect(quotedFigures(row.input)).toEqual(row.expected);
    });
  }
});

describe('quotedFigures - the `one` exclusion against the tens-plus-unit rule', () => {
  for (const row of ONE_ROWS) {
    it(`${row.why}: ${JSON.stringify(row.input)}`, () => {
      expect(quotedFigures(row.input)).toEqual(row.expected);
    });
  }
});

describe('quotedFigures - word boundaries', () => {
  for (const row of BOUNDARY_ROWS) {
    it(`${row.why}: ${JSON.stringify(row.input)}`, () => {
      expect(quotedFigures(row.input)).toEqual(row.expected);
    });
  }
});

describe('quotedFigures - order found', () => {
  for (const row of ORDER_ROWS) {
    it(`${row.why}: ${JSON.stringify(row.input)}`, () => {
      expect(quotedFigures(row.input)).toEqual(row.expected);
    });
  }
});

describe('quotedFigures - a wrong number in clean prose', () => {
  /**
   * The shape TSD 5.7 records from thirty-five probes against `gemma3:4b`: four of six
   * comparison questions answered wrongly WITH the correct data in context. This reply cites
   * nothing false, claims nothing denied, names only a meal the prompt carried, and is polite
   * and fluent. The only false thing in it is `18`, where the domain resolved `22 min`.
   *
   * Extraction is what makes that reply discardable, so the assertions are that the invented
   * figure comes out and the resolved one does not.
   */
  const REPLY =
    'Great question! Of the meals you are looking at, the Grilled Chicken Salad is the ' +
    'quickest to prepare, at just 18 minutes. Let me know if you would like another option.';

  it('extracts the figure the model invented', () => {
    expect(quotedFigures(REPLY)).toEqual(['18']);
  });

  it('does not extract the figure the domain resolved, so the reply cannot match it', () => {
    expect(quotedFigures(REPLY)).not.toContain('22');
  });

  it('catches the same shape written as a spelled cardinal', () => {
    const spelled = REPLY.replace('18 minutes', 'eighteen minutes');
    expect(quotedFigures(spelled)).toEqual(['18']);
  });
});

describe('normaliseFigure', () => {
  it('strips grouping commas and keeps the decimal point', () => {
    expect(normaliseFigure('1,234.50')).toBe('1234.50');
  });

  it('strips every grouping comma, not only the first', () => {
    expect(normaliseFigure('1,234,567')).toBe('1234567');
  });

  it('leaves a plain integer and a plain decimal untouched', () => {
    expect(normaliseFigure('22')).toBe('22');
    expect(normaliseFigure('10.10')).toBe('10.10');
  });

  it('is idempotent, so normalising an already-normalised permitted set is safe', () => {
    for (const figure of ['1,234.50', '10.10', '22', '0']) {
      expect(normaliseFigure(normaliseFigure(figure))).toBe(normaliseFigure(figure));
    }
  });

  it('does NOT make `22` and `22.0` the same figure - comparison is string identity', () => {
    expect(normaliseFigure('22')).not.toBe(normaliseFigure('22.0'));
  });

  it('reads a European rendering as grouped, so it matches nothing rather than guessing', () => {
    expect(normaliseFigure('1.234,50')).toBe('1.23450');
  });
});

describe('quotedFigures returns figures already normalised', () => {
  const TEXTS = [
    'Those meals come to $1,234.50 in total.',
    'The $10.10 plate takes twenty two minutes; 22 is the figure.',
    '1,234,567 and forty five',
  ];

  it('leaves no grouping comma in any returned figure', () => {
    for (const text of TEXTS) {
      expect(quotedFigures(text).join('|')).not.toContain(',');
    }
  });

  it('returns only figures that normalise to themselves', () => {
    for (const text of TEXTS) {
      for (const figure of quotedFigures(text)) {
        expect(normaliseFigure(figure)).toBe(figure);
      }
    }
  });
});
