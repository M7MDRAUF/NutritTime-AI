/**
 * Starts the API and the Expo dev server together, and stops them together.
 *
 * **Why this file exists.** `SDD.md` §2.3 documents the local procedure as four commands ending in
 * `npm run dev  # starts the API and the Expo dev server`, and the script behind it was
 * `npm run dev:server & npm run dev:mobile`. On a POSIX shell that backgrounds the first job; on
 * **Windows `cmd.exe`, `&` is a SEQUENTIAL separator**, so the Expo server never started until the
 * watcher exited — which it never does. Measured at P26: the two ran strictly in order, 2598 ms
 * apart. So the documented one-command procedure was unmet **on this project's own platform**, and
 * `docs/RUNBOOK.md` would have inherited the same false instruction.
 *
 * A document outranks the code (Plan §4: PRD > SDD > TSD > Plan), so the script is the defect and
 * this is the fix — not an edit to §2.3.
 *
 * **No dependency, on purpose.** `concurrently` and `npm-run-all` both exist to do exactly this,
 * and TSD §2.1 pins the toolchain: adding a package so that two `npm run`s can start at once is not
 * a trade this project makes, and a new dependency is a stop condition rather than a judgement call.
 * `e2e/serveExport.mjs` set this precedent for the same reason — Node's own modules are enough.
 *
 * **What it deliberately does NOT do.** No log prefixing, no colours, no restart-on-crash, no
 * ready-detection. Both children inherit this process's stdio, so their output is exactly what
 * running the two commands in two terminals gives you, interleaved. Anything cleverer would be a
 * process supervisor, and a supervisor nobody asked for is a thing that breaks in the dark.
 */

import { spawn } from 'node:child_process';

/**
 * `shell: true` is required and is not a smell here: `npm` on Windows is `npm.cmd`, which
 * `spawn` cannot execute directly. The arguments are literals in this file — nothing user-supplied
 * reaches the shell — so the usual injection objection does not apply.
 */
const COMMANDS = [
  { name: 'server', args: ['run', 'dev:server'] },
  { name: 'mobile', args: ['run', 'dev:mobile'] },
];

const children = [];
let shuttingDown = false;

/**
 * **One exiting stops the other.** Without this, a crashed API leaves Expo running and the next
 * `npm run dev` fails on a port already in use — the failure mode reads as "the fix broke the dev
 * server" when it is a leftover from the previous run. Killing the siblings is what makes the
 * combined command behave like one command.
 */
function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] ${reason}; stopping the other process.`);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  process.exitCode = code;
}

for (const { name, args } of COMMANDS) {
  const child = spawn('npm', args, { stdio: 'inherit', shell: true });
  children.push(child);

  child.on('exit', (code, signal) => {
    if (signal !== null) {
      shutdown(`${name} was stopped by ${signal}`, 0);
      return;
    }
    shutdown(`${name} exited with code ${code}`, code ?? 1);
  });

  child.on('error', (error) => {
    // The message is Node's own spawn error (ENOENT and friends), not an upstream service string,
    // so printing it is safe and is the only way a missing `npm` is diagnosable. PRD §12's
    // fixed-local-copy rule governs what a USER sees in the app; this is a developer's terminal.
    console.error(`[dev] could not start ${name}: ${error.message}`);
    shutdown(`${name} failed to start`, 1);
  });
}

// Ctrl+C reaches the children too, because they share this terminal's process group — but the
// handler still runs so that the second child is killed when only the first noticed.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}
