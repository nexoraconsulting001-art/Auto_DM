// PRD 7.4 and 7.15: the funnel per piece of content, each step with its one source label, and never a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIGURE_TEXT } from '../../../src/contracts/analytics.js';
import { withTenant } from '../../../src/tenancy.js';
import { seedReel, REEL_ID } from '../../helpers.js';
import { NOW, api, beacon, newVisitor, placeOrder, secondBusiness, startTraffic } from './support.js';

const MEDIA = REEL_ID;
const NOT_AVAILABLE = FIGURE_TEXT.notAvailableForLink;

async function automation(world, { mediaId = MEDIA, linkType = 'bhava_page', linkMode = 'two_tap', target = 'reel' } = {}, tenant = world.tenant) {
  const [row] = await world.db.platform.query(
    `INSERT INTO automations (tenant_id, name, slug, state, trigger_type, link_mode, link_type, link_url) VALUES ($1, 'Brunch', $2, 'live', 'comment', $3, $4, 'https://seller.example/x') RETURNING id`,
    [tenant.id, `brunch-${mediaId}`, linkMode, linkType],
  );
  await world.db.platform.query(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id) VALUES ($1, $2, 'instagram', $3, $4)`, [tenant.id, row.id, target, mediaId]);
  return row.id;
}

const dms = (world, n, { mediaId = MEDIA, start = 0, isTest = false } = {}) => Promise.all(Array.from({ length: n }, (_v, i) => world.db.platform.query(
  `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, purpose, idempotency_key, status, media_id, subject_hash, expires_at, sent_at, message_id, is_test)
   VALUES ($1, 'instagram', 'ME', 'private_reply', 'trigger', $2, 'sent', $3, $4, now() + interval '1 day', $5::timestamptz, $6, $7)`,
  [world.tenant.id, `private_reply:${mediaId}:${start + i}`, mediaId, 'a'.repeat(63) + (i % 10), new Date(NOW - 3_600_000), `mid-${mediaId}-${start + i}`, isTest],
)));

const taps = (world, automationId, people, { mediaId = MEDIA } = {}) => Promise.all(people.map((person) => world.db.platform.query(
  `INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash, comment_id, tap_count, first_tapped_at, last_tapped_at) VALUES ($1, $2, 'instagram', $3, $4, 'c', $5, $6::timestamptz, $6::timestamptz)`,
  [world.tenant.id, automationId, mediaId, person.hash, person.times ?? 1, new Date(NOW - 1800_000)],
)));

const funnel = async (world, mediaId = MEDIA, extra = {}) => (await api(world, `/insights/funnels/${mediaId}`, extra));
const step = (body, stage) => body.steps.find((s) => s.stage === stage);
const inbound = (world, event) => world.inTenant(() => world.services().sync.onInbound({ channel: 'instagram', receivedAt: new Date(NOW), ...event }));
const person = (i) => ({ hash: String(i).padStart(64, '0') });

test('N-14: comments, DMs, seen, two-tap taps and paid orders, with revenue, rates and source labels', async (t) => {
  const world = await startTraffic({ overrides: { readReceipts: true } });
  t.after(world.close);
  const { products } = await seedReel(world.repos);
  const id = await automation(world, { linkType: 'bhava_page', linkMode: 'two_tap' });
  for (let i = 0; i < 40; i += 1) await inbound(world, { type: 'comment', mediaId: MEDIA, commentId: `c${i}`, subject: person(i).hash });
  await dms(world, 38);
  for (let i = 0; i < 30; i += 1) await inbound(world, { type: 'seen', mid: `mid-${MEDIA}-${i}` });
  await taps(world, id, Array.from({ length: 25 }, (_v, i) => person(i)));
  const orders = [];
  for (let i = 0; i < 4; i += 1) orders.push(await placeOrder(world.repos, { reelId: MEDIA, productId: products[0].id }));
  const expected = orders.reduce((sum, o) => sum + o.total_paise, 0);

  const { status, body } = await funnel(world);
  assert.equal(status, 200);
  assert.deepEqual(body.steps.map((s) => s.count), [40, 38, 30, 25, 4]);
  assert.equal(step(body, 'sales').amountPaise, expected);
  assert.deepEqual(body.steps.map((s) => s.source), ['bhava', 'bhava', 'bhava', 'bhava', 'bhava']);
  assert.deepEqual(body.steps.map((s) => s.rate), [null, 0.95, 0.7895, 0.8333, 0.16]);
  assert.deepEqual([body.linkType, body.linkMode, body.kind, body.channel], ['bhava_page', 'two_tap', 'reel', 'instagram']);
});

test('N-15, N-75: repeat taps count once per person, however many times they tapped', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const id = await automation(world, { linkType: 'seller_site', linkMode: 'two_tap' });
  await dms(world, 50);
  await taps(world, id, Array.from({ length: 30 }, (_v, i) => ({ ...person(i), times: i < 5 ? 2 : 1 })));
  const { body } = await funnel(world);
  const tap = step(body, 'taps_or_visits');
  assert.equal(tap.count, 30);
  assert.equal(tap.source, 'bhava');
  assert.equal(tap.state, 'ok');
  assert.equal((await funnel(world)).body.steps.find((s) => s.stage === 'taps_or_visits').count, 30, 'a rerun adds nothing');
});

test('N-17: an order goes to the last tagged visit within 7 days', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { products } = await seedReel(world.repos);
  const visitor = newVisitor();
  const [reelA, postB] = ['20000000000000001', '20000000000000002'];
  await automation(world, { mediaId: reelA });
  await automation(world, { mediaId: postB, target: 'post' });
  const day = 86_400_000;
  await beacon(world, { name: 'page_view', path: '/a', mediaId: reelA }, { visitor });
  world.clock.now += 2 * day;
  await beacon(world, { name: 'page_view', path: '/b', mediaId: postB }, { visitor });
  world.clock.now += day;
  const order = await placeOrder(world.repos, { status: 'awaiting_payment', productId: products[0].id });
  await world.inTenant(() => world.services().ingest.linkOrder(order, visitor));
  await world.repos.orders.setStatus(order.id, 'paid');
  assert.equal(step((await funnel(world, postB)).body, 'sales').count, 1);
  assert.equal(step((await funnel(world, reelA)).body, 'sales').count, 0);
});

test('an order a week and a day after the visit goes to no visit', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { products } = await seedReel(world.repos);
  const visitor = newVisitor();
  const reelA = '20000000000000003';
  await automation(world, { mediaId: reelA });
  await beacon(world, { name: 'page_view', path: '/a', mediaId: reelA }, { visitor });
  world.clock.now += 8 * 86_400_000;
  const order = await placeOrder(world.repos, { status: 'awaiting_payment', productId: products[0].id });
  await world.inTenant(() => world.services().ingest.linkOrder(order, visitor));
  await world.repos.orders.setStatus(order.id, 'paid');
  assert.equal(step((await funnel(world, reelA)).body, 'sales').count, 0);
});

test('N-18: a paid order later cancelled drops out on the next refresh', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { products } = await seedReel(world.repos);
  const order = await placeOrder(world.repos, { reelId: MEDIA, productId: products[0].id });
  assert.equal(step((await funnel(world)).body, 'sales').count, 1);
  await world.repos.orders.setStatus(order.id, 'cancelled');
  const sales = step((await funnel(world)).body, 'sales');
  assert.equal(sales.count, 0);
  assert.equal(sales.amountPaise, 0);
});

test('N-19: funnel rows hold hashed subjects only, and no username or message text', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await automation(world);
  await inbound(world, { type: 'comment', mediaId: MEDIA, commentId: 'c1', subject: 'b'.repeat(64), username: 'a.shopper', text: 'price please', personId: '12345' });
  await funnel(world);
  const rows = await withTenant(world.tenant, () => world.db.query('SELECT * FROM funnel_events'));
  assert.equal(rows[0].subject_hash, 'b'.repeat(64));
  assert.ok(!/a\.shopper|price please|12345/.test(JSON.stringify(rows)));
  const columns = await world.db.platform.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'funnel_events' AND column_name IN ('username', 'text', 'phone')`);
  assert.deepEqual(columns, []);
});

