// PRD 9.15 (abandoned-cart reminders) and 9.16 (order alerts by WhatsApp and email). S-48 to S-55, S-96.
// The app has no clock a test can move to a time of day, so the reminder cases read the real time of day: inside quiet
// hours (9 pm to 9 am India time) a due reminder must wait for 9 am; outside them it must go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, MINUTE, NEUTRAL_MAIL, address, addP4Shop, buyer, hit, need, newPhone, noPlatformName, ok, quietUntil, unique, useP4World } from './kit.js';

const world = useP4World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });
const templateName = async (shop, purpose) => (await shop.one('SELECT name FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = $2', [shop.tenantId, purpose]))?.name;
const withTemplate = async (phone, name) => (await world.whatsappTo(phone)).filter((m) => m.body?.template?.name === name);
const RESTORE = /https?:\/\/[^"\s\\]+\/cart\/restore\/[A-Za-z0-9_-]+/;

async function consentedBuyer(shop, { email = `asha${unique()}@mail.example`, marketing = { whatsapp: false, email: false } } = {}) {
  const b = buyer(world, shop);
  const phone = await b.signIn();
  ok(await b.saveConsent({ orderUpdates: { whatsapp: true, email: true }, marketing }), 'Saving consent choices');
  return { b, phone, email };
}

// ---- order alerts ----

test('S-52: an order paid by a consenting shopper sends one Utility template and one email', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const product = await shop.item({ name: 'Monstera', pricePaise: 49900 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const email = `asha${unique()}@mail.example`;
  const row = await b.buy({ lines: [line(product)], address: address({ phone }), email });
  await world.until(async () => (await shop.alertsOf(row.id, 'paid')).filter((a) => a.status === 'sent').length >= 2, 12_000);
  const alerts = await shop.alertsOf(row.id, 'paid');
  assert.deepEqual(alerts.map((a) => a.channel).sort(), ['email', 'whatsapp'], 'Not one paid alert per channel');
  assert.ok(alerts.every((a) => a.status === 'sent'), `Paid alerts: ${alerts.map((a) => `${a.channel}:${a.status}:${a.skip_reason}`)}`);
  const name = await templateName(shop, 'order_paid');
  const wa = await withTemplate(phone, name);
  assert.equal(wa.length, 1, `${wa.length} paid WhatsApp messages`);
  const [tpl] = await shop.sql(`SELECT category FROM whatsapp_templates WHERE tenant_id = $1 AND purpose = 'order_paid'`, [shop.tenantId]);
  assert.equal(tpl.category, 'utility');
  assert.equal(wa[0].type, 'template');
  assert.equal(wa[0].phoneId, shop.waPhoneId);
  noPlatformName('The paid WhatsApp message', wa[0].body);
  const mailAlert = alerts.find((a) => a.channel === 'email');
  const mails = (await world.emailsTo(email)).filter((m) => m.id === mailAlert.provider_message_id);
  assert.equal(mails.length, 1, 'The paid email was not sent once');
  const mail = mails[0];
  noPlatformName('The paid email', { from: mail.from, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, replyTo: mail.replyTo });
  assert.ok(`${mail.subject} ${mail.html}`.includes('Leafy Corner'), 'The email does not carry the seller’s name');
  assert.ok(`${mail.html}${mail.text}`.includes(row.order_number));
});

test('S-52: no consent for order updates on a channel means nothing on that channel', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900 });
  const b = buyer(world, shop);
  const phone = newPhone();
  const email = `asha${unique()}@mail.example`;
  const row = await b.buy({ lines: [line(product)], address: address({ phone }), email, consent: { orderUpdates: { whatsapp: false, email: true } } });
  await world.until(async () => (await shop.alertsOf(row.id, 'paid')).some((a) => a.channel === 'email' && a.status === 'sent'), 12_000);
  await world.quiet(1000);
  assert.equal((await world.whatsappTo(phone)).length, 0, 'WhatsApp went to a shopper who said no to it');
  const wa = (await shop.alertsOf(row.id)).filter((a) => a.channel === 'whatsapp');
  assert.ok(wa.every((a) => a.status === 'skipped' && a.skip_reason === 'no_consent'), `WhatsApp alerts: ${wa.map((a) => `${a.status}:${a.skip_reason}`)}`);
});

