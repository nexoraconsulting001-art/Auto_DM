// PRD 7.4 and 7.15: the Bhava funnel per reel, post and story, and where each figure comes from. N-14 to N-19 and N-73 to N-79.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { CUSTOMER, addProduct } from '../../p0/spec-p0/support.js';
import { DAY, FIGURE_TEXT, INSIDE_MS, SOURCE_LABELS, addP2Shop, assertNoFigure, assertRate, captureLogs, comments, hit, liveReel, multipart, need, openP2World, shopper, stepOf, tapPayload, unique, useP2World, waitForDms } from './support.js';

const world = useP2World();

const funnel = (shop, id) => shop.get(`/insights/funnels/${id}`, undefined, 'The content funnel');

async function reelWithFunnel(shop, seed, autoOptions = { linkType: 'bhava_page', linkMode: 'two_tap' }) {
  const auto = await liveReel(shop, autoOptions);
  await shop.seedFunnel(auto.mediaId, { linkType: autoOptions.linkType, linkMode: autoOptions.linkMode, ...seed });
  await shop.settle({ ms: 2500, roundMs: 250 });
  return auto.mediaId;
}

const notAvailable = (step, what = 'The step') => {
  assert.equal(step.state, 'not_available', `${what}: ${JSON.stringify(step)}`);
  assert.equal(step.reason, FIGURE_TEXT.notAvailableForLink, what);
  assertNoFigure(step.count, what);
};

// ---- N-14 ------------------------------------------------------------------------------------------------------------

test('N-14: the funnel shows 40 / 38 / 30 / 25 / 4 with revenue, stage rates and source labels', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { comments: 40, dms: 38, seen: 30, taps: 25, sales: [1, 2, 3, 4].map(() => ({ amountPaise: 150000 })) });
  const res = await funnel(shop, id);
  assert.deepEqual(res.steps.map((s) => s.stage), ['comments', 'dms', 'seen', 'taps_or_visits', 'sales']);
  assert.deepEqual(res.steps.map((s) => s.count), [40, 38, 30, 25, 4]);
  assert.equal(stepOf(res, 'sales').amountPaise, 600000);
  assertRate(stepOf(res, 'dms').rate, 95, 'DMs from comments');
  assertRate(stepOf(res, 'seen').rate, 78.9, 'Seen from DMs');
  assertRate(stepOf(res, 'taps_or_visits').rate, 83.3, 'Taps from seen');
  assertRate(stepOf(res, 'sales').rate, 16, 'Sales from taps');
  for (const step of res.steps) assert.equal(step.source, 'bhava', step.stage);
  assert.equal(SOURCE_LABELS[stepOf(res, 'sales').source], 'Measured by Bhava');
  assert.deepEqual(stepOf(res, 'sales').origins, [{ origin: 'bhava_store', count: 4, amountPaise: 600000, source: 'bhava' }]);
});

test('N-14: real comments, DMs, read receipts and taps feed the funnel', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const people = await comments(world, shop, auto.mediaId, 3);
  await shop.settle({ ms: 8000 });
  const [first, second] = await Promise.all([shop.dms({ recipientId: people[0].id }), shop.dms({ recipientId: people[1].id })]);
  assert.ok(first.length && second.length, 'The DMs went');
  await world.meta.post('/seen', { igUserId: shop.igUserId, from: people[0].id, mid: first[0].id });
  await world.meta.post('/seen', { igUserId: shop.igUserId, from: people[1].id, mid: second[0].id });
  await shop.tap(people[0], await tapPayload(shop, people[0]));
  await shop.settle({ ms: 8000 });
  const res = await funnel(shop, auto.mediaId);
  assert.deepEqual([stepOf(res, 'comments').count, stepOf(res, 'dms').count, stepOf(res, 'seen').count, stepOf(res, 'taps_or_visits').count], [3, 3, 2, 1]);
  assert.equal(res.linkType, 'seller_site');
  assert.equal(res.linkMode, 'two_tap');
});

test('N-14: a read receipt delivered twice, or for a DM Bhava never sent, doesn\'t count again', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const [person] = await comments(world, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const [dm] = await shop.dms({ recipientId: person.id });
  await world.meta.post('/seen', { igUserId: shop.igUserId, from: person.id, mid: dm.id, duplicates: 3 });
  await world.meta.post('/seen', { igUserId: shop.igUserId, from: world.fan().id, mid: `m_unknown_${unique()}` });
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, auto.mediaId), 'seen').count, 1);
});

