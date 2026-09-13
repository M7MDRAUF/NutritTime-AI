/**
 * A quoted-CSV reader (RFC 4180), for the USDA dataset (T-07-06).
 *
 * Written rather than imported because TSD 2.1 pins the toolchain and adds no CSV library,
 * and because a naive `split(',')` is provably wrong on this input. Measured against the real
 * `fndds_ingredient_nutrient_value.csv` (122,330 data rows):
 *
 *   - 119,665 rows carry at least one comma inside a quoted field - every food description
 *     is of the form `"Butter, stick, salted"`.
 *   - 3,705 rows carry an RFC 4180 escaped quote (`""`), used for inch marks, as in
 *     `"Beef, flank, steak, separable lean only, trimmed to 0"" fat, choice, raw"`.
 *
 * So a naive split misparses 98% of the file, and an unescape-free reader corrupts the
 * descriptions that the ingredient resolver matches on. The file is CRLF-terminated.
 */

const QUOTE = '"';
const COMMA = ',';
const LINE_FEED = '\n';
const CARRIAGE_RETURN = '\r';
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Parse CSV text into rows of fields. Quoted fields may contain commas, line breaks and
 * doubled quotes; a doubled quote unescapes to one literal quote. Blank lines are dropped, so
 * the terminating newline of the last record does not produce a phantom empty row.
 *
 * Throws on input that ends inside a quoted field: that is a truncated or corrupt file, and
 * returning the partial row would hand the caller a silently short value.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  /**
   * Whether the current record has consumed any character at all - a quote that opened an
   * empty field counts. Without this, a blank line and the newline ending the final record
   * would each emit a row of one empty field.
   */
  let recordStarted = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };

  const endRecord = (): void => {
    endField();
    rows.push(row);
    row = [];
    recordStarted = false;
  };

  const start = text.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    // noUncheckedIndexedAccess: the loop bound guarantees a character but the type does not,
    // and appending a silent `undefined` would corrupt a field rather than fail.
    if (char === undefined) {
      throw new Error(`CSV read ran past the end of the input at index ${index}`);
    }

    if (inQuotes) {
      if (char !== QUOTE) {
        field += char;
      } else if (text[index + 1] === QUOTE) {
        field += QUOTE;
        index += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }

    if (char === QUOTE) {
      inQuotes = true;
      recordStarted = true;
    } else if (char === COMMA) {
      endField();
      recordStarted = true;
    } else if (char === LINE_FEED) {
      if (recordStarted) {
        endRecord();
      }
    } else if (char !== CARRIAGE_RETURN) {
      // A bare CR outside quotes is the first half of a CRLF terminator and is dropped; the
      // LF ends the record. Inside quotes it is data, and the branch above keeps it.
      field += char;
      recordStarted = true;
    }
  }

  if (inQuotes) {
    throw new Error('CSV input ended inside a quoted field: the file is truncated or corrupt');
  }
  if (recordStarted) {
    endRecord();
  }
  return rows;
}
