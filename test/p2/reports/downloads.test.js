// Summary downloads over HTTP (PRD 7.9, 7.13): one business's, the requester's own, what their role allows, large ones through the queue, and gone after 7 days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { ANALYTICS_LIMITS } from '../../../src/contracts/analytics.js';
import { QUEUE_DOWNLOAD, createDownloads } from '../../../src/modules/reports/downloads.js';
import { jobHandlers } from '../../../src/modules/reports/jobs.js';
import { reportServices } from '../../../src/modules/reports/services.js';
import { DAY, HOUR, openWorld, parseCsv } from './support.js';

const media = (shop, body = {}) => shop.json('/downloads', { method: 'POST', body: { source: 'media', format: 'csv', ...body } }, 201);
const cellsOf = (file) => parseCsv(file.text.replace(/^﻿/, '')).flat();

test('N-39: a media CSV is made at once, UTF-8 with a BOM, in the business\'s time zone, with a formula caption made inert', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const ref = await shop.accountRef();
  const caption = '=HYPERLINK("https://evil.example","Click")';
  await shop.seedMedia(ref, { caption, latest: { views: 10, reach: 8 } });
  // 20:00 UTC is 01:30 the next day in India.
  const posted = new Date(Date.UTC(2026, 9, 20, 20, 0));
  await shop.seedMedia(ref, { caption: 'नमस्ते, "quoted"', postedAt: posted, latest: { views: 3 } });
  const made = await media(shop);
  assert.deepEqual([made.status, made.background, made.rowCount], ['ready', false, 2]);
  assert.match(made.fileUrl, /^\/report-files\/d\d+$/);
  assert.ok(Math.abs(new Date(made.expiresAt) - new Date(made.createdAt) - ANALYTICS_LIMITS.downloadExpiryDays * DAY) < HOUR);
  const file = await shop.file(made.fileUrl);
  assert.equal(file.status, 200);
  assert.match(file.headers['content-type'], /text\/csv/);
  assert.match(file.headers['content-disposition'], /^attachment; filename="[\w.-]+\.csv"$/);
  assert.match(file.headers['cache-control'], /no-store/);
  assert.deepEqual([...file.raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const cells = cellsOf(file);
  assert.ok(cells.includes(`'${caption}`));
  assert.equal(cells.includes(caption), false);
  assert.ok(cells.includes('नमस्ते, "quoted"'));
  assert.ok(cells.includes('2026-10-21 01:30'), 'Posted in India\'s time');
  assert.ok(cells.includes('From Instagram/Facebook'), 'Each figure says where it came from');
});

test('N-39: the Excel version holds the same text as text, never a formula', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const ref = await shop.accountRef();
  await shop.seedMedia(ref, { caption: '@SUM(1+1)', latest: { views: 1 } });
  const made = await media(shop, { format: 'xlsx' });
  const file = await shop.file(made.fileUrl);
  assert.equal(file.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.raw);
  const values = [];
  workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
    values.push(cell.value);
  }));
  assert.ok(values.includes("'@SUM(1+1)"));
});

test('a file is its requester\'s and its business\'s alone', async (t) => {
  const w = await openWorld(t);
  const a = await w.addShop();
  const b = await w.addShop();
  await a.seedMedia(await a.accountRef(), { caption: 'Ours' });
  const made = await media(a);
  assert.equal((await a.file(made.fileUrl, null)).status, 401, 'Not signed in');
  assert.equal((await b.file(made.fileUrl)).status, 404, 'Another business, on its own address');
  assert.equal((await a.file(made.fileUrl, b.token)).status, 404, 'Another business\'s session on this address');
  assert.equal((await b.call(`/downloads/${made.id}`)).status, 404);
  assert.deepEqual((await b.json('/downloads')).items, []);
  const noAnalytics = await a.addUser('staff', ['orders']);
  assert.equal((await a.call(`/downloads/${made.id}`, {}, noAnalytics.token)).status, 403);
  assert.equal((await a.file(made.fileUrl, noAnalytics.token)).status, 403);
  const manager = await a.addUser('manager');
  assert.equal((await a.call(`/downloads/${made.id}`, {}, manager.token)).status, 404, 'A teammate\'s file is theirs, not shared');
  assert.equal((await a.file(made.fileUrl, manager.token)).status, 404);
  assert.deepEqual((await a.json('/downloads', {}, 200, manager.token)).items, []);
  assert.equal((await a.json('/downloads')).items[0].id, made.id);
  assert.equal((await a.file('/report-files/x1')).status, 404);
  assert.equal((await a.file('/report-files/d99999999999999999999')).status, 404);
});

