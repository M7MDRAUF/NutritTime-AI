import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StorageProvider } from './StorageProvider.js';
import { preferencesStore, preferencesActions } from './preferences/index.js';
import { memoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS } from '../infrastructure/storage/definitions.js';
import type { StoreStatus } from './createStore.js';

/**
 * `createStore`'s own suite — the factory five stores share, and it had **no test at all**.
 *
 * TSD §6.3 says of its three invariants "each of which the tests check", and two of the three were
 * checked only through `preferencesState.test.ts`, which never touches the factory. Nothing anywhere
 * failed a write while a store was mounted, so `saveError`, `saveBlocked`, `retrySave`, the
 * coalescing queue and the "stop draining on failure" rule were entirely unexercised — and
 * `DietarySetupScreen` renders a whole user-facing surface for them ("Your changes are not saved",
 * "Try again") that no test had ever rendered.
 */

const CLOCK = () => '2026-09-13T12:00:00.000Z';

interface CommittedStatus {
  readonly entryStatus: string;
  readonly saving: boolean;
  readonly saveError: string;
  readonly saveBlocked: boolean;
}

interface Harness {
  readonly driver: ReturnType<typeof memoryDriver>;
  /** What the last commit actually rendered. */
  committed(): CommittedStatus;
  status(): StoreStatus;
  dispatch(action: ReturnType<typeof preferencesActions.changeDiet>): Promise<void>;
  /**
   * Dispatch WITHOUT wrapping it in `act`, for a caller that is already inside one.
   *
   * Added because the burst test below used `void dispatch(...)` three times inside an outer
   * `act`, which opens three nested `act` scopes and never awaits them — and React 19 carries that
   * damage forward: the NEXT test in this file had its `StorageProvider` effect silently not run,
   * so a later test asserting on driver calls saw an empty log and failed for a reason that had
   * nothing to do with its subject. A test that disables the next test is worse than a slow one.
   */
  dispatchRaw(action: ReturnType<typeof preferencesActions.changeDiet>): void;
  settle(): Promise<void>;
  /** Tears the tree down, which is what P18's full reset does before it clears the keys. */
  unmount(): Promise<void>;
}

/**
 * A driver whose `setItem` does not settle until the test says so.
 *
 * `memoryDriver` resolves immediately, which is right for every other case here and useless for
 * the one below: the whole question is what a store does with a write still queued behind one
 * that is in flight. `failOn` cannot express "slow", only "broken".
 */
function holdingDriver(): {
  readonly driver: ReturnType<typeof memoryDriver>;
  /** Start holding. Called AFTER mount, so the boot projection is not part of the measurement. */
  readonly hold: () => void;
  readonly release: () => void;
  readonly held: () => number;
} {
  const inner = memoryDriver({});
  const waiters: (() => void)[] = [];
  let holding = false;
  // Delegated explicitly rather than spread: every method must keep reaching `inner`'s own
  // closure, which is where `calls` and `store` live.
  const driver: ReturnType<typeof memoryDriver> = {
    store: inner.store,
    failOn: inner.failOn,
    calls: inner.calls,
    multiGetKeys: inner.multiGetKeys,
    getItem: (key) => inner.getItem(key),
    removeItem: (key) => inner.removeItem(key),
    multiGet: (keys) => inner.multiGet(keys),
    setItem: async (key, value) => {
      if (holding) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      await inner.setItem(key, value);
    },
  };
  return {
    driver,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      // Copied before draining: a released write can queue the next one synchronously.
      const pending = waiters.splice(0, waiters.length);
      for (const resolve of pending) {
        resolve();
      }
    },
    held: () => waiters.length,
  };
}