test('S-53: a template still in review falls back to email, and the admin shows "Template pending"', async () => {
  const shop = await addP4Shop(world);
  await shop.templateStatus('order_paid', 'pending');
  await world.wa.post('/templates/enforce', { on: true });
  try {
    const product = await shop.item({ pricePaise: 49900 });
    const phone = newPhone();
    const email = `asha${unique()}@mail.example`;
    const row = await buyer(world, shop).buy({ lines: [line(product)], address: address({ phone }), email });
    await world.until(async () => (await shop.alertsOf(row.id, 'paid')).some((a) => a.channel === 'email' && a.status === 'sent'), 12_000);
    const alerts = await shop.alertsOf(row.id, 'paid');
    const wa = alerts.find((a) => a.channel === 'whatsapp');
    assert.ok(wa, 'No WhatsApp alert row says what happened');
    assert.equal(wa.status, 'skipped');
    assert.equal(wa.skip_reason, 'template_pending');
    assert.equal(alerts.find((a) => a.channel === 'email').status, 'sent', 'The email fallback was not sent');
    assert.equal((await withTemplate(phone, await templateName(shop, 'order_paid'))).length, 0, 'A template in review was sent');
    const list = need(await shop.send('GET', `/order-alerts?orderId=${row.id}`), 200, 'The alerts list').json().items;
    const shown = list.find((a) => a.channel === 'whatsapp' && a.event === 'paid');
    assert.equal(shown.skipReason, 'template_pending');
    const templates = need(await shop.send('GET', '/whatsapp-templates'), 200, 'The templates').json().items;
    assert.equal(templates.find((t) => t.purpose === 'order_paid').status, 'pending');
  } finally {
    await world.wa.post('/templates/enforce', { on: false });
  }
});

test('S-54: a "shipped" event arriving twice sends exactly one message per channel', async () => {
  const shop = await addP4Shop(world);
  const product = await shop.item({ pricePaise: 49900 });
  const phone = newPhone();
  const email = `asha${unique()}@mail.example`;
  const row = await buyer(world, shop).buy({ lines: [line(product)], address: address({ phone }), email });
  const shipment = await shop.ship(row);
  await shop.track(shipment.awb, 'PICKED UP', { duplicates: 3 });
  await shop.orderWhen(row.order_number, (o) => o.fulfilment_status === 'shipped');
  const sent = (await world.ship.get('/webhooks')).deliveries.at(-1);
  await world.ship.post('/webhooks/redeliver', { id: sent.id, times: 2 });
  await shop.track(shipment.awb, 'IN TRANSIT');
  await world.until(async () => (await shop.alertsOf(row.id, 'shipped')).filter((a) => a.status === 'sent').length >= 2, 12_000);
  await world.quiet(2000);
  const alerts = await shop.alertsOf(row.id, 'shipped');
  assert.deepEqual(alerts.map((a) => a.channel).sort(), ['email', 'whatsapp']);
  assert.equal((await withTemplate(phone, await templateName(shop, 'order_shipped'))).length, 1, 'More than one shipped WhatsApp message');
  const mails = (await world.emailsTo(email)).filter((m) => m.id === alerts.find((a) => a.channel === 'email').provider_message_id);
  assert.equal(mails.length, 1);
  assert.equal((await world.emailsTo(email)).filter((m) => /ship/i.test(m.subject)).length, 1, 'More than one shipped email');
});

