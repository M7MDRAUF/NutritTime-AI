/**
 * R-50's test, and the thing it has to do is **throw for real**.
 *
 * `Boom` throws from its own render function; nothing here calls `componentDidCatch` or
 * `getDerivedStateFromError`. Failure shape 1 is "a test that reads a file cannot test the file's
 * behaviour", and its sibling is a test that invokes the handler instead of triggering it: a
 * boundary whose `getDerivedStateFromError` had been deleted would pass a suite that called
 * `componentDidCatch` by hand while the app went back to a white page. **The control that makes the
 * file mean anything is `without a boundary`** — same component, same throw, nothing to catch it.
 * React empties the host and the error leaves the root, which is the state R-50 describes measured
 * beside the state that replaces it, so no single constant satisfies both halves (BRIEF §6.2).
 *
 * **React's dev-time `console.error` is displaced, not silenced.** React 19 logs every caught error
 * through `defaultOnCaughtError`, which `createRoot` uses only when the caller supplies nothing -
 * `react-dom` 19.2.3, `cjs/react-dom-client.development.js:28038`:
 * `void 0 !== options.onCaughtError && (onCaughtError = options.onCaughtError)`. `mount` passes its
 * own, so a `console.error` spy sees the boundary's line and nothing else, and nothing is stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { getByRole, queryByTestId } from '@testing-library/dom';
import { Text } from 'react-native';
import { ThemeProvider } from '../shared/theme/ThemeProvider.js';
import { ErrorBoundary } from './ErrorBoundary.js';

/**
 * The payload an exception message can carry, as the worst honest case. R-50's row records the one
 * reachable instance P14 found — "an unparseable meal time in `mealPeriodForDate`, called during
 * render" — and such an error quotes the value it could not parse; these stores hold meal times,
 * allergy lists and a name (PRD §10.3, TSD §5.8). So the assertions search for the message's parts
 * as well as the whole: a line carrying half a name is the same defect.
 */
const PAYLOAD = 'peanut, tree-nut, Maryam Nasser';
const THROWN_MESSAGE = `could not parse 07:0x for ${PAYLOAD}`;
const ERROR_NAME = 'MealTimeParseError';
const FALLBACK = 'navigation-error-boundary';
const SUBTREE_TEXT = 'Home, Explore and Suggestions';

/** A box the child reads, so a retry can find it no longer throwing without a re-render above. */
interface Detonator {
  live: boolean;
  message: string;
}

function Boom({ detonator }: { readonly detonator: Detonator }): ReactNode {
  if (detonator.live) {
    const error = new Error(detonator.message);
    error.name = ERROR_NAME;
    throw error;
  }
  return <Text testID="subtree">{SUBTREE_TEXT}</Text>;
}

interface Mounted {
  readonly host: HTMLElement;
  readonly text: () => string;
  /** Errors React handed to a boundary. */
  readonly caught: readonly unknown[];
  /**
   * The error that escaped the mount — the R-50 state, and its signal. **Measured:** with no
   * boundary React does not route it to `onUncaughtError` here at all; it empties the host and
   * rethrows out of `act`. Held rather than left to fail the test, so it asserts both ways.
   */
  readonly escaped: unknown;
}

const hosts: HTMLElement[] = [];

async function mount(tree: ReactNode): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  const caught: unknown[] = [];
  const root = createRoot(host, {
    onCaughtError: (error: unknown) => {
      caught.push(error);
    },
    // Only to displace `defaultOnUncaughtError`, which writes React's own report to the console.
    onUncaughtError: () => undefined,
  });
  let escaped: unknown;
  try {
    // Async `act`: the commit phase, where `componentDidCatch` runs, flushes before an assertion.
    await act(async () => {
      root.render(
        <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
          {tree}
        </ThemeProvider>,
      );
    });
  } catch (error: unknown) {
    escaped = error;
  }
  return { host, text: () => host.textContent ?? '', caught, escaped };
}

/** Already-throwing child under the boundary. `seam: false` is the shipped path: the sink writes. */
async function mountFailed(
  options: { readonly seam?: boolean; readonly message?: string } = {},
): Promise<Mounted> {
  const child = <Boom detonator={{ live: true, message: options.message ?? THROWN_MESSAGE }} />;
  return options.seam === false
    ? mount(<ErrorBoundary>{child}</ErrorBoundary>)
    : mount(<ErrorBoundary onError={() => undefined}>{child}</ErrorBoundary>);
}

function retryButton(host: HTMLElement): HTMLElement {
  return getByRole(host, 'button', { name: 'Try again' });
}

