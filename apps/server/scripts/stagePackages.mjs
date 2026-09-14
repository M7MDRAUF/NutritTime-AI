/**
 * Stage the three workspace packages INSIDE the server's own build output, so that
 * `node apps/server/dist/index.js` resolves `@nutritime/*` to compiled JavaScript (R-69).
 *
 * **The defect.** `dist/*.js` imports `@nutritime/contracts`, `@nutritime/domain` and
 * `@nutritime/catalog` as bare specifiers. Node resolves those by walking `node_modules`
 * upward from the importing file, reaches the workspace symlink in the root `node_modules`,
 * reads `main: src/index.ts` — and dies on `./core.js`, which exists only as `core.ts`. The
 * build compiled; the artefact had never run.
 *
 * **Why staging rather than repointing `main`.** `main: src/index.ts` is what five other
 * consumers read, and all five must keep reading source: the seven `tsc` projects, Vitest,
 * Metro (`build:web`), `tsx watch` (`dev:server`), and the `tsx` subprocess that
 * `boot.integration.test.ts` spawns. `tsx` and production `node` are the same resolver with
 * the same export conditions, so no `main`, `module` or `exports` field can send one to
 * `dist` and the other to `src`. `apps/server/dist/node_modules/` is the one resolution
 * scope only the artefact sees: it is the first directory Node checks from `dist/*.js`, and
 * it is invisible to every other tool.
 *
 * **No dependency**, for the reason `e2e/serveExport.mjs` gives: TSD §2.1 pins the toolchain
 * and `fs.cpSync` is enough. Failures `throw` rather than calling `process.exit`, which keeps
 * this file free of Node globals and therefore free of an `eslint.config.mjs` exemption.
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverRoot, '..', '..');
const stageRoot = join(serverRoot, 'dist', 'node_modules', '@nutritime');

/**
 * `extras` are files the compiled entry point reaches OUTSIDE its own `dist`.
 *
 * `packages/catalog/src/index.ts` imports `'../meals.json'`; from `dist/index.js` that is the
 * package root, so the data file has to travel with the code or the artefact boots with no
 * catalog at all. Listed explicitly rather than globbed: an unexamined extra file in a
 * production artefact is the failure `apps/server/tsconfig.build.json` already documents.
 */
const PACKAGES = [
  { name: 'contracts', extras: [] },
  { name: 'domain', extras: [] },
  { name: 'catalog', extras: ['meals.json'] },
];

rmSync(join(serverRoot, 'dist', 'node_modules'), { recursive: true, force: true });

for (const { name, extras } of PACKAGES) {
  const packageRoot = join(repoRoot, 'packages', name);
  const built = join(packageRoot, 'dist');
  if (!existsSync(built)) {
    throw new Error(
      `No build output at ${built}. Run: npm run build:packages (build:server does this first).`,
    );
  }
  const staged = join(stageRoot, name);
  mkdirSync(staged, { recursive: true });
  cpSync(built, join(staged, 'dist'), { recursive: true });
  for (const extra of extras) {
    cpSync(join(packageRoot, extra), join(staged, extra));
  }
  // A MINIMAL manifest, not a copy of the real one: the published shape must not carry
  // `devDependencies`, scripts or a `types` field into an artefact that must not need them.
  writeFileSync(
    join(staged, 'package.json'),
    `${JSON.stringify(
      {
        name: `@nutritime/${name}`,
        version: '0.1.0',
        private: true,
        type: 'module',
        main: './dist/index.js',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
