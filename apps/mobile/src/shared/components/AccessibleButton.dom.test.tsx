import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getByRole } from '@testing-library/dom';
import { asRendered, element, iconNamesIn, press, render } from './testHarness.js';
import { buildComponentTokens, darkColors, lightColors } from '../theme/index.js';
import { AccessibleButton } from './AccessibleButton.js';
import type { ButtonVariant } from './AccessibleButton.js';

/**
 * **The OS reduce-motion setting is supplied, not mocked** (T-23-06, BRIEF §6.3).
 *
 * `AccessibleButton` reads `AccessibilityInfo.isReduceMotionEnabled()` and its
 * `reduceMotionChanged` event; react-native-web 0.21.2 implements both over
 * `window.matchMedia('(prefers-reduced-motion: reduce)')`, captured ONCE at module load
 * (`react-native-web/src/exports/AccessibilityInfo/index.js:20-23`). So the query must exist before
 * the imports below are evaluated, which is what `vi.hoisted` is for. Defining the media query is
 * what Playwright's `emulateMedia({ reducedMotion })` does for the e2e projects too, and is why
 * nothing here calls `vi.mock`.
 *
 * **jsdom 30.0.1 implements no `matchMedia` at all** (`typeof window.matchMedia === 'undefined'`,
 * measured). Without this block react-native-web fail-closes `isReduceMotionEnabled()` to `true`
 * (index.js:28), so every assertion below would be the reduced one and the motion direction would
 * be untestable - BRIEF §6.1k's inert mutation, in the exact form the brief warned of here.
 *
 * **It answers per query and implements both listener APIs, because two modules share it.**
 * `Appearance` also calls `matchMedia` at load, for `(prefers-color-scheme: dark)` over the legacy
 * `addListener` (`Appearance/index.js:26,50`): one object answering every query with the
 * reduce-motion value makes `useColorScheme()` report dark, and one without `addListener` throws
 * `query.addListener is not a function` from its mount effect - which is how this was found.
 * `matches` is read per call, so flipping it between renders is enough, and `change` listeners are
 * recorded so `announce` can drive the live-update path.
 */
const media = vi.hoisted(() => {
  type Listener = (event: { matches: boolean }) => void;
  const REDUCE_MOTION = '(prefers-reduced-motion: reduce)';
  const listeners: Listener[] = [];
  const state = { matches: false };

  function makeList(query: string): unknown {
    const mine = query === REDUCE_MOTION;
    const add = (listener: Listener): void => {
      if (mine) {
        listeners.push(listener);
      }
    };
    const drop = (listener: Listener): void => {
      const at = listeners.indexOf(listener);
      if (at >= 0) {
        listeners.splice(at, 1);
      }
    };
    return {
      get matches(): boolean {
        return mine ? state.matches : false;
      },
      media: query,
      addEventListener: (_type: string, listener: Listener): void => add(listener),
      removeEventListener: (_type: string, listener: Listener): void => drop(listener),
      addListener: add,
      removeListener: drop,
    };
  }

  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => makeList(query),
  });

  return {
    /** What the OS says right now. */
    set(reduce: boolean): void {
      state.matches = reduce;
    },
    /** What the OS says when the user changes it while the app is open. */
    announce(reduce: boolean): void {
      state.matches = reduce;
      for (const listener of [...listeners]) {
        listener({ matches: reduce });
      }
    },
  };
});

const light = buildComponentTokens(lightColors).button;
const dark = buildComponentTokens(darkColors).button;
const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'ghost', 'destructive'];

/** The still mark the reduced path draws, by the vendor name `Icon` asks for. */
const BUSY_MARK = 'clock-outline';

function noop(): void {
  // A press handler the test does not care about.
}

/**
 * Render, then let the platform read settle: `isReduceMotionEnabled()` is a promise, so its value
 * reaches the render one microtask after mount. Every test goes through here rather than `render`
 * directly, so no resolution lands outside an `act()` scope and becomes stderr noise in the NEXT
 * test (BRIEF §6.2 shape 4).
 */
