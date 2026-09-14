/**
 * The acceptance test of `mealFormValidation.ts`, and it is deliberately shaped around one claim:
 *
 * > **A record `composeCustomMeal` produces from a draft `validateMealForm` accepts is a record
 * > `customMealSchema` accepts — and every rule the schema has that a draft could break is caught
 * > here first, bound to a field.**
 *
 * Both halves matter, and each is asserted against the REAL schema rather than a restatement of
 * it. Where this module names a bound (120 characters, 600 minutes, 24 servings), the test proves
 * the bound belongs to the schema by mutating a composed record past it and showing
 * `customMealSchema` refuses it. A test that only checked this module against its own constants
 * would stay green while the two drifted apart, which is exactly P14's defect: a value the form
 * accepted, the store held, and storage then quarantined — erasing the key on the next launch.
 *
 * `now` and `newId` are injected everywhere, so nothing here depends on the time of day.
 */

import { describe, expect, it } from 'vitest';
import { kebabIdSchema, moneySchema } from '@nutritime/contracts';
import type { CustomMeal } from '@nutritime/contracts';
import { customMealSchema } from '../../infrastructure/storage/definitions.js';
import {
  EMPTY_MEAL_FORM_DRAFT,
  MEAL_FORM_MESSAGES as M,
  MEAL_ID_PATTERN,
  composeCustomMeal,
  composeCustomMealUpdate,
  draftFromCustomMeal,
  generateMealId,
  nutrientRangeMessage,
  validateMealForm,
} from './mealFormValidation.js';
import type { ComposeContext, MealFormDraft } from './mealFormValidation.js';

const NOW = '2026-09-13T08:30:00.000Z';
const LATER = '2026-09-14T19:05:00.000Z';
const ID_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-2222-4222-9222-bbbbbbbbbbbb';

/** Nutrition unset — 53 of the 60 catalog records look like this, so it is the common case. */
const VALID: MealFormDraft = {
  name: 'Overnight oats',
  description: 'Oats soaked overnight in milk.',
  mealPeriods: ['breakfast'],
  dietTags: ['vegetarian'],
  allergenTags: ['milk'],
  ingredients: [
    { name: 'Rolled oats', measure: '80 g' },
    { name: 'Milk', measure: '200 ml' },
  ],
  instructions: ['Combine the oats and milk.', 'Chill overnight.'],
  priceText: '4.50',
  preparationMinutesText: '10',
  caloriesText: '',
  proteinGramsText: '',
  carbsGramsText: '',
  fatGramsText: '',
  servingsText: '',
};

const FIGURES = {
  caloriesText: '320',
  proteinGramsText: '12',
  carbsGramsText: '40',
  fatGramsText: '9',
} as const;
const NUTRIENT_FIELDS = [
  'caloriesText',
  'proteinGramsText',
  'carbsGramsText',
  'fatGramsText',
] as const;

function context(overrides: Partial<ComposeContext> = {}): ComposeContext {
  return { now: () => NOW, newId: () => ID_A, existingIds: [], ...overrides };
}

/** Composes, and fails LOUDLY rather than returning a half-record a later assertion tiptoes past. */
function compose(draft: MealFormDraft = VALID, ctx: ComposeContext = context()): CustomMeal {
  const result = composeCustomMeal(draft, ctx);
  if (!result.ok) {
    throw new Error(`expected a composable draft, got ${JSON.stringify(result.errors)}`);
  }
  return result.meal;
}

/** True when the STORAGE schema refuses a composed record with these fields replaced. */
function schemaRefuses(patch: Record<string, unknown>): boolean {
  return !customMealSchema.safeParse({ ...compose(), ...patch }).success;
}

