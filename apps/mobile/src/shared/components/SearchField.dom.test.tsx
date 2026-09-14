import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { SearchField } from './SearchField.js';

const light = buildComponentTokens(lightColors).field;
const dark = buildComponentTokens(darkColors).field;

const noop = (): void => undefined;

function input(container: HTMLElement): HTMLElement {
  const found = container.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no text input rendered');
  }
  return found;
}

describe('SearchField', () => {
  it('is a search landmark, so the glyph is never what says what this is', () => {
    // React Native 0.86 has no `searchbox` role for the input itself, and `role="search"` on an
    // `<input>` would be invalid ARIA, so the landmark goes on the container where it is correct.
    // This is the assertion that keeps the component honest if the icon ever fails to render.
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    expect(getByRole(container, 'search')).toBe(element(container, 's'));
  });

  it('always has an accessible name, defaulted, and never leans on the placeholder for one', () => {
    // TSD 6.7 gives this component no `label`, so the name is the only thing a screen reader has.
    // A placeholder is not a name: it disappears the moment the user types.
    const defaulted = render(
      <SearchField testID="s" value="" onChangeText={noop} placeholder="Search meals" />,
    );
    const named = render(
      <SearchField
        testID="s"
        value=""
        onChangeText={noop}
        accessibilityLabel="Search the catalog"
      />,
    );

    expect(input(defaulted).getAttribute('aria-label')).toBe('Search');
    expect(input(defaulted).getAttribute('placeholder')).toBe('Search meals');
    expect(input(named).getAttribute('aria-label')).toBe('Search the catalog');
  });

  it('keeps the leading icon decorative, so the field is not announced twice', () => {
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const icon = container.querySelector('[aria-hidden="true"]');

    expect(icon).not.toBeNull();
    if (!(icon instanceof HTMLElement)) {
      throw new Error('no icon rendered');
    }
    expect(icon.style.color).toBe(asRendered(light.placeholder));
  });

  it('offers a clear control only when there is something to clear', () => {
    const empty = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const filled = render(<SearchField testID="s" value="laksa" onChangeText={noop} />);

    expect(queryByRole(empty, 'button', { name: 'Clear search' })).toBeNull();
    expect(getByRole(filled, 'button', { name: 'Clear search' })).toBeTruthy();
  });

  it('empties the field through the same callback the user types into', () => {
    // Not internal state: the value is the caller's, so clearing it has to be reported rather
    // than performed. A component that emptied its own copy would desync from the screen.
    let latest = 'laksa';
    const container = render(
      <SearchField
        testID="s"
        value="laksa"
        onChangeText={(next) => {
          latest = next;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Clear search' }));
    expect(latest).toBe('');
  });

  it('reports what the user typed', () => {
    let typed = '';
    const container = render(
      <SearchField
        testID="s"
        value=""
        onChangeText={(next) => {
          typed = next;
        }}
      />,
    );

    act(() => {
      fireEvent.change(input(container), { target: { value: 'pie' } });
    });
    expect(typed).toBe('pie');
  });

  it('submits on the return key, and only when a handler was given', () => {
    let submissions = 0;
    const container = render(
      <SearchField
        testID="s"
        value="pie"
        onChangeText={noop}
        onSubmit={() => {
          submissions += 1;
        }}
      />,
    );

    act(() => {
      fireEvent.keyDown(input(container), { key: 'Enter' });
    });
    expect(submissions).toBe(1);

    // Without a handler the same key press must not throw.
    const plain = render(<SearchField testID="s" value="pie" onChangeText={noop} />);
    act(() => {
      fireEvent.keyDown(input(plain), { key: 'Enter' });
    });
    expect(submissions).toBe(1);
  });

  it('meets the build-to touch target as a minimum, not as a height', () => {
    const trough = element(render(<SearchField testID="s" value="" onChangeText={noop} />), 's');

    expect(trough.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(trough.style.height).toBe('');
    expect(trough.style.maxHeight).toBe('');
  });

  it('thickens its boundary on focus without changing the box it occupies', () => {
    const container = render(<SearchField testID="s" value="" onChangeText={noop} />);
    const trough = element(container, 's');
    const field = input(container);

    const outer = (node: HTMLElement): number =>
      Number.parseFloat(node.style.borderTopWidth) + Number.parseFloat(node.style.paddingLeft);
    const resting = outer(trough);

    act(() => {
      field.focus();
    });

    expect(trough.style.borderTopWidth).toBe(`${String(light.borderWidthFocused)}px`);
    expect(trough.style.borderTopColor).toBe(asRendered(light.borderColorFocused));
    expect(outer(trough)).toBe(resting);
  });

  it('takes its fill from the field group in both schemes', () => {
    const inLight = element(render(<SearchField testID="s" value="" onChangeText={noop} />), 's');
    const inDark = element(
      render(<SearchField testID="s" value="" onChangeText={noop} />, 'dark'),
      's',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('scales its type with the OS setting exactly once', () => {
    const single = input(render(<SearchField testID="s" value="" onChangeText={noop} />));
    const doubled = input(
      render(<SearchField testID="s" value="" onChangeText={noop} />, 'light', 2),
    );

    const base = Number.parseFloat(single.style.fontSize);
    expect(base).toBeGreaterThan(0);
    expect(Number.parseFloat(doubled.style.fontSize)).toBe(base * 2);
  });
});
