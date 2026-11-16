// Final review, medium buyer findings, the parts outside the web pages: buyer-5 (the shipping message links to the seller's own
// tracking page) and buyer-6 (the app offers a return only while one can be asked for, as the web does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../../src/tenancy.js';
import { changeOrder } from '../../../src/modules/orders/state.js';
import { orderAlertsFor } from '../../../src/modules/order-alerts/index.js';
import { PLATFORM, alertsApp, emailsTo, hit, inTenant, paidOrder, product, whatsappTo } from '../../p4/alerts-sync/support.js';
import { appWorld, json, markPaid, orderByNumber, payments, placeBody, product as appProduct, signedInApp } from '../../p6/shopper-api/support.js';

const TRACK = /^https:\/\/shop\.test\/track\/[0-9a-z]+\.[A-Za-z0-9_-]{22}$/;

test('buyer-5 (S-78, F-89): the shipped WhatsApp and email link to the seller’s tracking page; other updates keep the order page', async () => {
  const app = await alertsApp();
  try {
    const { alerts } = orderAlertsFor(app.ctx);
    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100078', email: 'meera@mail.example' });
    await inTenant(app, () => alerts.raise(order, 'shipped'));
    await inTenant(app, () => alerts.raise(order, 'delivered'));

    const sent = await whatsappTo(app, '+919811100078');
    const linkOf = (name) => sent.find((m) => m.body.template.name === name).body.template.components[0].parameters[3].text;
    const shippedLink = linkOf('order_shipped');
    assert.match(shippedLink, TRACK, 'the shipped WhatsApp does not link to the tracking page');
    assert.equal(linkOf('order_delivered'), `https://shop.test/order/${order.public_token}`, 'other updates keep the order page');

    const mail = (await emailsTo(app, 'meera@mail.example')).find((m) => /ship/i.test(m.subject));
    assert.ok(mail, 'no shipped email');
    assert.ok(mail.text.includes(`Track your order: ${shippedLink}`), 'the shipped email does not link to the tracking page');
    assert.ok(mail.html.includes(`href="${shippedLink}"`));
    assert.doesNotMatch(`${mail.text}${shippedLink}`, PLATFORM);

    // The link opens the seller's own tracking page for that order.
    const page = await hit(app, new URL(shippedLink).pathname, { host: 'shop.test' });
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`Order ${order.order_number}`));
  } finally {
    await app.close();
  }
});

test('buyer-6 (S-57): the app’s canReturn is true inside the return window and false after it, as on the web', async () => {
  const w = await appWorld();
  try {
    const { app } = w;
    await payments(app);
    const lamp = await appProduct(app, { name: 'Brass lamp', pricePaise: 50000, stock: 9 });
    await withTenant(app.tenant, () => app.ctx.returns.settings.update({ enabled: true, windowDays: 7 }, 'user:1'));
    const a = await signedInApp(w, { phone: '9876543210' });
    const placed = await json(await a.fetch('/api/store/checkout', { method: 'POST', body: placeBody(lamp.id, { lines: [{ productId: lamp.id, variantId: null, qty: 1 }] }) }));
    assert.equal(placed.status, 201, placed.text);
    const order = await orderByNumber(app, placed.body.orderNumber);
    await markPaid(app, order.id, { confirm: true });
    for (const to of ['packed', 'shipped', 'delivered']) await withTenant(app.tenant, () => app.db.tx((t) => changeOrder(t, order.id, { fulfilment: to, actor: 'user:1' })));
    await app.ctx.orderEvents.settle();

    const path = `/api/store/app/orders/${encodeURIComponent(order.order_number)}`;
    const fresh = await json(await a.fetch(path));
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal(fresh.body.canReturn, true, 'a delivered order inside the window can be returned');

    await app.db.platform.tx(async (tx) => {
      await tx.exec('ALTER TABLE orders DISABLE TRIGGER USER');
      await tx.query('UPDATE orders SET delivered_at = now() - make_interval(days => 10) WHERE id = $1', [order.id]);
      await tx.exec('ALTER TABLE orders ENABLE TRIGGER USER');
    });
    const late = await json(await a.fetch(path));
    assert.equal(late.status, 200, late.text);
    assert.equal(late.body.canReturn, false, 'the app offers a return after the 7-day window has passed');
  } finally {
    await w.close();
  }
});
