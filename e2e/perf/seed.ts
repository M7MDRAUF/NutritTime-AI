/**
 * Putting an already-onboarded device into storage, for the P25 measurement lane.
 *
 * Split out of `instrument.ts` because that file reached 350 lines, which BRIEF §4 caps. The seam
 * is the natural one: this module knows about the app's storage contract and nothing about
 * timing, and `instrument.ts` is the reverse.
 */

import type { Page } from '@playwright/test';

/**
 * TSD §6.4's storage keys, and the envelope `decodeEnvelope` accepts.
 *
 * **Transcribed from `e2e/support/appPhase.ts:23-24,38-74` rather than imported, for one reason
 * that is not tidiness:** `SeededProfile` there carries `allergies` and `diet` only, and this lane
 * has to vary `aiEnabled` — T-25-03's "without AI" is `aiEnabled: false` in the request body,
 * which is the state a user can actually put themselves in. Importing `enterApp` and then mutating
 * the envelope afterwards would mean two writes and a reload between them, which changes the thing
 * T-25-01 measures. The duplication is the same trade `appPhase.ts` itself records: an e2e spec
 * asserts from outside the app.
 */
const ONBOARDING_KEY = '@nutritime/onboarding';
const PREFERENCES_KEY = '@nutritime/preferences/v1';

export interface SeedOptions {
  readonly aiEnabled: boolean;
  readonly allergies?: readonly string[];
  readonly diet?: string;
}

/**
 * The seeding body.
 *
 * `appPhase.ts:34-36` chose `page.evaluate` over `addInitScript` for a real reason — an init script
 * re-runs on every document, which was actively wrong for the clearing helper it replaced. This
 * lane needs the other one anyway; `seedBeforeFirstScript` says why, and an `evaluate`-based
 * variant was tried, measured as racy, and removed rather than kept as an unused alternative.
 */
function seedScript(input: {
  onboardingKey: string;
  preferencesKey: string;
  aiEnabled: boolean;
  allergies: readonly string[];
  diet: string;
}): void {
  const at = new Date().toISOString();
  window.localStorage.clear();
  window.localStorage.setItem(
    input.onboardingKey,
    JSON.stringify({ schemaVersion: 1, updatedAt: at, value: { completed: true } }),
  );
  window.localStorage.setItem(
    input.preferencesKey,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: at,
      value: {
        schemaVersion: 1,
        diet: input.diet,
        allergies: input.allergies,
        goal: 'balanced',
        budget: 'medium',
        dislikedIngredients: [],
        mealTimes: { breakfast: '08:00', lunch: '12:30', dinner: '19:00' },
        aiEnabled: input.aiEnabled,
        themeMode: 'system',
      },
    }),
  );
}

function seedArgument(options: SeedOptions): {
  onboardingKey: string;
  preferencesKey: string;
  aiEnabled: boolean;
  allergies: readonly string[];
  diet: string;
} {
  return {
    onboardingKey: ONBOARDING_KEY,
    preferencesKey: PREFERENCES_KEY,
    aiEnabled: options.aiEnabled,
    allergies: options.allergies ?? [],
    diet: options.diet ?? 'regular',
  };
}

/**
 * Seed before the app's first script runs, so ONE navigation is both the first and the measured
 * one.
 *
 * **This is what makes T-25-01 a cold figure rather than a warm one.** The obvious sequence —
 * goto, seed, goto — parses the 1.7 MiB bundle twice in one renderer, and the second parse hits
 * V8's in-process code cache. The measured navigation is then systematically faster than any
 * launch a user has, and nothing in the number says so. Seeding from an init script removes the
 * first navigation entirely: a fresh context, an empty HTTP cache, one cold parse.
 *
 * Safe here precisely because `appPhase.ts`'s objection does not apply — this lane never reloads
 * inside a measured context, so "it runs in every new document" has nothing to re-run over.
 */
export async function seedBeforeFirstScript(page: Page, options: SeedOptions): Promise<void> {
  await page.addInitScript(seedScript, seedArgument(options));
}
