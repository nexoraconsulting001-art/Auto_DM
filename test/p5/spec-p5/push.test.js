// PRD 10.5: owner push. A cash on delivery order pushes within 30 s and the push opens the order; same-kind events
// inside 60 s collapse into one push; a push holds no name, phone, address or payment detail and always carries its
// business and a deep link; a token APNs or FCM rejects is deleted. One FCM project and one APNs key serve every
// business. P-20, P-21, P-22, P-23, P-13 (the server's half).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_RULES, NOTIFY_TABLES, PUSH_DATA_KEYS, SECOND, addMember, addP4Shop, addSeller, address, androidPushToken, appSignIn, buyer, codOrder, deliveries, iosPushToken, newDevice,
  newPhone, newSellerPhone, ownerApp, pushProblem, pushText, registerPush, unique, useP5World,
} from './kit.js';

const world = useP5World();
const line = (product, qty = 1) => ({ productId: product.id, variantId: null, qty });

/** The owner of a store, in the app with push on. */
async function ownerWithPush(shop, platform = 'android') {
  const s = await ownerApp(world, shop, { device: newDevice(platform === 'ios' ? 'iPhone 16' : 'Pixel 8', platform) });
  const token = await registerPush(s, { platform });
  return { s, token };
}

test('P-20: a cash on delivery order pushes within 30 s, and tapping it opens the order', async () => {
  const shop = await addP4Shop(world, { name: 'Kesar Kitchen' });
  await shop.codOn();
  const owner = await ownerWithPush(shop);
  const product = await shop.item({ pricePaise: 39900, stock: 5 });
  const placedAt = Date.now();
  const placed = await codOrder(world, shop, [line(product)]);
  const order = await shop.order(placed.orderNumber);
  const push = await world.waitFor(async () => (await world.pushes(owner.token))[0], 30_000, 200);
  assert.ok(push, 'No push within 30 s of a cash on delivery order');
  assert.ok(push.at - placedAt <= 30_000, `The push came ${((push.at - placedAt) / 1000).toFixed(1)} s after the order`);
  assert.match(push.title, /cash on delivery/i, `The push says "${push.title}"`);
  assert.equal(String(push.data.tenantId), String(shop.tenantId));
  assert.equal(push.data.link, `/orders/${order.id}`, 'The push does not open that order');
  // The tap: the app opens the path with its own session, and it is that order.
  const opened = await owner.s.send('GET', push.data.link);
  assert.equal(opened.status, 200);
  assert.equal(opened.data.orderNumber, order.order_number);
  const [row] = await deliveries(shop, `e.kind = 'order.cod_to_confirm' AND d.channel = 'push'`);
  assert.equal(row?.status, 'sent');
});

test('P-21: five orders within 40 s collapse into one push: "5 new orders"', async () => {
  const shop = await addP4Shop(world);
  const owner = await ownerWithPush(shop);
  const product = await shop.item({ pricePaise: 19900, stock: 50 });
  const started = Date.now();
  for (let i = 0; i < 5; i++) await buyer(world, shop).buy({ lines: [line(product)] });
  assert.ok(Date.now() - started < 40_000, 'Placing five orders took longer than 40 s');
  await world.waitFor(() => false, 1500);
  assert.equal((await world.pushes(owner.token)).length, 0, 'A new-order push went before the collapse hold');
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, NOTIFY_TABLES);
  await world.waitFor(async () => (await world.pushes(owner.token)).length >= 1, 12_000);
  await world.waitFor(() => false, 1500);
  const pushes = await world.pushes(owner.token);
  assert.equal(pushes.length, 1, `${pushes.length} pushes for five orders`);
  assert.equal(pushes[0].title, '5 new orders');
  assert.equal(Number(pushes[0].data.count), 5);
  assert.equal(pushes[0].data.link, '/orders', 'A push for five orders opens the list');
  assert.ok(pushes[0].collapseKey, 'The push has no collapse key');
  const rows = await deliveries(shop, `e.kind = 'order.new' AND d.channel = 'push'`);
  assert.equal(rows.filter((r) => r.status === 'sent').length, 1);
  assert.equal(rows.filter((r) => r.status === 'collapsed').length, 4);
  assert.equal(rows.find((r) => r.status === 'sent').group_count, 5);
});

