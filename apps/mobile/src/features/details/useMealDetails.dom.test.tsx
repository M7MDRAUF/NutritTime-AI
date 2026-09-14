import { describe, expect, it } from 'vitest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { seededCatalog } from '@nutritime/catalog';
import { mealSchema } from '@nutritime/contracts';
import type { Meal } from '@nutritime/contracts';
import { createApiClient } from '../../infrastructure/api/client.js';
import { ApiClientError, transportError } from '../../infrastructure/api/errors.js';
import type { ApiClient, FetchLike } from '../../infrastructure/api/client.js';
import { useMealDetails } from './useMealDetails.js';
import type { MealDetailsState } from './useMealDetails.js';

/**
 * `useMealDetails`' own suite (T-16-02, T-16-06).
 *
 * **Real catalog records, not hand-written fixtures.** P13 found `Meal.imageUrl` to be
 * `string | null` where a component claimed `string`, and every fixture author had chosen a URL,
 * so nothing failed. The records here are parsed through `mealSchema` from the shipped catalog.
 *
 * **The client is a stub whose promises this file settles by hand**, because the assertion that
 * matters most is about ORDERING: a request that is superseded and aborted, and then answers
 * anyway, must be unable to render. Real timing cannot make that happen on demand.
 *
 * **The two 404 tests use the REAL client over a stub `fetch`.** A hand-assembled `ApiClientError`
 * can carry a `kind`/`status`/`code` combination the client would never produce, and then the test
 * asserts a case that cannot happen. `notFound` has to come from an actual 404 travelling through
 * `errors.ts`, so these two drive an actual 404 through it.
 *
 * **Every re-render goes through the SAME root.** P15's first attempt at a dependency-array test
 * was decoration because it built a fresh tree each time, so the effect re-ran whatever the array
 * said. `harness.render` calls `root.render` again; it never creates a second root.
 */

const CATALOG: readonly Meal[] = (seededCatalog as unknown[]).map((record) =>
  mealSchema.parse(record),
);

function record(index: number): Meal {
  const found = CATALOG[index];
  if (found === undefined) {
    throw new Error(`the seeded catalog has no record at ${String(index)}`);
  }
  return found;
}

/** A client whose every `getMeal` is a promise this test completes when it chooses. */
function deferredClient(): {
  readonly client: ApiClient;
  readonly ids: string[];
  readonly signals: AbortSignal[];
  settle(index: number, meal: Meal): Promise<void>;
  reject(index: number, error: unknown): Promise<void>;
} {
  const ids: string[] = [];
  const signals: AbortSignal[] = [];
  const resolvers: { resolve: (value: Meal) => void; reject: (error: unknown) => void }[] = [];

  const client: ApiClient = {
    listMeals: () => Promise.reject(new Error('not used')),
    getMeal: (mealId, signal) => {
      ids.push(mealId);
      signals.push(signal);
      return new Promise<Meal>((resolve, reject) => {
        resolvers.push({ resolve, reject });
      });
    },
    recommend: () => Promise.reject(new Error('not used')),
    ask: () => Promise.reject(new Error('not used')),
  };

  return {
    client,
    ids,
    signals,
    settle: async (index, meal) => {
      resolvers[index]?.resolve(meal);
      await flush();
    },
    reject: async (index, error) => {
      resolvers[index]?.reject(error);
      await flush();
    },
  };
}

/** One macrotask, which drains every microtask queued behind it — the response, then the commit. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface ProbeProps {
  readonly client: ApiClient;
  readonly mealId: string;
  readonly nonce?: number;
}

interface Harness {
  /** Re-render the same root with changed props. Merged over what is already mounted. */
  render(next: Partial<ProbeProps>): void;
  unmount(): void;
  /** What the last COMMIT actually put in the DOM. */
  kind(): string;
  loadedId(): string;
  text(): string;
  /** The state object of the last render, for shape assertions the DOM cannot carry. */
  lastState(): MealDetailsState;
  /** Every state ever rendered, so "this was never on screen" is assertable. */
  readonly rendered: readonly MealDetailsState[];
}

