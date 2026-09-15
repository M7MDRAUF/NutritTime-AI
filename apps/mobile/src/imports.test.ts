import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every relative `.js` import in this app resolves to a file that exists (T-13-07).
 *
 * **Written because the first bundle of this app failed, and nothing in 1450 tests had noticed.**
 * The project rule is that every relative import ends in `.js`, while the sources are `.ts` and
 * `.tsx`. tsc understands that and so does Vitest — both substitute the extension. Metro does not:
 * it APPENDS its `sourceExts`, so the app's entry import was looked for as `App.js.ts`,
 * `App.js.tsx`, and the real `App.tsx` was never tried:
 *
 *     Unable to resolve "./App.js" from "apps/mobile/index.ts"
 *
 * `metro.config.js` now carries a `resolveRequest` that substitutes properly. This file is the
 * cheap half of the guard: it re-derives, from the tree, that every relative specifier has a real
 * file behind it under the same substitution rule the bundler uses. A broken import fails here in
 * milliseconds rather than three minutes into `expo export`, or — worse — only on a device.
 *
 * It does NOT replace building the app. `npm run build:web` is part of this phase's gate evidence
 * for exactly that reason: a resolver this test satisfies and Metro rejects is still possible, and
 * only the bundler can rule it out.
 */

const APP_ROOT = path.resolve(import.meta.dirname, '..');
const JS_SUFFIX = '.js';

function sourceFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.expo') {
        found.push(...sourceFilesUnder(full));
      }
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The file's text with every comment blanked out.
 *
 * **Not tidiness.** The first version of this suite scanned raw text and failed on its own
 * docblock, which quoted two example specifiers — so a file that merely *mentions* an import would
 * have broken the build. Blanked character for character rather than deleted, so the line numbers
 * in a failure message still point at the real line.
 */
function withoutComments(text: string): string {
  const blank = (segment: string): string =>
    [...segment].map((character) => (character === '\n' ? '\n' : ' ')).join('');
  const block = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
  const line = new RegExp('//[^\\n]*', 'g');
  return text.replace(block, blank).replace(line, blank);
}

/** Every relative specifier a file imports from, with its line number. */
function relativeImports(file: string): { readonly specifier: string; readonly line: number }[] {
  const text = withoutComments(fs.readFileSync(file, 'utf8'));
  const found: { specifier: string; line: number }[] = [];
  const pattern = new RegExp("from\\s+'(\\.[^']*)'", 'g');
  for (const match of text.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    found.push({ specifier, line: text.slice(0, match.index).split('\n').length });
  }
  return found;
}

/**
 * The file a specifier resolves to, or `null`. The substitution `metro.config.js` performs, and the
 * one tsc and Vitest already perform.
 *
 * Returns the PATH rather than a boolean because the cycle check below needs the graph's edges and
 * not merely the fact that each one lands somewhere. `resolves` is derived from it, so the two
 * cannot come to disagree about what resolves — which is the whole of R-78's lesson in miniature.
 */
function resolvedTarget(fromFile: string, specifier: string): string | null {
  const directory = path.dirname(fromFile);
  const base = specifier.endsWith(JS_SUFFIX) ? specifier.slice(0, -JS_SUFFIX.length) : specifier;
  const candidates = specifier.endsWith(JS_SUFFIX)
    ? [specifier, `${base}.tsx`, `${base}.ts`]
    : [`${specifier}.ts`, `${specifier}.tsx`, path.join(specifier, 'index.ts')];
  for (const candidate of candidates) {
    const target = path.resolve(directory, candidate);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  }
  return null;
}

/**
 * Every import cycle, each reported once, as a sorted strongly-connected component.
 *
 * **Tarjan rather than the path-wise walk `features/saved/mealRecord.test.ts` uses**, because that
 * one is exponential in a dense graph and this graph is the whole app: 174 files and 724 edges
 * against that file's nine modules. The output shape differs as a result — an SCC
 * (`a <-> b`), not a rotation (`a -> b -> a`) — and the control below is written against THIS
 * detector's output for that reason rather than copied from the other one.
 *
 * **Known limit, asserted rather than left to be found: a self-loop is not reported.** An SCC of
 * one node is not a cycle to Tarjan even when the node points at itself, and a file importing
 * itself is a real mistake. It is out of reach here for a different reason — `noImportSelf` in
 * `eslint.config.mjs` has no equivalent, but a self-import cannot resolve to a different file and
 * TypeScript reports the circular reference — so the limit is documented and pinned, not fixed.
 */
