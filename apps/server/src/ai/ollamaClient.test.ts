import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatModelReplySchema, explanationReplySchema } from '@nutritime/contracts';
import type { ChatModelReply, ExplanationReply } from '@nutritime/contracts';
import { GENERATION, loadConfig } from '../config.js';
import { chatFormat } from './chatFormat.js';
import { OllamaAbortError, OllamaError, createOllamaClient } from './ollamaClient.js';
import type { FetchLike, OllamaFailureReason, OllamaGenerateRequest } from './ollamaClient.js';

/**
 * T-19-05 (TSD 5.5; Plan 17's T-19-05 row).
 *
 * Three claims carry the phase, and each one is probed rather than asserted-and-hoped:
 *
 * 1. **The request body is TSD 5.5's and nothing else.** Asserted with a `toStrictEqual` against
 *    a fully-specified expectation, so a `system` or `template` field creeping in fails. A test
 *    that checked the three fields it happened to care about would not notice.
 * 2. **`done_reason: 'length'` is a failure, not a partial success.** Two separate properties
 *    carry this, and two different fixtures catch them - established by running both mutations,
 *    not by reasoning about them:
 *
 *    - **Unconditional** is what keeps a truncated reply from being RETURNED. *Gating* the check
 *      on a parse or schema failure - the tempting tidy-up, since it reads as "only bother asking
 *      about truncation when something else went wrong" - hands a truncated reply straight back.
 *      Only the clean-boundary fixture catches that, because it is truncated *and* parseable
 *      *and* schema-valid, so nothing downstream objects to it.
 *    - **Early** is what keeps the reported reason honest. Relocating the check below the inner
 *      `JSON.parse`, still unconditional, still rejects every truncated reply - but a reply that
 *      is truncated *and* unparseable then reports `schema`, so TSD 5.8's `outcome` blames the
 *      model's JSON for what was really a `num_predict` ceiling. Only the mid-string fixture
 *      catches that.
 *
 *    So neither fixture is redundant and neither subsumes the other. An earlier version of this
 *    comment claimed the position was the whole point; a mutation pass corrected that to
 *    unconditionality alone, and the relocation probe run against this file corrected it again -
 *    the position is not the safety property, but it is not unobservable either.
 * 3. **No upstream text escapes the module.** A distinctive token is planted in the status line,
 *    the failure body, the envelope, the inner reply and the transport rejection, and asserted
 *    absent from everything thrown.
 *
 * **No test here reaches the network.** `fetchImpl` is a parameter for exactly that reason; the
 * one test that exercises the default supplies a `vi.spyOn` over `globalThis.fetch` that rejects
 * without connecting, and it is the only place in the file that mentions the global.
 *
 * Fixtures are written to a checklist of attack shapes - a proxy HTML page, a JSON array, a
 * missing `response`, a non-string `done_reason`, a reply cut mid-string, a reply cut on a clean
 * boundary, a fenced code block - and never sampled from what the implementation happens to
 * produce (Brief 6.3).
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A real `ServerConfig`, through the real parser.
 *
 * Hand-rolling the object would let this file assert a body built from a shape `loadConfig`
 * cannot actually produce - and the field spellings are the live disagreement between TSD 5.5's
 * snippet and TSD 5.2's table, so the parser is the thing worth deferring to.
 */
const config = loadConfig({
  OLLAMA_BASE_URL: 'http://ollama.test:11434',
  OLLAMA_MODEL: 'gemma3:4b',
  AI_KEEP_ALIVE: '30m',
});

const URL_UNDER_TEST = 'http://ollama.test:11434/api/generate';

const PROMPT_MEAL_IDS = ['lentil-soup', 'greek-yogurt-bowl'];

const PROMPT = 'ROLE\nRULES\nANSWER\nFIGURES\nMEALS\nQUESTION';

/** A schema-valid reply, as a string, because the envelope carries the model's JSON as one. */
const VALID_REPLY_JSON =
  '{"answered":true,"answer":"Lentil soup carries 18 g of protein.","citedMealIds":["lentil-soup"]}';

