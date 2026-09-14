import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StorageProvider } from './StorageProvider.js';
import { onboardingStore, onboardingActions } from './onboarding/index.js';
import { memoryDriver } from '../infrastructure/storage/__fixtures__/memoryDriver.js';
import { STORAGE_KEYS } from '../infrastructure/storage/definitions.js';
import { encodeEnvelope } from '../infrastructure/storage/envelope.js';
import type { BootPhase } from '../navigation/routes.js';

/**
 * The boot phase, T-14-06 — and the test that should have existed before the e2e suite found this.
 *
 * **The first version of `StorageProvider` derived the phase from the hydration snapshot.** A
 * snapshot is read once at boot and never updated, so dispatching `onboarding/completed` moved the
 * store and left the phase behind: pressing Save at the end of setup did nothing visible until the
 * app restarted. Two Playwright specs failed on it and **no dom test covered it at all**, because
 * none of them renders the phase — the screen suites mount a screen directly.
 *
 * So this file mounts the same three layers `App.tsx` does and asserts the phase they produce. It is
 * the cheap, fast half of the guard; `e2e/specs/onboarding.spec.ts` is the half that proves it in a
 * browser with real storage.
 */

const CLOCK = () => '2026-09-13T12:00:00.000Z';

interface Probe {
  readonly phases: BootPhase[];
  complete(): Promise<void>;
}

async function mount(driver: ReturnType<typeof memoryDriver>): Promise<Probe> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const phases: BootPhase[] = [];
  let dispatchRef: ((action: ReturnType<typeof onboardingActions.complete>) => void) | null = null;

  /** Exactly what `App.tsx`'s `PhasedNavigation` does: derive from the LIVE store. */
  function PhaseProbe(): ReactNode {
    const onboarding = onboardingStore.useValue();
    dispatchRef = onboardingStore.useDispatch();
    phases.push(onboarding.completed ? 'app' : 'onboarding');
    return null;
  }

  await act(async () => {
    createRoot(host).render(
      <StorageProvider runtime={{ driver, now: CLOCK }} fallback={<PhaseIsHydrating />}>
        <onboardingStore.Provider>
          <PhaseProbe />
        </onboardingStore.Provider>
      </StorageProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    phases,
    complete: async () => {
      await act(async () => {
        dispatchRef?.(onboardingActions.complete());
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

/** Rendered only while the read is in flight, so its presence IS the `hydrating` phase. */
function PhaseIsHydrating(): ReactNode {
  return null;
}

describe('the boot phase', () => {
  it('starts at onboarding on an empty device', async () => {
    const probe = await mount(memoryDriver({}));
    expect(probe.phases[probe.phases.length - 1]).toBe('onboarding');
  });

  it('advances to app the moment onboarding is completed, with no reload', async () => {
    /**
     * **The defect, pinned.** Reading the snapshot instead of the store leaves this at
     * `onboarding` for ever — the store changes, the phase does not, and the user sees the setup
     * form again after pressing Save.
     */
    const probe = await mount(memoryDriver({}));
    expect(probe.phases[probe.phases.length - 1]).toBe('onboarding');

    await probe.complete();
    expect(probe.phases[probe.phases.length - 1]).toBe('app');
  });

  it('starts at app when the device already completed onboarding', async () => {
    const probe = await mount(
      memoryDriver({
        [STORAGE_KEYS.onboarding]: encodeEnvelope(1, { completed: true }, CLOCK()),
      }),
    );
    expect(probe.phases[probe.phases.length - 1]).toBe('app');
    // And it never passed through `onboarding` on the way, which would have flashed the setup form
    // at a user who finished it months ago.
    expect(probe.phases).not.toContain('onboarding');
  });

  it('treats an unreadable onboarding key as NOT completed', async () => {
    /**
     * The conservative reading, and the right one. Showing setup to someone who has already done it
     * costs them a few taps; skipping it for someone who has not leaves the app with no diet, no
     * allergies and no meal times — and the allergy list is what every safety decision reads.
     */
    const driver = memoryDriver({});
    driver.failOn.add('multiGet');
    const probe = await mount(driver);
    expect(probe.phases[probe.phases.length - 1]).toBe('onboarding');
  });

  it('renders nothing but the fallback until hydration resolves', async () => {
    // `hydrating` is the phase in which the protected screens do not exist at all (TSD §6.1), and
    // it is expressed here as "the children have not mounted yet" rather than as a flag a screen
    // could ignore.
    const host = document.createElement('div');
    document.body.appendChild(host);
    let mounted = false;

    function Child(): ReactNode {
      mounted = true;
      return null;
    }

    act(() => {
      createRoot(host).render(
        <StorageProvider runtime={{ driver: memoryDriver({}), now: CLOCK }}>
          <onboardingStore.Provider>
            <Child />
          </onboardingStore.Provider>
        </StorageProvider>,
      );
    });
    // Synchronously after the first render, hydration is still a pending promise.
    expect(mounted).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });
    expect(mounted).toBe(true);
  });
});
