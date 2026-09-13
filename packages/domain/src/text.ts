/**
 * Text primitives (TSD 4.1).
 *
 * Every string the domain compares passes through here first, so that "Crème Brûlée" and
 * "creme brulee" are the same thing everywhere, and so that comparison is always between
 * whole tokens. Substring comparison is how `"nut"` matches `"minute"`; nothing in this
 * module does it.
 *
 * Pure by construction: no clock, no I/O, no imports.
 */

/** Anything that is not a lowercase letter or a digit, in runs. */
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;

/** Combining marks left behind by NFD decomposition. */
const DIACRITIC = /\p{Diacritic}/gu;

/**
 * Punctuation that ends a phrase. A separator run between two words means the words belong
 * to different segments, so a phrase rule cannot match across it.
 */
const SEGMENT_SEPARATOR = /[,;:()[\]{}/|]+/;

/** `-es` endings that survive as a stem once the `es` is dropped. */
const DROPPABLE_ES = /(?:ss|zz|x|ch|sh|o)es$/;

/**
 * NFD-normalise, strip diacritics, lowercase, collapse every run of non-`[a-z0-9]` to a
 * single space, trim. `"Crème Brûlée"` becomes `"creme brulee"`.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(DIACRITIC, '')
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, ' ')
    .trim();
}

/**
 * `normalizeText`, then split on space. Empty input yields `[]` rather than `['']`, so a
 * caller counting tokens never counts a phantom one.
 */
export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized === '' ? [] : normalized.split(' ');
}

/**
 * Split the RAW string on separator punctuation first, then tokenize each segment, dropping
 * segments that hold no tokens.
 *
 * Splitting before normalising is the whole point: `normalizeText` turns a comma into a
 * space, so tokenising first would make `"milk, chocolate"` indistinguishable from
 * `"milk chocolate"` and a phrase rule would match across the comma.
 */
export function tokenizeSegments(value: string): string[][] {
  return value
    .split(SEGMENT_SEPARATOR)
    .map((segment) => tokenize(segment))
    .filter((tokens) => tokens.length > 0);
}

/**
 * Deliberately naive stemming: `-ies` to `-y`, a droppable `-es` to its stem, an ordinary
 * trailing `s` away. It runs on ingredient nouns, not on prose, so the length guards and the
 * `ss`/`us` exceptions are the entire defence against mangling a singular word.
 */
export function singularize(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && DROPPABLE_ES.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/** Normalized tokens joined with hyphens. The id spelling used throughout the catalog. */
export function kebabCase(value: string): string {
  return tokenize(value).join('-');
}

/** `kebabCase`, with each token singularised first, so `"Mixed Berries"` is `"mixed-berry"`. */
export function singularKebabCase(value: string): string {
  return tokenize(value).map(singularize).join('-');
}

/**
 * Exactly `-1`, `0` or `1` by code-unit order. The universal tie-break: because it is total
 * and returns a fixed magnitude, every sort in the system that falls through to it produces
 * the same order on every run.
 */
export function compareIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * True when `needle` appears as a contiguous run of WHOLE tokens in `haystack`. An empty
 * needle, or one longer than the haystack, is false.
 *
 * Never a substring match: `containsTokenSequence(['minute'], ['nut'])` is false.
 */
export function containsTokenSequence(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  const lastStart = haystack.length - needle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      // noUncheckedIndexedAccess: both reads are `string | undefined`. Two undefined reads
      // must not compare equal and count as a match, so each is rejected explicitly.
      const actual = haystack[start + offset];
      const expected = needle[offset];
      if (actual === undefined || expected === undefined || actual !== expected) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}
