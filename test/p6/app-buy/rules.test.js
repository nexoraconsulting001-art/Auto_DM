// The buying code's rules that need no server: the bag holds no money, no request carries an amount, one key per attempt, Paid only
// from the server's word, tokens only in secure storage and gone at sign-out, no platform name or log or shortener in what the
// buying code owns, and every line in English has its Hindi twin. The rendered screens are tested with jest beside the code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCart, cleanLines, keyOf } from '../../../apps/shopper/src/features/cart/cart.js';
import { assertNoMoney, createBuy, draftBody } from '../../../apps/shopper/src/features/cart/buy.js';
import { consentBody, createAttempt, orderIsPlaced, paymentWords, placeExtra } from '../../../apps/shopper/src/features/checkout/placing.js';
import { outcomeOf } from '../../../apps/shopper/src/features/payment/flow.js';
import { createSession } from '../../../apps/shopper/src/features/sign-in/session.js';
import { permissionOf } from '../../../apps/shopper/src/features/notifications/flow.js';
import { PROOF_MAX_FILES, formWith, partOf, pickFiles } from '../../../apps/shopper/src/features/returns/proof.js';
import { STATES, addressProblems } from '../../../apps/shopper/src/features/addresses/states.js';
import { settle } from '../../../packages/pay/src/index.js';
import { INDIAN_STATES } from '../../../src/contracts/orders.js';
import { ROUTES } from '../../../packages/store-client/src/routes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FEATURES = ['cart', 'checkout', 'payment', 'orders', 'tracking', 'account', 'sign-in', 'notifications', 'rewards', 'wishlist', 'reviews', 'returns', 'addresses'];
const OWNED = [...FEATURES.map((f) => `apps/shopper/src/features/${f}`), 'packages/pay/src'];
/** The one screen that may name the platform: the shared-profile consent (9.22), which Phase 4 defines. */
const MAY_NAME_PLATFORM = 'apps/shopper/src/features/account/SharedProfile.js';

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (rel.endsWith('.js') && !rel.endsWith('.test.js') && !rel.endsWith('.fixture.js')) out.push({ rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8') });
    }
  };
  OWNED.forEach(walk);
  return out;
}
const codeOf = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

test('the bag keeps ids and quantities only, merges repeats, survives a restart, and is wiped by sign-out', async () => {
  const disk = new Map();
  const storage = { getItem: async (k) => disk.get(k) ?? null, setItem: async (k, v) => disk.set(k, v), removeItem: async (k) => disk.delete(k) };
  const cart = createCart({ storage, storageKey: 'k' });
  await cart.add({ productId: 3, qty: 1 });
  await cart.add({ productId: 3, qty: 2 });
  await cart.add({ productId: 4, variantId: 9, qty: 1 });
  assert.deepEqual(cart.lines.map((l) => [keyOf(l), l.qty]), [['3:', 3], ['4:9', 1]]);
  assert.equal(cart.count, 4);
  assert.throws(() => cart.add({ productId: 3, qty: 0 }));
  assert.deepEqual(Object.keys(cart.lines[0]).sort(), ['productId', 'qty', 'variantId'], 'no price, name or total is kept');
  assert.ok(!/paise|price|total/i.test(disk.get('k')), 'nothing about money reaches the device');

  const again = createCart({ storage, storageKey: 'k' });
  await again.load();
  assert.equal(again.count, 4, 'the bag is still there after a restart');
  await again.setQty('3:', 0);
  assert.deepEqual(again.lines.map(keyOf), ['4:9']);
  await again.wipe();
  assert.equal(again.count, 0);
  assert.equal(disk.has('k'), false, 'wiped from the device too');
  assert.deepEqual(cleanLines([{ productId: 1, qty: 1.5 }, { productId: -1, qty: 1 }, { productId: 2, qty: 1, unitPaise: 5 }]).map((l) => Object.keys(l).sort().join()), ['productId,qty,variantId']);
});

