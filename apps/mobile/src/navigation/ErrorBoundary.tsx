/**
 * The one thing standing between a render throw and a white page (R-50).
 *
 * Before this file, `componentDidCatch`, `getDerivedStateFromError` and `ErrorBoundary` had **zero**
 * occurrences in `apps/mobile`, and there was no class component at any level of `App.tsx`. React
 * unmounts the whole root when an error reaches it uncaught, so on the web export any throw during
 * render left the document body empty: no control, no route back, and nothing on screen to say that
 * the meals, recipes and setup answers on the device were all still there. `Plan.md`'s R-50 row
 * ("**An `ErrorBoundary` around the navigator is a P22 task**, and it should render a surface that
 * says what still works rather than a blank screen") called for it, P22's own plan called it that
 * phase's most valuable single task, and the phase report never mentions it.
 *
 * **Why it lives under `navigation/` and not under `shared/components/`.** TSD §6.7's shared
 * inventory is **sixteen** components with published prop lists — `AccessibleButton`, `AppText`,
 * `Chip`, `Divider`, `EmptyState`, `ErrorState`, `FormField`, `Icon`, `IconButton`, `MealCard`,
 * `NutritionBadge`, `OfflineState`, `SearchField`, `Sheet`, `StatusMessage`, `Toast` — and a
 * seventeenth is a document amendment, which is a stop condition rather than a tidy-up. An error
 * boundary is navigation infrastructure: it wraps the navigator, it has no design-system prop
 * surface, and nothing composes it into a screen. So it is filed beside the navigator it protects,
 * and its fallback **reuses `ErrorState`** rather than authoring a seventeenth component. If you
 * are reading this while moving it into `shared/components/`: that move is a TSD §6.7 amendment,
 * and the cost is a documented divergence bought for nothing.
 *
 * `ErrorState` is imported by its own path rather than through `shared/components/index.js` on
 * purpose — the barrel pulls in all sixteen, and the surface that has to render after something
 * already failed should depend on as little as it can.
 */

import { Component } from 'react';
import type { ReactNode } from 'react';
import { ErrorState } from '../shared/components/ErrorState.js';

/**
 * PRD §12's three clauses, for the one state no screen can write its own copy for.
 *
 * "Each message says what happened, what still works, and what to do next. Stack traces and raw
 * provider errors never reach the user." **The middle clause is what R-50 is actually about**: a
 * blank screen and a bare apology are the same artefact to the person holding the phone, so
 * `ErrorState`'s default title — "Something went wrong" — is deliberately *not* what this renders.
 * It is a true sentence that leaves the reader with nothing, and this is the one failure surface
 * where the reader has lost sight of the whole app and most needs to be told what they still have.
 *
 * The voice is `ErrorState`'s and `assistantCopy.ts`'s, and their sentences are deliberately not
 * re-rolled here: `retryLabel` is left unset so the shared component's own "Try again" is used,
 * and the wording below follows the house pattern of naming the failure plainly and then naming
 * what was *not* lost ("Browsing, search and the meals you saved are untouched and still work").
 *
 * No string here carries a digit, for the same reason `chatCopy.ts` and `assistantCopy.ts` say so
 * of theirs: a figure in fixed copy is a figure nobody grounded.
 */
const FALLBACK_COPY = {
  title: 'This part of the app could not be drawn',
  description:
    'Something failed while this part of the app was being built, so it was closed rather than ' +
    'left blank. Nothing about the failure is shown here, and nothing about it leaves this device.',
  stillAvailable:
    'Everything you saved is still on this device and untouched: the meals you kept, the recipes ' +
    'you added and the answers you gave during setup. Try again rebuilds this part of the app, ' +
    'and browsing, search and suggestions all work again as soon as it comes back.',
  testID: 'navigation-error-boundary',
} as const;

/**
 * A property of the thrown value, read without trusting its type.
 *
 * React types `componentDidCatch`'s first argument as `Error`, and at runtime it is whatever was
 * thrown — a string, a `DOMException`, an object from another realm. **No `instanceof` anywhere in
 * this file**, and that is BRIEF §6.1k rather than style: under Vitest's jsdom a `DOMException`
 * from `localStorage` is not `instanceof Error` inside module code, so a guard written that way
 * would be unreachable in exactly the environment the tests run in, and mutating it would be free.
 * `name`, `message` and `stack` are plain string properties; reading them by name works across a
 * realm boundary and works on a thrown value that is not an `Error` at all.
 *
 * `Reflect.get` rather than an index, because the narrowed type here is `object` and TypeScript has
 * no index signature for it — and an `as` to paper over that is exactly the unchecked claim this
 * codebase exists to avoid.
 */
function readString(value: unknown, key: 'name' | 'message' | 'stack'): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const read: unknown = Reflect.get(value, key);
  return typeof read === 'string' ? read : undefined;
}

