// PRD 7.14: the seller's own Meta Pixel and Google Analytics. Off by default, per business, and nothing without consent. Everything reaches simulators only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_HOSTS } from '../../../src/contracts/analytics.js';
import { withTenant } from '../../../src/tenancy.js';
import { createGoogle } from '../../../tools/sim/google/index.mjs';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { seedReel } from '../../helpers.js';
import { api, beacon, newVisitor, page, placeOrder, secondBusiness, staffToken, startTraffic } from './support.js';

const PIXEL = '1234567890';
const STREAM = 'G-ABC123';
const CAPI_TOKEN = 'capi-token-abcdefghij';
const GA_SECRET = 'ga-secret-abcdefghij';
const ALL_HOSTS = [...TAG_HOSTS.meta, ...TAG_HOSTS.ga4];
const yes = { built: true, analyticsAndAds: async () => ({ granted: true, answered: true, reason: 'accepted' }) };
const declined = { built: true, analyticsAndAds: async () => ({ granted: false, answered: true, reason: 'declined' }) };

async function withSims(t, options = {}) {
  const meta = await createMeta().start();
  const google = await createGoogle().start();
  t.after(() => meta.close());
  t.after(() => google.close());
  await meta.post('/pixels', { pixelId: PIXEL, token: CAPI_TOKEN });
  await google.post('/ga4/streams', { measurementId: STREAM, apiSecret: GA_SECRET });
  const world = await startTraffic({ at: Date.now(), ...options, overrides: { graphBaseUrl: meta.url, ga4BaseUrl: google.url, ...options.overrides } });
  t.after(world.close);
  return { world, meta, google };
}

const turnOn = (world, opts = {}) => api(world, '/tags', { method: 'PATCH', body: { meta: { enabled: true, pixelId: PIXEL, capiToken: CAPI_TOKEN }, ga4: { enabled: true, measurementId: STREAM, apiSecret: GA_SECRET } }, ...opts });
const outbox = (world) => withTenant(world.tenant, () => world.db.query('SELECT * FROM tag_outbox ORDER BY id'));
const drain = (world) => world.services().tags.drain();
const hitPage = (world, slug) => beacon(world, { name: 'page_view', path: `/r/${slug}`, pageKind: 'landing', pageRef: slug, eventId: 'evt-1' }, { visitor: newVisitor() });

