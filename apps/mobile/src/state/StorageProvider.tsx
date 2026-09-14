/**
 * Hydration, run once, with its snapshot handed to the stores (T-14-06).
 *
 * TSD §6.1 requires **one `multiGet` across all six keys**, not six reads. So hydration cannot live
 * inside each store's provider — it has to happen above them, once, and each store receives its own
 * slice of the result. This is that boundary.
 *
 * **It does NOT decide the boot phase, and an earlier version of it did — which was a defect the
 * first end-to-end run found.** The phase was derived from `snapshot.entries.onboarding`, and a
 * snapshot is read once at boot and never updated: dispatching `onboarding/completed` moved the
 * store and left the phase where it was, so pressing Save at the end of setup did nothing visible
 * until the app was restarted. The live store is the source of truth after boot, so `App.tsx`
 * derives the phase inside the onboarding store's provider. What is left here is hydration.
 *
 * `hydrated` says only that the read has finished, which is what gates `hydrating`.
 *
 * **`hydrateStorage` never rejects** (it is written not to, and P12's verification found and fixed
 * the one path where it could), so there is no error phase. A driver that cannot be read at all
 * returns every key as `unavailable`, which means "run on defaults and destroy nothing" — the app
 * is usable and the user's data is untouched.
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { hydrateStorage, recordLaunch } from '../infrastructure/storage/hydrate.js';
import type { HydrationSnapshot } from '../infrastructure/storage/hydrate.js';
import { asyncStorageDriver, systemClock } from '../infrastructure/storage/asyncStorageDriver.js';
import type { RepositoryRuntime } from '../infrastructure/storage/repository.js';

export interface StorageContextValue {
  readonly snapshot: HydrationSnapshot;
  readonly runtime: RepositoryRuntime;
}

/**
 * `undefined` until hydration resolves, so a store provider cannot read a half-built snapshot.
 *
 * A default of "empty entries" would let every store silently create itself from defaults during the
 * first frame and then be replaced — which is the flicker-then-overwrite class of bug the
 * `hydrating` phase exists to prevent.
 */
const StorageContext = createContext<StorageContextValue | undefined>(undefined);

export interface StorageProviderProps {
  /** Injected for tests, so a suite supplies a memory driver and a fixed clock. */
  readonly runtime?: RepositoryRuntime;
  /**
   * Rendered while hydrating. The provider does NOT render its children until the snapshot exists,
   * because a child that read `undefined` would have to handle a state that lasts one frame.
   */
  readonly fallback?: ReactNode;
  readonly children: ReactNode;
}

const DEFAULT_RUNTIME: RepositoryRuntime = { driver: asyncStorageDriver, now: systemClock };

export function StorageProvider({
  runtime = DEFAULT_RUNTIME,
  fallback = null,
  children,
}: StorageProviderProps): ReactNode {
  const [snapshot, setSnapshot] = useState<HydrationSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const hydrated = await hydrateStorage(runtime);
      if (!live) {
        return;
      }
      setSnapshot(hydrated);
      // TSD §6.3: `meta` is the one key with no store, "written once at boot through its repository
      // directly". After the snapshot is published, so a slow write cannot hold up the first paint.
      void recordLaunch(runtime, hydrated);
    })();
    return () => {
      live = false;
    };
  }, [runtime]);

  const value = useMemo<StorageContextValue | null>(
    () => (snapshot === null ? null : { snapshot, runtime }),
    [snapshot, runtime],
  );

  if (value === null) {
    return <>{fallback}</>;
  }

  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>;
}

export function useStorageContext(): StorageContextValue {
  const context = useContext(StorageContext);
  if (context === undefined) {
    throw new Error('a store was used outside a StorageProvider');
  }
  return context;
}
