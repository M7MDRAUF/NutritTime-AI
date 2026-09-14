import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { FormField } from './FormField.js';

const light = buildComponentTokens(lightColors).field;
const dark = buildComponentTokens(darkColors).field;

const noop = (): void => undefined;

/** The `<input>`/`<textarea>` react-native-web renders for a `TextInput`. */
function input(container: HTMLElement): HTMLElement {
  const found = container.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no text input rendered');
  }
  return found;
}

/** Focus and blur, wrapped so the state they set is flushed before the assertion reads it. */
function focus(target: HTMLElement): void {
  act(() => {
    target.focus();
  });
}

function blur(target: HTMLElement): void {
  act(() => {
    target.blur();
  });
}

describe('FormField', () => {
  it('shows the label, and does not let a placeholder stand in for one', () => {
    // `component.ts` on `field.placeholder`: "Placeholders are a hint, never a label - `FormField`
    // has a visible `label`." Both are present and they are not the same string.
    const container = render(
      <FormField
        testID="f"
        label="Meal name"
        value=""
        onChangeText={noop}
        placeholder="e.g. Laksa"
      />,
    );

    expect(container.textContent).toContain('Meal name');
    expect(input(container).getAttribute('placeholder')).toBe('e.g. Laksa');
    expect(container.textContent).not.toContain('e.g. Laksa');
  });

  it('names itself with the label alone when nothing is wrong', () => {
    const container = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} />,
    );
    expect(input(container).getAttribute('aria-label')).toBe('Meal name');
  });

  it('folds the required marker, the error and the hint into the accessible name, in that order', () => {
    // React Native 0.86 declares no `aria-describedby`, `aria-invalid` or `aria-required` - see
    // the file header - so the accessible NAME is what iOS and Android actually read. The order
    // is the claim: the correction before the guidance.
    const container = render(
      <FormField
        testID="f"
        label="Meal name"
        value=""
        onChangeText={noop}
        required
        hint="Up to 60 characters."
        error="Enter a name."
      />,
    );

    expect(input(container).getAttribute('aria-label')).toBe(
      'Meal name, required. Enter a name. Up to 60 characters.',
    );
  });

  it('drops each clause from the name when it is absent', () => {
    const required = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} required />,
    );
    const hinted = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} hint="Up to 60." />,
    );

    // No trailing stop on the last clause: a pause with nothing after it.
    expect(input(required).getAttribute('aria-label')).toBe('Meal name, required');
    expect(input(hinted).getAttribute('aria-label')).toBe('Meal name. Up to 60.');
  });

  it('punctuates a caller’s copy once, whether or not the caller did', () => {
    // Joining the clauses with ". " regardless produced "Enter a name.. Up to 60 characters.",
    // which is a stumble a screen reader reads aloud. Both spellings of the caller's copy have to
    // come out the same.
    const punctuated = render(
      <FormField
        testID="f"
        label="Meal name"
        value=""
        onChangeText={noop}
        error="Enter a name."
        hint="Up to 60 characters."
      />,
    );
    const bare = render(
      <FormField
        testID="f"
        label="Meal name"
        value=""
        onChangeText={noop}
        error="Enter a name"
        hint="Up to 60 characters"
      />,
    );

    expect(input(punctuated).getAttribute('aria-label')).toBe(
      'Meal name. Enter a name. Up to 60 characters.',
    );
    expect(input(bare).getAttribute('aria-label')).toBe(
      'Meal name. Enter a name. Up to 60 characters',
    );
  });

  it('marks a required field visibly as well as by name', () => {
    // The accessible name says "required"; a sighted user needs to be told too, and in words
    // rather than an asterisk a screen reader would read as "star" or skip entirely.
    const required = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} required />,
    );
    const optional = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} />,
    );

    expect(required.textContent).toContain('Required');
    expect(optional.textContent).not.toContain('Required');
  });

  it('announces the error as an alert, with a mark beside it', () => {
    // Plan 14.2's adopted guideline, and `component.ts` on `field.errorText`: "Paired with an
    // icon, never colour alone." Both live-region spellings, because the native platforms read
    // only the RN one — react-native-web 0.21.2 maps it TO `aria-live`, as `FormField.tsx:202`
    // now records against the shipped source.
    const container = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} error="Enter a name." />,
    );
    const alert = getByRole(container, 'alert');

    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.textContent).toContain('Enter a name.');
    // The mark is the non-colour carrier; it is hidden from assistive technology because the
    // sentence beside it already says it. `alert-circle-outline`, not the failure mark
    // `ErrorState` uses: an invalid field is being corrected, not broken.
    expect(iconNamesIn(alert)).toStrictEqual(['alert-circle-outline']);
    expect(alert.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders no alert region at all when there is no error', () => {
    const container = render(
      <FormField testID="f" label="Meal name" value="" onChangeText={noop} />,
    );
    expect(queryByRole(container, 'alert')).toBeNull();
  });

  it('colours its boundary by state, and an error outranks focus', () => {
    const resting = render(<FormField testID="f" label="Name" value="" onChangeText={noop} />);
    const errored = render(
      <FormField testID="f" label="Name" value="" onChangeText={noop} error="Enter a name." />,
    );

    expect(input(resting).style.borderTopColor).toBe(asRendered(light.borderColor));

    const erroredInput = input(errored);
    expect(erroredInput.style.borderTopColor).toBe(asRendered(light.borderColorError));
    focus(erroredInput);
    expect(erroredInput.style.borderTopColor).toBe(asRendered(light.borderColorError));
  });

  it('thickens its boundary on focus without changing the box it occupies', () => {
    // `component.ts`: "Focus thickens the border rather than replacing it: the field must not
    // appear to move or resize when it gains focus." In React Native a border grows the layout
    // box, so the extra stroke has to come back out of the padding. Border + padding is the
    // quantity that must not change.
    const container = render(<FormField testID="f" label="Name" value="" onChangeText={noop} />);
    const field = input(container);

    const outer = (node: HTMLElement): number =>
      Number.parseFloat(node.style.borderTopWidth) + Number.parseFloat(node.style.paddingTop);

    const resting = outer(field);
    expect(field.style.borderTopWidth).toBe(`${String(light.borderWidth)}px`);

    focus(field);
    expect(field.style.borderTopWidth).toBe(`${String(light.borderWidthFocused)}px`);
    expect(field.style.borderTopColor).toBe(asRendered(light.borderColorFocused));
    expect(outer(field)).toBe(resting);

    blur(field);
    expect(field.style.borderTopWidth).toBe(`${String(light.borderWidth)}px`);
  });

  it('meets the build-to touch target', () => {
    // `field.minHeight` is `touch.buildTo`. A minimum, never a height: the box has to be able to
    // grow when the text does.
    const field = input(render(<FormField testID="f" label="Name" value="" onChangeText={noop} />));

    expect(field.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(field.style.height).toBe('');
  });

  it('reports what the user typed', () => {
    let typed = '';
    const container = render(
      <FormField
        testID="f"
        label="Name"
        value=""
        onChangeText={(next) => {
          typed = next;
        }}
      />,
    );

    act(() => {
      fireEvent.change(input(container), { target: { value: 'Laksa' } });
    });
    expect(typed).toBe('Laksa');
  });

  it('calls back on blur, which is where Plan 14.2 puts validation', () => {
    let blurs = 0;
    const container = render(
      <FormField
        testID="f"
        label="Name"
        value=""
        onChangeText={noop}
        onBlur={() => {
          blurs += 1;
        }}
      />,
    );
    const field = input(container);

    focus(field);
    expect(blurs).toBe(0);
    blur(field);
    expect(blurs).toBe(1);
  });

  it('becomes a multi-line box when asked, and a single-line one otherwise', () => {
    const single = render(<FormField testID="f" label="Name" value="" onChangeText={noop} />);
    const multi = render(
      <FormField testID="f" label="Instructions" value="" onChangeText={noop} multiline />,
    );

    expect(input(single).tagName.toLowerCase()).toBe('input');
    expect(input(multi).tagName.toLowerCase()).toBe('textarea');
  });

  it('passes the length bound straight through', () => {
    // PRD 10.2 bounds user records and FR-015 caps the assistant question at 500 characters; a
    // field that silently dropped `maxLength` would move that check to the server only.
    const container = render(
      <FormField testID="f" label="Question" value="" onChangeText={noop} maxLength={500} />,
    );
    expect(input(container).getAttribute('maxlength')).toBe('500');
  });

  it('scales its type with the OS setting exactly once', () => {
    const single = input(
      render(<FormField testID="f" label="Name" value="" onChangeText={noop} />),
    );
    const doubled = input(
      render(<FormField testID="f" label="Name" value="" onChangeText={noop} />, 'light', 2),
    );

    const base = Number.parseFloat(single.style.fontSize);
    expect(base).toBeGreaterThan(0);
    expect(Number.parseFloat(doubled.style.fontSize)).toBe(base * 2);
    expect(doubled.style.height).toBe('');
  });

  it('takes its fill from the field group in both schemes', () => {
    const inLight = input(
      render(<FormField testID="f" label="Name" value="" onChangeText={noop} />),
    );
    const inDark = input(
      render(<FormField testID="f" label="Name" value="" onChangeText={noop} />, 'dark'),
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('is reachable from the container by its testID', () => {
    expect(
      element(render(<FormField testID="f" label="Name" value="" onChangeText={noop} />), 'f'),
    ).toBeTruthy();
  });
});
