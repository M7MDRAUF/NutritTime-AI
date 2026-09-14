/**
 * The render harness every `*.dom.test.tsx` in this directory shares.
 *
 * Rendered through react-native-web with `createRoot` plus `act`, not `@testing-library/react` —
 * which this workspace does not have and TSD §2.1 does not pin. That is the whole harness.
 *
 * Both theme inputs are injected rather than mocked: `ThemeProvider` takes `mode` and `fontScale`
 * as props precisely so a test can render a scheme or a text size without touching a module
 * registry. Extracted here because six suites had carried a byte-identical copy and the next ten
 * components would have carried ten more — at which point a fix to the harness stops reaching the
 * tests that need it.
 *
 * **This file is test-only.** It lives beside the components rather than under a `__tests__`
 * directory because the project's own convention (see `navigation/testHarness.tsx`) is a named
 * module, and because nothing in the app may import it: it pulls in `react-dom`, which has no
 * business in a React Native bundle.
 */

import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ThemeMode } from '@nutritime/contracts';
import { ThemeProvider } from '../theme/ThemeProvider.js';

/** Render `node` inside a theme with both of its inputs pinned. */
export function render(node: ReactNode, mode: ThemeMode = 'light', fontScale = 1): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      <ThemeProvider mode={mode} deviceScheme={null} fontScale={fontScale}>
        {node}
      </ThemeProvider>,
    );
  });
  return container;
}

/**
 * The element a component rendered for `testID`.
 *
 * Throws rather than returning `null`, so a typo in a test id fails as "no element rendered"
 * instead of as a confusing assertion against `undefined` three lines later.
 */
export function element(container: HTMLElement, testID: string): HTMLElement {
  const found = container.querySelector(`[data-testid="${testID}"]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no element rendered for testID ${testID}`);
  }
  return found;
}

/**
 * Every vendor icon name the tree rendered, in document order.
 *
 * **The right way to assert an icon in this environment.** jsdom has no font engine, so nothing
 * here can prove a glyph was drawn; what IS provable is which icon was asked for. The double at
 * `__testing__/iconSet.tsx` surfaces the vendor's name as `data-icon-name`, so a test asserts
 * identity (`alert-outline`) rather than a character (`\u26A0`) that no longer exists and could
 * not have been measured anyway.
 *
 * The suites used to assert the characters, because `Icon` was a Unicode glyph map. Five of them
 * failed the moment it became a real icon set - which is the correct outcome for an assertion
 * about an implementation detail, and the reason this helper exists rather than five new
 * per-file ones.
 */
export function iconNamesIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-icon-name]')].map(
    (node) => node.getAttribute('data-icon-name') ?? '',
  );
}

/** A press, wrapped in `act` so the state it sets is flushed before the assertion reads it. */
export function press(target: HTMLElement): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * A colour put through jsdom's own parser, so a token's value and a rendered one compare as equals.
 *
 * Read through `getComputedStyle` rather than the inline declaration, because a fill can be the
 * keyword `transparent`: inline it stays that word, while react-native-web resolves it to
 * `rgba(0, 0, 0, 0)`. Computing both ends puts every colour in one form.
 */
export function asRendered(color: string): string {
  const probe = document.createElement('div');
  probe.style.backgroundColor = color;
  document.body.appendChild(probe);
  return globalThis.getComputedStyle(probe).backgroundColor;
}
