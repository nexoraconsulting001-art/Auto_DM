// Reporting API keys and the reporting API (PRD 7.13, N-63 to N-66, N-82): owner only, shown once, stored hashed, revoked at once; the key alone
// names the business; summary figures only, with Explore's metrics, breakdowns and filters; 60 calls a minute per key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REPORTING_BASE_PATH } from '../../../src/contracts/analytics.js';
import { DAY, captureLogs, hit, openWorld, requestId } from './support.js';

const createKey = (shop, name = 'Sheets') => shop.json('/api-keys', { method: 'POST', body: { name } }, 201);
const reporting = (w, shop, key, path, { business = shop.tenantId, host = shop.host, headers = {}, method = 'GET' } = {}) =>
  hit(w.app, `${REPORTING_BASE_PATH}/businesses/${business}${path}`, { host, method, headers: { ...(key ? { 'x-api-key': key } : {}), ...headers } });
const yesterday = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);

test('N-63: only the owner makes, lists or revokes a key; it is shown once, stored as a hash, read-only, and audited', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const manager = await shop.addUser('manager');
  const refused = await shop.call('/api-keys', { method: 'POST', body: { name: 'Mine' } }, manager.token);
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'Owner only.');
  const created = await createKey(shop);
  assert.match(created.key, /^bhv_[\w-]{43}$/);
  assert.equal(created.scope, 'analytics:read');
  assert.ok(created.key.startsWith(created.prefix));
  for (const [method, path] of [['GET', '/api-keys'], ['DELETE', `/api-keys/${created.id}`]]) assert.equal((await shop.call(path, { method }, manager.token)).status, 403, path);
  const rows = await shop.sql('SELECT * FROM reporting_api_keys WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(JSON.stringify(rows).includes(created.key), false, 'The key is not stored');
  const listed = (await shop.json('/api-keys')).items.find((k) => k.id === created.id);
  assert.equal(Object.hasOwn(listed, 'key'), false, 'Never returned again');
  const audit = await shop.audit('reporting_key');
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes(created.key), false, 'The audit row holds the key masked');
  const keys = await Promise.all([createKey(shop), createKey(shop), createKey(shop)]);
  assert.equal(new Set(keys.map((k) => k.key)).size, 3);
  const tier1 = await w.addShop({ plan: 't1' });
  const later = await tier1.call('/api-keys', { method: 'POST', body: { name: 'K' } });
  assert.equal(later.status, 403);
  assert.match(later.json().error, /tier 2/);
});

test('N-64: the key alone names the business: on any address it works, and another business\'s id is 404, with no data, and logged', async (t) => {
  const logs = captureLogs(t);
  const w = await openWorld(t);
  const a = await w.addShop();
  const b = await w.addShop();
  await b.write('traffic_daily', [{ day: yesterday(), hour: 10, weekday: 1, source: 'bio_link', sessions: 77 }]);
  const { key } = await createKey(a);
  const ok = await reporting(w, a, key, '/metrics?metrics=sessions&range=7', { host: b.host });
  assert.equal(ok.status, 200, ok.text);
  const id = requestId();
  const res = await reporting(w, a, key, '/metrics?metrics=sessions&range=7', { business: b.tenantId, headers: { 'x-request-id': id } });
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /sessions|77/);
  assert.ok(logs.forRequest(id).some((l) => /reporting\.not_found/.test(l)), 'The attempt is logged');
  assert.equal(logs.text().includes(key), false, 'The key is never logged');
  for (const bad of ['abc', '0', '-1', "1'--", '99999999999']) assert.equal((await reporting(w, a, key, '/metrics?metrics=sessions', { business: bad })).status, 404, bad);
});

test('N-64: no key, a made-up key, a session token or a revoked key is 401; a write is 405', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const { id, key } = await createKey(shop);
  assert.equal((await reporting(w, shop, null, '/metrics?metrics=sessions')).status, 401);
  assert.equal((await reporting(w, shop, 'bhv_madeup', '/metrics?metrics=sessions')).status, 401);
  assert.equal((await reporting(w, shop, `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`, '/metrics?metrics=sessions')).status, 401, 'One character off');
  assert.equal((await reporting(w, shop, null, '/metrics?metrics=sessions', { headers: { authorization: `Bearer ${shop.token}` } })).status, 401, 'A session is not a key');
  assert.equal((await reporting(w, shop, null, '/metrics?metrics=sessions', { headers: { authorization: `Bearer ${key}` } })).status, 200, 'The key as a bearer token');
  assert.equal((await reporting(w, shop, key, '/metrics', { method: 'POST' })).status, 405);
  assert.equal((await reporting(w, shop, key, '/metrics', { method: 'DELETE' })).status, 405);
  assert.equal((await shop.call(`/api-keys/${id}`, { method: 'DELETE' })).status, 204);
  const revoked = await reporting(w, shop, key, '/metrics?metrics=sessions');
  assert.equal(revoked.status, 401);
  assert.equal(revoked.json().code, 'unauthorized');
  assert.ok((await shop.json('/api-keys')).items.find((k) => k.id === id).revokedAt);
  assert.equal((await shop.audit('reporting_key.revoked')).length, 1);
  assert.equal((await shop.call(`/api-keys/${id}`, { method: 'DELETE' })).status, 204, 'Revoking twice is harmless');
  assert.equal((await shop.audit('reporting_key.revoked')).length, 1);
  const other = await w.addShop();
  const theirs = await createKey(other);
  assert.equal((await shop.call(`/api-keys/${theirs.id}`, { method: 'DELETE' })).status, 404, 'Another business\'s key');
  assert.equal((await reporting(w, other, theirs.key, '/metrics?metrics=sessions')).status, 200);
  await shop.sql(`UPDATE tenants SET status = 'closed' WHERE id = $1`, [other.tenantId]);
  assert.equal((await reporting(w, other, theirs.key, '/metrics?metrics=sessions')).status, 403, 'A closed business\'s key does nothing');
});

