/**
 * A static file server for the Expo web export, in Node's own http module.
 *
 * **No dependency, on purpose.** `serve`, `http-server` and `vite preview` would all do this, and
 * TSD §2.1 pins the toolchain — adding a package so that a test can read files off a disk is not a
 * trade this project makes. `expo export --platform web` writes a plain static tree, so seventy
 * lines of `createServer` is the whole requirement.
 *
 * Started by Playwright's `webServer`, never by hand.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'apps', 'mobile', 'dist');
const PORT = Number(process.env.WEB_PORT ?? '4173');

const TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }),
);

if (!existsSync(ROOT)) {
  // Loud and immediate. A server that answers 404 for everything would make every spec fail with
  // "element not found", which sends the reader looking at the app instead of at the missing build.
  console.error(
    `No web export at ${ROOT}.\nRun: npm run build:web   (from the repository root, before the e2e suite)`,
  );
  process.exit(1);
}

/** Reject any path that escapes the export directory before it reaches the file system. */
function resolveWithin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null;
  }
  return candidate;
}

createServer((request, response) => {
  const target = resolveWithin(ROOT, request.url ?? '/');
  if (target === null) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  // A directory, or a path with no extension, is a route rather than a file. `output: "static"`
  // writes one HTML file per route, so try `<path>.html` and `<path>/index.html` before falling
  // back — otherwise a deep link like /explore would 404 and the linking spec could not run.
  const candidates =
    extname(target) === ''
      ? [join(target, 'index.html'), `${target}.html`, join(ROOT, 'index.html')]
      : [target];

  const found = candidates.find((one) => existsSync(one) && statSync(one).isFile());
  if (found === undefined) {
    response.writeHead(404).end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': TYPES.get(extname(found)) ?? 'application/octet-stream',
    // No caching: a spec must never read the previous build's bundle.
    'Cache-Control': 'no-store',
  });
  createReadStream(found).pipe(response);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`web export on http://127.0.0.1:${String(PORT)} from ${ROOT}`);
});
