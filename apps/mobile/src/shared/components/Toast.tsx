/**
 * A transient message over the app (TSD 6.7).
 *
 * **The tone glyph's colour was a measured WCAG failure, and this file is where it was caught.**
 * `component.ts`'s four `toast.tone*` tokens were `status.*`, which is authored against
 * `surface.canvas` - the opposite of `surface.inverse` in both schemes - so every one of the eight
 * pairings landed between **1.49:1 and 2.76:1**, under WCAG 1.4.11's 3:1 for a non-text indicator
 * and under the AA-in-both-themes PRD 10.5 requires:
 *
 * | tone    | was (light) | was (dark) | now (light) | now (dark) |
 * |---------|-------------|------------|-------------|------------|
 * | info    | 2.05:1      | 2.27:1     | 7.02:1      | 7.79:1     |
 * | success | 2.32:1      | 1.72:1     | 9.29:1      | 6.86:1     |
 * | warning | 2.52:1      | 1.49:1     | 10.69:1     | 6.33:1     |
 * | danger  | 2.76:1      | 2.47:1     | 6.45:1      | 5.78:1     |
 *
 * `contrast.test.ts` had verified every text tone on canvas, raised, sunken and overlay - and
 * `surface.inverse` is none of those, so the table had no row for this pairing and nothing failed.
 * **A missing row looks exactly like a passing one**, which is the general lesson.
 *
 * The repair authored no new colour: an inverse surface has the brightness of the OTHER scheme's
 * canvas, so `semantic.ts`'s new `statusOnInverse` is simply the other scheme's `status`, used
 * against the surface brightness those values were authored for. Every pairing now clears AA for
 * text, not merely 1.4.11's 3:1 for an indicator, and `contrast.test.ts` covers the surface in
 * both directions - including an assertion that the CANVAS tones still fail here, so the two
 * families cannot quietly converge without someone being told.
 *
 * The glyph still carries the tone by SHAPE as well as by colour, because PRD 10.5 requires
 * colour never to be the only carrier.
 *
 * **`IconButton` is not used for the dismiss control for the same measured reason.** It draws its
 * glyph in `button.ghost.label`, which is `content.link`: 2.32:1 on the light toast and 1.36:1 on
 * the dark one. It exposes no colour, so the only way to use it here would be to ship an
 * invisible control. The two controls below are built to `button.minHeight` on both axes, exactly
 * as `IconButton` is.
 *
 * **`toast.shadowColor` is not set either, and for a third reason.** react-native-web 0.21
 * deprecates every `shadow*` style prop in favour of `boxShadow` and warns on stderr for each one,
 * and on native a shadow COLOUR with no offset, opacity or radius draws nothing at all. The theme
 * is flat by design - `effect.elevationFloating` is 2 in light and 0 in dark - so `elevation` is
 * the whole of the floating affordance here. Reported as a token with no consumer.
 *
 * **`durationMs` has no default, and an absent one means the toast does not expire.** No document
 * fixes a dwell time, and inventing one is the wrong way round: WCAG 2.2.1 treats "no time limit"
 * as the conforming baseline and an auto-dismiss as the exception that needs justifying. A caller
 * that wants one passes a figure it can defend; a caller that passes nothing gets a message the
 * user dismisses when they have read it.
 */

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import type { StatusTone } from './StatusMessage.js';
import type { ComponentTokens } from '../theme/index.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * The glyph that carries each tone, written out key by key.
 *
 * A `Record` over a finite union rather than an index signature, so every tone has a glyph at
 * compile time and reading one back is an `IconName`, not `IconName | undefined`.
 */
const TONE_ICONS: Readonly<Record<StatusTone, IconName>> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'danger',
};

/** The accessible name of the dismiss control. No document fixes the word; this is the plain one. */
const DISMISS_LABEL = 'Dismiss';

/**
 * Tone to colour, from the four repaired `toast.tone*` tokens.
 *
 * A `Record` over the finite union for the same reason `TONE_ICONS` is one: every tone has a
 * colour at compile time, and reading one back is a `string` rather than `string | undefined`.
 */
function toneColors(toast: ComponentTokens['toast']): Readonly<Record<StatusTone, string>> {
  return {
    info: toast.toneInfo,
    success: toast.toneSuccess,
    warning: toast.toneWarning,
    danger: toast.toneDanger,
  };
}

