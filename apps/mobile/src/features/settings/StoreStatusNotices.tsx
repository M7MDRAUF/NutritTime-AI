/**
 * What a store's save state looks like to a user, for the stores Settings clears.
 *
 * **A dispatch is not a write, and that gap is the defect this component exists to close.**
 * `createStore`'s queue writes after the reducer has already run, so a confirmed clear empties the
 * list on screen from the dispatch alone; if the write is then refused, every favourite is back at
 * the next launch. Silently — the store that failed is the only thing that knows. And a key whose
 * read was `unavailable` is never written over at all (TSD §6.3, deliberately: the stored bytes are
 * unknown and a default written over a real profile is permanent loss), so a clear dispatched
 * against one destroys nothing on the device. Telling the user it worked is the same lie twice.
 *
 * Two rules are load-bearing rather than stylistic:
 *
 *  1. **A retry is offered where retrying can succeed and withheld where it cannot.** A refused
 *     write can succeed on a second attempt; a bound refusal never can (TSD §6.4: "retrying the
 *     same value can never succeed"), and a retry button for something that will always refuse is a
 *     lie in the interface. `saveBlocked` is the difference and the store already computes it.
 *  2. **`description` is the store's own message, never an exception's.** `createStore` narrows to
 *     `StorageWriteError` before reading `.message` precisely because a driver or library string can
 *     quote the payload, and the payload here is a name and an allergy list (PRD §12).
 *
 * **This is the THIRD copy of this mapping in the app** — `DietarySetupScreen` and
 * `MealFormScreen` each hand-roll their own — and the duplication is what lets two screens disagree
 * about whether a failed write was reported at all. The shared home is not `shared/components/`
 * (TSD §6.7 fixes that inventory at sixteen) but beside `StoreStatus` in `state/`, where the type
 * is defined. Consolidating it touches two other feature slices and P14's, so it is recorded as a
 * follow-up rather than done here; this component is deliberately local until then.
 *
 * Props only — no store access, no dispatch — which is what makes every branch testable by passing
 * a status in.
 */

import type { ReactNode } from 'react';
import { StatusMessage } from '../../shared/components/index.js';
import type { StoreStatus } from '../../state/createStore.js';
import { SAVE_FAILED_TITLES, SET_LABELS, joinSets } from './settingsCopy.js';
import type { ClearableId } from './settingsCopy.js';

export interface StoreStatusNoticesProps {
  /** One entry per store the screen can clear, in the order the notices should appear. */
  readonly statuses: readonly { readonly id: ClearableId; readonly status: StoreStatus }[];
}

export function StoreStatusNotices({ statuses }: StoreStatusNoticesProps): ReactNode {
  const unreadable = statuses.filter(({ status }) => status.entryStatus === 'unavailable');

  return (
    <>
      {statuses.map(({ id, status }) =>
        status.saveError === null ? null : (
          <StatusMessage
            key={id}
            testID={`settings-save-error-${id}`}
            tone="danger"
            icon="alertCircle"
            title={status.saveBlocked ? 'That list is full' : SAVE_FAILED_TITLES[id]}
            description={status.saveError}
            stillAvailable="Your other data is unchanged and the app still works. Until this saves, what you see here may differ from what is stored on this device."
            {...(status.saveBlocked
              ? {}
              : { actionLabel: 'Try again', onAction: status.retrySave })}
            announceOnMount
          />
        ),
      )}

      {/* One notice for all of them, not one each: a single failed `multiGet` puts every key in
          this state at once, and three identical warnings are three times the noise and no more
          information. The sets are named inside it instead.

          **`announceOnMount`, for the same reason the save-error notices above carry it.** This
          one says the clear buttons below it will not reach the device: an `unavailable` key is
          never written over (TSD 6.3), so a clear empties the list on screen and leaves the
          stored copy intact, and a user who cannot see the amber panel would press Clear and be
          told it worked. `entryStatus` is read off the boot hydration snapshot, which
          `StorageProvider` builds once and never updates, so this branch cannot appear or
          disappear from a state change - it mounts with the Settings tab and `role="alert"` is
          spoken on that insertion rather than on every render. */}
      {unreadable.length === 0 ? null : (
        <StatusMessage
          testID="settings-unavailable"
          tone="warning"
          icon="warning"
          title="Changes will not be kept"
          description={`These could not be read on this device, so nothing is written over them: ${joinSets(unreadable.map(({ id }) => SET_LABELS[id]))}. What you change or clear here applies until you close the app.`}
          announceOnMount
        />
      )}
    </>
  );
}