for (const [denominator, low] of [[19, true], [20, false]]) {
  test(`N-14: a rate on ${denominator} shows ${low ? '"low volume" and no number' : 'its number'}`, async () => {
    const shop = await addP2Shop(world);
    const id = await reelWithFunnel(shop, { comments: 25, dms: denominator, seen: 10, taps: 5 });
    const seen = stepOf(await funnel(shop, id), 'seen');
    assert.equal(seen.lowVolume, low);
    if (low) assert.equal(seen.rate, null);
    else assertRate(seen.rate, 50, 'Seen rate');
  });
}

test('N-14: tier 1 ends at taps or visits: no sales and no money', async () => {
  const shop = await addP2Shop(world, { plan: 't1' });
  const id = await reelWithFunnel(shop, { comments: 25, dms: 25, seen: 25, taps: 25, sales: [{ amountPaise: 1000 }] });
  const res = await funnel(shop, id);
  const sales = res.steps.find((s) => s.stage === 'sales');
  if (sales) {
    assert.equal(sales.state, 'not_available');
    assertNoFigure(sales.count, 'Sales on tier 1');
    assertNoFigure(sales.amountPaise, 'Revenue on tier 1');
  }
});

test('N-14: a staff member without revenue access sees the funnel with sales hidden', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { comments: 25, dms: 25, seen: 25, taps: 25, sales: [{ amountPaise: 1000 }] });
  const staff = await shop.addStaff(['analytics']);
  const res = need(await shop.as(staff.token, `/insights/funnels/${id}`), 200, 'Staff funnel').json();
  assertNoFigure(stepOf(res, 'sales').amountPaise, 'Revenue for staff without orders access');
});

test('N-14: another business\'s reel is not found, and nonsense in the id is refused', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const id = await reelWithFunnel(a, { comments: 2, dms: 1 });
  assert.equal((await b.raw(`/insights/funnels/${id}`)).status, 404);
  for (const bad of ["x'%20OR%201=1", 'x'.repeat(81), '%00']) assert.ok([400, 404].includes((await a.raw(`/insights/funnels/${bad}`)).status), bad);
  for (const query of [{ kind: 'evil' }, { limit: '0' }, { limit: '1000' }, { cursor: "'" }]) assert.equal((await a.raw('/insights/funnels', query)).status, 400, JSON.stringify(query));
});

test('N-14: the same event at the same moment counts once: duplicate comments and re-run rollups change nothing', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const from = world.fan();
  await shop.comment(auto.mediaId, { from, text: 'price', duplicates: 3 });
  await shop.settle({ ms: 8000 });
  await world.tickTogether();
  await shop.settle({ ms: 3000 });
  const res = await funnel(shop, auto.mediaId);
  assert.deepEqual([stepOf(res, 'comments').count, stepOf(res, 'dms').count], [1, 1]);
});

// ---- N-15 ------------------------------------------------------------------------------------------------------------

