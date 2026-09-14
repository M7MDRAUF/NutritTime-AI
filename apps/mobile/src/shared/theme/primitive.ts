/**
 * Layer 1 of TSD 6.6 — raw scales, private to this directory.
 *
 * Nothing here carries meaning. `palette.green[600]` is a colour; whether it is a brand fill or a
 * success tone is `semantic.ts`'s decision, and which component uses it is `component.ts`'s. That
 * split is the whole point: a screen that needs "the success colour" must not be able to reach a
 * ramp step and pick one, because then two screens disagree about what success looks like and
 * nothing in the type system notices.
 *
 * The directory boundary is enforced two ways: `src/index.ts` does not re-export this module, and
 * `boundary.test.ts` fails if any file outside `src/theme/` imports it. See DECISIONS.md 9 for the
 * lint half of T-11-05's acceptance, which this phase could not add.
 *
 * Provenance of every value is recorded in `design-system/DECISIONS.md`. The short version: the
 * green, orange, slate and red anchors and the spacing scale come from the UI UX Pro Max
 * "Calorie & Nutrition Counter" palette and its MASTER.md; the type scale is TSD 6.6's four fixed
 * rules; the touch values are PRD 10.5 (2.1.0) via conflict X-05.
 *
 * This file is under SQG-09's 350-line cap and needs no exception. `semantic.ts`, `component.ts`
 * and `contrast.test.ts` are over it; each one's exception is recorded in DECISIONS.md 10.
 */

/**
 * Colour ramps. Steps are ordered light to dark in every family, in both schemes, so "600 is
 * darker than 400" never depends on which scheme is active — `semantic.ts` picks the step that
 * satisfies contrast, and it picks from a ramp whose direction does not move underneath it.
 *
 * `ink` and `sage` exist because the dark scheme is authored rather than inverted (TSD 6.6). A
 * dark canvas is not a light canvas flipped; it is a near-black with its own green cast, and the
 * steps for it have to be authored as their own family or they end up as arithmetic on the light
 * ones — which is the inversion the TSD forbids.
 */
export const palette = {
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',

  /** Brand. 600 and 500 are the generator's Primary and Secondary, adopted verbatim. */
  green: {
    50: '#ECFDF5',
    100: '#D1FAE5',
    200: '#A7F3D0',
    300: '#6EE7B7',
    400: '#34D399',
    500: '#10B981',
    600: '#059669',
    700: '#047857',
    800: '#065F46',
    900: '#064E3B',
  },

  /** Call to action, and the carbohydrate macro. 600 is the generator's Accent. */
  orange: {
    50: '#FFF7ED',
    100: '#FFEDD5',
    200: '#FED7AA',
    300: '#FDBA74',
    400: '#FB923C',
    500: '#F97316',
    600: '#EA580C',
    700: '#C2410C',
    800: '#9A3412',
    900: '#7C2D12',
  },

  /** The protein macro, and the informational status family. */
  blue: {
    50: '#EFF6FF',
    100: '#DBEAFE',
    200: '#BFDBFE',
    300: '#93C5FD',
    400: '#60A5FA',
    500: '#3B82F6',
    600: '#2563EB',
    700: '#1D4ED8',
    800: '#1E40AF',
    900: '#1E3A8A',
  },

  /** The fat macro, and the warning status family. */
  amber: {
    50: '#FFFBEB',
    100: '#FEF3C7',
    200: '#FDE68A',
    300: '#FCD34D',
    400: '#FBBF24',
    500: '#F59E0B',
    600: '#D97706',
    700: '#B45309',
    800: '#92400E',
    900: '#78350F',
  },

  /** Destructive and danger. 600 is the generator's Destructive. */
  red: {
    50: '#FEF2F2',
    100: '#FEE2E2',
    200: '#FECACA',
    300: '#FCA5A5',
    400: '#F87171',
    500: '#EF4444',
    600: '#DC2626',
    700: '#B91C1C',
    800: '#991B1B',
    900: '#7F1D1D',
  },

  /** Light-scheme text and neutrals. 900 is the generator's Foreground, 600 its Muted Foreground. */
  slate: {
    50: '#F8FAFC',
    100: '#F1F5F9',
    200: '#E2E8F0',
    300: '#CBD5E1',
    400: '#94A3B8',
    500: '#64748B',
    600: '#475569',
    700: '#334155',
    800: '#1E293B',
    900: '#0F172A',
  },

  /**
   * Light-scheme green-tinted neutrals. 50 is the generator's Muted, 100 its Border. Kept apart
   * from `slate` because they carry the canvas's green cast; mixing the two families is what
   * makes a "grey" surface read as dirty next to a mint one.
   */
  sage: {
    50: '#F0F8F6',
    100: '#E1F2ED',
    200: '#C7E5DC',
  },

  /**
   * Dark-scheme surfaces and text, authored for the dark canvas (TSD 6.6). 950 is the deepest
   * recess and 400 the softest readable text; none is a transform of a `slate` or `green` step.
   */
  ink: {
    400: '#8AA9A0',
    300: '#A9C4BB',
    200: '#E8F5F0',
    600: '#5E7F76',
    700: '#1E332C',
    800: '#18302A',
    850: '#12231E',
    900: '#0A1714',
    950: '#06100D',
    /** The label colour on a bright dark-scheme fill. Not `black`: pure black on a mint-bright
     * green reads as a hole, and this keeps the fill's own hue in the text. */
    ondark: '#04140F',
  },
} as const;

