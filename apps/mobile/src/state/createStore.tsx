/**
 * One store factory, five configurations (TSD §6.3). No per-store boilerplate.
 *
 * **Three contexts per store, and that is the memoisation strategy rather than a style choice.** A
 * component that only dispatches — a chip, a toggle — must not re-render when the value changes, and
 * a component that only reads the value must not re-render when `saving` flips. One context carrying
 * `{ state, dispatch, status }` re-renders every consumer on every change of any of the three.
 *
 * **The write queue coalesces, and it never writes over an `unavailable` key.** That second rule is
 * the load-bearing one: `unavailable` means the read failed, so the stored bytes are unknown — and
 * writing a default over data that might be perfectly good is how a transient driver failure turns
 * into permanent data loss. The store runs on defaults for the session and touches nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { Dispatch, ReactNode } from 'react';
import { createRepository } from '../infrastructure/storage/repository.js';
import type { EntryStatus, StorageWriteFailure } from '../infrastructure/storage/repository.js';
import { isStorageWriteError } from '../infrastructure/storage/repository.js';
import { STORAGE_DEFINITIONS } from '../infrastructure/storage/definitions.js';
import type { StorageKeyName, StorageValues } from '../infrastructure/storage/definitions.js';
import { useStorageContext } from './StorageProvider.js';

export interface StoreStatus {
  readonly hydrated: boolean;
  readonly entryStatus: EntryStatus;
  readonly saving: boolean;
  /** A fixed local message, never a driver string (PRD §15.5). */
  readonly saveError: string | null;
  /**
   * True when the write was refused for exceeding a bound (TSD §6.4).
   *
   * Separate from `saveError` because the UI must present it differently: **there is nothing to
   * retry.** Offering a retry for something that will always refuse is a lie in the interface.
   */
  readonly saveBlocked: boolean;
  readonly retrySave: () => void;
}

export interface StoreConfig<K extends StorageKeyName, S, A extends { readonly type: string }> {
  readonly name: string;
  readonly key: K;
  readonly create: (persisted: StorageValues[K]) => S;
  readonly reducer: (state: S, action: A) => S;
  /** Omitted for a store that is not persisted. */
  readonly project?: (state: S) => StorageValues[K];
}

export interface Store<S, A> {
  readonly Provider: (props: { readonly children: ReactNode }) => ReactNode;
  readonly useValue: () => S;
  readonly useDispatch: () => Dispatch<A>;
  readonly useStatus: () => StoreStatus;
}

const FAILURE_IS_BOUND: StorageWriteFailure = 'bound-exceeded';

export function createStore<K extends StorageKeyName, S, A extends { readonly type: string }>(
  config: StoreConfig<K, S, A>,
): Store<S, A> {
  const ValueContext = createContext<S | undefined>(undefined);
  const DispatchContext = createContext<Dispatch<A> | undefined>(undefined);
  const StatusContext = createContext<StoreStatus | undefined>(undefined);

  function useRequired<T>(context: React.Context<T | undefined>, what: string): T {
    const value = useContext(context);
    if (value === undefined) {
      throw new Error(`${config.name}: ${what} was used outside its Provider`);
    }
    return value;
  }

  function Provider({ children }: { readonly children: ReactNode }): ReactNode {
    const { snapshot, runtime } = useStorageContext();
    const entry = snapshot.entries[config.key];

    // `useReducer`'s initialiser form, so `create` runs once rather than on every render. The
    // snapshot is already resolved by the time any store mounts (`StorageProvider` renders no
    // children until it is), so there is no "hydrating" state inside a store.
    const [state, dispatch] = useReducer(
      config.reducer,
      entry.value,
      config.create as (persisted: StorageValues[K]) => S,
    );

    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveBlocked, setSaveBlocked] = useState(false);

    const repository = useMemo(
      () => createRepository(STORAGE_DEFINITIONS[config.key], runtime),
      [runtime],
    );

    /**
     * The coalescing queue.
     *
     * `pending` holds the newest value to write; `inFlight` says whether a write is running. A
     * burst of dispatches — a user dragging a slider, or typing into a field — produces one write
     * per completed round trip rather than one per keystroke, and **the value written is always the
     * latest**, never an intermediate one that arrived out of order.
     */
    const pending = useRef<StorageValues[K] | null>(null);
    const inFlight = useRef(false);
    const mounted = useRef(true);
    useEffect(
      () => () => {
        mounted.current = false;
      },
      [],
    );

    const drain = useCallback(async (): Promise<void> => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      try {
        while (pending.current !== null) {
          const value = pending.current;
          pending.current = null;
          if (mounted.current) {
            setSaving(true);
          }
          try {
            await repository.set(value);
            if (mounted.current) {
              setSaveError(null);
              setSaveBlocked(false);
            }
          } catch (error) {
            if (!mounted.current) {
              return;
            }
            // The repository's own message, which is fixed and local by construction. A driver
            // string can quote the payload — and the payload here is a name and an allergy list.
            const blocked = isStorageWriteError(error) && error.reason === FAILURE_IS_BOUND;
            setSaveBlocked(blocked);
            setSaveError(
              error instanceof Error ? error.message : 'That change could not be saved.',
            );
            // Stop draining on failure: retrying the queue immediately would spin against a full
            // list or a dead driver. `retrySave` is the user's decision to try again.
            return;
          }
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) {
          setSaving(false);
        }
      }
    }, [repository]);

    const project = config.project;

    useEffect(() => {
      if (project === undefined) {
        return;
      }
      /**
       * **Never write over a key whose read status is `unavailable`** (TSD §6.3).
       *
       * The read failed, so what is on disk is unknown. Writing this session's defaults over it
       * would turn one transient driver failure into permanent loss of a real profile — and for the
       * `preferences` key that is the user's allergy list.
       */
      if (entry.status === 'unavailable') {
        return;
      }
      pending.current = project(state);
      void drain();
    }, [state, project, entry.status, drain]);

    const retrySave = useCallback(() => {
      if (project === undefined || entry.status === 'unavailable') {
        return;
      }
      pending.current = project(state);
      setSaveError(null);
      void drain();
    }, [project, entry.status, state, drain]);

    const status = useMemo<StoreStatus>(
      () => ({
        hydrated: true,
        entryStatus: entry.status,
        saving,
        saveError,
        saveBlocked,
        retrySave,
      }),
      [entry.status, saving, saveError, saveBlocked, retrySave],
    );

    return (
      <ValueContext.Provider value={state}>
        <DispatchContext.Provider value={dispatch}>
          <StatusContext.Provider value={status}>{children}</StatusContext.Provider>
        </DispatchContext.Provider>
      </ValueContext.Provider>
    );
  }

  return {
    Provider,
    useValue: () => useRequired(ValueContext, 'useValue'),
    useDispatch: () => useRequired(DispatchContext, 'useDispatch'),
    useStatus: () => useRequired(StatusContext, 'useStatus'),
  };
}
