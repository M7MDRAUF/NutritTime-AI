/**
 * Assistant (T-21-05 … T-21-07) — the last route in the app without a screen.
 *
 * TSD §6.8: the data is `POST /chat` and the states are loading, unavailable and answered-false.
 * The server half shipped with `apps/server/src/routes/chat.ts`; this is what the user sees.
 *
 * **Three properties matter more than the layout.**
 *
 * 1. **The transcript is local display state and nothing else** (PRD §7.3, §10.3). It lives in
 *    `useAssistant`'s `useState`; this feature declares no store, writes no storage key and calls
 *    `createStore` nowhere. A stored transcript is a stored question.
 * 2. **The 500-character bound is enforced on this side** (PRD FR-015). `maxLength` stops the
 *    keyboard and `validateQuestion` stops everything else, including a deep link's
 *    `seedQuestion`, which never passes a keyboard at all.
 * 3. **`answered: false` is a successful answer**, not an error, and is rendered as one.
 *
 * **Two AI switches, and only one of them is the server's.** `config.AI_ENABLED` is the operator's
 * and arrives as a 503; `preferences.aiEnabled` is the user's, and `useAssistant` gates on it
 * locally — no request, the turned-off state, and no `aiEnabled` field on the wire (PRD §7.3).
 *
 * **The preferences are narrowed before the post.** `chatRequestSchema` is a `z.strictObject`, so
 * a `goal` or a `budget` inside `preferences` is a 400 (TSD §5.4) — avoiding that rejection is the
 * client's job, and `selectChatPreferences` is where it happens. It is not the recommendation
 * request's preference set with two fields dropped; it is its own, narrower thing.
 *
 * This screen reads the catalog on the user's behalf and is not a nutrition advisor (PRD §7.3):
 * nothing it says — here or in `assistantCopy.ts` — claims a meal is allergen-free or makes any
 * health or medical claim, and the suite runs every string through a transcription of TSD §5.7's
 * denied phrases, because containment guards the model and not us.
 *
 * **PRD §10.1's two waiting thresholds are enforced here** — see `useRequestProgress`. Before them
 * this screen showed one static sentence for as long as the request took, which against §10.1's own
 * assistant row ("~11 s, hard timeout 30 s") and the cold-model paragraph above it meant up to half
 * a minute with no escalation at all.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { AccessibleButton, AppText, EmptyState, FormField } from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { preferencesStore } from '../../state/preferences/index.js';
// **The thresholds are IMPORTED, not retyped.** PRD §10.1 states them once and this repository
// already holds them once, beside Home's request. A second pair of literals here is the shape this
// project has been bitten by before — three copies of one failure-to-outcome mapping, two of them
// already diverged — so the coupling to a sibling feature is deliberately preferred to a fourth
// copy. The right home is a module neither feature owns; that edit is filed rather than taken,
// because `features/home/**` is not this agent's to restructure.
import { AI_PROGRESS_AFTER_MS, LOADING_AFTER_MS } from '../home/useRecommendations.js';
import { AssistantTurnRow } from './AssistantTurnRow.js';
import {
  ASSISTANT_COPY,
  ASSISTANT_MAX_QUESTION,
  charactersLeft,
  questionHint,
  questionTooLongMessage,
} from './assistantCopy.js';
import { useAssistant } from './useAssistant.js';
import type { AssistantValidation } from './useAssistant.js';

/** The message for each validation state, keyed so a third cannot arrive without words. */
function validationMessage(validation: AssistantValidation): string {
  return validation === 'empty'
    ? ASSISTANT_COPY.emptyQuestion
    : questionTooLongMessage(ASSISTANT_MAX_QUESTION);
}

export interface RequestProgress {
  /** True once the request has been in flight past PRD §10.1's first threshold. */
  readonly showLoading: boolean;
  /** True once it has been in flight past the second. */
  readonly showAiProgress: boolean;
}

