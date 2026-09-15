/**
 * The Assistant screen's state: the transcript, the client-side bound, and the ask (T-21-05).
 *
 * **The transcript is `useState` and nothing else.** There is no store, no storage key and no
 * `createStore` call anywhere in this feature, and that is a product requirement rather than a
 * shortcut: PRD §7.3 says "Each question is answered independently. No conversation history is
 * sent to or kept by the server; the on-screen transcript is a display concern only", and PRD
 * §10.3 forbids a question being kept at all. A stored transcript is a stored question. The suite
 * pins both halves — that nothing is written to the driver across a whole ask, and that
 * `STORAGE_KEYS` has no key this feature could write to.
 *
 * **No history is sent, either.** `ChatRequest` carries one `question` and the three retrieval
 * fields; there is no parameter a previous turn could travel through, and `chatRequestSchema` is
 * a `z.strictObject`, so there could not be one without a 400.
 *
 * **The bound is enforced here, not only on the keyboard.** `FormField`'s `maxLength` stops a
 * user typing past 500, but `AssistantParams.seedQuestion` (TSD §6.2) means a deep link can hand
 * this screen a question of any length, and that route never touches the keyboard. So the check
 * lives in front of the request: an over-long question is a validation state and **the client is
 * not called at all**.
 *
 * **The user's own AI switch is honoured here too, and also without a request.** PRD §7.3 says to
 * report the assistant as unavailable "when AI is off", and `preferences.aiEnabled` is what "off"
 * means from the user's seat — `config.AI_ENABLED` is the operator's switch and a different thing.
 * `ChatRequest` carries no `aiEnabled` field and deliberately gains none; see `send`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiErrorCode, ChatResponse, Citation, UserPreferences } from '@nutritime/contracts';
import { isApiClientError } from '../../infrastructure/api/errors.js';
import { mealPeriodNow } from '../../shared/mealPeriodNow.js';
import type { ApiClient } from '../../infrastructure/api/client.js';
import type { ChatRequest, ChatRequestPreferences } from '../../infrastructure/api/routes.js';
import { ASSISTANT_MAX_QUESTION } from './assistantCopy.js';
import type { AssistantFailure } from './assistantCopy.js';

/** What went wrong with the question itself, before anything left the device. */
export type AssistantValidation = 'empty' | 'too-long';

export type AssistantTurnState =
  | { readonly kind: 'pending' }
  /** `answered: true`. The model phrased it and containment passed. */
  | {
      readonly kind: 'answered';
      readonly answer: string;
      readonly citations: readonly Citation[];
    }
  /** `answered: false` — **a successful answer**, 200 with `source: 'local'`. Not a failure. */
  | { readonly kind: 'no-information'; readonly answer: string }
  | { readonly kind: 'failed'; readonly failure: AssistantFailure };

export interface AssistantTurn {
  /**
   * A per-mount counter, and deliberately not the question or a hash of it.
   *
   * It is a React key and a test id, so it must be stable and unique within the transcript; two
   * identical questions are two turns. Nothing outside this component ever sees it, and it is
   * gone when the screen unmounts, which is the whole point.
   */
  readonly id: number;
  readonly question: string;
  readonly state: AssistantTurnState;
}

/**
 * The narrow preference set the chat lane takes — `diet`, `allergies`, `dislikedIngredients`.
 *
 * **Narrowed here, before the post, because the server returns 400 on `goal` or `budget`**
 * (`chatRequestSchema` is a `z.strictObject`; TSD §5.4, Plan §11.6) and avoiding that rejection is
 * the client's job. Retrieval reads none of the other fields, so sending them would be a required
 * field that changes nothing — which is a field that will eventually be believed.
 *
 * Destructured rather than spread-and-delete, so a field added to `UserPreferences` cannot leak
 * into the request by default: it has to be named here to travel. That matters more than usual on
 * this route, where PRD §10.3 bounds what may leave the device at all.
 */
export function selectChatPreferences(preferences: UserPreferences): ChatRequestPreferences {
  const { diet, allergies, dislikedIngredients } = preferences;
  return { diet, allergies, dislikedIngredients };
}

/**
 * The 500-character bound, measured the way the server measures it.
 *
 * `chatRequestSchema` is `z.string().trim().min(1).max(500)`, so the length that counts is the
 * *trimmed* one: a 500-character question with trailing spaces is accepted there and must be
 * accepted here. Being stricter than the server would reject a question the server would have
 * answered; being looser would spend the round trip to learn a number this module already knows.
 * The suite asserts the two agree over a table of inputs rather than restating the rule.
 */
