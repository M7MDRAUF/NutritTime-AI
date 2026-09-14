import { describe, expect, it } from 'vitest';
import type { ColorScheme, SemanticTokens } from './semantic.js';
import { colorsByScheme, darkColors, lightColors } from './semantic.js';
import { typeScale } from './primitive.js';

/**
 * T-11-08 — PRD 10.5: "Both themes meet WCAG AA contrast where measurable."
 *
 * The ratios are computed here, from the WCAG 2.x relative-luminance definition, for every
 * foreground/background pairing the token maps can produce, in both schemes. TSD 2.1 pins the
 * toolchain, so there is no colour library and no contrast library; the formula is thirty lines and
 * adding a dependency to avoid writing them is not a trade this project makes.
 *
 * `where measurable` is doing real work in that sentence, and it is the part a test like this
 * usually gets wrong by silently omitting the awkward pairings. Three classes are exempt, and each
 * one is asserted *against its exemption* below rather than left out of the table:
 *
 *  1. WCAG 1.4.3 exempts inactive controls. `content.disabled` on `surface.disabled` is measured
 *     and reported, and only required to be legible-ish, not AA.
 *  2. WCAG 1.4.11 reaches "visual information required to identify user interface components", not
 *     decoration. `border.subtle` is a rule between list rows; it is measured and required only to
 *     be visible, while `border.default` — which is what identifies a text field — must clear 3:1.
 *  3. A pairing against a remote photograph has no known background, so the scrim's alpha is
 *     composited over the worst case (a pure-white photo) and the result must clear AA.
 *
 * Thresholds, from WCAG 2.2:
 *   4.5:1  normal text (1.4.3 AA)
 *   3.0:1  large text — 18.66 px bold or 24 px (1.4.3 AA), and non-text UI boundaries (1.4.11 AA)
 *
 * SQG-09 exception, recorded in DECISIONS.md 10. Plan.md 17.1 already carries three test files for
 * the same reason: the pairing table is the assertion, and a reader checking that a pairing is
 * covered needs the whole table.
 */

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** Below this a boundary is invisible rather than merely low-contrast. */
const VISIBLE_MINIMUM = 1.05;

/** No upper bound: an exemption whose premise is not "this pairing is weak" has no ceiling. */
const UNBOUNDED = Number.POSITIVE_INFINITY;

