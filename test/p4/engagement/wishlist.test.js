// PRD 9.20: the wishlist. Saves merge into the account after sign-in, at most 200, only this business's products; a saved
// product taken off the store shows as unavailable and can't be bought; the owner sees how many saved each product, never who.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORE_LIMITS } from '../../../src/contracts/orders.js';
import { as, consoleApi, hit, member, otherShop, place, placeBody, product, rows, setFeature, signedIn, storeApp, textOf, noPlatformName, withTenant } from './support.js';

const put = (app, who, body) => hit(app, '/api/store/wishlist', { method: 'PUT', body, ...(who ? as(who) : {}) });
const read = (app, who) => hit(app, '/api/store/wishlist', who ? as(who) : {});
const ids = (res) => (res.json?.items ?? []).map((i) => i.productId).sort((a, b) => a - b);

test('S-84: saves made logged out merge into the account once; a repeat changes nothing; a guest can’t write to an account', async () => {
  const app = await storeApp();
  try {
    const items = [await product(app, { name: 'One' }), await product(app, { name: 'Two' }), await product(app, { name: 'Three' })];
    const want = items.map((p) => p.id).sort((a, b) => a - b);
    assert.equal((await put(app, null, { add: want })).status, 401, 'a guest writing to an account');
    assert.equal((await read(app, null)).status, 401);
    const page = await hit(app, '/wishlist');
    assert.equal(page.status, 200);
    assert.match(page.text, /<script src="\/store\/wishlist\.js/, 'the logged-out page has no script to keep saves in the browser');
    assert.match(page.text, /data-wish-page/);
    assert.ok(noPlatformName(page.text));
    const script = await hit(app, '/store/wishlist.js');
    assert.equal(script.status, 200);
    assert.match(script.text, /localStorage/);

    const asha = await signedIn(app);
    const merged = await put(app, asha, { add: want });
    assert.equal(merged.status, 200, merged.text);
    assert.deepEqual(ids(merged), want);
    assert.deepEqual(ids(await put(app, asha, { add: [want[0], want[0], want[1]] })), want, 'a repeated merge doubled or lost items');
    assert.deepEqual(ids(await put(app, asha, { remove: [want[2]] })), want.slice(0, 2));
    assert.deepEqual(ids(await put(app, asha, { add: [want[2]], remove: [want[2]] })), want.slice(0, 2), 'one id both added and removed is removed');
    const [{ n }] = await rows(app, 'SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1', [app.tenant.id]);
    assert.equal(n, 2);
    const signedPage = await hit(app, '/wishlist', as(asha));
    assert.match(textOf(signedPage.text), /One/);
    assert.match(signedPage.text, /"signedIn":true/, 'the signed-in page doesn’t tell the script to merge');
  } finally {
    app.close();
  }
});

test('S-84: only this business’s products, never another shopper’s list, bad bodies refused, and never past 200', async () => {
  const app = await storeApp();
  try {
    const other = await otherShop(app);
    const mine = await product(app, { name: 'Mine' });
    const foreign = await product(app, { name: 'Foreign', tenant: other.tenant });
    const asha = await signedIn(app);
    const res = await put(app, asha, { add: [foreign.id, mine.id, 2147483647] });
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), [mine.id]);
    for (const bad of [{ add: [-1] }, { add: ['1'] }, { add: [1.5] }, { add: [mine.id], shopperId: 1 }, { add: null }, { add: Array.from({ length: STORE_LIMITS.wishlistItems + 1 }, (_, i) => i + 1) }]) {
      assert.equal((await put(app, asha, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    const ravi = await signedIn(app, { phone: '+919000011111' });
    assert.deepEqual(ids(await read(app, ravi)), [], 'a stranger sees another shopper’s saves');

    // Fill to the cap directly, then try to pass it.
    await withTenant(app.tenant, async () => {
      for (let i = 0; i < STORE_LIMITS.wishlistItems; i++) await app.platform.products.create({ name: `Filler ${i}`, price: '10', active: 'on' });
    });
    const all = (await rows(app, 'SELECT id FROM products WHERE tenant_id = $1 AND id <> $2 ORDER BY id', [app.tenant.id, mine.id])).map((r) => r.id);
    const first = await put(app, asha, { add: all.slice(0, 199) });
    assert.equal(first.json.items.length, STORE_LIMITS.wishlistItems);
    const over = await put(app, asha, { add: all.slice(199, 203) });
    assert.equal(over.status, 200);
    assert.equal(over.json.items.length, STORE_LIMITS.wishlistItems);
    assert.match(over.json.notices.join(' '), /200/);
    const [{ n }] = await rows(app, 'SELECT count(*)::int AS n FROM wishlist_items WHERE tenant_id = $1 AND shopper_id = $2', [app.tenant.id, asha.id]);
    assert.equal(n, STORE_LIMITS.wishlistItems);
  } finally {
    app.close();
  }
});

test('S-85: a saved product taken off the store shows as unavailable, a sold-out one as sold out, and neither can be bought', async () => {
  const app = await storeApp();
  try {
    const { payments } = await import('./support.js');
    await payments(app);
    const tray = await product(app, { name: 'Walnut tray', stock: 5 });
    const candle = await product(app, { name: 'Last candle', stock: 0 });
    const cup = await product(app, { name: 'Clay cup', stock: 5 });
    const asha = await signedIn(app);
    await put(app, asha, { add: [tray.id, candle.id, cup.id] });
    await withTenant(app.tenant, () => app.db.query('UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [app.tenant.id, tray.id]));
    const list = await read(app, asha);
    const by = Object.fromEntries(list.json.items.map((i) => [i.productId, i]));
    assert.deepEqual([by[tray.id].state, by[tray.id].available, by[tray.id].pricePaise], ['inactive', false, null], 'the inactive item vanished or still looks buyable');
    assert.deepEqual([by[candle.id].state, by[candle.id].available], ['sold_out', false]);
    assert.deepEqual([by[cup.id].state, by[cup.id].available], ['ok', true]);
    const page = await hit(app, '/wishlist', as(asha));
    const text = textOf(page.text);
    assert.match(text, /Walnut tray Unavailable/);
    assert.match(text, /Last candle Sold out/);
    assert.equal((page.text.match(/data-wish-bag=/g) ?? []).length, 1, 'only what can be bought has an Add to bag');
    for (const p of [tray, candle]) assert.equal((await place(app, placeBody(p.id), as(asha))).status, 409, `ordering ${p.name}`);
  } finally {
    app.close();
  }
});

test('S-86: the owner sees how many saved each product, never who, and only with analytics; hearts and the account link show on the store', async () => {
  const app = await storeApp();
  try {
    const other = await otherShop(app);
    const tray = await product(app, { name: 'Walnut tray' });
    const cup = await product(app, { name: 'Clay cup' });
    const theirs = await product(app, { name: 'Other store item', tenant: other.tenant });
    const a = await signedIn(app, { phone: '+919811100001' });
    const b = await signedIn(app, { phone: '+919811100002' });
    await put(app, a, { add: [tray.id, cup.id] });
    await put(app, b, { add: [tray.id] });
    await put(app, await signedIn(app, { phone: '+919811100003', tenant: other.tenant }), { add: [theirs.id] });

    const api = await consoleApi(app);
    const res = await api('GET', '/wishlist/counts');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.items, [{ productId: tray.id, name: 'Walnut tray', saves: 2 }, { productId: cup.id, name: 'Clay cup', saves: 1 }]);
    assert.doesNotMatch(res.text, /shopper|phone|98111/i);
    const paged = await api('GET', '/wishlist/counts?limit=1');
    assert.deepEqual(paged.json.items.map((i) => i.productId), [tray.id]);
    assert.deepEqual((await api('GET', `/wishlist/counts?limit=1&cursor=${paged.json.nextCursor}`)).json.items.map((i) => i.productId), [cup.id]);
    const staff = await member(app, { role: 'staff', permissions: ['catalog'] });
    assert.equal((await staff('GET', '/wishlist/counts')).status, 403);
    const analyst = await member(app, { role: 'staff', permissions: ['analytics'], phone: '9111100002' });
    assert.equal((await analyst('GET', '/wishlist/counts')).status, 200);

    const shop = await hit(app, '/shop', as(a));
    assert.match(shop.text, new RegExp(`href="/p/${tray.slug}" data-wish="${tray.id}"`), 'no heart on the product card');
    assert.match(shop.text, /<script type="application\/json" id="wish-data">\{"signedIn":true,"saved":\[\d+,\d+\]\}/);
    const productPage = await hit(app, `/p/${tray.slug}`);
    assert.match(productPage.text, /src="\/store\/wishlist\.js/);
    assert.match(productPage.text, /"signedIn":false/);
    const account = await hit(app, '/account', as(a));
    assert.match(account.text, /href="\/wishlist"/, 'the account has no way to the wishlist');

    // Without the feature there is no wishlist anywhere.
    await setFeature(app, 'store.wishlist', false);
    assert.equal((await read(app, a)).status, 404);
    assert.equal((await hit(app, '/wishlist')).status, 404);
    assert.doesNotMatch((await hit(app, '/shop')).text, /data-wish=|wishlist\.js/);
    assert.equal((await api('GET', '/wishlist/counts')).status, 403);
  } finally {
    app.close();
  }
});
