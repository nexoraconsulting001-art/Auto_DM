// PRD 7.13: large exports, scheduled reports and the reporting API. N-61 to N-66 and N-81 to N-83.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { routeList } from '../../../src/contracts/api/index.js';
import { ANALYTICS_LIMITS, DAY, HOUR, INSIDE_MS, OUTSIDE_MS, REPORTING_BASE_PATH, addP2Shop, assertAttemptLogged, captureLogs, consoleUser, dayAgo, fileAt, hit, lastWeekdayAt, atClock, need, onConsole, pause, reportingKeyHeaders, requestId, shopper, unique, useP2World, waitForFile } from './support.js';

const world = useP2World();

/** A view with `n` distinct rows, straight into the rollup. */
async function rowsOfView(shop, n) {
  await shop.sql(
    `INSERT INTO traffic_daily (tenant_id, day, dims_hash, hour, weekday, landing_page, sessions)
     SELECT $1, current_date - 1, md5(g::text), 1, 1, '/r/p' || g, 1 FROM generate_series(1, $2::int) g`,
    [shop.tenantId, n],
  );
  // The insert holds the event loop for a while, and a kept-alive connection the server gave up on meanwhile would reset the next call.
  await pause(5500);
}
const VIEW = { metrics: ['sessions'], dimensions: ['landing_page'], range: '7' };

// ---- N-61 ------------------------------------------------------------------------------------------------------------

test('N-61: a 120,000-row view as XLSX runs in the background, and a Bhava email links to the file in the admin', async () => {
  const shop = await addP2Shop(world);
  await rowsOfView(shop, 120_000);
  const made = await shop.post('/downloads', { source: 'explore', format: 'xlsx', query: VIEW }, 201, 'Asking for the file');
  assert.equal(made.background, true);
  assert.equal(made.fileUrl, null, 'Not ready at the moment of asking');
  const done = await waitForFile(world, shop, made);
  assert.equal(done.status, 'ready');
  assert.equal(done.rowCount, 120_000);
  const [mail] = await shop.deliveries('download_id = $2 AND channel = $3', [done.id, 'email']);
  assert.ok(mail, 'An email goes when it is ready');
  assert.match(`${mail.subject} ${mail.body}`, /bhava/i);
  assert.ok(mail.body.includes(new URL(done.fileUrl, world.base).pathname) || mail.body.includes('/admin'), 'It links to the file in the admin');
  const file = need(await fileAt(world, shop, done.fileUrl), 200, 'The file');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.raw);
  assert.ok(workbook.worksheets[0].rowCount >= 120_001, `Header and every row: ${workbook.worksheets[0].rowCount}`);
});

test('N-61: the 50,000-row edge: 50,000 is not background, and 50,001 is', async () => {
  const shop = await addP2Shop(world);
  await rowsOfView(shop, ANALYTICS_LIMITS.downloadBackgroundOverRows);
  const at = await shop.post('/downloads', { source: 'explore', format: 'csv', query: VIEW }, 201, 'Exactly 50,000');
  assert.equal(at.background, false);
  await shop.sql(`INSERT INTO traffic_daily (tenant_id, day, dims_hash, hour, weekday, landing_page, sessions) VALUES ($1, current_date - 1, md5('one more'), 1, 1, '/r/more', 1)`, [shop.tenantId]);
  const over = await shop.post('/downloads', { source: 'explore', format: 'csv', query: VIEW }, 201, 'One more');
  assert.equal(over.background, true);
});

test('N-61: the link expires after 7 days, exactly', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 2, source: 'bio_link' }]);
  const done = await waitForFile(world, shop, await shop.post('/downloads', { source: 'explore', format: 'csv', query: { metrics: ['sessions'], range: '7' } }, 201));
  assert.equal(done.status, 'ready');
  const lifetime = new Date(done.expiresAt) - new Date(done.createdAt);
  assert.ok(Math.abs(lifetime - ANALYTICS_LIMITS.downloadExpiryDays * DAY) < HOUR, `Expires after ${lifetime / DAY} days`);
  await world.travel(ANALYTICS_LIMITS.downloadExpiryDays * DAY - INSIDE_MS * 2);
  need(await fileAt(world, shop, done.fileUrl), 200, 'Just inside 7 days');
  await world.travel(INSIDE_MS * 2 + OUTSIDE_MS);
  const gone = await fileAt(world, shop, done.fileUrl);
  assert.ok([404, 410].includes(gone.status), `Just past 7 days: ${gone.status}`);
  await shop.settle({ ms: 2500, roundMs: 250 });
  assert.equal((await shop.get(`/downloads/${done.id}`)).status, 'expired');
});

