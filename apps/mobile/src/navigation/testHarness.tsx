/**
 * The render harness and the one mock a navigator cannot mount without.
 *
 * **Two of the three shims this file used to carry have moved to `vitest.setup.dom.mts`**, which
 * now exists: `IS_REACT_ACT_ENVIRONMENT` and the no-op `ResizeObserver` are global concerns and
 * every dom suite needs them. What stays is the one that must NOT be global.
 *
 * `react-native-safe-area-context` ships its web implementation as `*.web.js` platform files.
 * Metro resolves those; Vitest does not, so the bare `.js` files load and import React Native's
 * Flow-typed codegen specs, which esbuild cannot parse. Every navigator reaches this package
 * through `@react-navigation/elements`, so nothing here renders without the mock below.
 *
 * It is opted into per file rather than declared in the setup, because a `vi.mock` in a setup file
 * replaces the module for every dom test in the workspace - including suites that never asked, and
 * whose failure would then name a module they do not import.
 */

import { act, createContext } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The module object for `vi.mock('react-native-safe-area-context', ...)`.
 *
 * Zero insets and a phone-sized frame: a navigator laid out against real insets would make every
 * assertion depend on a device the test never names.
 */
export function createSafeAreaContextMock(): Record<string, unknown> {
  const insets = { top: 0, left: 0, right: 0, bottom: 0 };
  const frame = { x: 0, y: 0, width: 390, height: 844 };

  return {
    // A non-null default matters: `SafeAreaProviderCompat` reads this context and only mounts a
    // provider when it finds nothing, so a default of `null` would pull the real provider back in.
    SafeAreaInsetsContext: createContext(insets),
    SafeAreaFrameContext: createContext(frame),
    initialWindowMetrics: { insets, frame },
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
    SafeAreaView: ({ children }: { children: ReactNode }) => children,
  };
}

export interface DomRender {
  /** The element the tree was rendered into. */
  readonly host: HTMLElement;
  /** Everything the user can read, for content assertions. */
  readonly text: () => string;
  /** Re-render with a different tree — how a boot-phase change is exercised. */
  readonly rerender: (next: ReactNode) => Promise<void>;
  readonly unmount: () => Promise<void>;
}

export async function renderToDom(element: ReactNode): Promise<DomRender> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  const draw = async (tree: ReactNode): Promise<void> => {
    // Async `act`, so effects and the passive-effect pass both flush before the assertion —
    // `useSyncExternalStore` subscribes in an effect, and a synchronous act would assert before it.
    await act(async () => {
      root.render(tree);
    });
  };

  await draw(element);

  return {
    host,
    text: () => host.textContent ?? '',
    rerender: draw,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}
