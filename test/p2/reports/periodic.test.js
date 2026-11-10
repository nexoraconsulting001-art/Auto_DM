// The weekly summary and the monthly performance report (PRD 7.9, N-40 to N-44): on the business's clock, from the cache only, once per period,
// to the team and never to shoppers, Bhava-branded, with revenue only where the plan and the person allow, and one-click unsubscribe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hit, istAt, openWorld, unique } from './support.js';

const MONDAY = '2026-11-09';
const FIRST = '2026-11-01'; // a Sunday, so no weekly report is due with it
const emails = (shop, where = 'true', params = []) => shop.deliveries(`channel = 'email' AND (${where})`, params);
const tokenIn = (body) => /[?&]token=([\w-]+)/.exec(body)?.[1];

async function seedWeek(shop, { sale = false } = {}) {
  const ref = await shop.accountRef();
  const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  await shop.write('meta_account_daily', [
    ...days('2026-10-26', 7).map((day) => ({ day, account_id: ref.account_id, views: 100, reach: 50, followers_count: 1000 })),
    ...days('2026-11-02', 7).map((day) => ({ day, account_id: ref.account_id, views: 150, reach: 40, followers_count: 1010 })),
  ]);
  const prefix = `top${unique()}`;
  for (let i = 1; i <= 4; i++) await shop.seedMedia(ref, { mediaId: `${prefix}-rank-${i}`, caption: `Caption-number-${i}`, latest: { views: i * 1000 }, postedAt: new Date('2026-11-05T06:00:00Z') });
  await shop.seedMedia(ref, { caption: '<img src=x onerror=alert(1)>', latest: { views: 999999 }, postedAt: new Date('2026-11-04T06:00:00Z') });
  await shop.write('funnel_daily', [{ day: '2026-11-04', channel: 'instagram', media_id: `${prefix}-rank-4`, content_kind: 'reel', link_type: 'bhava_page', link_mode: 'two_tap', origin: 'automation', source_label: 'bhava', comments: 12, dms_sent: 10, taps: 4, ...(sale ? { orders: 1, revenue_paise: 250000 } : {}) }]);
  return { ref, prefix };
}

test('N-40: the weekly report goes at 09:00 Monday on the business\'s clock, once, with week-on-week figures, the top 3 posts and no Meta call', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 8, 59) });
  const tier1 = await w.addShop({ plan: 't1' });
  const tier3 = await w.addShop({ plan: 't3', name: `Mehta & Sons ${unique()}` });
  const { prefix } = await seedWeek(tier1);
  await seedWeek(tier3, { sale: true });
  await w.runJobs();
  assert.equal((await tier1.runs('weekly')).length, 0, 'Not at 08:59');

  w.clock.t = istAt(MONDAY, 9, 5);
  await w.runJobs();
  await w.runJobs();
  const [run] = await tier1.runs('weekly');
  assert.ok(run, 'It ran');
  assert.deepEqual([run.status, run.start], ['sent', '2026-11-02']);
  assert.equal((await tier1.runs('weekly')).length, 1, 'Once, however many ticks');
  const [mail, ...more] = await emails(tier1);
  assert.equal(more.length, 0, 'One email for the one owner');
  assert.match(mail.subject, /^Bhava weekly report for /);
  assert.ok(mail.subject.includes(tier1.name) && mail.body.includes(tier1.name), 'It names the business');
  assert.doesNotMatch(`${mail.subject} ${mail.body}`, /revenue|₹|\border(s)?\b/i, 'Tier 1: no orders or revenue');
  assert.match(mail.body, /Taps or visits/);
  assert.match(mail.body, /1,050<\/strong>.*?up 50%/s, 'Views this week, and the change from last week');
  assert.match(mail.body, /Followers/);
  assert.ok(mail.body.includes('Caption-number-4') && mail.body.includes('Caption-number-3'), 'The top posts are listed');
  assert.equal(`${mail.body} ${JSON.stringify(run.summary)}`.match(new RegExp(`Caption-number-[12]\\b|${prefix}-rank-[12]\\b`)), null, 'Only the top 3: the most viewed, two of the ranked ones');
  assert.equal(mail.body.includes('<img src=x onerror='), false, 'A caption is escaped');
  assert.ok(mail.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal((await tier1.deliveries(`channel = 'push'`)).length, 1, 'And the owner app push');

  const [rich] = await emails(tier3);
  assert.match(rich.body, /Revenue/);
  assert.match(rich.body, /₹2,500\.00/);
  assert.ok(rich.body.includes('Mehta &amp; Sons'), 'The business name is escaped too');
});

