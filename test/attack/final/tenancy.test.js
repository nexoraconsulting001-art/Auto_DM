// Attack: business separation (PRD 5.1). Two real stores on one app, real HTTP with real Host headers. Every test tries
// to read, change or link to the other business's data from the outside: tokens and cookies carried to the other
// address, the other business's ids in addresses and in bodies, hostile ids, and both businesses at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { withTenant } from '../../../src/tenancy.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { OWNER } from '../../helpers.js';
import { csrfFor } from '../../../src/modules/shoppers/keys.js';
import { uploadFile } from '../../p0/spec-p0/support.js';
import { hit, otherStore, payments, placeBody, product, q, shopper, stockOf, storeApp } from '../../p4/checkout/support.js';

const A_HOST = 'default.bhava.test';
const VICTIM = { phone: '9000000077', password: 'victim-pass-1' };

async function login(app, host, who) {
  const res = await hit(app, '/api/v1/auth/login', { method: 'POST', body: who, host });
  assert.equal(res.status, 201, `login on ${host}: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.token;
}

/** Store A (the attacker, the default business) and store B (the victim), each with an owner, a product, payments and a shopper. */
async function twoStores(t) {
  const app = await storeApp();
  t.after(() => app.close());
  await app.db.platform.query("UPDATE tenants SET plan = 't5' WHERE id = $1", [app.tenant.id]);
  const b = await otherStore(app, { slug: 'victim', name: 'Victim Velvet', plan: 't5' });
  await withTenant(b.tenant, () => app.platform.users.ensureOwner(VICTIM));
  await payments(app, { online: false, cod: true });
  await payments(app, { online: false, cod: true, tenant: b.tenant });
  const aProduct = await product(app, { name: 'Attacker lamp', stock: 5 });
  const bProduct = await product(app, { name: 'Victim vase', stock: 5, tenant: b.tenant });
  const aToken = await login(app, A_HOST, OWNER);
  const bToken = await login(app, b.host, VICTIM);
  return { app, b, aProduct, bProduct, aToken, bToken };
}

const shopperCsrf = (app, cookie) => ({ 'x-shopper-csrf': csrfFor(app.config, String(cookie).replace(/^_sid=/, '')) });
const ownerApi = (app, host, token) => (method, path, body) => hit(app, `/api/v1${path}`, { method, host, token, body });

test('tenancy attack: a seller token of one business is refused on the other business\'s address', async (t) => {
  const { app, b, aToken, bToken } = await twoStores(t);
  for (const path of ['/auth/me', '/products', '/orders', '/settings', '/coupons', '/customers']) {
    const res = await hit(app, `/api/v1${path}`, { host: b.host, token: aToken });
    assert.ok(res.status === 401 || res.status === 403, `A's token on B's host ${path}: ${res.status} ${res.text.slice(0, 160)}`);
    assert.ok(!/Victim/.test(res.text), `${path} leaked B's data`);
  }
  // and the other way round, a write
  const res = await hit(app, '/api/v1/products', { host: A_HOST, token: bToken, method: 'POST', body: { name: 'Planted', price: 1 } });
  assert.ok(res.status === 401 || res.status === 403, `B's token writing on A's host: ${res.status}`);
  const planted = await app.db.platform.query("SELECT tenant_id FROM products WHERE name = 'Planted'");
  assert.deepEqual(planted, []);
});

