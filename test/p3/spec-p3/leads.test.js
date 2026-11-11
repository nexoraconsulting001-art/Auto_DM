// PRD 8.15: the lead form. A first name and a phone number or an email, with consent the shopper gives by ticking a box that
// names the seller and the channels. Leads are one business's only; downloads are logged; withdrawal shows in the next file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UA, addP3Shop, assertBranded404, assertNoLiveMarkup, captureLogs, creatorPage, csvRows, fillLead, formOf, hit, leadFile, leadFormOn, noPlatformName,
  plain, setFeature, setTier, signIn, submitLead, textOf, useP3World, xlsxRows,
} from './kit.js';

const world = useP3World();

/** A business with a landing page that carries the lead form. */
async function withForm(options = {}, form = {}) {
  const shop = await addP3Shop(world, options);
  const landing = await shop.page({ headline: 'Lead page' });
  await leadFormOn(shop, 'landing', form);
  return { shop, landing, path: `/r/${landing.slug}` };
}

const consents = (shop, leadId) => shop.sql('SELECT channel, granted_at, withdrawn_at FROM lead_consents WHERE tenant_id = $1 AND lead_id = $2 ORDER BY channel', [shop.tenantId, leadId]);
const taken = (r) => r.landed.status === 200 && r.sent.status < 400;

// ---- K-54 ------------------------------------------------------------------------------------------------------------------

test('K-54: a first name and phone with the box ticked saves the lead with its source and consent version, and thanks the shopper in the seller\'s brand', async () => {
  const { shop, landing, path } = await withForm({ name: 'Mehul Sweets' }, { channels: ['whatsapp', 'email'], offerLine: 'Get first word of our festive boxes' });
  const alertsBefore = (await shop.ownerAlerts()).length;
  const settings = await shop.must('GET', '/lead-forms');
  assert.equal(settings.available, true);
  assert.equal(settings.consent.version, 1);
  assert.ok(settings.consent.body.includes('Mehul Sweets'), `The consent names the seller: ${settings.consent.body}`);
  assert.match(settings.consent.body, /WhatsApp/i);
  assert.match(settings.consent.body, /email/i);

  const result = await submitLead(world, shop, `${path}?utm_source=instagram&utm_medium=dm&utm_campaign=diwali-boxes`, { firstName: 'Asha', phone: '98765 43210' });
  assert.ok(result.page.text.includes('Get first word of our festive boxes'), 'The offer line sits above the form');
  assert.ok(result.form.text.includes(settings.consent.body) || plain(result.form.text).includes(plain(settings.consent.body)), 'The form shows the consent wording');
  assert.ok(taken(result), `The form was taken: ${result.sent.status} then ${result.landed.status}`);
  assert.ok(result.landed.text.includes('Mehul Sweets'), 'The thank-you page carries the seller\'s name');
  assert.match(textOf(result.landed.text), /thank/i);
  noPlatformName('The thank-you page', result.landed.text);
  noPlatformName('The thank-you headers', result.landed.headers);
  noPlatformName('The form', result.form.html);
  assert.ok(!result.landed.text.includes('9876543210') && !(result.sent.headers.location ?? '').includes('9876543210'), 'The phone number is not echoed into the page or its address');

  const rows = await shop.leadRows();
  assert.equal(rows.length, 1);
  const lead = rows[0];
  assert.equal(lead.first_name, 'Asha');
  assert.equal(lead.phone, '+919876543210', 'The phone is stored in international format');
  assert.equal(lead.email, '');
  assert.equal(lead.source, 'landing');
  assert.equal(lead.source_ref, landing.slug);
  assert.equal(lead.page_id, landing.id);
  assert.equal(lead.utm_campaign, 'diwali-boxes');
  const [wording] = await shop.sql('SELECT version, body FROM lead_consent_texts WHERE tenant_id = $1 AND id = $2', [shop.tenantId, lead.consent_text_id]);
  assert.equal(wording.version, 1, 'The consent text version is kept with the lead');
  assert.ok(Math.abs(Date.now() - new Date(lead.consented_at).getTime()) < 60_000, 'And when it was given');
  assert.deepEqual((await consents(shop, lead.id)).map((c) => [c.channel, c.withdrawn_at]), [['email', null], ['whatsapp', null]], 'Each channel is its own consent');
  assert.deepEqual(Object.keys(lead).sort(), ['consent_text_id', 'consented_at', 'created_at', 'email', 'first_name', 'id', 'page_id', 'phone', 'source', 'source_ref', 'tenant_id', 'utm_campaign'], 'Nothing else is collected');

  const viaApi = (await shop.must('GET', '/leads')).items;
  assert.deepEqual(viaApi.map((l) => [l.firstName, l.phone, l.source, l.consentVersion, l.pageId]), [['Asha', '+919876543210', 'landing', 1, landing.id]]);
  assert.ok((await shop.ownerAlerts()).length > alertsBefore, 'The owner is told about the new lead');
});