function mount(initial: ProbeProps): Harness {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const rendered: MealDetailsState[] = [];
  let current: ProbeProps = initial;

  function Probe(props: ProbeProps): ReactNode {
    const state = useMealDetails(props);
    // Recorded during render deliberately: this is the list of states that REACHED the tree, which
    // is what "a stale meal was never rendered" needs. The committed value is read from the DOM
    // below, because a render-time capture is only as reliable as the test's guess about how many
    // flushes React needed (`createStore.dom.test.tsx` records that lesson).
    rendered.push(state);
    return (
      <div
        data-testid="probe"
        data-kind={state.kind}
        data-meal-id={state.kind === 'loaded' ? state.meal.id : ''}
      >
        {state.kind === 'loaded' ? state.meal.name : ''}
      </div>
    );
  }

  const draw = (props: ProbeProps): void => {
    act(() => {
      root.render(<Probe {...props} />);
    });
  };
  draw(current);

  const committed = (): HTMLElement => {
    const node = host.querySelector('[data-testid="probe"]');
    if (!(node instanceof HTMLElement)) {
      throw new Error('the probe never rendered');
    }
    return node;
  };

  return {
    render: (next) => {
      current = { ...current, ...next };
      draw(current);
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
    kind: () => committed().getAttribute('data-kind') ?? '',
    loadedId: () => committed().getAttribute('data-meal-id') ?? '',
    text: () => host.textContent ?? '',
    lastState: () => {
      const last = rendered[rendered.length - 1];
      if (last === undefined) {
        throw new Error('the probe never rendered');
      }
      // The array and the DOM must agree, or a shape assertion below would be about a state the
      // user never saw.
      if (last.kind !== (committed().getAttribute('data-kind') ?? '')) {
        throw new Error('the recorded state is not the committed one');
      }
      return last;
    },
    rendered,
  };
}

/** The real client over a stub `fetch`, so the error under test is one the client truly produces. */
function realClient(respond: () => Response): ApiClient {
  const fetchImpl: FetchLike = () => Promise.resolve(respond());
  // No `baseUrl`: `DEFAULT_API_BASE_URL` applies, and the stub never looks at the URL anyway.
  return createApiClient({ fetch: fetchImpl });
}

describe('useMealDetails', () => {
  it('starts in loading and asks the server for the id it was given', () => {
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });

    expect(view.kind()).toBe('loading');
    expect(stub.ids).toStrictEqual([first.id]);
    expect(stub.signals[0]?.aborted).toBe(false);
  });

  it('renders the meal the server answered with', async () => {
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.settle(0, first);

    expect(view.kind()).toBe('loaded');
    expect(view.loadedId()).toBe(first.id);
    expect(view.text()).toContain(first.name);
  });

  it('does NOT render a response that arrives AFTER its abort', async () => {
    /**
     * **The assertion this hook exists for.**
     *
     * The user opens meal A, the modal is reused for meal B before A answers, and A answers
     * anyway. An abort-only implementation still renders A: `abort()` cannot un-resolve a promise
     * whose continuation is already queued as a microtask. Only the generation counter makes it
     * unrenderable — and on THIS screen the stale render would put one meal's allergen notice
     * under another meal's name.
     *
     * The stub ignores the signal on purpose, which is exactly the queued-continuation case: a
     * client that honoured the abort could not produce this ordering at all.
     */
    const stale = record(0);
    const fresh = record(1);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: stale.id });

    view.render({ mealId: fresh.id });
    expect(stub.ids).toStrictEqual([stale.id, fresh.id]);
    expect(stub.signals[0]?.aborted, 'the superseded request must be aborted').toBe(true);
    expect(stub.signals[1]?.aborted).toBe(false);

    await stub.settle(1, fresh);
    expect(view.loadedId()).toBe(fresh.id);

    // Now the superseded request answers, after its abort. Nothing may change.
    await stub.settle(0, stale);
    expect(view.kind()).toBe('loaded');
    expect(view.loadedId(), 'the stale meal must not have replaced the fresh one').toBe(fresh.id);
    expect(
      view.rendered.some((state) => state.kind === 'loaded' && state.meal.id === stale.id),
      'the stale meal must never have been rendered at any point',
    ).toBe(false);
  });

  it('an abort rejection is not reported to the user as a failure', async () => {
    // The real client raises the caller's own `AbortError` for a cancelled request — there is no
    // `cancelled` failure kind — so a hook that classified every rejection would show "failed"
    // every time the user changed meal.
    const stale = record(0);
    const fresh = record(1);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: stale.id });

    view.render({ mealId: fresh.id });
    const aborted = new Error('The request was cancelled.');
    aborted.name = 'AbortError';
    await stub.reject(0, aborted);

    expect(view.kind()).toBe('loading');
    expect(view.rendered.some((state) => state.kind === 'failed')).toBe(false);
  });

  it('takes the previous meal off screen the MOMENT the id changes', async () => {
    /**
     * PRD §12 and FR-003's defect class. `loading` is set synchronously at the top of the effect,
     * so the old meal is already gone in the same commit that starts the new request. Setting it in
     * the response handler instead would leave meal A's ingredients and allergen notice on screen
     * under meal B's id for a whole round trip — and for ever if the request failed.
     *
     * Asserted BEFORE the second response is settled, which is the only moment the difference
     * exists.
     */
    const first = record(0);
    const second = record(1);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.settle(0, first);
    expect(view.loadedId()).toBe(first.id);

    view.render({ mealId: second.id });

    expect(view.kind(), 'the new id must be loading, not still loaded').toBe('loading');
    expect(view.loadedId(), 'the previous meal must already be gone').toBe('');
    expect(view.text()).not.toContain(first.name);

    await stub.settle(1, second);
    expect(view.loadedId()).toBe(second.id);
  });

  it('re-requests when the id changes — same root, re-rendered', async () => {
    // The dependency-array test. If `mealId` were dropped from the array, the effect would not
    // re-run and the hook would answer with the first meal for ever. It re-renders the SAME root,
    // because a fresh tree re-runs every effect regardless of the array and proves nothing (P15).
    const first = record(0);
    const second = record(1);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.settle(0, first);

    view.render({ mealId: second.id });
    await stub.settle(1, second);

    expect(stub.ids).toStrictEqual([first.id, second.id]);
    expect(view.loadedId()).toBe(second.id);
  });

  it('re-requests the same id when the nonce is bumped, which is the retry', async () => {
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.reject(0, transportError('getMeal', 'unreachable'));
    expect(view.kind()).toBe('unreachable');

    view.render({ nonce: 1 });
    expect(view.kind(), 'a retry goes back to loading').toBe('loading');
    expect(stub.ids).toStrictEqual([first.id, first.id]);

    await stub.settle(1, first);
    expect(view.loadedId()).toBe(first.id);
  });

  it('re-requests through a replaced client', async () => {
    const first = record(0);
    const one = deferredClient();
    const two = deferredClient();
    const view = mount({ client: one.client, mealId: first.id });
    await one.settle(0, first);

    view.render({ client: two.client });
    await two.settle(0, first);

    expect(two.ids).toStrictEqual([first.id]);
    expect(view.loadedId()).toBe(first.id);
  });

  it('issues no second request when the parent re-renders with identical props', async () => {
    // Nothing in the dependency array is an object or a function, so a parent re-render is free.
    // A fresh object dependency here would re-request on every keystroke anywhere above it.
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.settle(0, first);

    view.render({});
    view.render({});
    view.render({});

    expect(stub.ids).toStrictEqual([first.id]);
    expect(view.loadedId()).toBe(first.id);
  });

  it('reports a 404 WITH the server envelope as notFound, not failed', async () => {
    // PRD FR-005: "A request for an unknown meal is a 404, not an empty success", and TSD §6.8
    // lists not-found as its own state. The body is the server's real one (`apps/server/errors.ts`
    // `meal_not_found`), driven through the real client so the classification is made from the
    // error `errors.ts` actually produces.
    const body = JSON.stringify({
      error: { code: 'meal_not_found', message: 'That meal could not be found.', retryable: false },
    });
    const view = mount({
      client: realClient(() => new Response(body, { status: 404 })),
      mealId: 'no-such-meal',
    });
    await flush();

    expect(view.kind()).toBe('notFound');
    expect(view.lastState()).toStrictEqual({ kind: 'notFound' });
  });

  it('reports a 404 with NO envelope as notFound too', async () => {
    // A plain 404 from a path the server does not claim, or from anything in front of it, arrives
    // as `kind: 'unreadable'` with the status intact — `errors.ts` says "a 404 stays 404". Keying
    // on `code === 'meal_not_found'` would send this to `failed` and offer a retry that can never
    // succeed, which is why the hook keys on the status.
    const view = mount({
      client: realClient(() => new Response('<html>Not Found</html>', { status: 404 })),
      mealId: 'no-such-meal',
    });
    await flush();

    expect(view.kind()).toBe('notFound');
  });

  it('calls an unreachable server local-only, and a timeout too', async () => {
    // Built with the client's OWN factory rather than hand-assembled: a hand-made error can carry
    // a combination the client would never produce.
    const first = record(0);
    const unreachable = deferredClient();
    const unreachableView = mount({ client: unreachable.client, mealId: first.id });
    await unreachable.reject(0, transportError('getMeal', 'unreachable'));
    expect(unreachableView.kind()).toBe('unreachable');

    const timeout = deferredClient();
    const timeoutView = mount({ client: timeout.client, mealId: first.id });
    await timeout.reject(0, transportError('getMeal', 'timeout'));
    expect(timeoutView.kind()).toBe('unreachable');
  });

  it('calls a 500 failed, never local-only', async () => {
    // A 500 is not "offline". Saying so would send the user to check a connection that is fine and
    // stop a real problem being reported.
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.reject(
      0,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        wire: null,
        route: 'getMeal',
      }),
    );

    expect(view.kind()).toBe('failed');
  });

  it('calls an unreadable 200 failed', async () => {
    // TSD §6.5's "no coerced success": a 200 whose body does not decode is a failure, not a meal
    // with missing fields.
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.reject(0, transportError('getMeal', 'unreadable'));

    expect(view.kind()).toBe('failed');
  });

  it('calls a throw that is not an ApiClientError failed', async () => {
    // A bug in the client, or anything else that escapes it, must not crash the screen and must
    // not be mistaken for a 404 or for an unreachable server.
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.reject(0, new TypeError('undefined is not a function'));

    expect(view.kind()).toBe('failed');
  });

  it('carries nothing from the wire in the state it returns', async () => {
    /**
     * PRD §15.5 and TSD §6.5 rule 1. The client keeps the server's body on `.wire` and never in
     * `.message`; this proves the hook does not reach for either.
     *
     * The shape is asserted, not just the kind: the defect this guards is a future `message` field
     * added "for the screen", which is how a socket path reaches a screenshot. `toStrictEqual`
     * fails the moment the failure state carries anything but its `kind`.
     */
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });
    await stub.reject(
      0,
      new ApiClientError({
        kind: 'server',
        status: 500,
        code: 'internal_error',
        retryable: false,
        wire: {
          code: 'internal_error',
          message: 'ECONNREFUSED /var/run/secret.sock',
          retryable: false,
        },
        route: 'getMeal',
      }),
    );

    expect(view.lastState()).toStrictEqual({ kind: 'failed' });
    expect(view.text()).not.toContain('ECONNREFUSED');
    expect(view.text()).not.toContain('secret.sock');
  });

  it('aborts the in-flight request when the screen goes away', async () => {
    // The modal is dismissed mid-request. The abort is what stops the work; the response arriving
    // afterwards must not throw.
    const first = record(0);
    const stub = deferredClient();
    const view = mount({ client: stub.client, mealId: first.id });

    view.unmount();
    expect(stub.signals[0]?.aborted).toBe(true);

    await stub.settle(0, first);
    // This host, not `document.body`: earlier tests leave their own hosts mounted, and one of them
    // holds this same meal's name.
    expect(view.text()).toBe('');
  });
});
