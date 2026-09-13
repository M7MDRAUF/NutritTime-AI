/**
 * Ingredient resolver (T-07-07, TSD 7.4 step 1).
 *
 * Maps a TheMealDB ingredient name onto exactly one USDA dataset row, or onto nothing.
 *
 * The rule that shapes the whole module: **an unknown term returns no match, never a near
 * one.** A wrong ingredient does not announce itself - it produces a full set of four
 * plausible numbers computed from the wrong food - whereas no match produces `null`s and a
 * reason, which a reader can see and fix. So there is no edit distance here, no token-overlap
 * score, no "closest description" and no fallback to a category. Resolution is exact lookup
 * against curated tables, and everything else fails.
 *
 * Two stages, kept separable because they fail for different reasons and want different
 * fixes:
 *
 *   1. **Canonicalisation** - normalise, strip preparation words, singularise, apply aliases.
 *      Answers "what food is this name?" Fixed by adding an alias.
 *   2. **Binding** - look the canonical name up in `INGREDIENT_BINDINGS`. Answers "which USDA
 *      row is that food?" Fixed by adding a binding, which may be impossible: `shallots`
 *      canonicalises correctly and has no row anywhere in the FNDDS ingredient list.
 *
 * Keeping them apart is what lets the resolver say "shallots, which the dataset does not
 * carry" instead of the much less useful "unrecognised ingredient".
 */

import { normalizeText, singularize, tokenize } from '@nutritime/domain';

import {
  INGREDIENT_ALIASES,
  INGREDIENT_BINDINGS,
  PREPARATION_WORDS,
} from './ingredient-bindings.js';
import type { IngredientBinding } from './ingredient-bindings.js';

export type IngredientFailureKind =
  /** The name normalised away to nothing - empty, or punctuation only. */
  | 'empty-name'
  /** No alias and no binding recognises this name. Fix: add an alias or a binding. */
  | 'unknown-ingredient'
  /** The name canonicalised, but the dataset carries no row for that food. Fix: nothing. */
  | 'unbound-ingredient';

export interface IngredientResolution {
  readonly ok: true;
  /** The canonical key, and the key the emitted `NutrientRow` is filed under. */
  readonly key: string;
  readonly binding: IngredientBinding;
}

export interface IngredientFailure {
  readonly ok: false;
  readonly kind: IngredientFailureKind;
  /** The canonical name reached before the failure, when one was reached. */
  readonly key: string | null;
  readonly reason: string;
}

export type IngredientResult = IngredientResolution | IngredientFailure;

/** Drop preparation words, unless they are the whole name - `fresh` alone is not nothing. */
function stripPreparationWords(tokens: readonly string[]): string[] {
  const kept = tokens.filter((token) => !PREPARATION_WORDS.has(token));
  return kept.length === 0 ? [...tokens] : kept;
}

/**
 * Reduce a raw ingredient name to its canonical form, or null when nothing recognises it.
 *
 * Exported separately from `resolveIngredient` so that alias handling can be asserted on its
 * own: `challots` canonicalises to `shallots` whether or not the dataset can bind it.
 *
 * Four candidate spellings are tried, in order of decreasing fidelity to what was written, so
 * that a more specific table entry always beats a more general one. `dried oregano` matches
 * its own entry before the bare `oregano` is ever considered.
 */
export function canonicalizeIngredientName(name: string): string | null {
  const normalized = normalizeText(name);
  if (normalized === '') {
    return null;
  }

  const tokens = tokenize(normalized);
  const stripped = stripPreparationWords(tokens);

  const candidates = [
    normalized,
    stripped.join(' '),
    tokens.map(singularize).join(' '),
    stripped.map(singularize).join(' '),
  ];

  for (const candidate of candidates) {
    if (candidate === '') {
      continue;
    }
    const alias = INGREDIENT_ALIASES.get(candidate);
    if (alias !== undefined) {
      return alias;
    }
    if (INGREDIENT_BINDINGS.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Resolve a TheMealDB ingredient name to its USDA binding.
 *
 * Never throws and never guesses: the caller gets a binding or a named reason, and T-07-09
 * turns any reason at all into four `null`s for the whole meal.
 */
export function resolveIngredient(name: string): IngredientResult {
  if (normalizeText(name) === '') {
    return {
      ok: false,
      kind: 'empty-name',
      key: null,
      reason: `"${name}" contains no ingredient name`,
    };
  }

  const key = canonicalizeIngredientName(name);
  if (key === null) {
    return {
      ok: false,
      kind: 'unknown-ingredient',
      key: null,
      reason:
        `"${name}" matches no ingredient alias or binding; it is left unresolved rather ` +
        'than matched to the nearest name',
    };
  }

  const binding = INGREDIENT_BINDINGS.get(key);
  if (binding === undefined) {
    return {
      ok: false,
      kind: 'unbound-ingredient',
      key,
      reason: `"${name}" resolves to "${key}", which the USDA dataset carries no row for`,
    };
  }

  return { ok: true, key, binding };
}