async function tappedReel(world_, shop, times, { together = false, ...webhookOptions } = {}) {
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const [person] = await comments(world_, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const payload = await tapPayload(shop, person);
  const taps = Array.from({ length: times }, () => () => shop.tap(person, payload, webhookOptions));
  if (together) await Promise.all(taps.map((run) => run()));
  else for (const run of taps) await run();
  await shop.settle({ ms: 8000 });
  return { auto, person };
}

test('N-15: the same person tapping 5 times counts once', async () => {
  const shop = await addP2Shop(world);
  const { auto } = await tappedReel(world, shop, 5);
  assert.equal(stepOf(await funnel(shop, auto.mediaId), 'taps_or_visits').count, 1);
});

test('N-15: 5 taps arriving at the same moment still count once', async () => {
  const shop = await addP2Shop(world);
  const { auto } = await tappedReel(world, shop, 5, { together: true });
  assert.equal(stepOf(await funnel(shop, auto.mediaId), 'taps_or_visits').count, 1);
  const rows = await shop.sql(`SELECT count(*)::int AS n FROM funnel_events WHERE tenant_id = $1 AND media_id = $2 AND stage = 'taps_or_visits'`, [shop.tenantId, auto.mediaId]);
  assert.equal(rows[0].n, 1);
});

test('N-15: the same tap webhook delivered 3 times counts once', async () => {
  const shop = await addP2Shop(world);
  const { auto } = await tappedReel(world, shop, 1, { duplicates: 3 });
  assert.equal(stepOf(await funnel(shop, auto.mediaId), 'taps_or_visits').count, 1);
});

test('N-15: one person on two reels counts once on each', async () => {
  const shop = await addP2Shop(world);
  const a = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const b = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const person = world.fan();
  await shop.comment(a.mediaId, { from: person });
  await shop.comment(b.mediaId, { from: person });
  await shop.settle({ ms: 8000 });
  const dms = await shop.dms({ recipientId: person.id });
  for (const dm of dms) if (dm.message?.attachment?.payload?.buttons?.[0]?.payload) await shop.tap(person, dm.message.attachment.payload.buttons[0].payload);
  await shop.settle({ ms: 8000 });
  const counts = [stepOf(await funnel(shop, a.mediaId), 'taps_or_visits').count, stepOf(await funnel(shop, b.mediaId), 'taps_or_visits').count];
  assert.deepEqual(counts.sort(), dms.length >= 2 ? [1, 1] : [0, 1]);
});

// ---- N-16 is in traffic.test.js, beside the rest of what a visit is. ---------------------------------------------------

// ---- N-17 ------------------------------------------------------------------------------------------------------------

async function storeOrder(shop, visitor, product, buyer) {
  const res = need(await hit(world, '/api/orders', { host: shop.host, method: 'POST', token: buyer.token, headers: { cookie: `_vid=${visitor.visitorId}` }, body: { items: [{ productId: product.id, qty: 1 }], customer: CUSTOMER } }), 201, 'Placing the order').json();
  const [row] = await shop.sql('SELECT id, total_paise FROM orders WHERE tenant_id = $1 AND public_token = $2', [shop.tenantId, res.token]);
  return { ...res, id: row.id, totalPaise: row.total_paise };
}
const setOrderStatus = (shop, id, status) => shop.post(`/orders/${id}/status`, { status }, 200, `Marking the order ${status}`);

async function visitAndBuy(shop, { firstAgoDays, lastAgoDays, media = ['REEL_A', 'POST_B'], ignoreUntagged = false, nowAdjustMs = 0 }) {
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'landing_view', path: '/r/a', pageKind: 'landing', mediaId: media[0] });
  await shop.settle({ ms: 1500, roundMs: 200 });
  await world.travel((firstAgoDays - lastAgoDays) * DAY);
  await visitor.send({ name: 'landing_view', path: '/r/b', pageKind: 'landing', mediaId: media[1] });
  await shop.settle({ ms: 1500, roundMs: 200 });
  if (ignoreUntagged) await visitor.send({ name: 'page_view', path: '/about', pageKind: 'other' });
  await world.travel(lastAgoDays * DAY + nowAdjustMs);
  return visitor;
}

test('N-17: visit from Reel A on day 1, Post B on day 3, order on day 4: the order goes to Post B', async () => {
  const shop = await addP2Shop(world);
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = await visitAndBuy(shop, { firstAgoDays: 3, lastAgoDays: 1 });
  const order = await storeOrder(shop, visitor, product, buyer);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').count, 1);
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').amountPaise, order.totalPaise);
  assert.equal(stepOf(await funnel(shop, 'REEL_A'), 'sales').count ?? 0, 0);
});

test('N-17: an untagged visit after the tagged one doesn\'t take the order away from it', async () => {
  const shop = await addP2Shop(world);
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = await visitAndBuy(shop, { firstAgoDays: 3, lastAgoDays: 1, ignoreUntagged: true });
  const order = await storeOrder(shop, visitor, product, buyer);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').count, 1);
});

test('N-17: a visit just under 7 days before the order still gets it', async () => {
  const shop = await addP2Shop(world);
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = await visitAndBuy(shop, { firstAgoDays: 8, lastAgoDays: 7, nowAdjustMs: -INSIDE_MS * 2 });
  const order = await storeOrder(shop, visitor, product, buyer);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').count, 1);
});

