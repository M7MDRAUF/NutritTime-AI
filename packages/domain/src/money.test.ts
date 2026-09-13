import { describe, expect, it } from 'vitest';

import { addMoney, formatMoney, money, sumMoney } from './money.js';

/**
 * Plan.md 19.3 vectors: cent arithmetic, formatting, and no float literal anywhere in this
 * file. Every amount below is a whole number of cents and every expectation is an integer or
 * a string. The one non-integer input - used to prove the constructor rejects a fractional
 * cent - is derived from integer literals rather than written as a decimal.
 */
describe('money', () => {
  it('builds a USD amount from whole cents', () => {
    expect(money(1010)).toEqual({ amountCents: 1010, currency: 'USD' });
  });

  it('accepts zero', () => {
    expect(money(0)).toEqual({ amountCents: 0, currency: 'USD' });
  });

  it('throws a RangeError naming the amount when given a fractional cent', () => {
    const fractionalCents = 1 / 2;

    expect(() => money(fractionalCents)).toThrow(RangeError);
    expect(() => money(fractionalCents)).toThrow(String(fractionalCents));
  });

  it('rejects a non-finite amount', () => {
    // Neither NaN nor Infinity is an integer, and neither should silently become a price.
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => money(Number.NEGATIVE_INFINITY)).toThrow(RangeError);
  });

  it('throws a RangeError naming the amount when given a negative number of cents', () => {
    expect(() => money(-1)).toThrow(RangeError);
    expect(() => money(-1)).toThrow('-1');
  });
});

describe('addMoney', () => {
  it('adds ten cents and twenty cents to exactly thirty cents', () => {
    expect(addMoney(money(10), money(20)).amountCents).toBe(30);
  });

  it('carries ninety-nine cents plus one cent into a whole dollar', () => {
    expect(addMoney(money(99), money(1))).toEqual({ amountCents: 100, currency: 'USD' });
  });

  it('leaves an amount unchanged when adding zero', () => {
    expect(addMoney(money(1010), money(0)).amountCents).toBe(1010);
  });

  it('gives the same total in either order', () => {
    expect(addMoney(money(5), money(1010)).amountCents).toBe(
      addMoney(money(1010), money(5)).amountCents,
    );
  });
});

describe('sumMoney', () => {
  it('totals every amount in the list', () => {
    expect(sumMoney([money(10), money(20), money(5)]).amountCents).toBe(35);
  });

  it('totals an empty list to zero USD', () => {
    expect(sumMoney([])).toEqual({ amountCents: 0, currency: 'USD' });
  });

  it('totals a one-element list to that element', () => {
    expect(sumMoney([money(99999)])).toEqual({ amountCents: 99999, currency: 'USD' });
  });

  it('agrees with repeated addition', () => {
    expect(sumMoney([money(99), money(1), money(5)]).amountCents).toBe(
      addMoney(addMoney(money(99), money(1)), money(5)).amountCents,
    );
  });
});

describe('formatMoney', () => {
  it('renders 1010 cents as "$10.10"', () => {
    expect(formatMoney(money(1010))).toBe('$10.10');
  });

  it('renders zero as "$0.00"', () => {
    expect(formatMoney(money(0))).toBe('$0.00');
  });

  it('pads a single-digit cent amount to two minor digits', () => {
    expect(formatMoney(money(5))).toBe('$0.05');
  });

  it('renders a whole dollar with a zeroed minor unit', () => {
    expect(formatMoney(money(100))).toBe('$1.00');
  });

  it('renders an amount past a thousand dollars without a thousands separator', () => {
    expect(formatMoney(money(99999))).toBe('$999.99');
  });
});

describe('formatMoney on a value that bypassed the constructor', () => {
  // Money is a plain interface, so an object literal can carry an amount money() would
  // have refused. The renderer must still produce something readable.
  it('renders a negative amount with the sign outside the symbol', () => {
    expect(formatMoney({ amountCents: -5, currency: 'USD' })).toBe('-$0.05');
    expect(formatMoney({ amountCents: -1010, currency: 'USD' })).toBe('-$10.10');
  });
});
