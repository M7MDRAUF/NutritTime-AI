import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom';
import { BUDGET_BANDS, DIET_TAGS, NUTRITION_GOALS } from '@nutritime/contracts';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { onboardingStore } from '../../state/onboarding/index.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { DEFAULT_PREFERENCES, STORAGE_KEYS } from '../../infrastructure/storage/definitions.js';
import { encodeEnvelope } from '../../infrastructure/storage/envelope.js';
import type { StorageDriver } from '../../infrastructure/storage/repository.js';
import { DietarySetupScreen } from './DietarySetupScreen.js';
import { VALIDATION_MESSAGES } from './dietaryValidation.js';

/**
 * T-14-04 and T-14-05, through the real store and a memory driver.
 *
 * Rendered against `StorageProvider` rather than a stubbed context, so what these tests exercise is
 * the path the app takes: one `multiGet`, a store created from its slice, a dispatch, and a write
 * through the coalescing queue. A screen tested against a fake store would prove the JSX and nothing
 * about whether an allergy survives being chosen.
 */

const CLOCK = () => '2026-09-13T12:00:00.000Z';

interface Harness {
  readonly host: HTMLElement;
  readonly driver: ReturnType<typeof memoryDriver>;
  find(testID: string): HTMLElement | null;
  must(testID: string): HTMLElement;
  text(): string;
  /** Let hydration resolve and the queue drain. */
  settle(): Promise<void>;
}