test('N-17: a visit just over 7 days before the order doesn\'t', async () => {
  const shop = await addP2Shop(world);
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = await visitAndBuy(shop, { firstAgoDays: 8, lastAgoDays: 7, nowAdjustMs: 2000 });
  const order = await storeOrder(shop, visitor, product, buyer);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').count ?? 0, 0);
});

test('N-17: another shopper\'s visit never takes this shopper\'s order, and neither does another business\'s', async () => {
  const shop = await addP2Shop(world);
  const other = await addP2Shop(world);
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = await visitAndBuy(shop, { firstAgoDays: 3, lastAgoDays: 1 });
  await shopper(world, shop, {}).send({ name: 'landing_view', path: '/r/z', pageKind: 'landing', mediaId: 'OTHER_REEL' });
  await shopper(world, other, { vid: visitor.visitorId }).send({ name: 'landing_view', path: '/r/x', pageKind: 'landing', mediaId: 'THEIR_REEL' });
  await world.travel(1000);
  const order = await storeOrder(shop, visitor, product, buyer);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'POST_B'), 'sales').count, 1);
  assert.equal(stepOf(await funnel(shop, 'OTHER_REEL'), 'sales').count ?? 0, 0);
  assert.equal((await other.raw('/insights/funnels/POST_B')).status, 404);
});

// ---- N-18 ------------------------------------------------------------------------------------------------------------

async function paidOrder(shop) {
  const [buyer, product] = await Promise.all([shop.addCustomer(), addProduct(shop, 'Lamp')]);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'landing_view', path: '/r/a', pageKind: 'landing', mediaId: 'REEL_C' });
  await shop.settle({ ms: 1500, roundMs: 200 });
  const order = await storeOrder(shop, visitor, product, buyer);
  return order;
}

test('N-18: a paid order later cancelled drops out of revenue and the order count on the next refresh', async () => {
  const shop = await addP2Shop(world);
  const order = await paidOrder(shop);
  await setOrderStatus(shop, order.id, 'paid');
  await shop.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(shop, 'REEL_C'), 'sales').count, 1);
  await setOrderStatus(shop, order.id, 'cancelled');
  await shop.settle({ ms: 4000 });
  const sales = stepOf(await funnel(shop, 'REEL_C'), 'sales');
  assert.equal(sales.count ?? 0, 0);
  assert.equal(sales.amountPaise ?? 0, 0);
  const [row] = await shop.sql(`SELECT voided_at FROM funnel_events WHERE tenant_id = $1 AND media_id = 'REEL_C' AND stage = 'sales'`, [shop.tenantId]);
  assert.ok(row?.voided_at, 'The sale is marked void, not lost');
});

for (const [status, counts] of [['awaiting_payment', false], ['payment_submitted', false], ['paid', true], ['shipped', true], ['delivered', true], ['cancelled', false]]) {
  test(`N-18: an order that is ${status} ${counts ? 'counts' : 'doesn\'t count'} as revenue`, async () => {
    const shop = await addP2Shop(world);
    const order = await paidOrder(shop);
    if (status !== 'awaiting_payment') await setOrderStatus(shop, order.id, status);
    await shop.settle({ ms: 4000 });
    const sales = stepOf(await funnel(shop, 'REEL_C'), 'sales');
    assert.equal(sales.count ?? 0, counts ? 1 : 0);
    assert.equal(sales.amountPaise ?? 0, counts ? order.totalPaise : 0);
  });
}

test('N-18: a shopper\'s browser can\'t make revenue: an order beacon with a value adds none', async () => {
  const shop = await addP2Shop(world);
  await paidOrder(shop);
  const before = (await shop.get('/traffic/summary', { range: '7' })).revenuePaise.value;
  await shopper(world, shop).beacon({ name: 'order', path: '/order/x', mediaId: 'REEL_C', valuePaise: 99_999_900 });
  await shopper(world, shop).beacon({ name: 'payment_success', path: '/order/x', mediaId: 'REEL_C', valuePaise: 99_999_900 });
  await shop.settle({ ms: 3000 });
  const after = (await shop.get('/traffic/summary', { range: '7' })).revenuePaise.value;
  assert.equal(after, before, 'Revenue comes from orders, not from what a page says');
  assert.equal(stepOf(await funnel(shop, 'REEL_C'), 'sales').amountPaise ?? 0, 0);
});

