import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { BrandFile } from '../../../src/contracts/apps.js';
import { ShowcaseBuildError, envLines } from '../../../tools/showcase-build/lib.mjs';
import { assertBrandIds, startShowcaseServer } from '../../../tools/showcase-build/server.mjs';
import { KEYS, root, smallManifest } from './support.js';

// Loading a sample business takes minutes on a busy machine, so these tests load two small businesses made from the
// committed plant seed (13 products each) instead of the committed manifest, and share one server per mode. The real
// manifest is loaded by the workflow's seed job.
const SLOW = { timeout: 30 * 60_000 };
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const base = { NODE_ENV: 'development', ALLOW_PGLITE: '1', APP_HOST: '127.0.0.1', PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP };
let dir;
let manifest;
let owner;
let ownerPort;
let shopper;
let shopperPort;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showcase-test-'));
  manifest = smallManifest(path.join(dir, 'seed'));
  ownerPort = await freePort();
  owner = await startShowcaseServer({ mode: 'owner', manifest, brandsOut: path.join(dir, 'brands'), env: { ...base, PORT: String(ownerPort) } });
  shopperPort = await freePort();
  shopper = await startShowcaseServer({ mode: 'shopper', key: 'second', manifest, brandsDir: path.join(dir, 'brands'), env: { ...base, PORT: String(shopperPort) } });
}, SLOW);

