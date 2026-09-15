/**
 * What meal period it is on this device, guarded — the one implementation both Home and the
 * assistant use.
 *
 * **The server holds no clock (TSD §5.4), so the client decides what "now" means** and sends it
 * with every request that depends on it. `useRecommendations.ts` has said for several phases that
 * "`mealPeriodForDate` is the domain's, so Home and the assistant cannot disagree about what time
 * it is" — and until P28 that was aspirational rather than true, because the assistant was never
 * told the period at all. This module is what makes the sentence true: one computation, one
 * fallback, two callers.
 *
 * **Guarded, because `mealPeriodForDate` THROWS.** `parseClockTime` raises `RangeError` on
 * anything that is not zero-padded `HH:mm`, and this runs during render. The store refuses such a
 * value, which is the real fix; this is the second line, because the store is not the only way a
 * value can arrive — a migration, a restored backup, a future import.
 *
 * `snack` is the fallback for the same reason TSD §4.3 makes it the default: **it is the period
 * that claims least.** A question answered about snacks when it should have been lunch is a mild
 * inaccuracy; a crash, or a refusal to answer at all, is not.
 */

import { mealPeriodForDate } from '@nutritime/domain';
// `MealTimes` is the domain's (`meal-period.ts`), not the contracts package's - the same place
// `mealPeriodForDate` comes from, so the pair cannot drift.
import type { MealTimes } from '@nutritime/domain';
import type { MealPeriod } from '@nutritime/contracts';

/** The period that claims least, per TSD §4.3. */
export const FALLBACK_MEAL_PERIOD: MealPeriod = 'snack';

/**
 * @param at the instant to classify — passed in rather than read here, so a test can choose it
 *   and so this module needs no clock of its own.
 */
export function mealPeriodNow(at: Date, mealTimes: MealTimes): MealPeriod {
  try {
    return mealPeriodForDate(at, mealTimes);
  } catch {
    return FALLBACK_MEAL_PERIOD;
  }
}
