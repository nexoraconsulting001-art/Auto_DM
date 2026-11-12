// PRD 10.7 (the shopper app's server half): browsing with no login, the gate every app request passes (business from the host,
// X-App-Tenant, minimum version), guest checkout, a test-card payment, and the seller's brand only. P-27, P-28, P-29, P-31.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accepted, addAppShop, assertNoPlatformName, buyer, line, namesPlatform, refusedStatus, stockedProducts, together, useP6World, APP_LIMITS } from './kit.js';

const world = useP6World();

/** A store with the app on, two products, a reel showing both, and a category holding the reel. */
async function appStore(options = {}) {
  const shop = await addAppShop(world, options);
  const products = await stockedProducts(shop, 2);
  const page = await shop.page({ productIds: products.map((p) => p.id), caption: 'Brunch edit' });
  const category = await shop.category(`Kitchen ${shop.tenantId}`);
  await shop.addToCategory(category.id, page.id);
  return { shop, products, page, category };
}

test('P-27: browsing shows the catalog and Reels with no login, and no answer asks for one', async () => {
  const { shop, products, page } = await appStore({ name: 'Kesar Kitchen' });
  const app = shop.app();
  // Before any session at all the app can learn the store's name and theme.
  const boot = accepted(await app.get('/api/store/app/bootstrap'), 'Bootstrap with no session');
  assert.equal(boot.data.name, shop.name.slice(0, 30));
  assert.ok(boot.data.theme.colors && boot.data.supportEmail);
  assert.match(boot.headers['cache-control'] ?? '', /no-store/, 'Every app answer is no-store');
  // A guest session opens with one call and no credentials.
  const started = await app.start('guest');
  assert.equal(started.status, 201, `A guest session did not open: ${started.text.slice(0, 200)}`);
  assert.equal(started.data.guest, true);
  assert.equal(started.data.shopper, null);
  assert.match(started.data.accessToken, /^sa_/);
  assert.match(started.data.refreshToken, /^sr_/);
  for (const path of ['/api/store/app/home', '/api/store/app/catalog', '/api/store/app/reels', '/api/store/app/categories', `/api/store/app/products/${products[0].slug}`, `/api/store/app/landing/${page.slug}`]) {
    const res = await app.get(path);
    assert.equal(res.status, 200, `${path} asked for a login or failed: ${res.status} ${res.text.slice(0, 200)}`);
    assert.match(res.headers['cache-control'] ?? '', /no-store/, `${path} must be no-store`);
  }
  const home = (await app.get('/api/store/app/home')).data;
  assert.ok(home.products.length >= 2 && home.reels.length >= 1, 'Home shows products and reels');
  for (const p of home.products) assert.ok(Number.isInteger(p.pricePaise), 'Prices are whole paise');
  const catalog = (await app.get('/api/store/app/catalog')).data;
  assert.deepEqual(catalog.items.map((p) => p.id).sort(), products.map((p) => p.id).sort());
  const reels = (await app.get('/api/store/app/reels')).data;
  assert.ok(reels.items.some((r) => r.slug === page.slug));
  // The same browse without the session works too: browsing never needs a login.
  const bare = shop.app();
  assert.equal((await bare.get('/api/store/app/catalog')).status, 200, 'Browsing with no session at all');
  // The signed-in-only routes do ask.
  refusedStatus(await bare.get('/api/store/app/orders'), 'Orders with no session', [401]);
  refusedStatus(await app.get('/api/store/app/orders'), 'Orders with a guest session', [401, 403]);
  refusedStatus(await app.get('/api/store/app/rewards'), 'Rewards with a guest session', [401, 403]);
});

