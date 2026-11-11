// Phase 5 contract: the notifications framework (PRD 5.13) and owner push (10.5). What the tracks build against:
// the kinds and their rules as data, the tables, ctx.notify (emit, sendCode, prefs, the delivery log), the routes and
// who answers them, and the one rule that keeps sellers' and shoppers' messages apart.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as accounts from '../../../src/contracts/accounts.js';
import { OWNER_APP_SCHEME, SIGNED_IN, routeList, routes } from '../../../src/contracts/api/index.js';
import * as n from '../../../src/contracts/notifications.js';
import { ORDER_EVENTS } from '../../../src/contracts/orders.js';
import { MODULES } from '../../../src/modules/index.js';
import { PrefsError, createNotify } from '../../../src/modules/notifications/index.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { createPlatform } from '../../../src/platform/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { registerJobs } from '../../../src/worker.js';
import { createWhatsApp } from '../../../tools/sim/whatsapp/index.mjs';
import { placeOrder } from '../../p4/contract/support.js';
import { OWNER, sellerCodeFor, startApp } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ROUTES = ['notifications.list', 'notifications.markRead', 'notifications.prefs', 'notifications.savePrefs', 'push.register', 'push.unregister'];
const KINDS = [
  'order.new', 'order.cod_to_confirm', 'token.expiring', 'token.invalid', 'dm.usage_80', 'dm.usage_100', 'needs_human', 'reach_guard.alert', 'payment.failed',
  'return.requested', 'report.weekly', 'report.monthly', 'staff.changed', 'device.signed_in', 'account.deletion_requested', 'app.review_state',
];

let app;
let whatsapp;
let ownerId;
const inTenant = (fn) => withTenant(app.tenant, fn);
const sql = (text, params) => app.db.platform.query(text, params);

before(async () => {
  whatsapp = createWhatsApp({ token: 'platform-token' });
  await whatsapp.start();
  app = await startApp({ overrides: { whatsappBaseUrl: whatsapp.url, platformWhatsappPhoneId: '1000', platformWhatsappToken: 'platform-token' } });
  ownerId = (await app.repos.users.findByPhone(OWNER.phone)).id;
});
after(async () => {
  app?.ctx.notify.close();
  app?.close();
  await whatsapp?.close();
});

test('the kinds are data: sixteen seeded, each with channels, wording for one and many, a layout, a template and a link', () => {
  assert.deepEqual(n.NOTIFY_CHANNELS, ['push', 'email', 'whatsapp', 'inapp']);
  assert.deepEqual([...n.NOTIFY_KINDS].sort(), [...KINDS].sort());
  for (const kind of n.NOTIFY_KINDS) {
    const spec = n.NOTIFY_EVENTS[kind];
    assert.equal(n.wordingProblem(kind), null, kind);
    for (const field of ['label', 'audience', 'channels', 'critical', 'collapse', 'mandatory', 'one', 'many', 'email', 'whatsapp', 'link']) assert.ok(field in spec, `${kind}.${field}`);
    assert.ok(n.NOTIFY_AUDIENCES.includes(spec.audience), kind);
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.channels));
    assert.equal(n.isReservedKind(kind), false);
  }
  // Reserved for Phase 7, and not a kind until its row is added.
  assert.equal(n.isReservedKind('billing.invoice_ready'), true);
  assert.equal(Object.keys(n.NOTIFY_EVENTS).some((kind) => kind.startsWith('billing.')), false);

  // Critical kinds are never held: not to collapse, not for quiet hours. A cash on delivery order is one of them (P-20).
  assert.deepEqual(n.NOTIFY_KINDS.filter((k) => n.NOTIFY_EVENTS[k].critical).sort(), ['account.deletion_requested', 'device.signed_in', 'dm.usage_100', 'order.cod_to_confirm', 'reach_guard.alert', 'token.invalid']);
  assert.deepEqual(n.NOTIFY_KINDS.filter((k) => n.NOTIFY_EVENTS[k].collapse).sort(), ['needs_human', 'order.new', 'payment.failed', 'return.requested']);
  assert.deepEqual(n.NOTIFY_EVENTS['order.new'].channels.filter((c) => ['push', 'email'].includes(c)), ['push', 'email'], 'F-56: a new order is push and email');
  assert.deepEqual(n.wordingFor('order.new', { count: 5 }), { title: '5 new orders', body: 'Tap to see them.' }, 'P-21');
  assert.equal(n.wordingFor('order.new', { values: { orderNumber: 'MM-1001' } }).body, 'Order MM-1001 is in. Tap to see it.');
  assert.equal(n.wordingFor('order.new').body, 'Order is in. Tap to see it.', 'a missing value leaves nothing behind');
  assert.throws(() => n.wordingFor('order.imagined'), /not a notification kind/);

  // The numbers the design is held to.
  assert.deepEqual([n.NOTIFY_RULES.dedupeMs, n.NOTIFY_RULES.maxAttempts, n.NOTIFY_RULES.collapseMs], [600_000, 3, 60_000]);
  assert.ok(n.NOTIFY_RULES.collapseHoldMs >= 40_000 && n.NOTIFY_RULES.collapseHoldMs + 2 * n.NOTIFY_RULES.pollMs <= 60_000, 'five orders in 40 s are one push (P-21), and it still leaves inside 60 s (F-56)');
  assert.ok(n.NOTIFY_RULES.pollMs * 2 <= 30_000, 'a critical push leaves inside 30 s (P-20)');
  assert.deepEqual([n.nextAttemptAt(1, new Date(0)).getTime(), n.nextAttemptAt(2, new Date(0)).getTime(), n.nextAttemptAt(3, new Date(0))], [30_000, 120_000, null], 'F-59: three tries, then failed');
  assert.deepEqual(n.DELIVERY_STATUSES, ['queued', 'sent', 'failed', 'dropped', 'collapsed']);
  assert.deepEqual(n.PUSH_ERROR_KINDS, ['unregistered', 'invalid_token', 'throttled', 'unavailable', 'timeout']);
  assert.deepEqual(n.PUSH_TOKEN_GONE, ['unregistered', 'invalid_token'], 'P-23');

  // The sources name real things.
  for (const kind of [...Object.values(n.NOTIFY_SOURCES.alerts), ...Object.values(n.NOTIFY_SOURCES.orderEvents), ...Object.values(n.NOTIFY_SOURCES.reportPeriods)]) assert.ok(n.NOTIFY_EVENTS[kind], kind);
  for (const type of Object.keys(n.NOTIFY_SOURCES.orderEvents)) assert.ok(ORDER_EVENTS.includes(type), type);
  assert.deepEqual(n.CODE_PURPOSES, accounts.CODE_PURPOSES);
  assert.equal(n.OWNER_APP_LINK_SCHEME, OWNER_APP_SCHEME);
});