test('K-54: an email instead of a phone works; phones in every common spelling become one international number', async () => {
  const { shop, path } = await withForm();
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Ravi', email: 'Ravi.K@Example.com' })));
  for (const phone of ['9876543210', '09876543210', '+91 98765 43210', '+91-98765-43210', '(+91) 98765 43210', '0091 9876543210']) {
    const result = await submitLead(world, shop, path, { firstName: 'Meera', phone });
    assert.ok(taken(result), `"${phone}" was refused: ${result.sent.status}`);
  }
  const rows = await shop.leadRows();
  assert.equal(rows[0].phone, '');
  assert.match(rows[0].email, /^ravi\.k@example\.com$/i);
  assert.deepEqual([...new Set(rows.slice(1).map((r) => r.phone))], ['+919876543210']);
  for (const [values, what] of [[{ firstName: 'Bad', phone: '12345' }, 'a 5-digit phone'], [{ firstName: 'Bad', email: 'not-an-email' }, 'a bad email'], [{ firstName: 'Bad', email: 'a@b' }, 'an email with no domain'], [{ firstName: 'Bad', phone: 'call me' }, 'words for a phone'], [{ firstName: '', phone: '9876543210' }, 'no first name'], [{ firstName: 'x'.repeat(61), phone: '9876543210' }, 'a 61-letter name']]) {
    const before = (await shop.leadRows()).length;
    const result = await submitLead(world, shop, path, values);
    assert.ok(result.sent.status < 500, `${what} crashed the form`);
    assert.equal((await shop.leadRows()).length, before, `${what} was stored`);
    noPlatformName(`The error for ${what}`, result.landed.text);
  }
});

test('K-54: a lead from the creator page is marked as from the bio page, and one business\'s form never feeds another', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const creator = await creatorPage(shop);
  await leadFormOn(shop, 'creator');
  const result = await submitLead(world, shop, `/${creator.slug}`, { firstName: 'Bio visitor', phone: '9811122233' });
  assert.ok(taken(result));
  const [lead] = await shop.leadRows();
  assert.ok(['creator', 'bio'].includes(lead.source), `The source is the bio page: ${lead.source}`);
  assert.equal((await other.leadRows()).length, 0);
  assert.deepEqual((await other.must('GET', '/leads')).items, []);
  for (const [method, route, body] of [['GET', `/leads/${lead.id}`], ['DELETE', `/leads/${lead.id}`], ['POST', `/leads/${lead.id}/revoke-consent`, {}]]) {
    assert.equal((await other.send(method, route, body)).status, 404, `Another business ${method} ${route}`);
  }
  assert.equal((await shop.leadRows()).length, 1);
  const form = formOf((await shop.open(`/${creator.slug}`)).text);
  const forged = new URLSearchParams(fillLead(form, { firstName: 'Forged', phone: '9811122244' }));
  for (const key of [...forged.keys()]) if (/tenant|business|shop/i.test(key)) forged.set(key, String(other.tenantId));
  forged.set('tenant_id', String(other.tenantId));
  forged.set('tenantId', String(other.tenantId));
  await hit(world, form.action, { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone, 'x-forwarded-for': '198.51.100.77' }, body: forged.toString() });
  assert.equal((await other.leadRows()).length, 0, 'A field naming another business moves nothing there');
  for (const route of ['/leads', '/leads/import', '/lead-imports', '/leads/bulk']) {
    const res = await shop.send('POST', route, { leads: [{ firstName: 'Bought', phone: '+919999999999' }], firstName: 'Bought', phone: '+919999999999' });
    assert.ok([404, 405].includes(res.status), `Outside lists can't be imported as leads: POST ${route} answered ${res.status}`);
  }
});

