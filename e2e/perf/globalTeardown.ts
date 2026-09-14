/**
 * Stop whatever `globalSetup` started — and nothing it did not.
 *
 * A separate file because Playwright takes `globalSetup` and `globalTeardown` as two paths, each
 * exporting one function; the handles live in `serverHarness.ts`, which both import.
 */

import { stopMeasurementServers } from './serverHarness.js';

export default async function globalTeardown(): Promise<void> {
  await stopMeasurementServers();
}