test('N-18: one business cancelling an order leaves another business\'s revenue alone', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const orderA = await paidOrder(a);
  const orderB = await paidOrder(b);
  await setOrderStatus(a, orderA.id, 'paid');
  await setOrderStatus(b, orderB.id, 'paid');
  await setOrderStatus(a, orderA.id, 'cancelled');
  await a.settle({ ms: 4000 });
  await b.settle({ ms: 4000 });
  assert.equal(stepOf(await funnel(b, 'REEL_C'), 'sales').count, 1);
});

// ---- N-19 ------------------------------------------------------------------------------------------------------------

test('N-19: after a run the funnel tables hold hashed subjects and no usernames', async (t) => {
  const logs = captureLogs(t);
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const person = world.fan('secretperson');
  await shop.comment(auto.mediaId, { from: person, text: 'price please call 9876543210' });
  await shop.settle({ ms: 8000 });
  await shop.tap(person, await tapPayload(shop, person));
  await shop.settle({ ms: 8000 });
  const rows = await shop.sql('SELECT * FROM funnel_events WHERE tenant_id = $1', [shop.tenantId]);
  assert.ok(rows.length >= 3, `The run left funnel rows: ${rows.length}`);
  const expected = await shop.hash(person.id);
  for (const row of rows) {
    if (row.subject_hash) {
      assert.match(row.subject_hash, /^[0-9a-f]{64}$/);
      assert.equal(row.subject_hash, expected, 'The one hash a person has');
    }
  }
  const dump = JSON.stringify(rows) + JSON.stringify(await shop.sql('SELECT * FROM funnel_daily WHERE tenant_id = $1', [shop.tenantId]));
  for (const secret of [person.username, person.id, '9876543210']) assert.equal(dump.includes(secret), false, `Funnel tables hold ${secret}`);
  const lines = logs.text();
  for (const secret of [person.username, 'price please call', '9876543210']) assert.equal(lines.includes(secret), false, `Logs hold ${secret}`);
});

test('N-19: subjects are salted per business: the same person has different hashes at two businesses', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const person = world.fan();
  assert.notEqual(await a.hash(person.id), await b.hash(person.id));
});

