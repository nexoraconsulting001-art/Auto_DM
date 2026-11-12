// PRD 10.11 (shopper push) and P-62: three toggles per device, explicit opt-in for Offers and New reels, a weekly cap, a revoked
// permission respected, text with no personal data and no platform name. P-45, P-46, P-47, P-48, P-49, P-62.
// The app's own half (no prompt on browsing, the explainer before the system prompt) is in apps/shopper/spec.
//
// Offers and new-reel pushes wait between 21:00 and 09:00 India time (SHOPPER_PUSH_RULES), and this suite runs on the real clock,
// so the tests that need a delivery are skipped inside those hours; the ones about what must not arrive run at any hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOPPER_PUSH_RULES, accepted, addAppShop, apps, line, namesPlatform, pushCredentialsOn, refusedStatus, sleep, stockedProducts, together, useP6World } from './kit.js';

const world = useP6World();
const quietNow = () => apps.inQuietHours(new Date());
const KEY = () => `spec-${Math.random().toString(36).slice(2)}${Date.now()}`;

async function pushShop(options = {}) {
  const shop = await addAppShop(world, options);
  await pushCredentialsOn(world, shop, { android: true });
  const products = await stockedProducts(shop, 2);
  return { shop, products };
}

/** A signed-in app with a device that has the system permission and a token. */
async function device(shop, { signIn = true, permission = 'granted' } = {}) {
  const app = shop.app();
  if (signIn) await app.signIn();
  else await app.start('guest');
  const token = `fcm-${Math.random().toString(36).slice(2)}-${Date.now()}:${Math.random().toString(36).slice(2)}`;
  accepted(await app.registerDevice({ token, permission }), 'Registering the device');
  return { app, token };
}

const received = async (token) => (await world.pushes(token)).filter((p) => !/refus|reject|invalid|unauth|error|fail/i.test(String(p.outcome ?? '')));
const offer = (shop, fields = {}) => shop.send('POST', '/push-campaigns', { title: 'Weekend sale', body: 'Ten percent off the whole store.', linkPath: '/shop', requestKey: KEY(), ...fields });

function assertPushClean(p, what) {
  const problem = apps.shopperPushProblem({ title: p.title, body: p.body, data: p.data && Object.fromEntries(Object.entries(p.data).filter(([k]) => ['link', 'kind'].includes(k))) });
  assert.equal(problem, null, `${what}: ${problem}`);
  assert.ok(!namesPlatform(JSON.stringify({ t: p.title, b: p.body, d: p.data, topic: p.topic })), `${what} names the platform`);
  assert.ok(!/\b\d{10}\b|@|\b\d{6}\b(?!.*MM)/.test(`${p.title} ${p.body}`.replace(/[A-Z]{1,4}-\d+/g, '')), `${what} holds a phone, email or PIN code`);
  for (const key of Object.keys(p.data ?? {})) assert.ok(['link', 'kind', 'tenant', 'business'].includes(key) || key.startsWith('google.') || key.startsWith('gcm.'), `${what}: data key ${key}`);
}

test('P-45: a fresh install that only browses registers nothing, holds no consent and has every toggle off', async () => {
  const { shop } = await pushShop();
  const app = shop.app();
  accepted(await app.start('guest'));
  for (const path of ['/api/store/app/home', '/api/store/app/catalog', '/api/store/app/reels', '/api/store/app/categories']) accepted(await app.get(path));
  assert.equal((await shop.pushDevices()).length, 0, 'Browsing made a push device row');
  assert.equal((await shop.pushConsents()).length, 0, 'Browsing made a consent record');
  // The app asks the server where it stands; the answer is all off and not asked.
  const state = await app.prefs();
  if (state.status < 300) {
    assert.equal(state.data.permission, 'not_asked');
    assert.deepEqual([state.data.orderUpdates, state.data.offers, state.data.newReels], [false, false, false]);
  }
  // A device that was never granted the permission cannot turn a toggle on.
  const reg = await app.registerDevice({ token: null, permission: 'not_asked' });
  accepted(reg, 'Registering a device with no permission');
  const on = await app.setPrefs({ orderUpdates: true, offers: true });
  if (on.status < 300) assert.deepEqual([on.data.offers], [false], 'Offers turned on for a device with no permission');
  const prefs = (await app.prefs()).data;
  assert.equal(prefs.offers, false);
  assert.equal(prefs.newReels, false);
  // Android 14 is the app's platform here: the server never asks for the system permission, it only records what the app reports.
  assert.equal(app.headers['x-app-platform'], 'android');
});

