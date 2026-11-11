// Order alerts to shoppers (PRD 9.16): settings with WhatsApp and email only (S-96), the business's own WhatsApp account and
// templates, one message per event and channel (S-52, S-54), the template-pending fallback (S-53), mail from the right
// domain with the seller's name only (S-55), consent first, retries, and WhatsApp's delivery reports and STOP replies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { orderAlertsFor } from '../../../src/modules/order-alerts/index.js';
import { WHATSAPP_TEMPLATES } from '../../../src/modules/order-alerts/templates.js';
import { NEUTRAL_MAIL, PLATFORM, alertsApp, alertsOf, emailsTo, hit, inTenant, paidOrder, product, q, signWhatsapp, whatsappTo } from './support.js';

test('S-96: alert settings offer WhatsApp and email only, with the cost per message, and save what the owner changes', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    const first = await app.api('GET', '/alert-settings');
    assert.equal(first.status, 200, first.text);
    assert.deepEqual(first.json.channels, ['whatsapp', 'email']);
    assert.deepEqual(first.json.events, ['placed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);
    assert.equal(first.json.emailFromAddress, `orders@${NEUTRAL_MAIL}`);
    assert.deepEqual(first.json.whatsappCostPaise, { utility: null, authentication: null, marketing: null });
    assert.doesNotMatch(first.text, /sms/i);

    const saved = await app.api('PATCH', '/alert-settings', { email: false, events: ['paid', 'shipped'], emailFromLocal: 'hello', sms: true, channels: ['sms'] });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.email, false);
    assert.deepEqual(saved.json.events, ['paid', 'shipped']);
    assert.equal(saved.json.emailFromAddress, `hello@${NEUTRAL_MAIL}`);
    assert.doesNotMatch(saved.text, /sms/i, 'an SMS field is never kept');

    // Mail from the business's own domain needs a verified one.
    const refused = await app.api('PATCH', '/alert-settings', { emailFrom: 'own' });
    assert.equal(refused.status, 400);
    await app.db.platform.query(`INSERT INTO tenant_domains (domain, tenant_id, status, is_primary, verified_at) VALUES ('neelstudio.example', $1, 'verified', true, now())`, [app.tenant.id]);
    const own = await app.api('PATCH', '/alert-settings', { emailFrom: 'own' });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.json.emailFromAddress, 'hello@neelstudio.example');
    const [audit] = await q(app, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'alert_settings.updated' ORDER BY id DESC LIMIT 1`, [app.tenant.id]);
    assert.ok(audit, 'the change is in the audit log');
  } finally {
    await app.close();
  }
});

test('the business connects its own WhatsApp number; the token is never shown, and a number belongs to one business', async () => {
  const app = await alertsApp({ whatsapp: false });
  try {
    assert.deepEqual((await app.api('GET', '/whatsapp-account')).json, { connected: false, displayNumber: '', status: 'none' });
    const bad = await app.api('PUT', '/whatsapp-account', { wabaId: 'waba1', phoneNumberId: 'ph1', accessToken: 'wrong-token' });
    assert.equal(bad.status, 400, bad.text);
    const ok = await app.api('PUT', '/whatsapp-account', { wabaId: 'waba1', phoneNumberId: 'ph1', accessToken: 'sim-whatsapp-token' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.connected, true);
    assert.equal(ok.json.displayNumber, '+91 90000 00000', 'the number WhatsApp has on file');
    assert.ok(!ok.text.includes('sim-whatsapp-token'));
    const [row] = await q(app, 'SELECT access_token_enc FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    assert.ok(row.access_token_enc && !row.access_token_enc.includes('sim-whatsapp-token'), 'stored encrypted');

    // Templates: submitted for review, then read back as WhatsApp's review goes.
    const synced = await app.api('POST', '/whatsapp-templates/sync');
    assert.equal(synced.status, 200, synced.text);
    assert.deepEqual(synced.json.items.map((t) => t.purpose).sort(), Object.keys(WHATSAPP_TEMPLATES).sort());
    assert.ok(synced.json.items.every((t) => t.status === 'pending'));
    assert.equal(synced.json.items.find((t) => t.purpose === 'order_paid').category, 'utility');
    assert.equal(synced.json.items.find((t) => t.purpose === 'otp').category, 'authentication');
    assert.equal(synced.json.items.find((t) => t.purpose === 'cart_reminder').category, 'marketing');
    const submitted = (await app.wa.calls({ method: 'POST', path: '/*/*/message_templates' }));
    assert.equal(submitted.length, Object.keys(WHATSAPP_TEMPLATES).length);
    for (const call of submitted) assert.doesNotMatch(JSON.stringify(call.body), PLATFORM, 'a template names the platform');
    await app.wa.post('/templates', { name: 'order_paid', status: 'APPROVED' });
    await app.wa.post('/templates', { name: 'order_shipped', status: 'REJECTED' });
    const again = (await app.api('POST', '/whatsapp-templates/sync')).json.items;
    assert.equal(again.find((t) => t.purpose === 'order_paid').status, 'approved');
    assert.equal(again.find((t) => t.purpose === 'order_shipped').status, 'rejected');
    assert.equal((await app.wa.calls({ method: 'POST', path: '/*/*/message_templates' })).length, submitted.length, 'nothing is submitted twice');

    // The same number at another business is refused.
    const other = await app.platform.tenants.ensure({ slug: 'haldi', name: 'Haldi House' });
    await app.db.platform.query(`UPDATE tenants SET plan = 't3' WHERE id = $1`, [other.id]);
    await withTenant(other, () => app.platform.users.ensureOwner({ phone: '9000000002', password: 'other-pass' }));
    const login = await hit(app, '/api/v1/auth/login', { method: 'POST', host: 'haldi.shops.example', body: { phone: '9000000002', password: 'other-pass' } });
    const taken = await hit(app, '/api/v1/whatsapp-account', { method: 'PUT', host: 'haldi.shops.example', token: login.json.token, body: { wabaId: 'waba2', phoneNumberId: 'ph1', accessToken: 'sim-whatsapp-token' } });
    assert.equal(taken.status, 409, taken.text);

    assert.equal((await app.api('DELETE', '/whatsapp-account')).status, 204);
    assert.equal((await app.api('GET', '/whatsapp-account')).json.status, 'none');
    assert.equal((await app.api('POST', '/whatsapp-templates/sync')).status, 409, 'no account, no sync');
  } finally {
    await app.close();
  }
});

test('S-52, S-55: a paid order sends one Utility template and one email, in the seller’s name only', async () => {
  const app = await alertsApp();
  try {
    const lamp = await product(app, { name: 'Brass lamp', pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811122233', email: 'asha@mail.example' });
    const alerts = await alertsOf(app, order.id);
    assert.deepEqual(alerts.map((a) => [a.event, a.channel, a.status]), [['paid', 'whatsapp', 'sent'], ['paid', 'email', 'sent']]);
    const wa = await whatsappTo(app, '+919811122233');
    assert.equal(wa.length, 1);
    assert.equal(wa[0].body.template.name, 'order_paid');
    const params = wa[0].body.template.components[0].parameters.map((p) => p.text);
    assert.deepEqual(params.slice(0, 3), ['Asha', order.order_number, 'Neel Studio']);
    assert.equal(params[3], `https://shop.test/order/${order.public_token}`, 'a direct link to the store’s own order page');
    assert.doesNotMatch(JSON.stringify(wa[0].body), PLATFORM);
    const [mail] = await emailsTo(app, 'asha@mail.example');
    assert.equal(mail.id, alerts[1].provider_message_id);
    assert.equal(mail.fromDomain, NEUTRAL_MAIL);
    // The From name is the gate's choice (the business's name); the body carries the store's name its pages show.
    assert.match(mail.from, new RegExp(`^${app.tenant.name} <`));
    assert.ok(`${mail.subject} ${mail.html}`.includes('Neel Studio'));
    assert.match(mail.subject, /Payment received/);
    assert.ok(mail.html.includes(order.order_number) && mail.text.includes(order.order_number));
    assert.ok(mail.html.includes('Brass lamp'));
    assert.ok(mail.headers['List-Unsubscribe'], 'a way to stop order emails');
    for (const part of [mail.from, mail.subject, mail.html, mail.text, JSON.stringify(mail.headers)]) assert.doesNotMatch(part, PLATFORM);

    // S-54: the same event again, and the listener run again, send nothing more.
    const { alerts: service } = orderAlertsFor(app.ctx);
    await inTenant(app, () => service.raise(order, 'paid'));
    assert.equal((await whatsappTo(app, '+919811122233')).length, 1);
    assert.equal((await emailsTo(app, 'asha@mail.example')).length, 1);
    assert.equal((await alertsOf(app, order.id)).length, 2);

    // The console lists them, newest first.
    const list = await app.api('GET', `/order-alerts?orderId=${order.id}`);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.json.items.map((a) => [a.channel, a.status, a.orderNumber]), [['email', 'sent', order.order_number], ['whatsapp', 'sent', order.order_number]]);
  } finally {
    await app.close();
  }
});