async function mount(driver: ReturnType<typeof memoryDriver>): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let statusRef: StoreStatus | null = null;
  let dispatchRef: ((action: never) => void) | null = null;

  /**
   * The status is written into the DOM, not captured in a closure.
   *
   * A ref assigned during render is only as reliable as the test's guess about how many flushes
   * React needed — my first version read `null` in the `unavailable` case and reported "the probe
   * never rendered" when the real problem was the harness. A `data-*` attribute is whatever the
   * last commit actually produced.
   */
  function Probe(): ReactNode {
    const status = preferencesStore.useStatus();
    statusRef = status;
    dispatchRef = preferencesStore.useDispatch() as (action: never) => void;
    return (
      <div
        data-testid="probe"
        data-entry-status={status.entryStatus}
        data-saving={String(status.saving)}
        data-save-error={status.saveError ?? ''}
        data-save-blocked={String(status.saveBlocked)}
      />
    );
  }

  const root = createRoot(host);
  await act(async () => {
    root.render(
      <StorageProvider runtime={{ driver, now: CLOCK }}>
        <preferencesStore.Provider>
          <Probe />
        </preferencesStore.Provider>
      </StorageProvider>,
    );
  });

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  await settle();

  return {
    driver,
    committed: () => {
      const node = host.querySelector('[data-testid="probe"]');
      if (!(node instanceof HTMLElement)) {
        throw new Error('the probe never rendered');
      }
      return {
        entryStatus: node.getAttribute('data-entry-status') ?? '',
        saving: node.getAttribute('data-saving') === 'true',
        saveError: node.getAttribute('data-save-error') ?? '',
        saveBlocked: node.getAttribute('data-save-blocked') === 'true',
      };
    },
    status: () => {
      if (statusRef === null) {
        throw new Error('the probe never rendered');
      }
      return statusRef;
    },
    dispatch: async (action) => {
      await act(async () => {
        dispatchRef?.(action as never);
      });
      await settle();
    },
    dispatchRaw: (action) => {
      if (dispatchRef === null) {
        throw new Error('the probe never rendered, so there is no dispatch to call');
      }
      dispatchRef(action as never);
    },
    settle,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe('createStore', () => {
  it('persists a dispatched change through the repository', async () => {
    const view = await mount(memoryDriver({}));
    await view.dispatch(preferencesActions.changeDiet('vegan'));

    const written = view.driver.store.get(STORAGE_KEYS.preferences);
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? '{}')).toMatchObject({ value: { diet: 'vegan' } });
    expect(view.committed().saveError).toBe('');
    expect(view.committed().saving).toBe(false);
  });

  it('reports a failed write with a FIXED local message, never the driver text', async () => {
    /**
     * PRD §12. The memory driver throws `driver refused setItem`, which is harmless — but a real
     * driver's message can quote the payload, and this payload is a name and an allergy list.
     */
    const driver = memoryDriver({});
    driver.failOn.add('setItem');
    const view = await mount(driver);
    await view.dispatch(preferencesActions.changeDiet('vegan'));

    expect(view.committed().saveError).toBe('That change could not be saved.');
    expect(view.committed().saveError).not.toContain('driver refused');
    expect(view.committed().saveBlocked).toBe(false);
    expect(view.committed().saving).toBe(false);
  });

  it('stops draining on failure rather than spinning against a dead driver', async () => {
    const driver = memoryDriver({});
    driver.failOn.add('setItem');
    const view = await mount(driver);

    const before = driver.calls.filter((one) => one.startsWith('setItem')).length;
    await view.dispatch(preferencesActions.changeDiet('vegan'));
    const after = driver.calls.filter((one) => one.startsWith('setItem')).length;
    // Exactly one attempt per dispatch. A queue that retried itself would produce a stream of them.
    expect(after - before).toBe(1);
  });

  it('retries on demand, and succeeds once the driver recovers', async () => {
    const driver = memoryDriver({});
    driver.failOn.add('setItem');
    const view = await mount(driver);
    await view.dispatch(preferencesActions.changeDiet('vegan'));
    expect(view.committed().saveError).not.toBe('');

    driver.failOn.delete('setItem');
    await act(async () => {
      view.status().retrySave();
    });
    await view.settle();

    expect(view.committed().saveError).toBe('');
    // And it wrote the LATEST state, not the value that was pending when the failure happened.
    expect(JSON.parse(view.driver.store.get(STORAGE_KEYS.preferences) ?? '{}')).toMatchObject({
      value: { diet: 'vegan' },
    });
  });

  it('coalesces a burst into one write per round trip, and writes the LAST value', async () => {
    /**
     * The queue's whole purpose. Three dispatches inside one `act` must not produce three writes,
     * and whatever is written must be the newest state — never an intermediate one that happened
     * to win a race.
     */
    const driver = memoryDriver({});
    const view = await mount(driver);
    const before = driver.calls.filter((one) => one.startsWith('setItem')).length;

    await act(async () => {
      // `dispatchRaw`, because we are already inside `act`. The previous version called the
      // act-wrapping `dispatch` three times and discarded the promises, which left nested act
      // scopes unresolved and stopped the NEXT test's effects from running at all.
      view.dispatchRaw(preferencesActions.changeDiet('vegan'));
      view.dispatchRaw(preferencesActions.changeDiet('vegetarian'));
      view.dispatchRaw(preferencesActions.changeDiet('gluten-aware'));
    });
    await view.settle();

    const writes = driver.calls.filter((one) => one.startsWith('setItem')).length - before;
    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThan(3);
    expect(JSON.parse(driver.store.get(STORAGE_KEYS.preferences) ?? '{}')).toMatchObject({
      value: { diet: 'gluten-aware' },
    });
  });

  it('abandons a QUEUED write when the store unmounts, so a reset cannot be undone by it', async () => {
    /**
     * **The guard that makes P18's full reset trustworthy, and it had no test until an auditor
     * reproduced the defect.**
     *
     * `DataResetProvider` unmounts this whole subtree *before* clearing the keys, so that no store
     * can begin a write while the clear runs. That only holds if a write already sitting in the
     * queue actually stops: the drain loop went straight on to `repository.set`, so a write queued
     * a moment earlier landed **after** the keys were removed. The user who confirmed "erase all
     * data" then got every outward sign of a completed wipe with their diet and allergy list back
     * on disk — written by a store instance that no longer existed, so nothing reported it.
     *
     * **Holding starts after mount, deliberately.** A cold mount already queues two writes — the
     * store's own boot projection and `recordLaunch`'s `meta` — and counting those measured the
     * wrong thing: `meta` goes through its own repository, not this store's queue, so no guard here
     * could ever stop it. Measuring from `hold()` isolates the one claim being made.
     *
     * The sequence is then exactly the reachable one: a held write keeps the drain parked inside
     * `await`, a second dispatch leaves a value in `pending`, and the unmount happens while it is
     * parked. Releasing runs the loop's next iteration with `mounted.current === false`.
     */
    const { driver, hold, release } = holdingDriver();
    const view = await mount(driver);

    const preferenceWrites = (): number =>
      driver.calls.filter((one) => one === `setItem:${STORAGE_KEYS.preferences}`).length;
    const beforeHold = preferenceWrites();

    hold();
    // Held, so `inFlight` stays true and the drain is parked inside `await repository.set`.
    await view.dispatch(preferencesActions.changeDiet('vegan'));
    // `drain` returns early because a write is in flight, so this value waits in `pending`.
    await view.dispatch(preferencesActions.changeDiet('vegetarian'));

    await view.unmount();
    release();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly the write that was already in flight. The queued one must never be attempted: with
    // the `mounted.current` guard removed this is 2, and that second write is the resurrection.
    expect(preferenceWrites() - beforeHold).toBe(1);
    expect(JSON.parse(driver.store.get(STORAGE_KEYS.preferences) ?? '{}')).toMatchObject({
      value: { diet: 'vegan' },
    });
  });

  /**
   * **There is deliberately no "used outside its Provider" test here, and that is a judgement about
   * evidence rather than an omission.**
   *
   * The guard exists — all three hooks throw a named error — but I could not build an assertion on
   * it that I trust. Calling the hook directly gives React's own "Invalid hook call". Rendering the
   * component inside `StorageProvider` puts the throw in a later asynchronous commit, which React
   * 19 reports as an unhandled rejection rather than rethrowing from `act`. Rendering it bare did
   * not rethrow either, while the structurally identical test in `ThemeProvider.dom.test.tsx` does
   * — so React 19's error propagation through `act` is doing something I have not pinned down.
   *
   * A test that passes for a reason I cannot explain is worse than no test, because the next person
   * will trust it. The pattern is covered by `ThemeProvider.dom.test.tsx`, and this is recorded so
   * the gap is visible rather than looking like nobody thought of it.
   */
});
