import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiBusyError, AiTimeoutError, createAiLane } from './aiLane.js';

/**
 * T-19-07 (TSD 5.5, Plan 15.5's Concurrency row).
 *
 * Two claims carry the phase. **"Immediately"** - the refusal is asserted to arrive before the
 * in-flight call settles AND in the same microtask turn it was asked in, because a test that
 * only asserts "it rejects" passes against a lane that queues. And **the lane is free again
 * after every outcome** - success, throw, timeout and refusal each get a follow-up call, since a
 * lane that latches occupied leaves the assistant unavailable until restart. That is R-51's
 * shape in `createStore`, so it is a live failure mode here.
 *
 * Fake timers for the budget; real microtasks for the concurrency. Nothing here waits 30 s.
 */

/** A promise this file decides when to settle: the stand-in for a slow inference. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An `fn` that ignores its signal and never settles on its own. */
const neverSettles = (): Promise<never> => new Promise<never>(() => undefined);

const CHAT_BUDGET_MS = 30_000;

describe('the two errors', () => {
  it('name themselves - an Error subclass reports name "Error" otherwise', () => {
    expect(new AiBusyError().name).toBe('AiBusyError');
    expect(new AiTimeoutError().name).toBe('AiTimeoutError');
    expect(new AiBusyError().message).toBe('The AI lane is already running a call.');
    expect(new AiTimeoutError().message).toBe('The AI call exceeded its budget.');
    expect(new AiBusyError()).toBeInstanceOf(Error);
    expect(new AiTimeoutError()).toBeInstanceOf(Error);
    // The route maps them to different codes, so neither may be an instance of the other.
    expect(new AiBusyError()).not.toBeInstanceOf(AiTimeoutError);
    expect(new AiTimeoutError()).not.toBeInstanceOf(AiBusyError);
  });
});

describe('single-flight', () => {
  it('refuses a second concurrent call BEFORE the first one settles', async () => {
    const lane = createAiLane();
    const order: string[] = [];
    const held = deferred<'first'>();
    const running = lane.run(async () => {
      const value = await held.promise;
      order.push('first settled');
      return value;
    }, CHAT_BUDGET_MS);
    const refused = lane
      .run(async () => 'second', CHAT_BUDGET_MS)
      .catch((error: unknown) => {
        order.push('refused');
        throw error;
      });

    await expect(refused).rejects.toBeInstanceOf(AiBusyError);
    // Load-bearing: the refusal is observable while the first call is still pending.
    expect(order).toStrictEqual(['refused']);

    held.resolve('first');
    await expect(running).resolves.toBe('first');
    expect(order).toStrictEqual(['refused', 'first settled']);
  });

  it('rejects in the turn it was called in, without yielding first', async () => {
    const lane = createAiLane();
    const held = deferred<'held'>();
    const running = lane.run(() => held.promise, CHAT_BUDGET_MS);

    const marks: string[] = [];
    const refused = lane.run(async () => 'never', CHAT_BUDGET_MS);
    const seen = refused.catch((error: unknown) => {
      marks.push('refused');
      return error;
    });
    // A two-rung microtask ladder queued immediately AFTER the refusal: a synchronously
    // rejected promise schedules its reaction first, so 'refused' leads. One `await` on the
    // busy path inside `run` pushes it behind 'tick 1'.
    void Promise.resolve()
      .then(() => marks.push('tick 1'))
      .then(() => marks.push('tick 2'));

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(marks).toStrictEqual(['refused', 'tick 1', 'tick 2']);
    await expect(seen).resolves.toBeInstanceOf(AiBusyError);

    held.resolve('held');
    await expect(running).resolves.toBe('held');
  });

  it('refuses without queueing, and frees only when the in-flight call settles', async () => {
    const lane = createAiLane();
    const held = deferred<'held'>();
    const running = lane.run(() => held.promise, CHAT_BUDGET_MS);
    const queued = vi.fn(async () => 'queued');

    await expect(lane.run(queued, CHAT_BUDGET_MS)).rejects.toBeInstanceOf(AiBusyError);
    await expect(lane.run(queued, CHAT_BUDGET_MS)).rejects.toBeInstanceOf(AiBusyError);
    expect(queued).not.toHaveBeenCalled();

    held.resolve('held');
    await expect(running).resolves.toBe('held');
    // Never called even once the lane is free: that is the "no queue" half of TSD 5.5. And
    // busy-then-run - the refused caller may retry, and gets the lane.
    expect(queued).not.toHaveBeenCalled();
    await expect(lane.run(async () => 'c', CHAT_BUDGET_MS)).resolves.toBe('c');
  });

  it('does not abort the in-flight call when it refuses another', async () => {
    const lane = createAiLane();
    const held = deferred<'held'>();
    let seen: AbortSignal | undefined;
    const running = lane.run((signal) => {
      seen = signal;
      return held.promise;
    }, CHAT_BUDGET_MS);

    await expect(lane.run(async () => 'no', CHAT_BUDGET_MS)).rejects.toBeInstanceOf(AiBusyError);
    // A lane holding ONE controller and cleaning up unconditionally aborts the running
    // inference here. Probed.
    expect(seen?.aborted).toBe(false);

    held.resolve('held');
    await expect(running).resolves.toBe('held');
  });
});