/** `#RRGGBB` or `#RRGGBBAA`, to 8-bit channels. Returns alpha as 0..1; 1 when absent. */
function parseHex(value: string): { r: number; g: number; b: number; a: number } {
  const body = value.startsWith('#') ? value.slice(1) : value;
  if (body.length !== 6 && body.length !== 8) {
    throw new Error(`Not a 6- or 8-digit hex colour: ${value}`);
  }
  const channel = (offset: number): number => {
    const pair = body.slice(offset, offset + 2);
    const parsed = Number.parseInt(pair, 16);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Not a hex pair at offset ${offset} of ${value}: ${pair}`);
    }
    return parsed;
  };
  return {
    r: channel(0),
    g: channel(2),
    b: channel(4),
    a: body.length === 8 ? channel(6) / 255 : 1,
  };
}

/**
 * WCAG 2.x relative luminance.
 *
 * L = 0.2126 R + 0.7152 G + 0.0722 B, over channels linearised by
 * c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4.
 *
 * The 0.03928 threshold is the figure in the WCAG 2.x definition itself. sRGB's own specification
 * says 0.04045; the two differ only in the eighth decimal of the result and WCAG's number is the
 * one a conformance claim is checked against, so it is the one used.
 */
function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const linearise = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/** WCAG 2.x contrast ratio: (Llighter + 0.05) / (Ldarker + 0.05). Order-independent. */
function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Source-over compositing of a translucent colour onto an opaque one. */
function compositeOver(translucent: string, base: string): string {
  const top = parseHex(translucent);
  const bottom = parseHex(base);
  const mix = (t: number, b: number): number => Math.round(top.a * t + (1 - top.a) * b);
  const toHex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(mix(top.r, bottom.r))}${toHex(mix(top.g, bottom.g))}${toHex(mix(top.b, bottom.b))}`;
}

interface Pairing {
  readonly name: string;
  readonly foreground: (c: SemanticTokens) => string;
  readonly background: (c: SemanticTokens) => string;
  readonly minimum: number;
}

/** The three surfaces any body text can land on. Every text tone is checked against all three. */
const TEXT_SURFACES = [
  ['canvas', (c: SemanticTokens) => c.surface.canvas],
  ['raised', (c: SemanticTokens) => c.surface.raised],
  ['sunken', (c: SemanticTokens) => c.surface.sunken],
  ['overlay', (c: SemanticTokens) => c.surface.overlay],
] as const satisfies ReadonlyArray<readonly [string, (c: SemanticTokens) => string]>;

/** Text tones that must be AA on every one of those surfaces. */
const TEXT_TONES = [
  ['content.primary', (c: SemanticTokens) => c.content.primary],
  ['content.secondary', (c: SemanticTokens) => c.content.secondary],
  ['content.tertiary', (c: SemanticTokens) => c.content.tertiary],
  ['content.link', (c: SemanticTokens) => c.content.link],
  ['accent.protein', (c: SemanticTokens) => c.accent.protein],
  ['accent.carb', (c: SemanticTokens) => c.accent.carb],
  ['accent.fat', (c: SemanticTokens) => c.accent.fat],
  ['status.info', (c: SemanticTokens) => c.status.info],
  ['status.success', (c: SemanticTokens) => c.status.success],
  ['status.warning', (c: SemanticTokens) => c.status.warning],
  ['status.danger', (c: SemanticTokens) => c.status.danger],
] as const satisfies ReadonlyArray<readonly [string, (c: SemanticTokens) => string]>;

const surfaceTextPairings: readonly Pairing[] = TEXT_TONES.flatMap(([toneName, foreground]) =>
  TEXT_SURFACES.map(([surfaceName, background]) => ({
    name: `${toneName} on surface.${surfaceName}`,
    foreground,
    background,
    minimum: AA_NORMAL_TEXT,
  })),
);

/** Labels on a filled control, status text on its own tint, and the inverse surface. */
const filledPairings: readonly Pairing[] = [
  {
    name: 'content.onBrand on accent.brand',
    foreground: (c) => c.content.onBrand,
    background: (c) => c.accent.brand,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.onBrand on accent.brandPressed',
    foreground: (c) => c.content.onBrand,
    background: (c) => c.accent.brandPressed,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.onBrand on surface.brand',
    foreground: (c) => c.content.onBrand,
    background: (c) => c.surface.brand,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.onAccent on accent.cta',
    foreground: (c) => c.content.onAccent,
    background: (c) => c.accent.cta,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.onAccent on accent.ctaPressed',
    foreground: (c) => c.content.onAccent,
    background: (c) => c.accent.ctaPressed,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.onDanger on status.danger',
    foreground: (c) => c.content.onDanger,
    background: (c) => c.status.danger,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.inverse on surface.inverse',
    foreground: (c) => c.content.inverse,
    background: (c) => c.surface.inverse,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.link on accent.brandSubtle',
    foreground: (c) => c.content.link,
    background: (c) => c.accent.brandSubtle,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'content.primary on accent.brandSubtle',
    foreground: (c) => c.content.primary,
    background: (c) => c.accent.brandSubtle,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'accent.carb on accent.ctaSubtle',
    foreground: (c) => c.accent.carb,
    background: (c) => c.accent.ctaSubtle,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'status.info on statusSurface.info',
    foreground: (c) => c.status.info,
    background: (c) => c.statusSurface.info,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'status.success on statusSurface.success',
    foreground: (c) => c.status.success,
    background: (c) => c.statusSurface.success,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'status.warning on statusSurface.warning',
    foreground: (c) => c.status.warning,
    background: (c) => c.statusSurface.warning,
    minimum: AA_NORMAL_TEXT,
  },
  {
    name: 'status.danger on statusSurface.danger',
    foreground: (c) => c.status.danger,
    background: (c) => c.statusSurface.danger,
    minimum: AA_NORMAL_TEXT,
  },
];

/**
 * WCAG 1.4.11 — 3:1 for the boundaries and indicators that identify a control or its state.
 *
 * `border.subtle` is deliberately absent: it is a decorative rule, and it gets its own weaker
 * assertion further down so that its exemption is recorded rather than assumed.
 */
const nonTextPairings: readonly Pairing[] = [
  ['border.default', (c: SemanticTokens) => c.border.default],
  ['border.strong', (c: SemanticTokens) => c.border.strong],
  ['border.focus', (c: SemanticTokens) => c.border.focus],
  ['border.brand', (c: SemanticTokens) => c.border.brand],
  ['border.danger', (c: SemanticTokens) => c.border.danger],
].flatMap(([borderName, foreground]) =>
  TEXT_SURFACES.map(([surfaceName, background]) => ({
    name: `${String(borderName)} on surface.${surfaceName}`,
    foreground: foreground as (c: SemanticTokens) => string,
    background,
    minimum: AA_NON_TEXT,
  })),
);

/**
 * **`surface.inverse` — the surface this file did not cover, and a defect got through because of
 * it.**
 *
 * P11 verified every text tone on canvas, raised, sunken and overlay. `toast` sits on
 * `surface.inverse`, which is none of those, so the four `toast.tone*` tokens - `status.*`, which
 * is authored against `surface.canvas`, the inverse surface's OPPOSITE in both schemes - shipped
 * at between **1.49:1 and 2.76:1** and nothing failed. The component author measured it and
 * refused to render them, which is the only reason it was caught before a device.
 *
 * The lesson generalises past this fix: **a pairing that is not in this table is not verified, and
 * a missing row looks exactly like a passing one.** Any future component that introduces a new
 * surface has to add its rows here in the same change.
 */
const inverseTextTones = [
  ['content.inverse', (c: SemanticTokens) => c.content.inverse],
  ['statusOnInverse.info', (c: SemanticTokens) => c.statusOnInverse.info],
  ['statusOnInverse.success', (c: SemanticTokens) => c.statusOnInverse.success],
  ['statusOnInverse.warning', (c: SemanticTokens) => c.statusOnInverse.warning],
  ['statusOnInverse.danger', (c: SemanticTokens) => c.statusOnInverse.danger],
] as const satisfies ReadonlyArray<readonly [string, (c: SemanticTokens) => string]>;

const inversePairings: readonly Pairing[] = inverseTextTones.map(([toneName, foreground]) => ({
  name: `${toneName} on surface.inverse`,
  foreground,
  background: (c: SemanticTokens) => c.surface.inverse,
  // AA for TEXT, not 1.4.11's 3:1 for an indicator. A tone glyph is a non-text indicator and 3:1
  // would suffice, but every one of these clears 5.78:1 with the values crossed, so asserting the
  // weaker bound would leave room for a regression that is still technically conforming.
  minimum: AA_NORMAL_TEXT,
}));

const allPairings: readonly Pairing[] = [
  ...surfaceTextPairings,
  ...filledPairings,
  ...nonTextPairings,
  ...inversePairings,
];

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

describe('the WCAG implementation itself', () => {
  // Anchors from the WCAG 2.x definition, so a regression in the formula fails here rather than
  // silently relaxing every assertion below it.
  it('returns 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#059669', '#059669')).toBeCloseTo(1, 10);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#0F172A', '#ECFDF5')).toBeCloseTo(
      contrastRatio('#ECFDF5', '#0F172A'),
      10,
    );
  });

  it('reproduces the published relative luminance of the sRGB primaries', () => {
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 10);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
  });

  it('exercises the linear branch below the 0.03928 threshold', () => {
    // 0x08 / 255 = 0.0314, under the threshold, so the linear branch decides this value. Without
    // a case here the branch could be wrong and nothing in the suite would notice.
    expect(relativeLuminance('#080808')).toBeCloseTo(0.00243, 5);
  });

  it('composites a translucent colour over an opaque one', () => {
    // `#80` is 128/255 = 50.196%, not 50%, so black at that alpha over white lands on 127 and not
    // 128. Asserting the round number here would have been asserting the wrong arithmetic.
    expect(compositeOver('#00000080', '#FFFFFF')).toBe('#7F7F7F');
    expect(compositeOver('#FFFFFFFF', '#000000')).toBe('#FFFFFF');
    expect(compositeOver('#00000000', '#123456')).toBe('#123456');
  });

  it('rejects a value that is not a hex colour', () => {
    expect(() => relativeLuminance('rgb(1,2,3)')).toThrow(/6- or 8-digit hex/);
    expect(() => relativeLuminance('#ABC')).toThrow(/6- or 8-digit hex/);
  });
});