test('K-54: markup in a name is stored as text and shown as text; a filled honeypot stores nothing; a flood from one address is slowed', async (t) => {
  const logs = captureLogs(t);
  const { shop, path } = await withForm();
  const hostile = await submitLead(world, shop, path, { firstName: '<script>alert(1)</script>', phone: '9800000001' });
  assert.ok(hostile.sent.status < 500);
  assertNoLiveMarkup(hostile.landed.text, 'The page after a hostile name');
  const stored = await shop.leadRows();
  if (stored.length) assert.equal(stored[0].first_name, '<script>alert(1)</script>', 'Stored as the text it is, not altered into something else');
  const before = stored.length;

  const bot = await submitLead(world, shop, path, { firstName: 'Bot', phone: '9800000002', honeypot: 'http://spam.example' });
  assert.ok(bot.sent.status < 500);
  assert.equal((await shop.leadRows()).length, before, 'A filled honeypot stores nothing');
  noPlatformName('The answer to a bot', bot.landed.text);

  const ip = '203.0.113.9';
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const r = await submitLead(world, shop, path, { firstName: `Flood ${i}`, phone: `98000${String(10000 + i)}` }, { ip }).catch(() => ({ sent: { status: 429 }, landed: { status: 429, text: '' } }));
    if (!taken(r)) refused++;
  }
  const flooded = (await shop.leadRows()).length - before;
  assert.ok(flooded < 40, `40 leads from one address in a few seconds were all stored (${flooded})`);
  assert.ok(refused > 0 || flooded < 40, 'The per-address limit stepped in');
  const elsewhere = await submitLead(world, shop, path, { firstName: 'Someone else', phone: '9811100000' }, { ip: '203.0.113.200' });
  assert.ok(taken(elsewhere), 'Another address is not slowed by the flood');
  assert.doesNotMatch((await shop.open(path)).text, /captcha|recaptcha|hcaptcha|turnstile/i, 'No CAPTCHA');
  const text = logs.text();
  for (const secret of ['9800000001', '9811100000', '+919811100000', 'Someone else', 'Flood 3']) assert.ok(!text.includes(secret), `A lead's ${/\d{6}/.test(secret) ? 'phone number' : 'name'} is in the logs`);
});

test('K-54: the same lead sent twice at the same moment never crashes, and every stored lead has its consent', async () => {
  const { shop, path } = await withForm();
  const page = await shop.open(path);
  const form = formOf(page.text);
  const body = fillLead(form, { firstName: 'Twice', phone: '9822200000' });
  const headers = { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone, 'x-forwarded-for': '198.51.100.44' };
  const answers = await Promise.all([1, 2, 3].map(() => hit(world, form.action, { host: shop.host, method: 'POST', headers, body })));
  for (const res of answers) assert.ok(res.status < 500, `A double tap crashed: ${res.status}`);
  const rows = await shop.leadRows();
  assert.ok(rows.length >= 1 && rows.length <= 3);
  assert.equal(rows.length, 1, 'A double tap on Send is one lead');
  for (const row of rows) assert.ok((await consents(shop, row.id)).length >= 1, 'No lead is stored without its consent rows');
});

// ---- K-55 ------------------------------------------------------------------------------------------------------------------

