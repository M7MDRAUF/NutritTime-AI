import { describe, expect, it } from 'vitest';

import {
  compareIds,
  containsTokenSequence,
  kebabCase,
  normalizeText,
  singularKebabCase,
  singularize,
  tokenize,
  tokenizeSegments,
} from './text.js';

describe('normalizeText', () => {
  it('strips diacritics and lowercases, so "Crème Brûlée" reads "creme brulee"', () => {
    expect(normalizeText('Crème Brûlée')).toBe('creme brulee');
  });

  it('folds a precomposed character and its decomposed twin to the same output', () => {
    const precomposed = 'Jalapeño';
    const decomposed = 'Jalapeño';
    expect(precomposed).not.toBe(decomposed);
    expect(normalizeText(precomposed)).toBe('jalapeno');
    expect(normalizeText(decomposed)).toBe('jalapeno');
  });

  it('collapses every run of non-alphanumeric characters to a single space and trims', () => {
    expect(normalizeText('  Chicken---&&&   Rice!!  ')).toBe('chicken rice');
  });

  it('keeps digits', () => {
    expect(normalizeText('Omega-3 Salmon')).toBe('omega 3 salmon');
  });

  it('leaves no character outside [a-z0-9 ] in its output', () => {
    expect(normalizeText('Café (100%) — Jalapeño/Crème!')).not.toMatch(/[^a-z0-9 ]/);
  });

  it('returns an empty string when the input holds nothing alphanumeric', () => {
    expect(normalizeText('  --- ,,, !!!  ')).toBe('');
  });
});

describe('tokenize', () => {
  it('splits a phrase into whole-word tokens', () => {
    expect(tokenize('Grilled Chicken Salad')).toEqual(['grilled', 'chicken', 'salad']);
  });

  it('treats punctuation between words as a token boundary', () => {
    expect(tokenize('peanut-butter')).toEqual(['peanut', 'butter']);
  });

  it('returns an empty array for empty input, never an array holding an empty string', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ,,, ')).toEqual([]);
  });

  it('never emits an empty token from padded or punctuated input', () => {
    expect(tokenize('  ...milk,  chocolate...  ')).not.toContain('');
  });
});

describe('tokenizeSegments', () => {
  const SEPARATORS = [',', ';', ':', '(', ')', '[', ']', '{', '}', '/', '|'];

  for (const separator of SEPARATORS) {
    it(`splits on "${separator}", so "milk" and "chocolate" land in different segments`, () => {
      expect(tokenizeSegments(`milk${separator}chocolate`)).toEqual([['milk'], ['chocolate']]);
    });
  }

  it('keeps an uninterrupted phrase inside a single segment', () => {
    expect(tokenizeSegments('milk chocolate')).toEqual([['milk', 'chocolate']]);
  });

  it('drops segments that hold no tokens', () => {
    expect(tokenizeSegments('milk,, ; ,chocolate')).toEqual([['milk'], ['chocolate']]);
  });

  it('returns an empty array when the input is separators only', () => {
    expect(tokenizeSegments(' , ; () ')).toEqual([]);
  });

  it('puts no segment of "milk, chocolate" in possession of both words', () => {
    const segments = tokenizeSegments('milk, chocolate');
    expect(segments.some((segment) => containsTokenSequence(segment, ['milk', 'chocolate']))).toBe(
      false,
    );
  });

  it('leaves both words in one segment of "dark milk chocolate bar"', () => {
    const segments = tokenizeSegments('dark milk chocolate bar');
    expect(segments.some((segment) => containsTokenSequence(segment, ['milk', 'chocolate']))).toBe(
      true,
    );
  });
});

describe('singularize', () => {
  it('rewrites -ies to -y above four characters', () => {
    expect(singularize('berries')).toBe('berry');
    expect(singularize('cherries')).toBe('cherry');
  });

  it('drops -es after ch', () => {
    expect(singularize('peaches')).toBe('peach');
    expect(singularize('sandwiches')).toBe('sandwich');
  });

  it('drops -es after ss, zz, x, sh and o', () => {
    expect(singularize('glasses')).toBe('glass');
    expect(singularize('buzzes')).toBe('buzz');
    expect(singularize('boxes')).toBe('box');
    expect(singularize('dishes')).toBe('dish');
    expect(singularize('tomatoes')).toBe('tomato');
  });

  it('drops an ordinary trailing s above three characters', () => {
    expect(singularize('oats')).toBe('oat');
    expect(singularize('beans')).toBe('bean');
  });

  it('leaves a word ending in ss unchanged', () => {
    expect(singularize('glass')).toBe('glass');
    expect(singularize('watercress')).toBe('watercress');
  });

  it('leaves a word ending in us unchanged', () => {
    expect(singularize('hummus')).toBe('hummus');
    expect(singularize('couscous')).toBe('couscous');
  });

  it('leaves a three-character word ending in s unchanged', () => {
    expect(singularize('gas')).toBe('gas');
  });

  it('leaves a word carrying no plural marker unchanged', () => {
    expect(singularize('rice')).toBe('rice');
    expect(singularize('quinoa')).toBe('quinoa');
  });
});