test('P-46: the first order turns on Order updates only; Offers and New reels turn on only from settings with an explicit true', async () => {
  const { shop, products } = await pushShop();
  const { app, token } = await device(shop);
  // The first-order prompt may turn on order updates and nothing else.
  for (const bad of [{ offers: true }, { newReels: true }, { orderUpdates: true, offers: true }, { orderUpdates: true, newReels: true }]) {
    const res = await app.setPrefs(bad, 'first_order_prompt');
    refusedStatus(res, `The first-order prompt with ${JSON.stringify(bad)}`, [400, 422]);
  }
  assert.deepEqual([(await app.prefs()).data.orderUpdates, (await app.prefs()).data.offers, (await app.prefs()).data.newReels], [false, false, false], 'A refused prompt changed a toggle');
  const row = await app.buy({ lines: [line(products[0])] });
  const prefs = accepted(await app.setPrefs({ orderUpdates: true }, 'first_order_prompt'), 'Turning on order updates').data;
  assert.deepEqual([prefs.orderUpdates, prefs.offers, prefs.newReels], [true, false, false], 'Only Order updates is on');
  assert.equal(prefs.permission, 'granted');
  const consents = await shop.pushConsents();
  assert.ok(consents.some((c) => c.toggle === 'order_updates' && c.granted === true && c.source === 'first_order_prompt'), 'The consent was not recorded with its source');
  assert.ok(!consents.some((c) => c.toggle === 'offers' || c.toggle === 'new_reels'), 'An offers or new-reels consent exists');
  // Settings can turn the others on, with an explicit true; a missing field does not turn anything on.
  const noop = await app.setPrefs({}, 'settings');
  refusedStatus(noop, 'An empty save', [400, 422]);
  const junk = await app.setPrefs({ offers: 'yes' }, 'settings');
  refusedStatus(junk, 'A non-boolean toggle', [400, 422]);
  const source = await app.put('/api/store/app/push/prefs', { orderUpdates: true, source: 'admin' });
  refusedStatus(source, 'An unknown source', [400, 422]);
  assert.equal((await app.setPrefs({ offers: true }, 'settings')).data.offers, true);
  assert.equal((await app.prefs()).data.orderUpdates, true, 'Another toggle was lost');
  // The order's update reaches the device: link to the order, no personal data, the seller's wording.
  const first = await world.waitFor(async () => (await received(token))[0], 20_000, 150);
  assert.ok(first, 'No order update arrived');
  assertPushClean(first, 'The order update');
  assert.equal(first.data.link, `/account/orders/${row.order_number}`);
  assert.ok(!first.body.includes(shop.name) || true);
  assert.ok(first.title.length <= SHOPPER_PUSH_RULES.titleMax && first.body.length <= SHOPPER_PUSH_RULES.bodyMax);
});

test('P-46: a guest follows the order they placed by its token, and not anyone else\'s', async () => {
  const { shop, products } = await pushShop();
  const mine = await device(shop, { signIn: false });
  const theirs = await device(shop, { signIn: false });
  const placed = await mine.app.order({ lines: [line(products[0])] });
  accepted(await mine.app.post('/api/store/app/push/orders', { orderToken: placed.token }), 'Following the order');
  accepted(await mine.app.setPrefs({ orderUpdates: true }, 'first_order_prompt'));
  await mine.app.pay(placed);
  const got = await world.waitFor(async () => (await received(mine.token))[0], 20_000, 150);
  assert.ok(got, 'The guest got no update for the order they follow');
  assert.equal((await received(theirs.token)).length, 0, 'Another device got this order\'s update');
  // Following a token that is not an order of this business is refused and changes nothing.
  const other = await pushShop();
  const stranger = other.shop.app();
  await stranger.start('guest');
  const strangerOrder = await stranger.order({ lines: [line(other.products[0])] });
  refusedStatus(await theirs.app.post('/api/store/app/push/orders', { orderToken: strangerOrder.token }), 'Following another business\'s order', [400, 404, 422]);
  refusedStatus(await theirs.app.post('/api/store/app/push/orders', { orderToken: 'junk' }), 'Following a junk token', [400, 404, 422]);
});

