/**
 * An inline status banner (TSD 6.7).
 *
 * PRD 12 fixes the shape of every state message: **what happened, what still works, what to do
 * next.** This component is the one that says all three explicitly - `title` and `description` are
 * what happened, `stillAvailable` is what still works, and `actionLabel`/`onAction` is what to do
 * next - and the other four state components repeat that order.
 *
 * **The tone is never carried by colour alone.** `icon` is a required prop precisely so the glyph
 * differs per tone, and `contrast.test.ts` says so in as many words: "A status tint is not what
 * tells the user the status: TSD 6.7 makes `icon` a required prop on `StatusMessage`". The tint is
 * therefore not used as the panel fill either - see the note on the surface below.
 *
 * Composed from the `card` group plus `AccessibleButton`, which is what `component.ts` says the
 * five state components are built from.
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import { AccessibleButton } from './AccessibleButton.js';
import { AppText } from './AppText.js';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';
import type { SemanticTokens } from '../theme/index.js';

/**
 * The four status roles `semantic.ts` publishes, and nothing else.
 *
 * Derived from the token map rather than listed, the way `AppText`'s `TextTone` is: a status role
 * added to the theme is available here the day it lands, and one removed stops compiling at its
 * call sites. TSD 6.7 writes the prop as bare `tone` and fixes no inhabitants; this is the only
 * set the theme can colour.
 */
export type StatusTone = keyof SemanticTokens['status'];

export interface StillAvailableNoteProps {
  /** The sentence that says what still works. PRD 12. */
  readonly sentence: string;
  readonly testID?: string;
}

/**
 * The "what still works" sentence, rendered as its own bounded note.
 *
 * **Why it is here and not in a file of its own:** four of the five state components render it
 * and T-12-05's file boundary permits no sixth file, so one of the five owns it and the other
 * three import it rather than carrying a fourth copy of the same twelve lines. A dedicated
 * `StillAvailableNote.tsx` is the right home and is recorded in the phase report as such. It is
 * deliberately **not** exported from `index.ts`: TSD 6.7's inventory is sixteen components and
 * this is not a seventeenth.
 *
 * It is a bordered panel rather than another paragraph because PRD 12's three clauses have to be
 * distinguishable. A reassurance that reads as more error prose is a reassurance nobody finds -
 * and thin nutrition coverage (TSD 7.4's all-or-nothing rule) and offline-first storage are
 * deliberate, so the sentence that says so has to look deliberate too.
 *
 * The surface is `card.background`, not a status tint: `contrast.test.ts` verifies every text tone
 * against `surface.canvas`, `raised`, `sunken` and `overlay`, and the ONLY foreground it verifies
 * on a `statusSurface.*` tint is `status.*` itself. Body copy in status red is both unverified and
 * bad typography.
 */
export function StillAvailableNote({ sentence, testID }: StillAvailableNoteProps): ReactNode {
  const { components, colors, typography } = useTheme();
  const card = components.card;

  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        alignSelf: 'stretch',
        gap: card.gap,
        padding: card.padding,
        borderRadius: card.radius,
        borderWidth: card.borderWidth,
        borderColor: card.borderColor,
        backgroundColor: card.background,
      }}
    >
      {/* Decorative: the sentence beside it says the same thing in words. */}
      <Icon name="info" size={typography.body.lineHeight} color={colors.status.info} />
      {/* `AppText` takes no style, so the flex box that lets a long sentence wrap lives here. */}
      <View style={{ flex: 1 }}>
        <AppText variant="body" tone="secondary">
          {sentence}
        </AppText>
      </View>
    </View>
  );
}

export interface StatusMessageProps {
  readonly tone: StatusTone;
  /** Required by TSD 6.7, and the reason the tone is never colour-only (PRD 10.5). */
  readonly icon: IconName;
  readonly title: string;
  /** User-facing copy, never an exception message (TSD 6.7). */
  readonly description: string;
  readonly stillAvailable?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Announce the message when it appears, for a state that arrives after the screen has. */
  readonly announceOnMount?: boolean;
  readonly testID?: string;
}

export function StatusMessage({
  tone,
  icon,
  title,
  description,
  stillAvailable,
  actionLabel,
  onAction,
  announceOnMount = false,
  testID,
}: StatusMessageProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const card = components.card;
  const toneColor = colors.status[tone];

  useEffect(() => {
    // iOS has no live region: `accessibilityLiveRegion` is Android-only and `aria-live` is what
    // the web export reads, so VoiceOver would be the one platform told nothing. This is the
    // documented iOS API for the same job, and it is gated to iOS so the web export does not
    // announce the message twice - react-native-web implements `announceForAccessibility` by
    // creating a live region of its own, which would stack with the one below.
    if (announceOnMount && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(`${title}. ${description}`);
    }
  }, [announceOnMount, title, description]);

  return (
    <View
      testID={testID}
      // Both spellings, deliberately: `accessibilityLiveRegion` is what Android reads and
      // react-native-web 0.21 maps none of it, while `aria-live` is what the web export and this
      // suite read. Setting one leaves either the platform or the test blind.
      accessibilityLiveRegion={announceOnMount ? 'polite' : 'none'}
      aria-live={announceOnMount ? 'polite' : undefined}
      style={{
        alignSelf: 'stretch',
        gap: card.gap,
        padding: card.padding,
        borderRadius: card.radius,
        // The tone's own colour as the boundary. `status.*` is verified at 3:1 against
        // `surface.canvas` and at 4.5:1 against `surface.raised`, so it is legible as a
        // boundary in both schemes - which `toast.tone*` on `toast.background` is not.
        borderWidth: card.borderWidth,
        borderColor: toneColor,
        backgroundColor: card.background,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: card.gap }}>
        {/*
          Decorative. The tone is already in the title and in the glyph SHAPE, and labelling the
          icon would make a screen reader announce the tone before the sentence that explains it.
        */}
        <Icon name={icon} size={typography.subheading.lineHeight} color={toneColor} />
        <View style={{ flex: 1, gap: card.gap }}>
          <AppText variant="subheading">{title}</AppText>
          <AppText variant="body" tone="secondary">
            {description}
          </AppText>
        </View>
      </View>

      {stillAvailable === undefined ? null : (
        <StillAvailableNote
          sentence={stillAvailable}
          testID={testID === undefined ? undefined : `${testID}-still-available`}
        />
      )}

      {actionLabel === undefined || onAction === undefined ? null : (
        <View style={{ alignSelf: isLargeText ? 'stretch' : 'flex-start' }}>
          <AccessibleButton
            label={actionLabel}
            onPress={onAction}
            variant="secondary"
            fullWidth={isLargeText}
          />
        </View>
      )}
    </View>
  );
}
