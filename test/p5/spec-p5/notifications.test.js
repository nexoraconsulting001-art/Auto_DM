// PRD 5.13: one service turns each event into push, email, WhatsApp and in-app for the seller, Bhava-branded and from
// Bhava's sender. A new order reaches the owner by push and email within 60 s, the same alert five times is sent once,
// a failing provider gets three tries and then the delivery is failed, and preferences and quiet hours hold.
// F-56, F-57, F-58, F-59, F-88.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND_LOGO, MINUTE, NOTIFY_RULES, NOTIFY_TABLES, PLATFORM_EMAIL, PLATFORM_PHONE_ID, SECOND, WORKSPACE_BADGE, addMember, addP4Shop, addSeller, appSignIn, atOnce,
  buyer, deliveries, events, ownerApp, registerPush, sellerEmailProblem, setEmail, unique, useP5World,
} from './kit.js';

const world = useP5World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const addressOf = (from) => String(from ?? '').replace(/^.*</, '').replace(/>.*$/, '').trim().toLowerCase();
const ownerEmail = () => `owner${unique()}@seller.example`;
/** How many times the mail provider was asked to send to this address. */
const mailTries = async (address) => (await world.mail.calls({ method: 'POST', path: '/messages' })).filter((c) => JSON.stringify(c.body?.to ?? '').includes(address)).length;

/** A business whose owner is signed in to the app with push on and has an email address. */
async function ownerReady(world, shop) {
  const s = await ownerApp(world, shop);
  const token = await registerPush(s);
  const email = ownerEmail();
  await setEmail(shop, s.user.id, email);
  return { s, token, email, userId: s.user.id };
}

/** Lets a push held to collapse become due, and runs the worker until `check` holds. */
async function pastCollapseHold(check, ms = 12_000) {
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, NOTIFY_TABLES);
  return world.waitFor(check, ms);
}

