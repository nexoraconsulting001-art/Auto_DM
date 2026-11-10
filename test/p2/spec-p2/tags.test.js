// PRD 7.14: the seller's own Meta Pixel and Google Analytics on their buyer pages. N-67 to N-72.
// Shopper consent is built in Phase 4, so a stand-in says what each test needs the shopper to have answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { addReel } from '../../p0/spec-p0/support.js';
import { TAG_HOSTS, UA, addP2Shop, dayAgo, hit, need, shopper, unique, useP2World } from './support.js';

const world = useP2World();
const ALL_HOSTS = [...TAG_HOSTS.meta, ...TAG_HOSTS.ga4];

function ids() {
  const pixelId = String(100000 + crypto.randomInt(899999));
  const measurementId = `G-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  return { pixelId, measurementId, capiToken: `tok${unique()}0000000000`, apiSecret: `sec${unique()}0000000000` };
}

async function tagsOn(shop, tag = ids(), { meta = true, ga4 = true } = {}) {
  await world.meta.post('/pixels', { pixelId: tag.pixelId, token: tag.capiToken });
  await world.google.post('/ga4/streams', { measurementId: tag.measurementId, apiSecret: tag.apiSecret });
  await shop.patch('/tags', {
    ...(meta ? { meta: { enabled: true, pixelId: tag.pixelId, capiToken: tag.capiToken } } : {}),
    ...(ga4 ? { ga4: { enabled: true, measurementId: tag.measurementId, apiSecret: tag.apiSecret } } : {}),
  }, 200, 'Turning tags on');
  return tag;
}

const reelPage = async (shop) => `/r/${(await addReel(shop, String(100_000_000 + crypto.randomInt(1e9)), { headline: `Reel ${unique()}` })).reel.slug}`;
const page = async (shop, path) => need(await hit(world, path, { host: shop.host, headers: { 'user-agent': UA.phone } }), 200, 'The page');
const csp = (res) => String(res.headers['content-security-policy'] ?? '');
const settled = (shop) => shop.settle({ ms: 3000, roundMs: 300 });
const metaEvents = async (tag) => world.meta.get('/capi/events', { pixelId: tag.pixelId });
const googleEvents = async (tag) => world.google.get('/ga4/events', { measurementId: tag.measurementId });
const nothingSent = async (tag, what) => {
  assert.deepEqual((await metaEvents(tag)).received, [], `${what}: Meta got events`);
  assert.deepEqual((await googleEvents(tag)).accepted, [], `${what}: Google got events`);
};
const assertNoTagInPage = (text, tag, what) => {
  assert.equal(text.includes(tag.pixelId), false, `${what}: the pixel id is in the page`);
  assert.equal(text.includes(tag.measurementId), false, `${what}: the measurement id is in the page`);
  assert.doesNotMatch(text, /connect\.facebook\.net|googletagmanager\.com|google-analytics\.com/, what);
};

// ---- N-67 ------------------------------------------------------------------------------------------------------------

test('N-67: pixel on and the banner unanswered: nothing goes to Meta or Google, and Bhava still counts the session', async () => {
  world.consent.unanswered();
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  const path = await reelPage(shop);
  const res = await page(shop, path);
  assertNoTagInPage(res.text, tag, 'Unanswered');
  await shopper(world, shop).send({ name: 'page_view', path, pageKind: 'landing' });
  await shopper(world, shop).send({ name: 'product_view', path, pageKind: 'product', valuePaise: 100, eventId: `e${unique()}` });
  await settled(shop);
  await nothingSent(tag, 'Unanswered');
  assert.deepEqual(await shop.tagRows(), [], 'Nothing queued');
  assert.equal((await shop.get('/traffic/summary', { range: '7' })).sessions.value, 2);
});

test('N-67: the real consent says no until Phase 4, so nothing can go', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  world.consent.unanswered();
  await shopper(world, shop).send({ name: 'page_view', path: '/a', eventId: `e${unique()}` });
  await settled(shop);
  await nothingSent(tag, 'Unanswered');
});

test('N-67: tags are off by default for every new business', async () => {
  const shop = await addP2Shop(world);
  const res = await shop.get('/tags');
  assert.deepEqual([res.meta.enabled, res.ga4.enabled, res.meta.pixelId, res.ga4.measurementId], [false, false, '', '']);
  assert.equal(res.available, true);
  assert.deepEqual([res.meta.capiTokenSet, res.ga4.apiSecretSet], [false, false]);
});

test('N-67: tokens and secrets are stored encrypted and are never returned', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  const res = await shop.get('/tags');
  assert.deepEqual([res.meta.capiTokenSet, res.ga4.apiSecretSet], [true, true]);
  const text = JSON.stringify(res);
  assert.equal(text.includes(tag.capiToken) || text.includes(tag.apiSecret), false, 'A secret came back');
  const [row] = await shop.sql('SELECT * FROM tag_settings WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(JSON.stringify(row).includes(tag.capiToken) || JSON.stringify(row).includes(tag.apiSecret), false, 'A secret is stored in plain');
  assert.ok(row.meta_capi_token_enc && row.ga4_api_secret_enc);
});

test('N-67: only the owner sets tags, tier 2 and up, and bad ids are refused', async () => {
  const shop = await addP2Shop(world);
  const manager = await shop.addManager();
  const refused = await shop.as(manager.token, '/tags', { method: 'PATCH', body: { meta: { enabled: true } } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'Owner only.');
  for (const body of [{ meta: { pixelId: 'abc' } }, { meta: { pixelId: "1234567'--" } }, { ga4: { measurementId: 'UA-1' } }, { ga4: { measurementId: '<script>' } }, { meta: { capiToken: 'short' } }]) {
    assert.equal((await shop.api('/tags', { method: 'PATCH', body })).status, 400, JSON.stringify(body));
  }
  const tier1 = await addP2Shop(world, { plan: 't1' });
  assert.equal((await tier1.get('/tags')).available, false);
  assert.ok([400, 402, 403].includes((await tier1.api('/tags', { method: 'PATCH', body: { meta: { enabled: true, pixelId: '1234567' } } })).status));
});

test('N-67: Bhava never adds a pixel or tag of its own', async () => {
  world.consent.grant();
  try {
    const shop = await addP2Shop(world);
    const res = await page(shop, await reelPage(shop));
    assert.doesNotMatch(res.text, /connect\.facebook\.net|googletagmanager\.com|fbq\(|gtag\(/);
    for (const host of ALL_HOSTS) assert.equal(csp(res).includes(host), false, host);
  } finally {
    world.consent.unanswered();
  }
});

// ---- N-68 ------------------------------------------------------------------------------------------------------------

test('N-68: a shopper who declines: no tag loads and no server event goes, on this or any later page', async () => {
  world.consent.decline();
  try {
    const shop = await addP2Shop(world);
    const tag = await tagsOn(shop);
    const first = await reelPage(shop);
    const second = await reelPage(shop);
    assertNoTagInPage((await page(shop, first)).text, tag, 'First page');
    assertNoTagInPage((await page(shop, second)).text, tag, 'Second page');
    const visitor = shopper(world, shop);
    for (const name of ['page_view', 'product_view', 'add_to_cart', 'checkout_started']) await visitor.send({ name, path: first, eventId: `e${unique()}` });
    await settled(shop);
    await nothingSent(tag, 'Declined');
    assert.deepEqual(await shop.tagRows(), [], 'Nothing queued');
  } finally {
    world.consent.unanswered();
  }
});

test('N-68: declining doesn\'t change Bhava\'s own counts', async () => {
  world.consent.decline();
  try {
    const shop = await addP2Shop(world);
    await tagsOn(shop);
    await shopper(world, shop).send({ name: 'page_view', path: '/a' });
    await settled(shop);
    assert.equal((await shop.get('/traffic/summary', { range: '7' })).sessions.value, 1);
  } finally {
    world.consent.unanswered();
  }
});

test('N-68: consent is asked per shopper: one shopper\'s yes is no one else\'s', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  const yes = shopper(world, shop);
  await yes.send({ name: 'page_view', path: '/a' });
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  const eventYes = `yes${unique()}`;
  const eventNo = `no${unique()}`;
  world.consent.set((who) => (who.visitorId === yes.visitorId ? { granted: true, answered: true, reason: '' } : { granted: false, answered: true, reason: '' }));
  try {
    await yes.send({ name: 'product_view', path: '/a', eventId: eventYes });
    await shopper(world, shop).send({ name: 'product_view', path: '/a', eventId: eventNo });
    await settled(shop);
    const sent = (await metaEvents(tag)).received.map((e) => e.eventId);
    assert.ok(sent.includes(eventYes), 'The shopper who accepted');
    assert.equal(sent.includes(eventNo), false, 'The shopper who did not');
  } finally {
    world.consent.unanswered();
  }
});

// ---- N-69 ------------------------------------------------------------------------------------------------------------

async function acceptAndBuy(shop, tag, eventId = `order-${unique()}`) {
  world.consent.grant();
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/r/a', pageKind: 'landing' });
  await visitor.send({ name: 'payment_success', path: '/order/x', pageKind: 'checkout', valuePaise: 129900, eventId });
  await visitor.send({ name: 'order', path: '/order/x', pageKind: 'checkout', valuePaise: 129900, eventId });
  await settled(shop);
  await fetch(`${world.meta.url}/tr?id=${tag.pixelId}&ev=Purchase&eid=${eventId}`);
  return eventId;
}

test('N-69: accept then buy: one purchase in Meta after removing duplicates, and one GA4 purchase, both with the order value', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  try {
    const eventId = await acceptAndBuy(shop, tag);
    const { received, deduped } = await metaEvents(tag);
    const serverPurchases = received.filter((e) => e.eventName === 'Purchase' && e.source === 'server');
    assert.equal(serverPurchases.length, 1, 'One server event');
    assert.equal(serverPurchases[0].eventId, eventId, 'It shares its id with the browser hit');
    assert.equal(deduped.filter((e) => e.eventName === 'Purchase').length, 1, 'Meta counts it once');
    assert.equal(Number(serverPurchases[0].customData.value), 1299, 'The value in rupees');
    assert.equal(serverPurchases[0].customData.currency, 'INR');
    const events = await googleEvents(tag);
    assert.equal(events.purchases, 1);
    const purchase = events.accepted.find((e) => e.name === 'purchase');
    assert.equal(Number(purchase.params.value), 1299);
    assert.equal(purchase.params.currency, 'INR');
    assert.ok(purchase.params.transaction_id, 'GA4 needs a transaction id to count a purchase once');
  } finally {
    world.consent.unanswered();
  }
});

test('N-69: the same purchase fired twice at the same moment is one row in the queue', async () => {
  const shop = await addP2Shop(world);
  await tagsOn(shop);
  world.consent.grant();
  try {
    const visitor = shopper(world, shop);
    await visitor.send({ name: 'page_view', path: '/a' });
    const eventId = `order-${unique()}`;
    await Promise.all([1, 2, 3].map(() => visitor.beacon({ name: 'order', path: '/order/x', valuePaise: 500, eventId })));
    await settled(shop);
    const rows = (await shop.tagRows()).filter((r) => r.event_id === eventId);
    assert.ok(rows.length <= 2, `One per provider, got ${rows.length}`);
    assert.equal(new Set(rows.map((r) => r.provider)).size, rows.length);
  } finally {
    world.consent.unanswered();
  }
});

test('N-69: the event queue holds no IP, no user agent and no plain email or phone, and never a token', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  const ip = '203.0.113.10';
  world.consent.grant();
  try {
    await shopper(world, shop, { ip, ua: UA.instagram }).send({ name: 'product_view', path: '/a', eventId: `e${unique()}` });
    await settled(shop);
    const dump = JSON.stringify(await shop.tagRows());
    assert.equal(dump.includes(ip), false);
    assert.equal(dump.includes('Mozilla'), false);
    assert.equal(dump.includes(tag.capiToken), false);
    assert.equal(dump.includes(tag.apiSecret), false);
  } finally {
    world.consent.unanswered();
  }
});

test('N-69: cart and purchase events are tier 3: tier 2 sends page view and view content only', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  const tag = await tagsOn(shop);
  world.consent.grant();
  try {
    const visitor = shopper(world, shop);
    await visitor.send({ name: 'page_view', path: '/a', eventId: `e${unique()}` });
    await visitor.send({ name: 'add_to_cart', path: '/a', eventId: `e${unique()}` });
    await settled(shop);
    const names = (await metaEvents(tag)).received.map((e) => e.eventName);
    assert.ok(names.includes('PageView'), names.join());
    assert.equal(names.includes('AddToCart'), false, names.join());
  } finally {
    world.consent.unanswered();
  }
});

test('N-69: Meta timing out once is retried, with one purchase counted', async () => {
  const shop = await addP2Shop(world);
  const tag = await tagsOn(shop);
  await world.meta.fault({ kind: 'server_error', status: 500, times: 1, match: { path: `*/${tag.pixelId}/events` } });
  world.consent.grant();
  try {
    await shopper(world, shop).send({ name: 'order', path: '/order/x', valuePaise: 500, eventId: `order-${unique()}` });
    await settled(shop);
    const [row] = (await shop.tagRows()).filter((r) => r.provider === 'meta');
    assert.ok(row, 'A queued server event');
    if (row.status === 'queued') {
      await shop.sql('UPDATE tag_outbox SET next_attempt_at = now() WHERE id = $1', [row.id]);
      await settled(shop);
    }
    assert.equal((await metaEvents(tag)).received.filter((e) => e.source === 'server').length, 1);
  } finally {
    world.consent.unanswered();
  }
});

// ---- N-70 ------------------------------------------------------------------------------------------------------------

test('N-70: one business\'s pixel is absent from another\'s page and its content security policy', async () => {
  world.consent.grant();
  try {
    const a = await addP2Shop(world);
    const b = await addP2Shop(world);
    const tag = await tagsOn(a);
    const onA = await page(a, await reelPage(a));
    const onB = await page(b, await reelPage(b));
    assert.ok(onA.text.includes(tag.pixelId), 'A\'s own page has its pixel');
    for (const host of TAG_HOSTS.meta) assert.ok(csp(onA).includes(host), `A's policy allows ${host}`);
    assertNoTagInPage(onB.text, tag, 'B\'s page');
    for (const host of ALL_HOSTS) assert.equal(csp(onB).includes(host), false, `B's policy allows ${host}`);
  } finally {
    world.consent.unanswered();
  }
});

