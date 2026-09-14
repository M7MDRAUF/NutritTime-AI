import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Load `.env` into `process.env` before any project starts.
 *
 * Without this the file is decorative: `USDA_DATASET_PATH` is documented in `.env`, read by
 * the seed script, and never actually set for a test run. Hand-rolled rather than pulled from
 * `dotenv`, because TSD 2.1 pins the toolchain and a config convenience is not worth a
 * dependency. An already-set variable wins, so a real environment always beats the file.
 */
function loadDotEnv(): void {
  const file = path.resolve(import.meta.dirname, '.env');
  if (!fs.existsSync(file)) {
    return;
  }
  // Split on the newline character itself and strip any carriage return, rather than a
  // regex: a CRLF file must parse the same as an LF one.
  for (const raw of fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
    // No regex: eslint no-control-regex rejects a literal CR, and a plain endsWith says
    // what is meant more directly anyway.
    const line = raw.endsWith(String.fromCharCode(13)) ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const split = trimmed.indexOf('=');
    if (split <= 0) {
      continue;
    }
    const key = trimmed.slice(0, split).trim();
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(split + 1).trim();
    }
  }
}

loadDotEnv();

/**
 * Three projects, per TSD 8.1. E2E is Playwright and is deliberately not a Vitest project.
 *
 * The react-native package ships Flow-typed source esbuild cannot strip, so anything importing
 * it is untestable under Vitest in node. The `dom` project aliases react-native to
 * react-native-web - plain compiled JS - and runs under jsdom. Vitest externalises
 * node_modules, so an externalised package's own `import 'react-native'` would bypass the
 * alias; the `inline` list below makes the alias apply transitively.
 *
 * passWithNoTests is deliberately NOT set. P01 has no tests yet and runs its gate with the
 * --passWithNoTests CLI flag instead, so the exemption applies to that one run rather than
 * standing for every phase from P02 to P27, where a mis-scoped include glob would report
 * "no tests" and pass green.
 *
 * `setupFiles` for the dom project arrived at P12, as reserved: `vitest.setup.dom.mts` sets
 * `IS_REACT_ACT_ENVIRONMENT`, without which every `act()` call warns on stderr while the test
 * still passes.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.dom.test.*', '**/*.integration.test.*'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', 'e2e/**'],
        },
      },
      {
        resolve: {
          alias: {
            'react-native': path.resolve(import.meta.dirname, 'node_modules/react-native-web'),
            // `@expo/vector-icons` publishes JSX inside a `.js` file
            // (`build/createIconSet.js:79` is `return <Text />`), and rolldown refuses to parse
            // it - "Unexpected JSX expression" - which failed twelve of sixteen dom suites at the
            // import. Widening the transform with `esbuild.include` + `loader: 'jsx'` does not
            // reach rolldown's parser, so the module is aliased to a double for this project only.
            // The app imports the real component; what the double costs and what it preserves is
            // written out in the file itself.
            '@expo/vector-icons/MaterialCommunityIcons': path.resolve(
              import.meta.dirname,
              'apps/mobile/src/shared/components/__testing__/iconSet.tsx',
            ),
          },
        },
        test: {
          name: 'dom',
          setupFiles: ['./vitest.setup.dom.mts'],
          environment: 'jsdom',
          server: {
            deps: {
              inline: [
                /@react-navigation\//,
                /react-native-screens/,
                /react-native-safe-area-context/,
                /react-native-gesture-handler/,
              ],
            },
          },
          include: ['apps/mobile/src/**/*.dom.test.{ts,tsx}'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.*', '**/__tests__/**', '**/index.ts', '**/*.d.ts'],
    },
  },
});