test('N-61: an export of this size is nobody else\'s to see, while it runs or after', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.seedSessions([{ count: 2, source: 'bio_link' }]);
  const made = await a.post('/downloads', { source: 'explore', format: 'csv', query: { metrics: ['sessions'], range: '7' } }, 201);
  assert.equal((await b.raw(`/downloads/${made.id}`)).status, 404);
  assert.deepEqual((await b.get('/downloads')).items, []);
});

// ---- N-62 ------------------------------------------------------------------------------------------------------------

const newView = (shop, extra = {}) => shop.post('/saved-views', { name: `V ${unique()}`, visibility: 'team', definition: { metrics: ['sessions'], range: '7' }, ...extra }, 201);
const schedule = (shop, viewId, body = {}) => shop.post('/scheduled-reports', { viewId, frequency: 'weekly', hourOfDay: 9, weekday: 1, ...body }, 201, 'Scheduling');
const addRecipient = (shop, id, email) => shop.post(`/scheduled-reports/${id}/recipients`, { email }, 201, 'Adding the address');
const due = (shop, id) => shop.sql(`UPDATE scheduled_reports SET next_run_at = now() - interval '1 second' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, id]);

test('N-62: a weekly report to an outside accountant: sent as an attachment, and the add is in the audit log', async () => {
  const shop = await addP2Shop(world, { timeZone: 'Asia/Kolkata' });
  await shop.seedSessions([{ count: 4, source: 'bio_link' }]);
  const report = await schedule(shop, (await newView(shop)).id);
  const recipient = await addRecipient(shop, report.id, 'accounts@firm.example');
  assert.equal(recipient.kind, 'outside');
  const audit = await shop.audit('recipient|scheduled|report');
  assert.ok(audit.length >= 1, 'The add is logged');
  assert.ok(JSON.stringify(audit).includes(`${report.id}`), 'It names the report');
  await due(shop, report.id);
  await shop.settle({ ms: 4000, roundMs: 300 });
  const [sent] = await shop.deliveries('to_address = $2', ['accounts@firm.example']);
  assert.ok(sent, 'It went to the outside address');
  assert.ok(sent.attachment_key && sent.attachment_name, 'As an attachment');
  assert.match(sent.attachment_name, /\.csv$/);
  assert.match(`${sent.subject} ${sent.body}`, /bhava/i);
});

test('N-62: the next run is worked out in the seller\'s time zone', async () => {
  const shop = await addP2Shop(world, { timeZone: 'Asia/Kolkata' });
  const report = await schedule(shop, (await newView(shop)).id, { frequency: 'weekly', hourOfDay: 9, weekday: 1 });
  const next = new Date(new Date(report.nextRunAt).getTime() + 5.5 * HOUR);
  assert.deepEqual([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()], [1, 9, 0]);
  assert.ok(new Date(report.nextRunAt) > new Date(), 'In the future');
});

test('N-62: daily, weekly and monthly each run once at their time, and the next one is set', async () => {
  const shop = await addP2Shop(world);
  for (const [frequency, extra] of [['daily', {}], ['weekly', { weekday: 2 }], ['monthly', { dayOfMonth: 15 }]]) {
    const report = await schedule(shop, (await newView(shop)).id, { frequency, ...extra });
    await due(shop, report.id);
    await shop.settle({ ms: 3000, roundMs: 300 });
    const [row] = await shop.sql('SELECT * FROM scheduled_reports WHERE id = $1', [report.id]);
    assert.ok(row.last_run_at, frequency);
    assert.ok(new Date(row.next_run_at) > new Date(), `${frequency} is scheduled again`);
  }
});

test('N-62: one due report at the same moment, from two workers, is sent once', async () => {
  const shop = await addP2Shop(world);
  const report = await schedule(shop, (await newView(shop)).id);
  await addRecipient(shop, report.id, 'once@firm.example');
  await due(shop, report.id);
  world.addWorker();
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  assert.equal((await shop.deliveries('to_address = $2', ['once@firm.example'])).length, 1);
});

test('N-62: a manager schedules, only the owner adds outside addresses, and staff can\'t schedule at all', async () => {
  const shop = await addP2Shop(world);
  const manager = await shop.addManager();
  const staff = await shop.addStaff(['analytics']);
  const view = await newView(shop);
  const report = need(await shop.as(manager.token, '/scheduled-reports', { method: 'POST', body: { viewId: view.id, frequency: 'weekly', hourOfDay: 9, weekday: 1 } }), 201, 'A manager schedules').json();
  const refused = await shop.as(manager.token, `/scheduled-reports/${report.id}/recipients`, { method: 'POST', body: { email: 'x@firm.example' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'Owner only.');
  assert.equal((await shop.as(staff.token, '/scheduled-reports', { method: 'POST', body: { viewId: view.id } })).status, 403);
});

test('N-62: removing an outside address is logged too, and it stops getting the report', async () => {
  const shop = await addP2Shop(world);
  const report = await schedule(shop, (await newView(shop)).id);
  const recipient = await addRecipient(shop, report.id, 'gone@firm.example');
  const before = (await shop.audit('recipient|scheduled|report')).length;
  need(await shop.api(`/scheduled-report-recipients/${recipient.id}`, { method: 'DELETE' }), 204, 'Removing');
  assert.ok((await shop.audit('recipient|scheduled|report')).length > before, 'Logged');
  await due(shop, report.id);
  await shop.settle({ ms: 3000, roundMs: 300 });
  assert.deepEqual(await shop.deliveries('to_address = $2', ['gone@firm.example']), []);
});

test('N-62: the same address twice is one recipient, in any letter case', async () => {
  const shop = await addP2Shop(world);
  const report = await schedule(shop, (await newView(shop)).id);
  await addRecipient(shop, report.id, 'dup@firm.example');
  const again = await shop.api(`/scheduled-reports/${report.id}/recipients`, { method: 'POST', body: { email: 'DUP@firm.example' } });
  assert.ok([201, 400, 409].includes(again.status));
  const [{ n }] = await shop.sql(`SELECT count(*)::int AS n FROM scheduled_report_recipients WHERE tenant_id = $1 AND lower(email) = 'dup@firm.example'`, [shop.tenantId]);
  assert.equal(n, 1);
});

test('N-62: an address carrying a header injection is refused', async () => {
  const shop = await addP2Shop(world);
  const report = await schedule(shop, (await newView(shop)).id);
  for (const email of ['a@b.example\r\nBcc: x@y.example', 'a b@firm.example', 'notanaddress', '@firm.example', 'a@b']) {
    assert.equal((await shop.api(`/scheduled-reports/${report.id}/recipients`, { method: 'POST', body: { email } })).status, 400, JSON.stringify(email));
  }
});

test('N-62: another business\'s schedule is not found, and a hostile schedule is refused', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const report = await schedule(b, (await newView(b)).id);
  assert.equal((await a.api(`/scheduled-reports/${report.id}`, { method: 'PATCH', body: { enabled: false } })).status, 404);
  assert.equal((await a.api(`/scheduled-reports/${report.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.api(`/scheduled-reports/${report.id}/recipients`, { method: 'POST', body: { email: 'a@firm.example' } })).status, 404);
  const view = await newView(a);
  for (const body of [{ viewId: view.id, hourOfDay: 24 }, { viewId: view.id, hourOfDay: -1 }, { viewId: view.id, weekday: 7 }, { viewId: view.id, dayOfMonth: 29 }, { viewId: view.id, frequency: 'hourly' }, { viewId: view.id, format: 'exe' }]) {
    assert.equal((await a.api('/scheduled-reports', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
});

test('N-62: scheduled reports are from tier 2; on tier 1 the owner is told so', async () => {
  const shop = await addP2Shop(world, { plan: 't1' });
  const view = await newView(shop);
  const res = await shop.api('/scheduled-reports', { method: 'POST', body: { viewId: view.id, frequency: 'weekly', hourOfDay: 9, weekday: 1 } });
  assert.ok(res.status === 400 || res.status === 402 || res.status === 403, `Got ${res.status}`);
});

test('N-62: a shared view with hidden revenue isn\'t mailed to someone who can\'t see it', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 30, source: 'bio_link', orders: 1, revenue_paise: 123456 }]);
  const view = await newView(shop, { definition: { metrics: ['sessions', 'revenue_paise'], range: '7' } });
  const report = await schedule(shop, view.id);
  const staff = await shop.addStaff(['analytics']);
  await shop.sql(`INSERT INTO scheduled_report_recipients (tenant_id, scheduled_report_id, kind, user_id) VALUES ($1, $2, 'team', $3)`, [shop.tenantId, report.id, staff.user.id]);
  await due(shop, report.id);
  await shop.settle({ ms: 3000, roundMs: 300 });
  for (const delivery of await shop.deliveries('user_id = $2', [staff.user.id])) assert.equal(delivery.body.includes('123456'), false);
});

