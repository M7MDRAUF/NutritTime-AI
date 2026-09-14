/**
 * `generateMealId`, extracted from `mealFormValidation.test.ts` with the code it tests (SQG-09).
 *
 * The claim this file exists to make: **the id is a lowercase RFC-4122 v4 that `kebabIdSchema`
 * accepts, by whichever of the three strategies the runtime actually offers.** The test
 * environment has `crypto`; a Hermes device may not, so the fallback paths are exercised by
 * REMOVING the global rather than by trusting that it is there — a suite that only ran the
 * `randomUUID` path would prove nothing about the device this ships on.
 *
 * Every test here ran in `mealFormValidation.test.ts` before the split and is unchanged apart
 * from its indentation; the one test that also needed `composeCustomMeal` stayed behind.
 */

import { describe, expect, it, vi } from 'vitest';
import { kebabIdSchema } from '@nutritime/contracts';
import { MEAL_ID_PATTERN, generateMealId } from './mealIdentity.js';

describe('generateMealId', () => {
  it('produces a v4-shaped id that kebabIdSchema accepts', () => {
    const id = generateMealId();
    expect(id).toMatch(MEAL_ID_PATTERN);
    expect(kebabIdSchema.safeParse(id).success).toBe(true);
  });

  it('does not repeat itself over a thousand calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateMealId()));
    expect(ids.size).toBe(1000);
  });

  describe('when the device has no crypto', () => {
    /**
     * Expo 57's winter runtime ships no `crypto`, so `globalThis.crypto` may be absent on a
     * Hermes device. The test environment HAS it, which is exactly why it is removed here: a
     * suite that only exercised the `randomUUID` path would prove nothing about the device.
     */
    it('assembles a v4 from the injected random, deterministically', () => {
      vi.stubGlobal('crypto', undefined);
      try {
        let byte = 0;
        const id = generateMealId(() => byte++ / 256);
        expect(id).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
        expect(id).toMatch(MEAL_ID_PATTERN);
        expect(kebabIdSchema.safeParse(id).success).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    const ALWAYS_ONE = (): number => 1;
    const ALWAYS_MINUS_ONE = (): number => -1;
    const ALWAYS_NAN = (): number => Number.NaN;

    it.each([
      [ALWAYS_ONE, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
      [ALWAYS_MINUS_ONE, '00000000-0000-4000-8000-000000000000'],
      [ALWAYS_NAN, '00000000-0000-4000-8000-000000000000'],
    ] as const)('clamps an out-of-range random to a well-formed id', (random, expected) => {
      vi.stubGlobal('crypto', undefined);
      try {
        const id = generateMealId(random);
        expect(id).toBe(expected);
        expect(id).toMatch(MEAL_ID_PATTERN);
        expect(kebabIdSchema.safeParse(id).success).toBe(true);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it('uses getRandomValues when randomUUID is absent', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => target.fill(0xab),
    });
    try {
      expect(generateMealId()).toBe('abababab-abab-4bab-abab-abababababab');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not trust a randomUUID that returns something else', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'NOT-A-UUID',
      getRandomValues: (target: Uint8Array) => target.fill(0xab),
    });
    try {
      // Falls through rather than returning a value `kebabIdSchema` rejects — which the
      // `customMeals/created` reducer would refuse silently, losing the meal with no message.
      expect(generateMealId()).toBe('abababab-abab-4bab-abab-abababababab');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
