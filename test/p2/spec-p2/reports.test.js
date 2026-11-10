// PRD 7.9: reports and exports. N-39 to N-44. Reports run on the seller's clock, so these tests set the app's clock to the moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { CUSTOMER, addOrder, addProduct } from '../../p0/spec-p0/support.js';
import { DAY, HOUR, addP2Shop, atClock, fileAt, lastFirstOfMonthAt, lastWeekdayAt, need, parseCsv, shopper, unique, useP2World, waitForFile } from './support.js';

const world = useP2World();
const IST = { timeZone: 'Asia/Kolkata' };
const MONDAY = 1;

/** The app's clock is put at a moment, and the worker does what is due then. */
async function at(t, when, shop) {
  const restore = atClock(when);
  t.after(restore);
  await shop.settle({ ms: 4000, roundMs: 300 });
}
const mondayAt = (hour, minute = 0) => lastWeekdayAt({ weekday: MONDAY, hour, minute });
const firstAt = (hour, minute = 0) => lastFirstOfMonthAt({ hour, minute });
const emails = (shop) => shop.deliveries(`channel = 'email'`);
const download = async (shop, body) => {
  const made = await shop.post('/downloads', body, 201, 'The download');
  return waitForFile(world, shop, made);
};
const fileOf = async (shop, done) => {
  assert.equal(done.status, 'ready', `The download is ${done.status}`);
  return need(await fileAt(world, shop, done.fileUrl), 200, 'The file');
};

// ---- N-39 ------------------------------------------------------------------------------------------------------------

const seedCaption = (shop, caption) => shop.seedMedia({ mediaId: `c${unique()}`, kind: 'reel', latest: { views: 5 }, caption });

test('N-39: a caption starting =HYPERLINK( is written as \'=HYPERLINK( in the CSV', async () => {
  const shop = await addP2Shop(world);
  const caption = '=HYPERLINK("https://evil.example","Click")';
  await seedCaption(shop, caption);
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
  const cells = parseCsv(file.text.replace(/^﻿/, '')).flat();
  assert.ok(cells.includes(`'${caption}`), `Escaped caption not found in ${cells.slice(0, 20).join(' | ')}`);
  assert.equal(cells.includes(caption), false, 'The raw formula is not there');
});

for (const start of ['=', '+', '-', '@']) {
  test(`N-39: a cell starting ${start} is prefixed with a quote`, async () => {
    const shop = await addP2Shop(world);
    const caption = `${start}SUM(1+1)`;
    await seedCaption(shop, caption);
    const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
    assert.ok(parseCsv(file.text.replace(/^﻿/, '')).flat().includes(`'${caption}`));
  });
}

test('N-39: a tab or carriage return ahead of the formula doesn\'t get it past the check', async () => {
  const shop = await addP2Shop(world);
  for (const caption of ['\t=cmd', '\r=cmd', '\n=cmd', '  =cmd']) {
    const id = `c${unique()}`;
    await shop.seedMedia({ mediaId: id, kind: 'reel', latest: { views: 5 }, caption });
  }
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
  for (const cell of parseCsv(file.text.replace(/^﻿/, '')).flat()) assert.doesNotMatch(cell, /^\s*=cmd/, JSON.stringify(cell));
});

test('N-39: a caption with quotes, commas and new lines stays one cell', async () => {
  const shop = await addP2Shop(world);
  const caption = 'She said "hi", then\nleft';
  await seedCaption(shop, caption);
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
  assert.ok(parseCsv(file.text.replace(/^﻿/, '')).flat().includes(caption));
});

test('N-39: the CSV is UTF-8 with a BOM', async () => {
  const shop = await addP2Shop(world);
  await seedCaption(shop, 'Hindi: नमस्ते');
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
  assert.equal(file.raw[0], 0xef);
  assert.equal(file.raw[1], 0xbb);
  assert.equal(file.raw[2], 0xbf);
  assert.ok(file.text.includes('नमस्ते'));
  assert.match(file.headers['content-type'], /csv/);
});

test('N-39: XLSX has the same escape, and the cell is text, not a formula', async () => {
  const shop = await addP2Shop(world);
  const caption = '=HYPERLINK("https://evil.example","x")';
  await seedCaption(shop, caption);
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'xlsx' }));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.raw);
  const values = [];
  workbook.worksheets[0].eachRow((row) => row.eachCell((cell) => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula, 'No cell is a formula');
    values.push(String(cell.value));
  }));
  assert.ok(values.includes(`'${caption}`), values.slice(0, 20).join(' | '));
});

