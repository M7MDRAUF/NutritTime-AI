/**
 * Allergen inference and conflict detection (TSD 4.4, PRD FR-007, FR-015).
 *
 * This is the one module where a defect is a safety issue and the failure is silent: a meal
 * wrongly cleared looks exactly like a meal correctly cleared. Every decision below leans the
 * same way - toward finding an allergen rather than missing one - and the phrase suppressors
 * are the deliberate, enumerated exceptions.
 *
 * Nothing downstream can reverse what this module decides. The recommendation engine rejects
 * before it scores, and retrieval rejects before the model is reachable.
 */

import type { CanonicalAllergen } from '@nutritime/contracts';
import { CANONICAL_ALLERGENS } from '@nutritime/contracts';
import { ALLERGEN_IMPLICATIONS, ALLERGEN_PHRASES, ALLERGEN_TOKENS } from './allergen-lexicon.js';
import {
  containsTokenSequence,
  singularKebabCase,
  singularize,
  tokenize,
  tokenizeSegments,
} from './text.js';

export interface AllergenSubject {
  readonly allergenTags: readonly string[];
  readonly ingredients: readonly { readonly name: string }[];
}

const CANONICAL = new Set<string>(CANONICAL_ALLERGENS);

export function isCanonicalAllergen(value: string): value is CanonicalAllergen {
  return CANONICAL.has(value);
}

/** An ingredient name as segments of singularised tokens. */
function ingredientSegments(name: string): string[][] {
  return tokenizeSegments(name).map((segment) => segment.map(singularize));
}

/**
 * Apply the phrase rules to one token run.
 *
 * Rules are longest-first, so a longer phrase claims its tokens before a shorter one nested
 * inside it. A matched rule marks every token it covers as consumed and contributes its tags;
 * a suppressor contributes nothing but still consumes, which is the whole mechanism by which
 * `water chestnut` stops being a tree nut.
 *
 * Returns the consumption mask so the caller can skip claimed tokens in the word pass.
 */
function claimPhrases(tokens: readonly string[], into: Set<CanonicalAllergen>): boolean[] {
  const consumed: boolean[] = tokens.map(() => false);

  for (const rule of ALLERGEN_PHRASES) {
    const span = rule.tokens.length;
    if (span === 0 || span > tokens.length) {
      continue;
    }
    for (let start = 0; start + span <= tokens.length; start += 1) {
      if (!containsTokenSequence(tokens.slice(start, start + span), rule.tokens)) {
        continue;
      }
      for (let offset = 0; offset < span; offset += 1) {
        consumed[start + offset] = true;
      }
      for (const tag of rule.tags) {
        into.add(tag);
      }
    }
  }

  return consumed;
}

/** Phrase pass, then the single-word table over whatever the phrases did not claim. */
function inferFromTokens(tokens: readonly string[], into: Set<CanonicalAllergen>): void {
  const consumed = claimPhrases(tokens, into);
  tokens.forEach((token, index) => {
    if (consumed[index] === true) {
      return;
    }
    for (const tag of ALLERGEN_TOKENS[token] ?? []) {
      into.add(tag);
    }
  });
}

/**
 * Infer from a set of raw names, before implication closure.
 *
 * The two passes are deliberately asymmetric. Suppression is **segment-scoped**, so a phrase
 * cannot reach across a comma to cancel an allergen in a different clause. Addition is not
 * scoped, so a phrase spanning a segment boundary is still found - because failing to add is
 * the dangerous direction and failing to suppress is merely annoying.
 */
function inferRaw(names: readonly string[]): Set<CanonicalAllergen> {
  const found = new Set<CanonicalAllergen>();
  for (const name of names) {
    for (const segment of ingredientSegments(name)) {
      inferFromTokens(segment, found);
    }
    claimPhrases(tokenize(name).map(singularize), found);
  }
  return found;
}

export function inferAllergensFromIngredients(
  ingredientNames: readonly string[],
): ReadonlySet<CanonicalAllergen> {
  return closeAllergenImplications(inferRaw(ingredientNames));
}

/**
 * Close a tag set under the implication table, to a fixpoint.
 *
 * `Set` iteration visits values appended during the walk, so a chain of implications resolves
 * in one pass without a worklist.
 */
export function closeAllergenImplications(
  tags: ReadonlySet<CanonicalAllergen>,
  implications: typeof ALLERGEN_IMPLICATIONS = ALLERGEN_IMPLICATIONS,
): ReadonlySet<CanonicalAllergen> {
  const closed = new Set<CanonicalAllergen>(tags);
  for (const tag of closed) {
    for (const implied of implications[tag] ?? []) {
      closed.add(implied);
    }
  }
  return closed;
}

