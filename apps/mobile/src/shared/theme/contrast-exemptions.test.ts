import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ColorScheme, SemanticTokens } from './semantic.js';
import { colorsByScheme, darkColors, lightColors } from './semantic.js';

/**
 * **"Where measurable" — the pairings asserted AGAINST their exemption. Split out of
 * `contrast.test.ts` at P23.**
 *
 * PRD 10.5 says "Both themes meet WCAG AA contrast where measurable", and `where measurable` is
 * doing real work in that sentence. It is also the part a suite like this usually gets wrong by
 * silently omitting the awkward pairings, so each exempt class is measured and bounded here rather
 * than left out of the table next door:
 *
 *  1. WCAG 1.4.3 exempts inactive controls. `content.disabled` on `surface.disabled` is measured
 *     and only required to be legible-ish, not AA.
 *  2. WCAG 1.4.11 reaches "visual information required to identify user interface components", not
 *     decoration. `border.subtle` is a rule between list rows; it is required only to be visible.
 *  3. A pairing against a remote photograph has no known background, so the scrim's alpha is
 *     composited over the worst case — a pure-white photo — and the result must clear AA.
 *  4. A status tint is not what tells the user the status (TSD 6.7 makes `icon` required on
 *     `StatusMessage`), so the tint is decoration and the 3:1 lands on `status.*`.
 *  5. A tone authored for ONE ground is not safe on a ground a screen chooses — the last block,
 *     which is where three pairings measure exactly 1.0000:1.
 *
 * **Why it is its own file.** `contrast.test.ts` reached 922 lines against a row of 670 when P23's
 * measured-exemption table and its coverage closure landed. `Plan.md` 17.1 records what happens at
 * that point: the same file grew to 696 against the 459 it was exempt at — "42% past a cap it was
 * already exempt from, which is how an exception becomes a blanket" — and it was **split rather
 * than re-approved**. This is the second application of that precedent to the same file.
 *
 * The seam is the one the coverage guard makes available. Everything that is a **control on the
 * pairing table** stayed with the table — the table itself, the AA measurement over it, the
 * coverage closure and the residue counts, because a derivation separated from the thing it
 * derives is how residue counts go stale. What moved is everything asserted against an
 * *exemption*: those name their own pairing, are complete in themselves, and are no longer the
 * record that nothing was omitted — the closure assertion in `contrast.test.ts` is, and it is a
 * stronger record than a paragraph promising it.
 *
 * Nothing was rewritten. Six blocks, moved by line range with a `count == 1` anchor: the
 * `statusOnInverse` necessity table and its describe, the meal-photograph composite, the backdrop
 * composite, the recorded exemptions, and the bound content tones.
 *
 * The WCAG arithmetic is duplicated rather than imported from a test file, as in all three
 * neighbours, and this copy is anchored against the published values at the bottom.
 */

const AA_NORMAL_TEXT = 4.5;
const AA_LARGE_TEXT = 3;
const AA_NON_TEXT = 3;

/** Below this a boundary is invisible rather than merely low-contrast. */
const VISIBLE_MINIMUM = 1.05;

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

/** The three surfaces any body text can land on. Every text tone is checked against all three. */
const TEXT_SURFACES = [
  ['canvas', (c: SemanticTokens) => c.surface.canvas],
  ['raised', (c: SemanticTokens) => c.surface.raised],
  ['sunken', (c: SemanticTokens) => c.surface.sunken],
  ['overlay', (c: SemanticTokens) => c.surface.overlay],
] as const satisfies ReadonlyArray<readonly [string, (c: SemanticTokens) => string]>;

interface Pairing {
  readonly name: string;
  readonly foreground: (c: SemanticTokens) => string;
  readonly background: (c: SemanticTokens) => string;
  readonly minimum: number;
}