test('F-56: a new order reaches the owner by push and by email within 60 s', async () => {
  const shop = await addP4Shop(world, { name: 'Tulsi Threads' });
  const owner = await ownerReady(world, shop);
  const product = await shop.item({ pricePaise: 49900 });
  const order = await buyer(world, shop).buy({ lines: [line(product)] });

  const email = await world.waitFor(async () => (await world.platformEmailsTo(owner.email))[0], 15_000);
  assert.ok(email, 'No email reached the owner about the new order');
  assert.equal(addressOf(email.from), PLATFORM_EMAIL, `The new-order email came from ${email.from}`);
  assert.ok(`${email.subject} ${email.html} ${email.text}`.includes(order.order_number), 'The email does not name the order');
  const push = await pastCollapseHold(async () => (await world.pushes(owner.token))[0]);
  assert.ok(push, 'No push reached the owner\'s phone about the new order');
  assert.equal(String(push.data?.tenantId), String(shop.tenantId), 'The push does not carry its business');
  assert.equal(push.data?.link, `/orders/${order.id}`, 'The push does not open the order');

  const rows = await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2`, [owner.userId]);
  for (const channel of ['push', 'email', 'inapp']) {
    const row = rows.find((r) => r.channel === channel);
    assert.ok(row, `No ${channel} delivery for the new order`);
    assert.equal(row.status, 'sent', `The ${channel} delivery is ${row.status}: ${row.reason}`);
    const seconds = (new Date(row.sent_at) - new Date(row.event_at)) / 1000;
    assert.ok(seconds <= 60, `The ${channel} delivery went ${seconds.toFixed(1)} s after the order`);
  }
  // The in-app list holds it for the owner.
  const list = await owner.s.send('GET', '/notifications');
  assert.equal(list.status, 200);
  assert.ok(list.data.items.some((n) => n.kind === 'order.new' && n.link === `/orders/${order.id}`), 'The in-app list has no new-order entry');
  assert.ok(list.data.unread >= 1);
});

test('F-57: the same alert emitted five times in five minutes is one event and one send per channel', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  const notify = world.notify();
  const key = `spec-token-${unique()}`;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } }));
    await world.shift(MINUTE - 5 * SECOND, ['notification_events']);
  }
  assert.ok(ids[0], 'The first emit made no event');
  assert.deepEqual(ids.slice(1), [null, null, null, null], 'A repeat inside ten minutes made another event');
  await world.waitFor(async () => (await world.pushes(owner.token)).length >= 1 && (await world.platformEmailsTo(owner.email)).length >= 1, 12_000);
  await world.waitFor(() => false, 1500);
  assert.equal((await world.pushes(owner.token)).length, 1, 'More than one push for one alert');
  assert.equal((await world.platformEmailsTo(owner.email)).length, 1, 'More than one email for one alert');
  const wa = (await world.sellerMessages(owner.s.phone)).filter((m) => m.type === 'template' && m.body?.template?.name !== 'login_code');
  assert.ok(wa.length <= 1, `${wa.length} WhatsApp alerts for one alert`);
  if (wa[0]) assert.equal(wa[0].phoneId, PLATFORM_PHONE_ID);
  assert.equal((await events(shop, `kind = 'token.invalid' AND event_key = $2`, [key])).length, 1);
});

test('F-57: five emits of one key at the same moment make one event; after ten minutes the key is new again', async () => {
  const shop = await addSeller(world);
  const notify = world.notify();
  const key = `spec-burst-${unique()}`;
  const ids = await atOnce(5, () => notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } }));
  assert.equal(ids.filter(Boolean).length, 1, `${ids.filter(Boolean).length} events from a burst of five with one key`);
  // Just inside the window it is still a repeat; just past it, something that happened again.
  await world.shift(NOTIFY_RULES.dedupeMs - 30 * SECOND, ['notification_events']);
  assert.equal(await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } }), null, 'A repeat at nine and a half minutes');
  await world.shift(31 * SECOND, ['notification_events']);
  assert.ok(await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } }), 'The key a second past ten minutes is still a repeat');
  // The same key in another business is another event.
  const other = await addSeller(world);
  assert.ok(await notify.emit({ event: 'token.invalid', tenantId: other.tenantId, key, data: { account: 'Instagram' } }));
  // Personal data, a kind that does not exist and a reserved kind are refused, not sent.
  for (const bad of [
    { event: 'token.invalid', tenantId: shop.tenantId, key: `k${unique()}`, data: { customerName: 'Asha' } },
    { event: 'token.invalid', tenantId: shop.tenantId, key: `k${unique()}`, data: { ref: '+919876543210' } },
    { event: 'order.imagined', tenantId: shop.tenantId, key: `k${unique()}` },
    { event: 'billing.invoice_ready', tenantId: shop.tenantId, key: `k${unique()}` },
    { event: 'token.invalid', tenantId: shop.tenantId, key: `k${unique()}`, link: 'https://evil.example/x' },
  ]) await assert.rejects(() => notify.emit(bad), JSON.stringify(bad).slice(0, 80));
});

test('F-57: an alert raised five times with one dedupe key notifies once', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  for (let i = 0; i < 5; i++) await shop.repos.alerts.raise({ kind: 'token.invalid', message: 'The Instagram connection stopped working', severity: 'critical', target: 'instagram', dedupeKey: 'spec-token-invalid', audience: 'owner' });
  await world.waitFor(async () => (await world.platformEmailsTo(owner.email)).length >= 1, 12_000);
  await world.waitFor(() => false, 1500);
  assert.equal((await world.platformEmailsTo(owner.email)).length, 1, 'One alert raised five times sent more than one email');
  assert.equal((await events(shop, `kind = 'token.invalid'`)).length, 1);
});

test('F-58: a token alert email is Bhava-branded, from Bhava\'s sender, and the business logo shows only as the workspace badge', async () => {
  const shop = await addSeller(world, { name: 'Saffron Stories' });
  const owner = await ownerReady(world, shop);
  const logoUrl = await shop.upload('#C8794E');
  const kit = await shop.send('PATCH', '/brand-kit', { logoUrl });
  assert.equal(kit.status, 200, `Saving the logo: ${kit.status} ${kit.text.slice(0, 200)}`);
  await shop.repos.alerts.raise({ kind: 'token.invalid', message: 'The Instagram connection stopped working', severity: 'critical', target: 'instagram', audience: 'owner' });
  const mail = await world.waitFor(async () => (await world.platformEmailsTo(owner.email))[0], 15_000);
  assert.ok(mail, 'No token alert email');
  assert.equal(addressOf(mail.from), PLATFORM_EMAIL, `The token alert came from ${mail.from}`);
  assert.match(mail.from, /Bhava/, 'The sender\'s name is not Bhava');
  assert.equal(sellerEmailProblem({ from: addressOf(mail.from), html: mail.html }, { platformFrom: PLATFORM_EMAIL }), null);
  assert.match(`${mail.subject} ${mail.html}`, /Bhava/);
  assert.match(mail.html, new RegExp(BRAND_LOGO), 'Bhava\'s logo is not in the email');
  const logoName = logoUrl.split('/').pop();
  const logoTags = (mail.html.match(/<img\b[^>]*>/gi) ?? []).filter((tag) => tag.includes(logoName));
  assert.ok(logoTags.length <= 1, 'The business logo shows more than once');
  for (const tag of logoTags) assert.ok(tag.includes(WORKSPACE_BADGE), `The business logo shows outside the workspace badge: ${tag}`);
  assert.doesNotMatch(mail.html, /background(-image)?\s*:[^;"']*url\(/i, 'The email has a background image');
  // Reply-to and headers are Bhava's too, never the seller's or a shopper's.
  assert.ok(!mail.replyTo || /bhava/i.test(mail.replyTo), `Reply-To is ${mail.replyTo}`);
  assert.match(`${mail.html}${mail.text}`, /reconnect/i, 'The token alert does not say to reconnect');
});

test('F-59: an email provider answering 500 gets three tries with backoff, then the delivery is failed', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  await world.mail.fault({ kind: 'server_error', status: 500, times: 'forever', match: { method: 'POST', path: '/messages' } });
  try {
    const before = await mailTries(owner.email);
    await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-f59-${unique()}`, data: { account: 'Instagram' } });
    const emailRow = async () => (await deliveries(shop, `e.kind = 'token.invalid' AND d.channel = 'email' AND d.user_id = $2`, [owner.userId]))[0];
    await world.waitFor(async () => (await emailRow())?.attempt >= 1, 12_000);
    let row = await emailRow();
    assert.equal(row.attempt, 1);
    assert.equal(row.status, 'queued', 'A 500 was not tried again');
    const backoff = (new Date(row.next_attempt_at) - Date.now()) / 1000;
    assert.ok(backoff > 20 && backoff <= NOTIFY_RULES.backoffMs[0] / 1000 + 2, `The second try is due in ${backoff.toFixed(0)} s`);
    // Not before its time.
    await world.waitFor(() => false, 1500);
    assert.equal((await emailRow()).attempt, 1, 'The second try came before its backoff');
    await world.shift(NOTIFY_RULES.backoffMs[0] + SECOND, ['notification_deliveries']);
    await world.waitFor(async () => (await emailRow())?.attempt >= 2, 12_000);
    row = await emailRow();
    assert.equal(row.status, 'queued');
    await world.shift(NOTIFY_RULES.backoffMs[1] + SECOND, ['notification_deliveries']);
    await world.waitFor(async () => (await emailRow())?.status === 'failed', 12_000);
    row = await emailRow();
    assert.deepEqual([row.status, row.attempt], ['failed', NOTIFY_RULES.maxAttempts], `After three 500s the delivery is ${row.status} at try ${row.attempt}`);
    assert.ok(row.reason, 'A failed delivery says no reason');
    const tries = (await mailTries(owner.email)) - before;
    assert.equal(tries, NOTIFY_RULES.maxAttempts, `The provider was called ${tries} times`);
    // Failing email holds nothing else up: push and in-app went.
    const others = await deliveries(shop, `e.kind = 'token.invalid' AND d.channel IN ('push', 'inapp') AND d.user_id = $2`, [owner.userId]);
    assert.ok(others.length >= 2 && others.every((r) => r.status === 'sent'), `Other channels: ${others.map((r) => `${r.channel}:${r.status}`)}`);
    // And a failed delivery is never tried a fourth time.
    await world.mail.delete('/faults');
    await world.shift(10 * MINUTE, ['notification_deliveries']);
    await world.waitFor(() => false, 1500);
    assert.equal((await mailTries(owner.email)) - before, NOTIFY_RULES.maxAttempts, 'A failed delivery was tried again');
  } finally {
    await world.mail.delete('/faults');
  }
});