export function validateQuestion(question: string): AssistantValidation | null {
  const trimmed = question.trim();
  if (trimmed === '') {
    return 'empty';
  }
  return trimmed.length > ASSISTANT_MAX_QUESTION ? 'too-long' : null;
}

/**
 * Every `ApiErrorCode` the server can answer with, mapped to a state this screen can render.
 *
 * **Keyed by `ApiErrorCode`, so a sixth server code cannot ship without a decision here.** The
 * three that matter are the three 503s: `ai_disabled`, `ai_unavailable` and `ai_busy` share a
 * status and mean different things, so they map to three different failures and three different
 * sets of words (T-21-07).
 *
 * `meal_not_found` is unreachable on this route and maps to the generic failure rather than being
 * omitted, for the reason `chatCopy.ts` gives about its own record: a table with a hole is a table
 * that will one day be indexed into the hole.
 */
const FAILURE_FOR_CODE: Readonly<Record<ApiErrorCode, AssistantFailure>> = {
  invalid_request: 'rejected',
  meal_not_found: 'failed',
  ai_disabled: 'disabled',
  ai_unavailable: 'unavailable',
  ai_busy: 'busy',
};

/**
 * Looked up by iteration rather than by index, because `ApiClientError.code` is `string | null`.
 *
 * It is `string` on purpose (X-20): the server's own 500 carries `internal_error`, a sixth code
 * the union does not name, and an unknown code must arrive intact and fall back to generic copy
 * rather than being parsed away into an unreadable response.
 */
function failureForCode(code: string | null): AssistantFailure {
  for (const [known, failure] of Object.entries(FAILURE_FOR_CODE)) {
    if (known === code) {
      return failure;
    }
  }
  return 'failed';
}

/**
 * Which state a thrown error becomes.
 *
 * `unreachable` and `timeout` both read as offline, which is the mapping Home's `stateForError`
 * already uses — the client's `ask` deadline is 35 s against the server's 30 s chat budget
 * (`ROUTE_TIMEOUTS_MS`), so a client timeout means the request never came back at all. **Nothing
 * from `error.message` or `error.wire` is ever rendered** (PRD §12): the only thing read off the
 * error is `kind` and `code`.
 */
export function failureFor(error: unknown): AssistantFailure {
  if (!isApiClientError(error)) {
    return 'failed';
  }
  if (error.kind === 'unreachable' || error.kind === 'timeout') {
    return 'offline';
  }
  return failureForCode(error.code);
}

/**
 * `answered` decides, and the model's own opinion is not consulted.
 *
 * The flag is the *endpoint's* statement about whether the domain resolved an answer — the route
 * deliberately does not read the model reply's `answered` field — so this is the one field that
 * says which of two correct outcomes arrived. Citations are dropped on the `false` branch because
 * such an answer drew on nothing (PRD §7.3 cites nothing, and the route sends `citations: []`);
 * listing meals beside "I do not have that information" would present them as evidence for a
 * refusal.
 */
export function stateForResponse(response: ChatResponse): AssistantTurnState {
  return response.answered
    ? { kind: 'answered', answer: response.answer, citations: response.citations }
    : { kind: 'no-information', answer: response.answer };
}

export interface UseAssistantOptions {
  readonly client: ApiClient;
  readonly preferences: UserPreferences;
  /** `AssistantParams.seedQuestion` from a deep link, which is why the bound is not the keyboard's. */
  readonly initialQuestion?: string;
}

export interface UseAssistantResult {
  readonly question: string;
  readonly setQuestion: (value: string) => void;
  readonly validation: AssistantValidation | null;
  /** Newest first. Local display state, never persisted. */
  readonly turns: readonly AssistantTurn[];
  readonly pending: boolean;
  readonly ask: () => void;
  /** Re-ask one turn's question in place, for the failures whose copy offers an action. */
  readonly retry: (turnId: number) => void;
}

