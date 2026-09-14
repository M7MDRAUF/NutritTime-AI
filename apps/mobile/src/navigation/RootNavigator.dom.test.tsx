/**
 * T-12-12. The two claims that matter, and the reason each is a test rather than a review note:
 *
 *  1. **The boot phase gates what renders.** Not what is focused — what *exists*. The negative
 *     assertions carry the weight here: in `hydrating` there must be no route to the tabs at all,
 *     which is TSD §6.1's guarantee that a protected screen cannot render before hydration and
 *     that onboarding cannot be shown to someone who has finished it.
 *  2. **Five tabs, in PRD §11's order**, with the Assistant in the centre.
 *
 * Nothing is registered, so each route renders its placeholder — which names the route, and so
 * makes "which screens exist" directly readable from the DOM.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { ThemeProvider } from '../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../state/StorageProvider.js';
import { uiStore } from '../state/ui/index.js';
import { memoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import { RootNavigator } from './RootNavigator.js';
import type { BootPhase } from './routes.js';
import { renderToDom } from './testHarness.js';

vi.mock('react-native-safe-area-context', async () => {
  const { createSafeAreaContextMock } = await import('./testHarness.js');
  return createSafeAreaContextMock();
});

/**
 * **`StorageProvider` and the `ui` store are mounted here as of P18, and that is a real change to
 * what this suite covers rather than boilerplate.**
 *
 * `TabNavigator` now records the tab the user moved to (T-18-01): it dispatches
 * `ui/tabChanged` on `focus`, and reads the tab to open on from the hydration snapshot. So the
 * navigator genuinely depends on both, and a test that rendered it without them would be testing a
 * tree the app never builds.
 *
 * This is **not** the mocking exercise `RootNavigator`'s own docstring warns about — `phase` is
 * still a prop, for exactly the reason recorded there. These are the real providers with an
 * injected memory driver, the same shape `createStore.dom.test.tsx` uses, so nothing here is a
 * stand-in for the thing it is testing.
 */
const CLOCK = () => '2026-09-13T12:00:00.000Z';

function App({ phase }: { readonly phase: BootPhase }): ReactNode {
  return (
    <ThemeProvider mode="light" deviceScheme="light" fontScale={1}>
      <StorageProvider runtime={{ driver: memoryDriver({}), now: CLOCK }}>
        <uiStore.Provider>
          <NavigationContainer>
            <RootNavigator phase={phase} />
          </NavigationContainer>
        </uiStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );
}

/** The accessible names of the tab buttons, in render order. */
/**
 * What each tab ANNOUNCES, which is not the same as its `textContent`.
 *
 * Descendants marked `aria-hidden` are dropped, and that turned from bookkeeping into the point of
 * the helper when the tabs got real icons (A-11): every `tabBarIcon` renders an `Icon`, which hides
 * itself from assistive technology because the visible label beside it already says the word. A
 * bare `textContent` read picks the icon up anyway and returned `home-outlineHome`.
 *
 * So this now asserts the accessibility claim rather than merely tolerating the icon: a tab
 * announces "Home", once, and the icon contributes nothing to its name.
 */
function tabNames(host: HTMLElement): readonly string[] {
  return [...host.querySelectorAll('[role="tab"]')].map((tab) => {
    const clone = tab.cloneNode(true);
    if (!(clone instanceof HTMLElement)) {
      return '';
    }
    for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) {
      hidden.remove();
    }
    return clone.textContent ?? '';
  });
}

describe('the root navigator', () => {
  it('shows only Splash while hydrating', async () => {
    const view = await renderToDom(<App phase="hydrating" />);

    expect(view.text()).toContain('Splash is not available yet');
    // The tabs are not merely unfocused — there is no tab bar, because the route does not exist.
    expect(tabNames(view.host)).toEqual([]);
    expect(view.text()).not.toContain('Home');
    expect(view.text()).not.toContain('Onboarding');
    await view.unmount();
  });

  it('shows onboarding, and no route into the app, while onboarding', async () => {
    const view = await renderToDom(<App phase="onboarding" />);

    expect(view.text()).toContain('Onboarding is not available yet');
    expect(tabNames(view.host)).toEqual([]);
    expect(view.text()).not.toContain('Splash');
    await view.unmount();
  });

  it('shows the five tabs, Assistant in the centre, once the app phase is reached', async () => {
    const view = await renderToDom(<App phase="app" />);

    expect(tabNames(view.host)).toEqual(['Home', 'Explore', 'Assistant', 'Saved', 'Settings']);
    // Home is the initial tab, and its stack is mounted.
    expect(view.text()).toContain('Home is not available yet');
    // Onboarding is gone: a user who has finished it cannot be shown it again.
    expect(view.text()).not.toContain('Onboarding is not available yet');
    expect(view.text()).not.toContain('Splash is not available yet');
    await view.unmount();
  });

  it('swaps the screens when the phase advances, rather than redirecting over them', async () => {
    const view = await renderToDom(<App phase="hydrating" />);
    expect(view.text()).toContain('Splash is not available yet');

    await view.rerender(<App phase="app" />);

    expect(tabNames(view.host)).toEqual(['Home', 'Explore', 'Assistant', 'Saved', 'Settings']);
    expect(view.text()).not.toContain('Splash is not available yet');
    await view.unmount();
  });
});