test('S-55: order email comes from the seller’s own domain and passes DKIM, with no platform name', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const domain = `leafy${unique()}.example`.toLowerCase();
  await shop.sql(`INSERT INTO tenant_domains (domain, tenant_id, status, is_primary, verified_at) VALUES ($1, $2, 'verified', true, now())`, [domain, shop.tenantId]);
  await world.mail.post('/dkim', { domain, pass: true });
  const settings = await shop.alertsSet({ emailFrom: 'own', emailFromLocal: 'orders', emailReplyTo: `care@${domain}` });
  assert.equal(settings.emailFromAddress, `orders@${domain}`);
  noPlatformName('Alert settings', settings);
  const product = await shop.item({ pricePaise: 49900 });
  const email = `asha${unique()}@mail.example`;
  const row = await buyer(world, shop).buy({ lines: [line(product)], email });
  await world.until(async () => (await world.emailsTo(email)).length >= 1, 12_000);
  const mails = await world.emailsTo(email);
  assert.ok(mails.length >= 1, 'No order email');
  for (const m of mails) {
    assert.equal(m.fromDomain, domain, `An order email came from ${m.from}`);
    assert.equal(m.dkim, 'pass');
    assert.match(m.from, /Leafy Corner/, 'The From name is not the seller’s');
    noPlatformName('An order email', { from: m.from, subject: m.subject, html: m.html, text: m.text, headers: m.headers, replyTo: m.replyTo });
  }
  assert.ok((await shop.alertsOf(row.id)).length >= 1);
});

test('S-55: on the neutral sending domain the email still carries only the seller’s name', async () => {
  const shop = await addP4Shop(world, { name: 'Brass Bazaar' });
  const settings = await shop.alertsSet({ emailFrom: 'neutral' });
  assert.ok(settings.emailFromAddress.endsWith(`@${NEUTRAL_MAIL}`), `Neutral mail comes from ${settings.emailFromAddress}`);
  const product = await shop.item({ pricePaise: 49900 });
  const email = `asha${unique()}@mail.example`;
  await buyer(world, shop).buy({ lines: [line(product)], email });
  await world.until(async () => (await world.emailsTo(email)).length >= 1, 12_000);
  for (const m of await world.emailsTo(email)) {
    assert.equal(m.fromDomain, NEUTRAL_MAIL);
    assert.match(m.from, /Brass Bazaar/);
    noPlatformName('A neutral order email', { from: m.from, subject: m.subject, html: m.html, text: m.text, headers: m.headers });
  }
  const unverified = `pending${unique()}.example`.toLowerCase();
  await shop.sql(`INSERT INTO tenant_domains (domain, tenant_id, status) VALUES ($1, $2, 'pending')`, [unverified, shop.tenantId]);
  const res = await shop.send('PATCH', '/alert-settings', { emailFrom: 'own' });
  if (res.status === 200) assert.ok(!res.json().emailFromAddress.endsWith(`@${unverified}`), 'Mail would come from a domain that is not verified');
});

test('S-96: alert settings offer WhatsApp and email only, with the WhatsApp cost per message at cost', async () => {
  const shop = await addP4Shop(world);
  const settings = need(await shop.send('GET', '/alert-settings'), 200, 'Alert settings').json();
  assert.deepEqual([...settings.channels].sort(), ['email', 'whatsapp']);
  assert.doesNotMatch(JSON.stringify(settings), /sms/i, 'Alert settings mention SMS');
  assert.ok(settings.whatsappCostPaise && ['utility', 'authentication', 'marketing'].every((k) => k in settings.whatsappCostPaise), 'No WhatsApp cost per message');
  for (const v of Object.values(settings.whatsappCostPaise)) assert.ok(v === null || (Number.isInteger(v) && v >= 0));
  const res = await shop.send('PATCH', '/alert-settings', { sms: true, channels: ['sms'] });
  assert.ok(res.status === 400 || !JSON.stringify(res.json()).match(/sms/i), 'An SMS channel was saved');
  assert.doesNotMatch(JSON.stringify(need(await shop.send('GET', '/alert-settings'), 200, 'Alert settings again').json()), /sms/i);
  const manager = await shop.manager();
  need(await manager.send('GET', '/alert-settings'), 200, 'A manager reading alert settings');
  const page = await hit(world, '/settings/alerts', { host: shop.host, token: shop.token });
  if (page.status === 200) assert.doesNotMatch(page.text, /\bSMS\b/);
});

// ---- cart reminders ----

async function leftCart(shop, marketing) {
  await shop.remindersOn();
  const product = await shop.item({ name: `Brass diya ${unique()}`, pricePaise: 12000 });
  const who = await consentedBuyer(shop, { marketing });
  ok(await who.b.putCart([line(product, 2)]), 'Filling the cart');
  return { ...who, product };
}