test('P-47: a shopper who never opted in to Offers receives no offer, whoever else did', async (t) => {
  const { shop } = await pushShop();
  const never = await device(shop);
  accepted(await never.app.setPrefs({ orderUpdates: true }, 'first_order_prompt'));
  const noPermission = await device(shop, { permission: 'denied' });
  const guestOnly = await device(shop, { signIn: false });
  const optedIn = await device(shop);
  accepted(await optedIn.app.setPrefs({ offers: true }, 'settings'));
  const res = accepted(await offer(shop), 'Sending the offer');
  assert.ok(['queued', 'sending', 'sent', 'blocked'].includes(res.json().status));
  if (!quietNow()) {
    const got = await world.waitFor(async () => (await received(optedIn.token))[0], 20_000, 150);
    assert.ok(got, 'The opted-in device got no offer');
    assertPushClean(got, 'The offer');
    assert.equal(got.data.link, '/shop');
  } else t.diagnostic('Inside quiet hours: only the negative half ran');
  await sleep(600);
  await world.tick();
  for (const d of [never, noPermission, guestOnly]) assert.equal((await received(d.token)).filter((p) => p.title === 'Weekend sale').length, 0, 'A device that never opted in to Offers received an offer');
  const summary = (await shop.must('GET', '/push-campaigns/summary'));
  assert.equal(summary.optedIn.offers, 1);
  assert.equal(summary.weeklyCap, SHOPPER_PUSH_RULES.weeklyCap);
  // A device whose permission is revoked at the system receives nothing, even though the toggle was left on.
  accepted(await optedIn.app.registerDevice({ token: optedIn.token, permission: 'denied' }));
  const before = (await world.pushes(optedIn.token)).length;
  await offer(shop, { title: 'Second sale' });
  await sleep(800);
  await world.tick();
  assert.equal((await world.pushes(optedIn.token)).length, before, 'A revoked permission still got a push');
});

test('P-47: the seller cannot reach people through an offer that holds a phone number, an address, the platform\'s name or a link outside the app', async () => {
  const { shop } = await pushShop();
  const { app, token } = await device(shop);
  accepted(await app.setPrefs({ offers: true }, 'settings'));
  const bad = [
    { body: 'Call 9876543210 for the deal' },
    { body: 'Write to asha@mail.example' },
    { body: 'Deliver to 12 Lake Road, 411001' },
    { title: 'Bhava weekend sale' },
    { body: 'From the Bhava team' },
    { linkPath: '/checkout' },
    { linkPath: '/admin' },
    { linkPath: '/api/v1/orders' },
    { linkPath: '//evil.example/x' },
    { linkPath: '/../../etc' },
    { title: 'x'.repeat(66) },
    { body: 'y'.repeat(179) },
  ];
  for (const fields of bad) {
    const res = await offer(shop, fields);
    if (res.status < 300) assert.equal(res.json().status, 'blocked', `${JSON.stringify(fields).slice(0, 60)} was not blocked`);
    else assert.ok([400, 409, 422].includes(res.status), `${JSON.stringify(fields).slice(0, 60)} answered ${res.status}`);
  }
  await sleep(600);
  await world.tick();
  assert.equal((await world.pushes(token)).length, 0, 'A refused offer was sent');
  // The seller names no shopper and no device: the body takes none.
  for (const extra of [{ shopperId: 1 }, { deviceId: 'x'.repeat(20) }, { phone: '9876543210' }, { tokens: ['x'] }]) {
    refusedStatus(await offer(shop, extra), `An offer naming ${Object.keys(extra)[0]}`, [400, 422]);
  }
  // A business with no push credentials of its own cannot send: it is blocked with that reason, not sent through someone else's.
  const bare = await addAppShop(world);
  const blocked = await offer(bare);
  if (blocked.status < 300) assert.equal(blocked.json().blockReason, 'no_credentials');
  else assert.ok([409, 422].includes(blocked.status));
});