async function render(driver: StorageDriver & { store: Map<string, string> }): Promise<Harness> {
  const host = document.createElement('div');
  document.body.appendChild(host);

  const tree: ReactNode = (
    <ThemeProvider mode="light" deviceScheme={null} fontScale={1}>
      <StorageProvider runtime={{ driver, now: CLOCK }}>
        <preferencesStore.Provider>
          <onboardingStore.Provider>
            <DietarySetupScreen
              route={{ key: 'd', name: 'DietarySetup', params: undefined } as never}
              navigation={{ goBack: () => undefined } as never}
            />
          </onboardingStore.Provider>
        </preferencesStore.Provider>
      </StorageProvider>
    </ThemeProvider>
  );

  await act(async () => {
    createRoot(host).render(tree);
  });

  const find = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    host,
    driver: driver as ReturnType<typeof memoryDriver>,
    find,
    must: (testID) => {
      const found = find(testID);
      if (found === null) {
        throw new Error(`no element for testID ${testID}`);
      }
      return found;
    },
    text: () => host.textContent ?? '',
    settle: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function press(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function inputIn(container: HTMLElement): HTMLElement {
  const found = container.querySelector('input, textarea');
  if (!(found instanceof HTMLElement)) {
    throw new Error('no input rendered');
  }
  return found;
}

/**
 * A real focus then a real blur, which is what `FormField`'s own suite does.
 *
 * `fireEvent.blur` dispatches a `blur` event that does not bubble and fires on an element that was
 * never focused, so react-native-web's `TextInput` never sees it — the first version of these tests
 * used it and every blur-time assertion failed with the field rendering only its label.
 */
function blurField(target: HTMLElement): void {
  act(() => {
    target.focus();
  });
  act(() => {
    target.blur();
  });
}

describe('DietarySetupScreen', () => {
  it('offers every canonical allergen as a checkbox and no text box for one', async () => {
    /**
     * **R-30's containment, asserted.** A text box here would let a user type `cilantro`, which the
     * matcher cannot act on — protection that looks exactly like protection and provides none. The
     * count is checked too: a list that silently lost an allergen would leave a real allergy
     * unofferable.
     */
    const view = await render(memoryDriver({}));

    const allergies = view.must('field-allergies');
    const boxes = queryAllByRole(allergies, 'checkbox');
    expect(boxes).toHaveLength(10);
    for (const allergen of [
      'peanut',
      'tree-nut',
      'milk',
      'egg',
      'soy',
      'wheat',
      'gluten',
      'fish',
      'shellfish',
      'sesame',
    ]) {
      expect(view.find(`chip-allergy-${allergen}`), allergen).not.toBeNull();
    }
    // And nothing inside the allergy group accepts free text.
    expect(allergies.querySelector('input, textarea')).toBeNull();
  });

  it('persists a chosen allergy through the store to the driver', async () => {
    const view = await render(memoryDriver({}));

    press(view.must('chip-allergy-peanut'));
    await view.settle();

    // Read back from the DRIVER, not from the store: the claim is that it was written.
    const written = view.driver.store.get(STORAGE_KEYS.preferences);
    expect(written).toBeDefined();
    expect(JSON.parse(written ?? '{}')).toMatchObject({
      value: { allergies: ['peanut'] },
    });
  });

  it('announces a chosen allergy as checked, on both platforms', async () => {
    // react-native-web maps `accessibilityState` to nothing (R-34), so `Chip` sets both spellings.
    // This asserts the web one, which is what a screen reader in a browser reads.
    const view = await render(memoryDriver({}));
    const chip = view.must('chip-allergy-milk');
    expect(chip.getAttribute('aria-checked')).toBe('false');
    press(chip);
    expect(view.must('chip-allergy-milk').getAttribute('aria-checked')).toBe('true');
  });

  it('shows no error for a meal time the user has not touched', async () => {
    // The whole of "validate on blur". Every default is valid, so this also proves the screen does
    // not open in an error state - which would be the first thing a new user saw.
    const view = await render(memoryDriver({}));
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockFormat);
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockEmpty);
  });

  it('does not complain mid-keystroke, and complains on blur', async () => {
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-breakfast'));

    act(() => {
      fireEvent.change(field, { target: { value: '08:' } });
    });
    // `08:` is not a wrong time, it is an unfinished one. Telling someone they are wrong while they
    // are still typing is how a form becomes hostile.
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockFormat);

    blurField(field);
    expect(view.text()).toContain(VALIDATION_MESSAGES.clockFormat);
  });

  it('clears the error on the next keystroke once it has been shown', async () => {
    // After an error is visible, a correction must forgive immediately - not make the user leave
    // the field a second time to find out they have fixed it.
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-breakfast'));

    act(() => {
      fireEvent.change(field, { target: { value: '08:' } });
    });
    blurField(field);
    expect(view.text()).toContain(VALIDATION_MESSAGES.clockFormat);

    act(() => {
      fireEvent.change(field, { target: { value: '08:15' } });
    });
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockFormat);
  });

  it('binds the error to the field that has it', async () => {
    const view = await render(memoryDriver({}));
    const lunch = inputIn(view.must('field-lunch'));
    act(() => {
      fireEvent.change(lunch, { target: { value: 'noon' } });
    });
    blurField(lunch);

    // Inside the lunch field, and nowhere near breakfast or dinner.
    expect(view.must('field-lunch').textContent ?? '').toContain(VALIDATION_MESSAGES.clockFormat);
    expect(view.must('field-breakfast').textContent ?? '').not.toContain(
      VALIDATION_MESSAGES.clockFormat,
    );
    expect(view.must('field-dinner').textContent ?? '').not.toContain(
      VALIDATION_MESSAGES.clockFormat,
    );
  });

  it('announces the error as an alert', async () => {
    // Plan §14.2 adopted the alert role for errors specifically (S-25).
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-dinner'));
    act(() => {
      fireEvent.change(field, { target: { value: 'x' } });
    });
    blurField(field);
    expect(getByRole(view.must('field-dinner'), 'alert')).toBeTruthy();
  });

  it('reveals the error when Save is pressed on a field the user never left', async () => {
    /**
     * The case blur-time validation would otherwise miss: a user types a half-finished time, never
     * leaves the field, and presses Save. Without `submitted` un-filtering the errors, the button
     * would appear to do nothing — the worst possible response to a deliberate action.
     *
     * **Driven through the UI rather than through storage, because a bad value cannot come from
     * storage.** My first version of this test seeded the driver with `breakfast: 'nope'` and
     * failed: `userPreferencesSchema` validates `mealTimes` with `clockTimeSchema`, so the entry is
     * quarantined on read and the store falls back to valid defaults. That is the storage layer
     * working exactly as designed, and it makes the stored-bad-value case unreachable — so the only
     * way to have an invalid form is to be mid-edit, which is what this now exercises.
     */
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-breakfast'));

    act(() => {
      fireEvent.change(field, { target: { value: '08:' } });
    });
    // Untouched: no blur, so nothing is shown yet.
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockFormat);

    press(view.must('dietary-setup-save'));
    expect(view.text()).toContain(VALIDATION_MESSAGES.clockFormat);
  });

  it('a malformed stored meal time never reaches the form at all', async () => {
    // The other half of the finding above, asserted rather than left implicit: the quarantine path
    // means the screen opens on valid defaults instead of on someone else's corruption.
    const view = await render(
      memoryDriver({
        [STORAGE_KEYS.preferences]: encodeEnvelope(
          1,
          {
            schemaVersion: 1,
            diet: 'regular',
            allergies: [],
            goal: 'balanced',
            budget: 'medium',
            dislikedIngredients: [],
            mealTimes: { breakfast: 'nope', lunch: '12:30', dinner: '19:00' },
            aiEnabled: true,
            themeMode: 'system',
          },
          CLOCK(),
        ),
      }),
    );

    expect(inputIn(view.must('field-breakfast')).getAttribute('value')).toBe('08:00');
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.clockFormat);
  });

  it('tells the user when their 31st ingredient will not fit, instead of dropping it in silence', async () => {
    /**
     * **The rule that could not fire.** `validateDislikes` was run over the STORED list, which the
     * reducer has already capped at `MAX_DISLIKES` — so its predicate was false by construction,
     * `VALIDATION_MESSAGES.dislikesTooMany` was copy with no path to a screen, and a user pasting a
     * long list had everything past the 30th discarded while the controlled field erased the
     * characters they had just typed. PRD §12's "say what happened" was unmet for this field.
     *
     * The rule reads the draft now. Both halves are asserted here: the user is told, AND the
     * reducer's cap — the guard that makes an unstorable value impossible — still holds.
     */
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-dislikes'));
    const typed = Array.from({ length: 31 }, (_, index) => `a${String(index)}`).join(',');

    act(() => {
      fireEvent.change(field, { target: { value: typed } });
    });
    // Mid-keystroke, nothing is said — the same dignity rule the meal times follow.
    expect(view.text()).not.toContain(VALIDATION_MESSAGES.dislikesTooMany);

    blurField(field);
    expect(view.must('field-dislikes').textContent ?? '').toContain(
      VALIDATION_MESSAGES.dislikesTooMany,
    );
    // And the field still holds what they typed, rather than the truncated list read back at them.
    expect(inputIn(view.must('field-dislikes')).getAttribute('value')).toBe(typed);

    await view.settle();

    /**
     * The belt, unchanged: the store took 30 and no more, so nothing unstorable was ever queued.
     * Read from the DRIVER, because the claim is about what would be on disk at the next launch —
     * a 31st entry there is what quarantined the whole key and erased the allergy list.
     */
    const written: unknown = JSON.parse(view.driver.store.get(STORAGE_KEYS.preferences) ?? '{}');
    const stored = written as { value: { dislikedIngredients: readonly string[] } };
    expect(stored.value.dislikedIngredients).toHaveLength(30);

    /**
     * And Save does not complete onboarding while the message stands. Without this the user is
     * told and then walked past it, which is the same silent loss with an extra step.
     */
    press(view.must('dietary-setup-save'));
    await view.settle();
    const onboarding: unknown = JSON.parse(view.driver.store.get(STORAGE_KEYS.onboarding) ?? '{}');
    expect(onboarding).toMatchObject({ value: { completed: false } });
  });

  it('shows nothing for a list that fits — the control for the rule above', async () => {
    // Without this, a rule that reported on every list would pass the test above, and the form
    // would be unusable for the ordinary case of three or four disliked ingredients.
    const view = await render(memoryDriver({}));
    const field = inputIn(view.must('field-dislikes'));

    act(() => {
      fireEvent.change(field, { target: { value: 'okra, cilantro, olive' } });
    });
    blurField(field);

    expect(view.text()).not.toContain(VALIDATION_MESSAGES.dislikesTooMany);
    await view.settle();
    expect(JSON.parse(view.driver.store.get(STORAGE_KEYS.preferences) ?? '{}')).toMatchObject({
      value: { dislikedIngredients: ['okra', 'cilantro', 'olive'] },
    });
  });

  it('tells the user their profile was reset and ANNOUNCES it, because their allergy list is now empty', async () => {
    /**
     * **`dietary-setup-recovered` was referenced by no test anywhere in the repository** — the
     * destructive half of the pair, deletable in silence. Its twin on Home was found the same way
     * and fixed this week; this is the same repair on this screen.
     *
     * `recovered` on the preferences key means the stored profile failed `userPreferencesSchema`,
     * was quarantined, and rebuilt from `DEFAULT_PREFERENCES` — so `allergies` is `[]`, every meal
     * passes the filter, and the app looks completely normal. That is P14's CRITICAL, and this
     * notice is the only thing standing between it and a user who believes their declared allergy
     * is still in force.
     *
     * Reached the way the app reaches it: a well-formed envelope holding an invalid value, so the
     * read path quarantines it rather than a test asserting a status directly.
     */
    const view = await render(
      memoryDriver({
        [STORAGE_KEYS.preferences]: encodeEnvelope(
          1,
          { schemaVersion: 1, diet: 'not-a-real-diet', allergies: ['peanut'] },
          CLOCK(),
        ),
      }),
    );

    const notice = view.must('dietary-setup-recovered');

    /**
     * **T-23-05, and the most expensive silence on this screen.** The panel existed, carried the
     * right sentence, and was not a live region of any kind — so the one user who cannot see an
     * amber box was the one not told that their declared allergy had been dropped.
     * `announceOnMount` gives it `role="alert"`, whose INSERTION is the announcement, which is
     * the event this branch actually has: `entryStatus` comes from the hydration snapshot, so the
     * notice mounts with its own words already inside it and a bare `aria-live` region would have
     * had no content change to report.
     *
     * Read off the notice element itself, because the role and the words have to be on the same
     * node for an alert to be spoken — react-native-web's `View` renders one `div` and forwards
     * the whole accessibility set to it (0.21.2), so they are.
     *
     * The negative control for this claim — a `StatusMessage` that must NOT announce — is in
     * `MealForm.dom.test.tsx` ("says so before anything is typed, and does NOT announce it"),
     * because all three notices on this screen are arrivals and every one of them announces.
     */
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent ?? '').toContain('including an empty allergy list');

    // The user-visible consequence the notice is about: the allergy they had declared is no longer
    // selected. Asserted through the rendered chip, not through the store.
    expect(view.must('chip-allergy-peanut').getAttribute('aria-checked')).toBe('false');
  });

  it('shows no reset notice when the stored profile read cleanly — the control', async () => {
    // Without this, a screen that rendered the warning unconditionally would pass the test above.
    const view = await render(
      memoryDriver({
        [STORAGE_KEYS.preferences]: encodeEnvelope(
          1,
          {
            schemaVersion: 1,
            diet: 'regular',
            allergies: ['peanut'],
            goal: 'balanced',
            budget: 'medium',
            dislikedIngredients: [],
            mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
            aiEnabled: true,
            themeMode: 'system',
          },
          CLOCK(),
        ),
      }),
    );

    expect(view.find('dietary-setup-recovered')).toBeNull();
    // And the profile really did survive, which is what makes the absence meaningful.
    expect(view.must('chip-allergy-peanut').getAttribute('aria-checked')).toBe('true');
  });

  it('warns, rather than pretending, when the key could not be read', async () => {
    /**
     * `unavailable` means the store will not write over the key (TSD §6.3) — which is the right
     * call, because the bytes on disk are unknown and might be a real profile. But a user who then
     * makes a careful set of choices and loses them was misled by silence, so the screen says so.
     */
    const driver = memoryDriver({});
    driver.failOn.add('multiGet');
    const view = await render(driver);

    const notice = view.must('dietary-setup-unavailable');
    expect(notice.textContent ?? '').toContain('Changes will not be kept');
    // T-23-05: it arrives at hydration and nothing later in the session repeats it, so it is
    // announced. Same element, same reason as the reset notice above.
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.getAttribute('aria-live')).toBe('polite');

    // And nothing is written over it, even after a change.
    press(view.must('chip-allergy-peanut'));
    await view.settle();
    expect(driver.store.has(STORAGE_KEYS.preferences)).toBe(false);

    /**
     * **`retrySave` must honour the same rule**, and it is a second, separate path to
     * `repository.set` — a user pressing "Try again" is exactly when the rule is easiest to forget.
     * Asserted here rather than in `createStore.dom.test.tsx` because this harness is the one that
     * demonstrably renders under a failing `multiGet`.
     */
    const retry = view.find('dietary-setup-save-error');
    // No save has been attempted, so there is no error surface and nothing to press — which is
    // itself correct: the store never queued a write. The rule is asserted through the driver.
    expect(retry).toBeNull();
    expect(
      driver.calls.filter((one) => one.startsWith('setItem:@nutritime/preferences')),
    ).toHaveLength(0);
  });

  it('does not mount any of the three announced notices for a validation failure', async () => {
    /**
     * **T-23-05, and the reason the three `announceOnMount` notices do not make this screen's
     * worst case worse.** A failed Save on this form mounts one `aria-live="assertive"` region per
     * invalid field — measured at **four** reachable through the UI (the three meal times plus
     * dislikes; `FieldErrors`' fifth member, `allergies`, cannot fail from here, and
     * `dietaryValidation.ts` says so in as many words: the screen offers a fixed checkbox list).
     * Assertive means each one interrupts the last, so a fifth, sixth and seventh region arriving
     * on the same event would be a collision rather than an announcement.
     *
     * They do not arrive on the same event, and this is the test that keeps it that way. All three
     * notices are driven by **store status** — a hydration that quarantined the profile, a read
     * that failed, a write that was refused — and none of them by `submitted` or by `valid`. They
     * are also `polite` rather than `assertive` (asserted individually above), so even when one is
     * already on screen it queues behind the field errors instead of cutting across them.
     *
     * A mutant that drove any of the three off the validation state would redden here. The
     * assertive count itself is deliberately NOT pinned: the flood is a known `FormField` defect
     * with an adopted fix recorded in `design-system/DECISIONS.md:377`, and a test that fixed its
     * magnitude in place would have to be deleted before anyone could repair it.
     */
    const view = await render(memoryDriver({}));
    const set = (testID: string, value: string): void => {
      const input = inputIn(view.must(testID));
      act(() => {
        fireEvent.change(input, { target: { value } });
      });
    };
    set('field-breakfast', 'nope');
    set('field-lunch', '99:99');
    set('field-dinner', '');

    press(view.must('dietary-setup-save'));

    // The refusal really happened: the errors are un-filtered and on screen.
    expect(view.text()).toContain(VALIDATION_MESSAGES.clockFormat);
    expect(view.text()).toContain(VALIDATION_MESSAGES.clockEmpty);
    expect(view.find('dietary-setup-save-error')).toBeNull();
    expect(view.find('dietary-setup-recovered')).toBeNull();
    expect(view.find('dietary-setup-unavailable')).toBeNull();
    // And nothing on the screen is announcing politely, so there is nothing for the field alerts
    // to collide with. This is the assertion that fails if a notice is ever driven off `submitted`.
    expect(view.host.querySelectorAll('[aria-live="polite"]')).toHaveLength(0);
  });

  it('announces a refused write, which is the one failure here that arrives after the user acts', async () => {
    /**
     * T-23-05's "async results announced", on the surface that most needs it — and unlike
     * `MealFormScreen`, this screen stays put, so a user really does sit in front of this notice.
     *
     * The path is the app's own: this form dispatches each preference on the CHANGE, not on Save,
     * so a refused `setItem` reports back while the user is still choosing. Before this, the
     * panel was not a live region of any kind: a screen-reader user went on setting allergies
     * that were not reaching the device, and the next launch would have shown them the old list.
     *
     * The read is allowed to succeed — `failOn` is armed after hydration — because a failing
     * `multiGet` marks the key `unavailable`, which suppresses the write entirely and is the
     * *other* test above. Two different states, and only this one produces a `saveError`.
     */
    const driver = memoryDriver({});
    const view = await render(driver);
    driver.failOn.add('setItem');

    press(view.must('chip-allergy-peanut'));
    await view.settle();
    await view.settle();

    const notice = view.must('dietary-setup-save-error');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.textContent ?? '').toContain('Your changes are not saved');
    // Fixed local copy, and a retry that can succeed (PRD §12, TSD §6.4). The driver's own words
    // never reach the user.
    expect(notice.textContent ?? '').toContain('Try again');
    expect(notice.textContent ?? '').not.toContain('driver refused');
    // The write really was attempted and really did fail, so the state is the app's, not a stub's.
    expect(
      driver.calls.filter((one) => one.startsWith('setItem:@nutritime/preferences')).length,
    ).toBeGreaterThan(1);
    /**
     * And the truth the notice exists to tell: the screen and the device disagree. The chip reads
     * as chosen, and the bytes on the device — which are the defaults written at hydration, since
     * `failOn` was armed after it — never gained the allergen. Asserted on the raw stored string
     * rather than a decode, because the claim is only that the refused value is absent.
     */
    expect(view.must('chip-allergy-peanut').getAttribute('aria-checked')).toBe('true');
    expect(driver.store.get(STORAGE_KEYS.preferences) ?? '').not.toContain('peanut');
  });
});