test('N-42: the report goes to the team that reads analytics, never to shoppers, and revenue only to those who may see it', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 9, 5) });
  const shop = await w.addShop();
  await seedWeek(shop, { sale: true });
  const manager = await shop.addUser('manager', [], { email: 'mira@team.example' });
  const analyst = await shop.addUser('staff', ['analytics']);
  const packer = await shop.addUser('staff', ['orders']);
  const shopper = await shop.addUser('customer');
  await w.runJobs();
  const mail = await emails(shop);
  const to = new Map(mail.map((m) => [m.user_id, m]));
  assert.ok(to.has(manager.user.id) && to.has(analyst.user.id));
  assert.equal(to.get(manager.user.id).to_address, 'mira@team.example');
  assert.equal(to.has(packer.user.id), false, 'Staff without analytics');
  assert.equal(to.has(shopper.user.id), false, 'Never a shopper');
  assert.match(to.get(manager.user.id).body, /₹2,500/);
  assert.doesNotMatch(to.get(analyst.user.id).body, /revenue|₹|\border(s)?\b/i, 'Analytics without orders: no revenue');
  const pushes = await shop.deliveries(`channel = 'push'`);
  assert.equal(pushes.length, 1, 'Push is for the owner app');
  for (const m of mail) assert.equal(new Set(mail.map((x) => x.user_id)).size, mail.length, `one email per person: ${m.id}`);
});

test('N-40: one click unsubscribes, a made-up token changes nothing, and the next week goes to everyone else only', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 9, 5) });
  const shop = await w.addShop();
  const manager = await shop.addUser('manager');
  await w.runJobs();
  const mine = (await emails(shop)).find((m) => m.user_id !== manager.user.id);
  const token = tokenIn(mine.body);
  assert.ok(token, 'The email carries an unsubscribe link');
  assert.ok(mine.body.includes(`/reporting/unsubscribe?token=${token}&amp;report=weekly`));
  assert.deepEqual(await shop.json('/reports/unsubscribe', { method: 'POST', body: { token: 'nope', report: 'all' } }, 200, null), { ok: false });
  assert.equal((await shop.json('/reports/preferences')).weekly, true);
  assert.deepEqual(await shop.json('/reports/unsubscribe', { method: 'POST', body: { token, report: 'weekly' } }, 200, null), { ok: true });
  assert.deepEqual(await shop.json('/reports/preferences'), { weekly: false, monthly: true, monthlyAvailable: true });
  const stored = await shop.sql('SELECT * FROM report_preferences WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(JSON.stringify(stored).includes(token), false, 'Only a hash of the token is kept');

  w.clock.t = istAt('2026-11-16', 9, 5);
  await w.runJobs();
  const [, second] = await shop.runs('weekly');
  assert.equal(second.status, 'sent');
  const next = await emails(shop, 'report_run_id = $2', [second.id]);
  assert.deepEqual(next.map((m) => m.user_id), [manager.user.id]);
});

test('the unsubscribe link opens a page with one button, and the button unsubscribes', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 9, 5) });
  const shop = await w.addShop();
  await w.runJobs();
  const [mail] = await emails(shop);
  const token = tokenIn(mail.body);
  const opened = await hit(w.app, `/reporting/unsubscribe?token=${token}&report=weekly`, { host: shop.host });
  assert.equal(opened.status, 200);
  assert.match(opened.text, /Stop the weekly report\?/);
  assert.match(opened.text, /<button type="submit"/);
  assert.equal(opened.text.includes('/_t/s.js'), false, 'Not a buyer page: no tracking script');
  assert.equal((await shop.json('/reports/preferences')).weekly, true, 'Opening the link alone changes nothing');
  const clicked = await hit(w.app, '/reporting/unsubscribe', { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, report: 'weekly' }).toString() });
  assert.equal(clicked.status, 200);
  assert.match(clicked.text, /won’t get the weekly report/);
  assert.equal((await shop.json('/reports/preferences')).weekly, false);
  const oneClick = await hit(w.app, `/reporting/unsubscribe?token=${token}&report=all`, { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(oneClick.status, 200, 'A mail app\'s own one-click unsubscribe');
  assert.deepEqual(await shop.json('/reports/preferences'), { weekly: false, monthly: false, monthlyAvailable: true });
});

test('N-41: an expired token, no Instagram at all, or a paused business', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 9, 5) });
  const expired = await w.addShop();
  const { ref } = await seedWeek(expired);
  await expired.sql(`UPDATE ig_accounts SET status = 'reconnect_needed', token_expires_at = now() - interval '1 day' WHERE tenant_id = $1 AND ig_user_id = $2`, [expired.tenantId, ref.account_id]);
  const none = await w.addShop({ plan: 't1' });
  const paused = await w.addShop();
  await paused.sql(`UPDATE tenants SET status = 'paused' WHERE id = $1`, [paused.tenantId]);
  await w.runJobs();
  assert.equal((await expired.runs('weekly'))[0]?.status, 'sent');
  assert.match((await emails(expired))[0].body, /Reconnect Instagram/);
  assert.equal((await none.runs('weekly'))[0]?.status, 'sent');
  const [bare] = await emails(none);
  assert.match(bare.body, /Connect Instagram/);
  assert.doesNotMatch(bare.body, /undefined|NaN|\[object/);
  assert.deepEqual(await paused.runs('weekly'), [], 'A paused business gets no report');
});

