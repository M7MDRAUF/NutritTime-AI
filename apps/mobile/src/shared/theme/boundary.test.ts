import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T-11-05's acceptance is "`primitive.ts` not importable outside the theme directory", with
 * "Lint rule + test" as its evidence. This is the test half.
 *
 * The lint half landed at P11 as a Rule 3 entry and was re-pointed at `apps/mobile` when these
 * modules were re-homed here. This file remains the stronger of the two halves, because it reads
 * the tree from disk: an import-based check would pass while a violating file sat right beside it,
 * unread.
 */

// Re-homed at P12. Scanning `apps/mobile/src` rather than one package's `src` is a STRONGER
// check than the original: the thing worth preventing is a screen reaching a raw ramp step, and
// the screens live here.
const themeDirectory = import.meta.dirname;
const sourceRoot = path.resolve(themeDirectory, '..', '..');
/** The barrel now lives inside the theme directory, because the theme IS the module. */
const barrelPath = path.join(themeDirectory, 'index.ts');

function typeScriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...typeScriptFilesUnder(full));
      // `.tsx` too, and leaving it out made this whole file blind. `'AppText.tsx'.endsWith('.ts')`
      // is FALSE, so the walker scanned 31 `.ts` files and skipped 42 `.tsx` ones - every shared
      // component, every navigator, the screen registry, and `ThemeProvider` itself. The docblock
      // above says "the thing worth preventing is a screen reaching a raw ramp step, and the
      // screens live here", which was exactly true of every file it could not see: adding
      // `import { palette } from '../theme/primitive.js'` to any component broke nothing here.
      //
      // An oversight rather than a choice - the structurally identical walker in
      // `asyncStorageDriver.test.ts` reads both extensions. The lint half of T-11-05 did cover
      // these files (`--print-config` on a `.tsx` shows the `primitive` pattern), so the boundary
      // was enforced; just not by the half this file calls the stronger of the two.
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(full);
    }
  }
  return found;
}

/** Any specifier ending in `primitive.js`, at any relative depth and in either quote style. */
function importsPrimitive(source: string): boolean {
  return /from\s+['"][^'"]*primitive\.js['"]/.test(source);
}

describe('primitive.ts is private to the theme directory', () => {
  const files = typeScriptFilesUnder(sourceRoot);

  it('finds the source tree it is supposed to be checking', () => {
    // Without this, a wrong `packageRoot` would make every assertion below vacuously true — the
    // failure mode of any test that walks a directory.
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain(path.join(themeDirectory, 'primitive.ts'));
    expect(files).toContain(barrelPath);
  });

  it.each([
    ['semantic.ts', true],
    ['component.ts', true],
  ])('%s is inside the theme directory and may import it', (name, expected) => {
    const source = fs.readFileSync(path.join(themeDirectory, name), 'utf8');
    expect(importsPrimitive(source)).toBe(expected);
  });

  it('no file outside src/theme/ imports it', () => {
    const offenders = files
      .filter((file) => path.dirname(file) !== themeDirectory)
      .filter((file) => importsPrimitive(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(sourceRoot, file));
    expect(offenders, 'files outside src/theme/ importing primitive.js').toEqual([]);
  });

  it('the theme barrel does not re-export it', () => {
    const index = fs.readFileSync(barrelPath, 'utf8');
    expect(importsPrimitive(index)).toBe(false);
    expect(index).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*primitive/);
    // Comments stripped first. The first version of this assertion failed on `index.ts`'s own doc
    // comment, which names `palette` while explaining why `palette` is not exported — a check that
    // cannot tell prose from code would have forced the explanation out of the file.
    const code = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bpalette\b|\btypeScale\b|\bzIndex\b/);
  });
});
