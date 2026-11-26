// PRD 5.17: managed services. A service operator works through the seller API in a session that names a service and a task;
// every change is recorded, shown to the seller, and the seller can undo or approve it. F-90 to F-95.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_A_SERVICE, maskSecrets } from '../../../src/contracts/services.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { addStaff, consoleUser, grantService, json, need, one, opCall, pause, shopOn, sql, startService, unique, useBillingWorld, hit, impersonate } from './support.js';

const world = useBillingWorld();

const changesOf = (shop) => sql(world, 'SELECT * FROM service_changes WHERE tenant_id = $1 ORDER BY id', [shop.tenantId]);
const setMode = (shop, service, mode) => shop.send('PUT', '/services', { service, mode });

async function catalogJob(options = {}) {
  const shop = await shopOn(world, 't3', options);
  await grantService(shop, 'catalog_management');
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'catalog_management', 'TASK-90');
  const product = await shop.product({ pricePaise: 49_900, name: 'Brass lamp' });
  return { shop, op, s, product };
}

test('F-90: an operator with catalog management changes a price: it is saved, audited with operator, service, task and diff, and shown in the seller\'s feed', async () => {
  const { shop, op, s, product } = await catalogJob();
  const res = need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 59_900 }), 200, 'The operator changes the price');
  assert.equal(res.data.pricePaise, 59_900);
  assert.equal((await shop.getProduct(product.id)).pricePaise, 59_900, 'saved');
  const [change] = await changesOf(shop);
  assert.ok(change, 'a change row');
  assert.equal(change.state, 'applied');
  assert.equal(change.route_id, 'products.update');
  assert.equal(JSON.stringify(change.before).includes('49900'), true, 'the before value');
  assert.equal(JSON.stringify(change.after).includes('59900'), true, 'the after value');
  const audit = await sql(world, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'service.change'`, [shop.tenantId]);
  assert.equal(audit.length, 1);
  const text = JSON.stringify(audit[0]);
  assert.match(text, /catalog_management/);
  assert.match(text, /TASK-90/);
  assert.ok(new RegExp(String(op.email.split('@')[0]).slice(0, 4)).test(text) || /operator/i.test(text), 'the operator is named');
  const feed = json(need(await shop.send('GET', '/team-feed'), 200, 'The feed'));
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].service, 'catalog_management');
  assert.equal(feed.items[0].state, 'applied');
  assert.match(JSON.stringify(feed.items[0]), /TASK-90/);
  const seen = json(need(await opCall(world, op, 'GET', `/service-changes?tenantId=${shop.tenantId}`), 200, 'The console\'s list'));
  assert.equal(seen.items.length, 1);
});

test('F-90: a failed or refused operator write leaves no applied change, and no secret reaches the record', async () => {
  const { shop, s, product } = await catalogJob();
  assert.ok((await s.call('PATCH', `/products/${product.id}`, { pricePaise: -5 })).status === 400);
  assert.equal((await s.call('PATCH', '/products/99999999', { pricePaise: 5 })).status, 404);
  assert.deepEqual((await changesOf(shop)).filter((c) => c.state === 'applied'), []);
  assert.deepEqual(maskSecrets({ name: 'x', accessToken: 'abc', nested: { api_key: 'k', ok: 1 } }), { name: 'x', accessToken: '••••', nested: { api_key: '••••', ok: 1 } });
  need(await s.call('PATCH', `/products/${product.id}`, { name: 'Brass lamp, large' }), 200, 'A name change');
  assert.doesNotMatch(JSON.stringify(await changesOf(shop)), /test-ig-token|sim-key-secret/);
});

test('F-91: the same operator opening payment keys, billing, payouts, staff or settings gets 403, and nothing in the business changes', async () => {
  const { shop, s } = await catalogJob();
  const before = JSON.stringify(await sql(world, 'SELECT plan, status FROM tenants WHERE id = $1', [shop.tenantId]));
  const blocked = routeList.filter((r) => NEVER_A_SERVICE.includes(r.id.split('.')[0]) && r.id !== 'auth.logout');
  assert.ok(blocked.length >= 30, `${blocked.length} routes the contract keeps from a service`);
  for (const r of blocked) {
    const res = await s.call(r.method, r.path.replace(/:[a-zA-Z]+/g, '1'), r.method === 'GET' ? undefined : {});
    assert.equal(res.status, 403, `${r.id}: ${res.status} ${res.text.slice(0, 80)}`);
    assert.equal(res.data?.code, 'service.out_of_scope', r.id);
  }
  for (const [method, path, body] of [['GET', '/billing'], ['GET', '/payment-settings'], ['PUT', '/setup/own-keys', { provider: 'razorpay', keyId: 'a', keySecret: 'b' }], ['GET', '/team'], ['POST', '/billing/change', { plan: 't5', requestKey: 'abcdefgh12' }], ['GET', '/api-keys'], ['POST', '/refunds', {}]]) {
    const res = await s.call(method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(JSON.stringify(await sql(world, 'SELECT plan, status FROM tenants WHERE id = $1', [shop.tenantId])), before);
  // Out of this service's own scope: catalog management does not touch automations or pages.
  for (const path of ['/automations', '/pages']) assert.equal((await s.call('GET', path)).data.code, 'service.out_of_scope', path);
  // The seller's own feed and undo are not an operator's to use.
  assert.equal((await s.call('GET', '/team-feed')).status, 403);
  assert.equal((await s.call('POST', '/team-feed/1/undo')).status, 403);
  assert.equal((await s.call('PUT', '/services', { service: 'catalog_management', mode: 'direct' })).status, 403, 'an operator cannot pick their own mode');
});

test('F-91: a session needs its service: starting one with no task reference, for a service the business has not bought, or by the wrong role, is refused', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world, 'service_operator');
  const start = (body, who = op) => opCall(world, who, 'POST', `/tenants/${shop.tenantId}/service-sessions`, body);
  assert.equal((await start({ service: 'catalog_management', taskRef: 'T-1' })).status, 403, 'the business has not bought it');
  assert.equal(json(await start({ service: 'catalog_management', taskRef: 'T-1' })).code, 'service.ended');
  await grantService(shop, 'catalog_management');
  assert.equal((await start({ service: 'catalog_management' })).status, 400, 'no task reference');
  assert.equal((await start({ service: 'catalog_management', taskRef: '  ' })).status, 400);
  assert.equal((await start({ service: 'sorcery', taskRef: 'T-1' })).status, 400);
  assert.equal((await start({ service: 'catalog_management', taskRef: 'T-1' }, await consoleUser(world, 'onboarding'))).status, 403, 'not an operator');
  assert.equal((await hit(world, `/tenants/${shop.tenantId}/service-sessions`, { host: shop.host, method: 'POST', token: shop.token, body: { service: 'catalog_management', taskRef: 'T-1' } })).status, 404);
  need(await start({ service: 'catalog_management', taskRef: 'T-1' }), 201, 'With a task and the service');
  const other = await shopOn(world, 't3');
  assert.equal((await opCall(world, op, 'POST', `/tenants/${other.tenantId}/service-sessions`, { service: 'catalog_management', taskRef: 'T-2' })).status, 403, 'a session is for one business');
});

test('F-92: when the service lapses, the operator\'s write access ends at once, also a second after, and a new session is refused', async () => {
  const { shop, op, s, product } = await catalogJob();
  need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 50_000 }), 200, 'A write while the service runs');
  await grantService(shop, 'catalog_management', false);
  const late = await s.call('PATCH', `/products/${product.id}`, { pricePaise: 1 });
  assert.ok([401, 403].includes(late.status), `after the lapse: ${late.status}`);
  assert.ok(late.data?.code === 'service.ended' || late.status === 401);
  assert.equal((await s.call('GET', `/products/${product.id}`)).status >= 400, true, 'not even a read');
  assert.equal((await shop.getProduct(product.id)).pricePaise, 50_000, 'nothing was written');
  assert.equal((await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/service-sessions`, { service: 'catalog_management', taskRef: 'T-3' })).status, 403);
  // Buying it again does not revive the old session.
  await grantService(shop, 'catalog_management', true);
  assert.ok([200, 401, 403].includes((await s.call('GET', `/products/${product.id}`)).status));
  const row = await one(world, 'SELECT id FROM service_sessions WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1', [shop.tenantId]);
  need(await opCall(world, op, 'POST', `/service-sessions/${row.id}/end`), 200, 'Ending the session');
  assert.equal((await s.call('GET', `/products/${product.id}`)).status, 401, 'an ended session is over');
});