test('N-81: hostile download requests are refused before anything is stored', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const bodies = [{}, { source: 'raw_events' }, { source: 'traffic_events' }, { source: 'media', format: 'exe' }, { source: 'explore' }, { source: 'funnel' }, { source: 'cohort' },
    { source: 'explore', query: { metrics: ['sessions'], dimensions: ['visitor_id'] } }, { source: 'media', from: "x' OR 1=1", to: '2026-01-01' }, { source: 'media', from: '2026-02-01', to: '2026-01-01' }];
  for (const body of bodies) assert.equal((await shop.call('/downloads', { method: 'POST', body })).status, 400, JSON.stringify(body));
  const other = await w.addShop();
  const [funnel] = await other.sql(`INSERT INTO custom_funnels (tenant_id, name, steps) VALUES ($1, 'Theirs', '[{"kind":"landing_view"},{"kind":"product_view"}]') RETURNING id`, [other.tenantId]);
  assert.equal((await shop.call('/downloads', { method: 'POST', body: { source: 'funnel', funnelId: funnel.id } })).status, 404, 'Another business\'s funnel');
  assert.deepEqual(await shop.sql('SELECT id FROM report_downloads WHERE tenant_id = $1', [shop.tenantId]), []);
});

test('N-53: a download hides what the person\'s role can\'t see, revenue included, from the header too', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  await shop.write('traffic_daily', [{ day, hour: 10, weekday: 1, source: 'bio_link', sessions: 30, orders: 2, revenue_paise: 123456 }]);
  const staff = await shop.addUser('staff', ['analytics']);
  const body = { source: 'explore', format: 'csv', query: { metrics: ['sessions', 'revenue_paise'], dimensions: ['source'], range: '7' } };
  const theirs = await shop.json('/downloads', { method: 'POST', body }, 201, staff.token);
  const file = await shop.file(theirs.fileUrl, staff.token);
  assert.equal(file.status, 200);
  assert.doesNotMatch(file.text, /revenue|123456/i);
  assert.ok(cellsOf(file).includes('30'));
  const mine = await shop.json('/downloads', { method: 'POST', body }, 201);
  assert.match((await shop.file(mine.fileUrl)).text, /123456/, 'The owner sees it');
});

test('the fixed sheets are figures only: no usernames, visitor ids or shopper details', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const ref = await shop.accountRef();
  const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  await shop.seedMedia(ref, { mediaId: 'story1', kind: 'story', storyFinalState: 'final', latest: { views: 40, replies: 2 } });
  await shop.seedMedia(ref, { mediaId: 'reel1', caption: 'Lamps' });
  await shop.write('meta_account_daily', [{ day, account_id: ref.account_id, views: 500, reach: 300, followers_count: 1200 }]);
  await shop.write('funnel_daily', [{ day, channel: 'instagram', media_id: 'reel1', content_kind: 'reel', link_type: 'bhava_page', link_mode: 'two_tap', origin: 'automation', source_label: 'bhava', comments: 5, dms_sent: 4, taps: 2, orders: 1, revenue_paise: 5000 }]);
  await shop.sql(`INSERT INTO account_health_history (tenant_id, account_ref, day, score, band, deductions) VALUES ($1, $2, $3, 70, 'watch', '[{"code":"token_14d","points":-10,"message":"Your token expires soon"}]')`, [shop.tenantId, ref.id, day]);
  await shop.sql(`INSERT INTO users (tenant_id, name, phone, password_hash, role, email) VALUES ($1, 'Priya Shopperton', '9811122233', 'x', 'customer', 'priya@shopper.example')`, [shop.tenantId]);
  const expected = { account_daily: '1200', media: 'Lamps', story_finals: '40', content_funnel: '5000', health_history: 'Your token expires soon (-10)' };
  for (const [source, wanted] of Object.entries(expected)) {
    const made = await media(shop, { source });
    const file = await shop.file(made.fileUrl);
    assert.equal(file.status, 200, source);
    assert.ok(file.text.includes(wanted), `${source} holds ${wanted}`);
    for (const banned of ['Priya', '9811122233', 'priya@shopper.example', 'visitor_id', 'subject_hash', 'user_agent']) assert.equal(file.text.includes(banned), false, `${source}: ${banned}`);
  }
  const staff = await shop.addUser('staff', ['analytics']);
  const limited = await shop.json('/downloads', { method: 'POST', body: { source: 'content_funnel', format: 'csv' } }, 201, staff.token);
  assert.doesNotMatch((await shop.file(limited.fileUrl, staff.token)).text, /Revenue|5000/, 'Staff without orders see no sales in the funnel sheet');
});

