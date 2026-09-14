import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
 * **P23 T-23-07 — the repair above closed the instance and not the class.** Six hand-written rows
 * reached seven of the 79 colour-valued members of `ComponentTokens` — the four `toast.tone*`, both
 * toast text tones, and `toast.background` as the ground under all six — and the card rows reached
 * `card.skeleton`, `card.background`, `card.imageScrim` and `card.imageText`. **The other 68 were
 * measured by nothing**, on the layer the original defect lived on — so pointing
 * `chip.labelSelected` at `content.tertiary` passed the whole gate, at a measured **2.0110:1 in
 * light and 1.3219:1 in dark** against AA's 4.5. (The figure the task was briefed with was ~1.5:1,
 * which is neither of them; both were recomputed here rather than quoted.) A hand-written table
 * cannot close that: a missing row looks exactly like a passing one, and that sentence is now
 * written three times in this repository about three different tables.
 *
 * So the pairing set below is **derived** rather than listed. `buildComponentTokens` is walked for
 * its string leaves, each leaf is classified by its own member name, and the thing it is painted on
 * comes from its siblings in the same group — `label` on `background`, `labelSelected` on
 * `backgroundSelected`, `neutralText` on `neutralBackground`, and a mark whose group offers no
 * ground on all four surfaces a screen can choose. A member added to `ComponentTokens` therefore
 * arrives already measured, and one that the derivation cannot place **fails** instead of being
 * skipped.
 *
 * The WCAG arithmetic is duplicated rather than exported from a test file. Twenty lines, and both
 * copies are checked against the same known values.
 */

const AA_NORMAL_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** A decorative rule may sit under 3:1, but it must not vanish into its own background. */
const VISIBLE_MINIMUM = 1.05;

/** No upper bound: most pairings may be as strong as they like. */
const UNBOUNDED = Number.POSITIVE_INFINITY;

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

/**
 * **A translucent fill over an opaque one — the load-bearing helper, so it gets its own check.**
 *
 * `MealCard` lays the meal's name on a remote photograph, which is the one background this theme
 * does not choose and cannot measure. What it does choose is `card.imageScrim` — a translucent fill
 * drawn between the two — and the scrim's ALPHA is the whole of the guarantee, so the pairing has to
 * be computed by compositing rather than read off a token.
 *
 * My first version of the image test measured `imageText` against bare `card.skeleton` with no
 * scrim and reported 1.10:1 as a defect. It was the test that was wrong, not the tokens: the text is
 * never on the bare skeleton. Recorded because a false positive in a contrast suite costs exactly as
 * much trust as a false negative.
 */
function compositeOver(translucent: string, opaqueHex: string): string {
  const top = parseHex(translucent);
  const bottom = parseHex(opaqueHex);
  const mix = (t: number, b: number): number => Math.round(top.a * t + (1 - top.a) * b);
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return `#${hex(mix(top.r, bottom.r))}${hex(mix(top.g, bottom.g))}${hex(mix(top.b, bottom.b))}`;
}

// ---------------------------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------------------------

/** Every colour-valued leaf of a built `ComponentTokens`, as a dotted member path. */
function colourMembers(
  node: unknown,
  prefix: readonly string[] = [],
): ReadonlyArray<readonly [string, string]> {
  const found: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string') {
      found.push([[...prefix, key].join('.'), value]);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      found.push(...colourMembers(value, [...prefix, key]));
    }
  }
  return found;
}

/** The same walk over the numbers, so a boundary's width can be read beside its colour. */
function numberMembers(node: unknown, prefix: readonly string[] = []): ReadonlyMap<string, number> {
  const found = new Map<string, number>();
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'number') {
      found.set([...prefix, key].join('.'), value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [member, width] of numberMembers(value, [...prefix, key])) {
        found.set(member, width);
      }
    }
  }
  return found;
}

/**
 * **Which semantic role each member is assigned, read from `component.ts` itself.**
 *
 * The values come from calling `buildComponentTokens`; the ROLE NAMES cannot, because a value does
 * not identify a role. In light, `accent.brand`, `surface.brand`, `border.brand` and `border.focus`
 * are all `#059669`, and in dark all four are `green[400]` — so a value lookup cannot tell a fill
 * apart from a tint, which is precisely the distinction the tab-bar defect turned on. Reading the
 * assignment from source is the only way to know, and it is the second authority this file measures
 * against: a member the parser cannot place fails `every member is assigned exactly one semantic
 * role`, rather than quietly dropping out of the pairing set.
 */