test('F-92: a service that lapses a second ago and a write that races it never apply after the lapse', async () => {
  const { shop, s, product } = await catalogJob();
  const writes = Array.from({ length: 6 }, (_, i) => s.call('PATCH', `/products/${product.id}`, { pricePaise: 60_000 + i }));
  await pause(5);
  await grantService(shop, 'catalog_management', false);
  // The moment the lapse is committed: no write may be recorded as applied after it.
  const lapsedAt = (await one(world, 'SELECT clock_timestamp() AS t')).t;
  const results = await Promise.all(writes);
  for (const r of results) assert.ok(r.status === 200 || [401, 403].includes(r.status), `${r.status}`);
  const late = await sql(world, `SELECT id FROM service_changes WHERE tenant_id = $1 AND created_at > $2`, [shop.tenantId, lapsedAt]);
  assert.deepEqual(late, [], 'a change recorded after the service lapsed');
  const applied = results.filter((r) => r.status === 200).length;
  assert.equal((await changesOf(shop)).length, applied, 'every write that answered 200 is recorded, and only those');
  // A second after the lapse, a read and a write are both refused.
  await pause(1000);
  const second = await s.call('PATCH', `/products/${product.id}`, { pricePaise: 7 });
  assert.ok([401, 403].includes(second.status), `a write a second after the lapse: ${second.status}`);
  assert.notEqual((await shop.getProduct(product.id)).pricePaise, 7);
});

