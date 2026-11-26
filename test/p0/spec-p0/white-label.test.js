// PRD 2: what a buyer sees carries the seller's brand, what a seller sees carries the platform's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER, addBusiness, addOrder, connectWhatsapp, drainNotifications, addProduct, addReel, api, assertBuyerPageClean, connectInstagram, hit, linksIn, need, noPlatformName, placeOrder, sendComment, signIn, startWorld, waitFor } from './support.js';
import { buyerPaths, fakeMail, fakeWhatsapp, hooks, orderStates, shopperPaths } from './surfaces.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { withTenant } from '../../../src/tenancy.js';
import { QUEUE_PERIODIC, jobHandlers } from '../../../src/modules/reports/jobs.js';

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

/** A guest places an order at the store's own checkout, without an account. Answers the order row; `answer` is what checkout said. */
const guestCheckout = (app, shop, product, customer = CUSTOMER, extra = {}) => placeOrder(app, shop, product, { customer, ...extra });

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
  noPlatformName('The checkout answer', placed.answer);
  await assertBuyerPageClean(app, shop, `/order/${placed.public_token}`);
});

test('U-01: the invoice email and the invoice never show the platform name', async (t) => {
  const mail = fakeMail();
  const { app, shop, products } = await store(t, { options: { overrides: { [hooks.mail]: mail } } });
  const placed = await guestCheckout(app, shop, products[0], CUSTOMER, { email: CUSTOMER_EMAIL, paid: true });
  const message = await waitFor(async () => (await mail.messages()).find((m) => String(m.to).includes(CUSTOMER_EMAIL)), 10_000);
  assert.ok(message, 'No invoice email reached the guest');
  noPlatformName('The buyer email', message);
  // The invoice is a PDF drawn from the document's own row: the row (seller, buyer, brand, lines) and the file's headers are read.
  const [invoice] = await app.db.query('SELECT * FROM invoices WHERE tenant_id = $1 AND order_id = $2', [shop.tenant.id, placed.id]);
  assert.ok(invoice, 'No invoice was made for the paid order');
  noPlatformName('The invoice', invoice);
  const file = need(await hit(app, buyerPaths.invoice(placed.public_token, invoice.number), { host: shop.host }), 200, 'The buyer\'s invoice');
  assert.match(file.headers['content-type'], /pdf/);
  noPlatformName('The invoice file headers', file.headers);
});

test('U-05: an order alert email carries the platform\'s name and sender, with the seller\'s logo only as workspace identity', async (t) => {
  const mail = fakeMail();
  const { app, shop, products } = await store(t, { options: { overrides: { [hooks.mail]: mail } } });
  await shop.repos.brandKit.save({ logoUrl: SELLER_LOGO, colors: { primary: '#234D33' } });
  await app.db.query('UPDATE users SET email = $2 WHERE tenant_id = $1 AND role = $3', [shop.tenant.id, 'owner@seller.example', 'owner']);
  await placeOrder(app, shop, products[0], { customer: CUSTOMER, email: CUSTOMER_EMAIL, paid: true });
  const alert = await waitFor(async () => (await drainNotifications(app), (await mail.messages()).find((m) => String(m.to).includes('owner@seller.example'))), 10_000);
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
  // The weekly report is not run from the console: the reports job runs it for each business on its Monday (src/modules/reports/jobs.js).
  const week = { kind: 'weekly', periodStart: '2026-11-16', periodEnd: '2026-11-22' };
  await withTenant(shop.tenant, () => jobHandlers(app.ctx)[QUEUE_PERIODIC]({ payload: week, attempt: 1 }));
  const report = await waitFor(async () => (await drainNotifications(app), (await mail.messages()).find((m) => String(m.to).includes('owner@seller.example'))), 10_000);
  assert.ok(report, 'No weekly report reached the owner');
  assert.match(String(report.from), /bhava/i, 'sender name and domain');
  assert.match(report.html, /bhava/i, 'the platform\'s name or logo');
  assert.match(report.html, /Kesar Home/, 'names the business as the workspace');
});