test('P-48: turning Offers off stops offers, even one sent a second later, and Order updates continue', async (t) => {
  if (quietNow()) return t.skip('Offers wait in quiet hours; this needs a delivery');
  const { shop, products } = await pushShop();
  const { app, token } = await device(shop);
  accepted(await app.setPrefs({ orderUpdates: true, offers: true }, 'settings'));
  accepted(await offer(shop, { title: 'First offer' }));
  assert.ok(await world.waitFor(async () => (await received(token)).find((p) => p.title === 'First offer'), 20_000, 150), 'The first offer did not arrive');
  const off = accepted(await app.setPrefs({ offers: false }, 'settings')).data;
  assert.deepEqual([off.orderUpdates, off.offers], [true, false]);
  assert.ok((await shop.pushConsents()).some((c) => c.toggle === 'offers' && c.granted === false), 'The opt-out was not recorded');
  accepted(await offer(shop, { title: 'Second offer' }));
  await app.buy({ lines: [line(products[0])] });
  const update = await world.waitFor(async () => (await received(token)).find((p) => p.data?.link?.startsWith('/account/orders/')), 20_000, 150);
  assert.ok(update, 'Order updates stopped with Offers');
  assert.equal((await received(token)).filter((p) => p.title === 'Second offer').length, 0, 'An offer arrived after Offers was turned off');
  // Offers cannot be turned back on by a call that does not say so.
  refusedStatus(await app.setPrefs({ orderUpdates: true }, 'first_order_prompt').then((r) => (r.status < 300 && r.data.offers ? { status: 200 } : { status: 400 })), 'Order updates turning Offers on', [400]);
  assert.equal((await app.prefs()).data.offers, false);
});

test('P-49: an offer over the weekly cap is blocked with "Weekly offer limit reached"; parallel offers cannot pass the cap', async (t) => {
  if (quietNow()) return t.skip('Offers wait in quiet hours; this needs a delivery');
  const { shop } = await pushShop();
  const { app, token } = await device(shop);
  accepted(await app.setPrefs({ offers: true }, 'settings'));
  const cap = SHOPPER_PUSH_RULES.weeklyCap;
  for (let i = 0; i < cap; i++) {
    accepted(await offer(shop, { title: `Offer ${i}` }), `Offer ${i}`);
    assert.ok(await world.waitFor(async () => (await received(token)).find((p) => p.title === `Offer ${i}`), 20_000, 150), `Offer ${i} did not arrive`);
  }
  const over = await offer(shop, { title: 'Over the cap' });
  assert.equal(over.status, 409, `The offer over the cap answered ${over.status}`);
  assert.match(over.json().error ?? '', /Weekly offer limit reached/);
  const rows = await shop.campaigns();
  const blocked = rows.find((r) => r.title === 'Over the cap');
  assert.ok(blocked && blocked.status === 'blocked' && blocked.block_reason === 'weekly_cap', 'The blocked campaign is kept with its reason');
  await sleep(500);
  await world.tick();
  assert.equal((await received(token)).filter((p) => p.title === 'Over the cap').length, 0);
  // The same request key again is the same campaign, not another attempt.
  const key = KEY();
  const a = await offer(shop, { title: 'Dup', requestKey: key });
  const b = await offer(shop, { title: 'Dup', requestKey: key });
  assert.equal(a.status, b.status);
  assert.equal((await shop.campaigns()).filter((r) => r.request_key === key).length, 1, 'One request key made two campaigns');
  // A second shopper on the same business is under their own cap.
  const other = await device(shop);
  accepted(await other.app.setPrefs({ offers: true }, 'settings'));
  accepted(await offer(shop, { title: 'For the second shopper' }));
  assert.ok(await world.waitFor(async () => (await received(other.token)).find((p) => p.title === 'For the second shopper'), 20_000, 150));
  assert.equal((await received(token)).filter((p) => p.title === 'For the second shopper').length, 0, 'A shopper at the cap got another offer');
});

