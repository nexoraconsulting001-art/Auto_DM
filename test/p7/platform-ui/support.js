// Shared by the Platform Console web app's tests: a build of the console into a folder of its own (never console/dist-platform,
// which a person may be looking at), and the source files it is made of.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SRC = path.join(ROOT, 'console', 'src', 'platform');

/** Every file under `dir` that matches `pattern`, as absolute paths. */
export function filesUnder(dir, pattern = /\.(jsx?|css)$/) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full, pattern));
    else if (pattern.test(entry.name)) found.push(full);
  }
  return found;
}

export const read = (file) => fs.readFileSync(file, 'utf8');

/** Builds the Platform Console into a fresh temporary folder and answers its path. */
export function buildConsole() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-platform-ui-'));
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [vite, 'build', '--config', 'vite.platform.config.js', '--outDir', outDir, '--emptyOutDir'], { cwd: path.join(ROOT, 'console'), stdio: 'pipe', timeout: 240_000 });
  return outDir;
}

/** The text of every file of a build, by relative path. */
export function bundleText(dir) {
  const out = {};
  for (const file of filesUnder(dir, /\.(html|js|css|svg|json)$/)) out[path.relative(dir, file).replaceAll('\\', '/')] = read(file);
  return out;
}
