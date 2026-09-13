# T-07-04 — allergen hand review of all 60 catalog records

**Phase:** P07. **Date:** 2026-09-13. **Reviewer:** the implementing engineer.

TSD 7.2 step 4 makes this a task rather than a note: allergen tags are the one field where a mistake
is a safety issue, so inference from the ingredient list is a starting point and the committed value
is reviewed. This log records the review of **every one of the sixty records**, not only the ones
that needed changing — an unrecorded "no change" is indistinguishable from an unreviewed record.

**Method.** For each record the derived tags were read against the full upstream ingredient list, and
the question asked was specifically _what is missing_, not _is this plausible_. A reviewer may only
ADD a tag; `seed.ts` unions inference with `allergenAdditions` and nothing in the authoring table can
remove an inferred tag. The tolerable error runs one way: hiding a safe meal, never exposing an
unsafe one.

**Outcome.** 5 records corrected, 2 further records annotated where the derived value was judged
wrong-but-safer-kept, 53 confirmed with no change.

## Corrections made

| Record                                               | Added    | Why inference missed it                                                                                                                                    |
| ---------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roasted-eggplant-with-tahini-pine-nuts-and-lentils` | `sesame` | Tahini is in the dish's own title and absent from its ingredient list. Inference reads ingredients only.                                                   |
| `spinach-ricotta-cannelloni`                         | `wheat`  | The pasta appears only in the NAME; the ingredient list says "Cannellini Beans" — one letter away, and a legume. A baked pasta dish carried no gluten tag. |
| `chilli-prawn-linguine`                              | `milk`   | "Fromage Frais" reached no dairy token. The lexicon gap is R-19 and was fixed in the shared lexicon as well.                                               |
| `christmas-pudding-flapjack`                         | `wheat`  | Christmas pudding is built on flour and breadcrumbs but arrives as one compound word carrying no wheat token. The rolled oats are a second reason.         |
| `beef-wellington`                                    | `milk`   | Retail puff pastry is butter-based and the dish has no other dairy ingredient. Added on the false-positive side.                                           |

## Judged and deliberately left as derived

| Record                        | Derived value                                | Judgement                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chicken-enchilada-casserole` | keeps `wheat`/`gluten` from "corn tortillas" | Corn tortillas are usually maize only, so this is likely a false positive. **Left in place**: removing it would expose a coeliac if any tortilla in the dish is a wheat blend, while keeping it only hides a safe meal. |
| `french-onion-soup`           | not vegetarian                               | Called out because the cheese and bread make it look meat-free at a glance. The stock is beef.                                                                                                                          |

## Every record reviewed

`+` marks a record whose tags this review changed; `~` one judged and deliberately left as
derived; `.` one confirmed unchanged.