test('the wording rules are checks: nothing personal in a push, ids only in data, Bhava\'s brand and one workspace badge in an email', () => {
  const data = { tenantId: 7, kind: 'order.new', link: '/orders/12', eventId: 3, count: 1 };
  assert.equal(n.pushProblem({ title: 'New order', body: 'Order MM-1001 is in. Tap to see it.', data }), null);
  for (const [body, why] of [
    ['Asha ordered. Call 98765 43210', /phone/], ['Call +91-9876543210 now', /phone/], ['Send to asha@example.com', /email/],
    ['Paid ₹1,499 by UPI', /payment/], ['Rs. 500 is due', /payment/], ['Deliver to 12 Lake Road', /address/], ['Pincode 411001', /address/],
  ]) assert.match(n.pushProblem({ title: 'New order', body, data }), why, body);
  assert.match(n.pushProblem({ title: '', body: 'x', data }), /title/);
  assert.match(n.pushProblem({ title: 'New order', data: { ...data, tenantId: undefined } }), /tenantId/, 'P: every push carries tenantId');
  assert.match(n.pushProblem({ title: 'New order', data: { ...data, link: 'https://elsewhere.example/x' } }), /deep link/);
  assert.match(n.pushProblem({ title: 'New order', data: { ...data, customerName: 'Asha' } }), /customerName/, 'P-22: nothing else rides along');
  assert.deepEqual(n.PUSH_DATA_KEYS, ['tenantId', 'link', 'kind', 'eventId', 'count']);

  assert.equal(n.dataProblem({ orderId: 12, orderNumber: 'MM-1001', percent: 80, cod: true, account: 'Instagram' }), null);
  for (const bad of [{ customerName: 'Asha' }, { phone: '9876543210' }, { note: 'Leave at the door' }, { ref: '+919876543210' }, { orderId: 1.5 }, { items: [1] }, { address: { city: 'Pune' } }, { email: 'a@b.example' }, null, [1]]) {
    assert.notEqual(n.dataProblem(bad), null, JSON.stringify(bad));
  }

  // Links: one path, two forms.
  assert.deepEqual([n.linkFor('order.new', { orderId: 12 }), n.linkFor('order.new', {}), n.linkFor('order.new', { orderId: '../admin' })], ['/orders/12', '/orders', '/orders']);
  assert.deepEqual([n.appLink('/orders/12'), n.consoleLink('/orders/12'), n.consoleLink('/')], ['bhavabusiness://orders/12', '/admin/orders/12', '/admin']);
  for (const bad of ['orders/12', '//evil.example', '/orders//12', 'https://x.example', '/Orders', '/orders?x=1', '']) assert.equal(n.isLinkPath(bad), false, bad);

  // F-58, F-88: Bhava-branded, from Bhava's sender; the business logo only as the workspace badge.
  const platformFrom = 'alerts@mail.bhava.example';
  const logo = `<img ${n.BRAND_LOGO} src="https://cdn.example/bhava.png" alt="Bhava">`;
  const badge = `<img ${n.WORKSPACE_BADGE} src="https://cdn.example/shop-logo.png" alt="">`;
  assert.equal(n.sellerEmailProblem({ from: platformFrom, html: `${logo}${badge}<p>Reconnect your account. Bhava</p>` }, { platformFrom }), null);
  assert.match(n.sellerEmailProblem({ from: 'orders@shop.example', html: `${logo}<p>Bhava</p>` }, { platformFrom }), /sender/);
  assert.match(n.sellerEmailProblem({ from: platformFrom, html: '<p>Your weekly report</p>' }, { platformFrom }), /Bhava-branded/);
  assert.match(n.sellerEmailProblem({ from: platformFrom, html: `${logo}${badge}${badge}<p>Bhava</p>` }, { platformFrom }), /once/);
  assert.match(n.sellerEmailProblem({ from: platformFrom, html: `${logo}<img src="https://cdn.example/shop-banner.png"><p>Bhava</p>` }, { platformFrom }), /only images/);
  assert.match(n.sellerEmailProblem({ from: platformFrom, html: `<div style="background-image: url(https://cdn.example/shop.png)">Bhava</div>` }, { platformFrom }), /background/);
  assert.match(n.sellerEmailProblem({ from: platformFrom, html: 'Bhava' }, {}), /sender/, 'with no platform sender set, nothing passes');
});