describe('the composed record satisfies customMealSchema', () => {
  it('has a schemaRefuses helper that CAN return false, so its every use is a real check', () => {
    // Without this, a helper that broke the record while patching it would make all twenty
    // `schemaRefuses` assertions trivially true — the decorative-test failure BRIEF §6 is about.
    expect(schemaRefuses({})).toBe(false);
    expect(schemaRefuses({ name: 'Still a fine name' })).toBe(false);
  });

  it('accepts a valid draft with nutrition left unset', () => {
    const parsed = customMealSchema.safeParse(compose());
    expect(parsed.success).toBe(true);
  });

  it('accepts a valid draft with all four figures and a serving count', () => {
    const meal = compose({ ...VALID, ...FIGURES, servingsText: '2' });
    expect(customMealSchema.safeParse(meal).success).toBe(true);
    expect(meal.nutrition).toStrictEqual({
      calories: 320,
      proteinGrams: 12,
      carbsGrams: 40,
      fatGrams: 9,
    });
    expect(meal.nutritionProvenance.servings).toBe(2);
  });

  it('sets the fields FR-013 and CONTRACTS §7 fix rather than reading them off the draft', () => {
    const meal = compose();
    expect(meal.source).toBe('user');
    expect(meal.nutritionProvenance).toStrictEqual({
      origin: 'user',
      dataset: null,
      servings: null,
      reason: null,
    });
    expect(meal.provenance).toStrictEqual({
      themealdbId: null,
      sourceUrl: null,
      imageSource: null,
      licenceConfirmed: false,
    });
    expect(meal.imageUrl).toBeNull();
    expect(meal.available).toBe(true);
    expect(meal.id).toBe(ID_A);
    expect(meal.createdAt).toBe(NOW);
    expect(meal.updatedAt).toBe(NOW);
  });

  it('gives the record an id kebabIdSchema accepts', () => {
    expect(kebabIdSchema.safeParse(compose().id).success).toBe(true);
  });

  it('trims, and stores the trimmed value rather than what was typed', () => {
    const meal = compose({
      ...VALID,
      name: '  Overnight oats  ',
      description: '  Oats.  ',
      ingredients: [{ name: '  Rolled oats  ', measure: '  80 g  ' }],
      instructions: ['  Combine.  '],
      allergenTags: ['  milk  ', '   ', 'tree-nut'],
    });
    expect(meal.name).toBe('Overnight oats');
    expect(meal.description).toBe('Oats.');
    expect(meal.ingredients).toStrictEqual([{ name: 'Rolled oats', measure: '80 g' }]);
    expect(meal.instructions).toStrictEqual(['Combine.']);
    // A blank tag is dropped; an UNKNOWN one is kept, because `core.ts` calls rejecting an
    // unrecognised allergen tag "the one failure mode this system must never have".
    expect(meal.allergenTags).toStrictEqual(['milk', 'tree-nut']);
  });

  it('keeps an allergen tag the taxonomy does not know', () => {
    const meal = compose({ ...VALID, allergenTags: ['lupin', 'celery'] });
    expect(meal.allergenTags).toStrictEqual(['lupin', 'celery']);
    expect(customMealSchema.safeParse(meal).success).toBe(true);
  });
});

