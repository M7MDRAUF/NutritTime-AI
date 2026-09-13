/**
 * Allergen lexicon (TSD 4.4).
 *
 * Three tables. They are data, and they live here rather than in the specification because
 * they will grow as the catalog does.
 *
 * The asymmetry that governs every entry: a **false negative hides an allergen from someone
 * who asked about it**, and a false positive only hides a safe meal. So the token lists are
 * generous, and the phrase rules exist to take back the specific cases where that generosity
 * is wrong.
 */

import type { CanonicalAllergen } from '@nutritime/contracts';
import { singularize, tokenize } from './text.js';

/**
 * A tag that necessarily implies another. Wheat contains gluten, so a wheat tag implies a
 * gluten one - but not the reverse: barley and rye carry gluten with no wheat in sight.
 */
export const ALLERGEN_IMPLICATIONS: Partial<
  Record<CanonicalAllergen, readonly CanonicalAllergen[]>
> = {
  wheat: ['gluten'],
};

/**
 * Single words that carry an allergen. Keys are lowercase and singular, because input is
 * singularised before lookup. A word may carry several allergens - `custard` is egg and milk.
 */
const TOKEN_GROUPS: readonly (readonly [CanonicalAllergen, readonly string[]])[] = [
  // `nut` is deliberately listed under BOTH peanut and tree-nut. Colloquially "nuts"
  // includes peanuts, and a user who types "nuts" is the common case. Listing it once made
  // the term resolve to a single canonical allergen, which closed off the ambiguous-match
  // path and left a peanut allergy matching nothing at all.
  ['peanut', ['peanut', 'nut', 'groundnut', 'arachis', 'satay']],
  [
    'tree-nut',
    [
      'nut',
      'almond',
      'cashew',
      'walnut',
      'pecan',
      'pistachio',
      'hazelnut',
      'filbert',
      'macadamia',
      'chestnut',
      'coconut',
      'praline',
      'marzipan',
      'frangipane',
      'pesto',
      'nougat',
      'gianduja',
      'amaretto',
      'amaretti',
    ],
  ],
  [
    'milk',
    [
      'milk',
      'dairy',
      'lactose',
      'casein',
      'caseinate',
      'whey',
      'butter',
      'buttermilk',
      'ghee',
      'cream',
      'creme',
      'custard',
      'yogurt',
      'yoghurt',
      'kefir',
      'curd',
      'cheese',
      'cheddar',
      'mozzarella',
      'parmesan',
      'parmigiano',
      'pecorino',
      'feta',
      'ricotta',
      'brie',
      'gouda',
      'mascarpone',
      'halloumi',
      'paneer',
      'gruyere',
      'emmental',
      'provolone',
      'gorgonzola',
      'stilton',
      'roquefort',
      'camembert',
      'burrata',
      'queso',
      'quark',
      'bechamel',
      'alfredo',
      'ganache',
      'tzatziki',
      'raita',
      'hollandaise',
      'bearnaise',
      // Unqualified chocolate is more often milk chocolate than not. Dark chocolate is
      // wrongly flagged, which hides a safe meal rather than exposing an unsafe one.
      'chocolate',
    ],
  ],
  [
    'egg',
    [
      'egg',
      'albumen',
      'albumin',
      'mayonnaise',
      'mayo',
      'aioli',
      'meringue',
      'quiche',
      'carbonara',
      'souffle',
      'omelette',
      'omelet',
      'frittata',
      'pavlova',
      'zabaglione',
      'custard',
      'hollandaise',
      'bearnaise',
    ],
  ],
  [
    'soy',
    [
      'soy',
      'soya',
      'soybean',
      'edamame',
      'tofu',
      'miso',
      'tempeh',
      'tamari',
      'natto',
      'shoyu',
      'hoisin',
      'gochujang',
      'ponzu',
      'yuba',
    ],
  ],
  [
    'wheat',
    [
      'wheat',
      'flour',
      'bread',
      'breadcrumb',
      'panko',
      'crouton',
      'pasta',
      'spaghetti',
      'macaroni',
      'penne',
      'linguine',
      'lasagna',
      'lasagne',
      'orzo',
      'rigatoni',
      'fettuccine',
      'tagliatelle',
      'tortellini',
      'ravioli',
      'farfalle',
      'fusilli',
      'gnocchi',
      'noodle',
      'vermicelli',
      'udon',
      'ramen',
      'wonton',
      'dumpling',
      'couscous',
      'semolina',
      'durum',
      'farro',
      'spelt',
      'bulgur',
      'seitan',
      'croissant',
      'bagel',
      'waffle',
      'pancake',
      'tortilla',
      'pita',
      'naan',
      'brioche',
      'baguette',
      'cracker',
      'biscuit',
      'pastry',
      'phyllo',
      'filo',
      'muffin',
      'pretzel',
      'matzo',
      'focaccia',
      'crepe',
      // Staples of the catalog's cuisines that carry wheat without saying so. Each leans to
      // the false-positive side on purpose: UK sausages are bound with rusk, retail suet is
      // flour-coated, and compounded asafoetida is cut with wheat flour. An Italian sausage
      // that is actually gluten-free is hidden; that is the tolerable error.
      'sausage',
      'dough',
      'suet',
      'asafoetida',
    ],
  ],
  ['gluten', ['gluten', 'barley', 'rye', 'malt', 'malted', 'beer', 'ale', 'lager', 'stout']],
  [
    'fish',
    [
      'fish',
      'anchovy',
      'salmon',
      'tuna',
      'cod',
      'haddock',
      'halibut',
      'sardine',
      'pilchard',
      'tilapia',
      'trout',
      'mackerel',
      'snapper',
      'bass',
      'bonito',
      'surimi',
      'catfish',
      'swordfish',
      'monkfish',
      'pollock',
      'herring',
      'kipper',
      'whitebait',
      'plaice',
      'hake',
      'eel',
      'caviar',
      'roe',
      'worcestershire',
      'dashi',
      'katsuobushi',
      // Umbrella terms. A user allergy that infers NOTHING defeats the ambiguous-match path
      // in conflictingAllergens, because that path tests what the term implies.
      'seafood',
    ],
  ],
  [
    'shellfish',
    [
      'shellfish',
      'crustacean',
      'shrimp',
      'prawn',
      'crab',
      'crabmeat',
      'lobster',
      'crawfish',
      'crayfish',
      'langoustine',
      'clam',
      'mussel',
      'oyster',
      'scallop',
      'squid',
      'calamari',
      'octopus',
      'krill',
      'scampi',
      'abalone',
      'cuttlefish',
      'seafood',
      'mollusc',
      'mollusk',
    ],
  ],
  ['sesame', ['sesame', 'tahini', 'benne', 'halva', 'zaatar', 'hummus', 'gomashio', 'furikake']],
];

