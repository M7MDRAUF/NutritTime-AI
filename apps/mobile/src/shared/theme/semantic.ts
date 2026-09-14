import type { ThemeMode } from '@nutritime/contracts';
import { palette } from './primitive.js';

/**
 * Layer 2 of TSD 6.6 — roles, not colours.
 *
 * One interface, two maps typed by it. That shape is the acceptance criterion for T-11-06: a token
 * present in `lightColors` and missing from `darkColors` is a **compile** error, not a dark-mode bug
 * a user finds. Nothing here is optional and nothing is indexed, so there is no path by which a
 * scheme can be partially defined.
 *
 * **Dark is authored, not inverted.** TSD 6.6 requires its own accent brightness, its own status
 * family and its own scrim strength, and DECISIONS.md 3.3 records each one. Two consequences worth
 * naming, because they are what an inversion gets wrong:
 *
 *  - `surface.sunken` is *lighter* than the canvas in light and *darker* in dark. Recessed means
 *    recessed in both schemes. Inverting the light map flips it into a raised surface.
 *  - `content.onBrand` is `#000000` in light and `ink.ondark` in dark, because the two brand fills
 *    are different greens. Black on the dark scheme's brighter green would be a different pairing
 *    at a different ratio, chosen by accident.
 *
 * Every pairing below is computed against WCAG AA in `contrast.test.ts`, in both schemes. No ratio
 * here was estimated.
 *
 * SQG-09 exception, recorded in DECISIONS.md 10: this file is over the 350-line cap and is one
 * token table in two columns. Splitting the two maps into two files is precisely the split that
 * lets one drift from the other — a reviewer checking that dark authored its own value for a role
 * needs both columns on the same screen.
 */

/**
 * The two resolved schemes.
 *
 * TSD 6.6 uses `ColorScheme` in `resolveScheme`'s signature and declares it nowhere — not in 3.1,
 * not in `packages/contracts`. Declared here as the only inhabitant consistent with
 * `THEME_MODES = ['system','light','dark']` and with React Native's
 * `Appearance.getColorScheme(): 'light' | 'dark' | null`. It is theme-local, not a wire contract,
 * so it does not belong in `contracts`. Recorded as proposed amendment A-11-01; the TSD is not
 * edited to match this code.
 */
export type ColorScheme = 'light' | 'dark';

export interface SemanticTokens {
  /** What things sit on. */
  readonly surface: {
    /** The screen behind everything. */
    readonly canvas: string;
    /** A card or list row lifted off the canvas. */
    readonly raised: string;
    /** A recessed well: a search field's trough, an unselected chip. */
    readonly sunken: string;
    /** A sheet or dialog panel, above the scrim. */
    readonly overlay: string;
    /** Reversed against the canvas. Toasts, and nothing else by default. */
    readonly inverse: string;
    /** A brand-filled region — a selected chip, a primary button. */
    readonly brand: string;
    /** An inactive control's fill. */
    readonly disabled: string;
  };

  /** Text and icons. */
  readonly content: {
    /** Body copy, headings, values. */
    readonly primary: string;
    /** Supporting copy that must still be read. */
    readonly secondary: string;
    /** Metadata: timestamps, units, counts. The quietest tone that is still AA. */
    readonly tertiary: string;
    /** On `surface.inverse`. */
    readonly inverse: string;
    /** On `surface.brand` and on `accent.brand`. */
    readonly onBrand: string;
    /** On `accent.cta`. */
    readonly onAccent: string;
    /** On a `status.danger` fill. */
    readonly onDanger: string;
    /**
     * On a remote meal photograph, over `scrim.image`.
     *
     * This is light in **both** schemes, which is why it cannot be `content.inverse`: the dark
     * scheme's inverse tone is dark, because its inverse *surface* is light. A photograph is not a
     * surface this theme controls, so the pairing does not flip with the scheme — dark text over a
     * darkened photo is unreadable in either one.
     */
    readonly onImage: string;
    /** A navigable link inside a paragraph. Never the only affordance — PRD 10.5. */
    readonly link: string;
    /** An inactive control's label. WCAG 1.4.3 exempts it; see `contrast.test.ts`. */
    readonly disabled: string;
  };

  /**
   * Brand, call-to-action and the three macro accents.
   *
   * The macros are the palette direction Plan.md 14.2 adopted — protein blue, carb orange, fat
   * yellow. One colour per macro serves both a text tone and a swatch, so a swatch can never be a
   * shade the text beside it is not.
   */
  readonly accent: {
    readonly brand: string;
    readonly brandPressed: string;
    /** A tinted brand background: a badge, an informational panel. */
    readonly brandSubtle: string;
    readonly cta: string;
    readonly ctaPressed: string;
    readonly ctaSubtle: string;
    readonly protein: string;
    readonly carb: string;
    readonly fat: string;
  };