test('a signed-in bag is pushed to the server and merged after sign-in', async () => {
  const puts = [];
  let active = false;
  const cart = createCart({ remote: { active: () => active, put: async (lines) => { puts.push(lines.map((l) => l.qty)); return [{ productId: 1, variantId: null, qty: 5 }]; } } });
  await cart.add({ productId: 1, qty: 1 });
  assert.deepEqual(puts, [], 'a guest bag stays on the phone');
  active = true;
  await cart.mergeWithServer();
  assert.deepEqual(puts, [[1]]);
  assert.equal(cart.count, 5, 'the server’s merged bag becomes the bag');
  await cart.setQty('1:', 2);
  assert.deepEqual(puts.at(-1), [2]);
});

test('no request carries money: a price, total, discount, fee or tax field is refused before it leaves the phone', async () => {
  for (const field of ['pricePaise', 'totalPaise', 'discountPaise', 'shippingFee', 'taxPaise', 'amount', 'advancePaise', 'unitPrice']) {
    assert.throws(() => assertNoMoney({ lines: [{ productId: 1, [field]: 1 }] }), /never sends money/, field);
  }
  assert.doesNotThrow(() => assertNoMoney({ lines: [{ productId: 1, variantId: null, qty: 2 }], couponCode: 'NEEL10', redeemPoints: 40, paymentMode: 'prepaid' }));
  const sent = [];
  const buy = createBuy({ call: async (id, options) => { sent.push([id, options]); return {}; } });
  await assert.rejects(buy.call('checkoutPlace', { body: { lines: [], totalPaise: 1 } }), /never sends money/);
  assert.equal(sent.length, 0, 'nothing left the phone');
  // The body of a quote is built from choices only, whatever the draft carried.
  const body = draftBody({ lines: [{ productId: 1, variantId: null, qty: 1, unitPaise: 10 }], address: { name: 'A', phone: '9', line1: 'x' }, paymentMode: 'cod', totalPaise: 99, redeemPoints: 0, email: '', couponCode: '' });
  assert.deepEqual(Object.keys(body).sort(), ['address', 'lines', 'paymentMode']);
  assert.deepEqual(body.lines, [{ productId: 1, variantId: null, qty: 1 }]);
});

test('one attempt, one key: a double tap shares a request, a retry keeps the key, a changed bag or phone starts a new attempt', async () => {
  let made = 0;
  const attempt = createAttempt({ newKey: () => `key-${++made}` });
  const draft = { lines: [{ productId: 1, variantId: null, qty: 1 }], address: { phone: '98765 43210' } };
  let sent = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const send = async (key) => { sent += 1; await gate; return { orderNumber: `A-${key}`, next: 'pay' }; };
  const first = attempt.place(draft, send);
  const second = attempt.place(draft, send);
  assert.equal(attempt.busy, true);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ orderNumber: 'A-key-1', next: 'pay' }, { orderNumber: 'A-key-1', next: 'pay' }]);
  assert.equal(sent, 1);
  assert.equal(attempt.busy, false);

  // A failed try keeps its key for the retry.
  await assert.rejects(attempt.place(draft, async () => { throw new Error('offline'); }));
  const keys = [];
  await attempt.place(draft, async (key) => { keys.push(key); return { next: 'pay' }; });
  await attempt.place(draft, async (key) => { keys.push(key); return { next: 'pay' }; });
  assert.equal(keys[0], 'key-2', 'the retry after a failure is the same attempt');
  assert.notEqual(keys[0], keys[1], 'after an order was made the next order is a new attempt');
  // The same key stands while the phone and bag stand, and is new for a new phone or bag.
  const k1 = attempt.keyFor(draft);
  assert.equal(attempt.keyFor({ ...draft, address: { phone: '9876543210' } }), k1, 'the same phone written another way');
  assert.notEqual(attempt.keyFor({ ...draft, address: { phone: '9876500000' } }), k1);
  // Asked to prove the phone first: no order yet, so the attempt goes on with the same key.
  const before = attempt.keyFor(draft);
  await attempt.place(draft, async () => ({ next: 'verify_phone', orderNumber: '' }));
  assert.equal(attempt.keyFor(draft), before);
});