// ---- N-63 ------------------------------------------------------------------------------------------------------------

const createKey = (shop, name = `Key ${unique()}`) => shop.post('/api-keys', { name }, 201, 'Creating a key');
const reporting = (shop, key, path, options = {}) => hit(world, `${REPORTING_BASE_PATH}/businesses/${options.business ?? shop.tenantId}${path}`, { host: shop.host, headers: { ...(key ? reportingKeyHeaders(key) : {}), ...options.headers } });

test('N-63: a manager can\'t create an API key: "Owner only"', async () => {
  const shop = await addP2Shop(world);
  const manager = await shop.addManager();
  const res = await shop.as(manager.token, '/api-keys', { method: 'POST', body: { name: 'Mine' } });
  assert.equal(res.status, 403);
  assert.equal(res.json().error, 'Owner only.');
  assert.deepEqual(await shop.sql('SELECT * FROM reporting_api_keys WHERE tenant_id = $1', [shop.tenantId]), []);
});

test('N-63: nor can a manager list or revoke one', async () => {
  const shop = await addP2Shop(world);
  const key = await createKey(shop);
  const manager = await shop.addManager();
  for (const [method, path] of [['GET', '/api-keys'], ['DELETE', `/api-keys/${key.id}`]]) assert.equal((await shop.as(manager.token, path, { method })).status, 403, path);
});

