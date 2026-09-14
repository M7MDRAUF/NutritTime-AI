import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ColorScheme, SemanticTokens } from './semantic.js';
import { colorsByScheme } from './semantic.js';

/**
 * **The third composer of a colour pair, split out of `component-contrast.test.ts` at P23.**
 *
 * Three files, three composers, and the split is along the question each one answers.
 * `contrast.test.ts` asks whether a semantic pair is readable. `component-contrast.test.ts` asks
 * whether `buildComponentTokens` composed a readable pair. This one asks whether **React
 * Navigation's chrome** did — and it is the composer that actually shipped a live AA failure, in
 * neither of the other two halves.
 *
 * It was moved rather than re-approved at a bigger size, which is the precedent `Plan.md` 17.1
 * records for this exact file: `contrast.test.ts` grew to 696 lines against the 459 its exception
 * was granted at — "42% past a cap it was already exempt from, which is how an exception becomes a
 * blanket" — and it was split. `component-contrast.test.ts` reached 811 against a row of 408 when
 * the derived component-token guard landed, so the two blocks that answer a different question left.
 *
 * The WCAG arithmetic is duplicated rather than imported from a test file, as it is in both
 * neighbours, and this copy is anchored against the same published values at the bottom. Three
 * functions, and a shared non-test module for them would be a fourth file in a directory `TSD.md`
 * 6.6 fixes at three layers — which is a document question, not a test question.
 */

const AA_NORMAL_TEXT = 4.5;

const SCHEMES: readonly ColorScheme[] = ['light', 'dark'];

function parseHex(value: string): { r: number; g: number; b: number } {
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
  return { r: channel(0), g: channel(2), b: channel(4) };
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

describe('the WCAG arithmetic in this file matches the one in contrast.test.ts', () => {
  it('returns 21:1 for black on white, 1:1 for a colour on itself, and the sRGB primaries', () => {
    // This copy has to be anchored on its own. A third copy that drifted would relax every
    // assertion below it and report a plausible, wrong ratio for the pair that shipped at 3.77.
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#059669', '#059669')).toBeCloseTo(1, 10);
    expect(relativeLuminance('#FF0000')).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance('#00FF00')).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance('#0000FF')).toBeCloseTo(0.0722, 4);
    // 0x08 / 255 = 0.0314, under the 0.03928 threshold, so the linear branch decides this one.
    expect(relativeLuminance('#080808')).toBeCloseTo(0.00243, 5);
  });

  it('reproduces the ratio the tab bar shipped at', () => {
    // `accent.brand` on `surface.raised` in light. The figure this whole file exists for, stated
    // as a literal rather than read from the maps, so a token change fails against the RECORD of
    // the defect and not against its own new value.
    expect(contrastRatio('#059669', '#FFFFFF')).toBeCloseTo(3.7682, 4);
  });
});

/**
 * **The navigation chrome — the third composer, and the one that shipped a live AA failure.**
 *
 * `contrast.test.ts` answers "is this colour pair readable" and the block above answers "did
 * `buildComponentTokens` compose a readable pair". Neither can see the third composer: React
 * Navigation's own chrome, whose tints `TabNavigator.tsx` and `navigationTheme.ts` assemble from
 * semantic tokens directly. `tabBarActiveTintColor` was `accent.brand` — a FILL role, authored to
 * sit *under* `content.onBrand` — over `surface.raised`, which is **3.77:1** in light against AA's
 * 4.5:1 for normal text. Both tokens in that pair were individually correct and the composition was
 * not, which is exactly the class of defect P12's split was written for; the chrome was simply in
 * neither half.
 *
 * **Both sides of every pair are read from the source file that sets them**, the way
 * `typography.test.ts` reads `App.tsx`. Restating the pair here is what would let the two drift: a
 * test that measures `content.link on surface.raised` passes forever regardless of what the
 * navigator is actually pointed at. A slot pointed at a colour literal, or at something that is not
 * a colour role, fails to resolve and fails the test rather than silently measuring nothing.
 */
const navigationDirectory = path.resolve(import.meta.dirname, '..', '..', 'navigation');

/** Comments in those files name these very tokens, so they are stripped before anything matches. */
function sourceOf(file: string): string {
  return fs
    .readFileSync(path.join(navigationDirectory, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** The `<group>.<member>` role a named slot is pointed at, in the file that sets it. */
function roleAt(file: string, slot: string): string {
  const match = new RegExp(`\\b${slot}:\\s*colors\\.([A-Za-z]+)\\.([A-Za-z]+)`).exec(
    sourceOf(file),
  );
  if (match === null) {
    throw new Error(`${file} does not point ${slot} at a semantic colour token`);
  }
  return `${match[1] ?? ''}.${match[2] ?? ''}`;
}

/** Every `<group>.<member>` that resolves to a colour, so a role read from source can be looked up. */
function colourValues(tokens: SemanticTokens): Map<string, string> {
  const values = new Map<string, string>();
  for (const [group, members] of Object.entries(tokens)) {
    // The same widening `contrast.test.ts`'s own walker uses: the groups are heterogeneous —
    // `effect` carries numbers — so one walker cannot read them all without it.
    for (const [member, value] of Object.entries(members as Record<string, unknown>)) {
      if (typeof value === 'string') {
        values.set(`${group}.${member}`, value);
      }
    }
  }
  return values;
}

/** Each chrome slot that paints TEXT, and the slot in the same file naming what sits behind it. */
const CHROME_TEXT_SLOTS = [
  { file: 'TabNavigator.tsx', foreground: 'tabBarActiveTintColor', background: 'backgroundColor' },
  {
    file: 'TabNavigator.tsx',
    foreground: 'tabBarInactiveTintColor',
    background: 'backgroundColor',
  },
  { file: 'navigationTheme.ts', foreground: 'primary', background: 'card' },
  { file: 'navigationTheme.ts', foreground: 'text', background: 'card' },
] as const;

describe('the navigation chrome composes a readable pair', () => {
  it.each(SCHEMES)('every tint the navigator paints text with is AA in %s', (scheme) => {
    const values = colourValues(colorsByScheme[scheme]);
    for (const { file, foreground, background } of CHROME_TEXT_SLOTS) {
      const foregroundRole = roleAt(file, foreground);
      const backgroundRole = roleAt(file, background);
      const tint = values.get(foregroundRole);
      const behind = values.get(backgroundRole);
      if (tint === undefined || behind === undefined) {
        throw new Error(`${file}: ${foregroundRole} or ${backgroundRole} is not a colour role`);
      }
      const ratio = contrastRatio(tint, behind);
      expect(
        ratio,
        `${file}: ${foreground} is ${foregroundRole} ${tint} on ${background} ${backgroundRole} ${behind} = ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('paints a tab LABEL with that tint, which is why the threshold is 4.5 and not 3', () => {
    // The premise the threshold rests on. Each `Tabs.Screen` supplies a `title` and no
    // `tabBarLabel`, so React Navigation renders the tab's text in the active tint - a bare glyph
    // would owe only 1.4.11's 3:1, which light's `accent.brand` at 3.77:1 would have cleared. If
    // the labels are ever hidden, this is the assertion that says the threshold may move.
    const source = sourceOf('TabNavigator.tsx');
    const titles = [...source.matchAll(/title: '([A-Za-z]+)'/g)].map((match) => match[1]);
    expect(titles).toEqual(['Home', 'Explore', 'Assistant', 'Saved', 'Settings']);
    expect(source).not.toContain('tabBarShowLabel');
  });
});