test('what the shopper agrees to: order updates on WhatsApp, marketing off, terms accepted by the shopper', () => {
  assert.deepEqual(consentBody({ noticeVersion: 3 }), { noticeVersion: 3, orderUpdates: { whatsapp: true, email: false }, marketing: { whatsapp: false, email: false } });
  assert.equal(consentBody({}).noticeVersion, 1);
  assert.deepEqual(Object.keys(placeExtra({ key: 'k', consent: {} })).sort(), ['acceptTerms', 'consent', 'idempotencyKey', 'saveDetails']);
});

test('Paid is the server’s word: only paid says paid, cash on delivery and an advance say what they are', async () => {
  assert.equal(paymentWords('paid'), 'paid');
  assert.equal(paymentWords('cod_due'), 'cod');
  assert.equal(paymentWords('advance_paid'), 'advance');
  assert.equal(paymentWords('unpaid'), 'waiting');
  assert.equal(paymentWords('voided'), 'failed');
  assert.equal(paymentWords(undefined), 'waiting');
  assert.equal(orderIsPlaced({ next: 'done' }), true);
  assert.equal(orderIsPlaced({ next: 'pay' }), false);
  // Whatever the payment page said, the result is the server's state.
  const asked = [];
  const result = await settle({ token: 't' }, { orderState: async (token) => (asked.push(token), { next: 'pay' }), attempts: 3, waitMs: 0, wait: async () => {} });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual([outcomeOf(result), outcomeOf({ status: 'paid' }), outcomeOf({ status: 'failed' }), outcomeOf({ status: 'cancelled', state: { next: 'pending' } })], ['cancelled', 'paid', 'failed', 'confirming']);
  assert.equal(asked.length, 1, 'the server was asked');
});

function fakeSession({ answer, fail, now = () => 0 } = {}) {
  const held = new Map();
  const store = {
    getRefreshToken: async () => held.get('refresh') ?? null,
    setRefreshToken: async (v) => (v ? held.set('refresh', v) : held.delete('refresh')),
    getDeviceId: async () => 'device-abcdefghijklmnop',
    clearSession: async () => held.clear(),
  };
  const calls = [];
  let session;
  const client = {
    async call(id, options) {
      calls.push(id);
      const token = await session.getAccessToken();
      if (fail?.[id]) throw fail[id];
      return (answer?.[id] ?? (() => ({})))(options, token);
    },
    pageUrl: () => 'https://store.example/auth/app/google',
  };
  let wiped = 0;
  session = createSession({ client, store, scheme: 'neel', onWipe: [() => { wiped += 1; }], random: async (n) => new Uint8Array(n), sha256: async () => 'x', now });
  return { session, store, held, calls, wiped: () => wiped };
}
const tokens = (n = 1) => ({ accessToken: `shopa_${n}`, accessExpiresInSeconds: 900, refreshToken: `shopr_${n}`, guest: true, shopper: null });

test('session: one guest start however many calls come; the access token stays in memory and the refresh token in the store', async () => {
  const f = fakeSession({ answer: { appSessionStart: () => tokens(1) } });
  assert.equal(await f.session.getAccessToken(), null, 'a phone with nothing yet does not hold the first call back');
  await f.session.start();
  const seen = await Promise.all([f.session.getAccessToken(), f.session.getAccessToken(), f.session.getAccessToken()]);
  assert.deepEqual(seen, ['shopa_1', 'shopa_1', 'shopa_1']);
  assert.equal(f.calls.filter((c) => c === 'appSessionStart').length, 1);
  assert.deepEqual([...f.held.entries()], [['refresh', 'shopr_1']], 'only the refresh token is stored, and the access token is not');
  assert.equal(f.session.getState().status, 'guest');
});

test('session: a refresh the server refuses signs out and wipes; one that could not be asked changes nothing', async () => {
  const refused = fakeSession({ answer: { appSessionStart: () => tokens(2) }, fail: { appSessionRefresh: { status: 401, code: 'unauthenticated' } } });
  refused.held.set('refresh', 'shopr_old');
  assert.equal(await refused.session.getAccessToken(), 'shopa_2');
  assert.equal(refused.wiped(), 1);
  assert.equal(refused.held.get('refresh'), 'shopr_2', 'the dead token is gone');

  let t = 0;
  const offline = fakeSession({ fail: { appSessionRefresh: { status: 0, code: 'network' } }, now: () => t });
  offline.held.set('refresh', 'shopr_keep');
  assert.equal(await offline.session.getAccessToken(), null);
  assert.equal(offline.wiped(), 0);
  assert.equal(offline.held.get('refresh'), 'shopr_keep', 'offline never signs anyone out');
  assert.equal(await offline.session.getAccessToken(), null);
  assert.equal(offline.calls.filter((c) => c === 'appSessionRefresh').length, 1, 'it does not hammer an unreachable store');
  t = 60_000;
  await offline.session.getAccessToken();
  assert.equal(offline.calls.filter((c) => c === 'appSessionRefresh').length, 2, 'and tries again a little later');
});