export function useAssistant({
  client,
  preferences,
  initialQuestion = '',
}: UseAssistantOptions): UseAssistantResult {
  const [question, setQuestionValue] = useState(initialQuestion);
  const [validation, setValidation] = useState<AssistantValidation | null>(null);
  const [turns, setTurns] = useState<readonly AssistantTurn[]>([]);
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const inFlight = useRef<AbortController | null>(null);

  // Aborted on unmount, so a screen the user has left stops waiting on a 35-second deadline. The
  // client turns a caller's abort into the caller's own `AbortError` rather than a failure state,
  // and the guards below drop it either way.
  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const send = useCallback(
    (id: number, text: string): void => {
      /**
       * **The user's own AI switch, honoured locally — no request at all** (PRD §7.3:111: "Report
       * the assistant as unavailable — never substitute a generated answer — **when AI is off** or
       * Ollama cannot be reached").
       *
       * Two switches exist and they belong to two different people. `config.AI_ENABLED` is the
       * **operator's**, checked at TSD §5.4's step 4, and it arrives here as a 503 `ai_disabled`.
       * `preferences.aiEnabled` is the **user's**, and until this gate existed it governed Home's
       * explanations and did nothing at all for the assistant — Settings said "the assistant is
       * unavailable" with it off, and the assistant went on calling the model.
       *
       * **It is gated here rather than by putting `aiEnabled` on the wire**, and that is the
       * decision rather than the shortcut: `chatRequestSchema` is deliberately narrow because "a
       * required field that changes nothing is a field that will eventually be believed", and a
       * field the server *did* read would give one decision two sources that eventually disagree.
       * The client already knows the preference, so it spends no round trip to learn it.
       *
       * At the single choke point, so `ask` and `retry` both inherit it: a user who switches AI
       * off after a failed turn cannot press "Try again" past the gate either. And it reads the
       * **current** preference rather than one captured at mount, which is what the suite's
       * toggle-off-then-on control pins.
       */
      if (!preferences.aiEnabled) {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === id ? { ...turn, state: { kind: 'failed', failure: 'disabled' } } : turn,
          ),
        );
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      setPending(true);

      /**
       * Built here rather than in the screen, and **never from the whole preference set**.
       *
       * One question, the three retrieval fields, and nothing else — no transcript, no earlier
       * answer, no `aiEnabled`, no allergy list beyond the one retrieval consumes on the server.
       */
      const request: ChatRequest = {
        question: text,
        /**
         * **What "now" means, so "what can I eat right now?" has an answer.**
         *
         * Computed here on the device because the server holds no clock (TSD 5.4), through the
         * same `mealPeriodNow` Home uses - which is what makes `useRecommendations`'s claim that
         * the two "cannot disagree about what time it is" true rather than aspirational.
         *
         * Read at ASK time rather than memoised at mount: a transcript left open across the
         * boundary between lunch and dinner should answer about dinner, and an assistant that
         * answered about lunch because that is when the screen opened would be quietly wrong in
         * the one way this field exists to prevent.
         */
        mealPeriod: mealPeriodNow(new Date(), preferences.mealTimes),
        preferences: selectChatPreferences(preferences),
      };

      void (async () => {
        try {
          const response = await client.ask(request, controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          setTurns((current) =>
            current.map((turn) =>
              turn.id === id ? { ...turn, state: stateForResponse(response) } : turn,
            ),
          );
        } catch (error: unknown) {
          if (controller.signal.aborted) {
            return;
          }
          setTurns((current) =>
            current.map((turn) =>
              turn.id === id
                ? { ...turn, state: { kind: 'failed', failure: failureFor(error) } }
                : turn,
            ),
          );
        } finally {
          // Only the request that is still the current one clears the flag: a superseded
          // controller finishing later must not report the live one as done.
          if (inFlight.current === controller) {
            inFlight.current = null;
            setPending(false);
          }
        }
      })();
    },
    [client, preferences],
  );

  const setQuestion = useCallback((value: string): void => {
    setQuestionValue(value);
    // The correction clears the complaint. A validation message that outlives the text it was
    // about is a message the user cannot act on.
    setValidation(null);
  }, []);

  const ask = useCallback((): void => {
    // **One question in flight at a time, as a property of the hook rather than of the button.**
    // TSD §5.5 gives the server one AI call process-wide, so a second concurrent ask could only
    // ever come back `ai_busy`; refusing it here costs the user nothing and keeps the abort
    // bookkeeping to a single controller.
    if (pending) {
      return;
    }
    const problem = validateQuestion(question);
    if (problem !== null) {
      setValidation(problem);
      return;
    }
    setValidation(null);
    const id = nextId.current;
    nextId.current += 1;
    // Trimmed, because that is the length that was checked and the text the server will measure.
    const text = question.trim();
    // Newest first: the input sits at the top of the screen and nothing here scrolls itself, so
    // an answer appended below the previous ten would land off-screen.
    setTurns((current) => [{ id, question: text, state: { kind: 'pending' } }, ...current]);
    setQuestionValue('');
    send(id, text);
  }, [pending, question, send]);

  const retry = useCallback(
    (turnId: number): void => {
      if (pending) {
        return;
      }
      const turn = turns.find((candidate) => candidate.id === turnId);
      if (turn === undefined) {
        return;
      }
      setTurns((current) =>
        current.map((candidate) =>
          candidate.id === turnId ? { ...candidate, state: { kind: 'pending' } } : candidate,
        ),
      );
      send(turnId, turn.question);
    },
    [pending, turns, send],
  );

  return { question, setQuestion, validation, turns, pending, ask, retry };
}