/**
 * A `format` fixture owned by THIS file, for the whole-body `toStrictEqual`.
 *
 * The body assertion used to restate `chatFormat`'s output as literals, and that was a coupling
 * defect rather than thoroughness: `chatFormat.ts` belongs to another module, so a legitimate
 * change to what it emits turned this file red for something this file does not own. (It did
 * exactly that mid-window.) More importantly it asserted the wrong thing - CONTRACTS 7 makes
 * `format` **caller-supplied**, so this client's obligation is that whatever it was handed
 * arrives on the wire unaltered, not that the handed thing has any particular shape. Asserting
 * A3's numbers here was testing A3's module through mine.
 *
 * `chatFormat` is still exercised, by `forwards the real chatFormat output deep-equal` below,
 * which compares against a fresh call rather than against a transcription - so it stays true for
 * any correct `chatFormat` instead of pinning one version of it.
 */
const FORMAT_FIXTURE = {
  type: 'object',
  properties: {
    answered: { type: 'boolean' },
    answer: { type: 'string', minLength: 1, maxLength: 700 },
    citedMealIds: { type: 'array', maxItems: 5, items: { type: 'string', enum: ['lentil-soup'] } },
  },
  required: ['answered', 'answer', 'citedMealIds'],
  additionalProperties: false,
};