describe('every schema rule a draft could break is caught first, bound to a field', () => {
  /**
   * Each row proves two things: this module rejects the draft with a message on the named field,
   * AND the storage schema would have rejected the corresponding record. The second half is what
   * stops this suite from asserting a rule the schema does not actually have.
   */
  it.each([
    ['name', 'name', { name: '   ' }, { name: '' }, M.nameRequired],
    ['name over 120', 'name', { name: 'a'.repeat(121) }, { name: 'a'.repeat(121) }, M.nameTooLong],
    [
      'description over 400',
      'description',
      { description: 'd'.repeat(401) },
      { description: 'd'.repeat(401) },
      M.descriptionTooLong,
    ],
    [
      'no meal period',
      'mealPeriods',
      { mealPeriods: [] },
      { mealPeriods: [] },
      M.mealPeriodsRequired,
    ],
    ['no diet tag', 'dietTags', { dietTags: [] }, { dietTags: [] }, M.dietTagsRequired],
    [
      'no ingredients',
      'ingredients',
      { ingredients: [] },
      { ingredients: [] },
      M.ingredientsRequired,
    ],
    [
      'no instructions',
      'instructions',
      { instructions: [] },
      { instructions: [] },
      M.instructionsRequired,
    ],
    [
      'negative price',
      'priceText',
      { priceText: '-1' },
      { price: { amountCents: -100, currency: 'USD' } },
      M.negative,
    ],
    [
      'price over the Money bound',
      'priceText',
      { priceText: '1000.01' },
      { price: { amountCents: 100_001, currency: 'USD' } },
      M.priceRange,
    ],
    [
      'fractional minutes',
      'preparationMinutesText',
      { preparationMinutesText: '10.5' },
      { preparationMinutes: 10.5 },
      M.wholeNumber,
    ],
    [
      'negative minutes',
      'preparationMinutesText',
      { preparationMinutesText: '-5' },
      { preparationMinutes: -5 },
      M.negative,
    ],
    [
      'minutes over 600',
      'preparationMinutesText',
      { preparationMinutesText: '601' },
      { preparationMinutes: 601 },
      M.minutesRange,
    ],
  ] as const)('%s', (_label, field, draftPatch, recordPatch, message) => {
    const errors = validateMealForm({ ...VALID, ...draftPatch });
    expect(errors[field]).toBe(message);
    expect(schemaRefuses(recordPatch)).toBe(true);
    expect(composeCustomMeal({ ...VALID, ...draftPatch }, context()).ok).toBe(false);
  });

  it('reports the empty draft on every field that is missing, and on no other', () => {
    const errors = validateMealForm(EMPTY_MEAL_FORM_DRAFT);
    expect(Object.keys(errors).sort()).toStrictEqual([
      'dietTags',
      'ingredients',
      'instructions',
      'mealPeriods',
      'name',
      'preparationMinutesText',
      'priceText',
    ]);
    expect(errors.priceText).toBe(M.priceRequired);
    expect(errors.preparationMinutesText).toBe(M.minutesRequired);
  });

  it('accepts the values exactly AT each bound', () => {
    const at: MealFormDraft = {
      ...VALID,
      ...FIGURES,
      name: 'n'.repeat(120),
      description: 'd'.repeat(400),
      preparationMinutesText: '600',
      priceText: '1000',
      caloriesText: '2000',
      proteinGramsText: '200',
      carbsGramsText: '300',
      fatGramsText: '200',
      servingsText: '24',
    };
    expect(validateMealForm(at)).toStrictEqual({});
    expect(customMealSchema.safeParse(compose(at)).success).toBe(true);
  });

  it('accepts a free meal and a zero-minute meal, because 0 is a real answer', () => {
    const free = { ...VALID, priceText: '0', preparationMinutesText: '0' };
    expect(validateMealForm(free)).toStrictEqual({});
    expect(compose(free).price.amountCents).toBe(0);
  });
});

describe('ingredient and instruction rows', () => {
  it('drops trailing blank rows without a word, because they are unfilled affordances', () => {
    const meal = compose({
      ...VALID,
      ingredients: [
        { name: 'Oats', measure: '80 g' },
        { name: '', measure: '' },
      ],
      instructions: ['Combine.', '   ', ''],
    });
    expect(meal.ingredients).toStrictEqual([{ name: 'Oats', measure: '80 g' }]);
    expect(meal.instructions).toStrictEqual(['Combine.']);
  });

  it('reports an INTERIOR blank row rather than deleting a row somebody is looking at', () => {
    const errors = validateMealForm({
      ...VALID,
      ingredients: [
        { name: '', measure: '' },
        { name: 'Oats', measure: '80 g' },
      ],
      instructions: ['', 'Chill.'],
    });
    expect(errors['ingredient.0']).toBe(M.rowBlank);
    expect(errors['instruction.0']).toBe(M.rowBlank);
    expect(errors['ingredient.1']).toBeUndefined();
    expect(errors['instruction.1']).toBeUndefined();
    expect(errors.ingredients).toBeUndefined();
  });

  it('refuses a measure with no name, and binds it to that row', () => {
    const errors = validateMealForm({ ...VALID, ingredients: [{ name: '  ', measure: '200 ml' }] });
    expect(errors['ingredient.0']).toBe(M.ingredientNameRequired);
    // The rule is the schema's: `ingredientSchema` requires `name.min(1)`.
    expect(schemaRefuses({ ingredients: [{ name: '', measure: '200 ml' }] })).toBe(true);
  });

  it('treats a list of nothing but blank rows as an empty list', () => {
    const errors = validateMealForm({
      ...VALID,
      ingredients: [
        { name: '', measure: '' },
        { name: ' ', measure: ' ' },
      ],
      instructions: ['', '  '],
    });
    expect(errors.ingredients).toBe(M.ingredientsRequired);
    expect(errors.instructions).toBe(M.instructionsRequired);
    expect(errors['ingredient.0']).toBeUndefined();
    expect(schemaRefuses({ instructions: [''] })).toBe(true);
  });
});