test('N-19: no funnel table has a column for a username, a phone or a message', async () => {
  const shop = await addP2Shop(world);
  const columns = await shop.sql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('funnel_events', 'funnel_daily') AND column_name ~ '(user|phone|text|message|name)'`);
  assert.deepEqual(columns.filter((c) => !['event_name'].includes(c.column_name)), []);
});

// ---- N-73 to N-79 -----------------------------------------------------------------------------------------------------

test('N-73: an Amazon reel in one-tap mode shows not available, with no estimate, and its DMs still show', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap' });
  await comments(world, shop, auto.mediaId, 2);
  await shop.settle({ ms: 8000 });
  const res = await funnel(shop, auto.mediaId);
  notAvailable(stepOf(res, 'taps_or_visits'), 'One-tap Amazon');
  assert.equal(stepOf(res, 'dms').count, 2);
  assert.deepEqual([res.linkType, res.linkMode], ['amazon', 'one_tap']);
});

for (const [linkType, oneTap] of [['amazon', false], ['affiliate', false], ['whatsapp', false], ['bhava_page', true]]) {
  test(`N-73: ${linkType} in one-tap mode ${oneTap ? 'is visits measured by Bhava' : 'is not available'}`, async () => {
    const shop = await addP2Shop(world);
    const id = await reelWithFunnel(shop, { dms: 25, taps: oneTap ? 5 : 0, origin: 'bhava_page' }, { linkType, linkMode: 'one_tap' });
    const step = stepOf(await funnel(shop, id), 'taps_or_visits');
    if (oneTap) assert.deepEqual([step.state, step.source, step.count], ['ok', 'bhava', 5]);
    else notAvailable(step, linkType);
  });
}

for (const linkType of ['bhava_page', 'seller_site', 'amazon', 'affiliate', 'whatsapp']) {
  test(`N-75: ${linkType} in two-tap mode is exact taps, measured by Bhava`, async () => {
    const shop = await addP2Shop(world);
    const id = await reelWithFunnel(shop, { dms: 25, taps: 7, origin: 'two_tap' }, { linkType, linkMode: 'two_tap' });
    const step = stepOf(await funnel(shop, id), 'taps_or_visits');
    assert.deepEqual([step.state, step.source, step.count], ['ok', 'bhava', 7]);
  });
}

test('N-74: an uploaded Amazon report shows the reel\'s earnings in rupees, from the destination, and taps stay not available', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap', amazonTag: 'specstore-21' });
  const csv = `Date,Tracking ID,Items Shipped,Revenue(Rs),Earnings(Rs)\n${isoYesterday()},specstore-21,3,"4,500.00",1234.50\n`;
  const form = multipart('file', 'earnings.csv', 'text/csv', csv);
  const row = need(await shop.api('/destinations/reports?source=amazon', { method: 'POST', headers: form.headers, body: form.body }), 201, 'The upload').json();
  assert.equal(row.rowsImported, 1);
  assert.equal(row.rowsUnmatched, 0);
  await shop.settle({ ms: 3000 });
  const res = await funnel(shop, auto.mediaId);
  const sales = stepOf(res, 'sales');
  assert.equal(sales.amountPaise, 123450);
  assert.equal(sales.source, 'destination');
  assert.equal(SOURCE_LABELS[sales.source], 'From the destination');
  notAvailable(stepOf(res, 'taps_or_visits'), 'Taps after the report');
});

function isoYesterday() {
  return new Date(Date.now() - DAY).toISOString().slice(0, 10);
}
async function uploadAmazon(shop, csv) {
  const form = multipart('file', 'earnings.csv', 'text/csv', csv);
  return shop.api('/destinations/reports?source=amazon', { method: 'POST', headers: form.headers, body: form.body });
}

test('N-74: the same report uploaded twice doesn\'t double the earnings', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap', amazonTag: 'twice-21' });
  const csv = `Date,Tracking ID,Earnings(Rs)\n${isoYesterday()},twice-21,100.00\n`;
  need(await uploadAmazon(shop, csv), 201, 'The first upload');
  need(await uploadAmazon(shop, csv), 201, 'The second upload');
  await shop.settle({ ms: 3000 });
  assert.equal(stepOf(await funnel(shop, auto.mediaId), 'sales').amountPaise, 10000);
});

test('N-74: a tracking id that isn\'t this business\'s is unmatched, and earns the other business nothing', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const theirs = await liveReel(b, { linkType: 'amazon', linkMode: 'one_tap', amazonTag: 'theirs-21' });
  const row = need(await uploadAmazon(a, `Date,Tracking ID,Earnings(Rs)\n${isoYesterday()},theirs-21,100.00\n`), 201, 'The upload').json();
  assert.deepEqual([row.rowsImported, row.rowsUnmatched], [0, 1]);
  await b.settle({ ms: 3000 });
  assert.equal(stepOf(await funnel(b, theirs.mediaId), 'sales').amountPaise ?? 0, 0);
});

test('N-74: hostile uploads are refused or unmatched, and nothing runs as a formula or crashes', async () => {
  const shop = await addP2Shop(world);
  for (const csv of ['', '\u0000\u0001garbage', 'not,a,report', `Date,Tracking ID,Earnings(Rs)\n=cmd|' /C calc'!A0,${"'; DROP TABLE tenants;--"},1e308\n`, `Date,Tracking ID,Earnings(Rs)\n${isoYesterday()},x-21,-5.00\n`]) {
    const res = await uploadAmazon(shop, csv);
    assert.ok([201, 400].includes(res.status), `Got ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const png = multipart('file', 'x.png', 'image/png', Buffer.from('89504e47', 'hex'));
  assert.ok([400, 415].includes((await shop.api('/destinations/reports?source=amazon', { method: 'POST', headers: png.headers, body: png.body })).status));
  const huge = multipart('file', 'x.csv', 'text/csv', Buffer.alloc(5 * 1024 * 1024 + 10, 'a'));
  assert.ok([400, 413].includes((await shop.api('/destinations/reports?source=amazon', { method: 'POST', headers: huge.headers, body: huge.body })).status));
  assert.ok((await shop.sql('SELECT count(*)::int AS n FROM tenants'))[0].n > 0);
});

