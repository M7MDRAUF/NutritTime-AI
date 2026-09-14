import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ROUTE_TIMEOUTS_MS } from './routes.js';
import { ApiClientError, isApiClientError } from './errors.js';
import { createApiClient } from './client.js';
import type { FetchLike } from './client.js';
import {
  API_BASE as BASE,
  CHAT_REQUEST,
  RECOMMEND_REQUEST,
  hangingFetch,
  jsonResponse,
  stubFetch,
  wireMeal,
} from './__fixtures__/wire.js';

const freshSignal = (): AbortSignal => new AbortController().signal;

describe('outcome 1 — the parsed value', () => {
  it('lists meals, sending the query string and asking for JSON', async () => {
    const body = { meals: [wireMeal()], page: 1, pageSize: 20, total: 1 };
    const stub = stubFetch(() => jsonResponse(body));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    await expect(
      client.listMeals({ period: 'lunch', query: 'yogurt' }, freshSignal()),
    ).resolves.toEqual(body);

    expect(stub.calls[0]?.url).toBe(`${BASE}/api/v1/meals?period=lunch&query=yogurt`);
    expect(stub.calls[0]?.init.method).toBe('GET');
    // Deliberately nothing else: a custom header would make every GET preflighted.
    expect(stub.calls[0]?.init.headers).toEqual({ Accept: 'application/json' });
  });

  it('gets one meal', async () => {
    const stub = stubFetch(() => jsonResponse(wireMeal()));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    await expect(client.getMeal('greek-yogurt-bowl', freshSignal())).resolves.toEqual(wireMeal());
    expect(stub.calls[0]?.url).toBe(`${BASE}/api/v1/meals/greek-yogurt-bowl`);
  });

  it('posts a recommendation with a JSON content type and the body it was given', async () => {
    const body = { mealPeriod: 'lunch', recommendations: [] };
    const stub = stubFetch(() => jsonResponse(body));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    await expect(client.recommend(RECOMMEND_REQUEST, freshSignal())).resolves.toEqual(body);
    expect(stub.calls[0]?.init.method).toBe('POST');
    expect(stub.calls[0]?.init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(stub.calls[0]?.init.body))).toEqual(RECOMMEND_REQUEST);
  });

  it('asks the assistant and treats `answered: false` as success', async () => {
    const body = { answered: false, answer: 'I do not have that.', citations: [], source: 'local' };
    const stub = stubFetch(() => jsonResponse(body));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    await expect(client.ask(CHAT_REQUEST, freshSignal())).resolves.toEqual(body);
    expect(stub.calls[0]?.url).toBe(`${BASE}/api/v1/chat`);
  });

  it('normalises a base URL with a trailing slash rather than producing a double one', async () => {
    const stub = stubFetch(() => jsonResponse(wireMeal()));
    const client = createApiClient({ baseUrl: `${BASE}/`, fetch: stub.fetch });
    await client.getMeal('m', freshSignal());
    expect(stub.calls[0]?.url).toBe(`${BASE}/api/v1/meals/m`);
  });
});

describe('outcome 2 — the server’s error envelope', () => {
  it('carries code, status, retryability and the envelope itself', async () => {
    const notFound = {
      error: { code: 'meal_not_found', message: 'That meal could not be found.', retryable: false },
    };
    const stub = stubFetch(() => jsonResponse(notFound, 404));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    const error = await client.getMeal('nope', freshSignal()).catch((e: unknown) => e);

    expect(isApiClientError(error)).toBe(true);
    expect(error).toMatchObject({
      kind: 'server',
      status: 404,
      code: 'meal_not_found',
      retryable: false,
      route: 'getMeal',
      wire: notFound.error,
    });
  });

  /**
   * **The rule this test exists for.** TSD 6.5: nothing from the wire reaches a user-visible
   * message. A server error text rendered into a toast is how internal detail leaks into a
   * screenshot — and the leaked text below contains the user's own question.
   */
  it('NEVER puts the server’s text into the message a user could see', async () => {
    const leaky = {
      error: {
        code: 'ai_unavailable',
        message: 'ECONNREFUSED 127.0.0.1:11434 while phrasing "do I have a peanut allergy"',
        retryable: true,
      },
    };
    const stub = stubFetch(() => jsonResponse(leaky, 503));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    const error = await client.ask(CHAT_REQUEST, freshSignal()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(isApiClientError(error) && error.message).toBe('The request could not be completed.');
    // `Error.toString()` and a bare template literal both read `message`, so both are covered by
    // checking `String(error)`: those are the two ways the text would actually reach a screen.
    expect(String(error)).not.toContain('ECONNREFUSED');
    expect(String(error)).not.toContain('peanut');
    expect(String(error)).not.toContain('11434');
    expect(isApiClientError(error) && error.wire?.message).toBe(leaky.error.message);
  });

  it('reports an error status whose body is not an envelope as unreadable, status intact', async () => {
    // The plain 404 the server serves outside the meals route, and anything a proxy inserts.
    const stub = stubFetch(() => new Response('<html>Not Found</html>', { status: 404 }));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    const error = await client.ask(CHAT_REQUEST, freshSignal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unreadable', status: 404, code: null, wire: null });
    expect(isApiClientError(error) && error.message).toBe('The response could not be read.');
  });
});

describe('outcome 3 — transport failures', () => {
  it('maps an unreachable server to 503, with no network text in the message', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
    const client = createApiClient({ baseUrl: BASE, fetch: failing });

    const error = await client.getMeal('m', freshSignal()).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: 'unreachable', status: 503, retryable: true, code: null });
    expect(isApiClientError(error) && error.message).toBe('The server could not be reached.');
    expect(String(error)).not.toContain('ECONNREFUSED');
  });

  it('maps a 200 whose body does not decode to 502 — no coerced success', async () => {
    const stub = stubFetch(() => jsonResponse({ meals: [{ id: 'half-a-meal' }], page: 1 }));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    const error = await client.listMeals({}, freshSignal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unreadable', status: 502, retryable: false });
  });

  it('maps a 200 with a body that is not JSON at all to 502', async () => {
    const stub = stubFetch(() => new Response('', { status: 200 }));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    const error = await client.getMeal('m', freshSignal()).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'unreadable', status: 502 });
  });
});

