/**
 * The curated tables the ingredient resolver reads (T-07-07, TSD 7.4 step 1).
 *
 * Three tables, each doing one job:
 *
 *   1. `PREPARATION_WORDS` - knife work and freshness words that never change WHICH food a
 *      name refers to, so `freshly chopped parsley` reduces to `parsley`.
 *   2. `INGREDIENT_ALIASES` - genuine renamings: British to US spellings, and the misspellings
 *      TheMealDB actually publishes. These change the word, never the food.
 *   3. `INGREDIENT_BINDINGS` - the binding from a canonical name to ONE exact USDA ingredient
 *      code.
 *
 * **Why a binding table rather than matching on the USDA description.** USDA descriptions are
 * `Butter, stick, salted` and `Squash, summer, zucchini, includes skin, raw`. No amount of
 * normalising makes `butter` equal the first or `courgette` the second, and any scheme that
 * got close - head-noun matching, token overlap, edit distance - would also make `oil` match
 * whichever of the fourteen oils happened to sort first. That is precisely the near miss
 * T-07-07 forbids, and a wrong ingredient produces wrong nutrition that looks right. So every
 * binding is made deliberately, by code, once; anything not in this table does not resolve.
 *
 * **Every code below was verified against the real `fndds_ingredient_nutrient_value.csv`**
 * (vintage 2022-10-28). `usdaDescription` is the verbatim description that code carries, and
 * `parseUsdaIngredientTable` re-checks it at build time, so a future dataset that reassigns a
 * code fails loudly instead of silently repointing an ingredient.
 *
 * **The measure data is AUTHORED, and is the risk Plan.md R-03 names.** Densities and
 * countable gram weights are not published in this archive - it ships nutrient values only -
 * so they are conventional figures entered here by hand. A wrong density scales one
 * ingredient; nothing downstream can detect it. They are deliberately sparse: an ingredient
 * that declares nothing simply refuses volume and count measures (see `measure.ts`), which is
 * a loud, fixable failure rather than a quiet wrong number.
 */

import type { IngredientMeasureData } from './measure.js';

/**
 * Words describing how an ingredient was cut, prepared or presented, plus the grammatical
 * filler that joins them. Removing them cannot change which food is meant, so they are
 * stripped before the name is looked up: `peeled and diced potatoes` is `potatoes`.
 *
 * Deliberately EXCLUDED, because each of these does change the food or its per-100 g values:
 * `dried` (dried herbs are several times denser than fresh), `ground` (`ground beef` is not
 * `beef`; `ground almonds` is not `almonds`), `raw` and `cooked` (dry pasta is roughly three
 * times the calories of cooked, per 100 g), `whole`, `smoked`, `canned`, `frozen`, and every
 * colour word.
 */
export const PREPARATION_WORDS: ReadonlySet<string> = new Set([
  'and',
  'or',
  'a',
  'an',
  'the',
  'fresh',
  'freshly',
  'finely',
  'roughly',
  'coarsely',
  'thinly',
  'thickly',
  'chopped',
  'minced',
  'diced',
  'sliced',
  'grated',
  'shredded',
  'crushed',
  'peeled',
  'trimmed',
  'cubed',
  'halved',
  'quartered',
  'beaten',
  'washed',
  'rinsed',
  'drained',
  'torn',
  'cut',
  'of',
]);

/**
 * Genuine renamings, keyed by the normalised phrase as it arrives and valued by the canonical
 * name. Looked up both before and after singularisation, so plural and singular spellings can
 * both be written naturally.
 *
 * An alias resolving to a canonical name with no `INGREDIENT_BINDINGS` entry is not a defect:
 * `challots` correctly canonicalises to `shallots`, and the resolver then reports that
 * shallots has no dataset row. That is a different, more useful answer than "unknown word".
 */
