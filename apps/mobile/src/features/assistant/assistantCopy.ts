/**
 * Every word the Assistant screen says, and the one bound it enforces (T-21-05, T-21-07).
 *
 * **This is server-unchecked user-facing text**, and that is the reason the copy lives in its own
 * module rather than inline in the screen. Containment (`apps/server/src/ai/containment.ts`) runs
 * over *model replies*; it has never run over the client's own prose, and it cannot — a mobile
 * module may not import a server one (the lint boundary forbids it). So the discipline has to be
 * in the writing: **no string below makes a safety, health or medical claim**, and none of them
 * carries a digit, for the same reason `apps/server/src/ai/chatCopy.ts` says so of its three.
 * `assistantCopy.test.ts` holds a hand-transcribed copy of TSD §5.7's denied-phrase list and runs
 * every string here through it, which is the nearest thing to `deniedClaimIn` this side of the
 * boundary.
 *
 * Every state's copy is PRD §12's three clauses: `title` says what happened, `description` says it
 * in full, `stillAvailable` says what still works, and `actionLabel` is what to do next.
 *
 * **The two strings that must never converge are `ASSISTANT_FAILURE_COPY.unavailable` and
 * `ASSISTANT_COPY.noInformation`.** One means the assistant could not be reached; the other means
 * the assistant *answered* and does not have that information (PRD §7.3, and a 200 with
 * `source: 'local'` on the wire). Conflating them tells a user the app is broken at the moment it
 * has just answered them correctly, and that is the specific defect T-21-07 exists to prevent.
 */

/**
 * PRD FR-015 and §7.3: "a free-text question of 1–500 characters".
 *
 * `chatRequestSchema` caps it at 500 server-side too, and this is the one the user feels — a field
 * that accepts 600 characters and then shows a 400 has spent the user's typing to tell them a
 * number the app already knew. The two are pinned to each other executably rather than by
 * comment: the suite parses a question of exactly this length through `chatRequestSchema` and one
 * a character longer, so a drift in either direction fails.
 */
export const ASSISTANT_MAX_QUESTION = 500;

/**
 * The ways an ask can fail to produce an answer, as a const array so the union and the copy table
 * are derived from one list.
 *
 * Declared as data rather than as a bare union because the suite iterates it: a seventh failure
 * added here without copy is a compile error, and one added *with* copy still cannot arrive
 * undecided, because the distinctness and denied-claim assertions range over this array.
 *
 * `disabled` and `unavailable` are **both HTTP 503** (`API_ERROR_STATUS` in `@nutritime/contracts`
 * gives `ai_disabled` and `ai_unavailable` the same status) and they mean different things: the
 * model was turned off, versus the model could not be reached. They are two members here for
 * exactly that reason.
 *
 * `disabled` is also the one state reachable **without any request at all**: `useAssistant` gates
 * on the user's own `preferences.aiEnabled` before calling the client. See its copy below.
 */
export const ASSISTANT_FAILURES = [
  'disabled',
  'unavailable',
  'busy',
  'offline',
  'rejected',
  'failed',
] as const;

export type AssistantFailure = (typeof ASSISTANT_FAILURES)[number];

export interface AssistantStateCopy {
  readonly title: string;
  /** User-facing copy, never an exception message and never a wire string (PRD §12, TSD §3.5). */
  readonly description: string;
  /** PRD §12's "what still works". */
  readonly stillAvailable: string;
  /**
   * `null` where asking again changes nothing, rather than optional.
   *
   * A required field with a null inhabitant forces the decision: a "Try again" on a model that is
   * switched off is a control that cannot work, and one on a question the server refused would
   * re-send the same refused question.
   */
  readonly actionLabel: string | null;
}

