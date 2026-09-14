/**
 * Layer 0 of containment (Plan 15.4): the citation constraint that runs at GENERATION time.
 *
 * Ollama compiles the request's `format` field into a GBNF grammar through llama.cpp's
 * schema-to-grammar converter, which renders a JSON Schema `enum` as an alternation of
 * literals. So when `citedMealIds.items` is an `enum` of exactly the ids this prompt carried,
 * a fabricated citation is not caught after the fact - it cannot be sampled (TSD 5.5).
 *
 * **That is why this is a function and not a constant.** A static schema would have to list
 * either every id in the catalog or none of them, and either way the mechanism would be gone:
 * the constraint is only as tight as the prompt it was built for.
 *
 * **Layer 0 does not replace containment check 1.** The grammar path is upstream behaviour
 * across two projects whose versions this repository does not pin (TSD 2.1 pins neither Ollama
 * nor llama.cpp), and a constraint that silently stopped being enforced would remove the
 * guarantee with no signal. TSD 5.5 is explicit: the 5.7 citation check still runs anyway.
 */

/** A JSON Schema fragment, as Ollama's `format` field takes it. */
export interface JsonStringSchema {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
}

export interface ChatFormat {
  readonly type: 'object';
  readonly properties: {
    readonly answered: { readonly type: 'boolean' };
    readonly answer: JsonStringSchema;
    readonly citedMealIds: {
      readonly type: 'array';
      readonly maxItems: number;
      readonly items: JsonStringSchema;
    };
  };
  readonly required: readonly ['answered', 'answer', 'citedMealIds'];
  readonly additionalProperties: false;
}

/**
 * The per-request reply schema for the chat lane, verbatim from TSD 5.5.
 *
 * The bounds mirror `chatModelReplySchema` (TSD 3.3) field for field - `answer` 1..700,
 * `citedMealIds` at most 5, an id at most 200 characters. They are two enforcement points for
 * one rule: the grammar stops the model writing an out-of-bounds reply, and the schema stops
 * an out-of-bounds reply being believed if the grammar was not applied. `chatFormat.test.ts`
 * reads the numbers back out of the Zod schema rather than restating them, so the two cannot
 * drift apart unnoticed.
 *
 * `promptMealIds` is COPIED into the `enum`, not aliased. The returned object outlives this
 * call - it is handed to the Ollama client and, under `AI_FAKE`, to nothing at all - and a
 * caller that kept its own reference to the id array would otherwise be able to widen the
 * grammar after the schema was built.
 *
 * @param promptMealIds the ids of `resolved.namedMeals`, in block order (TSD 5.6)
 */
export function chatFormat(promptMealIds: readonly string[]): ChatFormat {
  return {
    type: 'object',
    properties: {
      answered: { type: 'boolean' },
      answer: { type: 'string', minLength: 1, maxLength: 700 },
      citedMealIds: {
        type: 'array',
        maxItems: 5,
        items:
          promptMealIds.length === 0
            ? // **No `enum` key at all, and this branch is production behaviour, not an
              // edge case.** A `count` question resolves to an empty `namedMeals` (TSD 4.9:
              // "Count -> empty, because the answer is a number and no meal needs
              // describing"), so every counting question takes this path.
              //
              // An empty `enum` is either a schema error or an alternation that matches
              // nothing, which would make the grammar unable to produce a citation at all -
              // and since `citedMealIds` is required, every reply would then fail its own
              // format and the lane would 503 on a question the domain answered correctly.
              // A plain bounded string is the honest shape: the grammar permits a citation,
              // and containment check 1 rejects it, because an empty prompt id set permits
              // no citation.
              { type: 'string', maxLength: 200 }
            : { type: 'string', enum: [...promptMealIds] },
      },
    },
    required: ['answered', 'answer', 'citedMealIds'],
    // A model returning an extra field must fail its own format, matching
    // `chatModelReplySchema`'s `z.strictObject`. Two layers, one rule - see the note above.
    additionalProperties: false,
  };
}
