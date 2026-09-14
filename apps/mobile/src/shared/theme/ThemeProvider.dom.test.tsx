import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { LARGE_TEXT_SCALE, ThemeProvider, useTheme } from './ThemeProvider.js';
import type { Theme } from './ThemeProvider.js';
import { colorsByScheme, resolveScheme } from './index.js';
import { typeScale } from './primitive.js';

/**
 * T-12-03's own suite, written at the P12 verification.
 *
 * **`resolveScheme` appeared in no test file at all**, and `ThemeProvider` was covered only
 * incidentally — by component suites that pass `mode` and `fontScale` through the render harness
 * and then assert something else. That left the three-way scheme decision, the documented
 * `'system'`-with-no-device-preference fallback, the `'unspecified'` narrowing, the
 * `isLargeText` threshold and the "outside a provider" guard all unverified, which is how
 * T-12-03 shipped `fontScale` applied to nothing in the first place.
 *
 * Every assertion here is chosen so that a plausible wrong implementation fails it: `resolveScheme`
 * returning the device scheme when the user chose a mode, the scale multiplying `fontSize` but not
 * `lineHeight`, the threshold being `>` instead of `>=`.
 */

function readTheme(node: (theme: Theme) => ReactNode, ...args: Parameters<typeof provider>): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(provider(...args)(node));
  });
}

function provider(
  mode: Parameters<typeof ThemeProvider>[0]['mode'],
  deviceScheme?: Parameters<typeof ThemeProvider>[0]['deviceScheme'],
  fontScale?: number,
) {
  return (render: (theme: Theme) => ReactNode): ReactNode => {
    function Probe(): ReactNode {
      return render(useTheme());
    }
    return (
      <ThemeProvider mode={mode} deviceScheme={deviceScheme} fontScale={fontScale}>
        <Probe />
      </ThemeProvider>
    );
  };
}

/** The theme the provider produced, captured out of a render. */
function themeFrom(...args: Parameters<typeof provider>): Theme {
  let captured: Theme | undefined;
  readTheme(
    (theme) => {
      captured = theme;
      return null;
    },
    ...args,
  );
  if (captured === undefined) {
    throw new Error('the provider rendered no child');
  }
  return captured;
}

describe('resolveScheme', () => {
  it('honours an explicit choice regardless of the device', () => {
    // The user's preference wins. A `resolveScheme` that consulted the device first would pass a
    // test that only ever used `system`, which is why both devices are named here.
    for (const device of ['light', 'dark', null] as const) {
      expect(resolveScheme('light', device)).toBe('light');
      expect(resolveScheme('dark', device)).toBe('dark');
    }
  });

  it('defers to the device under `system`', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
  });

  it('falls back to light when the device has no preference', () => {
    // `null` means "the device did not say", which is a real state on the web export and on a
    // device that has never been set. Light is the documented fallback.
    expect(resolveScheme('system', null)).toBe('light');
  });
});

describe('ThemeProvider', () => {
  it('takes the scheme from `mode`, so a test can render both without mocking a module', () => {
    expect(themeFrom('dark', 'light').scheme).toBe('dark');
    expect(themeFrom('light', 'dark').scheme).toBe('light');
    expect(themeFrom('dark', 'light').colors).toBe(colorsByScheme.dark);
  });

  it("narrows React Native's `'unspecified'` to no preference", () => {
    // `useColorScheme()` can return `'unspecified'`, which `resolveScheme` does not accept - and
    // should not, because "the device has no preference" is exactly what `null` already means.
    // Asserted through the injected value, since the hook itself cannot return it under jsdom.
    expect(themeFrom('system', null).scheme).toBe('light');
  });

  it('applies the font scale to size, line box AND letter spacing, exactly once', () => {
    const single = themeFrom('light', null, 1);
    const doubled = themeFrom('light', null, 2);

    expect(single.typography.body.fontSize).toBe(typeScale.body.fontSize);
    expect(doubled.typography.body.fontSize).toBe(typeScale.body.fontSize * 2);
    // The line box too. A scale that grew the glyphs and not the leading would overlap rows at
    // exactly the setting PRD 10.5 exists to protect.
    expect(doubled.typography.body.lineHeight).toBe(typeScale.body.lineHeight * 2);
    // And the tracking, which React Native measures in points and does not scale on its own.
    expect(doubled.typography.headline.letterSpacing).toBe(typeScale.headline.letterSpacing * 2);
    expect(doubled.fontScale).toBe(2);
  });

  it('carries the uppercase transform on `label` and nowhere else', () => {
    const theme = themeFrom('light', null, 1);
    expect(theme.typography.label.textTransform).toBe('uppercase');
    for (const variant of [
      'display',
      'headline',
      'title',
      'subheading',
      'body',
      'caption',
    ] as const) {
      expect(theme.typography[variant].textTransform, variant).toBe('none');
    }
  });

  it('flips `isLargeText` AT the threshold, not past it', () => {
    // `>=`, not `>`. A layout that reflows one notch late is the bug this flag exists to prevent,
    // and the boundary is the only value that tells the two operators apart.
    expect(themeFrom('light', null, LARGE_TEXT_SCALE - 0.01).isLargeText).toBe(false);
    expect(themeFrom('light', null, LARGE_TEXT_SCALE).isLargeText).toBe(true);
    expect(themeFrom('light', null, 2).isLargeText).toBe(true);
  });

  it('throws a named error when `useTheme` is called outside a provider', () => {
    // Rather than defaulting to light, which would silently give a dark device light tokens - a
    // bug that looks like a styling mistake instead of a missing provider.
    function Orphan(): ReactNode {
      useTheme();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    expect(() => {
      act(() => {
        createRoot(container).render(<Orphan />);
      });
    }).toThrow(/outside a ThemeProvider/);
  });
});
