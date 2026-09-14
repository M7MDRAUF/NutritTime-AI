import { test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { enterApp } from './appPhase.js';
import type { SeededProfile } from './appPhase.js';

/**
 * The two boot phases every spec needs, as Playwright fixtures (T-24-01).
 *
 * **It extends the P13 harness rather than replacing it.** `enterApp` already carries the
 * envelope-shape reasoning a second seeder would get wrong — a bare `{"completed":true}` fails
 * `decodeEnvelope`, lands the spec back on onboarding, and gives no clue why — so `app` delegates
 * to it and this file adds no storage writing of its own. What the fixtures buy is that the choice
 * between the two phases stops being retyped: five of the ten specs had their own copy of
 * load-clear-reload or their own `enterApp` call, and the copies are where they drift.
 *
 * **Which spec uses which is settled by `appPhase.ts`'s docstring and is not revisited here.** A
 * spec that is ABOUT onboarding clicks through the form, because the journey is the thing under
 * test; every other spec seeds. `emptyDevice` exists for the first group, `app` for the second.
 */

/**
 * A genuinely empty device: load once, clear, reload.
 *
 * **Not `page.addInitScript`, and that is a recorded defect rather than a preference**
 * (`appPhase.ts:34-37`). An init script runs in EVERY new document on the page, reloads included,
 * so a spec that onboarded and then reloaded had its storage wiped on the way back in and the app
 * correctly showed onboarding again — the test was asserting that persistence works while deleting
 * the data it was about. Clearing once, between two loads, leaves the app booted against an empty
 * store exactly once and lets a later `page.reload()` keep whatever the user did.
 *
 * **`localStorage` is the whole of this origin's storage for this app.** Verified rather than
 * assumed: `@react-native-async-storage/async-storage` 2.2.0's web entry
 * (`src/AsyncStorage.ts`, the `react-native` field's target) is `window.localStorage` at every
 * call site, and `apps/mobile/src` names no other web storage API — no `sessionStorage`, no
 * `indexedDB`, no cookie. So a `localStorage.clear()` is a cleared device, and naming the wider
 * APIs here would be a claim about code that does not exist.
 *
 * **No app-phase assertion, unlike `enterApp`'s tab-bar check, and the asymmetry is deliberate.**
 * `enterApp` asserts the tab bar because seeding can be REJECTED — hydration quarantines a bad
 * envelope — so its postcondition is genuinely in doubt. A deletion has no such failure mode. And
 * the phase an empty device boots into is precisely what `onboarding.spec.ts`'s first test claims,
 * so asserting it in here would move that claim into shared code, where a regression would be
 * reported against the fixture instead of against the app.
 */
async function clearDevice(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
}

export interface AppFixtures {
  /** A device already past onboarding. Seeds through the real envelope; never clicks the form. */
  readonly app: (profile?: SeededProfile) => Promise<void>;
  /** A device with nothing stored — the cold first launch. Clears origin storage, then reloads. */
  readonly emptyDevice: () => Promise<void>;
}

/**
 * Both fixtures hand back a FUNCTION rather than doing their work at setup time.
 *
 * Two specs need something to happen before the app's first boot — `page.clock.setFixedTime` for a
 * deterministic meal period, `page.route` for a stubbed response — and a fixture that had already
 * called `page.goto` would have made both impossible. Requesting the fixture stays free; calling
 * it is the line in the test that says where the boot happens.
 */
export const test = base.extend<AppFixtures>({
  app: async ({ page }, use) => {
    await use(async (profile: SeededProfile = {}) => {
      await enterApp(page, profile);
    });
  },
  emptyDevice: async ({ page }, use) => {
    await use(async () => {
      await clearDevice(page);
    });
  },
});

export { expect } from '@playwright/test';
