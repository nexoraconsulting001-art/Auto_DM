// PRD 8.15: the lead form, its consent, its spam controls, the seller's list and file, withdrawal and deletion.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { sweepFiles } from '../../../src/modules/leads/index.js';
import { MAX_NEW_PER_HOUR } from '../../../src/modules/leads/repo.js';
import { checkLead, cleanFirstName, consentBody, fieldsFor, normalizeEmail, normalizePhone, optOutToken, readOptOutToken, safeBack } from '../../../src/modules/leads/rules.js';
import { setLogSink } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { BROWSER, addPage, addTeamMember, secondBusiness, setPlan, startWorld } from './support.js';

const ExcelJS = createRequire(import.meta.url)('exceljs');

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

/** Switches a surface's form on. */
async function formOn(business, surface = 'landing', extra = {}) {
  const res = await business.api('/lead-forms', { method: 'PATCH', body: { surface, enabled: true, ...extra } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const FILLED = { firstName: 'Asha', phone: '98765 43210', consent: 'yes', cv: '1', surface: 'landing' };
const send = (business, form, options = {}) => business.page('/lead', { method: 'POST', form: { ...FILLED, ...form }, ...options });
const leadsOf = (w, business = w) => w.db.platform.query('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY id', [business.tenant.id]);
const consentsOf = (w, leadId) => w.db.platform.query('SELECT channel, withdrawn_at FROM lead_consents WHERE lead_id = $1 ORDER BY channel', [leadId]);
const optOutLink = (text) => /href="(\/lead\/opt-out\?t=[\w.-]+)"/.exec(text)?.[1] ?? null;

test('a phone number is stored in international format, an email is checked, and a name is a name', () => {
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 (98765) 43210'), '+919876543210');
  assert.equal(normalizePhone('0044 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('+1 415-555-2671'), '+14155552671');
  for (const bad of ['12345', '5876543210', 'call me', '+0123456789', '98765432101234567890', '<script>', '']) assert.equal(normalizePhone(bad), null, bad);
  assert.equal(normalizeEmail(' Asha@Example.COM '), 'asha@example.com');
  for (const bad of ['asha', 'a@b', 'a b@c.in', 'a@@b.in', 'a..b@c.in', `${'a'.repeat(250)}@b.in`, '"><img>@x.in']) assert.equal(normalizeEmail(bad), null, bad);
  assert.equal(cleanFirstName('  Asha  ').value, 'Asha');
  assert.equal(cleanFirstName('आशा').error, '');
  assert.equal(cleanFirstName('').error, 'Add your first name');
  assert.notEqual(cleanFirstName('<b>Asha</b>').error, '');
  assert.notEqual(cleanFirstName('http://spam.example').error, '');
  assert.notEqual(cleanFirstName('A'.repeat(61)).error, '');

  assert.equal(consentBody('Zari & Co', ['email', 'whatsapp']), 'I agree that Zari & Co may contact me about offers by WhatsApp or email.');
  assert.equal(consentBody('Zari', ['whatsapp', 'sms', 'email', 'call']), 'I agree that Zari may contact me about offers by WhatsApp, SMS, email or phone call.');
  assert.deepEqual(fieldsFor(['email']), { phone: false, email: true }, 'the form asks only for what its wording covers');
  assert.deepEqual(fieldsFor(['whatsapp', 'call']), { phone: true, email: false });

  const ok = checkLead({ firstName: 'Asha', phone: '9876543210', email: '', consent: 'yes' }, ['whatsapp', 'email']);
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.lead, { firstName: 'Asha', phone: '+919876543210', email: '', channels: ['whatsapp'] }, 'a phone alone never grants email');
  assert.equal(checkLead({ firstName: 'Asha', consent: 'yes' }, ['whatsapp', 'email']).errors.contact, 'Add a phone number or email');
  assert.ok(checkLead({ firstName: 'Asha', phone: '9876543210' }, ['whatsapp']).errors.consent);
  for (const notTicked of ['', 'no', '0', 'false', ['yes'], undefined, null]) assert.ok(checkLead({ firstName: 'Asha', phone: '9876543210', consent: notTicked }, ['whatsapp']).errors.consent, String(notTicked));
  // A phone typed into a form whose wording has no phone channel is not kept.
  assert.equal(checkLead({ firstName: 'Asha', phone: '9876543210', email: 'a@b.in', consent: 'yes' }, ['email']).lead.phone, '');

  const token = optOutToken('secret-one', 7, 42);
  assert.equal(readOptOutToken('secret-one', 7, token), 42);
  assert.equal(readOptOutToken('secret-one', 8, token), null, 'a link is for one business');
  assert.equal(readOptOutToken('secret-two', 7, token), null);
  assert.throws(() => optOutToken('', 7, 42), /session secret/, 'no link is made without a secret');
  assert.equal(readOptOutToken('secret-one', 7, token.replace('42.', '43.')), null);
  for (const bad of ['', '42', '42.', null, ['x'], `42.${'a'.repeat(31)}`]) assert.equal(readOptOutToken('secret-one', 7, bad), null);
  assert.equal(safeBack('/r/steel-bottle'), '/r/steel-bottle');
  assert.equal(safeBack('/priya/kitchen'), '/priya/kitchen');
  for (const bad of ['//evil.example', 'https://evil.example', '/r/../admin', '/a/b/c', 'javascript:alert(1)', ['/x']]) assert.equal(safeBack(bad), '', String(bad));
});

test('K-59: without the feature the setting is hidden, changes are refused and the form’s address is the branded 404', async (t) => {
  const w = await world(t, { plan: 't1' });
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  assert.deepEqual((await w.api('/lead-forms')).body, { available: false, consent: null, items: [] });
  const refused = await w.api('/lead-forms', { method: 'PATCH', body: { surface: 'landing', enabled: true } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'plan.not_included');
  assert.equal((await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['email'] } })).status, 403);

  for (const res of [await w.page('/lead'), await send(w, {}), await w.page('/lead/thanks')]) {
    assert.equal(res.status, 404);
    assert.match(res.text, /Zari &amp; Co/);
    assert.doesNotMatch(res.text, /bhava/i);
  }
  assert.equal((await leadsOf(w)).length, 0);

  // The add-on is a row for this business: with it the form works on tier 1.
  await withTenant(w.tenant, () => w.repos.entitlements.setOverride('lead_form', { enabled: true }));
  const on = await formOn(w);
  assert.equal(on.available, true);
  assert.deepEqual(on.items.map((i) => [i.surface, i.enabled]), [['landing', true], ['creator', false], ['store', false]]);
  assert.equal((await w.page('/lead')).status, 200);
  assert.equal((await send(w, {})).status, 200);
  assert.equal((await leadsOf(w)).length, 1);
  // Taking it away closes the form, and the leads already held can still be read and deleted.
  await withTenant(w.tenant, () => w.repos.entitlements.clearOverride('lead_form'));
  assert.equal((await send(w, { phone: '9876500000' })).status, 404);
  assert.equal((await w.api('/leads')).body.items.length, 1);
});

test('K-54: a first name, a phone and the ticked box save a lead with its source and consent; the thank-you page is the seller’s', async (t) => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
  const w = await world(t);
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  const reel = await addPage(w, { headline: 'Steel bottle' });
  const settings = await formOn(w, 'landing', { offerLine: 'Get 10% off your first order' });
  assert.deepEqual(settings.consent, { version: 1, body: 'I agree that Zari & Co may contact me about offers by WhatsApp or email.', channels: ['whatsapp', 'email'] });

  const form = await w.page(`/lead?r=${reel.slug}&utm_campaign=diwali`, { headers: BROWSER });
  assert.equal(form.status, 200);
  assert.match(form.text, /I agree that Zari &amp; Co may contact me about offers by WhatsApp or email\./);
  assert.match(form.text, /Get 10% off your first order/);
  assert.match(form.text, /<input type="checkbox" id="lead-consent" name="consent" value="yes" required>/, 'the box is there, required, and not ticked');
  assert.doesNotMatch(form.text, /checked/);
  assert.match(form.text, new RegExp(`name="ref" value="${reel.slug}"`));
  assert.match(form.text, /name="utm_campaign" value="diwali"/);
  assert.doesNotMatch(form.text, /bhava/i);
  assert.doesNotMatch(form.text, /captcha/i);
  // Only what the form needs: a name, the contacts its wording covers, and nothing else a person fills in.
  const asked = [...form.text.matchAll(/<input type="(text|tel|email|checkbox)"[^>]* name="([\w_]+)"/g)].map((m) => m[2]);
  assert.deepEqual(asked, ['firstName', 'phone', 'email', 'company_website', 'consent']);

  const done = await send(w, { ref: reel.slug, utm_campaign: 'diwali', back: `/r/${reel.slug}` });
  assert.equal(done.status, 200);
  assert.match(done.text, /<h1>Thank you<\/h1>/);
  assert.match(done.text, /Zari &amp; Co has your details/);
  assert.match(done.text, new RegExp(`<a class="btn" href="/r/${reel.slug}">Back</a>`));
  assert.doesNotMatch(done.text, /bhava/i);
  assert.doesNotMatch(JSON.stringify(done.headers), /bhava/i);
  assert.doesNotMatch(done.text, /Asha|98765/, 'the page does not repeat what was sent');
  assert.ok(optOutLink(done.text), 'with the way to withdraw');

  const [lead] = await leadsOf(w);
  assert.deepEqual(
    { first_name: lead.first_name, phone: lead.phone, email: lead.email, source: lead.source, source_ref: lead.source_ref, utm_campaign: lead.utm_campaign, page_id: lead.page_id },
    { first_name: 'Asha', phone: '+919876543210', email: '', source: 'landing', source_ref: reel.slug, utm_campaign: 'diwali', page_id: reel.id },
  );
  assert.deepEqual(Object.keys(lead).sort(), ['consent_text_id', 'consented_at', 'created_at', 'email', 'first_name', 'id', 'page_id', 'phone', 'source', 'source_ref', 'tenant_id', 'utm_campaign'], 'nothing else is collected');
  assert.deepEqual((await consentsOf(w, lead.id)).map((c) => c.channel), ['whatsapp'], 'consent for the channel the phone reaches, not for email');

  const listed = (await w.api('/leads')).body.items[0];
  assert.equal(listed.consentVersion, 1);
  assert.equal(listed.phone, '+919876543210');
  assert.deepEqual(listed.consents.map((c) => [c.channel, c.withdrawnAt]), [['whatsapp', null]]);
  assert.equal((await w.api(`/leads/${lead.id}`)).body.firstName, 'Asha');

  // The owner is told in the platform's words, with nothing about the shopper; logs carry ids only.
  const alerts = await w.db.platform.query(`SELECT message, kind FROM alerts WHERE tenant_id = $1 AND kind = 'lead.new'`, [w.tenant.id]);
  assert.equal(alerts.length, 1);
  assert.doesNotMatch(alerts[0].message, /Asha|98765/);
  assert.ok(lines.some((l) => l.includes('leads.captured')));
  assert.doesNotMatch(lines.join('\n'), /Asha|9876543210/);
});

test('K-55, K-56: a first name alone, or an unticked box, is refused and nothing is stored', async (t) => {
  const w = await world(t);
  await formOn(w);
  const nameOnly = await send(w, { phone: '' });
  assert.equal(nameOnly.status, 422);
  assert.match(nameOnly.text, /Add a phone number or email/);
  assert.match(nameOnly.text, /name="firstName" value="Asha"/, 'what was typed is kept');

  const unticked = await send(w, { consent: '' });
  assert.equal(unticked.status, 422);
  assert.match(unticked.text, /Tick the box to agree before sending/);
  assert.doesNotMatch(unticked.text, /checked/, 'the box is never ticked for the shopper');
  const { consent: _left, ...noBox } = FILLED;
  assert.equal((await w.page('/lead', { method: 'POST', form: noBox })).status, 422);
  assert.equal((await send(w, { consent: 'false' })).status, 422);

  for (const [fields, message] of [
    [{ phone: '12345' }, /Check the phone number/],
    [{ phone: '', email: 'not-an-email' }, /Check the email address/],
    [{ firstName: '' }, /Add your first name/],
    [{ firstName: '<script>alert(1)</script>' }, /Use letters only/],
  ]) {
    const res = await send(w, fields);
    assert.equal(res.status, 422);
    assert.match(res.text, message);
    assert.doesNotMatch(res.text, /<script>alert/);
    assert.doesNotMatch(res.text, /bhava/i);
  }
  // A body that isn't a form at all is refused the same way.
  assert.equal((await w.page('/lead', { method: 'POST', body: { firstName: { $ne: '' }, phone: ['1', '2'], consent: ['yes'] } })).status, 422);
  assert.equal((await leadsOf(w)).length, 0);
});

test('spam: the hidden field, a limit per address, and the same contact again never floods the list', async (t) => {
  const w = await world(t, { overrides: { leadsPerAddress: 6 } });
  await formOn(w);

  // A script fills the field no person sees: it gets the thank-you page and nothing is kept.
  const trapped = await send(w, { company_website: 'https://spam.example' });
  assert.equal(trapped.status, 200);
  assert.match(trapped.text, /Thank you/);
  assert.equal(optOutLink(trapped.text), null);
  assert.equal((await leadsOf(w)).length, 0);

  // The same phone five times is one lead, however it is typed; the same email is too.
  for (const phone of ['9876543210', '09876543210', '+91 98765 43210', '98765-43210', '9876543210']) assert.equal((await send(w, { phone })).status, 200);
  let all = await leadsOf(w);
  assert.equal(all.length, 1);
  assert.equal(all[0].phone, '+919876543210');

  // The sixth send from this address in ten minutes passes; the seventh is asked to wait, in the seller's brand.
  assert.equal((await send(w, { phone: '9876500001' })).status, 200);
  const limited = await send(w, { phone: '9876500002' });
  assert.equal(limited.status, 429);
  assert.match(limited.text, /Please try again later/);
  assert.doesNotMatch(limited.text, /bhava/i);
  assert.equal((await leadsOf(w)).length, 2);
  // Another address is not held back by the first (the proxy in front names the shopper's address).
  const elsewhere = await send(w, { phone: '9876500003' }, { headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(elsewhere.status, 200);
  // The address itself is nowhere in the database.
  const dump = JSON.stringify(await w.db.platform.query('SELECT * FROM leads'));
  assert.doesNotMatch(dump, /127\.0\.0\.1|203\.0\.113\.9/);

  // A flood from many addresses stops at the business's hourly ceiling.
  await w.db.platform.query(
    `INSERT INTO leads (tenant_id, first_name, phone, source, consent_text_id)
     SELECT $1, 'Filler', '+9170000' || lpad(n::text, 5, '0'), 'landing', (SELECT id FROM lead_consent_texts WHERE tenant_id = $1 LIMIT 1) FROM generate_series(1, $2::int) n`,
    [w.tenant.id, MAX_NEW_PER_HOUR],
  );
  const full = await send(w, { phone: '9876500004' }, { headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.equal(full.status, 429);
  // Someone already on the list can still send again: no new row is needed.
  assert.equal((await send(w, { phone: '9876500003' }, { headers: { 'x-forwarded-for': '203.0.113.11' } })).status, 200);
  all = await leadsOf(w);
  assert.equal(all.length, MAX_NEW_PER_HOUR + 3);
});

test('two sends of one contact at the same moment make one lead', async (t) => {
  const w = await world(t);
  await formOn(w);
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => send(w, { phone: '9876511111' }, { headers: { 'x-forwarded-for': `203.0.113.${20 + i}` } })));
  assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200, 200]);
  assert.equal((await leadsOf(w)).length, 1);
});

test('consent wordings are numbered and never changed; a lead keeps the one its shopper saw', async (t) => {
  const w = await world(t);
  await w.repos.settings.update({ store_name: 'Zari' });
  await formOn(w);
  assert.equal((await send(w, { phone: '9876500001' })).status, 200);

  const changed = await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['email'] } });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.consent, { version: 2, body: 'I agree that Zari may contact me about offers by email.', channels: ['email'] });
  assert.equal((await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: [] } })).status, 400);
  assert.equal((await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['fax'] } })).status, 400);

  // The form now asks for an email only.
  const form = await w.page('/lead');
  assert.match(form.text, /name="email"/);
  assert.doesNotMatch(form.text, /name="phone"/);
  assert.match(form.text, /name="cv" value="2"/);
  assert.equal((await send(w, { cv: '2', phone: '', email: 'Asha@Example.com' })).status, 200);
  // A shopper who still had the first wording open agreed to that one.
  assert.equal((await send(w, { cv: '1', phone: '9876500003' })).status, 200);
  // A version that was never this business's falls back to today's wording, which needs an email.
  assert.equal((await send(w, { cv: '99', phone: '9876500004' })).status, 422);

  const versions = (await w.api('/leads')).body.items.map((l) => [l.phone || l.email, l.consentVersion, l.consents.map((c) => c.channel)]).reverse();
  assert.deepEqual(versions, [['+919876500001', 1, ['whatsapp']], ['asha@example.com', 2, ['email']], ['+919876500003', 1, ['whatsapp']]]);
  const texts = await w.db.platform.query('SELECT version, body FROM lead_consent_texts WHERE tenant_id = $1 ORDER BY version', [w.tenant.id]);
  assert.deepEqual(texts.map((r) => r.version), [1, 2]);
  assert.match(texts[0].body, /WhatsApp or email/, 'the first wording is as it was');

  // The business renames itself: the next form shows a new version that names it, and the old ones stay.
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  assert.match((await w.page('/lead')).text, /I agree that Zari &amp; Co may contact me about offers by email\./);
  assert.equal((await w.api('/lead-forms')).body.consent.version, 3);
  // The wording table takes no change or removal from the app's role.
  await assert.rejects(withTenant(w.tenant, () => w.db.query(`UPDATE lead_consent_texts SET body = 'I agree to anything at all.' WHERE tenant_id = $1`, [w.tenant.id])), /permission denied/);
});