describe('nutrition is all-or-nothing (FR-006)', () => {
  /**
   * All sixteen blank/filled combinations of the four figures, which is exhaustive over the
   * figures themselves: the rule reads only whether each is blank, so a subset could not be.
   * The serving count is the second axis and is only defined at counts 0 and 4 — the two
   * boundaries the `superRefine` `user` branch actually constrains — so it is driven there.
   */
  it.each(Array.from({ length: 16 }, (_unused, mask) => [mask]))(
    'combination %i',
    (mask: number) => {
      const filled = NUTRIENT_FIELDS.filter((_field, index) => (mask & (1 << index)) !== 0);
      const draft: MealFormDraft = { ...VALID };
      const patched = filled.reduce<MealFormDraft>(
        (acc, field) => ({ ...acc, [field]: FIGURES[field] }),
        draft,
      );

      if (filled.length === 0) {
        expect(validateMealForm(patched)).toStrictEqual({});
        const meal = compose(patched);
        expect(meal.nutrition).toStrictEqual({
          calories: null,
          proteinGrams: null,
          carbsGrams: null,
          fatGrams: null,
        });
        expect(meal.nutritionProvenance.servings).toBeNull();
        return;
      }

      if (filled.length === 4) {
        expect(validateMealForm({ ...patched, servingsText: '2' })).toStrictEqual({});
        expect(validateMealForm(patched).servingsText).toBe(M.servingsRequired);
        expect(composeCustomMeal(patched, context()).ok).toBe(false);
        return;
      }

      // Three, two or one of four. Each BLANK figure carries the message, because that is the
      // field the user has to act on; the filled ones are left alone.
      const errors = validateMealForm({ ...patched, servingsText: '2' });
      for (const field of NUTRIENT_FIELDS) {
        expect(errors[field]).toBe(filled.includes(field) ? undefined : M.nutritionIncomplete);
      }
      expect(composeCustomMeal({ ...patched, servingsText: '2' }, context()).ok).toBe(false);
    },
  );

  it('is a rule the schema also has, so the form is not inventing it', () => {
    expect(
      schemaRefuses({
        nutrition: { calories: 320, proteinGrams: 12, carbsGrams: 40, fatGrams: null },
      }),
    ).toBe(true);
    expect(
      schemaRefuses({
        nutrition: { calories: 320, proteinGrams: 12, carbsGrams: 40, fatGrams: 9 },
        nutritionProvenance: { origin: 'user', dataset: null, servings: null, reason: null },
      }),
    ).toBe(true);
  });

  it.each([
    ['0', M.servingsRange],
    ['25', M.servingsRange],
    ['2.5', M.wholeNumber],
    ['-1', M.negative],
    ['many', M.wholeNumber],
  ] as const)('refuses a serving count of %s', (servingsText, message) => {
    const errors = validateMealForm({ ...VALID, ...FIGURES, servingsText });
    expect(errors.servingsText).toBe(message);
  });

  it('pins the serving-count bound to nutritionProvenanceSchema, not to this module', () => {
    const figures = { calories: 320, proteinGrams: 12, carbsGrams: 40, fatGrams: 9 };
    for (const servings of [0, 25, 2.5]) {
      expect(
        schemaRefuses({
          nutrition: figures,
          nutritionProvenance: { origin: 'user', dataset: null, servings, reason: null },
        }),
      ).toBe(true);
    }
  });

  it('refuses a serving count with no figures rather than silently discarding it', () => {
    const errors = validateMealForm({ ...VALID, servingsText: '4' });
    expect(errors.servingsText).toBe(M.servingsWithoutNutrition);
    expect(composeCustomMeal({ ...VALID, servingsText: '4' }, context()).ok).toBe(false);
  });

  it.each(NUTRIENT_FIELDS)('bounds %s with its own schema maximum', (field) => {
    const overBy = {
      caloriesText: '2001',
      proteinGramsText: '201',
      carbsGramsText: '301',
      fatGramsText: '201',
    };
    const errors = validateMealForm({
      ...VALID,
      ...FIGURES,
      servingsText: '2',
      [field]: overBy[field],
    });
    expect(errors[field]).toBe(nutrientRangeMessage(field));
  });

  it('pins the calorie bound and integer rule to nutritionSummarySchema', () => {
    expect(
      schemaRefuses({
        nutrition: { calories: 2001, proteinGrams: 12, carbsGrams: 40, fatGrams: 9 },
        nutritionProvenance: { origin: 'user', dataset: null, servings: 2, reason: null },
      }),
    ).toBe(true);
    expect(
      schemaRefuses({
        nutrition: { calories: 2.5, proteinGrams: 12, carbsGrams: 40, fatGrams: 9 },
        nutritionProvenance: { origin: 'user', dataset: null, servings: 2, reason: null },
      }),
    ).toBe(true);
  });

  it.each(NUTRIENT_FIELDS)('reports a negative %s as negative, not as malformed', (field) => {
    const errors = validateMealForm({ ...VALID, ...FIGURES, servingsText: '2', [field]: '-1' });
    expect(errors[field]).toBe(M.negative);
  });
});

