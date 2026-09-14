/**
 * The in-page instrument the P25 browser measurements share (T-25-01, T-25-02, T-25-03).
 *
 * **Why the page stamps its own boundaries instead of `Date.now()` around a Playwright
 * assertion.** `await expect(locator).toBeVisible()` polls, so a figure taken around it carries
 * the harness's poll interval as though it were the app's latency. That is tolerable against a
 * 2500 ms budget and fatal against a 150 ms one — and using two different instruments for two
 * rows of one SLO table makes the table unreadable. Every boundary below is stamped inside the
 * page by an event listener or a `MutationObserver`; Playwright only reads the numbers afterwards,
 * so its polling sits outside the measured interval.
 *
 * **`busyWaitMs` is the sensitivity probe, and it is why it lives in production-shaped code
 * rather than in a spec.** BRIEF §6.1's probe rule applies to a measurement harness: if the app
 * got twice as slow, would the harness report it? A timing harness that prints a constant is the
 * performance lane's version of a test that cannot fail. The stall is injected at load time
 * (§6.1i) through `addInitScript`, so no repository file is ever opened for writing.
 *
 * Nothing under `e2e/specs/**` imports this. The perf lane is separate on purpose: a measurement
 * run must not be able to change what the acceptance suite asserts.
 */

import type { Page } from '@playwright/test';

/** One `fetch` the page made, with the interval it was in flight. */
export interface PerfFetchRecord {
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

/** The instrument's whole state. Mutable because the page writes to it. */
export interface PerfState {
  marks: Record<string, number>;
  /** The `data-testid` whose first painted frame the armed interaction is waiting for. */
  target: string | null;
  /** Injected stall, in ms, burned inside the stamped `pointerdown` handler. */
  busyWaitMs: number;
  fetches: PerfFetchRecord[];
  /**
   * Whether a row-content change is being watched for.
   *
   * A separate flag and not `mealsAtStart.length > 0`, because an interaction can legitimately
   * start from an EMPTY list and end with rows, or start with rows and end empty — and a detector
   * keyed on the snapshot being non-empty silently cannot see either. Exactly BRIEF §6.2's third
   * shape: a control that the mutation it exists to catch passes.
   */
  rowsArmed: boolean;
  /** `meal-*` test ids present when the interaction was armed, in document order. */
  mealsAtStart: string[];
}

declare global {
  interface Window {
    __nutritimePerf?: PerfState;
  }
}

/** Navigation and main-bundle timings, so a start figure can be split into its two halves. */
export interface NavigationTiming {
  readonly responseEnd: number;
  readonly domContentLoadedEventEnd: number;
  readonly loadEventEnd: number;
  readonly documentTransferBytes: number;
  /** When the largest script finished arriving. The app's own work starts after this. */
  readonly bundleResponseEnd: number;
  readonly bundleTransferBytes: number;
  readonly bundleDecodedBytes: number;
}

/**
 * The init script, installed before any app code runs.
 *
 * Self-contained by necessity: `addInitScript` serialises the function, so it may close over
 * nothing but its single argument.
 */
function instrumentScript(busyWaitMs: number): void {
  const state: PerfState = {
    marks: {},
    target: null,
    busyWaitMs,
    fetches: [],
    rowsArmed: false,
    mealsAtStart: [],
  };
  window.__nutritimePerf = state;

  /** First writer wins: a boundary is crossed once per armed interaction. */
  const mark = (name: string): void => {
    if (state.marks[name] === undefined) {
      state.marks[name] = performance.now();
    }
  };
  /** Last writer wins: used where the last of a burst is the boundary (the final keystroke). */
  const stamp = (name: string): void => {
    state.marks[name] = performance.now();
  };

  const shown = (target: string): boolean => {
    // A bare word is a test id; anything starting with `[` is a raw selector, which some
    // boundaries need because the test id carries a turn number the driver cannot know in
    // advance (`assistant-turn-<n>-unavailable`).
    const selector = target.startsWith('[') ? target : `[data-testid="${target}"]`;
    const element = document.querySelector(selector);
    // `getClientRects()` and not `offsetParent`: an inactive tab screen is hidden by a
    // `display: none` ANCESTOR, which empties the rect list but leaves the node in the document.
    // A boundary keyed on the node's presence would fire on the first visit and never again,
    // because a visited tab screen stays mounted.
    return element !== null && element.getClientRects().length > 0;
  };

  const mealIds = (): string[] =>
    Array.from(document.querySelectorAll('[data-testid^="meal-"]')).map(
      (node) => node.getAttribute('data-testid') ?? '',
    );

  const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((id, index) => id === right[index]);

  const check = (): void => {
    // T-25-01's boundary: three recommendation cards in the document. Keyed on the NODES and not
    // on their text, because `useFonts` loads four Inter faces and text can paint in the fallback
    // family first — a text-keyed boundary would be measuring font loading.
    if (document.querySelectorAll('[data-testid^="recommendation-"]').length >= 3) {
      mark('cards3');
    }
    const target = state.target;
    if (target !== null && state.marks['paint'] === undefined && shown(target)) {
      mark('dom');
      requestAnimationFrame(() => {
        mark('paint');
      });
    }
    if (state.rowsArmed && state.marks['rowsPaint'] === undefined) {
      if (!sameList(state.mealsAtStart, mealIds())) {
        mark('rowsDom');
        requestAnimationFrame(() => {
          mark('rowsPaint');
        });
      }
    }
  };

  new MutationObserver(check).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
  });

  // Capture phase, so t0 is stamped before any app handler can run. The stall is burned AFTER
  // the stamp, so an injected delay lands inside the measured interval rather than before it.
  document.addEventListener(
    'pointerdown',
    () => {
      stamp('t0');
      const until = performance.now() + state.busyWaitMs;
      while (performance.now() < until) {
        // Deliberate synchronous stall. Sensitivity probe only; zero by default.
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    () => {
      mark('keyFirst');
      stamp('keyLast');
    },
    true,
  );

  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const start = performance.now();
    try {
      return await originalFetch(input, init);
    } finally {
      state.fetches.push({ url, start, end: performance.now() });
    }
  };
}

