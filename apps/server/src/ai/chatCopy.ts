/**
 * The chat lane's two `answered: false` messages (CONTRACTS AMENDMENT 6).
 *
 * TSD 5.4 step 2 names "`<no-eligible-meals copy>`" without giving the words, and step 3 needs
 * something to say for every `UnresolvedAnswer`. Both strings reach a user in
 * `ChatResponse.answer`, so PRD 12 governs them: **fixed local copy, chosen here**, never an
 * exception message, never `String(error)`, never a reason name rendered for a human. They are
 * the only prose this server authors on the chat lane, and they exist so the deterministic
 * paths can answer honestly **without calling the model** (Plan 15.3).
 *
 * Each message says what happened, what still works, and what to do next (PRD 12).
 *
 * **What the copy may not claim.** No denied phrase from `claimDenylist.ts` appears in any of
 * these strings, and none of them carries a digit. Containment does not run over server copy -
 * it runs over model replies - so nothing would catch a health verdict written here; the
 * discipline has to be in the writing. `noEligibleMeals` also names the three filters that can
 * actually empty the set (allergen rejection, diet incompatibility, availability) and **not**
 * disliked ingredients, which TSD 4.8 step 4 demotes rather than excludes: telling a user to
 * relax a filter that cannot have caused the emptiness is advice that does nothing.
 */

import type { UnresolvedReason } from '@nutritime/domain';

export const CHAT_COPY: {
  /** `eligible` is empty - the user's own filters excluded everything. PRD FR-015. */
  readonly noEligibleMeals: string;
  /** The resolver could not answer. PRD 7.3: "I do not have that information". */
  readonly noInformation: string;
  /** A greeting, and - per R-22 - a Capability question too. See below. */
  readonly greeting: string;
} = {
  noEligibleMeals:
    'Your allergy and diet filters, together with what is unavailable right now, leave no ' +
    'meals for me to read, so I have nothing to answer from. Relax one of those and ask ' +
    'again; browsing and searching the catalog still work.',

  /**
   * PRD 7.3's sentence, verbatim, then the bounded list PRD 7.4 describes.
   *
   * The refusal comes first because it is the answer; the suggestions follow because a bounded
   * assistant that does not say what its bounds are reads as a broken one.
   */
  /*
    **Every suggestion here is a form that was MEASURED to resolve, and three of the previous
    five were not (R-85).**

    It used to offer "how they rank by calories or protein", "what they come to altogether" and
    (in `greeting`) "which has the most protein" - and all three refuse:

    - the four nutrition fields are `null` for **53 of the 60** seeded meals, and TSD 4.9's
      `gather` refuses a field any candidate cannot supply (`field-partially-known`), so every
      calorie, protein, carbohydrate and fat question is dead until the catalog-coverage pass
      binds the remaining ingredients. That is R-03, not a lexicon gap;
    - "what they come to altogether" names a shape and no field, which TSD 4.9's matching rule 5
      makes `incomplete-intent` **by contract** - so the fix is this sentence, not the resolver.

    **Guidance copy is a promise, and this one was telling the user to ask three questions the
    app then refused.** A bounded assistant that misstates its bounds is worse than one that
    states them narrowly: the narrow version is merely limited, and the other reads as broken.
    So price, preparation time, listing and count are named - and nutrition is not named until it
    works.
  */
  noInformation:
    'I do not have that information. I can only answer from the meals your preferences ' +
    'allow, and this question is not one I can work out from them. Try asking which meal is ' +
    'cheapest or quickest, which takes the longest to make, what the total price is, how they ' +
    'rank by price or preparation time, how many there are, or what options you have.',

  /**
   * **One string for two question shapes, and that collision is R-22 rather than a shortcut.**
   *
   * PRD 7.4 lists **Capability** ("What can you do?") as one of six answerable shapes, but
   * TSD 4.9's `UnresolvedReason` has no `capability` member, so `answer-lexicon.ts` classifies
   * "what can you do" as a `greeting` term alongside "hello". A route therefore **cannot** give
   * the two different words: by the time the reason arrives, the distinction is gone. Inventing
   * a seventh reason would be a TSD 4.9 amendment and a `packages/domain` edit, which is a stop
   * condition - so the resolution is one line that is honest as a reply to either, which is why
   * it opens with a greeting and then answers the capability question.
   */
  greeting:
    'Hello. I can answer questions about the meals your diet, allergies, and availability ' +
    'already allow: which one is cheapest or quickest, which takes the longest to make, what ' +
    'the total price is, how they rank by price or preparation time, how many there are, and ' +
    'what options you have. Ask about one of those and I will read the list for you.',
};

/**
 * `UnresolvedReason` to copy, as a keyed record so a seventh reason is a **compile error**.
 *
 * Every reason but `greeting` maps to `noInformation`, and that is the point rather than
 * laziness: TSD 5.7 says the client is never told which rule fired, and the same reasoning
 * holds one layer up - a caller able to tell `ambiguous-intent` from `field-partially-known`
 * can probe the resolver's internals through the copy, and the user has no action that differs
 * between the two. The distinctions are a developer's concern, and a developer reads the
 * resolver's own suite.
 *
 * `empty-question` is **unreachable through the route**: `chatRequestSchema` trims and requires
 * at least one character, so a blank question is a 400 at step 1 and never reaches step 3. It is
 * mapped anyway because `resolveAnswer` is exported and reachable from elsewhere, and because a
 * record with a hole is a record that will one day be indexed into the hole.
 */
const COPY_FOR_REASON: Readonly<Record<UnresolvedReason, string>> = {
  'empty-question': CHAT_COPY.noInformation,
  'no-intent': CHAT_COPY.noInformation,
  'incomplete-intent': CHAT_COPY.noInformation,
  'ambiguous-intent': CHAT_COPY.noInformation,
  'field-unknown': CHAT_COPY.noInformation,
  'field-partially-known': CHAT_COPY.noInformation,
  'no-candidates': CHAT_COPY.noInformation,
  greeting: CHAT_COPY.greeting,
};

export function copyForUnresolved(reason: UnresolvedReason): string {
  return COPY_FOR_REASON[reason];
}
