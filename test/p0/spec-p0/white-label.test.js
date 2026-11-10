// PRD 2: what a buyer sees carries the seller's brand, what a seller sees carries the platform's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER, addBusiness, addOrder, addProduct, addReel, api, assertBuyerPageClean, connectInstagram, consoleUser, hit, linksIn, need, noPlatformName, onConsole, sendComment, signIn, startWorld, waitFor } from './support.js';
import { buyerPaths, consolePaths, fakeMail, hooks, shopperPaths } from './surfaces.js';

const IG_ACCOUNT = 'IG-KESAR';
const REEL = '17900000000000030';
const CUSTOMER_EMAIL = 'asha@buyer.example';
const SELLER_LOGO = 'https://cdn.kesarhome.example/logo.png';

async function store(t, { plan = 't3', options } = {}) {
  const app = await startWorld(t, options);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home', plan });
  await connectInstagram(app, shop, IG_ACCOUNT);
  const seeded = await addReel(shop, REEL);
  return { app, shop, ...seeded };
}

/** A real comment on the reel, and the DM it causes. */
async function commentAndGetDm(app) {
  const before = app.ig.calls.length;
  need(await sendComment(app, IG_ACCOUNT, REEL), 200, 'Comment webhook');
  await waitFor(() => app.ig.calls.length > before);
  return app.ig.calls.slice(before);
}

/** A guest places an order, without an account. */
async function guestCheckout(app, shop, product, customer = CUSTOMER) {
  const body = { items: [{ productId: product.id, qty: 1 }], customer, guest: true };
  const named = await hit(app, buyerPaths.guestCheckout, { host: shop.host, method: 'POST', body });
  const res = named.status === 404 ? await hit(app, '/api/orders', { host: shop.host, method: 'POST', body }) : named;
  need(res, 201, 'Guest checkout');
  return res.json();
}

test('U-01: on a paid plan the DM link, landing page, store, product and checkout pages never show the platform name', async (t) => {
  const { app, shop, reel, products } = await store(t);
  const dm = await commentAndGetDm(app);
  assert.ok(dm.length > 0, 'the comment produced a DM');
  noPlatformName('The DM', dm);
  const links = linksIn(dm);
  assert.ok(links.length > 0, 'the DM carries a link');
  for (const link of links) {
    assert.equal(new URL(link).hostname, shop.host, 'the link is on the seller\'s own address');
    noPlatformName('The link domain', link);
  }
  await assertBuyerPageClean(app, shop, new URL(links[0]).pathname + new URL(links[0]).search);
  for (const page of [`/r/${reel.slug}`, '/', '/shop', '/about', `/p/${products[0].slug}`, `/r/${reel.slug}/p/${products[0].slug}`]) {
    await assertBuyerPageClean(app, shop, page);
  }
});

test('U-01: a guest can check out on a paid plan, and the checkout and order pages never show the platform name', async (t) => {
  const { app, shop, products } = await store(t);
  await assertBuyerPageClean(app, shop, '/checkout');
  const placed = await guestCheckout(app, shop, products[0]);
  noPlatformName('The checkout answer', placed);
  await assertBuyerPageClean(app, shop, `/order/${placed.token}`);
});

test('U-01: the invoice email and the invoice never show the platform name', async (t) => {
  const mail = fakeMail();
  const { app, shop, products } = await store(t, { options: { overrides: { [hooks.mail]: mail } } });
  const placed = await guestCheckout(app, shop, products[0], { ...CUSTOMER, email: CUSTOMER_EMAIL });
  await app.db.query(`UPDATE orders SET status = 'paid' WHERE public_token = $1`, [placed.token]);
  const message = await waitFor(() => mail.sent.find((m) => String(m.to).includes(CUSTOMER_EMAIL)), 10_000);
  assert.ok(message, 'No invoice email reached the guest');
  noPlatformName('The buyer email', message);
  await assertBuyerPageClean(app, shop, buyerPaths.invoice(placed.token));
});

