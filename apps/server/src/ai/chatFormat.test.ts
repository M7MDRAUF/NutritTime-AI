import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatModelReplySchema } from '@nutritime/contracts';
import { chatFormat } from './chatFormat.js';

/**
 * The claim under test is T-19-04: `citedMealIds.items.enum` **equals** the prompt's ids -
 * not "contains them", not "is an array of strings". Equality in order, with nothing added
 * and nothing removed, is the whole of layer 0's guarantee (Plan 15.4).
 *
 * **The bounds are read out of `chatModelReplySchema`, never restated here.** A test asserting
 * `maxItems === 5` beside production code saying `maxItems: 5` proves that the number was
 * typed twice, not that the two layers agree. Zod 4 renders a schema's own constraints through
 * `z.toJSONSchema`, so both numbers come from one source and a change to TSD 3.3's contract
 * fails this suite.
 *
 * The derived schema is PARSED rather than indexed into. If Zod ever stops exposing a
 * constraint the parse throws and names it, instead of an `undefined` quietly comparing equal
 * to an `undefined` and every bound assertion passing on nothing.
 */
const derivedBounds = z
  .object({
    properties: z.object({
      answer: z.object({ minLength: z.number(), maxLength: z.number() }),
      citedMealIds: z.object({
        maxItems: z.number(),
        items: z.object({ maxLength: z.number() }),
      }),
    }),
    required: z.array(z.string()),
    // Deliberately `boolean`, not `literal(false)`: the assertion below compares two values,
    // so it has to be possible for the contract's value to be the other one.
    additionalProperties: z.boolean(),
  })
  .parse(z.toJSONSchema(chatModelReplySchema));

const ANSWER_BOUNDS = derivedBounds.properties.answer;
const CITATION_BOUNDS = derivedBounds.properties.citedMealIds;

/**
 * Ids lifted from `packages/catalog/meals.json` by hand, not generated from anything this
 * module does (BRIEF 6.3). Deliberately NOT in alphabetical or catalog order: a `.sort()`
 * anywhere in the implementation has to show up as a failure.
 */
const REAL_IDS = ['spicy-arrabiata-penne', 'english-breakfast', 'smoked-haddock-kedgeree'];

/** A disjoint second set, so no single constant can satisfy both enum assertions. */
const OTHER_IDS = ['breakfast-potatoes', 'home-made-mandazi'];

const citationItems = (ids: readonly string[]) => chatFormat(ids).properties.citedMealIds.items;

describe('chatFormat - the envelope', () => {
  it('is an object schema with the exact required triple and no extra fields allowed', () => {
    const format = chatFormat(REAL_IDS);

    expect(format.type).toBe('object');
    // Both read from `chatModelReplySchema`: the model's format and the decoder that
    // validates its reply must demand the same three fields, in the same order.
    expect(format.required).toEqual(derivedBounds.required);
    // Fixture 3 of nine - "extra field" - depends on this being false. A model returning a
    // fourth property must fail its own format.
    expect(format.additionalProperties).toBe(derivedBounds.additionalProperties);
    expect(format.additionalProperties).toBe(false);
  });

  it('bounds `answer` exactly as `chatModelReplySchema` does', () => {
    const answer = chatFormat(REAL_IDS).properties.answer;

    expect(answer).toStrictEqual({
      type: 'string',
      minLength: ANSWER_BOUNDS.minLength,
      maxLength: ANSWER_BOUNDS.maxLength,
    });
  });

  it('shapes the whole `citedMealIds` fragment, so no constraint can be added to it', () => {
    // **`toStrictEqual` on the whole fragment, not `maxItems` alone.** Asserting only the
    // properties this module happens to set leaves every property it does NOT set unasserted,
    // and `minItems: 1` is the one that matters: added here it would require a citation on
    // every reply, breaking every superlative answered from a single named meal. A vacuity
    // audit found that mutation passing all fourteen earlier assertions.
    expect(chatFormat(REAL_IDS).properties.citedMealIds).toStrictEqual({
      type: 'array',
      maxItems: CITATION_BOUNDS.maxItems,
      items: { type: 'string', enum: REAL_IDS },
    });
  });

  it('declares `answered` as a bare boolean', () => {
    expect(chatFormat(REAL_IDS).properties.answered).toStrictEqual({ type: 'boolean' });
  });
});

