import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Import-boundary rules from Plan.md 12.2.
 *
 * Rules 1-5 are enforced here. Rule 6 (no cyclic imports) is NOT enforced: every mechanism
 * (eslint-plugin-import, madge, dpdm) is a dependency TSD 2.1 does not pin, and SDD 16
 * declines a cycle checker outright. Plan.md X-10 assumed an import rule could do it inside
 * the existing config without a new dependency; that assumption was wrong. X-10 is corrected
 * in Plan.md rather than re-decided here.
 *
 * Flat config REPLACES a rule when a later block names it for the same files - it does not
 * merge. So every file group gets one complete no-restricted-imports entry, and an exemption
 * is expressed by restating the rule without the exempted clause, never by 'off'. Using 'off'
 * silently dropped Rule 4 for the storage driver and Rules 1 and 3 for every test file.
 */

/** I/O packages, by exact name and by subpath. Bare and node:-prefixed forms both counted. */
const IO_PATHS = [
  { name: 'express', message: 'Pure code: no HTTP framework.' },
  { name: 'cors', message: 'Pure code: no HTTP framework.' },
  { name: 'react', message: 'Pure code: no UI.' },
  { name: 'react-dom', message: 'Pure code: no UI.' },
  { name: 'react-native', message: 'Pure code: no UI.' },
  { name: 'react-native-web', message: 'Pure code: no UI.' },
  { name: 'ollama', message: 'Pure code: no model client.' },
];

const IO_PATTERNS = [
  {
    group: ['node:*', 'node:*/*'],
    message: 'Pure code: no Node built-ins (no file system, network, process or crypto).',
  },
  {
    group: [
      'fs',
      'fs/*',
      'http',
      'https',
      'net',
      'dns',
      'os',
      'crypto',
      'child_process',
      'worker_threads',
      'stream',
      'stream/*',
    ],
    message: 'Pure code: no Node built-ins.',
  },
  {
    group: ['react-dom/*', 'react-native/*', 'ollama/*', '@react-native-async-storage/*'],
    message: 'Pure code: no UI, storage or model client.',
  },
];

/** A package reaching sideways into an application, by any spelling. */
const APP_ESCAPES = [
  {
    group: ['**/apps/**', '../../apps/**', '../../../apps/**', '../../../../apps/**'],
    message: 'packages must not import from apps.',
  },
];

/** One application reaching into the other. */
const appEscape = (target) => [
  {
    // Any specifier with the other app as a path segment, at any relative depth.
    // Enumerating depths missed the five-level case the P01 probe exercised.
    group: [`**/${target}/**`, `**/apps/${target}/**`],
    message: 'apps must not import each other. Share through packages/.',
  },
];

const ASYNC_STORAGE = {
  name: '@react-native-async-storage/async-storage',
  message: 'Only infrastructure/storage/asyncStorageDriver.ts may import AsyncStorage.',
};

/** Rule 1's "no clock" - covers the constructor, not only Date.now. */
const NO_CLOCK = [
  {
    // Only the zero-argument form reads a clock. `new Date(2026, 0, 1)` is a fixed
    // instant, which a test legitimately constructs to pass in as a parameter.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'The domain is pure: no clock. Take the time as a parameter.',
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'The domain is pure: no clock. Take the time as a parameter.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message: 'The domain is pure: no clock.',
  },
];

/**
 * `primitive.ts` is private to the theme directory (TSD §6.6).
 *
 * Broad on purpose: `**\/theme/primitive.js` does NOT match the real specifier
 * `../shared/theme/primitive.js`, because the leading `..` defeats it.
 */
const PRIMITIVE_PRIVATE = {
  group: ['**primitive.js', '**primitive'],
  message:
    'primitive.ts is private to the theme directory (TSD §6.6): import a semantic or component token.',
};

