// PRD 7.10: every visit on the seller's own pages, from the beacon to the screens, with nothing that can name a shopper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VISITOR_COOKIE, TRAFFIC_PATHS } from '../../../src/contracts/analytics.js';
import { setLogSink } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { login, seedReel } from '../../helpers.js';
import { CHROME_UA, INSTAGRAM_UA, WHATSAPP_CRAWLER_UA, api, beacon, newVisitor, page, raw, secondBusiness, startTraffic } from './support.js';

const DM_UTM = { source: 'instagram', medium: 'dm', campaign: 'brunch', content: '18475694065114168' };

async function waitFor(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('it never happened');
}
const summary = async (world, query = '') => (await api(world, `/traffic/summary${query}`)).body;

test('N-45: a comment DM visit in the Instagram app is one session, with its source and page views', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = newVisitor();
  const hit = (fields) => beacon(world, fields, { visitor, ua: INSTAGRAM_UA });
  await hit({ name: 'page_view', path: '/r/brunch', pageKind: 'landing', pageRef: 'brunch', utm: DM_UTM });
  await hit({ name: 'landing_view', path: '/r/brunch', pageKind: 'landing', pageRef: 'brunch', utm: DM_UTM });
  for (const slug of ['a', 'b', 'c']) {
    await hit({ name: 'page_view', path: `/p/${slug}`, pageKind: 'product', pageRef: slug });
    await hit({ name: 'product_view', path: `/p/${slug}`, pageKind: 'product', pageRef: slug });
  }
  await hit({ name: 'product_tap', path: '/p/c', pageKind: 'product', pageRef: 'c' });

  const s = await summary(world);
  assert.equal(s.sessions.value, 1);
  assert.equal(s.pageViews.value, 4);
  assert.equal(s.productTaps.value, 1);
  assert.equal(s.visitors.value, 1);
  const sources = (await api(world, '/traffic/sources')).body;
  assert.equal(sources.items[0].source, 'instagram_comment_dm');
  assert.equal(sources.label, 'bhava');
  const inApp = (await api(world, '/traffic/breakdown?by=in_app')).body;
  assert.deepEqual(inApp.items.map((i) => [i.key, i.sessions]), [['instagram', 1]]);
});

test('N-46: the same visitor the next day is a returning visitor from the bio link, and one unique visitor', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/r/brunch', pageKind: 'landing', pageRef: 'brunch', utm: DM_UTM }, { visitor });
  world.clock.now += 86_400_000;
  await beacon(world, { name: 'page_view', path: '/shop', src: 'bio' }, { visitor });
  const s = await summary(world, '?range=7');
  assert.equal(s.sessions.value, 2);
  assert.equal(s.visitors.value, 1);
  assert.equal(s.returningVisitors.value, 1);
  const sources = (await api(world, '/traffic/sources?range=7')).body.items.map((i) => i.source).sort();
  assert.deepEqual(sources, ['bio_link', 'instagram_comment_dm']);
});

test('a session ends after 30 quiet minutes, and at midnight in the business\'s time zone', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/' }, { visitor });
  world.clock.now += 29 * 60_000;
  await beacon(world, { name: 'page_view', path: '/shop' }, { visitor });
  assert.equal((await summary(world)).sessions.value, 1);
  world.clock.now += 31 * 60_000;
  await beacon(world, { name: 'page_view', path: '/' }, { visitor });
  assert.equal((await summary(world)).sessions.value, 2);
  world.clock.now = Date.parse('2026-11-05T18:29:00Z'); // 23:59 in India
  await beacon(world, { name: 'page_view', path: '/' }, { visitor });
  world.clock.now = Date.parse('2026-11-05T18:31:00Z'); // 00:01 the next day
  await beacon(world, { name: 'page_view', path: '/shop' }, { visitor });
  assert.equal((await summary(world)).sessions.value, 4);
});

test('N-47: a link-preview crawler is a preview, with no session or page view, and gets no script', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await seedReel(world.repos);
  const res = await page(world, '/r/brunch-edit', { ua: WHATSAPP_CRAWLER_UA });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(TRAFFIC_PATHS.script));
  assert.ok(!res.headers['set-cookie']?.join('').includes(VISITOR_COOKIE));
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: newVisitor(), ua: WHATSAPP_CRAWLER_UA });
  const s = await summary(world);
  assert.equal(s.sessions.value, 0);
  assert.equal(s.pageViews.value, 0);
  assert.equal(s.previews, 2);
  const rows = await withTenant(world.tenant, () => world.db.query('SELECT kind, n FROM traffic_previews'));
  assert.ok(rows.length && rows.every((r) => r.kind === 'crawler'));
});