test('F-59: an email provider that times out or answers junk is a failed try, never a lost or doubled email', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  for (const fault of [{ kind: 'timeout', delayMs: 4000 }, { kind: 'malformed', mode: 'garbage' }, { kind: 'rate_limit', retryAfter: 1 }]) {
    await world.mail.fault({ ...fault, times: 1, match: { method: 'POST', path: '/messages' } });
    const key = `spec-f59-${fault.kind}-${unique()}`;
    await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } });
    const row = async () => (await deliveries(shop, `e.event_key = $2 AND d.channel = 'email'`, [key]))[0];
    await world.waitFor(async () => (await row())?.attempt >= 1, 12_000);
    await world.shift(NOTIFY_RULES.backoffMs[0] + SECOND, ['notification_deliveries']);
    await world.waitFor(async () => (await row())?.status === 'sent', 12_000);
    assert.equal((await row())?.status, 'sent', `After one ${fault.kind} the email was not sent on the next try`);
  }
  await world.waitFor(() => false, 1000);
  const mails = await world.platformEmailsTo(owner.email);
  assert.ok(mails.length <= 3, `${mails.length} emails for three alerts`);
  await world.mail.delete('/faults');
});

test('F-59: a WhatsApp alert whose answer was lost is never sent again on a guess', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  await world.wa.fault({ kind: 'partial', then: 'timeout', times: 1, match: { method: 'POST', path: `*/${PLATFORM_PHONE_ID}/messages` } });
  const key = `spec-wa-${unique()}`;
  const before = (await world.sellerMessages(owner.s.phone)).length;
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } });
  const row = async () => (await deliveries(shop, `e.event_key = $2 AND d.channel = 'whatsapp'`, [key]))[0];
  await world.waitFor(async () => ['failed', 'dropped', 'sent'].includes((await row())?.status), 15_000);
  await world.shift(10 * MINUTE, ['notification_deliveries']);
  await world.waitFor(() => false, 2000);
  const sent = (await world.sellerMessages(owner.s.phone)).length - before;
  assert.ok(sent <= 1, `${sent} WhatsApp alerts went out for one event after a lost answer`);
  const final = await row();
  if (final) assert.notEqual(final.status, 'queued', 'The WhatsApp delivery is still waiting to be sent again');
  await world.wa.delete('/faults');
});

