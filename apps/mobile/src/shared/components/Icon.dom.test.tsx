import { describe, expect, it } from 'vitest';
import { getByRole, queryAllByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, render } from './testHarness.js';
import { darkColors, lightColors } from '../theme/index.js';
import { GLYPH_NAMES, ICON_NAMES, Icon } from './Icon.js';
import type { IconName } from './Icon.js';

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
});
