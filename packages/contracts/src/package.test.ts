import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Rule 2 of the package graph (Plan.md 12.2): contracts is the only package with a
 * third-party runtime dependency, and that dependency is zod.
 *
 * This is asserted against the manifest rather than through a lint pattern. ESLint's
 * no-restricted-imports cannot express "deny every bare specifier except one" without
 * also swallowing relative imports, and the manifest is the thing that actually decides
 * what ships.
 */
describe('contracts package manifest', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  it('declares zod as its only runtime dependency, at the pinned version', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['zod']);
    expect(manifest.dependencies?.zod).toBe('4.5.4');
  });

  it('declares no devDependencies of its own', () => {
    expect(manifest.devDependencies ?? {}).toEqual({});
  });
});