function cyclesIn(graph: ReadonlyMap<string, readonly string[]>): readonly string[] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[] = [];
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
        if (popped === node) break;
      }
      if (component.length > 1) cycles.push(component.sort().join(' <-> '));
    }
  };
  for (const node of graph.keys()) {
    if (!index.has(node)) visit(node);
  }
  return cycles.sort();
}

/** The existing boolean form, now DERIVED, so the two cannot disagree. */
function resolves(fromFile: string, specifier: string): boolean {
  return resolvedTarget(fromFile, specifier) !== null;
}

const FILES = [...sourceFilesUnder(path.join(APP_ROOT, 'src'))];
for (const root of ['App.tsx', 'index.ts']) {
  const full = path.join(APP_ROOT, root);
  if (fs.existsSync(full)) {
    FILES.push(full);
  }
}

describe('relative imports in apps/mobile', () => {
  it('scans the whole app, App.tsx and index.ts included', () => {
    // The two files outside `src/` are the ones the bundler enters through, and the ones the
    // original failure was in — so their presence here is the point rather than a detail.
    expect(FILES.length).toBeGreaterThan(40);
    expect(FILES.some((file) => file.endsWith(`${path.sep}App.tsx`))).toBe(true);
    expect(FILES.some((file) => file.endsWith(`${path.sep}index.ts`))).toBe(true);
    // And `.tsx` is included, which `boundary.test.ts` silently was not until P12's verification.
    expect(FILES.filter((file) => file.endsWith('.tsx')).length).toBeGreaterThan(20);
  });

  it('every relative specifier has a real file behind it', () => {
    const broken: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      for (const { specifier, line } of relativeImports(file)) {
        checked += 1;
        if (!resolves(file, specifier)) {
          broken.push(`${path.relative(APP_ROOT, file)}:${String(line)} -> ${specifier}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(80);
    expect(broken, `unresolvable relative imports:\n  ${broken.join('\n  ')}`).toStrictEqual([]);
  });

  it('ends every relative specifier in `.js`, as the project requires', () => {
    // The convention itself, asserted rather than assumed. It is what `verbatimModuleSyntax` and
    // Node's ESM resolution need, and it is the reason the Metro resolver exists at all — so a file
    // that quietly drops the extension makes that resolver look unnecessary.
    const bare: string[] = [];
    for (const file of FILES) {
      for (const { specifier, line } of relativeImports(file)) {
        if (!specifier.endsWith(JS_SUFFIX) && !specifier.endsWith('.json')) {
          bare.push(`${path.relative(APP_ROOT, file)}:${String(line)} -> ${specifier}`);
        }
      }
    }
    expect(bare, `relative imports missing .js:\n  ${bare.join('\n  ')}`).toStrictEqual([]);
  });

  it('blanks comments without shifting a single line', () => {
    // The helper is load-bearing for both assertions above, so it gets its own check rather than
    // being trusted — and a line-number shift would make every failure message point at the wrong
    // place, which is worse than no message at all.
    // Both specifiers are ASSEMBLED rather than written out, so this file's own source never
    // contains the `from` keyword beside a quoted path. Written literally, the scanner finds them
    // in its own fixture and reports `./real.js` as unresolvable — which it did. That is the honest
    // limit of a regex scanner: it cannot tell a specifier in code from one inside a string.
    const ghost = ['/* from ', "'./ghost.js'", ' */'].join('');
    const real = ['import x ', 'from ', "'./real.js'", ';'].join('');
    const source = ['const a = 1;', ghost, real].join('\n');
    const stripped = withoutComments(source);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(stripped).not.toContain('ghost');
    expect(stripped).toContain("'./real.js'");
  });
  it('has no import cycle anywhere in the app, type-only edges included', () => {
    /**
     * `Plan.md` §12.2 rule 6 and `TSD.md` §2.3 rule 5 — "no cyclic imports between modules" —
     * which had **no executable guard anywhere** until P28. The audit found the tree's only cycle
     * with a bespoke script, and it was invisible to a value-edge-only scan because one side was
     * `import type`: making it a value import failed **0 of 292** tests.
     *
     * **Every edge counts, type-only included, because the rule is about the SOURCE graph.** The
     * cycle that existed — `saved/mealRecord.ts` ↔ `mealFormValidation.ts` — was harmless at
     * runtime solely because `verbatimModuleSyntax` erases a type import, which is a property of
     * the compiler and not of the architecture.
     *
     * **No plugin.** `eslint-plugin-import` is present only as `eslint-config-expo`'s floating
     * transitive and `TSD.md` §2.1 pins neither (X-10), so importing it would be the dependency
     * stop condition. The walk is already paid for by the three tests above; Tarjan over its graph
     * measured 0.4–0.8 ms.
     *
     * `features/saved` keeps its own narrower check: a failure there names the exact edge, which
     * this one cannot.
     */
    // Keyed on paths RELATIVE to `apps/mobile`, so a failure names `src/features/saved/…` rather
    // than one contributor's home directory. The message is the whole value of this assertion —
    // "some cycle exists" is not actionable — and a machine-local absolute path in it is noise at
    // best. Relativising both ends keeps the graph closed: an edge must land on a node.
    const nodeOf = (file: string): string =>
      path.relative(APP_ROOT, file).split(path.sep).join('/');
    const graph = new Map<string, readonly string[]>(
      FILES.map((file) => [
        nodeOf(file),
        relativeImports(file)
          .map(({ specifier }) => resolvedTarget(file, specifier))
          .filter((target): target is string => target !== null)
          .map(nodeOf),
      ]),
    );
    const edges = [...graph.values()].reduce((total, list) => total + list.length, 0);

    // Non-vacuity, because an empty graph is acyclic: the floors are low enough not to need
    // maintenance and high enough that a walk which collected nothing fails here first.
    expect(graph.size).toBeGreaterThanOrEqual(100);
    expect(edges).toBeGreaterThanOrEqual(400);

    const cycles = cyclesIn(graph);
    expect(cycles, `import cycles:\n  ${cycles.join('\n  ')}`).toStrictEqual([]);
  });

  it('detects a cycle when there is one, reports none when there is not, and misses a self-loop', () => {
    /**
     * **The detector's own control**, without which a `cyclesIn` returning `[]` for every input
     * would satisfy the assertion above forever — which is precisely how the cycle it replaces
     * survived nine phases of green gates.
     *
     * Written against **this** detector's output rather than copied from
     * `features/saved/mealRecord.test.ts`: that one walks paths and reports rotations
     * (`a -> b -> a`), this one reports strongly-connected components (`a <-> b`). A verbatim copy
     * would have been a green test asserting the wrong shape.
     *
     * The third case pins the **limit** rather than the behaviour, so the gap is checked instead of
     * described: an SCC of one node is not a cycle to Tarjan, so `a -> a` is not reported.
     */
    const twoCycle = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const threeCycle = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const acyclic = new Map([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', []],
    ]);
    const selfLoop = new Map([['a', ['a']]]);
    const twoComponents = new Map([
      ['a', ['b']],
      ['b', ['a']],
      ['c', ['d']],
      ['d', ['c']],
    ]);

    expect(cyclesIn(twoCycle)).toStrictEqual(['a <-> b']);
    expect(cyclesIn(threeCycle)).toStrictEqual(['a <-> b <-> c']);
    expect(cyclesIn(acyclic)).toStrictEqual([]);
    // Documented limit, not a passing case dressed up: see the docstring on `cyclesIn`.
    expect(cyclesIn(selfLoop)).toStrictEqual([]);
    // Two disjoint cycles are two findings, not one - a reporter that merged them would hide one.
    expect(cyclesIn(twoComponents)).toStrictEqual(['a <-> b', 'c <-> d']);
  });
});
