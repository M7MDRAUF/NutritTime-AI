/**
 * A REAL `localStorage` origin, driven to the states the web export can actually reach (D-01).
 *
 * `memoryDriver.ts` is the fake every other storage test uses, and it is the right fake for the
 * read path: it is async, it never throws unasked, and it lets a test name the failure it wants.
 * **None of that is true of `localStorage`**, which is the surface Plan 10.2's web-surface note and
 * P22 T-22-06 are about:
 *
 *  - `window.localStorage.setItem` is **synchronous**, and on a full origin it **throws
 *    synchronously** — a `DOMException` named `QuotaExceededError`;
 *  - the quota is shared by every key in the origin, so one oversized value makes every other
 *    key's next write fail too;
 *  - nothing in the `StorageDriver` contract says any of that, so the only way to know the storage
 *    layer survives it is to run the storage layer against it.
 *
 * So the helpers here do not simulate a quota. `exhaustOrigin` finds the real one by measurement
 * and leaves exactly the headroom the caller asks for, which is why a test built on it keeps
 * working if the quota figure changes: no test in this directory names a byte count.
 *
 * **Why measurement rather than the documented figure.** The environment's quota is an
 * implementation detail of whatever is hosting the test — jsdom's default and a browser's are
 * different numbers, and a browser's varies by profile and by disk. A hard-coded 5,000,000 would be
 * a fixture drawn from the same source as the thing under test (§6.3) and would silently stop
 * exhausting anything the day the host changed it, leaving every quota assertion vacuously green.
 */

/**
 * The filler's key. Deliberately outside the `@nutritime/` namespace: hydration reads seven named
 * keys and would have to be given a reason to ignore an eighth, and a filler that looked like app
 * data could be mistaken for it in a failure message.
 */
const FILLER_KEY = 'test-origin-filler';

/**
 * Above any plausible origin quota, so the search below brackets the real one from outside — and
 * small enough that the search's largest allocation is not itself the slow part of a test run.
 */
const SEARCH_CEILING = 16 * 1024 * 1024;

function storage(): Storage {
  // A plain `throw` rather than a non-null assertion: this file runs in whatever environment the
  // test file declared, and "there is no localStorage here" is a mistake worth naming.
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('no localStorage: this fixture needs a DOM environment');
  }
  return globalThis.localStorage;
}

/** Whether one write of this size fits right now. Leaves the filler holding whatever fit last. */
function fillerFits(length: number): boolean {
  try {
    storage().setItem(FILLER_KEY, 'x'.repeat(length));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fill the origin so that exactly `headroom` code units remain, and return the filler's length.
 *
 * Called AFTER the app's own keys are seeded, because the quota counts every key and value in the
 * origin: filling first and seeding second would find a different limit, and the seeds would be the
 * writes that failed rather than the one the test is about.
 *
 * **`headroom` is room to GROW, which is the only thing a quota refuses.** Storage's `setItem`
 * returns early when the new value equals the old one, before any quota check, and the check itself
 * compares the origin's *new total* against the quota — so on an origin with zero headroom a
 * replacement of the same length still succeeds, and only a write that makes the origin bigger is
 * refused. A test that expects a refusal must therefore write something LONGER than what the key
 * already holds; two drafts of the `recordLaunch` case here passed while proving nothing because an
 * ISO instant is the same number of characters as the instant it replaced.
 *
 * `headroom` of 0 is the precise condition Plan's R-51 and R-53 rows call "a quota-exhausted
 * `localStorage` origin".
 */
export function exhaustOrigin(headroom = 0): number {
  storage().removeItem(FILLER_KEY);
  // Binary search on "does a filler of this length fit". Each probe REPLACES the filler, and a
  // replacement is measured against the origin without the filler's old value, so the probes are
  // independent of each other rather than cumulative.
  let low = 0;
  let high = SEARCH_CEILING;
  if (fillerFits(high)) {
    throw new Error('the origin accepted the search ceiling: it has no quota to exhaust');
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fillerFits(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const length = Math.max(0, low - headroom);
  storage().setItem(FILLER_KEY, 'x'.repeat(length));
  return length;
}

/** Give the origin its space back. Safe to call when nothing was filled. */
export function releaseOrigin(): void {
  storage().removeItem(FILLER_KEY);
}

/** Everything in the origin except the filler — the app's own view of the device. */
export function originKeys(): readonly string[] {
  const store = storage();
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && key !== FILLER_KEY) {
      keys.push(key);
    }
  }
  return keys;
}

/** Wipe the origin, filler included. The `beforeEach` of every test file that uses this fixture. */
export function resetOrigin(): void {
  storage().clear();
}
