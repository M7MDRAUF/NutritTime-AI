/**
 * The full reset (T-18-06, PRD FR-014 "resets all local data"): the one operation in this app
 * that destroys the user's data on purpose.
 *
 * **No document specifies the mechanism of a full reset.** FR-014 names the capability and
 * requires a confirmation; Plan §17's acceptance for T-18-06 is "All six keys cleared; app
 * returns to onboarding". The mechanism is plan-introduced, and this is its reasoning, because a
 * later reader will otherwise assume the obvious thing was tried first:
 *
 *  - The `onboarding` store deliberately has **no reset action** — its own docstring says why: an
 *    action that un-completes onboarding would be reachable from any screen holding a dispatch,
 *    and sending a user back through setup is a destructive action TSD §6.7 puts behind a
 *    confirmation. So the phase cannot be moved back by a dispatch, and this module does not try.
 *  - Clearing the keys alone is not enough either. The five stores hold their state in memory and
 *    would keep it, so the app would show pre-reset data over cleared storage until the next
 *    launch. `DataResetProvider` therefore unmounts the storage subtree, clears, and mounts a
 *    fresh one: hydration re-runs against cleared keys, every store re-creates from its own
 *    fallback, and the boot phase becomes `onboarding` because that is what a cleared
 *    `onboarding` key says.
 *
 * This half is the clearing, kept pure and free of React so that "every key, and the ledger, and
 * verified, and never a throw" is a `unit`-project test against the in-memory driver rather than
 * a device experiment.
 *
 * Four rules here are load-bearing rather than stylistic:
 *
 *  1. **The key list is iterated, never restated.** `STORAGE_KEY_NAMES` is the runtime witness
 *     that "six keys" is still six. A seventh key added to `definitions.ts` must be cleared by
 *     this function without anyone remembering to come back here — and the honest reading of
 *     T-18-06's "all six keys" is "all of them, whatever the number becomes".
 *  2. **It never throws, and it reports per key.** One key the driver refuses must not abandon
 *     the other five, because a partial reset that claims success is worse than one that names
 *     what survived: the user believes their allergy list is gone when it is not.
 *  3. **`onboarding` is cleared LAST, and only once everything else is gone.** See
 *     `clearAllStorage`. Removing the gate key early drops the user into setup with the data they
 *     asked to erase prefilled into the form, and moves the app to a phase in which its own
 *     failure message has no screen to render on.
 *  4. **The clear is VERIFIED against the disk, not against its own return values** — see
 *     `readSurvivors` and F-W7-RESET-1. A removal the driver accepted can be undone moments later
 *     by a store write that was already in flight when the reset began: that write belongs to a
 *     store instance the reset has discarded, so nothing sets state and nothing is logged, and the
 *     app shows every outward sign of a completed wipe while the user's declared allergy list sits
 *     back on disk.
 *
 * **What the verification covers, precisely, because it is a backstop and not the primary guard.**
 * The primary guard is in `createStore`: a store that has been unmounted must not enter
 * `repository.set` for a value it had merely queued. With that in place, what can still reach the
 * disk after a removal is a write that was **already inside** `repository.set` — its `setItem`
 * issued — at the moment the subtree was unmounted. The read-back catches such a write **only if
 * it lands before the last verification read of the pass group**. Under the in-memory driver every
 * removal and read resolves in a microtask, so the whole clear completes in far less time than a
 * real AsyncStorage write takes, and on a device a sufficiently slow pending write can settle
 * after the final read and survive. That case is open and reported; `DataResetProvider.dom.test.tsx`
 * carries it as an `it.fails` so the suite says so out loud rather than implying coverage.
 *
 * **There is deliberately no delay and no timeout.** Waiting out a pending write needs a duration
 * no document gives, which is BRIEF §8's stop condition and precisely why R-51 is recorded rather
 * than fixed. Verification needs no figure, and it answers the stronger question anyway — not "did
 * the removal return" but "is the data gone".
 */

