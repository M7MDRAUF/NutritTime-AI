/**
 * The single-flight gate in front of the local model (TSD 5.5; Plan 15.5's Concurrency row).
 *
 * One inference at a time, process-wide. A second concurrent `run` rejects with `AiBusyError`
 * **immediately**, and there is no queue: on a single-user local app, waiting behind another
 * inference is not a state worth building machinery for, and a queue would silently turn a
 * 30-second budget into a 60-second wait for a question the user has already abandoned.
 *
 * **"Process-wide" is a property of the wiring, not of this file.** It holds exactly as long as
 * boot creates ONE lane and hands the same instance to both the chat and the explanation call
 * site. Two `createAiLane()` calls are two lanes and therefore two concurrent inferences on one
 * 4B model, which is the shape of the failure this module exists to prevent.
 *
 * The lane knows nothing about Ollama, prompts, HTTP or JSON, and it must stay that way - it is
 * a concurrency primitive. It also does not map its own failures onto `ai_busy` /
 * `ai_unavailable`; the route does that, from the fixed copy in `errors.ts`.
 */

/**
 * The lane is occupied.
 *
 * The message is a **fixed local string** and reaches no user: the route answers 503 `ai_busy`
 * with the copy in `errors.ts` (PRD 12, TSD 3.5). There is no message parameter, so there is no
 * way for an upstream string to arrive here in the first place.
 */
export class AiBusyError extends Error {
  public constructor() {
    super('The AI lane is already running a call.');
    // An `Error` subclass inherits `name: 'Error'`, so without this line the AI log line's
    // `outcome` field (TSD 5.8) and any `error.name` branch would report the wrong thing.
    this.name = 'AiBusyError';
  }
}

/** The budget passed. Fixed local message, for the same reason as `AiBusyError`'s. */
export class AiTimeoutError extends Error {
  public constructor() {
    super('The AI call exceeded its budget.');
    this.name = 'AiTimeoutError';
  }
}

export interface AiLane {
  /**
   * Run `fn` as the one in-flight AI call.
   *
   * `fn` receives this call's `AbortSignal` and is **expected to honour it**: the lane aborts on
   * the deadline, but it cannot cancel work `fn` does not offer to cancel. Rejects with
   * `AiBusyError` when the lane is occupied and `AiTimeoutError` when `timeoutMs` passes.
   * Anything `fn` itself throws is rethrown unchanged - the lane classifies nothing.
   */
  run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T>;
}

export function createAiLane(): AiLane {
  /** The whole of the lane's state. */
  let occupied = false;

  async function run<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    // Claimed BEFORE anything can await. Two callers arriving in the same turn therefore
    // cannot both read `false`; an `await` anywhere above this line would let them.
    const owner = !occupied;
    if (owner) {
      occupied = true;
    }

    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      if (!owner) {
        // Thrown, not awaited. Nothing above this point yields, so the promise `run` returns is
        // ALREADY rejected by the time the caller receives it - which is what TSD 5.5's
        // "immediately" asks for, and what lets the route answer 503 instead of holding a
        // socket open behind somebody else's inference.
        throw new AiBusyError();
      }

      const owned = new AbortController();
      controller = owned;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // **`reject` before `abort`, and that order is load-bearing.** Both happen in this one
          // tick, so `fn` learns of the cancellation just as promptly either way - but
          // `Promise.race` settles with whichever of its two promises rejected FIRST. Aborting
          // first lets a well-behaved `fn` that rejects from its own abort listener win the
          // race, and the caller is then handed `fn`'s cancellation error in place of
          // `AiTimeoutError`: the same 503 for the user, but the AI log line's `outcome`
          // (TSD 5.8) reads `unreachable` on a call that actually timed out. Verified both ways
          // against Node before it was written down.
          reject(new AiTimeoutError());
          owned.abort();
        }, timeoutMs);
      });

      // A race, not `await fn(...)` followed by an elapsed-time check. `fn` is expected to
      // honour the signal but is not TRUSTED to: if it ignores the abort and settles late, the
      // race has already been decided and the late settlement loses. Handing a late value back
      // would fulfil a call the caller was told had timed out. The race also keeps a late
      // REJECTION handled, so an ignored abort cannot surface as an unhandled rejection.
      //
      // `return await` is load-bearing. A plain `return` of the race resolves this async
      // function's promise WITH it and runs `finally` straight away - clearing the timer before
      // it can fire and releasing the lane while the call is still running.
      return await Promise.race([fn(owned.signal), deadline]);
    } finally {
      // The one cleanup, covering all four exits: success, `fn` throwing, the timeout, and the
      // busy rejection. A timer left running holds the event loop open, which shows up as a
      // server process that will not exit rather than as a failing test.
      //
      // `controller.abort()` runs on the success path too. It is a no-op for work that has
      // already finished, and it makes the signal a truthful report of one thing - whether this
      // call is still live - so a `fn` that kept hold of it cannot keep working past its own
      // resolve.
      //
      // **`occupied` is why the guard is here.** It is the lane's one piece of shared state, so
      // an unconditional `occupied = false` would let the REFUSED caller hand the lane away
      // while the in-flight call is still running, and two inferences would overlap.
      //
      // `controller` and `timer` are per-invocation locals, which is the other half of the
      // argument: the refused caller has none of its own to release and cannot reach anybody
      // else's. They are inside the guard for one rule rather than three, not because an
      // unguarded `clearTimeout(undefined)` would do damage.
      if (owner) {
        clearTimeout(timer);
        controller?.abort();
        occupied = false;
      }
    }
  }

  return { run };
}