/**
 * PRD §10.1: "The UI shows a loading state after 200 ms and an AI-progress message after 2 s."
 *
 * **Derived from `pending` rather than armed inside `useAssistant.send`**, and that is the decision
 * rather than the shortcut. `pending` is the same flag the transcript row and the Ask button read,
 * so the escalation cannot drift out of step with the state it describes, and it inherits that
 * flag's termination for free: `send`'s `finally` clears `pending` on every path — answer, refusal,
 * failure, abort — so there is no exit through which a message could be left on screen. A pair of
 * timers owned by the request would have to repeat that bookkeeping and could disagree with it.
 *
 * **The AI-progress message needs no `aiEnabled` branch here, unlike Home's.** `useAssistant` gates
 * the user's own switch *before* setting `pending`, so a pending turn on this screen always means a
 * request went to the model — which is what makes the second sentence true when it is shown. The
 * suite pins that rather than trusting it: with AI off there is no request, no pending state and no
 * escalation at any elapsed time.
 *
 * Effects, not `setTimeout` in a handler, so React clears both timers on unmount; a user who
 * leaves the tab mid-question does not get a state update after the screen is gone.
 */
function useRequestProgress(pending: boolean): RequestProgress {
  const [showLoading, setShowLoading] = useState(false);
  const [showAiProgress, setShowAiProgress] = useState(false);

  useEffect(() => {
    if (!pending) {
      // Reset rather than leave: a second question must start from nothing, or its first 200 ms
      // would inherit the previous answer's escalation.
      setShowLoading(false);
      setShowAiProgress(false);
      return;
    }
    const loadingTimer = setTimeout(() => {
      setShowLoading(true);
    }, LOADING_AFTER_MS);
    const aiTimer = setTimeout(() => {
      setShowAiProgress(true);
    }, AI_PROGRESS_AFTER_MS);
    return () => {
      clearTimeout(loadingTimer);
      clearTimeout(aiTimer);
    };
  }, [pending]);

  return { showLoading, showAiProgress };
}

