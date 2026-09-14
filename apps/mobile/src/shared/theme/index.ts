/**
 * The package's public surface.
 *
 * `primitive.ts` is deliberately **not** re-exported. TSD 6.6 calls it "importable only within the
 * theme directory", and this omission is the enforceable half of that: an importer outside this
 * package can reach `SemanticTokens` and `buildComponentTokens` but has no path to a raw ramp step,
 * so a screen cannot pick `palette.green[600]` and call it a success colour.
 *
 * `boundary.test.ts` covers the whole of `apps/mobile/src`, where a relative import could still
 * reach past the omission. Re-homed here from `packages/design-system` at P12: Plan §18's P11
 * expected-files row and TSD §6.6 both name this directory, and X-17 recorded that the package
 * form contradicted them.
 */
export type { ColorScheme, SemanticTokens } from './semantic.js';
export { colorsByScheme, darkColors, lightColors, resolveScheme } from './semantic.js';
export type { ButtonVariantTokens, ComponentTokens } from './component.js';
export { buildComponentTokens } from './component.js';