test('N-74: only owners and managers upload, and a business sees only its own uploads', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const staff = await a.addStaff(['analytics']);
  const form = multipart('file', 'earnings.csv', 'text/csv', 'Date,Tracking ID,Earnings(Rs)\n');
  assert.equal((await a.as(staff.token, '/destinations/reports?source=amazon', { method: 'POST', headers: form.headers, body: form.body })).status, 403);
  need(await uploadAmazon(a, 'Date,Tracking ID,Earnings(Rs)\n'), 201, 'The upload');
  assert.deepEqual((await b.get('/destinations/reports')).items, []);
});

test('N-75: 50 DMs sent, 30 people tap, 5 of them twice: exactly 30, Measured by Bhava', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const people = await comments(world, shop, auto.mediaId, 50);
  assert.equal((await waitForDms(shop, 50)).length, 50, 'Every comment got its DM');
  const tappers = people.slice(0, 30);
  for (const person of tappers) await shop.tap(person, await tapPayload(shop, person));
  for (const person of tappers.slice(0, 5)) await shop.tap(person, await tapPayload(shop, person));
  await shop.settle({ ms: 30_000 });
  const res = await funnel(shop, auto.mediaId);
  assert.equal(stepOf(res, 'dms').count, 50);
  const taps = stepOf(res, 'taps_or_visits');
  assert.deepEqual([taps.count, taps.source], [30, 'bhava']);
});

test('N-76: every step that has a figure carries its label, and Meta\'s reach is never added to a Bhava count', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'bhava_page', linkMode: 'two_tap' });
  await shop.seedMedia({ mediaId: auto.mediaId, kind: 'reel', latest: { reach: 99999, views: 123456 } });
  await shop.seedFunnel(auto.mediaId, { comments: 40, dms: 38, seen: 30, taps: 25, linkType: 'bhava_page', linkMode: 'two_tap' });
  await shop.settle({ ms: 2500, roundMs: 250 });
  const res = await funnel(shop, auto.mediaId);
  for (const step of res.steps) if (step.state === 'ok') assert.ok(['bhava', 'platform', 'destination'].includes(step.source), `${step.stage} has no label`);
  assert.deepEqual(res.steps.slice(0, 4).map((s) => s.count), [40, 38, 30, 25]);
  assert.deepEqual([res.platform.reach, res.platform.views, res.platform.source], [99999, 123456, 'platform']);
  assert.ok(res.steps.every((s) => s.count !== 99999 && s.count !== 123456));
});

test('N-76: Meta\'s figures in the list of funnels stay on their own, per content kind', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'bhava_page', linkMode: 'two_tap' });
  await shop.seedMedia({ mediaId: auto.mediaId, kind: 'reel', latest: { reach: 500 } });
  await shop.seedFunnel(auto.mediaId, { comments: 5 });
  await shop.settle({ ms: 2500, roundMs: 250 });
  const { items } = await shop.get('/insights/funnels', { kind: 'reel' });
  const row = items.find((f) => f.mediaId === auto.mediaId);
  assert.equal(row.platform.source, 'platform');
  assert.equal((await shop.get('/insights/funnels', { kind: 'story' })).items.some((f) => f.mediaId === auto.mediaId), false);
});

test('N-77: with read receipts off, Seen shows Not available and the reason, and the other steps still show', async (t) => {
  const own = await openP2World({ overrides: { readReceipts: false } });
  t.after(() => own.close());
  const shop = await addP2Shop(own);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'two_tap' });
  const [person] = await comments(own, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const [dm] = await shop.dms({ recipientId: person.id });
  await shop.tap(person, dm.message.attachment.payload.buttons[0].payload);
  await shop.settle({ ms: 8000 });
  const res = need(await shop.api(`/insights/funnels/${auto.mediaId}`), 200, 'The funnel').json();
  const seen = stepOf(res, 'seen');
  assert.equal(seen.state, 'not_available');
  assertNoFigure(seen.count, 'Seen');
  assert.match(seen.reason ?? '', /not available/i);
  assert.ok((seen.reason ?? '').length > 15, 'It says why');
  assert.equal(stepOf(res, 'dms').count, 1);
  assert.equal(stepOf(res, 'taps_or_visits').count, 1);
});

