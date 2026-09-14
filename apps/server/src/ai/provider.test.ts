import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatModelReplySchema, explanationReplySchema } from '@nutritime/contracts';
import type { ChatModelReply, ExplanationReply } from '@nutritime/contracts';
import { loadConfig } from '../config.js';
import type { ServerConfig } from '../config.js';
import { chatFormat } from './chatFormat.js';
import { OllamaAbortError, OllamaError, createOllamaClient } from './ollamaClient.js';
import type * as ollamaClientModule from './ollamaClient.js';
import type {
  FetchLike,
  OllamaClient,
  OllamaFailureReason,
  OllamaGenerateRequest,
} from './ollamaClient.js';
import { createAiProvider } from './provider.js';
import type { Generation } from './provider.js';

/**
 * T-19-08's seam half (TSD 5.5; CONTRACTS 8). Four claims carry the file, each written so that
 * one named mutation of `provider.ts` turns it red:
 *
 * 1. **The fake touches no network and reads no `OLLAMA_BASE_URL`.** The injected `fetchImpl`
 *    and the global `fetch` are both asserted uncalled, and the config fixture counts reads of
 *    `OLLAMA_BASE_URL` - with the real branch in the same test as the control, because a trap
 *    nothing trips is not a trap.
 * 2. **The real branch never reads `echo`.** The echo carries a distinctive marker and the
 *    envelope a different reply; the marker must reach neither the returned value, nor the
 *    request body, nor a thrown message.
 * 3. **The real branch sends exactly what the client sends** - asserted differentially against
 *    `createOllamaClient` driven directly, rather than by restating TSD 5.5's body, which is
 *    `ollamaClient.test.ts`'s own acceptance.
 * 4. **A client failure reaches the caller as the client threw it.** No reason reshaped, no echo
 *    substituted - the wrong implementation that would make every test pass and every failure
 *    invisible.
 *
 * T-19-08's route-level half - retrieval, resolution and containment executing under `AI_FAKE` -
 * is P21's integration test, not this file.
 */

/**
 * A pass-through recorder around the **real** client factory, so a test can see the argument
 * object `provider.ts` hands to `generate`.
 *
 * It exists because the wire cannot witness the claim. Forwarding `generation` whole compiles -
 * `Generation<T>` is structurally assignable to `OllamaGenerateRequest<T>` - and changes nothing
 * in the request body, because the client builds that field by field. So every wire-level
 * assertion stays green while `echo` sits in the client's scope with nothing to say it must not
 * be read, which is the next person's defect and not this one's.
 *
 * **It replaces no behaviour.** `createOllamaClient` is the actual one, the error classes are the
 * actual ones, so `instanceof`, the two-stage decode and the fixed failure messages are all
 * untouched; the wrapper pushes the request and delegates.
 */
const observed = vi.hoisted(() => ({ requests: [] as OllamaGenerateRequest<unknown>[] }));

