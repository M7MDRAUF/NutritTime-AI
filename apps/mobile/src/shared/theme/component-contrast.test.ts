import { describe, expect, it } from 'vitest';
import type { ColorScheme, SemanticTokens } from './semantic.js';
import { colorsByScheme } from './semantic.js';
import { buildComponentTokens } from './component.js';

/**
 * **The COMPONENT tokens, on the surfaces they define. Split out of `contrast.test.ts` at P12.**
 *
 * Every pairing in that file is semantic-on-semantic, and a whole class of defect is invisible to
 * it: the `toast.tone*` failure lived in `component.ts`, which composed two individually-correct
 * semantic tokens into an unreadable pair. `status.*` is verified to AA on four surfaces;
 * `surface.inverse` is not one of them, and no semantic token names it, so no row could exist.
 * The eight pairings measured 1.49:1 to 2.76:1 and the suite stayed green.
 *
 * Its own file, rather than a fourteenth `describe` block, for two reasons: `contrast.test.ts` had
 * grown to 696 lines against the 459 its SQG-09 exception was granted at — 42% past a cap it was
 * already exempt from, which is how an exception becomes a blanket — and the split is along a real
 * seam. That file answers "is this colour pair readable"; this one answers "did
 * `buildComponentTokens` compose a readable pair", which is a different question with different
 * inputs.
 *
 * The WCAG arithmetic is duplicated rather than exported from a test file. Twenty lines, and both
 * copies are checked against the same known values.
 */

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** A decorative rule may sit under 3:1, but it must not vanish into its own background. */
const VISIBLE_MINIMUM = 1.05;

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

/** The four surfaces any of these tokens can land on. Same list as `contrast.test.ts`. */
const TEXT_SURFACES = [
  ['canvas', (c: SemanticTokens) => c.surface.canvas],
  ['raised', (c: SemanticTokens) => c.surface.raised],
  ['sunken', (c: SemanticTokens) => c.surface.sunken],
  ['overlay', (c: SemanticTokens) => c.surface.overlay],
] as const satisfies ReadonlyArray<readonly [string, (c: SemanticTokens) => string]>;

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