function chatRequest(
  format: unknown = chatFormat(PROMPT_MEAL_IDS),
): OllamaGenerateRequest<ChatModelReply> {
  return { prompt: PROMPT, format, decode: chatModelReplySchema };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

interface Recorder {
  readonly fetch: FetchLike;
  readonly calls: Call[];
  /** The `Response` objects handed back, so a test can ask whether their bodies were read. */
  readonly served: Response[];
}

/** A `fetch` that answers from a script and records what it was asked for. */
function recording(respond: () => Response): Recorder {
  const calls: Call[] = [];
  const served: Response[] = [];
  return {
    calls,
    served,
    fetch: (url, init) => {
      calls.push({ url, init });
      const response = respond();
      served.push(response);
      return Promise.resolve(response);
    },
  };
}

/** A `fetch` that rejects the way a transport failure does. */
function rejecting(reason: unknown): Recorder {
  const calls: Call[] = [];
  return {
    calls,
    served: [],
    fetch: (url, init) => {
      calls.push({ url, init });
      return Promise.reject(reason);
    },
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An envelope with no `done_reason` at all. */
function envelope(response: string): Response {
  return jsonResponse({ response });
}

/** An envelope whose `done_reason` is whatever is handed over, valid or not. */
function envelopeDone(response: string, doneReason: unknown): Response {
  return jsonResponse({ response, done_reason: doneReason });
}

function sentBody(call: Call | undefined): Record<string, unknown> {
  const raw = call?.init.body;
  if (typeof raw !== 'string') {
    throw new Error('the client did not send a string body');
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('the client did not send a JSON object body');
  }
  return { ...parsed };
}

/** Runs one generate and returns what it threw, so a table can assert over many shapes. */
async function thrownBy(recorder: Recorder): Promise<unknown> {
  const client = createOllamaClient(config, recorder.fetch);
  try {
    await client.generate(chatRequest(), new AbortController().signal);
  } catch (error: unknown) {
    return error;
  }
  throw new Error('generate resolved where it was expected to reject');
}

/** Narrows without a cast, so the assertions below read real properties of a real type. */
async function ollamaErrorFrom(recorder: Recorder): Promise<OllamaError> {
  const error = await thrownBy(recorder);
  if (!(error instanceof OllamaError)) {
    throw new Error(`expected an OllamaError, got ${typeof error}`);
  }
  return error;
}

async function reasonFrom(recorder: Recorder): Promise<OllamaFailureReason> {
  return (await ollamaErrorFrom(recorder)).reason;
}

async function resolvedChatReply(recorder: Recorder): Promise<ChatModelReply> {
  return createOllamaClient(config, recorder.fetch).generate(
    chatRequest(),
    new AbortController().signal,
  );
}

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

describe('the Ollama request', () => {
  it('is TSD 5.5 field for field and carries NOTHING else', async () => {
    const recorder = recording(() => envelope(VALID_REPLY_JSON));
    const client = createOllamaClient(config, recorder.fetch);
    const signal = new AbortController().signal;

    await client.generate(chatRequest(FORMAT_FIXTURE), signal);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];
    expect(call?.url).toBe(URL_UNDER_TEST);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.headers).toStrictEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
    // The caller's own signal, not a fresh one: this module holds no timeout of its own.
    expect(call?.init.signal).toBe(signal);
    // Nothing else in `init` either - no `keepalive`, no `redirect`, no `duplex`.
    expect(Object.keys(call?.init ?? {}).sort()).toStrictEqual([
      'body',
      'headers',
      'method',
      'signal',
    ]);

    // **The whole body, strictly.** An added `system`, `template`, `raw`, `images` or `suffix`
    // field fails here and only here. The four `options` values are the literals of TSD 5.2's
    // table rather than reads of `GENERATION`, so a drift in either place is caught - see the
    // `GENERATION` test below for the other half of that pair.
    //
    // `format` is this file's own fixture and is asserted as the same object that went in, which
    // is the pass-through obligation CONTRACTS 7 actually places on this client. See
    // `FORMAT_FIXTURE`.
    expect(sentBody(call)).toStrictEqual({
      model: 'gemma3:4b',
      prompt: PROMPT,
      stream: false,
      format: FORMAT_FIXTURE,
      keep_alive: '30m',
      options: { num_ctx: 4096, num_predict: 300, temperature: 0, seed: 7 },
    });
  });

  it('forwards the real chatFormat output deep-equal', async () => {
    // The composition check, against a FRESH `chatFormat` call rather than a transcription of one.
    // Both sides move together, so this stays true for any correct `chatFormat` while still
    // failing a client that dropped, re-derived or mutated the schema it was handed. It is not
    // vacuous: `chatFormat`'s return type forbids `undefined`, so a dropped field fails here.
    const recorder = recording(() => envelope(VALID_REPLY_JSON));
    const client = createOllamaClient(config, recorder.fetch);

    await client.generate(chatRequest(), new AbortController().signal);

    expect(sentBody(recorder.calls[0])['format']).toStrictEqual(chatFormat(PROMPT_MEAL_IDS));
  });

  it('sends the caller-supplied format verbatim - it knows nothing about chat', async () => {
    const recorder = recording(() =>
      envelope('{"mealId":"lentil-soup","reason":"It is cheap and quick."}'),
    );
    const client = createOllamaClient(config, recorder.fetch);
    const explanation: OllamaGenerateRequest<ExplanationReply> = {
      prompt: 'explain',
      // A shape `chatFormat` cannot produce, so nothing in the client can be inferring it.
      format: { type: 'object', properties: { mealId: { type: 'string' } }, nonsense: [1, 2] },
      decode: explanationReplySchema,
    };

    await expect(client.generate(explanation, new AbortController().signal)).resolves.toStrictEqual(
      { mealId: 'lentil-soup', reason: 'It is cheap and quick.' },
    );
    expect(sentBody(recorder.calls[0])['format']).toStrictEqual({
      type: 'object',
      properties: { mealId: { type: 'string' } },
      nonsense: [1, 2],
    });
  });

  it('passes AI_KEEP_ALIVE through as the duration STRING, unparsed and unconverted', async () => {
    for (const keepAlive of ['30m', '90s', '2h', '500ms', '0s']) {
      const recorder = recording(() => envelope(VALID_REPLY_JSON));
      const client = createOllamaClient(
        loadConfig({
          OLLAMA_BASE_URL: 'http://ollama.test:11434',
          OLLAMA_MODEL: 'gemma3:4b',
          AI_KEEP_ALIVE: keepAlive,
        }),
        recorder.fetch,
      );

      await client.generate(chatRequest(), new AbortController().signal);

      const sent = sentBody(recorder.calls[0])['keep_alive'];
      // Both halves matter. The value, and that it is a STRING: Ollama reads a bare number as
      // seconds, so a client that helpfully converted `30m` to `1800` would evict the model
      // between questions and resurface as a ~60-second cold load disguised as a timeout - the
      // exact failure TSD 5.2 rejects the bare form at boot to prevent.
      expect(sent).toBe(keepAlive);
      expect(typeof sent).toBe('string');
    }
  });

  it('reads the model from OLLAMA_MODEL and the URL from OLLAMA_BASE_URL', async () => {
    const recorder = recording(() => envelope(VALID_REPLY_JSON));
    const client = createOllamaClient(
      loadConfig({ OLLAMA_BASE_URL: 'https://gpu.example:9999/', OLLAMA_MODEL: 'gemma3:12b' }),
      recorder.fetch,
    );

    await client.generate(chatRequest(), new AbortController().signal);

    // The trailing slash is stripped by `loadConfig`, so the path never becomes `//api/generate`.
    expect(recorder.calls[0]?.url).toBe('https://gpu.example:9999/api/generate');
    expect(sentBody(recorder.calls[0])['model']).toBe('gemma3:12b');
  });

  it('holds GENERATION to TSD 5.2 - the other half of the options assertion', () => {
    // The body test asserts literals. This asserts the constants hold the same literals, so a
    // change to either is caught: drift in `GENERATION` fails here, a client sending something
    // else fails there. (T-19-06 is a source review; this is its guard rail.)
    expect(GENERATION).toStrictEqual({ numCtx: 4096, numPredict: 300, temperature: 0, seed: 7 });
  });
});

// ---------------------------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------------------------

describe('the two-stage decode, success', () => {
  it('returns the schema-parsed inner reply', async () => {
    const recorder = recording(() => envelope(VALID_REPLY_JSON));

    await expect(resolvedChatReply(recorder)).resolves.toStrictEqual({
      answered: true,
      answer: 'Lentil soup carries 18 g of protein.',
      citedMealIds: ['lentil-soup'],
    });
    // The pair for the `http-status` assertion below: here the body IS read.
    expect(recorder.served[0]?.bodyUsed).toBe(true);
  });

  it('tolerates the full envelope a real Ollama sends, not a two-field idealisation', async () => {
    // The shape of a real non-streamed `/api/generate` reply. An envelope parse strict enough to
    // reject these siblings would fail every genuine call while every fixture here stayed green.
    const recorder = recording(() =>
      jsonResponse({
        model: 'gemma3:4b',
        created_at: '2026-01-14T09:12:41.882Z',
        response: VALID_REPLY_JSON,
        done: true,
        done_reason: 'stop',
        context: [105, 2364, 107],
        total_duration: 4_182_991_100,
        load_duration: 31_204_500,
        prompt_eval_count: 1204,
        prompt_eval_duration: 498_112_000,
        eval_count: 41,
        eval_duration: 3_650_004_000,
      }),
    );

    await expect(resolvedChatReply(recorder)).resolves.toMatchObject({ answered: true });
  });

  it('accepts a 2xx at the boundary and refuses the one past it', async () => {
    await expect(
      resolvedChatReply(recording(() => jsonResponse({ response: VALID_REPLY_JSON }, 299))),
    ).resolves.toMatchObject({ answered: true });

    await expect(
      reasonFrom(recording(() => jsonResponse({ response: VALID_REPLY_JSON }, 300))),
    ).resolves.toBe('http-status');
  });
});

// ---------------------------------------------------------------------------------------------
// Failure, in TSD 5.5's order
// ---------------------------------------------------------------------------------------------

describe('http-status', () => {
  it('is the reason for any non-2xx, and the body is NEVER read', async () => {
    for (const status of [400, 404, 429, 500, 502, 503]) {
      const recorder = recording(
        () => new Response('{"error":"model \'gemma3:4b\' not found"}', { status }),
      );
      await expect(reasonFrom(recorder)).resolves.toBe('http-status');
      // Reading a failure body for detail is how upstream text gets in. `bodyUsed` is the only
      // assertion that can tell "we did not read it" from "we read it and threw the text away" -
      // and the second one is a leak waiting for its first interpolation.
      expect(recorder.served[0]?.bodyUsed).toBe(false);
    }
  });
});

describe('envelope', () => {
  const cases: ReadonlyArray<readonly [string, () => Response]> = [
    // A proxy or a dev server in the middle, which is what a wrong OLLAMA_BASE_URL actually hits.
    ['an HTML error page', () => new Response('<html><body>502 Bad Gateway</body></html>')],
    ['a bare string body', () => new Response('ok')],
    ['an empty body', () => new Response('')],
    ['a JSON body cut off mid-string', () => new Response('{"response":"{\\"answered\\":true}')],
    ['a JSON array', () => new Response('[{"response":"{}"}]')],
    ['JSON null', () => new Response('null')],
    ['a JSON number', () => new Response('7')],
    ['an object with no `response`', () => new Response('{"done":true,"done_reason":"stop"}')],
    ['a non-string `response`', () => new Response('{"response":42}')],
    ['a null `response`', () => new Response('{"response":null}')],
    ['an object `response`', () => new Response('{"response":{"answered":true}}')],
    // The field the truncation check reads. If it arrives as something unexpected, "generation
    // completed" is not a safe default, so the envelope is rejected rather than shrugged at.
    ['a numeric `done_reason`', () => envelopeDone(VALID_REPLY_JSON, 7)],
    ['an object `done_reason`', () => envelopeDone(VALID_REPLY_JSON, { kind: 'length' })],
    ['an array `done_reason`', () => envelopeDone(VALID_REPLY_JSON, ['length'])],
  ];

  for (const [label, make] of cases) {
    it(`rejects ${label}`, async () => {
      await expect(reasonFrom(recording(make))).resolves.toBe('envelope');
    });
  }

  it('accepts an absent or null `done_reason` - neither is a truncation', async () => {
    // JSON has no `undefined`, so "absent" is the only spelling of it on the wire; both shapes
    // are here because a reader that only defaulted one of them would pass a single case.
    for (const make of [
      () => envelope(VALID_REPLY_JSON),
      () => envelopeDone(VALID_REPLY_JSON, null),
    ]) {
      await expect(resolvedChatReply(recording(make))).resolves.toMatchObject({ answered: true });
    }
  });
});

describe('empty-reply', () => {
  it('is whitespace-only, in any spelling', async () => {
    for (const blank of ['', ' ', '\n', '\t  \r\n ']) {
      await expect(reasonFrom(recording(() => envelope(blank)))).resolves.toBe('empty-reply');
    }
  });

  it('wins over `done_reason: "length"` - the empty check is step 2 and truncation is step 3', async () => {
    // A model given no room at all returns an empty string AND `done_reason: 'length'`. The
    // order is TSD 5.5's, and this pins it: `empty-reply` is the more specific fact.
    await expect(reasonFrom(recording(() => envelopeDone('   ', 'length')))).resolves.toBe(
      'empty-reply',
    );
  });
});

describe('truncated - T-19-05', () => {
  /**
   * **The test that separates an unconditional truncation check from a conditional one.** The
   * reply is cut on a clean boundary, so it is valid JSON and it satisfies `chatModelReplySchema`
   * completely - which means a client that only asks about `done_reason` when the parse or the
   * schema already failed has a reply it has no grounds to reject, and hands back a sentence the
   * model never finished saying.
   *
   * The sentence is the point: "Lentil soup has more protein than" stops mid-claim. Shown to a
   * user it reads as a finished comparison with its object dropped.
   */
  it('fails a reply that is truncated AND parseable AND schema-valid', async () => {
    const cutButValid = JSON.stringify({
      answered: true,
      answer: 'Lentil soup has more protein than',
      citedMealIds: ['lentil-soup'],
    });
    // The fixture's own premise, asserted so this test cannot quietly become the easy case:
    // nothing downstream of the truncation check would have objected to it.
    const inner: unknown = JSON.parse(cutButValid);
    expect(chatModelReplySchema.safeParse(inner).success).toBe(true);

    const recorder = recording(() => envelopeDone(cutButValid, 'length'));

    await expect(reasonFrom(recorder)).resolves.toBe('truncated');
    expect(recorder.calls).toHaveLength(1);
  });

  it('fails a reply cut mid-string too - and reports truncation, not schema', async () => {
    // **Not redundant with the clean-boundary case above, and not a weaker version of it.** The
    // gating mutation passes THIS one (it reports `truncated`, because the parse failed first)
    // and fails that one. Relocating the check below the parse does the reverse: that one stays
    // green and this one reports `schema`. Each fixture is the only thing that catches one of the
    // two mutations - verified by running both.
    const recorder = recording(() =>
      envelopeDone('{"answered":true,"answer":"Lentil soup has more prot', 'length'),
    );
    await expect(reasonFrom(recorder)).resolves.toBe('truncated');
  });

  it('treats only the exact value "length" as truncation', async () => {
    for (const doneReason of ['stop', 'load', 'unload', 'Length', 'LENGTH', 'length ', '']) {
      await expect(
        resolvedChatReply(recording(() => envelopeDone(VALID_REPLY_JSON, doneReason))),
      ).resolves.toMatchObject({ answered: true });
    }
  });
});

describe('schema', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['prose instead of JSON', 'Sure! Lentil soup is the highest in protein.'],
    ['a fenced code block', '```json\n{"answered":true,"answer":"x","citedMealIds":[]}\n```'],
    ['JSON with a trailing comma', '{"answered":true,"answer":"x","citedMealIds":[],}'],
    ['single-quoted keys', "{'answered':true,'answer':'x','citedMealIds':[]}"],
    ['an array where an object belongs', '[{"answered":true}]'],
    ['a missing field', '{"answered":true,"answer":"x"}'],
    // `chatModelReplySchema` is a `z.strictObject`: an extra field is a rejection, not a shrug.
    ['an extra field', '{"answered":true,"answer":"x","citedMealIds":[],"calories":500}'],
    ['an empty answer', '{"answered":true,"answer":"","citedMealIds":[]}'],
    [
      'a six-citation reply',
      '{"answered":true,"answer":"x","citedMealIds":["a","b","c","d","e","f"]}',
    ],
    ['a wrong-typed field', '{"answered":"yes","answer":"x","citedMealIds":[]}'],
    ['a JSON string where an object belongs', '"answered"'],
  ];

  for (const [label, reply] of cases) {
    it(`rejects ${label}`, async () => {
      await expect(reasonFrom(recording(() => envelopeDone(reply, 'stop')))).resolves.toBe(
        'schema',
      );
    });
  }
});

