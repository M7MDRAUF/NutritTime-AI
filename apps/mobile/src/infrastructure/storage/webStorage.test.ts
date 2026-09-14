// @vitest-environment jsdom

/**
 * Storage on the web surface: the bound semantics and the write failures, against **real
 * `localStorage`** (P22 T-22-06, TSD 6.4, Plan 10.2's web-surface note, D-01).
 *
 * **What this proves that `repository.test.ts` cannot.** That file drives `memoryDriver`, which is
 * async, never throws unasked, and has no quota. `localStorage` is the opposite of all three, and
 * Plan 10.2 says so in as many words — "Quota and eviction behaviour differ from native; P22
 * T-22-06 verifies bound refusal and quarantine on the web build specifically rather than assuming
 * parity". A green memory-driver test is not evidence about the surface D-01 makes first-class.
 *
 * **The driver here is the shipped one.** `asyncStorageDriver` is imported unmocked, and in a DOM
 * environment the storage package it wraps resolves to its web implementation, which is a
 * `window.localStorage` pass-through. That is the same module the Expo web export loads. The first
 * three tests below exist to prove exactly that rather than assume it: if this file were somehow
 * running against a fake, every quota assertion after it would be vacuous.
 *
 * **Two figures are hand-transcribed from TSD 6.4 rather than imported** (§6.1g): the bound, and
 * the two `StorageWriteFailure` values. Importing `STORAGE_BOUNDS` would pin this file against the
 * same module the behaviour comes from, so a drift in `definitions.ts` would move the expectation
 * with it. Transcribed, a drift fails here — which is the entire reason for having both.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QUARANTINE_KEY, encodeEnvelope } from './envelope.js';
import { STORAGE_BOUNDS, STORAGE_DEFINITIONS, STORAGE_KEYS } from './definitions.js';
import type { RepositoryRuntime } from './repository.js';
import { createRepository, isStorageWriteError, readEntry } from './repository.js';
import { asyncStorageDriver } from './asyncStorageDriver.js';
import { exhaustOrigin, releaseOrigin, resetOrigin } from './__fixtures__/localStorageOrigin.js';

/** TSD 6.4: `STORAGE_BOUNDS = { favorites: 200, customMeals: 200 }`. Transcribed, not imported. */
const TSD_BOUND = 200;
/** TSD 6.4: `StorageWriteFailure = 'write-failed' | 'bound-exceeded'`. Exactly these two. */
const TSD_WRITE_FAILURES = ['bound-exceeded', 'write-failed'] as const;
/** `repository.ts`'s fixed local copy for each. A user never sees a driver string (PRD 12). */
const REFUSAL_MESSAGE = 'That list is full.';
const FAILURE_MESSAGE = 'That change could not be saved.';

const AT = '2026-09-14T09:00:00.000Z';
const FAVORITES = STORAGE_KEYS.favorites;
const PREFERENCES = STORAGE_KEYS.preferences;

const runtime: RepositoryRuntime = { driver: asyncStorageDriver, now: () => AT };

function favoritesRepository(): ReturnType<typeof createRepository<readonly string[]>> {
  return createRepository(STORAGE_DEFINITIONS.favorites, runtime);
}

/** `n` distinct ids. Distinct so a truncation keeps an identifiable prefix rather than a count. */
function ids(n: number): readonly string[] {
  return Array.from({ length: n }, (_unused, index) => `meal-${String(index)}`);
}

/** Read one key straight out of the origin — never through the driver under test. */
function raw(key: string): string | null {
  return window.localStorage.getItem(key);
}

/** Seed a key the way a previous launch would have left it, bypassing the write path entirely. */
function seed(key: string, value: unknown): void {
  window.localStorage.setItem(key, encodeEnvelope(1, value, AT));
}

/**
 * A parsed envelope with its field set pinned, or a throw.
 *
 * Throws rather than returning `null` on a non-envelope: a key that does not hold TSD 6.4's three
 * fields is one hydration quarantines at the next launch, and it has to fail a test loudly rather
 * than read as an absent value.
 */
