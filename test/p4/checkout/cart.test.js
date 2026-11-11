// The cart (PRD 9.2): the browser's bag mirrored to the server once signed in, capped, merged, priced by the server only,
// belonging to one business, and closed when an order is placed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hit, otherStore, payments, place, placeBody, product, q, sessionCookie, shopper, storeApp, withSizes } from './support.js';

const putCart = (app, cookie, lines, extra = {}) => hit(app, '/api/store/cart', { method: 'PUT', cookie, body: { lines, ...extra } });

test('S-04 twelve of one item in the bag is capped at 10, with a notice', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { stock: null });
    const asha = await shopper(app);
    const res = await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 7 }, { productId: lamp.id, variantId: null, qty: 5 }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.lines.map((l) => [l.productId, l.qty]), [[lamp.id, 10]], 'the same product merges into one line');
    assert.match(res.json.notices.join(' '), /up to 10/);
    const [{ qty }] = await q(app, 'SELECT qty FROM cart_lines WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(qty, 10);
    // The checkout quote caps the same way.
    const quoted = await hit(app, '/api/store/checkout/quote', { method: 'POST', body: { lines: [{ productId: lamp.id, variantId: null, qty: 12 }] } });
    assert.deepEqual([quoted.json.lines[0].qty, quoted.json.lines[0].state], [10, 'capped']);
  } finally {
    app.close();
  }
});

test('S-06 signing in on a second device shows the same server cart', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { stock: 5 });
    const kurti = await product(app, { name: 'Kurti', stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 2 }]);
    const asha = await shopper(app);
    assert.equal((await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 2 }, { productId: kurti.id, variantId: sizes.M, qty: 1 }])).status, 200);
    const phone = await sessionCookie(app, asha.id);
    const seen = await hit(app, '/api/store/cart', { cookie: phone });
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.json.lines.map((l) => [l.productId, l.variantId, l.qty, l.unitPaise, l.state]), [[lamp.id, null, 2, 50000, 'ok'], [kurti.id, sizes.M, 1, 50000, 'ok']]);
    // A guest has no server cart: the bag stays in the browser.
    assert.equal((await hit(app, '/api/store/cart')).status, 401);
    assert.equal((await putCart(app, undefined, [{ productId: lamp.id, variantId: null, qty: 1 }])).status, 401);
  } finally {
    app.close();
  }
});

test('S-05 the cart holds no prices: a price in the bag is refused, and what it shows is the catalog\'s price now', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { stock: 5 });
    const asha = await shopper(app);
    assert.equal((await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1, pricePaise: 100 }])).status, 400);
    assert.equal((await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1 }], { totalPaise: 100 })).status, 400);
    assert.equal((await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1 }])).status, 200);
    await q(app, 'UPDATE products SET price_paise = 65000 WHERE tenant_id = $1 AND id = $2', [app.tenant.id, lamp.id]);
    const seen = await hit(app, '/api/store/cart', { cookie: asha.cookie });
    assert.equal(seen.json.lines[0].unitPaise, 65000);
    await q(app, 'UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [app.tenant.id, lamp.id]);
    const hidden = await hit(app, '/api/store/cart', { cookie: asha.cookie });
    assert.deepEqual([hidden.json.lines[0].state, hidden.json.lines[0].linePaise], ['inactive', 0], 'inactive items come back flagged');
  } finally {
    app.close();
  }
});

test('a cart belongs to one business: another business\'s product or session never gets in', async () => {
  const app = await storeApp();
  try {
    const lamp = await product(app, { stock: 5 });
    const other = await otherStore(app);
    const theirs = await product(app, { tenant: other.tenant, stock: 5 });
    const asha = await shopper(app);
    const res = await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1 }, { productId: theirs.id, variantId: null, qty: 1 }]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.lines.map((l) => l.productId), [lamp.id]);
    const elsewhere = await hit(app, '/api/store/cart', { cookie: asha.cookie, host: other.host });
    assert.equal(elsewhere.status, 401, 'a session of one business is nobody at another');
    // A variant must be the product's own.
    const kurti = await product(app, { name: 'Kurti', stock: null });
    const sizes = await withSizes(app, kurti.id, [{ value: 'M', stock: 2 }]);
    const mixed = await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: sizes.M, qty: 1 }]);
    assert.deepEqual(mixed.json.lines, []);
  } finally {
    app.close();
  }
});

test('placing an order closes the shopper\'s cart, and emptying the bag closes it too', async () => {
  const app = await storeApp();
  try {
    await payments(app);
    const lamp = await product(app, { stock: 5 });
    const asha = await shopper(app);
    await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1 }]);
    const res = await place(app, placeBody(lamp.id), { cookie: asha.cookie });
    assert.equal(res.status, 201, res.text);
    await app.ctx.orderEvents.settle();
    const carts = await q(app, 'SELECT status FROM carts WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [app.tenant.id, asha.id]);
    assert.deepEqual(carts.map((c) => c.status), ['ordered']);
    assert.deepEqual((await hit(app, '/api/store/cart', { cookie: asha.cookie })).json.lines, []);
    await putCart(app, asha.cookie, [{ productId: lamp.id, variantId: null, qty: 1 }]);
    await putCart(app, asha.cookie, []);
    const after = await q(app, 'SELECT status FROM carts WHERE tenant_id = $1 AND shopper_id = $2 ORDER BY id', [app.tenant.id, asha.id]);
    assert.deepEqual(after.map((c) => c.status), ['ordered', 'emptied']);
  } finally {
    app.close();
  }
});

test('the bag page renders in the seller\'s brand, and the bag script it loads keeps 10 a line and 50 lines', async () => {
  const app = await storeApp();
  try {
    const page = await hit(app, '/cart');
    assert.equal(page.status, 200);
    assert.match(page.text, /data-cart-page/);
    assert.match(page.text, /Neel Studio/);
    assert.doesNotMatch(page.text, /bhava/i);
    const script = await hit(app, '/store/bag.js');
    assert.equal(script.status, 200);
    assert.match(script.headers['content-type'], /javascript/);
    assert.match(script.text, /const MAX_QTY = 10;/);
    assert.match(script.text, /const MAX_LINES = 50;/);
    assert.doesNotMatch(script.text, /price(Paise)?\s*:/, 'the bag never stores a price');
  } finally {
    app.close();
  }
});