export interface ToastProps {
  readonly message: string;
  readonly visible: boolean;
  readonly onDismiss: () => void;
  readonly tone?: StatusTone;
  /**
   * The sentence that says what still works (PRD 12).
   *
   * TSD 6.7's prose - "Every state component takes `stillAvailable`" - and `Plan.md` 17's own row
   * for T-12-05 ("all with `stillAvailable`") both require it; the same section's table omits it
   * from this one row. Added as an OPTIONAL prop, which satisfies the prose and the Plan's
   * acceptance criterion while breaking no caller written against the table. Recorded as a
   * divergence in the phase report rather than resolved by editing a document.
   */
  readonly stillAvailable?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** Milliseconds before the toast dismisses itself. Absent means it waits for the user. */
  readonly durationMs?: number;
  readonly testID?: string;
}

export function Toast({
  message,
  visible,
  onDismiss,
  tone = 'info',
  stillAvailable,
  actionLabel,
  onAction,
  durationMs,
  testID,
}: ToastProps): ReactNode {
  const { components, typography } = useTheme();
  const toast = components.toast;
  const toneColor = toneColors(toast);
  const button = components.button;

  useEffect(() => {
    if (!visible || durationMs === undefined) {
      return undefined;
    }
    const timer = setTimeout(onDismiss, durationMs);
    // Cleared on unmount and on every change to the three values below, so a toast whose message
    // is replaced while it is up gets a fresh full dwell rather than the remainder of the old one.
    return () => {
      clearTimeout(timer);
    };
  }, [visible, durationMs, onDismiss]);

  if (!visible) {
    return null;
  }

  /**
   * Both controls are the same box: built to the target, never sized by their glyph.
   *
   * Annotated `ViewStyle` rather than asserted `as const`, so the string members narrow from the
   * type they are assigned to instead of from an assertion.
   */
  const controlBox: ViewStyle = {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: button.minHeight,
    minWidth: button.minHeight,
    borderRadius: button.radius,
  };

  return (
    // `box-none` so the overlay itself swallows nothing: only the bar and its controls take a
    // touch, and the screen underneath stays usable while a toast is up.
    <View
      style={[
        // React Native's own constant rather than four inset literals of mine.
        StyleSheet.absoluteFill,
        {
          // In the style, not as a prop: react-native-web 0.21 warns that `props.pointerEvents`
          // is deprecated, and a green test run with a warning on stderr is the combination
          // `vitest.setup.dom.mts` exists to avoid.
          pointerEvents: 'box-none',
          zIndex: toast.zIndex,
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: toast.padding,
        },
      ]}
    >
      <View
        testID={testID}
        // Polite, not assertive, and not `role="alert"`: a toast reports something that has
        // already happened, so interrupting whatever the user is reading is the wrong trade.
        // Both spellings - Android reads one, the web export and this suite read the other.
        accessibilityLiveRegion="polite"
        aria-live="polite"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'stretch',
          gap: toast.gap,
          padding: toast.padding,
          borderRadius: toast.radius,
          backgroundColor: toast.background,
          // `toast.shadowColor` is deliberately not set - see the note at the top of this file.
          elevation: toast.elevation,
        }}
      >
        {/*
          Decorative: the glyph carries the tone, the message carries the meaning, and the shape
          carries it independently of the colour (PRD 10.5).
        */}
        <Icon
          name={TONE_ICONS[tone]}
          size={typography.bodyStrong.lineHeight}
          color={toneColor[tone]}
        />

        <View style={{ flex: 1, gap: toast.gap }}>
          {/*
            Not `AppText`. `toast.text` is a layer-3 decision and `AppText`'s `tone` reaches only
            `semantic.ts`'s content roles, so restating the mapping here would leave the toast
            token with no consumer to notice if it changed. Same reasoning as `Chip`'s label.
          */}
          <Text allowFontScaling={false} style={{ ...typography.body, color: toast.text }}>
            {message}
          </Text>
          {stillAvailable === undefined ? null : (
            <Text allowFontScaling={false} style={{ ...typography.caption, color: toast.text }}>
              {stillAvailable}
            </Text>
          )}
        </View>

        {actionLabel === undefined || onAction === undefined ? null : (
          <Pressable
            onPress={onAction}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={{ ...controlBox, paddingHorizontal: toast.gap }}
          >
            <Text
              allowFontScaling={false}
              style={{
                ...typography.bodyStrong,
                color: toast.actionText,
                // Underlined, because `toast.actionText` IS `toast.text` by design - see
                // `component.ts` - so without a second carrier the action is indistinguishable
                // from the sentence beside it (PRD 10.5).
                textDecorationLine: 'underline',
              }}
            >
              {actionLabel}
            </Text>
          </Pressable>
        )}

        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel={DISMISS_LABEL}
          style={controlBox}
        >
          <Icon name="close" size={typography.body.lineHeight} color={toast.text} />
        </Pressable>
      </View>
    </View>
  );
}
