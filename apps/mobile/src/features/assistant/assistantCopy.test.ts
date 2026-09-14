import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  chatRequestSchema,
  retrievalPreferencesSchema,
} from '@nutritime/contracts';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import { DEFAULT_PREFERENCES } from '../../infrastructure/storage/definitions.js';
import {
  ASSISTANT_COPY,
  ASSISTANT_FAILURES,
  ASSISTANT_FAILURE_COPY,
  ASSISTANT_MAX_QUESTION,
  charactersLeft,
  questionHint,
  questionTooLongMessage,
} from './assistantCopy.js';
import {
  failureFor,
  selectChatPreferences,
  stateForResponse,
  validateQuestion,
} from './useAssistant.js';

/**
 * The half of the Assistant feature that needs no renderer: the copy, the bound and the mappings.
 *
 * **Nothing is asserted against itself** (BRIEF §6.1g). The 500-character bound is pinned against
 * `chatRequestSchema` — a different authority, and the one the server actually enforces — rather
 * than by retyping 500 beside the constant; the failure table's key set against `API_ERROR_STATUS`;
 * the narrowed preference set against `retrievalPreferencesSchema`, which is strict and therefore
 * rejects a leaked `goal`. A drift in either end fails the other.
 *
 * **The copy is checked the way the server checks its own** (R-70). `apps/mobile` may not import
 * `apps/server` — the lint boundary forbids it and BRIEF §2 makes it a stop condition — so
 * `deniedClaimIn` is unreachable from here. The phrases below are transcribed **from TSD §5.7
 * (line 1278) and CONTRACTS AMENDMENT 2**, by hand, and the matcher reimplements §5.7's flattening
 * rule. It has its own control pair, because a matcher that cannot fire would make every "no claim
 * here" assertion vacuous.
 */

/**
 * TSD §5.7's sixteen, verbatim and in the document's order, plus AMENDMENT 2's three PRD
 * extensions. From the documents, not from `claimDenylist.ts`: a fixture drawn from the same
 * source as the code under test tests nothing (BRIEF §6.3).
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

/** AMENDMENT 2: negation of `healthy`, inflection of `medically`, negation of the two multi-words. */
const PRD_EXTENSIONS = ['you should', 'medical', 'unhealthy'] as const;

const DENIED_CLAIMS: readonly string[] = [...DOCUMENTED_CLAIMS, ...PRD_EXTENSIONS];

/** TSD §5.7: lowercase, non-alphanumeric → a single space, wrapped in single spaces. */
function flatten(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function deniedClaimIn(text: string): string | undefined {
  const flat = flatten(text);
  return DENIED_CLAIMS.find((claim) => flat.includes(` ${claim} `));
}

/**
 * Every string a user can read from this feature's copy module — **collected by WALKING the two
 * objects, not by listing their keys.**
 *
 * The list this replaced was hand-written, and a hand-written sweep makes every future string
 * **opt-in to the guard**. That is R-70's defect in structural form: the register row records that
 * "a guard aimed at one source of text does not cover another", and P20's CRITICAL was a server
 * copy string reading *"allergen free"* that failed **0 of 824** tests. One string was already
 * outside this list when it was found (`aiProgress`, written in `AssistantTurnRow.tsx` and since
 * moved into the module) — not through carelessness, but because nothing made it impossible.
 *
 * A walk cannot be forgotten. Adding a key to `ASSISTANT_COPY` now adds it to the sweep, and the
 * count assertion below is what stops a walk that silently finds nothing from passing every
 * "contains no denied claim" check vacuously — the same failure mode T-19-09's acceptance names
 * for an empty permitted figure set.
 *
 * `null` is skipped rather than stringified because `actionLabel` is legitimately `null` when a
 * retry cannot help; numbers are skipped because the digit rule below is about the copy constants,
 * and the bound reaches the user through the three functions that take it as an argument.
 */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }
  for (const nested of Object.values(value)) {
    collectStrings(nested, into);
  }
}

function everyCopyString(): readonly string[] {
  const found: string[] = [];
  collectStrings(ASSISTANT_FAILURE_COPY, found);
  collectStrings(ASSISTANT_COPY, found);
  return found;
}

const CHAT_PREFERENCES = { diet: 'regular', allergies: ['peanut'], dislikedIngredients: [] };

function parsesAsQuestion(question: string): boolean {
  return chatRequestSchema.safeParse({ question, preferences: CHAT_PREFERENCES }).success;
}

describe('the denied-claim matcher used below', () => {
  /**
   * The control pair TSD §5.7 names, and the reason it is here: without it, "no copy string
   * contains a denied claim" would pass just as happily with a matcher that never fires.
   */
  it('fires on a claim and not inside a longer word', () => {
    expect(deniedClaimIn('This meal is allergen-free and safe.')).toBeDefined();
    expect(deniedClaimIn('Food safety, treatment and handling unsafely.')).toBeUndefined();
    // Negation is not an exemption (TSD §5.7), so the matcher must still see this one.
    expect(deniedClaimIn('This is not healthy.')).toBe('healthy');
  });
});

