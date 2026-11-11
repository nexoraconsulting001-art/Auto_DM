// What the Phase 4 tracks build against: the requirement list, the module folders, the API contract, the buyer store's routes,
// the consent interface and the shopper-message gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_ONLY, RefundCreate, StockAdjust, routeList } from '../../../src/contracts/api/index.js';
import { RESERVED_PATHS } from '../../../src/contracts/buyer-pages.js';
import { INDIAN_STATES, PINCODE, STORE_LIMITS, stateCodeOf } from '../../../src/contracts/orders.js';
import { MESSAGE_REASONS, PLATFORM_NAME, quietUntil } from '../../../src/contracts/shopper-messages.js';
import { AddressInput, CartLine, CheckoutPlace, CheckoutQuote, OtpVerify, STORE_PROVIDER_PATHS, STORE_ROUTES } from '../../../src/contracts/store-routes.js';
import { ProviderError } from '../../../src/adapters/http.js';
import { MODULES } from '../../../src/modules/index.js';
import { createShopperMessages } from '../../../src/modules/shopper-messages/index.js';
import { CONSENT_NOT_ASKED, ConsentNotReadyError, createConsent } from '../../../src/platform/consent.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { withTenant } from '../../../src/tenancy.js';
import { OWNER, TEST_DATA_KEY, login, startApp } from '../../helpers.js';
import { query, world } from './support.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const requirements = JSON.parse(fs.readFileSync(path.join(repoRoot, 'requirements/p4.json'), 'utf8'));

/** Which module answers each Phase 4 group of routes. */
const OWNERS = {
  orderDownloads: 'orders', paymentSettings: 'payments', paymentAccount: 'payments', payments: 'payments', settlements: 'payments', refunds: 'refunds',
  shippingSettings: 'shipping', shipping: 'shipping', shipments: 'shipping', inventory: 'inventory', inventorySettings: 'inventory', invoiceSettings: 'invoices', invoices: 'invoices',
  returnSettings: 'returns', returns: 'returns', coupons: 'coupons', reviews: 'reviews', wishlist: 'wishlist', loyaltySettings: 'loyalty', loyalty: 'loyalty',
  alertSettings: 'order-alerts', whatsappAccount: 'order-alerts', whatsappTemplates: 'order-alerts', orderAlerts: 'order-alerts', cartReminders: 'abandoned-cart', shopify: 'shopify-sync',
  shoppers: 'shoppers', shopperDownloads: 'shoppers', privacy: 'consent', policies: 'consent', consentNotice: 'consent', dataRequests: 'consent',
};
const NEW_ORDER_IDS = ['orders.timeline', 'orders.advance', 'orders.cancel', 'orders.releaseHold', 'orders.reinstate', 'orders.addNote'];
const P4_MODULES = ['storefront', 'cart', 'checkout', 'orders', 'inventory', 'coupons', 'shoppers', 'consent', 'payments', 'refunds', 'shipping', 'invoices', 'returns', 'reviews', 'wishlist', 'loyalty', 'order-alerts', 'abandoned-cart', 'shopify-sync'];
const isPhase4 = (route) => OWNERS[route.id.split('.')[0]] || NEW_ORDER_IDS.includes(route.id);

