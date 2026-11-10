// PRD 5.3: the brand kit reaches every buyer surface, and only buyer surfaces.
// The Razorpay Checkout display itself is rendered by Razorpay, so these tests read the options the server hands it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER, TINY_PNG, addBusiness, addOrder, addProduct, addReel, api, assertBuyerPageClean, hit, need, noPlatformName, pageSource, pause, signIn, signInCookie, startWorld, uploadFile } from './support.js';
import { buyerPaths, fakeMail, hooks, kitFields } from './surfaces.js';

const GREEN = '#234D33';
const FONT = 'Playfair Display';

async function storeWithKit(t, options) {
  const app = await startWorld(t, options);
  const shop = await addBusiness(app, { slug: 'mehtamart', name: 'Mehta Mart' });
  const token = await signIn(app, shop);
  return { app, shop, token };
}

const usesKit = (source) => /#234D33/i.test(source) && /Playfair[ +]Display/.test(source);

async function within60s(check) {
  for (const end = Date.now() + 60_000; ;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await pause(1000);
  }
}

/** The checkout page, as a guest or, until guest checkout exists, as a signed-in shopper. */
async function openCheckout(app, shop) {
  const guest = await hit(app, '/checkout', { host: shop.host });
  if (guest.status === 200) return {};
  const shopper = { phone: '9812345678', password: 'shopper-pass' };
  await shop.repos.users.create({ name: 'Asha K', ...shopper });
  return { cookie: await signInCookie(app, shop, shopper) };
}

test('F-11: a saved primary colour and font reach the storefront, landing page and checkout within 60 s', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  const { reel } = await addReel(shop, '17900000000000010');
  const access = await openCheckout(app, shop);
  need(await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { colors: { primary: GREEN }, headingFont: FONT } }), 200, 'Save the brand kit');

  for (const [surface, pathname, options] of [['storefront', '/', {}], ['landing page', `/r/${reel.slug}`, {}], ['checkout', '/checkout', access]]) {
    const applied = await within60s(async () => {
      const { res, source } = await pageSource(app, shop.host, pathname, options);
      return res.status === 200 && usesKit(source);
    });
    assert.ok(applied, `The ${surface} did not use the saved colour and font within 60 s`);
  }
});

test('F-11: the shopper email uses the saved colour and font', async (t) => {
  const mail = fakeMail();
  const { app, shop, token } = await storeWithKit(t, { overrides: { [hooks.mail]: mail } });
  need(await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { colors: { primary: GREEN }, headingFont: FONT } }), 200, 'Save the brand kit');
  await addOrder(shop, await addProduct(shop, 'Lamp'), { ...CUSTOMER, email: 'asha@buyer.example' });
  const message = await within60s(async () => mail.sent.find((m) => String(m.to).includes('asha@buyer.example')));
  assert.ok(message, 'No email reached the shopper');
  assert.ok(usesKit(message.html), 'The email did not use the saved colour and font');
});

test('F-12: primary and on_primary at 2:1 contrast are blocked, naming both fields', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  const before = need(await api(app, shop, token, '/brand-kit'), 200, 'Read the kit').json();
  const res = await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { colors: { primary: '#808080', on_primary: '#404040' } } });
  assert.equal(res.status, 400);
  const body = res.json();
  assert.equal(body.code, 'validation_failed');
  const named = `${body.error} ${JSON.stringify(body.fields ?? {})}`;
  assert.match(named, /on_primary/, 'names on_primary');
  assert.match(named, /(?<!on_)primary/, 'names primary');
  assert.deepEqual(need(await api(app, shop, token, '/brand-kit'), 200, 'Read the kit').json().colors, before.colors, 'nothing was saved');
});

test('F-12: changing one colour so the pair falls below 4.5:1 is blocked too, and 4.5:1 passes', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  const save = (colors) => api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { colors } });
  need(await save({ primary: '#000000', on_primary: '#FFFFFF' }), 200, 'A clear pair');
  assert.equal((await save({ on_primary: '#111111' })).status, 400, 'on_primary alone, against the saved primary');
  need(await save({ primary: '#767676', on_primary: '#FFFFFF' }), 200, '#767676 on white is just above 4.5:1');
  assert.equal((await save({ primary: '#777777', on_primary: '#FFFFFF' })).status, 400, '#777777 on white is just below 4.5:1');
});

const HOSTILE_SVGS = {
  'a script tag': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="4"/></svg>',
  'an onload attribute': '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="4"/></svg>',
  'a javascript link': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  'embedded HTML': '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>',
  'a capitalised script tag in CDATA': '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT><![CDATA[alert(1)]]></SCRIPT></svg>',
};
const ACTIVE_CONTENT = /<script|\bon[a-z]+\s*=|javascript:|<foreignObject/i;

test('F-13: an SVG logo containing script is stripped or rejected', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  need(await uploadFile(app, shop, token), 201, 'Positive control: a plain PNG uploads');
  for (const [what, svg] of Object.entries(HOSTILE_SVGS)) {
    const res = await uploadFile(app, shop, token, { filename: 'logo.svg', mime: 'image/svg+xml', data: svg });
    if (res.status >= 400) {
      assert.ok([400, 415].includes(res.status), `${what}: refused with ${res.status}`);
      continue;
    }
    need(res, 201, what);
    const served = need(await hit(app, res.json().url, { host: shop.host }), 200, `${what}: serving the upload`);
    assert.doesNotMatch(served.text, ACTIVE_CONTENT, `${what} survived`);
  }
});

