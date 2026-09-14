/**
 * Start the two servers the P25 browser measurements need. See `serverHarness.ts`'s note on why
 * this replaces Playwright's `webServer` for this lane: the npm chain the suite uses survives the
 * kill at the end of a run on Windows, and a port this lane holds is a failure another agent
 * cannot diagnose.
 */

import { startMeasurementServers } from './serverHarness.js';

/** TSD §5.1's port, and an origin the server's CORS allowlist already trusts (TSD §5.3). */
const API_PORT = 4000;
const WEB_PORT = 19_006;

export default async function globalSetup(): Promise<void> {
  await startMeasurementServers(API_PORT, WEB_PORT);
}