describe('the lane is free again after every outcome', () => {
  it('after a success', async () => {
    const lane = createAiLane();
    await expect(lane.run(async () => 'one', 1000)).resolves.toBe('one');
    await expect(lane.run(async () => 'two', 1000)).resolves.toBe('two');
  });
  it('after fn throws, and the throw is rethrown unchanged', async () => {
    const lane = createAiLane();
    const boom = new Error('an upstream detail the lane must not reinterpret');
    // Identity, not `toThrow`: the lane classifies nothing, it only gates.
    await expect(lane.run(() => Promise.reject(boom), 1000)).rejects.toBe(boom);
    await expect(lane.run(async () => 'after the throw', 1000)).resolves.toBe('after the throw');
  });

  it('after fifty sequential calls that alternate success and failure', async () => {
    const lane = createAiLane();
    for (let index = 0; index < 50; index += 1) {
      if (index % 3 === 0) {
        const boom = new Error(`call ${String(index)} failed`);
        await expect(lane.run(() => Promise.reject(boom), 1000)).rejects.toBe(boom);
      } else {
        await expect(lane.run(async () => index, 1000)).resolves.toBe(index);
      }
    }
  });
});

describe('the signal handed to fn', () => {
  it('is fresh and un-aborted on every call, and fn decides the result', async () => {
    const lane = createAiLane();
    const sentinel = { id: 'the value fn returned' };
    const seen: AbortSignal[] = [];
    const abortedDuring: boolean[] = [];
    const record = (signal: AbortSignal): void => {
      seen.push(signal);
      abortedDuring.push(signal.aborted);
    };

    await expect(
      lane.run(async (signal) => {
        record(signal);
        return sentinel;
      }, 1000),
    ).resolves.toBe(sentinel);
    await expect(
      lane.run(async (signal) => {
        record(signal);
        return 'second';
      }, 1000),
    ).resolves.toBe('second');

    const [one, two] = seen;
    expect(one).toBeInstanceOf(AbortSignal);
    expect(two).toBeInstanceOf(AbortSignal);
    // A controller hoisted out of `run` would latch aborted and every later `fn` would bail.
    expect(two).not.toBe(one);
    expect(abortedDuring).toStrictEqual([false, false]);
  });

  it('is aborted on the way out, whether fn resolved or threw', async () => {
    const lane = createAiLane();
    const boom = new Error('fn broke');
    let afterSuccess: AbortSignal | undefined;
    let afterThrow: AbortSignal | undefined;
    await expect(
      lane.run(async (signal) => {
        afterSuccess = signal;
        return 'ok';
      }, 1000),
    ).resolves.toBe('ok');
    await expect(
      lane.run((signal) => {
        afterThrow = signal;
        return Promise.reject(boom);
      }, 1000),
    ).rejects.toBe(boom);
    expect(afterSuccess?.aborted).toBe(true);
    expect(afterThrow?.aborted).toBe(true);
  });
});