test('N-73, N-80: a one-tap Amazon reel shows "not available", and no click is recorded or estimated', async (t) => {
  const world = await startTraffic({ overrides: { readReceipts: true } });
  t.after(world.close);
  await automation(world, { linkType: 'amazon', linkMode: 'one_tap' });
  await dms(world, 25);
  const { body } = await funnel(world);
  const tap = step(body, 'taps_or_visits');
  assert.deepEqual([tap.state, tap.count, tap.reason, tap.source], ['not_available', null, NOT_AVAILABLE, null]);
  assert.equal(step(body, 'dms').count, 25);
  const events = await withTenant(world.tenant, () => world.db.query('SELECT 1 FROM traffic_events'));
  assert.equal(events.length, 0);
});

test('N-74: an uploaded Amazon report shows the reel\'s earnings, labelled from the destination, and taps stay not available', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await automation(world, { linkType: 'amazon', linkMode: 'one_tap' });
  await world.db.platform.query(`INSERT INTO measurement_ids (tenant_id, media_id, kind, value) VALUES ($1, $2, 'amazon_tag', 'brunch-21')`, [world.tenant.id, MEDIA]);
  const before = step((await funnel(world)).body, 'sales');
  assert.equal(before.state, 'not_available');
  const form = new FormData();
  form.append('file', new Blob(['Tracking ID,Date Shipped,Items Shipped,Ad Fees\nbrunch-21,2026-10-02,3,"1,250.00"\nstranger-21,2026-10-02,1,5.00\n'], { type: 'text/csv' }), 'report.csv');
  const res = await fetch(`${world.base}/api/v1/destinations/reports?source=amazon`, { method: 'POST', headers: { authorization: `Bearer ${world.token}` }, body: form });
  assert.equal(res.status, 201);
  const upload = await res.json();
  assert.deepEqual([upload.rowsImported, upload.rowsUnmatched, upload.periodFrom], [1, 1, '2026-10-02']);
  const { body } = await funnel(world);
  const sales = step(body, 'sales');
  assert.deepEqual([sales.amountPaise, sales.source, sales.state], [125000, 'destination', 'ok']);
  assert.equal(sales.origins[0].origin, 'amazon');
  assert.equal(step(body, 'taps_or_visits').state, 'not_available');
  const connections = (await api(world, '/destinations/connections')).body.items;
  assert.equal(connections.find((c) => c.source === 'amazon').enabled, true);
  assert.equal((await api(world, '/destinations/reports')).body.items.length, 1);
});