test('K-55: a first name with no phone and no email is blocked: "Add a phone number or email", and nothing is stored', async () => {
  const { shop, path } = await withForm({ name: 'Kutch Crafts' });
  const result = await submitLead(world, shop, path, { firstName: 'Asha' });
  assert.ok(result.sent.status < 500);
  assert.ok(!(result.sent.status >= 300 && /thanks/.test(result.sent.headers.location ?? '')), 'Not sent on to the thank-you page');
  assert.ok(plain(textOf(result.landed.text)).includes('Add a phone number or email'), `The shopper is told what is missing: ${textOf(result.landed.text).slice(0, 300)}`);
  assert.ok(formOf(result.landed.text), 'The form is shown again');
  assert.ok(result.landed.text.includes('Kutch Crafts'), 'In the seller\'s brand');
  noPlatformName('The error page', result.landed.text);
  noPlatformName('The error headers', result.landed.headers);
  assert.equal((await shop.leadRows()).length, 0);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM lead_consents WHERE tenant_id = $1', [shop.tenantId]))[0].n, 0);
  for (const values of [{ firstName: 'Asha', phone: '   ' }, { firstName: 'Asha', email: ' ' }, { firstName: 'Asha', phone: '', email: '' }]) {
    await submitLead(world, shop, path, values);
    assert.equal((await shop.leadRows()).length, 0);
  }
});

// ---- K-56 ------------------------------------------------------------------------------------------------------------------

test('K-56: with every field filled but the box unticked the form cannot be sent, and nothing is stored', async () => {
  const { shop, path } = await withForm({ name: 'Kutch Crafts' }, { channels: ['whatsapp', 'email'] });
  const form = formOf((await shop.open(path)).text);
  const boxes = form.fields.filter((f) => f.type === 'checkbox');
  assert.ok(boxes.length >= 1, 'The form has a consent box');
  for (const box of boxes) assert.ok(!('checked' in box), 'The box starts unticked');
  assert.ok(boxes.some((b) => 'required' in b), 'The browser won\'t send the form until it is ticked');
  assert.ok(form.text.includes('Kutch Crafts'), 'The wording names the seller');
  assert.match(form.text, /WhatsApp/i);
  assert.match(form.text, /email/i);

  const result = await submitLead(world, shop, path, { firstName: 'Asha', phone: '9876543210', email: 'asha@example.com', consent: false });
  assert.ok(result.sent.status < 500);
  assert.ok(!(result.sent.status >= 300 && /thanks/.test(result.sent.headers.location ?? '')), 'A form without consent is not accepted, even sent by hand');
  assert.doesNotMatch(textOf(result.landed.text), /thank you|thanks for/i);
  assert.equal((await shop.leadRows()).length, 0, 'Nothing stored');
  noPlatformName('The answer', result.landed.text);
  for (const value of ['', '0', 'false', 'off', 'no']) {
    const body = new URLSearchParams(fillLead(form, { firstName: 'Asha', phone: '9876543210', consent: false }));
    for (const box of boxes) body.set(box.name, value);
    const res = await hit(world, form.action, { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone, 'x-forwarded-for': '198.51.100.90' }, body: body.toString() });
    assert.ok(res.status < 500);
  }
  assert.equal((await shop.leadRows()).length, 0, 'A box sent as "false" or "off" is not consent');
});