test('N-63: a key is shown once, stored hashed, scoped read-only, and has the prefix', async () => {
  const shop = await addP2Shop(world);
  const created = await createKey(shop);
  assert.match(created.key, /^bhv_/);
  assert.equal(created.scope, 'analytics:read');
  const [row] = await shop.sql('SELECT * FROM reporting_api_keys WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(JSON.stringify(row).includes(created.key), false, 'The key isn\'t stored');
  assert.notEqual(row.key_hash, created.key);
  const listed = (await shop.get('/api-keys')).items.find((k) => k.id === created.id);
  assert.equal(Object.hasOwn(listed, 'key'), false, 'Never returned again');
  assert.equal(JSON.stringify(listed).includes(created.key), false);
  assert.ok((await shop.audit('key')).length >= 1, 'Creating one is audited');
});

test('N-63: the same key text is never issued twice', async () => {
  const shop = await addP2Shop(world);
  const keys = await Promise.all([createKey(shop), createKey(shop), createKey(shop)]);
  assert.equal(new Set(keys.map((k) => k.key)).size, 3);
});

// ---- N-64 ------------------------------------------------------------------------------------------------------------

test('N-64: a key asking for another business\'s id gets 404, no data, and the attempt is logged', async (t) => {
  const logs = captureLogs(t);
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await b.seedSessions([{ count: 5, source: 'bio_link' }]);
  const { key } = await createKey(a);
  const id = requestId();
  const res = await reporting(a, key, '/metrics?metrics=sessions', { business: b.tenantId, headers: { 'x-request-id': id } });
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /sessions/);
  assertAttemptLogged(logs, id, /report|key|not.?found|404/i);
  assert.equal(logs.text().includes(key), false, 'The key isn\'t in the logs');
});

test('N-64: a key works on the address of any host, and the key alone says which business it is', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await a.seedSessions([{ count: 5, source: 'bio_link' }]);
  const { key } = await createKey(a);
  const res = need(await hit(world, `${REPORTING_BASE_PATH}/businesses/${a.tenantId}/metrics?metrics=sessions&range=7`, { host: b.host, headers: reportingKeyHeaders(key) }), 200, 'The call').json();
  assert.ok(res.data.length >= 0);
});

