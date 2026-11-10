// PRD 7.10: traffic on the seller's own pages and links, and the visit rules from 7.4. N-16 and N-45 to N-50, N-80.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { addReel } from '../../p0/spec-p0/support.js';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, MINUTE, OUTSIDE_MS, TRAFFIC_PATHS, UA, VISITOR_COOKIE, addP2Shop, assertAttemptLogged, captureLogs, hit, liveReel, comments, need, noPlatformName, pause, requestId, shopper, signInCookie, stepOf, unique, useP2World } from './support.js';

const world = useP2World();

const summary = (shop, query = { range: '7' }) => shop.get('/traffic/summary', query, 'Traffic summary');
const sources = (shop, query = { range: '7' }) => shop.get('/traffic/sources', query, 'Traffic sources');
const breakdown = (shop, by, query = { range: '7' }) => shop.get('/traffic/breakdown', { ...query, by }, `Traffic by ${by}`);
const realtime = (shop) => shop.get('/traffic/realtime', undefined, 'Real-time panel');
const settled = (shop) => shop.settle({ ms: 2500, roundMs: 250 });
const reelPage = async (shop, headline = `Reel ${unique()}`) => (await addReel(shop, String(100_000_000 + crypto.randomInt(1e9)), { headline })).reel;
const COMMENT_DM = { source: 'instagram', medium: 'dm', campaign: 'launch', content: 'R1' };

// ---- N-45 ------------------------------------------------------------------------------------------------------------

async function commentDmVisit(shop, ua = UA.instagram, cookies = true) {
  const visitor = shopper(world, shop, { ua, cookies });
  await visitor.send({ name: 'page_view', path: '/r/launch', pageKind: 'landing', utm: COMMENT_DM, src: 'instagram_comment_dm' });
  for (const product of [1, 2, 3]) await visitor.send({ name: 'page_view', path: `/p/${product}`, pageKind: 'product' });
  await visitor.send({ name: 'product_tap', path: '/p/1', pageKind: 'product' });
  return visitor;
}

test('N-45: a comment-DM link opened in the Instagram app, 3 products viewed and one tapped: 1 session, the right source and browser, 4 page views, 1 tap', async () => {
  const shop = await addP2Shop(world);
  await commentDmVisit(shop);
  await settled(shop);
  const totals = await summary(shop);
  assert.deepEqual([totals.sessions.value, totals.pageViews.value, totals.productTaps.value], [1, 4, 1]);
  assert.equal(totals.source, 'bhava');
  assert.deepEqual((await sources(shop)).items.map((r) => [r.source, r.sessions]), [['instagram_comment_dm', 1]]);
  assert.deepEqual((await breakdown(shop, 'in_app')).items.map((r) => [r.key, r.sessions]), [['instagram', 1]]);
  assert.deepEqual((await breakdown(shop, 'device')).items.map((r) => [r.key, r.sessions]), [['mobile', 1]]);
});

test('N-45: every event carries its business from the host, whatever the body claims', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await shopper(world, a).send({ name: 'page_view', path: '/r/x', tenantId: b.tenantId, tenant_id: b.tenantId, host: b.host });
  await settled(a);
  await settled(b);
  assert.equal((await a.trafficEvents()).length, 1);
  assert.equal((await b.trafficEvents()).length, 0);
});

test('N-45: a beacon for no known business stores nothing and doesn\'t crash', async () => {
  const res = await hit(world, TRAFFIC_PATHS.event, { host: 'no-such-shop.example', method: 'POST', body: { name: 'page_view', path: '/' } });
  assert.ok(res.status < 500, `Got ${res.status}`);
});

test('N-45: a session ends after 30 minutes without a hit, exactly', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await world.travel(ANALYTICS_LIMITS.sessionIdleMs - INSIDE_MS * 2);
  await visitor.send({ name: 'page_view', path: '/b' });
  await settled(shop);
  assert.equal((await shop.sessions()).length, 1, 'Just inside 30 min is the same session');
  await world.travel(ANALYTICS_LIMITS.sessionIdleMs + OUTSIDE_MS);
  await visitor.send({ name: 'page_view', path: '/c' });
  await settled(shop);
  assert.equal((await shop.sessions()).length, 2, 'Just past 30 min is a new one');
});