function assignedRoles(): ReadonlyMap<string, string> {
  const source = fs
    .readFileSync(path.join(import.meta.dirname, 'component.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const body = source.slice(source.indexOf('export function buildComponentTokens'));
  const stack: string[] = [];
  const roles = new Map<string, string>();
  for (const line of body.split('\n')) {
    const opened = /^\s*([A-Za-z]+):\s*\{\s*$/.exec(line);
    if (opened?.[1] !== undefined) {
      stack.push(opened[1]);
      continue;
    }
    if (/^\s*\},?;?\s*$/.test(line)) {
      stack.pop();
      continue;
    }
    const assigned = /^\s*([A-Za-z]+):\s*color\.([A-Za-z]+)\.([A-Za-z]+)\s*,\s*$/.exec(line);
    if (assigned?.[1] !== undefined) {
      roles.set([...stack, assigned[1]].join('.'), `${assigned[2] ?? ''}.${assigned[3] ?? ''}`);
      continue;
    }
    const literal = /^\s*([A-Za-z]+):\s*'([^']*)'\s*,\s*$/.exec(line);
    if (literal?.[1] !== undefined) {
      roles.set([...stack, literal[1]].join('.'), `literal:${literal[2] ?? ''}`);
    }
  }
  return roles;
}

/**
 * What a member is, from its own name. Seven classes, and the name is the whole of the input, so a
 * member added to `ComponentTokens` is classified without anyone deciding to classify it.
 */
type MemberClass = 'ground' | 'mark' | 'boundary' | 'scrim' | 'shadow' | 'fill' | 'imageMark';

function nameOf(member: string): string {
  return member.slice(member.lastIndexOf('.') + 1);
}

function groupOf(member: string): string {
  return member.slice(0, member.lastIndexOf('.'));
}

function classOf(member: string): MemberClass {
  const name = nameOf(member);
  if (name === 'imageScrim' || name === 'backdrop') return 'scrim';
  if (name === 'shadowColor') return 'shadow';
  if (name === 'skeleton') return 'fill';
  if (name === 'imageText') return 'imageMark';
  if (name.startsWith('borderColor')) return 'boundary';
  if (name.startsWith('background') || name.endsWith('Background')) return 'ground';
  return 'mark';
}

/** `labelSelected` -> `Selected`. The state a member belongs to, so a pairing matches state to state. */
function stateOf(name: string): string {
  return /(Pressed|Disabled|Selected|Focused|Error)$/.exec(name)?.[1] ?? '';
}

/** `neutralText` -> `neutral`, `statusInfoBackground` -> `statusInfo`, `label` -> ``. */
function familyOf(name: string): string {
  return /^(.*?)(?:Text|Background)$/.exec(name)?.[1] ?? '';
}

/** Text owes 1.4.3's 4.5:1; an icon, a rule or a handle owes 1.4.11's 3:1. */
function isText(name: string): boolean {
  return name.endsWith('Text') || /^(text|label|placeholder|hint)/.test(name);
}

/**
 * **The residue: the members whose obligation is a band rather than a floor, listed by hand.**
 *
 * WCAG 1.4.11 reaches information "required to identify user interface components"; a rule between
 * two list rows identifies nothing, so these three are exempt from 3:1 — and are bounded on BOTH
 * sides instead, because an exemption that requires no measurement is not a guard. The lower bound
 * is what stops one drifting into its own background: dark `border.subtle` was `ink[700]` and
 * `surface.overlay` is `ink[800]` — adjacent steps — so a dark `Sheet`'s divider measured 1.0469 and
 * was invisible while the test, which checked `surface.canvas` alone, reported 1.3662 and passed.
 * The upper bound is what stops the opposite: a "decorative" rule at 6:1 is a control boundary, and
 * someone should be told rather than have the exemption quietly cover it.
 *
 * Keyed on the MEMBER and not on the role it points at. Keying it on `border.subtle` would mean
 * repointing `field.borderColor` at `border.subtle` moved a control's boundary into the exemption
 * and passed — the shape of vacuity this whole pass exists to remove. Three of 79; every other
 * boundary owes the full 3:1.
 */
const DECORATIVE_RULES: ReadonlySet<string> = new Set([
  'card.borderColor',
  'sheet.divider',
  'divider.color',
]);

