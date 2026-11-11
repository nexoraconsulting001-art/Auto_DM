// The notifications pipeline (PRD 5.13, 10.5): handing events out, collapsing, quiet hours, membership and devices
// checked before every try, and what a push, an email and the in-app list may hold. Against tools/sim/push, whatsapp and email.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as n from '../../../src/contracts/notifications.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { emailHtml } from '../../../src/modules/reports/render.js';
import { placeOrder } from '../../p4/contract/support.js';
import {
  MINUTE, PLATFORM_FROM, SECOND, SHOPPER, accepted, addUser, connect, deliveriesOf, deliveryOf, emailsTo, received, signInDevice, startWorld, whatsappsTo,
} from './support.js';

let w;
let owner;
let product;

before(async () => {
  w = await startWorld();
  owner = await connect(w, { devices: ['android'] });
  product = await w.app.repos.products.create({ name: 'Brass lamp', price: '500', active: 'on' });
});
after(() => w?.close());

const order = async (mode = 'prepaid') => {
  const made = await placeOrder({ tenant: w.tenant, db: w.app.db, product, inTenant: (fn) => w.inTenant(fn) }, { mode });
  await w.inTenant(() => w.app.db.tx((t) => changeOrder(t, made.id, mode === 'cod' ? { payment: 'cod_due', fulfilment: 'new', actor: 'shopper:1' } : { payment: 'paid', fulfilment: 'new', actor: 'webhook:razorpay' })));
  await w.app.ctx.orderEvents.drain();
  return made;
};
const reset = async () => {
  // Each test starts well clear of the last one's collapse groups.
  w.clock.advance(10 * MINUTE);
  await w.sims.push.post('/reset');
  await w.sims.email.post('/reset');
  await w.sims.whatsapp.post('/reset');
};
const emit = (input) => w.notify.emit({ tenantId: w.tenant.id, ...input });

test('F-57: the same alert five times in five minutes is sent once, with two workers draining at the same moment', async () => {
  await reset();
  const [a, b] = [w.worker(), w.worker()];
  // Five raises of one alert, and the same event emitted six times at once, while both workers drain.
  for (let i = 0; i < 5; i++) await w.inTenant(() => w.app.repos.alerts.raise({ kind: 'token.invalid', severity: 'critical', message: 'Reconnect', target: 'instagram:ME', dedupeKey: 'token.rejected:ME:1' }));
  const [ids] = await Promise.all([
    Promise.all(Array.from({ length: 6 }, () => emit({ event: 'dm.usage_100', key: 'usage:2026-11' }))),
    a.drain(), b.drain(),
  ]);
  await Promise.all([a.drain(), b.drain()]);
  assert.equal(ids.filter(Boolean).length, 1, 'one outbox row');
  const events = await w.sql(`SELECT id, kind FROM notification_events WHERE tenant_id = $1 AND kind IN ('token.invalid', 'dm.usage_100') ORDER BY id`, [w.tenant.id]);
  assert.deepEqual(events.map((e) => e.kind).sort(), ['dm.usage_100', 'token.invalid']);
  const pushes = await accepted(w, owner.devices[0].token);
  assert.deepEqual(pushes.map((p) => p.data.kind).sort(), ['dm.usage_100', 'token.invalid'], 'one push for each');
  assert.equal((await emailsTo(w, owner.email)).length, 2, 'one email for each');
  assert.equal((await whatsappsTo(w, owner.phone)).length, 1, 'token.invalid goes by WhatsApp too, once');
  const inapp = await w.sql('SELECT kind FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND event_id = ANY($3::bigint[])', [w.tenant.id, w.owner, events.map((e) => e.id)]);
  assert.equal(inapp.length, 2, 'one in-app row for each');
  for (const ev of events) {
    for (const d of await deliveriesOf(w, ev.id)) assert.equal(d.attempt <= 1, true, `${d.channel} tried once`);
  }
});

