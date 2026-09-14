/**
 * Reporting for the P25 measurement lane.
 *
 * **Plan P25 Part 4 is the whole of the contract: three runs, median and worst.** So `emit` will
 * not print a figure without both, and it prints the raw runs beside them — three samples give a
 * median with no dispersion estimate at all, and a reader who cannot see the spread cannot tell a
 * stable figure from a lucky one.
 *
 * **A figure carries its method or it is not emitted.** `note` is required, not optional. PRD
 * §10.1's table is quoted later as if every number in it were comparable; a figure whose build,
 * viewport, warm state and confounds are not attached to it is worse than no figure, because the
 * missing half is exactly the half a reader supplies from assumption.
 *
 * `process.stdout.write` and not `console.log`: `no-console` allows only `warn` and `error`
 * outside tests (`eslint.config.mjs:144`), and the one exemption in `e2e/` is for
 * `serveExport.mjs` by name. Writing measurements to stderr to satisfy a lint rule would put the
 * numbers in the wrong stream; `process.stdout.write` is not the `console` object at all.
 */

/** Ascending copy. `toSorted` is ES2023, which `e2e/tsconfig.json` targets. */
function ascending(values: readonly number[]): readonly number[] {
  return values.toSorted((left, right) => left - right);
}

/**
 * The lower median for an even count.
 *
 * Stated rather than averaged: Part 4 asks for *a* median of three runs, and interpolating between
 * two samples invents a value no run produced. With the odd counts this lane actually uses the two
 * definitions agree, and the choice only matters if a run is lost.
 */
export function median(values: readonly number[]): number {
  const sorted = ascending(values);
  const value = sorted[Math.floor((sorted.length - 1) / 2)];
  if (value === undefined) {
    throw new Error('median of no samples');
  }
  return value;
}

/** Worst means slowest, which for a latency is the maximum. */
export function worst(values: readonly number[]): number {
  const sorted = ascending(values);
  const value = sorted[sorted.length - 1];
  if (value === undefined) {
    throw new Error('worst of no samples');
  }
  return value;
}

/**
 * What kind of figure PRD §10.1's number is for this row — and the two are not interchangeable.
 *
 * - `budget` — a latency the path must stay UNDER. ≤ 2.5 s, ≤ 150 ms, ≤ 2 s. Over is a miss.
 * - `deadline` — a timeout that must FIRE, and at roughly the configured moment. PRD §10.1's
 *   "hard timeout 30 s" is one of these. A request that ends at 30.02 s has behaved exactly as
 *   specified, and printing MISS for it would be as dishonest as rounding a real miss into a
 *   pass — in the other direction. A request that ended at 3 s would be the actual defect, because
 *   something other than the budget fired; `toleranceMs` is two-sided for that reason.
 */
export type PerfKind = 'budget' | 'deadline';

export interface PerfRow {
  /** The Plan row this figure answers, e.g. `T-25-01`. */
  readonly row: string;
  /** What was measured, from which event to which event. */
  readonly what: string;
  /** PRD §10.1's figure in ms, or `null` where no document sets one. */
  readonly targetMs: number | null;
  /** Defaults to `budget`. */
  readonly kind?: PerfKind;
  /** Only for `deadline`: how far either side of the target still counts as behaving. */
  readonly toleranceMs?: number;
  readonly runsMs: readonly number[];
  /** Build, viewport, warm state, confounds. Required. */
  readonly note: string;
}

function ms(value: number): string {
  return value.toFixed(1);
}

/**
 * The verdict, on the median AND the worst.
 *
 * Both, because a median inside the budget with a worst outside it is a different product from one
 * where both are inside, and collapsing them to one word is how a marginal figure becomes a clean
 * pass in a later quotation. Part 5 forbids relaxing a target, so nothing here rounds.
 */
function verdictFor(row: PerfRow, medianMs: number, worstMs: number): string {
  const target = row.targetMs;
  if (target === null) {
    return 'NO TARGET';
  }
  if ((row.kind ?? 'budget') === 'deadline') {
    const tolerance = row.toleranceMs ?? 0;
    const behaves = (value: number): string =>
      Math.abs(value - target) <= tolerance ? 'BEHAVES' : 'DOES NOT BEHAVE';
    return (
      `median ${behaves(medianMs)} · worst ${behaves(worstMs)} ` +
      `(a DEADLINE that must fire: overshoot median ${ms(medianMs - target)} ms, ` +
      `worst ${ms(worstMs - target)} ms, tolerance ±${ms(tolerance)} ms)`
    );
  }
  return `median ${medianMs <= target ? 'PASS' : 'MISS'} · worst ${worstMs <= target ? 'PASS' : 'MISS'}`;
}

export function emit(row: PerfRow): void {
  const runs = row.runsMs.map(ms).join(', ');
  const target = row.targetMs === null ? 'no documented target' : `${ms(row.targetMs)} ms`;
  const medianMs = median(row.runsMs);
  const worstMs = worst(row.runsMs);
  const verdict = verdictFor(row, medianMs, worstMs);
  process.stdout.write(
    [
      `PERF ${row.row} :: ${row.what}`,
      `  target  ${target}`,
      `  runs    ${runs}`,
      `  median  ${ms(medianMs)} ms`,
      `  worst   ${ms(worstMs)} ms`,
      `  verdict ${verdict}`,
      `  method  ${row.note}`,
      '',
    ].join('\n'),
  );
}

/**
 * A sensitivity probe's result: the same figure with a delay injected.
 *
 * **BRIEF §6.1's probe rule applied to a timing harness.** If the app got twice as slow, would
 * this harness report it? `moved` is the answer, and it has to be close to `injectedMs` — a
 * harness that reports the same number under an injected stall is measuring something else.
 */
export function emitProbe(
  row: string,
  what: string,
  injectedMs: number,
  baselineMs: number,
  probedMs: number,
): void {
  const moved = probedMs - baselineMs;
  process.stdout.write(
    [
      `PROBE ${row} :: ${what}`,
      `  injected ${ms(injectedMs)} ms`,
      `  baseline ${ms(baselineMs)} ms`,
      `  probed   ${ms(probedMs)} ms`,
      `  moved    ${moved >= 0 ? '+' : ''}${ms(moved)} ms`,
      '',
    ].join('\n'),
  );
}

/** A free-form observation that belongs beside the figures rather than in prose. */
export function emitNote(row: string, text: string): void {
  process.stdout.write(`NOTE ${row} :: ${text}\n`);
}