/**
 * Multi-word rules, applied before the single-word table and claiming the tokens they match.
 *
 * A rule with **no tags is a suppressor**: it claims its tokens and contributes nothing, which
 * is how `water chestnut` avoids being read as a tree nut and `oat milk` avoids being read as
 * dairy. Without suppressors the generous token lists above would reject safe meals in bulk.
 */
const PHRASE_RULES: readonly {
  readonly phrase: string;
  readonly tags: readonly CanonicalAllergen[];
}[] = [
  // Not the allergen the token suggests.
  { phrase: 'water chestnut', tags: [] },
  { phrase: 'oat milk', tags: [] },
  { phrase: 'rice milk', tags: [] },
  { phrase: 'rice flour', tags: [] },
  { phrase: 'corn flour', tags: [] },
  { phrase: 'cornflour', tags: [] },
  { phrase: 'chickpea flour', tags: [] },
  // 'gram flour' is deliberately ABSENT. Its tokens collide with the unit word: "500 grams
  // flour" singularises to ["500","gram","flour"], the rule claimed both and the wheat
  // vanished. 'chickpea flour' covers the same ingredient without the collision.
  { phrase: 'potato flour', tags: [] },
  { phrase: 'rice noodle', tags: [] },
  { phrase: 'rice vermicelli', tags: [] },
  { phrase: 'glass noodle', tags: [] },
  // Claims only the two words it names. "gluten free bread" therefore still reports wheat
  // via `bread` - a false positive that hides a safe loaf. Suppressing the whole segment
  // would silence soy in "gluten free soy sauce", which is the far worse error.
  { phrase: 'gluten free', tags: [] },
  { phrase: 'cocoa butter', tags: [] },
  { phrase: 'shea butter', tags: [] },
  { phrase: 'vegan butter', tags: [] },
  { phrase: 'apple butter', tags: [] },
  { phrase: 'flax egg', tags: [] },
  { phrase: 'cream of tartar', tags: [] },
  { phrase: 'butter bean', tags: [] },
  // "<allergen> free" labels. Without these the label itself reports the allergen, and a
  // record declaring "nut free" would gain a tree-nut tag.
  { phrase: 'dairy free', tags: [] },
  { phrase: 'nut free', tags: [] },
  { phrase: 'egg free', tags: [] },
  { phrase: 'milk free', tags: [] },
  { phrase: 'egg plant', tags: [] },

  // The allergen is real but different from what the tokens would give.
  { phrase: 'peanut butter', tags: ['peanut'] },
  { phrase: 'peanut oil', tags: ['peanut'] },
  { phrase: 'peanut sauce', tags: ['peanut'] },
  { phrase: 'nut butter', tags: ['tree-nut'] },
  { phrase: 'pine nut', tags: ['tree-nut'] },
  { phrase: 'brazil nut', tags: ['tree-nut'] },
  { phrase: 'almond milk', tags: ['tree-nut'] },
  { phrase: 'almond flour', tags: ['tree-nut'] },
  { phrase: 'cashew milk', tags: ['tree-nut'] },
  { phrase: 'cashew cream', tags: ['tree-nut'] },
  { phrase: 'coconut milk', tags: ['tree-nut'] },
  { phrase: 'coconut cream', tags: ['tree-nut'] },
  { phrase: 'coconut flour', tags: ['tree-nut'] },
  { phrase: 'coconut oil', tags: ['tree-nut'] },
  { phrase: 'soy milk', tags: ['soy'] },
  { phrase: 'soya milk', tags: ['soy'] },
  { phrase: 'bean curd', tags: ['soy'] },

  // Compound foods carrying more than the obvious allergen.
  { phrase: 'soy sauce', tags: ['soy', 'wheat'] },
  { phrase: 'lemon curd', tags: ['egg', 'milk'] },
  { phrase: 'fish sauce', tags: ['fish'] },
  { phrase: 'nam pla', tags: ['fish'] },
  { phrase: 'oyster sauce', tags: ['shellfish'] },
  { phrase: 'worcestershire sauce', tags: ['fish'] },
  { phrase: 'caesar dressing', tags: ['fish', 'egg', 'milk'] },
  { phrase: 'egg white', tags: ['egg'] },
  { phrase: 'egg yolk', tags: ['egg'] },
  { phrase: 'sesame oil', tags: ['sesame'] },
  { phrase: 'sesame seed', tags: ['sesame'] },
  { phrase: 'wheat flour', tags: ['wheat'] },
  { phrase: 'whole wheat', tags: ['wheat'] },
  { phrase: 'monterey jack', tags: ['milk'] },
];

