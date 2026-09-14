/**
 * Containment check 2 — denied claims (TSD 5.7 check 2, Plan 15.4 layer 2, PRD FR-015).
 *
 * PRD 7.3: the assistant "may not state that a meal is allergen-free, safe, or healthy, and it
 * may not give medical or dietary advice". The reason is architectural rather than stylistic.
 * Allergen rejection, diet compatibility and availability exclusion are all final before the
 * model is reachable at all, so a reassuring sentence from the model adds no information and
 * puts a safety assertion in the one component that is not authoritative about safety. This
 * module is the point where that prohibition becomes executable.
 *
 * The list is TSD 5.7's sixteen phrases, transcribed in the document's order, plus six additions
 * made under PRD 7.3 by orchestrator ruling — see `PRD_EXTENSIONS` for the authority behind each,
 * and for why the list should be expected to need more. It is not a judgement about which words
 * are dangerous and it is not extensible here on local taste: a further addition or any removal
 * is a document decision, reported, not a code change made in this file.
 */

/**
 * Any run of characters outside `[a-z0-9]`, collapsed to ONE space.
 *
 * The run form (`+`) rather than a per-character replacement is what lets a multi-word phrase
 * survive punctuation: `"You should, eat"` carries a comma AND a space between the words, and a
 * 1:1 replacement would leave two spaces there, so `" you should eat "` would not be found. The
 * domain's own `normalizeText` (packages/domain/src/text.ts) collapses runs for the same reason.
 *
 * Declared at module scope with `g`. `String.prototype.replace` resets `lastIndex` on a global
 * regex, so the shared instance is safe across calls.
 */
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;

/**
 * TSD 5.7 check 2's list, verbatim and in the document's order.
 *
 * Two apparent redundancies are not redundant, because matching is whole-word: `" unsafe "` does
 * not contain `" safe "`, and `" doctors "` does not contain `" doctor "`. Each inflection the
 * document lists has to be listed.
 *
 * Held separately from `PRD_EXTENSIONS` so a drift in either is caught on its own: the test
 * asserts this run of sixteen against a literal transcription of the document, and the
 * extensions against the ruling that authorised them.
 */
const DOCUMENTED_CLAIMS = [
  'allergen free',
  'allergy free',
  'safe',
  'unsafe',
  'healthy',
  'healthier',
  'healthiest',
  'cures',
  'treats',
  'medically',
  'doctor',
  'doctors',
  'prescribes',
  'prescribed',
  'you should eat',
  'you should avoid',
] as const;

/**
 * Six extensions under **PRD 7.3, which outranks TSD 5.7** (BRIEF 1's authority order).
 *
 * PRD 7.3 is unambiguous — the assistant "may not state that a meal is allergen-free, safe, or
 * healthy, and it may not give medical or dietary advice" — and TSD 5.7's phrase list is an
 * *implementation* of that requirement which under-implements it in each of the places below.
 * Every addition is traceable to a rule TSD 5.7 itself states, so none of them contradicts the
 * document: the list is "the terms PRD FR-015 forbids, **with their inflections**", and
 * "**negation is not an exemption**".
 *
 * | Addition | Authority | The answer that motivated it |
 * |---|---|---|
 * | `you should` | negation is not an exemption, applied to the two multi-word entries | `"You should not eat the fish"` — passed check 2, because a negator placed INSIDE a phrase changes the token sequence |
 * | `medical` | with their inflections — the adjective of the listed `medically` | `"Please seek medical advice before ordering."` |
 * | `unhealthy` | negation is not an exemption, applied to the listed `healthy` | `"The deep-fried option is unhealthy."` — a health verdict with no negative counterpart in the list |
 * | `safer` | with their inflections — the comparative, the form `healthy` is given in the same list | `"The wrap is safer than the shrimp bowl."` |
 * | `safest` | with their inflections — the superlative, likewise | `"This is the safest choice for you."` |
 * | `safely` | with their inflections — the adverb | `"You can safely eat this one."` |
 *
 * The last three close an inconsistency inside TSD 5.7's own list: it spells out three forms of
 * `healthy` (`healthy`, `healthier`, `healthiest`) and exactly one of `safe`, so the document
 * demonstrates what "with their inflections" means for one term and omits it for that term's
 * sibling. Whole-word matching cannot see `safest` through the listed `safe` —
 * `" the safest choice "` does not contain `" safe "` — so the omission was a hole, not a
 * shorthand.
 *
 * `healthful` is deliberately NOT here: it is neither an inflection of `healthy` nor a negation of
 * it, so adding it would invent a rule no document states. It stays a negative control.
 *
 * **This list is not a closed set, and nobody should read it as one.** Three separate review
 * passes each found further missing inflections of terms already on it. A hand-maintained list of
 * word forms cannot be completed by inspection; what would close the class is a rule rather than
 * more entries — stem matching with a suffix set, or a stemmer. That is a TSD 5.7 amendment and a
 * dependency question, so it is reported, not built here.
 *
 * Why erring strict is the right direction here: a denied claim discards the reply and the chat
 * route returns 503 `ai_unavailable` (TSD 5.7). So a guard that is too strict fails by throwing
 * away a good answer — visible, and recoverable by asking again — while one that is too loose
 * fails by showing a user with a food allergy a safety or dietary verdict from the one component
 * that is not authoritative about safety. Those two costs are not comparable.
 */
