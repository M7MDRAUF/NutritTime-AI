import type { SemanticTokens } from './semantic.js';
import { duration, easing, opacity, radius, space, stroke, touch, zIndex } from './primitive.js';

/**
 * Layer 3 of TSD 6.6 — `buildComponentTokens(color: SemanticTokens): ComponentTokens` for the nine
 * groups TSD 6.6 names: button, field, card, chip, sheet, toast, badge, divider, focus ring.
 *
 * The signature takes only the colour map, so this layer is a pure function of the active scheme
 * and cannot be scheme-aware in any other way. Everything non-colour comes from `primitive.ts`
 * directly: a component group's radius is a decision about the group, not about the scheme, and
 * threading it through the argument would let one scheme round a card differently from the other.
 *
 * Why a function rather than two constants: the same nine groups must exist in both schemes with
 * the same shape. Building them from one expression makes that structural, not a convention two
 * maps happen to follow. A group added here appears in both schemes or in neither.
 *
 * The other seven of TSD 6.7's sixteen components compose from these nine — `MealCard` from `card`
 * plus `badge`, the five state components from `card` plus `button`, `SearchField` from `field`.
 * None needs a colour this file does not already hand out, which is the check that the nine groups
 * are the right nine.
 *
 * Every height below is derived from `touch.buildTo`, never written as a number. PRD 10.5 (2.1.0)
 * via X-05 fixes 48 dp as the single build-to value, and deriving it means a later padding or copy
 * change cannot quietly shrink a target under the minimum.
 *
 * SQG-09 exception, recorded in DECISIONS.md 10: the interface and the expression that satisfies it
 * are one table read as a pair, and a reviewer checking that a group is complete needs both halves
 * on the same screen.
 */

/** One variant's three states. Disabled is a colour pair, not an opacity: see `ComponentTokens`. */
export interface ButtonVariantTokens {
  readonly background: string;
  readonly backgroundPressed: string;
  readonly backgroundDisabled: string;
  readonly label: string;
  readonly labelDisabled: string;
  readonly borderColor: string;
  readonly borderWidth: number;
}

export interface ComponentTokens {
  readonly button: {
    /** Height, padding and radius are shared by every variant: one button shape, four fills. */
    readonly minHeight: number;
    readonly paddingHorizontal: number;
    readonly gap: number;
    readonly radius: number;
    readonly duration: number;
    readonly easing: readonly [number, number, number, number];
    /** The affirmative action on a screen. At most one. */
    readonly primary: ButtonVariantTokens;
    /** Everything else that is a button. */
    readonly secondary: ButtonVariantTokens;
    /** A tertiary action that must not compete: no fill, no border. */
    readonly ghost: ButtonVariantTokens;
    /** Reset, and deleting a custom meal. */
    readonly destructive: ButtonVariantTokens;
  };

  readonly field: {
    readonly minHeight: number;
    readonly paddingHorizontal: number;
    readonly paddingVertical: number;
    readonly radius: number;
    readonly background: string;
    readonly backgroundDisabled: string;
    readonly text: string;
    /** Placeholders are a hint, never a label — `FormField` has a visible `label` (TSD 6.7). */
    readonly placeholder: string;
    readonly label: string;
    readonly hint: string;
    readonly borderColor: string;
    readonly borderColorFocused: string;
    readonly borderColorError: string;
    readonly borderWidth: number;
    readonly borderWidthFocused: number;
    /** The inline message, bound to the field. Paired with an icon, never colour alone. */
    readonly errorText: string;
    readonly errorGap: number;
  };

  readonly card: {
    readonly background: string;
    readonly padding: number;
    readonly gap: number;
    readonly radius: number;
    readonly borderColor: string;
    readonly borderWidth: number;
    readonly shadowColor: string;
    readonly elevation: number;
    /** Behind text laid over a remote photograph. Its alpha is computed, not eyeballed. */
    readonly imageScrim: string;
    /** And the text on top of it. Light in both schemes — see `content.onImage`. */
    readonly imageText: string;
    readonly skeleton: string;
    readonly pressedOpacity: number;
  };

  readonly chip: {
    readonly minHeight: number;
    readonly paddingHorizontal: number;
    readonly gap: number;
    readonly radius: number;
    readonly background: string;
    readonly backgroundSelected: string;
    readonly backgroundDisabled: string;
    readonly label: string;
    readonly labelSelected: string;
    readonly labelDisabled: string;
    readonly borderColor: string;
    readonly borderColorSelected: string;
    readonly borderWidth: number;
  };

  readonly sheet: {
    readonly background: string;
    readonly padding: number;
    readonly radiusTop: number;
    readonly backdrop: string;
    readonly divider: string;
    readonly handleColor: string;
    readonly handleWidth: number;
    readonly handleHeight: number;
    readonly shadowColor: string;
    readonly elevation: number;
    readonly zIndex: number;
    readonly backdropZIndex: number;
    readonly duration: number;
    readonly easing: readonly [number, number, number, number];
  };