export interface CompiledPhraseRule {
  readonly tokens: readonly string[];
  readonly tags: readonly CanonicalAllergen[];
}

/**
 * Compiled longest-first.
 *
 * Note what this ordering does and does not buy. `claimPhrases` applies EVERY rule at every
 * position and unions both the consumption mask and the tag set, so the result is actually
 * order-independent: a later short rule can re-claim a token, but it can never retract a tag
 * an earlier rule added. Suppression works by claiming tokens before the single-word pass
 * runs, not by beating another phrase.
 *
 * The sort is therefore a readability aid and a hedge against a future best-match
 * implementation, not a live guarantee. Stating it as a guarantee would invite an editor to
 * rely on something the code does not do.
 */
export const ALLERGEN_PHRASES: readonly CompiledPhraseRule[] = PHRASE_RULES.map((rule) => ({
  tokens: tokenize(rule.phrase).map(singularize),
  tags: rule.tags,
})).sort((a, b) => b.tokens.length - a.tokens.length);

/**
 * The inverted single-word table, accumulating: a word appearing under two allergens carries
 * both. Built on a null-prototype object so an ingredient literally named `constructor` or
 * `toString` cannot reach an inherited property.
 */
function buildTokenIndex(): Record<string, readonly CanonicalAllergen[]> {
  const index = Object.create(null) as Record<string, CanonicalAllergen[]>;
  for (const [allergen, words] of TOKEN_GROUPS) {
    for (const word of words) {
      const bucket = index[word] ?? [];
      bucket.push(allergen);
      index[word] = bucket;
    }
  }
  return index;
}

export const ALLERGEN_TOKENS: Record<string, readonly CanonicalAllergen[]> = buildTokenIndex();
