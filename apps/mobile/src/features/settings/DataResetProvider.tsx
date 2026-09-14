/**
 * The remount half of the full reset (T-18-06). `resetData.ts` clears; this makes the app agree.
 *
 * **No document specifies the mechanism of a full reset**, so the reasoning is repeated here in
 * the file that carries it. Plan §17's acceptance for T-18-06 is "All six keys cleared; app
 * returns to onboarding", and the second clause is the hard one:
 *
 *  - The `onboarding` store has **no reset action, deliberately** (its docstring says so), so no
 *    dispatch can move the boot phase back. Adding one would put "send this user back through
 *    setup" within reach of any screen holding a dispatch.
 *  - And clearing the keys is not enough on its own: the five stores hold their state in memory,
 *    created once from the hydration snapshot, so after a clear the app would still be showing
 *    the data it had just destroyed — memory and disk disagreeing, which is the single thing a
 *    destructive action must not leave behind.
 *
 * So the storage subtree is **unmounted before the clear and mounted fresh afterwards**: while
 * `resetting`, this renders `fallback` instead of `StorageProvider`. Two different element types
 * at one position, so React discards the subtree and builds a new one when `resetting` clears, and
 * that new mount re-runs hydration against the cleared keys. Every store re-creates from its own
 * fallback, and `App.tsx` derives `onboarding` from the live store — which now reads
 * `completed: false` because that is what a cleared `onboarding` key says. Nothing needs a reset
 * action and no screen gains a dispatch that could un-complete onboarding.
 *
 * **The order is the point, and an earlier version of this had it the other way round.** It kept
 * the subtree mounted and remounted it with a changing `key` *after* the clear, which shipped
 * F-W7-RESET-1: a store write already in flight when the removals ran landed afterwards and put
 * the user's allergy list back on disk, silently, because the write belonged to a store instance
 * the remount had discarded. Clearing with nothing mounted stops the store from *issuing* further
 * writes; it cannot cancel one already issued, which is why `clearAllStorage` verifies the disk
 * and clears again. There is exactly one remount mechanism here — a second one whose probe no
 * longer failed would be decoration.
 *
 * **Why the reset state lives above the conditional and the runtime comes from below it.**
 * `resetting` and `resetError` must survive the unmount they cause — a failure message destroyed
 * by its own remount is a partial reset claiming success — so they are held here. The runtime,
 * though, is read *inside* by `DataResetScope` through `useStorageContext`, which means the keys
 * cleared are always the ones hydration actually read. That is deliberate: declaring a default
 * runtime here would hand the real app a second one, and if it ever drifted from
 * `StorageProvider`'s the reset would clear a store the app does not use. `runtime` is passed
 * through unchanged, `undefined` included, so `StorageProvider`'s own default still applies when
 * none is given.
 *
 * **R-51 and this unmount.** The register's hazard is that `createStore`'s write queue latches if
 * `repository.set` never settles (`inFlight` stays true) and that `mounted.current` is never reset
 * on a re-mount. Neither is made worse here, and both are cleared more directly than by the old
 * keyed remount: the subtree is discarded outright, component instances and all, so a new store
 * gets fresh `pending`, `inFlight` and `mounted` refs. A latched write queue does not survive a
 * reset. What the unmount does not do is stop `drain`'s loop issuing a value it had already
 * queued — `drain` checks `mounted.current` only around its `setState` calls, never before
 * `repository.set` — which is the other half of why the clear is verified rather than trusted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { StorageProvider, useStorageContext } from '../../state/StorageProvider.js';
import type { RepositoryRuntime } from '../../infrastructure/storage/repository.js';
import { clearAllStorage, describeResetFailure } from './resetData.js';

export interface DataResetProviderProps {
  readonly runtime?: RepositoryRuntime;
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

export interface DataReset {
  /** Clears every key, then remounts the storage subtree. Resolves when the clear is done. */
  readonly resetAll: () => Promise<void>;
  readonly resetting: boolean;
  /** Fixed local copy, never a driver string. Names the sets that survived. */
  readonly resetError: string | null;
}

/**
 * `undefined` rather than a no-op default.
 *
 * A default `resetAll` that resolved without clearing anything would be a destructive action
 * silently doing nothing — the confirmation sheet would close and the user would believe their
 * data was gone. A missing provider must be a crash in development, not a lie in the interface.
 */
const DataResetContext = createContext<DataReset | undefined>(undefined);

interface PendingReset {
  readonly runtime: RepositoryRuntime;
  readonly resolve: () => void;
}

interface ScopeProps {
  readonly perform: (runtime: RepositoryRuntime) => Promise<void>;
  /**
   * **Always `false` where this is read, and that is structural rather than a bug.** A consumer of
   * `useDataReset` lives inside the storage subtree, and the subtree is unmounted for the whole
   * time `resetting` is true — so no consumer can be mounted to observe it. The field stays in
   * `DataReset` because CONTRACTS.md §8 declares it and a screen may reasonably read it; what a
   * user sees during the clear is `fallback`, not a disabled button.
   */
  readonly resetting: boolean;
  readonly resetError: string | null;
  readonly children: ReactNode;
}

