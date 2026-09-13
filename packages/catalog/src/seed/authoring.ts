/**
 * The authored half of the catalog (TSD 7.2 steps 4 and 5).
 *
 * Everything in this file is a human decision, which is exactly why it is a flat table and not
 * an algorithm: each row can be read, checked and argued with. Nothing here is nutrition - not
 * one macro is typed by hand anywhere in this package, because TSD 7.4 derives all four from
 * the USDA table and PRD FR-006 forbids authoring them.
 *
 * **`servings` is the most dangerous number in the project.** It divides all four macros, so an
 * error scales a meal's entire nutrition proportionally and does it silently - the figures stay
 * plausible. TheMealDB publishes no serving count, so every value here is read off the recipe
 * by a person, and `nutritionProvenance.servings` records it as authored rather than sourced.
 *
 * `allergenAdditions` is the T-07-04 hand review. Inference from the ingredient list is the
 * starting point; these are the cases where a person found it wrong. Every entry carries the
 * reason, because a safety tag without a justification is impossible to re-review later.
 */

import type { MealPeriod } from '@nutritime/contracts';

/**
 * The most specific diet tag the dish carries.
 *
 * One tag, not a list: TSD 4.5's table already makes `vegan` satisfy a vegetarian and a
 * halal-preference user, so listing the weaker tags alongside it would be redundant data that
 * can fall out of step with the policy. `gluten-aware` is NOT authored here - it is derived in
 * `seed.ts` from the reviewed allergen tags, so it can never contradict them.
 */
export type AuthoredDiet = 'regular' | 'vegetarian' | 'vegan';

export interface AuthoredMeal {
  readonly description: string;
  readonly diet: AuthoredDiet;
  readonly mealPeriods: readonly MealPeriod[];
  readonly priceCents: number;
  readonly preparationMinutes: number;
  readonly servings: number;
  /** Added by the hand review, each with the reason it was missed. */
  readonly allergenAdditions?: readonly string[];
  readonly reviewNote?: string;
}