test('off by default: no tag, no hosts in the policy, and Bhava adds nothing of its own', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { reel } = await seedReel(world.repos);
  const res = await page(world, `/r/${reel.slug}`);
  for (const host of ALL_HOSTS) assert.ok(!res.headers['content-security-policy'].includes(host), host);
  assert.ok(!/fbq\(|gtag\(|googletagmanager|fbevents/.test(res.text));
  const settings = (await api(world, '/tags')).body;
  assert.deepEqual([settings.available, settings.meta.enabled, settings.ga4.enabled, settings.consentReady], [true, false, false, false]);
});

test('N-67: pixel on and the banner unanswered: no request to Meta or Google, and the session still counts', async (t) => {
  const { world, meta, google } = await withSims(t);
  const { reel } = await seedReel(world.repos);
  assert.equal((await turnOn(world)).status, 200);
  const res = await page(world, `/r/${reel.slug}`);
  assert.ok(!/fbq\(|gtag\(|fbevents/.test(res.text), 'no tag loads');
  assert.ok(!res.text.includes(PIXEL));
  await hitPage(world, reel.slug);
  assert.equal((await outbox(world)).length, 0);
  await drain(world);
  assert.equal((await meta.get('/capi/events', { pixelId: PIXEL })).received.length, 0);
  assert.equal((await google.get('/ga4/events', { measurementId: STREAM })).accepted.length, 0);
  assert.equal((await api(world, '/traffic/summary')).body.sessions.value, 1, 'Bhava\'s own counts don\'t depend on this');
});

test('N-68: a shopper who declined gets no tag and no server event on any later page', async (t) => {
  const { world, meta } = await withSims(t, { consent: declined });
  const { reel } = await seedReel(world.repos);
  await turnOn(world);
  for (const path of [`/r/${reel.slug}`, '/shop']) assert.ok(!/fbq\(|gtag\(/.test((await page(world, path)).text), path);
  await hitPage(world, reel.slug);
  assert.equal((await outbox(world)).length, 0);
  assert.equal((await meta.get('/capi/events', { pixelId: PIXEL })).received.length, 0);
});

test('N-69: accepted, then bought: one purchase on each side with the order value, and browser and server share an event id', async (t) => {
  const { world, meta, google } = await withSims(t, { consent: yes });
  const { products, reel } = await seedReel(world.repos, { n: 1 });
  await turnOn(world);

  const res = await page(world, `/r/${reel.slug}`);
  assert.ok(res.text.includes(`fbq('init','${PIXEL}')`));
  assert.ok(res.text.includes(`gtag/js?id=${STREAM}`));
  for (const host of ALL_HOSTS) assert.ok(res.headers['content-security-policy'].includes(host), host);
  const eventId = /data-e="([\w-]+)"/.exec(res.text)[1];

  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: `/r/${reel.slug}`, pageKind: 'landing', pageRef: reel.slug, eventId }, { visitor });
  await beacon(world, { name: 'page_view', path: `/r/${reel.slug}`, pageKind: 'landing', pageRef: reel.slug, eventId }, { visitor });
  const queued = await outbox(world);
  assert.deepEqual(queued.map((r) => [r.provider, r.event_name, r.event_id]), [['meta', 'PageView', eventId], ['ga4', 'page_view', eventId]]);

  const order = await placeOrder(world.repos, { status: 'awaiting_payment', productId: products[0].id });
  await world.inTenant(() => world.services().ingest.linkOrder(order, visitor));
  await world.repos.orders.setStatus(order.id, 'paid');
  await world.inTenant(() => world.services().sync.run());
  await world.inTenant(() => world.services().sync.run());
  await drain(world);

  const metaEvents = await meta.get('/capi/events', { pixelId: PIXEL });
  const purchases = metaEvents.deduped.filter((e) => e.eventName === 'Purchase');
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].customData.value, order.total_paise / 100);
  assert.equal(purchases[0].customData.currency, 'INR');
  const ga = await google.get('/ga4/events', { measurementId: STREAM });
  assert.equal(ga.purchases, 1);
  assert.equal(ga.accepted.find((e) => e.name === 'purchase').params.value, order.total_paise / 100);
  const stored = JSON.stringify(await outbox(world));
  assert.ok(!stored.includes('9876543210'), 'no phone number in the outbox');
});

test('hashed contact details go to Meta only for a signed-in shopper, and never unhashed', async (t) => {
  const { world, meta } = await withSims(t, { consent: yes });
  await turnOn(world);
  const shopper = await world.repos.users.create({ name: 'Asha', phone: '9812345670', email: 'asha@example.com', password: 'secret12' });
  await world.inTenant(() => world.services().tags.onBrowserEvent({ name: 'page_view', eventId: 'e1', valuePaise: 0 }, { at: new Date(world.clock.now), visitorId: newVisitor(), sessionId: null, user: { ...shopper, role: 'customer' }, host: 'shop.test', path: '/p/x' }));
  await drain(world);
  const [event] = (await meta.get('/capi/events', { pixelId: PIXEL })).received;
  assert.equal(event.userData.em[0].length, 64);
  assert.equal(event.userData.ph[0].length, 64);
  assert.ok(!JSON.stringify(await outbox(world)).includes('asha@example.com'));
});

test('a withdrawal stops events already waiting to go', async (t) => {
  const consent = { built: true, granted: true, async analyticsAndAds() { return { granted: this.granted, answered: true, reason: 'x' }; } };
  const { world, meta } = await withSims(t, { consent });
  const { reel } = await seedReel(world.repos);
  await turnOn(world);
  await hitPage(world, reel.slug);
  assert.equal((await outbox(world)).length, 2);
  consent.granted = false;
  await drain(world);
  assert.equal((await meta.get('/capi/events', { pixelId: PIXEL })).received.length, 0);
  assert.ok((await outbox(world)).every((r) => r.status === 'failed' && r.last_error === 'consent_withdrawn'));
});

test('N-70: one business\'s pixel is absent from another\'s page and policy', async (t) => {
  const world = await startTraffic({ consent: yes });
  t.after(world.close);
  const other = await secondBusiness(world);
  await seedReel(other.repos);
  await turnOn(world);
  const theirPage = await page(world, '/r/brunch-edit', { host: other.host });
  assert.equal(theirPage.status, 200);
  assert.ok(!theirPage.text.includes(PIXEL));
  assert.ok(!theirPage.text.includes(STREAM));
  for (const host of ALL_HOSTS) assert.ok(!theirPage.headers['content-security-policy'].includes(host), host);
});

test('N-71: a revoked token fails and retries, the panel shows the error, and the owner is alerted after 3 failed days, once', async (t) => {
  const { world, meta } = await withSims(t, { consent: yes });
  const { reel } = await seedReel(world.repos);
  await turnOn(world);
  await meta.post('/pixels/revoke', { pixelId: PIXEL });
  await hitPage(world, reel.slug);
  await drain(world);
  const metaRow = (await outbox(world)).find((r) => r.provider === 'meta');
  assert.equal(metaRow.status, 'queued', 'waits to be retried');
  assert.equal(metaRow.attempts, 1);
  assert.match(metaRow.last_error, /token_invalid/);
  assert.ok(!metaRow.last_error.includes(CAPI_TOKEN));

  const day = 86_400_000;
  world.clock.now += day;
  await drain(world);
  world.clock.now += day;
  let alerts = await world.repos.alerts.list({});
  assert.equal(alerts.items.filter((a) => a.kind === 'tags.failing').length, 0, 'not before the third day');
  await drain(world);
  alerts = await world.repos.alerts.list({});
  const failing = alerts.items.filter((a) => a.kind === 'tags.failing');
  assert.equal(failing.length, 1);
  assert.match(failing[0].message, /Meta Pixel/);

  const health = (await api(world, '/tags/health')).body.items.find((i) => i.provider === 'meta');
  assert.equal(health.failedDaysInARow, 3);
  assert.match(health.lastError, /token_invalid/);
  assert.ok(health.failed >= 3);
  assert.equal(health.enabled, true);
});

test('N-72: tags off: no hosts in the policy, nothing queued, and anything waiting is dropped', async (t) => {
  const world = await startTraffic({ consent: yes });
  t.after(world.close);
  const { reel } = await seedReel(world.repos);
  await turnOn(world);
  await hitPage(world, reel.slug);
  assert.ok((await outbox(world)).length > 0);
  assert.equal((await api(world, '/tags', { method: 'PATCH', body: { meta: { enabled: false }, ga4: { enabled: false } } })).status, 200);
  assert.ok((await outbox(world)).every((r) => r.status === 'failed' && r.last_error === 'tag_off'));
  const res = await page(world, `/r/${reel.slug}`);
  for (const host of ALL_HOSTS) assert.ok(!res.headers['content-security-policy'].includes(host), host);
  const before = (await outbox(world)).length;
  await beacon(world, { name: 'page_view', path: '/', eventId: 'evt-9' }, { visitor: newVisitor() });
  assert.equal((await outbox(world)).length, before);
});

test('only the tag that is on opens the policy for its host', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { reel } = await seedReel(world.repos);
  await api(world, '/tags', { method: 'PATCH', body: { ga4: { enabled: true, measurementId: STREAM } } });
  const policy = (await page(world, `/r/${reel.slug}`)).headers['content-security-policy'];
  for (const host of TAG_HOSTS.ga4) assert.ok(policy.includes(host), host);
  for (const host of TAG_HOSTS.meta) assert.ok(!policy.includes(host), host);
});