test('P-27: the business comes from the host; a build for one business gets nothing from another, and a tampered X-App-Tenant is a bare 404', async () => {
  const a = await appStore({ name: 'Kesar Kitchen' });
  const b = await appStore({ name: 'Mitti Mart' });
  const appA = a.shop.app();
  assert.equal((await appA.start('guest')).status, 201);
  // The shopper app of A calling B's host.
  const crossed = a.shop.app({ host: b.shop.host });
  const res = await crossed.get('/api/store/app/home');
  assert.equal(res.status, 404, 'A build for one business on another business\'s host');
  assert.equal(res.text, '', 'The answer holds nothing');
  assert.ok(!res.text.includes(b.shop.name) && !res.text.includes(a.shop.name));
  assert.equal((await crossed.start('guest')).status, 404, 'No session is opened for a mismatched build either');
  // The same build with its tenant id changed, on its own host.
  for (const tampered of [b.shop.tenantId, 0, 999_999, '1; DROP TABLE tenants', ' ', '-1']) {
    const t = a.shop.app({ tenantId: tampered });
    for (const path of ['/api/store/app/bootstrap', '/api/store/app/home', '/api/store/app/catalog']) {
      const r = await t.get(path);
      assert.equal(r.status, 404, `X-App-Tenant ${tampered} on ${path} answered ${r.status}`);
      assert.equal(r.text, '', `X-App-Tenant ${tampered} on ${path} answered a body`);
    }
  }
  // The header missing, or a different app, or a different platform word.
  assert.ok((await appA.get('/api/store/app/home', { 'x-app-tenant': '' })).status >= 400);
  assert.ok((await appA.get('/api/store/app/home', { 'x-app': 'owner' })).status >= 400, 'The owner app is not a shopper app');
  assert.ok((await appA.get('/api/store/app/home', { 'x-app-platform': 'web' })).status >= 400);
  assert.ok((await appA.get('/api/store/app/home', { 'x-app-platform': 'windows' })).status >= 400);
  // A session of A is no session on B, whichever tenant id the call claims.
  const token = appA.tokens.accessToken;
  const forged = b.shop.app();
  forged.tokens.accessToken = token;
  assert.equal((await forged.get('/api/store/app/me')).status, 401, 'A token of one business on another');
  const lying = b.shop.app({ tenantId: a.shop.tenantId });
  lying.tokens.accessToken = token;
  assert.equal((await lying.get('/api/store/app/me')).status, 404);
  // The shop is not found as a different business just because the platform word changes.
  const rows = await b.shop.appSessions();
  assert.equal(rows.length, 0, 'Nothing was written for the other business');
});

test('P-27: below the minimum version is 426 with the store link, the minimum itself and above are fine, and the platforms are independent', async () => {
  const { shop } = await appStore({ platforms: ['android', 'ios'] });
  await shop.appSet({
    android_min_version: '1.2.0', android_store_url: 'https://play.google.com/store/apps/details?id=com.example.kesar',
    ios_min_version: '2.0.0', ios_store_url: 'https://apps.apple.com/in/app/kesar/id1234567890',
  });
  const run = async (platform, version) => shop.app({ platform, version }).get('/api/store/app/home');
  for (const version of ['1.1.9', '1.0.0', '0.9.99', '1.1.99999']) {
    const res = await run('android', version);
    assert.equal(res.status, 426, `Android ${version} is below 1.2.0 but answered ${res.status}`);
    assert.equal(res.data.code, 'update_required');
    assert.equal(res.data.storeUrl, 'https://play.google.com/store/apps/details?id=com.example.kesar');
    assertNoPlatformName(res, 'The update-required answer');
  }
  for (const version of ['1.2.0', '1.2.1', '1.10.0', '2.0.0']) assert.equal((await run('android', version)).status, 200, `Android ${version} meets 1.2.0`);
  // Versions compare as numbers, not text: 1.10.0 is above 1.9.0.
  await shop.appSet({ android_min_version: '1.9.0' });
  assert.equal((await run('android', '1.10.0')).status, 200);
  assert.equal((await run('android', '1.2.0')).status, 426);
  // iOS has its own minimum and its own link.
  assert.equal((await run('ios', '1.9.0')).status, 426);
  assert.equal((await run('ios', '1.9.0')).data.storeUrl, 'https://apps.apple.com/in/app/kesar/id1234567890');
  assert.equal((await run('ios', '2.0.0')).status, 200);
  // A version that is not a version is refused, never a crash, never let through.
  for (const version of ['', 'abc', '1.2', '1.2.0.1', '-1.0.0', '1.2.0; rm', '99999999999.0.0']) {
    const res = await run('android', version);
    assert.ok(res.status >= 400 && res.status < 500, `Version "${version}" answered ${res.status}`);
  }
  // Bootstrap is the one call an old app can always make to learn the link.
  const boot = await shop.app({ version: '1.0.0' }).get('/api/store/app/bootstrap');
  assert.ok([200, 426].includes(boot.status));
  // Taking the minimum away lets everything in.
  await shop.appSet({ android_min_version: '', android_store_url: '' });
  assert.equal((await run('android', '0.0.1')).status, 200);
});