test('U-05: an order alert email carries the platform\'s name and sender, with the seller\'s logo only as workspace identity', async (t) => {
  const mail = fakeMail();
  const { app, shop, products } = await store(t, { options: { overrides: { [hooks.mail]: mail } } });
  await shop.repos.brandKit.save({ logoUrl: SELLER_LOGO, colors: { primary: '#234D33' } });
  await app.db.query('UPDATE users SET email = $2 WHERE tenant_id = $1 AND role = $3', [shop.tenant.id, 'owner@seller.example', 'owner']);
  await addOrder(shop, products[0], { ...CUSTOMER, email: CUSTOMER_EMAIL });
  const alert = await waitFor(() => mail.sent.find((m) => String(m.to).includes('owner@seller.example')), 10_000);
  assert.ok(alert, 'No order alert reached the owner');
  assert.match(String(alert.from), /bhava/i, 'sender name and domain');
  assert.match(alert.html, /bhava/i, 'the platform\'s name or logo');
  assert.doesNotMatch(alert.html, /#234D33/i, 'the seller\'s colours are not used');
  const logos = alert.html.match(/cdn\.kesarhome\.example\/logo\.png/g) ?? [];
  assert.ok(logos.length <= 1, 'the seller\'s logo appears once at most');
});

test('U-05: the weekly report email carries the platform\'s name, logo and sender domain', async (t) => {
  const mail = fakeMail();
  const { app, shop } = await store(t, { options: { overrides: { [hooks.mail]: mail } } });
  await app.db.query('UPDATE users SET email = $2 WHERE tenant_id = $1 AND role = $3', [shop.tenant.id, 'owner@seller.example', 'owner']);
  const operator = await consoleUser(app);
  need(await onConsole(app, operator, consolePaths.runWeeklyReport(shop.tenant.id), { method: 'POST' }), [200, 201, 202], 'Run the weekly report');
  const report = await waitFor(() => mail.sent.find((m) => String(m.to).includes('owner@seller.example')), 10_000);
  assert.ok(report, 'No weekly report reached the owner');
  assert.match(String(report.from), /bhava/i, 'sender name and domain');
  assert.match(report.html, /bhava/i, 'the platform\'s name or logo');
  assert.match(report.html, /Kesar Home/, 'names the business as the workspace');
});

test('U-06: a default-gateway payment shows only the seller\'s brand, and the success page is on the seller\'s domain', async (t) => {
  const { app, shop, products } = await store(t);
  await shop.repos.brandKit.save({ logoUrl: SELLER_LOGO, colors: { primary: '#234D33' } });
  const order = await addOrder(shop, products[0]);
  const page = await assertBuyerPageClean(app, shop, `/order/${order.public_token}`);
  assert.match(page.text, /checkout\.razorpay\.com/, 'Razorpay Checkout is not on the page');
  assert.match(page.text, /["']?name["']?\s*:\s*["']Kesar Home["']/, 'the seller\'s name');
  assert.match(page.text, /["']?image["']?\s*:\s*["']https:\/\/cdn\.kesarhome\.example\/logo\.png["']/, 'the seller\'s logo');
  assert.match(page.text, /#234D33/i, 'the seller\'s colour');
  await app.db.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id]);
  const success = await assertBuyerPageClean(app, shop, buyerPaths.paymentSuccess(order.public_token));
  assert.match(success.text, /Kesar Home/);
});

test('U-07: the DM on the Free plan carries no platform text or link', async (t) => {
  const { app } = await store(t, { plan: 'free' });
  const dm = await commentAndGetDm(app);
  assert.ok(dm.length > 0, 'the comment produced a DM');
  noPlatformName('The Free plan DM', dm);
  for (const link of linksIn(dm)) noPlatformName('A link in the DM', new URL(link).hostname);
});

test('U-09: B\'s owner sees none of the orders or customers a shopper has at A', async (t) => {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const order = await addOrder(a, await addProduct(a, 'Lamp'), { ...CUSTOMER, name: 'Shared Shopper' });
  const token = await signIn(app, b);
  const orders = need(await api(app, b, token, '/orders'), 200, 'B\'s orders');
  assert.deepEqual(orders.json().items, []);
  const customers = need(await api(app, b, token, '/customers'), 200, 'B\'s customers');
  assert.doesNotMatch(customers.text, /Shared Shopper/);
  assert.equal((await api(app, b, token, `/orders/${order.id}`)).status, 404);
});

/** Stands in for WhatsApp, and reads the code back out of the message sent. */
function fakeWhatsapp() {
  const sent = [];
  return { sent, send: async (message) => void sent.push(message), lastCode: () => /\b(\d{6})\b/.exec(JSON.stringify(sent.at(-1)))?.[1] };
}

async function verifyShopper(app, business, whatsapp, phone) {
  need(await hit(app, shopperPaths.requestCode, { host: business.host, method: 'POST', body: { phone } }), [200, 201], `Request a code at ${business.name}`);
  const res = need(await hit(app, shopperPaths.verifyCode, { host: business.host, method: 'POST', body: { phone, code: whatsapp.lastCode() } }), [200, 201], `Verify the code at ${business.name}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

test('U-09: a shopper verified at A gets one consent screen naming the platform at each new business', async (t) => {
  const whatsapp = fakeWhatsapp();
  const app = await startWorld(t, { overrides: { [hooks.whatsapp]: whatsapp } });
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const phone = '9876501234';
  await verifyShopper(app, a, whatsapp, phone);
  const cookie = await verifyShopper(app, b, whatsapp, phone);

  const consent = need(await hit(app, shopperPaths.consent, { host: b.host, cookie }), 200, 'The consent screen at B');
  assert.match(consent.text, /bhava/i, 'the consent screen names the platform');
  assert.doesNotMatch(consent.text, /checked/i, 'the box starts unticked');
  need(await hit(app, shopperPaths.consent, { host: b.host, cookie, method: 'POST', body: { consent: true } }), [200, 201, 204, 303], 'Give consent');
  const again = await hit(app, shopperPaths.consent, { host: b.host, cookie });
  assert.ok(again.status === 204 || again.status === 303, `asked a second time at B: ${again.status}`);
  await assertBuyerPageClean(app, b, '/checkout', { cookie });
});