const PRD_EXTENSIONS = ['you should', 'medical', 'unhealthy', 'safer', 'safest', 'safely'] as const;

/**
 * PRD FR-015's forbidden claims, with inflections (TSD 5.7 check 2), extended under PRD 7.3.
 *
 * **Extensions last, deliberately.** `deniedClaimIn` returns the first match in this order, so
 * `you should eat` is reached before the broader `you should` and `evidence` keeps the more
 * specific phrase. That is what keeps a log line worth reading, and it is asserted.
 */
export const DENIED_CLAIMS: readonly string[] = [...DOCUMENTED_CLAIMS, ...PRD_EXTENSIONS];

/**
 * Lowercase · non-alphanumeric → a single space · wrapped in single spaces.
 *
 * Exactly TSD 5.7's three steps, in that order, and nothing else. It deliberately does NOT strip
 * diacritics, even though `normalizeText` does — the document specifies three steps and a fourth
 * one added here would be a rule no document defines.
 *
 * The wrap is the whole mechanism behind whole-word matching. Callers test for `" phrase "`, so
 * a phrase that opens or closes the text needs a space that the text itself does not supply:
 * without the wrap, `"Healthy choices."` would not match `healthy`.
 */
export function flattenForMatching(text: string): string {
  return ` ${text.toLowerCase().replace(NON_ALPHANUMERIC_RUN, ' ')} `;
}

/**
 * The first denied phrase present, or `undefined`. Whole-word by construction.
 *
 * **Negation is not an exemption.** There is deliberately no negator detection and no sentiment
 * reasoning: `"this is not healthy"` matches `healthy`, because it is still a health verdict and
 * TSD 5.7 says so in those words. The next reader's instinct will be to treat the negated form
 * as benign and add an exception; that would delete the check for the most common phrasing a
 * model actually produces. Do not add one.
 *
 * A negator placed INSIDE a multi-word phrase does change the token sequence, so
 * `"you should not eat the fish"` does not match `you should eat` — it matches the broader
 * `you should`, which is in the list for exactly that reason (see `PRD_EXTENSIONS`). The
 * mechanism that catches it is another entry in the list, never a special case in this function.
 *
 * **First in `DENIED_CLAIMS` order, not first by position in the text.** Both are defensible;
 * list order is chosen because it makes the returned phrase a function of the denylist alone.
 * The return value becomes containment's `evidence`, which the server logs, and the answer it
 * came from derives from the user's question — so an evidence value whose choice depends on how
 * the sentence was phrased is an evidence value that varies with user input. TSD 5.8 forbids
 * logging a question or an answer; returning the matched PHRASE and never the surrounding
 * sentence is what keeps this side of that rule.
 */
export function deniedClaimIn(text: string): string | undefined {
  const flattened = flattenForMatching(text);
  for (const phrase of DENIED_CLAIMS) {
    if (flattened.includes(` ${phrase} `)) {
      return phrase;
    }
  }
  return undefined;
}
