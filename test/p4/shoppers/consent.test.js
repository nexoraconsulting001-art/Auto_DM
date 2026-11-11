// Shopper data protection (PRD 9.18): the consent ledger behind platform.consent, the policy pages, the cookie banner,
// one-tap withdrawal, and the seller's console routes for privacy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentLinks } from '../../../src/modules/consent/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { OWNER } from '../../helpers.js';
import { browser, signInWithCode, world } from './support.js';

const PHONE = '9876543210';
const E164 = '+919876543210';

async function ownerToken(w, host = null) {
  const res = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...(host ? { 'x-forwarded-host': host } : {}) }, body: JSON.stringify(OWNER) });
  assert.equal(res.status, 201);
  return (await res.json()).token;
}
const asOwner = (w, token) => (method, path, json) => fetch(`${w.app.base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });

/** What the shopper-message gate would do with a message, for this business. */
const gate = (w, tenant, message) => withTenant(tenant, () => w.app.ctx.shopperMessages.check(message));
const marketing = (channel, to) => (channel === 'whatsapp'
  ? { channel, purpose: 'marketing', to, template: { purpose: 'cart_reminder', params: ['x'] }, now: new Date('2026-11-11T06:30:00Z') }
  : { channel, purpose: 'marketing', to, email: { subject: 'New in', text: 'Hello', unsubscribeUrl: 'https://shop.test/unsubscribe/x' }, now: new Date('2026-11-11T06:30:00Z') });

test('S-59: signing in with a WhatsApp code or Google writes a consent record with the notice version and purposes', async () => {
  const w = await world();
  try {
    const b = browser(w.app);
    const { csrf } = await signInWithCode(w, b, PHONE);
    // The choices ticked on the sign-in page follow, under the same notice.
    const saved = await b.request('/api/store/consent?source=sign_in', { method: 'POST', json: { choices: { noticeVersion: 1, orderUpdates: { whatsapp: true }, marketing: { whatsapp: false } } }, headers: { 'x-shopper-csrf': csrf } });
    assert.equal(saved.status, 200);
    const rows = await w.app.db.platform.query('SELECT purpose, channel, granted, notice_version, source, shopper_id FROM consent_records ORDER BY id');
    assert.deepEqual(rows.map((r) => [r.purpose, r.channel, r.granted, r.notice_version, r.source]), [
      ['fulfilment', '', true, 1, 'sign_in'],
      ['order_updates', 'whatsapp', true, 1, 'sign_in'],
      ['marketing', 'whatsapp', false, 1, 'sign_in'],
    ]);
    assert.ok(rows.every((r) => r.shopper_id), 'each names the shopper');
    const [notice] = await w.app.db.platform.query('SELECT body_en, body_hi FROM consent_notices');
    assert.match(notice.body_en, /Test store/, 'the notice names the business');
    assert.ok(notice.body_hi.length > 20, 'and is bilingual');

    await w.google.post('/next-user', { sub: 'g-9', email: 'g@example.com', email_verified: true, name: 'G' });
    const g = browser(w.app);
    const go = await fetch(new URL((await g.request('/auth/google')).headers.get('location')), { redirect: 'manual' });
    const cb = new URL(go.headers.get('location'));
    assert.equal((await g.request(`${cb.pathname}${cb.search}`)).status, 303);
    const [google] = await w.app.db.platform.query(`SELECT c.purpose, c.source, c.notice_version FROM consent_records c JOIN shoppers s ON s.id = c.shopper_id WHERE s.google_sub = 'g-9'`);
    assert.deepEqual(google, { purpose: 'fulfilment', source: 'sign_in', notice_version: 1 });
  } finally {
    await w.close();
  }
});

test('S-60: a shopper who gave order-only consent gets no marketing on any channel', async () => {
  const w = await world({ google: false });
  try {
    const b = browser(w.app);
    const { csrf } = await signInWithCode(w, b, PHONE);
    await b.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, orderUpdates: { whatsapp: true, email: true } } }, headers: { 'x-shopper-csrf': csrf } });
    const [{ id }] = await w.app.db.platform.query('SELECT id FROM shoppers');
    for (const channel of ['whatsapp', 'email']) {
      const verdict = await gate(w, w.app.tenant, marketing(channel, { shopperId: id, phone: E164, email: 'asha@example.com' }));
      assert.deepEqual([verdict.outcome, verdict.reason], ['skipped', 'no_consent'], channel);
    }
    const update = await gate(w, w.app.tenant, { channel: 'whatsapp', purpose: 'order_update', to: { shopperId: id, phone: E164 }, template: { purpose: 'order_paid', params: ['A-1'] } });
    assert.notEqual(update.reason, 'no_consent', 'order updates were agreed to');
    // Asked by the number alone (a guest order's phone), the answer is the same.
    assert.equal((await gate(w, w.app.tenant, marketing('whatsapp', { phone: E164 }))).reason, 'no_consent');
  } finally {
    await w.close();
  }
});

test('S-64: withdrawing WhatsApp consent from a message’s link stops WhatsApp only, and email follows its own consent', async () => {
  const w = await world({ google: false });
  try {
    const b = browser(w.app);
    const { csrf } = await signInWithCode(w, b, PHONE);
    await b.request('/account', {});
    await b.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, marketing: { whatsapp: true, email: true } } }, headers: { 'x-shopper-csrf': csrf } });
    const [{ id }] = await w.app.db.platform.query('SELECT id FROM shoppers');
    const to = { shopperId: id, phone: E164, email: 'asha@example.com' };
    assert.notEqual((await gate(w, w.app.tenant, marketing('whatsapp', to))).reason, 'no_consent');

    const link = await withTenant(w.app.tenant, () => consentLinks(w.app.ctx).unsubscribeUrl({ origin: 'https://shop.test', shopperId: id, phone: E164, channel: 'whatsapp' }));
    assert.match(link, /^https:\/\/shop\.test\/unsubscribe\/[\w.-]+$/, 'a direct link on the store’s own address');
    const path = new URL(link).pathname;
    const reader = browser(w.app);
    const opened = await reader.request(path);
    assert.equal(opened.status, 200);
    assert.match(await opened.text(), /Stop offers and news on WhatsApp\?/);
    assert.notEqual((await gate(w, w.app.tenant, marketing('whatsapp', to))).reason, 'no_consent', 'opening the link alone changes nothing');

    const tapped = await reader.request(path, { method: 'POST', form: {} });
    assert.equal(tapped.status, 200);
    assert.match(await tapped.text(), /Done/);
    assert.equal((await gate(w, w.app.tenant, marketing('whatsapp', to))).reason, 'no_consent', 'no further WhatsApp marketing');
    assert.equal((await gate(w, w.app.tenant, marketing('whatsapp', { phone: E164 }))).reason, 'no_consent', 'by number too');
    assert.notEqual((await gate(w, w.app.tenant, marketing('email', to))).reason, 'no_consent', 'email keeps its own yes');

    // A changed or foreign link does nothing.
    assert.equal((await reader.request(`${path.slice(0, -2)}xx`, { method: 'POST', form: {} })).status, 404);
  } finally {
    await w.close();
  }
});

test('S-61: each policy page loads signed out on the business’s own domain, in its own name', async () => {
  const w = await world({ google: false });
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    await leaf.repos.settings.update({ store_name: 'Leaf and Clay' });
    for (const kind of ['privacy', 'terms', 'refund', 'shipping']) {
      const res = await browser(w.app).request(`/policies/${kind}`);
      assert.equal(res.status, 200, kind);
      const page = await res.text();
      assert.doesNotMatch(page, /bhava/i, `${kind} names only the seller`);
      const atLeaf = await browser(w.app, { host: leaf.host }).request(`/policies/${kind}`);
      assert.equal(atLeaf.status, 200);
      const leafPage = await atLeaf.text();
      assert.match(leafPage, /Leaf and Clay/);
      assert.doesNotMatch(leafPage, /Test store/, 'never the other business');
    }
    assert.equal((await browser(w.app).request('/policies/cookies')).status, 404);
  } finally {
    await w.close();
  }
});

test('S-62: the privacy page shows the business’s grievance contact, set from the console', async () => {
  const w = await world({ google: false });
  try {
    const api = asOwner(w, await ownerToken(w));
    const before = await (await api('GET', '/privacy')).json();
    assert.deepEqual(before, { grievanceName: '', grievanceEmail: '', grievancePhone: '', grievanceAddress: '' });
    const saved = await api('PATCH', '/privacy', { grievanceName: 'Meera Joshi', grievanceEmail: 'privacy@shop.example', grievanceAddress: '4 Lake Road, Pune' });
    assert.equal(saved.status, 200);
    const page = await (await browser(w.app).request('/policies/privacy')).text();
    for (const text of ['Grievance contact', 'Meera Joshi', 'privacy@shop.example', '4 Lake Road, Pune']) assert.match(page, new RegExp(text));
    assert.equal((await api('PATCH', '/privacy', { grievanceEmail: 'not an email' })).status, 400);

    const policy = await api('PUT', '/policies', { kind: 'refund', body: 'Returns within 7 days of delivery.' });
    assert.equal(policy.status, 200);
    assert.equal((await policy.json()).url, '/policies/refund');
    assert.match(await (await browser(w.app).request('/policies/refund')).text(), /Returns within 7 days of delivery\./);
    const all = await (await api('GET', '/policies')).json();
    assert.deepEqual(all.items.map((p) => p.kind), ['privacy', 'terms', 'refund', 'shipping']);
    const audit = await w.app.db.platform.query(`SELECT action FROM audit_log WHERE action IN ('privacy.update', 'policies.save')`);
    assert.equal(audit.length, 2);
  } finally {
    await w.close();
  }
});

test('the consent notice: version 0 until published, a new version each time, and old versions kept', async () => {
  const w = await world({ google: false });
  try {
    const api = asOwner(w, await ownerToken(w));
    const draft = await (await api('GET', '/consent-notice')).json();
    assert.equal(draft.version, 0);
    assert.match(draft.bodyEn, /Test store/);
    const first = await api('POST', '/consent-notice', { bodyEn: 'Test store uses your details for your orders.', bodyHi: 'टेस्ट स्टोर आपके ऑर्डर के लिए आपके विवरण का उपयोग करता है।' });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).version, 1);
    assert.equal((await (await api('POST', '/consent-notice', { bodyEn: 'Second wording.', bodyHi: 'दूसरा।' })).json()).version, 2);
    const store = await (await browser(w.app).request('/api/store/consent')).json();
    assert.equal(store.notice.version, 2);
    assert.equal(store.notice.bodyEn, 'Second wording.');
    const versions = await w.app.db.platform.query('SELECT version FROM consent_notices ORDER BY version');
    assert.deepEqual(versions.map((v) => v.version), [1, 2]);
    // A choice naming a version that was never published is refused.
    const b = browser(w.app);
    assert.equal((await b.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 9, analyticsAds: true } } })).status, 409);
  } finally {
    await w.close();
  }
});

test('the cookie banner: in the seller’s name, declining as easy as accepting, and a withdrawal stops later events', async () => {
  const w = await world({ google: false });
  try {
    // No tag on: no banner, and nothing to consent to.
    assert.doesNotMatch(await (await browser(w.app).request('/')).text(), /cookie-banner/);

    await w.app.repos.entitlements.setOverride('tags.pixels', { enabled: true });
    await w.app.db.platform.query(`INSERT INTO tag_settings (tenant_id, meta_enabled, meta_pixel_id) VALUES ($1, true, '123456789012345')`, [w.app.tenant.id]);
    const b = browser(w.app);
    const page = await (await b.request('/')).text();
    assert.match(page, /id="cookie-banner"/);
    const buttons = [...page.matchAll(/<button type="button" data-cookie="([01])" style="([^"]+)">([^<]+)<\/button>/g)];
    assert.deepEqual(buttons.map((m) => [m[1], m[3]]), [['1', 'Allow'], ['0', 'Don’t allow']]);
    assert.equal(buttons[0][2], buttons[1][2], 'both buttons look the same');
    assert.match(page, /Test store would like to use cookies/);
    assert.doesNotMatch(page.slice(page.indexOf('cookie-banner')), /bhava/i);
    const visitorId = b.cookies().get('_vid');
    assert.ok(visitorId);
    const ask = () => withTenant(w.app.tenant, () => w.app.ctx.platform.consent.analyticsAndAds({ visitorId }));
    assert.deepEqual(await ask(), { granted: false, answered: false, reason: 'not_asked' });

    // Declining: one tap, and the banner is gone.
    assert.equal((await b.request('/api/store/consent?source=banner', { method: 'POST', json: { choices: { noticeVersion: 1, analyticsAds: false } } })).status, 200);
    assert.deepEqual(await ask(), { granted: false, answered: true, reason: 'withdrawn' });
    assert.doesNotMatch(await (await b.request('/')).text(), /cookie-banner/);

    // Accepting, then taking it back from the privacy page: from then on the answer is no, so nothing more is sent.
    await b.request('/api/store/consent?source=banner', { method: 'POST', json: { choices: { noticeVersion: 1, analyticsAds: true } } });
    assert.equal((await ask()).granted, true);
    const privacy = await (await b.request('/policies/privacy')).text();
    assert.match(privacy, /You allowed cookies that measure visits and ads/);
    await b.request('/api/store/consent?source=banner', { method: 'POST', json: { choices: { noticeVersion: 1, analyticsAds: false } } });
    assert.equal((await ask()).granted, false);

    // A signed-in shopper's withdrawal on one device stops events from their other devices.
    const phone = browser(w.app);
    await phone.request('/');
    const laptop = browser(w.app);
    await laptop.request('/');
    const { csrf: c1 } = await signInWithCode(w, phone, PHONE);
    const { csrf: c2 } = await signInWithCode(w, laptop, PHONE);
    await phone.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, analyticsAds: true } }, headers: { 'x-shopper-csrf': c1 } });
    await laptop.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, analyticsAds: false } }, headers: { 'x-shopper-csrf': c2 } });
    const onPhone = await withTenant(w.app.tenant, () => w.app.ctx.platform.consent.analyticsAndAds({ visitorId: phone.cookies().get('_vid') }));
    assert.equal(onPhone.granted, false);
    // A banner answer never touches a shopper's message choices.
    const rows = await w.app.db.platform.query(`SELECT count(*)::int AS n FROM consent_records WHERE purpose IN ('marketing', 'order_updates')`);
    assert.equal(rows[0].n, 0);
  } finally {
    await w.close();
  }
});

test('S-104: a marketing yes at one store never counts at another', async () => {
  const w = await world({ google: false });
  try {
    const leaf = await w.addStore('leaf', 'Leaf and Clay');
    const atA = browser(w.app);
    const { csrf } = await signInWithCode(w, atA, PHONE);
    await atA.request('/api/store/consent', { method: 'POST', json: { choices: { noticeVersion: 1, marketing: { whatsapp: true, email: true } } }, headers: { 'x-shopper-csrf': csrf } });
    const atB = browser(w.app, { host: leaf.host });
    await signInWithCode(w, atB, PHONE);
    const [b] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [leaf.tenant.id]);
    for (const channel of ['whatsapp', 'email']) {
      assert.equal((await gate(w, leaf.tenant, marketing(channel, { shopperId: b.id, phone: E164, email: 'asha@example.com' }))).reason, 'no_consent', `B sends no ${channel} marketing`);
      assert.equal((await gate(w, leaf.tenant, marketing(channel, { phone: E164, email: 'asha@example.com' }))).reason, 'no_consent', `not even by number at B (${channel})`);
    }
    const [aId] = await w.app.db.platform.query('SELECT id FROM shoppers WHERE tenant_id = $1', [w.app.tenant.id]);
    assert.notEqual((await gate(w, w.app.tenant, marketing('whatsapp', { shopperId: aId.id, phone: E164 }))).reason, 'no_consent', 'A still may');
    const hashes = await w.app.db.platform.query(`SELECT DISTINCT tenant_id, phone_hash FROM consent_records WHERE phone_hash IS NOT NULL`);
    assert.equal(new Set(hashes.map((h) => h.phone_hash)).size, hashes.length, 'one number is a different hash at each store');
  } finally {
    await w.close();
  }
});