  /** Status foregrounds — the icon and the text. Never the only carrier (PRD 10.5). */
  readonly status: {
    readonly info: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
  };

  /** The tinted background a status message sits on. Pairs index-for-index with `status`. */
  readonly statusSurface: {
    readonly info: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
  };

  /**
   * The same four tones, for a foreground sitting on `surface.inverse`.
   *
   * **Added at P12 to repair a measured WCAG 1.4.11 failure, not as an enhancement.** `toast`'s
   * background is `surface.inverse`, and `status` is authored against `surface.canvas` - its
   * opposite in both schemes - so every one of the eight `toast.tone*` pairings P11 shipped landed
   * between **1.49:1 and 2.76:1**, against the 3:1 a non-text indicator needs and the AA in both
   * themes PRD 10.5 requires. `contrast.test.ts` had no pairing for this surface, so nothing
   * failed and the tokens looked finished.
   *
   * **No new colour was authored to fix it.** An inverse surface has the brightness of the OTHER
   * scheme's canvas, so it takes the other scheme's hand-authored status tones: light's
   * `statusOnInverse` IS dark's `status`, and dark's is light's. Every pairing then clears
   * **5.78:1 to 10.69:1** - not merely 1.4.11's 3:1 but AA for text - because each value is being
   * used against exactly the surface brightness it was authored for. Pinned in
   * `contrast.test.ts`.
   *
   * (The upper figure first written here was 11.71, which is not a pairing in either map: it came
   * from a `content.link` probe run while choosing the approach. The true range across all eight
   * is 5.78 - dark danger - to 10.69 - light warning.)
   */
  readonly statusOnInverse: {
    readonly info: string;
    readonly success: string;
    readonly warning: string;
    readonly danger: string;
  };

  readonly border: {
    /** Decorative dividers only. Below 3:1 by design — see `contrast.test.ts`. */
    readonly subtle: string;
    /** A control's boundary, where the boundary is what identifies the control (WCAG 1.4.11). */
    readonly default: string;
    /** A boundary that has to win against a busy surface. */
    readonly strong: string;
    readonly focus: string;
    readonly brand: string;
    readonly danger: string;
  };

  /**
   * Translucent overlays, as 8-digit hex so one string works in React Native and in CSS.
   *
   * Dark's are stronger and pure black (TSD 6.6's "own scrim strength"): a slate-blue scrim over a
   * near-black canvas does not read as a scrim at all.
   */
  readonly scrim: {
    /** Behind a sheet or dialog, over the app. */
    readonly backdrop: string;
    /** Inside a sheet, separating its header from scrolling content. */
    readonly sheet: string;
    /**
     * Over a remote meal photograph, behind text. `MealCard` takes an `imageUrl` (TSD 6.7) and a
     * remote photo is arbitrary, so this alpha is what bounds the worst case. It was computed
     * against a pure-white photograph, not chosen by eye — `contrast.test.ts` composites it.
     */
    readonly image: string;
  };

  /**
   * Non-colour surface effects.
   *
   * TSD 6.6 names the group and fixes no members; DECISIONS.md S-05 records the choice. The
   * generator's four-level shadow table is rejected in DECISIONS.md 5 — it contradicts the same
   * file's own Flat Design rule ("No gradients/shadows") and its own "Complex shadows"
   * anti-pattern. Two elevations remain, and in dark both are 0: a shadow is invisible against
   * `#0A1714`, so dark separates a floating surface with `surface.overlay` and `border.subtle`.
   */
  readonly effect: {
    readonly shadowColor: string;
    /** Cards and rows. Flat: zero. */
    readonly elevationSurface: number;
    /** The two surfaces that genuinely float: the sheet and the toast. */
    readonly elevationFloating: number;
    /** The loading placeholder fill. Required by PRD 12's mandatory loading state. */
    readonly skeleton: string;
    /** Android's press state layer. */
    readonly ripple: string;
    /** iOS's press overlay. */
    readonly highlight: string;
  };
}

/**
 * Light.
 *
 * Surfaces, the primary text tone and both `on*` labels are the UI UX Pro Max
 * "Calorie & Nutrition Counter" row adopted verbatim, including its counter-intuitive black-on-green
 * labels: black on `#059669` is 5.57:1 and white on the same green is 3.77:1, which fails AA. The
 * two places the row was overruled — its `Border` as a control boundary at 1.10:1, and its
 * `Destructive` as a text tone at 4.48:1 on the sunken surface — are recorded in DECISIONS.md 3.1
 * with the measured ratios.
 */
