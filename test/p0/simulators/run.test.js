import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_PORT, SERVICES, startAll } from '../../../tools/sim/index.mjs';
import { request } from './support.js';

const ENTRY = fileURLToPath(new URL('../../../tools/sim/index.mjs', import.meta.url));
const ROOT = path.resolve(path.dirname(ENTRY), '..', '..');
const NAMES = ['meta', 'whatsapp', 'razorpay', 'shiprocket', 'shopify', 'google'];

/** A run of consecutive ports with nothing listening on them right now. */
async function freeBasePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const base = 20000 + Math.floor(Math.random() * 30000);
    const servers = [];
    try {
      for (let i = 0; i < NAMES.length; i++) {
        servers.push(await new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(base + i, '127.0.0.1', () => resolve(server));
        }));
      }
      return base;
    } catch {
      continue;
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    }
  }
  throw new Error('No free run of ports.');
}

test('startAll runs one loopback server per service, each with the shared controls', async (t) => {
  const all = await startAll({ basePort: 0, env: { NODE_ENV: 'test' } });
  t.after(all.close);
  assert.deepEqual(SERVICES.map(([name]) => name), NAMES);
  assert.deepEqual(Object.keys(all.urls), NAMES);
  assert.equal(new Set(Object.values(all.urls)).size, NAMES.length, 'each on its own port');
  for (const [name, url] of Object.entries(all.urls)) {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual((await request(`${url}/__sim/health`)).body, { ok: true, name });
    assert.deepEqual((await request(`${url}/__sim/calls`)).body, { calls: [] });
    assert.deepEqual((await request(`${url}/__sim/faults`)).body, { faults: [] });
  }
});

test('startAll takes consecutive ports from the base, and options per service', async (t) => {
  const basePort = await freeBasePort();
  const all = await startAll({ basePort, env: { NODE_ENV: 'test' }, options: { whatsapp: { token: 'custom' } } });
  t.after(all.close);
  assert.equal(all.sims.meta.port, basePort);
  assert.equal(all.sims.google.port, basePort + 5);
  assert.equal((await request(`${all.urls.whatsapp}/v21.0/1`, { headers: { authorization: 'Bearer custom' } })).status, 200);
  assert.equal(DEFAULT_BASE_PORT, 9101);
});

test('a port already in use fails the start and leaves nothing running', async (t) => {
  const basePort = await freeBasePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(basePort + 2, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  await assert.rejects(() => startAll({ basePort, env: { NODE_ENV: 'test' } }), /EADDRINUSE/);
  const free = await request(`http://127.0.0.1:${basePort}/__sim/health`);
  assert.equal(free.status, null, 'the servers started before the failure were closed');
});

function runCommand(extraEnv) {
  const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, exited, output: () => stdout, errors: () => stderr };
}

test('the command starts every simulator and prints only addresses', async (t) => {
  const basePort = await freeBasePort();
  const run = runCommand({ SIM_BASE_PORT: String(basePort), APP_SECRET: 'from-env', VERIFY_TOKEN: 'vt-env', PORT: '4567', SIM_WEBHOOK_URL: '' });
  t.after(() => {
    run.child.kill();
    return run.exited;
  });
  for (const end = Date.now() + 20000; !NAMES.every((name) => run.output().includes(`sim ${name}`)) && Date.now() < end;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(NAMES.every((name) => run.output().includes(`sim ${name}`)), `started: ${run.output()} ${run.errors()}`);
  const lines = run.output().trim().split(/\r?\n/);
  assert.equal(lines.length, NAMES.length);
  for (const line of lines) assert.match(line, /^sim \S+\s+http:\/\/127\.0\.0\.1:\d+$/);

  const meta = `http://127.0.0.1:${basePort}`;
  assert.equal((await request(`${meta}/__sim/health`)).body.name, 'meta');
  const app = (await request(`${meta}/__sim/app`, { json: {} })).body;
  assert.equal(app.webhookUrl, 'http://127.0.0.1:4567/webhook', 'defaults to the local app');
  assert.equal(app.verifyToken, 'vt-env');
  assert.equal(app.secret, undefined);
});

test('the command refuses a bad SIM_BASE_PORT', async () => {
  const run = runCommand({ SIM_BASE_PORT: 'nine' });
  assert.equal(await run.exited, 1);
  assert.match(run.errors(), /SIM_BASE_PORT/);
  assert.equal(run.output(), '');
});
