import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSimulatorsAllowed, isLoopbackHost, isLoopbackUrl, isSimulatorUrl, refuseSimulatorUrl } from '../../../tools/sim/guard.mjs';
import { createSim } from '../../../tools/sim/base.mjs';
import { startAll } from '../../../tools/sim/index.mjs';

const ENTRY = fileURLToPath(new URL('../../../tools/sim/index.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(ENTRY), '..', '..');
const PRODUCTION = { NODE_ENV: 'production' };

test('every spelling of this machine counts as a simulator URL', () => {
  for (const url of [
    'http://127.0.0.1:9101',
    'http://127.0.0.1:9101/v23.0',
    'http://127.5.6.7/',
    'http://localhost:9101',
    'https://localhost/',
    'http://LOCALHOST:9101',
    'http://shop.localhost:3000/',
    'http://[::1]:9101/',
    'http://[::ffff:127.0.0.1]:9101/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://127.1/',
    'http://0.0.0.0:9101/',
    'http://[::]:9101/',
    'http://localhost./',
    '127.0.0.1:9101',
    'localhost:9101',
    'https://sim.example/__sim/calls',
  ]) {
    assert.equal(isSimulatorUrl(url), true, url);
  }
});

test('real services are not simulator URLs', () => {
  for (const url of ['https://graph.instagram.com', 'https://api.razorpay.com/v1/orders', 'https://localhost.example/', 'https://127.0.0.1.nip.example/', 'https://my__sim.example/__simulate', '']) {
    assert.equal(isSimulatorUrl(url), false, url);
  }
});

test('in production a simulator URL is refused and a real one passes through', () => {
  assert.throws(() => refuseSimulatorUrl('http://127.0.0.1:9101', { env: PRODUCTION, name: 'GRAPH_BASE_URL' }), (err) => {
    assert.equal(err.name, 'SimulatorRefusedError');
    assert.equal(err.code, 'ESIMREFUSED');
    assert.match(err.message, /GRAPH_BASE_URL/);
    assert.doesNotMatch(err.message, /127\.0\.0\.1/);
    return true;
  });
  assert.equal(refuseSimulatorUrl('https://graph.instagram.com', { env: PRODUCTION }), 'https://graph.instagram.com');
  assert.equal(refuseSimulatorUrl('', { env: PRODUCTION }), '', 'empty means the real service');
  assert.throws(() => refuseSimulatorUrl('http://localhost:1', { env: { NODE_ENV: ' Production ' } }), /refused/);
});

test('outside production a simulator URL is allowed', () => {
  for (const env of [{}, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
    assert.equal(refuseSimulatorUrl('http://127.0.0.1:9101', { env }), 'http://127.0.0.1:9101');
  }
});

test('the guard reads process.env by default', (t) => {
  const before = process.env.NODE_ENV;
  t.after(() => {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  });
  process.env.NODE_ENV = 'production';
  assert.throws(() => refuseSimulatorUrl('http://127.0.0.1:1'), /refused/);
  assert.throws(() => assertSimulatorsAllowed(), /do not run/);
  process.env.NODE_ENV = 'test';
  assert.doesNotThrow(() => assertSimulatorsAllowed());
});

test('isLoopbackHost and isLoopbackUrl', () => {
  for (const host of ['127.0.0.1', '127.255.255.254', 'localhost', 'a.localhost', '[::1]', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ['10.0.0.1', '8.8.8.8', 'example.com', 'localhost.com', '', '0.0.0.0', '::']) assert.equal(isLoopbackHost(host), false, host);
  assert.equal(isLoopbackUrl('http://127.0.0.1:3000/webhook'), true);
  assert.equal(isLoopbackUrl('https://shop.localhost/x'), true);
  assert.equal(isLoopbackUrl('ftp://127.0.0.1/'), false);
  assert.equal(isLoopbackUrl('https://example.com/'), false);
  assert.equal(isLoopbackUrl('not a url at all'), false);
});

test('a simulator refuses to start in production', async () => {
  const sim = createSim({ name: 'x', routes: () => {} });
  await assert.rejects(() => sim.start({ env: PRODUCTION }), /do not run/);
  assert.equal(sim.url, null);
});

test('startAll refuses in production and starts nothing', async () => {
  await assert.rejects(() => startAll({ basePort: 0, env: PRODUCTION }), /do not run/);
});

test('the command exits non-zero in production without opening a port', async () => {
  const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'production', SIM_BASE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(err, /do not run/);
  assert.doesNotMatch(out, /127\.0\.0\.1/);
});