test('K-56: consent is per channel and against the wording shown: a new wording is a new version, and old leads keep theirs', async () => {
  const { shop, path } = await withForm({}, { channels: ['whatsapp'] });
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'First', phone: '9833300001' })));
  const next = await shop.must('PUT', '/lead-forms/consent', { channels: ['whatsapp', 'sms', 'call'] });
  assert.equal(next.consent.version, 2);
  assert.match(next.consent.body, /SMS/i);
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Second', phone: '9833300002' })));
  const leads = (await shop.must('GET', '/leads')).items.sort((a, b) => a.id - b.id);
  assert.deepEqual(leads.map((l) => l.consentVersion), [1, 2]);
  assert.deepEqual(leads[0].consents.map((c) => c.channel).sort(), ['whatsapp'], 'The first lead agreed to WhatsApp only, and still has only that');
  assert.deepEqual(leads[1].consents.map((c) => c.channel).sort(), ['call', 'sms', 'whatsapp']);
  const texts = await shop.sql('SELECT version, body FROM lead_consent_texts WHERE tenant_id = $1 ORDER BY version', [shop.tenantId]);
  assert.equal(texts.length, 2, 'The old wording is kept, unchanged');
  for (const channels of [[], ['telegram'], ['whatsapp', 'whatsapp', 'sms', 'email', 'call'], 'whatsapp']) assert.equal((await shop.send('PUT', '/lead-forms/consent', { channels })).status, 400, JSON.stringify(channels));
  const changed = await shop.sql(`UPDATE lead_consent_texts SET body = 'I agree to anything at all, forever' WHERE tenant_id = $1 AND version = 1 RETURNING id`, [shop.tenantId]).catch(() => 'refused');
  assert.ok(changed === 'refused' || changed.length === 0, 'A consent wording can\'t be rewritten after the fact');
});

// ---- K-57 ------------------------------------------------------------------------------------------------------------------

test('K-57: the leads XLSX holds only this business\'s leads, and the download is logged', async () => {
  const a = await withForm({ name: 'Shop A' });
  const b = await withForm({ name: 'Shop B' });
  assert.ok(taken(await submitLead(world, a.shop, a.path, { firstName: 'Asha', phone: '9844400001' })));
  assert.ok(taken(await submitLead(world, a.shop, a.path, { firstName: 'Bina', email: 'bina@example.com' })));
  assert.ok(taken(await submitLead(world, b.shop, b.path, { firstName: 'Chetan', phone: '9844400003' })));
  const { download, file, path } = await leadFile(world, a.shop, 'xlsx');
  assert.equal(download.format, 'xlsx');
  assert.equal(download.rowCount, 2);
  assert.equal(file.raw.subarray(0, 2).toString('latin1'), 'PK', 'It is a real XLSX file');
  const rows = await xlsxRows(file.raw);
  const flat = JSON.stringify(rows);
  assert.equal(rows.length, 3, 'A header and this business\'s two leads');
  assert.ok(flat.includes('Asha') && flat.includes('Bina') && flat.includes('+919844400001') && flat.includes('bina@example.com'));
  assert.ok(!flat.includes('Chetan') && !flat.includes('9844400003'), 'None of the other business\'s leads');
  assert.match(String(file.headers['content-disposition'] ?? ''), /attachment/);
  noPlatformName('The file name', String(file.headers['content-disposition'] ?? ''));

  const logged = await a.shop.audit('lead');
  assert.ok(logged.some((r) => /download|export|file/i.test(`${r.action} ${r.target}`)), `The download is in the audit log: ${JSON.stringify(logged.map((r) => r.action))}`);
  assert.ok(logged.every((r) => !JSON.stringify(r.details).includes('9844400001') && !JSON.stringify(r.details).includes('Asha')), 'The audit log holds no lead\'s name or number');
  assert.equal((await b.shop.audit('lead')).filter((r) => /download|export|file/i.test(`${r.action} ${r.target}`)).length, 0, 'Logged for the business that downloaded, not another');

  assert.ok([401, 403, 404].includes((await hit(world, path, { host: a.shop.host })).status), 'Not without signing in');
  assert.equal((await hit(world, path, { host: b.shop.host, token: b.shop.token })).status, 404, 'Not for another business');
  assert.ok([401, 403, 404].includes((await hit(world, path, { host: a.shop.host, token: b.shop.token })).status), 'Not with another business\'s sign-in');
  assert.equal((await b.shop.send('GET', `/lead-downloads/${download.id}`)).status, 404);
  assert.deepEqual((await b.shop.must('GET', '/lead-downloads')).items, []);
  const theirs = await leadFile(world, b.shop, 'xlsx');
  assert.ok(JSON.stringify(await xlsxRows(theirs.file.raw)).includes('Chetan'));
});

