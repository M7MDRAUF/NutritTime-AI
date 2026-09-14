import { describe, expect, it } from 'vitest';

import { DENIED_CLAIMS, deniedClaimIn, flattenForMatching } from './claimDenylist.js';

/**
 * Plan 19.3's `containment` row requires **each denylist phrase, including a negated one**.
 *
 * Two layers, because either alone is beatable:
 *
 * 1. `DOCUMENT_DENIED_CLAIMS` is TSD 5.7 check 2's list typed out by hand from the document, and
 *    asserted to be the first sixteen entries of the export, in order. A loop over the export
 *    alone is vacuous if the export shrinks - sixteen cases become fifteen and the suite still
 *    reads green. `RULING_EXTENSIONS` is asserted separately, so a drift in the documented list
 *    and a drift in the three PRD 7.3 additions each go red on their own.
 * 2. One hand-written adversarial answer per phrase, keyed by phrase, so a dropped term makes a
 *    case go red under the name of the term that went missing.
 *
 * BRIEF 6.3: the fixtures are written to a checklist of attack shapes a 4B model actually
 * produces - reassurance, hyphenated "allergen-free", negation outside the phrase, negation
 * inside the phrase, medical framing, a directive - and never sampled from what this
 * implementation happens to return.
 */
const DOCUMENT_DENIED_CLAIMS = [
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
 * The additions the orchestrator ruled in under PRD 7.3, which outranks TSD 5.7.
 *
 * `you should` closes the negator-inside-a-phrase hole, `medical` is the adjective of the listed
 * `medically`, `unhealthy` is the missing negation of the listed `healthy`, and `safer` /
 * `safest` / `safely` are the inflections of `safe` that TSD 5.7 spells out for `healthy` and
 * omits for its sibling. Order matters: extensions come last so the specific `you should eat`
 * still wins over the broad `you should`.
 */
const RULING_EXTENSIONS = [
  'you should',
  'medical',
  'unhealthy',
  'safer',
  'safest',
  'safely',
] as const;

/** One adversarial answer per phrase, in list order. `%s` names the phrase. */
const ADVERSARIAL_ANSWERS = [
  ['allergen free', 'The Grilled Salmon Bowl is allergen-free for you.'],
  ['allergy free', 'Every option on this list is allergy free.'],
  ['safe', 'This one is safe to order tonight.'],
  ['unsafe', 'Nothing on this list is unsafe for you.'],
  ['healthy', 'This is not healthy.'],
  ['healthier', 'The wrap is healthier than the burger.'],
  ['healthiest', 'The Lentil Soup is the healthiest of the five.'],
  ['cures', 'Ginger cures nausea, so try the ginger tofu.'],
  ['treats', 'Turmeric treats inflammation.'],
  ['medically', 'That portion is medically appropriate for your condition.'],
  ['doctor', 'Ask your doctor before ordering this.'],
  ['doctors', 'Most doctors recommend the salmon.'],
  ['prescribes', 'Your plan prescribes a low-sodium option.'],
  ['prescribed', 'This is the prescribed portion for you.'],
  ['you should eat', 'Given your goals, you should eat the salad.'],
  ['you should avoid', 'you should avoid the shrimp bowl'],
  // The PRD 7.3 extensions. Every one of these answers passed check 2 before the ruling that
  // added its phrase, which is why each is written as prose a model would actually emit.
  ['you should', 'You should not eat the fish.'],
  ['medical', 'Please seek medical advice before ordering.'],
  ['unhealthy', 'The deep-fried option is unhealthy.'],
  ['safer', 'The wrap is safer than the shrimp bowl.'],
  ['safest', 'This is the safest choice for you.'],
  ['safely', 'You can safely eat this one.'],
] as const;

/**
 * Whole-word controls. `naivelyMatches` records whether the answer contains the phrase as a RAW
 * substring, which is the mutation these exist to catch: replacing the `" phrase "` test with a
 * bare `includes(phrase)`. BRIEF 6.2 shape 2 - a control that passes under the mutation is not a
 * control - so the flag is asserted rather than assumed, and the `true` rows are the real ones.
 *
 * `treatment` and `healthful` are `false`: they share a stem with `treats` and `healthy` but not
 * a substring, so they guard a stem-matching mutation instead. They are kept because a reader
 * expects them here, and the flag says plainly what each one is worth.
 *
 * `healthful` also stays a control on purpose after the PRD 7.3 ruling: it is neither an
 * inflection of `healthy` nor a negation of it, so denying it would invent a rule no document
 * states. `unhealthy` used to sit here as a control and is now a denied phrase, so its answer
 * moved to `ADVERSARIAL_ANSWERS`.
 *
 * Three phrases have no `true` row, and that is a statement rather than an omission: no English
 * word contains `unhealthy`, `safer` or `safest` as a substring, so an `includes()`-strong
 * control for them does not exist. Their `false` rows guard a *stem*-matching mutation instead —
 * `safety` would match a `safe`-plus-any-suffix rule — and the per-extension probes carry the
 * rest of the weight.
 *
 * `unsafely` was re-checked when `safely` joined the list, because a control that has become a
 * match is a broken control (the correction `unhealthy` needed). It still holds, and it is now
 * an `includes()`-strong control for `safely` as well as for `unsafe`: `"unsafely"` contains both
 * as raw substrings and neither as a whole word. Both rows are kept, one per phrase, so each
 * flag is asserted on its own.
 */
const WHOLE_WORD_CONTROLS = [
  ['safe', 'Food safety is handled in the kitchen.', true],
  ['unsafe', 'Nothing here is ever stored unsafely.', true],
  ['safely', 'Nothing here is ever stored unsafely.', true],
  ['doctor', 'Our consultant holds a doctorate in food science.', true],
  ['cures', 'The dressing obscures the flavour of the greens.', true],
  ['treats', 'Our weekend retreats serve this dish.', true],
  ['allergen free', 'There is no allergen freedom in a shared kitchen.', true],
  ['medical', 'Our biomedical team does not write the menu.', true],
  ['you should', 'Ask the chef you shouldered past in the queue.', true],
  ['treats', 'The treatment plan is not ours to write.', false],
  ['healthy', 'A healthful diet is not something this app assesses.', false],
  ['safer', 'Food safety is handled in the kitchen.', false],
  ['safest', 'A safety leaflet is not a verdict.', false],
] as const;

describe('DENIED_CLAIMS', () => {
  it("opens with TSD 5.7 check 2's list, complete and in the document's order", () => {
    // Asserted as the leading run rather than as the whole export, so an extension accidentally
    // inserted into the middle of the documented sixteen goes red here too.
    expect(DENIED_CLAIMS.slice(0, DOCUMENT_DENIED_CLAIMS.length)).toEqual([
      ...DOCUMENT_DENIED_CLAIMS,
    ]);
    expect(DOCUMENT_DENIED_CLAIMS).toHaveLength(16);
  });

  it('closes with the PRD 7.3 extensions, last so the specific phrase still wins', () => {
    expect(DENIED_CLAIMS.slice(DOCUMENT_DENIED_CLAIMS.length)).toEqual([...RULING_EXTENSIONS]);
    expect(RULING_EXTENSIONS).toHaveLength(6);
  });

  it('is the documented list followed by the extensions, and nothing else', () => {
    expect(DENIED_CLAIMS).toEqual([...DOCUMENT_DENIED_CLAIMS, ...RULING_EXTENSIONS]);
    expect(DENIED_CLAIMS).toHaveLength(22);
  });

  it('has a hand-written adversarial answer for every phrase in the list', () => {
    expect(ADVERSARIAL_ANSWERS.map(([phrase]) => phrase)).toEqual([
      ...DOCUMENT_DENIED_CLAIMS,
      ...RULING_EXTENSIONS,
    ]);
  });

  it.each([...DENIED_CLAIMS])(
    '"%s" is already in flattened form, so it is reachable, and it matches itself',
    (phrase) => {
      expect(flattenForMatching(phrase)).toBe(` ${phrase} `);
      // Returning itself also proves no entry is shadowed by an earlier, shorter one.
      expect(deniedClaimIn(phrase)).toBe(phrase);
    },
  );
});

describe('flattenForMatching', () => {
  it('lowercases, collapses each non-alphanumeric run to one space, and wraps in spaces', () => {
    expect(flattenForMatching('You should eat')).toBe(' you should eat ');
    // The wrap is unconditional and there is no trim, so edge punctuation leaves a doubled
    // space. Harmless by construction: matching needs one space on each side of the phrase and
    // a second one outside it changes nothing.
    expect(flattenForMatching('You should, eat!')).toBe(' you should eat  ');
  });

  it('collapses a RUN to a single space, not one space per character', () => {
    // The comma-plus-space between "should" and "eat" is one run. A per-character replacement
    // would leave two spaces and no multi-word phrase would ever match punctuated prose.
    expect(flattenForMatching('should,   eat')).toBe(' should eat ');
  });

  it('wraps even an empty input, so output always opens and closes with a space', () => {
    expect(flattenForMatching('')).toBe('  ');
    for (const text of ['healthy', '', '   ', 'a', '!!!', 'you should eat']) {
      const flattened = flattenForMatching(text);
      expect(flattened.startsWith(' ')).toBe(true);
      expect(flattened.endsWith(' ')).toBe(true);
    }
  });

  it('keeps digits, because check 3 is a different check and this one must not eat numbers', () => {
    expect(flattenForMatching('Omega-3 at $12.50')).toBe(' omega 3 at 12 50 ');
  });

  it('leaves no character outside [a-z0-9 ] in its output', () => {
    expect(flattenForMatching('Cafe (100%) -- SAFE!')).not.toMatch(/[^a-z0-9 ]/);
  });

  it('does not strip diacritics: TSD 5.7 specifies three steps and NFD is not one of them', () => {
    // Reported as a finding, pinned here so the behaviour cannot change unnoticed. An accented
    // letter is itself non-alphanumeric, so the whole letter becomes a space rather than
    // folding to its unaccented twin, and the word splits around the hole it leaves.
    expect(flattenForMatching('Héalthy')).toBe(' h althy ');
    expect(deniedClaimIn('Héalthy')).toBeUndefined();
  });
});

describe('deniedClaimIn catches every phrase the document lists', () => {
  it.each(ADVERSARIAL_ANSWERS)('catches "%s" in an answer asserting it', (phrase, answer) => {
    expect(deniedClaimIn(answer)).toBe(phrase);
  });

  it('passes a clean, grounded answer that asserts nothing', () => {
    expect(deniedClaimIn('The Lentil Soup costs $8.25 and takes 20 minutes.')).toBeUndefined();
    expect(deniedClaimIn('')).toBeUndefined();
  });
});

describe('deniedClaimIn treats negation as no exemption', () => {
  /**
   * TSD 5.7: "Negation is not an exemption: 'this is not healthy' is still a health verdict."
   *
   * The instinct on reading this suite will be to call the negated forms benign and add a
   * negator check. Do not. A model asked to phrase a resolved answer produces the negated form
   * far more often than the bare one, so an exemption here would remove the check for the
   * commonest phrasing. There is deliberately no negator list and no sentiment reasoning in
   * `claimDenylist.ts`, and these three cases are what would go red if one were added.
   */
  it('matches a claim with the negator outside the phrase', () => {
    expect(deniedClaimIn('This is not healthy.')).toBe('healthy');
    expect(deniedClaimIn('I cannot promise it is safe')).toBe('safe');
    expect(deniedClaimIn('It is never allergen-free in a shared kitchen.')).toBe('allergen free');
  });

  it('matches a negator placed INSIDE a multi-word phrase, via the broader `you should`', () => {
    // **These three answers used to PASS check 2.** `you should not eat` is a different token
    // sequence from `you should eat`, so TSD 5.7's sixteen phrases let a plain dietary directive
    // through - and PRD 7.3, which outranks TSD 5.7, says the assistant "may not give medical or
    // dietary advice". Telling a user with a food allergy not to eat something is exactly that,
    // delivered by the one component that is not authoritative about safety. Closed by adding
    // `you should` to the list, not by special-casing negators in `deniedClaimIn`.
    expect(deniedClaimIn('You should not eat the fish')).toBe('you should');
    expect(deniedClaimIn('You should never avoid the salad')).toBe('you should');
    expect(deniedClaimIn('You should probably avoid the salmon')).toBe('you should');
  });

  it('matches the two other verdicts the documented list had no word for', () => {
    // `medically` was listed and `medical` was not; `healthy` was listed and `unhealthy` was not,
    // even though `safe` and `unsafe` are both there. Both answers passed check 2 before.
    expect(deniedClaimIn('Please seek medical advice before ordering.')).toBe('medical');
    expect(deniedClaimIn('This is unhealthy.')).toBe('unhealthy');
  });

  it('matches the inflections of `safe` that the documented list spelled out only for `healthy`', () => {
    // **`"the safest choice for you"` used to PASS check 2.** TSD 5.7 lists three forms of
    // `healthy` and exactly one of `safe`, so its own demonstration of "with their inflections"
    // was applied to one term and not to that term's sibling.
    expect(deniedClaimIn('This is the safest choice for you.')).toBe('safest');
    expect(deniedClaimIn('The wrap is safer than the shrimp bowl.')).toBe('safer');
    expect(deniedClaimIn('You can safely eat this one.')).toBe('safely');
  });

  it('proves the listed `safe` could never have reached those three forms', () => {
    // The mechanical reason the three entries were needed rather than redundant: whole-word
    // matching cannot see an inflection through its stem. If this ever became true, `safe` would
    // cover them and the extensions would be dead weight - so the assertion is the negative one.
    for (const answer of ['the safest choice', 'a safer option', 'you can safely eat it']) {
      expect(flattenForMatching(answer).includes(' safe ')).toBe(false);
      expect(deniedClaimIn(answer)).not.toBeUndefined();
    }
  });

  it('keeps the more specific phrase as evidence when a broader one also matches', () => {
    // The extensions sit last in `DENIED_CLAIMS`, and the tie-break is list order, so a directive
    // that names the verb reports the verb. A log line saying `you should eat` is worth more than
    // one saying `you should`, and this is the only thing holding that.
    expect(deniedClaimIn('Given your goals, you should eat the salad.')).toBe('you should eat');
    expect(deniedClaimIn('you should avoid the shrimp bowl')).toBe('you should avoid');
    expect(DENIED_CLAIMS.indexOf('you should eat')).toBeLessThan(
      DENIED_CLAIMS.indexOf('you should'),
    );
    // `medically` likewise outranks the broader `medical`.
    expect(deniedClaimIn('That portion is medically appropriate.')).toBe('medically');
  });
});

describe('deniedClaimIn is whole-word by construction', () => {
  it.each(WHOLE_WORD_CONTROLS)(
    'does not fire "%s" inside a longer word: %s',
    (phrase, answer, naivelyMatches) => {
      // The control's own strength, asserted rather than assumed.
      expect(flattenForMatching(answer).includes(phrase)).toBe(naivelyMatches);
      expect(deniedClaimIn(answer)).toBeUndefined();
    },
  );

  it('still catches the same word when it stands alone', () => {
    // Pairs with the controls above so no constant return satisfies both sides.
    expect(deniedClaimIn('Food safety aside, this is safe.')).toBe('safe');
    expect(deniedClaimIn('A doctorate is not a doctor.')).toBe('doctor');
  });
});

describe('deniedClaimIn and the space wrap', () => {
  it('matches a phrase that OPENS the answer', () => {
    // With the leading space of the wrap removed, `" healthy "` cannot be found here at all:
    // the denied word is the first thing in the answer and supplies no space before itself.
    expect(deniedClaimIn('Healthy choices are plentiful here.')).toBe('healthy');
    expect(deniedClaimIn('you should avoid the shrimp bowl')).toBe('you should avoid');
  });

  it('matches a phrase that CLOSES the answer with no trailing punctuation', () => {
    // The full stop is deliberately absent: it would itself flatten to a space and the case
    // would pass with the trailing wrap gone, which is BRIEF 6.2 shape 2.
    expect(deniedClaimIn('The kitchen says this one is safe')).toBe('safe');
    expect(deniedClaimIn('this is what your doctor prescribed')).toBe('doctor');
  });

  it('matches a multi-word phrase across collapsed punctuation', () => {
    expect(deniedClaimIn('You should, eat the salad')).toBe('you should eat');
    expect(deniedClaimIn('You should\t eat  the salad')).toBe('you should eat');
  });
});

describe('deniedClaimIn evidence', () => {
  it('returns the first phrase in DENIED_CLAIMS order, not the first by position', () => {
    const answer = 'It is healthy, and the kitchen says it is safe.';
    // The two orders genuinely disagree on this answer, which is what makes it a test.
    expect(answer.toLowerCase().indexOf('healthy')).toBeLessThan(
      answer.toLowerCase().indexOf('safe'),
    );
    expect(DENIED_CLAIMS.indexOf('safe')).toBeLessThan(DENIED_CLAIMS.indexOf('healthy'));
    expect(deniedClaimIn(answer)).toBe('safe');
  });

  it('returns the matched phrase and never the surrounding sentence (TSD 5.8)', () => {
    // The return value becomes containment's `evidence`, which the server logs. The answer
    // derives from the user's question, so carrying any of it into the return value would put a
    // question in a log line.
    const answer = 'The Grilled Salmon Bowl at $12.50 is completely safe for a shellfish allergy.';
    const evidence = deniedClaimIn(answer) ?? '';
    expect(evidence).toBe('safe');
    expect(DENIED_CLAIMS).toContain(evidence);
    expect(evidence.length).toBeLessThan(answer.length);
    for (const leaked of ['salmon', 'shellfish', 'allergy', '12', 'bowl']) {
      expect(evidence).not.toContain(leaked);
    }
  });
});
