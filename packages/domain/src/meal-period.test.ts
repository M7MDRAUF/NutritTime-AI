import { describe, expect, it } from 'vitest';
import {
  MEAL_PERIOD_WINDOW,
  mealPeriodForDate,
  mealPeriodForMinutes,
  parseClockTime,
} from './meal-period.js';
import type { MealTimes } from './meal-period.js';

/**
 * The seven boundary vectors of Plan.md 19.3. Boundaries are where this function is wrong
 * if it is wrong at all: an off-by-one at an inclusive edge silently moves a user's whole
 * afternoon into the wrong meal.
 */

const DEFAULTS: MealTimes = { breakfast: '08:00', lunch: '13:00', dinner: '19:00' };
const at = (hh: number, mm: number) => hh * 60 + mm;

describe('parseClockTime', () => {
  it.each([
    ['00:00', 0],
    ['08:00', 480],
    ['13:05', 785],
    ['23:59', 1439],
  ])('reads %s as %i minutes', (value, expected) => {
    expect(parseClockTime(value)).toBe(expected);
  });

  it.each(['24:00', '8:00', '08:60', '0800', '8am', '', '  08:00'])(
    'throws RangeError on %s',
    (value) => {
      expect(() => parseClockTime(value)).toThrow(RangeError);
    },
  );
});

describe('window boundaries are inclusive at both ends', () => {
  const lunchAnchor = at(13, 0);

  // Vector 1 and 2: the opening edge.
  it('includes exactly anchor minus 90', () => {
    expect(
      mealPeriodForMinutes(lunchAnchor - MEAL_PERIOD_WINDOW.minutesBeforeAnchor, DEFAULTS),
    ).toBe('lunch');
  });

  it('excludes anchor minus 91', () => {
    expect(
      mealPeriodForMinutes(lunchAnchor - MEAL_PERIOD_WINDOW.minutesBeforeAnchor - 1, DEFAULTS),
    ).toBe('snack');
  });

  // Vector 3 and 4: the closing edge.
  it('includes exactly anchor plus 120', () => {
    expect(
      mealPeriodForMinutes(lunchAnchor + MEAL_PERIOD_WINDOW.minutesAfterAnchor, DEFAULTS),
    ).toBe('lunch');
  });

  it('excludes anchor plus 121', () => {
    expect(
      mealPeriodForMinutes(lunchAnchor + MEAL_PERIOD_WINDOW.minutesAfterAnchor + 1, DEFAULTS),
    ).toBe('snack');
  });

  it('classifies the anchor itself', () => {
    expect(mealPeriodForMinutes(lunchAnchor, DEFAULTS)).toBe('lunch');
  });
});

describe('overlapping windows', () => {
  // Vector 5: anchors close enough for their windows to overlap. Breakfast 08:00 spans
  // [06:30, 10:00] and lunch 11:00 spans [09:30, 13:00], so 09:30 is exactly 90 minutes
  // after breakfast and exactly 90 before lunch.
  const CLOSE: MealTimes = { breakfast: '08:00', lunch: '11:00', dinner: '19:00' };

  it('gives an exact tie to the earlier period in priority order', () => {
    expect(mealPeriodForMinutes(at(9, 30), CLOSE)).toBe('breakfast');
  });

  it('gives a near miss to whichever anchor is nearer', () => {
    // One minute earlier, lunch is not a candidate at all: its offset is -91, one past the
    // opening edge. This is window exclusion, not nearest-anchor selection.
    expect(mealPeriodForMinutes(at(9, 29), CLOSE)).toBe('breakfast');
    // One minute later, lunch is nearer by two: 89 against 91.
    expect(mealPeriodForMinutes(at(9, 31), CLOSE)).toBe('lunch');
    expect(mealPeriodForMinutes(at(10, 0), CLOSE)).toBe('lunch');
  });
});

describe('windows wrap midnight without special-casing the date', () => {
  // Vector 6.
  const LATE: MealTimes = { breakfast: '08:00', lunch: '13:00', dinner: '23:30' };

  it('classifies exactly 00:00 as dinner when the anchor is 23:30', () => {
    // TSD 4.3 names this vector specifically: the wrap must hold at midnight itself.
    expect(mealPeriodForMinutes(at(0, 0), LATE)).toBe('dinner');
  });

  it('classifies 00:15 as dinner when the anchor is 23:30', () => {
    expect(mealPeriodForMinutes(at(0, 15), LATE)).toBe('dinner');
  });

  it('classifies 01:30 as dinner, the last inclusive minute', () => {
    expect(mealPeriodForMinutes(at(1, 30), LATE)).toBe('dinner');
  });

  it('classifies 01:31 as a snack', () => {
    expect(mealPeriodForMinutes(at(1, 31), LATE)).toBe('snack');
  });

  it('normalises minutes outside a single day', () => {
    // 25:00 is 01:00, and a negative is yesterday evening.
    expect(mealPeriodForMinutes(at(25, 0), LATE)).toBe('dinner');
    expect(mealPeriodForMinutes(-30, LATE)).toBe('dinner');
  });
});

describe('times inside no window', () => {
  // Vector 7.
  it.each([
    ['03:00', at(3, 0)],
    ['10:30', at(10, 30)],
    ['16:00', at(16, 0)],
    ['22:00', at(22, 0)],
  ])('classifies %s as a snack', (_label, minutes) => {
    expect(mealPeriodForMinutes(minutes, DEFAULTS)).toBe('snack');
  });
});

describe('mealPeriodForDate', () => {
  it('takes the time as a parameter rather than reading a clock', () => {
    const noon = new Date(2026, 8, 13, 12, 30, 0);
    expect(mealPeriodForDate(noon, DEFAULTS)).toBe('lunch');
  });

  // Limitation worth stating: on a host whose offset is zero, local and UTC hours coincide,
  // so this test cannot distinguish a getHours() implementation from a getUTCHours() one.
  // Vitest's `env: { TZ }` does not help - Node ignores a runtime TZ change on Windows, which
  // was measured rather than assumed. P26 should pin TZ at the CI runner level, where it works.
  it('reads local wall-clock hours rather than UTC, where the host offset allows it', () => {
    const local = new Date(2026, 8, 13, 12, 30, 0);
    expect(mealPeriodForDate(local, DEFAULTS)).toBe('lunch');
    if (local.getTimezoneOffset() !== 0) {
      const utcMinutes = local.getUTCHours() * 60 + local.getUTCMinutes();
      expect(mealPeriodForMinutes(utcMinutes, DEFAULTS)).not.toBe('lunch');
    }
  });

  it('uses local wall-clock hours, so the calendar date is irrelevant', () => {
    const a = new Date(2026, 0, 1, 8, 0, 0);
    const b = new Date(2031, 11, 31, 8, 0, 0);
    expect(mealPeriodForDate(a, DEFAULTS)).toBe(mealPeriodForDate(b, DEFAULTS));
  });
});