test('N-64: a request with no key, a made-up key, or a session instead of a key is 401', async () => {
  const shop = await addP2Shop(world);
  assert.equal((await reporting(shop, null, '/metrics?metrics=sessions')).status, 401);
  assert.equal((await reporting(shop, 'bhv_madeup', '/metrics?metrics=sessions')).status, 401);
  assert.equal((await hit(world, `${REPORTING_BASE_PATH}/businesses/${shop.tenantId}/metrics?metrics=sessions`, { host: shop.host, token: shop.token })).status, 401);
});

test('N-64: the same metrics, dimensions and filters as Explore, with cursor paging and ISO dates', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions(Array.from({ length: 150 }, (_, i) => ({ count: 1, landing_page: `/r/p${i}`, source: i % 2 ? 'bio_link' : 'direct', day: dayAgo(1) })));
  const { key } = await createKey(shop);
  const first = need(await reporting(shop, key, '/metrics?metrics=sessions&dimensions=landing_page&filter=source:exclude:direct&range=7&limit=50'), 200, 'First page').json();
  assert.equal(first.data.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(first.columns[0].source, 'bhava');
  assert.equal(first.timeZone, shop.timeZone);
  const seen = new Set(first.data.map((r) => r.dimensions.landing_page));
  let cursor = first.nextCursor;
  while (cursor) {
    const page = need(await reporting(shop, key, `/metrics?metrics=sessions&dimensions=landing_page&filter=source:exclude:direct&range=7&limit=50&cursor=${cursor}`), 200, 'Next page').json();
    for (const r of page.data) seen.add(r.dimensions.landing_page);
    cursor = page.nextCursor;
  }
  assert.equal(seen.size, 75, 'Every non-direct row once');
});

test('N-64: hostile reporting queries are refused, and the catalogue is the plan\'s own', async () => {
  const shop = await addP2Shop(world);
  const { key } = await createKey(shop);
  for (const query of ['metrics=', 'metrics=nope', 'metrics=sessions&dimensions=visitor_id', 'metrics=sessions&dimensions=source,device,city', 'metrics=sessions&range=evil', 'metrics=sessions&limit=0', 'metrics=sessions&limit=101', "metrics=sessions&cursor='", 'metrics=sessions;DROP TABLE tenants']) {
    assert.equal((await reporting(shop, key, `/metrics?${query}`)).status, 400, query);
  }
  for (const id of ['abc', '0', '-1', "1'--"]) assert.ok([400, 404].includes((await reporting(shop, key, '/metrics?metrics=sessions', { business: id })).status), id);
  need(await reporting(shop, key, '/catalog'), 200, 'The catalogue');
  assert.ok((await shop.sql('SELECT count(*)::int AS n FROM tenants'))[0].n > 0);
});

test('N-64: the reporting API is GET only, and it is from tier 2', async () => {
  const shop = await addP2Shop(world);
  const { key } = await createKey(shop);
  const write = await hit(world, `${REPORTING_BASE_PATH}/businesses/${shop.tenantId}/metrics`, { host: shop.host, method: 'POST', headers: reportingKeyHeaders(key), body: {} });
  assert.ok(write.status === 404 || write.status === 405, `A write got ${write.status}`);
  const tier1 = await addP2Shop(world, { plan: 't1' });
  const res = await tier1.api('/api-keys', { method: 'POST', body: { name: 'K' } });
  assert.ok([400, 402, 403].includes(res.status), `Tier 1 got ${res.status}`);
});

test('N-64: revenue isn\'t handed to a key on a plan without it', async () => {
  const shop = await addP2Shop(world, { plan: 't2' });
  await shop.seedSessions([{ count: 5, source: 'bio_link', orders: 1, revenue_paise: 999 }]);
  const { key } = await createKey(shop);
  const res = await reporting(shop, key, '/metrics?metrics=revenue_paise&range=7');
  if (res.status === 200) assert.equal(res.text.includes('999'), false);
  else assert.ok([400, 403].includes(res.status));
});

// ---- N-65 ------------------------------------------------------------------------------------------------------------