/**
 * `SemanticTokens`' groups, split by the direction the group is authored for.
 *
 * `surface`, `statusSurface` and `scrim` are grounds; `content`, `border` and `statusOnInverse` are
 * marks. `accent`, `status` and `effect` are legitimately both — `accent.brand` is a fill and
 * `accent.protein` is a text tone, `status.danger` is the danger text tone AND the destructive fill
 * — so no direction rule can reach them and the measured ratio is what carries those. That is the
 * honest boundary of this check: it catches a mark assigned a ground role, which is what a
 * foreground/background swap looks like in source, and it does not catch a label pointed at
 * `accent.brand`, which is what the tab bar did. The ratio catches that one.
 */
const GROUND_GROUPS: ReadonlySet<string> = new Set(['surface', 'statusSurface', 'scrim']);
const MARK_GROUPS: ReadonlySet<string> = new Set(['content', 'border', 'statusOnInverse']);

/** One measurement: what it is, what it measured, and the two bounds it has to sit between. */
interface Check {
  /** The `ComponentTokens` members this measurement covers. Coverage is counted from these. */
  readonly members: readonly string[];
  readonly what: string;
  readonly measured: number;
  readonly floor: number;
  readonly ceiling: number;
}

function derive(scheme: ColorScheme): readonly Check[] {
  const colors = colorsByScheme[scheme];
  const tokens = buildComponentTokens(colors);
  const members = colourMembers(tokens);
  const widths = numberMembers(tokens);
  const paint = new Map(members);
  const checks: Check[] = [];
  const surfaces = TEXT_SURFACES.map(([name, read]) => [`surface.${name}`, read(colors)] as const);
  const add = (
    covers: readonly string[],
    what: string,
    measured: number,
    floor: number,
    ceiling: number = UNBOUNDED,
  ): void => {
    checks.push({ members: covers, what, measured, floor, ceiling });
  };
  const siblingNames = (member: string): readonly string[] =>
    members.filter(([other]) => groupOf(other) === groupOf(member)).map(([other]) => nameOf(other));

  /** The ground a mark is painted on: its family's, then its state's, then its group's base. */
  const groundFor = (member: string): string | null => {
    const siblings = siblingNames(member);
    const family = familyOf(nameOf(member));
    const state = stateOf(nameOf(member));
    const candidates = [
      ...(family === '' ? [] : [`${family}Background`]),
      ...(state === '' ? [] : [`background${state}`]),
      'background',
    ];
    return candidates.find((candidate) => siblings.includes(candidate)) ?? null;
  };

  /**
   * The two bounds, from the member's own name and nothing else.
   *
   * WCAG 1.4.3 exempts "text that is part of an inactive user interface component", so a pairing
   * with `Disabled` on either side is bounded below rather than at AA — measured and not omitted,
   * because a disabled label at 1.01:1 is invisible, which is a usability failure even where it is
   * not a conformance one.
   */
  const bounds = (member: string, inactive: boolean): readonly [number, number] => {
    if (DECORATIVE_RULES.has(member)) return [VISIBLE_MINIMUM, AA_NON_TEXT];
    if (inactive) return [VISIBLE_MINIMUM, UNBOUNDED];
    return [isText(nameOf(member)) ? AA_NORMAL_TEXT : AA_NON_TEXT, UNBOUNDED];
  };

  const onEverySurface = (member: string, value: string): void => {
    const [floor, ceiling] = bounds(member, nameOf(member).endsWith('Disabled'));
    for (const [surfaceName, background] of surfaces) {
      const what = `${member} ${value} on ${surfaceName} ${background}`;
      add([member], what, contrastRatio(value, background), floor, ceiling);
    }
  };

  const pair = (mark: string, ground: string): void => {
    const [floor, ceiling] = bounds(
      mark,
      nameOf(mark).endsWith('Disabled') || nameOf(ground).endsWith('Disabled'),
    );
    const above = paint.get(mark) ?? '';
    const below = paint.get(ground) ?? '';
    add(
      [mark, ground],
      `${mark} ${above} on ${ground} ${below}`,
      contrastRatio(above, below),
      floor,
      ceiling,
    );
  };

  /** Grounds a mark has already answered for, so the sweep below knows which are still open. */
  const grounded = new Set<string>();

  for (const [member, value] of members) {
    const group = groupOf(member);
    const kind = classOf(member);

    if (kind === 'mark' || kind === 'boundary') {
      // A boundary separates a control from what is OUTSIDE it, so it is measured against the
      // surfaces a screen can put the control on and never against the control's own fill:
      // `button.primary.borderColor` is `accent.brand`, the same colour as the fill it surrounds,
      // and pairing those two reports 1.00:1 for a border doing what it was authored to do.
      const ground = kind === 'boundary' ? null : groundFor(member);
      const width =
        widths.get(`${group}.borderWidth${stateOf(nameOf(member))}`) ??
        widths.get(`${group}.borderWidth`) ??
        0;

      if (kind === 'boundary' && (width === 0 || value === 'transparent')) {
        // Nothing is painted, or nothing is named, and the two have to agree. A `borderColor`
        // carrying a real value behind a zero width is a token that looks satisfied and draws
        // nothing; a transparent one behind a real width is a border nobody can see.
        const agrees = value === 'transparent' && width === 0;
        const what = `${member} is '${value}' and ${group}.borderWidth is ${String(width)}, which must agree`;
        add([member], what, agrees ? 0 : 1, 0, 1);
        continue;
      }
      if (ground === null || paint.get(`${group}.${ground}`) === 'transparent') {
        // No ground in the group, or a transparent one that lets the screen show through: either
        // way the surfaces are the real backgrounds. The ground is deliberately NOT recorded as
        // claimed, so the sweep below still has to account for it.
        onEverySurface(member, value);
        continue;
      }
      grounded.add(`${group}.${ground}`);
      pair(member, `${group}.${ground}`);
      continue;
    }

    if (kind === 'shadow') {
      // A shadow is not a pairing, and DECISIONS.md 5 flattens it to two elevations of which dark's
      // are both 0. What is still measurable is its direction: a shadow lightens nothing, so its
      // luminance must sit below every surface it can be cast on. Repointing this at a light tone
      // would make a glow, and nothing else in the suite would notice.
      const darkest = Math.min(...surfaces.map(([, background]) => relativeLuminance(background)));
      const what = `${member} ${value} luminance must sit below the darkest surface (${darkest.toFixed(4)})`;
      add([member], what, relativeLuminance(value), 0, darkest);
      continue;
    }

    if (kind === 'scrim') {
      // A scrim separates what is above it from what is below, and the least dimmable thing below
      // is a white one. 3:1 is borrowed from 1.4.11 as the boundary-visibility figure, the way
      // `contrast.test.ts` borrows it for `scrim.backdrop`.
      const dimmed = compositeOver(value, '#ffffff');
      const what = `${member} ${value} over a white app composites to ${dimmed} and must dim it`;
      add([member], what, contrastRatio(dimmed, '#ffffff'), AA_NON_TEXT);
      continue;
    }

    if (kind === 'fill') {
      // `effect.skeleton` had NO assertion anywhere, and its exemption was justified by a sentence
      // written for `ripple` and `highlight`: "a press layer whose own contrast is meaningless
      // because it composites over whatever it is pressed against". A skeleton is an opaque fill,
      // not a composite, and PRD 12 makes it the loading state — so it has to be visible against
      // the card it sits in and must not be so strong that an unloaded card reads as content.
      //
      // A fill is not a mark, so this does not claim the ground: the sweep below still makes
      // `card.background` answer for what it is.
      const ground = `${group}.background`;
      const below = paint.get(ground) ?? '';
      const what = `${member} ${value} on ${ground} ${below}`;
      add([member, ground], what, contrastRatio(value, below), VISIBLE_MINIMUM, AA_NON_TEXT);
      continue;
    }

    if (kind === 'imageMark') {
      // **Pure white is the worst case and the only one that needs to hold**, because no photograph
      // can be brighter than white and the scrim darkens whatever is under it. `card.skeleton` is
      // checked too, since it is what the box is painted with while an image loads or after it
      // fails — the pairing a user sees when the network is down, which for this product is often.
      const scrim = paint.get(`${group}.imageScrim`) ?? '';
      for (const [label, backdrop] of [
        ['a pure-white photograph', '#ffffff'],
        [`${group}.skeleton, the unloaded-image floor`, paint.get(`${group}.skeleton`) ?? ''],
      ] as const) {
        const behind = compositeOver(scrim, backdrop);
        const what = `${member} ${value} over ${group}.imageScrim over ${label} (${behind})`;
        add([member], what, contrastRatio(value, behind), AA_NORMAL_TEXT);
      }
      continue;
    }
  }

  // The grounds no mark claimed, in the three shapes they come in.
  for (const [member, value] of members) {
    if (classOf(member) !== 'ground' || grounded.has(member)) {
      continue;
    }
    const group = groupOf(member);
    const state = stateOf(nameOf(member));
    const marks = siblingNames(member).filter((name) => classOf(`${group}.${name}`) === 'mark');

    if (value === 'transparent') {
      // `button.ghost` has no fill, so the screen shows through and its marks were measured on all
      // four surfaces above. What is left to assert is that there IS a mark those measurements
      // covered: a transparent ground with nothing drawn over it is measured by nothing.
      const what = `${member} is transparent, so ${group}'s marks must be measured on the surfaces instead`;
      add([member], what, marks.length, 1);
      continue;
    }

    // A state fill with no mark of its own keeps the base mark: there is no `labelPressed`, so a
    // pressed button shows the SAME label over a different fill, and that is the pairing —
    // `content.onBrand on accent.brandPressed` at the semantic layer. Derived from the absence of
    // the state's own mark, not from a list of which states reuse which label.
    const inherited = marks.filter((name) => groundFor(`${group}.${name}`) === 'background');
    if (state !== '' && inherited.length > 0) {
      for (const mark of inherited) {
        pair(`${group}.${mark}`, member);
      }
      continue;
    }

    // And `card.background`, which has no mark in its own group at all. The claim that covers it is
    // that it IS one of the four surfaces `contrast.test.ts` measures every text tone against, so a
    // `card.background` moved to `accent.brand` satisfies neither this branch nor either other.
    const matching = surfaces.filter(([, background]) => background === value);
    const where = state === '' ? '' : ` for the ${state} state`;
    const what = `${member} ${value} has no mark in ${group}${where}, so it must be one of the four measured surfaces`;
    add([member], what, matching.length, 1);
  }

  return checks;
}

