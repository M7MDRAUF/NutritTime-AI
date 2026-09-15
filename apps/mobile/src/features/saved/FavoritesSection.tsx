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
 * **This file no longer renders a section; it renders one section's three parts** (T-22-08).
 * `SavedScreen` owns a single `SectionList`, so the eleven-element sequence this section used to
 * render as one subtree is now split along the only line the list offers — header, rows, footer —
 * and the split is where it is for a reason in each case:
 *
 *  - **header**: the heading and every whole-section state (`recovered`, `unavailable`, loading,
 *    offline, error, empty). These are the things whose entire job is to be seen, and a windowed
 *    list renders its header first and always.
 *  - **rows**: the resolved favourites, and only those. Each row mounts a remote TheMealDB
 *    photograph, so a row the list does not build is a request it does not make — which is the
 *    whole of T-22-08 on this screen.
 *  - **footer**: the `missing` notice, the orphan rows and the `unresolved` notice, in that order,
 *    because the notice says the ids are listed "below" and the copy has to stay true.
 *
 * **The orphan rows are a second list and they are NOT windowed.** They sit in the footer, which a
 * list renders whole. That is a deliberate, measured choice rather than an oversight: an orphan row
 * is a raw id and a button, and it mounts **no photograph at all** — the record that carried one is
 * the thing that is gone — so the cost this task exists to remove is not there. Moving them into
 * the section's `data` would window them, and would also force the `missing` notice above them to
 * become a row in the same list; that is a bigger change than the bytes justify, and it is recorded
 * as a follow-up rather than taken.
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
 *
 * **Only the two `entryStatus` notices announce themselves (`announceOnMount`); the three feed
 * notices do not, and that is a judgement rather than an omission.** `entryStatus` is read off the
 * boot hydration snapshot, which `StorageProvider` builds once and never updates, so neither of
 * those branches can appear or disappear from a state change: each mounts with the section, and
 * `StatusMessage`'s `role="alert"` is spoken on that insertion rather than on every render.
 * `missing` and `unresolved` are re-derived from the feed instead, so they unmount and remount on
 * every `onRetry` - announcing them would re-read "3 favourites could not be found" after a retry
 * that changed nothing about them, and a region that speaks on an unrelated change is the
 * interruption Plan 20's focus row exists to prevent.
 *
 * **The caveat that used to be here is gone.** It said that `SavedScreen` renders the two sections
 * at unkeyed sibling positions, so a `section` param change remounts both and re-announces. That
 * has been untrue since the two `key`s were added, and it is doubly untrue now: the header is a
 * keyed cell of the `SectionList` (`'favorites:header'`), so a swap reorders keyed children and
 * React moves the node. `Saved.dom.test.tsx` asserts that node's identity across a swap.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { Meal } from '@nutritime/contracts';
import {
  AccessibleButton,
  AppText,
  EmptyState,
  ErrorState,
  OfflineState,
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

/**
 * One resolved favourite, as the list sees it.
 *
 * Tagged for the same reason `CustomRow` is: both sections feed ONE `SectionList`, so the two row
 * types meet in a single `renderItem`. The **id is kept beside the meal** rather than read back off
 * it, which is `FavoriteEntry`'s own reasoning — rows key off the store's list, and the id the store
 * holds is the one a row has to be identified by.
 */
export interface FavoriteRow {
  readonly kind: 'favorite';
  readonly id: string;
  readonly meal: Meal;
}

export function favoriteRows(feed: FavoritesFeed): readonly FavoriteRow[] {
  return feed.kind === 'loaded'
    ? feed.resolved.map((entry) => ({ kind: 'favorite', id: entry.id, meal: entry.meal }))
    : [];
}

export function favoriteRowKey(row: FavoriteRow): string {
  return row.id;
}

export interface FavoritesSectionHeaderProps {
  readonly feed: FavoritesFeed;
  readonly entryStatus: EntryStatus;
  readonly onRetry: () => void;
}

export function FavoritesSectionHeader({
  feed,
  entryStatus,
  onRetry,
}: FavoritesSectionHeaderProps): ReactNode {
  const { components } = useTheme();
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
          announceOnMount
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
          announceOnMount
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
    </View>
  );
}

export interface FavoriteRowViewProps {
  readonly row: FavoriteRow;
  readonly allergies: readonly string[];
  readonly onOpen: (mealId: string) => void;
}

export function FavoriteRowView({ row, allergies, onOpen }: FavoriteRowViewProps): ReactNode {
  return (
    <SavedMealRow
      meal={row.meal}
      allergies={allergies}
      testID={`saved-favorite-${row.id}`}
      onOpen={onOpen}
    />
  );
}

export interface FavoritesSectionFooterProps {
  readonly feed: FavoritesFeed;
  readonly onRetry: () => void;
  /**
   * Ask the screen to confirm removing an orphan.
   *
   * The confirmation sheet and its pending id live in `SavedScreen` rather than here: the button
   * that opens it is in this footer, the list it removes from is the section's `data`, and a
   * `SectionList` renders those through two different callbacks. State shared by two render
   * callbacks belongs to whoever owns both.
   */
  readonly onRequestForget: (mealId: string) => void;
}

export function FavoritesSectionFooter({
  feed,
  onRetry,
  onRequestForget,
}: FavoritesSectionFooterProps): ReactNode {
  const { components } = useTheme();
  // Nothing rather than an empty box: the list puts its own gap between cells, so a footer that
  // renders an empty `View` when there is nothing to say leaves a hole under the last row.
  if (feed.kind !== 'loaded' || (feed.missing.length === 0 && feed.unresolved.length === 0)) {
    return null;
  }

  return (
    <View style={{ alignSelf: 'stretch', gap: components.card.gap }}>
      {feed.missing.length > 0 ? (
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
                  onRequestForget(mealId);
                }}
              />
            </View>
          ))}
        </>
      ) : null}

      {feed.unresolved.length > 0 ? (
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
    </View>
  );
}
