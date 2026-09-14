/**
 * The button (TSD 6.7).
 *
 * Four variants, one shape: `component.ts` gives every variant the same height, padding and
 * radius and varies only the fill, the label and the border, so a screen cannot accidentally
 * ship a secondary button that is a different size from the primary one beside it.
 *
 * Built to 48 on both axes from `button.minHeight`, which is `touch.buildTo` - PRD 10.5 (2.1.0)
 * via X-05: 44 pt iOS, 48 dp Android, 24 px web, and 48 satisfies all three.
 *
 * **The `loading` spinner is the app's only continuously-animating element, and it now honours
 * the OS reduce-motion setting** (T-23-06). See `useReducedMotion` below for how the setting is
 * read and why the replacement is a still mark rather than nothing at all.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * The OS "reduce motion" setting, read from the platform and kept current.
 *
 * **This is the platform contract, not an invented rule.** `AccessibilityInfo`'s
 * `isReduceMotionEnabled()` is the initial read and its `reduceMotionChanged` event is the update;
 * react-native-web 0.21.2 implements both over `window.matchMedia('(prefers-reduced-motion:
 * reduce)')` (`react-native-web/src/exports/AccessibilityInfo/index.js:20-39`), so the same two
 * calls cover iOS, Android and the web export. **No duration, no easing curve and no "short
 * enough" cutoff is decided here**, because none of the four documents fixes one and inventing a
 * figure would be a worse defect than the spinner.
 *
 * **A hook rather than a prop, and that is a constraint rather than a preference.** TSD §6.7 fixes
 * `AccessibleButton`'s props at nine, so a `reduceMotion?` prop would be a document amendment -
 * the same open decision R-56 records for `IconButton`'s `accessibilityState`. The shape this
 * project actually wants is `ThemeProvider`'s: the provider takes `mode`, `deviceScheme` and
 * `fontScale` as parameters precisely so a test can pin both states without a module registry, and
 * `reduceMotion` belongs beside `fontScale` on `Theme` for the same reason. That file is not this
 * agent's to edit; the exact edit is filed instead, and until it lands the suite supplies the
 * platform the way Playwright's `emulateMedia({ reducedMotion })` does - by defining the media
 * query, not by mocking this module.
 *
 * **It starts at `false` so that the read is observable.** A hook seeded with `true` would render
 * identically whether the platform was asked or not, which is exactly the inert-mutation trap
 * BRIEF §6.1k describes: under Vitest's jsdom 30.0.1 there is no `window.matchMedia` at all, so
 * react-native-web resolves `isReduceMotionEnabled()` to `true` (its own fail-closed answer,
 * index.js:28), and a default-path test therefore fails unless this effect really ran. The initial
 * value costs a user nothing: `loading` is false on mount at every call site, so by the time any
 * button is busy the read has long since settled.
 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      // The screen may have gone before the promise settled; setting state then is a no-op that
      // still reads as a leak to the next person looking at this.
      if (live) {
        setReduced(enabled);
      }
    });

    // **Widened, not asserted.** react-native-web 0.21.2 returns `undefined` from
    // `addEventListener` when the document has no `matchMedia` - it returns early at
    // `AccessibilityInfo/index.js:78-79`, before the `{ remove }` handle is built - so a bare
    // `subscription.remove()` throws `TypeError` on unmount in exactly the environment the dom
    // suite runs in. React Native's own types promise an `EventSubscription`; the annotation says
    // what the web implementation actually does, which is why this needs no `!` and no `as`.
    const subscription: { remove: () => void } | undefined = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (enabled) => {
        setReduced(enabled);
      },
    );

    return () => {
      live = false;
      subscription?.remove();
    };
  }, []);

  return reduced;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export interface AccessibleButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly icon?: IconName;
  readonly fullWidth?: boolean;
  /** Defaults to `label`. Give one only when the visible label is not the whole story. */
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly testID?: string;
}

export function AccessibleButton({
  label,
  onPress,
  variant = 'secondary',
  disabled = false,
  loading = false,
  icon,
  fullWidth = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: AccessibleButtonProps): ReactNode {
  const { components, colors, typography, isLargeText } = useTheme();
  const reduceMotion = useReducedMotion();
  const button = components.button;
  const tokens = button[variant];

  // A loading button is inert, not merely slow: the press already happened and a second one
  // would submit twice. It stays unpressable AND announces `busy`, so a screen reader user is
  // told which of the two states it is in.
  const inactive = disabled || loading;
  const labelColor = inactive ? tokens.labelDisabled : tokens.label;

  // See `Chip`: ripple on Android, highlight everywhere else. `component.ts` says this in as
  // many words on the destructive variant - colour is not the only press affordance - and it is
  // the only affordance that variant has, because its pressed fill is its resting fill.
  const highlight = Platform.OS === 'android' ? undefined : colors.effect.highlight;

  return (
    <Pressable
      testID={testID}
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      // The aria-* alias alongside `accessibilityState`, for the reason given in `Chip`.
      aria-busy={loading}
      android_ripple={{ color: colors.effect.ripple }}
      style={({ pressed }) => ({
        // A row until the text is large enough that a row would squeeze the label into a sliver
        // beside the icon; then it becomes a column (PRD 10.5, `isLargeText`).
        flexDirection: isLargeText ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: button.gap,
        minHeight: button.minHeight,
        minWidth: button.minHeight,
        paddingHorizontal: button.paddingHorizontal,
        borderRadius: button.radius,
        borderWidth: tokens.borderWidth,
        borderColor: tokens.borderColor,
        backgroundColor: inactive
          ? tokens.backgroundDisabled
          : pressed
            ? tokens.backgroundPressed
            : tokens.background,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
        // So the press overlay stops at the button's own corners.
        overflow: 'hidden',
      })}
    >
      {({ pressed }) => (
        <>
          {pressed && !inactive && highlight !== undefined ? (
            <View aria-hidden style={[StyleSheet.absoluteFill, { backgroundColor: highlight }]} />
          ) : null}
          {loading ? (
            // The spinner replaces the icon, never the label: a button whose text disappears
            // while it works loses its accessible name at the moment the user is waiting on it.
            //
            // **Under reduce-motion the mark is still, and it is still a mark** (T-23-06). Three
            // things were considered and two are wrong. Dropping the indicator leaves the fill and
            // the label unchanged, so "sent" and "not sent" look identical - P21's record has a
            // screen that found the right copy while a spinner sat stuck forever, and a user
            // cannot tell that apart from a broken app. `animating={false}` looks portable and is
            // not: react-native-web pauses the keyframes
            // (`ActivityIndicator/index.js:74`) but Android's `ProgressBarContainerView.kt:46`
            // sets the bar to `INVISIBLE`, so the signal would vanish on one platform only. A
            // still glyph in the same slot, at the same size and colour, is the one option that
            // says the same thing on all three - and the state is still announced, because
            // `accessibilityState.busy` and `aria-busy` above do not depend on this branch.
            reduceMotion ? (
              <Icon name="clock" size={typography.bodyStrong.lineHeight} color={labelColor} />
            ) : (
              <ActivityIndicator size="small" color={labelColor} />
            )
          ) : icon === undefined ? null : (
            <Icon name={icon} size={typography.bodyStrong.lineHeight} color={labelColor} />
          )}
          {/*
            Not `AppText`. The label colour is `button.primary.label` - a layer-3 decision - and
            `AppText`'s `tone` reaches only `semantic.ts`'s content roles. Restating that mapping
            here would leave the component token with no consumer to notice if it changed.
          */}
          <Text allowFontScaling={false} style={{ ...typography.bodyStrong, color: labelColor }}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
