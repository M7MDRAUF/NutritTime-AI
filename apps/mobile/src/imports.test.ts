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

/** The substitution `metro.config.js` performs, and the one tsc and Vitest already perform. */
function resolves(fromFile: string, specifier: string): boolean {
  const directory = path.dirname(fromFile);
  const base = specifier.endsWith(JS_SUFFIX) ? specifier.slice(0, -JS_SUFFIX.length) : specifier;
  const candidates = specifier.endsWith(JS_SUFFIX)
    ? [specifier, `${base}.tsx`, `${base}.ts`]
    : [`${specifier}.ts`, `${specifier}.tsx`, path.join(specifier, 'index.ts')];
  return candidates.some((candidate) => {
    const target = path.resolve(directory, candidate);
    return fs.existsSync(target) && fs.statSync(target).isFile();
  });
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
});