export const ASSISTANT_FAILURE_COPY: Readonly<Record<AssistantFailure, AssistantStateCopy>> = {
  /**
   * **One state, two switches, and the copy has to be true of both.**
   *
   * `preferences.aiEnabled` is the user's own, gated in `useAssistant` before any request;
   * `config.AI_ENABLED` is the operator's, which arrives as a 503 `ai_disabled`. Naming only the
   * server's — which this description used to do — would be a false specific claim in the more
   * common case, now that the user's switch is honoured. So it names both and points at the one
   * the reader can act on.
   */
  disabled: {
    title: 'The assistant is turned off',
    description:
      'Answers here are phrased by a model, and the model is off — either because AI is switched ' +
      'off in Settings, or because it is switched off where the server runs. So the question was ' +
      'not phrased at all, and nothing was invented in its place.',
    stillAvailable:
      'Suggestions, browsing, search and the meals you saved never need the model, and all of ' +
      'them still work.',
    actionLabel: null,
  },

  unavailable: {
    title: 'The assistant could not be reached',
    description:
      'The model that phrases these answers did not respond, so there is no answer to show. ' +
      'Nothing was made up to fill the gap.',
    stillAvailable: 'Browsing, search and the meals you saved are untouched and still work.',
    actionLabel: 'Try again',
  },

  busy: {
    title: 'The assistant is finishing another question',
    description:
      'One question is phrased at a time and another is still running, so this one was not ' +
      'answered. Asking again in a moment usually gets through.',
    stillAvailable: 'The rest of the app carries on working while that one finishes.',
    actionLabel: 'Ask again',
  },

  offline: {
    title: 'The server could not be reached',
    description: 'The question did not get through, so there is nothing to show for it.',
    stillAvailable:
      'Your saved meals and your own recipes are on this device and still work without the ' +
      'server.',
    actionLabel: 'Try again',
  },

  rejected: {
    title: 'That question was not accepted',
    description:
      'The server would not take the question as written, so it was not answered. A shorter, ' +
      'plainer wording usually gets through.',
    stillAvailable: 'Everything else on this screen, and the rest of the app, is unaffected.',
    actionLabel: null,
  },

  failed: {
    title: 'The answer could not be read',
    description:
      'A reply arrived that this app could not make sense of, so none of it is shown rather ' +
      'than part of it.',
    stillAvailable: 'Browsing the catalog and the meals you saved do not depend on this at all.',
    actionLabel: 'Try again',
  },
};

export const ASSISTANT_COPY = {
  heading: 'Assistant',

  /**
   * What the screen says before anything is asked.
   *
   * It names the bounds, because PRD §7.4's six answerable shapes are "a deliberate limit, not a
   * gap" — and an assistant that does not say what it can do reads as one that is broken when it
   * declines. Written to agree with `chatCopy.ts`'s `greeting`, which the server sends for a
   * Capability question, rather than to repeat it word for word.
   */
  intro:
    'Ask about the meals your diet, allergies and availability already allow. That list is all I ' +
    'read: which one is cheapest or quickest, which has the most protein, how they rank, what ' +
    'they come to altogether, and what options you have.',

  /**
   * The promise the code keeps, stated on screen.
   *
   * **Every clause of this is a property the suite pins.** Nothing is written to storage while a
   * question is asked and answered; `STORAGE_KEYS` holds no key for a transcript; and the request
   * body carries one question and the three retrieval fields, so no earlier question travels with
   * a later one (PRD §7.3, §10.3). A sentence like this is a defect the moment it stops being
   * true, which is why it is asserted rather than trusted.
   */
  privacyNote:
    'What you ask stays on this screen. Nothing here is written to this device, each question is ' +
    'answered on its own, and no earlier question is sent with a later one.',

  questionLabel: 'Your question',
  questionPlaceholder: 'Which of these is quickest?',
  askLabel: 'Ask',
  askHint: 'Sends this question and shows the answer below.',

  /** The pending state. Words rather than a bare spinner, per PRD §12 and Explore's precedent. */
  submitting: 'Reading the meals your preferences allow…',

  idleTitle: 'No questions yet',

  /** Labels for the two halves of one transcript entry. */
  questionHeading: 'You asked',
  answerHeading: 'Answer',

  /** T-21-06. The heading above the cited meals, which sit beside the answer they came from. */
  citationsHeading: 'Answered from these meals',
  citationHint: 'Opens this meal.',

  /**
   * `answered: false` — **a successful answer, and framed as one.**
   *
   * The words of the answer itself are the server's (`chatCopy.ts`: PRD §7.3's "I do not have
   * that information", or the no-eligible-meals sentence), so this carries only the framing and
   * the way on. It is rendered in the `info` tone with the `info` glyph, never `warning` or
   * `danger`: the endpoint returned 200 and answered correctly, and dressing that as a fault is
   * the misreport T-21-07 exists to prevent.
   */
  noInformation: {
    title: 'The assistant answered',
    stillAvailable:
      'This is an answer rather than a fault: the meals your preferences allow did not settle ' +
      'the question. Rewording it, or browsing the catalog yourself, is the way on from here.',
  },

  /** Validation, client-side, before anything is sent (T-21-05). */
  emptyQuestion: 'Type a question first.',
} as const;

/**
 * The bound as a sentence. A function, so the limit appears in the copy without any string in this
 * module carrying a digit — and so the number a user is told is the number the code enforces.
 */
export function questionTooLongMessage(limit: number): string {
  return `A question can be at most ${String(limit)} characters, and this one is longer, so it was not sent. Shorten it and ask again.`;
}

/** The field's static hint. Static on purpose: `FormField` folds `hint` into the accessible name,
 * and a live character count there would re-announce the field on every keystroke. The live count
 * is rendered separately, as visible text. */
export function questionHint(limit: number): string {
  return `Up to ${String(limit)} characters. Each question is answered on its own.`;
}

/** The live count, beside the field rather than inside its accessible name. */
export function charactersLeft(remaining: number): string {
  return `${String(remaining)} characters left`;
}
