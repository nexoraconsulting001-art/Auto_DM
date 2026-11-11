// PRD 9.19: ratings and reviews. Only a shopper who received the product can review it, once per product per order; the
// owner approves, hides and replies but never edits; product pages show the average and count of approved reviews only,
// with every word the shopper wrote escaped; one business's reviews never show on another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRequests } from '../../../src/modules/reviews/request.js';
import { ADDRESS, as, consoleApi, delivered, hit, markPaid, member, multipart, noPlatformName, one, ordered, otherShop, payments, product, rows, sendBytes, setPlan, signedIn, storeApp, textOf, withTenant } from './support.js';

const reviewOf = (app, who, body) => hit(app, '/api/store/reviews', { method: 'POST', body, ...as(who) });
const reviewForm = (page) => /\/api\/store\/reviews|data-review-form|name=["']rating["']/i.test(page);
const ratingOf = (app, productId) => one(app, 'SELECT review_count, rating_sum FROM product_ratings WHERE tenant_id = $1 AND product_id = $2', [app.tenant.id, productId]);

async function world() {
  const app = await storeApp();
  await payments(app);
  return app;
}

test('S-81: only a shopper whose order of the product was delivered may review it, once per order; nobody else, and no bad body', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { name: 'Brass lamp', stock: 10 });
    const bell = await product(app, { name: 'Brass bell', stock: 10 });
    const asha = await signedIn(app);
    const ravi = await signedIn(app, { phone: '+919000011111', name: 'Ravi K' });

    assert.equal((await reviewOf(app, asha, { orderNumber: 'X-1', productId: lamp.id, rating: 5 })).status, 403, 'no order at all');
    const waiting = await ordered(app, asha, lamp.id);
    await markPaid(app, waiting.id);
    assert.equal((await reviewOf(app, asha, { orderNumber: waiting.order_number, productId: lamp.id, rating: 5 })).status, 403, 'paid but not delivered');

    const got = await delivered(app, asha, lamp.id);
    assert.equal((await reviewOf(app, asha, { orderNumber: got.order_number, productId: bell.id, rating: 5 })).status, 403, 'a product the order did not have');
    assert.equal((await reviewOf(app, ravi, { orderNumber: got.order_number, productId: lamp.id, rating: 5 })).status, 403, 'another shopper’s order');
    assert.equal((await hit(app, '/api/store/reviews', { method: 'POST', body: { orderNumber: got.order_number, productId: lamp.id, rating: 5 } })).status, 401, 'a guest');
    for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: '5' }, { body: 'x'.repeat(1001) }, { status: 'approved' }, { displayName: 'Admin' }, { body: 'a\u0000b' }]) {
      const res = await reviewOf(app, asha, { orderNumber: got.order_number, productId: lamp.id, rating: 4, ...bad });
      assert.equal(res.status, 400, `${JSON.stringify(bad).slice(0, 40)} answered ${res.status}`);
    }

    const page = (who) => hit(app, `/p/${lamp.slug}`, who ? as(who) : {});
    assert.equal(reviewForm((await page(ravi)).text), false, 'the form is offered to a shopper who never received it');
    assert.equal(reviewForm((await page(null)).text), false, 'the form is offered to a guest');
    const mine = (await page(asha)).text;
    assert.ok(reviewForm(mine), 'the shopper who received it is not offered the form');
    assert.match(mine, new RegExp(`data-order="${got.order_number}"`));

    const res = await reviewOf(app, asha, { orderNumber: got.order_number, productId: lamp.id, rating: 4, body: 'Lovely glow' });
    assert.equal(res.status, 201, res.text);
    assert.doesNotMatch(res.text, /shopperId|phone|orderId/i);
    assert.equal((await reviewOf(app, asha, { orderNumber: got.order_number, productId: lamp.id, rating: 1 })).status, 409, 'a second review on the same order');
    assert.equal(reviewForm((await page(asha)).text), false, 'the form is still offered after the review');
    const [row] = await rows(app, 'SELECT * FROM reviews WHERE tenant_id = $1', [app.tenant.id]);
    assert.deepEqual([row.status, row.rating, row.display_name, row.shopper_id], ['pending', 4, 'Asha', asha.id]);

    // A second delivered order of the same product may be reviewed again.
    const again = await delivered(app, asha, lamp.id);
    assert.equal((await reviewOf(app, asha, { orderNumber: again.order_number, productId: lamp.id, rating: 5 })).status, 201);
  } finally {
    app.close();
  }
});