test('P-21: five new orders within 40 s are one push, "5 new orders"; a sixth inside 60 s replaces it, a later one starts again', async () => {
  await reset();
  const worker = w.worker();
  const start = w.clock.ms;
  const orders = [];
  for (let i = 0; i < 5; i++) {
    w.clock.set(start + i * 10 * SECOND);
    orders.push(await order());
    await worker.drain();
  }
  assert.deepEqual(await received(w, owner.devices[0].token), [], 'held while the group fills');
  w.clock.set(start + 45 * SECOND);
  await worker.drain();
  let pushes = await accepted(w, owner.devices[0].token);
  assert.equal(pushes.length, 1, 'one push for five orders');
  assert.deepEqual([pushes[0].title, pushes[0].body, pushes[0].data.count, pushes[0].data.link, pushes[0].data.tenantId], ['5 new orders', 'Tap to see them.', '5', '/orders', String(w.tenant.id)]);
  const group = pushes[0].collapseKey;
  assert.match(group, new RegExp(`^t${w.tenant.id}\\.order\\.new\\.\\d+$`));
  const ids = (await w.sql(`SELECT id FROM notification_events WHERE tenant_id = $1 AND kind = 'order.new' AND event_key = ANY($2::text[]) ORDER BY id`, [w.tenant.id, orders.map((o) => `order:${o.id}`)])).map((r) => r.id);
  const rows = (await Promise.all(ids.map((id) => deliveryOf(w, id, 'push', w.owner))));
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'collapsed', 'collapsed', 'collapsed', 'collapsed']);
  assert.equal(rows[0].group_count, 5);
  assert.ok(rows.slice(1).every((r) => Number(r.collapsed_into) === Number(rows[0].id)));
  assert.equal((await emailsTo(w, owner.email)).length, 5, 'F-56: every new order is also an email');

  // Inside 60 s of the first: the same push again with the new count and the same key, so the phone shows one.
  w.clock.set(start + 50 * SECOND);
  await order();
  await worker.drain();
  pushes = await accepted(w, owner.devices[0].token);
  assert.equal(pushes.length, 2);
  assert.deepEqual([pushes[1].title, pushes[1].collapseKey], ['6 new orders', group]);

  // After the window a new group opens, and a group of one says what it is and opens it.
  w.clock.set(start + 75 * SECOND);
  const late = await order();
  await worker.drain();
  assert.equal((await accepted(w, owner.devices[0].token)).length, 2, 'the new group waits its turn');
  w.clock.set(start + 121 * SECOND);
  await worker.drain();
  pushes = await accepted(w, owner.devices[0].token);
  assert.equal(pushes.length, 3);
  assert.deepEqual([pushes[2].title, pushes[2].data.count, pushes[2].data.link], ['New order', '1', `/orders/${late.id}`]);
  assert.notEqual(pushes[2].collapseKey, group);
});

test('P-21: an order that joins a group while its push is in flight is not lost: the push goes again with the new count', async () => {
  await reset();
  const [sender, other] = [w.worker(), w.worker()];
  await order();
  await sender.dispatch({ send: false });
  w.clock.advance(n.NOTIFY_RULES.collapseHoldMs);
  await w.sims.push.post('/behaviour', { kind: 'slow', delayMs: 450, token: owner.devices[0].token });
  const sending = sender.drain();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await order();
  await other.dispatch({ send: false }); // hands the second order out while the first push is on its way
  await sending;
  const pushes = await accepted(w, owner.devices[0].token);
  assert.deepEqual(pushes.map((p) => p.title), ['New order', '2 new orders']);
  assert.equal(new Set(pushes.map((p) => p.collapseKey)).size, 1, 'the second replaces the first on the phone');
});

