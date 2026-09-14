/**
 * One entry in the transcript: the question, and whichever of the four outcomes it reached
 * (T-21-06, T-21-07).
 *
 * Split out of `AssistantScreen.tsx` for the reason Explore's and Home's rows are: a row rendering
 * a state component, a heading and up to five buttons re-renders whenever the screen does — which
 * on this screen is on every keystroke, because the input is screen state. `memo` here and the
 * two handlers being `useCallback`s there is what makes that boundary real.
 *
 * **The four outcomes are four different surfaces, deliberately.** PRD §12 requires each state to
 * say what happened, what still works and what to do next, and T-21-07 exists because the two that
 * are easiest to conflate must not be:
 *
 *  - `answered: true` is the answer, with its citations beside it;
 *  - `answered: false` is **also an answer** — 200, `source: 'local'` — and is rendered in the
 *    `info` tone with the `info` glyph, framed as an answer the assistant gave;
 *  - a failure is rendered in its own tone, with a glyph and a title and a description no other
 *    state repeats (`assistantCopy.test.ts` asserts both sets are distinct).
 *
 * The glyph is what carries the difference where colour cannot: PRD §10.5 forbids colour as the
 * only carrier of a status, and `StatusMessage` makes `icon` required for exactly that reason.
 */

import { memo, useCallback } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { Citation } from '@nutritime/contracts';
import {
  AccessibleButton,
  AppText,
  ErrorState,
  OfflineState,
  StatusMessage,
} from '../../shared/components/index.js';
import type { IconName, StatusTone } from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import { ASSISTANT_COPY, ASSISTANT_FAILURE_COPY } from './assistantCopy.js';
import type { AssistantFailure } from './assistantCopy.js';
import type { AssistantTurn } from './useAssistant.js';

/**
 * Which shared state component each failure wears, and with which glyph.
 *
 * Keyed by `AssistantFailure`, so a seventh failure cannot render as a blank. **The four banner
 * entries carry four different glyphs**, which is the non-colour half of PRD §10.5 — and the pair
 * that matters is `unavailable` against the `info` glyph the `answered: false` state uses below.
 * `unavailable` shares `danger` with `ErrorState`'s own mark, which is deliberate rather than an
 * oversight: both are failures of the thing that was asked, and no single condition renders both.
 *
 * `offline` and `failed` reuse `OfflineState` and `ErrorState` rather than a tinted banner,
 * because that is what Home and Explore already do for the same two conditions and a third
 * spelling of "the server is unreachable" would be a third thing for a user to learn. TSD §6.7's
 * inventory is sixteen components and this screen authors no seventeenth.
 */
type FailurePresentation =
  | { readonly surface: 'status'; readonly tone: StatusTone; readonly icon: IconName }
  | { readonly surface: 'offline' }
  | { readonly surface: 'error' };

const FAILURE_PRESENTATION: Readonly<Record<AssistantFailure, FailurePresentation>> = {
  // The model is switched off. Caution, not failure: nothing is broken.
  disabled: { surface: 'status', tone: 'warning', icon: 'warning' },
  // The model did not answer. This one IS a failure of the thing that was asked.
  unavailable: { surface: 'status', tone: 'danger', icon: 'danger' },
  // Another question holds the lane. A clock, because the state resolves by waiting.
  busy: { surface: 'status', tone: 'info', icon: 'clock' },
  // The question itself was refused, which is the mark `FormField` uses for an invalid value.
  rejected: { surface: 'status', tone: 'warning', icon: 'alertCircle' },
  offline: { surface: 'offline' },
  failed: { surface: 'error' },
};

export interface AssistantTurnRowProps {
  readonly turn: AssistantTurn;
  /** PRD §10.1's first threshold has passed. Below it there is no loading surface at all. */
  readonly showLoading: boolean;
  /** PRD §10.1's second threshold has passed. */
  readonly showAiProgress: boolean;
  readonly onOpenMeal: (mealId: string) => void;
  readonly onRetry: (turnId: number) => void;
}

