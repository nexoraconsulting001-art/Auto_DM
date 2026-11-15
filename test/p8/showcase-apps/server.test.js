import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { BrandFile } from '../../../src/contracts/apps.js';
import { startShowcaseServer } from '../../../tools/showcase-build/server.mjs';
import { ShowcaseBuildError, envLines } from '../../../tools/showcase-build/lib.mjs';
import { read } from './support.js';

// Loading the sample businesses takes minutes on a busy machine: this file starts the owner server once and shares it.
const SLOW = { timeout: 25 * 60_000 };
const manifest = JSON.parse(read('seed/showcase/manifest.json'));
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let world;
let port;
let brandsDir;
const base = { NODE_ENV: 'development', ALLOW_PGLITE: '1', SIM_BASE_PORT: '0', APP_HOST: '127.0.0.1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };

before(async () => {
  port = await freePort();
  brandsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-brands-'));
  world = await startShowcaseServer({ mode: 'owner', brandsOut: brandsDir, env: { ...base, PORT: String(port) }, stdio: 'ignore' });
}, SLOW);

after(async () => {
  await world?.close();
  fs.rmSync(brandsDir, { recursive: true, force: true });
});

test('Q-11 both businesses of the manifest get a brand file from the database, with the business id it was loaded as', SLOW, () => {
  assert.deepEqual(world.brands.map((entry) => entry.key), manifest.businesses.map((entry) => entry.key));
  const files = world.brands.map((entry) => JSON.parse(fs.readFileSync(entry.file, 'utf8')));
  for (const file of files) assert.ok(BrandFile.safeParse(file).success, 'a brand file the build accepts');
  assert.equal(new Set(files.map((file) => file.tenantId)).size, files.length, 'one business id each');
  assert.equal(new Set(files.map((file) => file.android.package)).size, files.length, 'one package each');
  assert.equal(new Set(files.map((file) => file.name)).size, files.length);
  for (const [i, entry] of world.brands.entries()) {
    const ios = JSON.parse(fs.readFileSync(entry.iosFile, 'utf8'));
    assert.ok(BrandFile.safeParse(ios).success);
    assert.equal(ios.ios.bundleId, files[i].android.package);
    assert.equal(ios.tenantId, files[i].tenantId);
  }
  assert.ok(files.every((file) => file.tenantId > 0));
});

test('Q-11 the brand files are made fresh in a folder of the run, and the repository has none of them', SLOW, () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', '..');
  for (const entry of world.brands) assert.ok(!path.resolve(entry.file).startsWith(root), 'written outside the repository');
});

test('Q-11 the owner server is up, answers on the sign-in address, and tells the flows each business by its place in the manifest', SLOW, async () => {
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  const env = world.env;
  assert.equal(env.BUSINESS_COUNT, String(manifest.businesses.length));
  for (let n = 1; n <= manifest.businesses.length; n++) {
    assert.match(env[`BUSINESS_${n}_ID`], /^\d+$/);
    assert.ok(env[`BUSINESS_${n}_NAME`]);
    assert.match(env[`ORDER_${n}_ID`], /^\d+$/);
    assert.equal(env[`ORDER_${n}_NUMBER`], `SC-${n}-1001`);
  }
  assert.notEqual(env.BUSINESS_1_ID, env.BUSINESS_2_ID);
  assert.match(env.API_URL, new RegExp(`^http://127\\.0\\.0\\.1:${port}$`));
  assert.match(env.SIM_WHATSAPP_URL, /^http:\/\/127\.0\.0\.1:\d+$/, 'the flows read codes from a simulator on this machine');
  assert.doesNotThrow(() => envLines(env));
});

test('Q-11 the one operator account signs in with a code from the WhatsApp simulator and sees both businesses', SLOW, async () => {
  const url = world.env.API_URL;
  const host = { host: world.env.SIGN_IN_HOST };
  const post = (route, body, headers = {}) => fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...host, ...headers }, body: JSON.stringify(body) });
  const asked = await post('/api/v1/auth/start', { phone: world.env.PHONE_OPERATOR });
  assert.ok(asked.status < 300, `the sign-in code is sent (${asked.status})`);
  const sent = await (await fetch(`${world.env.SIM_WHATSAPP_URL}/__sim/sent`)).json();
  const message = [...sent.sent].reverse().find((entry) => String(entry.to).replace(/\D/g, '').endsWith(world.env.PHONE_OPERATOR));
  assert.ok(message, 'the code reached the simulator\'s outbox');
  const code = /(^|\D)(\d{6})(?!\d)/.exec(JSON.stringify(message.body))?.[2];
  assert.ok(code);
  const verified = await post('/api/v1/auth/verify', { phone: world.env.PHONE_OPERATOR, code, transport: 'bearer' });
  assert.ok(verified.status < 300, `the code signs in (${verified.status})`);
  const session = await verified.json();
  assert.ok(session.accessToken, 'a session');
  const list = await fetch(`${url}/api/v1/auth/businesses`, { headers: { ...host, authorization: `Bearer ${session.accessToken}` } });
  assert.equal(list.status, 200);
  const ids = (await list.json()).businesses.map((item) => String(item.id));
  for (let n = 1; n <= manifest.businesses.length; n++) assert.ok(ids.includes(world.env[`BUSINESS_${n}_ID`]), `business ${n} is in the switcher`);
});
  assert.equal(list.status, 200);
  const businesses = await list.json();
  const ids = (businesses.items ?? businesses).map((item) => String(item.id ?? item.tenantId));
  for (let n = 1; n <= manifest.businesses.length; n++) assert.ok(ids.includes(world.env[`BUSINESS_${n}_ID`]), `business ${n} is in the switcher`);
});

test('Q-11 the server refuses to start in production, or on a real database, and the shopper server needs the business it is for', async () => {
  await assert.rejects(startShowcaseServer({ mode: 'owner', env: { ...base, NODE_ENV: 'production' } }), ShowcaseBuildError);
  await assert.rejects(startShowcaseServer({ mode: 'owner', env: { ...base, DATABASE_URL: 'postgres://example.invalid/db' } }), /built-in database/);
  await assert.rejects(startShowcaseServer({ mode: 'shopper', env: base }), /--key/);
  await assert.rejects(startShowcaseServer({ mode: 'nonsense', env: base }), ShowcaseBuildError);
});