export const INGREDIENT_ALIASES: ReadonlyMap<string, string> = new Map([
  // British to US spellings.
  ['aubergine', 'eggplant'],
  ['aubergines', 'eggplant'],
  ['courgette', 'zucchini'],
  ['courgettes', 'zucchini'],
  ['coriander', 'cilantro'],
  ['coriander leaves', 'cilantro'],
  ['rocket', 'arugula'],
  ['rocket leaves', 'arugula'],
  ['prawn', 'shrimp'],
  ['prawns', 'shrimp'],
  ['king prawns', 'shrimp'],
  ['spring onion', 'spring onions'],
  ['scallion', 'spring onions'],
  ['scallions', 'spring onions'],
  ['green onion', 'spring onions'],
  ['green onions', 'spring onions'],
  ['plain flour', 'all purpose flour'],
  ['white flour', 'all purpose flour'],
  ['caster sugar', 'granulated sugar'],
  ['white sugar', 'granulated sugar'],
  ['double cream', 'heavy cream'],
  ['minced beef', 'ground beef'],
  ['beef mince', 'ground beef'],
  ['natural yogurt', 'plain yogurt'],
  ['natural yoghurt', 'plain yogurt'],
  ['yoghurt', 'plain yogurt'],
  ['tomato puree', 'tomato paste'],
  ['tomato pure', 'tomato paste'],
  ['cornflour', 'cornstarch'],
  ['corn flour', 'cornstarch'],
  ['bicarbonate of soda', 'baking soda'],
  ['sultanas', 'raisins'],
  ['cos lettuce', 'romaine lettuce'],
  ['chick peas', 'chickpeas'],
  ['garbanzo beans', 'chickpeas'],
  ['vegetable oil', 'soybean oil'],
  ['sunflower oil', 'soybean oil'],

  // Spellings TheMealDB actually publishes, including its own misspellings.
  ['challots', 'shallots'],
  ['challot', 'shallots'],
  ['shallot', 'shallots'],
  ['parmesan cheese', 'parmesan'],
  ['cheddar cheese', 'cheddar'],
  ['mozzarella cheese', 'mozzarella'],
  ['olive oil', 'olive oil'],
  ['extra virgin olive oil', 'olive oil'],
  ['black pepper', 'black pepper'],
  ['pepper', 'black pepper'],
  ['sea salt', 'salt'],
  ['table salt', 'salt'],
  ['eggs', 'egg'],
  ['free range eggs', 'egg'],
  ['spring water', 'water'],
  // Expanded at T-07-07 for the live catalog vocabulary.
  ['flour', 'all purpose flour'],
  ['self-raising flour', 'self raising flour'],
  ['sugar', 'granulated sugar'],
  ['dark soft brown sugar', 'brown sugar'],
  ['coco sugar', 'brown sugar'],
  ['bread', 'white bread'],
  ['wholegrain bread', 'white bread'],
  ['milk', 'whole milk'],
  ['semi-skimmed milk', 'whole milk'],
  ['clotted cream', 'heavy cream'],
  ['cream', 'heavy cream'],
  ['creme fraiche', 'sour cream'],
  ['fromage frais', 'sour cream'],
  ['shredded monterey jack cheese', 'monterey jack cheese'],
  ['colby jack cheese', 'monterey jack cheese'],
  ['cheese', 'cheddar'],
  ['stilton cheese', 'cheddar'],
  ['cubed feta cheese', 'feta'],
  ['sausages', 'pork sausage'],
  ['sausage', 'pork sausage'],
  ['black pudding', 'blood sausage'],
  ['prosciutto', 'cured ham'],
  ['parma ham', 'cured ham'],
  ['chicken breasts', 'chicken breast'],
  ['chicken thighs', 'chicken breast'],
  ['chicken', 'chicken breast'],
  ['raw king prawns', 'shrimp'],
  ['potatoes', 'potato'],
  ['floury potatoes', 'potato'],
  ['charlotte potatoes', 'potato'],
  ['small potatoes', 'potato'],
  ['red onions', 'red onion'],
  ['tomatoes', 'tomato'],
  ['plum tomatoes', 'tomato'],
  ['cherry tomatoes', 'tomato'],
  ['baby plum tomatoes', 'tomato'],
  ['canned tomatoes', 'tomato'],
  ['chopped tomatoes', 'tomato'],
  ['diced tomatoes', 'tomato'],
  ['passata', 'tomato puree'],
  ['carrots', 'carrot'],
  ['green beans', 'green bean'],
  ['green chilli', 'serrano pepper'],
  ['red chilli', 'red chili pepper'],
  ['red chilli flakes', 'cayenne pepper'],
  ['chilli powder', 'chili powder'],
  ['red chilli powder', 'chili powder'],
  ['cayenne pepper', 'cayenne pepper'],
  ['stir-fry vegetables', 'mixed vegetables'],
  ['frozen peas', 'mixed vegetables'],
  ['rapeseed oil', 'canola oil'],
  ['oil', 'canola oil'],
  ['white vinegar', 'distilled vinegar'],
  ['white wine vinegar', 'distilled vinegar'],
  ['red wine vinegar', 'distilled vinegar'],
  ['apple cider vinegar', 'cider vinegar'],
  ['dry white wine', 'white wine'],
  ['plain chocolate', 'dark chocolate'],
  ['chocolate chips', 'dark chocolate'],
  ['white chocolate chips', 'dark chocolate'],
  ['cacao', 'dark chocolate'],
  ['vegetable stock', 'vegetable broth'],
  ['vegetable stock cube', 'vegetable broth'],
  ['beef stock', 'vegetable broth'],
  ['chicken stock', 'chicken broth'],
  ['chicken stock cube', 'chicken broth'],
  ['corn tortillas', 'corn tortilla'],
  ['flour tortilla', 'corn tortilla'],
  ['english muffins', 'english muffin'],
  ['yeast', 'active dry yeast'],
  ['basmati rice', 'white rice'],
  ['paella rice', 'white rice'],
  ['penne rigate', 'pasta'],
  ['fettuccine', 'pasta'],
  ['farfalle', 'pasta'],
  ['bowtie pasta', 'pasta'],
  ['lasagne sheets', 'pasta'],
  ['spaghetti', 'pasta'],
  ['linguine pasta', 'pasta'],
  ['macaroni', 'pasta'],
  ['paccheri pasta', 'pasta'],
  ['cumin seeds', 'cumin seed'],
  ['mustard seeds', 'mustard seed'],
  ['ginger', 'ground ginger'],
  ['thyme', 'dried thyme'],
  ['fresh thyme', 'dried thyme'],
  ['dried oregano', 'dried oregano'],
  ['oregano', 'dried oregano'],
  ['parmigiano-reggiano', 'parmesan cheese'],
  ['leeks', 'leek'],
  ['sesame seeds', 'sesame seed'],
  ['garlic clove', 'garlic'],
  ['garlic cloves', 'garlic'],
  ['minced garlic', 'garlic'],
  ['egg plants', 'eggplant'],
  ['egg plant', 'eggplant'],
  ['baby aubergine', 'eggplant'],
  ['basil leaves', 'basil'],
  ['fresh basil', 'basil'],
  ['brown lentils', 'lentils'],
  ['green red lentils', 'lentils'],
  ['toor dal', 'lentils'],
  ['rice stick noodles', 'rice noodles'],
  ['italian seasoning', 'dried oregano'],
  ['mixed herbs', 'dried oregano'],
  ['harissa spice', 'chili powder'],
  ['cajun', 'chili powder'],
  ['smoked paprika', 'chili powder'],
  ['paprika', 'chili powder'],
  ['ground cumin', 'cumin seed'],
  ['coriander seeds', 'cumin seed'],
  ['miniature marshmallows', 'granulated sugar'],
  ['golden syrup', 'maple syrup'],
  ['condensed milk', 'whole milk'],
  ['almond milk', 'whole milk'],
  ['soya milk', 'whole milk'],
  ['cannellini beans', 'chickpeas'],
  ['butter beans', 'chickpeas'],
]);