describe('unreachable', () => {
  it('is a fetch rejection on a signal that was never aborted', async () => {
    await expect(reasonFrom(rejecting(new TypeError('fetch failed')))).resolves.toBe('unreachable');
  });

  it('is a body that dies after the status line on a signal that was never aborted', async () => {
    // A socket that closes mid-response: the status arrived, the body did not. `'unreachable'`'s
    // second clause, not a malformed envelope.
    //
    // **This is one half of a pair.** `an aborted fetch > is an abort even when it is the BODY
    // read that fails` is the other, and it drives the same `catch` with the signal aborted. No
    // single return value satisfies both, which is what makes the ternary in that `catch` tested
    // rather than merely present.
    const recorder = recording(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('ECONNRESET 127.0.0.1:11434'));
            },
          }),
          { status: 200 },
        ),
    );
    await expect(reasonFrom(recorder)).resolves.toBe('unreachable');
  });
});

// ---------------------------------------------------------------------------------------------
// Abort - deliberately NOT one of the six reasons
// ---------------------------------------------------------------------------------------------

/**
 * A `fetch` that answers a status line, then kills the BODY once the signal is aborted.
 *
 * Driving the second `catch` needs a response that already exists, so this cannot be built from
 * `abortingFetch` below - that one never resolves at all. The abort listener is registered inside
 * the stream's `start`, which runs synchronously while `fetchImpl` is still on the stack, so a
 * caller may abort as soon as `generate` has returned its promise.
 */