test('S-52: no consent to order updates on a channel means nothing on that channel, and an unpaid order says nothing', async () => {
  const app = await alertsApp();
  try {
    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100011', email: 'ravi@mail.example', consent: { orderUpdates: { whatsapp: false, email: true } } });
    const alerts = await alertsOf(app, order.id);
    assert.deepEqual(alerts.map((a) => [a.channel, a.status, a.skip_reason]), [['whatsapp', 'skipped', 'no_consent'], ['email', 'sent', '']]);
    assert.equal((await whatsappTo(app, '+919811100011')).length, 0);

    // Placed and never paid: no "order placed" message for a payment that may never come.
    const res = await hit(app, '/api/store/checkout', { method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 1 }], address: { name: 'Mira', phone: '+919811100022', line1: '1 Road', city: 'Pune', stateCode: '27', pincode: '411001' }, email: 'mira@mail.example', paymentMode: 'prepaid', idempotencyKey: crypto.randomUUID(), acceptTerms: true, consent: { noticeVersion: 1, orderUpdates: { whatsapp: true, email: true } } } });
    assert.equal(res.status, 201, res.text);
    await app.ctx.orderEvents.settle();
    const [unpaid] = await q(app, 'SELECT id FROM orders WHERE tenant_id = $1 AND order_number = $2', [app.tenant.id, res.json.orderNumber]);
    assert.equal((await alertsOf(app, unpaid.id)).length, 0);
  } finally {
    await app.close();
  }
});