test('a person who turned the weekly report off gets none; with nobody left the run is recorded as skipped', async (t) => {
  const w = await openWorld(t, { at: istAt(MONDAY, 9, 5) });
  const shop = await w.addShop();
  await shop.json('/reports/preferences', { method: 'PATCH', body: { weekly: false } });
  await w.runJobs();
  assert.deepEqual(await shop.deliveries(), []);
  assert.equal((await shop.runs('weekly'))[0].status, 'skipped');
});

async function seedMonth(shop, { sale = false } = {}) {
  const ref = await shop.accountRef();
  await shop.seedMedia(ref, { mediaId: 'R1', caption: 'October lamp reel', postedAt: new Date('2026-10-02T06:00:00Z') });
  await shop.write('traffic_daily', [{ day: '2026-10-15', hour: 10, weekday: 4, source: 'bio_link', media_id: 'R1', landing_page: '/r/lamp', sessions: 9, landing_views: 7, product_taps: 3, ...(sale ? { orders: 1, revenue_paise: 99900 } : {}) }]);
  await shop.write('funnel_daily', [{ day: '2026-10-15', channel: 'instagram', media_id: 'R1', content_kind: 'reel', link_type: 'bhava_page', link_mode: 'two_tap', origin: 'automation', source_label: 'bhava', dms_sent: 12, ...(sale ? { orders: 1, revenue_paise: 99900 } : {}) }]);
}

test('N-43: a tier 2 business on the 1st gets last month with DMs, visits and taps per reel and traffic by source, no revenue, and a PDF in the admin', async (t) => {
  const w = await openWorld(t, { at: istAt(FIRST, 8, 59) });
  const shop = await w.addShop({ plan: 't2' });
  await seedMonth(shop);
  await w.runJobs();
  assert.deepEqual(await shop.runs('monthly'), [], 'Not at 08:59');
  w.clock.t = istAt(FIRST, 9, 5);
  await w.runJobs();
  await w.runJobs();
  const runs = await shop.runs('monthly');
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual([run.status, run.start], ['sent', '2026-10-01']);
  assert.ok(run.storage_key);
  const [mail] = await emails(shop, 'report_run_id = $2', [run.id]);
  assert.match(mail.subject, /^Bhava monthly report for .*: October 2026$/);
  for (const words of [/DMs sent/, /Landing page visits/, /Product taps/, /Traffic by source/, /Bio link/, /October lamp reel/, /\/r\/lamp/]) assert.match(mail.body, words);
  assert.doesNotMatch(mail.body, /revenue|₹/i);
  const listed = await shop.json('/reports?kind=monthly');
  assert.equal(listed.items[0].id, Number(run.id));
  const detail = await shop.json(`/reports/${run.id}`);
  assert.match(detail.fileUrl, /^\/report-files\/m\d+$/);
  assert.ok(mail.body.includes(detail.fileUrl), 'The email links to the PDF in the admin');
  const pdf = await shop.file(detail.fileUrl);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.raw.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.equal((await shop.runs('weekly')).length, 0, 'A Sunday 1st is no weekly report');
});

test('N-44: tier 1 has no monthly report unless it bought the service, and the PDF is only its own business\'s', async (t) => {
  const w = await openWorld(t, { at: istAt(FIRST, 9, 5) });
  const tier1 = await w.addShop({ plan: 't1' });
  const bought = await w.addShop({ plan: 't1' });
  await bought.repos.entitlements.setOverride('report.monthly', { enabled: true });
  const tier3 = await w.addShop({ plan: 't3' });
  await seedMonth(tier3, { sale: true });
  const off = await w.addShop({ plan: 't2' });
  await off.json('/reports/preferences', { method: 'PATCH', body: { monthly: false } });
  await w.runJobs();
  assert.deepEqual(await tier1.runs('monthly'), []);
  assert.equal((await tier1.json('/reports/preferences')).monthlyAvailable, false);
  assert.equal((await bought.runs('monthly')).length, 1);
  assert.equal((await bought.json('/reports/preferences')).monthlyAvailable, true);
  assert.deepEqual(await off.deliveries(), [], 'Turned off: nothing sent');

  const [run] = await tier3.runs('monthly');
  const [mail] = await emails(tier3, 'report_run_id = $2', [run.id]);
  assert.match(mail.body, /₹999\.00/);
  const { fileUrl } = await tier3.json(`/reports/${run.id}`);
  assert.equal((await tier3.file(fileUrl)).status, 200);
  const analyst = await tier3.addUser('staff', ['analytics']);
  assert.equal((await tier3.file(fileUrl, analyst.token)).status, 403, 'The PDF holds revenue: not for staff without orders');
  assert.equal((await tier1.file(fileUrl)).status, 404, 'Another business');
  assert.equal((await tier1.call(`/reports/${run.id}`)).status, 404);
  assert.equal((await tier1.json('/reports')).items.some((r) => r.id === Number(run.id)), false);
});