export const lightColors: SemanticTokens = {
  surface: {
    canvas: palette.green[50],
    raised: palette.white,
    sunken: palette.sage[50],
    overlay: palette.white,
    inverse: palette.slate[900],
    brand: palette.green[600],
    disabled: palette.slate[200],
  },
  content: {
    primary: palette.slate[900],
    secondary: palette.slate[700],
    tertiary: palette.slate[600],
    inverse: palette.green[50],
    onBrand: palette.black,
    onAccent: palette.black,
    onDanger: palette.white,
    onImage: palette.green[50],
    link: palette.green[800],
    disabled: palette.slate[400],
  },
  accent: {
    brand: palette.green[600],
    // Pressed moves *lighter*, not darker. The resting label is black, so darkening the fill would
    // walk 5.57:1 down toward failure; `green[500]` walks it up to 8.28:1.
    brandPressed: palette.green[500],
    brandSubtle: palette.green[100],
    cta: palette.orange[600],
    ctaPressed: palette.orange[500],
    ctaSubtle: palette.orange[100],
    protein: palette.blue[800],
    carb: palette.orange[700],
    // Plan.md 14.2's direction says "fat yellow". At AA on a light surface, yellow is unavoidably
    // a dark amber: `amber[600]` is 2.95:1 on the sunken surface and fails. The hue family is kept;
    // its light end is not available for text. DECISIONS.md 3.2.
    fat: palette.amber[800],
  },
  status: {
    info: palette.blue[800],
    success: palette.green[800],
    warning: palette.amber[800],
    // red[700], not the generator's red[600]: one token serves both the danger text tone and the
    // destructive fill, and red[600] as text on `surface.sunken` is 4.48:1 — AA by -0.02.
    danger: palette.red[700],
  },
  statusSurface: {
    info: palette.blue[100],
    success: palette.green[100],
    warning: palette.amber[100],
    danger: palette.red[100],
  },
  // The 400 ramp, which is the DARK scheme's `status`. `surface.inverse` in the light scheme is
  // `slate[900]`, so a tone on it is a tone on a dark ground, and these are the four values
  // authored for one. 7.02 / 9.29 / 10.69 / 6.45:1.
  statusOnInverse: {
    info: palette.blue[400],
    success: palette.green[400],
    warning: palette.amber[400],
    danger: palette.red[400],
  },
  border: {
    subtle: palette.sage[100],
    // slate[500], not the generator's `Border`. A field whose only boundary is 1.10:1 against the
    // canvas is unidentifiable under WCAG 1.4.11; this is 4.41:1 at worst.
    default: palette.slate[500],
    strong: palette.slate[700],
    // The generator's `Ring`, adopted: 3.49:1 at worst across the three light surfaces, so it
    // clears 1.4.11's 3:1 everywhere it can be drawn.
    focus: palette.green[600],
    brand: palette.green[600],
    danger: palette.red[700],
  },
  scrim: {
    backdrop: '#0F172A80',
    sheet: '#0F172AA6',
    image: '#0F172AB3',
  },
  effect: {
    shadowColor: palette.slate[900],
    elevationSurface: 0,
    elevationFloating: 2,
    skeleton: palette.sage[100],
    ripple: '#0596691F',
    highlight: '#0F172A0D',
  },
};

/**
 * Dark — authored (TSD 6.6).
 *
 * Not one value below is a transform of its light counterpart. The surfaces are a green-cast
 * near-black family of their own (`palette.ink`); the accents are three ramp steps brighter than
 * light's because a green-600 fill disappears into a near-black canvas; the status family is four
 * bright tints against light's four dark ones; the scrim is pure black and stronger; and both
 * elevations are 0. The tightest pairing in this map is `content.tertiary` on `surface.overlay`
 * at 5.53:1.
 */