/**
 * Resolve a free-text allergy term to a canonical allergen, or `null` when it is ambiguous.
 *
 * Reuses the ingredient lexicon rather than keeping a second alias table, so `almond` resolves
 * to `tree-nut` without anyone maintaining a synonym list twice. A term inferring more than
 * one allergen is ambiguous and returns `null` - the caller then falls back to the broader
 * match in `conflictingAllergens`, which is the safe direction.
 */
export function normalizeAllergen(value: string): CanonicalAllergen | null {
  const key = singularKebabCase(value);
  if (key === '') {
    return null;
  }
  if (isCanonicalAllergen(key)) {
    return key;
  }
  const inferred = [...inferRaw([value])];
  const only = inferred[0];
  return only !== undefined && inferred.length === 1 ? only : null;
}

/**
 * Declared tags UNION tags inferred from the ingredient list, implication-closed.
 *
 * A catalog record may omit a tag its own ingredient list betrays, which is exactly why the
 * union exists: the declared tags are a claim, the ingredients are evidence, and this trusts
 * both. The raw declared literals are kept alongside the canonical set so an allergy the
 * taxonomy has never heard of can still match.
 */
export function effectiveAllergenTags(subject: AllergenSubject): ReadonlySet<string> {
  const canonical = new Set<CanonicalAllergen>();
  const literals = new Set<string>();

  for (const declared of subject.allergenTags) {
    const literal = singularKebabCase(declared);
    if (literal === '') {
      continue;
    }
    literals.add(literal);
    if (isCanonicalAllergen(literal)) {
      canonical.add(literal);
      continue;
    }
    // A declared tag outside the taxonomy still contributes whatever it implies.
    for (const implied of inferRaw([declared])) {
      canonical.add(implied);
    }
  }

  for (const inferred of inferRaw(subject.ingredients.map((item) => item.name))) {
    canonical.add(inferred);
  }

  return new Set<string>([...closeAllergenImplications(canonical), ...literals]);
}

/**
 * Blank the tokens a phrase legitimately claimed, so a literal scan cannot match inside a
 * suppressed phrase. A user allergic to `chestnut` must not be warned off `water chestnut`,
 * which is an aquatic vegetable.
 *
 * Only tokens that a phrase consumed AND the word table knows are blanked: blanking anything
 * else would hide ordinary words from the literal search.
 */
function unclaimedTokens(tokens: readonly string[]): string[] {
  const consumed = claimPhrases(tokens, new Set<CanonicalAllergen>());
  return tokens.map((token, index) =>
    consumed[index] === true && ALLERGEN_TOKENS[token] !== undefined ? '' : token,
  );
}

/**
 * Which of the user's declared allergies this subject conflicts with.
 *
 * Three independent paths, any one of which is a conflict:
 *
 * 1. The allergy, canonicalised, is among the subject's effective tags.
 * 2. The allergy term appears literally in an ingredient name. This is what catches an allergy
 *    the taxonomy has never heard of - `cilantro`, `nightshade` - which the whole canonical
 *    machinery above would otherwise miss entirely.
 * 3. The allergy is an ambiguous term whose own inference overlaps the subject's tags.
 *
 * Results are sorted so the output is stable and testable.
 */
export function conflictingAllergens(
  subject: AllergenSubject,
  userAllergies: readonly string[],
): string[] {
  const effective = effectiveAllergenTags(subject);
  const scannable = subject.ingredients.flatMap((item) =>
    ingredientSegments(item.name).map(unclaimedTokens),
  );
  const matched = new Set<string>();

  for (const allergy of userAllergies) {
    const literal = singularKebabCase(allergy);
    if (literal === '') {
      continue;
    }
    const canonical = normalizeAllergen(allergy);
    const key = canonical ?? literal;
    const needle = literal.split('-');

    const taggedDirectly = effective.has(key);
    const namedInIngredients = scannable.some((tokens) => containsTokenSequence(tokens, needle));
    const impliedByAmbiguousTerm =
      canonical === null && [...inferRaw([allergy])].some((tag) => effective.has(tag));

    if (taggedDirectly || namedInIngredients || impliedByAmbiguousTerm) {
      matched.add(key);
    }
  }

  return [...matched].sort();
}

export function hasAllergenConflict(
  subject: AllergenSubject,
  userAllergies: readonly string[],
): boolean {
  return conflictingAllergens(subject, userAllergies).length > 0;
}