/**
 * Inside the storage subtree, so it can read the runtime hydration used; it owns no state, so
 * being discarded and rebuilt by every reset costs nothing.
 */
function DataResetScope({ perform, resetting, resetError, children }: ScopeProps): ReactNode {
  const { runtime } = useStorageContext();
  const resetAll = useCallback((): Promise<void> => perform(runtime), [perform, runtime]);
  const value = useMemo<DataReset>(
    () => ({ resetAll, resetting, resetError }),
    [resetAll, resetting, resetError],
  );
  return <DataResetContext.Provider value={value}>{children}</DataResetContext.Provider>;
}

export function DataResetProvider({
  runtime,
  fallback,
  children,
}: DataResetProviderProps): ReactNode {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  /**
   * The reset in progress: the runtime to clear, and the promise `resetAll` handed its caller.
   *
   * A ref, not state, for two reasons. It is the single-flight latch — two taps can arrive inside
   * one React batch and both would read `resetting === false`, and a second clear running over
   * the first would report its outcome over the first's, when the message the user reads about
   * what survived has to come from the run they triggered. And it carries the `resolve` that the
   * effect below calls, which is not render data.
   */
  const pending = useRef<PendingReset | null>(null);

  /**
   * **Ask for the reset; do not perform it here.** Setting `resetting` is what unmounts the
   * storage subtree, and the clear must not start until that unmount has actually committed.
   */
  const perform = useCallback((target: RepositoryRuntime): Promise<void> => {
    if (pending.current !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      pending.current = { runtime: target, resolve };
      setResetError(null);
      setResetting(true);
    });
  }, []);

  /**
   * **The clear runs in an effect of the `resetting` render, and that ordering is the fix for
   * F-W7-RESET-1 — not a detail of how the promise is plumbed.**
   *
   * An effect runs after the commit, so by the time this executes the storage subtree is provably
   * gone: no store is mounted that could issue a write over the keys being removed. Doing the
   * clear inside `perform`, immediately after `setResetting(true)`, only *appeared* to work — it
   * relied on React flushing the unmount before the awaited work resumed, which a discrete event
   * does and a batch does not. The dom suite caught it: under `act` both state changes landed in
   * one commit, the subtree never unmounted, and the re-hydration assertion failed. A guarantee
   * that holds because of when React happens to flush is not a guarantee.
   *
   * Unmounting stops a store ISSUING a new write; it cannot cancel one already issued, because
   * `createStore`'s `drain` checks `mounted.current` only around its `setState` calls and never
   * before `repository.set`. That is why `clearAllStorage` reads the keys back and clears again
   * rather than trusting its own removals.
   */
  useEffect(() => {
    const request = pending.current;
    if (!resetting || request === null) {
      return;
    }
    void (async () => {
      try {
        setResetError(describeResetFailure(await clearAllStorage(request.runtime)));
      } finally {
        /**
         * `clearAllStorage` never rejects, so this is a guard against a future change rather than
         * a live path — and it is the right guard: an exception that skipped these three would
         * latch `pending` forever (R-51's shape, in this module), leave the app on the fallback
         * with no message and no way back, and hang the caller's promise. The subtree still comes
         * back, because an unknown amount was destroyed and re-hydrating from disk is the only
         * honest thing to show.
         */
        pending.current = null;
        setResetting(false);
        request.resolve();
      }
    })();
  }, [resetting]);

  /**
   * **The unmount, and the only remount mechanism in this file.**
   *
   * A different element type at this position, so the whole storage subtree — `StorageProvider`,
   * every store, every screen under them — is discarded while the clear runs and rebuilt from
   * nothing afterwards. Rebuilding is what re-runs hydration, which is what returns the app to
   * onboarding. Removing this conditional is the probe: the stores then keep the state they
   * created at boot and the app shows pre-reset data over cleared storage.
   */
  if (resetting) {
    return <>{fallback}</>;
  }

  return (
    // `runtime` and `fallback` are forwarded exactly as received. Passing `runtime={undefined}`
    // is what makes `StorageProvider`'s own destructuring default apply, so the real app keeps
    // the AsyncStorage driver and only a test's injected runtime replaces it.
    <StorageProvider runtime={runtime} fallback={fallback}>
      <DataResetScope perform={perform} resetting={resetting} resetError={resetError}>
        {children}
      </DataResetScope>
    </StorageProvider>
  );
}

export function useDataReset(): DataReset {
  const value = useContext(DataResetContext);
  if (value === undefined) {
    throw new Error('useDataReset was used outside a DataResetProvider');
  }
  return value;
}