describe('component tokens are readable on their own backgrounds', () => {
  const componentPairings = [
    ['toast.text', (t: ReturnType<typeof buildComponentTokens>) => t.toast.text, AA_NORMAL_TEXT],
    [
      'toast.actionText',
      (t: ReturnType<typeof buildComponentTokens>) => t.toast.actionText,
      AA_NORMAL_TEXT,
    ],
    [
      'toast.toneInfo',
      (t: ReturnType<typeof buildComponentTokens>) => t.toast.toneInfo,
      AA_NON_TEXT,
    ],
    [
      'toast.toneSuccess',
      (t: ReturnType<typeof buildComponentTokens>) => t.toast.toneSuccess,
      AA_NON_TEXT,
    ],
    [
      'toast.toneWarning',
      (t: ReturnType<typeof buildComponentTokens>) => t.toast.toneWarning,
      AA_NON_TEXT,
    ],
    [
      'toast.toneDanger',
      (t: ReturnType<typeof buildComponentTokens>) => t.toast.toneDanger,
      AA_NON_TEXT,
    ],
  ] as const;

  it.each(SCHEMES)('a decorative rule stays visible on EVERY surface in %s', (scheme) => {
    /**
     * **The exemption row that hard-coded one surface, which is how an invisible divider shipped.**
     *
     * `border.subtle` is exempt from 1.4.11's 3:1 because it is a decorative rule, and the
     * exemption is bounded below by `VISIBLE_MINIMUM` so it cannot drift INTO its background. That
     * bound was checked against `surface.canvas` alone. Dark `border.subtle` was `ink[700]` and
     * `surface.overlay` is `ink[800]` - adjacent steps - so a dark `Sheet`'s divider measured
     * 1.0469 and was invisible, while the test reported 1.3662 and passed.
     *
     * All four surfaces now, both bounds, because `Divider` is a shared component and a screen
     * chooses where it goes.
     */
    const colors = colorsByScheme[scheme];
    for (const [name, background] of TEXT_SURFACES) {
      const ratio = contrastRatio(colors.border.subtle, background(colors));
      expect(
        ratio,
        `border.subtle on surface.${name} measures ${ratio.toFixed(4)}:1 - it has drifted into its own background`,
      ).toBeGreaterThan(VISIBLE_MINIMUM);
      expect(
        ratio,
        `border.subtle on surface.${name} measures ${ratio.toFixed(4)}:1 - too strong for a decorative rule`,
      ).toBeLessThan(AA_NON_TEXT);
    }
  });

  it.each(SCHEMES)('the loading fill stays visible against a card in %s', (scheme) => {
    // `effect.skeleton` had NO assertion anywhere, and its exemption was justified by a sentence
    // written for `ripple` and `highlight`: "a press layer whose own contrast is meaningless
    // because it composites over whatever it is pressed against". A skeleton is an opaque fill,
    // not a composite, and PRD 12 makes it the loading state - so it has to be visible against
    // the card it sits in, which is the pairing it actually has.
    const colors = colorsByScheme[scheme];
    const tokens = buildComponentTokens(colors);
    const ratio = contrastRatio(tokens.card.skeleton, tokens.card.background);
    expect(
      ratio,
      `card.skeleton on card.background measures ${ratio.toFixed(4)}:1`,
    ).toBeGreaterThan(VISIBLE_MINIMUM);
    expect(ratio).toBeLessThan(AA_NON_TEXT);
  });

  it.each(SCHEMES)('on the toast surface in %s', (scheme) => {
    const tokens = buildComponentTokens(colorsByScheme[scheme]);
    for (const [name, foreground, minimum] of componentPairings) {
      const ratio = contrastRatio(foreground(tokens), tokens.toast.background);
      expect(
        ratio,
        `${name} measures ${ratio.toFixed(2)}:1 on toast.background`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  /**
   * **`card.imageText` over the scrim, over the worst photograph there can be.**
   *
   * `MealCard` lays the meal's name on a remote photograph, which is the one background this theme
   * does not choose and cannot measure. What it does choose is `card.imageScrim` - a translucent
   * fill drawn between the two - and the scrim's ALPHA is the whole of the guarantee. So the
   * pairing is computed by compositing the scrim over a backdrop and measuring against that.
   *
   * **Pure white is the worst case and the only one that needs to hold**, because no photograph can
   * be brighter than white, and the scrim darkens whatever is under it. `card.skeleton` is checked
   * too, since it is what the box is painted with while an image loads or after it fails - and it
   * is the pairing a user sees when the network is down, which for this product is often.
   *
   * My first version of this test measured `imageText` against bare `card.skeleton` with no scrim
   * and reported 1.10:1 as a defect. It was the test that was wrong, not the tokens: the text is
   * never on the bare skeleton. Recorded because a false positive in a contrast suite costs
   * exactly as much trust as a false negative.
   */
  function compositeOver(translucent: string, opaqueHex: string): string {
    const channels = (hex: string): readonly number[] => {
      const digits = hex.replace('#', '');
      const full =
        digits.length === 3
          ? digits
              .split('')
              .map((character) => character + character)
              .join('')
          : digits;
      return [0, 1, 2].map((index) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16));
    };

    // The theme writes its scrims as 8-digit hex, so the alpha is the last pair.
    const raw = translucent.replace('#', '');
    const alpha = raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1;
    const front = channels(`#${raw.slice(0, 6)}`);
    const back = channels(opaqueHex);

    const mixed = [0, 1, 2].map((index) => {
      const f = front[index] ?? 0;
      const b = back[index] ?? 0;
      return Math.round(f * alpha + b * (1 - alpha));
    });
    return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }

  it.each(SCHEMES)('a meal name stays readable on any photograph in %s', (scheme) => {
    const tokens = buildComponentTokens(colorsByScheme[scheme]);

    for (const [label, backdrop] of [
      ['a pure-white photograph', '#FFFFFF'],
      ['card.skeleton, the unloaded-image floor', tokens.card.skeleton],
    ] as const) {
      const behind = compositeOver(tokens.card.imageScrim, backdrop);
      const ratio = contrastRatio(tokens.card.imageText, behind);
      expect(
        ratio,
        `card.imageText over card.imageScrim over ${label} measures ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('composites a known alpha correctly', () => {
    // The helper above is the load-bearing part of the assertion, so it gets its own check rather
    // than being trusted - and it earned it immediately: I wrote `#808080` here and the real answer
    // is `#7f7f7f`, because `0x80` is 128/255 = 0.50196, not 0.5, so white contributes 127.0 and
    // rounds down. A contrast suite whose compositor is a percent out is worse than no suite,
    // since every ratio it reports would be plausible and slightly wrong.
    expect(compositeOver('#00000080', '#FFFFFF')).toBe('#7f7f7f');
    expect(compositeOver('#123456FF', '#FFFFFF')).toBe('#123456');
    expect(compositeOver('#12345600', '#FFFFFF')).toBe('#ffffff');
  });
});
