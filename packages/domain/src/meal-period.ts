/**
 * Meal-period detection (TSD 4.3, PRD FR-004).
 *
 * This module is called by the mobile app, not the server: the client computes the period
 * and sends it, so the server holds no clock and one fact is never derived twice.
 */

import type { MealPeriod } from '@nutritime/contracts';

/** A window opens 90 minutes before its anchor and closes 120 minutes after. Both inclusive. */
export const MEAL_PERIOD_WINDOW = { minutesBeforeAnchor: 90, minutesAfterAnchor: 120 } as const;

/** Evaluation order. First entry wins an exact tie. */
export const MEAL_PERIOD_PRIORITY = ['breakfast', 'lunch', 'dinner'] as const;

export const MINUTES_PER_DAY = 1440;

export type AnchoredMealPeriod = (typeof MEAL_PERIOD_PRIORITY)[number];

export interface MealTimes {
  readonly breakfast: string;
  readonly lunch: string;
  readonly dinner: string;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:mm` local time to minutes since midnight. Throws on anything else. */
export function parseClockTime(value: string): number {
  const match = CLOCK_PATTERN.exec(value);
  const hours = match?.[1];
  const minutes = match?.[2];
  if (hours === undefined || minutes === undefined) {
    throw new RangeError(`Expected a zero-padded HH:mm local time, received "${value}"`);
  }
  return Number(hours) * 60 + Number(minutes);
}

/** Wrap any integer into `[0, 1440)`. Handles negatives, which `%` alone does not. */
function withinDay(minutes: number): number {
  return ((Math.trunc(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Shortest signed distance from `anchor` to `minutes`, in `[-720, 720)`. Negative is before
 * the anchor.
 *
 * This is what lets the windows wrap midnight with no special case at all: a 23:30 anchor
 * and a 00:15 clock produce +45, not -1395, so no date arithmetic is needed anywhere.
 */
function signedOffsetFromAnchor(minutes: number, anchor: number): number {
  const half = MINUTES_PER_DAY / 2;
  return withinDay(minutes - anchor + half) - half;
}

/**
 * Classify a local wall-clock time.
 *
 * Nearest anchor wins where windows overlap; an exact tie goes to the earlier entry of
 * `MEAL_PERIOD_PRIORITY` (the comparison is strict `<`, so the first match is kept). A time
 * inside no window is a snack.
 */
export function mealPeriodForMinutes(minutes: number, mealTimes: MealTimes): MealPeriod {
  const target = withinDay(minutes);
  let best: { period: AnchoredMealPeriod; distance: number } | null = null;

  for (const period of MEAL_PERIOD_PRIORITY) {
    const offset = signedOffsetFromAnchor(target, parseClockTime(mealTimes[period]));
    const inWindow =
      offset >= -MEAL_PERIOD_WINDOW.minutesBeforeAnchor &&
      offset <= MEAL_PERIOD_WINDOW.minutesAfterAnchor;
    if (!inWindow) {
      continue;
    }
    const distance = Math.abs(offset);
    if (best === null || distance < best.distance) {
      best = { period, distance };
    }
  }

  return best === null ? 'snack' : best.period;
}

/**
 * Convenience wrapper. The `Date` is a parameter, never read from the environment - the
 * domain takes the time, it does not ask for it.
 */
export function mealPeriodForDate(localTime: Date, mealTimes: MealTimes): MealPeriod {
  return mealPeriodForMinutes(localTime.getHours() * 60 + localTime.getMinutes(), mealTimes);
}
