/**
 * Meal Details (T-16-02 … T-16-07) — FR-011's nine fields, and the one screen in this app where a
 * meal that conflicts with the user's allergies is reachable **by design**.
 *
 * **That is what makes this a safety surface.** Recommendations reject a conflicting candidate
 * before scoring (FR-007) and the assistant rejects before retrieval (FR-015) — but Explore lists
 * the whole catalog, so a user who has declared a peanut allergy can tap `pad-see-ew` and arrive
 * here. This is the last place anything can warn them, so the notice **names which allergens
 * conflict**: "contains allergens" is a sentence a user cannot act on.
 *
 * **The notice, and every field of a loaded meal, live in `MealDetailsBody.tsx`** — split out at
 * SQG-09's cap with the orchestrator's authorisation, along the seam this file's own shape already
 * described: the screen owns the params, the request, the two stores and the five states, and the
 * body owns what a loaded `Meal` looks like. Read that module's docstring for why the allergen
 * match is the domain's and never a screen's; it is not restated here.
 *
 * **The favourites bound is checked before the dispatch, and that is not belt-and-braces.** At
 * `MAX_FAVORITES` the reducer returns `state` identically, so no write is attempted and
 * `saveBlocked` never fires: a screen trusting the press would have told the user their meal was
 * saved when nothing happened. The refusal is decided and said here, **with no retry** — TSD §6.4,
 * retrying the same value can never succeed. Removing a favourite still works at the bound,
 * because a remove allocates the shorter list that queues the write.
 *
 * `presentation: 'modal'` is configured in `RootNavigator.tsx`. This screen supplies the dismiss
 * affordance and returns to the origin, read with `readUnionParam` because it may have come off a
 * deep link and is then a string the type system never saw.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import {
  AppText,
  EmptyState,
  ErrorState,
  IconButton,
  OfflineState,
  StatusMessage,
} from '../../shared/components/index.js';
import { useApiClient } from '../../infrastructure/api/ApiProvider.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { ScreenProps } from '../../navigation/registry.js';
import { NAVIGATION_ORIGINS, readStringParam, readUnionParam } from '../../navigation/routes.js';
import type { NavigationOrigin, TabParamList } from '../../navigation/routes.js';
import {
  MAX_FAVORITES,
  favoritesActions,
  favoritesStore,
  isFavorite,
  selectAtFavoritesBound,
  selectFavoriteIds,
} from '../../state/favorites/index.js';
import { MealDetailsBody } from './MealDetailsBody.js';
import { useMealDetails } from './useMealDetails.js';

/**
 * Which tab each origin belongs to (TSD §6.2). `satisfies` a total record over `NavigationOrigin`,
 * so an origin added to `NAVIGATION_ORIGINS` stops compiling here rather than quietly going Home.
 */
const ORIGIN_TABS = {
  home: 'HomeTab',
  explore: 'ExploreTab',
  saved: 'SavedTab',
  assistant: 'AssistantTab',
} as const satisfies Readonly<Record<NavigationOrigin, keyof TabParamList>>;

/** Where a dismiss goes when the link that opened this screen left nothing behind it. */
const DEFAULT_ORIGIN: NavigationOrigin = 'home';

/** Fixed local copy, every sentence. Nothing here is built from a wire or a driver string. */
const COPY = {
  loading: 'Loading this meal…',
  notFoundTitle: 'This meal is not in the catalog',
  notFoundDescription:
    'It may have been removed since this link was made, or the id may be wrong. There is nothing to retry — the meal is gone rather than unreachable.',
  notFoundStillAvailable: 'Everything you have saved is on this device and still works.',
  offlineDescription: 'This meal is on the server, and the server could not be reached.',
  offlineStillAvailable:
    'Your saved meals and your own recipes are on this device and still work, and your favourites can still be changed.',
  failedDescription: 'This meal could not be loaded.',
  failedStillAvailable: 'Your saved meals and your own recipes still work.',
  dismiss: 'Close meal details',
  back: 'Go back',
  addFavorite: 'Add to favourites',
  removeFavorite: 'Remove from favourites',
  savedNote: 'Saved to favourites',
  unsavedNote: 'Not in your favourites',
  boundTitle: 'Your favourites list is full',
  boundStillAvailable:
    'Every favourite you already have still works, and each one can still be removed from its own page.',
  recoveredTitle: 'Your saved favourites were reset',
  recoveredDescription:
    'The stored list could not be read, so it was emptied. Anything you had saved needs saving again.',
  truncatedTitle: 'Your favourites list was shortened',
  saveErrorTitle: 'Your favourites are not saved',
  retry: 'Try again',
} as const;