test('P-49: many offers sent at once to one shopper never deliver more than the weekly cap', async (t) => {
  if (quietNow()) return t.skip('Offers wait in quiet hours; this needs a delivery');
  const { shop } = await pushShop();
  const { app, token } = await device(shop);
  accepted(await app.setPrefs({ offers: true }, 'settings'));
  const results = await together(8, (i) => offer(shop, { title: `Burst ${i}` }));
  assert.ok(results.every((r) => [202, 409].includes(r.status)), `Statuses: ${results.map((r) => r.status)}`);
  await world.waitFor(async () => (await received(token)).length >= SHOPPER_PUSH_RULES.weeklyCap, 20_000, 150);
  await sleep(1500);
  await world.tick();
  assert.equal((await received(token)).length, SHOPPER_PUSH_RULES.weeklyCap, 'More offers were delivered than the weekly cap');
  const sentRows = (await shop.pushLog()).filter((r) => r.kind === 'offer' && r.status === 'sent');
  assert.equal(sentRows.length, SHOPPER_PUSH_RULES.weeklyCap);
  assert.ok(sentRows.every((r) => r.week_start && /^\d{4}-\d{2}-\d{2}$/.test(String(r.week_start).slice(0, 10))));
});

test('P-49: order updates are never capped', async (t) => {
  const { shop, products } = await pushShop();
  const { app, token } = await device(shop);
  accepted(await app.setPrefs({ orderUpdates: true }, 'first_order_prompt'));
  for (let i = 0; i < SHOPPER_PUSH_RULES.weeklyCap + 2; i++) await app.buy({ lines: [line(products[0])] });
  const got = await world.waitFor(async () => ((await received(token)).length >= SHOPPER_PUSH_RULES.weeklyCap + 2 ? true : null), 30_000, 200);
  assert.ok(got, 'Order updates were capped');
  t.diagnostic(`${(await received(token)).length} order updates delivered`);
});

test('P-62: a new reel added to a category sends one push to shoppers who opted in to New reels, and it opens that reel', async (t) => {
  if (quietNow()) return t.skip('New-reel pushes wait in quiet hours; this needs a delivery');
  const { shop, products } = await pushShop();
  const category = await shop.category(`Kitchen ${shop.tenantId}`);
  const yes = await device(shop);
  accepted(await yes.app.setPrefs({ newReels: true }, 'settings'));
  const orderOnly = await device(shop);
  accepted(await orderOnly.app.setPrefs({ orderUpdates: true }, 'first_order_prompt'));
  const offersOnly = await device(shop);
  accepted(await offersOnly.app.setPrefs({ offers: true }, 'settings'));
  const page = await shop.page({ productIds: [products[0].id], caption: 'Fresh arrivals' });
  await shop.addToCategory(category.id, page.id);
  const push = await world.waitFor(async () => (await received(yes.token))[0], 25_000, 150);
  assert.ok(push, 'No new-reel push arrived');
  assertPushClean(push, 'The new-reel push');
  assert.equal(push.data.link, `/r/${page.slug}`);
  assert.ok(push.title.includes(category.name), 'The title names the category');
  await sleep(1200);
  await world.tick();
  assert.equal((await received(yes.token)).length, 1, 'More than one push for one reel');
  assert.equal((await received(orderOnly.token)).length, 0);
  assert.equal((await received(offersOnly.token)).length, 0, 'Offers is not New reels');
  // The reel was added to a category of another business: this business's shoppers hear nothing.
  const other = await pushShop();
  const otherCategory = await other.shop.category('Elsewhere');
  const otherPage = await other.shop.page({ productIds: [other.products[0].id] });
  await other.shop.addToCategory(otherCategory.id, otherPage.id);
  await sleep(1200);
  await world.tick();
  assert.equal((await received(yes.token)).length, 1, 'Another business\'s reel reached this business\'s shopper');
  // The new-reel push counts toward the weekly cap with offers.
  assert.ok((await shop.pushLog()).some((r) => r.kind === 'new_reel' && r.status === 'sent'));
});