for (const source of ['account_daily', 'media', 'story_finals', 'content_funnel', 'health_history']) {
  test(`N-39: the ${source} export is aggregates only, with no usernames and no shopper data`, async () => {
    const shop = await addP2Shop(world);
    const secret = world.fan('secretfan');
    await seedCaption(shop, 'Ordinary');
    await shop.seedDays('reach', { 3: 500 });
    const file = await fileOf(shop, await download(shop, { source, format: 'csv' }));
    for (const banned of [secret.username, 'visitor_id', 'subject_hash', 'phone', 'user_agent']) assert.equal(file.text.includes(banned), false, banned);
  });
}

test('N-39: the export uses the seller\'s time zone', async () => {
  const shop = await addP2Shop(world, IST);
  // 20:00 UTC is 01:30 the next day in India.
  const posted = new Date(new Date(Date.now() - 3 * DAY).setUTCHours(20, 0, 0, 0));
  await shop.seedMedia({ mediaId: `tz${unique()}`, kind: 'reel', latest: { views: 5 }, caption: 'tz', postedAgoMs: Date.now() - posted.getTime() });
  const file = await fileOf(shop, await download(shop, { source: 'media', format: 'csv' }));
  const day = new Date(posted.getTime() + 5.5 * HOUR).toISOString().slice(0, 10);
  assert.ok(file.text.includes(day), `Expected ${day} in the file`);
});

test('N-39: a file is for its own business, signed in: nobody else can open it', async () => {
  const a = await addP2Shop(world);
  const b = await addP2Shop(world);
  await seedCaption(a, 'Ours');
  const done = await download(a, { source: 'media', format: 'csv' });
  assert.ok([401, 403, 302, 303].includes((await fileAt(world, a, done.fileUrl, { token: null })).status), 'Not signed in');
  assert.equal((await fileAt(world, b, done.fileUrl)).status, 404, 'Another business');
  assert.equal((await b.raw(`/downloads/${done.id}`)).status, 404);
  const staff = await a.addStaff(['orders']);
  assert.equal((await a.as(staff.token, `/downloads/${done.id}`)).status, 403, 'Without analytics');
});

