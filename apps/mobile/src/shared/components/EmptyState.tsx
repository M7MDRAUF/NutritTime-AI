/**
 * "There is nothing here, and that is not a failure" (TSD 6.7).
 *
 * PRD 12's three clauses in order: what happened (`title`, `description`), what still works
 * (`stillAvailable`), what to do next (`actionLabel` / `onAction`). Plan 14.2 adopted
 * "empty states with an action" from the UX guidelines, which is why the action is here rather
 * than left to the screen to bolt on underneath.
 *
 * **Tone is deliberately quiet.** The icon is `content.tertiary`, not a status colour: an empty
 * Saved list or a search with no matches is an ordinary outcome, and painting it amber teaches the
 * user to read a normal state as a fault. `ErrorState` and `OfflineState` are the two that carry a
 * status colour, and they carry it because something actually went wrong.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AccessibleButton } from './AccessibleButton.js';
import { AppText } from './AppText.js';
import { Icon } from './Icon.js';
import { StillAvailableNote } from './StatusMessage.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * The default is a statement about the data, not an apology.
 *
 * TSD 6.7 marks `title` optional, so a default has to exist; no document fixes the string.
 * It names the state and nothing more - the component knows WHAT KIND of state it is and does
 * not know the details, so it says the first and stays silent on the second. `description` has
 * no default for exactly that reason: a generic second sentence would be a guess, and a guess
 * here is how "no results for your filters" becomes "check your connection".
 */
const DEFAULT_TITLE = 'Nothing here yet';

export interface EmptyStateProps {
  readonly title?: string;
  /** User-facing copy, never an exception message (TSD 6.7). */
  readonly description?: string;
  /** The sentence that says what still works. PRD 12. */
  readonly stillAvailable?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly testID?: string;
}

export function EmptyState({
  title = DEFAULT_TITLE,
  description,
  stillAvailable,
  actionLabel,
  onAction,
  testID,
}: EmptyStateProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const card = components.card;

  return (
    <View
      testID={testID}
      style={{
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: card.padding,
        padding: card.padding,
      }}
    >
      <View style={{ alignItems: 'center', alignSelf: 'stretch', gap: card.gap }}>
        {/* Decorative: the title says the same thing in words, and an empty list needs no label. */}
        {/*
          `inbox`, not `info`. The batch that built this had only seventeen Unicode characters and
          called `info` the weakest of its six choices; with a real set behind `Icon` (A-11) an
          empty container is the mark that says "nothing here yet" rather than "here is a notice".
        */}
        <Icon name="inbox" size={typography.display.lineHeight} color={colors.content.tertiary} />
        <AppText variant="title" align="center">
          {title}
        </AppText>
        {description === undefined ? null : (
          <AppText variant="body" tone="secondary" align="center">
            {description}
          </AppText>
        )}
      </View>

      {stillAvailable === undefined ? null : (
        <StillAvailableNote
          sentence={stillAvailable}
          testID={testID === undefined ? undefined : `${testID}-still-available`}
        />
      )}

      {actionLabel === undefined || onAction === undefined ? null : (
        <AccessibleButton
          label={actionLabel}
          onPress={onAction}
          variant="primary"
          fullWidth={isLargeText}
        />
      )}
    </View>
  );
}
