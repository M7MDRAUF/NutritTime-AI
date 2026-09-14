/**
 * The local-only state (TSD 6.7, PRD 12).
 *
 * PRD 12 names this state "local-only (server unreachable)", and that wording is load-bearing:
 * this app's core features work with no network at all (PRD 10.2) and only the model and the
 * remote meal images need one. So the default title is **"Working offline"** and not "You're
 * offline" - the second is a claim about the user's radio that this component has no way to
 * check, and it is usually false. The server on the same machine can be down while the phone's
 * connection is perfect.
 *
 * That distinction is the whole point of `stillAvailable` here. Offline is the app's ordinary
 * operating mode, not a fault, and the sentence that says which features are unaffected is what
 * turns a dead end into a mode. It is the single most important prop on this component.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AccessibleButton } from './AccessibleButton.js';
import { AppText } from './AppText.js';
import { Icon } from './Icon.js';
import { StillAvailableNote } from './StatusMessage.js';
import { useTheme } from '../theme/ThemeProvider.js';

/** Defaults name the state and stop there; see the note in `EmptyState`. */
const DEFAULT_TITLE = 'Working offline';
const DEFAULT_RETRY_LABEL = 'Try again';

export interface OfflineStateProps {
  readonly title?: string;
  /** User-facing copy, never an exception message (TSD 6.7). */
  readonly description?: string;
  /** The sentence that says what still works. PRD 12, and the reason this state is not a wall. */
  readonly stillAvailable?: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
  readonly testID?: string;
}

export function OfflineState({
  title = DEFAULT_TITLE,
  description,
  stillAvailable,
  retryLabel = DEFAULT_RETRY_LABEL,
  onRetry,
  testID,
}: OfflineStateProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const card = components.card;

  return (
    <View
      testID={testID}
      // A live region, but NOT `role="alert"`. Losing the server is a change of mode the user
      // should be told about; it is not the interruption an error is, and Plan 14.2 adopted the
      // alert role for errors specifically. Both spellings for the reason given in `Chip`:
      // Android reads one, the web export and this suite read the other.
      accessibilityLiveRegion="polite"
      aria-live="polite"
      style={{
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: card.padding,
        padding: card.padding,
      }}
    >
      <View style={{ alignItems: 'center', alignSelf: 'stretch', gap: card.gap }}>
        {/*
          Decorative, and the non-colour half of PRD 10.5. A caution mark rather than the failure
          mark `ErrorState` uses: nothing has failed, something is merely unreachable.
        */}
        {/*
          `offline`, not `warning`. A caution triangle says "be careful"; a struck-through cloud
          says "not connected", which is the actual state - and PRD 10.2 is explicit that working
          offline is normal here rather than a fault.
        */}
        <Icon name="offline" size={typography.display.lineHeight} color={colors.status.warning} />
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

      {onRetry === undefined ? null : (
        <AccessibleButton
          label={retryLabel}
          onPress={onRetry}
          variant="secondary"
          fullWidth={isLargeText}
        />
      )}
    </View>
  );
}