test('tenancy attack: checkout on one store with the other store\'s product is refused and moves no stock', async (t) => {
  const { app, b, aProduct, bProduct } = await twoStores(t);
  const before = await stockOf(app, bProduct.id, b.tenant);
  const buyer = await shopper(app, { phone: '+919876543210' });
  const bodies = [
    placeBody(bProduct.id, { paymentMode: 'cod' }),
    placeBody(aProduct.id, { paymentMode: 'cod', lines: [{ productId: aProduct.id, variantId: null, qty: 1 }, { productId: bProduct.id, variantId: null, qty: 1 }] }),
  ];
  for (const body of bodies) {
    const res = await hit(app, '/api/store/checkout', { method: 'POST', host: A_HOST, body, cookie: buyer.cookie, headers: shopperCsrf(app, buyer.cookie) });
    assert.ok(res.status >= 400 && res.status < 500, `checkout with B's product on A: ${res.status} ${res.text.slice(0, 200)}`);
    const quote = await hit(app, '/api/store/checkout/quote', { method: 'POST', host: A_HOST, body, cookie: buyer.cookie, headers: shopperCsrf(app, buyer.cookie) });
    assert.ok(!(quote.status === 200 && /Victim/.test(quote.text)), `quote priced B's product on A: ${quote.text.slice(0, 200)}`);
  }
  assert.deepEqual(await stockOf(app, bProduct.id, b.tenant), before);
  const items = await app.db.platform.query('SELECT tenant_id FROM order_items WHERE product_id = $1', [bProduct.id]);
  assert.deepEqual(items, [], 'no order line anywhere points at B\'s product');
  // Control: the same buyer, cookie and body shape with A's own product is placed, so the refusals above were about the product.
  const own = await hit(app, '/api/store/checkout', { method: 'POST', host: A_HOST, body: placeBody(aProduct.id, { paymentMode: 'cod' }), cookie: buyer.cookie, headers: shopperCsrf(app, buyer.cookie) });
  assert.ok(own.status < 300 && own.json?.orderNumber, `control order on A: ${own.status} ${own.text.slice(0, 200)}`);
});

test('tenancy attack: the cart and the wishlist of one store cannot hold the other store\'s product', async (t) => {
  const { app, aProduct, bProduct } = await twoStores(t);
  const s = await shopper(app, { phone: '+919811111111' });
  const cart = await hit(app, '/api/store/cart', { method: 'PUT', host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie), body: { lines: [{ productId: bProduct.id, variantId: null, qty: 1 }] } });
  assert.ok(cart.status < 500, `cart: ${cart.status} ${cart.text.slice(0, 200)}`);
  if (cart.status === 200) assert.ok(!/Victim/.test(cart.text), `cart shows B's product on A: ${cart.text.slice(0, 200)}`);
  const read = await hit(app, '/api/store/cart', { host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie) });
  assert.ok(!/Victim/.test(read.text), `cart read shows B's product: ${read.text.slice(0, 200)}`);

  const wish = await hit(app, '/api/store/wishlist', { method: 'PUT', host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie), body: { add: [bProduct.id] } });
  assert.ok(wish.status < 500, `wishlist: ${wish.status} ${wish.text.slice(0, 200)}`);
  const rows = await app.db.platform.query('SELECT tenant_id FROM wishlist_items WHERE product_id = $1', [bProduct.id]).catch(() => []);
  assert.deepEqual(rows, [], 'no wishlist row points at B\'s product');
  const wread = await hit(app, '/api/store/wishlist', { host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie) });
  assert.ok(!/Victim/.test(wread.text), `wishlist read shows B's product: ${wread.text.slice(0, 200)}`);
  // Control: A's own product does go in, so the path above was really reached.
  const ownWish = await hit(app, '/api/store/wishlist', { method: 'PUT', host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie), body: { add: [aProduct.id] } });
  assert.equal(ownWish.status, 200, `control wishlist: ${ownWish.text.slice(0, 200)}`);
  assert.equal((await app.db.platform.query('SELECT 1 FROM wishlist_items WHERE product_id = $1', [aProduct.id])).length, 1);
});

test('tenancy attack: a shopper session of one store is nobody at the other store', async (t) => {
  const { app, b } = await twoStores(t);
  const s = await shopper(app, { phone: '+919822222222', tenant: b.tenant });
  await hit(app, '/api/store/addresses', { method: 'POST', host: b.host, cookie: s.cookie, headers: shopperCsrf(app, s.cookie), body: { name: 'Asha Rao', phone: '9876543210', line1: '12 Lake Road', city: 'Pune', stateCode: '27', pincode: '411001' } });
  for (const path of ['/api/store/addresses', '/api/store/wishlist', '/api/store/consent']) {
    const res = await hit(app, path, { host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie) });
    assert.ok(!/Lake Road|9876543210|\+919822222222/.test(res.text), `B's shopper cookie on A ${path} leaked: ${res.status} ${res.text.slice(0, 200)}`);
  }
});