test('S-53: a template still in review falls back to email and the admin shows "Template pending", even with email alerts off', async () => {
  const app = await alertsApp();
  try {
    await app.wa.post('/templates', { name: 'order_paid', status: 'PENDING' });
    await app.wa.post('/templates/enforce', { on: true });
    await app.api('POST', '/whatsapp-templates/sync');
    await app.api('PATCH', '/alert-settings', { email: false });
    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100033', email: 'leela@mail.example' });
    const alerts = await alertsOf(app, order.id);
    assert.deepEqual(alerts.map((a) => [a.channel, a.status, a.skip_reason]), [['whatsapp', 'skipped', 'template_pending'], ['email', 'sent', '']]);
    assert.equal((await whatsappTo(app, '+919811100033')).length, 0);
    assert.equal((await emailsTo(app, 'leela@mail.example')).length, 1);
    const shown = (await app.api('GET', '/order-alerts?status=skipped')).json.items;
    assert.equal(shown.find((a) => a.orderId === order.id).skipReason, 'template_pending');

    // Approved later: the owner sends it again, once.
    await app.wa.post('/templates', { name: 'order_paid', status: 'APPROVED' });
    await app.api('POST', '/whatsapp-templates/sync');
    const retried = await app.api('POST', `/order-alerts/${alerts[0].id}/retry`);
    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json.status, 'sent');
    assert.equal((await whatsappTo(app, '+919811100033')).length, 1);
    assert.equal((await app.api('POST', `/order-alerts/${alerts[0].id}/retry`)).status, 409, 'a sent message is not sent again');
    assert.equal((await app.api('POST', '/order-alerts/999999/retry')).status, 404);
  } finally {
    await app.close();
  }
});