test('session: sign-out and account deletion run every wipe and leave only a fresh guest', async () => {
  const f = fakeSession({
    answer: {
      appSessionStart: (o) => (o.body.grant === 'otp' ? { ...tokens(3), guest: false, shopper: { id: 1, name: 'A' } } : tokens(1)),
      appSessionEnd: () => tokens(4),
      appAccountDelete: () => ({ status: 'completed', signedOut: true, message: 'Deleted' }),
    },
  });
  await f.session.signInWithCode('9876543210', '123456');
  assert.equal(f.session.getState().status, 'signedIn');
  assert.equal(f.held.get('refresh'), 'shopr_3');
  await f.session.signOut();
  assert.equal(f.wiped(), 1);
  assert.equal(f.session.getState().status, 'guest');
  assert.equal(f.session.getState().shopper, null);
  assert.equal(f.held.get('refresh'), 'shopr_4');
  await f.session.signInWithCode('9876543210', '123456');
  const answer = await f.session.deleteAccount();
  assert.equal(answer.status, 'completed');
  assert.equal(f.wiped(), 2);
  assert.equal(f.session.getState().status, 'guest');
  assert.ok(!JSON.stringify(f.session.getState()).includes('shopr_'), 'no token in the session’s state');
});

test('push: the phone’s answer maps to the permission the store records', () => {
  assert.equal(permissionOf({ granted: true }), 'granted');
  assert.equal(permissionOf({ granted: false, status: 'denied' }), 'denied');
  assert.equal(permissionOf({ granted: false, status: 'undetermined' }), 'not_asked');
  assert.equal(permissionOf({ granted: false, ios: { status: 3 } }, { IosAuthorizationStatus: { PROVISIONAL: 3 } }), 'provisional');
});

test('the address form’s states are the store’s, and a bad address is named field by field', () => {
  assert.deepEqual(Object.fromEntries(STATES.map((s) => [s.code, s.name])), Object.fromEntries(Object.entries(INDIAN_STATES).map(([code, name]) => [String(code).padStart(2, '0'), name])));
  assert.deepEqual(Object.keys(addressProblems({ name: 'A', phone: '123', line1: '', city: '', stateCode: '', pincode: '12' })).sort(), ['city', 'line1', 'name', 'phone', 'pincode', 'stateCode']);
  assert.deepEqual(addressProblems({ name: 'Asha Rao', phone: '+91 98765 43210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' }), {});
});