test('F-88: the owner\'s weekly report email is Bhava-branded and from Bhava\'s sender', async () => {
  const shop = await addSeller(world, { name: 'Indigo Lane' });
  const owner = await ownerReady(world, shop);
  // What the Phase 2 reports job leaves in its outbox for this owner (report_deliveries, read by notifications).
  const [run] = await shop.sql(
    `INSERT INTO report_runs (tenant_id, kind, period_start, period_end, status, summary) VALUES ($1, 'weekly', current_date - 7, current_date - 1, 'sent', '{}') RETURNING id`,
    [shop.tenantId],
  );
  await shop.sql(
    `INSERT INTO report_deliveries (tenant_id, report_run_id, channel, user_id, to_address, subject, body, status) VALUES ($1, $2, 'email', $3, $4, 'Your weekly report', 'Reach 500. Taps 40.', 'queued')`,
    [shop.tenantId, run.id, owner.userId, owner.email],
  );
  const mail = await world.waitFor(async () => (await world.platformEmailsTo(owner.email))[0], 15_000);
  assert.ok(mail, 'No weekly report email');
  assert.equal(addressOf(mail.from), PLATFORM_EMAIL, `The weekly report came from ${mail.from}`);
  assert.match(mail.from, /Bhava/);
  assert.equal(sellerEmailProblem({ from: addressOf(mail.from), html: mail.html }, { platformFrom: PLATFORM_EMAIL }), null);
  assert.match(`${mail.subject} ${mail.html} ${mail.text}`, /weekly|week/i);
  const [delivery] = await shop.sql('SELECT notified_at FROM report_deliveries WHERE tenant_id = $1 AND report_run_id = $2', [shop.tenantId, run.id]);
  assert.ok(delivery.notified_at, 'The report delivery was not marked as taken');
  // Taken once: the worker running again sends no second copy.
  await world.waitFor(() => false, 1500);
  assert.equal((await world.platformEmailsTo(owner.email)).length, 1);
});

