import { describe, expect, it } from 'vitest';
import { getByRole, queryAllByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, render } from './testHarness.js';
import { darkColors, lightColors } from '../theme/index.js';
import { GLYPH_NAMES, ICON_NAMES, Icon } from './Icon.js';
import type { IconName } from './Icon.js';
import { EmptyState } from './EmptyState.js';
import { ErrorState } from './ErrorState.js';
import { OfflineState } from './OfflineState.js';
import { SearchField } from './SearchField.js';

/** Emoji, in the one definition that needs neither a dependency nor a maintained range list. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/** What every vendor glyph name in `GLYPH_NAMES` is, and what an emoji is not. */
const PRINTABLE_ASCII = /^[ -~]+$/;

/**
 * One real emoji, for the positive control below.
 *
 * Spelled as a codepoint rather than pasted in, which is the same reason `vitest.config.mts` uses
 * `String.fromCharCode(10)`: a literal astral character in a source file is at the mercy of every
 * editor and encoding between here and the next reader, and this one is load-bearing.
 */
const PIZZA = String.fromCodePoint(0x1f355);

/**
 * The user-facing copy a container rendered - visible text, plus the attributes that carry an
 * accessible name - with the icon double's own text excluded.
 *
 * **Not `EmptyState.dom.test.tsx`'s `readableText`, and the difference is the point.** That helper
 * strips `[aria-hidden="true"]` subtrees, which is right for "the text a screen reader would read"
 * and wrong here twice over: a LABELLED icon is not `aria-hidden`, so its double-rendered name
 * would land in the scan as though it were copy, while a hidden icon's `aria-label` - which is
 * copy, and the one place a sighted reviewer would never see an emoji - would be dropped. So the
 * exclusion is `data-icon-name`, which is exactly the double's artefact and nothing else.
 */
function copyIn(container: HTMLElement): string[] {
  const found: string[] = [];

  const walk = (node: Node): void => {
    if (node instanceof HTMLElement) {
      if (node.hasAttribute('data-icon-name')) {
        return;
      }
      for (const attribute of ['aria-label', 'placeholder', 'title', 'alt']) {
        const value = node.getAttribute(attribute);
        if (value !== null && value.trim() !== '') {
          found.push(value);
        }
      }
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.trim() !== '') {
        found.push(text);
      }
    }
    for (const child of Array.from(node.childNodes)) {
      walk(child);
    }
  };

  walk(container);
  return found;
}