test('every call the buying code makes is a route the app’s client knows, with the right token kind', () => {
  const used = new Set();
  for (const { text } of sources()) for (const match of text.matchAll(/(?:call|buy\.call|client\.call)\('([A-Za-z]+)'/g)) used.add(match[1]);
  for (const match of ['cartGet', 'cartPut', 'checkoutQuote', 'checkoutPlace', 'orderRetry', 'appOrderByToken', 'otpSend', 'otpVerify']) used.add(match);
  for (const id of used) assert.ok(ROUTES[id], `${id} is a route`);
  assert.equal(ROUTES.appRewards.auth, 'shopper');
  assert.equal(ROUTES.checkoutPlace.auth, 'app', 'guest checkout needs only an app session');
});

test('what the buying code owns names no platform (except the shared-profile consent), logs nothing, keeps tokens in secure storage and links straight', () => {
  const found = sources();
  assert.ok(found.length > 40, 'the sources were found');
  for (const { rel, text } of found) {
    const code = codeOf(text);
    if (rel !== MAY_NAME_PLATFORM) assert.ok(!/bhava/i.test(code.replace(/@bhava\/[a-z-]+(\/[a-z-]+)?/g, '')), `${rel} spells the platform’s name`);
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(code), `${rel} logs`);
    assert.ok(!/AsyncStorage|localStorage|sessionStorage/.test(code), `${rel} keeps something where a token must not be`);
    assert.ok(!/\bfetch\(/.test(code), `${rel} calls the network directly`);
    assert.ok(!/react-native-webview|WebView|dangerouslySetInnerHTML|innerHTML|\beval\(|new Function\(/.test(code), `${rel} runs markup`);
    assert.ok(!/['"`]\/(go|l|click|redirect|r)\/|bit\.ly|tinyurl/.test(code), `${rel} sends a link through a redirect`);
    assert.ok(!/(?:Paise|total|subtotal|discount)\w*\s*[*+/]\s*\w|\*\s*\w*\.?(?:qty|quantity)\b/i.test(code.replace(/\+\s*line\.qty/g, '')), `${rel} works out an amount`);
    assert.ok(!/\.reduce\([^)]*Paise/.test(code), `${rel} adds up money`);
    if (!/(sign-in|notifications)\/index\.js$/.test(rel)) assert.ok(!/expo-secure-store/.test(code), `${rel} reaches for secure storage`);
    // Nothing personal goes to a log or an analytics call, and no push token or code goes into the cache.
    assert.ok(!/setQueryData\([^)]*(token|code|otp)/i.test(code), `${rel} caches a secret`);
  }
});

test('every screen of the buying features draws in the seller’s brand: no string names the platform, and each language has the same lines', () => {
  for (const feature of FEATURES) {
    const text = fs.readFileSync(path.join(ROOT, `apps/shopper/src/features/${feature}/index.js`), 'utf8');
    const at = text.indexOf('strings:');
    if (at < 0) continue;
    const block = text.slice(at);
    const hi = block.indexOf('hi: {');
    assert.ok(hi > 0, `${feature} has Hindi lines`);
    const keys = (part) => new Set([...part.matchAll(/'([a-z-]+\.[A-Za-z0-9_.]+)':/g)].map((m) => m[1]));
    const english = keys(block.slice(0, hi));
    const hindi = keys(block.slice(hi));
    assert.deepEqual([...english].filter((k) => !hindi.has(k)), [], `${feature}: lines missing in Hindi`);
    assert.deepEqual([...hindi].filter((k) => !english.has(k)), [], `${feature}: lines missing in English`);
    assert.ok(!/bhava/i.test(block.replace(/@bhava\/[a-z-]+/g, '')), `${feature}: a string names the platform`);
  }
  const shared = fs.readFileSync(path.join(ROOT, MAY_NAME_PLATFORM), 'utf8');
  assert.match(shared, /const PLATFORM = /, 'the one platform-named screen takes the name from one constant');
});

test('photos and videos go as multipart parts by their address on the phone, never read into the app', async () => {
  const seen = [];
  const Real = globalThis.FormData;
  globalThis.FormData = class { append(key, value) { seen.push([key, value]); } };
  try {
    const picker = { launchImageLibraryAsync: async (options) => ({ canceled: false, assets: [{ uri: 'file:///a.jpg', fileName: 'a.jpg' }, { uri: 'file:///b.mov', type: 'video' }, { uri: 'file:///c', mimeType: 'image/png' }].map((a) => ({ ...a, _o: options.selectionLimit })) }) };
    const files = await pickFiles({ picker, limit: 2, video: true });
    assert.equal(files.length, 2, 'no more than the limit');
    assert.deepEqual(files[0], { uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg' });
    assert.equal(partOf({ uri: 'file:///x.mp4' }, 0).type, 'video/mp4');
    assert.equal(PROOF_MAX_FILES, 4);
    formWith({ items: '[]', reason: 'torn' }, 'proof', files);
    assert.deepEqual(seen.map(([key]) => key), ['items', 'reason', 'proof', 'proof']);
    assert.deepEqual(seen[2][1], files[0]);
    assert.deepEqual(await pickFiles({ picker: { launchImageLibraryAsync: async () => ({ canceled: true }) }, limit: 3 }), []);
  } finally {
    globalThis.FormData = Real;
  }
});