describe('the deadline and the internal abort controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ACTUALLY aborts the request it started, and reports a timeout', async () => {
    // A holder rather than a `let`: TypeScript narrows a `let` assigned only inside a callback to
    // `never` at the read site, and papering over that with a cast is exactly what is banned.
    const seen: { signal: AbortSignal | null } = { signal: null };
    const client = createApiClient({
      baseUrl: BASE,
      fetch: (url, init) => {
        seen.signal = init.signal ?? null;
        return hangingFetch(url, init);
      },
    });

    const pending = client.getMeal('m', freshSignal()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ROUTE_TIMEOUTS_MS.getMeal);
    const error: unknown = await pending;

    expect(error).toMatchObject({
      kind: 'timeout',
      status: 504,
      retryable: true,
      route: 'getMeal',
    });
    // Not merely "the promise settled": the signal handed to `fetch` is aborted, so the socket is
    // released rather than left hanging until the platform gives up.
    expect(seen.signal).not.toBeNull();
    expect(seen.signal?.aborted).toBe(true);
  });

  it('does not fire before its own deadline', async () => {
    const client = createApiClient({ baseUrl: BASE, fetch: hangingFetch });
    const pending = client.ask(CHAT_REQUEST, freshSignal()).catch((e: unknown) => e);

    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(ROUTE_TIMEOUTS_MS.ask - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ kind: 'timeout' });
  });

  it('uses each route’s own deadline, not one shared number', async () => {
    const client = createApiClient({ baseUrl: BASE, fetch: hangingFetch });
    const listing = client.listMeals({}, freshSignal()).catch((e: unknown) => e);
    const asking = client.ask(CHAT_REQUEST, freshSignal()).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(ROUTE_TIMEOUTS_MS.listMeals);
    await expect(listing).resolves.toMatchObject({ kind: 'timeout', route: 'listMeals' });

    let askSettled = false;
    void asking.then(() => {
      askSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(askSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(ROUTE_TIMEOUTS_MS.ask - ROUTE_TIMEOUTS_MS.listMeals);
    await expect(asking).resolves.toMatchObject({ kind: 'timeout', route: 'ask' });
  });
});

describe('the caller’s signal is forwarded, never passed through', () => {
  it('raises the caller’s cancellation, NOT a timeout', async () => {
    // Otherwise a cancelled screen shows a timeout error, and the two are indistinguishable at
    // the catch site.
    const controller = new AbortController();
    const client = createApiClient({ baseUrl: BASE, fetch: hangingFetch });

    const pending = client.getMeal('m', controller.signal).catch((e: unknown) => e);
    controller.abort();
    const error: unknown = await pending;

    expect(isApiClientError(error)).toBe(false);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error && error.name).toBe('AbortError');
  });

  it('preserves the caller’s own abort reason', async () => {
    class Superseded extends Error {}
    const controller = new AbortController();
    const client = createApiClient({ baseUrl: BASE, fetch: hangingFetch });

    const pending = client.listMeals({}, controller.signal).catch((e: unknown) => e);
    controller.abort(new Superseded('a newer search replaced this one'));

    await expect(pending).resolves.toBeInstanceOf(Superseded);
  });

  it('does not hand the caller’s signal to fetch', async () => {
    const stub = stubFetch(() => jsonResponse(wireMeal()));
    const controller = new AbortController();
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    await client.getMeal('m', controller.signal);

    // The client aborts on its own deadline; it must not be able to abort something it does not
    // own, and its own abort must stay distinguishable from the caller's.
    expect(stub.calls[0]?.init.signal).not.toBe(controller.signal);
    expect(stub.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers a signal that was already aborted without firing a request at all', async () => {
    const stub = stubFetch(() => jsonResponse(wireMeal()));
    const controller = new AbortController();
    controller.abort();
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });

    await expect(client.getMeal('m', controller.signal)).rejects.toThrow();
    expect(stub.calls).toHaveLength(0);
  });

  it('leaves no listener on a caller signal that outlives the request', async () => {
    // A screen-scoped signal reused across many requests would otherwise accumulate one listener
    // per call for as long as the screen is mounted.
    const controller = new AbortController();
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    signal.addEventListener = (...args: Parameters<typeof add>): void => {
      added += 1;
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>): void => {
      removed += 1;
      remove(...args);
    };

    const stub = stubFetch(() => jsonResponse(wireMeal()));
    const client = createApiClient({ baseUrl: BASE, fetch: stub.fetch });
    for (let index = 0; index < 3; index += 1) {
      await client.getMeal('m', signal);
    }

    expect(added).toBe(3);
    expect(removed).toBe(3);
  });
});