/**
 * R-55 · T-23-01 · T-23-04 — the diet, goal and budget rows.
 *
 * **These three groups had no assertions of any kind before this block.** Not a name, not a role,
 * not a press, not a state; no e2e spec covered them either beyond clicking one chip by `testID`.
 * `ChipRow`'s `selected` prop could have been deleted outright and this suite would have stayed
 * green, which is §6.2 shape 2 in its purest form: the control that nothing controls. R-55's own
 * recorded text says the fix "changes accessible names that `DietarySetup.dom.test.tsx` asserts" —
 * it asserted none of them, so the risk row was wrong about its own blast radius.
 *
 * What is claimed here is what a user has to be able to hear: each row is named, each chip is a
 * `checkbox` whose accessible name is its visible label, **exactly one chip per row is announced as
 * checked**, pressing moves that state, and the selection is drawn with a mark as well as a fill.
 */

interface ChipGroupCase {
  readonly prefix: 'diet' | 'goal' | 'budget';
  /** The group's announced name. */
  readonly name: string;
  /** The contract enum this row renders — a different authority than the screen (§6.1g). */
  readonly contract: readonly string[];
  readonly chips: readonly { readonly value: string; readonly label: string }[];
  /** `DEFAULT_PREFERENCES`' choice, pinned against that constant below. */
  readonly defaulted: { readonly value: string; readonly label: string };
  /** A choice that is neither the default nor the first chip, so "always check one of those" dies. */
  readonly seeded: { readonly value: string; readonly label: string };
}