after(async () => {
  await shopper?.close();
  await owner?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('Q-11 both businesses get a brand file from the database, and an iOS one, with the business id each was loaded as', SLOW, () => {
  assert.deepEqual(owner.brands.map((entry) => entry.key), KEYS);
  const files = owner.brands.map((entry) => JSON.parse(fs.readFileSync(entry.file, 'utf8')));
  for (const file of files) assert.ok(BrandFile.safeParse(file).success, 'a brand file the build accepts');
  assert.equal(new Set(files.map((file) => file.tenantId)).size, files.length, 'one business id each');
  assert.deepEqual(files.map((file) => file.android.package), ['app.sample.smallone', 'app.sample.smalltwo']);
  for (const [i, entry] of owner.brands.entries()) {
    const ios = JSON.parse(fs.readFileSync(entry.iosFile, 'utf8'));
    assert.ok(BrandFile.safeParse(ios).success);
    assert.equal(ios.ios.bundleId, files[i].android.package);
    assert.equal(ios.tenantId, files[i].tenantId);
  }
  for (const entry of owner.brands) assert.ok(!path.resolve(entry.file).startsWith(root), 'written outside the repository');
});

test('Q-11 a brand file for another business id than the one loaded is refused, naming the business and no more', () => {
  const folder = path.join(dir, 'tampered');
  fs.mkdirSync(path.join(folder, 'first'), { recursive: true });
  const file = JSON.parse(fs.readFileSync(owner.brands[0].file, 'utf8'));
  fs.writeFileSync(path.join(folder, 'first', 'brand.json'), JSON.stringify({ ...file, tenantId: file.tenantId + 40 }));
  assert.throws(() => assertBrandIds([{ key: 'first', tenantId: file.tenantId }], folder), (error) => error instanceof ShowcaseBuildError && /"first"/.test(error.message));
  fs.writeFileSync(path.join(folder, 'first', 'brand.json'), JSON.stringify(file));
  assert.doesNotThrow(() => assertBrandIds([{ key: 'first', tenantId: file.tenantId }], folder));
});

test('Q-11 the owner server is up and tells the flows each business and its new cash on delivery order by place in the manifest', SLOW, async () => {
  assert.equal((await fetch(`http://127.0.0.1:${ownerPort}/healthz`)).status, 200);
  const env = owner.env;
  assert.equal(env.BUSINESS_COUNT, '2');
  for (const n of [1, 2]) {
    assert.match(env[`BUSINESS_${n}_ID`], /^\d+$/);
    assert.equal(env[`BUSINESS_${n}_NAME`], ['Small One', 'Small Two'][n - 1]);
    assert.match(env[`ORDER_${n}_ID`], /^\d+$/);
    assert.equal(env[`ORDER_${n}_NUMBER`], `SC-${n}-1001`);
  }
  assert.notEqual(env.BUSINESS_1_ID, env.BUSINESS_2_ID);
  assert.equal(env.API_URL, `http://127.0.0.1:${ownerPort}`);
  assert.match(env.SIM_WHATSAPP_URL, /^http:\/\/127\.0\.0\.1:\d+$/, 'the flows read codes from a simulator on this machine');
  assert.doesNotThrow(() => envLines(env));
});

test('Q-11 the one operator account signs in with a code from the WhatsApp simulator and sees both businesses in the switcher', SLOW, async () => {
  const url = owner.env.API_URL;
  const post = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const asked = await post('/api/v1/auth/start', { phone: owner.env.PHONE_OPERATOR });
  assert.ok(asked.status < 300, `the sign-in code is sent (${asked.status})`);
  const sent = await (await fetch(`${owner.env.SIM_WHATSAPP_URL}/__sim/sent`)).json();
  const message = [...sent.sent].reverse().find((entry) => String(entry.to).replace(/\D/g, '').endsWith(owner.env.PHONE_OPERATOR));
  assert.ok(message, 'the code reached the simulator outbox');
  const code = /(^|\D)(\d{6})(?!\d)/.exec(JSON.stringify(message.body))?.[2];
  assert.ok(code);
  const verified = await post('/api/v1/auth/verify', { phone: owner.env.PHONE_OPERATOR, code, transport: 'bearer' });
  assert.ok(verified.status < 300, `the code signs in (${verified.status})`);
  const session = await verified.json();
  assert.ok(session.accessToken, 'a session');
  const list = await fetch(`${url}/api/v1/auth/businesses`, { headers: { authorization: `Bearer ${session.accessToken}` } });
  assert.equal(list.status, 200);
  const ids = (await list.json()).businesses.map((item) => String(item.id));
  for (const n of [1, 2]) assert.ok(ids.includes(owner.env[`BUSINESS_${n}_ID`]), `business ${n} is in the switcher`);
});

test('Q-11 the shopper server answers as the one business under test, and its flow values are that business\'s own', SLOW, async () => {
  const brand = JSON.parse(fs.readFileSync(owner.brands[1].file, 'utf8'));
  const env = shopper.env;
  assert.equal(env.APP_ID, brand.android.package);
  assert.equal(env.APP_SCHEME, brand.scheme);
  assert.equal(env.APP_NAME, brand.name);
  assert.equal(env.TENANT_ID, String(brand.tenantId));
  assert.ok(env.PRODUCT_SLUG && env.PRODUCT_NAME);
  assert.equal(env.API_URL, `http://127.0.0.1:${shopperPort}`);
  assert.match(env.SIM_RAZORPAY_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${env.API_URL}/healthz`)).status, 200);
  // online payment and cash on delivery are both on for this business, through the payment simulator
  const [pay] = await shopper.world.sql('SELECT mode, cod, kyc_status FROM payment_settings WHERE tenant_id = $1', [brand.tenantId]);
  assert.equal(pay.cod, true);
  assert.equal(pay.mode, 'managed');
  assert.equal(pay.kyc_status, 'verified');
  // the app's own request, as the build makes it: the business id it was built for, on the address the emulator uses
  const headers = (tenant) => ({ 'x-app': 'shopper', 'x-app-tenant': String(tenant), 'x-app-version': '1.0.0', 'x-app-platform': 'android', accept: 'application/json' });
  const feed = await fetch(`${env.API_URL}/api/store/app/home`, { headers: headers(env.TENANT_ID) });
  assert.notEqual(feed.status, 404, 'this business has an app for this build: the gate does not hide it');
  const wrong = await fetch(`${env.API_URL}/api/store/app/home`, { headers: headers(brand.tenantId + 1) });
  assert.equal(wrong.status, 404, 'a build for another business is told nothing');
});

test('Q-11 the server refuses to start in production, or on a real database, and the shopper server needs the business it is for', async () => {
  await assert.rejects(startShowcaseServer({ mode: 'owner', env: { ...base, NODE_ENV: 'production' } }), ShowcaseBuildError);
  await assert.rejects(startShowcaseServer({ mode: 'owner', env: { ...base, DATABASE_URL: 'postgres://example.invalid/db' } }), /built-in database/);
  await assert.rejects(startShowcaseServer({ mode: 'shopper', env: base }), /--key/);
  await assert.rejects(startShowcaseServer({ mode: 'nonsense', env: base }), ShowcaseBuildError);
});