test('tenancy attack: reviews cannot be written on, or read from, the other store\'s product', async (t) => {
  const { app, b, bProduct } = await twoStores(t);
  const s = await shopper(app, { phone: '+919833333333' });
  const res = await hit(app, '/api/store/reviews', { method: 'POST', host: A_HOST, cookie: s.cookie, headers: shopperCsrf(app, s.cookie), body: { orderNumber: '1', productId: bProduct.id, rating: 1, body: 'planted' } });
  assert.ok(res.status >= 400 && res.status < 500, `review on B's product from A: ${res.status} ${res.text.slice(0, 200)}`);
  const list = await hit(app, `/api/store/products/${bProduct.id}/reviews`, { host: A_HOST });
  assert.ok(list.status === 404 || !/Victim/.test(list.text), `B's product reviews read on A: ${list.status} ${list.text.slice(0, 200)}`);
  const rows = await app.db.platform.query('SELECT tenant_id FROM reviews WHERE product_id = $1', [bProduct.id]).catch(() => []);
  assert.deepEqual(rows.filter((r) => r.tenant_id !== b.tenant.id), []);
});

test('tenancy attack: a coupon cannot be scoped to the other business\'s products, categories or page', async (t) => {
  const { app, b, bProduct, aToken, bToken } = await twoStores(t);
  const bApi = ownerApi(app, b.host, bToken);
  const aApi = ownerApi(app, A_HOST, aToken);
  const cat = await bApi('POST', '/categories', { name: 'Victim category' });
  assert.equal(cat.status, 201, cat.text.slice(0, 200));
  const base = { kind: 'percent', percentBp: 1000, minOrderPaise: 0, active: true };
  const tries = [
    { code: 'STEALP', ...base, scope: 'products', scopeIds: [bProduct.id] },
    { code: 'STEALC', ...base, scope: 'categories', scopeIds: [cat.json.id] },
  ];
  for (const body of tries) {
    const res = await aApi('POST', '/coupons', body);
    assert.ok(res.status >= 400 && res.status < 500, `coupon ${body.code} scoped to B's ids: ${res.status} ${res.text.slice(0, 240)}`);
  }
  const stored = await app.db.platform.query("SELECT code, to_jsonb(c)::text AS row FROM coupons c WHERE tenant_id = $1 AND code LIKE 'STEAL%'", [app.tenant.id]);
  assert.deepEqual(stored.map((r) => r.code), [], `A's coupons linked to B's ids: ${stored.map((r) => r.row).join(' ')}`);
  const [mine] = await app.db.platform.query('SELECT id FROM products WHERE tenant_id = $1 LIMIT 1', [app.tenant.id]);
  const control = await aApi('POST', '/coupons', { code: 'OWNP', ...base, scope: 'products', scopeIds: [mine.id] });
  assert.equal(control.status, 201, `control coupon on A's own product: ${control.text.slice(0, 200)}`);
});

test('tenancy attack: return settings cannot name the other business\'s categories', async (t) => {
  const { app, b, aToken, bToken } = await twoStores(t);
  const cat = await ownerApi(app, b.host, bToken)('POST', '/categories', { name: 'Victim returns' });
  assert.equal(cat.status, 201, cat.text.slice(0, 200));
  const res = await ownerApi(app, A_HOST, aToken)('PATCH', '/return-settings', { eligibleCategoryIds: [cat.json.id] });
  const kept = res.status === 200 && (res.json?.eligibleCategoryIds ?? []).includes(cat.json.id);
  assert.ok(!kept, `A's return settings now name B's category ${cat.json.id}: ${res.status} ${res.text.slice(0, 200)}`);
  assert.ok(res.status < 500, `return settings: ${res.status} ${res.text.slice(0, 200)}`);
});

