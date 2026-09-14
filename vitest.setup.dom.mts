/**
 * Setup for the `dom` Vitest project (P12).
 *
 * `vitest.config.mts` reserved this file from P01 and deliberately did not reference it until
 * there was a React environment to prepare. That is now.
 *
 * Two shims, and each is here because it is unavoidable rather than convenient:
 *
 *  1. **`IS_REACT_ACT_ENVIRONMENT`.** Without it every `act()` call logs "The current testing
 *     environment is not configured to support act(...)" to stderr while the test still PASSES -
 *     the worst combination, because a green run buries the warning and the first person to read
 *     it assumes it is noise.
 *  2. **`ResizeObserver`.** `@react-navigation/elements` measures its frame with one and jsdom has
 *     no implementation, so a navigator throws before it renders. A no-op is correct rather than
 *     lazy: the jsdom viewport is fixed for the life of a test, so there is no resize to report.
 *
 * **What is deliberately NOT here: the `react-native-safe-area-context` mock.** It lives in
 * `apps/mobile/src/navigation/testHarness.tsx` and is opted into per file. A `vi.mock` in a setup
 * file applies to every dom test in the workspace, which would silently replace a real module for
 * suites that never asked - and a component that needs insets should take them as a prop, the way
 * `ThemeProvider` takes `mode` and `RootNavigator` takes `phase`, rather than be testable only
 * through a global mock.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

class NoopResizeObserver {
  observe(): void {
    // Nothing is measured: the jsdom viewport is fixed for the life of a test.
  }
  unobserve(): void {
    // Same.
  }
  disconnect(): void {
    // Same.
  }
}

const globals: { ResizeObserver?: unknown } = globalThis;
globals.ResizeObserver ??= NoopResizeObserver;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