test('N-76: every step carries one label, and Meta\'s reach is shown beside the funnel and never added in', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const id = await automation(world, { linkType: 'bhava_page', linkMode: 'two_tap' });
  await taps(world, id, [person(1), person(2)]);
  await world.inTenant(() => world.drivers.analytics.rollups.write('meta_content_daily', [{ day: '2026-11-01', media_id: MEDIA, content_kind: 'reel', reach: 5000, views: 9000 }]));
  const { body } = await funnel(world);
  assert.equal(step(body, 'taps_or_visits').count, 2);
  assert.deepEqual([body.platform.reach, body.platform.views, body.platform.source], [5000, 9000, 'platform']);
  for (const s of body.steps) assert.ok(s.source !== 'platform');
});

test('N-77: with no read receipts, Seen says why and gives no number', async (t) => {
  const world = await startTraffic({ overrides: { readReceipts: false } });
  t.after(world.close);
  await automation(world);
  await dms(world, 5);
  const seen = step((await funnel(world)).body, 'seen');
  assert.deepEqual([seen.state, seen.count, seen.source], ['not_available', null, null]);
  assert.match(seen.reason, /Not available/);
});

test('N-78, N-79: a one-tap seller-site link shows code orders from the destination, and taps only with GA4 or the site tag', async (t) => {
  const world = await startTraffic({ overrides: { readReceipts: true } });
  t.after(world.close);
  await automation(world, { linkType: 'seller_site', linkMode: 'one_tap' });
  await dms(world, 6);
  await inbound(world, { type: 'seen', mid: `mid-${MEDIA}-0` });
  let body = (await funnel(world)).body;
  assert.equal(step(body, 'taps_or_visits').state, 'not_available');
  assert.equal(step(body, 'dms').count, 6);
  assert.equal(step(body, 'seen').count, 1);
  assert.equal(step(body, 'sales').state, 'not_available');

  await world.db.platform.query(`INSERT INTO destination_figures (tenant_id, source, media_id, day, orders, earnings_paise) VALUES ($1, 'discount_code', $2, '2026-11-01', 2, 40000)`, [world.tenant.id, MEDIA]);
  body = (await funnel(world)).body;
  const sales = step(body, 'sales');
  assert.deepEqual([sales.count, sales.amountPaise, sales.source], [2, 40000, 'destination']);

  const tag = (await api(world, '/destinations/site-tag', { method: 'PUT', body: { enabled: true } })).body;
  assert.equal(tag.enabled, true);
  assert.ok(tag.snippet.includes('/_t/d'));
  assert.ok(!/bhava/i.test(tag.snippet.replace('bhava.test', '')));
  await fetch(`${world.base}/_t/d?m=${MEDIA}`, { method: 'POST' });
  await fetch(`${world.base}/_t/d?m=${MEDIA}`, { method: 'POST' });
  const tap = step((await funnel(world)).body, 'taps_or_visits');
  assert.deepEqual([tap.state, tap.count, tap.source], ['ok', 2, 'destination']);
  await api(world, '/destinations/site-tag', { method: 'PUT', body: { enabled: false } });
  await fetch(`${world.base}/_t/d?m=${MEDIA}`, { method: 'POST' });
  assert.equal(step((await funnel(world)).body, 'taps_or_visits').count, 2, 'an off tag reports nothing');
});

