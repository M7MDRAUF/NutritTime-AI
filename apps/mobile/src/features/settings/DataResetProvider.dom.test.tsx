import { describe, expect, it } from 'vitest';
import { act, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DataResetProvider, useDataReset } from './DataResetProvider.js';
import type { DataReset } from './DataResetProvider.js';
import { useStorageContext } from '../../state/StorageProvider.js';
import { onboardingStore } from '../../state/onboarding/index.js';
import { preferencesActions, preferencesStore } from '../../state/preferences/index.js';
import { callsOf, memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import {
  DEFAULT_PREFERENCES,
  STORAGE_KEYS,
  STORAGE_KEY_NAMES,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import { asyncStorageDriver } from '../../infrastructure/storage/asyncStorageDriver.js';
import type { RepositoryRuntime } from '../../infrastructure/storage/repository.js';
import type { BootPhase } from '../../navigation/routes.js';

/**
 * The reset's user-visible half: does the app's memory agree with the disk afterwards?
 *
 * **The assertion that matters is the one about re-hydration, and it is the easiest to fake.** A
 * test that dispatched nothing and read a store created from defaults would pass with the remount
 * removed entirely. So every reset assertion below is made against a tree that was seeded with
 * COMPLETED onboarding and real preferences, is mounted once, and is never rebuilt by the test —
 * the only thing that can change what the probe reads is the provider discarding and rebuilding
 * the subtree itself. `probeMounts` is the direct witness: the probe mounted twice, against the
 * same root, because the conditional render replaced `StorageProvider` and then put it back.
 *
 * A driver call count is deliberately NOT the witness. `clearAllStorage` now verifies its own work
 * with a `multiGet` over the same key list hydration reads, so counting `multiGet` calls would
 * measure the verification as well as the hydration and could not tell them apart.
 */

const AT = '2026-09-13T12:00:00.000Z';
const CLOCK = (): string => AT;

/** Stands in for the kind of value the preferences key really holds. */
const ALLERGY = 'peanut';

/** Every key populated with a VALID value, so nothing is quarantined during hydration. */
function seededDriver(): MemoryDriver {
  const driver = memoryDriver({});
  const put = (key: string, value: unknown): void => {
    driver.store.set(key, encodeEnvelope(STORAGE_SCHEMA_VERSION, value, AT));
  };
  put(STORAGE_KEYS.meta, { firstLaunchAt: AT, lastLaunchAt: AT });
  put(STORAGE_KEYS.onboarding, { completed: true });
  put(STORAGE_KEYS.preferences, {
    ...DEFAULT_PREFERENCES,
    diet: 'vegan',
    allergies: [ALLERGY],
  });
  put(STORAGE_KEYS.favorites, ['chicken-handi']);
  put(STORAGE_KEYS.customMeals, []);
  put(STORAGE_KEYS.ui, { lastTab: 'settings', disclaimerAcknowledged: true });
  return driver;
}

/**
 * A driver whose removals hang until released — the only way to observe the app while the clear is
 * genuinely in flight. Everything else passes straight through, so the verification read and the
 * hydration that follows are unaffected.
 */
function gatedRemoval(driver: MemoryDriver): {
  readonly gated: MemoryDriver;
  readonly release: () => void;
} {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return {
    gated: {
      ...driver,
      async removeItem(key: string): Promise<void> {
        await gate;
        return driver.removeItem(key);
      },
    },
    release,
  };
}

let latestReset: DataReset | null = null;
type DietAction = ReturnType<typeof preferencesActions.changeDiet>;
let latestDispatch: ((action: DietAction) => void) | null = null;
let latestRuntime: RepositoryRuntime | null = null;
let probeMounts = 0;

/**
 * What the tree renders, written into the DOM rather than captured in a closure — the convention
 * `createStore.dom.test.tsx` arrived at, for the reason it gives: a `data-*` attribute is whatever
 * the last commit actually produced, while a ref is only as good as the test's guess about flushes.
 *
 * The exception is `probeMounts`, which is counted in an effect with an empty dependency array:
 * that fires once per MOUNT and never on a re-render, which is exactly the distinction under test.
 */
function Probe(): ReactNode {
  const onboarding = onboardingStore.useValue();
  const { preferences } = preferencesStore.useValue();
  const reset = useDataReset();
  const { runtime } = useStorageContext();
  latestDispatch = preferencesStore.useDispatch();
  latestReset = reset;
  latestRuntime = runtime;

  useEffect(() => {
    probeMounts += 1;
  }, []);

  /**
   * The boot phase, derived exactly as `App.tsx` derives it — from the LIVE onboarding store.
   * Replicated rather than imported because `App.tsx` is not this task's file and nothing exports
   * the one-line derivation; T-18-06's acceptance is "app returns to onboarding", so the phase is
   * what has to be asserted rather than the boolean behind it.
   */
  const phase: BootPhase = onboarding.completed ? 'app' : 'onboarding';

  return (
    <div
      data-testid="probe"
      data-phase={phase}
      data-diet={preferences.diet}
      data-allergies={preferences.allergies.join(',')}
      data-resetting={String(reset.resetting)}
      data-reset-error={reset.resetError ?? ''}
    />
  );
}

interface Harness {
  read(attribute: string): string;
  /** Whether the storage subtree is mounted at all. False while the clear runs. */
  present(): boolean;
  /** True when the provider is showing `fallback` instead of the subtree. */
  showingFallback(): boolean;
  /**
   * Start a reset, flush until it resolves, and fail loudly if it never does.
   *
   * **Fire-and-forget, not `await act(async () => await resetAll())`.** The clear is started by an
   * effect of the render that unmounts the stores, and that render only commits when `act` flushes
   * its queue — so awaiting the promise from inside the `act` scope would deadlock waiting for a
   * flush that cannot happen until the scope exits. This is also how a screen must call it: the
   * caller is inside the subtree and is about to be unmounted.
   */
  resetAndSettle(): Promise<void>;
  settle(): Promise<void>;
}

/** Bounded, condition-driven, and no timers: flush passes until the work is done. */
const MAX_FLUSH_PASSES = 20;

async function mount(driver: MemoryDriver | undefined): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  latestReset = null;
  latestRuntime = null;
  probeMounts = 0;

  const runtime = driver === undefined ? undefined : { driver, now: CLOCK };

  await act(async () => {
    createRoot(host).render(
      <DataResetProvider runtime={runtime} fallback={<div data-testid="fallback" />}>
        <preferencesStore.Provider>
          <onboardingStore.Provider>
            <Probe />
          </onboardingStore.Provider>
        </preferencesStore.Provider>
      </DataResetProvider>,
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
    read: (attribute) => {
      const node = host.querySelector('[data-testid="probe"]');
      if (!(node instanceof HTMLElement)) {
        throw new Error('the probe is not mounted');
      }
      return node.getAttribute(attribute) ?? '';
    },
    present: () => host.querySelector('[data-testid="probe"]') !== null,
    showingFallback: () => host.querySelector('[data-testid="fallback"]') !== null,
    resetAndSettle: async () => {
      let done = false;
      await act(async () => {
        void reset()
          .resetAll()
          .then(() => {
            done = true;
          });
      });
      for (let pass = 0; pass < MAX_FLUSH_PASSES && !done; pass += 1) {
        await settle();
      }
      if (!done) {
        throw new Error('resetAll never resolved');
      }
      // One more, so the fresh subtree's own hydration and projections have landed.
      await settle();
    },
    settle,
  };
}

/**
 * The last `DataReset` the probe rendered.
 *
 * Deliberately the LAST one rather than a live read: during the clear the probe is unmounted, and
 * calling `resetAll` from a stale copy is precisely what a second confirmation would do.
 */
function reset(): DataReset {
  if (latestReset === null) {
    throw new Error('the probe never mounted');
  }
  return latestReset;
}

describe('DataResetProvider', () => {
  it('re-hydrates the subtree, so the app returns to onboarding on its own defaults', async () => {
    /**
     * T-18-06's acceptance, whole. The tree is mounted ONCE, with onboarding completed and a real
     * preference set on disk, and is never re-rendered by the test — so a probe reading fallback
     * values afterwards can only mean the subtree was rebuilt and hydration ran again.
     *
     * **This is the test that fails when the `if (resetting)` conditional is removed** (see the
     * report's probe): `StorageProvider` then stays mounted throughout, keeps the snapshot it
     * already has, and the stores keep the state they created at boot.
     */
    const driver = seededDriver();
    const view = await mount(driver);

    expect(view.read('data-phase')).toBe('app');
    expect(view.read('data-diet')).toBe('vegan');
    expect(view.read('data-allergies')).toBe(ALLERGY);
    expect(probeMounts).toBe(1);

    await view.resetAndSettle();

    expect(view.read('data-phase')).toBe('onboarding');
    expect(view.read('data-diet')).toBe(DEFAULT_PREFERENCES.diet);
    expect(view.read('data-allergies')).toBe('');
    expect(view.read('data-reset-error')).toBe('');
    // The subtree was discarded and rebuilt — one mount per generation, against the same root.
    expect(probeMounts).toBe(2);
  });

  it('removes every key the key list declares, and the data does not come back', async () => {
    const driver = seededDriver();
    const view = await mount(driver);

    await view.resetAndSettle();

    // Derived from `STORAGE_KEY_NAMES`, so a seventh key would have to be removed here too.
    for (const name of STORAGE_KEY_NAMES) {
      expect(callsOf(driver, 'removeItem')).toContain(STORAGE_KEYS[name]);
    }
    /**
     * The user's data is gone even though the keys exist again: each store re-creates from its
     * fallback on the fresh mount and projects that straight back, which is exactly what a first
     * launch does. What must NOT survive is the content.
     */
    expect([...driver.store.values()].join('|')).not.toContain(ALLERGY);
    expect([...driver.store.values()].join('|')).not.toContain('"diet":"vegan"');
  });

  it('does not resurrect a key from a write that was in flight when the clear ran', async () => {
    /**
     * F-W7-RESET-1, as a regression test. **This is the test that would have caught the defect**,
     * and it failed against the first implementation of this module — the report records the
     * failure it produced, with the user's allergy list in the received value.
     *
     * A store write is issued and left unsettled, then the reset runs, then the write lands. The
     * write belongs to a store instance the reset has already discarded: nothing sets state,
     * nothing is logged, and the app shows every outward sign of a completed wipe. What must not
     * happen is the user's allergy list arriving back on disk behind it.
     *
     * The timing is made deterministic rather than left to a driver's latency: the pending write
     * is released the instant its own key has been removed, which is the exact window the defect
     * lived in, and the window a real driver's queue would hit by luck.
     */
    const base = seededDriver();
    let writes = 0;
    let landed = (): void => {};
    const pendingWrite = new Promise<void>((resolve) => {
      landed = () => {
        resolve();
      };
    });
    const racing: MemoryDriver = {
      ...base,
      async setItem(key: string, value: string): Promise<void> {
        // Only the FIRST write to the preferences key waits. The very first `setItem` of the
        // app's life is `recordLaunch`'s `meta` write, and holding that one proves nothing.
        //
        // That first preferences write is the STORE'S OWN mount-time projection: `createStore`'s
        // write effect runs on mount and queues `project(state)`, so the hydrated value is
        // written straight back and a write is in flight on every cold launch. The dispatch below
        // then queues a second value behind it, which the coalescing queue writes once the first
        // completes — so both land after the removal, which is the stronger case.
        if (key === STORAGE_KEYS.preferences) {
          writes += 1;
          if (writes === 1) {
            await pendingWrite;
          }
        }
        return base.setItem(key, value);
      },
      async removeItem(key: string): Promise<void> {
        await base.removeItem(key);
        if (key === STORAGE_KEYS.preferences) {
          landed();
        }
      },
    };
    const view = await mount(racing);

    await act(async () => {
      latestDispatch?.(preferencesActions.changeDiet('vegetarian'));
    });
    // The write is issued and unsettled: the key still holds exactly what hydration read.
    expect(base.store.get(STORAGE_KEYS.preferences) ?? '').toContain('"diet":"vegan"');

    await view.resetAndSettle();

    expect(view.read('data-phase')).toBe('onboarding');
    expect([...base.store.values()].join('|')).not.toContain(ALLERGY);
    expect([...base.store.values()].join('|')).not.toContain('"diet":"vegetarian"');
  });

  it.fails(
    'does NOT catch a write that lands after the final verification read — OPEN',
    async () => {
      /**
       * **This test is expected to FAIL, and `it.fails` is what says so out loud.** It is the
       * residual of F-W7-RESET-1, kept in the suite rather than described in a report, because a
       * gap nobody can run is a gap the next person will assume is covered. The day it starts
       * passing, `it.fails` turns red and the marker should come off.
       *
       * The difference from the regression test above is the release point, and it is the whole
       * point. That one releases the held write from inside `removeItem` — during the first pass —
       * so the verification read still has a chance to see the resurrected key. This one releases it
       * after `resetAll` has resolved: every removal done, every read-back done, the subtree
       * rebuilt. Nothing left is looking, so the write lands and the user's allergy list is back on
       * disk under an app that shows onboarding.
       *
       * **What is being held is the store's own mount-time projection**, not the dispatch below.
       * `createStore`'s write effect runs on mount and queues `project(state)` immediately, so the
       * first `setItem` for the preferences key is the hydrated value being written straight back —
       * which means a write is in flight on every cold launch, with no user action at all. The
       * dispatch is here so the coalescing queue also holds a SECOND value behind the first, which
       * is what a user changing a setting shortly before confirming produces.
       *
       * Adding a fourth pass, or a delay, would only move the release point — any finite number of
       * passes has an "after the last one". Closing it needs either a cancellable driver write
       * (`StorageDriver`'s four methods are fixed by TSD §6.4 and none of them aborts) or a
       * queue-drained signal from `createStore` plus a bound on waiting for it, which is R-51,
       * recorded rather than fixed because no document gives the figure.
       */
      const base = seededDriver();
      let writes = 0;
      let landed = (): void => {};
      const pendingWrite = new Promise<void>((resolve) => {
        landed = () => {
          resolve();
        };
      });
      const racing: MemoryDriver = {
        ...base,
        async setItem(key: string, value: string): Promise<void> {
          if (key === STORAGE_KEYS.preferences) {
            writes += 1;
            if (writes === 1) {
              await pendingWrite;
            }
          }
          return base.setItem(key, value);
        },
      };
      const view = await mount(racing);

      await act(async () => {
        latestDispatch?.(preferencesActions.changeDiet('vegetarian'));
      });
      await view.resetAndSettle();

      // The reset reported total success, and by every check it could make, it was.
      expect(view.read('data-phase')).toBe('onboarding');
      expect(view.read('data-reset-error')).toBe('');
      expect([...base.store.values()].join('|')).not.toContain(ALLERGY);

      // Now the write that was in flight before the confirmation finally lands.
      await act(async () => {
        landed();
      });
      await view.settle();

      expect([...base.store.values()].join('|')).not.toContain(ALLERGY);
    },
  );

  it('unmounts the stores for the duration of the clear, and refuses a second reset', async () => {
    /**
     * The unmount is the fix, so it is asserted as a user-visible consequence rather than as a
     * boolean: while the clear runs there is no store mounted that could issue a write over it,
     * and what the user sees is `fallback`.
     */
    const base = seededDriver();
    const { gated, release } = gatedRemoval(base);
    const view = await mount(gated);
    expect(view.present()).toBe(true);

    let finished = false;
    await act(async () => {
      void reset()
        .resetAll()
        .then(() => {
          finished = true;
        });
    });

    expect(finished).toBe(false);
    expect(view.present()).toBe(false);
    expect(view.showingFallback()).toBe(true);

    // A second confirmation while the first clear is still running, from the stale copy a screen
    // would hold. It must not start another: the second run's outcome would report over the
    // first's, and the message the user reads about what survived has to come from the run they
    // triggered.
    let secondResolved = false;
    await act(async () => {
      void reset()
        .resetAll()
        .then(() => {
          secondResolved = true;
        });
    });
    // Refused immediately, and the caller is not left hanging behind the first run: the guard is
    // a latch with a resolved promise, not a queue.
    expect(secondResolved).toBe(true);
    expect(view.present()).toBe(false);

    await act(async () => {
      release();
    });
    await view.settle();

    expect(finished).toBe(true);
    expect(view.present()).toBe(true);
    expect(view.read('data-resetting')).toBe('false');
    // One removal per key plus the ledger, in one verified pass. Two clears would be double this.
    expect(callsOf(base, 'removeItem')).toHaveLength(STORAGE_KEY_NAMES.length + 1);
  });

  it('names the sets that survived, in copy that quotes no driver string', async () => {
    /**
     * The partial failure, end to end: a reset that claims success while an allergy list is still
     * on disk is the worst outcome this module can produce. `resetError` also has to SURVIVE the
     * unmount it triggers, which is why it is held above the conditional — a message destroyed by
     * its own remount is a partial reset claiming success.
     */
    const base = seededDriver();
    const refusing: MemoryDriver = {
      ...base,
      removeItem(key: string): Promise<void> {
        if (key === STORAGE_KEYS.preferences) {
          base.calls.push(`removeItem:${key}`);
          return Promise.reject(new Error('driver refused removeItem'));
        }
        return base.removeItem(key);
      },
    };
    const view = await mount(refusing);

    await view.resetAndSettle();

    const message = view.read('data-reset-error');
    expect(message).toContain('your preferences');
    expect(message).not.toContain('driver refused');
    expect(message).not.toContain(STORAGE_KEYS.preferences);
    expect(view.read('data-resetting')).toBe('false');

    /**
     * **And the phase does NOT move, which is what makes the message above readable at all.**
     *
     * `resetError` renders on `SettingsScreen`, and `RootNavigator` registers Settings only in the
     * `app` phase — so a partial failure that advanced the phase would hand the app a tree with no
     * surface for its own error. It would also put `DietarySetupScreen` in front of the user
     * hydrated from the `preferences` key that just refused to clear, showing them the diet and
     * allergy list they had asked to erase.
     *
     * So a partial failure stays in `app`, still set up, naming what survived.
     */
    expect(view.read('data-phase')).toBe('app');
    expect(view.read('data-diet')).toBe('vegan');
    expect(base.store.has(STORAGE_KEYS.onboarding)).toBe(true);
  });

  it('passes `runtime` through unchanged', async () => {
    const driver = seededDriver();
    await mount(driver);
    // Identity, not equality: a copied or wrapped runtime would clear a different store from the
    // one hydration read.
    expect(latestRuntime?.driver).toBe(driver);
    expect(latestRuntime?.now).toBe(CLOCK);
  });

  it("leaves StorageProvider's own default runtime in place when none is given", async () => {
    /**
     * The rule this protects: **no default runtime is declared in `DataResetProvider`.** One
     * declared there would be a second source of truth, and if it ever drifted the real app would
     * clear a store it does not use — or, in the shape this fleet's brief warns about, be handed a
     * memory driver in production.
     */
    await mount(undefined);
    expect(latestRuntime?.driver).toBe(asyncStorageDriver);
  });

  it('throws a named error when `useDataReset` is used outside its provider', () => {
    // Rather than a no-op `resetAll`, which would close the confirmation sheet and destroy
    // nothing — a destructive action silently doing nothing is worse than a crash in development.
    function Orphan(): ReactNode {
      useDataReset();
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    expect(() => {
      act(() => {
        createRoot(container).render(<Orphan />);
      });
    }).toThrow(/outside a DataResetProvider/);
  });
});