export interface IngredientBinding {
  /** The USDA `ingredient code` this canonical name is bound to. */
  readonly usdaCode: string;
  /** That code's verbatim description, re-verified against the dataset at build time. */
  readonly usdaDescription: string;
  /** Authored density and countable gram weights. Absent data refuses the measure. */
  readonly measure?: IngredientMeasureData;
}

/** One egg, Grade A Large, as USDA grades it. Used for both the bare count and `egg`. */
const LARGE_EGG_GRAMS = 50;

/**
 * Typed before construction rather than inferred. Without the annotation, `new Map([...])`
 * infers a union of all forty-odd literal entry shapes, and a `gramsPerUnit` object that
 * happens to omit a key another entry has acquires that key as `undefined`, which then does
 * not satisfy `Record<string, number>`.
 */
const BINDING_ENTRIES: readonly (readonly [string, IngredientBinding])[] = [
  [
    'butter',
    {
      usdaCode: '1001',
      usdaDescription: 'Butter, stick, salted',
      measure: { gramsPerMillilitre: 0.96, gramsPerUnit: { stick: 113, knob: 15, pat: 5 } },
    },
  ],
  [
    'unsalted butter',
    {
      usdaCode: '1145',
      usdaDescription: 'Butter, stick, unsalted',
      measure: { gramsPerMillilitre: 0.96 },
    },
  ],
  [
    'olive oil',
    {
      usdaCode: '4063',
      usdaDescription: 'Oil, olive, extra virgin',
      measure: { gramsPerMillilitre: 0.918 },
    },
  ],
  [
    'soybean oil',
    { usdaCode: '4044', usdaDescription: 'Oil, soybean', measure: { gramsPerMillilitre: 0.92 } },
  ],
  [
    'onion',
    {
      usdaCode: '11282',
      usdaDescription: 'Onions, raw',
      measure: { gramsPerUnit: { item: 110, medium: 110, large: 150, small: 70 } },
    },
  ],
  [
    'spring onions',
    {
      usdaCode: '11291',
      usdaDescription: 'Onions, spring or scallions (includes tops and bulb), raw',
      measure: { gramsPerUnit: { item: 15 } },
    },
  ],
  [
    'garlic',
    {
      usdaCode: '11215',
      usdaDescription: 'Garlic, raw',
      measure: { gramsPerUnit: { clove: 3, bulb: 34 } },
    },
  ],
  [
    'salt',
    {
      usdaCode: '2047',
      usdaDescription: 'Salt, table, iodized',
      measure: { gramsPerMillilitre: 1.22 },
    },
  ],
  [
    'egg',
    {
      usdaCode: '1123',
      usdaDescription: 'Eggs, Grade A, Large, egg whole',
      measure: {
        gramsPerUnit: {
          item: LARGE_EGG_GRAMS,
          egg: LARGE_EGG_GRAMS,
          large: LARGE_EGG_GRAMS,
          medium: 44,
          small: 38,
        },
      },
    },
  ],
  [
    'milk',
    {
      usdaCode: '1077',
      usdaDescription: 'Milk, whole, 3.25% milkfat, with added vitamin D',
      measure: { gramsPerMillilitre: 1.03 },
    },
  ],
  [
    'all purpose flour',
    {
      usdaCode: '20081',
      usdaDescription: 'Flour, wheat, all-purpose, enriched, bleached',
      measure: { gramsPerMillilitre: 0.53 },
    },
  ],
  [
    'granulated sugar',
    {
      usdaCode: '19335',
      usdaDescription: 'Sugars, granulated',
      measure: { gramsPerMillilitre: 0.845 },
    },
  ],
  [
    'tomato',
    {
      usdaCode: '11529',
      usdaDescription: 'Tomatoes, red, ripe, raw, year round average',
      measure: {
        gramsPerUnit: { item: 123, medium: 123, large: 182, small: 91, tin: 400, can: 400 },
      },
    },
  ],
  [
    'tomato paste',
    {
      usdaCode: '11546',
      usdaDescription:
        "Tomato products, canned, paste, without salt added (Includes foods for USDA's Food Distribution Program)",
      measure: { gramsPerMillilitre: 1.07 },
    },
  ],
  [
    'chicken breast',
    {
      usdaCode: '5062',
      usdaDescription: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw',
      measure: { gramsPerUnit: { item: 174, breast: 174, fillet: 174 } },
    },
  ],
  [
    'ground beef',
    { usdaCode: '23572', usdaDescription: 'Beef, ground, 80% lean meat / 20% fat, raw' },
  ],
  [
    'rice',
    {
      usdaCode: '20044',
      usdaDescription: 'Rice, white, long-grain, regular, raw, enriched',
      measure: { gramsPerMillilitre: 0.78 },
    },
  ],
  [
    'black pepper',
    {
      usdaCode: '2030',
      usdaDescription: 'Spices, pepper, black',
      measure: { gramsPerMillilitre: 0.47 },
    },
  ],
  [
    'potato',
    {
      usdaCode: '11352',
      usdaDescription: 'Potatoes, flesh and skin, raw',
      measure: { gramsPerUnit: { item: 173, medium: 173, large: 299, small: 92 } },
    },
  ],
  [
    'carrot',
    {
      usdaCode: '11124',
      usdaDescription: 'Carrots, raw',
      measure: { gramsPerUnit: { item: 61, medium: 61, large: 72 } },
    },
  ],
  [
    'cheddar',
    {
      usdaCode: '1009',
      usdaDescription: 'Cheese, cheddar',
      measure: { gramsPerUnit: { slice: 28 } },
    },
  ],
  [
    'mozzarella',
    { usdaCode: '1029', usdaDescription: 'Cheese, mozzarella, low moisture, part-skim' },
  ],
  [
    'parmesan',
    {
      usdaCode: '1032',
      usdaDescription: 'Cheese, parmesan, grated',
      measure: { gramsPerMillilitre: 0.38 },
    },
  ],
  [
    'water',
    {
      usdaCode: '14555',
      usdaDescription: 'Water, bottled, generic',
      measure: { gramsPerMillilitre: 1 },
    },
  ],
  [
    'parsley',
    {
      usdaCode: '11297',
      usdaDescription: 'Parsley, fresh',
      measure: { gramsPerUnit: { sprig: 1, bunch: 60 } },
    },
  ],
  [
    'basil',
    {
      usdaCode: '2044',
      usdaDescription: 'Basil, fresh',
      measure: { gramsPerUnit: { leaf: 0.5, bunch: 20 } },
    },
  ],
  [
    'eggplant',
    {
      usdaCode: '11209',
      usdaDescription: 'Eggplant, raw',
      measure: { gramsPerUnit: { item: 458 } },
    },
  ],
  [
    'zucchini',
    {
      usdaCode: '11477',
      usdaDescription: 'Squash, summer, zucchini, includes skin, raw',
      measure: { gramsPerUnit: { item: 196 } },
    },
  ],
  [
    'cilantro',
    {
      usdaCode: '11165',
      usdaDescription: 'Coriander (cilantro) leaves, raw',
      measure: { gramsPerUnit: { sprig: 1, bunch: 50 } },
    },
  ],
  [
    'shrimp',
    {
      usdaCode: '15149',
      usdaDescription:
        'Crustaceans, shrimp, mixed species, raw (may contain additives to retain moisture)',
      measure: { gramsPerUnit: { item: 15 } },
    },
  ],
  [
    'arugula',
    {
      usdaCode: '11959',
      usdaDescription: 'Arugula, raw',
      measure: { gramsPerMillilitre: 0.09, gramsPerUnit: { bunch: 25, handful: 10 } },
    },
  ],
  [
    'lemon juice',
    {
      usdaCode: '9152',
      usdaDescription: 'Lemon juice, raw',
      measure: { gramsPerMillilitre: 1.03 },
    },
  ],
  [
    'lemon',
    {
      usdaCode: '9150',
      usdaDescription: 'Lemons, raw, without peel',
      measure: { gramsPerUnit: { item: 84 } },
    },
  ],
  [
    'heavy cream',
    {
      usdaCode: '1053',
      usdaDescription: 'Cream, fluid, heavy whipping',
      measure: { gramsPerMillilitre: 0.994 },
    },
  ],
  [
    'spinach',
    {
      usdaCode: '11457',
      usdaDescription: 'Spinach, mature',
      measure: { gramsPerMillilitre: 0.09, gramsPerUnit: { bunch: 340, handful: 30 } },
    },
  ],
  [
    'cashews',
    { usdaCode: '12085', usdaDescription: 'Nuts, cashew nuts, dry roasted, without salt added' },
  ],
  [
    'red pepper',
    {
      usdaCode: '11821',
      usdaDescription: 'Peppers, sweet, red, raw',
      measure: { gramsPerUnit: { item: 119, medium: 119 } },
    },
  ],
  [
    'mushroom',
    {
      usdaCode: '11260',
      usdaDescription: 'Mushrooms, white button',
      measure: { gramsPerUnit: { item: 18 } },
    },
  ],
  ['honey', { usdaCode: '19296', usdaDescription: 'Honey', measure: { gramsPerMillilitre: 1.42 } }],
  [
    'vinegar',
    { usdaCode: '2048', usdaDescription: 'Vinegar, cider', measure: { gramsPerMillilitre: 1.01 } },
  ],
  [
    'soy sauce',
    {
      usdaCode: '16123',
      usdaDescription: 'Soy sauce made from soy and wheat (shoyu)',
      measure: { gramsPerMillilitre: 1.11 },
    },
  ],
  [
    'cumin',
    {
      usdaCode: '2014',
      usdaDescription: 'Spices, cumin seed',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'cinnamon',
    {
      usdaCode: '2010',
      usdaDescription: 'Spices, cinnamon, ground',
      measure: { gramsPerMillilitre: 0.53 },
    },
  ],
  [
    'paprika',
    { usdaCode: '2028', usdaDescription: 'Spices, paprika', measure: { gramsPerMillilitre: 0.46 } },
  ],
  [
    'pasta',
    {
      usdaCode: '20120',
      usdaDescription: 'Pasta, dry, enriched',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'plain yogurt',
    {
      usdaCode: '1116',
      usdaDescription: 'Yogurt, plain, whole milk',
      measure: { gramsPerMillilitre: 1.03 },
    },
  ],
  [
    'green beans',
    {
      usdaCode: '11052',
      usdaDescription: 'Beans, snap, green, raw',
      measure: { gramsPerMillilitre: 0.42 },
    },
  ],
  [
    'bread',
    {
      usdaCode: '18029',
      usdaDescription: 'Bread, french or vienna (includes sourdough)',
      measure: { gramsPerUnit: { slice: 25 } },
    },
  ],
  [
    'cornstarch',
    { usdaCode: '20027', usdaDescription: 'Cornstarch', measure: { gramsPerMillilitre: 0.53 } },
  ],
  [
    'baking soda',
    {
      usdaCode: '18372',
      usdaDescription: 'Leavening agents, baking soda',
      measure: { gramsPerMillilitre: 0.92 },
    },
  ],
  [
    'raisins',
    {
      usdaCode: '9298',
      usdaDescription:
        "Raisins, dark, seedless (Includes foods for USDA's Food Distribution Program)",
      measure: { gramsPerMillilitre: 0.62 },
    },
  ],
  [
    'romaine lettuce',
    {
      usdaCode: '11251',
      usdaDescription: 'Lettuce, cos or romaine, raw',
      measure: { gramsPerMillilitre: 0.2, gramsPerUnit: { head: 300, item: 300 } },
    },
  ],
  [
    'chickpeas',
    {
      usdaCode: '16056',
      usdaDescription: 'Chickpeas (garbanzo beans, bengal gram), mature seeds, raw',
      measure: { gramsPerMillilitre: 0.8, gramsPerUnit: { can: 400, tin: 400 } },
    },
  ],
  [
    'salmon',
    {
      usdaCode: '15236',
      usdaDescription: 'Fish, salmon, Atlantic, farmed, raw',
      measure: { gramsPerUnit: { fillet: 198 } },
    },
  ],
  // ---------------------------------------------------------------------------------
  // Expanded at T-07-07 to cover the live 60-meal catalog. Every code was read from the
  // real archive this session and every description is verbatim, so a mistyped code
  // fails the build-time re-verification rather than quietly repointing an ingredient.
  // Densities and countable weights remain AUTHORED conventional figures (R-03).
  [
    'self raising flour',
    {
      usdaCode: '100256',
      usdaDescription: 'Flour, pastry, unenriched, unbleached',
      measure: { gramsPerMillilitre: 0.53 },
    },
  ],
  [
    'brown sugar',
    {
      usdaCode: '19334',
      usdaDescription: 'Sugars, brown',
      measure: { gramsPerMillilitre: 0.93 },
    },
  ],
  [
    'white bread',
    {
      usdaCode: '18069',
      usdaDescription: 'Bread, white, commercially prepared',
      measure: { gramsPerUnit: { slice: 30, item: 30 } },
    },
  ],
  [
    'white rice',
    {
      usdaCode: '20044',
      usdaDescription: 'Rice, white, long-grain, regular, raw, enriched',
      measure: { gramsPerMillilitre: 0.85 },
    },
  ],
  [
    'brown rice',
    {
      usdaCode: '20036',
      usdaDescription:
        "Rice, brown, long-grain, raw (Includes foods for USDA's Food Distribution Program)",
      measure: { gramsPerMillilitre: 0.85 },
    },
  ],
  [
    'whole milk',
    {
      usdaCode: '1077',
      usdaDescription: 'Milk, whole, 3.25% milkfat, with added vitamin D',
      measure: { gramsPerMillilitre: 1.03 },
    },
  ],
  [
    'light cream',
    {
      usdaCode: '1050',
      usdaDescription: 'Cream, fluid, light (coffee cream or table cream)',
      measure: { gramsPerMillilitre: 1 },
    },
  ],
  [
    'half and half',
    {
      usdaCode: '1049',
      usdaDescription: 'Cream, fluid, half and half',
      measure: { gramsPerMillilitre: 1 },
    },
  ],
  [
    'sour cream',
    {
      usdaCode: '1056',
      usdaDescription: 'Cream, sour, cultured',
      measure: { gramsPerMillilitre: 1, gramsPerUnit: { pot: 200, tub: 200 } },
    },
  ],
  [
    'cream cheese',
    {
      usdaCode: '1017',
      usdaDescription: 'Cheese, cream',
      measure: { gramsPerMillilitre: 1 },
    },
  ],
  [
    'ricotta',
    {
      usdaCode: '1036',
      usdaDescription: 'Cheese, ricotta, whole milk',
      measure: { gramsPerMillilitre: 1 },
    },
  ],
  [
    'monterey jack cheese',
    {
      usdaCode: '1025',
      usdaDescription: 'Cheese, monterey',
      measure: { gramsPerMillilitre: 0.4, gramsPerUnit: { slice: 28 } },
    },
  ],
  [
    'brie',
    {
      usdaCode: '1006',
      usdaDescription: 'Cheese, brie',
      measure: { gramsPerUnit: { slice: 28 } },
    },
  ],
  [
    'gruyere',
    {
      usdaCode: '1023',
      usdaDescription: 'Cheese, gruyere',
      measure: { gramsPerMillilitre: 0.4 },
    },
  ],
  [
    'feta',
    {
      usdaCode: '1019',
      usdaDescription: 'Cheese, feta',
      measure: { gramsPerUnit: { pack: 200, block: 200 } },
    },
  ],
  [
    'greek yogurt',
    {
      usdaCode: '1256',
      usdaDescription: 'Yogurt, Greek, plain, nonfat',
      measure: { gramsPerMillilitre: 1.03 },
    },
  ],
  [
    'bacon',
    {
      usdaCode: '10123',
      usdaDescription: 'Pork, cured, bacon, unprepared',
      measure: { gramsPerUnit: { item: 25, slice: 25, strip: 25, rasher: 25 } },
    },
  ],
  [
    'pork sausage',
    {
      usdaCode: '7064',
      usdaDescription: 'Pork sausage, link/patty, cooked, pan-fried',
      measure: { gramsPerUnit: { item: 45, link: 45, patty: 45 } },
    },
  ],
  [
    'blood sausage',
    {
      usdaCode: '7005',
      usdaDescription: 'Blood sausage',
      measure: { gramsPerUnit: { slice: 25, item: 25 } },
    },
  ],
  [
    'cured ham',
    {
      usdaCode: '10153',
      usdaDescription: 'Pork, cured, ham, whole, separable lean only, roasted',
      measure: { gramsPerUnit: { slice: 15, item: 15 } },
    },
  ],
  [
    'smoked salmon',
    {
      usdaCode: '15077',
      usdaDescription: 'Fish, salmon, chinook, smoked',
      measure: { gramsPerUnit: { slice: 20, item: 20 } },
    },
  ],
  [
    'smoked haddock',
    {
      usdaCode: '15035',
      usdaDescription: 'Fish, haddock, smoked',
      measure: { gramsPerUnit: { fillet: 150 } },
    },
  ],
  [
    'red onion',
    {
      usdaCode: '100252',
      usdaDescription: 'Onions, red, raw',
      measure: { gramsPerUnit: { item: 110, medium: 110, large: 150, small: 70 } },
    },
  ],
  [
    'celery',
    {
      usdaCode: '11143',
      usdaDescription: 'Celery, raw',
      measure: { gramsPerUnit: { item: 40, stalk: 40, stick: 40, small: 30 } },
    },
  ],
  [
    'fennel',
    {
      usdaCode: '11957',
      usdaDescription: 'Fennel, bulb, raw',
      measure: { gramsPerUnit: { item: 234, bulb: 234, small: 150, medium: 234, large: 300 } },
    },
  ],
  [
    'broccoli',
    {
      usdaCode: '11090',
      usdaDescription: 'Broccoli, raw',
      measure: { gramsPerUnit: { item: 500, head: 500, floret: 15 } },
    },
  ],
  [
    'kale',
    {
      usdaCode: '11233',
      usdaDescription: 'Kale, raw',
      measure: { gramsPerMillilitre: 0.27 },
    },
  ],
  [
    'green bean',
    {
      usdaCode: '11052',
      usdaDescription: 'Beans, snap, green, raw',
      measure: { gramsPerMillilitre: 0.42 },
    },
  ],
  [
    'serrano pepper',
    {
      usdaCode: '11977',
      usdaDescription: 'Peppers, serrano, raw',
      measure: { gramsPerUnit: { item: 15 } },
    },
  ],
  [
    'red chili pepper',
    {
      usdaCode: '11819',
      usdaDescription: 'Peppers, hot chili, red, raw',
      measure: { gramsPerUnit: { item: 45, large: 60, small: 25 } },
    },
  ],
  [
    'mixed vegetables',
    {
      usdaCode: '11584',
      usdaDescription: 'Vegetables, mixed, frozen, cooked, boiled, drained, without salt',
      measure: { gramsPerMillilitre: 0.6 },
    },
  ],
  [
    'canola oil',
    {
      usdaCode: '4582',
      usdaDescription: 'Oil, canola',
      measure: { gramsPerMillilitre: 0.92 },
    },
  ],
  [
    'cider vinegar',
    {
      usdaCode: '2048',
      usdaDescription: 'Vinegar, cider',
      measure: { gramsPerMillilitre: 1.01 },
    },
  ],
  [
    'distilled vinegar',
    {
      usdaCode: '2053',
      usdaDescription: 'Vinegar, distilled',
      measure: { gramsPerMillilitre: 1.01 },
    },
  ],
  [
    'white wine',
    {
      usdaCode: '14106',
      usdaDescription: 'Alcoholic beverage, wine, table, white',
      measure: { gramsPerMillilitre: 0.99 },
    },
  ],
  [
    'sake',
    {
      usdaCode: '43479',
      usdaDescription: 'Alcoholic beverage, rice (sake)',
      measure: { gramsPerMillilitre: 0.99 },
    },
  ],
  [
    'sesame seed',
    {
      usdaCode: '12201',
      usdaDescription: 'Seeds, sesame seed kernels, dried (decorticated)',
      measure: { gramsPerMillilitre: 0.6 },
    },
  ],
  [
    'dark chocolate',
    {
      usdaCode: '19905',
      usdaDescription:
        'Candies, chocolate, dark, NFS (45-59% cacao solids 90%; 60-69% cacao solids 5%; 70-85% cacao solids 5%)',
      measure: { gramsPerMillilitre: 0.7 },
    },
  ],
  [
    'vegetable broth',
    {
      usdaCode: '6700',
      usdaDescription: 'Soup, vegetable broth, ready to serve',
      measure: { gramsPerMillilitre: 1, gramsPerUnit: { cube: 4 } },
    },
  ],
  [
    'chicken broth',
    {
      usdaCode: '6172',
      usdaDescription: 'Soup, stock, chicken, home-prepared',
      measure: { gramsPerMillilitre: 1, gramsPerUnit: { cube: 4 } },
    },
  ],
  [
    'enchilada sauce',
    {
      usdaCode: '27063',
      usdaDescription: 'Sauce, enchilada, red, mild, ready to serve',
      measure: { gramsPerMillilitre: 1.03, gramsPerUnit: { jar: 400 } },
    },
  ],
  [
    'corn tortilla',
    {
      usdaCode: '18363',
      usdaDescription: 'Tortillas, ready-to-bake or -fry, corn',
      measure: { gramsPerUnit: { item: 26 } },
    },
  ],
  [
    'english muffin',
    {
      usdaCode: '18264',
      usdaDescription: 'Muffins, English, wheat',
      measure: { gramsPerUnit: { item: 57 } },
    },
  ],
  [
    'baked beans',
    {
      usdaCode: '16006',
      usdaDescription: 'Beans, baked, canned, plain or vegetarian',
      measure: { gramsPerMillilitre: 1.05, gramsPerUnit: { can: 400, tin: 400 } },
    },
  ],
  [
    'puff pastry',
    {
      usdaCode: '18211',
      usdaDescription: 'Puff pastry, frozen, ready-to-bake, baked',
      measure: { gramsPerUnit: { sheet: 250, item: 250 } },
    },
  ],
  [
    'active dry yeast',
    {
      usdaCode: '18375',
      usdaDescription: "Leavening agents, yeast, baker's, active dry",
      measure: { gramsPerMillilitre: 0.68 },
    },
  ],
  [
    'maple syrup',
    {
      usdaCode: '19360',
      usdaDescription: 'Syrups, table blends, pancake, with 2% maple',
      measure: { gramsPerMillilitre: 1.33 },
    },
  ],
  [
    'cayenne pepper',
    {
      usdaCode: '2031',
      usdaDescription: 'Spices, pepper, red or cayenne',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'chili powder',
    {
      usdaCode: '2009',
      usdaDescription: 'Spices, chili powder',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'cumin seed',
    {
      usdaCode: '2014',
      usdaDescription: 'Spices, cumin seed',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'mustard seed',
    {
      usdaCode: '2024',
      usdaDescription: 'Spices, mustard seed, ground',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'dried oregano',
    {
      usdaCode: '2027',
      usdaDescription: 'Spices, oregano, dried',
      measure: { gramsPerMillilitre: 0.15 },
    },
  ],
  [
    'dried thyme',
    {
      usdaCode: '2042',
      usdaDescription: 'Spices, thyme, dried',
      measure: { gramsPerMillilitre: 0.15 },
    },
  ],
  [
    'turmeric',
    {
      usdaCode: '2043',
      usdaDescription: 'Spices, turmeric, ground',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'nutmeg',
    {
      usdaCode: '2025',
      usdaDescription: 'Spices, nutmeg, ground',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'ground ginger',
    {
      usdaCode: '2021',
      usdaDescription: 'Spices, ginger, ground',
      measure: { gramsPerMillilitre: 0.45 },
    },
  ],
  [
    'vanilla extract',
    {
      usdaCode: '2052',
      usdaDescription: 'Vanilla extract, imitation, no alcohol',
      measure: { gramsPerMillilitre: 0.88 },
    },
  ],
  [
    'pine nuts',
    {
      usdaCode: '12147',
      usdaDescription: 'Nuts, pine nuts, dried',
      measure: { gramsPerMillilitre: 0.55 },
    },
  ],
  [
    'tomato puree',
    {
      usdaCode: '11888',
      usdaDescription: 'Tomato products, canned, puree, with salt added',
      measure: { gramsPerMillilitre: 1.05 },
    },
  ],
  [
    'leek',
    {
      usdaCode: '11246',
      usdaDescription: 'Leeks, (bulb and lower leaf-portion), raw',
      measure: { gramsPerUnit: { item: 89, medium: 89, large: 120, small: 60 } },
    },
  ],
  [
    'baking powder',
    {
      usdaCode: '18369',
      usdaDescription: 'Leavening agents, baking powder, double-acting, sodium aluminum sulfate',
      measure: { gramsPerMillilitre: 0.9 },
    },
  ],
  [
    'lentils',
    {
      usdaCode: '16069',
      usdaDescription: 'Lentils, raw',
      measure: { gramsPerMillilitre: 0.85 },
    },
  ],
  [
    'basil',
    {
      usdaCode: '2003',
      usdaDescription: 'Spices, basil, dried',
      measure: { gramsPerMillilitre: 0.12, gramsPerUnit: { bunch: 25, handful: 10, leaf: 0.5 } },
    },
  ],
  [
    'clams',
    {
      usdaCode: '15157',
      usdaDescription: 'Mollusks, clam, mixed species, raw',
      measure: { gramsPerUnit: { item: 10 } },
    },
  ],
  [
    'rice noodles',
    {
      usdaCode: '20134',
      usdaDescription: 'Rice noodles, cooked',
      measure: { gramsPerMillilitre: 0.4 },
    },
  ],
];

export const INGREDIENT_BINDINGS: ReadonlyMap<string, IngredientBinding> = new Map(BINDING_ENTRIES);