export const darkColors: SemanticTokens = {
  surface: {
    canvas: palette.ink[900],
    raised: palette.ink[850],
    // Darker than the canvas, where light's sunken is lighter. An inversion of the light map would
    // flip this into a raised surface and a search trough would read as a card.
    sunken: palette.ink[950],
    overlay: palette.ink[800],
    inverse: palette.ink[200],
    brand: palette.green[400],
    disabled: palette.ink[700],
  },
  content: {
    // Not `white`. Pure white on a near-black canvas glares; this keeps the canvas's green cast.
    primary: palette.ink[200],
    secondary: palette.ink[300],
    tertiary: palette.ink[400],
    inverse: palette.ink[900],
    onBrand: palette.ink.ondark,
    onAccent: palette.ink.ondark,
    onDanger: palette.ink.ondark,
    // Light, like light's. The only role in either map whose two values are the same kind of
    // colour, because the thing underneath it is a photograph and not a surface.
    onImage: palette.ink[200],
    link: palette.green[300],
    disabled: palette.ink[600],
  },
  accent: {
    brand: palette.green[400],
    brandPressed: palette.green[300],
    brandSubtle: '#0C2A20',
    cta: palette.orange[400],
    ctaPressed: palette.orange[300],
    ctaSubtle: '#2E1D0C',
    protein: palette.blue[400],
    carb: palette.orange[300],
    // The constraint inverts here: on a dark canvas the bright end of amber is the readable end,
    // so dark gets the yellow that light could not have.
    fat: palette.amber[400],
  },
  status: {
    info: palette.blue[400],
    success: palette.green[400],
    warning: palette.amber[400],
    danger: palette.red[400],
  },
  // Authored dark tints. A light tint darkened algorithmically lands on a muddy grey, which is the
  // failure TSD 6.6's "authored, not inverted" is written against.
  statusSurface: {
    info: '#0E1E3A',
    success: '#0C2A20',
    warning: '#2B2109',
    danger: '#2E1414',
  },
  // Mirror of light's: the 800 ramp plus red[700], which is the LIGHT scheme's `status`. The dark
  // scheme's `surface.inverse` is `ink[200]`, a light ground. 7.79 / 6.86 / 6.33 / 5.78:1.
  statusOnInverse: {
    info: palette.blue[800],
    success: palette.green[800],
    warning: palette.amber[800],
    danger: palette.red[700],
  },
  border: {
    /**
     * **Authored at P12, not a ramp step, because no ramp step works.**
     *
     * This was `ink[700]` (`#1E332C`), and `surface.overlay` is `ink[800]` (`#18302A`) - adjacent
     * steps of the same ramp. Measured **1.0469:1**, under `contrast.test.ts`'s own
     * `VISIBLE_MINIMUM` of 1.05, so the `Divider` separating a dark `Sheet`'s header from its
     * content was invisible. The exemption test measured `border.subtle` against
     * `surface.canvas` ALONE (1.3662, comfortable), which is the same shape of gap that let the
     * `toast.tone*` failure ship: a pairing that is not in the table is not verified.
     *
     * Every existing ink step was tried and none fits: `ink[700]` is 1.047 at worst and the next
     * step up, `ink[600]`, is 3.19 - past 1.4.11's 3:1, so it reads as a control boundary rather
     * than a decorative rule, and it is already `border.default`'s value, which would collapse
     * two roles into one. `#2B423B` is the smallest move that clears the floor with margin on all
     * four dark surfaces: **1.301 overlay, 1.361 raised, 1.526 canvas, 1.698 sunken.** Light needs
     * no change (1.074 at worst, on sunken).
     */
    subtle: '#2B423B',
    default: palette.ink[600],
    strong: palette.ink[300],
    focus: palette.green[300],
    brand: palette.green[400],
    danger: palette.red[400],
  },
  scrim: {
    backdrop: '#000000B3',
    sheet: '#000000CC',
    image: '#000000A6',
  },
  effect: {
    shadowColor: palette.black,
    elevationSurface: 0,
    // Zero, not light's 2. A shadow against `#0A1714` is invisible; `surface.overlay` plus
    // `border.subtle` is what lifts a sheet in this scheme.
    elevationFloating: 0,
    skeleton: palette.ink[700],
    ripple: '#34D3992E',
    highlight: '#E8F5F014',
  },
};

/** Both schemes, by name. The one place a scheme is looked up, so there is one lookup to audit. */
export const colorsByScheme: Readonly<Record<ColorScheme, SemanticTokens>> = {
  light: lightColors,
  dark: darkColors,
};

/**
 * TSD 6.6's signature.
 *
 * `mode` is the stored preference (`preferences.themeMode`) and is a prop, never internal state —
 * one source of truth. `systemScheme` is what the OS reports, and it is nullable because
 * `Appearance.getColorScheme()` returns `null` before the platform has answered.
 *
 * The fallback for `'system'` with an unknown OS scheme is `'light'`: a first frame rendered light
 * and corrected to dark is a flash, while one rendered dark on a light device is unreadable.
 */
export function resolveScheme(mode: ThemeMode, systemScheme: ColorScheme | null): ColorScheme {
  switch (mode) {
    case 'light':
      return 'light';
    case 'dark':
      return 'dark';
    case 'system':
      return systemScheme ?? 'light';
  }
}