describe('price — minor units are derived, never typed', () => {
  it.each([
    ['4.50', 450],
    ['4.5', 450],
    ['4', 400],
    ['.5', 50],
    ['0', 0],
    ['0.05', 5],
    ['1000', 100_000],
    ['  4.50  ', 450],
  ] as const)('reads %s as %i cents', (priceText, cents) => {
    expect(validateMealForm({ ...VALID, priceText }).priceText).toBeUndefined();
    const meal = compose({ ...VALID, priceText });
    expect(meal.price.amountCents).toBe(cents);
    expect(moneySchema.safeParse(meal.price).success).toBe(true);
    // Round trip: edit mode reads the record back, and the number must not move.
    const again = compose({ ...VALID, priceText: draftFromCustomMeal(meal).priceText });
    expect(again.price.amountCents).toBe(cents);
  });

  it.each([
    ['4.505', M.pricePrecision],
    ['4.5000', M.pricePrecision],
    ['-1', M.negative],
    ['-0', M.negative],
    ['', M.priceRequired],
    ['   ', M.priceRequired],
    ['abc', M.priceFormat],
    ['1e3', M.priceFormat],
    ['٤', M.priceFormat],
    ['4.', M.priceFormat],
    ['4,50', M.priceFormat],
    ['$4.50', M.priceFormat],
    ['1000.01', M.priceRange],
    ['99999999', M.priceRange],
  ] as const)('refuses %s', (priceText, message) => {
    expect(validateMealForm({ ...VALID, priceText }).priceText).toBe(message);
    expect(composeCustomMeal({ ...VALID, priceText }, context()).ok).toBe(false);
  });

  it('never rounds: 4.505 is refused rather than stored as 451 or 450 cents', () => {
    expect(composeCustomMeal({ ...VALID, priceText: '4.505' }, context()).ok).toBe(false);
  });
});

describe('negative zero', () => {
  /**
   * `parseFloat('-0')` is `-0`, `Number.isInteger(-0)` is true, and Zod's `.int().min(0)`
   * therefore ACCEPTS it — so the schema is not the thing that catches this. A typed minus sign
   * is a negative number to the person who typed it, and this module is the only place that can
   * say so, which is why the assertion below is about the validator and not about the schema.
   */
  it.each(['priceText', 'preparationMinutesText', 'caloriesText'] as const)(
    'refuses -0 in %s',
    (field) => {
      const draft = { ...VALID, ...FIGURES, servingsText: '2', [field]: '-0' };
      expect(validateMealForm(draft)[field]).toBe(M.negative);
    },
  );

  it('is a value the schema itself would have taken', () => {
    expect(moneySchema.safeParse({ amountCents: -0, currency: 'USD' }).success).toBe(true);
  });
});