test('P-27: guest sessions are limited per address, and a spent refresh token is not accepted twice', async () => {
  const { shop } = await appStore();
  const ip = '198.51.100.77';
  const limit = APP_LIMITS.guestSessionsPerAddress.limit;
  const results = await together(limit + 5, () => shop.app({ ip, device: { id: `d${Math.random().toString(16).slice(2)}${'0'.repeat(16)}`.slice(0, 32), name: 'Pixel' } }).start('guest'));
  const opened = results.filter((r) => r.status === 201).length;
  assert.ok(opened <= limit, `${opened} guest sessions opened from one address; the limit is ${limit}`);
  assert.ok(results.some((r) => r.status === 429), 'The limit is not enforced');
  // Rotation: the old refresh token dies with the first use.
  const other = shop.app();
  accepted(await other.start('guest'), 'A guest session');
  const first = other.tokens.refreshToken;
  accepted(await other.refresh(), 'The first refresh');
  const again = await shop.app({ device: other.device }).call('POST', '/api/store/app/session/refresh', { refreshToken: first });
  assert.equal(again.status, 401, 'A spent refresh token was accepted again');
  assert.equal((await other.get('/api/store/app/me', { authorization: `Bearer ${other.tokens.accessToken}` })).status, 401, 'The app\'s token is Shopper, never Bearer');
});

test('P-28: checkout opens for a guest; prepaid needs no code, COD asks for a WhatsApp code and the cart is kept', async () => {
  const { shop, products } = await appStore();
  await shop.codOn();
  const app = shop.app();
  accepted(await app.start('guest'), 'A guest session');
  const lines = [line(products[0], 2)];
  accepted(await app.putCart(lines), 'Filling the cart');
  const phone = '+919811122233';
  const addr = { name: 'Asha Rao', phone, line1: '12 Lake Road', line2: '', landmark: '', city: 'Pune', stateCode: '27', pincode: '411001' };
  // Prepaid: no code, straight to the gateway.
  const prepaid = await app.order({ lines, address: addr });
  assert.equal(prepaid.next, 'pay');
  assert.ok(prepaid.gateway?.gatewayOrderId);
  // COD: the page is told to verify the phone, and nothing is placed yet.
  const body = app.checkoutBody({ lines, paymentMode: 'cod', address: addr });
  const before = (await shop.orders()).length;
  const asked = accepted(await app.place(body), 'COD checkout as a guest');
  assert.equal(asked.data.next, 'verify_phone');
  assert.equal((await shop.orders()).length, before, 'No COD order exists before the code');
  const cart = accepted(await app.getCart(), 'The cart after the prompt');
  assert.equal(cart.data.lines.length, 1, 'The cart is kept');
  assert.equal(cart.data.lines[0].qty, 2);
  // A wrong code does not place it.
  accepted(await app.post('/api/store/otp/send', { phone, purpose: 'cod', checkoutKey: body.idempotencyKey }), 'Asking for the COD code');
  const code = await world.codeFor(phone);
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  refusedStatus(await app.post('/api/store/otp/verify', { phone, purpose: 'cod', code: wrong, checkoutKey: body.idempotencyKey }), 'A wrong code');
  assert.equal((await app.place(body)).data?.next, 'verify_phone', 'Still not placed after a wrong code');
  accepted(await app.post('/api/store/otp/verify', { phone, purpose: 'cod', code, checkoutKey: body.idempotencyKey }), 'The right code');
  const placed = accepted(await app.place(body), 'COD after the code');
  assert.equal(placed.data.next, 'done');
  const order = await shop.order(placed.data.orderNumber);
  assert.equal(order.payment_mode ?? order.paymentMode, 'cod');
  // The code is a WhatsApp message, in the seller's brand.
  const messages = await world.allMessagesTo(phone);
  assert.ok(messages.length >= 1);
  assert.ok(!namesPlatform(JSON.stringify(messages)), 'A shopper\'s code message names the platform');
});

