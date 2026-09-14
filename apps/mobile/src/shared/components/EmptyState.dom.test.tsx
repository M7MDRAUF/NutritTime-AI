import { describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { EmptyState } from './EmptyState.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

/**
 * The text a screen reader would read.
 *
 * `Icon` renders a Unicode glyph inside a `Text`, so a decorative icon puts a character into
 * `textContent` that no user is meant to perceive as text. Stripping the `aria-hidden` subtrees
 * lets an assertion say "this is the ONLY copy on the screen" exactly, which is what the
 * no-invented-default-description claim needs - `toContain` could not fail on an extra sentence.
 */
function readableText(container: HTMLElement): string {
  const clone = container.cloneNode(true);
  if (!(clone instanceof HTMLElement)) {
    throw new Error('cloneNode did not return an element');
  }
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return clone.textContent ?? '';
}

describe('EmptyState', () => {
  it('names the state when the caller does not, and gets out of the way when it does', () => {
    const defaulted = render(<EmptyState testID="e" />);
    expect(defaulted.textContent).toContain('Nothing here yet');

    const named = render(<EmptyState testID="e" title="No saved meals" />);
    expect(named.textContent).toContain('No saved meals');
    expect(named.textContent).not.toContain('Nothing here yet');
  });

  it('renders no description at all rather than a generic one', () => {
    // The component knows WHAT KIND of state it is and not the details. A default second
    // sentence would be a guess, and this is the assertion that stops one being added: the only
    // text present with no `description` is the default title.
    const container = render(<EmptyState testID="e" />);
    expect(readableText(container)).toBe('Nothing here yet');
  });

  it('renders the "what still works" sentence in its own bounded note', () => {
    // PRD 12 asks for three distinguishable clauses. A reassurance rendered as one more paragraph
    // of the description is a reassurance nobody finds, so this asserts the note is a real box
    // with the card group's own fill and border - not just that the words appear somewhere.
    const container = render(
      <EmptyState
        testID="e"
        description="No meals match these filters."
        stillAvailable="Your saved meals and the built-in catalog are still here."
      />,
    );
    const note = element(container, 'e-still-available');

    expect(readableText(note)).toBe('Your saved meals and the built-in catalog are still here.');
    expect(note.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(note.style.borderTopWidth).toBe(`${String(light.card.borderWidth)}px`);
    // And the description is somewhere else entirely.
    expect(note.textContent).not.toContain('No meals match these filters.');
  });

  it('renders no note when there is nothing to say still works', () => {
    const container = render(<EmptyState testID="e" description="Nothing matched." />);
    expect(container.querySelector('[data-testid="e-still-available"]')).toBeNull();
  });

  it('takes the note through the token group in both schemes', () => {
    const inLight = element(
      render(<EmptyState testID="e" stillAvailable="Saved meals work." />),
      'e-still-available',
    );
    const inDark = element(
      render(<EmptyState testID="e" stillAvailable="Saved meals work." />, 'dark'),
      'e-still-available',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('offers the action when both halves are given, and fires it', () => {
    let presses = 0;
    const container = render(
      <EmptyState
        testID="e"
        actionLabel="Clear filters"
        onAction={() => {
          presses += 1;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Clear filters' }));
    expect(presses).toBe(1);
  });

  it('renders no button when only half the action is given', () => {
    // A label with no handler is a button that does nothing, which is worse than no button.
    const labelOnly = render(<EmptyState testID="e" actionLabel="Clear filters" />);
    expect(queryByRole(labelOnly, 'button')).toBeNull();

    const handlerOnly = render(<EmptyState testID="e" onAction={() => undefined} />);
    expect(queryByRole(handlerOnly, 'button')).toBeNull();
  });

  it('is quiet: the icon is not a status colour', () => {
    // An empty list is an ordinary outcome. Painting it amber teaches the user to read a normal
    // state as a fault, so this pins the icon to `content.tertiary` and away from the status
    // family that `ErrorState` and `OfflineState` use.
    const container = render(<EmptyState testID="e" />);
    const glyph = container.querySelectorAll('div[dir="auto"], span');
    const colors = [...glyph].map((node) => (node instanceof HTMLElement ? node.style.color : ''));

    expect(colors).toContain(asRendered(lightColors.content.tertiary));
    expect(colors).not.toContain(asRendered(lightColors.status.warning));
    expect(colors).not.toContain(asRendered(lightColors.status.danger));
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const state = element(render(<EmptyState testID="e" title="Nothing saved" />, 'light', 2), 'e');

    expect(state.style.height).toBe('');
    expect(state.style.maxHeight).toBe('');
  });

  it('does not announce itself: an empty list is page content, not an interruption', () => {
    // The contrast with `ErrorState` is the point. If this ever becomes a live region, an empty
    // search result would interrupt the user on every keystroke.
    const state = element(render(<EmptyState testID="e" />), 'e');
    expect(state.getAttribute('aria-live')).toBeNull();
    expect(state.getAttribute('role')).not.toBe('alert');
  });

  it('keeps every icon decorative, so nothing is announced twice', () => {
    // Both glyphs here repeat copy that is already beside them in words. If either stopped being
    // hidden, a screen reader would read the note as "info, your saved meals..." and the state
    // as a stray character before its own title.
    const container = render(<EmptyState testID="e" stillAvailable="Saved meals still work." />);

    expect(readableText(container)).toBe('Nothing here yetSaved meals still work.');
    // ...which is only true because the two glyphs ARE in the raw text and ARE hidden.
    expect(container.textContent).not.toBe(readableText(container));
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(2);
  });
});