/** `#RRGGBB` or `#RRGGBBAA`, to 8-bit channels. Returns alpha as 0..1; 1 when absent. */
function parseHex(value: string): { r: number; g: number; b: number; a: number } {
  const body = value.startsWith('#') ? value.slice(1) : value;
  if (body.length !== 6 && body.length !== 8) {
    throw new Error(`Not a 6- or 8-digit hex colour: ${value}`);
  }
  const channel = (offset: number): number => {
    const parsed = Number.parseInt(body.slice(offset, offset + 2), 16);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Not a hex pair at offset ${offset} of ${value}`);
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

/** Source-over compositing of a translucent colour onto an opaque one. */
function compositeOver(translucent: string, base: string): string {
  const top = parseHex(translucent);
  const bottom = parseHex(base);
  const mix = (t: number, b: number): number => Math.round(top.a * t + (1 - top.a) * b);
  const toHex = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(mix(top.r, bottom.r))}${toHex(mix(top.g, bottom.g))}${toHex(mix(top.b, bottom.b))}`;
}

describe('the WCAG arithmetic in this file matches the one in contrast.test.ts', () => {
  it('reproduces the published anchors, so this copy cannot drift', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#059669', '#059669')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
    // 0x08 / 255 = 0.0314, under the 0.03928 threshold, so the linear branch decides this one.
    expect(relativeLuminance('#080808')).toBeCloseTo(0.00243, 5);
  });

  it('composites a translucent colour over an opaque one', () => {
    // `#80` is 128/255 = 50.196%, not 50%, so black at that alpha over white lands on 127, not 128.
    expect(compositeOver('#00000080', '#FFFFFF')).toBe('#7F7F7F');
    expect(compositeOver('#FFFFFFFF', '#000000')).toBe('#FFFFFF');
    expect(compositeOver('#00000000', '#123456')).toBe('#123456');
  });
});

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

/**
 * **The six content tones that are bound to one ground — and the prop that hands out all ten.**
 *
 * `TEXT_FOREGROUND_ROLES` above names four `content` tones as safe on a surface a screen chooses.
 * The other six are not, and three of them are the SAME COLOUR as a screen surface: light
 * `content.inverse` is `green[50]` and so is `surface.canvas`; light `content.onDanger` is white and
 * so are `surface.raised` and `surface.overlay`; dark `content.inverse` is `ink[900]` and so is dark
 * `surface.canvas`. Every one of those measures exactly **1.0000:1** — invisible, not merely
 * low-contrast.
 *
 * That matters because `AppText` (`shared/components/AppText.tsx`) types its `tone` prop as
 * `keyof SemanticTokens['content']`, deliberately "derived from the token map rather than listed",
 * which makes all TEN reachable from any screen with no ground named and nothing measuring the
 * result.
 *
 * **The fix is not a narrowing of that type, and the reason is worth stating.** `content.inverse`
 * is unsafe on `surface.canvas` and *correct* on `surface.inverse` — a light tone on a reversed
 * ground is the whole point of an inverse role — so forbidding it globally would forbid a
 * legitimate use to prevent an illegitimate one. The real defect is that `AppText` chooses a colour
 * **without knowing what it is painted on**, and no type can express that; expressing it would mean
 * a `surface` prop, and TSD 6.7 fixes `AppText`'s prop list without `surface` in it. That is a
 * document amendment, not a test's decision.
 *
 * So what is built here is the **containment that needs no document change**: the six unsafe tones
 * are derived from the measurement rather than listed, and every `<AppText>` in the tree is read
 * from source to confirm none is handed one. `surface.canvas` is the ground it is checked against
 * because that is the default screen ground — the one a screen gets without choosing.
 *
 * Asserted in the house style of `statusOnInverseIsNecessary`: if one of the six ever DOES clear AA
 * on every screen surface in both schemes, it is a general-purpose tone and should move into
 * `TEXT_FOREGROUND_ROLES` rather than stay bound by a comment.
 */
