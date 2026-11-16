// D-10: the deps stage's guard ("a dev or app package reached the image") runs on what `npm ci --omit=dev` leaves. npm
// leaves an empty scope folder (node_modules/@playwright) behind for an omitted scoped dev package, so a guard that asks only
// whether the path exists failed every image build. The guard must fail on an installed package and pass on an empty scope.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dockerfile = fs.readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');

/** The guard loop of the deps stage, as the shell runs it. */
function guardScript() {
  const deps = dockerfile.slice(dockerfile.indexOf('AS deps'), dockerfile.indexOf('AS runtime'));
  const run = deps.slice(deps.indexOf('RUN npm ci'));
  const loop = run.slice(run.indexOf('for p in'));
  const script = loop.slice(0, loop.lastIndexOf('done') + 4).replace(/\\\n/g, '\n');
  assert.match(script, /react-native expo @expo vite jest playwright @playwright eslint typescript/, 'the guard still names every refused package');
  return script;
}

function runGuard(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-guard-'));
  try {
    for (const entry of layout) {
      const full = path.join(dir, entry);
      if (entry.endsWith('/')) fs.mkdirSync(full, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, '{}');
      }
    }
    execFileSync('sh', ['-c', guardScript()], { cwd: dir, stdio: 'pipe' });
    return 'passed';
  } catch (err) {
    return String(err.stdout ?? '') + String(err.stderr ?? '') || 'failed';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('D-10: an empty scope folder npm leaves behind is not a package in the image', () => {
  assert.equal(runGuard(['node_modules/@playwright/', 'node_modules/@expo/', 'node_modules/express/package.json']), 'passed');
});

test('D-10: an installed dev or app package still fails the build, scoped or not', () => {
  assert.match(runGuard(['node_modules/@playwright/test/package.json']), /reached the image: @playwright/);
  assert.match(runGuard(['node_modules/vite/package.json']), /reached the image: vite/);
  assert.match(runGuard(['node_modules/@expo/vector-icons/package.json']), /reached the image: @expo/);
  assert.match(runGuard(['node_modules/react-native/package.json']), /reached the image: react-native/);
});