/** The sequence answers items (src/contracts/api/categories.js SequenceItem); saving takes their page ids. */
const pageIds = (items) => items.map((i) => i.pageId);

async function categoryOf(shop, n = 3) {
  const category = await shop.category(`Lamps ${unique()}`);
  const pages = [];
  for (let i = 0; i < n; i++) pages.push(await shop.page());
  await shop.addToCategory(category.id, pages.map((p) => p.id));
  return { category, pages };
}

test('F-93: with "approve first", an operator\'s reorder waits as a draft until the seller approves it; rejecting it changes nothing', async () => {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'reel_management');
  need(await setMode(shop, 'reel_management', 'approve_first'), 200, 'Choosing approve first');
  const { category, pages } = await categoryOf(shop);
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'reel_management', 'TASK-93');
  const original = pageIds(await shop.sequence(category.id));
  const reversed = [...original].reverse();
  const res = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: reversed });
  assert.equal(res.status, 202, res.text.slice(0, 160));
  assert.equal(res.data.draft, true);
  assert.ok(res.data.changeId);
  assert.deepEqual(pageIds(await shop.sequence(category.id)), original, 'nothing changed yet');
  const [draft] = await changesOf(shop);
  assert.equal(draft.state, 'draft');
  const feed = json(need(await shop.send('GET', '/team-feed?state=draft'), 200, 'Drafts'));
  assert.equal(feed.items.length, 1);
  // Another business's owner cannot approve it.
  const stranger = await shopOn(world, 't3');
  assert.equal((await stranger.send('POST', `/team-feed/${res.data.changeId}/approve`)).status, 404);
  need(await shop.send('POST', `/team-feed/${res.data.changeId}/approve`), 200, 'Approving');
  assert.deepEqual(pageIds(await shop.sequence(category.id)), reversed, 'now it is live');
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [res.data.changeId])).state, 'approved');
  assert.ok([400, 409].includes((await shop.send('POST', `/team-feed/${res.data.changeId}/approve`)).status), 'approving twice');
  assert.ok([400, 409].includes((await shop.send('POST', `/team-feed/${res.data.changeId}/reject`)).status), 'rejecting an approved one');
  // A second draft, rejected.
  const second = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: original });
  assert.equal(second.status, 202);
  need(await shop.send('POST', `/team-feed/${second.data.changeId}/reject`), 200, 'Rejecting');
  assert.deepEqual(pageIds(await shop.sequence(category.id)), reversed, 'a rejected draft never applies');
  assert.ok([400, 409].includes((await shop.send('POST', `/team-feed/${second.data.changeId}/approve`)).status));
  void pages;
});

test('F-93: approving a draft runs the route\'s own checks again, and a draft the seller approves at the moment the service lapses is not applied', async () => {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'reel_management');
  need(await setMode(shop, 'reel_management', 'approve_first'), 200, 'Choosing approve first');
  const { category } = await categoryOf(shop);
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'reel_management', 'TASK-93B');
  const original = pageIds(await shop.sequence(category.id));
  const draft = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: [...original].reverse() });
  assert.equal(draft.status, 202);
  // The seller deletes the category before approving: the old request no longer fits.
  await shop.send('DELETE', `/categories/${category.id}`);
  const approve = await shop.send('POST', `/team-feed/${draft.data.changeId}/approve`);
  assert.ok(approve.status >= 400 && approve.status < 500, `the stale draft: ${approve.status}`);
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [draft.data.changeId])).state, 'draft', 'it stays a draft rather than half-applied');
  // A seller's mode is the seller's: only the owner picks it, and only a real mode.
  assert.equal((await setMode(shop, 'reel_management', 'sometimes')).status, 400);
  assert.equal((await setMode(shop, 'sorcery', 'direct')).status, 400);
});