test('P-21: a sixth order inside 60 s re-sends under the same collapse key; one after 60 s starts a new group', async () => {
  const shop = await addSeller(world);
  const owner = await ownerWithPush(shop);
  const notify = world.notify();
  const base = 900_000 + Number(unique().replace(/\D/g, '').slice(0, 5));
  for (let i = 0; i < 5; i++) await notify.emit({ event: 'order.new', tenantId: shop.tenantId, key: `order:${base + i}`, data: { orderId: base + i, orderNumber: `SP-${base + i}` } });
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, NOTIFY_TABLES);
  await world.waitFor(async () => (await world.pushes(owner.token)).length >= 1, 12_000);
  const [first] = await world.pushes(owner.token);
  assert.equal(first?.title, '5 new orders');
  // Inside 60 s of the group's first event.
  await notify.emit({ event: 'order.new', tenantId: shop.tenantId, key: `order:${base + 5}`, data: { orderId: base + 5, orderNumber: `SP-${base + 5}` } });
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, ['notification_deliveries']);
  await world.waitFor(async () => (await world.pushes(owner.token)).length >= 2, 12_000);
  const again = (await world.pushes(owner.token))[1];
  assert.ok(again, 'The sixth order inside the window sent nothing');
  assert.equal(again.collapseKey, first.collapseKey, 'The second send would show as a second notification');
  assert.equal(again.title, '6 new orders');
  // Past 60 s of the group's first event: a new group.
  await world.shift(NOTIFY_RULES.collapseMs + SECOND, NOTIFY_TABLES);
  await notify.emit({ event: 'order.new', tenantId: shop.tenantId, key: `order:${base + 6}`, data: { orderId: base + 6, orderNumber: `SP-${base + 6}` } });
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, ['notification_deliveries']);
  await world.waitFor(async () => (await world.pushes(owner.token)).length >= 3, 12_000);
  const later = (await world.pushes(owner.token))[2];
  assert.ok(later, 'An order after the window sent nothing');
  assert.notEqual(later.collapseKey, first.collapseKey, 'An order after 60 s joined the old group');
  assert.equal(later.title, 'New order');
});