test('S-81: a guest order with the number the shopper later proved is theirs to review; the same number at another store is not', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { stock: 10 });
    const guestOrder = await delivered(app, null, lamp.id, { address: { ...ADDRESS, phone: '9822001122' } });
    const asha = await signedIn(app, { phone: '+919822001122' });
    assert.equal((await reviewOf(app, asha, { orderNumber: guestOrder.order_number, productId: lamp.id, rating: 5 })).status, 201);
    const other = await otherShop(app);
    const there = await signedIn(app, { phone: '+919822001122', tenant: other.tenant });
    const res = await reviewOf(app, there, { orderNumber: guestOrder.order_number, productId: lamp.id, rating: 1 });
    assert.ok([403, 404].includes(res.status), `the same phone at another store answered ${res.status}`);
  } finally {
    app.close();
  }
});

test('S-82, S-83: approving updates the average and count once; hiding takes a review out of both; text is escaped; the words are never the seller’s', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { name: 'Brass lamp', stock: 10 });
    const asha = await signedIn(app);
    const ravi = await signedIn(app, { phone: '+919000011111', name: 'Ravi <b>K</b>' });
    const a = await delivered(app, asha, lamp.id);
    const b = await delivered(app, ravi, lamp.id);
    assert.equal((await reviewOf(app, asha, { orderNumber: a.order_number, productId: lamp.id, rating: 4, body: 'Warm light <b>bold</b><script>alert(1)</script>' })).status, 201);
    assert.equal((await reviewOf(app, ravi, { orderNumber: b.order_number, productId: lamp.id, rating: 1, body: 'Arrived dented "badly"' })).status, 201);

    const before = textOf((await hit(app, `/p/${lamp.slug}`)).text);
    assert.ok(!before.includes('Warm light') && /No reviews yet/.test(before), 'a pending review is on the store');
    const api = await consoleApi(app);
    const listed = await api('GET', '/reviews?status=pending');
    assert.equal(listed.status, 200, listed.text);
    const byRating = Object.fromEntries(listed.json.items.map((r) => [r.rating, r]));
    assert.equal(byRating[4].productName, 'Brass lamp');
    assert.equal(byRating[1].displayName, 'Ravi', 'the name shown is a first name only');

    assert.equal((await api('POST', `/reviews/${byRating[4].id}/approve`)).status, 200);
    assert.equal((await api('POST', `/reviews/${byRating[4].id}/approve`)).status, 200, 'approving twice');
    assert.deepEqual(await ratingOf(app, lamp.id), { review_count: 1, rating_sum: 4 }, 'approving twice counted twice');
    const shown = await hit(app, `/p/${lamp.slug}`);
    const text = textOf(shown.text);
    assert.match(text, /4\.0 out of 5 · 1 review\b/);
    assert.ok(text.includes('Warm light <b>bold</b><script>alert(1)</script>'), 'the words are not shown as written');
    assert.doesNotMatch(shown.text, /<script>alert\(1\)/, 'a shopper’s script is live on the page');
    assert.ok(noPlatformName(shown.text), 'the product page names the platform');

    assert.equal((await api('POST', `/reviews/${byRating[1].id}/approve`)).status, 200);
    assert.deepEqual(await ratingOf(app, lamp.id), { review_count: 2, rating_sum: 5 });
    assert.match(textOf((await hit(app, `/p/${lamp.slug}`)).text), /2\.5 out of 5 · 2 reviews/);
    const hidden = await api('POST', `/reviews/${byRating[1].id}/hide`);
    assert.equal(hidden.json.status, 'hidden');
    assert.equal((await api('POST', `/reviews/${byRating[1].id}/hide`)).status, 200, 'hiding twice');
    assert.deepEqual(await ratingOf(app, lamp.id), { review_count: 1, rating_sum: 4 }, 'the hidden review still counts');
    assert.ok(!(await hit(app, `/p/${lamp.slug}`)).text.includes('Arrived dented'), 'the hidden review is still on the store');
    const store = await hit(app, `/api/store/products/${lamp.id}/reviews`);
    assert.equal(store.status, 200);
    assert.deepEqual([store.json.count, store.json.average, store.json.items.length], [1, 4, 1]);
    assert.doesNotMatch(store.text, /phone|shopperId|orderId|\+91|dented/i);
    assert.deepEqual((await api('GET', '/reviews?status=hidden')).json.items.map((r) => r.body), ['Arrived dented "badly"']);

    // One public reply; the shopper's words can't be changed by any route.
    const reply = await api('PUT', `/reviews/${byRating[4].id}/reply`, { reply: 'Thank you! <i>Enjoy</i>' });
    assert.equal(reply.status, 200, reply.text);
    assert.equal((await api('PUT', `/reviews/${byRating[4].id}/reply`, { reply: '' })).status, 400, 'an empty reply');
    const replied = (await hit(app, `/p/${lamp.slug}`)).text;
    assert.ok(replied.includes('Thank you! &lt;i&gt;Enjoy&lt;/i&gt;'), 'the reply is not escaped');
    for (const [method, path] of [['PATCH', `/reviews/${byRating[4].id}`], ['PUT', `/reviews/${byRating[4].id}`]]) {
      const res = await api(method, path, { body: 'Great product!', rating: 5 });
      assert.ok([400, 404, 405].includes(res.status), `${method} ${path} answered ${res.status}`);
    }
    const kept = await one(app, 'SELECT body, rating FROM reviews WHERE tenant_id = $1 AND id = $2', [app.tenant.id, byRating[4].id]);
    assert.deepEqual(kept, { body: 'Warm light <b>bold</b><script>alert(1)</script>', rating: 4 });
  } finally {
    app.close();
  }
});