describe('assistantCopy', () => {
  it('makes no safety, health or medical claim anywhere', () => {
    const offenders = everyCopyString()
      .map((text) => ({ text, claim: deniedClaimIn(text) }))
      .filter((entry) => entry.claim !== undefined);
    expect(offenders).toEqual([]);
    // Paired with a presence assertion, so an empty copy module could not pass this test.
    expect(everyCopyString().length).toBeGreaterThan(ASSISTANT_FAILURES.length);
    for (const text of everyCopyString()) {
      expect(text.trim()).not.toBe('');
    }
  });

  it('carries no digit in any constant, so no figure can be read off the screen', () => {
    // The same discipline `chatCopy.ts` holds itself to. The bound's own number reaches the user
    // through the three functions below, which take it as an argument.
    for (const text of everyCopyString()) {
      expect(text).not.toMatch(/\d/);
    }
    expect(questionTooLongMessage(ASSISTANT_MAX_QUESTION)).toContain(
      String(ASSISTANT_MAX_QUESTION),
    );
    expect(questionHint(ASSISTANT_MAX_QUESTION)).toContain(String(ASSISTANT_MAX_QUESTION));
    expect(charactersLeft(12)).toContain('12');
  });

  /**
   * **T-21-07's acceptance, at the copy layer.** Every state says something no other state says,
   * and the pair the task exists for — an unreachable model against an answer the assistant gave —
   * is in the same sweep rather than checked as a special case.
   */
  it('gives every state its own title and its own description', () => {
    const titles = [
      ...ASSISTANT_FAILURES.map((failure) => ASSISTANT_FAILURE_COPY[failure].title),
      ASSISTANT_COPY.noInformation.title,
    ];
    expect(new Set(titles).size).toBe(titles.length);

    const descriptions = ASSISTANT_FAILURES.map(
      (failure) => ASSISTANT_FAILURE_COPY[failure].description,
    );
    expect(new Set(descriptions).size).toBe(descriptions.length);

    // The specific pair, named, so a failure message says which requirement broke.
    expect(ASSISTANT_FAILURE_COPY.unavailable.title).not.toBe(ASSISTANT_COPY.noInformation.title);
    expect(ASSISTANT_FAILURE_COPY.unavailable.description).not.toContain(
      ASSISTANT_COPY.noInformation.title,
    );
  });

  // A seventh failure cannot arrive with no words, nor outside the sweeps above.
  it('has copy for exactly the failures the union names', () => {
    expect(Object.keys(ASSISTANT_FAILURE_COPY).sort()).toEqual([...ASSISTANT_FAILURES].sort());
  });

  it('withholds an action where asking again cannot help, and offers one where it can', () => {
    expect(ASSISTANT_FAILURE_COPY.disabled.actionLabel).toBeNull();
    expect(ASSISTANT_FAILURE_COPY.rejected.actionLabel).toBeNull();
    expect(ASSISTANT_FAILURE_COPY.unavailable.actionLabel).not.toBeNull();
    expect(ASSISTANT_FAILURE_COPY.busy.actionLabel).not.toBeNull();
    expect(ASSISTANT_FAILURE_COPY.offline.actionLabel).not.toBeNull();
  });
});

describe('ASSISTANT_MAX_QUESTION', () => {
  /**
   * **Pinned against the schema that enforces it, in both directions**: raising the constant fails
   * the first assertion and lowering it fails the second.
   */
  it('is the length chatRequestSchema accepts, and one less than the length it refuses', () => {
    expect(parsesAsQuestion('a'.repeat(ASSISTANT_MAX_QUESTION))).toBe(true);
    expect(parsesAsQuestion('a'.repeat(ASSISTANT_MAX_QUESTION + 1))).toBe(false);
  });
});

describe('validateQuestion', () => {
  /**
   * A hand-written table, each row run through **both** verdicts — not a restatement of the rule.
   * The trailing-space rows are the ones that matter: `chatRequestSchema` is
   * `z.string().trim().min(1).max(500)`, so the length that counts is the trimmed one, and a client
   * measuring the raw string would refuse a question the server would have answered.
   */
  const CASES: readonly string[] = [
    '',
    '   ',
    '\n\t ',
    'a',
    'Which of these is quickest?',
    'a'.repeat(ASSISTANT_MAX_QUESTION - 1),
    'a'.repeat(ASSISTANT_MAX_QUESTION),
    'a'.repeat(ASSISTANT_MAX_QUESTION + 1),
    `  ${'a'.repeat(ASSISTANT_MAX_QUESTION)}  `,
    `  ${'a'.repeat(ASSISTANT_MAX_QUESTION + 1)}  `,
  ];

  it('accepts exactly what the server accepts', () => {
    const disagreements = CASES.filter(
      (question) => (validateQuestion(question) === null) !== parsesAsQuestion(question),
    ).map((question) => ({
      length: question.length,
      client: validateQuestion(question),
      server: parsesAsQuestion(question),
    }));
    expect(disagreements).toEqual([]);
    // The control: the table must contain both verdicts, or "they agree" is satisfied by a
    // validator that returns the same answer for everything.
    expect(CASES.some((question) => validateQuestion(question) === null)).toBe(true);
    expect(CASES.some((question) => validateQuestion(question) !== null)).toBe(true);
  });

  it('tells an empty question apart from an over-long one', () => {
    expect(validateQuestion('   ')).toBe('empty');
    expect(validateQuestion('a'.repeat(ASSISTANT_MAX_QUESTION + 1))).toBe('too-long');
  });
});