test('P-20: a cash on delivery order pushes at once, with tenantId and the link that opens it; F-56: a paid one by push and email inside 60 s', async () => {
  await reset();
  const worker = w.worker();
  const cod = await order('cod');
  await worker.drain();
  const [push] = await accepted(w, owner.devices[0].token);
  assert.ok(push, 'no wait for a critical kind');
  assert.equal(push.title, 'Cash on delivery order to confirm');
  assert.deepEqual({ ...push.data, eventId: undefined }, { tenantId: String(w.tenant.id), kind: 'order.cod_to_confirm', link: `/orders/${cod.id}`, eventId: undefined, count: '1' });
  assert.equal(n.appLink(push.data.link), `bhavabusiness://orders/${cod.id}`, 'the app opens the order');

  await reset();
  const placed = w.clock.ms;
  const paid = await order();
  await worker.drain();
  assert.equal((await emailsTo(w, owner.email)).length, 1, 'the email goes at once');
  w.clock.set(placed + n.NOTIFY_RULES.collapseHoldMs);
  await worker.drain();
  const [late] = await accepted(w, owner.devices[0].token);
  assert.deepEqual([late.title, late.data.link], ['New order', `/orders/${paid.id}`]);
  assert.ok(n.NOTIFY_RULES.collapseHoldMs + n.NOTIFY_RULES.pollMs < 60 * SECOND, 'held for the group, it still leaves inside 60 s');
});

test('P-22: no push of any kind holds a name, a phone, an address or a payment detail, and every one carries tenantId and a deep link', async () => {
  await reset();
  const worker = w.worker();
  // Push on for every kind that may use it, so every kind is looked at.
  const events = {};
  for (const kind of n.NOTIFY_KINDS) if (!n.NOTIFY_EVENTS[kind].mandatory && !n.NOTIFY_EVENTS[kind].channels.includes('push')) events[kind] = { push: true };
  await w.inTenant(() => w.notify.prefs.save({ userId: w.owner }, { events }));
  const made = await placeOrder({ tenant: w.tenant, db: w.app.db, product, inTenant: (fn) => w.inTenant(fn) }, { mode: 'cod' });
  const data = { orderId: made.id, orderNumber: made.order_number, returnId: 3, reportRunId: 9, percent: 80, days: 7, account: 'Instagram', threadId: 4 };
  for (const kind of n.NOTIFY_KINDS) await emit({ event: kind, key: `privacy:${kind}`, data });
  await worker.drain();
  w.clock.advance(2 * MINUTE);
  await worker.drain();
  const pushes = await received(w, owner.devices[0].token);
  const pushable = n.NOTIFY_KINDS.filter((kind) => n.resolvePrefs({ events }).events[kind].push);
  assert.deepEqual(pushes.map((p) => p.data.kind).sort(), [...pushable].sort(), 'one push for every kind that may push, and none for the others');
  assert.deepEqual(n.NOTIFY_KINDS.filter((k) => !pushable.includes(k)).sort(), ['account.deletion_requested', 'staff.changed']);
  const shopper = new RegExp([SHOPPER.name, 'Asha', SHOPPER.phone.slice(3), SHOPPER.line1, SHOPPER.pincode, '₹', 'Rs\\.? ?\\d'].join('|'), 'i');
  for (const push of pushes) {
    const kind = push.data.kind;
    assert.equal(n.pushProblem({ title: push.title, body: push.body, data: push.data }), null, kind);
    assert.deepEqual(Object.keys(push.data).filter((k) => !n.PUSH_DATA_KEYS.includes(k)), [], `${kind}: nothing rides along`);
    assert.equal(push.data.tenantId, String(w.tenant.id), kind);
    assert.ok(n.isLinkPath(push.data.link), kind);
    assert.equal(shopper.test(JSON.stringify(push.raw)), false, `${kind}: nothing about the shopper`);
  }
  for (const mail of await emailsTo(w, owner.email)) assert.equal(shopper.test(`${mail.subject} ${mail.html} ${mail.text}`), false, mail.subject);
  const inapp = await w.sql('SELECT title, body FROM notifications WHERE tenant_id = $1 AND user_id = $2', [w.tenant.id, w.owner]);
  for (const row of inapp) assert.equal(shopper.test(`${row.title} ${row.body}`), false, row.title);
  await w.inTenant(() => w.notify.prefs.save({ userId: w.owner }, { events: Object.fromEntries(Object.keys(events).map((k) => [k, { push: false }])) }));
});