  readonly toast: {
    readonly background: string;
    readonly text: string;
    readonly actionText: string;
    readonly padding: number;
    readonly gap: number;
    readonly radius: number;
    readonly shadowColor: string;
    readonly elevation: number;
    readonly zIndex: number;
    readonly duration: number;
    readonly easing: readonly [number, number, number, number];
    /**
     * Per tone: the icon and border colour. The message text stays `text` for legibility.
     *
     * Drawn from `statusOnInverse`, NOT `status`. The four values P11 put here were the canvas
     * tones and were unreadable on this surface - between 1.49:1 and 2.76:1 - which is recorded on
     * the `statusOnInverse` declaration.
     */
    readonly toneInfo: string;
    readonly toneSuccess: string;
    readonly toneWarning: string;
    readonly toneDanger: string;
  };

  readonly badge: {
    readonly minHeight: number;
    readonly paddingHorizontal: number;
    readonly gap: number;
    readonly radius: number;
    readonly neutralBackground: string;
    readonly neutralText: string;
    readonly brandBackground: string;
    readonly brandText: string;
    /** The three macro accents. Always beside a visible label (PRD 10.5, FR-006). */
    readonly proteinText: string;
    readonly carbText: string;
    readonly fatText: string;
    /** `NutritionBadge` renders "Not available", never 0 (PRD FR-006). This is that tone. */
    readonly unavailableText: string;
    readonly statusInfoBackground: string;
    readonly statusInfoText: string;
    readonly statusSuccessBackground: string;
    readonly statusSuccessText: string;
    readonly statusWarningBackground: string;
    readonly statusWarningText: string;
    readonly statusDangerBackground: string;
    readonly statusDangerText: string;
  };

  readonly divider: {
    readonly color: string;
    readonly thickness: number;
    readonly spacing: number;
    readonly spacingTight: number;
    readonly inset: number;
  };

  readonly focusRing: {
    readonly color: string;
    readonly width: number;
    readonly offset: number;
    readonly radius: number;
  };
}