vi.mock('./ollamaClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ollamaClientModule>();
  return {
    ...actual,
    createOllamaClient: (config: ServerConfig, fetchImpl?: FetchLike): OllamaClient => {
      const client = actual.createOllamaClient(config, fetchImpl);
      return {
        generate: <T>(request: OllamaGenerateRequest<T>, signal: AbortSignal): Promise<T> => {
          observed.requests.push(request);
          return client.generate(request, signal);
        },
      };
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  observed.requests.length = 0;
});

/**
 * Real configs through the real parser. `fakeEnvConfig` has `OLLAMA_BASE_URL` absent from the
 * environment, exactly as `e2e/playwright.config.ts` leaves it.
 */
const fakeEnvConfig = loadConfig({ AI_FAKE: 'true' });

const realConfig = loadConfig({
  OLLAMA_BASE_URL: 'http://ollama.test:11434',
  OLLAMA_MODEL: 'gemma3:4b',
  AI_KEEP_ALIVE: '30m',
});

/**
 * The same config with a counting getter over `OLLAMA_BASE_URL`. Copied field by field rather
 * than spread: a spread would read every value while building the copy, so the count would
 * start at one.
 */
function watched(base: ServerConfig): { readonly config: ServerConfig; readonly reads: string[] } {
  const reads: string[] = [];
  const config: ServerConfig = {
    PORT: base.PORT,
    AI_ENABLED: base.AI_ENABLED,
    AI_FAKE: base.AI_FAKE,
    get OLLAMA_BASE_URL(): string {
      reads.push(base.OLLAMA_BASE_URL);
      return base.OLLAMA_BASE_URL;
    },
    OLLAMA_MODEL: base.OLLAMA_MODEL,
    AI_KEEP_ALIVE: base.AI_KEEP_ALIVE,
    OLLAMA_CHAT_TIMEOUT_MS: base.OLLAMA_CHAT_TIMEOUT_MS,
    OLLAMA_EXPLANATION_TIMEOUT_MS: base.OLLAMA_EXPLANATION_TIMEOUT_MS,
  };
  return { config, reads };
}

const PROMPT = 'ROLE\nRULES\nANSWER\nFIGURES\nMEALS\nQUESTION';
const PROMPT_MEAL_IDS = ['meal-lentil-soup', 'meal-greek-yogurt-bowl'];

/** TSD 5.5's fake reply, shaped from a `ResolvedAnswer` as the chat route will shape it. */
const CHAT_ECHO: ChatModelReply = {
  answered: true,
  answer: 'Lentil soup has the highest protein, at 18 g.',
  citedMealIds: ['meal-lentil-soup'],
};

/** A token that could only reach an assertion by way of the real branch reading `echo`. */
const MARKER = 'ECHO-MUST-NOT-LEAK-7F3A';

const LEAKY_ECHO: ChatModelReply = { ...CHAT_ECHO, answer: `Lentil soup. ${MARKER}` };

/** What the envelope carries. Different from every echo above, so a mix-up cannot pass. */
const MODEL_REPLY: ChatModelReply = {
  answered: true,
  answer: 'Of the meals shown, lentil soup carries the most protein.',
  citedMealIds: ['meal-lentil-soup'],
};

const EXPLANATION_ECHO: ExplanationReply = {
  mealId: 'meal-lentil-soup',
  reason: 'It reaches your protein goal at 18 g.',
};

function chatGeneration(echo: ChatModelReply): Generation<ChatModelReply> {
  return {
    prompt: PROMPT,
    format: chatFormat(PROMPT_MEAL_IDS),
    decode: chatModelReplySchema,
    echo,
  };
}

/**
 * `format` is a hand-written fragment rather than `explanationFormat()`: that function is P20's
 * and does not exist yet, and the seam treats `format` as opaque.
 */
function explanationGeneration(echo: ExplanationReply): Generation<ExplanationReply> {
  return {
    prompt: PROMPT,
    format: { type: 'object', required: ['mealId', 'reason'] },
    decode: explanationReplySchema,
    echo,
  };
}

const live = (): AbortSignal => new AbortController().signal;

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

interface Recorder {
  readonly fetch: FetchLike;
  readonly calls: Call[];
}

/** A `fetch` that answers from a script and records what it was asked for. */
function recording(respond: () => Promise<Response>): Recorder {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      if (init.signal?.aborted === true) {
        // Platform `fetch` rejects on an aborted signal before it opens a socket. The fixture
        // says so rather than the client checking the flag, which it deliberately does not.
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return respond();
    },
  };
}

/** Ollama's envelope carries the model's JSON as a *string* (TSD 5.5). */
function envelopeOf(reply: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ response: JSON.stringify(reply) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function onlyCall(recorder: Recorder): Call {
  expect(recorder.calls).toHaveLength(1);
  const call = recorder.calls[0];
  if (call === undefined) {
    throw new Error('no call was recorded');
  }
  return call;
}

function bodyOf(call: Call): string {
  const { body } = call.init;
  if (typeof body !== 'string') {
    throw new Error('the request body was not a JSON string');
  }
  return body;
}

/**
 * The rejection, or a loud failure if the promise RESOLVED. `rejects.toBeInstanceOf` also fails
 * on a resolve, but this wording names the defect: an implementation that swallows an
 * `OllamaError` and returns the echo resolves, and the report should say so.
 */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  let settled: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  try {
    await promise;
    settled = { ok: true };
  } catch (error: unknown) {
    settled = { ok: false, error };
  }
  if (settled.ok) {
    throw new Error('expected a rejection; the provider resolved instead');
  }
  return settled.error;
}

