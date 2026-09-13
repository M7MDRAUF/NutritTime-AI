import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * T-11-05's acceptance is "`primitive.ts` not importable outside the theme directory", with
 * "Lint rule + test" as its evidence. This is the test half.
 *
 * The lint half is **not delivered by P11** and is not silently missing: `eslint.config.mjs` is
 * outside this phase's ownership, so a `no-restricted-imports` entry for `packages/design-system`
 * is recorded as a follow-up in the phase report instead of being added here. Until it exists this
 * file is the only thing standing between a screen and a raw ramp step, which is why it reads the
 * tree from disk rather than asserting something about a module it imported — an import-based check
 * would pass while a violating file sat right beside it, unread.
 */

const packageRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceRoot = path.join(packageRoot, 'src');
const themeDirectory = path.join(sourceRoot, 'theme');

function typeScriptFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...typeScriptFilesUnder(full));
    } else if (entry.name.endsWith('.ts')) {
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
    expect(files).toContain(path.join(sourceRoot, 'index.ts'));
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
      .map((file) => path.relative(packageRoot, file));
    expect(offenders, 'files outside src/theme/ importing primitive.js').toEqual([]);
  });

  it('the package entry point does not re-export it', () => {
    const index = fs.readFileSync(path.join(sourceRoot, 'index.ts'), 'utf8');
    expect(importsPrimitive(index)).toBe(false);
    expect(index).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*primitive/);
    // Comments stripped first. The first version of this assertion failed on `index.ts`'s own doc
    // comment, which names `palette` while explaining why `palette` is not exported — a check that
    // cannot tell prose from code would have forced the explanation out of the file.
    const code = index.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bpalette\b|\btypeScale\b|\bzIndex\b/);
  });
});
