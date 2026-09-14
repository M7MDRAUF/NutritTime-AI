/**
 * A bottom sheet (TSD 6.7).
 *
 * **`Modal`, not a hand-rolled overlay.** React Native's `Modal` is what gives the Android
 * hardware back button a way to close this (`onRequestClose`), and react-native-web 0.21's export
 * of it adds `role="dialog"`, `aria-modal` and a focus trap that a plain `View` cannot. React
 * Native 0.86 has no `dialog` accessibility role to set by hand - `AccessibilityRole` stops at
 * `alert` - so on the web surface the role arrives only because `Modal` is doing the work.
 *
 * **The accessible name is therefore a prop of `Modal`, not of the panel below it (M-20).** This
 * is not where it feels natural, and putting it where it felt natural is what broke it. In
 * react-native-web 0.21.2, `Modal` renders `ModalPortal > ModalAnimation > ModalFocusTrap >
 * ModalContent`, and `ModalContent` is the one that owns the semantics: its `View` gets
 * `role={active ? 'dialog' : null}` and a hardcoded `aria-modal`, and every prop `Modal` and
 * `ModalContent` do not destructure is spread onto that *same* `View`. The panel below is three
 * `div`s down, so a name set there landed on a roleless element: the dialog had a role with no
 * name and a name with no role, and a screen reader announced all three destructive confirmations
 * as bare "dialog" (PRD 10.5 requires a name on every interactive element). `aria-label` passed
 * to `Modal` rides that spread onto the element that has the role, which is the only arrangement
 * an accessible name has ever meant.
 *
 * **`aria-modal` is deliberately absent below.** It was on the panel, where it was invalid - ARIA
 * defines `aria-modal` only on a dialog role, and the panel has no role - and redundant, because
 * `ModalContent` already sets it on the element that does have the role. So it is dropped rather
 * than moved: there is nowhere to move it to that does not already have it.
 *
 * **`accessibilityViewIsModal` stays on the panel because it is iOS-only.** It appears nowhere in
 * react-native-web 0.21.2, so it cannot be the web surface's modal flag; on iOS it is what makes
 * VoiceOver ignore the views behind the sheet, and the panel is the subtree that should trap it.
 *
 * **Safe-area insets are a PROP, not a hook.** `react-native-safe-area-context` ships its web
 * build as `*.web.js` platform files, which Metro resolves and Vitest does not, so calling
 * `useSafeAreaInsets()` here would make this component untestable in the `dom` project. Injected
 * instead, the same way `ThemeProvider` takes `mode` and `RootNavigator` takes `phase` - a mock
 * exists in `navigation/testHarness.tsx` and importing across that boundary is the wrong
 * direction. A screen that has insets passes them; one that does not gets `sheet.padding`.
 *
 * **`animationType` is `none`.** `sheet.duration` and `sheet.easing` exist and this component
 * consumes neither, because `Modal` exposes no duration: its three animations are fixed. Honouring
 * the tokens needs `Animated`, which is a change of shape rather than a tweak, and a CSS
 * animation that never fires its `animationend` in jsdom would leave the sheet permanently
 * invisible to this suite. Recorded in the phase report.
 */

import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { AppText } from './AppText.js';
import { Divider } from './Divider.js';
import { IconButton } from './IconButton.js';
import { useTheme } from '../theme/ThemeProvider.js';

/** The accessible name of the control that closes the sheet. No document fixes the word. */
const CLOSE_LABEL = 'Close';

export interface SheetInsets {
  /** The safe area below the sheet - a home indicator, usually. Added to `sheet.padding`. */
  readonly bottom: number;
}

export interface SheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** The sheet's accessible name, always. `hideTitle` hides it visually and nothing more. */
  readonly title: string;
  readonly children: ReactNode;
  readonly hideTitle?: boolean;
  /** Injected rather than read from a hook; see the note above. */
  readonly insets?: SheetInsets;
  readonly testID?: string;
}

export function Sheet({
  visible,
  onClose,
  title,
  children,
  hideTitle = false,
  insets,
  testID,
}: SheetProps): ReactNode {
  const { components } = useTheme();
  const sheet = components.sheet;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      // The name has to be set HERE, on the element react-native-web gives the `dialog` role to.
      // See the note above: `Modal` spreads what it does not consume onto that element, and the
      // panel below is three levels too low to be named. `aria-label` rather than the deprecated
      // `accessibilityLabel`, which 0.21 maps to it anyway.
      aria-label={title}
      // Android's hardware back button, and the whole reason this is a `Modal`.
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          onPress={onClose}
          // Hidden from assistive technology on all three platforms. The close button below is
          // the accessible way out; announcing the backdrop as a second, unlabelled "close"
          // control would be one more thing to swipe past and nothing more.
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            // React Native's own constant rather than four inset literals.
            StyleSheet.absoluteFill,
            { backgroundColor: sheet.backdrop, zIndex: sheet.backdropZIndex },
          ]}
        />

        <View
          testID={testID}
          // iOS-only, and the only modal flag this element needs: it is what stops VoiceOver
          // reaching the views behind the sheet. The web's `aria-modal` is set by `ModalContent`
          // on the element that carries `role="dialog"`, and neither the name nor `aria-modal`
          // belongs here - see the note at the top of the file.
          accessibilityViewIsModal
          // VoiceOver's two-finger scrub. The gesture exists to dismiss exactly this.
          onAccessibilityEscape={onClose}
          style={{
            zIndex: sheet.zIndex,
            padding: sheet.padding,
            // The safe area is ADDED to the sheet's own padding rather than replacing it, so a
            // phone with a home indicator gets clearance and one without is unchanged.
            paddingBottom: insets === undefined ? sheet.padding : sheet.padding + insets.bottom,
            borderTopLeftRadius: sheet.radiusTop,
            borderTopRightRadius: sheet.radiusTop,
            backgroundColor: sheet.background,
            // `sheet.shadowColor` is deliberately not set; see the note in `MealCard`.
            elevation: sheet.elevation,
          }}
        >
          {/* The grab handle. Decorative, and a radius equal to its own height fully rounds it. */}
          <View
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              alignSelf: 'center',
              width: sheet.handleWidth,
              height: sheet.handleHeight,
              borderRadius: sheet.handleHeight,
              backgroundColor: sheet.handleColor,
            }}
          />

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: sheet.padding,
            }}
          >
            {/*
              `hideTitle` hides the heading, never the name: the `aria-label` on `Modal` carries
              `title` in both cases, so a sheet whose heading would duplicate its content is still
              announced by name. The flex box is what lets a long title wrap beside the button.
            */}
            <View style={{ flex: 1 }}>
              {hideTitle ? null : <AppText variant="title">{title}</AppText>}
            </View>
            <IconButton icon="close" accessibilityLabel={CLOSE_LABEL} onPress={onClose} />
          </View>

          <Divider spacing="tight" />

          {children}
        </View>
      </View>
    </Modal>
  );
}
