// PRD 5.17, managed services, against the real app: an operator's session needs a task and a service the business has
// today, reaches only that service's routes, records every write with before and after (secrets masked) in the seller's
// "Done by Bhava team" feed, waits as a draft under approve-first, and can be undone once by the seller. F-90 to F-95.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEVER_A_SERVICE } from '../../../src/contracts/services.js';
import { routeList } from '../../../src/contracts/api/index.js';
import { addStaff, consoleUser, grantService, hit, json, need, one, opCall, shopOn, sql, startService, unique, useBillingWorld } from '../spec-p7/support.js';

const world = useBillingWorld();
/** The category's reels as page ids, in order (shop.sequence answers the items themselves). */
const orderOf = async (shop, categoryId) => (await shop.sequence(categoryId)).map((i) => i.pageId);
const changesOf = (shop) => sql(world, 'SELECT * FROM service_changes WHERE tenant_id = $1 ORDER BY id', [shop.tenantId]);

async function catalogJob(task = 'TASK-1') {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'catalog_management');
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'catalog_management', task);
  const product = await shop.product({ pricePaise: 49_900, name: 'Brass lamp' });
  return { shop, op, s, product };
}

test('F-90, F-95: a price change is recorded with operator, service, task, before and after; the seller undoes it once, audited, and it cannot be replayed', async () => {
  const { shop, op, s, product } = await catalogJob('TASK-90');
  assert.equal(s.me.status, 200, 'the session opened');
  need(await s.call('PATCH', `/products/${product.id}`, { pricePaise: 59_900 }), 200, 'The operator\'s change');
  const [change] = await changesOf(shop);
  assert.deepEqual([change.state, change.route_id, change.task_ref, change.service], ['applied', 'products.update', 'TASK-90', 'catalog_management']);
  assert.equal(change.before.pricePaise, 49_900);
  assert.equal(change.after.pricePaise, 59_900);
  const feed = json(need(await shop.send('GET', '/team-feed'), 200, 'The feed'));
  assert.deepEqual([feed.items.length, feed.items[0].id, feed.items[0].canUndo, feed.items[0].taskRef], [1, Number(change.id), true, 'TASK-90']);
  const console = json(need(await opCall(world, op, 'GET', `/service-changes?tenantId=${shop.tenantId}`), 200, 'The console list'));
  assert.equal(console.items[0].operatorName.length > 0, true);
  // Two undos at once: one wins.
  const raced = await Promise.all([shop.send('POST', `/team-feed/${change.id}/undo`), shop.send('POST', `/team-feed/${change.id}/undo`)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await shop.getProduct(product.id)).pricePaise, 49_900);
  assert.equal((await one(world, 'SELECT state, undone_by FROM service_changes WHERE id = $1', [change.id])).state, 'undone');
  const undoAudit = await sql(world, `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'service.undo'`, [shop.tenantId]);
  assert.equal(undoAudit.length, 1);
  assert.equal(undoAudit[0].details.changeId, Number(change.id));
  // A third try, and another business's owner on this change, change nothing.
  assert.equal((await shop.send('POST', `/team-feed/${change.id}/undo`)).status, 409);
  const stranger = await shopOn(world, 't3');
  assert.equal((await stranger.send('POST', `/team-feed/${change.id}/undo`)).status, 404);
  assert.equal((await stranger.send('GET', '/team-feed')).status, 200);
  assert.equal(json(await stranger.send('GET', '/team-feed')).items.length, 0, 'another business sees none of it');
  // Something the team created has nothing to put back.
  const created = need(await s.call('POST', '/products', { name: `Made by team ${unique()}`, pricePaise: 100, active: true }), 201, 'A creation');
  void created;
  const make = (await changesOf(shop)).find((c) => c.route_id === 'products.create');
  assert.equal((await shop.send('POST', `/team-feed/${make.id}/undo`)).status, 409);
  // Staff may not undo.
  const staff = await addStaff(world, shop, { permissions: ['catalog'] });
  assert.equal((await hit(world, `/api/v1/team-feed/${change.id}/undo`, { host: shop.host, method: 'POST', token: staff.token })).status, 403);
});

test('F-91: no service reaches keys, payouts, refunds, billing, staff, roles or settings, nor its own feed and mode; other services\' routes are out of scope', async () => {
  const { shop, s } = await catalogJob('TASK-91');
  const blocked = routeList.filter((r) => NEVER_A_SERVICE.includes(r.id.split('.')[0]) && !['auth.logout', 'auth.me'].includes(r.id));
  // auth.me and auth.logout are the two the contract leaves open (operatorRefusal): the console must know who it is and be able to leave.
  for (const r of blocked) {
    const res = await s.call(r.method, r.path.replace(/:[a-zA-Z]+/g, '1'), r.method === 'GET' ? undefined : {});
    assert.equal(res.status, 403, `${r.id}: ${res.status}`);
  }
  for (const path of ['/automations', '/pages']) assert.equal((await s.call('GET', path)).data.code, 'service.out_of_scope', path);
  assert.equal((await s.call('PUT', '/services', { service: 'catalog_management', mode: 'direct' })).status, 403);
  assert.equal((await s.call('PUT', '/setup/own-keys', { provider: 'razorpay', keyId: 'a', keySecret: 'b' })).status, 403);
  assert.deepEqual((await changesOf(shop)).length, 0, 'nothing was recorded');
});