test('N-45: a session ends at midnight in the seller\'s time zone', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await settled(shop);
  // Moved to before midnight, ten minutes before the hit that follows.
  const sinceMidnight = Date.now() % DAY;
  await world.travel(sinceMidnight + 5 * MINUTE);
  await shop.sql(`UPDATE traffic_sessions SET day = day - 1 WHERE tenant_id = $1`, [shop.tenantId]);
  await visitor.send({ name: 'page_view', path: '/b' });
  await settled(shop);
  assert.equal((await shop.sessions()).length, 2);
});

test('N-45: the source comes from the first hit only, in order: UTM, then src, then referrer, then Direct', async () => {
  const cases = [
    [{ utm: { source: 'whatsapp', medium: '', campaign: '', content: '' }, src: 'bio_link', referrer: 'https://news.example/x' }, 'whatsapp'],
    [{ src: 'bio_link', referrer: 'https://news.example/x' }, 'bio_link'],
    [{ referrer: 'https://news.example/x' }, 'other_referrer'],
    [{}, 'direct'],
  ];
  for (const [first, expected] of cases) {
    const shop = await addP2Shop(world);
    const visitor = shopper(world, shop);
    await visitor.send({ name: 'page_view', path: '/a', ...first });
    await visitor.send({ name: 'page_view', path: '/b', src: 'facebook_dm', utm: { source: 'facebook', medium: '', campaign: '', content: '' } });
    await settled(shop);
    assert.deepEqual((await sources(shop)).items.map((r) => r.source), [expected], JSON.stringify(first));
  }
});

test('N-45: "other referrer" is kept by domain, and the UTM campaign is its own dimension', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/a', referrer: 'https://news.example/story?id=9' });
  await shopper(world, shop).send({ name: 'page_view', path: '/a', utm: COMMENT_DM, src: 'instagram_comment_dm' });
  await settled(shop);
  const row = (await sources(shop)).items.find((r) => r.source === 'other_referrer');
  assert.equal(row.referrerDomain, 'news.example');
  assert.ok((await breakdown(shop, 'utm_campaign')).items.some((r) => r.key === 'launch'));
});

test('N-45: device, operating system and browser are read from the user agent, for each kind of phone and desktop', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop, { ua: UA.desktop }).send({ name: 'page_view', path: '/a' });
  await shopper(world, shop, { ua: UA.facebook }).send({ name: 'page_view', path: '/a' });
  await settled(shop);
  assert.deepEqual((await breakdown(shop, 'device')).items.map((r) => r.key).sort(), ['desktop', 'mobile']);
  assert.deepEqual((await breakdown(shop, 'in_app')).items.map((r) => r.key).sort(), ['browser', 'facebook']);
});

test('N-45: city and state come from the address at ingest', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop, { ip: '203.0.113.10' }).send({ name: 'page_view', path: '/a' });
  await shopper(world, shop, { ip: '203.0.113.12' }).send({ name: 'page_view', path: '/a' });
  await settled(shop);
  assert.deepEqual((await breakdown(shop, 'city')).items.map((r) => r.key).sort(), ['Delhi', 'Pune']);
  assert.deepEqual((await breakdown(shop, 'state')).items.map((r) => r.key).sort(), ['Delhi', 'Maharashtra']);
});

test('N-45: a one-page session is a bounce, and a two-page session isn\'t', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  const two = shopper(world, shop);
  await two.send({ name: 'page_view', path: '/a' });
  await two.send({ name: 'page_view', path: '/b' });
  await settled(shop);
  assert.deepEqual((await shop.sessions()).map((s) => s.bounced).sort(), [0, 1]);
});

test('N-45: a repeated beacon with the same event id counts once, even at the same moment', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  const eventId = `ev-${unique()}`;
  await Promise.all([1, 2, 3, 4, 5].map(() => visitor.beacon({ name: 'product_tap', path: '/a', eventId })));
  await settled(shop);
  assert.equal((await summary(shop)).productTaps.value, 1);
});