/**
 * Hand-transcribed, deliberately (§6.1g).
 *
 * `chipLabel` lives in `ChipRow.tsx` — the subject — so spelling these labels with it would assert
 * the implementation against itself and be true of whatever it happened to produce. `contract` and
 * `DEFAULT_PREFERENCES` are the two independent authorities, and the key-set test below fails if a
 * sixth diet tag or a fourth budget band ever arrives, rather than letting it be rendered untested.
 */
const CHIP_GROUPS: readonly ChipGroupCase[] = [
  {
    prefix: 'diet',
    name: 'Diet',
    contract: DIET_TAGS,
    chips: [
      { value: 'regular', label: 'Regular' },
      { value: 'vegetarian', label: 'Vegetarian' },
      { value: 'vegan', label: 'Vegan' },
      { value: 'halal-preference', label: 'Halal preference' },
      { value: 'gluten-aware', label: 'Gluten aware' },
    ],
    defaulted: { value: 'regular', label: 'Regular' },
    seeded: { value: 'vegan', label: 'Vegan' },
  },
  {
    prefix: 'goal',
    name: 'Goal',
    contract: NUTRITION_GOALS,
    chips: [
      { value: 'balanced', label: 'Balanced' },
      { value: 'high-protein', label: 'High protein' },
      { value: 'lower-calorie', label: 'Lower calorie' },
    ],
    defaulted: { value: 'balanced', label: 'Balanced' },
    seeded: { value: 'lower-calorie', label: 'Lower calorie' },
  },
  {
    prefix: 'budget',
    name: 'Budget',
    contract: BUDGET_BANDS,
    chips: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    defaulted: { value: 'medium', label: 'Medium' },
    seeded: { value: 'high', label: 'High' },
  },
];