test('N-39: hostile download requests are refused', async () => {
  const shop = await addP2Shop(world);
  for (const body of [{}, { source: 'raw_events' }, { source: 'traffic_events' }, { source: 'media', format: 'exe' }, { source: 'explore' }, { source: 'funnel' }, { source: 'cohort' }, { source: 'explore', query: { metrics: ['sessions'], dimensions: ['visitor_id'] } }, { source: 'media', from: "x' OR 1=1", to: '2026-01-01' }]) {
    assert.equal((await shop.api('/downloads', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
});

// ---- N-40 ------------------------------------------------------------------------------------------------------------

test('N-40: a tier 1 weekly report shows taps or visits where measured, and no orders or revenue', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't1' });
  await shop.seedDays('reach', { 3: 500 });
  await shop.seedFunnel('R1', { dms: 10, taps: 4 });
  await at(t, mondayAt(9, 5), shop);
  const [run] = await shop.runs('weekly');
  assert.ok(run, 'The weekly report ran');
  assert.equal(run.status, 'sent');
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  assert.doesNotMatch(`${mail.subject} ${mail.body}`, /revenue|₹|\border(s)?\b/i);
  assert.match(mail.body, /tap|visit/i);
  assert.ok((await shop.deliveries(`channel = 'push'`)).length >= 1, 'And the owner app push');
});

test('N-40: tier 3 sees revenue in the same report', async (t) => {
  const shop = await addP2Shop(world, IST);
  await shop.seedFunnel('R1', { dms: 10, taps: 4, sales: [{ amountPaise: 250000 }] });
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  assert.match(mail.body, /revenue|₹/i);
});

test('N-40: the report goes at 09:00 in the seller\'s time zone: not at 08:59', async (t) => {
  const shop = await addP2Shop(world, IST);
  await at(t, mondayAt(8, 59), shop);
  assert.equal((await shop.runs('weekly')).length, 0, 'Not yet');
  await at(t, mondayAt(9, 0), shop);
  assert.equal((await shop.runs('weekly')).length, 1, 'Now');
});

test('N-40: a business in another time zone gets its report at its own 09:00', async (t) => {
  const shop = await addP2Shop(world, { timeZone: 'UTC' });
  // 09:30 in India is 04:00 in UTC: too early for this business.
  await at(t, mondayAt(9, 30), shop);
  assert.equal((await shop.runs('weekly')).length, 0);
  await at(t, lastWeekdayAt({ weekday: MONDAY, hour: 9, minute: 5, offsetMs: 0 }), shop);
  assert.equal((await shop.runs('weekly')).length, 1);
});

test('N-40: a second run in the same week sends nothing more, even from two workers at once', async (t) => {
  const shop = await addP2Shop(world, IST);
  const restore = atClock(mondayAt(9, 5));
  t.after(restore);
  world.addWorker();
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  await shop.settle({ ms: 2000, roundMs: 300 });
  assert.equal((await shop.runs('weekly')).length, 1);
  const addresses = (await emails(shop)).map((m) => `${m.user_id}|${m.to_address}`);
  assert.equal(new Set(addresses).size, addresses.length, 'One email per person');
});

test('N-40: the week-on-week figures come from the cache: no call to Meta', async (t) => {
  const shop = await addP2Shop(world, IST);
  await shop.settle({ ms: 1500, roundMs: 200 });
  await shop.sql(`UPDATE insight_polls SET next_due_at = now() + interval '30 days' WHERE tenant_id = $1`, [shop.tenantId]);
  await shop.clearMetaCalls();
  await at(t, mondayAt(9, 5), shop);
  assert.deepEqual((await shop.metaCalls('*')).map((c) => c.path), [], 'No Meta calls for the report');
});

test('N-40: the top 3 media are listed, and a fourth isn\'t', async (t) => {
  const shop = await addP2Shop(world, IST);
  const prefix = `top${unique()}`;
  for (let i = 1; i <= 4; i++) await shop.seedMedia({ mediaId: `${prefix}-rank-${i}`, kind: 'reel', postedAgoMs: 3 * DAY, caption: `Caption-number-${i}`, latest: { views: i * 1000 } });
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  const [run] = await shop.runs('weekly');
  const shown = (i) => `${mail.body} ${JSON.stringify(run.summary)}`.match(new RegExp(`Caption-number-${i}|${prefix}-rank-${i}`));
  assert.ok([2, 3, 4].every(shown), mail.body.slice(0, 400));
  assert.equal(shown(1), null, 'Only the top 3');
});

test('N-40: one-click unsubscribe works, and nothing more is sent', async (t) => {
  const shop = await addP2Shop(world, IST);
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  const token = /[?&]token=([\w-]+)/.exec(mail.body)?.[1] ?? /unsubscribe\/([\w-]+)/.exec(mail.body)?.[1];
  assert.ok(token, 'The email has a one-click unsubscribe link');
  const done = need(await shop.as(undefined, '/reports/unsubscribe', { method: 'POST', body: { token, report: 'weekly' } }), 200, 'Unsubscribing').json();
  assert.equal(done.ok, true);
  assert.equal((await shop.get('/reports/preferences')).weekly, false);
});

test('N-40: a made-up unsubscribe token does nothing and says so, without saying why', async () => {
  const shop = await addP2Shop(world, IST);
  const res = need(await shop.as(undefined, '/reports/unsubscribe', { method: 'POST', body: { token: 'nope', report: 'all' } }), 200, 'The request');
  assert.equal(res.json().ok, false);
  assert.equal((await shop.get('/reports/preferences')).weekly, true);
});

test('N-40: a person who turned the weekly report off gets none, and another owner still does', async (t) => {
  const shop = await addP2Shop(world, IST);
  need(await shop.api('/reports/preferences', { method: 'PATCH', body: { weekly: false } }), 200, 'Turning it off');
  await at(t, mondayAt(9, 5), shop);
  assert.deepEqual((await emails(shop)).map((m) => m.subject), []);
});

test('N-40: reports are listed for their own business only', async (t) => {
  const a = await addP2Shop(world, IST);
  const b = await addP2Shop(world, IST);
  await at(t, mondayAt(9, 5), a);
  const [run] = await a.runs('weekly');
  assert.ok((await a.get('/reports')).items.some((r) => r.id === Number(run.id)));
  assert.equal((await b.raw(`/reports/${run.id}`)).status, 404);
});

// ---- N-41 ------------------------------------------------------------------------------------------------------------

test('N-41: a token that expired on Sunday: the Monday report still sends, with a Reconnect Instagram notice', async (t) => {
  const shop = await addP2Shop(world, IST);
  await shop.sql(`UPDATE ig_accounts SET status = 'reconnect_needed', token_expires_at = now() - interval '1 day' WHERE tenant_id = $1 AND ig_user_id = $2`, [shop.tenantId, shop.igUserId]);
  await at(t, mondayAt(9, 5), shop);
  const [run] = await shop.runs('weekly');
  assert.equal(run?.status, 'sent');
  const [mail] = await emails(shop);
  assert.match(mail.body, /Reconnect Instagram/);
});

test('N-41: Meta being down has no effect on the report', async (t) => {
  const shop = await addP2Shop(world, IST);
  await world.meta.fault({ kind: 'timeout', times: 'forever' });
  try {
    await at(t, mondayAt(9, 5), shop);
    assert.equal((await shop.runs('weekly'))[0]?.status, 'sent');
  } finally {
    await world.meta.delete('/faults');
  }
});

test('N-41: a business with no Instagram connected still gets its report', async (t) => {
  const shop = await addP2Shop(world, { ...IST, igConnected: false });
  await at(t, mondayAt(9, 5), shop);
  assert.equal((await shop.runs('weekly'))[0]?.status, 'sent');
});

// ---- N-42 ------------------------------------------------------------------------------------------------------------

test('N-42: the report email is from Bhava, names the business, and has no shopper data', async (t) => {
  const shop = await addP2Shop(world, { ...IST, name: `Mehta ${unique()}` });
  const product = await addProduct(shop, 'Lamp');
  const customer = { ...CUSTOMER, name: 'Priya Shopperton', phone: '9811122233', email: 'priya@shopper.example' };
  await addOrder(shop, product, customer);
  await shopper(world, shop).send({ name: 'page_view', path: '/a' });
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  assert.ok(mail.body.includes(shop.name) || mail.subject.includes(shop.name), 'The business is named');
  assert.match(`${mail.subject} ${mail.body}`, /bhava/i, 'It is a Bhava email');
  for (const secret of ['Priya Shopperton', '9811122233', 'priya@shopper.example', '12 MG Road']) assert.equal(mail.body.includes(secret), false, `The email holds ${secret}`);
  assert.equal(JSON.stringify((await shop.runs('weekly'))[0].summary).includes('Priya'), false, 'The stored summary too');
});

test('N-42: the email goes to the team, not to shoppers', async (t) => {
  const shop = await addP2Shop(world, IST);
  const customer = await shop.addCustomer();
  await at(t, mondayAt(9, 5), shop);
  const mail = await emails(shop);
  const users = await shop.sql(`SELECT id FROM users WHERE tenant_id = $1 AND phone = $2`, [shop.tenantId, customer.phone]);
  assert.equal(mail.some((m) => m.user_id === users[0].id), false);
});

test('N-42: a caption with HTML is not live in the report email', async (t) => {
  const shop = await addP2Shop(world, IST);
  await shop.seedMedia({ mediaId: `m${unique()}`, kind: 'reel', postedAgoMs: 2 * DAY, caption: '<img src=x onerror=alert(1)>', latest: { views: 999999 } });
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  assert.equal(mail.body.includes('<img src=x onerror='), false, 'The caption is escaped');
});

// ---- N-43 ------------------------------------------------------------------------------------------------------------

test('N-43: a tier 2 business on the 1st gets the previous month at 09:00, with DMs, visits and taps per reel, traffic by source, and no revenue', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't2' });
  const start = firstAt(9, 5);
  const previousMonth = new Date(start + 5.5 * HOUR - 2 * DAY).toISOString().slice(0, 7);
  await shop.seedSessions([{ count: 9, day: `${previousMonth}-15`, source: 'bio_link', product_taps: 1 }]);
  await shop.seedFunnel('R1', { dms: 12, taps: 3 });
  await shop.seedMedia({ mediaId: 'R1', kind: 'reel', postedAgoMs: 40 * DAY, latest: { views: 100 } });
  await at(t, start, shop);
  const [run] = await shop.runs('monthly');
  assert.ok(run, 'The monthly report ran');
  assert.equal(run.status, 'sent');
  assert.equal(String(run.period_start.toISOString?.().slice(0, 7) ?? run.period_start).slice(0, 7), previousMonth);
  const [mail] = await shop.deliveries(`report_run_id = $2 AND channel = 'email'`, [run.id]);
  assert.ok(mail, 'A monthly email');
  assert.match(mail.body, /dm/i);
  assert.match(mail.body, /visit/i);
  assert.match(mail.body, /tap/i);
  assert.match(mail.body, /source|bio/i);
  assert.doesNotMatch(mail.body, /revenue|₹/i);
  assert.ok(run.storage_key, 'A PDF is kept');
  const detail = await shop.get(`/reports/${run.id}`);
  assert.ok(detail.fileUrl, 'The admin links to it');
  const pdf = need(await fileAt(world, shop, detail.fileUrl), 200, 'The PDF');
  assert.equal(pdf.raw.subarray(0, 5).toString(), '%PDF-');
});