test('K-57: names that look like formulas are inert in the XLSX and the CSV, and staff without the right can\'t download', async () => {
  const { shop, path } = await withForm();
  const names = ['=HYPERLINK("http://evil.example","Click")', '+1+1', '-2+3', '@SUM(A1:A9)', '=cmd|\' /C calc\'!A0', 'Asha, "the" first\nline two'];
  for (const [i, firstName] of names.entries()) assert.ok(taken(await submitLead(world, shop, path, { firstName, phone: `98555000${String(10 + i)}` })), `"${firstName}" was refused`);
  const xlsx = await xlsxRows((await leadFile(world, shop, 'xlsx')).file.raw);
  for (const row of xlsx) for (const cell of row) {
    assert.ok(!(cell && typeof cell === 'object' && 'formula' in cell), `A cell is a live formula: ${JSON.stringify(cell)}`);
    assert.ok(!(cell && typeof cell === 'object' && 'hyperlink' in cell), `A cell is a live link: ${JSON.stringify(cell)}`);
  }
  assert.ok(JSON.stringify(xlsx).includes('HYPERLINK'), 'The text is still there, as text');
  const csv = await leadFile(world, shop, 'csv');
  assert.match(csv.file.headers['content-type'], /text\/csv/);
  const cells = csvRows(csv.file.text).flat();
  for (const cell of cells) assert.doesNotMatch(cell, /^[=+@]|^-\d|^\t|^\r/, `A CSV cell starts a formula: ${JSON.stringify(cell.slice(0, 40))}`);
  assert.equal(csvRows(csv.file.text).length, names.length + 1, 'A quoted newline is one row');
  assert.ok(cells.some((c) => c.includes('line two')));
  for (const format of ['pdf', 'xls', '', 'XLSX']) assert.equal((await shop.send('POST', '/lead-downloads', { format })).status, 400, `Format "${format}"`);
  for (const route of ['/leads/export', '/leads.csv', '/leads?format=csv']) {
    const res = await shop.send('GET', route);
    assert.ok(res.status !== 200 || /application\/json/.test(res.headers['content-type'] ?? ''), `${route} hands out a file with no logged download`);
  }
  const staff = { phone: `92${String(Date.now()).slice(-8)}`, password: 'staff-pass-1' };
  await shop.repos.users.create({ name: 'Ravi Staff', ...staff, role: 'staff' });
  const token = await signIn(world, shop, staff);
  const res = await hit(world, '/api/v1/lead-downloads', { host: shop.host, method: 'POST', token, body: { format: 'xlsx' } });
  assert.equal(res.status, 403, `Staff with no permissions downloading leads answered ${res.status}`);
  assert.equal((await hit(world, '/api/v1/leads', { host: shop.host, token })).status, 403);
});

// ---- K-58 ------------------------------------------------------------------------------------------------------------------