test('N-78: a one-tap link to the seller\'s site with a code order: taps not available, and the code order counts, from the destination', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'one_tap' });
  await shop.sql(`INSERT INTO destination_figures (tenant_id, source, media_id, day, orders, earnings_paise) VALUES ($1, 'discount_code', $2, $3, 1, 250000)`, [shop.tenantId, auto.mediaId, isoYesterday()]);
  await shop.settle({ ms: 2500, roundMs: 250 });
  const res = await funnel(shop, auto.mediaId);
  notAvailable(stepOf(res, 'taps_or_visits'), 'One-tap to the seller\'s site');
  const sales = stepOf(res, 'sales');
  assert.equal(sales.source, 'destination');
  assert.deepEqual(sales.origins.map((o) => [o.origin, o.count, o.source]), [['discount_code', 1, 'destination']]);
  assert.equal(sales.amountPaise, 250000);
});

test('N-79: one-tap to the seller\'s site with no GA4 or tag: not available; DMs and Seen still show', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { comments: 25, dms: 22, seen: 21 }, { linkType: 'seller_site', linkMode: 'one_tap' });
  const res = await funnel(shop, id);
  notAvailable(stepOf(res, 'taps_or_visits'), 'One-tap to the seller\'s site');
  assert.deepEqual([stepOf(res, 'dms').count, stepOf(res, 'seen').count], [22, 21]);
});

test('N-79: once the seller\'s site tag is on, UTM visits show, labelled from the destination, and its snippet names no platform', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { comments: 25, dms: 22, seen: 21 }, { linkType: 'seller_site', linkMode: 'one_tap' });
  const tag = await need(await shop.api('/destinations/site-tag', { method: 'PUT', body: { enabled: true } }), 200, 'Turning the site tag on').json();
  assert.equal(tag.enabled, true);
  assert.ok(tag.snippet.length > 0, 'There is a snippet to paste');
  assert.doesNotMatch(tag.snippet, /bhava/i);
  await shop.sql(`INSERT INTO destination_figures (tenant_id, source, media_id, day, visits) VALUES ($1, 'site_tag', $2, $3, 12)`, [shop.tenantId, id, isoYesterday()]);
  await shop.settle({ ms: 2500, roundMs: 250 });
  const step = stepOf(await funnel(shop, id), 'taps_or_visits');
  assert.deepEqual([step.state, step.count, step.source], ['ok', 12, 'destination']);
  assert.deepEqual(step.origins.map((o) => o.origin), ['utm']);
});

test('N-79: a site tag switched off again is empty and the step goes back to not available', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { dms: 22 }, { linkType: 'seller_site', linkMode: 'one_tap' });
  need(await shop.api('/destinations/site-tag', { method: 'PUT', body: { enabled: true } }), 200, 'On');
  const off = need(await shop.api('/destinations/site-tag', { method: 'PUT', body: { enabled: false } }), 200, 'Off').json();
  assert.deepEqual([off.enabled, off.snippet], [false, '']);
  notAvailable(stepOf(await funnel(shop, id), 'taps_or_visits'), 'After switching off');
});

test('N-79: a connected GA4 reports visits the same way; staff can\'t change the site tag', async () => {
  const shop = await addP2Shop(world);
  const id = await reelWithFunnel(shop, { dms: 22 }, { linkType: 'seller_site', linkMode: 'one_tap' });
  await shop.sql(`INSERT INTO destination_connections (tenant_id, source, enabled, connected_at) VALUES ($1, 'ga4', true, now())`, [shop.tenantId]);
  await shop.sql(`INSERT INTO destination_figures (tenant_id, source, media_id, day, visits) VALUES ($1, 'ga4', $2, $3, 9)`, [shop.tenantId, id, isoYesterday()]);
  await shop.settle({ ms: 2500, roundMs: 250 });
  const step = stepOf(await funnel(shop, id), 'taps_or_visits');
  assert.deepEqual([step.state, step.count, step.source], ['ok', 9, 'destination']);
  const staff = await shop.addStaff(['analytics']);
  assert.equal((await shop.as(staff.token, '/destinations/site-tag', { method: 'PUT', body: { enabled: true } })).status, 403);
  assert.ok((await shop.get('/destinations/connections')).items.some((c) => c.source === 'ga4' && c.enabled));
});

test('N-19: a hash in the funnel is not simply the sha256 of the person\'s id', async () => {
  const shop = await addP2Shop(world);
  const person = world.fan();
  assert.notEqual(await shop.hash(person.id), crypto.createHash('sha256').update(person.id).digest('hex'));
});
