// Customers, password resets and DM activity through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, REEL_ID, seedReel } from '../../helpers.js';
import { capturingLogs, ok, placeOrder, refused, walk, withApp } from './support.js';

const asha = { name: 'Asha K', phone: '9876543210', password: 'secret1' };

test('customers list what they have ordered and spent, owners first, and search', withApp(async ({ api, repos }) => {
  const user = await repos.users.create(asha);
  await repos.users.create({ name: 'Ravi S', phone: '9123456780', password: 'secret1' });
  const pot = await ok(await api('POST', '/products', { name: 'Pot', pricePaise: 100000 }), 201);
  await placeOrder(repos, pot, { userId: user.id });
  const cancelled = await placeOrder(repos, pot, { userId: user.id });
  await ok(await api('POST', `/orders/${cancelled.id}/status`, { status: 'cancelled' }));

  const { items } = await ok(await api('GET', '/customers'));
  assert.deepEqual(items.map((c) => c.role), ['owner', 'customer', 'customer']);
  assert.equal(items[0].phone, OWNER.phone);
  const row = items.find((c) => c.id === user.id);
  assert.equal(row.orderCount, 2);
  assert.equal(row.spentPaise, 100000);
  assert.equal(row.name, asha.name);
  assert.equal('password_hash' in row, false);

  const search = async (q) => (await ok(await api('GET', `/customers?search=${q}`))).items.map((c) => c.name);
  assert.deepEqual(await search('asha'), ['Asha K']);
  assert.deepEqual(await search('9123'), ['Ravi S']);
  assert.deepEqual(await search('zzz'), []);
}));

test('paging reaches every customer, past the 500 the core repo stops at, and keeps owners first', withApp(async ({ api, db, tenant }) => {
  await db.query(
    `INSERT INTO users (tenant_id, name, phone, password_hash, role) SELECT $1, 'Buyer ' || n, (8000000000 + n)::text, 'x', 'customer' FROM generate_series(1, 505) n`,
    [tenant.id],
  );
  const { items, sizes } = await walk(api, '/customers', 100);
  assert.deepEqual(sizes, [100, 100, 100, 100, 100, 6]);
  assert.equal(new Set(items.map((c) => c.id)).size, 506);
  assert.equal(items[0].role, 'owner');
  assert.ok(items.slice(1).every((c) => c.role === 'customer'));
  for (const cursor of ['WzBd', 'WzIsMV0', 'WzEsMF0']) await refused(await api('GET', `/customers?cursor=${cursor}`), 400, 'validation_failed');
}));

test('a reset gives a shopper a new password, once, and ends their sessions', withApp(async (app) => {
  const { api, repos } = app;
  const user = await repos.users.create(asha);
  const old = await app.signIn(asha);
  const lines = await capturingLogs(async (captured) => {
    const { temporaryPassword } = await ok(await api('POST', `/customers/${user.id}/reset-password`));
    assert.match(temporaryPassword, /^[A-Za-z0-9]{8}$/);
    await refused(await fetch(`${app.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${old}` } }), 401, 'unauthorized');
    await refused(await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(asha) }), 401, 'unauthorized');
    assert.ok(await app.signIn({ phone: asha.phone, password: temporaryPassword }));
    assert.ok(!JSON.stringify(captured).includes(temporaryPassword));
  });
  assert.ok(!JSON.stringify(lines).includes(asha.phone));
}));

test('a reset applies to shoppers only, and a missing person is a 404', withApp(async ({ api, repos }) => {
  const staff = await repos.users.create({ name: 'Ravi S', phone: '9123456780', password: 'secret1', role: 'staff' });
  const owner = await repos.users.findByPhone(OWNER.phone);
  for (const person of [owner, staff]) await refused(await api('POST', `/customers/${person.id}/reset-password`), 403, 'forbidden');
  await refused(await api('POST', '/customers/999999/reset-password'), 404, 'not_found');
  assert.ok(await repos.users.verify(staff.phone, 'secret1'));
  assert.ok(await repos.users.verify(OWNER.phone, OWNER.password));
}));

test('activity shows each comment with its reel, newest first', withApp(async ({ api, repos }) => {
  await seedReel(repos);
  await repos.activity.log({ commentId: 'c1', reelId: REEL_ID, userId: 'u1', username: 'asha', text: 'LINK please', result: 'sent' });
  await repos.activity.log({ commentId: 'c2', reelId: null, userId: 'u2', username: 'ravi', text: 'hello', result: 'failed', error: 'no reel' });
  const { items, nextCursor } = await ok(await api('GET', '/activity'));
  assert.equal(nextCursor, null);
  assert.deepEqual(items.map((a) => a.commentId), ['c2', 'c1']);
  assert.equal(items[1].reelId, REEL_ID);
  assert.equal(items[1].reelHeadline, 'Brunch edit');
  assert.equal(items[1].reelSlug, 'brunch-edit');
  assert.equal(items[1].username, 'asha');
  assert.equal(items[1].text, 'LINK please');
  assert.equal(items[1].result, 'sent');
  assert.equal(items[0].reelHeadline, null);
  assert.equal(items[0].error, 'no reel');
}));

test('activity pages through rows made in the same instant, and a retried comment moves to the top', withApp(async ({ api, db, tenant, repos }) => {
  await db.query(
    `INSERT INTO activity (tenant_id, comment_id, username, text, result, created_at) SELECT $1, 'c' || n, 'u', 't', 'sent', '2026-11-01T10:00:00Z' FROM generate_series(1, 7) n`,
    [tenant.id],
  );
  const { items, sizes } = await walk(api, '/activity', 3);
  assert.deepEqual(sizes, [3, 3, 1]);
  assert.equal(new Set(items.map((a) => a.id)).size, 7);

  await db.query(`UPDATE activity SET result = 'failed' WHERE tenant_id = $1 AND comment_id = 'c2'`, [tenant.id]);
  await repos.activity.claim({ commentId: 'c2', reelId: null, userId: 'u', username: 'u', text: 't' });
  assert.equal((await ok(await api('GET', '/activity?limit=1'))).items[0].commentId, 'c2');
  for (const cursor of ['WzBd', 'WyJ4IiwxXQ', 'WzEuNSwxXQ', 'WzEsMF0']) await refused(await api('GET', `/activity?cursor=${cursor}`), 400, 'validation_failed');
}));
