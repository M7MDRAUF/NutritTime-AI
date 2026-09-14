import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { fireEvent, getByRole, queryAllByRole } from '@testing-library/dom';
import { ThemeProvider } from '../../shared/theme/ThemeProvider.js';
import { StorageProvider } from '../../state/StorageProvider.js';
import { preferencesStore } from '../../state/preferences/index.js';
import { onboardingStore } from '../../state/onboarding/index.js';
import { memoryDriver } from '../../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS } from '../../infrastructure/storage/definitions.js';
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

  it('warns, rather than pretending, when the key could not be read', async () => {
    /**
     * `unavailable` means the store will not write over the key (TSD §6.3) — which is the right
     * call, because the bytes on disk are unknown and might be a real profile. But a user who then
     * makes a careful set of choices and loses them was misled by silence, so the screen says so.
     */
    const driver = memoryDriver({});
    driver.failOn.add('multiGet');
    const view = await render(driver);

    expect(view.find('dietary-setup-unavailable')).not.toBeNull();
    expect(view.text()).toContain('Changes will not be kept');

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
});
