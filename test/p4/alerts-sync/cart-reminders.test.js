// Abandoned-cart reminders (PRD 9.15): only to a signed-in shopper's server cart, only on a channel they said yes to for
// marketing, at most two per time a cart is left (about 1 h and 24 h), never 9 pm to 9 am (S-50), stopped by an order (S-49),
// an empty cart, coming back or opting out, never by Instagram DM (S-51), and a link that restores the cart and is counted (S-48).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCartReminders } from '../../../src/modules/abandoned-cart/reminders.js';
import { HOUR, IST_MS, PLATFORM, alertsApp, consentOf, daytime, emailsTo, hit, inTenant, lastIst, place, placeBody, product, q, shopper, shopperCsrf, whatsappTo } from './support.js';

const putCart = (app, cookie, lines) => hit(app, '/api/store/cart', { method: 'PUT', cookie, headers: shopperCsrf(app, cookie), body: { lines } });
const setIdle = (app, cartId, since) => q(app, 'UPDATE carts SET last_activity_at = $3 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, cartId, since]);
const reminderRows = (app) => q(app, 'SELECT * FROM cart_reminders WHERE tenant_id = $1 ORDER BY id', [app.tenant.id]);
/** Time passes: every stored cart and reminder time moves `ms` into the past. */
async function age(app, ms) {
  const by = `${Math.round(ms)} milliseconds`;
  await q(app, `UPDATE carts SET last_activity_at = last_activity_at - interval '${by}', updated_at = updated_at - interval '${by}' WHERE tenant_id = $1`, [app.tenant.id]);
  await q(app, `UPDATE cart_reminders SET created_at = created_at - interval '${by}', scheduled_for = scheduled_for - interval '${by}', sent_at = sent_at - interval '${by}' WHERE tenant_id = $1`, [app.tenant.id]);
}
const linkIn = (message) => /https?:\/\/[^\s"\\]+\/cart\/restore\/[A-Za-z0-9_-]+(\?[^\s"\\]*)?/.exec(JSON.stringify(message.body))?.[0];

/** A signed-in shopper with marketing consent as given, and a cart left `idleMs` ago. */
async function leftCart(app, { phone = '+919822200011', email = '', marketing = { whatsapp: true }, idleMs = 61 * 60_000, since, name = 'Diya set' } = {}) {
  const diya = await product(app, { name, pricePaise: 12000, stock: 10 });
  const who = await shopper(app, { phone });
  if (email) await q(app, 'UPDATE shoppers SET email = $3, name = $4 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, who.id, email, 'Asha Rao']);
  await consentOf(app, { shopperId: who.id, phone }, { marketing });
  const put = await putCart(app, who.cookie, [{ productId: diya.id, variantId: null, qty: 2 }]);
  assert.equal(put.status, 200, put.text);
  const [cart] = await q(app, `SELECT id FROM carts WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'active'`, [app.tenant.id, who.id]);
  await setIdle(app, cart.id, since ?? new Date(Date.now() - idleMs));
  return { ...who, cartId: cart.id, product: diya };
}

test('reminders are off until the owner turns them on, and the settings say which channels and template are ready', async () => {
  const app = await alertsApp();
  try {
    const off = await app.api('GET', '/cart-reminders');
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json, { enabled: false, channels: ['whatsapp', 'email'], templateStatus: 'approved' });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    await leftCart(app);
    assert.deepEqual(await reminders.run(), { planned: 0, sent: 0 });
    assert.equal((await reminderRows(app)).length, 0, 'nothing is planned while reminders are off');
    const on = await app.api('PATCH', '/cart-reminders', { enabled: true });
    assert.equal(on.json.enabled, true);
    await app.db.platform.query(`UPDATE tenants SET plan = 't2' WHERE id = $1`, [app.tenant.id]);
    assert.equal((await app.api('PATCH', '/cart-reminders', { enabled: true })).status, 403, 'not on the plan');
  } finally {
    await app.close();
  }
});

