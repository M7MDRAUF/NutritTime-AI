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
 */

import { useCallback } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { AccessibleButton, AppText, EmptyState, FormField } from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { preferencesStore } from '../../state/preferences/index.js';
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
        loading={pending}
        onPress={ask}
      />

      <AppText variant="caption" tone="tertiary" testID="assistant-privacy">
        {ASSISTANT_COPY.privacyNote}
      </AppText>

      {/*
        A live region, so an answer that arrives after the user has moved on is announced rather
        than discovered. Both spellings, for the reason `Chip` and `StatusMessage` give: Android
        reads `accessibilityLiveRegion`, the web export and this suite read `aria-live`, and
        react-native-web 0.21 maps neither from the other.
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
            <AssistantTurnRow key={turn.id} turn={turn} onOpenMeal={openMeal} onRetry={retry} />
          ))
        )}
      </View>
    </ScrollView>
  );
}