test('N-61: a large export goes through the queue, a Bhava email links to it, and after 7 days it is gone', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  await shop.write('traffic_daily', Array.from({ length: 5 }, (_, i) => ({ day, hour: 1, weekday: 1, landing_page: `/r/p${i}`, sessions: i + 1 })));
  // The same service the app uses, with a smaller threshold than 50,000 so the test stays quick.
  const downloads = createDownloads(w.jobCtx, { sources: reportServices(w.jobCtx).sources, backgroundOverRows: 3 });
  const [owner] = await shop.sql(`SELECT * FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
  await shop.sql('UPDATE users SET email = $2 WHERE id = $1', [owner.id, 'owner@shop.example']);
  const made = await shop.inside(() => downloads.create({ source: 'explore', format: 'xlsx', query: { metrics: ['sessions'], dimensions: ['landing_page'], range: '7' } }, owner));
  assert.deepEqual([made.status, made.background, made.fileUrl], ['queued', true, null]);
  assert.equal((await shop.json(`/downloads/${made.id}`)).status, 'queued');
  const [job] = await shop.sql(`SELECT * FROM jobs WHERE queue = $1 AND tenant_id = $2`, [QUEUE_DOWNLOAD, shop.tenantId]);
  assert.ok(job, 'Queued as a job of this business');
  await w.drivers.queue.drain(QUEUE_DOWNLOAD, jobHandlers(w.jobCtx)[QUEUE_DOWNLOAD]);
  const done = await shop.json(`/downloads/${made.id}`);
  assert.deepEqual([done.status, done.rowCount], ['ready', 5]);
  const [mail] = await shop.deliveries('download_id = $2', [made.id]);
  assert.ok(mail, 'An email waits in the outbox');
  assert.equal(mail.user_id, owner.id);
  assert.equal(mail.to_address, 'owner@shop.example');
  assert.match(`${mail.subject} ${mail.body}`, /Bhava/);
  assert.ok(mail.body.includes(`/report-files/d${made.id}`), 'It links to the file');
  const file = await shop.file(done.fileUrl);
  assert.equal(file.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.raw);
  assert.equal(workbook.worksheets[0].rowCount, 6);

  await shop.sql(`UPDATE report_downloads SET expires_at = now() - interval '1 second' WHERE id = $1`, [made.id]);
  assert.equal((await shop.file(done.fileUrl)).status, 410, 'Past 7 days');
  assert.equal((await shop.json(`/downloads/${made.id}`)).status, 'expired');
  await w.runJobs({ tick: false });
  await jobHandlers(w.jobCtx)['reports.sweep']();
  const [row] = await shop.sql('SELECT status FROM report_downloads WHERE id = $1', [made.id]);
  assert.equal(row.status, 'expired');
  assert.equal((await shop.file(done.fileUrl)).status, 410);
});

test('N-61: a requester who loses analytics before the worker gets to the file gets nothing', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const staff = await shop.addUser('staff', ['analytics']);
  const day = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  await shop.write('traffic_daily', Array.from({ length: 3 }, (_, i) => ({ day, hour: 1, weekday: 1, landing_page: `/p${i}`, sessions: 1 })));
  const downloads = createDownloads(w.jobCtx, { sources: reportServices(w.jobCtx).sources, backgroundOverRows: 1 });
  const made = await shop.inside(async () => downloads.create({ source: 'explore', format: 'csv', query: { metrics: ['sessions'], dimensions: ['landing_page'], range: '7' } }, await shop.repos.users.get(staff.user.id)));
  await shop.repos.users.setPermissions(staff.user.id, ['orders']);
  await w.drivers.queue.drain(QUEUE_DOWNLOAD, jobHandlers(w.jobCtx)[QUEUE_DOWNLOAD]);
  const [row] = await shop.sql('SELECT status, storage_key FROM report_downloads WHERE id = $1', [made.id]);
  assert.deepEqual([row.status, row.storage_key], ['failed', '']);
  assert.deepEqual(await shop.deliveries(), []);
});