test('preferences: per kind and channel, in-app always on, security notices fixed, and quiet hours never delay a critical kind', () => {
  const defaults = n.resolvePrefs();
  assert.deepEqual(Object.keys(defaults.events).sort(), [...KINDS].sort());
  assert.deepEqual(defaults.events['order.new'], { push: true, email: true, whatsapp: false, inapp: true });
  assert.deepEqual(defaults.quietHours, { enabled: false, from: '22:00', to: '07:00', timezone: 'Asia/Kolkata' });

  const chosen = n.resolvePrefs({
    quietHours: { enabled: true, from: '21:00', to: '08:00', timezone: 'Asia/Kolkata' },
    events: { 'order.new': { email: false, inapp: false, whatsapp: true }, 'device.signed_in': { push: false, email: false }, needs_human: { whatsapp: true } },
  });
  assert.deepEqual(chosen.events['order.new'], { push: true, email: false, whatsapp: true, inapp: true }, 'in-app cannot be switched off');
  assert.deepEqual(chosen.events['device.signed_in'], defaults.events['device.signed_in'], 'a security notice keeps its channels');
  assert.equal(chosen.events.needs_human.whatsapp, false, 'no template, no WhatsApp');
  assert.equal(n.prefProblem('order.new', 'email', false), null);
  assert.match(n.prefProblem('order.new', 'inapp', false), /always on/);
  assert.match(n.prefProblem('staff.changed', 'email', false), /cannot be changed/);
  assert.match(n.prefProblem('needs_human', 'whatsapp', true), /WhatsApp/);
  assert.equal(n.prefProblem('order.imagined', 'push', true), 'invalid');

  const night = new Date('2026-11-11T23:30:00+05:30');
  const day = new Date('2026-11-11T12:00:00+05:30');
  const eight = new Date('2026-11-12T08:00:00+05:30');
  assert.equal(n.quietUntil(chosen.quietHours, night).toISOString(), eight.toISOString());
  assert.equal(n.quietUntil(chosen.quietHours, day), null);
  assert.equal(n.quietUntil({ ...chosen.quietHours, enabled: false }, night), null);
  assert.equal(n.quietUntil({ enabled: true, from: '13:00', to: '15:00', timezone: 'UTC' }, new Date('2026-11-11T14:00:00Z')).toISOString(), '2026-11-11T15:00:00.000Z');

  // Not urgent, at night: push waits for the morning; email and in-app do not.
  assert.equal(n.deliverAt('token.expiring', 'push', chosen, night).toISOString(), eight.toISOString());
  assert.equal(n.deliverAt('token.expiring', 'email', chosen, night).getTime(), night.getTime());
  assert.equal(n.deliverAt('token.expiring', 'inapp', chosen, night).getTime(), night.getTime());
  // Critical, at night: now, on every channel.
  for (const kind of n.NOTIFY_KINDS.filter((k) => n.NOTIFY_EVENTS[k].critical)) {
    for (const channel of n.NOTIFY_CHANNELS.filter((c) => chosen.events[kind][c])) assert.equal(n.deliverAt(kind, channel, chosen, night).getTime(), night.getTime(), `${kind} on ${channel}`);
  }
  // A kind that collapses holds its push; a switched-off channel gets nothing.
  assert.equal(n.deliverAt('order.new', 'push', chosen, day).getTime(), day.getTime() + n.NOTIFY_RULES.collapseHoldMs);
  assert.equal(n.deliverAt('order.new', 'email', chosen, day), null);
  assert.equal(n.collapseKeyFor({ tenantId: 7, kind: 'order.new', groupId: 41 }), 't7.order.new.41');
});