export default tseslint.config(
  // **`e2e/` is linted here, and it was excluded on a promise nothing kept.** This block used to
  // ignore `e2e/**` "because it is linted by its own config at P24" — that config does not exist,
  // `npm run typecheck` omitted the project too, and so `npm run check` (TSD 2.4's "single gate")
  // checked **none** of the specs that assert what a user actually sees. Found by a cross-phase
  // audit. The exclusion cost nothing to remove: this config is not type-aware, so e2e needs no
  // tsconfig wiring, and `typecheck` now carries `-p e2e` alongside the six workspace projects.
  //
  // Nested globs, not top-level ones. `dist/**` matches only a `dist` at the repository root,
  // so `apps/server/dist` - which `npm run build:server` writes - was being linted as source
  // and reported `process is not defined` in compiled output. Latent since P01; it could not
  // fire until a nested build directory existed.
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/web-build/**',
      'e2e/playwright-report/**',
      'e2e/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // An underscore-prefixed parameter is deliberately unused. Express identifies an error
      // handler by ARITY, so its fourth parameter must stay declared even though nothing reads
      // it; `after-used` reports exactly that case and nothing else would satisfy it.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Rule 1 - the domain is pure. Rule 3 folded in.
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...IO_PATHS, ASYNC_STORAGE], patterns: [...IO_PATTERNS, ...APP_ESCAPES] },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The domain is pure: no I/O.' },
        { name: 'XMLHttpRequest', message: 'The domain is pure: no I/O.' },
      ],
      'no-restricted-syntax': ['error', ...NO_CLOCK],
    },
  },

  // Rule 2 - contracts carries no I/O. The other half of the rule - that zod is its ONLY
  // third-party runtime dependency - is not expressible in no-restricted-imports without a
  // plugin (a deny-all-then-allow pattern also swallows relative imports). It is asserted
  // directly against package.json in contracts/src/package.test.ts, which is a stronger
  // check than a lint pattern: it reads the actual manifest.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...IO_PATHS, ASYNC_STORAGE], patterns: [...IO_PATTERNS, ...APP_ESCAPES] },
      ],
    },
  },

  // Contracts tests may read the manifest from disk. Restated without the Node-builtin
  // ban rather than switched off, so the I/O-package and app-escape rules both survive.
  {
    files: ['packages/contracts/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...IO_PATHS, ASYNC_STORAGE], patterns: APP_ESCAPES },
      ],
    },
  },

  // Rule 3 - every other package: no reaching into apps, and no I/O in catalog either.
  {
    files: ['packages/catalog/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: APP_ESCAPES }] },
  },

  // Rule 4 - the two applications never import each other.
  {
    files: ['apps/server/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: appEscape('mobile') }] },
  },

  // Rule 5 - `process.env` is read in `config.ts` and nowhere else.
  //
  // **This closes T-19-06, whose acceptance was "constants, not env-configurable" and whose
  // evidence column says "Source review".** The review passed and the values are pinned by a
  // `toStrictEqual` in `config.test.ts` - and neither caught the mutation an auditor found:
  // `numCtx: Number(process.env['NUM_CTX'] ?? 4096)` ships GREEN, because with the variable
  // unset it still yields 4096. A value assertion cannot see a value that is merely
  // *overridable*, so the guard has to be on the access rather than on the number.
  //
  // It also makes structural a property the whole server already leaned on by convention
  // (`config.ts`'s own docstring: "read in this file and nowhere else"). A second reader means
  // two places can disagree about what the server is configured to do, and the disagreement
  // shows up as behaviour no test reproduces because the test set only one of them.
  //
  // Tests are exempt: `boot.integration.test.ts` must spread an ambient environment into a child
  // process to be a realistic boot, and `grammar.integration.test.ts` reads `RUN_MODEL_TESTS` to
  // decide whether to run at all. Both are registered readers with their reasons in the files.
  //
  // A SEPARATE block, and only `no-restricted-properties` in it, because ESLint flat config
  // REPLACES rather than merges a rule across overlapping globs - this project has been bitten
  // three times. Setting a different rule name here leaves rule 4's `no-restricted-imports`
  // intact for the same glob, and `--print-config` is the only evidence that counts for that.
  {
    files: ['apps/server/src/**/*.ts'],
    ignores: ['apps/server/src/config.ts', 'apps/server/src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read the environment only in apps/server/src/config.ts. Every other module takes the parsed ServerConfig as a parameter (TSD 5.2).',
        },
      ],
    },
  },

  // Expo's Metro and Babel configs MUST be CommonJS: Metro loads `metro.config.js` with
  // `require` and Babel does the same for its own. They are build configuration, not app code,
  // and nothing in the bundle imports them - so `require`, `module` and `__dirname` are
  // declared here rather than the files being rewritten into a module format their loaders do
  // not accept.
  {
    files: ['apps/mobile/metro.config.js', 'apps/mobile/babel.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Rules 4 and 5, plus the privacy of `primitive.ts`.
  //
  // **All three live in ONE rule entry, and that is not tidiness.** Flat config REPLACES
  // `no-restricted-imports` for an overlapping glob rather than merging it, so a separate
  // `apps/mobile/src/**` block declaring the primitive pattern was silently discarded by this
  // one - `eslint --print-config` showed the pattern simply absent. P01 learned this from the
  // import-boundary rules; it cost a probe to notice again here.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [ASYNC_STORAGE], patterns: [...appEscape('server'), PRIMITIVE_PRIVATE] },
      ],
    },
  },

  // The theme directory itself may import it - that is the whole point of the directory. The
  // rule is RESTATED minus the primitive pattern rather than switched off, so Rules 4 and 5
  // survive here. An `'off'` exemption would drop all three.
  {
    files: ['apps/mobile/src/shared/theme/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [ASYNC_STORAGE], patterns: appEscape('server') }],
    },
  },

  // Rule 5 exemption - restated WITHOUT the AsyncStorage path, so Rule 4 survives here.
  {
    files: ['apps/mobile/src/infrastructure/storage/asyncStorageDriver.ts'],
    rules: {
      // Rule 5 exemption - restated WITHOUT the AsyncStorage path, so Rule 4 survives here.
      //
      // **`PRIMITIVE_PRIVATE` is restated too, and its absence was the flat-config trap for the
      // THIRD time in this project.** An overlapping glob REPLACES `no-restricted-imports` rather
      // than merging it, so listing only `appEscape('server')` here silently dropped the
      // primitive-privacy pattern for this file — the exact failure the block two entries above
      // documents in bold, and which P01 and P11 each paid for once. Confirmed by
      // `eslint --print-config`, which is the only evidence that counts for this rule.
      'no-restricted-imports': ['error', { patterns: [...appEscape('server'), PRIMITIVE_PRIVATE] }],
    },
  },

  // Tests may use devDependencies and console, but the architecture rules still apply:
  // a domain test importing express or reaching into apps/ is the coupling Rule 3 exists
  // to prevent, and test files are where it would first appear.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: { 'no-console': 'off' },
  },

  // `e2e/serveExport.mjs` is a Node script, not app code: a dependency-free static server that
  // Playwright starts to serve the web export. It is the only file in `e2e/` that needed anything
  // — the six specs lint clean under the shared rules, which is why bringing the workspace into
  // this config cost five lines rather than a second config.
  //
  // Node globals are declared rather than assumed, and `console.log` is allowed by RESTATING the
  // rule without that one clause. `'off'` would drop `console.debug` and `console.trace` with it,
  // which is the mistake P01 recorded and this file has now avoided four times.
  // `scripts/dev.mjs` is the same shape as `e2e/serveExport.mjs` below and is here for the same
  // reason: a hand-run Node tool at the repository root, outside every tsconfig `include`, whose
  // entire interface is its console output. It exists because `npm run dev`'s `&` is SEQUENTIAL
  // under Windows `cmd.exe`, so SDD §2.3's documented one-command procedure did not hold on this
  // project's own platform (measured at P26: 2598 ms, strictly ordered).
  //
  // `no-console` is RESTATED minus the allowed methods rather than switched off — the fifth time
  // this file has done that deliberately, because P01 learned that `'off'` silently drops
  // `console.debug` and `console.trace` along with the clause you meant to relax.
  {
    files: ['**/scripts/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
    },
  },

  {
    files: ['e2e/serveExport.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
    },
  },

  // The seed script is a hand-run command-line tool whose entire user interface is its
  // console output: what it fetched, what did not resolve, what it wrote. It never runs at
  // boot or in a request.
  //
  // The rule is RESTATED minus `log` rather than switched off, because P01 learned that an
  // `'off'` exemption silently drops the whole rule for these files - `console.debug` and
  // `console.trace` would come back with it.
  {
    files: ['packages/catalog/seed.ts'],
    rules: { 'no-console': ['error', { allow: ['log', 'warn', 'error'] }] },
  },
);