test('tokens are encrypted, never returned, never in the audit log; only the owner can change them', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const settings = (await turnOn(world)).body;
  assert.deepEqual([settings.meta.pixelId, settings.meta.capiTokenSet, settings.ga4.measurementId, settings.ga4.apiSecretSet], [PIXEL, true, STREAM, true]);
  assert.ok(!JSON.stringify(settings).includes(CAPI_TOKEN));
  const [row] = await world.db.platform.query('SELECT * FROM tag_settings WHERE tenant_id = $1', [world.tenant.id]);
  assert.ok(row.meta_capi_token_enc.startsWith('v1.'));
  assert.ok(!JSON.stringify(row).includes(CAPI_TOKEN));
  assert.ok(!JSON.stringify(row).includes(GA_SECRET));
  const audit = await world.db.platform.query(`SELECT * FROM audit_log WHERE action = 'tags.update'`);
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes(CAPI_TOKEN));

  const manager = await staffToken(world, { role: 'manager' });
  const refused = await api(world, '/tags', { method: 'PATCH', body: { meta: { enabled: false } }, token: manager });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'Owner only.');
  assert.equal((await api(world, '/tags', { method: 'PATCH', body: { meta: { pixelId: 'not-digits' } } })).status, 400);
});

test('pixels start at tier 2, cart and purchase events at tier 3', async (t) => {
  const free = await startTraffic({ plan: 'free', consent: yes });
  t.after(free.close);
  assert.equal((await api(free, '/tags')).body.available, false);
  assert.equal((await turnOn(free)).status, 403);

  const world = await startTraffic({ plan: 't2', consent: yes });
  t.after(world.close);
  const { reel } = await seedReel(world.repos);
  await turnOn(world);
  assert.ok(!(await page(world, `/r/${reel.slug}`)).text.includes('data-c="1"'));
  await beacon(world, { name: 'add_to_cart', path: '/p/x', eventId: 'cart-1' }, { visitor: newVisitor() });
  assert.equal((await outbox(world)).length, 0);
  await beacon(world, { name: 'product_view', path: '/p/x', eventId: 'view-1' }, { visitor: newVisitor() });
  assert.deepEqual((await outbox(world)).map((r) => r.event_name), ['ViewContent', 'view_item']);
});

test('the order page never loads a tag, so its private address can\'t reach Meta or Google', async (t) => {
  const world = await startTraffic({ consent: yes });
  t.after(world.close);
  const { products } = await seedReel(world.repos, { n: 1 });
  await turnOn(world);
  const order = await placeOrder(world.repos, { status: 'awaiting_payment', productId: products[0].id });
  const res = await page(world, `/order/${order.public_token}`);
  assert.equal(res.status, 200);
  assert.ok(!/fbq\(|gtag\(/.test(res.text));
  await beacon(world, { name: 'page_view', path: `/order/${order.public_token}` }, { visitor: newVisitor() });
  const stored = JSON.stringify(await world.inTenant(() => world.db.query('SELECT * FROM traffic_events')));
  assert.ok(!stored.includes(order.public_token), 'the token is never stored');
});
