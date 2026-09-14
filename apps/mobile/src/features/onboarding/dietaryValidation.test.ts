import { describe, expect, it } from 'vitest';
import { parseClockTime } from '@nutritime/domain';
import {
  ALLERGY_CHOICES,
  MAX_DISLIKES,
  VALIDATION_MESSAGES,
  isDietarySetupValid,
  validateAllergies,
  validateDislikes,
  validateMealTime,
  validateMealTimes,
} from './dietaryValidation.js';

describe('validateMealTime', () => {
  it.each(['00:00', '08:00', '09:30', '12:59', '19:00', '23:59'])('accepts %s', (value) => {
    expect(validateMealTime(value)).toBeUndefined();
  });

  it.each([
    ['8:00', 'unpadded hour'],
    ['08:0', 'unpadded minute'],
    ['24:00', 'hour out of range'],
    ['23:60', 'minute out of range'],
    ['08:00 ', 'trailing space'],
    [' 08:00', 'leading space'],
    ['108:00', 'three-digit hour'],
    ['08:00:00', 'seconds'],
    ['0800', 'no separator'],
    ['08.00', 'wrong separator'],
    ['breakfast', 'not a time at all'],
  ])('rejects %s (%s)', (value) => {
    expect(validateMealTime(value)).toBe(VALIDATION_MESSAGES.clockFormat);
  });

  it('distinguishes empty from malformed', () => {
    // "Enter a time" and "use a 24-hour time like 08:00" are different problems. One message for
    // both would tell someone who left the field blank to check their formatting.
    expect(validateMealTime('')).toBe(VALIDATION_MESSAGES.clockEmpty);
    expect(validateMealTime('   ')).toBe(VALIDATION_MESSAGES.clockEmpty);
  });

  it('accepts exactly what the DOMAIN accepts', () => {
    /**
     * The assertion that makes this validator worth having: the format is not this file's opinion,
     * it is `parseClockTime`'s. A validator that accepted `'8:00'` would hand the domain a string it
     * throws on, and the failure would surface as a crash inside meal-period detection rather than
     * as a message beside the field.
     */
    for (const value of ['00:00', '08:00', '12:30', '23:59']) {
      expect(validateMealTime(value)).toBeUndefined();
      expect(() => parseClockTime(value)).not.toThrow();
    }
    for (const value of ['8:00', '24:00', '23:60', '0800']) {
      expect(validateMealTime(value)).toBeDefined();
      // And each one the validator rejects is genuinely unusable, not merely unfashionable.
      expect(() => parseClockTime(value)).toThrow();
    }
  });
});

describe('validateMealTimes', () => {
  const good = { breakfast: '08:00', lunch: '12:30', dinner: '19:00' };

  it('passes the default anchors', () => {
    expect(validateMealTimes(good)).toStrictEqual({});
    expect(isDietarySetupValid(validateMealTimes(good))).toBe(true);
  });

  it('binds a format error to the field that has it, and to no other', () => {
    const errors = validateMealTimes({ ...good, lunch: '12:3' });
    expect(errors.lunch).toBe(VALIDATION_MESSAGES.clockFormat);
    expect(errors.breakfast).toBeUndefined();
    expect(errors.dinner).toBeUndefined();
  });

  it('reports EVERY malformed field, not just the first', () => {
    // A form that surfaces one error at a time makes the user submit three times to find out.
    const errors = validateMealTimes({ breakfast: 'x', lunch: 'y', dinner: 'z' });
    expect(Object.keys(errors).sort()).toStrictEqual(['breakfast', 'dinner', 'lunch']);
  });

  it('attaches an ordering error to the LATER field', () => {
    /**
     * Lunch before breakfast is lunch being out of place, from the user's point of view — breakfast
     * was already there. Putting the message on breakfast would point at a field they did not
     * touch, which is what Plan §14.2's "bound to the field" is written against.
     */
    const errors = validateMealTimes({ ...good, lunch: '07:00' });
    expect(errors.lunch).toBe(VALIDATION_MESSAGES.clockOrder);
    expect(errors.breakfast).toBeUndefined();

    const later = validateMealTimes({ ...good, dinner: '11:00' });
    expect(later.dinner).toBe(VALIDATION_MESSAGES.clockOrder);
    expect(later.lunch).toBeUndefined();
  });

  it('treats equal times as out of order', () => {
    // Two anchors at the same minute make one period unreachable rather than ambiguous: the nearest
    // anchor wins and the tie goes to the earlier entry, so the later meal can never be selected.
    expect(validateMealTimes({ ...good, lunch: '08:00' }).lunch).toBe(
      VALIDATION_MESSAGES.clockOrder,
    );
  });

  it('does not pile an ordering error on top of a format error', () => {
    // With lunch unparseable there is nothing to order, and a second message would be noise on a
    // field the user is already being told about.
    const errors = validateMealTimes({ ...good, lunch: 'nope' });
    expect(errors.lunch).toBe(VALIDATION_MESSAGES.clockFormat);
    expect(Object.values(errors)).not.toContain(VALIDATION_MESSAGES.clockOrder);
  });
});