test('S-48: an opted-in shopper who leaves a cart for an hour gets one WhatsApp reminder with a working link', async () => {
  const shop = await addP4Shop(world, { name: 'Leafy Corner' });
  const { phone, product } = await leftCart(shop, { whatsapp: true, email: false });
  await world.age(30 * MINUTE);
  await world.quiet(1000);
  const name = await templateName(shop, 'cart_reminder');
  assert.equal((await withTemplate(phone, name)).length, 0, 'A reminder went before the hour');
  await world.age(31 * MINUTE);
  const quiet = quietUntil(new Date());
  if (quiet) {
    await world.quiet(3000);
    assert.equal((await withTemplate(phone, name)).length, 0, 'A marketing reminder went out inside quiet hours');
    const rows = await shop.sql(`SELECT * FROM cart_reminders WHERE tenant_id = $1 AND status = 'scheduled'`, [shop.tenantId]);
    assert.ok(rows.every((r) => new Date(r.scheduled_for) >= new Date(quiet.getTime() - 60_000)), 'A reminder is scheduled inside quiet hours');
    return;
  }
  const sent = await world.until(async () => (await withTemplate(phone, name)).length || null, 12_000);
  assert.equal(sent, 1, 'Not exactly one reminder after an hour');
  const [msg] = await withTemplate(phone, name);
  noPlatformName('The reminder', msg.body);
  const link = RESTORE.exec(JSON.stringify(msg.body))?.[0];
  assert.ok(link, 'The reminder carries no cart link');
  const url = new URL(link);
  assert.equal(url.hostname, shop.host, 'The cart link is not on the seller’s own domain');
  const fresh = buyer(world, shop);
  let res = await fresh.open(url.pathname);
  if ([302, 303].includes(res.status)) {
    const to = new URL(res.headers.location, `https://${shop.host}`);
    assert.equal(to.hostname, shop.host, 'The cart link goes through another site');
    res = await fresh.open(`${to.pathname}${to.search}`);
  }
  need(res, 200, 'Opening the cart link');
  assert.ok(res.text.includes(product.name), 'The cart link does not bring the cart back');
  const [row] = await shop.sql(`SELECT * FROM cart_reminders WHERE tenant_id = $1 AND status = 'sent' ORDER BY id LIMIT 1`, [shop.tenantId]);
  assert.ok(row.clicked_at, 'The click was not counted');
  assert.equal(row.channel, 'whatsapp');
  need(await fresh.open(`/cart/restore/${'x'.repeat(30)}`), [404, 410], 'A made-up cart link');
  const other = await addP4Shop(world);
  need(await buyer(world, other).open(url.pathname), [404, 410], 'This cart link on another store');
});