test('reviews belong to one business: another approves nothing and shows nothing; staff need catalog; the plan gates it all', async () => {
  const app = await world();
  try {
    const lamp = await product(app, { stock: 10 });
    const asha = await signedIn(app);
    const got = await delivered(app, asha, lamp.id);
    assert.equal((await reviewOf(app, asha, { orderNumber: got.order_number, productId: lamp.id, rating: 5, body: 'Beautiful' })).status, 201);
    const api = await consoleApi(app);
    const [{ id }] = (await api('GET', '/reviews')).json.items;
    await api('POST', `/reviews/${id}/approve`);

    const other = await otherShop(app);
    const theirs = await consoleApi(app, { host: other.host });
    assert.equal((await theirs('POST', `/reviews/${id}/approve`)).status, 404);
    assert.equal((await theirs('PUT', `/reviews/${id}/reply`, { reply: 'x' })).status, 404);
    assert.deepEqual((await theirs('GET', '/reviews')).json.items, []);
    const there = await hit(app, `/api/store/products/${lamp.id}/reviews`, { host: other.host });
    assert.equal(there.status, 200);
    assert.ok(!there.text.includes('Beautiful'));

    const staff = await member(app, { role: 'staff', permissions: ['orders'] });
    assert.equal((await staff('POST', `/reviews/${id}/approve`)).status, 403);
    const catalog = await member(app, { role: 'staff', permissions: ['catalog'], phone: '9111100002' });
    assert.equal((await catalog('GET', '/reviews')).status, 200);

    await setPlan(app, app.tenant.id, 't2');
    const refused = await api('GET', '/reviews');
    assert.equal(refused.status, 403);
    assert.equal(refused.json.reason, 'plan');
  } finally {
    app.close();
  }
});

test('the review request after delivery goes through the gate as marketing, once, and not without the shopper’s yes', async () => {
  const app = await storeApp({ overrides: { reviewRequestDelayMs: 0 } });
  try {
    await payments(app);
    const lamp = await product(app, { stock: 10 });
    const asha = await signedIn(app);
    const got = await delivered(app, asha, lamp.id, { email: 'asha@mail.example' });
    const jobs = await rows(app, `SELECT tenant_id, payload FROM jobs WHERE queue = 'reviews.request'`);
    assert.deepEqual(jobs.map((j) => [j.tenant_id, j.payload.orderId]), [[app.tenant.id, got.id]], 'delivery queues one request');

    const sent = [];
    const requests = reviewRequests({ ...app.ctx, shopperMessages: { send: async (m) => { sent.push(m); return { outcome: 'skipped', reason: 'no_consent' }; } } });
    await withTenant(app.tenant, () => requests.send(got.id));
    await withTenant(app.tenant, () => requests.send(got.id));
    assert.deepEqual(sent.map((m) => [m.channel, m.purpose]), [['whatsapp', 'marketing'], ['email', 'marketing']], 'asked once per channel, as marketing');
    assert.ok(sent.every((m) => noPlatformName(JSON.stringify(m))), 'a review request names the platform');
    assert.match(sent[0].template.params[2], new RegExp(`/p/${lamp.slug}$`), 'the link is the product’s own page, direct');
    assert.ok(sent[1].email.unsubscribeUrl.includes('/unsubscribe/'));
    const alerts = await rows(app, `SELECT channel, status, skip_reason FROM order_alerts WHERE tenant_id = $1 AND order_id = $2 AND event = 'review_request' ORDER BY channel`, [app.tenant.id, got.id]);
    assert.deepEqual(alerts, [{ channel: 'email', status: 'skipped', skip_reason: 'no_consent' }, { channel: 'whatsapp', status: 'skipped', skip_reason: 'no_consent' }]);

    // Through the real gate: no marketing consent, so nothing reaches a provider.
    const other = await delivered(app, asha, lamp.id);
    await withTenant(app.tenant, () => reviewRequests(app.ctx).send(other.id));
    const real = await rows(app, `SELECT status, skip_reason FROM order_alerts WHERE tenant_id = $1 AND order_id = $2 AND event = 'review_request'`, [app.tenant.id, other.id]);
    assert.deepEqual(real.map((r) => r.status), ['skipped']);
  } finally {
    app.close();
  }
});