test('N-70: each business\'s server events go to its own pixel, with its own token', async () => {
  world.consent.grant();
  try {
    const a = await addP2Shop(world);
    const b = await addP2Shop(world);
    const tagA = await tagsOn(a);
    const tagB = await tagsOn(b);
    const idA = `a${unique()}`;
    const idB = `b${unique()}`;
    await shopper(world, a).send({ name: 'product_view', path: '/a', eventId: idA });
    await shopper(world, b).send({ name: 'product_view', path: '/a', eventId: idB });
    await settled(a);
    await settled(b);
    const sentA = (await metaEvents(tagA)).received.map((e) => e.eventId);
    const sentB = (await metaEvents(tagB)).received.map((e) => e.eventId);
    assert.ok(sentA.includes(idA) && !sentA.includes(idB));
    assert.ok(sentB.includes(idB) && !sentB.includes(idA));
  } finally {
    world.consent.unanswered();
  }
});

test('N-70: a GA4 tag on its own opens only Google\'s hosts', async () => {
  world.consent.grant();
  try {
    const shop = await addP2Shop(world);
    await tagsOn(shop, ids(), { meta: false, ga4: true });
    const res = await page(shop, await reelPage(shop));
    for (const host of TAG_HOSTS.ga4) assert.ok(csp(res).includes(host), host);
    for (const host of TAG_HOSTS.meta) assert.equal(csp(res).includes(host), false, host);
  } finally {
    world.consent.unanswered();
  }
});