test('F-13: an SVG disguised as a PNG is not served as active content', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  need(await uploadFile(app, shop, token), 201, 'Positive control: a plain PNG uploads');
  const res = await uploadFile(app, shop, token, { filename: 'logo.png', mime: 'image/png', data: HOSTILE_SVGS['a script tag'] });
  if (res.status >= 400) return; // refused because the bytes are not a PNG: also fine
  const served = need(await hit(app, res.json().url, { host: shop.host }), 200, 'Serving the upload');
  assert.doesNotMatch(served.headers['content-type'], /svg|html|xml/i);
});

test('F-14: a sender set before DKIM is verified sends from the neutral domain under the business name', async (t) => {
  const mail = fakeMail();
  const { app, shop, token } = await storeWithKit(t, { overrides: { [hooks.mail]: mail } });
  need(await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { [kitFields.buyerEmailSender]: 'orders@mehtamart.example' } }), 200, 'Save the sender');
  await addOrder(shop, await addProduct(shop, 'Lamp'), { ...CUSTOMER, email: 'asha@buyer.example' });
  const message = await within60s(async () => mail.sent.find((m) => String(m.to).includes('asha@buyer.example')));
  assert.ok(message, 'No email reached the shopper');
  const from = String(message.from);
  assert.match(from, /Mehta Mart/, 'shows the business name');
  assert.doesNotMatch(from, /mehtamart\.example/, 'does not use the unverified domain');
  noPlatformName('The sender', from);
});

const VARIANTS = ['Sent!', 'Check your DMs', 'Just messaged you', 'Look in your inbox', 'It is on the way'];

test('F-15: an owner saves 5 public-reply variants and they are stored on the kit', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  need(await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { [kitFields.publicReplies]: VARIANTS } }), 200, 'Save the variants');
  assert.deepEqual(need(await api(app, shop, token, '/brand-kit'), 200, 'Read the kit').json()[kitFields.publicReplies], VARIANTS);
});

test('F-15: fewer than 5 or more than 10 variants, or one with a link, are refused', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  const save = (list) => api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { [kitFields.publicReplies]: list } });
  need(await save(VARIANTS), 200, 'Positive control: 5 variants');
  assert.equal((await save(VARIANTS.slice(0, 4))).status, 400, '4 variants');
  assert.equal((await save(Array.from({ length: 11 }, (_, i) => `Reply number ${i}`))).status, 400, '11 variants');
  assert.equal((await save([...VARIANTS.slice(0, 4), 'See https://example.com'])).status, 400, 'a link');
  assert.equal((await save([...VARIANTS.slice(0, 4), 'x'.repeat(151)])).status, 400, 'over 150 characters');
});

async function paidOrder(t) {
  const { app, shop, token } = await storeWithKit(t);
  need(await api(app, shop, token, '/brand-kit', { method: 'PATCH', body: { colors: { primary: GREEN }, headingFont: FONT, logoUrl: 'https://cdn.mehtamart.example/logo.png' } }), 200, 'Save the brand kit');
  const order = await addOrder(shop, await addProduct(shop, 'Lamp'));
  return { app, shop, token, order };
}

test('F-74: the default-gateway checkout hands Razorpay the seller\'s name, logo and colour', async (t) => {
  const { app, shop, order } = await paidOrder(t);
  const res = need(await hit(app, `/order/${order.public_token}`, { host: shop.host }), 200, 'Order page');
  assert.match(res.text, /checkout\.razorpay\.com/, 'Razorpay Checkout is not on the page');
  assert.match(res.text, /["']?name["']?\s*:\s*["']Mehta Mart["']/, 'name option');
  assert.match(res.text, /["']?image["']?\s*:\s*["']https:\/\/cdn\.mehtamart\.example\/logo\.png["']/, 'logo option');
  assert.match(res.text, /["']?color["']?\s*:\s*["']#234D33["']/i, 'theme colour option');
  noPlatformName('Checkout options', res.text);
});

test('F-76: the order page in every status is on the seller\'s domain in the seller\'s kit', async (t) => {
  const { app, shop, order } = await paidOrder(t);
  for (const status of ['awaiting_payment', 'payment_submitted', 'paid', 'shipped', 'cancelled']) {
    await app.db.query('UPDATE orders SET status = $2 WHERE id = $1', [order.id, status]);
    await assertBuyerPageClean(app, shop, `/order/${order.public_token}`);
    const { source } = await pageSource(app, shop.host, `/order/${order.public_token}`);
    assert.ok(usesKit(source), `status ${status} does not use the seller's kit`);
  }
});

test('F-76: the payment success, failure and pending pages and the tracking page are seller-branded', async (t) => {
  const { app, shop, order } = await paidOrder(t);
  for (const [name, pathname] of Object.entries({
    success: buyerPaths.paymentSuccess(order.public_token),
    failure: buyerPaths.paymentFailure(order.public_token),
    pending: buyerPaths.paymentPending(order.public_token),
    tracking: buyerPaths.tracking(order.public_token),
  })) {
    const res = await assertBuyerPageClean(app, shop, pathname);
    assert.match(res.text, /Mehta Mart/, `${name} page names the seller`);
    const { source } = await pageSource(app, shop.host, pathname);
    assert.ok(usesKit(source), `${name} page does not use the seller's kit`);
    assert.doesNotMatch(res.text, /shiprocket/i, `${name} page shows the shipping partner`);
  }
});

test('F-13: a plain PNG logo is still accepted and served as a PNG', async (t) => {
  const { app, shop, token } = await storeWithKit(t);
  const uploaded = need(await uploadFile(app, shop, token), 201, 'Upload a PNG').json();
  const served = need(await hit(app, uploaded.url, { host: shop.host }), 200, 'Serving the PNG');
  assert.match(served.headers['content-type'], /image\/png/);
  assert.deepEqual(served.raw, TINY_PNG);
});