describe.each(SCHEMES)('%s scheme meets WCAG AA', (scheme) => {
  const colors = colorsByScheme[scheme];

  it.each(allPairings.map((p) => [p.name, p] as const))('%s', (_name, pairing) => {
    const foreground = pairing.foreground(colors);
    const background = pairing.background(colors);
    const ratio = contrastRatio(foreground, background);
    // The message carries the two hexes and the ratio, so a failure names the values to change
    // rather than only the roles.
    expect(
      ratio,
      `${pairing.name}: ${foreground} on ${background} = ${ratio.toFixed(2)}:1, needs ${pairing.minimum}:1`,
    ).toBeGreaterThanOrEqual(pairing.minimum);
  });
});

/**
 * **The coverage guard, and the direction it used to collapse.**
 *
 * The pairing table is hand-written, so this block is the guard against a token being added to
 * `SemanticTokens` and never appearing in an assertion. It had a hole of its own: it built ONE flat
 * set from `p.name.split(' on ')` — both halves of every pairing name thrown into the same bag —
 * and then asked only whether a role appeared in it. A role measured once as a **background**
 * therefore counted as coverage for its use as a **foreground**.
 *
 * That is not hypothetical. `accent.brand` appears in this table exactly once, as the fill under
 * `content.onBrand`; `TabNavigator.tsx` and `navigationTheme.ts` drew it as the active tab's LABEL
 * on `surface.raised`, which is **3.77:1** in light, and this guard reported full coverage. It is
 * the same shape of hole the two docblocks above already record twice — a missing row looks exactly
 * like a passing one — one level up, in the guard meant to find missing rows.
 *
 * So coverage is now **ordered**: the left of a pairing name is the foreground, the right is the
 * background, and every role has to be classified below before either direction counts. A role
 * drawn as body text is required on every surface a screen could put it on, not merely "somewhere",
 * because "somewhere" is the weaker claim that let the tab label through.
 */
