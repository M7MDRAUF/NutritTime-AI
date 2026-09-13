/**
 * The package's public surface.
 *
 * `primitive.ts` is deliberately **not** re-exported. TSD 6.6 calls it "importable only within the
 * theme directory", and this omission is the enforceable half of that: an importer outside this
 * package can reach `SemanticTokens` and `buildComponentTokens` but has no path to a raw ramp step,
 * so a screen cannot pick `palette.green[600]` and call it a success colour.
 *
 * `boundary.test.ts` covers the inside of the package, where a relative import could still reach
 * past the omission.
 */
export type { ColorScheme, SemanticTokens } from './theme/semantic.js';
export { colorsByScheme, darkColors, lightColors, resolveScheme } from './theme/semantic.js';
export type { ButtonVariantTokens, ComponentTokens } from './theme/component.js';
export { buildComponentTokens } from './theme/component.js';