test('notifications has a folder, comes right after alerts, and answers exactly its six routes', () => {
  const names = MODULES.map((m) => m.name);
  assert.ok(fs.existsSync(path.join(repoRoot, 'src/modules/notifications/index.js')));
  assert.equal(names.indexOf('notifications'), names.indexOf('alerts') + 1);
  assert.deepEqual(routeList.filter((r) => ['notifications', 'push'].includes(r.id.split('.')[0])).map((r) => r.id).sort(), [...ROUTES].sort());
  for (const module of MODULES) {
    if (module.name === 'notifications' || !module.api) continue;
    const ids = Object.keys(module.api({ repos: {}, config: {}, ig: {}, auth: {}, db: {}, platform: {}, providers: {}, notify: {} }) ?? {});
    assert.deepEqual(ids.filter((id) => ROUTES.includes(id)), [], `${module.name} answers none of them`);
  }
  assert.deepEqual(Object.keys(MODULES.find((m) => m.name === 'notifications').api()).sort(), [...ROUTES].sort());
  for (const id of ROUTES) {
    assert.equal(routes[id].access, SIGNED_IN, `${id}: a person's own list, choices and devices`);
    assert.equal(routes[id].fresh ?? routes[id].noBusiness ?? routes[id].consoleOnly, undefined, id);
    assert.ok((routes[id].path.match(/:/g) ?? []).length <= 1 && (!routes[id].path.includes(':') || routes[id].path.includes(':id')), id);
  }
  // Nobody reads or changes another person's: no route takes a user id.
  for (const id of ROUTES) for (const part of ['params', 'query', 'body']) assert.equal(JSON.stringify(routes[id][part]?.shape ?? {}).includes('userId'), false, id);
  assert.equal(routes['push.register'].body.safeParse({ deviceId: 'device-0123456789abcdef', platform: 'web', token: 'x'.repeat(40) }).success, false, 'push is android or ios');
  assert.equal(routes['push.register'].body.safeParse({ deviceId: 'device-0123456789abcdef', platform: 'ios', token: 'a1b2'.repeat(16), appVersion: '1.0.0' }).success, true);
  assert.equal(routes['notifications.markRead'].body.safeParse({ all: true }).success, true);
  assert.equal(routes['notifications.markRead'].body.safeParse({ ids: [] }).success, false);
  assert.equal(routes['notifications.savePrefs'].body.safeParse({ events: { 'order.new': { email: false } } }).success, true);
  assert.equal(routes['notifications.savePrefs'].body.safeParse({ events: { 'order.imagined': { email: false } } }).success, false);
  assert.equal(routes['notifications.savePrefs'].body.safeParse({}).success, false);
});