export const AssistantTurnRow = memo(function AssistantTurnRow({
  turn,
  showLoading,
  showAiProgress,
  onOpenMeal,
  onRetry,
}: AssistantTurnRowProps): ReactNode {
  const { components } = useTheme();
  const gap = components.card.gap;
  const { id, question, state } = turn;

  const retry = useCallback(() => {
    onRetry(id);
  }, [id, onRetry]);

  return (
    <View testID={`assistant-turn-${String(id)}`} style={{ alignSelf: 'stretch', gap }}>
      <AppText variant="label" tone="secondary">
        {ASSISTANT_COPY.questionHeading}
      </AppText>
      {/* The question as the user typed it, echoed on screen and nowhere else. */}
      <AppText variant="bodyStrong" testID={`assistant-turn-${String(id)}-question`}>
        {question}
      </AppText>

      {state.kind === 'pending' && showLoading ? (
        /*
          Words, not a bare spinner: PRD §12 wants the message to say what is happening, and the
          wait here is the retrieval and then the model, which is worth naming — and naming
          separately, because they are two different waits and the second is the long one.

          **PRD §10.1's escalation, and the whole of it.** Nothing before 200 ms (`showLoading`
          gates the surface itself, exactly as Home's `home-loading` is gated), the retrieval
          sentence from 200 ms, and the model sentence from 2 s. Until this existed the first
          sentence appeared instantly and then stood unchanged for as long as the request took —
          up to §10.1's own 30 s hard timeout on a cold model, which is the case that paragraph is
          about.

          **It is text, so reduce-motion does not touch it** (T-23-06). That composition is the
          point rather than an accident: a user who has asked for less motion loses the spinner in
          `AccessibleButton` and keeps every word of this, which is the only escalation signal they
          have left. A design that had put the escalation in the animation would have removed the
          progress report from exactly the people who most need a still one.

          One `testID` for both stages rather than two, so a test has to read the words to tell
          them apart — the same choice `Home.dom.test.tsx` makes against `home-loading`.
        */
        <AppText variant="body" tone="secondary" testID={`assistant-turn-${String(id)}-pending`}>
          {showAiProgress ? ASSISTANT_COPY.aiProgress : ASSISTANT_COPY.submitting}
        </AppText>
      ) : null}

      {state.kind === 'answered' ? (
        <View testID={`assistant-turn-${String(id)}-answer`} style={{ gap }}>
          <AppText variant="label" tone="secondary">
            {ASSISTANT_COPY.answerHeading}
          </AppText>
          <AppText variant="body">{state.answer}</AppText>
          <Citations citations={state.citations} turnId={id} onOpenMeal={onOpenMeal} />
        </View>
      ) : null}

      {state.kind === 'no-information' ? (
        /*
          `tone="info"` and the `info` glyph, and `description` is the SERVER's answer text.
          `chatCopy.ts` authored those words as fixed local copy under PRD §12, so they are the
          answer and they are shown as it; the title and the note are this screen's framing. An
          `answered: false` painted in `warning` or `danger` would tell the user the app is broken
          at the moment it answered them correctly.
        */
        <StatusMessage
          testID={`assistant-turn-${String(id)}-no-information`}
          tone="info"
          icon="info"
          title={ASSISTANT_COPY.noInformation.title}
          description={state.answer}
          stillAvailable={ASSISTANT_COPY.noInformation.stillAvailable}
          announceOnMount
        />
      ) : null}

      {state.kind === 'failed' ? (
        <View testID={`assistant-turn-${String(id)}-failure`}>
          <FailureSurface failure={state.failure} turnId={id} onRetry={retry} />
        </View>
      ) : null}
    </View>
  );
});

interface CitationsProps {
  readonly citations: readonly Citation[];
  readonly turnId: number;
  readonly onOpenMeal: (mealId: string) => void;
}

/**
 * The cited meals, beside the answer they came from (T-21-06, PRD §7.3).
 *
 * **Rendered from `ChatResponse.citations` and from nothing else.** The server resolves them from
 * `resolved.namedMeals` by id and never parses them out of the answer text (T-21-03), so a meal
 * name the model wrote into its prose cannot become a tappable link here. This component has no
 * access to the answer string, which is what keeps that true on this side too.
 *
 * Each one reaches the meal: `MealDetails` takes `{ mealId, origin }` and `NAVIGATION_ORIGINS`
 * includes `'assistant'` precisely for this screen.
 *
 * Nothing at all when the list is empty — not an empty heading, and not "no citations". An answer
 * the domain resolved without naming a meal has nothing to cite, and a heading over nothing reads
 * as a citation that failed to load.
 */