describe('selectChatPreferences', () => {
  /**
   * `retrievalPreferencesSchema` is a `z.strictObject`, so this parse **fails** if `goal`, `budget`
   * or any other field reaches the request — the 400 TSD §5.4 promises and this function avoids.
   */
  it('produces exactly the narrow projection the chat route accepts', () => {
    const narrowed = selectChatPreferences(DEFAULT_PREFERENCES);
    expect(retrievalPreferencesSchema.safeParse(narrowed).success).toBe(true);
    expect(Object.keys(narrowed).sort()).toEqual(['allergies', 'diet', 'dislikedIngredients']);
    // The control: the full preference set is NOT acceptable, so the assertion above is about
    // narrowing rather than about the schema being permissive.
    expect(retrievalPreferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(false);
  });

  it('carries the allergy list through unchanged, because retrieval is what consumes it', () => {
    const narrowed = selectChatPreferences({ ...DEFAULT_PREFERENCES, allergies: ['peanut'] });
    expect(narrowed.allergies).toEqual(['peanut']);
  });
});

describe('failureFor', () => {
  function serverError(code: string, status: number): ApiClientError {
    return new ApiClientError({
      kind: 'server',
      status,
      code,
      retryable: true,
      wire: { code, message: 'ECONNREFUSED /var/run/private.sock', retryable: true },
      route: 'ask',
    });
  }

  /**
   * **The trap T-21-07 exists for, at the mapping layer.** The three carry the *same* HTTP status
   * — asserted here from `API_ERROR_STATUS`, the contract's own table and not a number retyped —
   * and mean different things, so a client keying off the status alone could not tell them apart.
   */
  it('separates the three 503s, which the status alone cannot', () => {
    expect(API_ERROR_STATUS.ai_disabled).toBe(API_ERROR_STATUS.ai_unavailable);
    expect(API_ERROR_STATUS.ai_busy).toBe(API_ERROR_STATUS.ai_unavailable);

    const mapped = (['ai_disabled', 'ai_unavailable', 'ai_busy'] as const).map((code) =>
      failureFor(serverError(code, API_ERROR_STATUS[code])),
    );
    expect(mapped).toEqual(['disabled', 'unavailable', 'busy']);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('maps a rejected request, the transports and an unknown code', () => {
    expect(failureFor(serverError('invalid_request', API_ERROR_STATUS.invalid_request))).toBe(
      'rejected',
    );
    expect(failureFor(transportError('ask', 'unreachable'))).toBe('offline');
    expect(failureFor(transportError('ask', 'timeout'))).toBe('offline');
    expect(failureFor(transportError('ask', 'unreadable'))).toBe('failed');
    // X-20: `internal_error` is a sixth code the union does not name. It must arrive intact and
    // fall back to generic copy rather than being mistaken for a model failure.
    expect(failureFor(serverError('internal_error', 500))).toBe('failed');
    expect(failureFor(new Error('something else'))).toBe('failed');
  });
});

describe('stateForResponse', () => {
  /**
   * **`answered: false` is a successful answer** (TSD §5.4: HTTP 200, `source: 'local'`). The pair
   * is built so no single constant satisfies both: one carries citations and the other cannot.
   */
  it('tells an answer apart from an answered-false reply', () => {
    const answered = stateForResponse({
      answered: true,
      answer: 'The quickest is the yogurt bowl.',
      citations: [{ mealId: 'greek-yogurt-bowl', name: 'Greek yogurt bowl' }],
      source: 'gemma',
    });
    expect(answered.kind).toBe('answered');
    expect(answered.kind === 'answered' ? answered.citations : []).toHaveLength(1);

    const refused = stateForResponse({
      answered: false,
      answer: 'I do not have that information.',
      citations: [],
      source: 'local',
    });
    expect(refused.kind).toBe('no-information');
    // Neither branch is a failure: a screen keying on `kind === 'failed'` must see nothing here.
    expect([answered.kind, refused.kind]).not.toContain('failed');
  });

  /** PRD §7.3: such an answer drew on nothing, so it cites nothing even if a citation arrives. */
  it('cites nothing on the answered-false branch', () => {
    const refused = stateForResponse({
      answered: false,
      answer: 'I do not have that information.',
      citations: [{ mealId: 'greek-yogurt-bowl', name: 'Greek yogurt bowl' }],
      source: 'local',
    });
    expect(Object.keys(refused)).toEqual(['kind', 'answer']);
  });
});