test('S-48: a shopper who said yes to WhatsApp offers and left a cart for an hour gets one reminder whose link brings the cart back', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    const asha = await leftCart(app, { idleMs: 30 * 60_000 });
    await reminders.run();
    assert.equal((await whatsappTo(app, asha.phone)).length, 0, 'nothing before the hour');

    await setIdle(app, asha.cartId, lastIst(10, new Date(Date.now() - 2 * HOUR)));
    const done = await reminders.run();
    assert.equal(done.sent, 1);
    const sent = await whatsappTo(app, asha.phone);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.template.name, 'cart_reminder');
    assert.doesNotMatch(JSON.stringify(sent[0].body), PLATFORM);
    const link = new URL(linkIn(sent[0]));
    assert.equal(link.origin, 'https://shop.test', 'on the store’s own address');
    assert.equal(link.searchParams.get('utm_source'), 'whatsapp');
    await reminders.run();
    assert.equal((await whatsappTo(app, asha.phone)).length, 1, 'a second pass sends nothing more');

    // A fresh browser opens it: the bag is shown and filled, and the tap is counted.
    const page = await hit(app, link.pathname + link.search);
    assert.equal(page.status, 200, page.text.slice(0, 300));
    assert.ok(page.text.includes('Diya set'));
    assert.match(page.text, /id="restore-bag">\[\{"productId":\d+,"variantId":null,"qty":2\}\]/);
    assert.doesNotMatch(page.text, /9822200011/, 'the page shows products, never the shopper’s number');
    const [row] = (await reminderRows(app)).filter((r) => r.status === 'sent');
    assert.equal(row.channel, 'whatsapp');
    assert.ok(row.clicked_at);
    assert.equal(row.restore_token_hash.length, 64);
    assert.ok(!row.restore_token_hash.includes(link.pathname.split('/').pop()), 'only the token’s hash is kept');

    assert.equal((await hit(app, `/cart/restore/${'x'.repeat(40)}`)).status, 404, 'a made-up link');
    const other = await app.platform.tenants.ensure({ slug: 'haldi', name: 'Haldi House' });
    await app.db.platform.query(`UPDATE tenants SET plan = 't3' WHERE id = $1`, [other.id]);
    assert.equal((await hit(app, link.pathname, { host: 'haldi.shops.example' })).status, 404, 'another store finds nothing');
    await q(app, `UPDATE cart_reminders SET sent_at = now() - interval '31 days' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, row.id]);
    assert.equal((await hit(app, link.pathname)).status, 410, 'an old link has expired');

    const stats = await app.api('GET', '/cart-reminders/stats?days=30');
    assert.equal(stats.status, 200, stats.text);
    assert.deepEqual([stats.json.sent, stats.json.clicked], [0, 0], 'the expired one is older than the window');
  } finally {
    await app.close();
  }
});

test('S-50: an hour mark that falls at 11 pm waits until 9 am India time', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    const left = lastIst(22, new Date(Date.now() - 2 * HOUR));
    const asha = await leftCart(app, { since: left });
    await inTenant(app, () => reminders.planAll());
    const rows = await reminderRows(app);
    const step1 = rows.find((r) => r.step === 1);
    if (Date.now() < left.getTime() + 24 * HOUR) {
      assert.ok(step1, 'the first reminder is planned');
      const nineAm = new Date(Date.UTC(new Date(left.getTime() + IST_MS).getUTCFullYear(), new Date(left.getTime() + IST_MS).getUTCMonth(), new Date(left.getTime() + IST_MS).getUTCDate() + 1, 9) - IST_MS);
      assert.equal(new Date(step1.scheduled_for).toISOString(), nineAm.toISOString(), 'moved from 11 pm to 9 am');
    }
    for (const r of rows) {
      const hour = new Date(new Date(r.scheduled_for).getTime() + IST_MS).getUTCHours();
      assert.ok(hour >= 9 && hour < 21, `a reminder is set for ${hour}:00 India time`);
    }
    // At night the gate holds a due reminder back to 9 am rather than sending it.
    const night = createCartReminders(app.ctx, { clock: () => lastIst(23) });
    await q(app, `UPDATE cart_reminders SET scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1 AND status = 'scheduled'`, [app.tenant.id]);
    await inTenant(app, () => night.sendDue());
    assert.equal((await whatsappTo(app, asha.phone)).length, 0, 'nothing at night');
    for (const r of (await reminderRows(app)).filter((x) => x.status === 'scheduled')) {
      assert.equal(new Date(new Date(r.scheduled_for).getTime() + IST_MS).getUTCHours(), 9);
    }
  } finally {
    await app.close();
  }
});

test('S-49: an order after the first reminder stops the second; at most two per time a cart is left; an empty cart gets none', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    const asha = await leftCart(app, { since: lastIst(10, new Date(Date.now() - 2 * HOUR)) });
    await reminders.run();
    if (Date.now() < lastIst(10, new Date(Date.now() - 2 * HOUR)).getTime() + 24 * HOUR) {
      assert.deepEqual((await reminderRows(app)).map((r) => [r.step, r.status]), [[1, 'sent'], [2, 'scheduled']]);
    }
    // She orders: the checkout closes the cart and the second reminder never goes.
    const res = await place(app, placeBody(asha.product.id, { address: { name: 'Asha Rao', phone: asha.phone, line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' } }), { cookie: asha.cookie, headers: shopperCsrf(app, asha.cookie) });
    assert.equal(res.status, 201, res.text);
    await app.ctx.orderEvents.settle();
    const rows = await reminderRows(app);
    assert.ok(rows.every((r) => r.status !== 'scheduled'), 'nothing is left to send');
    assert.ok(rows.some((r) => r.stop_reason === 'ordered') || rows.every((r) => r.status === 'sent'));
    await q(app, `UPDATE cart_reminders SET scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1`, [app.tenant.id]);
    await reminders.run();
    assert.equal((await whatsappTo(app, asha.phone)).length, 1);

    // Left for days: two at most.
    const ravi = await leftCart(app, { phone: '+919822200022', since: new Date(Date.now() - 30 * HOUR), name: 'Lamp' });
    for (let i = 0; i < 4; i++) {
      await q(app, `UPDATE cart_reminders SET scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1 AND status = 'scheduled'`, [app.tenant.id]);
      await reminders.run();
    }
    const raviSent = await whatsappTo(app, ravi.phone);
    assert.equal(raviSent.length, 1, 'found after both marks had passed: the later one alone');
    assert.ok((await q(app, 'SELECT * FROM cart_reminders WHERE tenant_id = $1 AND cart_id = $2', [app.tenant.id, ravi.cartId])).length <= 2);

    // Emptied before the hour: nothing.
    const mira = await leftCart(app, { phone: '+919822200033', idleMs: 10 * 60_000, name: 'Bowl' });
    await reminders.run();
    assert.equal((await putCart(app, mira.cookie, [])).status, 200);
    await setIdle(app, mira.cartId, new Date(Date.now() - 2 * HOUR));
    await reminders.run();
    assert.equal((await whatsappTo(app, mira.phone)).length, 0);
  } finally {
    await app.close();
  }
});

test('coming back to the cart starts a new time; opting out or a STOP stops reminders; no consent means nothing at all', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    const since = lastIst(10, new Date(Date.now() - 2 * HOUR));
    const fresh = Date.now() < since.getTime() + 24 * HOUR;
    const asha = await leftCart(app, { since });
    await reminders.run();
    // She comes back and changes the bag: what was planned for last time stops, and a new time begins once she leaves again.
    assert.equal((await putCart(app, asha.cookie, [{ productId: asha.product.id, variantId: null, qty: 3 }])).status, 200);
    await q(app, `UPDATE cart_reminders SET scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1 AND status = 'scheduled'`, [app.tenant.id]);
    await reminders.run();
    assert.ok((await reminderRows(app)).every((r) => r.status !== 'scheduled' || r.episode > 1));
    if (fresh) assert.ok((await reminderRows(app)).some((r) => r.stop_reason === 'active_again'));
    await age(app, 2 * HOUR);
    await reminders.run();
    const [cart] = await q(app, 'SELECT episode FROM carts WHERE tenant_id = $1 AND id = $2', [app.tenant.id, asha.cartId]);
    assert.equal(cart.episode, 2);
    const second = (await reminderRows(app)).filter((r) => r.episode === 2);
    assert.ok(second.some((r) => r.status === 'sent'));

    // STOP by WhatsApp: the yes to WhatsApp offers is withdrawn and the scheduled reminder stops.
    const [{ phone_number_id: phoneId }] = await q(app, 'SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    await app.wa.post('/webhooks/url', { url: `${app.base}/webhooks/whatsapp` });
    await app.wa.post('/inbound', { phoneId, from: asha.phone.slice(1), text: 'stop' });
    const { orderAlertsFor } = await import('../../../src/modules/order-alerts/index.js');
    await orderAlertsFor(app.ctx).webhook.settle();
    const after = (await reminderRows(app)).filter((r) => r.episode === 2 && r.step === 2);
    assert.ok(after.every((r) => r.status === 'cancelled' && r.stop_reason === 'opted_out'), JSON.stringify(after.map((r) => [r.status, r.stop_reason])));
    const before = (await whatsappTo(app, asha.phone)).length;
    await q(app, `UPDATE cart_reminders SET status = 'scheduled', scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1 AND episode = 2 AND step = 2`, [app.tenant.id]);
    await reminders.run();
    assert.equal((await whatsappTo(app, asha.phone)).length, before, 'a shopper who opted out gets nothing');
    assert.equal((await reminderRows(app)).find((r) => r.episode === 2 && r.step === 2).stop_reason, 'opted_out');

    // Never asked: nothing, recorded once.
    const ravi = await leftCart(app, { phone: '+919822200044', marketing: {}, name: 'Rug' });
    await reminders.run();
    await reminders.run();
    const rows = await q(app, 'SELECT * FROM cart_reminders WHERE tenant_id = $1 AND cart_id = $2', [app.tenant.id, ravi.cartId]);
    assert.deepEqual(rows.map((r) => [r.status, r.stop_reason]), [['skipped', 'no_consent']]);
    assert.equal((await whatsappTo(app, ravi.phone)).length, 0);
  } finally {
    await app.close();
  }
});

test('S-51: a shopper who said yes to email offers only gets an email with an unsubscribe link, and never an Instagram DM', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });
    const asha = await leftCart(app, { email: 'asha@mail.example', marketing: { whatsapp: false, email: true }, since: lastIst(10, new Date(Date.now() - 2 * HOUR)) });
    await reminders.run();
    assert.equal((await whatsappTo(app, asha.phone)).length, 0);
    const mails = await emailsTo(app, 'asha@mail.example');
    assert.equal(mails.length, 1);
    const [mail] = mails;
    assert.ok(mail.headers['List-Unsubscribe'], 'an unsubscribe header');
    assert.match(mail.html, /Unsubscribe/);
    assert.match(mail.html, /\/cart\/restore\/[A-Za-z0-9_-]+\?utm_source=email/);
    assert.ok(mail.html.includes('Diya set'));
    for (const part of [mail.from, mail.subject, mail.html, mail.text]) assert.doesNotMatch(part, PLATFORM);
    assert.deepEqual(app.ig.calls, [], 'nothing went to Instagram');
    const [row] = await reminderRows(app);
    assert.equal(row.channel, 'email');

    // Resent after a crash mid-send: the same key, so the mail service answers with the same message and link.
    await q(app, `UPDATE cart_reminders SET status = 'scheduled', provider_message_id = 'claim', scheduled_for = now() - interval '1 minute' WHERE tenant_id = $1 AND id = $2`, [app.tenant.id, row.id]);
    const firstHash = row.restore_token_hash;
    await inTenant(app, () => reminders.sendDue());
    assert.equal((await emailsTo(app, 'asha@mail.example')).length, 1, 'not a second email');
    assert.equal((await reminderRows(app))[0].restore_token_hash, firstHash, 'the link in the first email still works');
  } finally {
    await app.close();
  }
});