/**
 * Stack frames with the message stripped out — `apps/server/src/logging.ts`'s `framesOf` rule, plus
 * one filter it does not have.
 *
 * **It is transcribed rather than imported, and that is forced.** `eslint.config.mjs`'s
 * `appEscape('server')` pattern makes `apps/mobile` importing `apps/server` a lint error, and BRIEF
 * §2 makes crossing it a stop condition; the same wall is why `assistantCopy.test.ts` carries a
 * hand-written copy of the denied-claim list instead of calling `deniedClaimIn`. So the *rule* is
 * reused — the error's name plus `    at …` lines, never the message line — and the shape of the
 * line below is `errorLogLine`'s five fields, field for field.
 *
 * **The extra filter, and why the server's version needs it too.** `framesOf` keeps every line
 * matching `/^\s+at\s/` and relies on the header line (`Error: <message>`) not matching. A message
 * that itself contains a newline and an indented `at …` line therefore survives the filter — and a
 * message here can quote a payload, which can be a name or an allergy list (PRD §10.3, TSD §5.8).
 * So any frame-shaped line that is also one of the message's own lines is dropped. A genuine frame
 * is never a line of the message unless the message quotes one verbatim, in which case dropping it
 * is the conservative answer. The residual in `apps/server/src/logging.ts` is reported, not edited:
 * that file is spine.
 */
function framesOf(error: unknown): readonly string[] {
  const stack = readString(error, 'stack');
  if (stack === undefined) {
    return [];
  }
  const message = readString(error, 'message') ?? '';
  const messageLines = new Set(message.split('\n').map((line) => line.trim()));
  return stack
    .split('\n')
    .filter((line) => /^\s+at\s/.test(line))
    .map((line) => line.trim())
    .filter((line) => !messageLines.has(line));
}

/**
 * What the default sink writes. **The message is not in it, and there is no path that puts it there.**
 *
 * TSD §5.8 closes the set of things a log line may carry and names what is never logged: "prompts,
 * questions, answers, allergy lists, names, or request bodies". PRD §10.3 is the requirement behind
 * it. An exception message is none of those categories by construction and all of them in practice
 * — `mealPeriodForDate`'s throw on an unparseable meal time, the one reachable instance R-50's row
 * records, would quote the stored value — so the name and the frames are what goes out.
 *
 * `message` is the *fixed local* string `'unhandled render error'`, the way `errorLogLine`'s is
 * `'unhandled error'`: a constant that says where the line came from, never anything read off the
 * throw.
 *
 * **There is no mobile-side log sink to report through.** Measured: `LogSink`, `framesOf`,
 * `errorLogLine` and even a bare `console.error` or `console.warn` have zero non-test occurrences
 * anywhere in `apps/mobile/src` or `App.tsx`. `apps/server/src/logging.ts`'s `consoleSink` is on
 * the far side of the import boundary. So this is the first one, and it is deliberately the
 * smallest thing that satisfies the rule rather than a logging layer nobody asked for:
 * `console.error` is the one console method `eslint.config.mjs` allows outside tests, and on the
 * web export it is the only sink there is.
 */
function reportLine(error: unknown): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    message: 'unhandled render error',
    errorName: readString(error, 'name') ?? 'UnknownError',
    frames: framesOf(error),
  });
}

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Test seam only. Production passes nothing; the default reports through the existing sink. */
  readonly onError?: (error: Error) => void;
}

/**
 * One flag, and deliberately nothing else.
 *
 * The caught error is **not** held in state. Nothing in the fallback may render it (PRD §12: stack
 * traces and raw provider errors never reach the user), so keeping it would be a value with no
 * legitimate reader and one obvious illegitimate one — the next person to add a "details" toggle.
 */
export interface ErrorBoundaryState {
  readonly failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { failed: false };
    this.retry = this.retry.bind(this);
  }

  /**
   * The half that stops the unmount. Without it the throw reaches the root and React empties the
   * document — R-50 exactly — no matter what `componentDidCatch` below does.
   *
   * It takes no argument, because the surface it selects does not depend on what was thrown. There
   * is one fallback and it is the same for every failure: this component cannot tell an unparseable
   * meal time from a bad store read, and copy that guessed would send the reader to fix the wrong
   * thing (`ErrorState`'s own docstring makes the same argument for its default title).
   */
  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  /**
   * The report. Separate from the state transition because React calls this one in the commit
   * phase, where a side effect is allowed.
   *
   * `onError` **replaces** the default rather than running alongside it: it exists so a test can
   * see the thrown value without the suite writing a line to the console on every case. It is
   * typed `(error: Error) => void` and receives the throw untouched, which makes it a seam and not
   * a second log path — a sink typed that way could print the message, so production passes nothing
   * and the default below is the only reporter the app ships.
   */
  override componentDidCatch(error: Error): void {
    const { onError } = this.props;
    if (onError !== undefined) {
      onError(error);
      return;
    }
    // The one console call in `apps/mobile`, and the only one `no-console` would allow.
    console.error(reportLine(error));
  }

  /**
   * The way out, and the reason this is a boundary rather than a nicer white page.
   *
   * **What a retry can recover:** anything that threw from a value that has since changed or from a
   * one-off — a store that has been written since, a race, a read that failed once. Clearing the
   * flag re-renders `children`, which remounts the subtree from scratch while every provider above
   * this boundary stays mounted, so the hydrated stores, the theme and the API client are all still
   * there and nothing is re-read from storage.
   *
   * **What it cannot recover:** a throw that is deterministic in the state the app is in. The
   * subtree will throw again on the same render and the fallback comes straight back — which is
   * the honest outcome and is why the copy above points at what survived rather than promising the
   * button will work. It also cannot recover a throw from *above* this boundary; see the note on
   * where it is mounted, in `App.tsx`.
   */
  private retry(): void {
    this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <ErrorState
        testID={FALLBACK_COPY.testID}
        title={FALLBACK_COPY.title}
        description={FALLBACK_COPY.description}
        stillAvailable={FALLBACK_COPY.stillAvailable}
        onRetry={this.retry}
      />
    );
  }
}
