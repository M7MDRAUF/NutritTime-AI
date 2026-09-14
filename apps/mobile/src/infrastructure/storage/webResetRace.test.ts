// @vitest-environment jsdom

/**
 * The two open risks Plan's register says "become live on a quota-exhausted `localStorage` origin"
 * — **R-51** (`createStore`'s queue latches on a write that never settles) and **R-53** (the full
 * reset's race is narrowed, not closed) — measured against real `localStorage`.
 *
 * **This file reports; it does not fix.** `createStore.tsx` is spine and `DataResetProvider` is
 * another slice's, so nothing here proposes a repair. What it does is turn both risk rows from a
 * prediction into a measurement, because both predictions rest on a property of the driver and the
 * web driver's property is the opposite of the one assumed:
 *
 *  - R-51 needs a write that **never settles**. `localStorage.setItem` is synchronous and the web
 *    implementation runs it inside a promise executor, so every write resolves or rejects in the
 *    same turn. There is no unsettled state to latch on.
 *  - R-53 needs a write **already awaiting** when the reset's final read-back completes. On this
 *    driver the bytes are on disk before `setItem` has handed back a promise, so a write that has
 *    started has already landed and the read-back sees it.
 *
 * **The assertions are made AFTER the in-flight write would have landed, never before.** P18's
 * verification found a confirmed "erase all data" leaving a diet and an allergy list on disk, and
 * the test that missed it asserted "the keys are gone" the instant the reset returned. Every
 * expectation below awaits the write it is racing first.
 *
 * The local `deferredWrites` wrapper is what makes the comparison a comparison: it is the same
 * repository over the same origin with the one property changed, so the outcomes below differ for
 * exactly one reason rather than for any of the differences between two whole drivers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserPreferences } from '@nutritime/contracts';
import { STORAGE_DEFINITIONS, STORAGE_KEYS } from './definitions.js';
import type { RepositoryRuntime, StorageDriver } from './repository.js';
import { createRepository, isStorageWriteError } from './repository.js';
import { asyncStorageDriver } from './asyncStorageDriver.js';
import { exhaustOrigin, releaseOrigin, resetOrigin } from './__fixtures__/localStorageOrigin.js';

const AT = '2026-09-14T10:00:00.000Z';
const PREFERENCES = STORAGE_KEYS.preferences;

const runtime: RepositoryRuntime = { driver: asyncStorageDriver, now: () => AT };

/** A profile with something in it worth losing — the payload P18's defect resurrected. */
function profile(allergies: readonly string[]): UserPreferences {
  return { ...STORAGE_DEFINITIONS.preferences.fallback(), allergies };
}

function raw(key: string): string | null {
  return window.localStorage.getItem(key);
}

/**
 * The same origin, reached through a driver whose `setItem` completes a turn LATER.
 *
 * This is native AsyncStorage's shape rather than the web driver's: a call that crosses a bridge
 * and settles on a later turn, so a write really can be pending while other code runs. Modelled
 * here — with one `await` and nothing else changed — so that the difference between the two results
 * below is attributable to that single property.
 */
function deferredWrites(): StorageDriver {
  return {
    getItem: (key) => asyncStorageDriver.getItem(key),
    removeItem: (key) => asyncStorageDriver.removeItem(key),
    multiGet: (keys) => asyncStorageDriver.multiGet(keys),
    async setItem(key, value) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      return asyncStorageDriver.setItem(key, value);
    },
  };
}

beforeEach(() => {
  resetOrigin();
});

afterEach(() => {
  releaseOrigin();
});

describe('R-53 — a write in flight across a clear', () => {
  it('on localStorage the write has ALREADY landed, so the clear removes it', async () => {
    const repository = createRepository(STORAGE_DEFINITIONS.preferences, runtime);

    // A write "in flight": started, deliberately not awaited — the state R-53 is about.
    const inFlight = repository.set(profile(['peanut']));
    await repository.clear();
    // **Awaited before the assertion.** Asserting here without it is the test that missed the
    // defect: the key is gone at this instant either way.
    await inFlight;

    expect(raw(PREFERENCES)).toBeNull();
  });

  it('with a DEFERRED write the same sequence leaves the profile on disk — R-53, reproduced', async () => {
    /**
     * The control that makes the result above a finding rather than a tautology. One property
     * changes — the write settles a turn later — and the confirmed erase leaves the user's allergy
     * list behind, written by a call nothing is watching any more. If this test ever passed
     * alongside the one above, neither would be telling us anything about ordering.
     */
    const repository = createRepository(STORAGE_DEFINITIONS.preferences, {
      driver: deferredWrites(),
      now: () => AT,
    });

    const inFlight = repository.set(profile(['peanut']));
    await repository.clear();
    await inFlight;

    const survivor = raw(PREFERENCES);
    expect(survivor).not.toBeNull();
    expect(survivor).toContain('peanut');
  });
});

describe('R-51 — a write that never settles', () => {
  it('cannot happen on localStorage: a refused write does not stop the next one', async () => {
    /**
     * R-51's cost is "changes stop persisting silently", and the mechanism is a queue whose
     * `inFlight` flag is never cleared because `repository.set` never settled. Measured at the
     * repository rather than at `createStore`, which is spine and cannot be rendered from this
     * project — see the report's COULD NOT VERIFY. What is measurable here is the premise: the
     * write settles, and the one after it lands.
     */
    const repository = createRepository(STORAGE_DEFINITIONS.preferences, runtime);
    await repository.set(STORAGE_DEFINITIONS.preferences.fallback());
    exhaustOrigin(0);

    const error = await repository.set(profile(['peanut'])).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isStorageWriteError(error) && error.reason).toBe('write-failed');

    releaseOrigin();
    await expect(repository.set(profile(['peanut']))).resolves.toBeUndefined();
    expect(raw(PREFERENCES)).toContain('peanut');
  });
});