test('requirements/p4.json lists every S scenario of PRD 9 once, with a short title', () => {
  const ids = requirements.map((r) => r.id);
  assert.equal(ids.length, 104);
  assert.deepEqual([...ids].sort(), Array.from({ length: 104 }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`).sort());
  for (const r of requirements) {
    assert.deepEqual(Object.keys(r), ['id', 'title']);
    assert.ok(r.title.length > 0 && r.title.length <= 80, r.id);
    assert.equal(/bhava/i.test(r.title), false, r.id);
  }
  for (const earlier of ['p0', 'p1', 'p2', 'p3']) {
    const theirs = JSON.parse(fs.readFileSync(path.join(repoRoot, `requirements/${earlier}.json`), 'utf8')).map((r) => r.id);
    assert.deepEqual(ids.filter((id) => theirs.includes(id)), [], `no id is also in ${earlier}.json`);
  }
});

test('each Phase 4 track has its own folder, listed after the Phase 3 pages and before the console', () => {
  const names = MODULES.map((m) => m.name);
  for (const name of P4_MODULES) {
    assert.ok(names.includes(name), name);
    assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules', name, 'index.js')), name);
    assert.ok(names.indexOf(name) > names.indexOf('leads'), `${name} after the Phase 3 pages`);
    assert.ok(names.indexOf(name) > names.indexOf('traffic'), `${name} after traffic, so its pages are counted`);
    assert.ok(names.indexOf(name) < names.indexOf('admin-console'), `${name} before the console`);
  }
  assert.equal(names.indexOf('storefront'), names.indexOf('admin-console') - 1, 'the storefront is the last of them');
  assert.equal(typeof MODULES.find((m) => m.name === 'storefront').lastRoutes, 'function', 'its pages and 404 mount after everything');
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/routes/store.js')), false, 'the Phase 0 store routes moved into the modules');
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/routes/account.js')), false);
});

test('every Phase 4 route belongs to the module named for it, and every route in the contract has exactly one answer', () => {
  const answers = new Map();
  for (const module of MODULES) {
    for (const id of Object.keys(module.api?.({ repos: {}, config: {}, ig: {}, auth: {} }) ?? {})) {
      assert.equal(answers.has(id), false, `${id} is answered by both ${answers.get(id)} and ${module.name}`);
      answers.set(id, module.name);
    }
  }
  const phase4 = routeList.filter(isPhase4);
  assert.equal(phase4.length, 97, `found ${phase4.length}`);
  for (const route of phase4) assert.equal(answers.get(route.id), OWNERS[route.id.split('.')[0]] ?? 'orders', route.id);
  for (const id of ['orders.list', 'orders.get', 'orders.setStatus']) assert.equal(answers.get(id), 'admin-api', `${id} stays with admin-api until the orders module takes it over`);
  for (const route of routeList) assert.ok(answers.has(route.id), `${route.id} has no module`);
  // The client's test walks every route with one id in the path at most.
  for (const route of phase4) assert.ok(!route.path.includes(':') || (route.path.match(/:/g).length === 1 && route.path.includes(':id')), route.id);
  assert.deepEqual(phase4.filter((r) => /raw|export/i.test(`${r.id} ${r.path}`)).map((r) => r.id), []);
});

test('who may do what: refunds and the customer list are the owner’s, and no route takes an order amount', () => {
  const byId = Object.fromEntries(routeList.map((r) => [r.id, r]));
  for (const id of ['refunds.create', 'refunds.retry', 'shopperDownloads.create', 'paymentAccount.setMode', 'loyalty.adjust', 'dataRequests.create', 'shopify.connect', 'whatsappAccount.connect', 'invoiceSettings.update']) {
    assert.equal(byId[id].access, OWNER_ONLY, `${id} is owner only`);
  }
  // S-29: a manager is refused by the access rule itself.
  assert.deepEqual([...byId['refunds.create'].access.roles], ['owner']);
  assert.equal(RefundCreate.safeParse({ amountPaise: 20000, idempotencyKey: 'refund-key-1', password: 'x' }).success, true);
  assert.equal(RefundCreate.safeParse({ amountPaise: 0, idempotencyKey: 'refund-key-1', password: 'x' }).success, false);
  assert.equal(RefundCreate.safeParse({ amountPaise: 20000, idempotencyKey: 'refund-key-1' }).success, false, 'a fresh re-auth is part of the request');
  assert.equal(RefundCreate.safeParse({ amountPaise: 199.5, idempotencyKey: 'refund-key-1', password: 'x' }).success, false, 'whole paise');
  assert.equal(StockAdjust.safeParse({ productId: 1, stock: 5 }).success, true);
  assert.equal(StockAdjust.safeParse({ productId: 1, stock: 5, delta: 1 }).success, false);
  // Order-moving routes take a move, never a total.
  for (const id of ['orders.advance', 'orders.cancel', 'shipments.create', 'returns.receive']) {
    const keys = Object.keys(byId[id].body.shape ?? {});
    assert.deepEqual(keys.filter((k) => /paise|total|price|amount/i.test(k)), [], id);
  }
  assert.deepEqual(Object.keys(byId['alertSettings.get'].response.shape.channels.element.enum ?? byId['alertSettings.get'].response.shape.channels.element.def.entries).sort(), ['email', 'whatsapp'], 'S-96: no SMS');
});

test('a Phase 4 route not built yet answers 501, and the Phase 0 store still answers through the modules', async () => {
  const app = await startApp();
  try {
    const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();
    const headers = { authorization: `Bearer ${token}` };
    for (const route of ['/coupons', '/payment-settings', '/shipping-settings', '/inventory', '/returns', '/reviews', '/loyalty/settings', '/alert-settings', '/shopify', '/shoppers', '/privacy', '/settlements', '/order-downloads']) {
      const res = await fetch(`${app.base}/api/v1${route}`, { headers });
      assert.equal(res.status, 501, route);
      assert.equal((await res.json()).code, 'not_implemented', route);
    }
    assert.equal((await fetch(`${app.base}/api/v1/orders`, { headers })).status, 200, 'the Phase 0 order list still answers');

    const product = await app.repos.products.create({ name: 'Brass lamp', price: '500', active: 'on' });
    const home = await fetch(`${app.base}/`);
    assert.equal(home.status, 200);
    assert.equal((await fetch(`${app.base}/p/${product.slug}`)).status, 200);
    assert.equal((await fetch(`${app.base}/shop?sort=constructor`)).status, 200, 'a sort the store does not define falls back, never a 500');
    const missing = await fetch(`${app.base}/nothing-here`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /doesn’t exist/, 'the store’s own 404, mounted last');
    assert.equal((await fetch(`${app.base}/api/products?ids=${product.id}`)).status, 200);
    const session = await login(app.base);
    assert.equal(session.location, '/admin', 'a seller still signs in at /login');
    assert.equal((await fetch(`${app.base}/checkout`, { headers: { cookie: session.cookie } })).status, 200);
    // An email far too long to be one is refused quickly, not matched against.
    const started = Date.now();
    const res = await fetch(`${app.base}/api/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [{ productId: product.id, qty: 1 }], customer: { name: 'Asha Rao', phone: '9876543210', email: `${'a'.repeat(60000)}@`, address: '12 Lake Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' } }),
    });
    assert.equal(res.status, 400);
    assert.ok(Date.now() - started < 2000);
  } finally {
    app.close();
  }
});