function reasonOf(error: unknown): OllamaFailureReason | undefined {
  return error instanceof OllamaError ? error.reason : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('createAiProvider under AI_FAKE', () => {
  it('returns the echo and makes no call at all, with OLLAMA_BASE_URL unset', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.reject(new Error('the fake reached the network')));
    const spy = recording(() => envelopeOf(MODEL_REPLY));
    expect(fakeEnvConfig.AI_FAKE).toBe(true);
    const provider = createAiProvider(fakeEnvConfig, spy.fetch);

    await expect(provider(chatGeneration(CHAT_ECHO), live())).resolves.toEqual(CHAT_ECHO);
    expect(spy.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('never reads OLLAMA_BASE_URL, where the real branch reads it once', async () => {
    const fake = watched(loadConfig({ AI_FAKE: 'true' }));
    const real = watched(realConfig);
    const spy = recording(() => envelopeOf(MODEL_REPLY));

    await createAiProvider(fake.config, spy.fetch)(chatGeneration(CHAT_ECHO), live());
    await createAiProvider(real.config, spy.fetch)(chatGeneration(CHAT_ECHO), live());

    // The pair is the assertion: no constant implementation of the getter satisfies both.
    expect(fake.reads).toHaveLength(0);
    expect(real.reads).toEqual(['http://ollama.test:11434']);
    expect(onlyCall(spy).url).toBe('http://ollama.test:11434/api/generate');
  });

  it('rejects an echo its decode schema rejects, with reason schema and no call', async () => {
    const spy = recording(() => envelopeOf(MODEL_REPLY));
    const provider = createAiProvider(fakeEnvConfig, spy.fetch);
    const tooLong: ChatModelReply = { ...CHAT_ECHO, answer: 'x'.repeat(701) };
    const tooMany: ChatModelReply = { ...CHAT_ECHO, citedMealIds: ['a', 'b', 'c', 'd', 'e', 'f'] };

    expect(reasonOf(await rejection(provider(chatGeneration(tooLong), live())))).toBe('schema');
    expect(reasonOf(await rejection(provider(chatGeneration(tooMany), live())))).toBe('schema');
    expect(spy.calls).toHaveLength(0);
  });

  it('accepts the schema boundary - so the rejection above is not a constant', async () => {
    const spy = recording(() => envelopeOf(MODEL_REPLY));
    const atBound: ChatModelReply = {
      ...CHAT_ECHO,
      answer: 'y'.repeat(700),
      citedMealIds: ['a', 'b', 'c', 'd', 'e'],
    };

    await expect(
      createAiProvider(fakeEnvConfig, spy.fetch)(chatGeneration(atBound), live()),
    ).resolves.toEqual(atBound);
  });

  it('does not read AI_ENABLED: it is a different switch (TSD 5.2)', async () => {
    const fakeDisabled = loadConfig({ AI_FAKE: 'true', AI_ENABLED: 'false' });
    const realDisabled = loadConfig({
      AI_ENABLED: 'false',
      OLLAMA_BASE_URL: 'http://ollama.test:11434',
    });
    const spy = recording(() => envelopeOf(MODEL_REPLY));

    await expect(
      createAiProvider(fakeDisabled, spy.fetch)(chatGeneration(CHAT_ECHO), live()),
    ).resolves.toEqual(CHAT_ECHO);
    await expect(
      createAiProvider(realDisabled, spy.fetch)(chatGeneration(LEAKY_ECHO), live()),
    ).resolves.toEqual(MODEL_REPLY);
    expect(spy.calls).toHaveLength(1);
  });
});

describe('createAiProvider on the real branch', () => {
  it('ignores echo: the value comes from the envelope and the marker reaches nothing', async () => {
    const spy = recording(() => envelopeOf(MODEL_REPLY));
    const provider = createAiProvider(realConfig, spy.fetch);

    const result = await provider(chatGeneration(LEAKY_ECHO), live());

    expect(result).toEqual(MODEL_REPLY);
    expect(result.answer).not.toContain(MARKER);
    expect(bodyOf(onlyCall(spy))).not.toContain(MARKER);
  });

  it('sends exactly what createOllamaClient sends', async () => {
    const viaProvider = recording(() => envelopeOf(MODEL_REPLY));
    const viaClient = recording(() => envelopeOf(MODEL_REPLY));
    const generation = chatGeneration(LEAKY_ECHO);

    await createAiProvider(realConfig, viaProvider.fetch)(generation, live());
    await createOllamaClient(realConfig, viaClient.fetch).generate(
      { prompt: generation.prompt, format: generation.format, decode: generation.decode },
      live(),
    );

    const sent = onlyCall(viaProvider);
    const expected = onlyCall(viaClient);
    expect(sent.url).toBe(expected.url);
    expect(sent.init.method).toBe(expected.init.method);
    expect(sent.init.headers).toStrictEqual(expected.init.headers);
    expect(bodyOf(sent)).toBe(bodyOf(expected));
    // Not a vacuous string comparison: the prompt is in there and the echo is not.
    expect(bodyOf(sent)).toContain('QUESTION');
    expect(bodyOf(sent)).not.toContain(MARKER);

    // **What the client RECEIVED, not only what reached the wire.** The two differ and only this
    // half fails when `generation` is forwarded whole: the body stays byte-identical, because the
    // client picks its fields, so `toStrictEqual` on the argument object is the one assertion a
    // fourth key breaks. Both recorded requests are the provider's and the direct caller's, so
    // the differential covers the argument as well as the wire.
    const handedOver = {
      prompt: generation.prompt,
      format: generation.format,
      decode: generation.decode,
    };
    expect(observed.requests).toStrictEqual([handedOver, handedOver]);
    const handed = observed.requests[0];
    if (handed === undefined) {
      throw new Error('the client was never called');
    }
    expect('echo' in handed).toBe(false);
    expect(JSON.stringify({ prompt: handed.prompt, format: handed.format })).not.toContain(MARKER);
  });

  it.each([
    {
      failure: 'a non-2xx status',
      respond: (): Promise<Response> =>
        Promise.resolve(new Response(`{"error":"${MARKER}"}`, { status: 500 })),
      reason: 'http-status',
    },
    {
      failure: 'a transport rejection',
      respond: (): Promise<Response> => Promise.reject(new TypeError(`fetch failed ${MARKER}`)),
      reason: 'unreachable',
    },
    {
      failure: 'a reply the schema rejects',
      respond: (): Promise<Response> =>
        envelopeOf({ ...MODEL_REPLY, answer: 'z'.repeat(701), extra: MARKER }),
      reason: 'schema',
    },
  ])(
    'lets the OllamaError for $failure through, with no echo fallback',
    async ({ respond, reason }) => {
      const spy = recording(respond);

      const error = await rejection(
        createAiProvider(realConfig, spy.fetch)(chatGeneration(LEAKY_ECHO), live()),
      );

      expect(error).toBeInstanceOf(OllamaError);
      expect(reasonOf(error)).toBe(reason);
      expect(messageOf(error)).not.toContain(MARKER);
      expect(spy.calls).toHaveLength(1);
    },
  );
});

describe('createAiProvider across branches and lanes', () => {
  it('rejects an aborted signal with OllamaAbortError on both branches', async () => {
    const fakeSpy = recording(() => envelopeOf(MODEL_REPLY));
    const realSpy = recording(() => envelopeOf(MODEL_REPLY));

    const fromFake = await rejection(
      createAiProvider(fakeEnvConfig, fakeSpy.fetch)(
        chatGeneration(CHAT_ECHO),
        AbortSignal.abort(MARKER),
      ),
    );
    const fromReal = await rejection(
      createAiProvider(realConfig, realSpy.fetch)(
        chatGeneration(CHAT_ECHO),
        AbortSignal.abort(MARKER),
      ),
    );

    // The same error from the same fact about the input: the seam does not change what the
    // caller catches. The abort reason is the caller's arbitrary value and must not cross.
    expect(fromFake).toBeInstanceOf(OllamaAbortError);
    expect(fromReal).toBeInstanceOf(OllamaAbortError);
    expect(messageOf(fromFake)).not.toContain(MARKER);
    expect(fakeSpy.calls).toHaveLength(0);
    // One call on the real branch, unlike the fake: it learns of the abort from `fetch`.
    expect(realSpy.calls).toHaveLength(1);
  });

  it('carries chat and explanation through one provider, with T inferred per call', async () => {
    const fromModel: ExplanationReply = { mealId: 'meal-lentil-soup', reason: 'Protein, 18 g.' };
    const spy = recording(() => envelopeOf(fromModel));
    const leaky: ExplanationReply = { mealId: 'meal-lentil-soup', reason: MARKER };
    const fake = createAiProvider(fakeEnvConfig, spy.fetch);

    const chat = await fake(chatGeneration(CHAT_ECHO), live());
    const echoed = await fake(explanationGeneration(EXPLANATION_ECHO), live());
    const decoded = await createAiProvider(realConfig, spy.fetch)(
      explanationGeneration(leaky),
      live(),
    );

    // Each property read only compiles if `T` was inferred per generation, which is the whole of
    // "one provider, two lanes".
    expect(chat.citedMealIds).toEqual(['meal-lentil-soup']);
    expect(echoed.reason).toBe(EXPLANATION_ECHO.reason);
    expect(decoded).toEqual(fromModel);
    expect(decoded.reason).not.toContain(MARKER);
  });
});