test('a send that fails for a while is retried with backoff; one whose answer was lost is never repeated', async () => {
  const app = await alertsApp();
  try {
    const lamp = await product(app, { pricePaise: 49900 });
    await app.mail.fault({ kind: 'rate_limit', times: 3, match: { method: 'POST', path: '/messages' } });
    await app.wa.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: '/*/*/messages' } });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100044', email: 'kiran@mail.example' });
    let [wa, mail] = await alertsOf(app, order.id);
    assert.equal(wa.status, 'failed', 'WhatsApp may have taken it: never sent again on a guess');
    assert.equal(wa.error_code, 'unknown_delivery');
    assert.equal(mail.status, 'queued', 'a refusal that may pass waits and goes again');
    assert.ok(new Date(mail.next_attempt_at) > new Date());
    assert.equal(mail.attempts, 1);

    const { alerts } = orderAlertsFor(app.ctx);
    await q(app, `UPDATE order_alerts SET next_attempt_at = now() - interval '1 second' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, mail.id]);
    assert.deepEqual(await alerts.sweep(), { due: 1, sent: 1 });
    [wa, mail] = await alertsOf(app, order.id);
    assert.equal(mail.status, 'sent');
    assert.equal((await emailsTo(app, 'kiran@mail.example')).length, 1);
    assert.equal((await whatsappTo(app, '+919811100044')).length, 1, 'the one WhatsApp took, and no second');
    const [owner] = await q(app, `SELECT * FROM alerts WHERE tenant_id = $1 AND kind = 'order_alerts.failed'`, [app.tenant.id]);
    assert.ok(owner, 'the owner is told some messages failed');
    assert.doesNotMatch(owner.message, /\+?91981/);

    // A sender that died mid-send left the row "in flight": WhatsApp is failed, not sent again.
    await q(app, `UPDATE order_alerts SET status = 'queued', error_code = 'in_flight', next_attempt_at = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, wa.id]);
    await alerts.sweep();
    assert.equal((await alertsOf(app, order.id))[0].error_code, 'unknown_delivery');
    assert.equal((await whatsappTo(app, '+919811100044')).length, 1);
  } finally {
    await app.close();
  }
});