test('tenancy attack: a landing page cannot be built from the other business\'s products or categories', async (t) => {
  const { app, b, aProduct, bProduct, aToken, bToken } = await twoStores(t);
  const cat = await ownerApi(app, b.host, bToken)('POST', '/categories', { name: 'Victim page cat' });
  const aApi = ownerApi(app, A_HOST, aToken);
  const tries = [
    { kind: 'reel', mediaId: '18475694065114168', productIds: [bProduct.id] },
    { kind: 'reel', mediaId: '18475694065114169', productIds: [aProduct.id], categoryIds: [cat.json.id] },
  ];
  for (const body of tries) {
    const res = await aApi('POST', '/pages', body);
    assert.ok(res.status < 500, `page: ${res.status} ${res.text.slice(0, 200)}`);
    if (res.status === 201) {
      assert.ok(!(res.json.products ?? []).some((p) => p.id === bProduct.id || /Victim/.test(JSON.stringify(p))), `page holds B's product: ${res.text.slice(0, 300)}`);
      assert.ok(!(res.json.categoryIds ?? []).includes(cat.json.id), `page holds B's category: ${res.text.slice(0, 300)}`);
    }
  }
});

test('tenancy attack: hostile ids in every id route never reach a 5xx and never another business', async (t) => {
  const { app, aToken } = await twoStores(t);
  const hostile = ['2147483648', '4294967296', '9007199254740993', '-1', '0', '1e3', '%00', '1%00', '%E0%A5%A7', '%EF%BC%91', `${'9'.repeat(400)}`, '0x1', '1.0', '%20%31', 'null', '[1]'];
  const crashes = [];
  for (const route of routeList.filter((r) => /:id\b/.test(r.path) && !r.consoleOnly)) {
    for (const id of hostile) {
      const path = `/api/v1${route.path.replace(':id', id)}`;
      const res = await hit(app, path, { host: A_HOST, token: aToken, method: route.method, body: route.method === 'GET' || route.method === 'DELETE' ? undefined : {} });
      if (res.status >= 500) crashes.push(`${route.id} ${route.method} ${path} -> ${res.status} ${res.text.slice(0, 120)}`);
    }
  }
  assert.deepEqual(crashes, [], crashes.join('\n'));
});

test('tenancy attack: both stores ordering at once keep their own order numbers and stock', async (t) => {
  const { app, b, aProduct, bProduct } = await twoStores(t);
  await app.db.platform.query('UPDATE products SET stock = 100 WHERE id = ANY($1::int[])', [[aProduct.id, bProduct.id]]);
  const N = 8;
  const buyerA = await shopper(app, { phone: '+919876543210' });
  const buyerB = await shopper(app, { phone: '+919876543210', tenant: b.tenant });
  const jobs = [];
  for (let i = 0; i < N; i++) {
    jobs.push(hit(app, '/api/store/checkout', { method: 'POST', host: A_HOST, cookie: buyerA.cookie, headers: shopperCsrf(app, buyerA.cookie), body: placeBody(aProduct.id, { paymentMode: 'cod', idempotencyKey: crypto.randomUUID() }) }));
    jobs.push(hit(app, '/api/store/checkout', { method: 'POST', host: b.host, cookie: buyerB.cookie, headers: shopperCsrf(app, buyerB.cookie), body: placeBody(bProduct.id, { paymentMode: 'cod', idempotencyKey: crypto.randomUUID() }) }));
  }
  const results = await Promise.all(jobs);
  const bad = results.filter((r) => r.status >= 500);
  assert.deepEqual(bad.map((r) => `${r.status} ${r.text.slice(0, 120)}`), []);
  for (const [tenant, prod] of [[app.tenant, aProduct], [b.tenant, bProduct]]) {
    const orders = await q(app, 'SELECT order_number FROM orders WHERE tenant_id = $1', [tenant.id], tenant);
    const numbers = orders.map((o) => String(o.order_number));
    assert.equal(numbers.length, N, `${tenant.id} placed ${numbers.length} of ${N}: ${results.map((r) => r.status).join(',')} ${results[0].text.slice(0, 200)}`);
    assert.equal(new Set(numbers).size, numbers.length, `duplicate order numbers in ${tenant.id}: ${numbers}`);
    const lines = await app.db.platform.query('SELECT DISTINCT i.product_id, o.tenant_id FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id WHERE o.tenant_id = $1', [tenant.id]);
    assert.ok(lines.every((l) => Number(l.product_id) === Number(prod.id)), `orders of ${tenant.id} hold another product: ${JSON.stringify(lines)}`);
  }
});