test('N-70: a pixel id can\'t carry script into the page', async () => {
  const shop = await addP2Shop(world);
  assert.equal((await shop.api('/tags', { method: 'PATCH', body: { meta: { pixelId: '123456"><script>alert(1)</script>' } } })).status, 400);
});

// ---- N-71 ------------------------------------------------------------------------------------------------------------

async function failingPixel(shop) {
  const tag = await tagsOn(shop);
  await world.meta.post('/pixels/revoke', { pixelId: tag.pixelId });
  return tag;
}

const failedDays = async (shop, provider, offsets, base = 3) => {
  for (const offset of offsets) await shop.sql(`INSERT INTO tag_health_daily (tenant_id, provider, day, sent, failed, last_error, last_error_at) VALUES ($1, $2, $3, 0, $4, '190', now()) ON CONFLICT DO NOTHING`, [shop.tenantId, provider, dayAgo(offset), base]);
};

test('N-71: a revoked Conversions token: events fail and are retried, and the health panel shows the error', async () => {
  const shop = await addP2Shop(world);
  const tag = await failingPixel(shop);
  world.consent.grant();
  try {
    await shopper(world, shop).send({ name: 'product_view', path: '/a', eventId: `e${unique()}` });
    await settled(shop);
    const [row] = (await shop.tagRows()).filter((r) => r.provider === 'meta');
    assert.ok(row, 'A queued event');
    assert.ok(row.attempts >= 1, 'It was tried');
    assert.equal(row.status === 'queued' || row.status === 'failed', true, row.status);
    assert.equal(JSON.stringify(row).includes(tag.capiToken), false);
    const health = (await shop.get('/tags/health')).items.find((i) => i.provider === 'meta');
    assert.ok(health.failed >= 1);
    assert.ok(health.lastError, 'The panel shows the error');
    assert.equal(health.lastError.includes(tag.capiToken), false);
  } finally {
    world.consent.unanswered();
  }
});