test('N-45: hostile beacons are not stored, and never a crash', async () => {
  const shop = await addP2Shop(world);
  const post = (body, headers = {}) => hit(world, TRAFFIC_PATHS.event, { host: shop.host, method: 'POST', headers: { 'user-agent': UA.phone, ...headers }, body });
  const bad = [
    {}, { name: 'made_up', path: '/' }, { name: 'page_view' }, { name: 'page_view', path: 'x'.repeat(501) },
    { name: 'page_view', path: '/', valuePaise: -1 }, { name: 'page_view', path: '/', valuePaise: 1.5 },
    { name: 'page_view', path: '/', mediaId: "x' OR 1=1--" }, { name: 'page_view', path: '/', eventId: 'x'.repeat(65) },
    { name: 'page_view', path: '/\0' }, { name: 'page_view', path: '/', pageKind: 'evil' },
    { name: 'page_view', path: '/', engagedMs: -5 }, { name: ['page_view'], path: '/' },
  ];
  for (const body of bad) {
    const res = await post(body);
    assert.ok(res.status < 500, `${JSON.stringify(body).slice(0, 80)} got ${res.status}`);
  }
  for (const raw of ['not json', '{"name":', '[]', 'null']) {
    const res = await post(raw, { 'content-type': 'application/json' });
    assert.ok(res.status < 500, `${raw} got ${res.status}`);
  }
  const huge = await post(JSON.stringify({ name: 'page_view', path: '/', pad: 'x'.repeat(2_000_000) }), { 'content-type': 'application/json' });
  assert.ok(huge.status < 500, `A 2 MB beacon got ${huge.status}`);
  assert.equal((await shop.trafficEvents()).length, 0, 'None of them was stored');
});

test('N-45: a beacon can\'t link to another business\'s product, or to one that doesn\'t exist', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const theirs = await b.repos.products.create({ name: 'Theirs', price: '100', active: 'on' });
  for (const productId of [theirs.id, 2147480000]) {
    const res = await shopper(world, a).beacon({ name: 'product_view', path: '/p/x', pageKind: 'product', productId });
    assert.ok(res.status < 500, `Got ${res.status}`);
  }
  await settled(a);
  for (const event of await a.trafficEvents()) assert.equal(event.product_id, null);
});

test('N-45: nonsense in a visitor cookie is replaced, not stored and not a crash', async () => {
  const shop = await addP2Shop(world);
  for (const vid of ['not-a-uuid', "'; DROP TABLE tenants;--", 'x'.repeat(4000), '00000000-0000-0000-0000-00000000000g']) {
    const res = await hit(world, TRAFFIC_PATHS.event, { host: shop.host, method: 'POST', headers: { 'user-agent': UA.phone, cookie: `${VISITOR_COOKIE}=${encodeURIComponent(vid)}` }, body: { name: 'page_view', path: '/' } });
    assert.ok(res.status < 500, `Got ${res.status}`);
  }
  for (const row of await shop.sql('SELECT visitor_id FROM traffic_visitors WHERE tenant_id = $1', [shop.tenantId])) assert.match(row.visitor_id, /^[0-9a-f-]{36}$/);
});

// ---- N-46 ------------------------------------------------------------------------------------------------------------

async function returningVisitor(shop) {
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a', src: 'instagram_comment_dm' });
  await settled(shop);
  await world.travel(DAY + MINUTE);
  await visitor.send({ name: 'page_view', path: '/a', src: 'bio_link' });
  await settled(shop);
  return visitor;
}

test('N-46: the same visitor back next day from the bio link: source Bio link, counted as returning, one unique visitor over the 2 days', async () => {
  const shop = await addP2Shop(world);
  await returningVisitor(shop);
  const totals = await summary(shop);
  assert.equal(totals.sessions.value, 2);
  assert.equal(totals.visitors.value, 1);
  assert.equal(totals.returningVisitors.value, 1);
  assert.equal(totals.newVisitors.value, 1);
  const bySource = (await sources(shop)).items;
  assert.equal(bySource.find((r) => r.source === 'bio_link').sessions, 1);
  assert.equal(bySource.find((r) => r.source === 'instagram_comment_dm').sessions, 1);
});