describe('Icon', () => {
  it('hides a decorative icon from assistive technology', () => {
    // An icon with no label is repeating something the control beside it already says. Announced
    // twice is worse than not announced, so it leaves the tree entirely.
    const container = render(<Icon testID="i" name="check" />);

    expect(element(container, 'i').getAttribute('aria-hidden')).toBe('true');
    expect(queryAllByRole(container, 'img')).toHaveLength(0);
  });

  it('exposes a labelled icon as an image with that name', () => {
    const container = render(<Icon testID="i" name="warning" accessibilityLabel="Contains nuts" />);

    expect(getByRole(container, 'img', { name: 'Contains nuts' })).toBeTruthy();
    expect(element(container, 'i').getAttribute('aria-hidden')).toBeNull();
  });

  it('defaults to the body line box, and grows with the OS font scale', () => {
    const single = element(render(<Icon testID="i" name="check" />), 'i');
    expect(single.style.fontSize).toBe('24px');
    expect(single.style.lineHeight).toBe('24px');

    // No second rule and no font-scale arithmetic in this component: the size follows because
    // `typography` is already scaled (PRD 10.5).
    const doubled = element(render(<Icon testID="i" name="check" />, 'light', 2), 'i');
    expect(doubled.style.fontSize).toBe('48px');
  });

  it('takes an explicit size and a token colour over its defaults', () => {
    // A literal size is fine in a test - it is the value under assertion. In a component it
    // would not be, which is why `size` is documented as taking a resolved token.
    const container = render(
      <Icon testID="i" name="star" size={32} color={lightColors.accent.carb} />,
    );
    const icon = element(container, 'i');

    expect(icon.style.fontSize).toBe('32px');
    expect(icon.style.color).toBe(asRendered(lightColors.accent.carb));
  });

  it('defaults its colour to the active scheme content tone', () => {
    const inLight = element(render(<Icon testID="i" name="check" />), 'i');
    const inDark = element(render(<Icon testID="i" name="check" />, 'dark'), 'i');

    expect(inLight.style.color).toBe(asRendered(lightColors.content.primary));
    expect(inDark.style.color).toBe(asRendered(darkColors.content.primary));
  });

  /**
   * **The assertion that replaced two glyph-shape tests, and is stronger than both.**
   *
   * While `Icon` was a Unicode glyph map, two tests defended against emoji: one checked that no
   * codepoint sat above the basic plane, another that three characters carried U+FE0E to request
   * the text presentation. Both were about characters, and both became meaningless when the icon
   * set landed (A-11) - `@expo/vector-icons` ships a font with the app, so DECISIONS.md §5's "no
   * emoji" is satisfied by construction rather than by a codepoint range.
   *
   * What can go wrong NOW is a name that does not exist in the set, which renders a blank square
   * on a device and nothing at all in a test. So this reads the vendor's own shipped glyph map and
   * checks every value against it. It is a real file on disk, not a fixture: a typo, a renamed
   * icon, or a package upgrade that drops one all fail here.
   */
  it('names only icons the shipped font actually contains', async () => {
    const glyphMap =
      (await import('@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json')) as {
        readonly default: Readonly<Record<string, number>>;
      };

    expect(Object.keys(glyphMap.default).length).toBeGreaterThan(1000);
    for (const [name, vendorName] of Object.entries(GLYPH_NAMES)) {
      expect(
        Object.hasOwn(glyphMap.default, vendorName),
        `${name} maps to "${vendorName}", which is not in MaterialCommunityIcons`,
      ).toBe(true);
    }
  });

  it('asks the set for the icon each name means', () => {
    // Spot-checked rather than exhaustive, and deliberately the five that carry meaning a screen
    // depends on: the search field's magnifier, the two hearts a favourite toggles between, and
    // the invalid/failed pair that must stay two different marks (PRD §10.5).
    const nameFor = (name: IconName): string =>
      iconNamesIn(render(<Icon testID="i" name={name} />))[0] ?? '';

    expect(nameFor('search')).toBe('magnify');
    expect(nameFor('heart')).toBe('heart');
    expect(nameFor('heartOutline')).toBe('heart-outline');
    expect(nameFor('alertCircle')).toBe('alert-circle-outline');
    expect(nameFor('danger')).toBe('close-circle-outline');
    expect(nameFor('alertCircle')).not.toBe(nameFor('danger'));
  });

  it('publishes a runtime witness that matches the map exactly', () => {
    // S-12: `ICON_NAMES` exists so a screen can enumerate the union at runtime, and it is derived
    // from `GLYPHS` through a type guard rather than hand-listed - which is how a name ends up in
    // the union with nothing behind it. This pins the derivation, and it replaces a test that read
    // `textContent` per name and could only have failed on an empty string literal in the map.
    expect([...ICON_NAMES].sort()).toStrictEqual(Object.keys(GLYPH_NAMES).sort());
    expect(ICON_NAMES.length).toBeGreaterThan(20);
  });

  it('has a distinct icon for every name', () => {
    // A map with two names pointing at one icon is a design mistake that looks like a typo. The
    // one legitimate near-collision - `heart` and `heartOutline` - is distinct by construction.
    const vendorNames = Object.values(GLYPH_NAMES);
    expect(new Set(vendorNames).size).toBe(vendorNames.length);
  });

  /**
   * **"No emoji icons" - `Plan.md` §14.2's pre-delivery checklist item, executable again.**
   *
   * Two guards used to stand here and were retired for a correct reason: while `Icon` was a
   * Unicode glyph map they checked codepoint ranges, and the icon vocabulary became a shipped font
   * (A-11), which no codepoint range describes. What retiring them left behind is the part worth
   * recording - the checklist item had **nothing executable behind it at all**, and the docstring
   * above still says the rule is "satisfied by construction". That is true of the half of the rule
   * which is about icons, and it says nothing about the other half.
   *
   * **The other half is an emoji typed into a copy string.** `IconName` never sees it, the font
   * never renders it, and every guard that reasons about `GLYPHS` is blind to it. A rocket in an
   * empty-state title ships.
   *
   * **The trap, named, because it decides what the subject is.** The `dom` project aliases
   * `@expo/vector-icons/MaterialCommunityIcons` to `__testing__/iconSet.tsx`, and that double
   * renders the vendor's NAME as its own text child. Every icon on screen therefore contributes a
   * text node that is a test artefact rather than copy, so a scan which swallowed it would be
   * measuring the double instead of the product - and an emoji could hide the other way too,
   * behind a glyph name. The halves are kept apart rather than merged: `copyIn` excludes the
   * `data-icon-name` subtrees and that exclusion is asserted below rather than described, and the
   * names themselves are held to printable ASCII by their own loop.
   *
   * `\p{Extended_Pictographic}` is the detector rather than a hand-maintained range list: it is
   * the Unicode property the emoji set is derived from, it needs no data file and no dependency,
   * and it covers the dingbats a "no emoji" rule is really aimed at as well as the pictographs.
   */
  it('keeps emoji out of the icon names and out of the copy rendered beside them', () => {
    for (const [name, vendorName] of Object.entries(GLYPH_NAMES)) {
      expect(
        PRINTABLE_ASCII.test(vendorName),
        `${name} maps to "${vendorName}", which is not printable ASCII`,
      ).toBe(true);
    }

    // **The positive control, and it is a control rather than a second subject** (BRIEF §6.2
    // shape 2): the same scan over a surface deliberately given an emoji has to FIND one, so a
    // `copyIn` that returned nothing, a detector that matched nothing, or a harness that rendered
    // nothing fails here. It is seeded through a prop, so no authored copy is involved and no
    // rewording of the product's own text can invalidate it.
    const seeded = copyIn(render(<EmptyState testID="seed" title={`Nothing here yet ${PIZZA}`} />));
    expect(seeded.some((line) => PICTOGRAPHIC.test(line))).toBe(true);

    // The three PRD §12 state components and the search field, each rendered with no copy passed
    // in, so what is scanned is the copy the components themselves author: three default titles,
    // two default retry labels, and the search field's two accessible names. The `onRetry`
    // handlers are passed because without one neither state renders its button, and the label
    // would be authored copy that nothing on screen carries.
    const surfaces = [
      render(<EmptyState testID="empty" />),
      render(<ErrorState testID="error" onRetry={() => undefined} />),
      render(<OfflineState testID="offline" onRetry={() => undefined} />),
      render(<SearchField testID="search" value="laksa" onChangeText={() => undefined} />),
    ].map((surface) => copyIn(surface));

    // Every surface contributed, asserted per surface rather than as a total. A total can be met
    // by three loud surfaces while the fourth renders nothing, and it is the surface that stops
    // rendering that takes its copy out of the subject unnoticed. No wording is named here, so a
    // rewrite of any of these strings leaves this assertion alone.
    for (const strings of surfaces) {
      expect(strings.length).toBeGreaterThan(0);
    }
    const copy = surfaces.flat();

    // **The exclusion, pinned in both directions.** `EmptyState` renders `inbox`, so the double's
    // text IS in the tree - asserted first, because an exclusion whose subject is absent excludes
    // nothing - and it must not reach the copy scan, where it would quietly replace the product's
    // text with the harness's.
    const inbox = render(<EmptyState testID="empty" />);
    expect(inbox.textContent).toContain('inbox-outline');
    expect(copyIn(inbox).some((line) => line.includes('inbox-outline'))).toBe(false);

    for (const line of copy) {
      expect(PICTOGRAPHIC.test(line), `emoji in user-facing copy: ${JSON.stringify(line)}`).toBe(
        false,
      );
    }
  });
});