test('F-56: switching new-order email off stops it, and in-app cannot be switched off', async () => {
  const shop = await addP4Shop(world);
  const owner = await ownerReady(world, shop);
  const prefs = await owner.s.send('GET', '/notifications/prefs');
  assert.equal(prefs.status, 200);
  assert.deepEqual(prefs.data.events['order.new'], { push: true, email: true, whatsapp: false, inapp: true });
  const kind = prefs.data.kinds.find((k) => k.kind === 'order.new');
  assert.ok(kind && !kind.channels.includes('inapp'), 'In-app is offered as a choice');
  for (const body of [{ events: { 'order.new': { inapp: false } } }, { events: { 'device.signed_in': { email: false } } }, { events: { needs_human: { whatsapp: true } } }, { quietHours: { from: '25:00' } }, { quietHours: { to: '7am' } }]) {
    const res = await owner.s.send('PUT', '/notifications/prefs', body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was saved: ${res.status}`);
  }
  const saved = await owner.s.send('PUT', '/notifications/prefs', { events: { 'order.new': { email: false } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.events['order.new'].email, false);
  const product = await shop.item({ pricePaise: 29900 });
  await buyer(world, shop).buy({ lines: [line(product)] });
  await world.waitFor(async () => (await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2 AND d.channel = 'inapp'`, [owner.userId])).length >= 1, 12_000);
  await world.waitFor(() => false, 1500);
  assert.equal((await world.platformEmailsTo(owner.email)).length, 0, 'An email went after the owner switched it off');
  assert.ok((await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2 AND d.channel = 'inapp' AND d.status = 'sent'`, [owner.userId])).length >= 1);
});

test('F-56: quiet hours across midnight hold a push that is not urgent, never a critical one, and never email', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  // A time zone where it is now between 23:00 and 23:59, and quiet hours of 23:00 to 01:00 there.
  const hour = new Date().getUTCHours();
  const offset = ((23 - hour) % 24 + 24) % 24;
  const signed = offset > 12 ? offset - 24 : offset;
  const timezone = signed === 0 ? 'Etc/GMT' : `Etc/GMT${signed > 0 ? '-' : '+'}${Math.abs(signed)}`;
  const saved = await owner.s.send('PUT', '/notifications/prefs', { quietHours: { enabled: true, from: '23:00', to: '01:00', timezone } });
  assert.equal(saved.status, 200, `Saving quiet hours: ${saved.status} ${saved.text.slice(0, 200)}`);
  const notify = world.notify();
  const quietKey = `spec-quiet-${unique()}`;
  const urgentKey = `spec-urgent-${unique()}`;
  await notify.emit({ event: 'token.expiring', tenantId: shop.tenantId, key: quietKey, data: { account: 'Instagram', days: 7 } });
  await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key: urgentKey, data: { account: 'Instagram' } });
  const row = async (key, channel) => (await deliveries(shop, `e.event_key = $2 AND d.channel = $3`, [key, channel]))[0];
  await world.waitFor(async () => (await row(urgentKey, 'push'))?.status === 'sent' && (await row(quietKey, 'email'))?.status === 'sent', 12_000);
  assert.equal((await row(urgentKey, 'push'))?.status, 'sent', 'A critical push waited for quiet hours');
  assert.equal((await row(quietKey, 'email'))?.status, 'sent', 'Email waited for quiet hours');
  const held = await row(quietKey, 'push');
  assert.ok(held, 'No push delivery for the non-urgent alert');
  assert.equal(held.status, 'queued', 'A non-urgent push went out inside quiet hours');
  const until = (new Date(held.next_attempt_at) - Date.now()) / MINUTE;
  assert.ok(until > 0 && until <= 121, `The held push is due in ${until.toFixed(0)} minutes, not when quiet hours end past midnight`);
});

test('F-56: someone removed from the team gets nothing more, queued pushes included', async () => {
  const shop = await addP4Shop(world);
  const staff = await addMember(shop, { role: 'staff', permissions: ['orders'] });
  const s = await appSignIn(world, staff.phone, { tenantId: shop.tenantId });
  const token = await registerPush(s);
  const product = await shop.item({ pricePaise: 19900 });
  const order = await buyer(world, shop).buy({ lines: [line(product)] });
  await world.waitFor(async () => (await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2 AND d.channel = 'push'`, [staff.userId])).length >= 1, 12_000);
  const owner = await ownerApp(world, shop);
  assert.equal((await owner.send('DELETE', `/team/${staff.userId}`)).status, 204);
  await pastCollapseHold(async () => {
    const [row] = await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2 AND d.channel = 'push'`, [staff.userId]);
    return row && row.status !== 'queued';
  });
  const [row] = await deliveries(shop, `e.kind = 'order.new' AND d.user_id = $2 AND d.channel = 'push'`, [staff.userId]);
  assert.deepEqual([row?.status, row?.reason], ['dropped', 'removed'], `The removed member's queued push is ${row?.status} (${row?.reason})`);
  assert.equal((await world.pushes(token)).length, 0, `A push about order ${order.order_number} reached someone removed from the team`);
});

