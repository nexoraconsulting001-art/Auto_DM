// PRD 10.2 and 10.3: one person, several businesses. The switcher lists exactly theirs, switching shows only the new
// business's rows, another business's ids answer 404, and X-Tenant-Id for a business the person is not in is refused.
// An order confirmed in the app is the same order on the web. P-06, P-09, P-10, P-18.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMember, addP4Shop, addSeller, appSignIn, codOrder, local10, manualOrder, newSellerPhone, noCrash, ok, ownerApp, ownerPhone, refusedWith, useP5World, webSignIn,
} from './kit.js';

const world = useP5World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

test('P-06: the owner of A asking for B\'s order id gets 404, and nothing of B\'s order in the answer', async () => {
  const a = await addSeller(world, { name: 'Alder Goods' });
  const b = await addSeller(world, { name: 'Birch Wares' });
  const theirs = await manualOrder(b, { name: 'Bina Secret', phone: '9811122233', address: '7 Hidden Lane', city: 'Pune', state: 'MH', pincode: '411001' });
  const s = await ownerApp(world, a);
  for (const [method, path, body] of [
    ['GET', `/orders/${theirs.id}`], ['GET', `/orders/${theirs.id}/timeline`], ['POST', `/orders/${theirs.id}/advance`, { to: 'packed' }],
    ['POST', `/orders/${theirs.id}/cancel`, { reason: 'seller' }], ['POST', `/orders/${theirs.id}/notes`, { note: 'peek' }], ['POST', `/orders/${theirs.id}/status`, { status: 'shipped' }],
  ]) {
    const res = await s.send(method, path, body);
    assert.equal(res.status, 404, `${method} ${path} for another business's order answered ${res.status}`);
    assert.doesNotMatch(res.text, /Bina Secret|9811122233|Hidden Lane/, `${method} ${path} leaked B's order`);
  }
  const [row] = await b.sql('SELECT status, notes FROM orders WHERE tenant_id = $1 AND id = $2', [b.tenantId, theirs.id]);
  assert.notEqual(row.status, 'shipped', 'A changed B\'s order');
  assert.ok(!String(row.notes ?? '').includes('peek'));
  // A's list never holds it.
  const list = await s.send('GET', '/orders?limit=100');
  assert.equal(list.status, 200);
  assert.ok(!list.data.items.some((o) => o.id === theirs.id), 'A\'s order list holds B\'s order');
  // Ids that are not ids are refused, never a fault.
  for (const id of ['0', '-1', 'abc', '1.5', '99999999999999999999', '%00', `${theirs.id}%20OR%201=1`]) noCrash(await s.send('GET', `/orders/${id}`), `GET /orders/${id}`);
});

test('P-06: X-Tenant-Id for a business the person is not in, or no business at all, is a 403, never a fault', async () => {
  const a = await addSeller(world);
  const b = await addSeller(world);
  await manualOrder(b);
  const s = await ownerApp(world, a);
  const asB = await s.send('GET', '/orders', undefined, { tenantId: b.tenantId });
  assert.deepEqual([asB.status, asB.data?.code], [403, 'forbidden'], 'X-Tenant-Id of a business this person is not in');
  assert.equal(asB.data?.items, undefined);
  for (const id of ['99999999', '0', '-1', 'abc', `${b.tenantId}, ${a.tenantId}`, `${a.tenantId} OR 1=1`, ' ', '1e3']) {
    const res = noCrash(await s.send('GET', '/orders', undefined, { headers: { 'x-tenant-id': id } }), `X-Tenant-Id: ${id}`);
    assert.ok([400, 403].includes(res.status), `X-Tenant-Id: ${JSON.stringify(id)} answered ${res.status}`);
  }
  // A good token on another business's own address is a 401 there.
  const onB = await world.app('/api/v1/orders', { host: b.host, token: s.accessToken });
  assert.equal(onB.status, 401, `A's token on B's own address answered ${onB.status}`);
  // The same for the console's cookie session.
  const web = await webSignIn(world, ownerPhone(a), { tenantId: a.tenantId });
  assert.equal((await web.send('GET', '/orders')).status, 200);
  assert.equal((await web.send('GET', '/orders', undefined, { tenantId: b.tenantId })).status, 403);
});

