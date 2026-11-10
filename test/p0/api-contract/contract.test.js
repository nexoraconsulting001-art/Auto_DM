// The /api/v1 contract is the same kind of thing all the way through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../../src/contracts/api/index.js';
import { ALLOWED_IMAGE_TYPES } from '../../../src/repos/media.js';
import { ORDER_STATUSES } from '../../../src/repos/orders.js';

const { routeList, ERROR_STATUS, ERROR_CODES, ApiError, isAllowed, staffWith, MANAGERS, OWNER_ONLY, PUBLIC, SIGNED_IN, ListQuery, text, Timestamp, IdParams, PaiseInput, IMAGE_UPLOAD } = contract;

test('every route has a method, a path, an access rule and a response', () => {
  assert.ok(routeList.length >= 30);
  for (const route of routeList) {
    assert.match(route.id, /^[a-zA-Z]+\.[a-zA-Z]+$/, route.id);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method), route.id);
    assert.match(route.path, /^\/[a-z0-9:/-]+$/, route.id);
    assert.ok(route.access && (route.access.public || route.access.signedIn || route.access.roles?.length), `${route.id} has no access rule`);
    assert.ok(route.response === null || typeof route.response?.safeParse === 'function', `${route.id} has no response`);
    if (route.response === null) assert.equal(route.status, 204, route.id);
    if (route.method === 'GET') assert.equal(route.body, undefined, route.id);
    if (route.path.includes(':')) assert.ok(route.params, `${route.id} has a path parameter and no schema for it`);
  }
});

test('no route is hidden behind another', () => {
  const seen = new Set();
  for (const { id, method, path } of routeList) {
    const key = `${method} ${path}`;
    assert.ok(!seen.has(key), `${id} repeats ${key}`);
    seen.add(key);
  }
  // A path with a parameter must not swallow a fixed path registered after it.
  routeList.forEach((later, i) => {
    for (const earlier of routeList.slice(0, i)) {
      if (earlier.method !== later.method || !earlier.path.includes(':')) continue;
      const pattern = new RegExp(`^${earlier.path.replace(/:\w+/g, '[^/]+')}$`);
      assert.ok(!pattern.test(later.path), `${earlier.id} hides ${later.id}`);
    }
  });
});

test('every list takes a cursor and a limit and returns items and a next cursor', () => {
  const lists = routeList.filter((r) => r.response?.shape?.nextCursor);
  assert.ok(lists.length >= 8);
  assert.ok(routeList.filter((r) => r.id.endsWith('.list')).every((r) => lists.includes(r)));
  for (const route of lists) {
    assert.ok(route.response.shape.items, route.id);
    assert.ok(route.query, `${route.id} has no query`);
    assert.equal(route.query.parse({ cursor: 'abc', limit: '5' }).limit, 5, route.id);
    assert.equal(route.query.parse({}).limit, 25, route.id);
    assert.equal(route.query.safeParse({ limit: '101' }).success, false, route.id);
  }
  assert.equal(ListQuery.safeParse({ cursor: "x' OR 1=1" }).success, false);
});

test('money is whole paise, and input stops at what the columns hold', () => {
  for (const route of routeList) {
    const shapes = [route.body?.shape, route.response?.shape, route.response?.shape?.items?.element?.shape].filter(Boolean);
    for (const shape of shapes) {
      for (const [name, schema] of Object.entries(shape)) {
        if (!name.endsWith('Paise')) continue;
        assert.equal(schema.safeParse(1.5).success, false, `${route.id}.${name} accepts part of a paisa`);
        assert.equal(schema.safeParse(-1).success, false, `${route.id}.${name} accepts a negative amount`);
      }
    }
  }
  assert.equal(PaiseInput.safeParse(2147483647).success, true);
  assert.equal(PaiseInput.safeParse(2147483648).success, false);
});

test('text never carries a NUL byte, ids stop at 32 bits, and times come out as strings', () => {
  assert.equal(text(10).safeParse('a\0b').success, false);
  assert.equal(text(10).parse('  hi  '), 'hi');
  for (const id of ['0', '-1', '1e3', '0x10', ' 7', '7.5', '2147483648', '99999999999999999999', '']) {
    assert.equal(IdParams.safeParse({ id }).success, false, id);
  }
  assert.deepEqual(IdParams.parse({ id: '2147483647' }), { id: 2147483647 });
  assert.equal(Timestamp.parse(new Date(0)), '1970-01-01T00:00:00.000Z');
});

test('the contract agrees with the data layer', () => {
  assert.deepEqual([...contract.ORDER_STATUSES].sort(), Object.keys(ORDER_STATUSES).sort());
  assert.deepEqual([...IMAGE_UPLOAD.mimeTypes].sort(), [...ALLOWED_IMAGE_TYPES].sort());
});

test('every error code has a status and a sentence for people', () => {
  assert.equal(ERROR_CODES.length, Object.keys(ERROR_STATUS).length);
  for (const code of ERROR_CODES) {
    const err = new ApiError(code);
    assert.equal(err.status, ERROR_STATUS[code]);
    assert.ok(err.message.length > 5, code);
  }
  assert.equal(new ApiError('conflict', 'Already shipped').message, 'Already shipped');
  assert.equal(contract.ErrorBody.safeParse({ error: 'x', code: 'not_found', fields: { a: 'b' }, requestId: 'r' }).success, true);
  assert.equal(contract.ErrorBody.safeParse({ error: 'x', code: 'made_up' }).success, false);
});

test('access rules: owner and manager by role, staff only by named permission', () => {
  const owner = { role: 'owner' };
  const manager = { role: 'manager' };
  const shopper = { role: 'customer' };
  const noPermissions = { role: 'staff' };
  const ordersOnly = { role: 'staff', permissions: ['orders'] };

  assert.equal(isAllowed(null, PUBLIC), true);
  assert.equal(isAllowed(null, SIGNED_IN), false);
  assert.equal(isAllowed(shopper, SIGNED_IN), true);

  assert.equal(isAllowed(owner, OWNER_ONLY), true);
  assert.equal(isAllowed(manager, OWNER_ONLY), false);
  assert.equal(isAllowed(manager, MANAGERS), true);
  assert.equal(isAllowed(ordersOnly, MANAGERS), false);

  const orders = staffWith('orders');
  assert.equal(isAllowed(owner, orders), true);
  assert.equal(isAllowed(manager, orders), true);
  assert.equal(isAllowed(ordersOnly, orders), true);
  assert.equal(isAllowed(ordersOnly, staffWith('automations')), false);
  assert.equal(isAllowed(noPermissions, orders), false);
  assert.equal(isAllowed(shopper, orders), false);
  assert.equal(isAllowed(null, orders), false);
});

test('where shoppers\' money goes is the owner\'s alone', () => {
  const route = routeList.find((r) => r.id === 'settings.updatePayment');
  assert.deepEqual([...route.access.roles], ['owner']);
  // The general settings route must not be a way round it.
  const updated = routeList.find((r) => r.id === 'settings.update').body.parse({ upiId: 'attacker@upi', upiPayee: 'x', storeName: 'S' });
  assert.deepEqual(updated, { storeName: 'S' });
});