describe('kebabCase', () => {
  it('joins normalized tokens with hyphens', () => {
    expect(kebabCase('Crème Brûlée Tart')).toBe('creme-brulee-tart');
  });

  it('produces one hyphen where the input had a run of punctuation', () => {
    expect(kebabCase('  Chicken & Rice!!  ')).toBe('chicken-rice');
  });

  it('leaves a plural plural, so "Mixed Berries" stays "mixed-berries"', () => {
    expect(kebabCase('Mixed Berries')).toBe('mixed-berries');
  });

  it('returns an empty string for input holding nothing alphanumeric', () => {
    expect(kebabCase('  ---  ')).toBe('');
  });
});

describe('singularKebabCase', () => {
  it('singularizes each token before joining', () => {
    expect(singularKebabCase('Mixed Berries')).toBe('mixed-berry');
    expect(singularKebabCase('Grilled Peaches')).toBe('grilled-peach');
  });

  it('keeps the s on a token ending in ss or us', () => {
    expect(singularKebabCase('Watercress Hummus')).toBe('watercress-hummus');
  });

  it('returns an empty string for input holding nothing alphanumeric', () => {
    expect(singularKebabCase(' /// ')).toBe('');
  });
});

describe('compareIds', () => {
  it('returns -1 when a sorts before b', () => {
    expect(compareIds('apple-pie', 'banana-bread')).toBe(-1);
  });

  it('returns 1 when a sorts after b', () => {
    expect(compareIds('banana-bread', 'apple-pie')).toBe(1);
  });

  it('returns 0 for identical ids', () => {
    expect(compareIds('apple-pie', 'apple-pie')).toBe(0);
  });

  it('returns exactly -1 or 1, never the code-unit distance', () => {
    expect(compareIds('a', 'z')).toBe(-1);
    expect(compareIds('z', 'a')).toBe(1);
  });

  it('orders by code unit, so an uppercase letter sorts before a lowercase one', () => {
    expect(compareIds('Zebra', 'apple')).toBe(-1);
  });

  it('sorts a list into ascending code-unit order', () => {
    expect(['pear', 'apple', 'fig', 'apple-pie'].toSorted(compareIds)).toEqual([
      'apple',
      'apple-pie',
      'fig',
      'pear',
    ]);
  });
});

describe('containsTokenSequence', () => {
  it('finds a contiguous run of whole tokens', () => {
    expect(containsTokenSequence(['grilled', 'chicken', 'salad'], ['chicken', 'salad'])).toBe(true);
  });

  it('finds a run at the start and at the end of the haystack', () => {
    expect(containsTokenSequence(['milk', 'chocolate', 'bar'], ['milk', 'chocolate'])).toBe(true);
    expect(containsTokenSequence(['dark', 'milk', 'chocolate'], ['milk', 'chocolate'])).toBe(true);
  });

  it('finds a single-token needle', () => {
    expect(containsTokenSequence(['milk', 'chocolate'], ['milk'])).toBe(true);
  });

  it('rejects a substring match, so "nut" is not found inside "minute"', () => {
    expect(containsTokenSequence(['minute'], ['nut'])).toBe(false);
  });

  it('rejects a substring match on a longer haystack too', () => {
    expect(containsTokenSequence(['water', 'chestnut', 'minute'], ['nut'])).toBe(false);
  });

  it('rejects tokens that are present but not contiguous', () => {
    expect(containsTokenSequence(['milk', 'dark', 'chocolate'], ['milk', 'chocolate'])).toBe(false);
  });

  it('rejects a run that appears in the wrong order', () => {
    expect(containsTokenSequence(['chocolate', 'milk'], ['milk', 'chocolate'])).toBe(false);
  });

  it('rejects an empty needle', () => {
    expect(containsTokenSequence(['milk'], [])).toBe(false);
    expect(containsTokenSequence([], [])).toBe(false);
  });

  it('rejects a needle longer than the haystack', () => {
    expect(containsTokenSequence(['milk'], ['milk', 'chocolate'])).toBe(false);
  });

  it('rejects any needle against an empty haystack', () => {
    expect(containsTokenSequence([], ['milk'])).toBe(false);
  });
});