test('the buyer store’s routes each have one owner among the modules, no two share an address, and their first segments are reserved', () => {
  const names = MODULES.map((m) => m.name);
  const seen = new Set();
  for (const [id, route] of Object.entries({ ...STORE_ROUTES, ...STORE_PROVIDER_PATHS })) {
    assert.ok(names.includes(route.owner) && P4_MODULES.includes(route.owner), `${id} is owned by a Phase 4 module`);
    assert.match(route.path, /^\/[\w./:-]*$/, id);
    const key = `${route.method} ${route.path}`;
    assert.equal(seen.has(key), false, `${key} is listed twice`);
    seen.add(key);
    const first = route.path.split('/')[1];
    if (first && !first.startsWith(':')) assert.ok(RESERVED_PATHS.includes(first.toLowerCase()), `"${first}" is reserved, so no creator page can take it (${id})`);
  }
  const named = Object.entries(STORE_ROUTES).filter(([, r]) => r.platformNamed).map(([id]) => id);
  assert.deepEqual(named, ['sharedConsent'], 'S-101: one buyer page may name the platform');
  for (const [id, route] of Object.entries(STORE_ROUTES)) if (route.kind === 'json' && route.path.startsWith('/api/')) assert.ok(route.path.startsWith('/api/store/'), `${id} is under /api/store`);
  for (const [id, route] of Object.entries(STORE_PROVIDER_PATHS)) assert.equal(/shiprocket|kartrocket/i.test(route.path), false, `${id}: the courier refuses an address with its name in it`);
});