test('U-06: a default-gateway payment shows only the seller\'s brand, and the success page is on the seller\'s domain', async (t) => {
  const { app, shop, products } = await store(t);
  await shop.repos.brandKit.save({ logoUrl: SELLER_LOGO, colors: { primary: '#234D33' } });
  const order = await placeOrder(app, shop, products[0]);
  const page = await assertBuyerPageClean(app, shop, `/order/${order.public_token}`);
  assert.match(page.headers['content-security-policy'], /checkout\.razorpay\.com/, 'Razorpay Checkout is not allowed on the page');
  // What the payment script hands Razorpay Checkout is what the server answers when the shopper taps Pay.
  const pay = need(await hit(app, `/api/store/orders/${order.public_token}/retry`, { host: shop.host, method: 'POST', headers: { origin: `https://${shop.host}` }, body: {} }), 200, 'Tap Pay');
  const { display } = pay.json().gateway;
  assert.equal(display.name, 'Kesar Home', 'the seller\'s name');
  assert.equal(display.image, SELLER_LOGO, 'the seller\'s logo');
  assert.match(display.color, /^#234D33$/i, 'the seller\'s colour');
  noPlatformName('The payment options', pay.text);
  await orderStates.success(app, order);
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

/**
 * A shopper's browser at one business: opens the checkout page (which sets the cookie and carries the CSRF token the store's
 * own script reads), asks for a WhatsApp code and enters it. Answers the cookies of the signed-in shopper.
 */
async function verifyShopper(app, business, whatsapp, phone) {
  const open = need(await hit(app, '/checkout', { host: business.host }), 200, `Open checkout at ${business.name}`);
  const jar = (open.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
  const csrf = /data-csrf="([^"]+)"|"csrf(?:Token)?"\s*:\s*"([^"]+)"|name="csrf-token" content="([^"]+)"/.exec(open.text);
  const headers = { origin: `https://${business.host}`, ...(csrf ? { 'x-csrf-token': csrf[1] ?? csrf[2] ?? csrf[3] } : {}) };
  const cookie = jar.join('; ');
  need(await hit(app, shopperPaths.requestCode, { host: business.host, method: 'POST', cookie, headers, body: { phone, purpose: 'sign_in' } }), [200, 201], `Request a code at ${business.name}`);
  const res = need(await hit(app, shopperPaths.verifyCode, { host: business.host, method: 'POST', cookie, headers, body: { phone, purpose: 'sign_in', code: await whatsapp.lastCode(phone) } }), [200, 201], `Verify the code at ${business.name}`);
  return [...jar, ...res.headers['set-cookie'].map((c) => c.split(';')[0])].join('; ');
}

test('U-09: a shopper verified at A gets one consent screen naming the platform at each new business', async (t) => {
  const whatsapp = fakeWhatsapp();
  const app = await startWorld(t, { overrides: { [hooks.whatsapp]: whatsapp } });
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const sid = (cookie) => /(?:^|;\s*)_sid=([^;]+)/.exec(cookie)[1];
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  const phone = '9876501234';
  for (const business of [a, b]) await connectWhatsapp(app, business, whatsapp);
  await verifyShopper(app, a, whatsapp, phone);
  const cookie = await verifyShopper(app, b, whatsapp, phone);

  const consent = need(await hit(app, shopperPaths.consent, { host: b.host, cookie }), 200, 'The consent screen at B');
  assert.match(consent.text, /bhava/i, 'the consent screen names the platform');
  const box = /<input[^>]*type="checkbox"[^>]*>/i.exec(consent.text)?.[0];
  assert.ok(box, 'the consent screen has its box');
  assert.doesNotMatch(box, /\bchecked\b/i, 'the box starts unticked');
  const noticeVersion = Number(/noticeVersion:\s*(\d+)/.exec(consent.text)?.[1] ?? 1);
  const headers = { origin: `https://${b.host}`, 'x-shopper-csrf': csrfFor(app.config, sid(cookie)) };
  need(await hit(app, shopperPaths.consentSave, { host: b.host, cookie, headers, method: 'POST', body: { noticeVersion, agree: true, next: '/checkout' } }), [200, 201, 204, 303], 'Give consent');
  const again = await hit(app, shopperPaths.consent, { host: b.host, cookie });
  // The page is the saved state now (with a way to withdraw), never the ask again: no box to tick.
  assert.ok(again.status === 204 || again.status === 303 || (again.status === 200 && !/id="sp-agree"/.test(again.text) && /id="sp-withdraw"/.test(again.text)), `asked a second time at B: ${again.status}`);
  await assertBuyerPageClean(app, b, '/checkout', { cookie });
});