describe('coverage of the token maps', () => {
  /**
   * Roles this theme draws as text or as an icon on a surface a SCREEN chooses. Each must be
   * measured against every surface in `TEXT_SURFACES`, in both schemes.
   */
  const TEXT_FOREGROUND_ROLES = [
    'content.primary',
    'content.secondary',
    'content.tertiary',
    'content.link',
    'accent.protein',
    'accent.carb',
    'accent.fat',
    'status.info',
    'status.success',
    'status.warning',
    'status.danger',
  ] as const;

  /**
   * Foregrounds whose background is fixed by the role itself — a label that exists only for one
   * fill, a border, a tone on the inverse surface. Each must appear as the foreground of at least
   * one pairing; which background is named in the table beside it.
   */
  const PAIRED_FOREGROUND_ROLES = [
    'content.inverse',
    'content.onBrand',
    'content.onAccent',
    'content.onDanger',
    'statusOnInverse.info',
    'statusOnInverse.success',
    'statusOnInverse.warning',
    'statusOnInverse.danger',
    'border.default',
    'border.strong',
    'border.focus',
    'border.brand',
    'border.danger',
  ] as const;

  /**
   * Roles drawn BEHIND something. `status.danger` is deliberately in both lists: it is a text tone
   * on the four surfaces and the fill under `content.onDanger`, and a role used both ways has to be
   * measured both ways.
   *
   * `statusSurface.*` moved here from the exemption list, where it had been dead weight: all four
   * already appear as the background of a `status.* on statusSurface.*` row, so exempting them from
   * needing a pairing exempted nothing.
   */
  const BACKGROUND_ROLES = [
    'surface.canvas',
    'surface.raised',
    'surface.sunken',
    'surface.overlay',
    'surface.inverse',
    'surface.brand',
    'accent.brand',
    'accent.brandPressed',
    'accent.brandSubtle',
    'accent.cta',
    'accent.ctaPressed',
    'accent.ctaSubtle',
    'status.danger',
    'statusSurface.info',
    'statusSurface.success',
    'statusSurface.warning',
    'statusSurface.danger',
  ] as const;

  /**
   * **Roles no `<foreground> on <background>` row can name — and what each one measures instead.**
   *
   * This was a bare `Set` of eleven names called `COLOUR_ROLES_WITHOUT_A_PAIRING`, and an audit of
   * P23 found it **required no measurement at all**: adding a role to it satisfied every assertion
   * in this file, so the one list whose job was to account for the unmeasured roles was itself the
   * cheapest way to make a role unmeasured. Two of them — `effect.ripple` and `effect.highlight` —
   * had in fact never been measured anywhere, and `effect.shadowColor` was asserted by nothing in
   * the repository.
   *
   * So a `measure` is now **required by the type**. A name cannot be added here without saying what
   * is measured in the pairing's place, and the bound is two-sided wherever the exemption's premise
   * is that the pairing is WEAK: above the ceiling the exemption is unnecessary and the row should
   * be deleted rather than left to cover something it no longer describes. That is the same
   * argument `statusOnInverseIsNecessary` above makes about its own reason for existing.
   */
  interface ExemptRole {
    readonly role: string;
    /** Why no row in the table above can name it. */
    readonly because: string;
    /** What is measured in the pairing's place. A role with nothing to measure is a defect. */
    readonly measure: (c: SemanticTokens) => number;
    readonly floor: number;
    readonly ceiling: number;
  }

  /** The worst of the four surfaces, because a screen chooses which one a component lands on. */
  const worstSurface = (value: string, c: SemanticTokens): number =>
    Math.min(...TEXT_SURFACES.map(([, read]) => contrastRatio(value, read(c))));

  /** How much a translucent layer changes the least dimmable thing there is. */
  const dimsWhite = (scrim: string): number =>
    contrastRatio(compositeOver(scrim, '#FFFFFF'), '#FFFFFF');

  /** A press layer composites over whatever it is pressed against, so measure it against each. */
  const pressLayer = (layer: string, c: SemanticTokens): number =>
    Math.min(
      ...TEXT_SURFACES.map(([, read]) => {
        const surface = read(c);
        return contrastRatio(compositeOver(layer, surface), surface);
      }),
    );

  const MEASURED_WITHOUT_A_TOKEN_PAIRING: readonly ExemptRole[] = [
    {
      role: 'content.disabled',
      because: 'WCAG 1.4.3 exempts the text of an inactive user interface component',
      measure: (c) => contrastRatio(c.content.disabled, c.surface.disabled),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NORMAL_TEXT,
    },
    {
      role: 'surface.disabled',
      because: 'it is only ever the ground under `content.disabled`, which 1.4.3 exempts',
      measure: (c) => contrastRatio(c.content.disabled, c.surface.disabled),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NORMAL_TEXT,
    },
    {
      role: 'border.subtle',
      because: '1.4.11 reaches what identifies a control, and a rule between rows identifies none',
      measure: (c) => worstSurface(c.border.subtle, c),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NON_TEXT,
    },
    {
      role: 'scrim.backdrop',
      because: 'no text sits on it; its job is to separate a sheet from the app beneath',
      measure: (c) => dimsWhite(c.scrim.backdrop),
      floor: AA_NON_TEXT,
      ceiling: UNBOUNDED,
    },
    {
      role: 'scrim.sheet',
      because: 'a separator inside an already-AA sheet, over whatever the sheet is showing',
      measure: (c) => dimsWhite(c.scrim.sheet),
      floor: AA_NON_TEXT,
      ceiling: UNBOUNDED,
    },
    {
      role: 'scrim.image',
      because: 'what is under it is a remote photograph, which this theme does not choose',
      measure: (c) => contrastRatio(c.content.onImage, compositeOver(c.scrim.image, '#FFFFFF')),
      floor: AA_NORMAL_TEXT,
      ceiling: UNBOUNDED,
    },
    {
      role: 'content.onImage',
      because: 'its background is that same photograph, reached only through the composited scrim',
      measure: (c) => contrastRatio(c.content.onImage, compositeOver(c.scrim.image, '#FFFFFF')),
      floor: AA_NORMAL_TEXT,
      ceiling: UNBOUNDED,
    },
    {
      role: 'effect.shadowColor',
      because: 'a shadow is cast by a surface rather than drawn on one',
      // Only that it is distinguishable from the darkest surface it can be cast on. That it is
      // DARKER — a shadow that lightens is a glow — is asserted at the component layer, where
      // `card`, `sheet` and `toast` are the three groups that actually cast one.
      measure: (c) => worstSurface(c.effect.shadowColor, c),
      floor: VISIBLE_MINIMUM,
      ceiling: UNBOUNDED,
    },
    {
      role: 'effect.skeleton',
      because: 'it replaces content rather than sitting on it, and PRD 12 makes it a loading state',
      measure: (c) => contrastRatio(c.effect.skeleton, c.surface.raised),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NON_TEXT,
    },
    {
      role: 'effect.ripple',
      because: "Android's press layer composites over whatever it is pressed against",
      measure: (c) => pressLayer(c.effect.ripple, c),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NON_TEXT,
    },
    {
      role: 'effect.highlight',
      because: "iOS's press overlay composites over whatever it is pressed against",
      measure: (c) => pressLayer(c.effect.highlight, c),
      floor: VISIBLE_MINIMUM,
      ceiling: AA_NON_TEXT,
    },
  ];

  function colourRoles(tokens: SemanticTokens): string[] {
    const roles: string[] = [];
    for (const [group, members] of Object.entries(tokens)) {
      for (const [member, value] of Object.entries(members as Record<string, unknown>)) {
        if (typeof value === 'string') {
          roles.push(`${group}.${member}`);
        }
      }
    }
    return roles;
  }

  /** A pairing name is `<foreground> on <background>`, and the two halves are kept apart. */
  function halves(name: string): { foreground: string; background: string } {
    const parts = name.split(' on ');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new Error(`Pairing name is not "<foreground> on <background>": ${name}`);
    }
    return { foreground: parts[0], background: parts[1] };
  }

  const pairingNames = new Set(allPairings.map((p) => p.name));
  const measuredAsForeground = new Set(allPairings.map((p) => halves(p.name).foreground));
  const measuredAsBackground = new Set(allPairings.map((p) => halves(p.name).background));
  const classified = [
    ...TEXT_FOREGROUND_ROLES,
    ...PAIRED_FOREGROUND_ROLES,
    ...BACKGROUND_ROLES,
    ...MEASURED_WITHOUT_A_TOKEN_PAIRING.map((exempt) => exempt.role),
  ];

  it.each(SCHEMES)('%s: every colour role declares the direction it is drawn in', (scheme) => {
    const declared = new Set(classified);
    const unclassified = colourRoles(colorsByScheme[scheme]).filter((role) => !declared.has(role));
    // A new token cannot be added without someone deciding whether it is drawn on top of something
    // or underneath it — which is the decision that was never made for `accent.brand`.
    expect(unclassified, `colour roles with no declared direction of use`).toEqual([]);
  });

  it('declares no role the token maps do not define', () => {
    // The other direction. A renamed or deleted token would otherwise leave a stale entry above
    // that quietly requires nothing, and the guard would report coverage of a role that is gone.
    const real = new Set(colourRoles(lightColors));
    expect(classified.filter((role) => !real.has(role))).toEqual([]);
  });

  it('measures every text foreground on every surface a screen can put it on', () => {
    const missing = TEXT_FOREGROUND_ROLES.flatMap((role) =>
      TEXT_SURFACES.map(([surfaceName]) => `${role} on surface.${surfaceName}`).filter(
        (name) => !pairingNames.has(name),
      ),
    );
    expect(missing, `text tones with a surface they are never measured against`).toEqual([]);
  });

  it('measures every foreground AS a foreground, not merely somewhere', () => {
    // The assertion the old guard could not make. `accent.brand` satisfied the old one by being a
    // background; the moment a role is declared a foreground it has to appear on the LEFT of a
    // pairing name, and no amount of use as a fill will substitute for it.
    const unmeasured = [...TEXT_FOREGROUND_ROLES, ...PAIRED_FOREGROUND_ROLES].filter(
      (role) => !measuredAsForeground.has(role),
    );
    expect(unmeasured, `roles drawn as a foreground with no foreground pairing`).toEqual([]);
  });

  it('measures every background AS a background', () => {
    const unmeasured = BACKGROUND_ROLES.filter((role) => !measuredAsBackground.has(role));
    expect(unmeasured, `roles drawn as a background with no background pairing`).toEqual([]);
  });

  it('both schemes define exactly the same roles, so neither can be partial', () => {
    expect(colourRoles(lightColors)).toEqual(colourRoles(darkColors));
  });

  it('asserts both schemes, not just light', () => {
    // The generator's own pre-delivery checklist asks only for "Light mode: text contrast 4.5:1".
    // PRD 10.5 requires both, and this is the assertion that the stronger rule is the one in force.
    expect(SCHEMES).toEqual(['light', 'dark']);
    expect(allPairings.length).toBeGreaterThan(50);
  });

  it.each(SCHEMES)('%s: every exempt role measures something in the pairing’s place', (scheme) => {
    const colors = colorsByScheme[scheme];
    for (const exempt of MEASURED_WITHOUT_A_TOKEN_PAIRING) {
      const measured = exempt.measure(colors);
      expect(
        measured,
        `${exempt.role} (${exempt.because}) measures ${measured.toFixed(4)}, needs at least ${String(exempt.floor)}`,
      ).toBeGreaterThanOrEqual(exempt.floor);
      if (exempt.ceiling !== UNBOUNDED) {
        expect(
          measured,
          `${exempt.role} measures ${measured.toFixed(4)} - at or above ${String(exempt.ceiling)} the exemption is unnecessary and this row should be deleted rather than left to cover a pairing it no longer describes`,
        ).toBeLessThan(exempt.ceiling);
      }
    }
  });

  it('exempts exactly the roles no pairing names, in either direction', () => {
    // The exemption list is now DERIVED from the table rather than trusted beside it: a role that
    // no pairing names on either side must appear here, and a role that a pairing does name must
    // not. A new token added without a row fails; an exemption left behind after a row was added
    // for it fails too, which is the "quietly converging" failure this file already guards against
    // for `statusOnInverse`.
    const paired = new Set([...measuredAsForeground, ...measuredAsBackground]);
    const unpaired = colourRoles(lightColors)
      .filter((role) => !paired.has(role))
      .sort();
    expect(unpaired).toEqual(MEASURED_WITHOUT_A_TOKEN_PAIRING.map((e) => e.role).sort());
  });

  it('classifies no role in a direction its own group contradicts', () => {
    // The four lists above are declarations, and an audit of P23 found them checked against nothing
    // but each other — so a label repointed at `accent.brand` would have passed every assertion in
    // this file. `SemanticTokens` authors `surface`, `statusSurface` and `scrim` as grounds and
    // `content`, `border` and `statusOnInverse` as marks, so a role declared against its own
    // group's direction is a mistake the interface's own structure can see.
    //
    // It does NOT reach `accent`, `status` or `effect`, whose roles are legitimately used both ways
    // — `accent.brand` is a fill and `accent.protein` is a text tone. That is why the real closure
    // is at the component layer: `component-contrast.test.ts` checks the direction
    // `buildComponentTokens` paints each role in, against the member name that paints it.
    const groundGroups = new Set(['surface', 'statusSurface', 'scrim']);
    const markGroups = new Set(['content', 'border', 'statusOnInverse']);
    const groupOf = (role: string): string => role.split('.')[0] ?? '';
    expect(
      [...TEXT_FOREGROUND_ROLES, ...PAIRED_FOREGROUND_ROLES].filter((role) =>
        groundGroups.has(groupOf(role)),
      ),
      'roles declared as a foreground whose group is authored as a ground',
    ).toEqual([]);
    expect(
      BACKGROUND_ROLES.filter((role) => markGroups.has(groupOf(role))),
      'roles declared as a background whose group is authored as a mark',
    ).toEqual([]);
  });

  it('states how much of the classification is still declared, with the count', () => {
    // The residue, counted rather than implied. Deriving these four lists from the pairing table
    // they exist to guard would be circular - BRIEF 6.1g's bad case, an expectation computed from
    // the subject - so they stay hand-written and the count is what makes that visible to a reader.
    // 52 entries for 51 roles: `status.danger` is declared twice because it is used twice, as the
    // danger text tone and as the destructive fill.
    expect(TEXT_FOREGROUND_ROLES.length + PAIRED_FOREGROUND_ROLES.length).toBe(24);
    expect(BACKGROUND_ROLES.length).toBe(17);
    expect(MEASURED_WITHOUT_A_TOKEN_PAIRING.length).toBe(11);
    expect(classified.length).toBe(52);
    expect(colourRoles(lightColors).length).toBe(51);
  });
});

