/**
 * Home (T-15-03 … T-15-06). Three meals for the time of day, and the disclaimer that qualifies them.
 *
 * **The meal period renders before any request, and with the server down** (T-15-01). It is
 * computed on the device by the domain's `mealPeriodForDate`, so the screen is never blank while it
 * waits — and TSD §5.4 keeps the clock here rather than on the server, because a server-side clock
 * would be wrong across time zones and untestable without one.
 *
 * **The disclaimer is a surface, not a footnote** (FR-007, T-15-06). It sits above the meals rather
 * than under them: a qualification a user has to scroll past three cards to find has not qualified
 * anything. It is `StatusMessage` in the `info` tone rather than `warning` — this is not an error
 * and it must not read as one, or it becomes the thing users learn to dismiss.
 */

import { memo, useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { formatMoney } from '@nutritime/domain';
import type { MealPeriod, Recommendation } from '@nutritime/contracts';
import {
  AppText,
  EmptyState,
  ErrorState,
  MealCard,
  OfflineState,
  StatusMessage,
} from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { useRecommendations } from './useRecommendations.js';

/** §11.5: "fixed at three". Restated here so the screen cannot render a fourth. */
const MAX_RECOMMENDATIONS = 3;

/** How the period reads in a greeting. Not `titleCase`: "Snack" is not a time of day. */
const PERIOD_HEADING: Readonly<Record<MealPeriod, string>> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Something small',
};

export interface HomeScreenProps extends ScreenProps<'Home'> {
  /** Injected so a test fixes the time rather than asking the machine what it is. */
  readonly now?: () => Date;
  /**
   * Bumped when the screen regains focus, by `HomeScreenWithFocus`.
   *
   * A prop rather than a `useFocusEffect` call in here, because that hook needs a route context —
   * and requiring one would mean no screen test could render Home without mounting a whole
   * navigator. The wrapper that supplies it is what the registry registers.
   */
  readonly focusEpoch?: number;
}