describe('a content tone bound to one ground is not safe on a screen-chosen surface', () => {
  const BOUND_TO_ONE_GROUND = [
    'inverse',
    'onBrand',
    'onAccent',
    'onDanger',
    'onImage',
    'disabled',
  ] as const satisfies ReadonlyArray<keyof SemanticTokens['content']>;

  it('splits the content group into four free tones and six bound ones', () => {
    const bound = new Set<string>(BOUND_TO_ONE_GROUND);
    expect(Object.keys(lightColors.content).filter((tone) => !bound.has(tone))).toEqual([
      'primary',
      'secondary',
      'tertiary',
      'link',
    ]);
  });

  it('derives that same split from the ratios, so the list above is not the authority', () => {
    // Two authorities for one claim (BRIEF 6.1g): the declaration above states the intent, and
    // this computes it from the canvas measurement. A tone added to `content` lands in one of the
    // two sets by arithmetic, and if the two disagree one of them is wrong - which is the entire
    // reason for having both.
    expect([...unsafeOnCanvas].sort()).toEqual([...BOUND_TO_ONE_GROUND].sort());
  });

  it('measures every bound tone against every screen surface in both schemes', () => {
    for (const tone of BOUND_TO_ONE_GROUND) {
      const worst = Math.min(
        ...SCHEMES.flatMap((scheme) =>
          TEXT_SURFACES.map(([, read]) =>
            contrastRatio(colorsByScheme[scheme].content[tone], read(colorsByScheme[scheme])),
          ),
        ),
      );
      expect(
        worst,
        `content.${tone} measures ${worst.toFixed(4)}:1 at worst on a surface a screen chooses - if this now CLEARS 4.5:1 it is a general-purpose tone and belongs in TEXT_FOREGROUND_ROLES`,
      ).toBeLessThan(AA_NORMAL_TEXT);
    }
  });

  it('records the three pairings that are the same colour on both sides', () => {
    // Not "close to 1" - exactly 1, because the two roles resolve to one palette step. A tone
    // drifting off its surface would relax this, which is why it is asserted rather than described.
    expect(contrastRatio(lightColors.content.inverse, lightColors.surface.canvas)).toBeCloseTo(
      1,
      10,
    );
    expect(contrastRatio(lightColors.content.onDanger, lightColors.surface.raised)).toBeCloseTo(
      1,
      10,
    );
    expect(contrastRatio(darkColors.content.inverse, darkColors.surface.canvas)).toBeCloseTo(1, 10);
  });
});

/**
 * The `content` tones that fail AA on `surface.canvas` in **either** scheme.
 *
 * Derived, not listed. `surface.canvas` is the ground a screen gets without choosing one, so it is
 * the ground a tone handed to `AppText` with no other information is measured against. The union
 * across schemes is what matters: light `content.onBrand` is black and clears 19.94:1 on the light
 * canvas, while dark `content.onBrand` is `ink.ondark` and measures 1.0225:1 on the dark one. A
 * per-scheme set would call that tone safe in light and let it ship.
 */
const unsafeOnCanvas: ReadonlySet<string> = new Set(
  Object.keys(lightColors.content).filter((tone) =>
    SCHEMES.some((scheme) => {
      const colors = colorsByScheme[scheme];
      const content = colors.content as unknown as Record<string, string>;
      return contrastRatio(content[tone] ?? '', colors.surface.canvas) < AA_NORMAL_TEXT;
    }),
  ),
);

/**
 * **The containment, and why it is a source scan.**
 *
 * The claim is about the call sites, not about behaviour: "no screen hands `AppText` a tone that is
 * unsafe on the ground it will land on". BRIEF 6.2's first failure shape warns that a test which
 * reads a file cannot test the file's behaviour — and that is exactly right, which is why this
 * makes no behavioural claim. The property really is a property of the source, in the way
 * `register.dom.test.tsx` reads `register.ts` and `navigation-contrast.test.ts` reads
 * `TabNavigator.tsx`.
 *
 * What a source scan can still be is **vacuous**, in two ways, and both are closed below: the
 * extractor is tested against adversarial fixtures that include the violation it must catch, and
 * the real-tree run asserts floors on how much it found, so a walk that silently stopped seeing
 * files fails instead of reporting a clean tree.
 *
 * A tone it cannot read fails **closed**. A dynamic `tone={expression}` cannot be checked, so it is
 * reported rather than skipped: `AppText` has none today, and the day one arrives is the day
 * someone has to decide what ground it lands on.
 */
function appTextTones(source: string): {
  readonly literals: readonly string[];
  readonly unreadable: readonly string[];
} {
  const stripped = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const literals: string[] = [];
  const unreadable: string[] = [];
  // The negative lookahead is load-bearing: without it `<AppTextRow tone="inverse">` would be read
  // as an `AppText`, and a guard that reports a violation in a component that does not exist is as
  // useless as one that misses a real one.
  const opener = /<AppText(?![A-Za-z0-9_$])/g;
  for (let match = opener.exec(stripped); match !== null; match = opener.exec(stripped)) {
    // Walk to this tag's own `>`, tracking braces. An attribute expression can contain a `>`
    // (`style={{ flex: a > b ? 1 : 0 }}`), and stopping at the first one would read the NEXT tag's
    // attributes as this tag's - which is how a scan reports the wrong file.
    let depth = 0;
    let end = stripped.length;
    for (let i = match.index; i < stripped.length; i += 1) {
      const character = stripped[i];
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      else if (character === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    const tag = stripped.slice(match.index, end);
    const literal = /\btone="([A-Za-z]+)"/.exec(tag);
    if (literal?.[1] !== undefined) {
      literals.push(literal[1]);
    } else if (/\btone\s*=/.test(tag)) {
      unreadable.push(tag.replace(/\s+/g, ' ').trim());
    }
    opener.lastIndex = Math.max(end, match.index + 1);
  }
  return { literals, unreadable };
}

/** Every `.tsx` under `apps/mobile/src` that is neither a test nor a testing double. */
function screenSources(): ReadonlyArray<readonly [string, string]> {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const found: Array<readonly [string, string]> = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__testing__' && entry.name !== 'node_modules') {
          walk(full);
        }
      } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
        found.push([
          path.relative(root, full).split(path.sep).join('/'),
          fs.readFileSync(full, 'utf8'),
        ]);
      }
    }
  };
  walk(root);
  return found;
}

