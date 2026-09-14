import { describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { AppText } from './AppText.js';
import { Sheet } from './Sheet.js';

const light = buildComponentTokens(lightColors).sheet;
const dark = buildComponentTokens(darkColors).sheet;

const noop = (): void => undefined;

/**
 * A sheet is a `Modal`, and react-native-web renders a `Modal` through a portal into
 * `document.body` rather than into the container the harness created. So every query here is
 * rooted at the body, and every `testID` in this file is unique: the harness never removes a
 * container, so a repeated id would be found from an earlier test in this same file.
 */
function body(): HTMLElement {
  return document.body;
}

describe('Sheet', () => {
  it('renders nothing at all while it is closed', () => {
    render(
      <Sheet
        testID="sheet-closed"
        visible={false}
        onClose={noop}
        title="Filters"
        children={null}
      />,
    );
    expect(body().querySelector('[data-testid="sheet-closed"]')).toBeNull();
  });

  it('is a modal dialog when it is open', () => {
    // React Native 0.86's `AccessibilityRole` has no `dialog`, so `role="dialog"` arrives only
    // because this is a `Modal` - which is most of why it is one. Both modal spellings are set:
    // `accessibilityViewIsModal` is what iOS reads and `aria-modal` is what the web export and
    // this suite read, and react-native-web 0.21 maps neither from the other.
    render(<Sheet testID="sheet-open" visible onClose={noop} title="Filters" children={null} />);
    const panel = element(body(), 'sheet-open');

    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(getByRole(body(), 'dialog')).toBeTruthy();
  });

  it('keeps its name when its heading is hidden', () => {
    // `hideTitle` is a visual instruction, not an accessibility one. A sheet with no accessible
    // name is a sheet a screen reader announces as "dialog".
    render(<Sheet testID="sheet-shown" visible onClose={noop} title="Filters" children={null} />);
    render(
      <Sheet
        testID="sheet-hidden"
        visible
        onClose={noop}
        title="Filters"
        hideTitle
        children={null}
      />,
    );

    const shown = element(body(), 'sheet-shown');
    const hidden = element(body(), 'sheet-hidden');

    expect(shown.textContent).toContain('Filters');
    expect(hidden.textContent).not.toContain('Filters');
    expect(shown.getAttribute('aria-label')).toBe('Filters');
    expect(hidden.getAttribute('aria-label')).toBe('Filters');
  });

  it('closes on its close button', () => {
    let closes = 0;
    render(
      <Sheet
        testID="sheet-close-button"
        visible
        onClose={() => {
          closes += 1;
        }}
        title="Filters"
        children={null}
      />,
    );

    press(
      getByRole(element(body(), 'sheet-close-button').parentElement ?? body(), 'button', {
        name: 'Close',
      }),
    );
    expect(closes).toBe(1);
  });

  it('closes on the backdrop, which is hidden from assistive technology', () => {
    // The backdrop is a convenience for a pointer. Announcing it would add a second, unlabelled
    // way out that a screen-reader user has to swipe past; the close button is the accessible one.
    let closes = 0;
    render(
      <Sheet
        testID="sheet-backdrop"
        visible
        onClose={() => {
          closes += 1;
        }}
        title="Filters"
        children={null}
      />,
    );

    const panel = element(body(), 'sheet-backdrop');
    const overlay = panel.parentElement;
    if (!(overlay instanceof HTMLElement)) {
      throw new Error('no overlay rendered');
    }
    const backdrop = overlay.querySelector('[aria-hidden="true"]');
    if (!(backdrop instanceof HTMLElement)) {
      throw new Error('no backdrop rendered');
    }

    expect(backdrop.style.backgroundColor).toBe(asRendered(light.backdrop));
    press(backdrop);
    expect(closes).toBe(1);
    // And there is exactly one control that announces itself as a way out.
    expect(overlay.querySelectorAll('[role="button"]').length).toBe(1);
  });

  it('stacks the panel above its own backdrop', () => {
    render(<Sheet testID="sheet-zindex" visible onClose={noop} title="Filters" children={null} />);
    const panel = element(body(), 'sheet-zindex');

    expect(panel.style.zIndex).toBe(String(light.zIndex));
    expect(Number(panel.style.zIndex)).toBeGreaterThan(light.backdropZIndex);
  });

  it('renders its children', () => {
    render(
      <Sheet testID="sheet-children" visible onClose={noop} title="Filters">
        <AppText>Vegan only</AppText>
      </Sheet>,
    );
    expect(element(body(), 'sheet-children').textContent).toContain('Vegan only');
  });

  it('adds an injected safe-area inset to its own padding rather than replacing it', () => {
    // `react-native-safe-area-context` ships its web build as `*.web.js` platform files, which
    // Metro resolves and Vitest does not, so the insets are a prop. A phone with a home indicator
    // gets clearance; one without is unchanged.
    render(
      <Sheet testID="sheet-no-inset" visible onClose={noop} title="Filters" children={null} />,
    );
    render(
      <Sheet
        testID="sheet-inset"
        visible
        onClose={noop}
        title="Filters"
        insets={{ bottom: 34 }}
        children={null}
      />,
    );

    expect(element(body(), 'sheet-no-inset').style.paddingBottom).toBe(
      `${String(light.padding)}px`,
    );
    expect(element(body(), 'sheet-inset').style.paddingBottom).toBe(
      `${String(light.padding + 34)}px`,
    );
    // The top padding is untouched by the inset: only the bottom edge has a home indicator.
    expect(element(body(), 'sheet-inset').style.paddingTop).toBe(`${String(light.padding)}px`);
  });

  it('rounds only its top corners, because it rises from the bottom edge', () => {
    render(<Sheet testID="sheet-radius" visible onClose={noop} title="Filters" children={null} />);
    const panel = element(body(), 'sheet-radius');

    expect(panel.style.borderTopLeftRadius).toBe(`${String(light.radiusTop)}px`);
    expect(panel.style.borderTopRightRadius).toBe(`${String(light.radiusTop)}px`);
    expect(panel.style.borderBottomLeftRadius).toBe('');
  });

  it('takes its surface from the sheet group in both schemes', () => {
    render(<Sheet testID="sheet-light" visible onClose={noop} title="Filters" children={null} />);
    render(
      <Sheet testID="sheet-dark" visible onClose={noop} title="Filters" children={null} />,
      'dark',
    );

    const inLight = element(body(), 'sheet-light');
    const inDark = element(body(), 'sheet-dark');

    expect(inLight.style.backgroundColor).toBe(asRendered(light.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('grows at a 2x font scale instead of clipping', () => {
    render(
      <Sheet
        testID="sheet-scaled"
        visible
        onClose={noop}
        title="A long sheet title"
        children={null}
      />,
      'light',
      2,
    );
    const panel = element(body(), 'sheet-scaled');

    expect(panel.style.height).toBe('');
    expect(panel.style.maxHeight).toBe('');
  });

  it('has no dialog anywhere in the document while every sheet is closed', () => {
    // Guards the whole file's premise: the assertions above read from `document.body`, which the
    // harness never cleans, so this is the check that a closed sheet leaves nothing behind for a
    // later test to find.
    const isolated = render(
      <Sheet testID="sheet-none" visible={false} onClose={noop} title="Filters" children={null} />,
    );
    expect(queryByRole(isolated, 'dialog')).toBeNull();
    expect(isolated.textContent).toBe('');
  });
});
