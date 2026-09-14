import { describe, expect, it } from 'vitest';
import { memoryDriver, callsOf } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import type { MemoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import {
  DEFAULT_PREFERENCES,
  QUARANTINE_KEY,
  STORAGE_KEYS,
  STORAGE_KEY_NAMES,
  STORAGE_SCHEMA_VERSION,
} from '../../infrastructure/storage/definitions.js';
import {
  buildQuarantineRecord,
  encodeEnvelope,
  encodeQuarantineLedger,
} from '../../infrastructure/storage/envelope.js';
import type { RepositoryRuntime } from '../../infrastructure/storage/repository.js';
import {
  QUARANTINE_SET_NAME,
  RESET_ATTEMPTS,
  clearAllStorage,
  describeResetFailure,
} from './resetData.js';

/**
 * The destructive path's own suite. Every assertion here answers one question: after this runs,
 * is the data actually gone, and does the outcome tell the truth about what is not?
 *
 * The one thing this file deliberately does NOT do is write down six key names and check for
 * them. T-18-06's acceptance says "all six keys"; the honest reading is "all of them, whatever
 * the number becomes", so every expectation below is DERIVED from `STORAGE_KEY_NAMES`. A seventh
 * key added to `definitions.ts` and not cleared fails these tests without anyone editing them,
 * which is the whole reason `clearAllStorage` iterates instead of listing.
 */

const AT = '2026-09-13T12:00:00.000Z';
const CLOCK = (): string => AT;

/** A marker standing in for the kind of thing the preferences key really holds. */
const ALLERGY = 'peanut';

/**
 * Every key this build owns, carrying bytes, plus a ledger holding a rejected payload.
 *
 * Seeded through `STORAGE_KEY_NAMES` rather than key by key, so the fixture grows with the key
 * list too — a seventh key would arrive here already populated, and the removal assertions would
 * then be the only thing that could fail.
 */
function seededDriver(): MemoryDriver {
  const driver = memoryDriver({});
  for (const name of STORAGE_KEY_NAMES) {
    driver.store.set(
      STORAGE_KEYS[name],
      encodeEnvelope(STORAGE_SCHEMA_VERSION, { seeded: name }, AT),
    );
  }
  // The one realistic record, because "the user's data is gone" is the claim being made and an
  // allergy list is the value that matters most. Overwrites the generic seed above.
  driver.store.set(
    STORAGE_KEYS.preferences,
    encodeEnvelope(
      STORAGE_SCHEMA_VERSION,
      { ...DEFAULT_PREFERENCES, diet: 'vegan', allergies: [ALLERGY] },
      AT,
    ),
  );
  // A quarantined preferences payload: a value that failed its schema, which is still an allergy
  // list. `decodeQuarantineLedger` would read this back on the next launch.
  driver.store.set(
    QUARANTINE_KEY,
    encodeQuarantineLedger(
      {
        records: [
          buildQuarantineRecord(
            STORAGE_KEYS.preferences,
            'schema-invalid',
            STORAGE_SCHEMA_VERSION,
            `{"diet":"vegan","allergies":["${ALLERGY}"],"goal":null}`,
            AT,
          ),
        ],
      },
      AT,
    ),
  );
  return driver;
}

function runtimeFor(driver: MemoryDriver): RepositoryRuntime {
  return { driver, now: CLOCK };
}

/**
 * A driver that refuses ONE key's removal, by rejection.
 *
 * `MemoryDriver.failOn` is per method, not per key, so it cannot express "five keys clear and the
 * sixth does not" — which is the case that decides whether a partial failure abandons the rest.
 * Written here rather than added to the shared fixture: `__fixtures__/memoryDriver.ts` belongs to
 * the storage layer and is outside this task's write allowlist.
 */
function refusingRemovalOf(driver: MemoryDriver, refused: string): MemoryDriver {
  return {
    ...driver,
    removeItem(key: string): Promise<void> {
      if (key === refused) {
        // Recorded before refusing, so "the call was attempted" stays assertable — the shared
        // fixture's own convention.
        driver.calls.push(`removeItem:${key}`);
        return Promise.reject(new Error(`driver refused removeItem for ${key}`));
      }
      return driver.removeItem(key);
    },
  };
}

describe('clearAllStorage', () => {
  it('removes every key `STORAGE_KEY_NAMES` declares, plus the ledger, and nothing else', async () => {
    const driver = seededDriver();

    const outcome = await clearAllStorage(runtimeFor(driver));

    /**
     * Built from the key list itself: this is the assertion that fails if a seventh key is added
     * to `definitions.ts` and not cleared — the expected set grows and the removals do not.
     *
     * Compared as SETS, because the order is a separate claim with its own test below; one ordered
     * array would conflate "covers everything" with "in this sequence".
     */
    const expected = new Set([
      ...STORAGE_KEY_NAMES.map((name) => STORAGE_KEYS[name]),
      QUARANTINE_KEY,
    ]);
    expect(new Set(callsOf(driver, 'removeItem'))).toEqual(expected);
    expect(new Set(outcome.cleared)).toEqual(new Set([...STORAGE_KEY_NAMES, QUARANTINE_SET_NAME]));
    expect(outcome.failed).toEqual([]);
    // And the bytes are actually gone, not merely asked about.
    expect([...driver.store.keys()]).toEqual([]);
  });

  it('clears `onboarding` last of all, after every other key and after the ledger', async () => {
    /**
     * The ordering is load-bearing, so it is asserted rather than left to the constant's shape.
     * An absent `onboarding` key is what puts the app in the `onboarding` phase, and it must not
     * become absent while anything remains that could prefill the setup form — nor while the app
     * still needs Settings mounted to render the failure message.
     */
    const driver = seededDriver();

    await clearAllStorage(runtimeFor(driver));

    const removals = callsOf(driver, 'removeItem');
    expect(removals.at(-1)).toBe(STORAGE_KEYS.onboarding);
    // Not merely last: after every other set, with nothing interleaved behind it.
    expect(removals.indexOf(STORAGE_KEYS.onboarding)).toBe(removals.length - 1);
    expect(removals.indexOf(QUARANTINE_KEY)).toBeLessThan(
      removals.indexOf(STORAGE_KEYS.onboarding),
    );
  });

  it('leaves no trace of the allergy list, in the live key or the ledger', async () => {
    /**
     * The quarantine ledger is user data. A value that failed its schema is still the value the
     * user typed, and no document mentions the ledger in the context of reset — so this is the
     * assertion that pins the judgement down. `store.values()` is read as one string, because
     * "gone from everywhere" is the claim and naming the two keys separately would miss a third.
     */
    const driver = seededDriver();
    expect([...driver.store.values()].join('|')).toContain(ALLERGY);

    await clearAllStorage(runtimeFor(driver));

    expect([...driver.store.values()].join('|')).not.toContain(ALLERGY);
    expect(driver.store.has(QUARANTINE_KEY)).toBe(false);
    expect(callsOf(driver, 'removeItem')).toContain(QUARANTINE_KEY);
  });

  it('clears the others when one key refuses, and names the one that survived', async () => {
    const base = seededDriver();
    const driver = refusingRemovalOf(base, STORAGE_KEYS.preferences);

    const outcome = await clearAllStorage(runtimeFor(driver));

    // The refusal did not abandon the rest: every other DATA key is gone, derived from the key
    // list. `onboarding` is absent from `cleared` because it was never attempted — see below.
    const others = STORAGE_KEY_NAMES.filter(
      (name) => name !== 'preferences' && name !== 'onboarding',
    );
    expect(outcome.cleared).toEqual([...others, QUARANTINE_SET_NAME]);
    expect(outcome.failed).toEqual(['preferences']);
    // Attempted for every data key in the first pass — the loop does not stop at the failure.
    const firstPass = [
      ...STORAGE_KEY_NAMES.filter((name) => name !== 'onboarding').map(
        (name) => STORAGE_KEYS[name],
      ),
      QUARANTINE_KEY,
    ];
    expect(callsOf(driver, 'removeItem').slice(0, firstPass.length)).toEqual(firstPass);
    // And the one that refused was retried, a bounded number of times.
    expect(
      callsOf(driver, 'removeItem').filter((key) => key === STORAGE_KEYS.preferences),
    ).toHaveLength(RESET_ATTEMPTS);
  });

  it('leaves `onboarding` intact when anything else survives, so setup cannot prefill it', async () => {
    /**
     * The consequence the ordering exists to prevent, at the level a user would feel it.
     *
     * `preferences` refuses. Clearing `onboarding` anyway — as an earlier version did, having it
     * second in hydration order — moves the app to the `onboarding` phase, where
     * `DietarySetupScreen` hydrates from the surviving key and shows the user their own diet and
     * allergy list inside the flow that exists to collect them for the first time; and where
     * `SettingsScreen` is not registered, so the `resetError` naming the survivor has nowhere to
     * render. So the gate key is still on disk, and was never even asked about.
     */
    const base = seededDriver();
    const driver = refusingRemovalOf(base, STORAGE_KEYS.preferences);

    const outcome = await clearAllStorage(runtimeFor(driver));

    expect(base.store.has(STORAGE_KEYS.onboarding)).toBe(true);
    expect(callsOf(driver, 'removeItem')).not.toContain(STORAGE_KEYS.onboarding);
    // Neither cleared nor failed: it was not attempted, and saying either would be untrue.
    expect(outcome.cleared).not.toContain('onboarding');
    expect(outcome.failed).not.toContain('onboarding');
    // The message names the survivor and nothing else.
    expect(describeResetFailure(outcome)).toContain('your preferences');
    expect(describeResetFailure(outcome)).not.toContain('setup status');
  });

  it('clears a key again when a write puts it back, rather than trusting the removal', async () => {
    /**
     * F-W7-RESET-1's containment, as a unit test. A removal the driver ACCEPTED is undone
     * immediately afterwards by a write that was already in flight when the reset began — the
     * write belongs to a store instance the provider has already discarded, so nothing reports
     * it. A `clearAllStorage` that trusted its own return values would report total success while
     * the user's allergy list sat back on disk.
     *
     * The resurrection happens exactly once, which is the realistic shape: the number of writes
     * that can still land is finite, because the stores are unmounted before the clear.
     */
    const base = seededDriver();
    let resurrections = 0;
    const racing: MemoryDriver = {
      ...base,
      async removeItem(key: string): Promise<void> {
        await base.removeItem(key);
        if (key === STORAGE_KEYS.preferences && resurrections === 0) {
          resurrections += 1;
          base.store.set(STORAGE_KEYS.preferences, `{"allergies":["${ALLERGY}"]}`);
        }
      },
    };

    const outcome = await clearAllStorage(runtimeFor(racing));

    expect(outcome.failed).toEqual([]);
    expect(new Set(outcome.cleared)).toEqual(new Set([...STORAGE_KEY_NAMES, QUARANTINE_SET_NAME]));
    // The gate key is still reported last, because the resurrection did not stop the data pass
    // from completing — a resurrected key that was NOT recovered would hold `onboarding` back.
    expect(outcome.cleared.at(-1)).toBe('onboarding');
    expect([...base.store.keys()]).toEqual([]);
    expect([...base.store.values()].join('|')).not.toContain(ALLERGY);
    // Two passes over that key: one that was undone, one that stuck.
    expect(
      callsOf(racing, 'removeItem').filter((key) => key === STORAGE_KEYS.preferences),
    ).toHaveLength(2);
  });

  it('gives up after a bounded number of passes on a key that always comes back', async () => {
    /**
     * The other end of the same mechanism: a key that reappears after EVERY removal must not spin
     * forever, and must be named. A driver behaving this way is refusing, not racing — and saying
     * so is more useful to the user than a fourth attempt.
     */
    const base = seededDriver();
    const immortal: MemoryDriver = {
      ...base,
      async removeItem(key: string): Promise<void> {
        await base.removeItem(key);
        if (key === STORAGE_KEYS.preferences) {
          base.store.set(STORAGE_KEYS.preferences, `{"allergies":["${ALLERGY}"]}`);
        }
      },
    };

    const outcome = await clearAllStorage(runtimeFor(immortal));

    expect(outcome.failed).toEqual(['preferences']);
    expect(describeResetFailure(outcome)).toContain('your preferences');
    expect(
      callsOf(immortal, 'removeItem').filter((key) => key === STORAGE_KEYS.preferences),
    ).toHaveLength(RESET_ATTEMPTS);
    // Bounded overall, not only per key: one verification read per pass, at most.
    expect(base.multiGetKeys.length).toBeLessThanOrEqual(RESET_ATTEMPTS);
  });

  it('falls back to the removals when the verification read itself fails', async () => {
    /**
     * "Nothing survived" and "I could not look" are different answers, and this pins which one is
     * reported. A driver that removed everything but cannot be read back has told us all it can,
     * and naming six sets in a failure message on the strength of an unreadable `multiGet` would
     * be alarming the user about data that is in fact gone. It is the same distinction
     * `EntryStatus` draws between `default` and `unavailable`.
     */
    const driver = seededDriver();
    driver.failOn.add('multiGet');

    const outcome = await clearAllStorage(runtimeFor(driver));

    expect(outcome.failed).toEqual([]);
    expect(describeResetFailure(outcome)).toBeNull();
    // And it really did remove them, which is what makes trusting the removals defensible here.
    expect([...driver.store.keys()]).toEqual([]);
  });

  it('survives a driver that throws synchronously on every removal', async () => {
    /**
     * The synchronous throw, not the rejection. `hydrate.ts` records this exact lesson in bold: a
     * driver that throws before returning a promise defeated a `Promise.allSettled` and bricked
     * the launch. `memoryDriver.failOn` throws from inside the method body, which is that shape.
     */
    const driver = seededDriver();
    driver.failOn.add('removeItem');

    const outcome = await clearAllStorage(runtimeFor(driver));

    expect(outcome.cleared).toEqual([]);
    expect(outcome.failed).toEqual([
      ...STORAGE_KEY_NAMES.filter((name) => name !== 'onboarding'),
      QUARANTINE_SET_NAME,
    ]);
    // Nothing was destroyed, which is the right outcome for a driver that cannot be written — and
    // the app stays set up rather than landing in setup on top of all of its own data.
    expect(driver.store.size).toBe(STORAGE_KEY_NAMES.length + 1);
    expect(driver.store.has(STORAGE_KEYS.onboarding)).toBe(true);
  });
});

describe('describeResetFailure', () => {
  it('is null when everything cleared, so success says nothing', async () => {
    const outcome = await clearAllStorage(runtimeFor(seededDriver()));
    expect(describeResetFailure(outcome)).toBeNull();
  });

  it('names the sets that survived in fixed local copy, quoting no driver string', async () => {
    /**
     * PRD §12. The memory driver's text is harmless, but a real driver's message can quote the
     * payload — and this payload is a name and an allergy list. The message must be assembled
     * from set names only.
     */
    const base = seededDriver();
    const driver = refusingRemovalOf(base, STORAGE_KEYS.preferences);
    const message = describeResetFailure(await clearAllStorage(runtimeFor(driver)));

    expect(message).not.toBeNull();
    expect(message).toContain('your preferences');
    expect(message).not.toContain('driver refused');
    expect(message).not.toContain(STORAGE_KEYS.preferences);
    expect(message).not.toContain('preferences/v1');
    // PRD §12: what happened, what still works, what to do next.
    expect(message).toContain('could not be cleared');
    expect(message).toContain('Everything else was reset');
    expect(message).toContain('Try the reset again');
  });

  it('reads as a sentence for two survivors rather than a comma-spliced fragment', () => {
    // Copy, checked because the joiner is the kind of thing that ships as "a, b." and nobody
    // reads it again.
    const message = describeResetFailure({ cleared: [], failed: ['favorites', 'customMeals'] });
    expect(message).toContain('favourites and your own meals');
  });

  it('has a user-facing label for every set it can report, including the ledger', () => {
    /**
     * The labels are typed exhaustively over `StorageKeyName`, so a missing one is a compile
     * error — but a compile error is not evidence at runtime, and `failed` is `string[]`. This
     * proves no reportable set falls through to its code name, which is what a user would see.
     */
    for (const name of [...STORAGE_KEY_NAMES, QUARANTINE_SET_NAME]) {
      const message = describeResetFailure({ cleared: [], failed: [name] });
      expect(message).not.toBeNull();
      expect(message).not.toContain(`cleared: ${name}.`);
    }
  });
});
