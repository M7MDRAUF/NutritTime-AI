import { describe, expect, it } from 'vitest';
import { getAllByRole, getByRole, queryAllByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { IconButton } from './IconButton.js';

const light = buildComponentTokens(lightColors).button;
const dark = buildComponentTokens(darkColors).button;

function noop(): void {
  // A press handler the test does not care about.
}

describe('IconButton', () => {
  it('meets the build-to target on both axes even when the glyph is tiny', () => {
    // This is the case the component exists to get right: the target is a property of the box,
    // not of the icon, so shrinking the icon must not shrink the target. `hitSlop` is absent
    // deliberately - it is invisible to the DOM and there is no shortfall for it to make up.
    const button = element(
      render(
        <IconButton testID="b" icon="close" size={12} accessibilityLabel="Close" onPress={noop} />,
      ),
      'b',
    );

    expect(button.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(button.style.minWidth).toBe(`${String(light.minHeight)}px`);
  });

  it('carries exactly one accessible name', () => {
    // The glyph inside is decorative. If it were labelled too, a screen reader would announce
    // the control twice.
    const container = render(
      <IconButton testID="b" icon="close" accessibilityLabel="Close" onPress={noop} />,
    );

    expect(getByRole(container, 'button', { name: 'Close' })).toBeTruthy();
    expect(getAllByRole(container, 'button')).toHaveLength(1);
    expect(queryAllByRole(container, 'img')).toHaveLength(0);
  });

  it('does not fire when disabled, and does when it is not', () => {
    let presses = 0;
    const increment = (): void => {
      presses += 1;
    };

    press(
      element(
        render(
          <IconButton
            testID="b"
            icon="close"
            accessibilityLabel="Close"
            disabled
            onPress={increment}
          />,
        ),
        'b',
      ),
    );
    expect(presses).toBe(0);

    press(
      element(
        render(
          <IconButton testID="b" icon="close" accessibilityLabel="Close" onPress={increment} />,
        ),
        'b',
      ),
    );
    expect(presses).toBe(1);
  });

  it('draws its glyph in the ghost variant label tone, in both schemes', () => {
    const inLight = render(
      <IconButton testID="b" icon="close" accessibilityLabel="C" onPress={noop} />,
    );
    const inDark = render(
      <IconButton testID="b" icon="close" accessibilityLabel="C" onPress={noop} />,
      'dark',
    );
    const glyphOf = (container: HTMLElement): HTMLElement => {
      const glyph = element(container, 'b').firstElementChild;
      if (!(glyph instanceof HTMLElement)) {
        throw new Error('the icon button rendered no glyph');
      }
      return glyph;
    };

    expect(glyphOf(inLight).style.color).toBe(asRendered(light.ghost.label));
    expect(glyphOf(inDark).style.color).toBe(asRendered(dark.ghost.label));
  });

  it('sizes its glyph to the body line box and follows the OS font scale', () => {
    const doubled = element(
      render(
        <IconButton testID="b" icon="close" accessibilityLabel="Close" onPress={noop} />,
        'light',
        2,
      ),
      'b',
    );
    const glyph = doubled.firstElementChild;
    if (!(glyph instanceof HTMLElement)) {
      throw new Error('the icon button rendered no glyph');
    }

    expect(glyph.style.fontSize).toBe('48px');
    // The box does not shrink and does not fix a height, so a larger glyph grows the button
    // rather than spilling out of it (PRD 10.5).
    expect(doubled.style.height).toBe('');
    expect(doubled.style.minHeight).toBe(`${String(light.minHeight)}px`);
  });
});
