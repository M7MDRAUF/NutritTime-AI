import { describe, expect, it } from 'vitest';
import {
  closeAllergenImplications,
  conflictingAllergens,
  effectiveAllergenTags,
  hasAllergenConflict,
  inferAllergensFromIngredients,
  isCanonicalAllergen,
  normalizeAllergen,
} from './allergens.js';
import type { AllergenSubject } from './allergens.js';
import type { CanonicalAllergen } from '@nutritime/contracts';

/**
 * The module where a defect is silent and a safety issue. These tests are weighted toward
 * false negatives - an allergen that should have been found and was not - because that is
 * the failure a user cannot see.
 */

const subject = (ingredients: string[], allergenTags: string[] = []): AllergenSubject => ({
  allergenTags,
  ingredients: ingredients.map((name) => ({ name })),
});

const inferred = (...names: string[]) => [...inferAllergensFromIngredients(names)].sort();

describe('isCanonicalAllergen', () => {
  it('accepts every member of the taxonomy and nothing else', () => {
    expect(isCanonicalAllergen('peanut')).toBe(true);
    expect(isCanonicalAllergen('tree-nut')).toBe(true);
    expect(isCanonicalAllergen('sesame')).toBe(true);
    expect(isCanonicalAllergen('peanuts')).toBe(false);
    expect(isCanonicalAllergen('treenut')).toBe(false);
    expect(isCanonicalAllergen('cilantro')).toBe(false);
  });
});

describe('single-word inference', () => {
  it.each([
    ['almonds', 'tree-nut'],
    ['cheddar', 'milk'],
    ['mayonnaise', 'egg'],
    ['tofu', 'soy'],
    ['spaghetti', 'wheat'],
    ['barley', 'gluten'],
    ['anchovies', 'fish'],
    ['prawns', 'shellfish'],
    ['tahini', 'sesame'],
    ['groundnut oil', 'peanut'],
  ])('reads %s as %s', (name, tag) => {
    expect(inferred(name)).toContain(tag);
  });

  it('carries a word that belongs to two allergens into both', () => {
    // Custard is egg and milk; hollandaise likewise. A single-allergen answer here would
    // clear the meal for whichever allergy the table happened not to list first.
    expect(inferred('custard')).toEqual(['egg', 'milk']);
    expect(inferred('hollandaise sauce')).toEqual(['egg', 'milk']);
  });

  it('finds nothing in an ingredient that carries no allergen', () => {
    expect(inferred('carrot', 'olive oil', 'fresh basil')).toEqual([]);
  });
});

describe('phrase rules beat the single-word table', () => {
  // The headline suppressor cases from Plan.md 19.3.
  it('reads coconut milk as a tree nut and NOT as dairy', () => {
    expect(inferred('coconut milk')).toEqual(['tree-nut']);
  });

  it('reads water chestnut as carrying nothing at all', () => {
    expect(inferred('water chestnut')).toEqual([]);
  });

  it.each([
    ['oat milk', []],
    ['rice milk', []],
    ['rice flour', []],
    ['cocoa butter', []],
    ['flax egg', []],
  ])('suppresses %s', (name, expectedTags) => {
    expect(inferred(name)).toEqual(expectedTags);
  });

  it('flags "gluten free bread" as containing gluten - a false positive, accepted', () => {
    // The suppressor claims the words "gluten free"; `bread` is a separate token and still
    // maps to wheat. So a genuinely safe loaf is hidden from a gluten-aware user.
    //
    // That is the tolerable direction. Suppressing the whole segment instead would also
    // silence a real allergen: "gluten free soy sauce" would stop reporting soy, which is a
    // false NEGATIVE and the failure this module exists to prevent. Fixing this properly
    // needs a rule that removes specific tags rather than claiming tokens, which TSD 4.4 does
    // not describe - so it is recorded rather than invented here.
    expect(inferred('gluten free bread')).toEqual(['gluten', 'wheat']);
  });

  it('never lets a suppressor silence an unrelated allergen', () => {
    // The property that matters: whatever "gluten free" does to gluten, soy survives.
    expect(inferred('gluten free soy sauce')).toContain('soy');
  });

  it.each([
    ['almond milk', ['tree-nut']],
    ['soy milk', ['soy']],
    ['peanut butter', ['peanut']],
    ['bean curd', ['soy']],
  ])('redirects %s to %s', (name, expectedTags) => {
    expect(inferred(name)).toEqual(expectedTags);
  });

  it('adds every allergen of a compound food, not just the obvious one', () => {
    // Soy sauce is brewed with wheat. A soy-only answer would clear it for a wheat allergy.
    expect(inferred('soy sauce')).toEqual(['gluten', 'soy', 'wheat']);
    expect(inferred('caesar dressing')).toEqual(['egg', 'fish', 'milk']);
    expect(inferred('lemon curd')).toEqual(['egg', 'milk']);
  });

  it('prefers the longer phrase when one nests inside another', () => {
    // 'peanut butter' must win over a bare 'butter', which would add milk.
    expect(inferred('peanut butter')).not.toContain('milk');
  });
});

