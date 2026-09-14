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
const AA_LARGE_TEXT = 3;
const AA_NON_TEXT = 3;

/** Below this a boundary is invisible rather than merely low-contrast. */
const VISIBLE_MINIMUM = 1.05;

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

/**
 * The status tones must NOT be usable on the inverse surface, which is the point of the split.
 *
 * Asserted as a failure rather than left implicit: if a future edit ever made `status.*` readable
 * on `surface.inverse` - by moving `surface.inverse` towards the canvas, say - then `statusOnInverse`
 * would be redundant and someone should be told, rather than the two quietly converging.
 */
const statusOnInverseIsNecessary: readonly Pairing[] = [
  ['status.info', (c: SemanticTokens) => c.status.info],
  ['status.success', (c: SemanticTokens) => c.status.success],
  ['status.warning', (c: SemanticTokens) => c.status.warning],
  ['status.danger', (c: SemanticTokens) => c.status.danger],
].map(([toneName, foreground]) => ({
  name: `${String(toneName)} on surface.inverse`,
  foreground: foreground as (c: SemanticTokens) => string,
  background: (c: SemanticTokens) => c.surface.inverse,
  minimum: AA_NON_TEXT,
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

describe.each(SCHEMES)('%s scheme: text over a remote meal photograph', (scheme) => {
  const colors = colorsByScheme[scheme];

  // `MealCard` takes an `imageUrl` (TSD 6.7) and a remote photograph is arbitrary, so the only
  // honest assertion is against the worst case. The brightest possible photo is pure white, and a
  // scrim that holds AA there holds it for every darker image.
  it('holds AA with the scrim composited over a pure-white image', () => {
    const worstCase = compositeOver(colors.scrim.image, '#FFFFFF');
    const ratio = contrastRatio(colors.content.onImage, worstCase);
    expect(
      ratio,
      `scrim.image over white = ${worstCase}; content.onImage on it = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  // `content.onImage` exists because this assertion first ran against `content.inverse` and failed
  // at 2.62:1 in dark — the dark scheme's inverse tone is *dark*, since its inverse surface is
  // light, and dark text over a darkened photograph is unreadable. The token was wrong, not the
  // threshold.
  it('uses a light foreground over an image in both schemes', () => {
    expect(relativeLuminance(colors.content.onImage)).toBeGreaterThan(0.5);
  });
});

describe.each(SCHEMES)('%s scheme: the backdrop actually dims the app behind a sheet', (scheme) => {
  const colors = colorsByScheme[scheme];

  // No text sits on a backdrop, so a text threshold would be the wrong question. What a backdrop
  // has to do is separate the sheet from the app beneath it, and the least-dimmable app is a white
  // one. 3:1 is borrowed from 1.4.11 as the boundary-visibility figure.
  it.each(['backdrop', 'sheet'] as const)('scrim.%s dims a white app by at least 3:1', (which) => {
    const dimmed = compositeOver(colors.scrim[which], '#FFFFFF');
    const ratio = contrastRatio(dimmed, '#FFFFFF');
    expect(ratio, `scrim.${which} over white = ${dimmed}`).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });
});

describe.each(SCHEMES)('%s scheme: recorded exemptions', (scheme) => {
  const colors = colorsByScheme[scheme];

  // WCAG 1.4.11 reaches information "required to identify user interface components". A rule
  // between two list rows identifies nothing, so `border.subtle` is exempt — but it still has to
  // be visible, and asserting that is what stops it drifting to the surface colour.
  it('border.subtle is visible but is exempt from 1.4.11, being decorative', () => {
    const ratio = contrastRatio(colors.border.subtle, colors.surface.canvas);
    expect(ratio).toBeGreaterThan(VISIBLE_MINIMUM);
    expect(ratio).toBeLessThan(AA_NON_TEXT);
  });

  // WCAG 1.4.3 exempts "text or images of text that are part of an inactive user interface
  // component". Measured and bounded rather than omitted: a disabled label that fell to 1.2:1
  // would be invisible, which is a usability failure even where it is not a conformance one.
  it('content.disabled is exempt from 1.4.3, being an inactive control', () => {
    const ratio = contrastRatio(colors.content.disabled, colors.surface.disabled);
    expect(ratio).toBeGreaterThan(VISIBLE_MINIMUM);
  });

  // A status tint is not what tells the user the status: TSD 6.7 makes `icon` a required prop on
  // `StatusMessage`, and PRD 10.5 forbids colour as the sole carrier. So the tint is decoration
  // over the canvas, and the 3:1 obligation lands on `status.*`, asserted above.
  it.each(['info', 'success', 'warning', 'danger'] as const)(
    'statusSurface.%s is decoration; the icon and text carry the status',
    (tone) => {
      const ratio = contrastRatio(colors.statusSurface[tone], colors.surface.canvas);
      expect(ratio).toBeGreaterThan(1);
      expect(contrastRatio(colors.status[tone], colors.surface.canvas)).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    },
  );
});

describe('coverage of the token maps', () => {
  // The pairing table is hand-written, so this is the guard against a token being added to
  // `SemanticTokens` and never appearing in an assertion. It fails when a new colour role lands
  // without a pairing, which is exactly the regression T-11-08 exists to catch.
  const COLOUR_ROLES_WITHOUT_A_PAIRING = new Set([
    // Asserted through the exemptions above rather than the AA table.
    'content.disabled',
    'surface.disabled',
    'border.subtle',
    'statusSurface.info',
    'statusSurface.success',
    'statusSurface.warning',
    'statusSurface.danger',
    'scrim.backdrop',
    'scrim.image',
    // Asserted against the composited scrim above, not against a token background: the thing
    // underneath it is a remote photograph, which this theme does not choose.
    'content.onImage',
    // A separator inside an already-AA sheet, and a press layer whose own contrast is meaningless
    // because it composites over whatever it is pressed against.
    'scrim.sheet',
    'effect.shadowColor',
    'effect.skeleton',
    'effect.ripple',
    'effect.highlight',
  ]);

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

  const named = new Set(allPairings.flatMap((p) => p.name.split(' on ')));

  it.each(SCHEMES)('%s: every colour role is asserted or explicitly exempt', (scheme) => {
    const unasserted = colourRoles(colorsByScheme[scheme]).filter(
      (role) => !named.has(role) && !COLOUR_ROLES_WITHOUT_A_PAIRING.has(role),
    );
    expect(unasserted, `colour roles with no pairing and no recorded exemption`).toEqual([]);
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

describe('the canvas status tones are unusable on surface.inverse', () => {
  // The reason `statusOnInverse` exists, asserted rather than assumed. Every one of these was
  // between 1.49:1 and 2.76:1 when `toast.tone*` pointed at them, and all eight failed 1.4.11.
  it.each(SCHEMES)('in %s', (scheme) => {
    const colors = colorsByScheme[scheme];
    for (const pairing of statusOnInverseIsNecessary) {
      const ratio = contrastRatio(pairing.foreground(colors), pairing.background(colors));
      expect(
        ratio,
        `${pairing.name} measures ${ratio.toFixed(2)}:1 - if this now PASSES 3:1, statusOnInverse is redundant and should be removed rather than left to diverge`,
      ).toBeLessThan(AA_NON_TEXT);
    }
  });
});

/**
 * **The component tokens, on the surfaces THEY define. This is the block whose absence let a
 * defect ship.**
 *
 * Every pairing above is semantic-on-semantic. The `toast.tone*` failure lived in `component.ts`:
 * the four tokens pointed at `status.*`, which is verified to AA on four surfaces and is
 * unreadable on the fifth - `toast.background` - which no row covered because no SEMANTIC token
 * names it. A semantic-level suite cannot see that class of defect at all: both halves are
 * individually correct and the composition is not.
 *
 * So this asserts what `buildComponentTokens` actually produced, which is what a component reads.
 */