test('tenancy attack: a product cannot be put in the other business\'s category (K-01)', async (t) => {
  const { app, b, aToken, bToken } = await twoStores(t);
  const cat = await ownerApi(app, b.host, bToken)('POST', '/categories', { name: 'Victim shelf' });
  assert.equal(cat.status, 201, cat.text.slice(0, 200));
  const aApi = ownerApi(app, A_HOST, aToken);
  const made = await aApi('POST', '/products', { name: 'Smuggled', pricePaise: 1000, categoryIds: [cat.json.id] });
  assert.ok(made.status < 500, `create: ${made.status} ${made.text.slice(0, 200)}`);
  if (made.status === 201) assert.ok(!(made.json.categoryIds ?? []).includes(cat.json.id), `A's product sits in B's category: ${made.text.slice(0, 300)}`);
  const [mine] = await app.db.platform.query('SELECT id FROM products WHERE tenant_id = $1 ORDER BY id LIMIT 1', [app.tenant.id]);
  const patched = await aApi('PATCH', `/products/${mine.id}`, { categoryIds: [cat.json.id] });
  assert.ok(patched.status < 500, `patch: ${patched.status} ${patched.text.slice(0, 200)}`);
  const links = await app.db.platform.query('SELECT tenant_id, product_id FROM product_categories WHERE category_id = $1', [cat.json.id]);
  assert.deepEqual(links.filter((l) => l.tenant_id !== b.tenant.id), [], 'no other business links a product to B\'s category');
  const bCat = await ownerApi(app, b.host, bToken)('GET', `/categories/${cat.json.id}`);
  assert.ok(!/Smuggled/.test(bCat.text), 'B\'s category does not show A\'s product');
});

test('tenancy attack: the other business\'s uploaded image is not served on this address, and cannot be put on a product', async (t) => {
  const { app, b, aToken, bToken } = await twoStores(t);
  const up = await uploadFile(app, { host: b.host }, bToken);
  assert.equal(up.status, 201, up.text.slice(0, 200));
  const { id } = up.json();
  for (const path of [`/media/${id}`, `/media/${id}/card`, `/media/${id}/hero`]) {
    const own = await hit(app, path, { host: b.host });
    const other = await hit(app, path, { host: A_HOST });
    assert.equal(other.status, 404, `B's image ${path} on A's address: ${other.status} (on B: ${own.status})`);
  }
  const made = await ownerApi(app, A_HOST, aToken)('POST', '/products', { name: 'Borrowed photo', pricePaise: 1000, images: [`/media/${id}`] });
  assert.ok(made.status < 500, `create: ${made.status} ${made.text.slice(0, 200)}`);
  const stored = await app.db.platform.query('SELECT images::text AS images FROM products WHERE tenant_id = $1 AND images::text LIKE $2', [app.tenant.id, `%${id}%`]);
  const page = await hit(app, '/p/borrowed-photo', { host: A_HOST });
  assert.ok(made.status !== 201 || !JSON.stringify(made.json.images ?? []).includes(id),
    `A's product holds B's upload ${id}: API answer ${made.text.slice(0, 200)} | products.images rows: ${JSON.stringify(stored)} | A's product page (${page.status}) names it: ${page.text.includes(id)}`);
});