describe('suppression is segment-scoped, addition is not', () => {
  it('does not let a suppressor reach across a comma', () => {
    // 'water chestnut' suppresses within its own clause; the almonds in the next clause are
    // untouched. Suppression crossing a boundary is how an allergen goes missing.
    expect(inferred('water chestnut, toasted almonds')).toEqual(['tree-nut']);
  });

  it('still finds a phrase that spans a segment boundary', () => {
    // Addition is unscoped precisely so a comma cannot hide something.
    expect(inferred('soy, sauce')).toContain('soy');
  });
});

describe('closeAllergenImplications', () => {
  it('adds gluten to wheat', () => {
    const closed = closeAllergenImplications(new Set<CanonicalAllergen>(['wheat']));
    expect([...closed].sort()).toEqual(['gluten', 'wheat']);
  });

  it('does not add wheat to gluten', () => {
    // Barley and rye carry gluten with no wheat. The implication runs one way only.
    const closed = closeAllergenImplications(new Set<CanonicalAllergen>(['gluten']));
    expect([...closed]).toEqual(['gluten']);
  });

  it('reaches a fixpoint through a chain', () => {
    const closed = closeAllergenImplications(new Set<CanonicalAllergen>(['wheat', 'milk']), {
      wheat: ['gluten'],
      gluten: ['sesame'],
    });
    expect([...closed].sort()).toEqual(['gluten', 'milk', 'sesame', 'wheat']);
  });

  it('applies the closure through the public inference entry point', () => {
    expect(inferred('plain flour')).toEqual(['gluten', 'wheat']);
  });
});

describe('normalizeAllergen', () => {
  it('passes a canonical value through', () => {
    expect(normalizeAllergen('peanut')).toBe('peanut');
    expect(normalizeAllergen('tree-nut')).toBe('tree-nut');
  });

  it('resolves a plural and a synonym via the ingredient lexicon', () => {
    expect(normalizeAllergen('peanuts')).toBe('peanut');
    expect(normalizeAllergen('almond')).toBe('tree-nut');
    expect(normalizeAllergen('cheddar')).toBe('milk');
  });

  it('returns null for a term that implies more than one allergen', () => {
    // Ambiguity is not resolved by picking one. The caller widens the match instead.
    expect(normalizeAllergen('custard')).toBeNull();
  });

  it('returns null for a term the lexicon does not know', () => {
    expect(normalizeAllergen('cilantro')).toBeNull();
    expect(normalizeAllergen('   ')).toBeNull();
  });
});

describe('effectiveAllergenTags', () => {
  it('is the union of declared tags and what the ingredients betray', () => {
    // The record claims only milk; the ingredient list gives away the wheat.
    const tags = effectiveAllergenTags(subject(['plain flour', 'butter'], ['milk']));
    expect([...tags].sort()).toEqual(['gluten', 'milk', 'wheat']);
  });

  it('finds an allergen the record failed to declare', () => {
    // This is the case the union exists for: a mistagged catalog record.
    const tags = effectiveAllergenTags(subject(['peanut oil'], []));
    expect([...tags]).toContain('peanut');
  });

  it('keeps a declared tag outside the taxonomy as a literal', () => {
    const tags = effectiveAllergenTags(subject(['rice'], ['cilantro']));
    expect([...tags]).toContain('cilantro');
  });

  it('resolves a non-canonical declared tag to its canonical allergen too', () => {
    const tags = effectiveAllergenTags(subject(['rice'], ['almonds']));
    expect([...tags]).toContain('tree-nut');
    expect([...tags]).toContain('almond');
  });
});