test('a Bhava-hosted one-tap page counts its visits, a preview does not, and a tester\'s DM is not a DM', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await automation(world, { linkType: 'bhava_page', linkMode: 'one_tap' });
  await dms(world, 3);
  await dms(world, 2, { start: 100, isTest: true });
  for (let i = 0; i < 4; i += 1) await beacon(world, { name: 'page_view', path: '/r/x', mediaId: MEDIA }, { visitor: newVisitor() });
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/r/x', mediaId: MEDIA }, { visitor });
  await beacon(world, { name: 'page_view', path: '/r/x', mediaId: MEDIA }, { visitor });
  await beacon(world, { name: 'page_view', path: '/r/x', mediaId: MEDIA }, { visitor: newVisitor(), headers: { referer: 'https://shop.test/r/x?preview=1' } });
  const { body } = await funnel(world);
  assert.equal(step(body, 'dms').count, 3);
  assert.equal(step(body, 'taps_or_visits').count, 5, 'one per session, previews left out');
  assert.equal(step(body, 'taps_or_visits').origins[0].origin, 'bhava_page');
});

test('a rate under 20 is low volume, and the tier decides who sees store sales', async (t) => {
  const world = await startTraffic({ plan: 't1' });
  t.after(world.close);
  await automation(world);
  for (let i = 0; i < 10; i += 1) await inbound(world, { type: 'comment', mediaId: MEDIA, commentId: `c${i}`, subject: person(i).hash });
  await dms(world, 8);
  const { body } = await funnel(world);
  assert.deepEqual([step(body, 'dms').rate, step(body, 'dms').lowVolume], [null, true]);
  const sales = step(body, 'sales');
  assert.deepEqual([sales.state, sales.reason], ['not_available', FIGURE_TEXT.needsTier3]);
});

test('the funnel list pages through this business\'s content only, and a stranger\'s media is not found', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  await automation(world, { mediaId: '30000000000000001' });
  await automation(world, { mediaId: '30000000000000002', target: 'post' });
  await automation(world, { mediaId: '30000000000000009' }, other.tenant);
  const first = (await api(world, '/insights/funnels?limit=1')).body;
  assert.deepEqual(first.items.map((i) => i.mediaId), ['30000000000000002']);
  assert.equal(first.items[0].kind, 'feed');
  const second = (await api(world, `/insights/funnels?limit=1&cursor=${first.nextCursor}`)).body;
  assert.deepEqual(second.items.map((i) => i.mediaId), ['30000000000000001']);
  assert.equal(second.nextCursor, null);
  assert.equal((await api(world, '/insights/funnels/30000000000000009')).status, 404);
  assert.equal((await api(world, '/insights/funnels?kind=story')).body.items.length, 0);
});