export function HomeScreen({ navigation, now, focusEpoch }: HomeScreenProps): ReactNode {
  const client = useApiClient();
  const { colors, components } = useTheme();
  const preferences = preferencesStore.useValue();
  const preferencesStatus = preferencesStore.useStatus();

  const { mealPeriod, state, showLoading, showAiProgress, reload } = useRecommendations({
    client,
    preferences,
    // P16 owns the favourites store; until then the request carries an empty list, which is a true
    // statement about a user who has favourited nothing rather than a placeholder.
    favoriteMealIds: [],
    ...(now === undefined ? {} : { now }),
    ...(focusEpoch === undefined ? {} : { focusEpoch }),
  });

  const openMeal = useCallback(
    (mealId: string) => {
      navigation.navigate('MealDetails', { mealId, origin: 'home' });
    },
    [navigation],
  );

  const name = preferences.preferences.name;

  return (
    <ScrollView
      testID="home-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
    >
      {/*
        Rendered from `mealPeriod`, which exists on the first render. No request has been made at
        this point and none needs to have been: T-15-01's acceptance is that this is here with the
        server down.
      */}
      <AppText variant="title" tone="primary" level={1} testID="home-period">
        {name === undefined ? PERIOD_HEADING[mealPeriod] : `${PERIOD_HEADING[mealPeriod]}, ${name}`}
      </AppText>

      {/* FR-007. Above the meals, because a qualification below them qualifies nothing. */}
      <StatusMessage
        testID="home-disclaimer"
        tone="info"
        icon="info"
        title="Check the label if it matters"
        description="Suggestions are filtered using the allergies you set, from a catalog that is neither complete nor verified. This is not medical advice."
      />

      {showLoading && state.kind === 'pending' ? (
        <AppText variant="body" tone="secondary" testID="home-loading">
          {showAiProgress ? 'Still writing your reasons…' : 'Finding meals for you…'}
        </AppText>
      ) : null}

      {/*
        **`recovered` means the stored profile was quarantined and reset to defaults**, allergies
        included. Surfaced here as well as on the setup form, because Home is where a user would
        otherwise see meals filtered by an empty allergy list and have no reason to doubt them.
      */}
      {preferencesStatus.entryStatus === 'recovered' ? (
        <StatusMessage
          testID="home-preferences-recovered"
          tone="warning"
          icon="alertCircle"
          title="Your preferences were reset"
          description="The saved copy could not be read, so your allergy list is empty. Set it again before relying on these suggestions."
        />
      ) : null}

      {/* Both states get a retry: PRD §10.1 says the first request after a restart may fail and
          then recover on its own, and Home is a tab screen that is never unmounted — so without
          this the only way out was to change a preference or restart. */}
      {state.kind === 'unreachable' ? (
        <OfflineState
          testID="home-offline"
          stillAvailable="Your saved meals and your own recipes are on this device and still work."
          retryLabel="Try again"
          onRetry={reload}
        />
      ) : null}

      {state.kind === 'failed' ? (
        <ErrorState
          testID="home-error"
          description="Suggestions could not be loaded."
          stillAvailable="Explore and your saved meals still work."
          retryLabel="Try again"
          onRetry={reload}
        />
      ) : null}

      {state.kind === 'loaded' && state.recommendations.length === 0 ? (
        <EmptyState
          testID="home-empty"
          title="Nothing fits right now"
          description="Every meal was ruled out by your allergies, diet or budget. Widening one of them will bring some back."
        />
      ) : null}

      {state.kind === 'loaded' && state.recommendations.length > 0 ? (
        <View testID="home-recommendations" style={{ gap: components.card.gap }}>
          {/*
            Sliced to `MAX_RECOMMENDATIONS`, although §11.5 fixes the response at three: the screen
            should not paint a fourth card if a future response carries one. PRD §13 says three, and
            a screen that renders whatever it is handed makes the contract the server's alone.
          */}
          {state.recommendations.slice(0, MAX_RECOMMENDATIONS).map((recommendation) => (
            <RecommendationRow
              key={recommendation.meal.id}
              recommendation={recommendation}
              onOpen={openMeal}
            />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

interface RecommendationRowProps {
  readonly recommendation: Recommendation;
  readonly onOpen: (mealId: string) => void;
}

/**
 * One recommendation, memoised for the same reason Explore's row is.
 *
 * **The fallback indicator is on the card, not in a legend.** T-15-04 requires the user to be able
 * to tell a deterministic explanation from a model-written one, and a key elsewhere on the screen
 * would make them map three cards to three symbols. `explanationSource` is per-recommendation, so
 * the marker is too.
 */
const RecommendationRow = memo(function RecommendationRow({
  recommendation,
  onOpen,
}: RecommendationRowProps): ReactNode {
  const { meal, explanation, explanationSource } = recommendation;
  const onPress = useCallback(() => {
    onOpen(meal.id);
  }, [meal.id, onOpen]);

  return (
    <View testID={`recommendation-${meal.id}`}>
      <MealCard
        testID={`meal-${meal.id}`}
        name={meal.name}
        imageUrl={meal.imageUrl}
        priceLabel={formatMoney(meal.price)}
        preparationMinutes={meal.preparationMinutes}
        tags={meal.dietTags}
        reason={explanation}
        unavailable={!meal.available}
        onPress={onPress}
      />
      {/*
        Only when it IS the fallback. Marking the model-written case as well would put a badge on
        every card and tell the user nothing — the default is the interesting one to name, because
        `explanationSource: 'fallback'` means no model saw this sentence.
      */}
      {explanationSource === 'fallback' ? (
        // The visible words are the whole message, so there is no `accessibilityLabel` to add -
        // and `AppText` exposes none, deliberately: a label that differed from the text would be
        // two different statements about the same sentence.
        <AppText variant="caption" tone="tertiary" testID={`explanation-source-${meal.id}`}>
          Written by the app
        </AppText>
      ) : null}
    </View>
  );
});

/**
 * `HomeScreen` with the focus half of the clock wired up — and what the registry registers.
 *
 * **The period was frozen for the life of the process**, because a bottom-tab screen is not
 * remounted on re-focus (`TabNavigator` sets no `unmountOnBlur`) and nothing re-read the time: an
 * app opened at 12:00 and resumed at 20:00 still said "Lunch". `useFocusEffect` fires whenever the
 * user comes back to this tab, which with the hook's own `AppState` listener covers both ways a
 * user returns to a screen.
 *
 * Separated from `HomeScreen` so a screen test can render Home without a navigator: `useFocusEffect`
 * throws without a route context, and requiring one would have made every Home assertion depend on
 * mounting the whole navigation tree.
 */
export function HomeScreenWithFocus(props: ScreenProps<'Home'>): ReactNode {
  const [focusEpoch, setFocusEpoch] = useState(0);
  useFocusEffect(
    useCallback(() => {
      setFocusEpoch((current) => current + 1);
    }, []),
  );
  return <HomeScreen {...props} focusEpoch={focusEpoch} />;
}