/**
 * Spacing. The generator's MASTER.md scale, adopted verbatim, plus `none`.
 *
 * `none` is not padding: SDD 14 forbids literals in feature code, and without a zero token a
 * component that needs no gap has to write `0`, which is the first literal and then the argument
 * for the next one.
 */
export const space = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

/** Corner radii. 8/12/16 are the generator's button, card and modal values. */
export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  /** Chip and NutritionBadge. Large enough to round any height this app renders. */
  pill: 999,
} as const;

/** Border widths. The generator's three: input 1, secondary button 2, focus ring 3. */
export const stroke = {
  hairline: 1,
  regular: 2,
  focus: 3,
} as const;

/**
 * Motion durations, in milliseconds. 150 and 200 are the generator's "clean transitions
 * (150-200ms ease)".
 *
 * `instant` exists so the reduced-motion path is a token swap rather than a conditional in every
 * animated component — PRD 10.5 and the generator's checklist both require honouring the OS
 * setting, and a rule that has to be re-implemented per component is a rule that gets missed.
 */
export const duration = {
  instant: 0,
  fast: 150,
  base: 200,
  slow: 300,
} as const;

/**
 * Easing curves as cubic-bézier control points.
 *
 * Documents are silent on the shape (DECISIONS.md S-01). Control points rather than named strings,
 * because one tuple feeds both React Native's `Easing.bezier(...)` and the web export's
 * `cubic-bezier(...)`; a named curve would need a per-platform lookup table.
 */
