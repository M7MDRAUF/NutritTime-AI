/**
 * The favourites half of Saved — the fetching section, and its five states (T-17-02).
 *
 * Reads no store and no API client: the feed, the storage status and the allergy list all arrive as
 * props, which is what makes every state below reachable from `Saved.dom.test.tsx` without a stub
 * inside the component.
 *
 * **This is the section that carries PRD §12's full set** — loading, local-only, error, empty —
 * because it is the one that makes requests. `CustomSection` reads a hydrated store and has neither
 * a loading nor a local-only state; `SavedScreen.tsx`'s docstring says why inventing one there would
 * be a control that can never be observed.
 *
 * **`entryStatus` has two bad values and they mean different things.** `recovered` is "the stored
 * list was corrupt and has been reset"; `unavailable` is "the key could not be read at all, so what
 * is on disk is unknown **and nothing can be saved over it**" (TSD §6.3 — `createStore` skips the
 * write, silently: `saveError` stays null and `saveBlocked` stays false). Under `unavailable` this
 * section must not claim the list is empty, because it does not know that it is.
 *
 * **Three ways a favourite fails to appear, and they are deliberately not one message.** `missing` is
 * a 404 — the record is gone, so the row offers to forget it. `unresolved` is any other per-id
 * failure, which says nothing about whether the record still exists, so it offers a retry and never
 * a removal. A whole-section `unreachable`/`failed` is only reached when nothing resolved at all.
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import {
  AccessibleButton,
  AppText,
  EmptyState,
  ErrorState,
  OfflineState,
  Sheet,
  StatusMessage,
} from '../../shared/components/index.js';
import { useTheme } from '../../shared/theme/ThemeProvider.js';
import type { EntryStatus } from '../../infrastructure/storage/repository.js';
import { SavedMealRow } from './SavedMealRow.js';
import type { FavoritesFeed } from './favoritesFeed.js';

/** "1 favourite", "3 favourites" — the count is the point, so it is never rendered as "1 items". */
function countLabel(count: number, tail: string): string {
  return `${String(count)} favourite${count === 1 ? '' : 's'} ${tail}`;
}

export interface FavoritesSectionProps {
  readonly feed: FavoritesFeed;
  readonly entryStatus: EntryStatus;
  /** The user's declared allergies, straight from the `preferences` store. */
  readonly allergies: readonly string[];
  readonly onOpen: (mealId: string) => void;
  readonly onRetry: () => void;
  readonly onForget: (mealId: string) => void;
}