test('F-91, F-92: a session needs a task and a service bought today; the one-time address works once; a lapse ends access mid-session; buying again does not revive it', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world, 'service_operator');
  const start = (body, who = op) => opCall(world, who, 'POST', `/tenants/${shop.tenantId}/service-sessions`, body);
  const refused = await start({ service: 'catalog_management', taskRef: 'T-1' });
  assert.deepEqual([refused.status, json(refused).code], [403, 'service.ended']);
  await grantService(shop, 'catalog_management');
  assert.equal((await start({ service: 'catalog_management' })).status, 400);
  assert.equal((await start({ service: 'catalog_management', taskRef: '   ' })).status, 400);
  assert.equal((await start({ service: 'catalog_management', taskRef: 'x'.repeat(121) })).status, 400);
  assert.equal((await start({ service: 'catalog_management', taskRef: 'T-1' }, await consoleUser(world, 'onboarding'))).status, 403);
  const started = json(need(await start({ service: 'catalog_management', taskRef: 'T-1' }), 201, 'Starting'));
  assert.equal(started.session.taskRef, 'T-1');
  // The address opens one session, once.
  const url = new URL(started.url, `https://${shop.host}`);
  const first = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.ok(first.status < 400 && String(first.headers['set-cookie']).includes('sid='));
  const replay = await hit(world, `${url.pathname}${url.search}`, { host: shop.host });
  assert.equal(replay.status, 410);
  const elsewhere = await shopOn(world, 't3');
  assert.equal((await hit(world, `${url.pathname}${url.search}`, { host: elsewhere.host })).status, 410, 'not on another business\'s address');
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  const me = await hit(world, '/api/v1/auth/me', { host: shop.host, cookie });
  const csrf = json(me).csrf ?? '';
  const call = (method, path, body) => hit(world, `/api/v1${path}`, { host: shop.host, cookie, method, ...(body === undefined ? {} : { body }), headers: { 'x-csrf-token': csrf } });
  const product = await shop.product({ pricePaise: 10_000 });
  need(await call('PATCH', `/products/${product.id}`, { pricePaise: 20_000 }), 200, 'Working');
  await grantService(shop, 'catalog_management', false);
  const late = await call('PATCH', `/products/${product.id}`, { pricePaise: 1 });
  assert.ok([401, 403].includes(late.status), `after the lapse: ${late.status}`);
  assert.equal((await shop.getProduct(product.id)).pricePaise, 20_000);
  assert.equal((await start({ service: 'catalog_management', taskRef: 'T-2' })).status, 403);
  await grantService(shop, 'catalog_management', true);
  // The console syncs the new period when anyone looks; the old session stays dead.
  need(await start({ service: 'catalog_management', taskRef: 'T-3' }), 201, 'A new session in the new period');
  assert.equal((await call('GET', `/products/${product.id}`)).status, 401, 'the old session is not revived');
  // Ending a session ends it at once.
  const fresh = await startService(world, shop, op, 'catalog_management', 'T-4');
  need(await fresh.call('GET', `/products/${product.id}`), 200, 'Reading');
  need(await opCall(world, op, 'POST', `/service-sessions/${fresh.started.session.id}/end`), 200, 'Ending');
  assert.equal((await fresh.call('GET', `/products/${product.id}`)).status, 401);
  // Another operator cannot end someone else's session; a super admin can.
  const other = await startService(world, shop, op, 'catalog_management', 'T-5');
  assert.equal((await opCall(world, await consoleUser(world, 'service_operator'), 'POST', `/service-sessions/${other.started.session.id}/end`)).status, 403);
  need(await opCall(world, await consoleUser(world, 'super_admin'), 'POST', `/service-sessions/${other.started.session.id}/end`), 200, 'A super admin ends it');
});

async function reelJob(mode) {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'reel_management');
  if (mode) need(await shop.send('PUT', '/services', { service: 'reel_management', mode }), 200, `Choosing ${mode}`);
  const category = await shop.category(`Lamps ${unique()}`);
  const pages = [];
  for (let i = 0; i < 3; i++) pages.push(await shop.page());
  await shop.addToCategory(category.id, pages.map((p) => p.id));
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'reel_management', 'TASK-93');
  return { shop, category, s };
}

