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
      citedMealIds:
        promptMealIds.length === 0
          ? /*
              **`maxItems: 0`, which is the only array a citation-less answer may be (R-81).**

              A `count` question resolves to an empty `namedMeals` (TSD 4.9: "Count -> empty,
              because the answer is a number and no meal needs describing"), so **every counting
              question takes this branch** - it is production behaviour, not an edge case.

              This used to be `{ type: 'string', maxLength: 200 }` at the item level, on reasoning
              that was half right: an empty `enum` IS either a schema error or an alternation
              matching nothing, and since `citedMealIds` is required, that would make every reply
              fail its own format. The step missed is that the constraint belongs on the ARRAY and
              not on the item. `maxItems: 0` admits exactly one value, `[]`, which satisfies
              `required` and carries no citation to check.

              **What the old shape cost, measured against a real `gemma3:4b` at P28:** a free
              bounded string let the model invent `"MEAL_ID_9"`, `"MEAL_ID_28"` and `"7"`,
              containment check 1 rejected them because an empty prompt id set permits no
              citation, and the correct count was discarded as a 503 - **3 of 3 count questions,
              in both measured sessions**. A user asking "how many are vegan?" got "The assistant
              is unavailable right now." essentially always, while the domain held the right
              answer.

              **This is a TSD 5.5 amendment**, because that section specifies this function
              verbatim, and it is in the permitted direction: PRD 7.4 lists **Count** as an
              answerable shape, TSD 5.5's schema made Count unanswerable, and PRD outranks TSD.
              Recorded in `Plan.md` as the R-81 closure rather than applied silently.
            */
            // The item's `maxLength` is kept although `maxItems: 0` makes it unreachable: it is
            // the contract's own id bound, it costs nothing, and it still limits the damage if a
            // future edit restores a non-zero `maxItems` without thinking about R-81.
            { type: 'array', maxItems: 0, items: { type: 'string', maxLength: 200 } }
          : { type: 'array', maxItems: 5, items: { type: 'string', enum: [...promptMealIds] } },
    },
    required: ['answered', 'answer', 'citedMealIds'],
    // A model returning an extra field must fail its own format, matching
    // `chatModelReplySchema`'s `z.strictObject`. Two layers, one rule - see the note above.
    additionalProperties: false,
  };
}