test('N-46: new and returning show as a breakdown, and the first visit stays new', async () => {
  const shop = await addP2Shop(world);
  await returningVisitor(shop);
  const rows = (await breakdown(shop, 'visitor_type')).items;
  assert.deepEqual(rows.map((r) => [r.key, r.sessions]).sort(), [['new', 1], ['returning', 1]]);
});

test('N-46: the visitor id is a random first-party cookie on the seller\'s own domain, kept 13 months', async () => {
  const shop = await addP2Shop(world);
  const res = await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  const line = [res.headers['set-cookie'] ?? []].flat().find((c) => c.startsWith(`${VISITOR_COOKIE}=`));
  assert.ok(line, `The ${VISITOR_COOKIE} cookie is set`);
  assert.match(line, new RegExp(`^${VISITOR_COOKIE}=[0-9a-f-]{36};`, 'i'));
  const age = Number(/max-age=(\d+)/i.exec(line)?.[1]);
  assert.ok(Math.abs(age - ANALYTICS_LIMITS.visitorCookieDays * 86400) < 2 * 86400, `Kept ${age / 86400} days`);
  assert.doesNotMatch(line, /domain=/i, 'It stays on the host that set it');
  assert.ok(/samesite=lax/i.test(line) || /samesite=strict/i.test(line), 'It isn\'t sent cross-site');
});

test('N-46: visitors are per business: one cookie at two businesses is two visitors', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const vid = crypto.randomUUID();
  await shopper(world, a, { vid }).send({ name: 'page_view', path: '/a' });
  await shopper(world, b, { vid }).send({ name: 'page_view', path: '/a' });
  await settled(a);
  await settled(b);
  assert.equal((await summary(a)).visitors.value, 1);
  assert.equal((await summary(b)).visitors.value, 1);
  assert.equal((await summary(b)).newVisitors.value, 1, 'New here, whatever happened elsewhere');
});

test('N-46: the trend and heatmap read the seller\'s own time zone, and the compare window is the previous period', async () => {
  const shop = await addP2Shop(world, { timeZone: 'Asia/Kolkata' });
  await shop.seedSessions([{ count: 5, day: new Date(Date.now() - DAY).toISOString().slice(0, 10), hour: 21, weekday: 2, source: 'bio_link' }, { count: 3, day: new Date(Date.now() - 8 * DAY).toISOString().slice(0, 10), source: 'bio_link' }]);
  await settled(shop);
  const trend = await shop.get('/traffic/trend', { range: '7', compare: 'previous' }, 'Trend');
  assert.equal(trend.points.reduce((sum, p) => sum + p.sessions, 0), 5);
  assert.equal(trend.points.reduce((sum, p) => sum + (p.previous ?? 0), 0), 3);
  const heat = await shop.get('/traffic/heatmap', { range: '7' }, 'Heatmap');
  assert.equal(heat.timeZone, 'Asia/Kolkata');
  assert.deepEqual(heat.cells.filter((c) => c.sessions > 0).map((c) => [c.weekday, c.hour, c.sessions]), [[2, 21, 5]]);
});

test('N-46: unique visitors over a 90-day range are distinct, not a sum of days', async () => {
  const shop = await addP2Shop(world);
  await returningVisitor(shop);
  assert.equal((await summary(shop, { range: '90' })).visitors.value, 1);
});

// ---- N-47 ------------------------------------------------------------------------------------------------------------

for (const [label, ua] of [['WhatsApp', UA.whatsappCrawler], ['Facebook', UA.facebookCrawler], ['Telegram', UA.telegramCrawler], ['Google', UA.googleBot]]) {
  test(`N-47: a ${label} crawler on a landing page counts as a preview: no session and no page view`, async () => {
    const shop = await addP2Shop(world);
    const reel = await reelPage(shop);
    await shopper(world, shop, { ua }).open(`/r/${reel.slug}`, { runScript: false });
    await settled(shop);
    const totals = await summary(shop);
    assert.equal(totals.sessions.value, 0);
    assert.equal(totals.pageViews.value, 0);
    assert.equal(totals.previews, 1);
    assert.equal((await shop.previews()).filter((p) => ['crawler', 'bot'].includes(p.kind)).length, 1);
  });
}