function envelopeOf(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${String(parsed)} is not an envelope`);
  }
  const record: Readonly<Record<string, unknown>> = { ...parsed };
  expect(Object.keys(record).sort()).toEqual(['schemaVersion', 'updatedAt', 'value']);
  return record;
}

async function refusalFrom(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('the write resolved; this test needs it to be refused');
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  resetOrigin();
});

afterEach(() => {
  releaseOrigin();
});

describe('the driver the web export actually loads', () => {
  it('is backed by window.localStorage in both directions', async () => {
    // **The anti-vacuity control for this whole file.** A fake driver would pass every quota test
    // below by never having a quota, so the seam is proved to be the real one first.
    await asyncStorageDriver.setItem('@probe/out', 'written-through');
    expect(raw('@probe/out')).toBe('written-through');

    window.localStorage.setItem('@probe/in', 'read-through');
    await expect(asyncStorageDriver.getItem('@probe/in')).resolves.toBe('read-through');

    await asyncStorageDriver.removeItem('@probe/out');
    expect(raw('@probe/out')).toBeNull();
  });

  it('has already stored the bytes before its promise is awaited', () => {
    /**
     * **The measurement R-53 turns on.** `localStorage.setItem` is synchronous, and the web
     * implementation calls it inside a promise executor — which runs synchronously — so by the time
     * `setItem` has returned a promise at all, the write has landed. A write cannot be "in flight"
     * on this driver in the sense R-53 describes, and that is a fact about the platform rather than
     * about the app. Recorded here because R-53's remaining gap is stated as "a write already
     * awaiting when the final read-back completes".
     */
    const settling = asyncStorageDriver.setItem('@probe/sync', 'landed');
    expect(raw('@probe/sync')).toBe('landed');
    return settling;
  });

  it('SETTLES a refused write rather than hanging, on a full origin', async () => {
    /**
     * **The measurement R-51 turns on.** R-51 is a latch: `createStore`'s queue leaves `inFlight`
     * true forever if `repository.set` neither resolves nor rejects, and Plan's row says a
     * quota-exhausted `localStorage` origin is where that becomes certain. It is the opposite — the
     * web implementation wraps a synchronous throw into a REJECTION, so the queue's `finally`
     * always runs. Raced against a timer so "it settled" is measured rather than assumed.
     */
    exhaustOrigin(0);
    const outcome = await Promise.race([
      asyncStorageDriver
        .setItem('@probe/full', 'x'.repeat(4096))
        .then((): string => 'resolved')
        .catch((): string => 'rejected'),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('never settled');
        }, 250);
      }),
    ]);
    expect(outcome).toBe('rejected');
  });

  it('rejects with the platform’s own quota error, which is a DOMException', async () => {
    // Named so the next reader knows what the storage layer is catching, and so a host whose
    // `localStorage` stopped throwing on a full origin would fail this file loudly.
    exhaustOrigin(0);
    const error = await asyncStorageDriver.setItem('@probe/full', 'x'.repeat(4096)).then(
      (): unknown => null,
      (thrown: unknown): unknown => thrown,
    );
    expect(error).toBeInstanceOf(DOMException);
    expect(error instanceof DOMException && error.name).toBe('QuotaExceededError');
  });
});

describe('bounds on a real localStorage origin', () => {
  it('matches the figure TSD 6.4 declares', () => {
    // Without this, every bound assertion below would follow `definitions.ts` wherever it went.
    expect(STORAGE_BOUNDS.favorites).toBe(TSD_BOUND);
    expect(STORAGE_BOUNDS.customMeals).toBe(TSD_BOUND);
  });

  it('REFUSES a write past the bound and leaves the stored list byte-identical', async () => {
    const repository = favoritesRepository();
    await repository.set(ids(3));
    const before = raw(FAVORITES);
    expect(before).not.toBeNull();

    const error = await refusalFrom(repository.set(ids(TSD_BOUND + 1)));

    expect(isStorageWriteError(error) && error.reason).toBe('bound-exceeded');
    expect(isStorageWriteError(error) && error.key).toBe(FAVORITES);
    expect(isStorageWriteError(error) && error.message).toBe(REFUSAL_MESSAGE);
    // A refusal that half-saved would be worse than either outcome, and on a shared origin a
    // partial write is the shape that would strand the user between two lists.
    expect(raw(FAVORITES)).toBe(before);
  });

  it('accepts a write exactly AT the bound', async () => {
    // The control that keeps the refusal above from being satisfied by "refuses everything".
    await favoritesRepository().set(ids(TSD_BOUND));
    // Read off the origin, so "it was accepted" is a fact about the disk rather than about a
    // promise that resolved. TSD 6.4 fixes the envelope at exactly these three fields.
    const stored: unknown = JSON.parse(raw(FAVORITES) ?? 'null');
    expect(envelopeOf(stored)).toEqual({
      schemaVersion: 1,
      updatedAt: AT,
      value: ids(TSD_BOUND),
    });
    await expect(readEntry(STORAGE_DEFINITIONS.favorites, runtime)).resolves.toEqual({
      value: ids(TSD_BOUND),
      status: 'loaded',
    });
  });

  it('TRUNCATES the same over-long list on READ, and quarantines nothing', async () => {
    /**
     * **The asymmetry, on one value.** TSD 6.4 makes the two directions different on purpose:
     * "Bounds are refusals, not truncations … **Reads still truncate** and report `recovered`: an
     * over-long entry already on disk is a fact to recover from, and refusing there would make it
     * permanently unreadable." Driving one list through both halves is what no single behaviour can
     * satisfy — a truncating write passes the read half and fails the write half, and a refusing
     * read passes the write half and fails this one.
     */
    const overLong = ids(TSD_BOUND + 1);
    const error = await refusalFrom(favoritesRepository().set(overLong));
    expect(isStorageWriteError(error) && error.reason).toBe('bound-exceeded');

    seed(FAVORITES, overLong);
    const before = raw(FAVORITES);

    await expect(readEntry(STORAGE_DEFINITIONS.favorites, runtime)).resolves.toEqual({
      value: ids(TSD_BOUND),
      status: 'recovered',
    });
    // Truncation is not corruption: nothing is recorded, and the longer bytes stay where they are
    // until a store projects the shorter list over them (R-54).
    expect(raw(QUARANTINE_KEY)).toBeNull();
    expect(raw(FAVORITES)).toBe(before);
  });
});

describe('a quota-exhausted origin', () => {
  it('reports `write-failed` — NOT `bound-exceeded` — when localStorage refuses', async () => {
    /**
     * **The tempting wrong mapping.** A quota *is* a bound in ordinary language, and reporting it
     * as `bound-exceeded` would compile, read plausibly, and tell the user something false: TSD
     * 6.4's `bound-exceeded` means the app's own declared bound, and `createStore` turns it into
     * `saveBlocked`, which `StoreStatusNotices` presents with **no retry button** because
     * "retrying the same value can never succeed". A quota refusal is the one storage failure a
     * retry genuinely may fix — after the user frees space — so mapping it here would remove the
     * only control that could help them and title it "That list is full" over a list of three.
     */
    const repository = favoritesRepository();
    await repository.set(ids(1));
    exhaustOrigin(0);

    const error = await refusalFrom(repository.set(ids(2)));

    expect(isStorageWriteError(error)).toBe(true);
    expect(isStorageWriteError(error) && error.reason).toBe('write-failed');
    expect(isStorageWriteError(error) && error.reason).not.toBe('bound-exceeded');
    expect(isStorageWriteError(error) && error.message).toBe(FAILURE_MESSAGE);
    expect(isStorageWriteError(error) && error.message).not.toBe(REFUSAL_MESSAGE);
  });

  it('reports `write-failed` for a key that has no bound at all', async () => {
    // `preferences` carries no `bound`, so this cannot be the bound branch answering. A quota is a
    // property of the ORIGIN, not of a key, and every key fails the same way.
    const repository = createRepository(STORAGE_DEFINITIONS.preferences, runtime);
    await repository.set(STORAGE_DEFINITIONS.preferences.fallback());
    exhaustOrigin(0);

    const error = await refusalFrom(
      repository.set({ ...STORAGE_DEFINITIONS.preferences.fallback(), allergies: ['peanut'] }),
    );
    expect(isStorageWriteError(error) && error.reason).toBe('write-failed');
    expect(TSD_WRITE_FAILURES).toContain(
      isStorageWriteError(error) ? error.reason : 'not-a-reason',
    );
  });

  it('keeps the platform’s quota text away from the user', async () => {
    /**
     * The `DOMException` says "The 5000000-code unit storage quota has been exceeded." A message
     * built from it would put a number the user cannot act on in front of them, and worse, the same
     * escape hatch carries a driver string that can quote the payload — and the payload under
     * `preferences` is a name and an allergy list (PRD 10.3, PRD 12).
     */
    const repository = createRepository(STORAGE_DEFINITIONS.preferences, runtime);
    exhaustOrigin(0);
    const error = await refusalFrom(
      repository.set({ ...STORAGE_DEFINITIONS.preferences.fallback(), allergies: ['peanut'] }),
    );

    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    expect(text).toBe(`StorageWriteError: ${FAILURE_MESSAGE}`);
    expect(text).not.toContain('quota');
    expect(text).not.toContain('Quota');
    expect(text).not.toContain('code unit');
    expect(text).not.toContain('peanut');
  });

  it('loses nothing: the previous value survives the refused write, whole', async () => {
    // The silent-loss shape. A driver that cleared, or half-wrote, before failing would leave the
    // user with a list they never chose — and the screen would show the list they dispatched.
    const repository = favoritesRepository();
    await repository.set(ids(3));
    const before = raw(FAVORITES);
    exhaustOrigin(0);

    await refusalFrom(repository.set(ids(4)));

    expect(raw(FAVORITES)).toBe(before);
    releaseOrigin();
    await expect(readEntry(STORAGE_DEFINITIONS.favorites, runtime)).resolves.toEqual({
      value: ids(3),
      status: 'loaded',
    });
  });

  it('still READS and still CLEARS while the origin is full', async () => {
    // Neither needs space, and both are how a user gets out of this state: the app keeps working
    // on what is stored, and "clear my favourites" frees the origin rather than failing with it.
    const repository = favoritesRepository();
    await repository.set(ids(2));
    seed(PREFERENCES, STORAGE_DEFINITIONS.preferences.fallback());
    exhaustOrigin(0);

    await expect(repository.get()).resolves.toEqual(ids(2));
    await expect(repository.clear()).resolves.toBeUndefined();
    expect(raw(FAVORITES)).toBeNull();
    // And the key it did not name is untouched.
    expect(raw(PREFERENCES)).not.toBeNull();
  });
});
