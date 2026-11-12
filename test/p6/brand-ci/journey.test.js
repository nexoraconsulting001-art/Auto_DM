// The server half of every flow in apps/shopper/.maestro, rehearsed for each fixture brand against the job's own server
// (support/server.mjs, started as its own process exactly as the workflow starts it) with the app's own session, store client
// and pay package: browse with no sign-in, open a product, a guest pays online with the payment simulator's test card through
// the flows' own pay.js (and the app says Paid only when the server does), a cash on delivery order with a WhatsApp code read
// by the flows' own code.js, the order under Orders with tracking, reorder, and delete the account. That the screens do the
// same on an emulator is for the android-e2e job.
import '../../../tools/net-guard.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBuy } from '../../../apps/shopper/src/features/cart/buy.js';
import { consentBody, createAttempt, orderIsPlaced, paymentWords, placeExtra } from '../../../apps/shopper/src/features/checkout/placing.js';
import { createSession } from '../../../apps/shopper/src/features/sign-in/session.js';
import { createBrowse, createStoreClient } from '../../../packages/store-client/src/index.js';
import { runScript } from '../../p5/app-release/maestro-shim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SUPPORT = path.join(ROOT, 'apps/shopper/.maestro/support');
const FIXTURES = path.join(ROOT, 'tools/build-brand/fixtures');
const brandNames = fs.readdirSync(FIXTURES).filter((n) => fs.existsSync(path.join(FIXTURES, n, 'brand.json')));
const read = (file) => fs.readFileSync(file, 'utf8');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** Starts support/server.mjs for one brand file the way the workflow does, as a process of its own. */
async function startWorld(brandFile) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brand-ci-env-')), 'flows.env');
  const child = spawn(process.execPath, [path.join(SUPPORT, 'server.mjs'), '--brand', brandFile, '--out', out], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development', PORT: String(await freePort()), APP_HOST: 'localhost', SIM_BASE_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  await Promise.race([
    new Promise((resolve) => child.once('message', resolve)),
    exited.then((code) => Promise.reject(new Error(`server.mjs exited with ${code}: ${stderr.slice(-800)}`))),
  ]);
  const env = Object.fromEntries(read(out).trim().split(/\r?\n/).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  const stop = async () => {
    if (child.connected) child.disconnect();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
    if (child.exitCode === null) child.kill();
  };
  return { env, stop };
}

/** The app's side of buying, made the way the app makes it, against one brand's server. */
function phone(env) {
  const held = new Map();
  const store = {
    getRefreshToken: async () => held.get('refresh') ?? null,
    setRefreshToken: async (value) => (value ? held.set('refresh', value) : held.delete('refresh')),
    getDeviceId: async () => 'device-abcdefghijklmnop',
    clearSession: async () => held.clear(),
  };
  let session = null;
  const client = createStoreClient({
    origin: env.API_URL,
    tenantId: Number(env.TENANT_ID),
    version: '1.0.0',
    platform: 'android',
    getAccessToken: () => session.getAccessToken(),
    onUnauthorized: () => session.onUnauthorized(),
  });
  session = createSession({
    client, store, scheme: env.APP_SCHEME, random: async (n) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256), sha256: async () => 'x', onWipe: [],
  });
  const buy = createBuy(client, { ready: () => session.start() });
  const attempt = createAttempt({ newKey: (() => { let n = 0; return () => `attempt-${Date.now()}-${++n}`; })() });
  return { client, session, buy, attempt, browse: createBrowse(client) };
}

const addressOf = (env) => ({ name: env.SHOPPER_NAME, phone: env.SHOPPER_PHONE, line1: env.SHOPPER_LINE1, city: env.SHOPPER_CITY, stateCode: env.SHOPPER_STATE_CODE, pincode: env.SHOPPER_PINCODE });