test('S-49: a shopper who orders after the first reminder gets no second one', async () => {
  const shop = await addP4Shop(world);
  const { b, phone, product } = await leftCart(shop, { whatsapp: true, email: false });
  await world.age(61 * MINUTE);
  const name = await templateName(shop, 'cart_reminder');
  if (!quietUntil(new Date())) await world.until(async () => (await withTemplate(phone, name)).length || null, 12_000);
  await b.buy({ lines: [line(product, 2)] });
  await world.age(DAY);
  await world.quiet(3000);
  assert.ok((await withTemplate(phone, name)).length <= 1, 'A reminder went after the shopper ordered');
  const later = await shop.sql(`SELECT * FROM cart_reminders WHERE tenant_id = $1 AND step = 2 AND status = 'sent'`, [shop.tenantId]);
  assert.equal(later.length, 0);
  const [cart] = await shop.sql('SELECT status FROM carts WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  assert.equal(cart.status, 'ordered');
});

test('S-49: at most two reminders, about an hour and a day after the cart was left, and none for an emptied cart', async () => {
  const shop = await addP4Shop(world);
  const { b, phone } = await leftCart(shop, { whatsapp: true, email: false });
  const name = await templateName(shop, 'cart_reminder');
  for (let i = 0; i < 4; i++) {
    await world.age(DAY);
    await world.quiet(1500);
  }
  assert.ok((await withTemplate(phone, name)).length <= 2, 'More than two reminders for one abandoned cart');
  const emptied = await leftCart(shop, { whatsapp: true, email: false });
  ok(await emptied.b.putCart([]), 'Emptying the cart');
  await world.age(2 * DAY);
  await world.quiet(2000);
  assert.equal((await withTemplate(emptied.phone, name)).length, 0, 'A reminder went for an empty cart');
  void b;
});

test('S-50: a reminder due in quiet hours waits until 9 am India time', async () => {
  const shop = await addP4Shop(world);
  const { phone } = await leftCart(shop, { whatsapp: true, email: false });
  const name = await templateName(shop, 'cart_reminder');
  const now = new Date();
  const quiet = quietUntil(now);
  if (quiet) {
    await world.age(61 * MINUTE);
    await world.quiet(3000);
    assert.equal((await withTemplate(phone, name)).length, 0, 'A reminder went at night');
    const [row] = await shop.sql(`SELECT * FROM cart_reminders WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [shop.tenantId]);
    if (row) assert.ok(new Date(row.scheduled_for) >= new Date(quiet.getTime() - 60_000), `The reminder is set for ${row.scheduled_for}, before 9 am (${quiet.toISOString()})`);
    return;
  }
  // Daytime: leave the cart at 10 pm last night, so its one-hour mark fell at 11 pm and the next-day mark falls tonight.
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const lastNight22 = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - 1, 22) - 5.5 * 3_600_000;
  await world.age(now.getTime() - lastNight22);
  await world.quiet(3000);
  const sent = await withTemplate(phone, name);
  for (const m of sent) assert.equal(quietUntil(new Date(m.at)), null, 'A reminder was sent inside quiet hours');
  const rows = await shop.sql(`SELECT * FROM cart_reminders WHERE tenant_id = $1 AND status = 'scheduled'`, [shop.tenantId]);
  for (const r of rows) assert.equal(quietUntil(new Date(r.scheduled_for)), null, `A reminder is scheduled for ${r.scheduled_for}, inside quiet hours`);
});

test('S-51: an abandoned cart is never chased by Instagram DM, only on a channel the shopper said yes to', async () => {
  const shop = await addP4Shop(world);
  const fan = world.fan();
  await shop.dm(fan, 'Is the diya still available?');
  await shop.settle();
  const dmsBefore = (await shop.dms()).length;
  const { phone, email, b } = await leftCart(shop, { whatsapp: false, email: true });
  // A shopper signed in by WhatsApp has no email until one is saved; the contract's only way is saveDetails at a checkout, so it is written here.
  await shop.sql('UPDATE shoppers SET email = $3 WHERE tenant_id = $1 AND id = $2', [shop.tenantId, (await b.me()).id, email]);
  await world.age(25 * 60 * MINUTE);
  await world.quiet(3000);
  assert.equal((await shop.dms()).length, dmsBefore, 'An Instagram DM went out about the cart');
  assert.equal((await withTemplate(phone, await templateName(shop, 'cart_reminder'))).length, 0, 'A WhatsApp reminder went to a shopper who said no to WhatsApp marketing');
  const mails = (await world.emailsTo(email)).filter((m) => RESTORE.test(`${m.html}${m.text}`));
  if (!quietUntil(new Date())) assert.ok(mails.length >= 1, 'No email reminder for a shopper who said yes to email marketing');
  for (const m of mails) {
    assert.ok(m.headers['List-Unsubscribe'] || m.headers['list-unsubscribe'] || /unsubscribe/i.test(m.html), 'A marketing email has no unsubscribe link');
    noPlatformName('A reminder email', { from: m.from, subject: m.subject, html: m.html, text: m.text });
  }
  const none = await leftCart(shop, { whatsapp: false, email: false });
  await world.age(25 * 60 * MINUTE);
  await world.quiet(2000);
  assert.equal((await world.whatsappTo(none.phone)).filter((m) => RESTORE.test(JSON.stringify(m.body))).length, 0);
  assert.equal((await world.emailsTo(none.email)).length, 0, 'A shopper with no marketing consent got a reminder');
  void b;
});