test('K-58: a withdrawn consent stops marketing to that contact, and the next download marks the lead as withdrawn', async () => {
  const { shop, path } = await withForm({}, { channels: ['whatsapp', 'email'] });
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Stays', phone: '9866600001' })));
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Leaves', phone: '9866600002', email: 'leaves@example.com' })));
  const leaves = (await shop.must('GET', '/leads')).items.find((l) => l.firstName === 'Leaves');
  const before = await xlsxRows((await leadFile(world, shop, 'xlsx')).file.raw);
  assert.doesNotMatch(JSON.stringify(before.slice(1)), /withdrawn/i, 'Nobody is marked withdrawn yet');

  const revoked = await shop.must('POST', `/leads/${leaves.id}/revoke-consent`, {});
  assert.ok(revoked.consents.length >= 1 && revoked.consents.every((c) => c.withdrawnAt), 'With no channel named, every channel is withdrawn');
  assert.ok((await consents(shop, leaves.id)).every((c) => c.withdrawn_at !== null));
  const active = (await shop.must('GET', '/leads?consent=active')).items.map((l) => l.firstName);
  assert.deepEqual(active, ['Stays'], 'The list of people who may be contacted no longer has them');
  assert.deepEqual((await shop.must('GET', '/leads?consent=withdrawn')).items.map((l) => l.firstName), ['Leaves']);

  const after = await xlsxRows((await leadFile(world, shop, 'xlsx')).file.raw);
  const header = after[0].map((h) => String(h).toLowerCase());
  const rowOf = (name) => after.find((r) => r.includes(name));
  assert.ok(rowOf('Leaves'), 'The lead is still in the file');
  assert.match(JSON.stringify(rowOf('Leaves')) + header.join(','), /withdrawn/i, 'And is marked as withdrawn');
  const marker = header.findIndex((h) => /withdrawn|consent|status/.test(h));
  assert.ok(marker >= 0, `The file has a column for it: ${header.join(', ')}`);
  assert.notDeepEqual(rowOf('Leaves').slice(marker), rowOf('Stays').slice(marker), 'The withdrawn lead reads differently from the one who stayed');
  assert.doesNotMatch(JSON.stringify(rowOf('Stays')), /withdrawn/i);

  const again = await shop.must('POST', `/leads/${leaves.id}/revoke-consent`, {});
  assert.deepEqual(again.consents.map((c) => c.withdrawnAt), revoked.consents.map((c) => c.withdrawnAt), 'Withdrawing twice keeps the first time');
});

test('K-58: one channel can be withdrawn alone; a shopper\'s opt-out door needs their own link; deleting a lead removes its consents', async () => {
  const { shop, path } = await withForm({}, { channels: ['whatsapp', 'email', 'sms'] });
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Partial', phone: '9877700001', email: 'partial@example.com' })));
  const [lead] = (await shop.must('GET', '/leads')).items;
  const partial = await shop.must('POST', `/leads/${lead.id}/revoke-consent`, { channels: ['whatsapp'] });
  assert.deepEqual(partial.consents.filter((c) => c.withdrawnAt).map((c) => c.channel), ['whatsapp'], 'Only WhatsApp is withdrawn');
  assert.deepEqual((await shop.must('GET', '/leads?consent=active')).items.map((l) => l.id), [lead.id], 'They can still be contacted another way');
  for (const body of [{ channels: [] }, { channels: ['telegram'] }, { channels: 'whatsapp' }]) assert.equal((await shop.send('POST', `/leads/${lead.id}/revoke-consent`, body)).status, 400);

  for (const query of ['', `?id=${lead.id}`, `?lead=${lead.id}`, '?token=guess', `?token=${lead.id}`, '?token=%00', `?t=${'a'.repeat(3000)}`, '?token=<script>alert(1)</script>']) {
    const res = await shop.open(`/lead/opt-out${query}`);
    assert.ok(res.status < 500, `/lead/opt-out${query.slice(0, 30)} answered ${res.status}`);
    noPlatformName('The opt-out page', res.text);
    assertNoLiveMarkup(res.text, 'The opt-out page');
    assert.ok(!res.text.includes('9877700001') && !res.text.includes('partial@example.com'), 'The opt-out page shows nobody\'s contact');
  }
  assert.deepEqual((await consents(shop, lead.id)).filter((c) => c.withdrawn_at).map((c) => c.channel), ['whatsapp'], 'A guessed id or token withdraws nothing');

  await shop.must('DELETE', `/leads/${lead.id}`, undefined, 204);
  assert.equal((await shop.leadRows()).length, 0);
  assert.equal((await consents(shop, lead.id)).length, 0, 'Deleting a lead removes its consent records');
  assert.equal((await shop.send('GET', `/leads/${lead.id}`)).status, 404);
  const file = await xlsxRows((await leadFile(world, shop, 'xlsx')).file.raw);
  assert.ok(!JSON.stringify(file).includes('Partial'), 'A deleted lead is in no later file');
});