test('P-21: critical kinds never wait and never collapse', async () => {
  const shop = await addSeller(world);
  const owner = await ownerWithPush(shop);
  const notify = world.notify();
  for (let i = 0; i < 3; i++) await notify.emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-crit-${unique()}`, data: { account: 'Instagram' } });
  const pushes = await world.waitFor(async () => {
    const list = await world.pushes(owner.token);
    return list.length >= 3 ? list : null;
  }, 15_000);
  assert.ok(pushes, `Three critical alerts made ${(await world.pushes(owner.token)).length} pushes without waiting`);
  assert.equal(new Set(pushes.map((p) => p.collapseKey ?? `none-${p.seq}`)).size, 3, 'Critical pushes collapsed into one');
});

test('P-22: a new-order push holds no name, phone, address or amount, on FCM and APNs', async () => {
  const shop = await addP4Shop(world, { name: 'Jasmine Jars' });
  const android = await ownerWithPush(shop, 'android');
  const iosOwner = await ownerApp(world, shop, { device: newDevice('iPhone 16', 'ios') });
  const iosToken = await registerPush(iosOwner, { platform: 'ios', token: iosPushToken() });
  const product = await shop.item({ name: 'Rose attar 12 ml', pricePaise: 123400 });
  const phone = newPhone();
  const shopper = address({ name: 'Zoravar Quintessa', phone, line1: '77 Peculiar Lane', city: 'Nashik', pincode: '422001' });
  const email = `zoravar${unique()}@mail.example`;
  await buyer(world, shop).buy({ lines: [line(product)], address: shopper, email });
  await world.shift(NOTIFY_RULES.collapseHoldMs + SECOND, NOTIFY_TABLES);
  await world.waitFor(async () => (await world.pushes(android.token)).length >= 1 && (await world.pushes(iosToken)).length >= 1, 12_000);
  const pushes = [...await world.pushes(android.token), ...await world.pushes(iosToken)];
  assert.ok(pushes.some((p) => p.wire === 'fcm') && pushes.some((p) => p.wire === 'apns'), `The push went on ${[...new Set(pushes.map((p) => p.wire))]}`);
  for (const p of pushes) {
    const text = pushText(p);
    for (const secret of ['Zoravar', 'Quintessa', phone.slice(-10), phone.slice(-5), '77 Peculiar', 'Peculiar Lane', 'Nashik', '422001', email, 'Rose attar', '1234', '₹']) {
      assert.ok(!text.includes(secret), `A ${p.wire} push holds "${secret}": ${text.slice(0, 300)}`);
    }
    assert.equal(pushProblem({ title: p.title, body: p.body, data: p.data }), null, `${p.wire}: ${pushProblem({ title: p.title, body: p.body, data: p.data })}`);
    for (const key of Object.keys(p.data ?? {})) assert.ok(PUSH_DATA_KEYS.includes(key), `A push carries "${key}"`);
    assert.equal(String(p.data.tenantId), String(shop.tenantId));
    assert.match(p.data.link, /^\/orders(\/\d+)?$/);
    assert.ok(p.ttl > 0 && p.ttl <= NOTIFY_RULES.pushTtlSeconds, `${p.wire} ttl is ${p.ttl}`);
  }
});

test('P-23: a token APNs calls Unregistered is deleted, and gets nothing more', async () => {
  const shop = await addSeller(world);
  const owner = await ownerWithPush(shop, 'ios');
  const other = await ownerWithPush(shop, 'android');
  await world.push.post('/tokens', { token: owner.token, state: 'unregistered' });
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-p23-${unique()}`, data: { account: 'Instagram' } });
  const gone = await world.waitFor(async () => (await world.sql('SELECT * FROM push_devices WHERE device_id = $1', [owner.s.device.id]))[0]?.deleted_at, 15_000);
  assert.ok(gone, 'The token APNs called Unregistered was not deleted');
  const [row] = await world.sql('SELECT * FROM push_devices WHERE device_id = $1', [owner.s.device.id]);
  assert.equal(row.delete_reason, 'unregistered');
  assert.equal(row.token_enc, null, 'The deleted token is still kept');
  const [otherRow] = await world.sql('SELECT * FROM push_devices WHERE device_id = $1', [other.s.device.id]);
  assert.equal(otherRow.deleted_at, null, 'Another device\'s token was deleted too');
  assert.ok((await world.pushes(other.token)).length >= 1, 'The other device got nothing');
  // The next push does not try the deleted token.
  const tried = (await world.pushes(owner.token)).length;
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-p23b-${unique()}`, data: { account: 'Instagram' } });
  await world.waitFor(async () => (await world.pushes(other.token)).length >= 2, 12_000);
  assert.equal((await world.pushes(owner.token)).length, tried, 'A deleted token was pushed to again');
});

test('P-23: FCM calling a token invalid deletes it; throttling, a 500, a hang and junk keep it and try again', async () => {
  const shop = await addSeller(world);
  const owner = await ownerWithPush(shop, 'android');
  await world.push.post('/tokens', { token: owner.token, state: 'invalid' });
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-p23c-${unique()}`, data: { account: 'Instagram' } });
  await world.waitFor(async () => (await world.sql('SELECT deleted_at FROM push_devices WHERE device_id = $1', [owner.s.device.id]))[0]?.deleted_at, 15_000);
  assert.equal((await world.sql('SELECT delete_reason FROM push_devices WHERE device_id = $1', [owner.s.device.id]))[0]?.delete_reason, 'invalid_token');

  for (const kind of ['throttle', 'error', 'hang', 'junk']) {
    const s = await ownerApp(world, shop, { device: newDevice(`Phone ${kind}`) });
    const token = await registerPush(s, { token: androidPushToken() });
    await world.push.post('/behaviour', { kind, wire: 'fcm', token, times: 1, ...(kind === 'throttle' ? { retryAfter: 1 } : {}) });
    const key = `spec-${kind}-${unique()}`;
    await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } });
    const row = async () => (await deliveries(shop, `e.event_key = $2 AND d.channel = 'push' AND d.user_id = $3`, [key, s.user.id]))[0];
    await world.waitFor(async () => (await row())?.attempt >= 1 && (await row())?.status !== 'sent', 15_000);
    await world.shift(NOTIFY_RULES.backoffMs[0] + SECOND, ['notification_deliveries']);
    await world.waitFor(async () => (await row())?.status === 'sent', 15_000);
    assert.equal((await row())?.status, 'sent', `After one ${kind} the push was not sent on the next try`);
    const [device] = await world.sql('SELECT deleted_at FROM push_devices WHERE device_id = $1', [s.device.id]);
    assert.equal(device.deleted_at, null, `A ${kind} deleted the token`);
  }
});