describe('draftFromCustomMeal', () => {
  it('round-trips a record through the form without changing it', () => {
    const original = compose({ ...VALID, ...FIGURES, servingsText: '3' });
    const again = composeCustomMealUpdate(draftFromCustomMeal(original), original, {
      now: () => NOW,
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.meal).toStrictEqual(original);
    }
  });

  it('produces a draft that validates clean', () => {
    expect(validateMealForm(draftFromCustomMeal(compose()))).toStrictEqual({});
  });

  it('renders an unset figure as a blank box, never as 0', () => {
    const draft = draftFromCustomMeal(compose());
    expect(draft.caloriesText).toBe('');
    expect(draft.proteinGramsText).toBe('');
    expect(draft.servingsText).toBe('');
  });

  it('drops a serving count the record carries with no figures to divide', () => {
    // `mealSchema`'s `user` branch permits this pair, so it is a record that can exist.
    const odd: CustomMeal = {
      ...compose(),
      nutritionProvenance: { origin: 'user', dataset: null, servings: 6, reason: null },
    };
    expect(customMealSchema.safeParse(odd).success).toBe(true);
    expect(draftFromCustomMeal(odd).servingsText).toBe('');
    expect(validateMealForm(draftFromCustomMeal(odd))).toStrictEqual({});
  });
});

describe('composeCustomMealUpdate', () => {
  it('keeps id and createdAt and moves updatedAt', () => {
    const existing = compose();
    const result = composeCustomMealUpdate({ ...VALID, name: 'Renamed oats' }, existing, {
      now: () => LATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meal.id).toBe(existing.id);
    expect(result.meal.createdAt).toBe(NOW);
    expect(result.meal.updatedAt).toBe(LATER);
    expect(result.meal.name).toBe('Renamed oats');
    expect(customMealSchema.safeParse(result.meal).success).toBe(true);
  });

  it('refuses an invalid edit with the same field-bound errors as a create', () => {
    const result = composeCustomMealUpdate({ ...VALID, name: '' }, compose(), { now: () => LATER });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe(M.nameRequired);
    }
  });
});

describe('id collision', () => {
  it('regenerates against existingIds and uses the fresh id', () => {
    const ids = [ID_A, ID_B];
    let call = 0;
    const result = composeCustomMeal(
      VALID,
      context({ existingIds: [ID_A], newId: () => ids[call++] ?? ID_B }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meal.id).toBe(ID_B);
    }
    expect(call).toBe(2);
  });

  it('gives up after five attempts rather than returning a colliding record', () => {
    let call = 0;
    const result = composeCustomMeal(
      VALID,
      context({
        existingIds: [ID_A],
        newId: () => {
          call += 1;
          return ID_A;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe(M.idCollision);
    }
    // Five, not four and not forever. The `created` reducer refuses a duplicate id SILENTLY, so
    // a sixth attempt returning `ok: true` would make the user's meal vanish with no message.
    expect(call).toBe(5);
  });
});

describe('the backstop', () => {
  it('refuses a record an injected clock made unstorable', () => {
    for (const bad of ['yesterday', '2026-02-31T00:00:00.000Z', '', '2026-09-13']) {
      const result = composeCustomMeal(VALID, context({ now: () => bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.name).toBe(M.notSaveable);
      }
    }
  });

  it('refuses a record an injected id generator made unstorable', () => {
    // `kebabIdSchema` is lowercase-only, so an upper-case id is a value storage rejects.
    const result = composeCustomMeal(VALID, context({ newId: () => 'NOT_A_KEBAB_ID' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBe(M.notSaveable);
    }
  });
});

describe('generateMealId, as the form actually uses it', () => {
  // The rest of `generateMealId`'s behaviour moved to `mealIdentity.test.ts` with the code. This
  // one stays because it is about the seam: a real generated id must survive composition.
  it('is accepted as a real id by composeCustomMeal', () => {
    const meal = compose(VALID, context({ newId: () => generateMealId() }));
    expect(meal.id).toMatch(MEAL_ID_PATTERN);
    expect(customMealSchema.safeParse(meal).success).toBe(true);
  });
});