test('F-56: the in-app list is each person\'s own, newest first, and marking read works only on their own', async () => {
  const shop = await addSeller(world);
  const owner = await ownerReady(world, shop);
  const manager = await addMember(shop, { role: 'manager' });
  const m = await appSignIn(world, manager.phone, { tenantId: shop.tenantId });
  const notify = world.notify();
  await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-list-1-${unique()}`, data: { account: 'Instagram' } });
  await notify.emit({ event: 'token.expiring', tenantId: shop.tenantId, key: `spec-list-2-${unique()}`, data: { account: 'Instagram', days: 5 } });
  await world.waitFor(async () => ((await owner.s.send('GET', '/notifications')).data?.items ?? []).length >= 2, 12_000);
  const list = await owner.s.send('GET', '/notifications');
  assert.deepEqual(list.data.items.slice(0, 2).map((n) => n.kind), ['token.expiring', 'token.invalid'], 'Not newest first');
  assert.equal(list.data.unread, list.data.items.filter((n) => !n.readAt).length);
  // Owner-only alerts are not the manager's.
  const theirs = await m.send('GET', '/notifications');
  assert.ok(!theirs.data.items.some((n) => n.kind === 'token.invalid'), 'An owner alert reached a manager');
  // The manager marking the owner's ids changes nothing.
  await m.send('POST', '/notifications/read', { ids: list.data.items.map((n) => n.id) });
  assert.equal((await owner.s.send('GET', '/notifications')).data.unread, list.data.unread, 'A manager marked the owner\'s notifications read');
  assert.equal((await owner.s.send('POST', '/notifications/read', { ids: [list.data.items[0].id] })).status, 204);
  assert.equal((await owner.s.send('GET', '/notifications')).data.unread, list.data.unread - 1);
  assert.equal((await owner.s.send('POST', '/notifications/read', { all: true })).status, 204);
  assert.equal((await owner.s.send('GET', '/notifications?unread=1')).data.unread, 0);
  for (const body of [{}, { ids: [] }, { ids: ['x'] }, { all: false }, { all: true, ids: [1] }]) assert.equal((await owner.s.send('POST', '/notifications/read', body)).status, 400, JSON.stringify(body));
});

test('F-58: a seller\'s WhatsApp alert comes from Bhava\'s number with Bhava\'s template, never the business\'s own number', async () => {
  const shop = await addP4Shop(world, { name: 'Lotus Loom' });
  const owner = await ownerReady(world, shop);
  const before = (await world.allMessagesTo(owner.s.phone)).length;
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-wa-alert-${unique()}`, data: { account: 'Instagram' } });
  await world.waitFor(async () => (await world.allMessagesTo(owner.s.phone)).length > before, 12_000);
  const sent = (await world.allMessagesTo(owner.s.phone)).slice(before);
  assert.equal(sent.length, 1, `${sent.length} WhatsApp messages for one alert`);
  assert.equal(sent[0].phoneId, PLATFORM_PHONE_ID, 'A seller alert went from the business\'s own number');
  assert.notEqual(sent[0].phoneId, shop.waPhoneId);
  assert.equal(sent[0].type, 'template');
  assert.match(sent[0].body.template.name, /^[a-z0-9_]+$/);
  assert.doesNotMatch(JSON.stringify(sent[0].body.template), /\+?91\d{10}|@/, 'The alert holds a number or an address');
});