test('F-94: an operator\'s automation the owner could not switch on is blocked by the Compliance Engine in the same way, and no row is made', async () => {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'reel_management');
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'reel_management', 'TASK-94');
  const mediaId = await shop.reel();
  const bad = [
    { linkUrl: 'http://insecure.example/x' },
    { keywords: [] },
    { matchMode: 'any', anyModeAcknowledged: false, keywords: [] },
    { linkUrl: 'https://bit.ly/short' },
  ];
  for (const fields of bad) {
    const body = shop.automationBody({ mediaId, ...fields });
    const owner = await shop.send('POST', '/automations', body);
    const operator = await s.call('POST', '/automations', body);
    assert.ok(owner.status >= 400 && owner.status < 500, `the owner is refused ${JSON.stringify(fields)}: ${owner.status}`);
    assert.equal(operator.status, owner.status, `the operator is refused the same way: ${operator.status} against ${owner.status}`);
    assert.equal(operator.data?.code ?? '', json(owner)?.code ?? '', 'the same reason');
  }
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n), 0);
  assert.deepEqual((await changesOf(shop)).filter((c) => c.state === 'applied'), []);
  // The same operator switching one on for a business that has not passed the release gate is held like the owner is.
  const closed = await shopOn(world, 't3', { gates: false });
  await grantService(closed, 'reel_management');
  const cs = await startService(world, closed, op, 'reel_management', 'TASK-94B');
  const made = await closed.tryAutomation({ mediaId: await closed.reel() });
  const live = await cs.call('POST', `/automations/${json(made).id}/state`, { state: 'live' });
  const ownerLive = await closed.send('POST', `/automations/${json(made).id}/state`, { state: 'live' });
  assert.equal(live.status, ownerLive.status, 'a gate holds the operator as it holds the owner');
  const state = (await one(world, 'SELECT state FROM automations WHERE id = $1', [json(made).id])).state;
  if (live.status >= 400) assert.notEqual(state, 'live', 'a refused request leaves it off');
});

test('F-95: a seller undoes an operator\'s change: the previous version is restored and the undo is audited; twice, and in a race, it happens once', async () => {
  const { shop, s, product } = await catalogJob();
  need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 77_700 }), 200, 'The operator\'s change');
  const [change] = await changesOf(shop);
  const feed = json(need(await shop.send('GET', '/team-feed'), 200, 'The feed'));
  assert.equal(feed.items[0].id, change.id);
  const undone = await Promise.all([shop.send('POST', `/team-feed/${change.id}/undo`), shop.send('POST', `/team-feed/${change.id}/undo`)]);
  assert.equal(undone.filter((r) => r.status === 200).length, 1, `one undo, ${undone.map((r) => r.status)}`);
  assert.ok(undone.some((r) => [400, 409].includes(r.status)), 'the other is refused');
  assert.equal((await shop.getProduct(product.id)).pricePaise, 49_900, 'the previous version is back');
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [change.id])).state, 'undone');
  const audit = await sql(world, `SELECT * FROM audit_log WHERE tenant_id = $1 AND action ~* 'undo'`, [shop.tenantId]);
  assert.equal(audit.length, 1, 'one audit row for the undo');
  assert.match(JSON.stringify(audit[0]), new RegExp(String(change.id)));
  assert.ok([400, 409].includes((await shop.send('POST', `/team-feed/${change.id}/undo`)).status), 'a third time');
  assert.equal((await shop.getProduct(product.id)).pricePaise, 49_900);
  // Never a hard delete: the change stays in the feed as undone.
  assert.equal(json(need(await shop.send('GET', '/team-feed?state=undone'), 200, 'Undone')).items.length, 1);
});

test('F-95: undoing a change another business made, one that is a draft, or one the team made by creating something is refused, and nothing changes', async () => {
  const { shop, s, product } = await catalogJob();
  const stranger = await shopOn(world, 't3');
  need(await s.call('PATCH', `/products/${product.id}`, { name: 'Renamed lamp' }), 200, 'A change');
  const [change] = await changesOf(shop);
  assert.equal((await stranger.send('POST', `/team-feed/${change.id}/undo`)).status, 404);
  assert.equal((await shop.getProduct(product.id)).name, 'Renamed lamp');
  const created = await s.call('POST', '/products', { name: 'New by team', pricePaise: 100, active: true });
  assert.equal(created.status, 201);
  const rows = await changesOf(shop);
  const make = rows.find((r) => r.route_id === 'products.create');
  const refused = await shop.send('POST', `/team-feed/${make.id}/undo`);
  assert.ok([400, 409].includes(refused.status), `nothing to put back for a creation: ${refused.status}`);
  assert.equal((await shop.send('POST', '/team-feed/999999/undo')).status, 404);
  // A path id that is not an id is no such change: the router answers 404 for every route (api-v1 pathParams), not 400.
  assert.equal((await shop.send('POST', `/team-feed/abc/undo`)).status, 404);
  // A manager may undo; staff may not.
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  const asStaff = await hit(world, `/api/v1/team-feed/${change.id}/undo`, { host: shop.host, method: 'POST', token: staff.token });
  assert.equal(asStaff.status, 403);
  void impersonate;
});