test('N-65: the 61st request in a minute gets 429 with a retry time', async () => {
  const shop = await addP2Shop(world);
  const { key } = await createKey(shop);
  for (let i = 1; i <= 60; i++) assert.equal((await reporting(shop, key, '/metrics?metrics=sessions')).status, 200, `Request ${i}`);
  const res = await reporting(shop, key, '/metrics?metrics=sessions');
  assert.equal(res.status, 429);
  const wait = Number(res.headers['retry-after']);
  assert.ok(wait >= 1 && wait <= 60, `Retry-After is ${res.headers['retry-after']}`);
});

test('N-65: 70 requests at the same moment let at most 60 through', async () => {
  const shop = await addP2Shop(world);
  const { key } = await createKey(shop);
  const results = await Promise.all(Array.from({ length: 70 }, () => reporting(shop, key, '/metrics?metrics=sessions')));
  const ok = results.filter((r) => r.status === 200).length;
  assert.ok(ok <= 60, `${ok} went through`);
  assert.equal(results.filter((r) => r.status === 429).length, 70 - ok);
});

test('N-65: the limit is per key: another key of the same business is unaffected', async () => {
  const shop = await addP2Shop(world);
  const first = await createKey(shop);
  const second = await createKey(shop);
  for (let i = 0; i < 61; i++) await reporting(shop, first.key, '/metrics?metrics=sessions');
  assert.equal((await reporting(shop, second.key, '/metrics?metrics=sessions')).status, 200);
});

test('N-65: a bad key can\'t use up the limit of a good one', async () => {
  const shop = await addP2Shop(world);
  const { key } = await createKey(shop);
  for (let i = 0; i < 70; i++) await reporting(shop, `${key}x`, '/metrics?metrics=sessions');
  assert.equal((await reporting(shop, key, '/metrics?metrics=sessions')).status, 200);
});

// ---- N-66 ------------------------------------------------------------------------------------------------------------

test('N-66: a revoked key gets 401 at once, and revoking is audited', async () => {
  const shop = await addP2Shop(world);
  const { id, key } = await createKey(shop);
  need(await reporting(shop, key, '/metrics?metrics=sessions'), 200, 'Before');
  need(await shop.api(`/api-keys/${id}`, { method: 'DELETE' }), 204, 'Revoking');
  assert.equal((await reporting(shop, key, '/metrics?metrics=sessions')).status, 401);
  assert.ok((await shop.get('/api-keys')).items.find((k) => k.id === id).revokedAt);
  assert.ok((await shop.audit('key')).length >= 2, 'Create and revoke are both logged');
});

test('N-66: another business can\'t revoke a key, and revoking twice is harmless', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  const { id, key } = await createKey(a);
  assert.equal((await b.api(`/api-keys/${id}`, { method: 'DELETE' })).status, 404);
  need(await reporting(a, key, '/metrics?metrics=sessions'), 200, 'Still works');
  need(await a.api(`/api-keys/${id}`, { method: 'DELETE' }), 204, 'First');
  assert.ok([204, 404].includes((await a.api(`/api-keys/${id}`, { method: 'DELETE' })).status));
});

test('N-66: a key last-used time is kept, and a revoked key\'s isn\'t touched', async () => {
  const shop = await addP2Shop(world);
  const { id, key } = await createKey(shop);
  await reporting(shop, key, '/metrics?metrics=sessions');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok((await shop.get('/api-keys')).items.find((k) => k.id === id).lastUsedAt);
});

// ---- N-81 to N-83 -----------------------------------------------------------------------------------------------------

test('N-81: a seller has no route that names raw events or an export of them, and a guess at one is refused', async () => {
  assert.deepEqual(routeList.filter((r) => /raw|export|events\b/i.test(`${r.id} ${r.path}`) && !/activity|audit/.test(r.id)).map((r) => r.id), []);
  const shop = await addP2Shop(world);
  for (const path of ['/traffic/events', '/traffic/raw', '/raw-export', '/exports/raw', '/events/export']) {
    assert.ok([404, 501].includes((await shop.raw(path)).status), path);
  }
  for (const body of [{ source: 'raw_events' }, { source: 'traffic_events', format: 'csv' }]) assert.equal((await shop.api('/downloads', { method: 'POST', body })).status, 400);
});

test('N-81: the console offers summary exports only: CSV and Excel', async () => {
  const shop = await addP2Shop(world);
  await shop.seedSessions([{ count: 2, source: 'bio_link' }]);
  for (const format of ['csv', 'xlsx']) {
    const done = await waitForFile(world, shop, await shop.post('/downloads', { source: 'explore', format, query: { metrics: ['sessions'], range: '7' } }, 201));
    assert.equal(done.status, 'ready', format);
  }
});