test('K-58: a shopper withdraws or erases through their own link, and the seller can record a withdrawal', async (t) => {
  const w = await world(t);
  const leaf = await secondBusiness(w);
  await formOn(w);
  await formOn(leaf);
  await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['whatsapp', 'sms', 'email'] } });
  const sent = await send(w, { cv: '2', email: 'asha@example.com' });
  const link = optOutLink(sent.text);
  const [lead] = await leadsOf(w);
  assert.deepEqual((await consentsOf(w, lead.id)).map((c) => c.channel), ['email', 'sms', 'whatsapp']);

  // Opening the link changes nothing (a mail scanner follows links); it offers both choices in the seller's brand.
  const door = await w.page(link);
  assert.equal(door.status, 200);
  assert.match(door.text, /Stop contacting me/);
  assert.match(door.text, /Delete my details/);
  assert.doesNotMatch(door.text, /bhava/i);
  assert.doesNotMatch(door.text, /asha@example|98765/, 'the door shows no contact');
  assert.equal(door.headers['referrer-policy'], 'no-referrer');
  assert.ok((await consentsOf(w, lead.id)).every((c) => c.withdrawn_at === null));

  // The seller records a withdrawal of one channel sent some other way.
  const one = await w.api(`/leads/${lead.id}/revoke-consent`, { method: 'POST', body: { channels: ['sms'] } });
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.consents.map((c) => [c.channel, c.withdrawnAt !== null]), [['whatsapp', false], ['sms', true], ['email', false]]);
  assert.equal((await w.api('/leads?consent=withdrawn')).body.items.length, 1);
  assert.equal((await w.api('/leads?consent=active')).body.items.length, 1);

  // A link made for this business does nothing at another's address, and a made-up one is the branded 404.
  const token = new URLSearchParams(link.split('?')[1]).get('t');
  assert.equal((await leaf.page(link)).status, 404);
  assert.equal((await leaf.page('/lead/opt-out', { method: 'POST', form: { t: token, action: 'delete' } })).status, 404);
  assert.equal((await w.page('/lead/opt-out?t=1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  assert.equal((await w.page('/lead/opt-out', { method: 'POST', form: { t: `${lead.id + 1}.${token.split('.')[1]}`, action: 'delete' } })).status, 404);
  assert.equal((await leadsOf(w)).length, 1);

  // The shopper withdraws: every channel is marked, and none is used again.
  const stopped = await w.page('/lead/opt-out', { method: 'POST', form: { t: token, action: 'withdraw' } });
  assert.equal(stopped.status, 200);
  assert.match(stopped.text, /won’t contact you about offers any more/);
  assert.ok((await consentsOf(w, lead.id)).every((c) => c.withdrawn_at !== null));
  assert.equal((await w.api('/leads?consent=active')).body.items.length, 0);

  // The next file says so.
  const download = (await w.api('/lead-downloads', { method: 'POST', body: { format: 'csv' } })).body;
  const csv = (await w.page(download.fileUrl, { headers: { authorization: `Bearer ${w.token}` } })).text;
  const row = csv.split('\r\n')[1];
  assert.match(row, /^Asha,\+919876543210,asha@example\.com,/);
  assert.match(row, /Withdrawn \d{4}-\d{2}-\d{2},Withdrawn \d{4}-\d{2}-\d{2},Withdrawn \d{4}-\d{2}-\d{2},,"Yes, all"/);

  // Ticking the box again later is fresh consent, for the channels that contact reaches.
  assert.equal((await send(w, { cv: '2', phone: '9876543210', email: '' })).status, 200);
  assert.deepEqual((await consentsOf(w, lead.id)).map((c) => [c.channel, c.withdrawn_at === null]), [['email', false], ['sms', true], ['whatsapp', true]]);
  assert.equal((await leadsOf(w)).length, 1);

  // Deletion on request: the lead and its consent records go, from the shopper's link or by the seller.
  const erased = await w.page('/lead/opt-out', { method: 'POST', form: { t: token, action: 'delete' } });
  assert.equal(erased.status, 200);
  assert.match(erased.text, /no longer holds the details you sent/);
  assert.equal((await leadsOf(w)).length, 0);
  assert.equal((await consentsOf(w, lead.id)).length, 0);
  assert.equal((await w.page('/lead/opt-out', { method: 'POST', form: { t: token, action: 'delete' } })).status, 200, 'asking again gets the same answer');

  await send(w, { cv: '2', phone: '9876500009' });
  const [again] = await leadsOf(w);
  assert.equal((await w.api(`/leads/${again.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await w.api(`/leads/${again.id}`)).status, 404);
  assert.equal((await w.api(`/leads/${again.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await leadsOf(w)).length, 0);

  const audit = await w.db.platform.query(`SELECT actor, action, details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'lead.%' ORDER BY id`, [w.tenant.id]);
  assert.deepEqual(audit.map((a) => [a.actor.split(':')[0], a.action]), [['user', 'lead.consent_withdrawn'], ['shopper', 'lead.consent_withdrawn'], ['shopper', 'lead.deleted'], ['user', 'lead.deleted']]);
  assert.doesNotMatch(JSON.stringify(audit), /Asha|asha@|98765/, 'the audit log holds ids, never the contact');
});

test('K-57: the file holds only this business’s leads, is made inert for spreadsheets, and every download is logged', async (t) => {
  const w = await world(t);
  const leaf = await secondBusiness(w);
  await formOn(w);
  await formOn(leaf);
  await send(w, { firstName: 'Asha', phone: '9876500001', utm_campaign: '=HYPERLINK("http://evil.example")' });
  await send(w, { firstName: 'Ravi', phone: '', email: 'ravi@example.com', utm_campaign: 'diwali' });
  await send(leaf, { firstName: 'Meena', phone: '9876500002' });

  const made = await w.api('/lead-downloads', { method: 'POST', body: {} });
  assert.equal(made.status, 201);
  assert.deepEqual({ format: made.body.format, status: made.body.status, rowCount: made.body.rowCount }, { format: 'xlsx', status: 'ready', rowCount: 2 });
  assert.match(made.body.fileUrl, /^\/leads\/files\/\d+$/);
  assert.doesNotMatch(made.body.fileUrl, /export|raw/);

  const file = await w.page(made.body.fileUrl, { headers: { authorization: `Bearer ${w.token}` } });
  assert.equal(file.status, 200);
  assert.match(file.headers['content-disposition'], /^attachment; filename="leads-\d+\.xlsx"$/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(file.buffer);
  const rows = [];
  book.worksheets[0].eachRow((row) => rows.push(row.values.slice(1)));
  assert.deepEqual(rows[0].slice(0, 6), ['First name', 'Phone', 'Email', 'Source', 'Page', 'Campaign']);
  assert.deepEqual(rows.slice(1).map((r) => r[0]), ['Asha', 'Ravi']);
  assert.equal(rows[1][1], '+919876500001');
  assert.equal(rows[1][5], `'=HYPERLINK(http://evil.example)`, 'a cell that would run is made text');
  assert.doesNotMatch(JSON.stringify(rows), /Meena|9876500002/);
  for (const row of rows) for (const cell of row) assert.ok(cell === undefined || typeof cell !== 'object', 'no formula cells');
  assert.equal(book.creator ?? '', '', 'the file names no maker');

  const csv = (await w.api('/lead-downloads', { method: 'POST', body: { format: 'csv' } })).body;
  const text = (await w.page(csv.fileUrl, { headers: { authorization: `Bearer ${w.token}` } })).text;
  assert.equal(text.split('\r\n').length, 4);
  assert.doesNotMatch(text, /Meena|bhava/i);
  assert.match(text, /Yes,,,,No,1,/);

  // The other business's file has its own lead only, and neither can open the other's.
  const theirs = (await leaf.api('/lead-downloads', { method: 'POST', body: { format: 'csv' } })).body;
  assert.equal(theirs.rowCount, 1);
  const theirText = (await leaf.page(theirs.fileUrl, { headers: { authorization: `Bearer ${leaf.token}` } })).text;
  assert.match(theirText, /Meena/);
  assert.doesNotMatch(theirText, /Asha|Ravi/);
  // Ids are per table, so make one that exists only for the other business.
  const extra = (await leaf.api('/lead-downloads', { method: 'POST', body: { format: 'csv' } })).body;
  const more = (await leaf.api('/lead-downloads', { method: 'POST', body: { format: 'csv' } })).body;
  for (const id of [extra.id, more.id]) {
    assert.equal((await w.page(`/leads/files/${id}`, { headers: { authorization: `Bearer ${w.token}` } })).status, 404);
    assert.equal((await w.api(`/lead-downloads/${id}`)).status, 404);
  }
  assert.deepEqual((await w.api('/lead-downloads')).body.items.map((d) => d.id), [csv.id, made.body.id]);

  // Signed out, or without the right, there is no file.
  assert.equal((await w.page(made.body.fileUrl)).status, 401);
  const staff = await addTeamMember(w, w, { permissions: ['customers'] });
  assert.equal((await w.page(made.body.fileUrl, { headers: { authorization: `Bearer ${staff.token}` } })).status, 403);
  assert.equal((await staff.api('/lead-downloads', { method: 'POST', body: {} })).status, 403);
  assert.equal((await staff.api('/leads')).status, 200, 'staff with the customers right read the list');
  assert.equal((await staff.api(`/leads/1`, { method: 'DELETE' })).status, 403);
  const noRight = await addTeamMember(w, w, { permissions: ['catalog'] });
  assert.equal((await noRight.api('/leads')).status, 403);
  assert.equal((await w.page('/leads/files/abc', { headers: { authorization: `Bearer ${w.token}` } })).status, 404);

  // Each download and each opening is in the audit log, with counts and no contact.
  const audit = await w.db.platform.query(`SELECT action, details FROM audit_log WHERE tenant_id = $1 AND action LIKE 'leads.%' ORDER BY id`, [w.tenant.id]);
  assert.deepEqual(audit.map((a) => a.action), ['leads.downloaded', 'leads.file_opened', 'leads.downloaded', 'leads.file_opened']);
  assert.deepEqual(audit[0].details, { format: 'xlsx', rows: 2 });
  assert.doesNotMatch(JSON.stringify(audit), /Asha|ravi@|98765/);

  // A file past its time is gone: the row says expired and the sweep removes it.
  await w.db.platform.query(`UPDATE lead_downloads SET expires_at = now() - interval '1 minute' WHERE id = $1`, [made.body.id]);
  assert.equal((await w.api(`/lead-downloads/${made.body.id}`)).body.status, 'expired');
  assert.equal((await w.api(`/lead-downloads/${made.body.id}`)).body.fileUrl, null);
  assert.equal((await w.page(made.body.fileUrl, { headers: { authorization: `Bearer ${w.token}` } })).status, 410);
  await w.db.platform.query(`UPDATE lead_downloads SET expires_at = now() - interval '1 minute' WHERE id = $1`, [csv.id]);
  assert.equal(await sweepFiles({ db: w.db, repos: w.platform, platform: { storage: { remove: async () => {} } } }), 1);
  const [swept] = await w.db.platform.query('SELECT status, file_key FROM lead_downloads WHERE id = $1', [csv.id]);
  assert.deepEqual(swept, { status: 'expired', file_key: '' });
});

test('one business never sees, changes or receives another’s leads', async (t) => {
  const w = await world(t);
  const leaf = await secondBusiness(w);
  await formOn(w);
  await formOn(leaf);
  // The same person leaves the same number with both shops: two leads, one each.
  await send(w, { phone: '9876543210' });
  await send(leaf, { firstName: 'Asha', phone: '9876543210' });
  const [mine] = await leadsOf(w);
  const [theirs] = await leadsOf(w, leaf);
  assert.notEqual(mine.id, theirs.id);

  assert.deepEqual((await w.api('/leads')).body.items.map((l) => l.id), [mine.id]);
  assert.deepEqual((await leaf.api('/leads')).body.items.map((l) => l.id), [theirs.id]);
  for (const [method, path, body] of [['GET', `/leads/${theirs.id}`], ['DELETE', `/leads/${theirs.id}`], ['POST', `/leads/${theirs.id}/revoke-consent`, {}]]) {
    assert.equal((await w.api(path, { method, body })).status, 404, `${method} ${path}`);
  }
  assert.equal((await leadsOf(w, leaf)).length, 1);
  assert.ok((await consentsOf(w, theirs.id)).every((c) => c.withdrawn_at === null));

  // A form sent to one shop naming the other's page keeps nothing of the other's.
  const theirReel = await addPage(leaf, { headline: 'Their reel' });
  await send(w, { phone: '9876500005', ref: theirReel.slug });
  const last = (await leadsOf(w)).at(-1);
  assert.deepEqual({ source_ref: last.source_ref, page_id: last.page_id }, { source_ref: '', page_id: null });

  // Each shop's settings and wording are its own.
  await leaf.repos.settings.update({ store_name: 'Leaf and Clay' });
  await w.api('/lead-forms/consent', { method: 'PUT', body: { channels: ['call'] } });
  assert.equal((await leaf.api('/lead-forms')).body.consent.version, 1);
  assert.match((await leaf.page('/lead')).text, /I agree that Leaf and Clay may contact me/);

  // Under the app's own role, a query that forgets its WHERE still sees one business.
  const seen = await withTenant(w.tenant, () => w.db.query('SELECT tenant_id FROM leads'));
  assert.ok(seen.length > 0 && seen.every((r) => r.tenant_id === w.tenant.id));
  await assert.rejects(withTenant(w.tenant, () => w.db.query('INSERT INTO leads (tenant_id, first_name, phone, source, consent_text_id) VALUES ($1, $2, $3, $4, $5)', [leaf.tenant.id, 'X', '+919876500099', 'landing', theirs.consent_text_id])));
});

test('the form sits on the creator page and on a landing page as each is switched on', async (t) => {
  const w = await world(t);
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  const reel = await addPage(w, { headline: 'Steel bottle' });
  assert.equal((await w.api('/creator-page', { method: 'PATCH', body: { slug: 'zari', enabled: true } })).status, 200);
  assert.doesNotMatch((await w.page('/zari')).text, /action="\/lead"/, 'off until the owner turns it on');
  await formOn(w, 'creator', { offerLine: 'Early access to new drops' });
  const page = await w.page('/zari?utm_campaign=bio-oct');
  assert.match(page.text, /<form class="form" method="post" action="\/lead"/);
  assert.match(page.text, /Early access to new drops/);
  assert.match(page.text, /name="surface" value="creator"/);
  assert.match(page.text, /name="ref" value="zari"/);

  // The creator page's form is on; the landing one is not, so a send that claims to be from a landing page is the 404.
  assert.equal((await send(w, { surface: 'landing' })).status, 404);
  const done = await send(w, { surface: 'creator', ref: 'zari', back: '/zari', utm_campaign: 'bio-oct' });
  assert.equal(done.status, 200);
  assert.match(done.text, /<a class="btn" href="\/zari">Back<\/a>/);
  const [lead] = await leadsOf(w);
  assert.deepEqual({ source: lead.source, source_ref: lead.source_ref, utm_campaign: lead.utm_campaign, page_id: lead.page_id }, { source: 'creator', source_ref: 'zari', utm_campaign: 'bio-oct', page_id: null });
  assert.equal((await w.api('/leads?source=creator')).body.items.length, 1);
  assert.equal((await w.api('/leads?source=landing')).body.items.length, 0);

  // One landing page can carry the form on its own, and another can refuse it.
  await w.db.platform.query('UPDATE reels SET lead_form = true WHERE id = $1', [reel.id]);
  assert.equal((await w.page(`/lead?r=${reel.slug}`)).status, 200);
  assert.equal((await w.page('/lead')).status, 404);
  const fromBio = await send(w, { surface: 'landing', ref: reel.slug, phone: '9876500007', utm_medium: 'bio' });
  assert.equal(fromBio.status, 200);
  assert.equal((await leadsOf(w)).at(-1).source, 'bio', 'a landing page reached from the bio link');
  await formOn(w, 'landing');
  await w.db.platform.query('UPDATE reels SET lead_form = false WHERE id = $1', [reel.id]);
  assert.equal((await w.page(`/lead?r=${reel.slug}`)).status, 404);
  assert.equal((await w.page('/lead')).status, 200);

  // Lists page with a cursor, newest first.
  for (let i = 0; i < 3; i++) await send(w, { surface: 'creator', ref: 'zari', phone: `98765001${10 + i}` });
  const first = (await w.api('/leads?limit=2')).body;
  assert.equal(first.items.length, 2);
  const next = (await w.api(`/leads?limit=2&cursor=${first.nextCursor}`)).body;
  assert.ok(next.items[0].id < first.items[1].id);
  assert.equal((await w.api('/leads?cursor=nonsense')).status, 400);
  await setPlan(w, 't1');
  assert.doesNotMatch((await w.page('/zari')).text, /action="\/lead"/, 'without the feature the page shows no form');
});