test('P-06: every Phase 5 route that takes an id refuses another business\'s', async () => {
  const a = await addSeller(world);
  const b = await addSeller(world);
  const theirs = await addMember(b, { role: 'staff', permissions: ['orders'] });
  const s = await ownerApp(world, a);
  for (const [method, path, body] of [
    ['PATCH', `/team/${theirs.userId}`, { role: 'manager' }],
    ['DELETE', `/team/${theirs.userId}`],
  ]) {
    const res = noCrash(await s.send(method, path, body), `${method} ${path}`);
    assert.ok([403, 404].includes(res.status), `${method} ${path} for another business's member answered ${res.status}`);
  }
  const [row] = await b.sql('SELECT role, removed_at FROM users WHERE tenant_id = $1 AND id = $2', [b.tenantId, theirs.userId]);
  assert.deepEqual([row.role, row.removed_at], ['staff', null], 'A changed B\'s team');
  // Notifications: B's ids are not A's to mark.
  const bOwner = await ownerApp(world, b);
  const theirList = await bOwner.send('GET', '/notifications');
  const ids = (theirList.data?.items ?? []).map((n) => n.id);
  if (ids.length) {
    noCrash(await s.send('POST', '/notifications/read', { ids }), 'Marking another business\'s notifications read');
    const again = await bOwner.send('GET', '/notifications?unread=1');
    assert.equal(again.data.unread, theirList.data.unread, 'A marked B\'s notifications read');
  }
});

test('P-09: a staff member in two businesses sees exactly those two in the switcher', async () => {
  const a = await addSeller(world, { name: 'Ash Studio' });
  const b = await addSeller(world, { name: 'Beech Store' });
  const c = await addSeller(world, { name: 'Cedar Shop' });
  const d = await addSeller(world, { name: 'Deodar Mart' });
  const phone = newSellerPhone();
  await addMember(a, { phone, role: 'staff', permissions: ['orders'] });
  await addMember(b, { phone, role: 'staff', permissions: ['catalog'] });
  // Removed from C's team, and a shopper (not a seller) at D: neither is a business of theirs.
  const removed = await addMember(c, { phone, role: 'staff', permissions: ['orders'] });
  await c.sql('UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND id = $2', [c.tenantId, removed.userId]);
  await d.repos.users.create({ name: 'Shopper', phone: local10(phone), password: 'shopper-pass-1', role: 'customer' });

  const s = await appSignIn(world, phone, { tenantId: a.tenantId });
  const listed = await s.send('GET', '/auth/businesses');
  assert.equal(listed.status, 200);
  const ids = listed.data.businesses.map((x) => x.id).sort((x, y) => x - y);
  assert.deepEqual(ids, [a.tenantId, b.tenantId].sort((x, y) => x - y), `The switcher lists ${JSON.stringify(listed.data.businesses.map((x) => x.name))}`);
  assert.ok(listed.data.businesses.every((x) => x.role === 'staff'));
  assert.deepEqual(listed.data.businesses.filter((x) => x.current).map((x) => x.id), [a.tenantId], 'The business in use is not the one marked current');
  assert.deepEqual(s.businesses.map((x) => x.id).sort((x, y) => x - y), ids, 'The sign-in answer lists other businesses');
  assert.doesNotMatch(listed.text, /Cedar Shop|Deodar Mart/);
  // Switching to one of theirs works with that account's permissions; the others are refused.
  const inB = await s.send('GET', '/auth/me', undefined, { tenantId: b.tenantId });
  assert.equal(inB.status, 200);
  assert.equal(inB.data.business.id, b.tenantId);
  assert.deepEqual(inB.data.user.permissions, ['catalog'], 'In B the staff member has B\'s permissions');
  assert.equal((await s.send('GET', '/orders', undefined, { tenantId: b.tenantId })).status, 403, 'In B they hold no orders permission');
  for (const other of [c, d]) assert.equal((await s.send('GET', '/auth/me', undefined, { tenantId: other.tenantId })).status, 403);
});

test('P-09: a number nobody verified links no business: an account typed with someone\'s number is not theirs until they prove it', async () => {
  const a = await addSeller(world);
  const b = await addSeller(world);
  const phone = newSellerPhone();
  const inA = await addMember(a, { phone, role: 'manager' });
  const inB = await addMember(b, { phone, role: 'staff', permissions: ['orders'] });
  // Nobody has signed in with that number yet: there is no person, no link between the two accounts.
  const people = await world.sql('SELECT p.id FROM people p JOIN person_identities i ON i.person_id = p.id WHERE i.kind = $1 AND i.subject = $2', ['phone', phone]);
  assert.equal(people.length, 0, 'A person exists for a number nobody verified');
  const linked = () => world.sql('SELECT count(*)::int AS n FROM memberships WHERE (tenant_id = $1 AND user_id = $2) OR (tenant_id = $3 AND user_id = $4)', [a.tenantId, inA.userId, b.tenantId, inB.userId]);
  assert.equal((await linked())[0].n, 0, 'A membership was written for a number nobody verified');
  const users = await world.sql('SELECT person_id FROM users WHERE (tenant_id = $1 AND id = $2) OR (tenant_id = $3 AND id = $4)', [a.tenantId, inA.userId, b.tenantId, inB.userId]);
  assert.ok(users.every((u) => u.person_id === null), 'An account belongs to a person before anyone proved the number');
  // The code to that number is the proof: both accounts are theirs from then on.
  const s = await appSignIn(world, phone, { tenantId: a.tenantId });
  const ids = (await s.send('GET', '/auth/businesses')).data.businesses.map((x) => x.id).sort((x, y) => x - y);
  assert.deepEqual(ids, [a.tenantId, b.tenantId].sort((x, y) => x - y));
});

