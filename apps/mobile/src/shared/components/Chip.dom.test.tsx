import { describe, expect, it } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { Chip } from './Chip.js';

const light = buildComponentTokens(lightColors).chip;
const dark = buildComponentTokens(darkColors).chip;

describe('Chip', () => {
  it('meets the build-to touch target on both axes', () => {
    // PRD 10.5 (2.1.0) via X-05: 44 pt iOS, 48 dp Android, 24 px web, build to 48. Both axes,
    // because a chip labelled "2" would otherwise be tall enough and far too narrow.
    const chip = element(render(<Chip testID="c" label="Vegan" />), 'c');

    expect(chip.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(chip.style.minWidth).toBe(`${String(light.minHeight)}px`);
  });

  it('announces itself as a checkbox with a checked state when it toggles', () => {
    const on = render(<Chip testID="c" label="Vegan" toggle selected />);
    expect(getByRole(on, 'checkbox', { name: 'Vegan' }).getAttribute('aria-checked')).toBe('true');

    const off = render(<Chip testID="c" label="Vegan" toggle />);
    expect(getByRole(off, 'checkbox', { name: 'Vegan' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('announces itself as a selected button when it does not toggle', () => {
    const container = render(<Chip testID="c" label="Lunch" selected />);
    expect(getByRole(container, 'button', { name: 'Lunch' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('does not fire when disabled, and does when it is not', () => {
    let presses = 0;
    const increment = (): void => {
      presses += 1;
    };

    press(element(render(<Chip testID="c" label="Vegan" disabled onPress={increment} />), 'c'));
    expect(presses).toBe(0);

    press(element(render(<Chip testID="c" label="Vegan" onPress={increment} />), 'c'));
    expect(presses).toBe(1);
  });

  it('takes its accessible name from the visible label unless given one', () => {
    const plain = render(<Chip testID="c" label="Nut free" />);
    expect(getByRole(plain, 'button', { name: 'Nut free' })).toBeTruthy();

    const labelled = render(<Chip testID="c" label="Nut free" accessibilityLabel="Exclude nuts" />);
    expect(getByRole(labelled, 'button', { name: 'Exclude nuts' })).toBeTruthy();
  });

  it('carries selection by a mark as well as by colour', () => {
    // PRD 10.5: colour is never the only carrier. The check glyph is the non-colour half.
    const selected = element(render(<Chip testID="c" label="Vegan" selected />), 'c');
    const unselected = element(render(<Chip testID="c" label="Vegan" />), 'c');

    expect(selected.textContent).not.toBe(unselected.textContent);
    expect((selected.textContent ?? '').length).toBeGreaterThan(
      (unselected.textContent ?? '').length,
    );
  });

  it('fills itself from its own token group in both schemes', () => {
    const inLight = element(render(<Chip testID="c" label="Vegan" selected />), 'c');
    const inDark = element(render(<Chip testID="c" label="Vegan" selected />, 'dark'), 'c');

    expect(inLight.style.backgroundColor).toBe(asRendered(light.backgroundSelected));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.backgroundSelected));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const chip = element(render(<Chip testID="c" label="Vegan" />, 'light', 2), 'c');

    // Still a minimum, never a height: the label is twice as tall and has somewhere to go.
    expect(chip.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(chip.style.height).toBe('');
    expect(chip.style.maxHeight).toBe('');
  });
});