describe('validateAllergies', () => {
  it('accepts every value the UI can produce', () => {
    // The screen offers exactly `ALLERGY_CHOICES`, so this asserts the pair is consistent: a choice
    // the form offers and the validator rejects would be an unsubmittable form.
    expect(validateAllergies(ALLERGY_CHOICES)).toBeUndefined();
    expect(ALLERGY_CHOICES.length).toBeGreaterThan(5);
  });

  it('rejects a term the matcher cannot act on', () => {
    // R-30. Unreachable through the UI, which is the containment — this is the guard for a restored
    // backup or a future import, where accepting the term would claim a protection that does not
    // exist.
    expect(validateAllergies(['cilantro'])).toBe(VALIDATION_MESSAGES.allergyUnknown);
    expect(validateAllergies(['peanut', 'cilantro'])).toBe(VALIDATION_MESSAGES.allergyUnknown);
  });

  it('accepts an empty list', () => {
    // No allergies is the default and the common case (S-20). It must not read as incomplete.
    expect(validateAllergies([])).toBeUndefined();
  });
});

/**
 * The rule that **could not fire for a whole phase**, and therefore had no test either.
 *
 * The screen passed it `preferences.dislikedIngredients` — the list the reducer had already capped
 * at `MAX_DISLIKES` — so `cleaned.size > MAX_DISLIKES` was false by construction, the message was
 * unreachable copy, and a 31st ingredient was discarded in silence while the field erased the
 * characters the user had just typed. It is fed the draft text now, and these are the cases that
 * text produces.
 */
describe('validateDislikes', () => {
  const listOf = (count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) => `ingredient-${String(index)}`);

  it('says nothing at the bound, and speaks at one past it', () => {
    // Both directions on the same boundary: an off-by-one in either would fail one of these.
    expect(validateDislikes(listOf(MAX_DISLIKES))).toBeUndefined();
    expect(validateDislikes(listOf(MAX_DISLIKES + 1))).toBe(VALIDATION_MESSAGES.dislikesTooMany);
  });

  it('blocks submission when it fires, so Save cannot quietly drop the overflow', () => {
    expect(isDietarySetupValid({ dislikes: validateDislikes(listOf(MAX_DISLIKES + 1)) })).toBe(
      false,
    );
    expect(isDietarySetupValid({ dislikes: validateDislikes(listOf(MAX_DISLIKES)) })).toBe(true);
  });

  it('counts ingredients, not commas', () => {
    // `'a,,b'` is two ingredients. Telling the user they have three would be counting punctuation,
    // and the count has to match what the reducer stores or the message contradicts the field.
    const withBlanks = [...listOf(MAX_DISLIKES), '', '   '];
    expect(withBlanks).toHaveLength(MAX_DISLIKES + 2);
    expect(validateDislikes(withBlanks)).toBeUndefined();
  });

  it('counts a repeated ingredient once, as the store does', () => {
    // The reducer de-duplicates before capping, so 31 entries with one repeat store as 30 and must
    // not be reported as an overflow.
    const repeated = [...listOf(MAX_DISLIKES), 'ingredient-0'];
    expect(validateDislikes(repeated)).toBeUndefined();
    // And trimming happens before the comparison, so ` ingredient-0 ` is the same entry.
    expect(validateDislikes([...listOf(MAX_DISLIKES), ' ingredient-0 '])).toBeUndefined();
  });

  it('names the bound in the message, because "too many" is not actionable', () => {
    expect(VALIDATION_MESSAGES.dislikesTooMany).toContain(String(MAX_DISLIKES));
  });

  it('accepts an empty list', () => {
    expect(validateDislikes([])).toBeUndefined();
    expect(validateDislikes([''])).toBeUndefined();
  });
});