import {
  QUARANTINE_KEY,
  STORAGE_DEFINITIONS,
  STORAGE_KEYS,
  STORAGE_KEY_NAMES,
} from '../../infrastructure/storage/definitions.js';
import type { StorageKeyName } from '../../infrastructure/storage/definitions.js';
import { createRepository } from '../../infrastructure/storage/repository.js';
import type { RepositoryRuntime } from '../../infrastructure/storage/repository.js';

/**
 * What a reset actually did, per set.
 *
 * **`cleared` and `failed` together do not always cover every set, and that is deliberate.** When
 * anything else survives, `onboarding` is never attempted — see `clearAllStorage` — so it belongs
 * in neither list: calling it cleared would be a lie, and calling it failed would name "setup
 * status" in a message about a removal that was never tried.
 */
export interface ResetOutcome {
  /** Storage KEY NAMES, not raw keys — a raw key is a storage detail and a `@`-prefixed string. */
  readonly cleared: readonly string[];
  readonly failed: readonly string[];
}

/**
 * The quarantine ledger, named alongside the six keys so the outcome can report on it.
 *
 * It is not a `StorageKeyName` — it has no definition, no schema and no store — which is exactly
 * why `ResetOutcome` is typed with `string[]` rather than `StorageKeyName[]`.
 */
export const QUARANTINE_SET_NAME = 'quarantine';

type ResetSetName = StorageKeyName | typeof QUARANTINE_SET_NAME;

/**
 * **The one key whose absence sends the app back to onboarding, and it is cleared LAST.**
 *
 * Typed as `StorageKeyName` rather than left as a bare string so that renaming the key in
 * `definitions.ts` is a compile error here instead of a silent return to the ordering this
 * comment exists to prevent.
 */
const ONBOARDING_SET: StorageKeyName = 'onboarding';

/**
 * Everything except `onboarding`: the remaining keys in hydration order, then the ledger.
 *
 * Still derived from `STORAGE_KEY_NAMES`, so a seventh key is cleared without anyone editing
 * this — it simply arrives in the filter's output.
 */
const DATA_SETS: readonly ResetSetName[] = [
  ...STORAGE_KEY_NAMES.filter((name) => name !== ONBOARDING_SET),
  QUARANTINE_SET_NAME,
];

/**
 * How many remove-and-verify passes before a surviving key is reported as failed.
 *
 * **Plan-introduced, and it is a bound rather than a threshold.** One pass cannot see a write that
 * lands during it; the second pass is what removes a key the first pass's read-back caught coming
 * back. A third exists because the stores are unmounted before the clear, so the number of writes
 * that can still land is finite and small — a key present after three passes is a driver refusing,
 * not a race, and saying so is more useful than trying a fourth time.
 *
 * It deliberately is NOT a delay. A delay needs a figure no document gives (BRIEF §8), and a key
 * that reappears is an observation, not an interval to be waited out.
 */
export const RESET_ATTEMPTS = 3;

/**
 * What each set is called in front of the user, for the one message this module produces.
 *
 * **Typed exhaustively on purpose**: a seventh storage key is a compile error here, which is the
 * compile-time half of the runtime iteration above. The clearing would already cover a new key;
 * this makes sure the failure message can name it rather than falling back to its code name.
 *
 * The labels are what the user would call these things, not what the code calls them: nobody has
 * a "meta key", and what `meta` holds is a record of launches.
 */
const SET_LABELS: Readonly<Record<ResetSetName, string>> = {
  meta: 'launch history',
  onboarding: 'setup status',
  preferences: 'your preferences',
  favorites: 'favourites',
  customMeals: 'your own meals',
  ui: 'app settings',
  [QUARANTINE_SET_NAME]: 'recovered data',
};

/**
 * The same table, read by a plain `string`.
 *
 * A widening assignment rather than an `as`: `ResetOutcome.failed` is `string[]` (it carries the
 * ledger, which is not a key name), and indexing the exhaustive record with a `string` needs an
 * index signature. Assigning to one keeps `SET_LABELS` exhaustively checked above while making a
 * miss here `undefined` rather than a type error to be silenced.
 */
