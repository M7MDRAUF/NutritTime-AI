/**
 * Metro, taught about the monorepo and about this project's import convention.
 *
 * `watchFolders` puts the workspace root in Metro's watch set, so a change in `packages/domain`
 * reaches the app without a restart. `disableHierarchicalLookup` is NOT disabled - instead
 * `nodeModulesPaths` names both the app's own `node_modules` and the root's, because npm workspaces
 * hoist most packages to the root and Metro would otherwise resolve only what happens to be nested.
 *
 * **And then `resolveRequest`, which the first bundle of this app made unavoidable.**
 *
 * Every relative import in this repository ends in `.js` - that is a project-wide rule, required by
 * `verbatimModuleSyntax` and by Node's ESM resolution, and the source files are `.ts` and `.tsx`.
 * tsc understands the convention and so does Vitest, which is why 1450 tests and six typecheck
 * projects were green while **nothing had ever been bundled**. Metro does not: it APPENDS its
 * `sourceExts` to a specifier rather than substituting, so `./App.js` is looked for as
 * `App.js.ts`, `App.js.tsx`, `App.js.web.js`, and the real `App.tsx` is never tried:
 *
 *     Unable to resolve "./App.js" from "apps/mobile/index.ts"
 *       * App.js(.web.ts|.ts|.web.tsx|.tsx|...)
 *
 * The two ways out were to abandon the convention inside `apps/mobile`, or to teach the bundler
 * what the convention means. Abandoning it would split the repository's import style at one
 * directory boundary and give the mobile app a rule none of the other five projects follow - a
 * difference every future file has to remember. So the bundler is taught, in one place, below.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

/**
 * Map a relative `./x.js` specifier onto the `.ts`/`.tsx` source that actually exists.
 *
 * Only when the literal file is absent, so a real `.js` on disk still wins and a third-party
 * package importing its own compiled output is untouched. Only for RELATIVE specifiers, so nothing
 * in `node_modules` can be redirected by it. And it delegates back to Metro's own resolver for
 * everything else, including the substituted path, so platform extensions (`.web.tsx`), the
 * `react-native` condition and the monorepo paths above all keep working.
 */
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isRelative = moduleName.startsWith('./') || moduleName.startsWith('../');
  if (isRelative && moduleName.endsWith('.js')) {
    const base = moduleName.slice(0, -'.js'.length);
    const from = path.dirname(context.originModulePath);
    // `.js` first: if the compiled file is genuinely there, it is what the author meant.
    for (const candidate of [moduleName, `${base}.tsx`, `${base}.ts`]) {
      if (fs.existsSync(path.resolve(from, candidate))) {
        return context.resolveRequest(context, candidate, platform);
      }
    }
  }
  return (defaultResolve ?? context.resolveRequest)(context, moduleName, platform);
};
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