test('N-16: an owner preview and a signed-in team member are not visits', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await seedReel(world.repos);
  const preview = await page(world, '/r/brunch-edit?preview=1');
  assert.ok(!preview.text.includes(TRAFFIC_PATHS.script));
  const fromPreview = await beacon(world, { name: 'page_view', path: '/r/brunch-edit' }, { visitor: newVisitor(), headers: { referer: 'https://shop.test/r/brunch-edit?preview=1' } });
  assert.equal(fromPreview.status, 204);
  const s = await summary(world);
  assert.equal(s.sessions.value, 0);
  assert.equal(s.previews, 2);
});

test('N-48: twelve visitors active in the last 30 minutes show in real time, with top pages and sources', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  for (let i = 0; i < 12; i += 1) await beacon(world, { name: 'page_view', path: '/r/brunch', pageKind: 'landing', pageRef: 'brunch', utm: DM_UTM }, { visitor: newVisitor() });
  const live = (await api(world, '/traffic/realtime')).body;
  assert.equal(live.active, 12);
  assert.equal(live.topPages[0].active, 12);
  assert.equal(live.topSources[0].source, 'instagram_comment_dm');
  world.clock.now += 31 * 60_000;
  assert.equal((await api(world, '/traffic/realtime')).body.active, 0);
});

test('N-49: another business\'s landing slug returns no rows, and the attempt is logged with ids only', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  await seedReel(other.repos);
  await beacon(world, { name: 'page_view', path: '/r/brunch-edit', pageKind: 'landing', pageRef: 'brunch-edit' }, { visitor: newVisitor(), host: other.host });
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
  const answer = (await api(world, '/traffic/summary?page=brunch-edit')).body;
  assert.equal(answer.sessions.value, 0);
  assert.equal((await api(world, '/traffic/sources?page=brunch-edit')).body.items.length, 0);
  assert.ok(lines.some((l) => l.includes('traffic.page_not_found')));
  const theirs = (await api(world, '/traffic/summary', { token: other.token, host: other.host })).body;
  assert.equal(theirs.sessions.value, 1);
});