test('P-28: the app sends no price, total, channel or coupon flag the server would trust; the order is priced and tagged by the server', async () => {
  const { shop, products } = await appStore();
  const app = shop.app();
  accepted(await app.start('guest'));
  const [cheap] = products;
  const lines = [line(cheap, 2)];
  const honest = accepted(await app.post('/api/store/checkout/quote', { lines }), 'A quote').data;
  assert.equal(honest.subtotalPaise, 2 * cheap.pricePaise ?? 2 * 29900);
  for (const extra of [{ pricePaise: 1 }, { totalPaise: 1 }, { subtotalPaise: 1 }, { discountPaise: 99999 }, { channel: 'web' }, { channel: 'app' }, { appOnly: true }, { isApp: true }, { amountPaise: 100 }]) {
    const body = app.checkoutBody({ lines, ...extra });
    const res = await app.place(body);
    if (res.status < 300) {
      // Ignored is allowed only if the server still priced it itself and tagged it itself.
      const order = await shop.order(res.data.orderNumber);
      assert.equal(Number(order.total_paise), honest.totalPaise, `${Object.keys(extra)[0]} changed the total`);
      assert.equal(order.channel, 'app');
    } else assert.ok([400, 422].includes(res.status), `${Object.keys(extra)[0]} answered ${res.status}`);
  }
  // A price on a cart line is refused outright.
  const lineWithPrice = { ...lines[0], pricePaise: 1 };
  assert.ok((await app.putCart([lineWithPrice])).status >= 400, 'A price on a cart line');
  assert.ok((await app.post('/api/store/checkout/quote', { lines: [lineWithPrice] })).status >= 400);
  // Every order of the app is tagged app, and the web's is tagged web, however the call was made.
  const placed = await app.order({ lines });
  assert.equal((await shop.order(placed.orderNumber)).channel, 'app');
  const web = buyer(world, shop);
  const webPlaced = await web.order({ lines });
  assert.equal((await shop.order(webPlaced.orderNumber)).channel, 'web');
  // The headers of a web buyer who copies the app's headers do not turn the order into an app order.
  const spoof = await web.api('POST', '/api/store/checkout', web.checkoutBody({ lines }), { 'x-app': 'shopper', 'x-app-tenant': String(shop.tenantId), 'x-app-version': '1.0.0', 'x-app-platform': 'android' });
  if (spoof.status < 300) assert.equal((await shop.order(spoof.data.orderNumber)).channel, 'web', 'App headers with no app session made an app order');
});

test('P-29: a test-card payment shows Paid in the shopper app and in the owner app', async () => {
  const { shop, products } = await appStore();
  const app = shop.app();
  await app.signIn();
  const row = await app.buy({ lines: [line(products[0])] });
  assert.ok(['paid', 'advance_paid'].includes(row.payment_status));
  assert.equal(row.channel, 'app');
  // The shopper's app.
  const state = accepted(await app.get(`/api/store/app/order/${row.placed.token}`), 'The order by its token').data;
  assert.equal(state.paymentStatus, 'paid');
  assert.equal(state.next, 'done');
  const mine = accepted(await app.get(`/api/store/app/orders/${row.order_number}`), 'The order in the account').data;
  assert.equal(mine.paymentStatus, 'paid');
  assert.equal(mine.totalPaise, Number(row.total_paise));
  const list = accepted(await app.get('/api/store/app/orders')).data;
  assert.ok(list.items.some((o) => o.orderNumber === row.order_number && o.paymentStatus === 'paid'));
  // The owner's app (the console API, signed in as the owner).
  const owner = await shop.orderApi(row.id);
  assert.equal(owner.paymentStatus, 'paid');
  // The order by token holds no name, phone or address.
  assert.ok(!/Lake Road|Asha/.test(JSON.stringify(state)), 'The token view leaked the buyer');
  // Paying with a tampered signature does not mark it paid.
  const second = await app.order({ lines: [line(products[1])] });
  const paid = await world.rzp.post('/pay', { orderId: second.gateway.gatewayOrderId, webhook: false });
  const forged = await app.post('/api/store/payments/return', { orderToken: second.token, gatewayOrderId: second.gateway.gatewayOrderId, gatewayPaymentId: paid.payment.id, signature: 'f'.repeat(64) });
  assert.ok(forged.status >= 400, 'A forged signature was accepted');
  assert.notEqual((await shop.order(second.orderNumber)).payment_status, 'paid');
});

