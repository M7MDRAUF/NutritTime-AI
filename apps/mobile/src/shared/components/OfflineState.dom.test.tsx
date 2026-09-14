import { describe, expect, it } from 'vitest';
import { getByRole, queryByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { OfflineState } from './OfflineState.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

describe('OfflineState', () => {
  it('describes the app’s mode, not the user’s connection', () => {
    // PRD 12 calls this state "local-only (server unreachable)" and PRD 10.2 says core features
    // work with no network at all. The server on the same machine can be down while the phone's
    // connection is perfect, so a default of "You're offline" would be a claim this component
    // cannot check and usually a false one.
    const container = render(<OfflineState testID="o" />);

    expect(container.textContent).toContain('Working offline');
    expect(container.textContent).not.toContain('offline.');
    expect(container.textContent?.toLowerCase()).not.toContain('connection');
    expect(container.textContent?.toLowerCase()).not.toContain('internet');
  });

  it('lets the caller name the state instead', () => {
    const named = render(<OfflineState testID="o" title="Showing local meals" />);
    expect(named.textContent).toContain('Showing local meals');
    expect(named.textContent).not.toContain('Working offline');
  });

  it('is a polite live region and not an alert', () => {
    // Losing the server is a change of mode the user should be told about; it is not the
    // interruption an error is. Both spellings, because the native platforms read only the RN
    // one — react-native-web 0.21.2 maps it TO `aria-live` (`'none'` → `'off'`), not a no-op.
    const state = element(render(<OfflineState testID="o" />), 'o');

    expect(state.getAttribute('aria-live')).toBe('polite');
    expect(state.getAttribute('role')).not.toBe('alert');
  });

  it('carries the state by its own mark, not the one an error uses', () => {
    // Three states, three marks, and the difference matters: `cloud-off-outline` says "not
    // connected", `close-circle-outline` says "failed", `alert-circle-outline` says "invalid".
    // A caution triangle - which this used before the icon set landed (A-11) - said only "be
    // careful", and PRD 10.2 is explicit that working offline is normal here rather than a fault.
    expect(iconNamesIn(render(<OfflineState testID="o" />))).toStrictEqual(['cloud-off-outline']);
  });

  it('renders the "what still works" sentence in its own bounded note', () => {
    // This is the sentence that turns a dead end into a mode, and it is the whole reason this
    // state is not a wall. It has to be a distinguishable block, not more prose.
    const container = render(
      <OfflineState
        testID="o"
        description="The recommendation server did not answer."
        stillAvailable="All 60 built-in meals, your favorites and your custom meals still work."
      />,
    );
    const note = element(container, 'o-still-available');

    expect(note.textContent).toContain(
      'All 60 built-in meals, your favorites and your custom meals still work.',
    );
    expect(note.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(note.style.borderTopWidth).toBe(`${String(light.card.borderWidth)}px`);
  });

  it('offers a retry, defaulted, and fires it', () => {
    let retries = 0;
    const container = render(
      <OfflineState
        testID="o"
        onRetry={() => {
          retries += 1;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Try again' }));
    expect(retries).toBe(1);
  });

  it('renders no retry button without a handler, even with a label', () => {
    const container = render(<OfflineState testID="o" retryLabel="Reconnect" />);
    expect(queryByRole(container, 'button')).toBeNull();
  });

  it('fills the note from its own token group in both schemes', () => {
    const inLight = element(
      render(<OfflineState testID="o" stillAvailable="Saved meals work." />),
      'o-still-available',
    );
    const inDark = element(
      render(<OfflineState testID="o" stillAvailable="Saved meals work." />, 'dark'),
      'o-still-available',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.card.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.card.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const state = element(render(<OfflineState testID="o" />, 'light', 2), 'o');
    expect(state.style.height).toBe('');
    expect(state.style.maxHeight).toBe('');
  });
});
