import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv.js';

/**
 * The boundaries that matter are the ones the real USDA file actually exercises: commas
 * inside quoted descriptions, doubled quotes used as inch marks, CRLF terminators, and a
 * truncated file. The happy path is one test; the rest are the failure modes a naive reader
 * gets wrong.
 */
describe('parseCsv', () => {
  it('reads plain unquoted fields', () => {
    expect(parseCsv('a,b,c')).toEqual([['a', 'b', 'c']]);
  });

  it('keeps a comma that sits inside a quoted field', () => {
    // The shape of every USDA food description. A naive split yields four fields, not two.
    expect(parseCsv('"1001","Butter, stick, salted"')).toEqual([['1001', 'Butter, stick, salted']]);
  });

  it('unescapes a doubled quote to one literal quote', () => {
    // The inch mark in `trimmed to 0" fat`, as the file spells it.
    expect(parseCsv('"13068","Beef, trimmed to 0"" fat, raw"')).toEqual([
      ['13068', 'Beef, trimmed to 0" fat, raw'],
    ]);
  });

  it('treats CRLF and LF as the same record terminator', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('does not emit a phantom row for the newline that ends the last record', () => {
    expect(parseCsv('a,b\r\n')).toEqual([['a', 'b']]);
  });

  it('drops blank lines rather than reading them as empty records', () => {
    expect(parseCsv('a,b\n\n\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('preserves empty fields, including a quoted empty field', () => {
    // The USDA file writes an absent FDC ID as `""`, which must survive as an empty string
    // rather than vanish: a dropped field shifts every later column.
    expect(parseCsv('"1001","743.0","","1976"')).toEqual([['1001', '743.0', '', '1976']]);
    expect(parseCsv('a,,b')).toEqual([['a', '', 'b']]);
  });

  it('keeps a line break that sits inside a quoted field', () => {
    expect(parseCsv('"one\ntwo",b')).toEqual([['one\ntwo', 'b']]);
  });

  it('strips a byte order mark from the first field', () => {
    expect(parseCsv('\uFEFF"ingredient code","x"')).toEqual([['ingredient code', 'x']]);
  });

  it('reads a final record that has no trailing newline', () => {
    expect(parseCsv('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('throws rather than returning a short row when the input ends inside a quoted field', () => {
    // A truncated download must fail loudly. Returning `[['Butter, stick']]` would look like
    // a complete record and quietly enter the nutrient table.
    expect(() => parseCsv('"1001","Butter, stick')).toThrow(/ended inside a quoted field/);
  });

  it('returns no rows for empty or whitespace-only input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\r\n\r\n')).toEqual([]);
  });
});