test('tenancy attack: the brand kit and categories cannot point at the other business\'s uploaded files', async (t) => {
  const { app, b, aToken, bToken } = await twoStores(t);
  const up = await uploadFile(app, { host: b.host }, bToken);
  assert.equal(up.status, 201, up.text.slice(0, 200));
  const link = `/media/${up.json().id}`;
  const aApi = ownerApi(app, A_HOST, aToken);
  const kept = [];
  for (const [method, path, body] of [
    ['PATCH', '/brand-kit', { logoUrl: link }],
    ['PATCH', '/brand-kit', { faviconUrl: link }],
    ['PATCH', '/brand-kit', { logoDarkUrl: link }],
    ['POST', '/categories', { name: 'Borrowed cover', imageUrl: link }],
  ]) {
    const res = await aApi(method, path, body);
    assert.ok(res.status < 500, `${method} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
    if (res.status < 300 && res.text.includes(up.json().id)) kept.push(`${method} ${path} ${JSON.stringify(body)} -> ${res.status} ${res.text.slice(0, 160)}`);
  }
  assert.deepEqual(kept, [], `A stored links to B's upload:\n${kept.join('\n')}`);
});

test('tenancy attack: the other store\'s order link, number and token answer nothing on this store', async (t) => {
  const { app, b, bProduct } = await twoStores(t);
  const buyer = await shopper(app, { phone: '+919876543210', tenant: b.tenant });
  const placed = await hit(app, '/api/store/checkout', { method: 'POST', host: b.host, body: placeBody(bProduct.id, { paymentMode: 'cod' }), cookie: buyer.cookie, headers: shopperCsrf(app, buyer.cookie) });
  assert.ok(placed.status < 300 && placed.json?.token, `B's order: ${placed.status} ${placed.text.slice(0, 200)}`);
  const { token, orderNumber } = placed.json;
  const onB = await hit(app, `/order/${token}`, { host: b.host });
  assert.equal(onB.status, 200, 'control: the link works on its own store');
  const aBuyer = await shopper(app, { phone: '+919876543210' });
  const tries = [
    ['GET', `/order/${token}`, undefined],
    ['POST', `/order/${token}/paid`, {}],
    ['POST', `/api/store/orders/${token}/retry`, {}],
    ['GET', `/api/store/orders/${orderNumber}`, undefined],
    ['POST', `/api/store/orders/${orderNumber}/cancel`, {}],
    ['POST', `/api/store/orders/${orderNumber}/returns`, {}],
  ];
  const leaks = [];
  for (const [method, path, body] of tries) {
    const res = await hit(app, path, { method, host: A_HOST, body, cookie: aBuyer.cookie, headers: shopperCsrf(app, aBuyer.cookie) });
    if (res.status < 300 || /Victim|Asha Rao|Lake Road/.test(res.text)) leaks.push(`${method} ${path} -> ${res.status} ${res.text.slice(0, 160)}`);
    assert.ok(res.status < 500, `${method} ${path}: ${res.status}`);
  }
  assert.deepEqual(leaks, [], leaks.join('\n'));
  const [after] = await app.db.platform.query('SELECT status, fulfilment_status, payment_status FROM orders WHERE tenant_id = $1 AND order_number = $2', [b.tenant.id, orderNumber]).catch(async () => app.db.platform.query('SELECT fulfilment_status FROM orders WHERE tenant_id = $1 AND order_number = $2', [b.tenant.id, orderNumber]));
  assert.ok(!/cancel/.test(JSON.stringify(after)), `B's order changed: ${JSON.stringify(after)}`);
});

/** Every row business `tenantId` holds, table by table, as sorted JSON. */
async function rowsOf(app, tenantId) {
  const tables = await app.db.platform.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('audit_log', 'jobs', 'rate_limit_hits') ORDER BY 1`,
  );
  const out = {};
  for (const { name } of tables) out[name] = (await app.db.platform.query(`SELECT to_jsonb(x)::text AS j FROM ${name} x WHERE tenant_id = $1`, [tenantId])).map((r) => r.j).sort();
  return out;
}

test('tenancy attack: well-formed writes naming the other business\'s real ids change none of its rows', async (t) => {
  const { app, b, bProduct, aToken, bToken } = await twoStores(t);
  const bApi = ownerApi(app, b.host, bToken);
  const cat = (await bApi('POST', '/categories', { name: 'Victim cat' })).json;
  const coupon = await bApi('POST', '/coupons', { code: 'VICTIM10', kind: 'percent', percentBp: 1000, minOrderPaise: 0, active: true });
  assert.equal(coupon.status, 201, coupon.text.slice(0, 200));
  const staff = await withTenant(b.tenant, () => app.platform.users.create({ name: 'Victim staff', phone: '9000000088', password: 'staff-pass-1', role: 'staff' }));
  const buyer = await shopper(app, { phone: '+919876543210', tenant: b.tenant });
  const placed = await hit(app, '/api/store/checkout', { method: 'POST', host: b.host, body: placeBody(bProduct.id, { paymentMode: 'cod' }), cookie: buyer.cookie, headers: shopperCsrf(app, buyer.cookie) });
  assert.ok(placed.status < 300, placed.text.slice(0, 200));
  const [order] = await app.db.platform.query('SELECT id FROM orders WHERE tenant_id = $1', [b.tenant.id]);
  await app.ctx.orderEvents.settle(); // B's own order finishes its follow-up work first
  const before = await rowsOf(app, b.tenant.id);
  const aApi = ownerApi(app, A_HOST, aToken);
  const writes = [
    ['PATCH', `/products/${bProduct.id}`, { name: 'Pwned', pricePaise: 1 }],
    ['DELETE', `/products/${bProduct.id}`],
    ['PATCH', `/categories/${cat.id}`, { name: 'Pwned' }],
    ['DELETE', `/categories/${cat.id}`],
    ['PATCH', `/coupons/${coupon.json.id}`, { active: false, percentBp: 10000 }],
    ['DELETE', `/coupons/${coupon.json.id}`],
    ['PATCH', `/team/${staff.id}`, { role: 'manager' }],
    ['DELETE', `/team/${staff.id}`],
    ['POST', `/orders/${order.id}/cancel`, { reason: 'fraud', note: 'x' }],
    ['POST', `/orders/${order.id}/notes`, { note: 'planted' }],
    ['POST', `/orders/${order.id}/status`, { status: 'cancelled' }],
    ['POST', `/orders/${order.id}/advance`, {}],
    ['POST', `/orders/${order.id}/refunds`, { amountPaise: 100, reason: 'other' }],
    ['POST', `/orders/${order.id}/shipments`, {}],
    ['POST', `/customers/${buyer.id}/reset-password`],
    ['POST', `/loyalty/members/${buyer.id}/adjust`, { points: 1000, note: 'free points' }],
  ];
  const answered = [];
  for (const [method, path, body] of writes) {
    const res = await aApi(method, path, body);
    answered.push(`${method} ${path} ${res.status}`);
    assert.ok(res.status < 500, `${method} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
    assert.ok(res.status >= 400, `${method} ${path} answered ${res.status}: ${res.text.slice(0, 200)}`);
  }
  await app.ctx.orderEvents.settle();
  const after = await rowsOf(app, b.tenant.id);
  const changed = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  assert.deepEqual(changed, [], `B's tables changed: ${changed.join(', ')} (${answered.join('; ')})`);
});

test('tenancy attack: a seller token on its own address reaches no console route naming the other business', async (t) => {
  const { app, b, aToken } = await twoStores(t);
  const reached = [];
  for (const route of routeList.filter((r) => r.consoleOnly || /\/tenants\/:id|\/businesses\/:id/.test(r.path))) {
    const path = `/api/v1${route.path.replace(':id', String(b.tenant.id))}`;
    const res = await hit(app, path, { host: A_HOST, token: aToken, method: route.method, body: route.method === 'GET' ? undefined : {} });
    assert.ok(res.status < 500, `${route.id} ${path}: ${res.status} ${res.text.slice(0, 160)}`);
    if (res.status < 300 || /Victim Velvet/.test(res.text)) reached.push(`${route.id} ${route.method} ${path} -> ${res.status} ${res.text.slice(0, 160)}`);
  }
  assert.deepEqual(reached, [], reached.join('\n'));
});
