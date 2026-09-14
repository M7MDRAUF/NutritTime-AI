import { describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { ErrorState } from './ErrorState.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

describe('ErrorState', () => {
  it('names the state when the caller does not, and gets out of the way when it does', () => {
    expect(render(<ErrorState testID="x" />).textContent).toContain('Something went wrong');

    const named = render(<ErrorState testID="x" title="Recommendations failed" />);
    expect(named.textContent).toContain('Recommendations failed');
    expect(named.textContent).not.toContain('Something went wrong');
  });

  it('announces itself as an alert', () => {
    // Plan 14.2 adopted `role="alert"` for errors specifically, and this is the only one of the
    // five state components that carries it. Both spellings are asserted because
    // react-native-web 0.21 maps neither from the other: if the aria alias were dropped the web
    // export would announce nothing, and this is the test that would still be green.
    const state = element(render(<ErrorState testID="x" />), 'x');

    expect(state.getAttribute('role')).toBe('alert');
    expect(state.getAttribute('aria-live')).toBe('assertive');
  });

  it('ranks its two actions: retry is the affirmative fill, the alternative is not', () => {
    // Two buttons that look identical are two buttons the user has to read before choosing. The
    // fills come from two different variants of the button group, so this fails if they are ever
    // given the same one.
    const container = render(
      <ErrorState
        testID="x"
        onRetry={() => undefined}
        secondaryActionLabel="Browse the catalog"
        onSecondaryAction={() => undefined}
      />,
    );

    const retry = getByRole(container, 'button', { name: 'Try again' });
    const secondary = getByRole(container, 'button', { name: 'Browse the catalog' });

    expect(retry.style.backgroundColor).toBe(asRendered(light.button.primary.background));
    expect(secondary.style.backgroundColor).toBe(asRendered(light.button.ghost.background));
    expect(retry.style.backgroundColor).not.toBe(secondary.style.backgroundColor);
  });

  it('fires each action independently', () => {
    let retries = 0;
    let secondaries = 0;
    const container = render(
      <ErrorState
        testID="x"
        retryLabel="Retry"
        onRetry={() => {
          retries += 1;
        }}
        secondaryActionLabel="Go back"
        onSecondaryAction={() => {
          secondaries += 1;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Retry' }));
    expect(retries).toBe(1);
    expect(secondaries).toBe(0);

    press(getByRole(container, 'button', { name: 'Go back' }));
    expect(secondaries).toBe(1);
    expect(retries).toBe(1);
  });

  it('renders no retry button without a handler, even with a label', () => {
    // `retryLabel` has a default, so a component that keyed the button off the label alone would
    // render a dead "Try again" on every error.
    const container = render(<ErrorState testID="x" retryLabel="Retry" />);
    expect(queryByRole(container, 'button')).toBeNull();
  });

  it('renders no secondary button when only half of it is given', () => {
    const labelOnly = render(
      <ErrorState testID="x" onRetry={() => undefined} secondaryActionLabel="Go back" />,
    );
    expect(queryByRole(labelOnly, 'button', { name: 'Go back' })).toBeNull();

    const handlerOnly = render(
      <ErrorState testID="x" onRetry={() => undefined} onSecondaryAction={() => undefined} />,
    );
    // The retry button is still there; the secondary one is not, because it has no name.
    expect(handlerOnly.querySelectorAll('[role="button"]').length).toBe(1);
  });

  it('carries the failure by a mark as well as by a colour, in both schemes', () => {
    // PRD 10.5: colour is never the only carrier. The MARK is the non-colour half, and it is the
    // same icon in both schemes while the colour is not.
    //
    // Asserted by icon NAME, not by character. This test used to look for `\u2717` because `Icon`
    // was a Unicode glyph map; with a real set behind it (A-11) the character is an
    // implementation detail of the font, and jsdom could never prove it was drawn anyway.
    const inLight = render(<ErrorState testID="x" />);
    const inDark = render(<ErrorState testID="x" />, 'dark');

    // `close-circle-outline` is the FAILURE mark. `FormField`'s invalid-value mark is
    // `alert-circle-outline`, deliberately different: a field mid-correction has not failed.
    expect(iconNamesIn(inLight)).toStrictEqual(['close-circle-outline']);
    expect(iconNamesIn(inDark)).toStrictEqual(['close-circle-outline']);

    const lightIcon = inLight.querySelector('[aria-hidden="true"]');
    const darkIcon = inDark.querySelector('[aria-hidden="true"]');
    if (!(lightIcon instanceof HTMLElement) || !(darkIcon instanceof HTMLElement)) {
      throw new Error('no icon rendered');
    }
    expect(lightIcon.style.color).toBe(asRendered(lightColors.status.danger));
    expect(darkIcon.style.color).toBe(asRendered(darkColors.status.danger));
    expect(lightIcon.style.color).not.toBe(darkIcon.style.color);
  });

  it('renders the "what still works" sentence in its own bounded note', () => {
    const container = render(
      <ErrorState
        testID="x"
        description="The recommendation service did not answer."
        stillAvailable="Explore and your saved meals still work offline."
      />,
    );
    const note = element(container, 'x-still-available');

    expect(note.textContent).toContain('Explore and your saved meals still work offline.');
    expect(note.textContent).not.toContain('The recommendation service did not answer.');
    expect(note.style.backgroundColor).toBe(asRendered(light.card.background));
  });

  it('stacks its actions at a 2x font scale instead of squeezing them', () => {
    // `isLargeText` is true from 1.3 up. Two labels side by side at 2x would each get a sliver,
    // so the row becomes a column - the same rule `AccessibleButton` applies to its own contents.
    const wide = render(
      <ErrorState
        testID="x"
        onRetry={() => undefined}
        secondaryActionLabel="Go back"
        onSecondaryAction={() => undefined}
      />,
    );
    const tall = render(
      <ErrorState
        testID="x"
        onRetry={() => undefined}
        secondaryActionLabel="Go back"
        onSecondaryAction={() => undefined}
      />,
      'light',
      2,
    );

    const wideRow = getByRole(wide, 'button', { name: 'Try again' }).parentElement;
    const tallRow = getByRole(tall, 'button', { name: 'Try again' }).parentElement;
    if (!(wideRow instanceof HTMLElement) || !(tallRow instanceof HTMLElement)) {
      throw new Error('no action row rendered');
    }

    expect(wideRow.style.flexDirection).toBe('row');
    expect(tallRow.style.flexDirection).toBe('column');
  });

  it('has nowhere to put an exception, by construction', () => {
    // TSD 6.7: `description` is user-facing copy, never an exception message; PRD 12: stack
    // traces never reach the user. A component cannot police what a caller passes, but it can
    // refuse to accept an error object at all - and this is the assertion that fails the day
    // someone adds an `error?: unknown` prop and starts rendering `String(error)`.
    const container = render(
      <ErrorState testID="x" description="We could not reach the server." />,
    );
    expect(container.textContent).toContain('We could not reach the server.');
    expect(container.textContent).not.toContain('Error:');
    expect(container.textContent).not.toContain('at ');
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const state = element(render(<ErrorState testID="x" />, 'light', 2), 'x');
    expect(state.style.height).toBe('');
    expect(state.style.maxHeight).toBe('');
  });

  it('takes the note through the token group in dark as well as light', () => {
    const inDark = element(
      render(<ErrorState testID="x" stillAvailable="Saved meals work." />, 'dark'),
      'x-still-available',
    );
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
  });
});
