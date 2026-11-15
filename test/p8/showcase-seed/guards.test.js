import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs, seedShowcase, ShowcaseError } from '../../../scripts/showcase.js';
import { PROVIDER_ENV, ShowcaseRefusedError, assertShowcaseAllowed } from '../../../tools/sim/activity/world.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const node = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }, timeout: 60_000 });

test('Q-01 the showcase refuses to run when NODE_ENV is production, whatever else is set', () => {
  assert.throws(() => assertShowcaseAllowed({ NODE_ENV: 'production' }), ShowcaseRefusedError);
  assert.throws(() => assertShowcaseAllowed({ NODE_ENV: ' Production ' }), /never runs when NODE_ENV is production/);
  assert.doesNotThrow(() => assertShowcaseAllowed({ NODE_ENV: 'test' }));
  assert.doesNotThrow(() => assertShowcaseAllowed({}));
});

test('Q-01 the showcase refuses a real provider address, for every provider the app can be pointed at', () => {
  assert.ok(PROVIDER_ENV.includes('GRAPH_BASE_URL') && PROVIDER_ENV.includes('RAZORPAY_BASE_URL') && PROVIDER_ENV.includes('SHIPROCKET_BASE_URL') && PROVIDER_ENV.includes('WHATSAPP_BASE_URL'));
  for (const name of PROVIDER_ENV) {
    const real = name.endsWith('_HOSTS') ? 'api.example-mail.com' : 'https://provider.example.com';
    assert.throws(() => assertShowcaseAllowed({ [name]: real }), (err) => err instanceof ShowcaseRefusedError && err.message.startsWith(name), name);
    assert.doesNotThrow(() => assertShowcaseAllowed({ [name]: name.endsWith('_HOSTS') ? '127.0.0.1' : 'http://127.0.0.1:9101' }), `${name} on this machine is a simulator`);
  }
  assert.throws(() => assertShowcaseAllowed({ GRAPH_BASE_URL: 'https://graph.instagram.com' }), /real provider address/);
});

test('Q-01 the showcase refuses a live payment key and a database that is not on this machine', () => { // secret-scan:allow
  assert.throws(() => assertShowcaseAllowed({ RAZORPAY_KEY_ID: 'rzp_live_AbCdEf123456' }), /live key/); // secret-scan:allow
  assert.doesNotThrow(() => assertShowcaseAllowed({ RAZORPAY_KEY_ID: 'rzp_test_AbCdEf123456' })); // secret-scan:allow
  assert.throws(() => assertShowcaseAllowed({ DATABASE_URL: 'postgres://u:p@db.internal.example.com:5432/bhava' }), /not on this machine/);
  assert.doesNotThrow(() => assertShowcaseAllowed({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/bhava' }));
  assert.throws(() => assertShowcaseAllowed({ DATABASE_URL: 'not a url' }), ShowcaseRefusedError);
});

test('Q-01 npm run showcase stops before opening anything when the environment is a production one', () => {
  const production = node(['scripts/showcase.js'], { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' });
  assert.equal(production.status, 2, production.stderr);
  assert.match(production.stderr, /never runs when NODE_ENV is production/);
  const real = node(['scripts/showcase.js'], { GRAPH_BASE_URL: 'https://graph.facebook.com', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' });
  assert.equal(real.status, 2, real.stderr);
  assert.match(real.stderr, /GRAPH_BASE_URL names a real provider address/);
  const check = node(['scripts/showcase.js', '--check'], { NODE_ENV: 'production' });
  assert.equal(check.status, 0, 'reading the seed files writes nothing and needs no database, so it is allowed anywhere');
});

test('Q-01 seeding needs a database and businesses to load, and says so', async () => {
  await assert.rejects(seedShowcase({}), (err) => err instanceof ShowcaseError && /database/.test(err.message));
  await assert.rejects(seedShowcase({ db: {}, businesses: [] }), /businesses to load/);
});

test('Q-01 the options of the command are checked', () => {
  assert.deepEqual({ ...parseArgs([], {}), plantSeed: '' }.days, 30);
  assert.equal(parseArgs(['--days', '5', '--seed', '7', '--no-activity', '--only', 'first'], {}).days, 5);
  assert.throws(() => parseArgs(['--days', '91'], {}), /0 to 90/);
  assert.throws(() => parseArgs(['--export-brands'], {}), /needs a value/);
  assert.throws(() => parseArgs(['--production'], {}), /Unknown option/);
});

test('Q-01 no code path of the showcase names a sample business: the policy check passes on every file it owns', () => {
  const result = node(['tools/policy-check.mjs', 'tools/sim/activity', 'scripts/showcase.js', 'test/p8/showcase-seed']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(0, 1500));
});