test('a review may carry up to three photos, stored as the business’s own media after they are written again; anything else is refused', async () => {
  const app = await world();
  try {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c0392b' } }).png().toBuffer();
    const lamp = await product(app, { name: 'Brass lamp', stock: 10 });
    const asha = await signedIn(app);
    const ravi = await signedIn(app, { phone: '+919000011111' });
    const got = await delivered(app, asha, lamp.id);
    const post = (who, fields, files) => {
      const form = multipart(fields, files);
      return sendBytes(app, '/api/store/reviews', { body: form.body, cookie: who.cookie, headers: { ...form.headers, 'x-shopper-csrf': who.csrf } });
    };
    const photo = (n = 1) => Array.from({ length: n }, (_, i) => ({ field: 'photos', name: `p${i}.png`, type: 'image/png', data: png }));
    const fields = { orderNumber: got.order_number, productId: String(lamp.id), rating: '5', body: 'Looks <i>lovely</i>' };

    assert.equal((await post(ravi, fields, photo())).status, 403, 'a shopper who never received it');
    assert.equal((await post(asha, fields, photo(4))).status, 400, 'four photos');
    assert.equal((await post(asha, fields, [{ field: 'photos', name: 'x.png', type: 'image/png', data: Buffer.from('<script>alert(1)</script>') }])).status, 400, 'a script named as a photo');
    assert.equal((await post(asha, fields, [{ field: 'photos', name: 'x.svg', type: 'image/svg+xml', data: Buffer.from('<svg/>') }])).status, 415, 'an SVG');
    assert.equal((await post(asha, { ...fields, rating: 'five' }, photo())).status, 400, 'a rating that isn’t a number');
    assert.equal((await post(asha, { ...fields, status: 'approved' }, photo())).status, 400, 'a field the page may not send');
    assert.equal((await rows(app, 'SELECT count(*)::int AS n FROM media WHERE tenant_id = $1', [app.tenant.id]))[0].n, 0, 'a refused review left files behind');

    const res = await post(asha, fields, photo(2));
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.review.photos.length, 2);
    const stored = await rows(app, 'SELECT m.mime FROM review_photos p JOIN media m ON m.tenant_id = p.tenant_id AND m.id = p.media_id WHERE p.tenant_id = $1 ORDER BY p.position', [app.tenant.id]);
    assert.deepEqual(stored.map((m) => m.mime), ['image/webp', 'image/webp'], 'the photos were kept as they arrived');
    assert.equal((await post(asha, fields, photo())).status, 409, 'a second review on the same order');

    const api = await consoleApi(app);
    const [review] = (await api('GET', '/reviews')).json.items;
    assert.equal(review.photos.length, 2);
    await api('POST', `/reviews/${review.id}/approve`);
    const page = await hit(app, `/p/${lamp.slug}`);
    assert.equal((page.text.match(/<img src="\/media\/[0-9a-f-]{36}" alt="A buyer’s photo"/g) ?? []).length, 2);
    assert.equal((await hit(app, review.photos[0])).status, 200);
    assert.ok(page.text.includes('Looks &lt;i&gt;lovely&lt;/i&gt;'));
  } finally {
    app.close();
  }
});