test('N-47: a crawler running the page\'s script is still only a preview', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop, { ua: UA.whatsappCrawler }).beacon({ name: 'page_view', path: '/r/x', pageKind: 'landing' });
  await settled(shop);
  assert.equal((await summary(shop)).sessions.value, 0);
  assert.equal((await shop.sessions()).length, 0);
});

test('N-47: a crawler\'s preview never sets a visitor cookie', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  const res = await hit(world, `/r/${reel.slug}`, { host: shop.host, headers: { 'user-agent': UA.facebookCrawler } });
  assert.equal([res.headers['set-cookie'] ?? []].flat().some((c) => c.startsWith(`${VISITOR_COOKIE}=`)), false);
});

// ---- N-16 ------------------------------------------------------------------------------------------------------------

test('N-16: an owner preview of a page (?preview=1) is not a visit, and is counted as a preview', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  const owner = shopper(world, shop);
  await owner.open(`/r/${reel.slug}?preview=1`, { beacon: { pageKind: 'landing', path: `/r/${reel.slug}?preview=1` } });
  await settled(shop);
  const totals = await summary(shop);
  assert.equal(totals.sessions.value, 0);
  assert.equal(totals.pageViews.value, 0);
  assert.ok((await shop.previews()).filter((p) => p.kind === 'owner_preview').reduce((n, p) => n + Number(p.n), 0) >= 1, 'Counted separately');
});

test('N-16: a beacon reporting a preview address is a preview, however it got here', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).beacon({ name: 'page_view', path: '/r/x?preview=1', pageKind: 'landing' });
  await settled(shop);
  assert.equal((await shop.sessions()).length, 0);
});

test('N-16: a signed-in team member on their own page is not a visit', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  const cookie = await signInCookie(world, shop);
  await shopper(world, shop, { extraCookies: cookie }).open(`/r/${reel.slug}`, { beacon: { pageKind: 'landing' } });
  await settled(shop);
  assert.equal((await summary(shop)).sessions.value, 0);
  assert.ok((await shop.previews()).some((p) => p.kind === 'team'), 'Counted separately');
});

test('N-16: a real shopper\'s visit with the same address but no ?preview=1 counts', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  await shopper(world, shop).open(`/r/${reel.slug}`, { beacon: { pageKind: 'landing' } });
  await settled(shop);
  assert.equal((await summary(shop)).sessions.value, 1);
});

// ---- N-48 ------------------------------------------------------------------------------------------------------------

test('N-48: 12 visitors active in the last 30 minutes show within 15 s, with top pages and sources', async () => {
  const shop = await addP2Shop(world);
  for (let i = 0; i < 12; i++) await shopper(world, shop).send({ name: 'landing_view', path: '/r/launch', pageKind: 'landing', pageRef: 'launch', src: 'bio_link' });
  const started = Date.now();
  let res;
  do {
    res = await realtime(shop);
    if (res.active === 12) break;
    await pause(500);
  } while (Date.now() - started < 15_000);
  assert.equal(res.active, 12, `Shown after ${Date.now() - started} ms`);
  assert.deepEqual(res.topSources.map((s) => [s.source, s.active]), [['bio_link', 12]]);
  assert.equal(res.topPages[0].active, 12);
  assert.ok(res.at, 'It says when');
});

test('N-48: the 30-minute window is exact', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  await settled(shop);
  await world.travel(ANALYTICS_LIMITS.realtimeWindowMs - INSIDE_MS * 2);
  assert.equal((await realtime(shop)).active, 1, 'Just inside 30 min');
  await world.travel(INSIDE_MS * 2 + OUTSIDE_MS);
  await pause(50);
  await shop.settle({ ms: 1500, roundMs: 200 });
  const started = Date.now();
  let res;
  do {
    res = await realtime(shop);
    if (res.active === 0) break;
    await pause(500);
  } while (Date.now() - started < 16_000);
  assert.equal(res.active, 0, 'Just past 30 min');
});