export function MealDetailsScreen({ route, navigation }: ScreenProps<'MealDetails'>): ReactNode {
  const client = useApiClient();
  const { colors, components } = useTheme();
  const [nonce, setNonce] = useState(0);

  /**
   * Read, not taken from the declared type: a param parsed out of a URL is a string the type
   * system never saw. A blank id needs no branch of its own — it reaches the server, which answers
   * 404, and `notFound` is the truth about a malformed link.
   */
  const mealId = readStringParam(route.params, 'mealId') ?? '';
  const origin = readUnionParam(route.params, 'origin', NAVIGATION_ORIGINS) ?? DEFAULT_ORIGIN;

  const state = useMealDetails({ client, mealId, nonce });
  const favorites = favoritesStore.useValue();
  const favoritesDispatch = favoritesStore.useDispatch();
  const favoritesStatus = favoritesStore.useStatus();

  const saved = isFavorite(favorites, mealId);
  /** The add the reducer would refuse silently. A remove is never refused — see the docstring. */
  const addRefused = selectAtFavoritesBound(favorites) && !saved;

  /**
   * **One surface, two sources — and only one of them can still fire.**
   *
   * TSD §6.3 publishes `saveBlocked` as "the case the UI must present differently", so it stays
   * wired here rather than deleted. But the reducers were hardened to refuse at the bound
   * (CONTRACTS §1: `favorites/added` returns `state` identically at `MAX_FAVORITES`), which means
   * `repository.set` is never handed an over-long value and never throws `bound-exceeded` — so
   * `saveBlocked` is unreachable today, for every key. A branch of its own would have been dead UI
   * reading as coverage, which is what P14 removed an unreachable error surface for.
   *
   * `selectAtFavoritesBound` is the reachable source and the one the tests drive; `saveBlocked` is
   * the same message arriving from the write path, kept so that a storage condition returning one
   * day lands on a surface that already exists and is already tested rather than on nothing.
   */
  const listFull = state.kind === 'loaded' && (addRefused || favoritesStatus.saveBlocked);

  /**
   * How many favourites hydration produced, captured once.
   *
   * **`EntryStatus` carries one value for two outcomes**, and the copy has to tell them apart: a
   * quarantined entry always returns the empty fallback, while an over-long entry is TRUNCATED on
   * read (TSD §6.4 — reads truncate, they never refuse). So a `recovered` list that arrived
   * **non-empty** can only be a truncation, and telling that user their list "could not be read, so
   * it was emptied" while their favourites render below the message is a message the screen itself
   * contradicts.
   *
   * Captured at mount rather than recomputed, so a user who removes every favourite in this session
   * does not flip the message to the other wording. `useState`'s initialiser form, because the
   * store's first value IS the hydrated one — `StorageProvider` renders no children until the
   * snapshot exists.
   */
  const [hydratedFavoriteCount] = useState(() => selectFavoriteIds(favorites).length);

  const onToggleFavorite = useCallback(() => {
    // Re-read from the value rather than trusting the render's `addRefused`: this is the last
    // moment before a dispatch that would be swallowed with nothing to observe.
    if (selectAtFavoritesBound(favorites) && !isFavorite(favorites, mealId)) {
      return;
    }
    favoritesDispatch(favoritesActions.toggle(mealId));
  }, [favorites, favoritesDispatch, mealId]);

  const onDismiss = useCallback(() => {
    // T-16-07. A modal pushed from a tab has the origin directly beneath it, so `goBack` returns
    // to the list the user was reading, scroll position included. A deep link has nothing beneath
    // it, and that is the case `origin` exists for.
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    navigation.navigate('Tabs', { screen: ORIGIN_TABS[origin] });
  }, [navigation, origin]);

  const onRetry = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return (
    <ScrollView
      testID="meal-details-screen"
      style={{ backgroundColor: colors.surface.canvas }}
      contentContainerStyle={{ gap: components.card.gap, padding: components.card.padding }}
    >
      <View
        testID="meal-details-header"
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <IconButton
          testID="meal-details-dismiss"
          icon="close"
          accessibilityLabel={COPY.dismiss}
          onPress={onDismiss}
        />
        {state.kind === 'loaded' ? (
          <View style={{ alignItems: 'flex-end' }}>
            {/*
              `heart` and `heartOutline` are different SHAPES, not two tints of one (PRD §10.5, and
              the reason `Icon` moved to Material Community Icons — Feather has no filled heart).
              The label says the ACTION, which is what a button's name is for; the note below says
              the STATE in words, because `IconButton` publishes no way to pass an
              `accessibilityState` (recorded under NEEDS-INTEGRATION).
            */}
            <IconButton
              testID="meal-details-favorite"
              icon={saved ? 'heart' : 'heartOutline'}
              accessibilityLabel={saved ? COPY.removeFavorite : COPY.addFavorite}
              onPress={onToggleFavorite}
              disabled={addRefused}
            />
            <AppText testID="meal-details-favorite-state" variant="caption" tone="secondary">
              {saved ? COPY.savedNote : COPY.unsavedNote}
            </AppText>
          </View>
        ) : null}
      </View>

      {/* `recovered` is two different outcomes — see `hydratedFavoriteCount`. P14's finding is why
          either is surfaced at all: the heart would simply read "not saved" with nothing saying
          why. **And it announces (`announceOnMount`)**, because that heart is the only other
          signal and its state is carried in a caption a screen reader reaches after this. The
          value cannot flicker: `entryStatus` is read off the boot hydration snapshot, which
          `StorageProvider` builds once and never updates. This is a stack screen, so it mounts
          again on every meal opened - one announcement per visit, never one per render. */}
      {favoritesStatus.entryStatus === 'recovered' ? (
        <StatusMessage
          testID="meal-details-favorites-recovered"
          tone="warning"
          icon="alertCircle"
          title={hydratedFavoriteCount > 0 ? COPY.truncatedTitle : COPY.recoveredTitle}
          description={
            hydratedFavoriteCount > 0
              ? // Stated as already done, because it is: `createStore`'s mount projection writes the
                // truncated list back at this same launch, so the overflow is gone from disk before
                // the user reads this. Accurate is the only useful register here.
                `More than ${String(MAX_FAVORITES)} favourites were stored, so the newest ${String(MAX_FAVORITES)} were kept and the oldest dropped. The shorter list has already been saved, so the rest cannot be recovered.`
              : COPY.recoveredDescription
          }
          announceOnMount
        />
      ) : null}

      {/* T-16-05, and deliberately carrying NO action: `StatusMessage` renders a button only when
          both `actionLabel` and `onAction` are given, so omitting them is how "no retry" is said.
          Deliberately NOT announced either: `addRefused` holds for every meal a user at the bound
          opens, so an alert here would interrupt on each one and report nothing that arrived. */}
      {listFull ? (
        <StatusMessage
          testID="meal-details-favorites-full"
          tone="warning"
          icon="alertCircle"
          title={COPY.boundTitle}
          description={`You have ${String(MAX_FAVORITES)} favourites, which is as many as this device stores. Remove one to make room for this meal.`}
          stillAvailable={COPY.boundStillAvailable}
        />
      ) : null}

      {/* A write that failed for any other reason, which a retry genuinely may fix. The
          `saveBlocked` conjunct is what keeps this and the surface above mutually exclusive by
          construction rather than by the accident of `saveBlocked` being unreachable.

          **`announceOnMount` earns its place here more than anywhere else on this screen**: this
          notice arrives from the user's own tap, and nothing else reports the refusal - the heart
          is already drawn as saved by the time the write is turned down. `retrySave` clears
          `saveError` before it re-attempts, so a second failure remounts this branch and is
          announced again, which is the intended behaviour: a refused retry is a new event. */}
      {favoritesStatus.saveError !== null && !favoritesStatus.saveBlocked ? (
        <StatusMessage
          testID="meal-details-favorites-save-error"
          tone="danger"
          icon="alertCircle"
          title={COPY.saveErrorTitle}
          // The repository's own message, which is fixed local copy by construction — never a
          // driver string, which can quote the payload (PRD §12).
          description={favoritesStatus.saveError}
          actionLabel={COPY.retry}
          onAction={favoritesStatus.retrySave}
          announceOnMount
        />
      ) : null}

      {state.kind === 'loading' ? (
        <AppText variant="body" tone="secondary" testID="meal-details-loading">
          {COPY.loading}
        </AppText>
      ) : null}

      {/* `notFound` is not an error and gets no retry: asking again returns the same 404, so the
          affordance offered is the one that works — going back where you were. */}
      {state.kind === 'notFound' ? (
        <EmptyState
          testID="meal-details-not-found"
          title={COPY.notFoundTitle}
          description={COPY.notFoundDescription}
          stillAvailable={COPY.notFoundStillAvailable}
          actionLabel={COPY.back}
          onAction={onDismiss}
        />
      ) : null}

      {state.kind === 'unreachable' ? (
        <OfflineState
          testID="meal-details-offline"
          description={COPY.offlineDescription}
          stillAvailable={COPY.offlineStillAvailable}
          retryLabel={COPY.retry}
          onRetry={onRetry}
        />
      ) : null}

      {state.kind === 'failed' ? (
        <ErrorState
          testID="meal-details-error"
          description={COPY.failedDescription}
          stillAvailable={COPY.failedStillAvailable}
          retryLabel={COPY.retry}
          onRetry={onRetry}
        />
      ) : null}

      {state.kind === 'loaded' ? <MealDetailsBody meal={state.meal} /> : null}
    </ScrollView>
  );
}