test('WhatsApp webhooks: signed delivery reports mark alerts delivered, a STOP withdraws marketing consent, and a bad signature stores nothing', async () => {
  const app = await alertsApp();
  try {
    const verify = await hit(app, '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wa-verify&hub.challenge=abc123');
    assert.equal(verify.status, 200);
    assert.equal(verify.text, 'abc123');
    assert.match(verify.headers['content-type'], /text\/plain/);
    assert.equal((await hit(app, '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc')).status, 403);

    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100055', email: 'dev@mail.example' });
    const [wa] = await alertsOf(app, order.id);
    await app.wa.post('/webhooks/url', { url: `${app.base}/webhooks/whatsapp` });
    await app.wa.post('/status', { messageId: wa.provider_message_id, status: 'delivered', hold: true });
    await app.wa.post('/status', { messageId: wa.provider_message_id, status: 'sent', hold: true });
    await app.wa.post('/webhooks/flush', {});
    await orderAlertsFor(app.ctx).webhook.settle();
    assert.equal((await alertsOf(app, order.id))[0].status, 'delivered', '"sent" arriving after "delivered" never moves it back');

    const before = (await app.db.platform.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'whatsapp'`))[0].n;
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const bad = await hit(app, '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWhatsapp(app, raw, 'wrong') }, body: raw });
    assert.equal(bad.status, 401);
    const none = await hit(app, '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(none.status, 401);
    const junk = await hit(app, '/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signWhatsapp(app, 'not json') }, body: 'not json' });
    assert.ok(junk.status >= 400 && junk.status < 500, `unreadable body: ${junk.status}`);
    assert.equal((await app.db.platform.query(`SELECT count(*)::int AS n FROM provider_webhook_events WHERE provider = 'whatsapp'`))[0].n, before);

    // STOP: the shopper's yes to WhatsApp marketing at this business is taken back. The reply's words are not kept.
    const phone = '+919811100066';
    await inTenant(app, () => app.ctx.platform.consent.record({ subject: { phone }, choices: [{ purpose: 'marketing', channel: 'whatsapp', granted: true }], noticeVersion: 1, source: 'account' }));
    const [{ phone_number_id: phoneId }] = await q(app, 'SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    await app.wa.post('/inbound', { phoneId, from: '919811100066', text: 'STOP' });
    await orderAlertsFor(app.ctx).webhook.settle();
    const answer = await inTenant(app, () => app.ctx.platform.consent.allows({ purpose: 'marketing', channel: 'whatsapp', phone }));
    assert.equal(answer.granted, false);
    const stored = await app.db.platform.query(`SELECT payload, status FROM provider_webhook_events WHERE provider = 'whatsapp' AND event_type = 'messages'`);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, 'processed');
    assert.doesNotMatch(JSON.stringify(stored[0].payload), /STOP|9811100066/, 'neither the words nor the number are kept');
  } finally {
    await app.close();
  }
});

test('shipped, delivered, cancelled and refunded each speak once; cash on delivery says "placed"; one business never sees another’s alerts', async () => {
  const app = await alertsApp();
  try {
    const { alerts } = orderAlertsFor(app.ctx);
    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100077', email: 'noor@mail.example' });
    for (const kind of ['shipped', 'delivered', 'refunded']) {
      await inTenant(app, () => alerts.raise(order, kind));
      await inTenant(app, () => alerts.raise(order, kind));
    }
    const rows = await alertsOf(app, order.id);
    assert.deepEqual(rows.map((r) => `${r.event}:${r.channel}:${r.status}`), ['paid:whatsapp:sent', 'paid:email:sent', 'shipped:whatsapp:sent', 'shipped:email:sent', 'delivered:whatsapp:sent', 'delivered:email:sent', 'refunded:whatsapp:sent', 'refunded:email:sent']);
    const names = (await whatsappTo(app, '+919811100077')).map((m) => m.body.template.name);
    assert.deepEqual(names, ['order_paid', 'order_shipped', 'order_delivered', 'order_refunded']);
    const subjects = (await emailsTo(app, 'noor@mail.example')).map((m) => m.subject);
    assert.equal(subjects.filter((s) => /ship/i.test(s)).length, 1);

    // The rules for which order events speak.
    const { alertKindFor } = await import('../../../src/modules/order-alerts/alerts.js');
    const checkout = { flow: 'checkout', payment_mode: 'cod', confirmed_at: new Date() };
    assert.equal(alertKindFor({ type: 'order.confirmed' }, checkout), 'placed');
    assert.equal(alertKindFor({ type: 'order.confirmed' }, { ...checkout, payment_mode: 'prepaid' }), null);
    assert.equal(alertKindFor({ type: 'order.paid', from: 'cod_due' }, checkout), null, 'cash collected at the door is not a second message');
    assert.equal(alertKindFor({ type: 'order.cancelled' }, { ...checkout, confirmed_at: null }), null);
    assert.equal(alertKindFor({ type: 'order.partially_refunded' }, checkout), 'refunded');
    assert.equal(alertKindFor({ type: 'order.paid', from: 'unpaid' }, { flow: 'manual' }), null, 'the Phase 0 manual store sends nothing');

    // Another business's console sees none of these.
    const other = await app.platform.tenants.ensure({ slug: 'haldi', name: 'Haldi House' });
    await app.db.platform.query(`UPDATE tenants SET plan = 't3' WHERE id = $1`, [other.id]);
    await withTenant(other, () => app.platform.users.ensureOwner({ phone: '9000000003', password: 'other-pass' }));
    const login = await hit(app, '/api/v1/auth/login', { method: 'POST', host: 'haldi.shops.example', body: { phone: '9000000003', password: 'other-pass' } });
    const theirs = await hit(app, '/api/v1/order-alerts', { host: 'haldi.shops.example', token: login.json.token });
    assert.equal(theirs.status, 200, theirs.text);
    assert.deepEqual(theirs.json.items, []);
    assert.equal((await hit(app, `/api/v1/order-alerts/${rows[0].id}/retry`, { method: 'POST', host: 'haldi.shops.example', token: login.json.token })).status, 404);
  } finally {
    await app.close();
  }
});
