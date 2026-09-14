import { describe, expect, it } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { AccessibleButton } from './AccessibleButton.js';
import type { ButtonVariant } from './AccessibleButton.js';

const light = buildComponentTokens(lightColors).button;
const dark = buildComponentTokens(darkColors).button;
const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

function noop(): void {
  // A press handler the test does not care about.
}

describe('AccessibleButton', () => {
  it('meets the build-to touch target on both axes', () => {
    const button = element(
      render(<AccessibleButton testID="b" label="Save" onPress={noop} />),
      'b',
    );

    expect(button.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(button.style.minWidth).toBe(`${String(light.minHeight)}px`);
  });

  it.each(VARIANTS)('fills the %s variant from its own token, in both schemes', (variant) => {
    const inLight = element(
      render(<AccessibleButton testID="b" label="Save" variant={variant} onPress={noop} />),
      'b',
    );
    const inDark = element(
      render(<AccessibleButton testID="b" label="Save" variant={variant} onPress={noop} />, 'dark'),
      'b',
    );

    expect(globalThis.getComputedStyle(inLight).backgroundColor).toBe(
      asRendered(light[variant].background),
    );
    expect(globalThis.getComputedStyle(inDark).backgroundColor).toBe(
      asRendered(dark[variant].background),
    );
  });

  it('does not fire when disabled', () => {
    let presses = 0;
    const button = element(
      render(
        <AccessibleButton
          testID="b"
          label="Save"
          disabled
          onPress={() => {
            presses += 1;
          }}
        />,
      ),
      'b',
    );

    press(button);
    expect(presses).toBe(0);
  });

  it('does not fire while loading, and says it is busy rather than broken', () => {
    // The press already happened. A second one would submit twice, and a disabled-looking button
    // with no explanation is indistinguishable from a dead one - hence `busy`.
    let presses = 0;
    const container = render(
      <AccessibleButton
        testID="b"
        label="Save"
        loading
        onPress={() => {
          presses += 1;
        }}
      />,
    );

    press(element(container, 'b'));
    expect(presses).toBe(0);
    expect(getByRole(container, 'button', { name: 'Save' }).getAttribute('aria-busy')).toBe('true');
  });

  it('fires when it is neither disabled nor loading', () => {
    let presses = 0;
    press(
      element(
        render(
          <AccessibleButton
            testID="b"
            label="Save"
            onPress={() => {
              presses += 1;
            }}
          />,
        ),
        'b',
      ),
    );
    expect(presses).toBe(1);
  });

  it('keeps its label as the accessible name, and lets one be given', () => {
    const plain = render(<AccessibleButton testID="b" label="Save" onPress={noop} />);
    expect(getByRole(plain, 'button', { name: 'Save' })).toBeTruthy();

    const labelled = render(
      <AccessibleButton
        testID="b"
        label="Save"
        accessibilityLabel="Save this meal"
        onPress={noop}
      />,
    );
    expect(getByRole(labelled, 'button', { name: 'Save this meal' })).toBeTruthy();
  });

  it('keeps the label visible while loading', () => {
    // A spinner that replaces the text takes the accessible name away at the exact moment the
    // user is waiting on it.
    const container = render(
      <AccessibleButton testID="b" label="Save" loading icon="check" onPress={noop} />,
    );
    expect(element(container, 'b').textContent).toContain('Save');
  });

  it('becomes a column at a large text scale, and never fixes a height', () => {
    const large = element(
      render(<AccessibleButton testID="b" label="Save" icon="check" onPress={noop} />, 'light', 2),
      'b',
    );

    expect(large.style.flexDirection).toBe('column');
    expect(large.style.height).toBe('');
    expect(large.style.minHeight).toBe(`${String(light.minHeight)}px`);
  });

  it('stretches only when asked to', () => {
    const wide = element(
      render(<AccessibleButton testID="b" label="Save" fullWidth onPress={noop} />),
      'b',
    );
    const narrow = element(
      render(<AccessibleButton testID="b" label="Save" onPress={noop} />),
      'b',
    );

    expect(wide.style.alignSelf).toBe('stretch');
    expect(narrow.style.alignSelf).toBe('flex-start');
  });
});
