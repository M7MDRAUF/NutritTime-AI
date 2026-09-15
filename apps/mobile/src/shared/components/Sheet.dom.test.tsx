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

/**
 * The open dialog, found by its role AND its accessible name in a SINGLE query.
 *
 * **This helper exists because of M-20, and its shape is the fix.** The suite used to assert
 * `getAttribute('aria-label')` on the panel and `getByRole(body, 'dialog')` somewhere else, and
 * passed for months while those two things were on *different elements* three levels apart -
 * react-native-web 0.21.2 puts `role="dialog"` on `ModalContent`'s own `View`, and the name had
 * been set on the panel below it. Neither assertion could see the split, so the test could not
 * fail, and the three destructive confirmations announced as a bare "dialog". A pair that can be
 * satisfied separately is not a pair (BRIEF 6.2 shape 3): `getByRole(name)` computes the
 * accessible name *of the element that has the role*, so it is red the moment they part company.
 *
 * **Call it straight after the render that opened the sheet.** `Modal` keeps a module-level stack
 * of open modals and sets `role={active ? 'dialog' : null}`, where only the newest is active - so
 * with the harness never unmounting anything, exactly one sheet in this file has the role at a
 * time, and it is the one most recently rendered.
 */
function openDialogNamed(name: string): HTMLElement {
  return getByRole(body(), 'dialog', { name });
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

  it('is a dialog whose role and accessible name are on one and the same element', () => {
    // React Native 0.86's `AccessibilityRole` has no `dialog`, so `role="dialog"` arrives only
    // because this is a `Modal` - which is most of why it is one. The name has to arrive on that
    // same element or it is not the dialog's name, which is exactly what M-20 was.
    render(<Sheet testID="sheet-open" visible onClose={noop} title="Filters" children={null} />);

    const dialog = openDialogNamed('Filters');

    // `aria-modal` belongs on the element that has the role - ARIA defines it nowhere else - and
    // `ModalContent` sets it there itself, which is why `Sheet` no longer sets it at all.
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The panel is inside the dialog, not the dialog: it is three `div`s below the role and must
    // carry neither half of the name. Re-declaring either here is how the split came back.
    const panel = element(body(), 'sheet-open');
    expect(dialog.contains(panel)).toBe(true);
    expect(panel.getAttribute('aria-label')).toBeNull();
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(dialog.querySelectorAll('[aria-label="Filters"]').length).toBe(0);
  });

  it('keeps its name on the dialog when its heading is hidden', () => {
    // `hideTitle` is a visual instruction, not an accessibility one. A sheet with no accessible
    // name is a sheet a screen reader announces as "dialog".
    //
    // Asserted immediately after each render rather than both at the end, because only the newest
    // modal carries the role; see `openDialogNamed`.
    render(<Sheet testID="sheet-shown" visible onClose={noop} title="Filters" children={null} />);
    const shownDialog = openDialogNamed('Filters');
    const shown = element(body(), 'sheet-shown');

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
    const hiddenDialog = openDialogNamed('Filters');
    const hidden = element(body(), 'sheet-hidden');

    // The heading goes; the name does not. Two different sheets, so two different dialogs - and
    // the second query is what proves the name survived `hideTitle`, because it found the role
    // and the name together on a sheet that renders the word nowhere.
    expect(shownDialog).not.toBe(hiddenDialog);
    expect(hiddenDialog.contains(hidden)).toBe(true);
    expect(shown.textContent).toContain('Filters');
    expect(hidden.textContent).not.toContain('Filters');
  });

  /**
   * The titles the three destructive-action confirmation sheets are opened with.
   *
   * **Hand-transcribed from the call sites, which are a different authority than the subject**
   * (BRIEF 6.1g) - `SavedScreen.tsx`, `MealFormScreen.tsx` and `settingsCopy.ts`'s
   * `confirmationFor`. Importing them would pin this file to those modules; retyping them states
   * the value intended. They are also the control that no single constant can satisfy (BRIEF 6.2
   * shape 2): a `Sheet` that named every dialog the same word would pass a test that only asked
   * whether *a* named dialog exists, and fails the loop below on its first turn.
   */
  const DESTRUCTIVE_CONFIRMATIONS = [
    { testID: 'sheet-saved-forget', title: 'Remove this favourite?' },
    { testID: 'sheet-meal-delete', title: 'Delete this meal?' },
    { testID: 'sheet-settings-confirm', title: 'Erase everything on this device?' },
  ] as const;

  it('identifies each destructive confirmation by its own name, not as "a dialog"', () => {
    // PRD 10.5. A confirmation a screen-reader user cannot identify is a confirmation they cannot
    // safely answer, and all three of these delete something that does not come back.
    //
    // The fixture is only a control if the three names really are three names.
    expect(new Set(DESTRUCTIVE_CONFIRMATIONS.map((c) => c.title)).size).toBe(3);

    for (const { testID, title } of DESTRUCTIVE_CONFIRMATIONS) {
      render(
        <Sheet testID={testID} visible onClose={noop} title={title}>
          <AppText>Remove</AppText>
        </Sheet>,
      );

      // One query, for the role and this dialog's own name together.
      const dialog = openDialogNamed(title);
      // And it is *this* sheet's dialog, not merely some dialog that happens to carry the name.
      expect(dialog.contains(element(body(), testID))).toBe(true);
    }
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