test('S-05: no buyer call can carry a price, a total or a discount; the server works out every amount', () => {
  const lines = [{ productId: 1, variantId: null, qty: 2 }];
  assert.equal(CartLine.safeParse({ productId: 1, qty: 2 }).success, true);
  for (const extra of [{ pricePaise: 100 }, { unitPaise: 1 }, { price: 1 }, { total: 1 }]) assert.equal(CartLine.safeParse({ productId: 1, qty: 2, ...extra }).success, false, JSON.stringify(extra));
  const address = { name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' };
  const place = { lines, address, paymentMode: 'prepaid', idempotencyKey: 'attempt-0001', acceptTerms: true, consent: { noticeVersion: 1 } };
  assert.equal(CheckoutPlace.safeParse(place).success, true);
  for (const extra of [{ totalPaise: 100 }, { subtotalPaise: 1 }, { discountPaise: 99999 }, { shippingPaise: 0 }, { codFeePaise: 0 }, { advancePaise: 1 }, { amount: 1 }]) {
    assert.equal(CheckoutPlace.safeParse({ ...place, ...extra }).success, false, `checkout refuses ${Object.keys(extra)[0]}`);
    assert.equal(CheckoutQuote.safeParse({ lines, address, ...extra }).success, false, `a quote refuses ${Object.keys(extra)[0]}`);
  }
  assert.equal(CheckoutPlace.safeParse({ ...place, acceptTerms: false }).success, false, 'the terms are accepted before paying');
  assert.equal(CheckoutPlace.safeParse({ ...place, idempotencyKey: undefined }).success, false, 'S-15');
  const parsed = CheckoutPlace.parse(place);
  assert.deepEqual([parsed.consent.marketing, parsed.saveDetails, parsed.redeemPoints], [{ whatsapp: false, email: false }, false, 0], 'marketing and saving details are off unless ticked');
  // S-12
  const badPin = AddressInput.safeParse({ ...address, pincode: '012345' });
  assert.equal(badPin.success, false);
  assert.equal(badPin.error.issues[0].message, 'Enter a 6-digit PIN code');
  assert.equal(PINCODE.test('411001'), true);
  assert.equal(OtpVerify.safeParse({ phone: '9876543210', purpose: 'cod', code: '12345' }).success, false, 'six digits');
  assert.equal(OtpVerify.safeParse({ phone: '9876543210', purpose: 'sms', code: '123456' }).success, false, 'there is no SMS');
  assert.deepEqual([STORE_LIMITS.maxQtyPerLine, STORE_LIMITS.maxCartLines, STORE_LIMITS.otp.wrongTries, STORE_LIMITS.otp.sendsPerHour, STORE_LIMITS.holdMinutes, STORE_LIMITS.orderAttempts.limit], [10, 50, 3, 5, 30, 20]);
  assert.equal(stateCodeOf('delhi'), '07');
  assert.equal(INDIAN_STATES[27], 'Maharashtra');
});

test('consent: no by default, never assumed and never silently dropped; the consent module answers once it registers', async () => {
  const w = await world();
  const consent = createConsent();
  assert.equal(consent.built, false);
  await assert.rejects(() => consent.allows({ purpose: 'marketing', channel: 'whatsapp', shopperId: 1 }), /tenant context/, 'it is business data');
  await w.inTenant(async () => {
    assert.equal(await consent.allows({ purpose: 'marketing', channel: 'whatsapp', shopperId: 1 }), CONSENT_NOT_ASKED);
    assert.equal(await consent.analyticsAndAds({ visitorId: 'v' }), CONSENT_NOT_ASKED);
    assert.deepEqual(await consent.status({ shopperId: 1 }), []);
    assert.equal(await consent.notice(), null);
    await assert.rejects(() => consent.record({ subject: { shopperId: 1 }, choices: [{ purpose: 'fulfilment', granted: true }], noticeVersion: 1, source: 'checkout' }), ConsentNotReadyError);
    await assert.rejects(() => consent.revoke({ subject: { shopperId: 1 }, purpose: 'marketing', channel: 'email', source: 'account' }), ConsentNotReadyError);
    await assert.rejects(() => consent.allows({ purpose: 'marketing', shopperId: 1 }), /per channel/);
    await assert.rejects(() => consent.allows({ purpose: 'selling_data', shopperId: 1 }), /Unknown consent purpose/);
  });

  assert.throws(() => consent.use({ allows() {} }), /needs record\(\)/);
  const ledger = [];
  const provider = {
    allows: async (q) => {
      const last = ledger.filter((r) => r.shopperId === q.shopperId && r.purpose === q.purpose && (r.channel ?? '') === (q.channel ?? '')).at(-1);
      return last ? { granted: last.granted, answered: true } : { granted: false, answered: false };
    },
    record: async (entry) => {
      for (const choice of entry.choices) ledger.push({ ...entry.subject, ...choice });
      return { recorded: entry.choices.length };
    },
    revoke: async (entry) => {
      ledger.push({ ...entry.subject, purpose: entry.purpose, channel: entry.channel, granted: false });
      return { recorded: 1 };
    },
    status: async () => ledger,
    notice: async () => ({ version: 1, bodyEn: 'We use your details to deliver your order.', bodyHi: 'हम आपके विवरण का उपयोग आपका ऑर्डर पहुँचाने के लिए करते हैं।' }),
  };
  consent.use(provider);
  assert.equal(consent.built, true);
  assert.throws(() => consent.use(provider), /already registered/);
  await w.inTenant(async () => {
    const subject = { shopperId: 1 };
    assert.deepEqual(await consent.allows({ purpose: 'marketing', channel: 'whatsapp', ...subject }), { granted: false, answered: false, reason: 'not_granted' });
    assert.deepEqual(await consent.allows({ purpose: 'marketing', channel: 'whatsapp' }), { granted: false, answered: false, reason: 'consent.no_subject' });
    await consent.record({ subject, choices: [{ purpose: 'fulfilment', granted: true }, { purpose: 'order_updates', channel: 'whatsapp', granted: true }, { purpose: 'marketing', channel: 'whatsapp', granted: true }], noticeVersion: 1, source: 'checkout' });
    // S-60, S-64: each purpose and channel is its own yes.
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'whatsapp', ...subject })).granted, true);
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'email', ...subject })).granted, false);
    await consent.revoke({ subject, purpose: 'marketing', channel: 'whatsapp', source: 'unsubscribe' });
    assert.equal((await consent.allows({ purpose: 'marketing', channel: 'whatsapp', ...subject })).granted, false);
    assert.equal((await consent.allows({ purpose: 'order_updates', channel: 'whatsapp', ...subject })).granted, true);
    await assert.rejects(() => consent.record({ subject, choices: [{ purpose: 'marketing', channel: 'sms', granted: true }], noticeVersion: 1, source: 'checkout' }), /whatsapp or email/);
    await assert.rejects(() => consent.record({ subject, choices: [{ purpose: 'fulfilment', granted: 'yes' }], noticeVersion: 1, source: 'checkout' }), /yes or a no/);
    await assert.rejects(() => consent.record({ subject, choices: [{ purpose: 'fulfilment', granted: true }], source: 'checkout' }), /notice version/);
    await assert.rejects(() => consent.record({ subject: {}, choices: [{ purpose: 'fulfilment', granted: true }], noticeVersion: 1, source: 'checkout' }), /who it is about/);
    // A provider that answers something odd is a no.
    provider.allows = async () => ({ granted: 'true' });
    assert.equal((await consent.allows({ purpose: 'analytics_ads', visitorId: 'v' })).granted, false);
  });
});