/** Install the instrument. Call before the navigation that is to be measured. */
export async function installInstrument(page: Page, busyWaitMs = 0): Promise<void> {
  await page.addInitScript(instrumentScript, busyWaitMs);
}

/**
 * Clear the marks and arm the next interaction on one target.
 *
 * `target` is a test id, or a raw CSS selector when it starts with `[`.
 */
export async function armInteraction(page: Page, target: string | null): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__nutritimePerf;
    if (state === undefined) {
      throw new Error('perf instrument not installed');
    }
    state.marks = {};
    state.target = id;
    state.fetches = [];
    state.rowsArmed = false;
    state.mealsAtStart = [];
  }, target);
}

/** Arm a list-content change: snapshot the `meal-*` ids now, stamp when they differ. */
export async function armRowChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__nutritimePerf;
    if (state === undefined) {
      throw new Error('perf instrument not installed');
    }
    state.marks = {};
    state.target = null;
    state.fetches = [];
    state.mealsAtStart = Array.from(document.querySelectorAll('[data-testid^="meal-"]')).map(
      (node) => node.getAttribute('data-testid') ?? '',
    );
    state.rowsArmed = true;
  });
}

export async function readMarks(page: Page): Promise<Record<string, number>> {
  return await page.evaluate(() => ({ ...(window.__nutritimePerf?.marks ?? {}) }));
}

export async function readFetches(page: Page): Promise<PerfFetchRecord[]> {
  return await page.evaluate(() => [...(window.__nutritimePerf?.fetches ?? [])]);
}

/** Block until the page has stamped `name`. The wait is outside the measured interval. */
export async function waitForMark(page: Page, name: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (markName) => window.__nutritimePerf?.marks[markName] !== undefined,
    name,
    { timeout: timeoutMs },
  );
}

/** A mark that must be present. Absent is a harness failure, never a zero. */
export function requireMark(marks: Record<string, number>, name: string): number {
  const value = marks[name];
  if (value === undefined) {
    throw new Error(`perf mark '${name}' was never stamped`);
  }
  return value;
}

export async function readNavigationTiming(page: Page): Promise<NavigationTiming> {
  return await page.evaluate(() => {
    // Type predicates rather than `as`: `getEntriesByType` is typed `PerformanceEntry[]`, and an
    // assertion here would claim a shape the compiler cannot see (BRIEF §4). The predicate checks
    // the discriminant the spec guarantees plus one field of the wider interface.
    const isNavigation = (entry: PerformanceEntry): entry is PerformanceNavigationTiming =>
      entry.entryType === 'navigation' && 'responseEnd' in entry;
    const isResource = (entry: PerformanceEntry): entry is PerformanceResourceTiming =>
      entry.entryType === 'resource' && 'decodedBodySize' in entry;

    const nav = performance.getEntriesByType('navigation').find(isNavigation);
    const scripts = performance
      .getEntriesByType('resource')
      .filter(isResource)
      .filter((entry) => entry.initiatorType === 'script');
    let bundle: PerformanceResourceTiming | undefined;
    for (const entry of scripts) {
      if (bundle === undefined || entry.decodedBodySize > bundle.decodedBodySize) {
        bundle = entry;
      }
    }
    return {
      responseEnd: nav?.responseEnd ?? 0,
      domContentLoadedEventEnd: nav?.domContentLoadedEventEnd ?? 0,
      loadEventEnd: nav?.loadEventEnd ?? 0,
      documentTransferBytes: nav?.transferSize ?? 0,
      bundleResponseEnd: bundle?.responseEnd ?? 0,
      bundleTransferBytes: bundle?.transferSize ?? 0,
      bundleDecodedBytes: bundle?.decodedBodySize ?? 0,
    };
  });
}