test('N-50: no raw IP, full user agent or platform name is stored or served', async (t) => {
  const world = await startTraffic({ overrides: { geoTable: { '127.0.0.1': { city: 'Pune', state: 'Maharashtra' } } } });
  t.after(world.close);
  await seedReel(world.repos);
  const home = await page(world, '/r/brunch-edit', { ua: INSTAGRAM_UA });
  assert.ok(home.text.includes(TRAFFIC_PATHS.script), 'the script is on the page');
  assert.ok(!/bhava/i.test(home.text), 'nothing on the page names the platform');
  const script = await raw(world.port, TRAFFIC_PATHS.script);
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);
  assert.ok(!/bhava/i.test(script.text));
  assert.ok(!/bhava/i.test(TRAFFIC_PATHS.script + TRAFFIC_PATHS.event + VISITOR_COOKIE));

  await beacon(world, { name: 'page_view', path: '/r/brunch-edit', pageKind: 'landing', pageRef: 'brunch-edit', referrer: 'https://example.com/p?secret=1' }, { visitor: newVisitor(), ua: INSTAGRAM_UA });
  const stored = JSON.stringify(await withTenant(world.tenant, async () => [
    await world.db.query('SELECT * FROM traffic_events'),
    await world.db.query('SELECT * FROM traffic_sessions'),
    await world.db.query('SELECT * FROM traffic_visitors'),
  ]));
  assert.ok(!stored.includes('Instagram 300'), 'no user agent');
  assert.ok(!stored.includes('127.0.0.1'), 'no IP');
  assert.ok(!stored.includes('secret=1'), 'no query string from a referrer');
  assert.ok(!/bhava/i.test(stored));
  assert.ok(stored.includes('Pune'), 'the derived city is kept');
  const columns = await world.db.platform.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('traffic_events', 'traffic_sessions', 'traffic_visitors') AND (column_name LIKE '%ip%' OR column_name LIKE '%agent%')`);
  assert.deepEqual(columns, []);
});

test('N-60: with cookies blocked, two visits are two sessions and no visitor is recorded', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: null });
  await beacon(world, { name: 'page_view', path: '/shop' }, { visitor: null });
  const s = await summary(world);
  assert.equal(s.sessions.value, 2);
  assert.equal(s.visitors.value, 0);
  const visitors = await withTenant(world.tenant, () => world.db.query('SELECT 1 FROM traffic_visitors'));
  assert.equal(visitors.length, 0);
});

test('with cookies blocked, one page load is still one session', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: null, query: '?v=tab-1' });
  await beacon(world, { name: 'product_tap', path: '/', pageKind: 'product', pageRef: 'x' }, { visitor: null, query: '?v=tab-1' });
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: null, query: '?v=tab-2' });
  assert.equal((await summary(world)).sessions.value, 2);
});

test('a hit before the first cookie joins the session it started, once the browser sends the cookie back', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const first = await beacon(world, { name: 'page_view', path: '/r/x', pageKind: 'landing', pageRef: 'x' }, { visitor: null });
  const cookie = /_vid=([0-9a-f-]+)/.exec(first.headers['set-cookie'].join(''))[1];
  await beacon(world, { name: 'page_view', path: '/p/y', pageKind: 'product', pageRef: 'y' }, { visitor: cookie });
  const s = await summary(world);
  assert.equal(s.sessions.value, 1);
  assert.equal(s.visitors.value, 1);
  assert.equal(s.newVisitors.value, 1);
});

test('the page sets a first-party visitor cookie, and a repeat of the same beacon counts once', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  await seedReel(world.repos);
  const res = await page(world, '/r/brunch-edit', { ua: CHROME_UA });
  assert.match(res.headers['set-cookie'].join(''), new RegExp(`${VISITOR_COOKIE}=[0-9a-f-]{36}; Max-Age=\\d+; Path=/; .*HttpOnly`));
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/', eventId: 'abc' }, { visitor });
  await beacon(world, { name: 'page_view', path: '/', eventId: 'abc', engagedMs: 4000 }, { visitor });
  const s = await summary(world);
  assert.equal(s.pageViews.value, 1);
  assert.equal(s.medianEngagedMs.value, 4000);
});

test('a browser can\'t claim an order or a sale, a forged id is dropped, and an outside origin is refused', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  const { products } = await seedReel(other.repos, { n: 1 });
  const visitor = newVisitor();
  await beacon(world, { name: 'order', path: '/', valuePaise: 99_999_999 }, { visitor });
  await beacon(world, { name: 'payment_success', path: '/', valuePaise: 99_999_999 }, { visitor });
  await beacon(world, { name: 'product_tap', path: '/', productId: products[0].id }, { visitor });
  const s = await summary(world);
  assert.equal(s.orders.value, 0);
  assert.equal(s.revenuePaise.value, 0);
  const [event] = await withTenant(world.tenant, () => world.db.query(`SELECT product_id, value_paise FROM traffic_events WHERE name = 'product_tap'`));
  assert.equal(event.product_id, null, 'another business\'s product is never linked');
  const money = await withTenant(world.tenant, () => world.db.query(`SELECT value_paise FROM traffic_events WHERE name = 'payment_success'`));
  assert.equal(Number(money[0].value_paise), 0);
  const refused = await beacon(world, { name: 'page_view', path: '/' }, { visitor, headers: { origin: 'https://evil.example' } });
  assert.equal(refused.status, 403);
  assert.equal((await beacon(world, { name: 'nonsense', path: '/' }, { visitor })).status, 400);
});

test('a hit\'s business comes from the host, and each business reads only its own traffic', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const other = await secondBusiness(world);
  await beacon(world, { name: 'page_view', path: '/', tenant_id: world.tenant.id, tenantId: world.tenant.id }, { visitor: newVisitor(), host: other.host });
  assert.equal((await summary(world)).sessions.value, 0);
  assert.equal((await api(world, '/traffic/summary', { token: other.token, host: other.host })).body.sessions.value, 1);
  const res = await beacon(world, { name: 'page_view', path: '/' }, { visitor: newVisitor(), host: 'nobody.example' });
  assert.ok(res.status === 204 || res.status === 404);
});

test('the source table, trend, heatmap and pages add up from the same sessions', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { reel } = await seedReel(world.repos);
  for (let i = 0; i < 3; i += 1) await beacon(world, { name: 'page_view', path: `/r/${reel.slug}`, pageKind: 'landing', pageRef: reel.slug, utm: DM_UTM }, { visitor: newVisitor() });
  world.clock.now += 86_400_000;
  await beacon(world, { name: 'page_view', path: '/', src: 'wa' }, { visitor: newVisitor() });

  const trend = (await api(world, '/traffic/trend?range=7&compare=previous')).body;
  assert.equal(trend.points.length, 7);
  assert.deepEqual(trend.points.slice(-2).map((p) => p.sessions), [3, 1]);
  assert.equal(trend.points[0].previous, 0);
  const heat = (await api(world, '/traffic/heatmap?range=7')).body;
  assert.equal(heat.timeZone, 'Asia/Kolkata');
  assert.equal(heat.cells.reduce((sum, c) => sum + c.sessions, 0), 4);
  const pages = (await api(world, '/traffic/pages?range=7&kind=landing')).body;
  assert.equal(pages.items[0].ref, reel.slug);
  assert.equal(pages.items[0].views, 3);
  assert.equal(pages.items[0].title, reel.headline);
});

test('a role and a plan see only what they should', async (t) => {
  const world = await startTraffic({ plan: 'free' });
  t.after(world.close);
  await beacon(world, { name: 'page_view', path: '/' }, { visitor: newVisitor() });
  const s = await summary(world);
  assert.equal(s.sessions.value, 1);
  for (const field of ['addToCart', 'orders', 'revenuePaise', 'productTaps']) assert.ok(s.notIncluded.includes(field), field);
  assert.equal(s.revenuePaise.value, null);
  assert.deepEqual((await api(world, '/traffic/pages')).body.items, []);
  assert.equal((await raw(world.port, '/api/v1/traffic/summary')).status, 401);
});

test('an order placed on the site is tied to the visit that placed it, without slowing or changing the answer', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { products } = await seedReel(world.repos, { n: 1 });
  await world.repos.users.create({ name: 'A Shopper', phone: '9811111111', password: 'secret12' });
  const session = await login(world.base, { phone: '9811111111', password: 'secret12', csrfPage: '/checkout' });
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/checkout', pageKind: 'checkout' }, { visitor });
  const res = await fetch(`${world.base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${session.cookie}; ${VISITOR_COOKIE}=${visitor}`, 'x-csrf-token': session.csrf },
    body: JSON.stringify({ items: [{ productId: products[0].id, qty: 1 }], customer: { name: 'A Shopper', phone: '9811111111', address: '12 Long Road', city: 'Pune', state: 'MH', pincode: '411001' } }),
  });
  assert.equal(res.status, 201);
  await assert.doesNotReject(async () => res.json());
  await waitFor(async () => (await world.inTenant(() => world.db.query(`SELECT 1 FROM traffic_events WHERE name = 'order' AND visitor_id = $1`, [visitor]))).length === 1);
});

test('a real order reaches the visit that placed it, only once paid, and leaves when cancelled', async (t) => {
  const world = await startTraffic();
  t.after(world.close);
  const { products } = await seedReel(world.repos, { n: 1 });
  const visitor = newVisitor();
  await beacon(world, { name: 'page_view', path: '/checkout', pageKind: 'checkout' }, { visitor });
  const settings = await world.repos.settings.getAll();
  const order = await world.repos.orders.create({ items: [{ productId: products[0].id, qty: 2 }], customer: { name: 'A Shopper', phone: '9876543210', address: '12 Long Road', city: 'Pune', state: 'MH', pincode: '411001' } }, settings);
  await withTenant(world.tenant, () => world.services().ingest.linkOrder(order, visitor));
  const run = () => withTenant(world.tenant, () => world.services().sync.run());
  await run();
  assert.equal((await summary(world)).orders.value, 0, 'an unpaid order is not a sale');
  await world.repos.orders.setStatus(order.id, 'paid');
  await run();
  let s = await summary(world);
  assert.equal(s.orders.value, 1);
  assert.equal(s.revenuePaise.value, order.total_paise);
  await world.repos.orders.setStatus(order.id, 'cancelled');
  await run();
  s = await summary(world);
  assert.equal(s.orders.value, 0);
  assert.equal(s.revenuePaise.value, 0);
});
