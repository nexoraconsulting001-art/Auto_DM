import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHELL = '<!doctype html><title>Bhava for Business</title><div id="root"></div>';

/** A stand-in for console/dist, so tests about serving the console don't need a build. */
export function standInBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-console-port-'));
  fs.writeFileSync(path.join(dir, 'index.html'), SHELL);
  return dir;
}

export const removeBuild = (dir) => fs.rmSync(dir, { recursive: true, force: true });