test('N-71: retries wait between attempts, and stop after being refused for good', async () => {
  const shop = await addP2Shop(world);
  await failingPixel(shop);
  world.consent.grant();
  try {
    await shopper(world, shop).send({ name: 'product_view', path: '/a', eventId: `e${unique()}` });
    await settled(shop);
    const [first] = (await shop.tagRows()).filter((r) => r.provider === 'meta');
    if (first.status === 'queued') assert.ok(new Date(first.next_attempt_at) > new Date(), 'The next try is later');
    await settled(shop);
    const [second] = (await shop.tagRows()).filter((r) => r.provider === 'meta');
    assert.ok(second.attempts <= first.attempts + 1, 'Not retried on every tick');
  } finally {
    world.consent.unanswered();
  }
});

test('N-71: the owner is alerted after 3 failed days in a row, once', async () => {
  const shop = await addP2Shop(world);
  await tagsOn(shop);
  await failedDays(shop, 'meta', [2, 1, 0]);
  await settled(shop);
  await settled(shop);
  assert.equal((await shop.alerts()).filter((a) => /tag|pixel|conversion/i.test(`${a.kind} ${a.message}`)).length, 1);
});

test('N-71: 2 failed days don\'t alert', async () => {
  const shop = await addP2Shop(world);
  await tagsOn(shop);
  await failedDays(shop, 'meta', [1, 0]);
  await settled(shop);
  assert.equal((await shop.alerts()).filter((a) => /tag|pixel|conversion/i.test(`${a.kind} ${a.message}`)).length, 0);
});