export const easing = {
  /** Most transitions: enters and exits that are not entrances. */
  standard: [0.2, 0, 0, 1],
  /** Something arriving — a sheet rising, a toast appearing. Slow out, no overshoot. */
  decelerate: [0, 0, 0, 1],
  /** Something leaving. It should not linger. */
  accelerate: [0.3, 0, 1, 1],
  /** Progress indicators, where any curve reads as a stall. */
  linear: [0, 0, 1, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

/**
 * Opacities.
 *
 * `pressed` and `scrim` are the generator's own 0.9 and 0.5. `disabled` at 0.4 is chosen: WCAG
 * 1.4.3 exempts inactive controls from the contrast minimum, and `contrast.test.ts` records that
 * exemption against the token rather than quietly leaving the pairing out of the table.
 */
export const opacity = {
  opaque: 1,
  pressed: 0.9,
  disabled: 0.4,
  scrim: 0.5,
} as const;

/**
 * One family carries the whole hierarchy through weight (TSD 6.6) — but on React Native the weight
 * has to be in the FAMILY NAME, which is why this is a map and not a string.
 *
 * **The previous value was `'Inter, -apple-system, Roboto, sans-serif'`, and it was wrong in two
 * ways at once.** React Native's native `fontFamily` takes a single family name and does not parse
 * a CSS fallback list, so on a device it matched nothing and silently fell back to the system face;
 * and nothing in the app ever loaded Inter, so even a correct single name would have found no font
 * to match. It rendered correctly only on web, where the stack really is CSS — which is precisely
 * how it survived P11 and P12 unnoticed (R-32).
 *
 * A second native constraint forces the shape: **RN does not synthesise weights for a custom
 * family.** Setting `fontFamily: 'Inter'` with `fontWeight: '700'` gives regular Inter on Android
 * and is unreliable on iOS. Each weight must name its own loaded face, so the scale's `fontWeight`
 * indexes this map and `fontWeight` is still set beside it for the web export, which does use it.
 *
 * Keys are strings because React Native's `fontWeight` accepts `'400' | '600' | ...` and a numeric
 * literal would not assign to it — which also makes `typeFamily[step.fontWeight]` total by
 * construction.
 */
export const typeFamily = {
  '400': 'Inter_400Regular',
  '600': 'Inter_600SemiBold',
  '700': 'Inter_700Bold',
  '800': 'Inter_800ExtraBold',
} as const;

/**
 * The type scale, unscaled.
 *
 * TSD 6.6 fixes four rules and this scale obeys them exactly: headlines 800 at -0.5 letter
 * spacing, subheadings 600 at 18, body 400 at a 24 line height, labels 700 uppercase at +1.
 * The steps above `subheading` are chosen (DECISIONS.md S-08) and are deliberately restrained:
 * the source catalog's "poster rule: body 16pt vs headline 40pt+" is rejected in DECISIONS.md 4.3,
 * because a 40 pt headline at a 2x OS font scale clips on every phone and PRD 10.5 requires
 * scaling "without clipping".
 *
 * These are the values BEFORE `useWindowDimensions().fontScale` is applied. The multiplication is
 * P12's, in `useTheme()`: a React hook cannot live in a pure package (DECISIONS.md S-09).
 */
export const typeScale = {
  display: { fontSize: 34, lineHeight: 40, fontWeight: '800', letterSpacing: -0.5 },
  headline: { fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.5 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.25 },
  subheading: { fontSize: 18, lineHeight: 24, fontWeight: '600', letterSpacing: 0 },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400', letterSpacing: 0 },
  bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600', letterSpacing: 0 },
  caption: { fontSize: 14, lineHeight: 20, fontWeight: '400', letterSpacing: 0 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '700', letterSpacing: 1 },
} as const;

/**
 * Touch targets, per PRD 10.5 (2.1.0) — conflict X-05, closed by D-07.
 *
 * Three platform minima and one value to build to. `buildTo` is 48 because 48 dp satisfies all
 * three, and the PRD says so in as many words. The three minima are exported anyway so P23 can
 * assert against the platform it is auditing rather than against the build-to value, which would
 * make an iOS-only regression invisible.
 */
export const touch = {
  iosMinPt: 44,
  androidMinDp: 48,
  webMinPx: 24,
  buildTo: 48,
  /** Minimum gap between two adjacent targets (Apple HIG, Material). */
  gap: 8,
} as const;

/**
 * Stacking bands. Gaps between them so P12 can insert a layer without renumbering the rest —
 * a renumbering is how one screen ends up with a sheet behind its own scrim.
 */
export const zIndex = {
  base: 0,
  raised: 1,
  header: 10,
  scrim: 100,
  sheet: 110,
  toast: 200,
} as const;