|     | Record                                                      | Committed allergen tags                    |
| --- | ----------------------------------------------------------- | ------------------------------------------ |
| `.` | `english-breakfast`                                         | egg, gluten, wheat                         |
| `.` | `full-english-breakfast`                                    | egg, gluten, wheat                         |
| `.` | `fruit-and-cream-cheese-breakfast-pastries`                 | gluten, milk, wheat                        |
| `.` | `salmon-eggs-eggs-benedict`                                 | egg, fish, gluten, milk, wheat             |
| `.` | `smoked-haddock-kedgeree`                                   | egg, fish, milk                            |
| `.` | `breakfast-potatoes`                                        | (none)                                     |
| `.` | `home-made-mandazi`                                         | egg, gluten, milk, wheat                   |
| `.` | `spicy-arrabiata-penne`                                     | gluten, milk, wheat                        |
| `.` | `smoky-lentil-chili-with-squash`                            | tree-nut                                   |
| `.` | `dal-fry`                                                   | milk                                       |
| `.` | `spicy-north-african-potato-salad`                          | milk, tree-nut                             |
| `.` | `baingan-bharta`                                            | (none)                                     |
| `.` | `ribollita`                                                 | gluten, milk, wheat                        |
| `+` | `roasted-eggplant-with-tahini-pine-nuts-and-lentils`        | sesame, tree-nut                           |
| `.` | `stovetop-eggplant-with-harissa-chickpeas-and-cumin-yogurt` | milk                                       |
| `+` | `spinach-ricotta-cannelloni`                                | milk, wheat                                |
| `.` | `vegan-lasagna`                                             | gluten, soy, wheat                         |
| `.` | `vegan-chocolate-cake`                                      | gluten, tree-nut, wheat                    |
| `.` | `roast-fennel-and-aubergine-paella`                         | (none)                                     |
| `.` | `fasoliyyeh-bi-z-zayt-syrian-green-beans-with-olive-oil`    | (none)                                     |
| `.` | `red-onion-pickle`                                          | (none)                                     |
| `~` | `chicken-enchilada-casserole`                               | gluten, milk, wheat                        |
| `.` | `teriyaki-chicken-casserole`                                | gluten, soy, wheat                         |
| `.` | `pad-see-ew`                                                | egg, gluten, peanut, shellfish, soy, wheat |
| `.` | `potato-gratin-with-chicken`                                | milk                                       |
| `.` | `chicken-handi`                                             | milk                                       |
| `.` | `chicken-alfredo-primavera`                                 | gluten, milk, wheat                        |
| `.` | `tandoori-chicken`                                          | milk                                       |
| `.` | `spaghetti-bolognese`                                       | fish, gluten, milk, wheat                  |
| `.` | `irish-stew`                                                | gluten, wheat                              |
| `+` | `beef-wellington`                                           | egg, gluten, milk, wheat                   |
| `.` | `beef-brisket-pot-roast`                                    | (none)                                     |
| `.` | `beef-sunday-roast`                                         | egg, gluten, milk, wheat                   |
| `.` | `garides-saganaki`                                          | milk, shellfish                            |
| `.` | `honey-teriyaki-salmon`                                     | fish, gluten, sesame, soy, wheat           |
| `.` | `mediterranean-pasta-salad`                                 | fish, gluten, milk, wheat                  |
| `.` | `fish-pie`                                                  | fish, gluten, milk, shellfish, wheat       |
| `.` | `recheado-masala-fish`                                      | fish                                       |
| `.` | `cajun-spiced-fish-tacos`                                   | fish, gluten, milk, wheat                  |
| `.` | `laksa-king-prawn-noodles`                                  | fish, shellfish, tree-nut                  |
| `.` | `grilled-mac-and-cheese-sandwich`                           | gluten, milk, wheat                        |
| `.` | `fettucine-alfredo`                                         | gluten, milk, wheat                        |
| `.` | `pilchard-puttanesca`                                       | fish, gluten, milk, wheat                  |
| `.` | `venetian-duck-ragu`                                        | gluten, milk, wheat                        |
| `+` | `chilli-prawn-linguine`                                     | gluten, milk, shellfish, wheat             |
| `.` | `bakewell-tart`                                             | egg, gluten, milk, tree-nut, wheat         |
| `.` | `apple-frangipan-tart`                                      | egg, gluten, milk, tree-nut, wheat         |
| `.` | `chocolate-gateau`                                          | egg, gluten, milk, wheat                   |
| `.` | `rocky-road-fudge`                                          | milk, peanut                               |
| `.` | `hot-chocolate-fudge`                                       | milk                                       |
| `+` | `christmas-pudding-flapjack`                                | milk, wheat                                |
| `.` | `eton-mess`                                                 | egg, milk                                  |
| `~` | `french-onion-soup`                                         | gluten, milk, wheat                        |
| `.` | `brie-wrapped-in-prosciutto-brioche`                        | egg, gluten, milk, wheat                   |
| `.` | `boulangere-potatoes`                                       | (none)                                     |
| `.` | `fennel-dauphinoise`                                        | milk                                       |
| `.` | `cream-cheese-tart`                                         | egg, gluten, milk, wheat                   |
| `.` | `clam-chowder`                                              | gluten, milk, shellfish, wheat             |
| `.` | `creamy-tomato-soup`                                        | milk                                       |
| `.` | `broccoli-stilton-soup`                                     | milk                                       |

**Totals.** 60 records reviewed · 5 corrected · 2 annotated without change · 53 confirmed unchanged.

## Limitation carried forward

The allergen lexicon is a word list and is therefore incomplete by construction (R-19). This review
is the compensating control, and it is a human one: it catches what a word list cannot, and it will
miss what a human misses. Any future change to the sixty records requires the review to be redone
for the records that changed.