test('quiet hours hold push and WhatsApp for kinds that are not critical until they end, and never hold a critical one', async () => {
  await reset();
  const worker = w.worker();
  await w.inTenant(() => w.notify.prefs.save({ userId: w.owner }, { quietHours: { enabled: true, from: '22:00', to: '07:00', timezone: 'Asia/Kolkata' } }));
  try {
    w.clock.set('2026-11-12T23:30:00+05:30');
    const calm = await emit({ event: 'token.expiring', key: 'quiet:expiring', data: { account: 'Instagram', days: 7 } });
    const urgent = await emit({ event: 'token.invalid', key: 'quiet:invalid', data: { account: 'Instagram' } });
    await worker.drain();
    const pushes = await accepted(w, owner.devices[0].token);
    assert.deepEqual(pushes.map((p) => p.data.kind), ['token.invalid'], 'the critical one at once, at night');
    assert.equal((await whatsappsTo(w, owner.phone)).length, 1, 'and its WhatsApp');
    assert.deepEqual((await emailsTo(w, owner.email)).map((m) => m.subject.split(' |')[0]).sort(), ['Reconnect Instagram now', 'Reconnect Instagram soon'], 'email wakes nobody: never held');
    const held = await deliveryOf(w, calm, 'push');
    assert.deepEqual([held.status, new Date(held.next_attempt_at).toISOString()], ['queued', new Date('2026-11-13T07:00:00+05:30').toISOString()]);
    assert.equal((await deliveryOf(w, urgent, 'push')).status, 'sent');

    w.clock.set('2026-11-13T06:59:00+05:30');
    await worker.drain();
    assert.equal((await accepted(w, owner.devices[0].token)).length, 1, 'still quiet');
    w.clock.set('2026-11-13T07:00:00+05:30');
    await worker.drain();
    assert.deepEqual((await accepted(w, owner.devices[0].token)).map((p) => p.data.kind), ['token.invalid', 'token.expiring'], 'it goes when they end');

    // Quiet hours that begin after an event was handed out still hold its push, and do not count it as a try.
    w.clock.set('2026-11-13T21:59:30+05:30');
    const late = await emit({ event: 'token.expiring', key: 'quiet:late', data: { account: 'Instagram', days: 3 } });
    await worker.dispatch({ send: false });
    await w.sql(`UPDATE notification_prefs SET quiet_from = '21:00' WHERE tenant_id = $1 AND user_id = $2`, [w.tenant.id, w.owner]);
    await worker.drain();
    const waiting = await deliveryOf(w, late, 'push');
    assert.deepEqual([waiting.status, waiting.attempt], ['queued', 0]);
  } finally {
    await w.inTenant(() => w.notify.prefs.save({ userId: w.owner }, { quietHours: { enabled: false, from: '22:00' } }));
  }
});