const LABEL_BY_NAME: Readonly<Record<string, string | undefined>> = SET_LABELS;

/** The raw storage key behind a set name. The ledger is the one that is not in `STORAGE_KEYS`. */
function rawKeyOf(name: ResetSetName): string {
  return name === QUARANTINE_SET_NAME ? QUARANTINE_KEY : STORAGE_KEYS[name];
}

/**
 * One key's removal, through its own repository, with its failure contained.
 *
 * Generic over the key name rather than taking the union, so `STORAGE_DEFINITIONS[name]` stays
 * `RepositoryDefinition<StorageValues[K]>` and `createRepository` needs no assertion to infer it.
 *
 * `Repository.clear` is the right seam even though clearing reads nothing: it is the same call
 * the rest of the app uses, so a future definition-level concern is honoured here automatically
 * instead of being bypassed by a raw `removeItem` against a key spelled out a second time.
 */
async function clearOne<K extends StorageKeyName>(
  name: K,
  runtime: RepositoryRuntime,
): Promise<boolean> {
  try {
    await createRepository(STORAGE_DEFINITIONS[name], runtime).clear();
    return true;
  } catch {
    // The `StorageWriteError` is deliberately not inspected and not logged. Its own message is
    // fixed and local, but the caller's message is built from the NAMES of the sets that
    // survived — never from an exception's text, which PRD §15.5 keeps away from a user and a log
    // line alike, because a driver string can quote the payload.
    return false;
  }
}

/**
 * Remove one set. **The ledger is cleared too, and no document asks for it.**
 *
 * A quarantine record holds the raw bytes of a value that failed its schema, and a rejected value
 * is still the user's data: an allergy list that did not parse is an allergy list. "Resets all
 * local data" means it. Leaving it behind would keep the one payload the user is least likely to
 * know exists, after they asked for everything to go — the worse error by a long way. Removed
 * straight through the driver, because the ledger has no `RepositoryDefinition`.
 */
async function removeSet(name: ResetSetName, runtime: RepositoryRuntime): Promise<boolean> {
  if (name === QUARANTINE_SET_NAME) {
    try {
      await runtime.driver.removeItem(QUARANTINE_KEY);
      return true;
    } catch {
      return false;
    }
  }
  return clearOne(name, runtime);
}

/**
 * Which sets are still on the disk, or `null` when the disk could not be read.
 *
 * One `multiGet` over every set, not only the ones whose removal was refused — the case this
 * exists for is a key whose removal SUCCEEDED and which came back afterwards, and a read scoped to
 * the refusals would never look at it.
 *
 * `null` rather than an empty set when the read fails, because "nothing survived" and "I could not
 * look" are different answers and the caller treats them differently: it is the same distinction
 * `EntryStatus` draws between `default` and `unavailable` (TSD §6.4), for the same reason.
 */
async function readSurvivors(
  runtime: RepositoryRuntime,
  names: readonly ResetSetName[],
): Promise<ReadonlySet<ResetSetName> | null> {
  try {
    const pairs = await runtime.driver.multiGet(names.map(rawKeyOf));
    const stored = new Map<string, string | null>(pairs.map(([key, value]) => [key, value]));
    return new Set(names.filter((name) => (stored.get(rawKeyOf(name)) ?? null) !== null));
  } catch {
    return null;
  }
}

interface PassResult {
  readonly cleared: readonly ResetSetName[];
  readonly failed: readonly ResetSetName[];
}

/**
 * Remove one group of sets and **verify it**, up to `RESET_ATTEMPTS` passes. Never rejects.
 *
 * Each pass removes what is outstanding and then reads the disk back. What the disk says wins:
 * a removal the driver refused for a key that is not there anyway is not worth alarming the user
 * about, and a removal the driver accepted for a key that is there again is the defect this
 * verification exists to catch. When the read itself fails there is no disk answer to defer to, so
 * the removals' own verdict stands.
 *
 * Sequential rather than `Promise.allSettled`: the order of `cleared` and `failed` then follows the
 * group's own order, so the failure message is deterministic, and seven awaited removals on a
 * user-initiated action cost nothing worth parallelising.
 */
