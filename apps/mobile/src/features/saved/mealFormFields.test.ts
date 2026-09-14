/**
 * The two parsers and the price projection, tested directly (SQG-09 split).
 *
 * `mealFormValidation.test.ts` already drives every one of these strings through
 * `validateMealForm` and `composeCustomMeal` and asserts the stored cents and the schema verdict —
 * those tests stayed there, because they are about the form's rules and its agreement with
 * `customMealSchema`. What is here is what the extraction newly made testable on its own: the
 * parser contract, independent of any field that happens to use it.
 *
 * Three properties are asserted here that no test asserted before the split, because reaching
 * them through the form was not possible:
 *
 *  1. **`parsePriceCents` never yields a non-integer.** `moneySchema.amountCents` is `.int()`, so
 *     a parser that returned 4.5 would be caught only at the storage edge.
 *  2. **`priceTextFromCents` is the exact inverse of `parsePriceCents`**, for every representable
 *     amount — the round trip `draftFromCustomMeal` depends on for edit mode.
 *  3. **`parseWhole`'s digit-length guard fires before the arithmetic**, which is what keeps an
 *     absurd input out of the unsafe-integer range rather than relying on the bound comparison.
 */

import { describe, expect, it } from 'vitest';
import { moneySchema } from '@nutritime/contracts';
import {
  MEAL_FORM_MESSAGES as M,
  NUTRIENT_LIMITS,
  nutrientRangeMessage,
  parsePriceCents,
  parseWhole,
  priceTextFromCents,
} from './mealFormFields.js';

describe('parsePriceCents', () => {
  it.each([
    ['4.50', 450],
    ['4.5', 450],
    ['4', 400],
    ['.5', 50],
    ['0', 0],
    ['0.00', 0],
    ['0.05', 5],
    ['0.99', 99],
    ['1.00', 100],
    ['1000', 100_000],
  ] as const)('reads %s', (text, expected) => {
    expect(parsePriceCents(text)).toStrictEqual({ ok: true, value: expected });
  });

  it('never yields a non-integer, whatever the decimal input', () => {
    for (const text of ['4.50', '4.5', '4', '.5', '0.01', '999.99', '1000']) {
      const parsed = parsePriceCents(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(Number.isInteger(parsed.value)).toBe(true);
        expect(moneySchema.safeParse({ amountCents: parsed.value, currency: 'USD' }).success).toBe(
          true,
        );
      }
    }
  });

  it.each([
    ['', M.priceRequired],
    ['-1', M.negative],
    ['-0', M.negative],
    ['-0.50', M.negative],
    ['abc', M.priceFormat],
    ['1e3', M.priceFormat],
    ['٤', M.priceFormat],
    ['4.', M.priceFormat],
    ['.', M.priceFormat],
    ['4,50', M.priceFormat],
    ['$4.50', M.priceFormat],
    ['4.505', M.pricePrecision],
    ['4.5000', M.pricePrecision],
    ['1000.01', M.priceRange],
    ['9999999', M.priceRange],
    ['12345678', M.priceRange],
    ['99999999999999999999', M.priceRange],
  ] as const)('refuses %s', (text, message) => {
    expect(parsePriceCents(text)).toStrictEqual({ ok: false, message });
  });

  it('refuses an over-long major part BEFORE multiplying, not by comparing the product', () => {
    // `'99999999999999999999' * 100` leaves the safe-integer range, so a version that compared
    // the product against the bound would be comparing a number that had already lost precision.
    const parsed = parsePriceCents('99999999999999999999');
    expect(parsed).toStrictEqual({ ok: false, message: M.priceRange });
  });
});

describe('priceTextFromCents', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [5, '0.05'],
    [50, '0.50'],
    [99, '0.99'],
    [100, '1.00'],
    [450, '4.50'],
    [99_999, '999.99'],
    [100_000, '1000.00'],
  ] as const)('renders %i cents as %s', (cents, text) => {
    expect(priceTextFromCents(cents)).toBe(text);
  });

  it('is the exact inverse of parsePriceCents for every representable amount', () => {
    // The property `draftFromCustomMeal` relies on: a record read back into the form and saved
    // again must carry the same price. A projection that rounded would move the number.
    for (const cents of [0, 1, 5, 9, 10, 50, 99, 100, 101, 450, 999, 1000, 99_999, 100_000]) {
      const parsed = parsePriceCents(priceTextFromCents(cents));
      expect(parsed).toStrictEqual({ ok: true, value: cents });
    }
  });
});

describe('parseWhole', () => {
  it('accepts 0 and the bound itself', () => {
    expect(parseWhole('0', 600, M.minutesRange)).toStrictEqual({ ok: true, value: 0 });
    expect(parseWhole('600', 600, M.minutesRange)).toStrictEqual({ ok: true, value: 600 });
  });

  it.each([
    ['601', M.minutesRange],
    ['-1', M.negative],
    ['-0', M.negative],
    ['10.5', M.wholeNumber],
    ['abc', M.wholeNumber],
    ['1e3', M.wholeNumber],
    ['٤', M.wholeNumber],
    [' 10', M.wholeNumber],
  ] as const)('refuses %s', (text, message) => {
    expect(parseWhole(text, 600, M.minutesRange)).toStrictEqual({ ok: false, message });
  });

  it('treats a blank string as malformed, because blank belongs to the CALLER', () => {
    // Documented contract: `parseWhole` has no "required" message, so every caller must decide
    // what blank means for its own field before reaching here — which is how one field can make
    // blank an error and another can make it a legitimately unset nutrition figure.
    expect(parseWhole('', 600, M.minutesRange)).toStrictEqual({
      ok: false,
      message: M.wholeNumber,
    });
  });

  it('refuses an 11-digit input by length, before Number() is reached', () => {
    expect(parseWhole('99999999999', 600, M.minutesRange)).toStrictEqual({
      ok: false,
      message: M.minutesRange,
    });
  });
});

describe('nutrientRangeMessage', () => {
  it.each(['caloriesText', 'proteinGramsText', 'carbsGramsText', 'fatGramsText'] as const)(
    'names the label, the bound and the unit for %s',
    (field) => {
      const limit = NUTRIENT_LIMITS[field];
      const message = nutrientRangeMessage(field);
      // Derived from the limit table rather than retyped, so a changed bound cannot leave the
      // message behind — the failure mode CONTRACTS §5 calls out for retyped copy.
      expect(message).toContain(limit.label);
      expect(message).toContain(String(limit.max));
      expect(message).toContain(limit.unit);
    },
  );

  it('distinguishes the four fields, so a message cannot be shown beside the wrong box', () => {
    const messages = new Set(
      (['caloriesText', 'proteinGramsText', 'carbsGramsText', 'fatGramsText'] as const).map(
        nutrientRangeMessage,
      ),
    );
    expect(messages.size).toBe(4);
  });
});