async function mount(...args: Parameters<typeof render>): Promise<HTMLElement> {
  const container = render(...args);
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function spinnersIn(container: HTMLElement): number {
  return container.querySelectorAll('[role="progressbar"]').length;
}

describe('AccessibleButton', () => {
  it('meets the build-to touch target on both axes', async () => {
    const button = element(
      await mount(<AccessibleButton testID="b" label="Save" onPress={noop} />),
      'b',
    );

    expect(button.style.minHeight).toBe(`${String(light.minHeight)}px`);
    expect(button.style.minWidth).toBe(`${String(light.minHeight)}px`);
  });

  it.each(VARIANTS)('fills the %s variant from its own token, in both schemes', async (variant) => {
    const inLight = element(
      await mount(<AccessibleButton testID="b" label="Save" variant={variant} onPress={noop} />),
      'b',
    );
    const inDark = element(
      await mount(
        <AccessibleButton testID="b" label="Save" variant={variant} onPress={noop} />,
        'dark',
      ),
      'b',
    );

    expect(globalThis.getComputedStyle(inLight).backgroundColor).toBe(
      asRendered(light[variant].background),
    );
    expect(globalThis.getComputedStyle(inDark).backgroundColor).toBe(
      asRendered(dark[variant].background),
    );
  });

  it('does not fire when disabled', async () => {
    let presses = 0;
    const button = element(
      await mount(
        <AccessibleButton
          testID="b"
          label="Save"
          disabled
          onPress={() => {
            presses += 1;
          }}
        />,
      ),
      'b',
    );

    press(button);
    expect(presses).toBe(0);
  });

  it('does not fire while loading, and says it is busy rather than broken', async () => {
    // The press already happened. A second one would submit twice, and a disabled-looking button
    // with no explanation is indistinguishable from a dead one - hence `busy`.
    let presses = 0;
    const container = await mount(
      <AccessibleButton
        testID="b"
        label="Save"
        loading
        onPress={() => {
          presses += 1;
        }}
      />,
    );

    press(element(container, 'b'));
    expect(presses).toBe(0);
    expect(getByRole(container, 'button', { name: 'Save' }).getAttribute('aria-busy')).toBe('true');
  });

  it('fires when it is neither disabled nor loading', async () => {
    let presses = 0;
    press(
      element(
        await mount(
          <AccessibleButton
            testID="b"
            label="Save"
            onPress={() => {
              presses += 1;
            }}
          />,
        ),
        'b',
      ),
    );
    expect(presses).toBe(1);
  });

  it('keeps its label as the accessible name, and lets one be given', async () => {
    const plain = await mount(<AccessibleButton testID="b" label="Save" onPress={noop} />);
    expect(getByRole(plain, 'button', { name: 'Save' })).toBeTruthy();

    const labelled = await mount(
      <AccessibleButton
        testID="b"
        label="Save"
        accessibilityLabel="Save this meal"
        onPress={noop}
      />,
    );
    expect(getByRole(labelled, 'button', { name: 'Save this meal' })).toBeTruthy();
  });

  it('keeps the label visible while loading', async () => {
    // A spinner that replaces the text takes the accessible name away at the exact moment the
    // user is waiting on it.
    const container = await mount(
      <AccessibleButton testID="b" label="Save" loading icon="check" onPress={noop} />,
    );
    expect(element(container, 'b').textContent).toContain('Save');
  });

  it('becomes a column at a large text scale, and never fixes a height', async () => {
    const large = element(
      await mount(
        <AccessibleButton testID="b" label="Save" icon="check" onPress={noop} />,
        'light',
        2,
      ),
      'b',
    );

    expect(large.style.flexDirection).toBe('column');
    expect(large.style.height).toBe('');
    expect(large.style.minHeight).toBe(`${String(light.minHeight)}px`);
  });

  it('stretches only when asked to', async () => {
    const wide = element(
      await mount(<AccessibleButton testID="b" label="Save" fullWidth onPress={noop} />),
      'b',
    );
    const narrow = element(
      await mount(<AccessibleButton testID="b" label="Save" onPress={noop} />),
      'b',
    );

    expect(wide.style.alignSelf).toBe('stretch');
    expect(narrow.style.alignSelf).toBe('flex-start');
  });

  /**
   * **T-23-06 — reduced motion respected, asserted in BOTH directions in one test.**
   *
   * A single direction is worthless here, symmetrically: a component that ignored the setting and
   * always drew the still mark satisfies "reduced motion shows no spinner" while being a defect for
   * every user who did not ask for it, and one that always spun satisfies "the button shows
   * progress". So the spinner count and the mark count each have to be 1 in one direction and 0 in
   * the other, which no constant render can do (BRIEF §6.2 shape 2).
   *
   * The label and `aria-busy` are asserted in both, because whatever replaces the animation still
   * has to say "working": the `progressbar` role is gone on the reduced path and the announced
   * state must not be.
   */
  it('spins only when the OS has not asked for less motion, and marks the wait either way', async () => {
    media.set(false);
    const moving = await mount(<AccessibleButton testID="b" label="Ask" loading onPress={noop} />);

    media.set(true);
    const still = await mount(<AccessibleButton testID="b" label="Ask" loading onPress={noop} />);

    expect(spinnersIn(moving)).toBe(1);
    expect(iconNamesIn(moving)).not.toContain(BUSY_MARK);

    expect(spinnersIn(still)).toBe(0);
    expect(iconNamesIn(still)).toContain(BUSY_MARK);

    // Both still say "working", and say it the same way: the visible label, and the busy state a
    // screen reader hears. Neither is carried by the animation.
    for (const container of [moving, still]) {
      const button = getByRole(container, 'button', { name: 'Ask' });
      expect(button.getAttribute('aria-busy')).toBe('true');
      expect(button.textContent).toContain('Ask');
    }
  });

  /**
   * The wait reaches a terminal state on both paths.
   *
   * P21's record is a screen that found the right copy while a spinner sat on screen for ever, and
   * only a `progressbar` count caught it. The reduced path has no progressbar to count, so the
   * shared carrier is `aria-busy` - true and then false in both directions, which a stuck
   * indicator fails whichever way the setting is set.
   */
  it.each([
    { reduce: false, name: 'with motion' },
    { reduce: true, name: 'with reduced motion' },
  ])('clears the busy indicator when the work finishes, $name', async ({ reduce }) => {
    media.set(reduce);
    const busy = await mount(<AccessibleButton testID="b" label="Ask" loading onPress={noop} />);
    expect(getByRole(busy, 'button', { name: 'Ask' }).getAttribute('aria-busy')).toBe('true');
    expect(spinnersIn(busy) + iconNamesIn(busy).filter((n) => n === BUSY_MARK).length).toBe(1);

    const done = await mount(<AccessibleButton testID="b" label="Ask" onPress={noop} />);
    const button = getByRole(done, 'button', { name: 'Ask' });
    expect(button.getAttribute('aria-busy')).not.toBe('true');
    expect(spinnersIn(done)).toBe(0);
    expect(iconNamesIn(done)).not.toContain(BUSY_MARK);
  });

  /**
   * **The proof that the platform read actually runs** (BRIEF §6.1k).
   *
   * The tests above set `matches` before mounting, which a component reading the query once at
   * import time would also satisfy. This one changes the setting on an already-mounted button, so
   * it passes only if `AccessibilityInfo.addEventListener` was called AND its handler reaches
   * state - and it is what a user gets who turns the setting on mid-question, inside PRD §10.1's
   * "~11 s, hard timeout 30 s" window for this screen.
   */
  it('follows the setting changing while the button is already waiting', async () => {
    media.set(false);
    const container = await mount(
      <AccessibleButton testID="b" label="Ask" loading onPress={noop} />,
    );
    expect(spinnersIn(container)).toBe(1);

    await act(async () => {
      media.announce(true);
      await Promise.resolve();
    });

    expect(spinnersIn(container)).toBe(0);
    expect(iconNamesIn(container)).toContain(BUSY_MARK);

    // And back, so the assertion is not satisfied by a handler that only ever sets `true`.
    await act(async () => {
      media.announce(false);
      await Promise.resolve();
    });

    expect(spinnersIn(container)).toBe(1);
    expect(iconNamesIn(container)).not.toContain(BUSY_MARK);
  });
});
