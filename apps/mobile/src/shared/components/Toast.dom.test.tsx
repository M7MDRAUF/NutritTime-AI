import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { getByRole } from '@testing-library/dom';
import { asRendered, element, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { Toast } from './Toast.js';
import type { StatusTone } from './StatusMessage.js';

const light = buildComponentTokens(lightColors);
const dark = buildComponentTokens(darkColors);

const TONES: readonly StatusTone[] = ['info', 'success', 'warning', 'danger'];

/**
 * `act` is imported from React rather than taken from `testHarness.js`, which exports `render`,
 * `element`, `press` and `asRendered` and no timer helper. Advancing a fake clock has to be
 * wrapped so the state it flushes is applied before the assertion reads it, exactly as `press`
 * wraps a click.
 */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/**
 * WCAG 2.x relative luminance and contrast, recomputed here rather than imported.
 *
 * `contrast.test.ts` owns the theme-level assertions; this file measures what a RENDERED element
 * actually carries, which is a different claim. Duplicating twenty lines of arithmetic is the
 * cheaper of the two evils against exporting a helper from a test file.
 */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const digits = hex.replace('#', '');
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((character) => character + character)
            .join('')
        : digits;
    const channel = (index: number): number => {
      const value = Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing at all when it is not visible', () => {
    // Not "renders hidden": an invisible overlay that still exists would sit over the screen and
    // swallow touches at the bottom of every page in the app.
    const container = render(
      <Toast testID="t" message="Saved" visible={false} onDismiss={() => undefined} />,
    );
    expect(container.querySelector('[data-testid="t"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('does not expire when it is given no duration', () => {
    // No document fixes a dwell time and WCAG 2.2.1 treats "no time limit" as the baseline, so an
    // absent `durationMs` means the toast waits for the user. This is the assertion that fails if
    // a default is ever quietly introduced.
    let dismissals = 0;
    render(
      <Toast
        testID="t"
        message="Saved"
        visible
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );

    advance(60_000);
    expect(dismissals).toBe(0);
  });

  it('dismisses itself once the duration it was given has passed, and not before', () => {
    let dismissals = 0;
    render(
      <Toast
        testID="t"
        message="Saved"
        visible
        durationMs={4000}
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );

    advance(3999);
    expect(dismissals).toBe(0);

    advance(1);
    expect(dismissals).toBe(1);

    // And it does not keep firing: the timeout is a timeout, not an interval.
    advance(20_000);
    expect(dismissals).toBe(1);
  });

  it('starts no timer while it is invisible', () => {
    // A toast mounted hidden with a duration must not dismiss itself before it has been seen.
    let dismissals = 0;
    render(
      <Toast
        testID="t"
        message="Saved"
        visible={false}
        durationMs={1000}
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );

    advance(10_000);
    expect(dismissals).toBe(0);
  });

  it('dismisses on the dismiss control', () => {
    let dismissals = 0;
    const container = render(
      <Toast
        testID="t"
        message="Saved"
        visible
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Dismiss' }));
    expect(dismissals).toBe(1);
  });

  it('fires the action without dismissing, and renders none when half of it is missing', () => {
    // The two are separate: undoing something is not the same event as closing the message, and
    // a toast that vanished on the action would take its own confirmation with it.
    let actions = 0;
    let dismissals = 0;
    const container = render(
      <Toast
        testID="t"
        message="Meal removed"
        visible
        actionLabel="Undo"
        onAction={() => {
          actions += 1;
        }}
        onDismiss={() => {
          dismissals += 1;
        }}
      />,
    );

    press(getByRole(container, 'button', { name: 'Undo' }));
    expect(actions).toBe(1);
    expect(dismissals).toBe(0);

    const labelOnly = render(
      <Toast
        testID="t"
        message="Meal removed"
        visible
        actionLabel="Undo"
        onDismiss={() => undefined}
      />,
    );
    expect(labelOnly.querySelectorAll('[role="button"]').length).toBe(1);
  });

  it('builds both controls to the touch target on both axes', () => {
    // PRD 10.5 (2.1.0) via X-05: 48 is the single build-to value. `IconButton` could not be used
    // here (see the file header), so the boxes are asserted directly rather than inherited.
    const container = render(
      <Toast
        testID="t"
        message="Meal removed"
        visible
        actionLabel="Undo"
        onAction={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    for (const name of ['Undo', 'Dismiss']) {
      const control = getByRole(container, 'button', { name });
      expect(control.style.minHeight).toBe(`${String(light.button.minHeight)}px`);
      expect(control.style.minWidth).toBe(`${String(light.button.minHeight)}px`);
    }
  });

  /**
   * The tone colour, and the contrast it has to clear, measured HERE rather than trusted.
   *
   * The first version of this test asserted the opposite - that none of the four `toast.tone*`
   * tokens reached the DOM - because at the time all eight pairings were between 1.49:1 and
   * 2.76:1 against `toast.background`, under WCAG 1.4.11's 3:1 for a non-text indicator. Those
   * tokens were `status.*`, authored against `surface.canvas`, which is `surface.inverse`'s
   * opposite in both schemes.
   *
   * `semantic.ts` now has `statusOnInverse` and the tokens are usable, so the component uses them.
   * This test re-measures the ratio from the colours that actually reached the DOM, so it cannot
   * pass on a token that was repaired in name only - and it runs in both schemes, because a
   * single-scheme assertion is how the original defect survived the theme's own suite.
   */
  const TONE_TOKENS = {
    info: 'toneInfo',
    success: 'toneSuccess',
    warning: 'toneWarning',
    danger: 'toneDanger',
  } as const;

  describe.each(['light', 'dark'] as const)('in %s', (mode) => {
    const tokens = mode === 'light' ? light : dark;

    it.each(TONES)('draws the %s tone in a colour that clears AA on the toast', (tone) => {
      const container = render(
        <Toast testID="t" message="Saved" visible tone={tone} onDismiss={() => undefined} />,
        mode,
      );
      const expected = tokens.toast[TONE_TOKENS[tone]];

      const colors = [...container.querySelectorAll('*')].map((node) =>
        node instanceof HTMLElement ? node.style.color : '',
      );
      expect(colors).toContain(asRendered(expected));

      // Re-derived from the rendered value. 4.5 rather than 1.4.11's 3.0: a tone glyph is a
      // non-text indicator and 3:1 would conform, but every repaired pairing clears 5.78:1, so
      // asserting the weaker bound would leave room for a regression that still passes.
      const ratio = contrastRatio(expected, tokens.toast.background);
      expect(
        ratio,
        `${tone} measures ${ratio.toFixed(2)}:1 on toast.background`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('gives the four tones four different glyphs', () => {
    // Otherwise the tone prop would be decoration: with the colour deliberately not carrying it,
    // the shape is the only carrier left, and four identical shapes carry nothing.
    const glyphs = TONES.map((tone) => {
      const container = render(
        <Toast testID="t" message="Saved" visible tone={tone} onDismiss={() => undefined} />,
      );
      const icon = container.querySelector('[aria-hidden="true"]');
      return icon instanceof HTMLElement ? icon.textContent : '';
    });

    expect(new Set(glyphs).size).toBe(TONES.length);
  });

  it('is a polite live region, not an alert', () => {
    const bar = element(
      render(<Toast testID="t" message="Saved" visible onDismiss={() => undefined} />),
      't',
    );

    expect(bar.getAttribute('aria-live')).toBe('polite');
    expect(bar.getAttribute('role')).not.toBe('alert');
  });

  it('renders the "what still works" sentence when it is given one', () => {
    // TSD 6.7's table omits `stillAvailable` from this one row while the same section's prose and
    // Plan 17's own T-12-05 row both require it on every state component. Accepted as optional.
    const bar = element(
      render(
        <Toast
          testID="t"
          message="Could not reach the assistant."
          stillAvailable="Explore and Saved still work."
          visible
          onDismiss={() => undefined}
        />,
      ),
      't',
    );

    expect(bar.textContent).toContain('Could not reach the assistant.');
    expect(bar.textContent).toContain('Explore and Saved still work.');
  });

  it('fills itself from its own token group in both schemes', () => {
    const inLight = element(
      render(<Toast testID="t" message="Saved" visible onDismiss={() => undefined} />),
      't',
    );
    const inDark = element(
      render(<Toast testID="t" message="Saved" visible onDismiss={() => undefined} />, 'dark'),
      't',
    );

    expect(inLight.style.backgroundColor).toBe(asRendered(light.toast.background));
    expect(inDark.style.backgroundColor).toBe(asRendered(dark.toast.background));
    expect(inLight.style.backgroundColor).not.toBe(inDark.style.backgroundColor);
  });

  it('marks the action with something other than a colour', () => {
    // `toast.actionText` IS `toast.text` by design - `component.ts` says so - so without a second
    // carrier the action would be indistinguishable from the message beside it (PRD 10.5).
    const container = render(
      <Toast
        testID="t"
        message="Meal removed"
        visible
        actionLabel="Undo"
        onAction={() => undefined}
        onDismiss={() => undefined}
      />,
    );
    const label = getByRole(container, 'button', { name: 'Undo' }).firstElementChild;
    if (!(label instanceof HTMLElement)) {
      throw new Error('no action label rendered');
    }

    expect(label.style.color).toBe(asRendered(light.toast.text));
    expect(label.style.textDecorationLine).toBe('underline');
  });

  it('grows at a 2x font scale instead of clipping', () => {
    const bar = element(
      render(<Toast testID="t" message="Saved" visible onDismiss={() => undefined} />, 'light', 2),
      't',
    );

    expect(bar.style.height).toBe('');
    expect(bar.style.maxHeight).toBe('');
  });
});