test('nothing outside the notifications module calls the push adapter, the platform WhatsApp sender or the platform email sender', () => {
  const offenders = [];
  // Where they are made (the adapters), and the one module that may call them.
  const allowed = (rel) => rel.startsWith('src/modules/notifications/') || rel.startsWith('src/adapters/push/') || rel.startsWith('src/adapters/whatsapp/') || rel.startsWith('src/adapters/email/');
  const calls = /adapters\/push|createPush\b|\bPushError\b|whatsapp\??\.platform\b|email\??\.platform\b|\.platform\??\.send\(|platformSender|forCredentials\(/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full).replaceAll('\\', '/');
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|jsx)$/.test(entry.name) && !allowed(rel)) {
        const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        if (calls.test(source)) offenders.push(rel);
      }
    }
  };
  walk(path.join(repoRoot, 'src'));
  assert.deepEqual(offenders, [], 'a message to a seller goes through ctx.notify');
  // And the module itself never reaches for a shopper: it holds no call to the shopper gate or the business\'s own WhatsApp account.
  for (const file of fs.readdirSync(path.join(repoRoot, 'src/modules/notifications'))) {
    const source = fs.readFileSync(path.join(repoRoot, 'src/modules/notifications', file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.equal(/shopperMessages|\.sendTemplate\(|whatsapp_accounts|FROM shoppers/.test(source), false, `${file} has no path to a shopper`);
  }
});

test('the app and the worker both carry ctx.notify, and each channel reports whether it is set up', async () => {
  for (const name of ['emit', 'sendCode', 'channels']) assert.equal(typeof app.ctx.notify[name], 'function', name);
  for (const name of ['get', 'save']) assert.equal(typeof app.ctx.notify.prefs[name], 'function', name);
  assert.equal(typeof app.ctx.notify.deliveries.list, 'function');
  assert.deepEqual(app.ctx.notify.channels(), { push: { android: false, ios: false }, email: false, whatsapp: true, inapp: true }, 'push and email are not set up here; WhatsApp and in-app still deliver');

  const drivers = createPlatform(app.config, { db: app.db });
  const schedule = registerJobs({ db: app.db, platform: { ...drivers, queue: { ...drivers.queue, work() {} } }, config: app.config });
  assert.equal(typeof schedule.context.notify.emit, 'function');
  schedule.context.notify.close();

  const bare = createNotify({ db: app.db, providers: {}, config: {} });
  assert.deepEqual(bare.channels(), { push: { android: false, ios: false }, email: false, whatsapp: false, inapp: true });
  assert.deepEqual(await bare.sendCode({ to: '9876500011', code: '123456', purpose: 'signin' }), { outcome: 'failed', reason: 'not_configured', retryable: false });
});

test('the tables: four fenced tenant tables and push_devices for the platform alone, with the rules in the database', async () => {
  const rows = await sql(
    `SELECT c.relname AS name, has_table_privilege('bhava_app', c.oid, 'SELECT') AS app_reads, has_table_privilege('bhava_app', c.oid, 'DELETE') AS app_deletes, c.relrowsecurity AS fenced
     FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r'`,
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const name of ['notification_events', 'notification_deliveries', 'notifications', 'notification_prefs']) {
    assert.deepEqual([byName.get(name)?.app_reads, byName.get(name)?.fenced], [true, true], `${name} is a business table, fenced`);
  }
  for (const name of ['notification_events', 'notification_deliveries', 'notifications']) assert.equal(byName.get(name).app_deletes, false, `${name}: the log is not deleted by business code`);
  assert.deepEqual([byName.get('push_devices')?.app_reads, byName.get('push_devices')?.fenced], [false, false], 'push_devices is the platform\'s alone');
  await assert.rejects(() => inTenant(() => app.db.query('SELECT 1 FROM push_devices')), /permission denied/);

  const other = await app.platform.tenants.ensure({ slug: 'other', name: 'Other store' });
  const [stranger] = await sql(`INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1, 'Staff', '9000000009', 'x', 'owner') RETURNING id`, [other.id]);
  const event = (key, tenant = app.tenant.id) => sql(`INSERT INTO notification_events (tenant_id, kind, event_key, audience) VALUES ($1, 'order.new', $2, '"orders"') RETURNING id`, [tenant, key]).then(([r]) => r.id);
  const first = await event('order:1');
  await assert.rejects(() => event('order:1'), /unique|duplicate/, 'one live event per business, kind and key');
  await event('order:1', other.id); // another business's key is its own
  await assert.rejects(() => sql(`INSERT INTO notification_events (tenant_id, kind, event_key, audience, data) VALUES ($1, 'order.new', 'k', '"orders"', '[1]')`, [app.tenant.id]), /check/);
  await assert.rejects(() => sql(`INSERT INTO notification_events (tenant_id, kind, event_key, audience, link) VALUES ($1, 'order.new', 'k', '"orders"', 'https://x.example')`, [app.tenant.id]), /check/);
  await assert.rejects(() => sql(`INSERT INTO notification_events (tenant_id, kind, event_key, audience, channels) VALUES ($1, 'order.new', 'k', '"orders"', '{sms}')`, [app.tenant.id]), /check/, 'there is no SMS');
  // One business cannot see another's events, even with no WHERE.
  assert.deepEqual((await inTenant(() => app.db.query('SELECT tenant_id FROM notification_events'))).map((r) => r.tenant_id), [app.tenant.id]);

  const delivery = (eventId, userId, channel, tenant = app.tenant.id) => sql('INSERT INTO notification_deliveries (tenant_id, event_id, user_id, channel) VALUES ($1, $2, $3, $4) RETURNING id', [tenant, eventId, userId, channel]).then(([r]) => r.id);
  const push = await delivery(first, ownerId, 'push');
  await assert.rejects(() => delivery(first, ownerId, 'push'), /unique|duplicate/, 'one delivery per event, recipient and channel');
  await delivery(first, ownerId, 'email');
  await assert.rejects(() => delivery(first, ownerId, 'sms'), /check/);
  await assert.rejects(() => delivery(first, stranger.id, 'inapp'), /foreign key|fkey/, 'never to another business\'s account');
  await assert.rejects(() => delivery(first, ownerId, 'inapp', other.id), /foreign key|fkey/, 'never for another business\'s event');
  await sql('UPDATE notification_deliveries SET attempt = 3 WHERE id = $1', [push]);
  await assert.rejects(() => sql('UPDATE notification_deliveries SET attempt = attempt + 1 WHERE id = $1', [push]), /check/, 'F-59: a fourth try cannot be recorded');
  await assert.rejects(() => sql(`UPDATE notification_deliveries SET status = 'failed' WHERE id = $1`, [push]), /check/, 'a failure says why');
  await assert.rejects(() => sql(`UPDATE notification_deliveries SET status = 'sent' WHERE id = $1`, [push]), /check/, 'sent has a time');
  await assert.rejects(() => sql(`UPDATE notification_deliveries SET status = 'collapsed' WHERE id = $1`, [push]), /check/, 'collapsed names the push that carried it');
  const second = await event('order:2');
  const joined = await delivery(second, ownerId, 'push');
  await sql(`UPDATE notification_deliveries SET status = 'collapsed', collapsed_into = $2 WHERE id = $1`, [joined, push]);
  const mail = await delivery(second, ownerId, 'email');
  await assert.rejects(() => sql(`UPDATE notification_deliveries SET status = 'collapsed', collapsed_into = $2 WHERE id = $1`, [mail, push]), /check/, 'only a push collapses');

  await sql(`INSERT INTO notifications (tenant_id, user_id, event_id, kind, title) VALUES ($1, $2, $3, 'order.new', 'New order')`, [app.tenant.id, ownerId, first]);
  await assert.rejects(() => sql(`INSERT INTO notifications (tenant_id, user_id, event_id, kind, title) VALUES ($1, $2, $3, 'order.new', 'New order')`, [app.tenant.id, ownerId, first]), /unique|duplicate/);
  await assert.rejects(() => sql(`INSERT INTO notifications (tenant_id, user_id, event_id, kind, title) VALUES ($1, $2, $3, 'order.new', 'New order')`, [app.tenant.id, stranger.id, first]), /foreign key|fkey/);
  await assert.rejects(() => sql(`INSERT INTO notification_prefs (tenant_id, user_id, quiet_from) VALUES ($1, $2, '25:00')`, [app.tenant.id, ownerId]), /check/);

  const [person] = await sql(`INSERT INTO people (name) VALUES ('Asha') RETURNING id`);
  const [someone] = await sql(`INSERT INTO people (name) VALUES ('Ravi') RETURNING id`);
  const device = (personId, deviceId, platform, hash) => sql(`INSERT INTO push_devices (person_id, device_id, platform, token_enc, token_hash) VALUES ($1, $2, $3, 'v1.enc', $4) RETURNING id`, [personId, deviceId, platform, hash]).then(([r]) => r.id);
  const phone = await device(person.id, 'device-0123456789abcdef', 'android', 'h1');
  await assert.rejects(() => device(someone.id, 'device-fedcba9876543210', 'ios', 'h1'), /unique|duplicate/, 'a token is one device');
  await assert.rejects(() => device(person.id, 'device-0123456789abcdef', 'ios', 'h2'), /unique|duplicate/, 'a device has one token');
  await assert.rejects(() => device(person.id, 'device-00000000000000aa', 'web', 'h3'), /check/, 'android or ios');
  await assert.rejects(() => sql('UPDATE push_devices SET deleted_at = now() WHERE id = $1', [phone]), /check/, 'a deleted token is wiped and says why');
  await sql(`UPDATE push_devices SET deleted_at = now(), token_enc = NULL, delete_reason = 'unregistered' WHERE id = $1`, [phone]);

  const columns = await sql(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'notified_at'`);
  assert.deepEqual(columns.map((c) => c.table_name).sort(), ['alerts', 'report_deliveries'], 'the two outboxes that were waiting are marked as they are taken');
  await sql('DELETE FROM notification_events WHERE tenant_id = ANY($1::int[])', [[app.tenant.id, other.id]]);
});

test('emit writes one outbox row: the same key inside ten minutes is one event, and it commits or rolls back with its transaction', async () => {
  const { notify } = app.ctx;
  const tenantId = app.tenant.id;
  const id = await notify.emit({ event: 'order.new', tenantId, key: 'order:41', data: { orderId: 41, orderNumber: 'MM-1041' } });
  assert.ok(Number.isInteger(id) && id > 0);
  const [row] = await sql('SELECT tenant_id, kind, event_key, audience, channels, data, link, live, fanned_out_at FROM notification_events WHERE id = $1', [id]);
  assert.deepEqual(row, { tenant_id: tenantId, kind: 'order.new', event_key: 'order:41', audience: 'orders', channels: null, data: { orderId: 41, orderNumber: 'MM-1041' }, link: '/orders/41', live: true, fanned_out_at: null });

  // F-57: the same alert five times in five minutes is one.
  for (let i = 0; i < 5; i++) assert.equal(await notify.emit({ event: 'order.new', tenantId, key: 'order:41', data: { orderId: 41 } }), null);
  assert.equal(await inTenant(() => notify.emit({ event: 'order.new', tenantId, key: 'order:41' })), null, 'inside the business or outside it');
  // Another kind, another key and another business are other events.
  assert.ok(await notify.emit({ event: 'return.requested', tenantId, key: 'order:41', data: { returnId: 3 } }));
  assert.ok(await notify.emit({ event: 'order.new', tenantId, key: 'order:42', audience: { userId: ownerId }, channels: ['email'], link: '/orders' }));
  const other = await app.platform.tenants.ensure({ slug: 'emit-other', name: 'Other store' });
  assert.ok(await notify.emit({ event: 'order.new', tenantId: other.id, key: 'order:41' }));
  // After ten minutes the key is free again.
  await sql(`UPDATE notification_events SET created_at = now() - interval '9 minutes 50 seconds' WHERE id = $1`, [id]);
  assert.equal(await notify.emit({ event: 'order.new', tenantId, key: 'order:41' }), null);
  await sql(`UPDATE notification_events SET created_at = now() - interval '10 minutes 1 second' WHERE id = $1`, [id]);
  const again = await notify.emit({ event: 'order.new', tenantId, key: 'order:41' });
  assert.ok(again > id);
  assert.deepEqual((await sql(`SELECT id, live FROM notification_events WHERE tenant_id = $1 AND kind = 'order.new' AND event_key = 'order:41' ORDER BY id`, [tenantId])).map((r) => [Number(r.id), r.live]), [[id, false], [again, true]]);
  // Two at once: one row.
  const raced = await Promise.all(Array.from({ length: 6 }, () => notify.emit({ event: 'needs_human', tenantId, key: 'thread:9' })));
  assert.equal(raced.filter(Boolean).length, 1);

  // Inside an open transaction: it goes with the change, or not at all.
  await assert.rejects(() => inTenant(() => app.db.tx(async (t) => {
    assert.ok(await notify.emit({ event: 'staff.changed', tenantId, key: 'user:5:removed' }, t));
    throw new Error('the change failed');
  })), /the change failed/);
  assert.deepEqual(await sql(`SELECT 1 FROM notification_events WHERE kind = 'staff.changed'`), []);
  await inTenant(() => app.db.tx((t) => notify.emit({ event: 'staff.changed', tenantId, key: 'user:5:removed' }, t)));
  assert.equal((await sql(`SELECT 1 FROM notification_events WHERE kind = 'staff.changed'`)).length, 1);

  // What a caller may not do. Each is a bug in the caller, so each throws.
  await assert.rejects(() => notify.emit({ event: 'billing.invoice_ready', tenantId, key: 'k' }), /later phase/);
  await assert.rejects(() => notify.emit({ event: 'order.imagined', tenantId, key: 'k' }), /not a notification kind/);
  await assert.rejects(() => notify.emit({ event: 'order.new', key: 'k' }), /tenantId/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId }), /key/);
  await assert.rejects(() => inTenant(() => notify.emit({ event: 'order.new', tenantId: other.id, key: 'k' })), /current business/, 'one business cannot notify another');
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', data: { customerName: 'Asha Rao' } }), /ids and numbers only/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', data: { ref: '+919876543210' } }), /ids and numbers only/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', link: 'https://elsewhere.example' }), /path/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', audience: 'shoppers' }), /audience/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', audience: { shopperId: 4 } }), /audience/, 'a shopper is never an audience');
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k', channels: ['sms'] }), /channels/);
  await assert.rejects(() => notify.emit({ event: 'order.new', tenantId, key: 'k' }, { query: async () => [] }), /withTenant/);
});

test('a seller\'s login code goes from Bhava\'s own WhatsApp number, by template, and never by SMS (F-117)', async () => {
  const { notify } = app.ctx;
  assert.deepEqual(await notify.sendCode({ to: '9876500011', code: '482913', purpose: 'signin' }), { outcome: 'sent', reason: 'ok', retryable: false });
  assert.equal(await sellerCodeFor(whatsapp, '9876500011'), '482913', 'the helper every sign-in test uses finds it');
  const { sent } = await whatsapp.get('/sent');
  assert.deepEqual([sent.at(-1).phoneId, sent.at(-1).to, sent.at(-1).type, sent.at(-1).body.template.name], ['1000', '919876500011', 'template', n.CODE_TEMPLATE]);
  assert.equal((await sql('SELECT count(*)::int AS n FROM whatsapp_accounts'))[0].n, 0, 'no business\'s own WhatsApp account was involved');

  for (const bad of [{ to: 'nobody', code: '482913', purpose: 'signin' }, { to: '9876500011', code: '48291', purpose: 'signin' }, { to: '9876500011', code: '482913', purpose: 'sms' }, {}]) {
    assert.deepEqual(await notify.sendCode(bad), { outcome: 'failed', reason: 'invalid', retryable: false });
  }
  // The provider refuses: no throw, and the reason says what to offer next.
  await whatsapp.fault({ kind: 'rate_limit', status: 400, body: { error: { message: 'Undeliverable', code: 131026 } } });
  assert.deepEqual(await notify.sendCode({ to: '9876500012', code: '111222', purpose: 'reauth' }), { outcome: 'failed', reason: 'no_whatsapp', retryable: false }, 'F-118: offer Google sign-in');
  await whatsapp.fault({ kind: 'rate_limit' });
  assert.deepEqual(await notify.sendCode({ to: '9876500012', code: '111222', purpose: 'signin' }), { outcome: 'failed', reason: 'provider', retryable: true });
  await whatsapp.fault({ kind: 'partial', then: 'server_error' });
  assert.deepEqual(await notify.sendCode({ to: '9876500012', code: '333444', purpose: 'link' }), { outcome: 'failed', reason: 'unknown_delivery', retryable: false }, 'a code that may have gone out is not sent twice');
});

test('prefs.get and prefs.save: per person, kind and channel, kept only where they differ, and never across businesses', async () => {
  const { notify } = app.ctx;
  assert.deepEqual(await inTenant(() => notify.prefs.get({ userId: ownerId })), n.resolvePrefs());
  const saved = await inTenant(() => notify.prefs.save({ userId: ownerId }, { quietHours: { enabled: true, from: '21:30' }, events: { 'order.new': { email: false, push: true }, 'token.invalid': { whatsapp: false } } }));
  assert.deepEqual(saved.quietHours, { enabled: true, from: '21:30', to: '07:00', timezone: 'Asia/Kolkata' });
  assert.deepEqual([saved.events['order.new'].email, saved.events['order.new'].push, saved.events['token.invalid'].whatsapp], [false, true, false]);
  assert.deepEqual(await inTenant(() => notify.prefs.get({ userId: ownerId })), saved);
  assert.deepEqual((await sql('SELECT events FROM notification_prefs WHERE user_id = $1', [ownerId]))[0].events, { 'order.new': { email: false }, 'token.invalid': { whatsapp: false } }, 'a choice equal to the default is not kept');
  // A later save changes only what it names.
  const later = await inTenant(() => notify.prefs.save({ userId: ownerId }, { events: { 'order.new': { email: true } } }));
  assert.deepEqual([later.events['order.new'].email, later.events['token.invalid'].whatsapp, later.quietHours.enabled], [true, false, true]);

  for (const [input, field] of [
    [{ events: { 'order.new': { inapp: false } } }, 'events.order.new.inapp'], [{ events: { 'device.signed_in': { email: false } } }, 'events.device.signed_in.email'],
    [{ events: { needs_human: { whatsapp: true } } }, 'events.needs_human.whatsapp'], [{ events: { 'order.imagined': { push: true } } }, 'events.order.imagined.push'],
    [{ quietHours: { from: '25:00' } }, 'quietHours.from'], [{ quietHours: { timezone: 'Mars/Olympus' } }, 'quietHours.timezone'],
  ]) await assert.rejects(() => inTenant(() => notify.prefs.save({ userId: ownerId }, input)), (err) => err instanceof PrefsError && err.field === field, field);

  await assert.rejects(() => notify.prefs.get({ userId: ownerId }), /tenant context missing/, 'preferences belong to a business');
  const other = await app.platform.tenants.ensure({ slug: 'prefs-other', name: 'Other store' });
  assert.deepEqual(await withTenant(other, () => notify.prefs.get({ userId: ownerId })), n.resolvePrefs(), 'another business sees none of them');
  await assert.rejects(() => withTenant(other, () => notify.prefs.save({ userId: ownerId }, { quietHours: { enabled: true } })), /foreign key|fkey/, 'and cannot save for an account that is not its own');
  assert.deepEqual(await inTenant(() => notify.deliveries.list({ userId: ownerId })), { items: [], nextCursor: null });
});

test('a confirmed order becomes a notification: cash on delivery to confirm, any other a new order, once per order', async () => {
  const product = await app.repos.products.create({ name: 'Brass lamp', price: '500', active: 'on' });
  const w = { tenant: app.tenant, db: app.db, product, inTenant };
  const prepaid = await placeOrder(w);
  const cod = await placeOrder(w, { mode: 'cod' });
  await inTenant(() => app.db.tx((t) => changeOrder(t, prepaid.id, { payment: 'paid', fulfilment: 'new', actor: 'webhook:razorpay' })));
  await inTenant(() => app.db.tx((t) => changeOrder(t, cod.id, { payment: 'cod_due', fulfilment: 'new', actor: 'shopper:1' })));
  await app.ctx.orderEvents.drain();
  const rows = await sql(`SELECT kind, event_key, data, link, audience FROM notification_events WHERE event_key = ANY($1::text[]) ORDER BY id`, [[`order:${prepaid.id}`, `order:${cod.id}`]]);
  assert.deepEqual(rows.map((r) => [r.kind, r.event_key, r.link, r.audience]).sort(), [['order.cod_to_confirm', `order:${cod.id}`, `/orders/${cod.id}`, 'orders'], ['order.new', `order:${prepaid.id}`, `/orders/${prepaid.id}`, 'orders']].sort());
  for (const row of rows) {
    assert.equal(n.dataProblem(row.data), null);
    assert.deepEqual(Object.keys(row.data).sort(), ['orderId', 'orderNumber'], 'P-22: the order\'s id and number, and nothing about who ordered');
  }
  const [delivery] = await sql(`SELECT status FROM order_event_deliveries WHERE listener = 'notifications.orders' AND status <> 'done'`);
  assert.equal(delivery, undefined, 'the listener finished every event it was given');
});
