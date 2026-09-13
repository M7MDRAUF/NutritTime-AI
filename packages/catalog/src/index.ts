/**
 * The seeded catalog (TSD 7.1).
 *
 * Exported as `unknown` deliberately. The 60 records are data, and data is validated at the
 * boundary with `mealSchema` (TSD 7.3), never trusted by the type system. A typed export here
 * would let a hand-edited `meals.json` claim a shape it does not have and reach the server
 * unchecked, which is the one failure this indirection exists to prevent.
 *
 * The seed modules under `src/seed/` are deliberately NOT re-exported. They read the file
 * system and reach the network, they run only under `npm run seed`, and nothing that ships to
 * a device or a request path may import them.
 */

import meals from '../meals.json' with { type: 'json' };

export const seededCatalog: unknown = meals;