describe.each(SCHEMES)('%s: every colour member of ComponentTokens is measured', (scheme) => {
  const checks = derive(scheme);
  const tokens = buildComponentTokens(colorsByScheme[scheme]);
  const members = colourMembers(tokens).map(([member]) => member);

  it.each(checks.map((check) => [check.what, check] as const))('%s', (_what, check) => {
    expect(
      check.measured,
      `${check.what} measures ${check.measured.toFixed(4)}, needs at least ${String(check.floor)}`,
    ).toBeGreaterThanOrEqual(check.floor);
    if (check.ceiling !== UNBOUNDED) {
      expect(
        check.measured,
        `${check.what} measures ${check.measured.toFixed(4)}, needs under ${String(check.ceiling)}`,
      ).toBeLessThan(check.ceiling);
    }
  });

  it('leaves no colour member unmeasured', () => {
    const measured = new Set(checks.flatMap((check) => check.members));
    expect(
      members.filter((member) => !measured.has(member)),
      'colour-valued ComponentTokens members the derivation could not place',
    ).toEqual([]);
    // The count is part of the claim: T-23-07 found 11 of 79 measured, and a derivation that
    // silently stopped enumerating would satisfy the emptiness assertion above on its own.
    expect(members.length).toBe(79);
    expect(measured.size).toBe(79);
  });

  it('measures every member against something it is really painted on', () => {
    // A check whose two sides are the same member would be 1:1 and vacuous, and a check that
    // claims a member it does not name would let a member ride on another's measurement.
    for (const check of checks) {
      expect(new Set(check.members).size, check.what).toBe(check.members.length);
      for (const member of check.members) {
        expect(check.what, `${check.what} does not name ${member}`).toContain(member);
      }
    }
  });
});