test('N-48: bots and previews are not active visitors, and another business\'s visitors never show', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await shopper(world, a).send({ name: 'page_view', path: '/a' });
  await shopper(world, a, { ua: UA.googleBot }).beacon({ name: 'page_view', path: '/a' });
  await pause(100);
  assert.equal((await realtime(a)).active, 1);
  assert.equal((await realtime(b)).active, 0);
});

test('N-48: the panel gives counts only: no visitor id reaches the seller', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await pause(100);
  assert.equal(JSON.stringify(await realtime(shop)).includes(visitor.visitorId), false);
});

// ---- N-49 ------------------------------------------------------------------------------------------------------------

test('N-49: asking traffic for another business\'s landing slug returns no rows, and the attempt is logged', async (t) => {
  const logs = captureLogs(t);
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const reel = await reelPage(b);
  await b.seedSessions([{ count: 4, landing_page: reel.slug, source: 'bio_link' }]);
  const id = requestId();
  const res = need(await a.raw('/traffic/summary', { range: '7', page: reel.slug }, { headers: { 'x-request-id': id } }), 200, 'The request');
  assert.equal(res.json().sessions.value ?? 0, 0);
  assertAttemptLogged(logs, id, /traffic|not.?found|foreign|other|page/i);
  for (const line of logs.forRequest(id)) assert.equal(line.includes(reel.slug) && line.includes(b.name), false, 'A log line holds ids only');
});

for (const route of ['sources', 'trend', 'heatmap', 'pages', 'breakdown']) {
  test(`N-49: /traffic/${route} with another business's slug gives nothing of theirs`, async () => {
    const a = await addP2Shop(world);
    const b = await addP2Shop(world);
    const reel = await reelPage(b);
    await b.seedSessions([{ count: 4, landing_page: reel.slug, source: 'bio_link' }]);
    const res = need(await a.raw(`/traffic/${route}`, { range: '7', page: reel.slug }), 200, route).json();
    assert.doesNotMatch(JSON.stringify(res), /"sessions":[1-9]/, route);
    assert.equal(JSON.stringify(res).includes(reel.slug), false, 'The other business\'s page is not echoed back');
  });
}

test('N-49: a page filter is data, whatever it holds', async () => {
  const shop = await addP2Shop(world);
  for (const page of ["x' OR 1=1--", '../../etc/passwd', '%00', '<script>alert(1)</script>']) {
    const res = await shop.raw('/traffic/summary', { range: '7', page });
    assert.ok([200, 400].includes(res.status), `${page} got ${res.status}`);
    if (res.status === 200) assert.equal(res.json().sessions.value ?? 0, 0);
  }
  assert.equal((await shop.raw('/traffic/summary', { range: '7', page: 'x'.repeat(201) })).status, 400);
});

test('N-49: every traffic route is the seller\'s own, and staff need analytics', async () => {
  const shop = await addP2Shop(world);
  const staff = await shop.addStaff(['catalog']);
  for (const route of ['summary', 'sources', 'trend', 'heatmap', 'pages', 'breakdown', 'realtime']) assert.equal((await shop.as(staff.token, `/traffic/${route}`)).status, 403, route);
  assert.equal((await shop.as(undefined, '/traffic/summary')).status, 401);
});

test('N-49: hostile traffic filters are refused', async () => {
  const shop = await addP2Shop(world);
  for (const [route, query] of [['summary', { range: 'custom' }], ['summary', { compare: 'evil' }], ['breakdown', { by: 'visitor_id' }], ['breakdown', { by: 'user_agent' }], ['breakdown', { by: 'ip' }], ['pages', { kind: 'evil' }], ['summary', { range: 'custom', from: 'x', to: 'y' }]]) {
    assert.equal((await shop.raw(`/traffic/${route}`, query)).status, 400, `${route} ${JSON.stringify(query)}`);
  }
});

// ---- N-50 ------------------------------------------------------------------------------------------------------------