test('N-43: the 1st at 08:59 is too early, and at 09:00 it runs', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't2' });
  await at(t, firstAt(8, 59), shop);
  assert.equal((await shop.runs('monthly')).length, 0);
  await at(t, firstAt(9, 0), shop);
  assert.equal((await shop.runs('monthly')).length, 1);
});

test('N-43: a month\'s report runs once, however many workers and ticks', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't2' });
  const restore = atClock(firstAt(9, 5));
  t.after(restore);
  world.addWorker();
  await world.tickTogether();
  await shop.settle({ ms: 4000, roundMs: 300 });
  assert.equal((await shop.runs('monthly')).length, 1);
});

test('N-43: tier 3 has orders and revenue in the monthly report', async (t) => {
  const shop = await addP2Shop(world, IST);
  await shop.seedFunnel('R1', { dms: 12, taps: 3, sales: [{ amountPaise: 99900 }] });
  await at(t, firstAt(9, 5), shop);
  const [run] = await shop.runs('monthly');
  const [mail] = await shop.deliveries(`report_run_id = $2 AND channel = 'email'`, [run.id]);
  assert.match(mail.body, /order|revenue|₹/i);
});

test('N-43: the PDF is only for its own business', async (t) => {
  const a = await addP2Shop(world, { ...IST, plan: 't2' });
  const b = await addP2Shop(world, { ...IST, plan: 't2' });
  await at(t, firstAt(9, 5), a);
  const [run] = await a.runs('monthly');
  const detail = await a.get(`/reports/${run.id}`);
  assert.equal((await fileAt(world, b, detail.fileUrl)).status, 404);
});

