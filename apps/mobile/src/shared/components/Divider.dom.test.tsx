import { describe, expect, it } from 'vitest';
import { asRendered, element, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { Divider } from './Divider.js';

const light = buildComponentTokens(lightColors).divider;
const dark = buildComponentTokens(darkColors).divider;

describe('Divider', () => {
  it('is hidden from assistive technology', () => {
    // A rule between rows carries no information and cannot be acted on. Announcing it is noise,
    // which is also why `border.subtle` is the correct colour here and nowhere else.
    expect(element(render(<Divider testID="d" />), 'd').getAttribute('aria-hidden')).toBe('true');
  });

  it('draws its thickness and colour from the divider token in both schemes', () => {
    const inLight = element(render(<Divider testID="d" />), 'd');
    const inDark = element(render(<Divider testID="d" />, 'dark'), 'd');

    expect(inLight.style.height).toBe(`${String(light.thickness)}px`);
    expect(inLight.style.backgroundColor).toBe(asRendered(light.color));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.color));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('spaces itself from the token, and sets no margin at all when asked for none', () => {
    const standard = element(render(<Divider testID="d" />), 'd');
    const tight = element(render(<Divider testID="d" spacing="tight" />), 'd');
    const none = element(render(<Divider testID="d" spacing="none" />), 'd');

    expect(standard.style.marginTop).toBe(`${String(light.spacing)}px`);
    expect(tight.style.marginTop).toBe(`${String(light.spacingTight)}px`);
    // Unset, not zero: the zero token is not reachable from a component, and an absent margin is
    // what "none" means.
    expect(none.style.marginTop).toBe('');
  });

  it('indents by the token inset only when inset', () => {
    expect(element(render(<Divider testID="d" inset />), 'd').style.marginLeft).toBe(
      `${String(light.inset)}px`,
    );
    expect(element(render(<Divider testID="d" />), 'd').style.marginLeft).toBe('');
  });
});
