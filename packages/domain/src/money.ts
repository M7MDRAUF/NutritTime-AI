/**
 * Money, as integer cents (TSD 4.2).
 *
 * Prices never touch floating point: `0.1 + 0.2 !== 0.3`, and a price that is wrong by a cent
 * in a superlative answer ("the cheapest meal") is a wrong answer. Every amount in this module
 * is a whole number of cents; the only decimal point in the package is the one `formatMoney`
 * writes into a string.
 */
import type { Money } from '@nutritime/contracts';

/** Cents in one dollar - the single place the minor unit's size is named. */
const CENTS_PER_DOLLAR = 100;

/** Digits the minor unit is padded to, e.g. the `05` of `$0.05`. */
const MINOR_UNIT_DIGITS = 2;

/**
 * Construct a USD amount from whole cents.
 *
 * Throws on a non-integer or negative amount rather than rounding: a silently rounded price
 * is a lie the rest of the system cannot detect, while a `RangeError` naming the offending
 * value fails at the one place that knows what went wrong.
 */
export function money(amountCents: number): Money {
  if (!Number.isInteger(amountCents)) {
    throw new RangeError(
      `money: amountCents must be a whole number of cents, received ${amountCents}`,
    );
  }
  if (amountCents < 0) {
    throw new RangeError(`money: amountCents must not be negative, received ${amountCents}`);
  }
  return { amountCents, currency: 'USD' };
}

/** Add two amounts. Integer addition, so the result is exact. */
export function addMoney(a: Money, b: Money): Money {
  return money(a.amountCents + b.amountCents);
}

/** Total a list of amounts. An empty list totals zero USD, not `undefined`. */
export function sumMoney(values: readonly Money[]): Money {
  let totalCents = 0;
  for (const value of values) {
    totalCents += value.amountCents;
  }
  return money(totalCents);
}

/**
 * Render an amount, e.g. `1010` as `"$10.10"`.
 *
 * JavaScript has no integer division, so `/` here is IEEE-754 - but the quotient is only
 * ever truncated, never rounded to a decimal place, and for any safe integer the error is
 * far below one unit. That is the distinction from `(cents / 100).toFixed(2)`, which rounds
 * a float to two places and is the operation TSD 4.2 forbids.
 *
 * `Money` is a plain interface, so a value can reach this function without passing through
 * `money()`. A negative amount is therefore rendered explicitly rather than left to produce
 * "$0.-5" from a `-0` major unit and an unpadded negative remainder.
 */
export function formatMoney(value: Money): string {
  const negative = value.amountCents < 0;
  const magnitude = Math.abs(value.amountCents);
  const majorUnits = Math.trunc(magnitude / CENTS_PER_DOLLAR);
  const minorUnits = magnitude % CENTS_PER_DOLLAR;
  const rendered = `$${majorUnits}.${String(minorUnits).padStart(MINOR_UNIT_DIGITS, '0')}`;
  return negative ? `-${rendered}` : rendered;
}