test('someone removed from the business gets nothing more from it, deliveries already queued included', async () => {
  await reset();
  const worker = w.worker();
  const staffId = await addUser(w, { role: 'staff', permissions: ['orders'] });
  const staff = await connect(w, { userId: staffId });
  const first = await order();
  await worker.drain();
  assert.equal((await deliveryOf(w, (await w.sql(`SELECT id FROM notification_events WHERE event_key = $1 AND kind = 'order.new'`, [`order:${first.id}`]))[0].id, 'push', staffId)).status, 'queued');
  await w.sql('UPDATE users SET removed_at = now() WHERE id = $1', [staffId]);
  w.clock.advance(n.NOTIFY_RULES.collapseHoldMs);
  await worker.drain();
  const [ev] = await w.sql(`SELECT id FROM notification_events WHERE event_key = $1 AND kind = 'order.new'`, [`order:${first.id}`]);
  assert.deepEqual([(await deliveryOf(w, ev.id, 'push', staffId)).status, (await deliveryOf(w, ev.id, 'push', staffId)).reason], ['dropped', 'removed']);
  assert.equal((await deliveryOf(w, ev.id, 'push', w.owner)).status, 'sent', 'the owner still hears');
  assert.deepEqual(await received(w, staff.devices[0].token), []);
  assert.equal((await emailsTo(w, staff.email)).length, 1, 'the email for the first order went before they were removed');

  const second = await order();
  w.clock.advance(n.NOTIFY_RULES.collapseHoldMs);
  await worker.drain();
  const [next] = await w.sql(`SELECT id FROM notification_events WHERE event_key = $1 AND kind = 'order.new'`, [`order:${second.id}`]);
  assert.deepEqual((await deliveriesOf(w, next.id)).filter((d) => d.user_id === staffId), [], 'not even a row');
  assert.deepEqual(await received(w, staff.devices[0].token), []);
  assert.equal((await emailsTo(w, staff.email)).length, 1, 'and no email');
  assert.deepEqual(await w.sql('SELECT 1 FROM notifications WHERE user_id = $1 AND event_id = $2', [staffId, next.id]), []);
});

test('a revoked device, or one that signed out, gets nothing further; the person\'s other device still does', async () => {
  await reset();
  const worker = w.worker();
  const managerId = await addUser(w, { role: 'manager' });
  const person = await connect(w, { userId: managerId, devices: ['android', 'ios'] });
  const [phone, tablet] = person.devices;
  await w.sql('UPDATE auth_devices SET revoked_at = now() WHERE person_id = $1 AND device_id = $2', [person.personId, phone.id]);
  const one = await emit({ event: 'token.invalid', key: 'devices:1', audience: { userId: managerId } });
  await worker.drain();
  assert.deepEqual(await received(w, phone.token), [], 'the revoked device');
  assert.equal((await accepted(w, tablet.token)).length, 1, 'the other one');
  assert.equal((await deliveryOf(w, one, 'push')).status, 'sent');
  const [gone] = await w.sql('SELECT deleted_at, delete_reason, token_enc FROM push_devices WHERE person_id = $1 AND device_id = $2', [person.personId, phone.id]);
  assert.deepEqual([Boolean(gone.deleted_at), gone.delete_reason, gone.token_enc], [true, 'device_revoked', null]);

  // Signing out of the tablet revokes its family: nothing more goes there either, and the log says why.
  await w.sql(`UPDATE token_families SET revoked_at = now(), revoke_reason = 'signed_out' WHERE id = $1`, [tablet.familyId]);
  const two = await emit({ event: 'token.invalid', key: 'devices:2', audience: { userId: managerId } });
  await worker.drain();
  assert.equal((await received(w, tablet.token)).length, 1, 'no second push to the tablet');
  assert.deepEqual([(await deliveryOf(w, two, 'push')).status, (await deliveryOf(w, two, 'push')).reason], ['dropped', 'no_address']);
  assert.equal((await deliveryOf(w, two, 'email')).status, 'sent', 'email still reaches them');

  // Signed in again on that device: pushes resume once the app registers its token again.
  const back = await signInDevice(w, { personId: person.personId, userId: managerId, platform: 'ios', id: tablet.id });
  const res = await fetch(`${w.app.base}/api/v1/push/devices`, { method: 'POST', headers: back.headers, body: JSON.stringify({ deviceId: back.id, platform: 'ios', token: tablet.token }) });
  assert.equal(res.status, 204);
  const three = await emit({ event: 'token.invalid', key: 'devices:3', audience: { userId: managerId } });
  await worker.drain();
  assert.equal((await deliveryOf(w, three, 'push')).status, 'sent');
});