test('the shopper-message gate: consent first, quiet hours, an approved template, the seller’s brand, and never twice on a guess', async () => {
  const w = await world();
  const secrets = createSecrets({ dataKey: TEST_DATA_KEY });
  const sends = [];
  const whatsapp = { sendTemplate: async (account, message) => { sends.push({ account, message }); return { messageId: 'wamid.1' }; } };
  const email = { driver: 'http', send: async (message) => { sends.push({ email: message }); return { messageId: 'msg_1' }; } };
  const yes = new Set();
  const consent = { allows: async (q) => ({ granted: yes.has(`${q.purpose}:${q.channel}`), answered: true, reason: 'not_granted' }) };
  const gate = createShopperMessages({ db: w.db, platform: { consent, secrets }, providers: { whatsapp, email }, config: { emailNeutralDomain: 'mail.shopsdomain.example' } });
  const noon = new Date('2026-11-11T12:00:00+05:30');
  const paid = { channel: 'whatsapp', purpose: 'order_update', to: { shopperId: 1, phone: '+91 98765 43210' }, template: { purpose: 'order_paid', params: ['MM-1001'] }, orderId: 5, now: noon };

  await assert.rejects(() => gate.send(paid), /tenant context/);
  await w.inTenant(async () => {
    assert.deepEqual(await gate.send(paid), { outcome: 'skipped', reason: MESSAGE_REASONS.noConsent }, 'S-60: no yes, no message');
    yes.add('order_updates:whatsapp');
    assert.deepEqual(await gate.send(paid), { outcome: 'skipped', reason: MESSAGE_REASONS.noChannel }, 'the business has not connected WhatsApp');
    await w.db.query(`INSERT INTO whatsapp_accounts (tenant_id, waba_id, phone_number_id, access_token_enc) VALUES ($1, '777', '555', $2)`, [w.tenant.id, secrets.encrypt('business-token')]);
    await w.db.query(`INSERT INTO whatsapp_templates (tenant_id, purpose, category, name, status) VALUES ($1, 'order_paid', 'utility', 'order_paid_v1', 'pending'), ($1, 'otp', 'authentication', 'login_code', 'approved'), ($1, 'cart_reminder', 'marketing', 'cart_reminder_v1', 'approved')`, [w.tenant.id]);
    assert.deepEqual(await gate.send(paid), { outcome: 'skipped', reason: MESSAGE_REASONS.templatePending }, 'S-53');
    assert.equal(sends.length, 0);
    await w.db.query(`UPDATE whatsapp_templates SET status = 'approved' WHERE tenant_id = $1 AND purpose = 'order_paid'`, [w.tenant.id]);
    assert.deepEqual(await gate.send(paid), { outcome: 'sent', reason: 'ok', messageId: 'wamid.1' });
    assert.deepEqual([sends[0].account.accessToken, sends[0].account.phoneNumberId, sends[0].message.to, sends[0].message.name], ['business-token', '555', '919876543210', 'order_paid_v1'], 'on the business’s own number');
    assert.deepEqual(await gate.check(paid), { outcome: 'sent', reason: 'ok' }, 'check sends nothing');
    assert.equal(sends.length, 1);

    // A login code needs no consent; the person asked for it.
    const code = { channel: 'whatsapp', purpose: 'authentication', to: { phone: '+919876543210' }, template: { purpose: 'otp', params: ['482913'] }, now: new Date('2026-11-11T23:30:00+05:30') };
    assert.equal((await gate.send(code)).outcome, 'sent', 'even at night');
    // Marketing needs its own yes, and waits out the night (S-50, S-51).
    const reminder = { channel: 'whatsapp', purpose: 'marketing', to: { shopperId: 1, phone: '+919876543210' }, template: { purpose: 'cart_reminder', params: ['Asha'] }, now: new Date('2026-11-11T23:00:00+05:30') };
    assert.deepEqual(await gate.send(reminder), { outcome: 'skipped', reason: MESSAGE_REASONS.noConsent }, 'a yes to order updates is not a yes to marketing');
    yes.add('marketing:whatsapp');
    const deferred = await gate.send(reminder);
    assert.deepEqual([deferred.outcome, deferred.reason, deferred.until.toISOString()], ['deferred', 'quiet_hours', new Date('2026-11-12T09:00:00+05:30').toISOString()]);
    assert.equal((await gate.send({ ...reminder, now: noon })).outcome, 'sent');
    assert.deepEqual(await gate.send({ ...reminder, channel: 'instagram' }), { outcome: 'skipped', reason: 'invalid' }, 'S-51: there is no DM channel here');
    assert.deepEqual(await gate.send({ ...reminder, channel: 'sms' }), { outcome: 'skipped', reason: 'invalid' }, 'nor SMS');
    assert.deepEqual(await gate.send({ ...paid, to: { shopperId: 1, phone: '' } }), { outcome: 'skipped', reason: MESSAGE_REASONS.noAddress });
    assert.deepEqual(await gate.send({ ...paid, template: { purpose: 'order_paid', params: ['Thanks from Bhava'] } }), { outcome: 'skipped', reason: MESSAGE_REASONS.platformName }, 'S-101');

    // Email: from the neutral domain unless the business has its own, with an unsubscribe link on anything that is marketing.
    const mail = { channel: 'email', purpose: 'order_update', to: { shopperId: 1, email: 'asha@example.test' }, email: { subject: 'Your order MM-1001 is paid', html: '<p>Thank you.</p>', text: 'Thank you.' }, dedupeKey: 'order-5-paid-email', now: noon };
    yes.add('order_updates:email');
    const before = sends.length;
    assert.equal((await gate.send(mail)).outcome, 'sent');
    assert.deepEqual([sends[before].email.from, sends[before].email.fromName, sends[before].email.idempotencyKey], ['orders@mail.shopsdomain.example', 'Test store', 'order-5-paid-email']);
    yes.add('marketing:email');
    assert.deepEqual(await gate.send({ ...mail, purpose: 'marketing' }), { outcome: 'skipped', reason: MESSAGE_REASONS.noUnsubscribe });
    assert.equal((await gate.send({ ...mail, purpose: 'marketing', email: { ...mail.email, unsubscribeUrl: 'https://shop.example/unsubscribe/abc' } })).outcome, 'sent');
    assert.match(sends.at(-1).email.headers['List-Unsubscribe'], /unsubscribe\/abc/);

    // The provider's answer is lost: it may have gone out, so it is failed and not to be retried. A plain refusal can be.
    whatsapp.sendTemplate = async () => { throw new ProviderError({ provider: 'whatsapp', kind: 'timeout', delivery: 'unknown' }); };
    assert.deepEqual(await gate.send(paid), { outcome: 'failed', reason: MESSAGE_REASONS.unknownDelivery, retryable: false, kind: 'timeout', code: '' }, 'S-54: never sent twice on a guess');
    whatsapp.sendTemplate = async () => { throw new ProviderError({ provider: 'whatsapp', kind: 'throttled', status: 429, delivery: 'none' }); };
    assert.equal((await gate.send(paid)).retryable, true);
    // Consent that cannot be read is a no.
    consent.allows = async () => { throw new Error('database down'); };
    assert.deepEqual(await gate.send(paid), { outcome: 'skipped', reason: MESSAGE_REASONS.consentUnknown });
  });
  assert.equal(PLATFORM_NAME.test('Powered by BHAVA'), true);
  assert.equal(quietUntil(new Date('2026-11-11T08:59:00+05:30')).toISOString(), new Date('2026-11-11T09:00:00+05:30').toISOString());
  assert.equal(quietUntil(new Date('2026-11-11T09:00:00+05:30')), null);
  assert.equal(quietUntil(new Date('2026-11-11T20:59:00+05:30')), null);
  assert.ok(await query(w, 'SELECT 1'));
  await withTenant(w.tenant, async () => {});
});