describe('the budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with AiTimeoutError at the deadline and not before, aborting first', async () => {
    const lane = createAiLane();
    const order: string[] = [];
    let seen: AbortSignal | undefined;
    const running = lane.run((signal) => {
      seen = signal;
      signal.addEventListener('abort', () => order.push('aborted'));
      return neverSettles();
    }, CHAT_BUDGET_MS);
    const settled = running.catch((error: unknown) => {
      order.push('rejected');
      return error;
    });

    await vi.advanceTimersByTimeAsync(CHAT_BUDGET_MS - 1);
    // The control. Without it, a lane that aborted and rejected on entry would pass.
    expect(order).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
    // Abort first: a well-behaved `fn` gets the chance to bail before the caller is told.
    expect(order).toStrictEqual(['aborted', 'rejected']);
    expect(seen?.aborted).toBe(true);
    await expect(lane.run(async () => 'after', 1000)).resolves.toBe('after');
  });

  it('rejects with AiTimeoutError even when fn rejects from its own abort listener', async () => {
    const lane = createAiLane();
    const settled = lane
      .run(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('fn cancelled itself')));
          }),
        CHAT_BUDGET_MS,
      )
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(CHAT_BUDGET_MS);
    // `fn` honouring its signal must not win the race: the caller would be handed `fn`'s error
    // and the AI log line's `outcome` (TSD 5.8) would read `unreachable` on a real timeout.
    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
  });

  it('counts one pending timer while a call is in flight and none after it', async () => {
    const lane = createAiLane();
    const held = deferred<'held'>();
    const running = lane.run(() => held.promise, CHAT_BUDGET_MS);

    await Promise.resolve();
    // The control for every "no timer pending" case below: a lane that never armed a timer
    // at all would satisfy those and fail this.
    expect(vi.getTimerCount()).toBe(1);

    held.resolve('held');
    await expect(running).resolves.toBe('held');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after fn throws', async () => {
    const lane = createAiLane();
    const boom = new Error('fn broke');
    await expect(lane.run(() => Promise.reject(boom), CHAT_BUDGET_MS)).rejects.toBe(boom);
    // A timer surviving its call holds the event loop open: a process that will not exit.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer pending after a timeout', async () => {
    const lane = createAiLane();
    const settled = lane.run(() => neverSettles(), CHAT_BUDGET_MS).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(CHAT_BUDGET_MS);
    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the in-flight timeout alone when it refuses another call', async () => {
    const lane = createAiLane();
    const settled = lane.run(() => neverSettles(), CHAT_BUDGET_MS).catch((e: unknown) => e);

    await expect(lane.run(async () => 'no', CHAT_BUDGET_MS)).rejects.toBeInstanceOf(AiBusyError);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(CHAT_BUDGET_MS);
    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not hand back a late resolution from an fn that ignored its signal', async () => {
    const lane = createAiLane();
    const late = deferred<'late'>();
    const settled = lane
      .run(() => late.promise, 12_000)
      .then(
        (value) => `fulfilled with ${value}`,
        (error: unknown) => error,
      );

    await vi.advanceTimersByTimeAsync(12_000);
    late.resolve('late');
    // The caller has been told it timed out, so a `fn` that resolves anyway must not turn that
    // into a success. A lane that awaited `fn` and checked the clock afterwards would resolve
    // 'fulfilled with late' here; `Promise.race` is what makes the late settlement lose.
    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
    await expect(lane.run(async () => 'next', 12_000)).resolves.toBe('next');
  });

  it('does not replace the AiTimeoutError with a late rejection', async () => {
    const lane = createAiLane();
    const late = deferred<'late'>();
    const settled = lane.run(() => late.promise, 12_000).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(12_000);
    late.reject(new Error('an upstream detail that must never reach a caller'));
    await Promise.resolve();

    await expect(settled).resolves.toBeInstanceOf(AiTimeoutError);
    await expect(settled).resolves.toHaveProperty('message', 'The AI call exceeded its budget.');
    await expect(lane.run(async () => 'next', 12_000)).resolves.toBe('next');
  });
});
