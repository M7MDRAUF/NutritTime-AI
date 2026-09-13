import { describe, expect, it } from 'vitest';

import { INGREDIENT_BINDINGS } from './ingredient-bindings.js';
import { canonicalizeIngredientName, resolveIngredient } from './ingredient-resolver.js';

/**
 * Plan.md T-07-07 acceptance: aliases resolve `aubergine`, `challots` and `cashews`, and an
 * unknown term returns no match rather than a near one.
 *
 * The last clause is the one worth testing hardest. Any resolver can map a word it knows; the
 * property that matters is that it declines the words it does not, including the ones that
 * look tantalisingly close to something it does know.
 */

describe('canonicalizeIngredientName - British to US spellings', () => {
  it('resolves the three names the acceptance row names', () => {
    expect(canonicalizeIngredientName('Aubergine')).toBe('eggplant');
    expect(canonicalizeIngredientName('Challots')).toBe('shallots');
    expect(canonicalizeIngredientName('Cashews')).toBe('cashews');
  });

  it('resolves the rest of the British spellings', () => {
    expect(canonicalizeIngredientName('Courgettes')).toBe('zucchini');
    expect(canonicalizeIngredientName('Coriander')).toBe('cilantro');
    expect(canonicalizeIngredientName('Rocket')).toBe('arugula');
    expect(canonicalizeIngredientName('Prawns')).toBe('shrimp');
    expect(canonicalizeIngredientName('Plain Flour')).toBe('all purpose flour');
    expect(canonicalizeIngredientName('Double Cream')).toBe('heavy cream');
    expect(canonicalizeIngredientName('Minced Beef')).toBe('ground beef');
  });
});

describe('canonicalizeIngredientName - compound phrases and plurals', () => {
  it('reduces a preparation phrase to the ingredient', () => {
    expect(canonicalizeIngredientName('freshly chopped parsley')).toBe('parsley');
    expect(canonicalizeIngredientName('Finely Chopped Onions')).toBe('onion');
    expect(canonicalizeIngredientName('peeled and diced potatoes')).toBe('potato');
  });

  it('singularises a plural that has no explicit alias', () => {
    expect(canonicalizeIngredientName('Carrots')).toBe('carrot');
    expect(canonicalizeIngredientName('Tomatoes')).toBe('tomato');
    expect(canonicalizeIngredientName('Mushrooms')).toBe('mushroom');
  });

  it('strips diacritics through normalizeText', () => {
    expect(canonicalizeIngredientName('Crème')).toBeNull();
    expect(canonicalizeIngredientName('  Olive   Oil  ')).toBe('olive oil');
  });

  it('does not strip a word that changes the food', () => {
    // `ground` distinguishes ground beef from beef and ground almonds from almonds, so it is
    // not a preparation word. `ground beef` must not reduce to `beef`.
    expect(canonicalizeIngredientName('Ground Beef')).toBe('ground beef');
  });

  it('does not reduce a name to nothing when every token is a preparation word', () => {
    // `Chopped` alone is not an ingredient, but it must not silently become one either.
    expect(canonicalizeIngredientName('Chopped')).toBeNull();
  });
});

describe('resolveIngredient - refusal', () => {
  it('returns no match for an unknown ingredient', () => {
    const result = resolveIngredient('Sriracha Aioli');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('unknown-ingredient');
    }
  });

  it('refuses a near miss rather than resolving it to the word it resembles', () => {
    // Each of these is one or two characters from a name in the tables. A fuzzy matcher
    // would resolve every one of them, and every one would be wrong.
    for (const name of ['Buttermilk', 'Onion Powder', 'Garlic Powder', 'Tomato Soup', 'Ricee']) {
      const result = resolveIngredient(name);
      expect(result.ok, `${name} must not resolve`).toBe(false);
    }
  });

  it('distinguishes a name it cannot canonicalise from a food the dataset lacks', () => {
    // `challots` is understood - it means shallots - but FNDDS carries no shallot row at all.
    // Reporting that is materially more useful than "unrecognised ingredient", and it is the
    // difference between "add an alias" and "this cannot be fixed here".
    const shallots = resolveIngredient('Challots');
    expect(shallots.ok).toBe(false);
    if (!shallots.ok) {
      expect(shallots.kind).toBe('unbound-ingredient');
      expect(shallots.key).toBe('shallots');
      expect(shallots.reason).toContain('shallots');
    }
  });

  it('reports an empty name as empty rather than unknown', () => {
    const result = resolveIngredient('   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('empty-name');
    }
  });
});

describe('resolveIngredient - binding', () => {
  it('binds a resolved name to one exact USDA code', () => {
    const result = resolveIngredient('Aubergine');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBe('eggplant');
      expect(result.binding.usdaCode).toBe('11209');
      expect(result.binding.usdaDescription).toBe('Eggplant, raw');
    }
  });

  it('binds two spellings of one food to the same row', () => {
    const british = resolveIngredient('Courgettes');
    const american = resolveIngredient('Zucchini');
    expect(british.ok && american.ok).toBe(true);
    if (british.ok && american.ok) {
      expect(british.binding.usdaCode).toBe(american.binding.usdaCode);
    }
  });

  it('binds every canonical name in the alias table that has a binding', () => {
    // Guards against an alias whose target was renamed: the alias would still "resolve" and
    // then silently fail to bind for the rest of the project's life.
    const unbound: string[] = [];
    for (const key of INGREDIENT_BINDINGS.keys()) {
      const result = resolveIngredient(key);
      if (!result.ok) {
        unbound.push(key);
      }
    }
    expect(unbound).toEqual([]);
  });
});