test('P-10: switching business shows only the new business\'s orders, with no stale rows', async () => {
  const a = await addSeller(world, { name: 'Amla House' });
  const b = await addSeller(world, { name: 'Bael Corner' });
  const phone = newSellerPhone();
  await addMember(a, { phone, role: 'manager' });
  await addMember(b, { phone, role: 'manager' });
  const inA = [await manualOrder(a, { name: 'Anil A', phone: '9822200011', address: '1 A Road', city: 'Pune', state: 'MH', pincode: '411001' }), await manualOrder(a)];
  const inB = [await manualOrder(b, { name: 'Bela B', phone: '9822200022', address: '2 B Road', city: 'Pune', state: 'MH', pincode: '411001' })];
  const s = await appSignIn(world, phone, { tenantId: a.tenantId });

  const first = await s.send('GET', '/orders?limit=100', undefined, { tenantId: a.tenantId });
  assert.deepEqual(first.data.items.map((o) => o.id).sort(), inA.map((o) => o.id).sort());
  const switched = await s.send('GET', '/orders?limit=100', undefined, { tenantId: b.tenantId });
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.data.items.map((o) => o.id), inB.map((o) => o.id), 'After switching, Orders holds rows from the other business');
  assert.doesNotMatch(switched.text, /Anil A|9822200011/, 'A\'s customer shows in B');
  // Without the header, the session stays in the business it opened in: nothing moved behind the app's back.
  const plain = await s.send('GET', '/orders?limit=100');
  assert.deepEqual(plain.data.items.map((o) => o.id).sort(), inA.map((o) => o.id).sort());
  // A cursor from one business is no window into the other.
  const paged = await s.send('GET', '/orders?limit=1', undefined, { tenantId: a.tenantId });
  if (paged.data?.nextCursor) {
    const crossed = noCrash(await s.send('GET', `/orders?limit=100&cursor=${encodeURIComponent(paged.data.nextCursor)}`, undefined, { tenantId: b.tenantId }), 'A\'s cursor in B');
    if (crossed.status === 200) assert.ok(crossed.data.items.every((o) => inB.some((x) => x.id === o.id)), 'A\'s cursor showed A\'s rows in B');
  }
});

test('P-18: an order confirmed in the app shows the same status on the web on refresh', async () => {
  const shop = await addP4Shop(world, { name: 'Neem Naturals' });
  await shop.codOn();
  const product = await shop.item({ pricePaise: 59900, stock: 5 });
  const placed = await codOrder(world, shop, [line(product)]);
  const order = await shop.order(placed.orderNumber);
  assert.ok(order, 'The COD order was not made');

  const phone = ownerPhone(shop);
  const app = await appSignIn(world, phone, { tenantId: shop.tenantId });
  const web = await webSignIn(world, phone, { tenantId: shop.tenantId });
  const seen = await app.send('GET', `/orders/${order.id}`);
  assert.equal(seen.status, 200);
  // Confirming in the app: releasing a hold if there is one, then the first move the order allows.
  if (seen.data.holdReason) ok(await app.send('POST', `/orders/${order.id}/release-hold`), 'Releasing the hold in the app');
  const next = (await app.send('GET', `/orders/${order.id}`)).data.nextFulfilment ?? ['packed'];
  const to = ['packed', 'shipped', 'delivered'].find((s) => next.includes(s)) ?? 'packed';
  const confirmed = await app.send('POST', `/orders/${order.id}/advance`, { to });
  assert.equal(confirmed.status, 200, `Confirming in the app: ${confirmed.status} ${confirmed.text.slice(0, 200)}`);

  const onWeb = await web.send('GET', `/orders/${order.id}`);
  assert.equal(onWeb.status, 200);
  for (const field of ['fulfilmentStatus', 'paymentStatus', 'status', 'holdReason']) assert.deepEqual(onWeb.data[field], confirmed.data[field], `${field} differs between the app and the web`);
  const listed = (await web.send('GET', '/orders?limit=100')).data.items.find((o) => o.id === order.id);
  assert.equal(listed?.fulfilmentStatus, confirmed.data.fulfilmentStatus, 'The web list shows another status');
  const timeline = await web.send('GET', `/orders/${order.id}/timeline`);
  assert.ok(timeline.data.items.some((e) => e.to === confirmed.data.fulfilmentStatus), 'The web timeline does not show the app\'s change');
});