export const AUTHORED_MEALS: Readonly<Record<string, AuthoredMeal>> = {
  // ------------------------------------------------------------------ breakfast
  'english-breakfast': {
    description: 'The classic fry-up: sausages, bacon, black pudding and eggs with fried bread.',
    diet: 'regular',
    mealPeriods: ['breakfast'],
    priceCents: 950,
    preparationMinutes: 30,
    servings: 2,
  },
  'full-english-breakfast': {
    description: 'A full fry-up, with baked beans alongside the sausages, bacon and eggs.',
    diet: 'regular',
    mealPeriods: ['breakfast'],
    priceCents: 1050,
    preparationMinutes: 35,
    servings: 2,
  },
  'fruit-and-cream-cheese-breakfast-pastries': {
    description: 'Puff pastry squares with sweetened cream cheese and fresh berries.',
    diet: 'vegetarian',
    mealPeriods: ['breakfast', 'snack'],
    priceCents: 650,
    preparationMinutes: 40,
    servings: 8,
  },
  'salmon-eggs-eggs-benedict': {
    description: 'Poached eggs and smoked salmon on toasted muffins under hollandaise.',
    diet: 'regular',
    mealPeriods: ['breakfast'],
    priceCents: 1250,
    preparationMinutes: 30,
    servings: 2,
  },
  'smoked-haddock-kedgeree': {
    description: 'Spiced basmati rice with flaked smoked haddock and boiled egg.',
    diet: 'regular',
    mealPeriods: ['breakfast', 'lunch'],
    priceCents: 1150,
    preparationMinutes: 45,
    servings: 4,
  },
  'breakfast-potatoes': {
    description: 'Crisp roast potatoes with bacon, garlic and a little maple syrup.',
    diet: 'regular',
    mealPeriods: ['breakfast'],
    priceCents: 550,
    preparationMinutes: 40,
    servings: 4,
  },
  'home-made-mandazi': {
    description: 'Lightly sweet East African fried dough, eaten warm.',
    diet: 'vegetarian',
    mealPeriods: ['breakfast', 'snack'],
    priceCents: 400,
    preparationMinutes: 45,
    servings: 8,
  },

  // ----------------------------------------------------------------- vegetarian
  'spicy-arrabiata-penne': {
    description: 'Penne in a chilli-hot tomato sauce finished with Parmigiano-Reggiano.',
    diet: 'vegetarian',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 750,
    preparationMinutes: 25,
    servings: 4,
  },
  'smoky-lentil-chili-with-squash': {
    description: 'A smoky lentil and squash chilli with cashews and a little cocoa.',
    diet: 'vegan',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 850,
    preparationMinutes: 50,
    servings: 6,
  },
  'dal-fry': {
    description: 'Toor dal tempered with cumin, mustard seed and ghee.',
    diet: 'vegetarian',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 600,
    preparationMinutes: 40,
    servings: 4,
  },
  'spicy-north-african-potato-salad': {
    description: 'Warm potato salad with harissa, feta, mint and pine nuts.',
    diet: 'vegetarian',
    mealPeriods: ['lunch'],
    priceCents: 700,
    preparationMinutes: 30,
    servings: 4,
  },
  'baingan-bharta': {
    description: 'Smoked aubergine mashed with onion, tomato and green chilli.',
    diet: 'vegan',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 650,
    preparationMinutes: 45,
    servings: 4,
  },
  ribollita: {
    description: 'Tuscan bread soup with cannellini beans, kale and rosemary.',
    diet: 'vegetarian',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 700,
    preparationMinutes: 60,
    servings: 6,
  },
  'roasted-eggplant-with-tahini-pine-nuts-and-lentils': {
    description: 'Roasted aubergine over brown lentils with tahini and pine nuts.',
    diet: 'vegan',
    mealPeriods: ['dinner'],
    priceCents: 900,
    preparationMinutes: 60,
    servings: 4,
    allergenAdditions: ['sesame'],
    reviewNote:
      'The dish is named for tahini and the upstream ingredient list does not contain it. ' +
      'Inference reads ingredients only, so sesame was missing from a dish whose own title ' +
      'announces it - a false negative in the one field where that is a safety issue.',
  },
  'stovetop-eggplant-with-harissa-chickpeas-and-cumin-yogurt': {
    description: 'Aubergine and chickpeas with harissa and a cumin yoghurt.',
    diet: 'vegetarian',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 800,
    preparationMinutes: 35,
    servings: 4,
  },
  'spinach-ricotta-cannelloni': {
    description: 'Pasta tubes filled with spinach and ricotta, baked under tomato and mozzarella.',
    diet: 'vegetarian',
    mealPeriods: ['dinner'],
    priceCents: 950,
    preparationMinutes: 75,
    servings: 6,
    allergenAdditions: ['wheat'],
    reviewNote:
      'Cannelloni are wheat pasta, but the pasta appears only in the dish NAME; the ingredient ' +
      'list names "Cannellini Beans", which is one letter away and is a legume. Inference saw ' +
      'no wheat at all, so a baked pasta dish carried no gluten tag.',
  },

  // ---------------------------------------------------------------------- vegan
  'vegan-lasagna': {
    description: 'Lentil and vegetable lasagne layered with a soya bechamel.',
    diet: 'vegan',
    mealPeriods: ['dinner'],
    priceCents: 900,
    preparationMinutes: 90,
    servings: 6,
  },
  'vegan-chocolate-cake': {
    description: 'A dairy-free chocolate cake made with flax eggs and almond milk.',
    diet: 'vegan',
    mealPeriods: ['snack'],
    priceCents: 550,
    preparationMinutes: 50,
    servings: 10,
  },
  'roast-fennel-and-aubergine-paella': {
    description: 'Saffron paella rice with roast fennel, aubergine and peas.',
    diet: 'vegan',
    mealPeriods: ['dinner'],
    priceCents: 850,
    preparationMinutes: 60,
    servings: 4,
  },
  'fasoliyyeh-bi-z-zayt-syrian-green-beans-with-olive-oil': {
    description: 'Syrian green beans slow-cooked in olive oil with garlic and coriander.',
    diet: 'vegan',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 500,
    preparationMinutes: 40,
    servings: 4,
  },
  'red-onion-pickle': {
    description: 'Quick-pickled red onions with cider vinegar and bay.',
    diet: 'vegan',
    mealPeriods: ['snack'],
    priceCents: 250,
    preparationMinutes: 20,
    servings: 12,
  },

  // -------------------------------------------------------------------- chicken
  'chicken-enchilada-casserole': {
    description: 'Layered corn tortillas with chicken, enchilada sauce and Monterey Jack.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1000,
    preparationMinutes: 60,
    servings: 6,
    reviewNote:
      'Inference tags wheat from "corn tortillas", which are usually maize only. The tag is ' +
      'LEFT IN PLACE deliberately: removing it would expose a coeliac if any tortilla in the ' +
      'dish is a wheat-blend, while keeping it only hides a safe meal. The tolerable error ' +
      'runs in one direction.',
  },
  'teriyaki-chicken-casserole': {
    description: 'Chicken baked in teriyaki sauce with stir-fry vegetables and brown rice.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 950,
    preparationMinutes: 70,
    servings: 6,
  },
  'pad-see-ew': {
    description: 'Wide rice noodles stir-fried with chicken, egg and Chinese broccoli.',
    diet: 'regular',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 900,
    preparationMinutes: 25,
    servings: 4,
  },
  'potato-gratin-with-chicken': {
    description: 'Sliced potato gratin baked with chicken, bacon and Parmesan.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1100,
    preparationMinutes: 75,
    servings: 4,
  },
  'chicken-handi': {
    description: 'Chicken simmered with yoghurt, cream and garam masala.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1050,
    preparationMinutes: 50,
    servings: 4,
  },
  'chicken-alfredo-primavera': {
    description: 'Bowtie pasta with chicken, spring vegetables and a Parmesan cream.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1150,
    preparationMinutes: 40,
    servings: 4,
  },
  'tandoori-chicken': {
    description: 'Yoghurt-marinated chicken thighs with paprika, garam masala and lemon.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1000,
    preparationMinutes: 40,
    servings: 4,
  },

  // ----------------------------------------------------------------------- beef
  'spaghetti-bolognese': {
    description: 'Slow-cooked minced beef ragu with spaghetti and parmesan.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 900,
    preparationMinutes: 60,
    servings: 4,
  },
  'irish-stew': {
    description: 'Lamb chops braised with root vegetables, thyme and white wine.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1200,
    preparationMinutes: 120,
    servings: 4,
  },
  'beef-wellington': {
    description: 'Beef fillet with mushroom duxelles and Parma ham in puff pastry.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1800,
    preparationMinutes: 90,
    servings: 4,
    allergenAdditions: ['milk'],
    reviewNote:
      'Retail puff pastry is butter- or dairy-fat-based and this dish has no other dairy ' +
      'ingredient, so inference found none. Added on the false-positive side: the cost of ' +
      'being wrong is hiding a safe meal.',
  },
  'beef-brisket-pot-roast': {
    description: 'Brisket slow-roasted with carrots, potatoes and thyme.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1400,
    preparationMinutes: 240,
    servings: 6,
  },
  'beef-sunday-roast': {
    description: 'Roast beef with Yorkshire puddings, potatoes and greens.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1500,
    preparationMinutes: 120,
    servings: 6,
  },

  // -------------------------------------------------------------------- seafood
  'garides-saganaki': {
    description: 'King prawns baked with tomato, white wine and feta.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1300,
    preparationMinutes: 35,
    servings: 2,
  },
  'honey-teriyaki-salmon': {
    description: 'Salmon glazed with soy and sake, finished with sesame seed.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1250,
    preparationMinutes: 25,
    servings: 2,
  },
  'mediterranean-pasta-salad': {
    description: 'Farfalle with tuna, mozzarella, green olives and basil.',
    diet: 'regular',
    mealPeriods: ['lunch'],
    priceCents: 800,
    preparationMinutes: 20,
    servings: 4,
  },
  'fish-pie': {
    description: 'White fish and prawns under a potato crust with Gruyere.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1200,
    preparationMinutes: 75,
    servings: 4,
  },
  'recheado-masala-fish': {
    description: 'Mackerel stuffed with a tangy Goan red masala.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1100,
    preparationMinutes: 40,
    servings: 2,
  },
  'cajun-spiced-fish-tacos': {
    description: 'Cajun-spiced white fish in tortillas with avocado and sour cream.',
    diet: 'regular',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 950,
    preparationMinutes: 30,
    servings: 4,
  },
  'laksa-king-prawn-noodles': {
    description: 'Coconut laksa broth with king prawns and rice noodles.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1250,
    preparationMinutes: 30,
    servings: 2,
  },

  // ---------------------------------------------------------------------- pasta
  'grilled-mac-and-cheese-sandwich': {
    description: 'Macaroni cheese griddled between buttered bread.',
    diet: 'vegetarian',
    mealPeriods: ['lunch', 'snack'],
    priceCents: 750,
    preparationMinutes: 45,
    servings: 4,
  },
  'fettucine-alfredo': {
    description: 'Fettuccine in a clotted cream and Parmesan sauce.',
    diet: 'vegetarian',
    mealPeriods: ['dinner'],
    priceCents: 800,
    preparationMinutes: 20,
    servings: 4,
  },
  'pilchard-puttanesca': {
    description: 'Spaghetti with pilchards, black olives and red chilli.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 700,
    preparationMinutes: 25,
    servings: 2,
  },
  'venetian-duck-ragu': {
    description: 'Duck legs slow-cooked with red wine and cinnamon, over paccheri.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1400,
    preparationMinutes: 180,
    servings: 4,
  },
  'chilli-prawn-linguine': {
    description: 'Linguine with king prawns, red chilli and sugar snap peas.',
    diet: 'regular',
    mealPeriods: ['dinner'],
    priceCents: 1200,
    preparationMinutes: 25,
    servings: 2,
    allergenAdditions: ['milk'],
    reviewNote:
      'Fromage frais is a fresh dairy cheese and the allergen lexicon has no token for ' +
      '"fromage", so inference reported no milk at all. The lexicon gap is recorded as R-19; ' +
      'this tag fixes the record now rather than waiting for that change.',
  },

  // -------------------------------------------------------------------- dessert
  'bakewell-tart': {
    description: 'Almond frangipane over raspberry jam in a shortcrust case.',
    diet: 'vegetarian',
    mealPeriods: ['snack'],
    priceCents: 500,
    preparationMinutes: 75,
    servings: 8,
  },
  'apple-frangipan-tart': {
    description: 'Bramley apple and almond frangipane on a biscuit base.',
    diet: 'vegetarian',
    mealPeriods: ['snack'],
    priceCents: 500,
    preparationMinutes: 70,
    servings: 8,
  },
  'chocolate-gateau': {
    description: 'A rich plain-chocolate sponge gateau.',
    diet: 'vegetarian',
    mealPeriods: ['snack'],
    priceCents: 550,
    preparationMinutes: 60,
    servings: 10,
  },
  'rocky-road-fudge': {
    description: 'Peanut butter fudge with marshmallows and chocolate chips.',
    diet: 'regular',
    mealPeriods: ['snack'],
    priceCents: 400,
    preparationMinutes: 20,
    servings: 16,
    reviewNote:
      'NOT vegetarian: marshmallows are set with gelatin, which is animal-derived. Found by ' +
      'the P07 verification - the same review pass that checks allergens should have caught ' +
      'it, and diet tags gate what a vegetarian user is shown just as allergen tags do.',
  },
  'hot-chocolate-fudge': {
    description: 'Condensed milk fudge with white and dark chocolate.',
    diet: 'regular',
    mealPeriods: ['snack'],
    priceCents: 400,
    preparationMinutes: 25,
    servings: 16,
    reviewNote:
      'NOT vegetarian: marshmallows are set with gelatin, which is animal-derived. Found by ' +
      'the P07 verification - the same review pass that checks allergens should have caught ' +
      'it, and diet tags gate what a vegetarian user is shown just as allergen tags do.',
  },
  'christmas-pudding-flapjack': {
    description: 'Oat flapjack studded with leftover Christmas pudding.',
    diet: 'vegetarian',
    mealPeriods: ['snack'],
    priceCents: 350,
    preparationMinutes: 40,
    servings: 12,
    allergenAdditions: ['wheat'],
    reviewNote:
      'Christmas pudding is built on flour and breadcrumbs, but it reaches the ingredient list ' +
      'as the single compound word "Christmas pudding", which carries no wheat token. The ' +
      'rolled oats are a second reason a gluten-aware user should not be shown this.',
  },
  'eton-mess': {
    description: 'Crushed meringue folded through cream and strawberries.',
    diet: 'vegetarian',
    mealPeriods: ['snack'],
    priceCents: 450,
    preparationMinutes: 15,
    servings: 4,
  },

  // ----------------------------------------------------------------------- side
  'french-onion-soup': {
    description: 'Slow-caramelised onion soup under a Gruyere crouton.',
    diet: 'regular',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 700,
    preparationMinutes: 90,
    servings: 4,
    reviewNote:
      'Not tagged vegetarian: the stock is beef. The cheese and bread make it look meat-free ' +
      'at a glance, which is exactly why it is called out here.',
  },
  'brie-wrapped-in-prosciutto-brioche': {
    description: 'Whole brie wrapped in prosciutto and baked inside brioche.',
    diet: 'regular',
    mealPeriods: ['snack', 'dinner'],
    priceCents: 1300,
    preparationMinutes: 120,
    servings: 8,
  },
  'boulangere-potatoes': {
    description: 'Potatoes baked with onion and thyme in vegetable stock.',
    diet: 'vegan',
    mealPeriods: ['dinner'],
    priceCents: 400,
    preparationMinutes: 90,
    servings: 6,
  },
  'fennel-dauphinoise': {
    description: 'Potato and fennel baked in cream with Parmesan.',
    diet: 'vegetarian',
    mealPeriods: ['dinner'],
    priceCents: 600,
    preparationMinutes: 90,
    servings: 6,
  },

  // -------------------------------------------------------------------- starter
  'cream-cheese-tart': {
    description: 'A savoury cheese tart with plum tomatoes and basil.',
    diet: 'vegetarian',
    mealPeriods: ['lunch'],
    priceCents: 700,
    preparationMinutes: 60,
    servings: 6,
  },
  'clam-chowder': {
    description: 'New England clam chowder with bacon, potato and cream.',
    diet: 'regular',
    mealPeriods: ['lunch', 'dinner'],
    priceCents: 1100,
    preparationMinutes: 45,
    servings: 4,
  },
  'creamy-tomato-soup': {
    description: 'Tomato soup finished with whole milk and a little sugar.',
    diet: 'vegetarian',
    mealPeriods: ['lunch'],
    priceCents: 500,
    preparationMinutes: 45,
    servings: 4,
  },
  'broccoli-stilton-soup': {
    description: 'Broccoli soup with Stilton stirred through.',
    diet: 'vegetarian',
    mealPeriods: ['lunch'],
    priceCents: 600,
    preparationMinutes: 35,
    servings: 4,
  },
};