function bodyDiesOnAbort(): FetchLike {
  return (_url, init) => {
    const signal = init.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal === null || signal === undefined) {
          // Fail loudly rather than hang, for the reason `abortingFetch` gives below.
          controller.error(new Error('the client did not forward its signal'));
          return;
        }
        const die = (): void => {
          controller.error(new Error('ECONNRESET 127.0.0.1:11434'));
        };
        if (signal.aborted) {
          die();
          return;
        }
        signal.addEventListener('abort', die);
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  };
}

/** A `fetch` that rejects only once the signal it was handed is aborted. */
function abortingFetch(reject: (fail: (reason: unknown) => void) => void): FetchLike {
  return (_url, init) =>
    new Promise<Response>((_resolve, fail) => {
      const signal = init.signal;
      if (signal === null || signal === undefined) {
        // Fail loudly rather than hang: the client not forwarding the signal is a defect, and a
        // test that waited forever for it would report as a timeout instead.
        fail(new Error('the client did not forward its signal'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(fail);
      });
    });
}

async function thrownFrom(fetchImpl: FetchLike, signal: AbortSignal): Promise<Error> {
  const client = createOllamaClient(config, fetchImpl);
  try {
    await client.generate(chatRequest(), signal);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error('expected an Error');
  }
  throw new Error('generate resolved where it was expected to reject');
}

describe('an aborted fetch', () => {
  /**
   * The pair, and no single mapping satisfies both this and `unreachable`'s test above: a client
   * that answers `'unreachable'` for every rejection fails here, and one that rethrows every
   * rejection unchanged fails there.
   *
   * Cancellation is something the CALLER did; every member of `OllamaFailureReason` describes
   * something the upstream did. Calling an abort `'unreachable'` would make TSD 5.8's `outcome`
   * read `unreachable` for a call that actually timed out - the same mis-report `aiLane.ts`
   * rejects-before-aborting to avoid.
   */
  it('is not reported as an Ollama failure at all', async () => {
    const controller = new AbortController();
    const fetchImpl = abortingFetch((fail) => {
      fail(new DOMException('This operation was aborted', 'AbortError'));
    });
    const pending = thrownFrom(fetchImpl, controller.signal);
    controller.abort();

    const error = await pending;

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(error).not.toBeInstanceOf(OllamaError);
    expect(error.name).toBe('OllamaAbortError');
    expect(error.message).toBe('The Ollama call was aborted by its caller.');
  });

  it('discards the abort reason rather than carrying it out', async () => {
    // `abort(reason)` lets a caller attach an arbitrary object, and a client that rethrew the
    // original would publish it. Fixed local copy, here as everywhere.
    const controller = new AbortController();
    const fetchImpl = abortingFetch((fail) => {
      fail(new Error('aborted while talking to POISON-TOKEN-9f3a:11434'));
    });
    const pending = thrownFrom(fetchImpl, controller.signal);
    controller.abort(new Error('POISON-TOKEN-9f3a'));

    const error = await pending;

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(JSON.stringify([error.name, error.message, String(error)])).not.toContain(
      'POISON-TOKEN-9f3a',
    );
  });

  /**
   * **The second `catch` has its own abort branch, and this is what drives it.**
   *
   * There are two places a cancellation can surface: the `fetch` call itself rejecting, and the
   * body read rejecting after a status line already arrived. The tests above only reach the
   * first. Losing the ternary in the second would make a chat request that timed out mid-download
   * log `outcome: 'unreachable'` (TSD 5.8) - telling an operator the model is not there when the
   * truth is that it was too slow. Those have different causes and different fixes, and `outcome`
   * is the one field that separates them. It is A5's lane-side defect at the other end of the
   * same race.
   *
   * Paired with `unreachable > is a body that dies after the status line on a signal that was
   * never aborted`: same `catch`, opposite signal state, and no single return value satisfies
   * both.
   */
  it('is an abort even when it is the BODY read that fails', async () => {
    const controller = new AbortController();
    const pending = thrownFrom(bodyDiesOnAbort(), controller.signal);
    controller.abort();

    const error = await pending;

    expect(error).toBeInstanceOf(OllamaAbortError);
    expect(error).not.toBeInstanceOf(OllamaError);
    expect(error.name).toBe('OllamaAbortError');
    expect(error.message).toBe('The Ollama call was aborted by its caller.');
  });
});

// ---------------------------------------------------------------------------------------------
// The rule this module exists for
// ---------------------------------------------------------------------------------------------

const REASONS: readonly OllamaFailureReason[] = [
  'unreachable',
  'http-status',
  'envelope',
  'empty-reply',
  'truncated',
  'schema',
];

describe('OllamaError', () => {
  it('names itself - an Error subclass reports name "Error" otherwise', () => {
    // TSD 5.8's AI log line derives its `outcome` from what was thrown, so a subclass still
    // reporting `Error` would log the wrong outcome for every failure.
    for (const reason of REASONS) {
      const error = new OllamaError(reason);
      expect(error.name).toBe('OllamaError');
      expect(error).toBeInstanceOf(Error);
      expect(error.reason).toBe(reason);
    }
  });

  it('carries a distinct, non-empty fixed message per reason', () => {
    const messages = REASONS.map((reason) => new OllamaError(reason).message);
    expect(messages.every((message) => message.length > 0)).toBe(true);
    // Distinct, so a log line can tell the six apart. Equal messages would make five of the six
    // reasons invisible to anybody reading a log.
    expect(new Set(messages).size).toBe(REASONS.length);
  });

  it('is constructed from the reason alone - there is no channel for an upstream string', () => {
    // Structural, not a convention: the constructor takes one argument and it is a member of a
    // closed union, so no caller can pass text in even by mistake.
    expect(OllamaError.length).toBe(1);
  });
});

describe('no upstream text escapes this module', () => {
  const TOKEN = 'UPSTREAM-LEAK-7c1d';

  /**
   * One distinctive token, planted in every channel an upstream string can arrive through, and
   * asserted absent from everything thrown. This is the test that guards the rule the module
   * exists for; if it stays green under a `String(error)` or `statusText` interpolation then it
   * is decoration and the rule is unguarded.
   */
  const channels: ReadonlyArray<readonly [string, () => Recorder]> = [
    [
      'the transport rejection',
      () => rejecting(new TypeError(`fetch failed: connect ECONNREFUSED ${TOKEN}:11434`)),
    ],
    ['a non-Error rejection', () => rejecting(`${TOKEN} died`)],
    [
      'the status line and the failure body',
      () =>
        recording(
          () =>
            new Response(`{"error":"${TOKEN}"}`, {
              status: 500,
              statusText: `Internal Error at ${TOKEN}`,
            }),
        ),
    ],
    [
      'an unparseable envelope body',
      // Node's own JSON parse error quotes the start of the input it could not read, so
      // `response.json()` or a re-thrown parse error would carry this token out verbatim.
      () => recording(() => new Response(`<html><title>${TOKEN}</title></html>`)),
    ],
    [
      'an envelope that is valid JSON but not an envelope',
      () => recording(() => new Response(`{"oops":"${TOKEN}"}`)),
    ],
    [
      'an unparseable inner reply',
      () => recording(() => envelopeDone(`{"answer": ${TOKEN}`, 'stop')),
    ],
    [
      'a schema-rejected inner reply',
      () =>
        recording(() =>
          envelopeDone(`{"answered":true,"answer":"x","citedMealIds":[],"${TOKEN}":1}`, 'stop'),
        ),
    ],
    [
      'a truncated inner reply',
      () =>
        recording(() =>
          envelopeDone(`{"answered":true,"answer":"${TOKEN}","citedMealIds":[]}`, 'length'),
        ),
    ],
  ];

  for (const [label, make] of channels) {
    it(`keeps it out of everything thrown for ${label}`, async () => {
      const error = await ollamaErrorFrom(make());

      const surfaces = [
        error.message,
        error.name,
        error.reason,
        String(error),
        JSON.stringify(error, Object.getOwnPropertyNames(error)),
      ];
      for (const surface of surfaces) {
        expect(surface).not.toContain(TOKEN);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// No retry, no repair loop
// ---------------------------------------------------------------------------------------------

describe('no retry and no repair loop (Plan 15.5)', () => {
  it('calls fetchImpl exactly once on every failure path', async () => {
    const paths: ReadonlyArray<readonly [OllamaFailureReason, () => Recorder]> = [
      ['unreachable', () => rejecting(new TypeError('fetch failed'))],
      ['http-status', () => recording(() => new Response('{}', { status: 503 }))],
      ['envelope', () => recording(() => new Response('not json'))],
      ['empty-reply', () => recording(() => envelope('  '))],
      ['truncated', () => recording(() => envelopeDone(VALID_REPLY_JSON, 'length'))],
      ['schema', () => recording(() => envelopeDone('{"answered":true}', 'stop'))],
    ];

    for (const [expected, make] of paths) {
      const recorder = make();
      await expect(reasonFrom(recorder)).resolves.toBe(expected);
      // One line, one whole documented rule. A repair prompt or a retry on ANY of the six would
      // fail here, and nothing else in the suite would notice it.
      expect(recorder.calls).toHaveLength(1);
    }
  });

  it('calls fetchImpl exactly once on the success path', async () => {
    const recorder = recording(() => envelopeDone(VALID_REPLY_JSON, 'stop'));
    await resolvedChatReply(recorder);
    expect(recorder.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

describe('fetchImpl', () => {
  it('defaults to the global fetch - and this is the only test that mentions it', async () => {
    // Spied and rejected, so nothing connects. Every other test in this file supplies its own
    // `fetch`, which is the only reason the parameter exists (CONTRACTS 7).
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('no network in tests'));
    const client = createOllamaClient(config);

    await expect(
      client.generate(chatRequest(), new AbortController().signal),
    ).rejects.toBeInstanceOf(OllamaError);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(URL_UNDER_TEST);
  });
});