for (const name of brandNames) {
  describe(`the flows, rehearsed against the job server for ${name}`, { timeout: 600_000 }, () => {
    const brandFile = path.join(FIXTURES, name, 'brand.json');
    const brand = JSON.parse(read(brandFile));
    let world;
    let env;
    const script = (file, extra) => runScript(path.join(SUPPORT, file), { ...env, ...extra });

    before(async () => {
      world = await startWorld(brandFile);
      env = world.env;
    });
    after(async () => { await world?.stop(); });

    test('the job hands the flows this brand\'s own names and a store that is its own business', () => {
      assert.equal(env.APP_ID, brand.android.package);
      assert.equal(env.TENANT_ID, String(brand.tenantId));
      assert.equal(env.APP_SCHEME, brand.scheme);
      assert.equal(env.PRODUCT_SLUG, 'flow-test-mug');
      assert.match(env.SIM_WHATSAPP_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(env.SIM_RAZORPAY_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    });

    test('P-27: the catalog and the product show with no sign-in and no prompt', async () => {
      const app = phone(env);
      await app.session.start();
      const boot = await app.browse.bootstrap();
      assert.ok(boot, 'bootstrap answered');
      const page = await app.browse.catalog({});
      const card = page.items.find((item) => item.slug === env.PRODUCT_SLUG);
      assert.ok(card, 'the seeded product is in the catalog');
      assert.equal(card.name, env.PRODUCT_NAME);
      assert.equal(app.session.getState().status === 'signedIn', false);
      const product = await app.client.call('appProduct', { params: { slug: env.PRODUCT_SLUG } });
      assert.equal(product.name, env.PRODUCT_NAME);
      assert.doesNotMatch(JSON.stringify([boot, page, product]), new RegExp(['bha', 'va'].join(''), 'i'), 'nothing a shopper sees names the platform');
    });

    test('P-29: a guest pays with the test card, and the order is Paid only when the server says so', async () => {
      const app = phone(env);
      await app.session.start();
      const page = await app.browse.catalog({});
      const productId = page.items.find((item) => item.slug === env.PRODUCT_SLUG).id;
      const draft = { lines: [{ productId, variantId: null, qty: 1 }], address: addressOf(env), paymentMode: 'prepaid', email: env.SHOPPER_EMAIL };
      const quote = await app.buy.quote(draft);
      assert.equal(quote.serviceable !== false, true, 'the invented pin code is served');
      assert.ok(quote.paymentModes.find((m) => m.mode === 'prepaid')?.available, 'online payment is on for the seeded store');
      assert.ok(quote.paymentModes.find((m) => m.mode === 'cod')?.available, 'cash on delivery is on for the seeded store');
      const placed = await app.attempt.place(draft, (key) => app.buy.place(draft, placeExtra({ key, consent: consentBody({ noticeVersion: 1 }) })));
      assert.equal(placed.next, 'pay');
      assert.ok(placed.gateway, 'the server opened a gateway order');
      // Not paid before the card: asking the server says so, and the app would not say Paid.
      const before = await app.buy.state(placed.token);
      assert.notEqual(paymentWords(before.paymentStatus), 'paid');
      // The flow's own script plays the shopper with the test card.
      const paid = script('pay.js');
      assert.match(paid.paymentId, /^pay_/);
      let state;
      for (let i = 0; i < 40; i++) {
        state = await app.buy.state(placed.token);
        if (paymentWords(state.paymentStatus) === 'paid') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.equal(paymentWords(state.paymentStatus), 'paid', JSON.stringify(state));
      assert.equal(orderIsPlaced(state), true);
    });

    test('P-28, P-46, P-64, P-30: cash on delivery with a WhatsApp code, under Orders with tracking, reorder, then delete the account', async () => {
      const app = phone(env);
      // Sign in, as the sign-in steps do: the code is read from the WhatsApp simulator by the flows' own script.
      await app.session.start();
      await app.session.sendCode(env.SHOPPER_PHONE);
      await app.session.signInWithCode(env.SHOPPER_PHONE, script('code.js', { PHONE: env.SHOPPER_PHONE }).code);
      assert.equal(app.session.getState().status, 'signedIn');

      const page = await app.browse.catalog({});
      const productId = page.items.find((item) => item.slug === env.PRODUCT_SLUG).id;
      const draft = { lines: [{ productId, variantId: null, qty: 1 }], address: addressOf(env), paymentMode: 'cod', email: env.SHOPPER_EMAIL };
      const checkoutKey = app.attempt.keyFor(draft);
      await app.buy.sendCodFor({ phone: env.SHOPPER_PHONE, checkoutKey });
      await app.buy.verifyCodFor({ phone: env.SHOPPER_PHONE, code: script('code.js', { PHONE: env.SHOPPER_PHONE }).code, checkoutKey });
      const placed = await app.attempt.place(draft, (key) => app.buy.place(draft, placeExtra({ key, consent: consentBody({ noticeVersion: 1 }) })));
      assert.equal(placed.next, 'done');
      const state = await app.buy.state(placed.token);
      assert.equal(paymentWords(state.paymentStatus), 'cod');

      // Under Orders, and the tracking the screen shows.
      const orders = await app.client.call('appOrders', { query: { limit: 20 } });
      const mine = orders.items.find((order) => order.orderNumber === state.orderNumber);
      assert.ok(mine, 'the new order is under Orders');
      const detail = await app.client.call('appOrder', { params: { orderNumber: state.orderNumber } });
      assert.equal(detail.orderNumber, state.orderNumber);
      assert.ok(detail.fulfilmentStatus, 'there is a status for the tracking steps');

      // One tap on reorder puts the items back in the bag.
      const again = await app.client.call('appReorder', { params: { orderNumber: state.orderNumber } });
      assert.ok(JSON.stringify(again).includes(String(productId)), 'the product is back');

      // Delete the account: the session is over and the orders are no longer the shopper's to read.
      const deleted = await app.session.deleteAccount();
      assert.ok(deleted, 'the server answered the deletion');
      assert.notEqual(app.session.getState().status, 'signedIn');
      await assert.rejects(() => app.client.call('appOrders', { query: { limit: 20 } }));
    });
  });
}
