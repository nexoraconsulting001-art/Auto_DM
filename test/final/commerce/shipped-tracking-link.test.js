// commerce-4 (F-89, S-78): the shipped and delivered alerts link to the seller's tracking page (/track/), not the order page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderAlertsFor } from '../../../src/modules/order-alerts/index.js';
import { alertsApp, alertsOf, emailsTo, inTenant, paidOrder, product, whatsappTo } from '../../p4/alerts-sync/support.js';

test('commerce-4: shipped and delivered alerts link to /track/, the paid alert to /order/', async () => {
  const app = await alertsApp();
  try {
    const { alerts } = orderAlertsFor(app.ctx);
    const lamp = await product(app, { pricePaise: 49900 });
    const order = await paidOrder(app, { productId: lamp.id, phone: '+919811100088', email: 'tara@mail.example' });
    for (const kind of ['shipped', 'delivered']) await inTenant(app, () => alerts.raise(order, kind));
    const rows = await alertsOf(app, order.id);
    assert.equal(rows.filter((r) => r.status === 'sent').length, 6);
    const links = (await whatsappTo(app, '+919811100088')).map((m) => [m.body.template.name, m.body.template.components[0].parameters.at(-1).text]);
    const by = Object.fromEntries(links);
    assert.match(by.order_paid, /\/order\//);
    assert.match(by.order_shipped, /\/track\/[A-Za-z0-9_-]+/);
    assert.match(by.order_delivered, /\/track\/[A-Za-z0-9_-]+/);
    const mails = await emailsTo(app, 'tara@mail.example');
    const shipped = mails.find((m) => /shipped/i.test(m.subject));
    assert.match(shipped.html, /\/track\//);
  } finally {
    await app.close();
  }
});