describe('the type scale does not create a large-text loophole', () => {
  // 3:1 is permitted only for text at 18.66 px bold or 24 px. Every step of this scale is below
  // both, so 4.5:1 is the only applicable threshold and no pairing above may claim the lower one.
  it('has no step that would qualify for the 3:1 large-text allowance', () => {
    for (const [name, step] of Object.entries(typeScale)) {
      const bold = Number.parseInt(step.fontWeight, 10) >= 700;
      const qualifies = step.fontSize >= 24 || (bold && step.fontSize >= 18.66);
      expect(qualifies, `${name} at ${step.fontSize}px/${step.fontWeight}`).toBe(
        name === 'display' || name === 'headline' || name === 'title',
      );
    }
  });
});

/**
 * **The component tokens are measured in `component-contrast.test.ts`, not here.**
 *
 * Every pairing above is semantic-on-semantic, and a whole class of defect is invisible to that:
 * the `toast.tone*` failure lived in `component.ts`, whose four tokens pointed at `status.*` —
 * verified to AA on four surfaces and unreadable on the fifth, `toast.background`, which no row
 * here covered because no SEMANTIC token names it. Both halves were individually correct and the
 * composition was not.
 *
 * This docblock introduced that block until P12 moved it to its own file and left the comment
 * behind pointing at nothing. Kept as a pointer rather than deleted, because the sentence it
 * carries — a semantic-level suite cannot see a composition defect — is the reason the other file
 * exists.
 */