test('F-93: under approve-first the reorder is a draft until approved, applied then through the route; reject and double decisions change nothing', async () => {
  const { shop, category, s } = await reelJob('approve_first');
  const settings = json(need(await shop.send('GET', '/services'), 200, 'The settings'));
  assert.equal(settings.items.find((i) => i.service === 'reel_management').mode, 'approve_first');
  assert.equal((await shop.send('PUT', '/services', { service: 'merchandising', mode: 'direct' })).status, 403, 'a service not bought');
  const original = await orderOf(shop, category.id);
  const reversed = [...original].reverse();
  const draft = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: reversed });
  assert.equal(draft.status, 202, JSON.stringify(draft.data));
  assert.deepEqual(await orderOf(shop, category.id), original);
  const stranger = await shopOn(world, 't3');
  assert.equal((await stranger.send('POST', `/team-feed/${draft.data.changeId}/approve`)).status, 404);
  const approved = json(need(await shop.send('POST', `/team-feed/${draft.data.changeId}/approve`), 200, 'Approving'));
  assert.equal(approved.state, 'approved');
  assert.deepEqual(await orderOf(shop, category.id), reversed);
  assert.equal((await shop.send('POST', `/team-feed/${draft.data.changeId}/approve`)).status, 409);
  assert.equal((await shop.send('POST', `/team-feed/${draft.data.changeId}/reject`)).status, 409);
  // The approved change can be undone back to the order it replaced.
  need(await shop.send('POST', `/team-feed/${draft.data.changeId}/undo`), 200, 'Undoing the approved change');
  assert.deepEqual(await orderOf(shop, category.id), original);
  const second = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: reversed });
  need(await shop.send('POST', `/team-feed/${second.data.changeId}/reject`), 200, 'Rejecting');
  assert.deepEqual(await orderOf(shop, category.id), original);
  assert.equal((await shop.send('POST', `/team-feed/${second.data.changeId}/approve`)).status, 409);
  // A draft whose service lapsed before the seller approved it is not applied.
  const third = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: reversed });
  await grantService(shop, 'reel_management', false);
  const lapsed = await shop.send('POST', `/team-feed/${third.data.changeId}/approve`);
  assert.equal(lapsed.status, 403);
  assert.deepEqual(await orderOf(shop, category.id), original);
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [third.data.changeId])).state, 'draft');
});

test('F-93: a stale draft is refused when approved and stays a draft', async () => {
  const { shop, category, s } = await reelJob('approve_first');
  const original = await orderOf(shop, category.id);
  const draft = await s.call('PUT', `/categories/${category.id}/reels`, { pinned: [], order: [...original].reverse() });
  assert.equal(draft.status, 202);
  await shop.send('DELETE', `/categories/${category.id}`);
  const approve = await shop.send('POST', `/team-feed/${draft.data.changeId}/approve`);
  assert.ok(approve.status >= 400 && approve.status < 500, `${approve.status}`);
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [draft.data.changeId])).state, 'draft');
});

test('F-94: an operator\'s automation the owner could not make is refused the same way, and an approve-first draft passes compliance when applied', async () => {
  const shop = await shopOn(world, 't3');
  await grantService(shop, 'reel_management');
  const op = await consoleUser(world, 'service_operator');
  const s = await startService(world, shop, op, 'reel_management', 'TASK-94');
  const mediaId = await shop.reel();
  for (const fields of [{ linkUrl: 'http://insecure.example/x' }, { linkUrl: 'https://bit.ly/short' }, { keywords: [] }]) {
    const body = shop.automationBody({ mediaId, ...fields });
    const owner = await shop.send('POST', '/automations', body);
    const operator = await s.call('POST', '/automations', body);
    assert.ok(owner.status >= 400 && owner.status < 500);
    assert.equal(operator.status, owner.status, JSON.stringify(fields));
    assert.equal(operator.data?.code, json(owner)?.code);
  }
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n), 0);
  // The same bad request drafted under approve-first is checked when the seller approves it, and refused then.
  need(await shop.send('PUT', '/services', { service: 'reel_management', mode: 'approve_first' }), 200, 'Approve first');
  const later = await startService(world, shop, op, 'reel_management', 'TASK-94B');
  const drafted = await later.call('POST', '/automations', shop.automationBody({ mediaId, linkUrl: 'https://bit.ly/short' }));
  assert.equal(drafted.status, 202, 'drafted without being checked');
  const applied = await shop.send('POST', `/team-feed/${drafted.data.changeId}/approve`);
  assert.ok(applied.status >= 400 && applied.status < 500, `refused when applied: ${applied.status}`);
  assert.equal(Number((await one(world, 'SELECT count(*) AS n FROM automations WHERE tenant_id = $1', [shop.tenantId])).n), 0);
  assert.equal((await one(world, 'SELECT state FROM service_changes WHERE id = $1', [drafted.data.changeId])).state, 'draft');
  assert.doesNotMatch(JSON.stringify(await changesOf(shop)), /test-ig-token|sim-key-secret/);
});
