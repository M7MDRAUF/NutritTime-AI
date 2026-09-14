/**
 * Something failed and the screen has to say so (TSD 6.7).
 *
 * PRD 12's three clauses in order, and a fourth affordance TSD 6.7 gives only this component: a
 * SECOND action, because a failure usually has two honest answers - try the thing again, or go
 * somewhere that works. The two are visually ranked (primary retry, ghost secondary) so the
 * recommended one is obvious without reading both.
 *
 * **`description` is user-facing copy, never an exception message** (TSD 6.7), and PRD 12 puts the
 * same rule the other way round: stack traces and raw provider errors never reach the user. This
 * component cannot enforce what a caller passes, but it has no error-object path at all - there is
 * nothing here to hand a `catch` binding to.
 *
 * `accessibilityRole="alert"` is Plan 14.2's adopted UX guideline, `role="alert"` for errors, and
 * it is the only one of the five state components that carries it: an empty list and an offline
 * banner are page content, not an interruption.
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import { AccessibleButton } from './AccessibleButton.js';
import { AppText } from './AppText.js';
import { Icon } from './Icon.js';
import { StillAvailableNote } from './StatusMessage.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Defaults name the state and stop there; see the note in `EmptyState`.
 *
 * "Something went wrong" says what happened without claiming to know what. Anything more specific
 * would be the component guessing at a cause it was not told, and a wrong cause is worse than a
 * vague one: it sends the user to fix the wrong thing.
 */
const DEFAULT_TITLE = 'Something went wrong';
const DEFAULT_RETRY_LABEL = 'Try again';

export interface ErrorStateProps {
  readonly title?: string;
  /** User-facing copy, never an exception message (TSD 6.7). */
  readonly description?: string;
  /** The sentence that says what still works. PRD 12. */
  readonly stillAvailable?: string;
  readonly retryLabel?: string;
  readonly onRetry?: () => void;
  readonly secondaryActionLabel?: string;
  readonly onSecondaryAction?: () => void;
  readonly testID?: string;
}

export function ErrorState({
  title = DEFAULT_TITLE,
  description,
  stillAvailable,
  retryLabel = DEFAULT_RETRY_LABEL,
  onRetry,
  secondaryActionLabel,
  onSecondaryAction,
  testID,
}: ErrorStateProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const card = components.card;

  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      /*
        Both spellings, and the reason is NOT the one recorded here before.

        The old note said "react-native-web 0.21 maps neither from the other". **It does.** Read
        from the shipped source at the pinned version — `react-native-web` 0.21.2,
        `dist/modules/createDOMProps/index.js:460-462`, matching `src/…:489-491`:
        `_ariaLive = ariaLive != null ? ariaLive : accessibilityLiveRegion`, then
        `domProps['aria-live'] = _ariaLive === 'none' ? 'off' : _ariaLive`. So on the web export
        `accessibilityLiveRegion` alone would have produced `aria-live="assertive"` by itself.

        Both are set because the two platforms read different props and neither maps to the other
        on NATIVE: `accessibilityLiveRegion` is the Android API, `aria-live` is a no-op there, and
        on the web the explicit `aria-live` simply wins the `!=` test above. The deprecation
        `warnOnce` for the RN spelling is commented out in 0.21.2, so setting both is silent.
      */
      accessibilityLiveRegion="assertive"
      aria-live="assertive"
      style={{
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: card.padding,
        padding: card.padding,
      }}
    >
      <View style={{ alignItems: 'center', alignSelf: 'stretch', gap: card.gap }}>
        {/*
          Decorative, and the non-colour half of PRD 10.5: the ballot X is a failure mark in its
          own shape, so the state does not depend on the red being seen as red.
        */}
        <Icon name="danger" size={typography.display.lineHeight} color={colors.status.danger} />
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

      {onRetry === undefined && onSecondaryAction === undefined ? null : (
        <View
          style={{
            // A row until the text is large enough that two labels side by side would each get a
            // sliver; then it stacks (PRD 10.5, `isLargeText`). Same rule `AccessibleButton` uses
            // for its own icon and label.
            flexDirection: isLargeText ? 'column' : 'row',
            alignSelf: isLargeText ? 'stretch' : 'center',
            gap: card.gap,
          }}
        >
          {onRetry === undefined ? null : (
            <AccessibleButton
              label={retryLabel}
              onPress={onRetry}
              variant="primary"
              fullWidth={isLargeText}
            />
          )}
          {secondaryActionLabel === undefined || onSecondaryAction === undefined ? null : (
            <AccessibleButton
              label={secondaryActionLabel}
              onPress={onSecondaryAction}
              variant="ghost"
              fullWidth={isLargeText}
            />
          )}
        </View>
      )}
    </View>
  );
}