test('nothing but the gate sends to WhatsApp or by email, and the app wires the bus, the gate and the adapters', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && !rel.startsWith('src/modules/shopper-messages/') && !rel.startsWith('src/adapters/whatsapp/') && !rel.startsWith('src/adapters/email/')) {
        const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        if (/\.sendTemplate\(|providers\??\.email\??\.send\(|\bemail\.send\(|adapters\/whatsapp|adapters\/email/.test(source) && rel !== 'src/adapters/store.js') offenders.push(rel);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'a message to a shopper goes through ctx.shopperMessages');

  const app = await startApp();
  try {
    const { ctx } = app;
    assert.equal(typeof ctx.shopperMessages.send, 'function');
    assert.equal(typeof ctx.orderEvents.on, 'function');
    assert.equal(typeof ctx.platform.rateLimit.hit, 'function');
    assert.equal(typeof ctx.platform.consent.use, 'function');
    assert.deepEqual(Object.keys(ctx.providers).sort(), ['email', 'razorpay', 'shiprocket', 'shopify', 'whatsapp']);
    assert.equal(ctx.providers.razorpay.default.kind, 'route', 'Bhava-managed is the default');
    assert.equal(ctx.platform.consent.built, false, 'until the consent track registers');
  } finally {
    app.close();
  }
});