export function FavoritesSection({
  feed,
  entryStatus,
  allergies,
  onOpen,
  onRetry,
  onForget,
}: FavoritesSectionProps): ReactNode {
  const { components } = useTheme();

  /**
   * Which orphan the user has asked to remove, pending confirmation.
   *
   * **An orphan removal is confirmed, and it is the most irreversible removal in the app.** PRD
   * FR-014 requires destructive actions to confirm first, and un-favouriting an ordinary meal is
   * cheap to undo — open it again and tap the heart. This one cannot be undone at all: the catalog
   * no longer has the record, so there is no screen anywhere in the app that can reach it to
   * re-favourite it, and only a hand-run reseed could bring it back. A single id is still the
   * user's choice, and "small" is not the same as "reversible".
   */
  const [pendingForget, setPendingForget] = useState<string | null>(null);
  const closeSheet = useCallback(() => {
    setPendingForget(null);
  }, []);
  const confirmForget = useCallback(() => {
    if (pendingForget !== null) {
      onForget(pendingForget);
    }
    setPendingForget(null);
  }, [pendingForget, onForget]);

  const unreadable = entryStatus === 'unavailable';

  return (
    <View testID="saved-favorites" style={{ alignSelf: 'stretch', gap: components.card.gap }}>
      <AppText variant="subheading" level={2}>
        Favourite meals
      </AppText>

      {/*
        `recovered` means the stored id list could not be read and was reset. Named per list, because
        "your saved data was reset" would leave the user unable to tell which of two lists is gone —
        and P14's report is explicit that a reset the user is not told about is the reset that
        matters.
      */}
      {entryStatus === 'recovered' ? (
        <StatusMessage
          testID="saved-favorites-recovered"
          tone="warning"
          icon="alertCircle"
          title="Your favourites were reset"
          description="The saved list of favourite meals could not be read, so it is empty. Favourite the meals you want again."
          stillAvailable="Your own recipes are stored separately and are unaffected."
        />
      ) : null}

      {/*
        `unavailable` is a different statement from `recovered` and must not be worded like it. The
        key could not be read, so the list below is this session's empty default and NOT a fact about
        what the user saved — and the store will not write over the key either, so a heart tapped now
        is forgotten at the next launch with nothing to say so.
      */}
      {unreadable ? (
        <StatusMessage
          testID="saved-favorites-unavailable"
          tone="danger"
          icon="danger"
          title="Your favourites could not be read"
          description="This list is not empty — it could not be loaded, so nothing is shown. Favouriting a meal right now will not be remembered after you close the app."
          stillAvailable="Browsing, searching and opening meals all still work, and nothing you saved has been deleted."
        />
      ) : null}

      {feed.kind === 'loading' ? (
        <AppText variant="body" tone="secondary" testID="saved-favorites-loading">
          Loading your favourite meals…
        </AppText>
      ) : null}

      {feed.kind === 'unreachable' ? (
        <OfflineState
          testID="saved-favorites-offline"
          description="Your favourite meals live in the catalog, which is on the server."
          stillAvailable="Your own recipes are on this device and still work, and nothing you favourited has been lost."
          retryLabel="Try again"
          onRetry={onRetry}
        />
      ) : null}

      {feed.kind === 'failed' ? (
        <ErrorState
          testID="saved-favorites-error"
          description="Your favourite meals could not be loaded."
          stillAvailable="Your own recipes still work, and nothing you favourited has been lost."
          retryLabel="Try again"
          onRetry={onRetry}
        />
      ) : null}

      {/*
        The empty state is suppressed under `unavailable`: an unread key yields the fallback `[]`,
        and "No favourite meals yet" would be the app asserting something it cannot know.
      */}
      {!unreadable &&
      feed.kind === 'loaded' &&
      feed.resolved.length === 0 &&
      feed.missing.length === 0 &&
      feed.unresolved.length === 0 ? (
        <EmptyState
          testID="saved-favorites-empty"
          title="No favourite meals yet"
          description="Open a meal from Home or Explore and tap the heart to keep it here."
        />
      ) : null}

      {feed.kind === 'loaded'
        ? feed.resolved.map((entry) => (
            <SavedMealRow
              key={entry.id}
              meal={entry.meal}
              allergies={allergies}
              testID={`saved-favorite-${entry.id}`}
              onOpen={onOpen}
            />
          ))
        : null}

      {feed.kind === 'loaded' && feed.missing.length > 0 ? (
        <>
          {/*
            Said plainly, and NOT dropped: the id is still a choice the user made, so it gets a way
            out rather than being deleted on their behalf or hidden. The copy explains the state and
            then points at the action — an earlier wording reassured that "nothing was lost" directly
            above a button that loses it, which read as a contradiction.
          */}
          <StatusMessage
            testID="saved-favorites-missing"
            tone="warning"
            icon="alertCircle"
            title={countLabel(feed.missing.length, 'could not be found')}
            description="The catalog no longer has these meals, so they cannot be shown or opened. They are still on your list until you remove them below."
            stillAvailable="The rest of your favourites and all of your own recipes are unaffected."
          />
          {feed.missing.map((mealId) => (
            <View
              key={mealId}
              testID={`saved-orphan-${mealId}`}
              style={{ alignSelf: 'stretch', gap: components.card.gap }}
            >
              {/* The raw id, because it is the only identifier the store holds — the record that
                  carried a name is the one that is gone. */}
              <AppText variant="caption" tone="tertiary">
                {mealId}
              </AppText>
              <AccessibleButton
                testID={`saved-forget-${mealId}`}
                label="Remove from favourites"
                variant="secondary"
                accessibilityLabel={`Remove the missing meal ${mealId} from favourites`}
                onPress={() => {
                  setPendingForget(mealId);
                }}
              />
            </View>
          ))}
        </>
      ) : null}

      {feed.kind === 'loaded' && feed.unresolved.length > 0 ? (
        // Retryable, unlike the bound refusal in the other section: these meals may well still
        // exist and the next request may well reach them. Distinct from `missing` on purpose — a
        // failure that is not a 404 says nothing about whether the record is still there, so
        // offering to forget it would invite the user to delete a favourite over a dropped socket.
        <StatusMessage
          testID="saved-favorites-unresolved"
          tone="warning"
          icon="alertCircle"
          title={countLabel(feed.unresolved.length, 'could not be loaded')}
          description="These meals are still in your favourites and can be loaded again."
          stillAvailable="The favourites above and all of your own recipes are unaffected."
          actionLabel="Try again"
          onAction={onRetry}
        />
      ) : null}

      <Sheet
        testID="saved-forget-sheet"
        visible={pendingForget !== null}
        onClose={closeSheet}
        title="Remove this favourite?"
      >
        <View style={{ gap: components.card.gap }}>
          <AppText variant="body" tone="secondary">
            This meal is no longer in the catalog, so it cannot be added back later. Removing it
            clears it from your list and changes nothing else.
          </AppText>
          <AccessibleButton
            testID="saved-forget-confirm"
            label="Remove"
            variant="destructive"
            onPress={confirmForget}
          />
          <AccessibleButton
            testID="saved-forget-cancel"
            label="Keep it"
            variant="ghost"
            onPress={closeSheet}
          />
        </View>
      </Sheet>
    </View>
  );
}