test('P-31: no answer of the app names the platform: bootstrap, browse, errors, update-required, headers and hosts', async () => {
  const { shop, products, page } = await appStore({ name: 'Kesar Kitchen' });
  const app = shop.app();
  accepted(await app.start('guest'));
  const paths = [
    '/api/store/app/bootstrap', '/api/store/app/home', '/api/store/app/catalog', '/api/store/app/reels', '/api/store/app/categories',
    `/api/store/app/products/${products[0].slug}`, `/api/store/app/landing/${page.slug}`, '/api/store/app/policies/privacy', '/api/store/app/policies/terms',
    '/api/store/app/policies/refund', '/api/store/app/policies/shipping', '/api/store/app/me', '/api/store/app/orders', '/api/store/app/rewards',
    '/api/store/app/products/does-not-exist', '/api/store/app/categories/nope', '/api/store/app/policies/unknown', '/api/store/app/landing/%00',
  ];
  for (const path of paths) assertNoPlatformName(await app.get(path), path);
  // Errors in the seller's voice too: a forged tenant, an old version, an expired token, a malformed body.
  assertNoPlatformName(await shop.app({ tenantId: 0 }).get('/api/store/app/home'), 'A tampered tenant');
  await shop.appSet({ android_min_version: '9.0.0', android_store_url: 'https://play.google.com/store/apps/details?id=com.example.old' });
  assertNoPlatformName(await shop.app().get('/api/store/app/home'), 'An old version');
  await shop.appSet({ android_min_version: '', android_store_url: '' });
  assertNoPlatformName(await app.call('POST', '/api/store/app/session/refresh', { refreshToken: 'sr_junk' }), 'A bad refresh token');
  assertNoPlatformName(await app.call('POST', '/api/store/app/session', '{not json'), 'Broken JSON');
  assertNoPlatformName(await app.post('/api/store/checkout', { lines: [] }), 'An empty checkout');
  // Every link the bootstrap hands out is on the business's own host, never a platform one.
  const boot = (await app.get('/api/store/app/bootstrap')).data;
  const hosts = [...JSON.stringify(boot).matchAll(/https?:\/\/([^/"\s]+)/g)].map((m) => m[1].toLowerCase());
  for (const host of hosts) assert.ok(host === shop.host || /play\.google\.com|apps\.apple\.com/.test(host), `Bootstrap points at ${host}`);
  // The messages the shopper receives: the sign-in code is in the seller's brand.
  const phone = '+919822233344';
  await app.post('/api/store/otp/send', { phone, purpose: 'sign_in' });
  const texts = JSON.stringify(await world.allMessagesTo(phone));
  assert.ok(!namesPlatform(texts), 'The sign-in code message names the platform');
  // The stored defaults of the business refuse the platform's name as an app name, a short name or a scheme.
  for (const column of ['app_name', 'short_name']) {
    await assert.rejects(() => shop.appSet({ [column]: 'Bhava Shop' }), `${column} accepted the platform's name`);
  }
  await assert.rejects(() => shop.appSet({ url_scheme: 'bhavashop' }), 'url_scheme accepted the platform\'s name');
});