test('F-58: a token alert email is Bhava-branded, from Bhava\'s sender, with the business logo only as the workspace badge', async () => {
  await reset();
  const worker = w.worker();
  const logo = 'https://cdn.example/shop-logo.png';
  await w.app.repos.brandKit.save({ logoUrl: logo });
  await w.inTenant(() => w.app.repos.alerts.raise({ kind: 'token.expiring', severity: 'warning', message: 'Your Instagram connection ends in 7 days.', target: 'instagram:ME', dedupeKey: 'expiry_7d:ME:1' }));
  await worker.drain();
  const [mail] = await emailsTo(w, owner.email);
  assert.ok(mail, 'the alert became an email');
  assert.equal(mail.from, `Bhava <${PLATFORM_FROM}>`);
  assert.equal(n.sellerEmailProblem({ from: PLATFORM_FROM, html: mail.html }, { platformFrom: PLATFORM_FROM }), null);
  assert.match(mail.subject, /^Reconnect Instagram soon/);
  assert.match(mail.html, /The connection runs out in 7 days/);
  const images = mail.html.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(images.length, 1);
  assert.ok(images[0].includes(n.WORKSPACE_BADGE) && images[0].includes(logo), 'the logo, once, as the workspace badge');
  assert.match(mail.html, new RegExp(`href="https?://[^"]+/admin/settings/instagram"`), 'a direct link to the record in the console');
  assert.equal(/background(-image)?\s*:[^;"']*url\(/i.test(mail.html), false);
  const [alert] = await w.sql(`SELECT notified_at FROM alerts WHERE tenant_id = $1 AND dedupe_key = 'expiry_7d:ME:1'`, [w.tenant.id]);
  assert.ok(alert.notified_at, 'the alert is marked as taken');
  await worker.drain();
  assert.equal((await emailsTo(w, owner.email)).length, 1, 'and taken once');
});

test('F-88: the weekly report email is the report, Bhava-branded and from Bhava\'s sender; its row follows the delivery', async () => {
  await reset();
  const worker = w.worker();
  const logo = 'https://cdn.example/shop-logo.png';
  await w.app.repos.brandKit.save({ logoUrl: logo });
  const [run] = await w.sql(`INSERT INTO report_runs (tenant_id, kind, period_start, period_end, status) VALUES ($1, 'weekly', '2026-11-02', '2026-11-08', 'sent') RETURNING id`, [w.tenant.id]);
  const body = emailHtml({ businessName: 'Test store', logoUrl: logo, title: 'Your week on Instagram', intro: '2 to 8 November.', sections: [{ heading: 'Reach', text: 'Up 12% on last week.' }], footer: 'Sent by Bhava.' });
  const insert = (channel, userId, to) => w.sql(
    `INSERT INTO report_deliveries (tenant_id, report_run_id, channel, user_id, to_address, subject, body) VALUES ($1, $2, $3, $4, $5, 'Your Bhava weekly report', $6) RETURNING id`,
    [w.tenant.id, run.id, channel, userId, to, body],
  ).then(([r]) => r.id);
  const mailRow = await insert('email', w.owner, owner.email);
  const pushRow = await insert('push', w.owner, '');
  const outside = await insert('email', null, 'accounts@firm.example');
  await worker.drain();

  const [mail] = await emailsTo(w, owner.email);
  assert.equal(mail.subject, 'Your Bhava weekly report');
  assert.match(mail.html, /Up 12% on last week/, 'the report itself');
  assert.equal(mail.from, `Bhava <${PLATFORM_FROM}>`);
  assert.equal(n.sellerEmailProblem({ from: PLATFORM_FROM, html: mail.html }, { platformFrom: PLATFORM_FROM }), null, 'the logo is the workspace badge');
  const [push] = await accepted(w, owner.devices[0].token);
  assert.deepEqual([push.title, push.data.link], ['Your weekly report is ready', `/reports/${run.id}`]);
  const [firm] = await emailsTo(w, 'accounts@firm.example');
  assert.ok(firm, 'an outside address gets the report from Bhava\'s sender too');
  assert.equal(n.sellerEmailProblem({ from: PLATFORM_FROM, html: firm.html }, { platformFrom: PLATFORM_FROM }), null);
  const rows = await w.sql('SELECT id, status, notified_at FROM report_deliveries WHERE id = ANY($1::bigint[]) ORDER BY id', [[mailRow, pushRow, outside]]);
  assert.deepEqual(rows.map((r) => [r.status, Boolean(r.notified_at)]), [['sent', true], ['sent', true], ['sent', true]]);
  assert.deepEqual(await w.sql(`SELECT kind FROM notifications WHERE event_id IN (SELECT id FROM notification_events WHERE event_key LIKE 'report_delivery:%')`), [], 'a report delivery is for its one channel');

  // A report row with an attachment cannot go by this sender: it is marked failed, never sent half.
  const [attached] = await w.sql(`INSERT INTO report_deliveries (tenant_id, report_run_id, channel, user_id, to_address, subject, body, attachment_key, attachment_name) VALUES ($1, $2, 'email', NULL, 'files@firm.example', 's', $3, 'k', 'a.csv') RETURNING id`, [w.tenant.id, run.id, body]);
  await worker.drain();
  assert.equal((await w.sql('SELECT status FROM report_deliveries WHERE id = $1', [attached.id]))[0].status, 'failed');
  assert.deepEqual(await emailsTo(w, 'files@firm.example'), []);
});

test('an outbox row that names no kind is set aside and never holds up the events after it', async () => {
  await reset();
  const worker = w.worker();
  const [odd] = await w.sql(`INSERT INTO notification_events (tenant_id, kind, event_key, audience) VALUES ($1, 'billing.invoice_ready', 'odd:1', '"owner"') RETURNING id`, [w.tenant.id]);
  const fine = await emit({ event: 'dm.usage_100', key: 'after-odd:1' });
  await worker.drain();
  assert.deepEqual(await deliveriesOf(w, odd.id), []);
  assert.ok((await w.sql('SELECT fanned_out_at FROM notification_events WHERE id = $1', [odd.id]))[0].fanned_out_at, 'looked at once');
  assert.equal((await deliveryOf(w, fine, 'push')).status, 'sent');
});

test('alerts: a mapped kind becomes a notification for its own audience; any other stays in the alerts list only', async () => {
  await reset();
  const worker = w.worker();
  const inboxStaff = await addUser(w, { role: 'staff', permissions: ['inbox'] });
  const ordersStaff = await addUser(w, { role: 'staff', permissions: ['orders'] });
  await w.inTenant(() => w.app.repos.alerts.raise({ kind: 'thread.handoff', severity: 'info', message: 'Someone asked for a person.', target: '41', dedupeKey: 'handoff:41:1' }));
  await w.inTenant(() => w.app.repos.alerts.raise({ kind: 'shopify.reconnect', severity: 'critical', message: 'Reconnect Shopify.', target: 'shopify', dedupeKey: 'shopify-reconnect:1' }));
  await worker.drain();
  const [handoff] = await w.sql(`SELECT id, data, link, audience FROM notification_events WHERE tenant_id = $1 AND kind = 'needs_human' AND event_key LIKE 'alert:%'`, [w.tenant.id]);
  assert.deepEqual([handoff.link, handoff.audience, handoff.data.threadId], ['/inbox/needs-human', 'inbox', 41]);
  const people = (await w.sql('SELECT user_id FROM notifications WHERE event_id = $1 ORDER BY user_id', [handoff.id])).map((r) => r.user_id);
  assert.ok(people.includes(inboxStaff) && people.includes(w.owner) && !people.includes(ordersStaff), 'owners, managers and staff with inbox');
  assert.deepEqual(await w.sql(`SELECT 1 FROM notification_events WHERE tenant_id = $1 AND event_key IN (SELECT 'alert:' || id FROM alerts WHERE kind = 'shopify.reconnect')`, [w.tenant.id]), []);
  assert.ok((await w.sql(`SELECT notified_at FROM alerts WHERE kind = 'shopify.reconnect' AND tenant_id = $1`, [w.tenant.id]))[0].notified_at, 'stamped, so it is looked at once');
});
