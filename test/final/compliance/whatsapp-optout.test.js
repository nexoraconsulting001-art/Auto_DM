// compliance-3: a WhatsApp opt-out in Hindi or Hinglish, or in a word the seller added, stops marketing as well as automation:
// the shopper's yes to WhatsApp marketing is withdrawn and their scheduled WhatsApp cart reminders are cancelled, as STOP does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCartReminders } from '../../../src/modules/abandoned-cart/reminders.js';
import { orderAlertsFor } from '../../../src/modules/order-alerts/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { alertsApp, consentOf, daytime, hit, lastIst, product, q, shopper, shopperCsrf } from '../../p4/alerts-sync/support.js';

/** A signed-in shopper who said yes to WhatsApp marketing, with a cart left long enough ago for a reminder to be planned. */
async function leftCart(app, phone, name) {
  const item = await product(app, { name, pricePaise: 12000, stock: 10 });
  const who = await shopper(app, { phone });
  await consentOf(app, { shopperId: who.id, phone }, { marketing: { whatsapp: true } });
  const put = await hit(app, '/api/store/cart', { method: 'PUT', cookie: who.cookie, headers: shopperCsrf(app, who.cookie), body: { lines: [{ productId: item.id, variantId: null, qty: 1 }] } });
  assert.equal(put.status, 200, put.text);
  const [cart] = await q(app, `SELECT id FROM carts WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'active'`, [app.tenant.id, who.id]);
  await q(app, 'UPDATE carts SET last_activity_at = $3 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, cart.id, lastIst(10, new Date(Date.now() - 2 * 3_600_000))]);
  return { ...who, phone, cartId: cart.id };
}
const scheduled = async (app, who) => q(app, `SELECT id FROM cart_reminders WHERE tenant_id = $1 AND shopper_id = $2 AND channel = 'whatsapp' AND status = 'scheduled'`, [app.tenant.id, who.id]);
const stopped = async (app, who) => q(app, `SELECT id FROM cart_reminders WHERE tenant_id = $1 AND shopper_id = $2 AND channel = 'whatsapp' AND status = 'cancelled' AND stop_reason = 'opted_out'`, [app.tenant.id, who.id]);
const marketingAllowed = async (app, who) => (await withTenant(app.tenant, () => app.ctx.platform.consent.allows({ purpose: 'marketing', channel: 'whatsapp', shopperId: who.id, phone: who.phone }))).granted;

test('compliance-3: "band karo", "बंद करो" and a word the seller added withdraw WhatsApp marketing and cancel cart reminders', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    await withTenant(app.tenant, () => app.ctx.repos.compliance.addWord('optout', 'bas karo ji'));
    const [{ phone_number_id: phoneId }] = await q(app, 'SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    await app.wa.post('/webhooks/url', { url: `${app.base}/webhooks/whatsapp` });
    const reminders = createCartReminders(app.ctx, { clock: () => daytime() });

    const people = [['+919822200101', 'band karo', 'Diya set'], ['+919822200102', 'बंद करो', 'Rug'], ['+919822200103', 'Bas karo ji', 'Lamp']];
    const shoppers = [];
    for (const [phone, , name] of people) shoppers.push(await leftCart(app, phone, name));
    await reminders.run();
    for (const who of shoppers) {
      assert.ok((await scheduled(app, who)).length >= 1, 'a reminder is planned');
      assert.equal(await marketingAllowed(app, who), true);
    }

    for (const [i, [phone, word]] of people.entries()) {
      await app.wa.post('/inbound', { phoneId, from: phone.slice(1), text: word });
      await orderAlertsFor(app.ctx).webhook.settle();
      const who = shoppers[i];
      assert.equal((await scheduled(app, who)).length, 0, `"${word}" leaves no reminder planned`);
      assert.ok((await stopped(app, who)).length >= 1, `"${word}" cancels the reminder as opted out`);
      assert.equal(await marketingAllowed(app, who), false, `"${word}" withdraws the yes to WhatsApp marketing`);
    }
  } finally {
    await app.close();
  }
});

test('compliance-3: a sentence that only contains the words is not an opt-out', async () => {
  const app = await alertsApp();
  try {
    await app.api('PATCH', '/cart-reminders', { enabled: true });
    const [{ phone_number_id: phoneId }] = await q(app, 'SELECT phone_number_id FROM whatsapp_accounts WHERE tenant_id = $1', [app.tenant.id]);
    await app.wa.post('/webhooks/url', { url: `${app.base}/webhooks/whatsapp` });
    const who = await leftCart(app, '+919822200201', 'Shawl');
    await createCartReminders(app.ctx, { clock: () => daytime() }).run();
    await app.wa.post('/inbound', { phoneId, from: who.phone.slice(1), text: 'shop band karo kab tak?' });
    await orderAlertsFor(app.ctx).webhook.settle();
    assert.ok((await scheduled(app, who)).length >= 1);
    assert.equal(await marketingAllowed(app, who), true);
  } finally {
    await app.close();
  }
});