/** A valid stored profile, so the read path keeps these choices instead of quarantining them. */
function storedProfile(diet: string, goal: string, budget: string): Record<string, string> {
  return {
    [STORAGE_KEYS.preferences]: encodeEnvelope(
      1,
      {
        schemaVersion: 1,
        diet,
        allergies: [],
        goal,
        budget,
        dislikedIngredients: [],
        mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
        aiEnabled: true,
        themeMode: 'system',
      },
      CLOCK(),
    ),
  };
}

/**
 * Every chip in a row with the state it announces, `null` when it announces none.
 *
 * Returned as a whole row rather than one chip at a time on purpose: the assertion that matters is
 * about the row — one checked and the rest not — and a per-chip read cannot express it.
 */
function announcedStates(
  view: Harness,
  group: ChipGroupCase,
): readonly (readonly [string, string | null])[] {
  return group.chips.map(
    (chip) =>
      [
        chip.value,
        view.must(`chip-${group.prefix}-${chip.value}`).getAttribute('aria-checked'),
      ] as const,
  );
}

function checkedValues(states: readonly (readonly [string, string | null])[]): readonly string[] {
  return states.filter(([, state]) => state === 'true').map(([value]) => value);
}

describe('DietarySetupScreen chip groups', () => {
  it('keeps its own table honest against the contract and the stored defaults', () => {
    // Not a behaviour test: the guard that stops a new enum member from being rendered by the
    // screen and covered by nothing here. If this fails, the table below is stale, not the screen.
    for (const group of CHIP_GROUPS) {
      expect(
        group.chips.map((chip) => chip.value),
        group.prefix,
      ).toStrictEqual([...group.contract]);
      expect(group.defaulted.value, group.prefix).toBe(DEFAULT_PREFERENCES[group.prefix]);
      expect(group.seeded.value, group.prefix).not.toBe(group.defaulted.value);
      // And never the first chip, so a mutant that always checks index 0 fails the seeded case.
      expect(group.chips[0]?.value, group.prefix).not.toBe(group.seeded.value);
    }
  });

  it('gives each group a name and a container role ARIA allows', async () => {
    /**
     * R-55's second half. A `radiogroup` must own `radio`s, and `Chip` has no `radio` mode that
     * TSD §6.7's fixed prop list would permit — so the row was an invalid group holding `button`s
     * with no name at all. `toolbar` may own arbitrary widgets, which these are.
     */
    const view = await render(memoryDriver({}));

    for (const group of CHIP_GROUPS) {
      const row = view.must(`field-${group.prefix}`);
      expect(row.getAttribute('role'), group.prefix).toBe('toolbar');
      expect(row.getAttribute('aria-label'), group.prefix).toBe(group.name);
    }
  });

  it('offers every chip as a checkbox whose accessible name is its visible label', async () => {
    /**
     * Without `toggle` these are `<button>`s carrying `aria-selected`, which ARIA does not allow
     * on a button and which react-native-web 0.21.2 therefore leaves as the only signal — so this
     * reddens on the role the moment `toggle` is dropped.
     */
    const view = await render(memoryDriver({}));

    for (const group of CHIP_GROUPS) {
      const row = view.must(`field-${group.prefix}`);
      expect(queryAllByRole(row, 'checkbox'), group.prefix).toHaveLength(group.chips.length);
      for (const chip of group.chips) {
        // `getByRole` throws when the name or the role is wrong, which is the assertion.
        expect(getByRole(row, 'checkbox', { name: chip.label }), chip.value).toBeTruthy();
      }
    }
  });

  it('announces exactly one chip per group as checked, and it is the default choice', async () => {
    // The pair no constant satisfies: a row that announced every chip checked fails the first
    // assertion, a row that announced none fails both, and a row with no `aria-checked` at all —
    // `toggle` dropped, or `selected` deleted from `ChipRow` — fails both as well.
    const view = await render(memoryDriver({}));

    for (const group of CHIP_GROUPS) {
      const states = announcedStates(view, group);
      expect(checkedValues(states), group.prefix).toStrictEqual([group.defaulted.value]);
      expect(
        states.filter(([, state]) => state === 'false'),
        group.prefix,
      ).toHaveLength(group.chips.length - 1);
    }
  });

  it('announces the stored choice when it is neither the default nor the first chip', async () => {
    // The control for the test above: without it, a row hard-coded to check the default — or the
    // first chip — would pass. Read from a real stored profile, so the value travels the app's own
    // path rather than being asserted into place.
    const view = await render(memoryDriver(storedProfile('vegan', 'lower-calorie', 'high')));

    for (const group of CHIP_GROUPS) {
      const states = announcedStates(view, group);
      expect(checkedValues(states), group.prefix).toStrictEqual([group.seeded.value]);
      expect(
        states.filter(([, state]) => state === 'false'),
        group.prefix,
      ).toHaveLength(group.chips.length - 1);
    }
  });

  it('moves the announced state onto the pressed chip and off the one that had it', async () => {
    // A chip whose press changed the fill and not the announcement is R-55 with extra steps, so
    // the claim is specifically about what is announced after the tap.
    const view = await render(memoryDriver({}));

    for (const group of CHIP_GROUPS) {
      press(view.must(`chip-${group.prefix}-${group.seeded.value}`));
      await view.settle();

      const states = announcedStates(view, group);
      expect(checkedValues(states), group.prefix).toStrictEqual([group.seeded.value]);
      expect(
        view.must(`chip-${group.prefix}-${group.defaulted.value}`).getAttribute('aria-checked'),
        group.prefix,
      ).toBe('false');
    }
  });

  it('draws the selection with a mark as well as a fill', async () => {
    /**
     * T-23-04. PRD §10.5: colour is never the only carrier of a state, and a fill is only colour.
     * `Chip` draws a check glyph beside the label when selected, so the selected chip's text
     * content is longer than its label and an unselected chip's is exactly its label — a pair a
     * chip that always drew the mark, or never drew it, cannot both satisfy.
     */
    const view = await render(memoryDriver({}));

    for (const group of CHIP_GROUPS) {
      const on = view.must(`chip-${group.prefix}-${group.defaulted.value}`);
      const off = view.must(`chip-${group.prefix}-${group.seeded.value}`);

      expect(on.textContent, group.prefix).not.toBe(group.defaulted.label);
      expect((on.textContent ?? '').endsWith(group.defaulted.label), group.prefix).toBe(true);
      expect(off.textContent, group.prefix).toBe(group.seeded.label);
    }
  });
});