describe('chatFormat - T-19-04, the enum equals the prompt ids', () => {
  it('renders exactly the prompt ids, in prompt order, and nothing else', () => {
    const items = citationItems(REAL_IDS);

    // `toStrictEqual` on the WHOLE fragment, not just on `.enum`: it pins the absence of a
    // `maxLength` fallback alongside the enum, so an implementation that emitted both - and
    // would therefore still accept a fabricated id under the grammar - fails here.
    expect(items).toStrictEqual({ type: 'string', enum: REAL_IDS });
    expect(items.enum).toHaveLength(REAL_IDS.length);
  });

  it('is built per request: two prompts produce two different enums', () => {
    const first = citationItems(REAL_IDS);
    const second = citationItems(OTHER_IDS);

    // No constant, and no catalog-wide id list, can satisfy both of these (BRIEF 6.2 #2).
    expect(first.enum).toStrictEqual(REAL_IDS);
    expect(second.enum).toStrictEqual(OTHER_IDS);
    expect(first.enum).not.toStrictEqual(second.enum);
  });

  it('permits exactly one literal when the prompt carried one meal', () => {
    // The length-1 boundary: the non-empty branch has to fire here, not the bounded-string
    // one. A superlative with no ties is this case, and it is the commonest chat answer.
    expect(citationItems(['spicy-arrabiata-penne'])).toStrictEqual({
      type: 'string',
      enum: ['spicy-arrabiata-penne'],
    });
  });

  it('copies the ids verbatim - no normalisation, no de-duplication, no filtering', () => {
    // The catalog's ids are kebab-case by `kebabIdSchema`, so these spellings are not a
    // reachable state; the claim is about the copy, which must be a copy and not a cleanup.
    // A `new Set(...)`, a `.map(toLowerCase)` or a `.filter(isKebab)` all fail this.
    const odd = ['Mixed_Case', 'Mixed_Case', 'a b c'];

    expect(citationItems(odd).enum).toStrictEqual(['Mixed_Case', 'Mixed_Case', 'a b c']);
  });
});

describe('chatFormat - the empty branch is a branch, not an edge case', () => {
  /**
   * A `count` question resolves to an empty `namedMeals` (TSD 4.9), so this runs in
   * production on every counting question. An empty `enum` would be either a schema error or
   * an alternation matching nothing, and a grammar that can produce no citation at all would
   * make every reply fail its own required-field format.
   */
  it('omits the `enum` KEY entirely - not an empty array, not `undefined`', () => {
    const items = citationItems([]);

    // The key's absence, asserted three ways, because each one alone is beatable:
    // `in` misses nothing a prototype provides, `hasOwnProperty` is the direct claim, and
    // `Object.keys` catches an own key whose value happens to be `undefined`.
    expect('enum' in items).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(items, 'enum')).toBe(false);
    expect(Object.keys(items).sort()).toStrictEqual(['maxLength', 'type']);
    expect(items.enum).toBeUndefined();
  });

  it('falls back to a bounded string whose limit is the contract id limit', () => {
    // `toStrictEqual` would also fail on `enum: undefined`, which `toEqual` would let pass.
    expect(citationItems([])).toStrictEqual({
      type: 'string',
      maxLength: CITATION_BOUNDS.items.maxLength,
    });
  });

  it('shapes the whole `citedMealIds` fragment, and in particular sets no `minItems`', () => {
    // **The assertion this branch most needs, and the one a vacuity audit found missing.**
    // `minItems: 1` here would require a citation the prompt cannot supply - the enum is
    // absent precisely because `namedMeals` is empty - so every reply would fail its own
    // format and EVERY COUNT QUESTION would return a deterministic 503, on a question the
    // domain answered correctly. A whole answer shape, silently unavailable.
    //
    // Asserting the fragment key by key cannot catch that: an absent constraint has no key
    // to assert. Only `toStrictEqual` over the whole object does.
    expect(chatFormat([]).properties.citedMealIds).toStrictEqual({
      type: 'array',
      maxItems: CITATION_BOUNDS.maxItems,
      items: { type: 'string', maxLength: CITATION_BOUNDS.items.maxLength },
    });
  });

  it('still forbids extra fields and still bounds `answer` on the empty branch', () => {
    // The branch changes `items` and nothing else. A guard clause returning an early,
    // separately-written object would drift from the envelope above and fail here.
    const format = chatFormat([]);

    expect(format.additionalProperties).toBe(false);
    expect(format.required).toEqual(derivedBounds.required);
    expect(format.properties.answer).toStrictEqual({
      type: 'string',
      minLength: ANSWER_BOUNDS.minLength,
      maxLength: ANSWER_BOUNDS.maxLength,
    });
  });
});

