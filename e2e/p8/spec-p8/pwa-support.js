// Shared by the Phase 8 browser tests of the seller console as a web app (Q-12): a console build made fresh from the current
// sources into a folder of its own (so a service worker file added later is in it), then the Phase 5 console world on top of it.
// Nothing here leaves this machine: the dead proxy of playwright.config.mjs swallows every address but loopback.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');

function newest(dir) {
  let at = 0;
  if (!fs.existsSync(dir)) return String(at);
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) at = Math.max(at, fs.statSync(path.join(e.parentPath, e.name)).mtimeMs);
  return String(at);
}

/** A build of the seller console of the current sources, made once and shared by every worker. */
export function buildSellerConsole() {
  const key = crypto.createHash('sha1').update(`${newest(path.join(root, 'console/src'))}|${newest(path.join(root, 'console/public'))}|${root}`).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), `bhava-p8-console-${key}`);
  if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const tmp = `${dir}-${process.pid}`;
  execFileSync(process.execPath, [vite, 'build', '--outDir', tmp, '--emptyOutDir'], { cwd: path.join(root, 'console'), stdio: 'pipe', timeout: 300_000 });
  try {
    fs.renameSync(tmp, dir);
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }); // another worker got there first
  }
  return dir;
}

export const consoleDir = buildSellerConsole();
process.env.CONSOLE_DIR = consoleDir;
export const hasWorker = fs.existsSync(path.join(consoleDir, 'sw.js'));

/** Everything the page's caches hold: [{ cache, url, type, body }] (bodies of text answers only). */
export const dumpCaches = (page) => page.evaluate(async () => {
  const out = [];
  for (const name of await caches.keys()) {
    const cache = await caches.open(name);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const type = response?.headers.get('content-type') ?? '';
      out.push({ cache: name, url: request.url, type, body: /text|json|javascript|xml|svg/i.test(type) ? await response.clone().text() : '' });
    }
  }
  return out;
});