test('N-64: Explore\'s metrics, breakdowns and filters, with cursor paging, ISO days and the business\'s time zone; hostile queries are 400', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop({ timeZone: 'Asia/Kolkata' });
  await shop.write('traffic_daily', Array.from({ length: 30 }, (_, i) => ({ day: yesterday(), hour: 10, weekday: 1, landing_page: `/r/p${i}`, source: i % 2 ? 'bio_link' : 'direct', sessions: 1 })));
  const { key, id } = await createKey(shop);
  const first = await reporting(w, shop, key, '/metrics?metrics=sessions&dimensions=landing_page&filter=source:exclude:direct&range=7&limit=10');
  assert.equal(first.status, 200, first.text);
  const page = first.json();
  assert.equal(page.data.length, 10);
  assert.equal(page.columns[0].source, 'bhava');
  assert.equal(page.timeZone, 'Asia/Kolkata');
  assert.ok(page.nextCursor);
  const seen = new Set(page.data.map((r) => r.dimensions.landing_page));
  for (let cursor = page.nextCursor; cursor;) {
    const next = (await reporting(w, shop, key, `/metrics?metrics=sessions&dimensions=landing_page&filter=source:exclude:direct&range=7&limit=10&cursor=${cursor}`)).json();
    next.data.forEach((r) => seen.add(r.dimensions.landing_page));
    cursor = next.nextCursor;
  }
  assert.equal(seen.size, 15, 'Every non-direct page once');
  const byDay = (await reporting(w, shop, key, '/metrics?metrics=sessions&dimensions=date&range=7')).json();
  assert.ok(byDay.data.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.dimensions.date)));
  for (const query of ['metrics=', 'metrics=nope', 'metrics=sessions&dimensions=visitor_id', 'metrics=sessions&dimensions=source,device,city', 'metrics=sessions&range=evil', 'metrics=sessions&limit=0', 'metrics=sessions&limit=101',
    "metrics=sessions&cursor='", 'metrics=sessions&cursor=bm9wZQ', 'metrics=sessions;DROP%20TABLE%20tenants', 'metrics=sessions&filter=source', 'metrics=sessions&filter=visitor_id:include:x', 'metrics=sessions&filter=source:maybe:x', 'metrics=sessions&metrics=orders']) {
    assert.equal((await reporting(w, shop, key, `/metrics?${query}`)).status, 400, query);
  }
  const catalog = await reporting(w, shop, key, '/catalog');
  assert.equal(catalog.status, 200);
  assert.ok(catalog.json().metrics.some((m) => m.name === 'sessions'));
  const [row] = await shop.sql('SELECT last_used_at FROM reporting_api_keys WHERE id = $1', [id]);
  assert.ok(row.last_used_at, 'Last used is kept');
});

test('N-82: event-level rows are refused, and no summary query names a visitor', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const { key } = await createKey(shop);
  const res = await reporting(w, shop, key, '/events');
  assert.equal(res.status, 403);
  assert.equal(res.json().code, 'forbidden');
  for (const dimension of ['visitor_id', 'session_id', 'path', 'ip', 'event_key']) assert.equal((await reporting(w, shop, key, `/metrics?metrics=sessions&dimensions=${dimension}`)).status, 400, dimension);
});

test('N-64: revenue follows the plan: a tier 2 key gets none', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop({ plan: 't2' });
  await shop.write('traffic_daily', [{ day: yesterday(), hour: 10, weekday: 1, source: 'bio_link', sessions: 5, orders: 1, revenue_paise: 98765 }]);
  const { key } = await createKey(shop);
  const res = await reporting(w, shop, key, '/metrics?metrics=sessions,revenue_paise&range=7');
  assert.equal(res.status, 200);
  assert.equal(res.text.includes('98765'), false);
  assert.deepEqual(res.json().columns.map((c) => c.metric), ['sessions']);
  const rich = await w.addShop({ plan: 't3' });
  await rich.write('traffic_daily', [{ day: yesterday(), hour: 10, weekday: 1, source: 'bio_link', sessions: 5, orders: 1, revenue_paise: 98765 }]);
  assert.match((await reporting(w, rich, (await createKey(rich)).key, '/metrics?metrics=revenue_paise&range=7')).text, /98765/, 'Tier 3: the owner\'s key sees it');
});

test('N-65: the 61st call in a minute is 429 with a retry time, per key, and a bad key can\'t use up a good one\'s', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const first = await createKey(shop);
  const second = await createKey(shop);
  for (let i = 0; i < 70; i++) assert.equal((await reporting(w, shop, `${first.key}x`, '/catalog')).status, 401);
  const results = await Promise.all(Array.from({ length: 70 }, () => reporting(w, shop, first.key, '/catalog')));
  assert.equal(results.filter((r) => r.status === 200).length, 60, 'Calls arriving together: 60 go through');
  const limited = results.filter((r) => r.status === 429);
  assert.equal(limited.length, 10);
  const wait = Number(limited[0].headers['retry-after']);
  assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`);
  assert.equal(limited[0].json().code, 'rate_limited');
  assert.equal((await reporting(w, shop, second.key, '/catalog')).status, 200, 'Another key of the same business');
});