async function clearSets(
  runtime: RepositoryRuntime,
  sets: readonly ResetSetName[],
): Promise<PassResult> {
  let outstanding: readonly ResetSetName[] = sets;

  for (let attempt = 0; attempt < RESET_ATTEMPTS; attempt += 1) {
    const refused = new Set<ResetSetName>();
    for (const name of outstanding) {
      if (!(await removeSet(name, runtime))) {
        refused.add(name);
      }
    }

    // Every set in the group, not only the refusals: the case this exists for is a key whose
    // removal SUCCEEDED and which is back, and a read scoped to the refusals would never see it.
    const survivors = await readSurvivors(runtime, sets);
    outstanding = sets.filter((name) =>
      survivors === null ? refused.has(name) : survivors.has(name),
    );
    if (outstanding.length === 0) {
      return { cleared: sets, failed: [] };
    }
  }

  const failed = outstanding;
  return { cleared: sets.filter((name) => !failed.includes(name)), failed };
}

/**
 * Clear every key this app owns, plus the quarantine ledger. **Never rejects.**
 *
 * **`onboarding` is cleared last, and only when everything else is already gone. That ordering is
 * load-bearing — do not tidy it back into one list.** Two things go wrong when the gate key is
 * removed early, and both were found by adversarial review of an earlier version that cleared it
 * second, in hydration order:
 *
 *  1. **The user is dropped into setup with the data they just asked to erase, prefilled.** An
 *     absent `onboarding` key puts the app in the `onboarding` phase; if `preferences` survived
 *     the clear, `DietarySetupScreen` then hydrates from it and shows the user their own name,
 *     diet and allergy list back — inside the flow that exists to collect them for the first time.
 *     That is the worst single outcome this module can produce.
 *  2. **The failure message becomes unreadable at the exact moment it fires.** `resetError` is
 *     rendered by `SettingsScreen`, and `RootNavigator` does not register Settings in the
 *     `onboarding` phase — so a partial failure that advanced the phase would move the app to a
 *     tree with no surface for its own error. Leaving `onboarding` alone keeps the app in the
 *     `app` phase, where Settings exists and the user can read what survived and try again.
 *
 * So a partial failure leaves a usable, still-set-up app that names what it could not remove, and
 * the phase only advances once there is nothing left to prefill a form with.
 */
export async function clearAllStorage(runtime: RepositoryRuntime): Promise<ResetOutcome> {
  const data = await clearSets(runtime, DATA_SETS);
  if (data.failed.length > 0) {
    // `onboarding` is deliberately NOT attempted — see above. It appears in neither list.
    return { cleared: [...data.cleared], failed: [...data.failed] };
  }
  const gate = await clearSets(runtime, [ONBOARDING_SET]);
  return { cleared: [...data.cleared, ...gate.cleared], failed: [...gate.failed] };
}

/** `a`, `a and b`, `a, b and c` — so a two-item list does not read as a fragment. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1] ?? ''}`;
}

/**
 * The user-facing account of a reset, or `null` when everything went.
 *
 * **Fixed local copy, assembled only from set labels** (PRD §15.5). PRD §12's three parts are all
 * present — what happened, what still works, what to do next — because a user who asked for their
 * data to be destroyed needs to know precisely what was not.
 */
export function describeResetFailure(outcome: ResetOutcome): string | null {
  if (outcome.failed.length === 0) {
    return null;
  }
  const labels = outcome.failed.map((name) => LABEL_BY_NAME[name] ?? name);
  return `Some data could not be cleared: ${joinLabels(labels)}. Everything else was reset and the app still works. Try the reset again, or restart the app and try once more.`;
}
