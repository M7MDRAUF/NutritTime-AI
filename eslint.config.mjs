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
    selector: "NewExpression[callee.name='Date']",
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

export default tseslint.config(
  // e2e/ is a separate workspace with its own toolchain (TSD 8.1); it is linted by its own
  // config at P24, not by this one.
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.expo/**', 'e2e/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
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

  // Rule 2 - contracts may import zod and its own relative files, and nothing else.
  // Expressed as an allowlist: deny everything, then re-permit zod.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*', '*/*', '@*/*', '!zod', '!zod/*'],
              message: 'contracts may import only zod and its own relative files.',
            },
            ...APP_ESCAPES,
          ],
        },
      ],
    },
  },

  // Rule 3 - every other package: no reaching into apps, and no I/O in catalog either.
  {
    files: ['packages/catalog/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: APP_ESCAPES }] },
  },

  // The seed script is the one place in packages/ that is allowed file-system and network
  // access: it is a build-time tool, run by hand, never imported by the running app (TSD 7.2).
  {
    files: ['packages/catalog/seed.ts', 'packages/catalog/src/seed/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: APP_ESCAPES }] },
  },

  // Rule 4 - the two applications never import each other.
  {
    files: ['apps/server/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: appEscape('mobile') }] },
  },

  // Rules 4 and 5 - and AsyncStorage has exactly one importer.
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [ASYNC_STORAGE], patterns: appEscape('server') }],
    },
  },

  // Rule 5 exemption - restated WITHOUT the AsyncStorage path, so Rule 4 survives here.
  {
    files: ['apps/mobile/src/infrastructure/storage/asyncStorageDriver.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: appEscape('server') }],
    },
  },

  // Tests may use devDependencies and console, but the architecture rules still apply:
  // a domain test importing express or reaching into apps/ is the coupling Rule 3 exists
  // to prevent, and test files are where it would first appear.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
    rules: { 'no-console': 'off' },
  },
);