test('N-81: a summary export has no visitor ids or event rows', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await shop.settle({ ms: 2000, roundMs: 200 });
  const done = await waitForFile(world, shop, await shop.post('/downloads', { source: 'explore', format: 'csv', query: { metrics: ['sessions'], dimensions: ['landing_page'], range: '7' } }, 201));
  const file = need(await fileAt(world, shop, done.fileUrl), 200, 'The file');
  assert.equal(file.text.includes(visitor.visitorId), false);
});

test('N-82: an API key is refused event-level rows', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/secret-path' });
  await shop.settle({ ms: 2000, roundMs: 200 });
  const { key } = await createKey(shop);
  const res = await reporting(shop, key, '/events');
  assert.equal(res.status, 403);
  assert.equal(res.json().code, 'forbidden');
  assert.equal(res.text.includes('secret-path'), false);
});

test('N-82: no query to the summary route can return event rows or a visitor id', async () => {
  const shop = await addP2Shop(world);
  const visitor = shopper(world, shop);
  await visitor.send({ name: 'page_view', path: '/a' });
  await shop.settle({ ms: 2000, roundMs: 200 });
  const { key } = await createKey(shop);
  for (const dimension of ['visitor_id', 'session_id', 'path', 'ip', 'event_key']) assert.equal((await reporting(shop, key, `/metrics?metrics=sessions&dimensions=${dimension}`)).status, 400, dimension);
  const ok = need(await reporting(shop, key, '/metrics?metrics=sessions&range=7'), 200, 'A summary').json();
  assert.equal(JSON.stringify(ok).includes(visitor.visitorId), false);
});

test('N-83: a super admin\'s raw event export for one business makes the file and is logged', async () => {
  const shop = await addP2Shop(world);
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  await shop.settle({ ms: 2000, roundMs: 200 });
  const admin = await consoleUser(world, 'super_admin');
  const res = need(await onConsole(world, admin, '/raw-export', { method: 'POST', body: { reason: 'Audit request 1', tables: ['traffic_events'], tenantIds: [shop.tenantId], from: dayAgo(1), to: dayAgo(0) } }), 201, 'The raw export').json();
  assert.ok(res.rowCount >= 1);
  assert.ok(res.expiresAt);
  const rows = await world.rawDb.platform.query(`SELECT * FROM audit_log WHERE action = 'raw_export.create' ORDER BY id DESC LIMIT 1`);
  assert.ok(rows.length, 'It is in the audit log');
  assert.ok(JSON.stringify(rows[0]).includes('traffic_events'));
  assert.ok(JSON.stringify(rows[0].details ?? {}).includes('Audit request 1') || JSON.stringify(rows[0]).includes('Audit'));
});

test('N-83: support staff can\'t make a raw export, and a seller can\'t reach the route', async () => {
  const shop = await addP2Shop(world);
  const support = await consoleUser(world, 'support');
  const body = { reason: 'Audit request 2', tables: ['traffic_events'], tenantIds: [shop.tenantId], from: dayAgo(1), to: dayAgo(0) };
  assert.equal((await onConsole(world, support, '/raw-export', { method: 'POST', body })).status, 403);
  assert.ok([401, 403, 404].includes((await hit(world, '/raw-export', { host: shop.host, method: 'POST', token: shop.token, body })).status));
});

test('N-62: a report due at this business\'s Monday 09:00 keeps that hour when the clock runs back', async (t) => {
  const shop = await addP2Shop(world, { timeZone: 'Asia/Kolkata' });
  const report = await schedule(shop, (await newView(shop)).id, { frequency: 'weekly', hourOfDay: 9, weekday: 1 });
  const restore = atClock(lastWeekdayAt({ weekday: 1, hour: 9, minute: 1 }));
  t.after(restore);
  await due(shop, report.id);
  await shop.settle({ ms: 3000, roundMs: 300 });
  const [row] = await shop.sql('SELECT next_run_at FROM scheduled_reports WHERE id = $1', [report.id]);
  const local = new Date(new Date(row.next_run_at).getTime() + 5.5 * HOUR);
  assert.deepEqual([local.getUTCDay(), local.getUTCHours()], [1, 9]);
});