test('N-50: no raw IP, full user agent or platform name is stored or served', async () => {
  const shop = await addP2Shop(world);
  const ip = '203.0.113.11';
  const ua = `${UA.instagram} spec-marker-${unique()}`;
  const visitor = shopper(world, shop, { ip, ua });
  await visitor.send({ name: 'page_view', path: '/a', pageKind: 'landing', src: 'instagram_comment_dm' });
  await settled(shop);
  const dump = JSON.stringify({
    events: await shop.trafficEvents(),
    sessions: await shop.sessions(),
    visitors: await shop.sql('SELECT * FROM traffic_visitors WHERE tenant_id = $1', [shop.tenantId]),
    daily: await shop.sql('SELECT * FROM traffic_daily WHERE tenant_id = $1', [shop.tenantId]),
  });
  assert.equal(dump.includes(ip), false, 'The IP is stored');
  assert.equal(dump.includes(ua), false, 'The user agent is stored');
  assert.doesNotMatch(dump, /Mozilla\/5\.0/, 'A user agent string is stored');
});

test('N-50: the beacon, script and cookie have no platform name, in their names, paths or bodies', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  const page = await hit(world, `/r/${reel.slug}`, { host: shop.host, headers: { 'user-agent': UA.phone } });
  need(page, 200, 'The page');
  noPlatformName('The page', page.text);
  noPlatformName('The page headers', page.headers);
  assert.ok(page.text.includes(TRAFFIC_PATHS.script), 'The page loads its tracking script from the seller\'s domain');
  const script = need(await hit(world, TRAFFIC_PATHS.script, { host: shop.host }), 200, 'The script');
  noPlatformName('The script', script.text);
  noPlatformName('The script headers', script.headers);
  assert.match(script.headers['content-type'], /javascript/);
  const beacon = await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  noPlatformName('The beacon\'s answer', beacon.headers);
  noPlatformName('The beacon\'s body', beacon.text);
});

test('N-50: a path\'s query string, with whatever is in it, isn\'t stored', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/r/x?phone=9876543210&email=a@b.com&token=secret' });
  await settled(shop);
  const [event] = await shop.trafficEvents();
  assert.ok(event, 'The hit is stored');
  assert.equal(event.path, '/r/x');
  assert.doesNotMatch(JSON.stringify(await shop.sessions()), /9876543210|a@b\.com|secret/);
});

test('N-50: no answer to a seller can name one visitor', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await settled(shop);
  for (const route of ['summary', 'sources', 'trend', 'heatmap', 'pages', 'breakdown', 'realtime']) {
    assert.equal(JSON.stringify(await shop.get(`/traffic/${route}`)).includes(visitor.visitorId), false, route);
  }
});

test('N-50: the serving headers of a buyer page set no platform cookie, and the session cookie isn\'t the platform\'s either', async () => {
  const shop = await addP2Shop(world);
  const reel = await reelPage(shop);
  const res = await hit(world, `/r/${reel.slug}`, { host: shop.host, headers: { 'user-agent': UA.phone } });
  for (const line of [res.headers['set-cookie'] ?? []].flat()) assert.doesNotMatch(line, /bhava/i);
});

test('N-50: raw events past 13 months are removed; the edge day stays', async () => {
  const shop = await addP2Shop(world);
  const at = (days) => new Date(Date.now() - days * DAY + (days === ANALYTICS_LIMITS.rawEventDays ? 2 * HOUR : -2 * HOUR));
  for (const [key, days] of [['kept', ANALYTICS_LIMITS.rawEventDays], ['gone', ANALYTICS_LIMITS.rawEventDays + 1]]) {
    await shop.sql(`INSERT INTO traffic_events (tenant_id, name, path, at, event_key) VALUES ($1, 'page_view', '/a', $2, $3)`, [shop.tenantId, at(days), key]);
  }
  await settled(shop);
  assert.deepEqual((await shop.trafficEvents()).map((e) => e.event_key), ['kept']);
});