describe('conflictingAllergens', () => {
  const arrabiata = subject(
    ['penne rigate', 'olive oil', 'garlic', 'chopped tomatoes', 'parmigiano'],
    ['gluten', 'milk', 'wheat'],
  );

  it('matches a declared allergy against a tagged allergen', () => {
    expect(conflictingAllergens(arrabiata, ['milk'])).toEqual(['milk']);
  });

  it('matches through the taxonomy, so a plural still conflicts', () => {
    expect(conflictingAllergens(arrabiata, ['peanuts'])).toEqual([]);
    expect(conflictingAllergens(subject(['peanut oil']), ['peanuts'])).toEqual(['peanut']);
  });

  it('matches an allergy the taxonomy has never heard of, by ingredient name', () => {
    // Path 2. Without it, every allergy outside the ten canonical ones is invisible.
    const soup = subject(['chicken stock', 'fresh cilantro', 'lime']);
    expect(conflictingAllergens(soup, ['cilantro'])).toEqual(['cilantro']);
    expect(conflictingAllergens(soup, ['parsley'])).toEqual([]);
  });

  it('does not match a literal term inside a suppressed phrase', () => {
    // A chestnut allergy must not be triggered by water chestnut, which is not a nut.
    const stirFry = subject(['water chestnut', 'spring onion']);
    expect(conflictingAllergens(stirFry, ['chestnut'])).toEqual([]);
  });

  it('matches an ambiguous term through what it implies', () => {
    // Path 3: 'custard' resolves to no single allergen, but the meal carries both of its.
    const trifle = subject(['sponge', 'custard', 'cream']);
    expect(conflictingAllergens(trifle, ['custard'])).toEqual(['custard']);
  });

  it('returns every matching allergy, sorted', () => {
    expect(conflictingAllergens(arrabiata, ['milk', 'gluten', 'wheat'])).toEqual([
      'gluten',
      'milk',
      'wheat',
    ]);
  });

  it('ignores an empty or blank allergy term', () => {
    expect(conflictingAllergens(arrabiata, ['', '   '])).toEqual([]);
  });

  it('finds a conflict through the wheat-to-gluten implication', () => {
    // The record declares wheat only; a gluten allergy must still catch it.
    const bread = subject(['wheat flour', 'water', 'yeast'], ['wheat']);
    expect(conflictingAllergens(bread, ['gluten'])).toEqual(['gluten']);
  });
});

describe('hasAllergenConflict', () => {
  it('is true when any allergy matches and false when none does', () => {
    const dish = subject(['prawns', 'rice']);
    expect(hasAllergenConflict(dish, ['shellfish'])).toBe(true);
    expect(hasAllergenConflict(dish, ['peanut'])).toBe(false);
    expect(hasAllergenConflict(dish, [])).toBe(false);
  });
});

describe('umbrella and colloquial allergy terms (regression)', () => {
  // Both of these returned [] before P04 verification. They are the highest-severity class
  // of defect this module can have: a real allergen present, nothing reported, silently.

  it('warns a user allergic to "nuts" about peanuts', () => {
    // 'nut' resolving to a single canonical allergen gated off the ambiguous-match path, so
    // a peanut meal matched nothing. "nuts" is the likeliest thing a user actually types.
    expect(conflictingAllergens(subject(['peanut butter', 'bread']), ['nuts'])).toEqual(['nut']);
    expect(hasAllergenConflict(subject(['peanut oil']), ['nut'])).toBe(true);
  });

  it('still warns a user allergic to "nuts" about tree nuts', () => {
    expect(hasAllergenConflict(subject(['toasted almonds']), ['nuts'])).toBe(true);
  });

  it('warns a user allergic to "seafood" about shellfish and about fish', () => {
    // An umbrella term that infers nothing defeats the catch-all path, because that path
    // tests what the term implies.
    expect(hasAllergenConflict(subject(['king prawns', 'garlic']), ['seafood'])).toBe(true);
    expect(hasAllergenConflict(subject(['smoked salmon']), ['seafood'])).toBe(true);
  });

  it('warns a user allergic to "molluscs" about mussels', () => {
    expect(hasAllergenConflict(subject(['mussels', 'white wine']), ['molluscs'])).toBe(true);
  });
});

describe('token collisions and label suppressors (regression)', () => {
  it('does not lose wheat when a quantity word precedes flour', () => {
    // A 'gram flour' rule collided with the unit word: "500 grams flour" singularises to
    // ["500","gram","flour"], the rule claimed both, and the wheat vanished.
    expect(inferred('500 grams flour')).toEqual(['gluten', 'wheat']);
  });

  it.each([
    ['cream of tartar', []],
    ['butter beans', []],
    ['dairy-free spread', []],
    ['nut-free spread', []],
  ])('does not report an allergen for %s', (name, expectedTags) => {
    expect(inferred(name)).toEqual(expectedTags);
  });

  it('suppresses only what the label names, not the rest of the ingredient', () => {
    // "nut-free chocolate spread" correctly reports milk: the suppressor claims "nut free",
    // and `chocolate` is a separate token. Suppressing the whole segment instead would hide
    // the dairy, which is the dangerous direction.
    const tags = inferred('nut-free chocolate spread');
    expect(tags).toEqual(['milk']);
    expect(tags).not.toContain('tree-nut');
  });

  it('reports wheat for catalog staples that carry it without saying so', () => {
    expect(inferred('pork sausages')).toContain('wheat');
    expect(inferred('pizza dough')).toContain('wheat');
    expect(inferred('shredded suet')).toContain('wheat');
  });
});