async function pressRetry(host: HTMLElement): Promise<void> {
  await act(async () => {
    retryButton(host).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/**
 * TSD §5.7's denied phrases — its own sentence, copied verbatim and split on its commas — plus
 * CONTRACTS AMENDMENT 2's three PRD §7.3 extensions. The count and both ends are asserted below, so
 * a bad split cannot quietly shorten the list.
 *
 * **Transcribed because `deniedClaimIn` is unreachable from here:** `eslint.config.mjs`'s
 * `appEscape('server')` makes `apps/mobile` importing `apps/server` a lint error and BRIEF §2 makes
 * crossing it a stop condition. `assistantCopy.test.ts` set the precedent, and a fixture drawn from
 * `claimDenylist.ts` would come from the same source as the code it checks (BRIEF §6.3).
 *
 * **R-70 is why the sweep is over RENDERED TEXT and not a copy object.** A guard aimed at one
 * source of text does not cover another, and P20's CRITICAL was a server copy string reading
 * "allergen free" that failed 0 of 824 tests. A hand-written list makes every future sentence opt
 * in; `host.textContent` cannot be forgotten, and it covers what `ErrorState` supplies too.
 */
const DOCUMENTED_CLAIMS = `allergen free, allergy free, safe, unsafe, healthy, healthier,
healthiest, cures, treats, medically, doctor, doctors, prescribes, prescribed, you should eat, you
should avoid`
  .split(',')
  .map((phrase) => phrase.replace(/\s+/g, ' ').trim());

/** AMENDMENT 2: negation of `healthy`, inflection of `medically`, negation of the two multi-words. */
const PRD_EXTENSIONS = ['you should', 'medical', 'unhealthy'] as const;

const DENIED_CLAIMS: readonly string[] = [...DOCUMENTED_CLAIMS, ...PRD_EXTENSIONS];

function deniedClaimIn(text: string): string | undefined {
  // TSD §5.7's flattening rule: lowercase, non-alphanumeric → one space, wrapped in spaces.
  const squashed = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return DENIED_CLAIMS.find((claim) => ` ${squashed} `.includes(` ${claim} `));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) {
    host.remove();
  }
});

describe('the denied-claim matcher used below', () => {
  // Without this pair, "no denied claim" would pass with a matcher that never fires at all.
  it('fires on a claim, not inside a longer word, and not on a negation', () => {
    expect(DOCUMENTED_CLAIMS).toHaveLength(16);
    expect(DOCUMENTED_CLAIMS[0]).toBe('allergen free');
    expect(DOCUMENTED_CLAIMS[15]).toBe('you should avoid');
    expect(deniedClaimIn('This meal is allergen-free and safe.')).toBeDefined();
    expect(deniedClaimIn('Food safety, treatment and handling unsafely.')).toBeUndefined();
    expect(deniedClaimIn('This is not healthy.')).toBe('healthy');
  });
});

describe('ErrorBoundary', () => {
  it('renders its children untouched, and reports nothing, when nothing throws', async () => {
    const sink = vi.spyOn(console, 'error');
    const mounted = await mount(
      <ErrorBoundary>
        <Boom detonator={{ live: false, message: THROWN_MESSAGE }} />
      </ErrorBoundary>,
    );

    expect(mounted.text()).toContain(SUBTREE_TEXT);
    expect(queryByTestId(mounted.host, FALLBACK)).toBeNull();
    expect(mounted.caught).toEqual([]);
    expect(mounted.escaped).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();
  });

  // **R-50, measured, with no boundary in the tree** — the state the register row describes, and
  // the one the next test is measured against: an empty host, and no control to press.
  it('without a boundary, the same throw empties the tree — the state R-50 describes', async () => {
    const mounted = await mount(<Boom detonator={{ live: true, message: THROWN_MESSAGE }} />);

    expect(mounted.text()).toBe('');
    expect(mounted.host.childElementCount).toBe(0);
    // No boundary saw it, and it left the root: nothing in the app decided anything about it.
    expect(mounted.caught).toEqual([]);
    expect(mounted.escaped).not.toBeUndefined();
  });

  it('catches a throw during render, keeps a surface on screen, and drops the subtree', async () => {
    const mounted = await mountFailed();

    // The half that distinguishes this from the test above.
    expect(mounted.text()).not.toBe('');
    expect(mounted.escaped).toBeUndefined();
    expect(mounted.caught).toHaveLength(1);

    // The fallback, with the tree below it gone rather than half-drawn.
    expect(queryByTestId(mounted.host, FALLBACK)).not.toBeNull();
    expect(queryByTestId(mounted.host, 'subtree')).toBeNull();
    expect(mounted.text()).not.toContain(SUBTREE_TEXT);
    // And the way out is a real control, not a sentence about one.
    expect(retryButton(mounted.host)).toBeInstanceOf(HTMLElement);
  });

  /**
   * **PRD §12's middle clause, which is what R-50 is actually about:** "what happened, what still
   * works, and what to do next". A bare apology and a blank screen are the same artefact to the
   * reader, so the assertion is not "some copy rendered" but "the still-works note rendered, with a
   * sentence in it, and `ErrorState`'s default title did not stand in".
   */
  it('says what still works, not just that something went wrong', async () => {
    const mounted = await mountFailed();

    const note = queryByTestId(mounted.host, `${FALLBACK}-still-available`);
    expect(note).not.toBeNull();
    expect((note?.textContent ?? '').trim().length).toBeGreaterThan(40);
    expect(mounted.text()).not.toContain('Something went wrong');
    // Named because they are what a reader has lost sight of, and none of it is lost.
    for (const survivor of ['meals you kept', 'recipes', 'setup']) {
      expect(note?.textContent ?? '').toContain(survivor);
    }
  });

  it('offers a way out: the retry remounts the subtree and recovers', async () => {
    const detonator: Detonator = { live: true, message: THROWN_MESSAGE };
    const mounted = await mount(
      <ErrorBoundary onError={() => undefined}>
        <Boom detonator={detonator} />
      </ErrorBoundary>,
    );
    expect(queryByTestId(mounted.host, FALLBACK)).not.toBeNull();

    // The child stops throwing, the way a store that has since been written would.
    detonator.live = false;
    await pressRetry(mounted.host);

    expect(queryByTestId(mounted.host, 'subtree')).not.toBeNull();
    expect(mounted.text()).toContain(SUBTREE_TEXT);
    expect(queryByTestId(mounted.host, FALLBACK)).toBeNull();
    expect(mounted.escaped).toBeUndefined();
  });

  // What the retry cannot recover, and the pair matters: a boundary that never cleared its flag
  // passes this half, one that cleared it then unmounted on the second throw passes the half above.
  it('returns to the fallback on a deterministic throw, and still does not unmount', async () => {
    const mounted = await mountFailed();

    await pressRetry(mounted.host);

    expect(queryByTestId(mounted.host, FALLBACK)).not.toBeNull();
    expect(mounted.caught).toHaveLength(2);
    expect(mounted.escaped).toBeUndefined();
    expect(mounted.text()).not.toBe('');
  });

  /**
   * **The privacy requirement, over the DEFAULT sink** — no `onError`, so this is the shipped path.
   * TSD §5.8 closes what a line may carry; PRD §10.3 is the requirement behind it. The
   * name-and-frames half is asserted alongside, because "the message is absent" is satisfied by a
   * sink that writes nothing — which would leave R-50's one reachable instance undiagnosable.
   */
  it("logs the error's name and its frames, and never a word of its message", async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mountFailed({ seam: false });

    expect(sink).toHaveBeenCalledTimes(1);
    const written = sink.mock.calls.map((call) => call.join(' ')).join('\n');

    expect(written).not.toContain(THROWN_MESSAGE);
    for (const part of ['peanut', 'tree-nut', 'Maryam', 'Nasser', '07:0x', 'could not parse']) {
      expect(written).not.toContain(part);
    }

    // The control: the line is real, it is the shape `errorLogLine` writes, and it is diagnosable.
    const line = JSON.parse(written) as { readonly frames: readonly string[] };
    expect(line).toMatchObject({
      level: 'error',
      message: 'unhandled render error',
      errorName: ERROR_NAME,
    });
    expect(Array.isArray(line.frames)).toBe(true);
    expect(line.frames.length).toBeGreaterThan(0);
    for (const frame of line.frames) {
      expect(frame.startsWith('at ')).toBe(true);
    }
  });

  /**
   * The residual in `apps/server/src/logging.ts`'s `framesOf`, closed on this side: it keeps every
   * line matching `/^\s+at\s/` and relies on the stack's header not matching, so a message
   * containing a newline and an indented `at …` line survives it. The payload here is written
   * *into the message* in frame shape. That file is spine, so the residual is reported, not edited.
   */
  it('drops a frame-shaped line that came out of the message', async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await mountFailed({ seam: false, message: `bad value\n    at Allergies (${PAYLOAD})` });

    const written = sink.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(written).not.toContain('peanut');
    expect(written).not.toContain('Allergies');
    expect(written).not.toContain('bad value');
    // Still diagnosable: the real frames survived the extra filter.
    expect(written).toContain(ERROR_NAME);
    expect(
      (JSON.parse(written) as { readonly frames: readonly string[] }).frames.length,
    ).toBeGreaterThan(0);
  });

  it('hands the throw to the test seam instead of the sink, and writes no line', async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: Error[] = [];
    await mount(
      <ErrorBoundary
        onError={(error) => {
          seen.push(error);
        }}
      >
        <Boom detonator={{ live: true, message: THROWN_MESSAGE }} />
      </ErrorBoundary>,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe(ERROR_NAME);
    expect(sink).not.toHaveBeenCalled();
  });

  it('makes no safety, health or medical claim, and carries no digit, in what it renders', async () => {
    const rendered = (await mountFailed()).text();

    expect(deniedClaimIn(rendered)).toBeUndefined();
    // No digit either, the discipline `chatCopy.ts` and `assistantCopy.ts` hold their copy to: a
    // figure in fixed copy is one nobody grounded, and here it would be one read off a throw.
    expect(rendered).not.toMatch(/\d/);
    // Paired with a presence assertion, so an empty fallback could not pass either sweep vacuously.
    expect(rendered.trim().length).toBeGreaterThan(200);
  });
});