export function AssistantScreen({ route, navigation }: ScreenProps<'Assistant'>): ReactNode {
  const client = useApiClient();
  const { colors, components } = useTheme();
  const preferences = preferencesStore.useValue();

  /**
   * A deep link's question seeds the input and is then owned by the screen.
   *
   * Read once as the initial value rather than tracked, for the reason Explore reads its `query`
   * that way: a screen that re-derived its state from `route.params` on every render would fight
   * the user's typing. **It is not trusted for length** — `AssistantParams.seedQuestion` is a
   * string off a URL, so the bound in `useAssistant` is what stands between it and the request.
   */
  const { question, setQuestion, validation, turns, pending, ask, retry } = useAssistant({
    client,
    preferences: preferences.preferences,
    ...(route.params?.seedQuestion === undefined
      ? {}
      : { initialQuestion: route.params.seedQuestion }),
  });

  const { showLoading, showAiProgress } = useRequestProgress(pending);

  const openMeal = useCallback(
    (mealId: string) => {
      // `'assistant'` exists in `NAVIGATION_ORIGINS` for this screen and nothing else: one
      // `MealDetails` on the root stack, reachable from four places, which is why the origin is a
      // param rather than implied by the stack.
      navigation.navigate('MealDetails', { mealId, origin: 'assistant' });
    },
    [navigation],
  );

  return (
    <ScrollView
      testID="assistant-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
    >
      <AppText variant="title" tone="primary" level={1} testID="assistant-heading">
        {ASSISTANT_COPY.heading}
      </AppText>

      <FormField
        testID="assistant-question"
        label={ASSISTANT_COPY.questionLabel}
        value={question}
        onChangeText={setQuestion}
        placeholder={ASSISTANT_COPY.questionPlaceholder}
        hint={questionHint(ASSISTANT_MAX_QUESTION)}
        // PRD FR-015's bound, at the keyboard. `useAssistant` holds the other half, for the text
        // that never came through a keyboard.
        maxLength={ASSISTANT_MAX_QUESTION}
        multiline
        {...(validation === null ? {} : { error: validationMessage(validation) })}
      />

      {/* The live count, visible rather than folded into the field's accessible name — see
          `questionHint`. It is the field's own bound counted down, so it is never negative:
          `maxLength` refuses the 501st character. */}
      <AppText variant="caption" tone="tertiary" testID="assistant-remaining">
        {charactersLeft(ASSISTANT_MAX_QUESTION - question.length)}
      </AppText>

      <AccessibleButton
        testID="assistant-ask"
        label={ASSISTANT_COPY.askLabel}
        variant="primary"
        accessibilityHint={ASSISTANT_COPY.askHint}
        // `loading` makes the button inert and announces `busy`, which is the right pair while a
        // question is in flight: one AI call runs at a time server-side (TSD §5.5), so a second
        // press could only ever come back `ai_busy`.
        //
        // **`pending`, not `showLoading`, and deliberately.** PRD §10.1's 200 ms is about *feedback*
        // — below it a message is flicker rather than information — and it is carried by the
        // transcript row below. Inertness is *correctness* and has to hold from the first
        // millisecond, because the press that must not happen twice is the one a user makes
        // immediately. The visible half of this button's busy state is `AccessibleButton`'s, and it
        // honours the OS reduce-motion setting there (T-23-06).
        loading={pending}
        onPress={ask}
      />

      <AppText variant="caption" tone="tertiary" testID="assistant-privacy">
        {ASSISTANT_COPY.privacyNote}
      </AppText>

      {/*
        A live region, so an answer that arrives after the user has moved on is announced rather
        than discovered.

        **Both spellings, and the reason recorded here before was false — RETRACTED.** The old note
        read *"react-native-web 0.21 maps neither from the other"*. It does map one from the other.
        Read from the shipped source at the pinned version, `react-native-web` **0.21.2**
        (version from `node_modules/react-native-web/package.json`),
        `node_modules/react-native-web/dist/modules/createDOMProps/index.js:460-462`:

            var _ariaLive = ariaLive != null ? ariaLive : accessibilityLiveRegion;
            if (_ariaLive != null) {
              domProps['aria-live'] = _ariaLive === 'none' ? 'off' : _ariaLive;
            }

        So on the web export `accessibilityLiveRegion="polite"` alone would have produced
        `aria-live="polite"`, with `'none'` rewritten to `'off'`. The deprecation `warnOnce` for the
        RN spelling is itself commented out at :452-459, so setting both is silent.

        **Both are still set, for the reason that is true:** `accessibilityLiveRegion` is the
        Android API and `aria-live` is a no-op on native, so native needs the RN spelling; on the
        web the explicit `aria-live` simply wins the `!=` test above. The props are right — only the
        rationale was wrong.

        **And the attribution was wrong too.** `StatusMessage.tsx` says the OPPOSITE of what this
        comment credited it with (*"`accessibilityLiveRegion` IS mapped to `aria-live` there, with
        `'none'` rewritten to `'off'`"*), and `Chip.tsx`'s *"maps none of it"* is about a DIFFERENT
        prop, `accessibilityState`, where it is true — `grep -c accessibilityState` over
        `createDOMProps/index.js` is **0** at 0.21.2, and in `dist/` the token appears only in
        `TouchableWithoutFeedback` and `AccessibilityUtil/isDisabled.js`.

        Recorded rather than quietly reworded. That sentence was copied into **six** files, and this
        one held the **last surviving assertion** of it: the round that corrected the other five ran
        before this screen existed (P21, the newest production file in the tree), and the sentence
        was copied forward into it afterwards. So the tree carried the refutation twice
        (`ErrorState.tsx`, `FormField.tsx`) and the assertion once — in the file a reader of this
        lane opens first. A rationale that silently changes its story leaves nothing behind saying it
        was ever wrong, which is exactly how a copy survives five corrections; §6.1j.
      */}
      <View
        testID="assistant-transcript"
        accessibilityLiveRegion="polite"
        aria-live="polite"
        style={{ alignSelf: 'stretch', gap: components.card.padding }}
      >
        {turns.length === 0 ? (
          <EmptyState
            testID="assistant-idle"
            title={ASSISTANT_COPY.idleTitle}
            description={ASSISTANT_COPY.intro}
          />
        ) : (
          turns.map((turn) => (
            <AssistantTurnRow
              key={turn.id}
              turn={turn}
              showLoading={showLoading}
              showAiProgress={showAiProgress}
              onOpenMeal={openMeal}
              onRetry={retry}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}