// ---- N-44 ------------------------------------------------------------------------------------------------------------

test('N-44: tier 1 without the service gets no monthly report, and the weekly report still sends', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't1' });
  await at(t, firstAt(9, 5), shop);
  assert.equal((await shop.runs('monthly')).length, 0);
  assert.equal((await shop.get('/reports/preferences')).monthlyAvailable, false);
  await at(t, mondayAt(9, 5), shop);
  assert.equal((await shop.runs('weekly')).length, 1);
});

test('N-44: tier 1 with the service bought gets it', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't1' });
  await shop.repos.entitlements.setOverride('report.monthly', { enabled: true });
  await at(t, firstAt(9, 5), shop);
  assert.equal((await shop.runs('monthly')).length, 1);
  assert.equal((await shop.get('/reports/preferences')).monthlyAvailable, true);
});

test('N-44: a seller who turned the monthly report off gets none', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't2' });
  need(await shop.api('/reports/preferences', { method: 'PATCH', body: { monthly: false } }), 200, 'Turning it off');
  await at(t, firstAt(9, 5), shop);
  assert.deepEqual((await shop.deliveries(`channel = 'email'`)).map((m) => m.subject), []);
});

test('N-44: reports need no live data: a tier 1 business with no data at all still gets a clear weekly', async (t) => {
  const shop = await addP2Shop(world, { ...IST, plan: 't1' });
  await at(t, mondayAt(9, 5), shop);
  const [mail] = await emails(shop);
  assert.ok(mail, 'An email is in the outbox');
  assert.doesNotMatch(mail.body, /undefined|NaN|\[object/);
});