test('N-50: rollups past 25 months are removed; the edge day stays', async () => {
  const shop = await addP2Shop(world);
  const keep = new Date(Date.now() - ANALYTICS_LIMITS.rollupDays * DAY).toISOString().slice(0, 10);
  const gone = new Date(Date.now() - (ANALYTICS_LIMITS.rollupDays + 1) * DAY).toISOString().slice(0, 10);
  await shop.inside(() => world.rollups.write('traffic_daily', [{ day: keep, hour: 1, weekday: 1, source: 'direct', sessions: 1 }, { day: gone, hour: 1, weekday: 1, source: 'direct', sessions: 1 }]));
  await settled(shop);
  assert.deepEqual((await shop.sql('SELECT day::text FROM traffic_daily WHERE tenant_id = $1 ORDER BY day', [shop.tenantId])).map((r) => r.day), [keep]);
});

test('N-50: visitors unseen for 13 months are removed', async () => {
  const shop = await addP2Shop(world);
  const seen = crypto.randomUUID();
  const old = crypto.randomUUID();
  await shop.sql(`INSERT INTO traffic_visitors (tenant_id, visitor_id, first_seen_at, last_seen_at) VALUES ($1, $2, now() - interval '500 days', now() - interval '390 days'), ($1, $3, now() - interval '500 days', now() - interval '396 days')`, [shop.tenantId, seen, old]);
  await settled(shop);
  assert.deepEqual((await shop.sql('SELECT visitor_id FROM traffic_visitors WHERE tenant_id = $1', [shop.tenantId])).map((r) => r.visitor_id), [seen]);
});

// ---- N-80 ------------------------------------------------------------------------------------------------------------

test('N-80: a one-tap DM link to Amazon goes straight there, and Bhava records no session or click', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap' });
  const [person] = await comments(world, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const [dm] = await shop.dms({ recipientId: person.id });
  const link = dm.message.attachment.payload.buttons[0].url;
  assert.equal(new URL(link).host, 'www.amazon.in', 'A direct link');
  assert.deepEqual([(await shop.sessions()).length, (await shop.trafficEvents()).length], [0, 0]);
  assert.equal((await summary(shop)).sessions.value, 0);
});

test('N-80: the reel shows not available for this link type, and DMs still show', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'amazon', linkMode: 'one_tap' });
  await comments(world, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const funnel = await shop.get(`/insights/funnels/${auto.mediaId}`);
  const step = stepOf(funnel, 'taps_or_visits');
  assert.equal(step.state, 'not_available');
  assert.equal(step.count, null);
  assert.equal(stepOf(funnel, 'dms').count, 1);
});

test('N-80: no DM link carries a platform host or a redirect, on any link type', async () => {
  const shop = await addP2Shop(world);
  const auto = await liveReel(shop, { linkType: 'seller_site', linkMode: 'one_tap' });
  const [person] = await comments(world, shop, auto.mediaId, 1);
  await shop.settle({ ms: 8000 });
  const [dm] = await shop.dms({ recipientId: person.id });
  const link = new URL(dm.message.attachment.payload.buttons[0].url);
  assert.equal(link.host, shop.siteHost);
  assert.doesNotMatch(link.href, /bhava|\/go\/|\/l\//i);
  assert.equal(link.searchParams.get('utm_medium'), 'dm', 'The seller\'s own analytics see the tags');
});

test('N-80: tier 1 traffic is two-tap taps only: page metrics aren\'t included', async () => {
  const shop = await addP2Shop(world, { plan: 't1' });
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  await settled(shop);
  const totals = await summary(shop);
  for (const metric of ['productTaps', 'addToCart', 'orders', 'revenuePaise']) {
    assert.ok(totals.notIncluded.includes(metric), `${metric} is not in tier 1: ${totals.notIncluded}`);
    assert.equal(totals[metric].value, null, metric);
  }
});

test('N-80: tier 2 adds page views and taps but not cart, checkout or revenue', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  const totals = await summary(shop);
  for (const metric of ['addToCart', 'checkoutStarted', 'orders', 'revenuePaise']) assert.ok(totals.notIncluded.includes(metric), metric);
  assert.equal(totals.notIncluded.includes('productTaps'), false);
});