// ---- K-59 ------------------------------------------------------------------------------------------------------------------

test('K-59: on tier 1 without the add-on the lead form setting is hidden and the form\'s address is the branded 404', async () => {
  const { shop, landing, path } = await withForm({ name: 'Tier One Shop' });
  assert.ok(formOf((await shop.open(path)).text), 'On tier 3 the form is there');
  await setTier(world, shop, 't1');
  const settings = await shop.must('GET', '/lead-forms');
  assert.equal(settings.available, false, 'The setting is hidden');
  for (const [method, route, body] of [['PATCH', '/lead-forms', { surface: 'landing', enabled: true }], ['PUT', '/lead-forms/consent', { channels: ['whatsapp'] }]]) {
    const res = await shop.send(method, route, body);
    assert.ok([403, 404].includes(res.status), `${method} ${route} without the add-on answered ${res.status}`);
  }
  const page = await shop.open(path);
  assert.equal(page.status, 200, 'The landing page itself still opens');
  assert.equal(formOf(page.text), null, 'With no form on it');

  const before = (await shop.leadRows()).length;
  const body = new URLSearchParams({ first_name: 'Asha', firstName: 'Asha', name: 'Asha', phone: '9876543210', consent: 'on', agree: 'on', page: landing.slug, slug: landing.slug, source: 'landing' }).toString();
  const post = await hit(world, '/lead', { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone }, body });
  assertBranded404(post, shop, 'POST /lead without the add-on');
  for (const direct of ['/lead', '/lead/thanks', '/lead/opt-out', `/lead?page=${landing.slug}`]) assertBranded404(await shop.open(direct), shop, `GET ${direct} without the add-on`);
  assert.equal((await shop.leadRows()).length, before, 'Nothing is stored');

  await setFeature(shop, 'lead_form', true);
  assert.equal((await shop.must('GET', '/lead-forms')).available, true, 'With the add-on the setting is back');
  assert.ok(formOf((await shop.open(path)).text), 'And so is the form');
  assert.ok(taken(await submitLead(world, shop, path, { firstName: 'Asha', phone: '9876543210' })), 'And it takes a lead');
  await setFeature(shop, 'lead_form', false);
  assertBranded404(await shop.open('/lead/thanks'), shop, 'With the add-on taken away again');
});

test('K-59: with the plan but the form switched off for a page, that page has no form and takes no lead', async () => {
  const shop = await addP3Shop(world);
  const withFormPage = await shop.page({ headline: 'With form' });
  const without = await shop.page({ headline: 'Without form', leadForm: false });
  await leadFormOn(shop, 'landing');
  assert.ok(formOf((await shop.open(`/r/${withFormPage.slug}`)).text));
  assert.equal(formOf((await shop.open(`/r/${without.slug}`)).text), null, 'The owner turns the form on per page');
  const form = formOf((await shop.open(`/r/${withFormPage.slug}`)).text);
  const body = new URLSearchParams(fillLead(form, { firstName: 'Sneaky', phone: '9888800001' }));
  for (const key of [...body.keys()]) if (body.get(key) === withFormPage.slug) body.set(key, without.slug);
  for (const key of [...body.keys()]) if (body.get(key) === String(withFormPage.id)) body.set(key, String(without.id));
  const res = await hit(world, form.action, { host: shop.host, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA.phone, 'x-forwarded-for': '198.51.100.61' }, body: body.toString() });
  assert.ok(res.status < 500);
  const rows = await shop.leadRows();
  assert.ok(rows.every((r) => r.page_id !== without.id), 'No lead is recorded against a page whose form is off');
  await shop.must('PATCH', '/lead-forms', { surface: 'landing', enabled: false });
  assert.equal(formOf((await shop.open(`/r/${withFormPage.slug}`)).text), null, 'Switched off for landing pages, it is gone from all of them');
  const creator = await creatorPage(shop);
  assert.equal(formOf((await shop.open(`/${creator.slug}`)).text), null, 'It was never on for the creator page');
});