describe('no screen hands AppText a tone that is unsafe on the canvas', () => {
  it('extracts the tone a tag was given, and misses none of the shapes it has to catch', () => {
    // Adversarial fixtures, written to a checklist of attack shapes rather than sampled from what
    // the extractor happens to produce (BRIEF 6.3). Every line is a way a real scan goes wrong.
    const fixture = [
      '<AppText>no tone at all, which defaults to primary</AppText>',
      '<AppText tone="secondary">a safe literal</AppText>',
      '<AppText tone="inverse">THE VIOLATION this guard exists to catch</AppText>',
      '<AppText tone={chosen}>a dynamic tone, which cannot be checked</AppText>',
      '<AppText\n  variant="title"\n  tone="onBrand"\n>attributes across lines</AppText>',
      '<StatusMessage tone="warning" />',
      '<AppTextRow tone="onImage" />',
      '<AppText style={{ flex: a > b ? 1 : 0 }} tone="onDanger" />',
      '{/* <AppText tone="disabled" /> */}',
      '<AppText tone="primary" /><AppText tone="tertiary" />',
    ].join('\n');
    const found = appTextTones(fixture);
    expect(found.literals).toEqual([
      'secondary',
      'inverse',
      'onBrand',
      'onDanger',
      'primary',
      'tertiary',
    ]);
    expect(found.unreadable).toEqual(['<AppText tone={chosen}']);
    // The three the extractor must NOT report, stated as absences so a looser matcher fails here:
    // `StatusMessage`'s own tone, a component whose name merely starts with AppText, and a
    // commented-out violation.
    expect(found.literals).not.toContain('warning');
    expect(found.literals).not.toContain('onImage');
    expect(found.literals).not.toContain('disabled');
    // And the violation is recognised as one, which is the claim the real-tree test rests on.
    expect(found.literals.filter((tone) => unsafeOnCanvas.has(tone))).toEqual([
      'inverse',
      'onBrand',
      'onDanger',
    ]);
  });

  it('finds no unsafe and no unreadable tone anywhere in the app', () => {
    const sources = screenSources();
    const sites: Array<readonly [string, string]> = [];
    const unreadable: Array<readonly [string, string]> = [];
    for (const [file, source] of sources) {
      const found = appTextTones(source);
      for (const tone of found.literals) sites.push([file, tone]);
      for (const tag of found.unreadable) unreadable.push([file, tag]);
    }
    expect(
      unreadable,
      'AppText tones this guard cannot read - a dynamic tone cannot be checked against a ground, so it fails closed rather than being skipped',
    ).toEqual([]);
    expect(
      sites.filter(([, tone]) => unsafeOnCanvas.has(tone)),
      'call sites handing AppText a tone that measures under 4.5:1 on surface.canvas in one of the two schemes',
    ).toEqual([]);
    // The anti-vacuity floors. Measured at P23: **47** non-test .tsx files, **85** AppText tags of
    // which **68** carry a literal tone and 17 carry none (defaulting to primary). The floors sit
    // just under those, because a DROP is the failure mode - a walk that stopped seeing files is
    // the only way a scan reports a clean tree it never read - while growth is ordinary and must
    // not fail an unrelated screen. The floor already earned itself once: the first version guessed
    // 60 files and failed at 47, which is how these numbers came to be measured rather than assumed.
    expect(sources.length, 'tsx files scanned').toBeGreaterThanOrEqual(47);
    expect(sites.length, 'AppText tags carrying a literal tone').toBeGreaterThanOrEqual(64);
  });
});
