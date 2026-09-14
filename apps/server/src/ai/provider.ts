/**
 * The `AI_FAKE` seam (TSD 5.5; CONTRACTS 8).
 *
 * **`AI_FAKE` is a real server code path selected by configuration, not a test mock.** The
 * route, retrieval, resolution, prompt construction and containment all execute exactly as in
 * production; the single thing replaced is the HTTP call to Ollama. That is what makes an
 * `AI_FAKE` test evidence rather than theatre: CI has no model and the assistant is the feature
 * most worth covering, so a seam that short-circuited the prompt build or skipped containment
 * would leave every one of those tests green and proving nothing.
 *
 * The fake returns what TSD 5.5 fixes - the RESOLVED answer, `{ answered: true, answer:
 * resolved.statement, citedMealIds: resolved.citedMealIds }` - and that reply passes containment
 * by construction. That is the point rather than a convenience: the domain resolved it, so a
 * correct containment implementation must accept it. A containment failure over the fake's reply
 * is a false positive in containment and a real defect, not a fixture to adjust.
 *
 * **One provider serves both lanes.** Chat and explanation differ only in their `format`, their
 * `decode` schema and their `echo`, and all three are parameters - so a second provider would be
 * this code with a different call site, and the two would eventually disagree about what the
 * seam does.
 *
 * **`AI_ENABLED` is not read here, deliberately.** TSD 5.2 gives the two switches two meanings:
 * `AI_ENABLED=false` makes chat answer 503 `ai_disabled` (TSD 5.4, step 4), while `AI_FAKE=true`
 * replaces the model call. Reading both here would give one decision two owners, and the route's
 * step 4 is the owner.
 */

import type { ValueSchema } from '@nutritime/contracts';
import type { ServerConfig } from '../config.js';
import { OllamaAbortError, OllamaError, createOllamaClient } from './ollamaClient.js';
import type { FetchLike } from './ollamaClient.js';

export interface Generation<T> {
  readonly prompt: string;
  readonly format: unknown;
  readonly decode: ValueSchema<T>;
  /**
   * What `AI_FAKE` returns instead of calling the model. The real provider IGNORES it.
   *
   * It is a parameter rather than a closure because TSD 5.5 fixes what the fake returns - the
   * RESOLVED answer - and only the caller holds it. That the real branch never reads it is the
   * property to assert, not merely to intend.
   */
  readonly echo: T;
}

export type AiProvider = <T>(generation: Generation<T>, signal: AbortSignal) => Promise<T>;

/**
 * The fake branch. **Module-level, closing over nothing** - no config, no client, no URL - so
 * "it cannot reach the network" is a property the reader can check by looking at its scope
 * rather than by trusting a branch elsewhere in the file.
 *
 * **An aborted signal rejects; it does not return a cheerful echo.** The real branch has no
 * pre-flight check either: platform `fetch` rejects immediately on an aborted signal and
 * `ollamaClient` turns that into `OllamaAbortError`. So rejecting here is not extra strictness,
 * it is the same observable behaviour from the same fact about the input - and that is the only
 * thing that keeps the seam honest, because a fake that resolved after cancellation would make
 * every `AI_FAKE` test of the cancellation path prove something about the fake and nothing about
 * the server. `aiLane.ts` rejects with `AiTimeoutError` BEFORE it aborts, so on the timeout path
 * the lane's race has already settled and this rejection loses, exactly as the client's does; it
 * surfaces when something else aborted the signal, and by then the caller has been told the call
 * is cancelled. Handing back an answer would fulfil a call the caller was told had stopped.
 *
 * `OllamaAbortError` is reused rather than a new type invented (AMENDMENT 1): it is raised from
 * a fact about the input and never from a guess about the caller's motive, and it discards the
 * abort reason, so a caller's `abort(someText)` cannot smuggle text across the boundary PRD 12
 * closes.
 *
 * **The echo IS validated against `decode`, and the argument against doing it is the one this
 * project keeps losing to.** The objection is real - the echo is built by the server from a
 * `ResolvedAnswer`, so parsing it tests the server against itself. But `decode` is the contract
 * with the MODEL, and on this path the fake IS the model. Skipping the parse would make the fake
 * a LOOSER path than the real one, and a reply the real path rejects as `'schema'` - a statement
 * over 700 characters, six citations where the schema allows five - would then be answered 200
 * under `AI_FAKE` and 503 against a real gemma. Brief 7.4 names that shape exactly: if a test
 * passes under `AI_FAKE` and would fail against a real model, the fake is wrong. The failure is
 * `OllamaError('schema')`, the same error from the same cause at the same stage as the real
 * path's last step, so TSD 5.8's `outcome` reads `schema` on either branch. The parse is a GATE
 * and not a transform: CONTRACTS 8 pins the returned value as `generation.echo`, and both pinned
 * schemas are `z.strictObject` with no transform, so a parsed value would be structurally
 * identical anyway.
 *
 * Rejections are returned, never thrown synchronously, so a caller inside `aiLane.run` always
 * receives a promise to race rather than a throw that escapes the race.
 */
function echoGeneration<T>(generation: Generation<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new OllamaAbortError());
  }

  const decoded = generation.decode.safeParse(generation.echo);
  if (!decoded.success) {
    return Promise.reject(new OllamaError('schema'));
  }

  return Promise.resolve(generation.echo);
}

/**
 * @param fetchImpl is forwarded to the Ollama client and exists only so a test drives the real
 *   branch without a network (CONTRACTS 7). The fake branch never receives it, which is what the
 *   zero-call assertion in `provider.test.ts` rests on.
 *
 * **The branch is taken once, here, and not per call.** `config` is frozen at boot so `AI_FAKE`
 * cannot change under a running server - and `createOllamaClient` computes
 * `${OLLAMA_BASE_URL}/api/generate` eagerly in its own body, so constructing a client on the
 * fake path would READ a variable `e2e/playwright.config.ts` deliberately leaves unset. It is
 * left unset there to prove this path does not quietly fall through to a real call, and a
 * provider that built a client it never used would defeat that proof while staying green.
 */
export function createAiProvider(config: ServerConfig, fetchImpl?: FetchLike): AiProvider {
  if (config.AI_FAKE) {
    return echoGeneration;
  }

  const client = createOllamaClient(config, fetchImpl);

  /**
   * **The three client fields are picked by name rather than `generation` forwarded whole.**
   * `Generation<T>` is assignable to `OllamaGenerateRequest<T>`, so `client.generate(generation,
   * signal)` would compile - and then the only thing keeping the echo off the wire would be the
   * client's own field-by-field body construction, one edit away in a file this module does not
   * own. Picking the fields makes "the real branch never reads `echo`" a property of this
   * function rather than a property of somebody else's.
   *
   * **No `try`/`catch`.** An `OllamaError` must reach the caller as the client threw it: its
   * `reason` is what TSD 5.8's `outcome` is derived from, so catching it to return `echo` as a
   * fallback would report a healthy model on a dead one and make every failure invisible while
   * every test stayed green. It is the single most tempting wrong implementation of this file.
   */
  function generate<T>(generation: Generation<T>, signal: AbortSignal): Promise<T> {
    return client.generate(
      { prompt: generation.prompt, format: generation.format, decode: generation.decode },
      signal,
    );
  }

  return generate;
}
