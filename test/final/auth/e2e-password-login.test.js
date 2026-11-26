// The browser tests' apps are test apps: PASSWORD_LOGIN is on in them as it is under node's test runner, so the earlier
// phases' worlds (built on src/config.js) can sign sellers in through the Phase 0 password routes. Before, Playwright's
// workers had no NODE_TEST_CONTEXT, src/config.js left it off, and every such sign-in answered 404 not_found.
// Outside the test runners it stays off unless PASSWORD_LOGIN says otherwise (the production guard refuses it on).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Loads playwright.config.mjs (when `playwright`) and then src/config.js in a fresh process, with no test-runner marker. */
function passwordLoginIn({ playwright, PASSWORD_LOGIN }) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.PASSWORD_LOGIN;
  env.NODE_ENV = 'development';
  if (PASSWORD_LOGIN !== undefined) env.PASSWORD_LOGIN = PASSWORD_LOGIN;
  const script = `${playwright ? "await import('./playwright.config.mjs');" : ''} const { config } = await import('./src/config.js'); process.stdout.write(String(config.passwordLogin));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' }).trim();
}

test('the Playwright config turns PASSWORD_LOGIN on for the apps the browser tests start', () => {
  assert.equal(passwordLoginIn({ playwright: true }), 'true');
});

test('an explicit PASSWORD_LOGIN=0 is kept under Playwright, and nothing else turns it on', () => {
  assert.equal(passwordLoginIn({ playwright: true, PASSWORD_LOGIN: '0' }), 'false');
  assert.equal(passwordLoginIn({ playwright: false }), 'false');
});