function Citations({ citations, turnId, onOpenMeal }: CitationsProps): ReactNode {
  const { components } = useTheme();
  if (citations.length === 0) {
    return null;
  }
  return (
    <View
      testID={`assistant-turn-${String(turnId)}-citations`}
      style={{ alignSelf: 'stretch', gap: components.card.gap }}
    >
      <AppText variant="label" tone="secondary">
        {ASSISTANT_COPY.citationsHeading}
      </AppText>
      {/* Wraps rather than scrolling sideways, for the reason Explore's chip row does: a row that
          scrolls hides its own tail, and at a 2x font scale no row is long enough anyway. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: components.card.gap }}>
        {citations.map((citation) => (
          <CitationButton key={citation.mealId} citation={citation} onOpenMeal={onOpenMeal} />
        ))}
      </View>
    </View>
  );
}

interface CitationButtonProps {
  readonly citation: Citation;
  readonly onOpenMeal: (mealId: string) => void;
}

/**
 * One citation.
 *
 * Its own component so the `onPress` closure is per-citation and stable, rather than a fresh
 * arrow allocated for every citation on every render of the row.
 *
 * `AccessibleButton` rather than `Chip`: a citation is not a two-state control, and the button is
 * built to `touch.buildTo` (48) on both axes, which PRD §10.5 requires. The visible label is the
 * meal's name, so the hint carries what pressing it does — `accessibilityLabel` is left to default
 * to the label, because a label that differed from the visible text would be two statements about
 * one control.
 */
function CitationButton({ citation, onOpenMeal }: CitationButtonProps): ReactNode {
  const onPress = useCallback(() => {
    onOpenMeal(citation.mealId);
  }, [citation.mealId, onOpenMeal]);

  return (
    <AccessibleButton
      testID={`assistant-citation-${citation.mealId}`}
      label={citation.name}
      variant="secondary"
      icon="chevronRight"
      accessibilityHint={ASSISTANT_COPY.citationHint}
      onPress={onPress}
    />
  );
}

interface FailureSurfaceProps {
  readonly failure: AssistantFailure;
  readonly turnId: number;
  readonly onRetry: () => void;
}

/**
 * One failure, in its own words.
 *
 * The copy comes from `ASSISTANT_FAILURE_COPY` keyed by the failure, so the six sets of words
 * cannot be confused with each other or with the `answered: false` framing above. `actionLabel`
 * being `null` withholds the control rather than disabling it: a "Try again" against a model that
 * is switched off is a button that cannot work.
 */
function FailureSurface({ failure, turnId, onRetry }: FailureSurfaceProps): ReactNode {
  const copy = ASSISTANT_FAILURE_COPY[failure];
  const presentation = FAILURE_PRESENTATION[failure];
  const testID = `assistant-turn-${String(turnId)}-${failure}`;
  const action = copy.actionLabel;

  if (presentation.surface === 'offline') {
    return (
      <OfflineState
        testID={testID}
        title={copy.title}
        description={copy.description}
        stillAvailable={copy.stillAvailable}
        {...(action === null ? {} : { retryLabel: action, onRetry })}
      />
    );
  }

  if (presentation.surface === 'error') {
    return (
      <ErrorState
        testID={testID}
        title={copy.title}
        description={copy.description}
        stillAvailable={copy.stillAvailable}
        {...(action === null ? {} : { retryLabel: action, onRetry })}
      />
    );
  }

  return (
    <StatusMessage
      testID={testID}
      tone={presentation.tone}
      icon={presentation.icon}
      title={copy.title}
      description={copy.description}
      stillAvailable={copy.stillAvailable}
      announceOnMount
      {...(action === null ? {} : { actionLabel: action, onAction: onRetry })}
    />
  );
}
