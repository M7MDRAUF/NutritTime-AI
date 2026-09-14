import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Put the app in the `app` boot phase without clicking through onboarding.
 *
 * **P14 gave the app a gate, and every spec that wants the tab bar has to get past it.** Before
 * P14, `page.goto('/')` landed straight on the tabs; now an empty device correctly shows
 * onboarding, and twelve Explore specs failed the moment that landed — they were asserting against
 * a phase the app no longer starts in.
 *
 * Two ways past it: click through the form, or seed the key that decides the phase. The specs that
 * are ABOUT onboarding click through it (`onboarding.spec.ts`, `home-allergy.spec.ts`), because the
 * journey is the thing under test. Every other spec seeds, because six clicks of someone else's
 * feature before each assertion is slow and couples unrelated specs to a form's markup.
 *
 * Seeded through the real envelope shape, so hydration accepts it rather than quarantining it — a
 * bare `{"completed":true}` would fail `decodeEnvelope` and land the spec back on onboarding with
 * no clue why.
 */

/** TSD §6.4's key names. Duplicated deliberately: an e2e spec asserts from outside the app. */
const ONBOARDING_KEY = '@nutritime/onboarding';
const PREFERENCES_KEY = '@nutritime/preferences/v1';

export interface SeededProfile {
  readonly allergies?: readonly string[];
  readonly diet?: string;
}

/**
 * Load once, seed storage, reload.
 *
 * **Not `addInitScript`**: that runs in every new document, so a later `page.reload()` in the same
 * spec would re-seed — which is harmless here but was actively wrong for the clearing helper it
 * replaced, where it deleted the data a persistence assertion was about.
 */
export async function enterApp(page: Page, profile: SeededProfile = {}): Promise<void> {
  await page.goto('/');
  await page.evaluate(
    ({ onboardingKey, preferencesKey, allergies, diet }) => {
      const at = new Date().toISOString();
      window.localStorage.clear();
      window.localStorage.setItem(
        onboardingKey,
        JSON.stringify({ schemaVersion: 1, updatedAt: at, value: { completed: true } }),
      );
      window.localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: at,
          value: {
            schemaVersion: 1,
            diet,
            allergies,
            goal: 'balanced',
            budget: 'medium',
            dislikedIngredients: [],
            mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
            aiEnabled: true,
            themeMode: 'system',
          },
        }),
      );
    },
    {
      onboardingKey: ONBOARDING_KEY,
      preferencesKey: PREFERENCES_KEY,
      allergies: profile.allergies ?? [],
      diet: profile.diet ?? 'regular',
    },
  );
  await page.reload();
  // The tab bar only exists in the `app` phase, so its presence IS the assertion that the seed
  // was accepted rather than quarantined.
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
}