test('P-23: when Bhava\'s own push credentials are refused, no seller\'s device token is deleted', async () => {
  const shop = await addSeller(world);
  const owner = await ownerWithPush(shop, 'android');
  await world.push.post('/credentials/rotate', {});
  const key = `spec-rotated-${unique()}`;
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key, data: { account: 'Instagram' } });
  await world.waitFor(async () => (await deliveries(shop, `e.event_key = $2 AND d.channel = 'push'`, [key]))[0]?.attempt >= 1, 15_000);
  const [device] = await world.sql('SELECT deleted_at FROM push_devices WHERE device_id = $1', [owner.s.device.id]);
  assert.equal(device.deleted_at, null, 'Bhava\'s own credentials being refused deleted a seller\'s device token');
});

test('P-23: push tokens are kept encrypted, one device moves with its token, and junk is refused', async () => {
  const shop = await addSeller(world);
  const s = await ownerApp(world, shop);
  const token = await registerPush(s);
  const rows = await world.sql('SELECT * FROM push_devices WHERE device_id = $1', [s.device.id]);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token), 'The push token is stored as it came');
  for (const body of [{ deviceId: s.device.id, platform: 'web', token }, { deviceId: 'short', platform: 'android', token }, { deviceId: s.device.id, platform: 'android', token: 'x' }, { deviceId: s.device.id, platform: 'android', token: `${token} OR 1=1` }]) {
    assert.equal((await s.send('POST', '/push/devices', body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  // The same token signed in by someone else now belongs to them: the first person hears nothing more on it.
  const other = await appSignIn(world, newSellerPhone(), { device: s.device }).catch(() => null);
  if (other?.user) {
    await registerPush(other, { token });
    const owners = await world.sql('SELECT person_id FROM push_devices WHERE deleted_at IS NULL AND token_hash = (SELECT token_hash FROM push_devices WHERE device_id = $1 ORDER BY id DESC LIMIT 1)', [s.device.id]);
    assert.ok(owners.length <= 1, 'One token is registered to two people');
  }
  // Signing out of the app: this device gets no more pushes.
  assert.equal((await s.send('DELETE', `/push/devices/${s.device.id}`)).status, 204);
  await world.notify().emit({ event: 'token.invalid', tenantId: shop.tenantId, key: `spec-out-${unique()}`, data: { account: 'Instagram' } });
  await world.waitFor(() => false, 2000);
  assert.equal((await world.pushes(token)).length, 0, 'A signed-out device got a push');
});

test('P-13: a push for one business carries that business\'s id, and one device hears from every business of its person', async () => {
  const a = await addSeller(world, { name: 'Orchid Oils' });
  const b = await addSeller(world, { name: 'Pine Pottery' });
  const phone = newSellerPhone();
  await addMember(a, { phone, role: 'manager' });
  await addMember(b, { phone, role: 'manager' });
  const s = await appSignIn(world, phone, { tenantId: a.tenantId });
  const token = await registerPush(s);
  const notify = world.notify();
  await notify.emit({ event: 'order.cod_to_confirm', tenantId: b.tenantId, key: `order:${unique().replace(/\D/g, '')}`, data: { orderId: 4242, orderNumber: 'PP-4242' } });
  const push = await world.waitFor(async () => (await world.pushes(token))[0], 15_000);
  assert.ok(push, 'The person signed in to A heard nothing about B');
  assert.equal(String(push.data.tenantId), String(b.tenantId), 'The push does not name the business it is about');
  assert.equal(push.data.link, '/orders/4242');
  assert.doesNotMatch(pushText(push), /Orchid Oils/, 'A push about B names A');
});