/**
 * The same vacuity gap closed once at the top, for every level at once.
 *
 * The fragment assertions above are the ones whose failure message names the defect; these two
 * are the backstop. An added key ANYWHERE - a `minItems` on the array, a `pattern` on `answer`,
 * a `minProperties` on the root, a fourth property beside the three `required` names - fails
 * here even if nobody thought to assert that key. There is one of these per branch because
 * only `items` differs between them, and a single-branch version would leave the other half of
 * the function shaped by nothing.
 */
describe('chatFormat - the whole schema, key for key', () => {
  const envelope = {
    type: 'object',
    properties: {
      answered: { type: 'boolean' },
      answer: {
        type: 'string',
        minLength: ANSWER_BOUNDS.minLength,
        maxLength: ANSWER_BOUNDS.maxLength,
      },
    },
    required: derivedBounds.required,
    additionalProperties: derivedBounds.additionalProperties,
  };

  it('is exactly this, and nothing more, when the prompt carried meals', () => {
    expect(chatFormat(REAL_IDS)).toStrictEqual({
      ...envelope,
      properties: {
        ...envelope.properties,
        citedMealIds: {
          type: 'array',
          maxItems: CITATION_BOUNDS.maxItems,
          items: { type: 'string', enum: REAL_IDS },
        },
      },
    });
  });

  it('is exactly this, and nothing more, when the prompt carried none', () => {
    expect(chatFormat([])).toStrictEqual({
      ...envelope,
      properties: {
        ...envelope.properties,
        citedMealIds: {
          type: 'array',
          maxItems: CITATION_BOUNDS.maxItems,
          items: { type: 'string', maxLength: CITATION_BOUNDS.items.maxLength },
        },
      },
    });
  });
});

describe('chatFormat - the enum is a copy, not an alias', () => {
  it('is unchanged when the caller mutates the array it passed in', () => {
    const callerIds = [...REAL_IDS];
    const format = chatFormat(callerIds);

    // The widening a caller must not be able to perform after the fact.
    callerIds.push('fabricated-meal-id');
    callerIds[0] = 'overwritten-meal-id';

    expect(format.properties.citedMealIds.items.enum).toStrictEqual(REAL_IDS);
    expect(format.properties.citedMealIds.items.enum).not.toContain('fabricated-meal-id');
    // Reference inequality alone proves nothing (a fresh wrapper around the same array beats
    // it), so it stands only beside the mutation above.
    expect(format.properties.citedMealIds.items.enum).not.toBe(callerIds);
  });

  it('does not mutate the array it was given', () => {
    const callerIds = [...REAL_IDS];

    chatFormat(callerIds);

    expect(callerIds).toStrictEqual(REAL_IDS);
  });

  it('returns a fresh fragment per call, on both branches', () => {
    // Two callers must not share one mutable schema object - including on the empty branch,
    // where a hoisted module constant would be the natural thing to reach for.
    expect(citationItems(REAL_IDS)).not.toBe(citationItems(REAL_IDS));
    expect(citationItems([])).not.toBe(citationItems([]));
    expect(chatFormat([]).properties).not.toBe(chatFormat([]).properties);
  });
});