describe('the component layer composes roles in the direction they were authored for', () => {
  const roles = assignedRoles();
  const members = colourMembers(buildComponentTokens(colorsByScheme.light));

  it('assigns every member exactly one semantic role, and no colour literal', () => {
    // The parser is the second authority, so it must not be allowed to miss a member: a member it
    // cannot place would otherwise drop out of the direction check below with no trace. And
    // TSD 6.6 puts the colours in `semantic.ts` — the only literal layer 3 may name is the absence
    // of a colour, which is what lets `button.ghost` have no fill and no border.
    const unplaced = members.map(([member]) => member).filter((member) => !roles.has(member));
    expect(unplaced, 'members with no `color.<group>.<member>` assignment in component.ts').toEqual(
      [],
    );
    const literals = [...roles].filter(([, role]) => role.startsWith('literal:'));
    expect(
      literals.filter(([, role]) => role !== 'literal:transparent'),
      'colour literals authored into component.ts instead of a semantic role',
    ).toEqual([]);
    expect(literals.length).toBe(3);
  });

  it('agrees with the values buildComponentTokens actually produced', () => {
    // Source and runtime, cross-checked. A parser that drifted from the file — a reformat that
    // moved an assignment onto two lines, say — would otherwise keep reporting the role it last
    // managed to read, and the direction check would be measuring a stale map.
    for (const scheme of SCHEMES) {
      const colors: SemanticTokens = colorsByScheme[scheme];
      const groups = colors as unknown as Record<string, Record<string, unknown>>;
      for (const [member, value] of colourMembers(buildComponentTokens(colors))) {
        const role = roles.get(member) ?? '';
        if (role.startsWith('literal:')) {
          expect(value, `${member} in ${scheme}`).toBe(role.slice('literal:'.length));
          continue;
        }
        const [group, name] = role.split('.');
        expect(groups[group ?? '']?.[name ?? ''], `${member} is ${role} in ${scheme}`).toBe(value);
      }
    }
  });

  it('never paints a mark with a ground role or fills a ground with a mark role', () => {
    // **The direction assertion, and the one a swap fails.** Contrast is order-independent, so
    // exchanging `chip.labelSelected` and `chip.backgroundSelected` measures the same ratio and no
    // threshold can see it. What changes is the role each member points at, and `semantic.ts`
    // authors `surface.*` to sit under something and `content.*` to sit on top of it.
    const wrongWay: string[] = [];
    for (const [member] of members) {
      const role = roles.get(member) ?? '';
      const group = role.split('.')[0] ?? '';
      const kind = classOf(member);
      if (
        (kind === 'mark' || kind === 'boundary' || kind === 'imageMark') &&
        GROUND_GROUPS.has(group)
      ) {
        wrongWay.push(`${member} is drawn on top of something but points at ${role}`);
      }
      if (kind === 'ground' && MARK_GROUPS.has(group)) {
        wrongWay.push(`${member} is drawn underneath something but points at ${role}`);
      }
      if (kind === 'scrim' && group !== 'scrim') {
        wrongWay.push(`${member} is a translucent overlay but points at ${role}`);
      }
      if ((kind === 'shadow' || kind === 'fill') && group !== 'effect') {
        wrongWay.push(`${member} is a surface effect but points at ${role}`);
      }
    }
    expect(wrongWay).toEqual([]);
  });

  it('states what is still declared rather than derived, with the count', () => {
    // Two lists remain hand-written at this layer and nothing else does. Recorded as a count so
    // the residue is visible: a fourth entry in either one is a decision someone took, and a
    // reviewer can see that it was taken without reading the derivation.
    expect(DECORATIVE_RULES.size).toBe(3);
    expect(GROUND_GROUPS.size + MARK_GROUPS.size).toBe(6);
    // The other three groups — `accent`, `status`, `effect` — carry roles used in both directions,
    // so they are deliberately unconstrained here and the ratio is what covers them.
    const groups = Object.keys(colorsByScheme.light);
    expect(groups.filter((group) => !GROUND_GROUPS.has(group) && !MARK_GROUPS.has(group))).toEqual([
      'accent',
      'status',
      'effect',
    ]);
  });
});

describe('the WCAG arithmetic in this file matches the one in contrast.test.ts', () => {
  it('returns 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#059669', '#059669')).toBeCloseTo(1, 10);
  });

  it('composites a known alpha correctly', () => {
    // The compositor is the load-bearing part of the image assertion, so it gets its own check
    // rather than being trusted - and it earned it immediately: I wrote `#808080` here and the real
    // answer is `#7f7f7f`, because `0x80` is 128/255 = 0.50196, not 0.5, so white contributes 127.0
    // and rounds down. A contrast suite whose compositor is a percent out is worse than no suite,
    // since every ratio it reports would be plausible and slightly wrong.
    expect(compositeOver('#00000080', '#FFFFFF')).toBe('#7f7f7f');
    expect(compositeOver('#123456FF', '#FFFFFF')).toBe('#123456');
    expect(compositeOver('#12345600', '#FFFFFF')).toBe('#ffffff');
  });
});