export function buildComponentTokens(color: SemanticTokens): ComponentTokens {
  return {
    button: {
      minHeight: touch.buildTo,
      paddingHorizontal: space.lg,
      gap: space.sm,
      radius: radius.sm,
      duration: duration.base,
      easing: easing.standard,
      primary: {
        background: color.accent.brand,
        backgroundPressed: color.accent.brandPressed,
        backgroundDisabled: color.surface.disabled,
        label: color.content.onBrand,
        labelDisabled: color.content.disabled,
        borderColor: color.accent.brand,
        borderWidth: stroke.hairline,
      },
      secondary: {
        // No fill: the border and the label carry it. The generator's secondary button, whose 2 px
        // brand border is `stroke.regular` here.
        background: color.surface.raised,
        backgroundPressed: color.accent.brandSubtle,
        backgroundDisabled: color.surface.disabled,
        label: color.content.link,
        labelDisabled: color.content.disabled,
        borderColor: color.border.brand,
        borderWidth: stroke.regular,
      },
      ghost: {
        background: 'transparent',
        backgroundPressed: color.accent.brandSubtle,
        backgroundDisabled: 'transparent',
        label: color.content.link,
        labelDisabled: color.content.disabled,
        borderColor: 'transparent',
        borderWidth: 0,
      },
      destructive: {
        background: color.status.danger,
        // No darker danger step is authored, so the pressed state is the scrim-free option the
        // platforms already give us: the same fill under `opacity.pressed`. Colour is not the only
        // press affordance in either case — `effect.ripple` and `effect.highlight` carry it too.
        backgroundPressed: color.status.danger,
        backgroundDisabled: color.surface.disabled,
        label: color.content.onDanger,
        labelDisabled: color.content.disabled,
        borderColor: color.border.danger,
        borderWidth: stroke.hairline,
      },
    },

    field: {
      minHeight: touch.buildTo,
      paddingHorizontal: space.md,
      // 12 vertical around a 24 line box is 48 — `touch.buildTo` reached by construction rather
      // than by writing 48 twice and hoping they stay equal.
      paddingVertical: space.md - space.xs,
      radius: radius.sm,
      background: color.surface.raised,
      backgroundDisabled: color.surface.disabled,
      text: color.content.primary,
      placeholder: color.content.tertiary,
      label: color.content.secondary,
      hint: color.content.tertiary,
      borderColor: color.border.default,
      borderColorFocused: color.border.focus,
      borderColorError: color.border.danger,
      borderWidth: stroke.hairline,
      // Focus thickens the border rather than replacing it: the field must not appear to move or
      // resize when it gains focus. These two widths are the app's ONLY rendered focus indicator —
      // `focusRing` below has no consumer — so what matters is the relation between them and not
      // either value: equal widths leave a focused field looking exactly like an unfocused one.
      // `focus-indicator.test.ts` pins the relation, which is what the two `.dom.test.tsx`
      // assertions comparing a render to its own token cannot.
      borderWidthFocused: stroke.regular,
      errorText: color.status.danger,
      errorGap: space.xs,
    },

    card: {
      background: color.surface.raised,
      padding: space.md,
      gap: space.sm,
      radius: radius.md,
      // Flat Design has no shadows, so a card's edge is its border. Without one, a white card on a
      // mint canvas has no boundary at all in light, and none against `#0A1714` in dark.
      borderColor: color.border.subtle,
      borderWidth: stroke.hairline,
      shadowColor: color.effect.shadowColor,
      elevation: color.effect.elevationSurface,
      imageScrim: color.scrim.image,
      imageText: color.content.onImage,
      skeleton: color.effect.skeleton,
      pressedOpacity: opacity.pressed,
    },

    chip: {
      minHeight: touch.buildTo,
      paddingHorizontal: space.md,
      gap: space.xs,
      radius: radius.pill,
      background: color.surface.sunken,
      backgroundSelected: color.surface.brand,
      backgroundDisabled: color.surface.disabled,
      label: color.content.secondary,
      labelSelected: color.content.onBrand,
      labelDisabled: color.content.disabled,
      // A chip is a control, so its unselected boundary is what identifies it (WCAG 1.4.11) and
      // `border.subtle` is not strong enough to carry that.
      borderColor: color.border.default,
      borderColorSelected: color.border.brand,
      borderWidth: stroke.hairline,
    },

    sheet: {
      background: color.surface.overlay,
      padding: space.lg,
      radiusTop: radius.lg,
      backdrop: color.scrim.backdrop,
      divider: color.border.subtle,
      handleColor: color.border.strong,
      handleWidth: space.xxl - space.md,
      handleHeight: stroke.focus + stroke.hairline,
      shadowColor: color.effect.shadowColor,
      elevation: color.effect.elevationFloating,
      zIndex: zIndex.sheet,
      backdropZIndex: zIndex.scrim,
      // Decelerate, not standard: a sheet arrives, and an arrival that speeds up at the end reads
      // as a snap.
      duration: duration.slow,
      easing: easing.decelerate,
    },

    toast: {
      background: color.surface.inverse,
      text: color.content.inverse,
      // The action label is the same tone as the message. A brand accent on an inverse surface is
      // a different pairing in each scheme, and one of the two would be the weaker.
      actionText: color.content.inverse,
      padding: space.md,
      gap: space.sm,
      radius: radius.sm,
      shadowColor: color.effect.shadowColor,
      elevation: color.effect.elevationFloating,
      zIndex: zIndex.toast,
      duration: duration.base,
      easing: easing.decelerate,
      toneInfo: color.statusOnInverse.info,
      toneSuccess: color.statusOnInverse.success,
      toneWarning: color.statusOnInverse.warning,
      toneDanger: color.statusOnInverse.danger,
    },

    badge: {
      // Badges are read, not tapped, so `touch.buildTo` does not apply. TSD 6.7's `NutritionBadge`
      // and `Chip` are separate components precisely because one is a control and one is a label;
      // padding a badge to 48 would make a nutrition row four times too tall.
      minHeight: space.lg,
      paddingHorizontal: space.sm,
      gap: space.xs,
      radius: radius.pill,
      neutralBackground: color.surface.sunken,
      neutralText: color.content.secondary,
      brandBackground: color.accent.brandSubtle,
      brandText: color.content.link,
      proteinText: color.accent.protein,
      carbText: color.accent.carb,
      fatText: color.accent.fat,
      // `tertiary`, not `disabled`: "Not available" is a fact about the data, not an inactive
      // control, so it has to meet the AA minimum like any other text.
      unavailableText: color.content.tertiary,
      statusInfoBackground: color.statusSurface.info,
      statusInfoText: color.status.info,
      statusSuccessBackground: color.statusSurface.success,
      statusSuccessText: color.status.success,
      statusWarningBackground: color.statusSurface.warning,
      statusWarningText: color.status.warning,
      statusDangerBackground: color.statusSurface.danger,
      statusDangerText: color.status.danger,
    },

    divider: {
      // The one place `border.subtle` is correct: a rule between rows carries no information, so
      // WCAG 1.4.11's 3:1 does not reach it.
      color: color.border.subtle,
      thickness: stroke.hairline,
      spacing: space.md,
      spacingTight: space.sm,
      inset: space.md,
    },

    focusRing: {
      color: color.border.focus,
      // The generator's 3 px ring geometry, adopted. Its 12.5%-alpha colour is not: at that alpha
      // the ring lands far below 1.4.11's 3:1, so the ring is specified at full `border.focus`.
      //
      // **Specified, and not drawn: this group has no consumer.** The focus state the app renders
      // is `field.borderWidthFocused`, not this ring, and `DECISIONS.md` 5's reason for rejecting
      // `outline: none` — that `focusRing` "is always visible and 3:1" — is therefore about a ring
      // nothing paints. `focus-indicator.test.ts` holds the measurement and the verdict.
      width: stroke.focus,
      offset: stroke.regular,
      // One step above the element's own radius, so the ring sits concentric with the corner it
      // surrounds instead of cutting across it.
      radius: radius.md,
    },
  };
}