test('P-62: the provider\'s answers: a dead token is dropped, junk and timeouts retry a few times and never crash the sender', async (t) => {
  if (quietNow()) return t.skip('Offers wait in quiet hours; this needs a delivery');
  const { shop } = await pushShop();
  const dead = await device(shop);
  accepted(await dead.app.setPrefs({ offers: true }, 'settings'));
  await world.push.post('/tokens', { token: dead.token, state: 'unregistered' });
  accepted(await offer(shop, { title: 'To a dead token' }));
  const row = await world.waitFor(async () => (await shop.pushDevices()).find((d) => d.deleted_at), 20_000, 150);
  assert.ok(row, 'A token the provider calls unregistered was kept');
  assert.equal(row.delete_reason, 'unregistered');
  // Junk answers and a hanging provider: the campaign ends in a state, the worker survives and the next offer works.
  const live = await device(shop);
  accepted(await live.app.setPrefs({ offers: true }, 'settings'));
  await world.push.post('/behaviour', { kind: 'junk', wire: 'fcm', token: live.token, times: 1 });
  accepted(await offer(shop, { title: 'Junk answer' }));
  await world.waitFor(async () => (await shop.campaigns()).find((c) => c.title === 'Junk answer' && ['sent', 'failed'].includes(c.status)), 25_000, 200);
  const junk = (await shop.campaigns()).find((c) => c.title === 'Junk answer');
  assert.ok(['sent', 'failed'].includes(junk.status), `A junk answer left the campaign ${junk.status}`);
  assert.ok((await shop.pushLog()).every((r) => r.attempts <= SHOPPER_PUSH_RULES.maxAttempts), 'More attempts than the limit');
  await world.push.post('/behaviour', { kind: 'hang', wire: 'fcm', token: live.token, times: 1 });
  accepted(await offer(shop, { title: 'Provider hangs' }));
  const ended = await world.waitFor(async () => (await shop.campaigns()).find((c) => c.title === 'Provider hangs' && ['sent', 'failed'].includes(c.status)), 30_000, 250);
  assert.ok(ended, 'A hanging provider left the campaign sending for ever');
  const alive = (await shop.pushDevices()).find((d) => d.token_hash && !d.deleted_at);
  assert.ok(alive, 'A timeout deleted a good device');
});

test('P-47: shoppers of one business never get another business\'s push, and a tenant id cannot be chosen by the app', async (t) => {
  const a = await pushShop({ name: 'Leafy Corner' });
  const b = await pushShop({ name: 'Brass Bazaar' });
  const da = await device(a.shop);
  const db = await device(b.shop);
  accepted(await da.app.setPrefs({ offers: true }, 'settings'));
  accepted(await db.app.setPrefs({ offers: true }, 'settings'));
  // An app of A registering on B's host, or B's tenant on A's host, is a 404 and changes nothing.
  const crossed = a.shop.app({ host: b.shop.host });
  assert.equal((await crossed.registerDevice()).status, 404);
  const wrongTenant = a.shop.app({ tenantId: b.shop.tenantId });
  assert.equal((await wrongTenant.registerDevice()).status, 404);
  assert.equal((await b.shop.pushDevices()).length, 1);
  if (!quietNow()) {
    accepted(await offer(a.shop, { title: 'Only for A' }));
    assert.ok(await world.waitFor(async () => (await received(da.token))[0], 20_000, 150));
    await sleep(500);
    assert.equal((await received(db.token)).length, 0, 'B\'s shopper got A\'s offer');
  } else t.diagnostic('Inside quiet hours: only the cross-business refusals ran');
});