test('N-71: a good day in between breaks the run', async () => {
  const shop = await addP2Shop(world);
  await tagsOn(shop);
  await failedDays(shop, 'meta', [3, 2, 0]);
  await shop.sql(`INSERT INTO tag_health_daily (tenant_id, provider, day, sent, failed) VALUES ($1, 'meta', $2, 10, 0)`, [shop.tenantId, dayAgo(1)]);
  await settled(shop);
  assert.equal((await shop.alerts()).filter((a) => /tag|pixel|conversion/i.test(`${a.kind} ${a.message}`)).length, 0);
});

test('N-71: the health panel counts each business on its own', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await failedDays(a, 'meta', [0]);
  await tagsOn(b);
  const health = (await b.get('/tags/health')).items.find((i) => i.provider === 'meta');
  assert.equal(health.failed, 0);
  const staff = await a.addStaff(['orders']);
  assert.equal((await a.as(staff.token, '/tags/health')).status, 403);
});

// ---- N-72 ------------------------------------------------------------------------------------------------------------

test('N-72: tags off: no Meta or Google hosts in the policy, and nothing queued', async () => {
  world.consent.grant();
  try {
    const shop = await addP2Shop(world);
    const tag = await tagsOn(shop);
    await shop.patch('/tags', { meta: { enabled: false }, ga4: { enabled: false } }, 200, 'Off');
    const res = await page(shop, await reelPage(shop));
    for (const host of ALL_HOSTS) assert.equal(csp(res).includes(host), false, host);
    assertNoTagInPage(res.text, tag, 'Off');
    await shopper(world, shop).send({ name: 'product_view', path: '/a', eventId: `e${unique()}` });
    await settled(shop);
    assert.deepEqual(await shop.tagRows(), [], 'Nothing queued');
    await nothingSent(tag, 'Off');
  } finally {
    world.consent.unanswered();
  }
});

test('N-72: a tag turned off stops what was already waiting', async () => {
  world.consent.grant();
  try {
    const shop = await addP2Shop(world);
    const tag = await tagsOn(shop);
    await shop.sql(`UPDATE jobs SET status = 'done' WHERE status = 'queued' AND tenant_id = $1`, [shop.tenantId]).catch(() => {});
    world.stopWorker();
    await shopper(world, shop).send({ name: 'product_view', path: '/a', eventId: `e${unique()}` });
    await shop.patch('/tags', { meta: { enabled: false }, ga4: { enabled: false } }, 200, 'Off');
    world.startWorker();
    await settled(shop);
    await nothingSent(tag, 'Queued then off');
  } finally {
    world.startWorker();
    world.consent.unanswered();
  }
});

test('N-72: the page\'s security policy never allows anything to be loaded from the platform', async () => {
  const shop = await addP2Shop(world);
  const res = await page(shop, await reelPage(shop));
  assert.doesNotMatch(csp(res), /bhava/i);
});
