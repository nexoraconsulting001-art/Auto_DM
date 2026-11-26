// Corner cases around the tenancy fixes D-5, tenancy-1, D-6 and tenancy-2: boundaries, the other business's ids, concurrent
// requests, malformed input, and roles at the edge of a permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTenant } from '../../../src/repos/index.js';
import { reelsRepo } from '../../../src/repos/reels.js';
import { withTenant } from '../../../src/tenancy.js';
import { productionProblems } from '../../../src/platform/production-guard.js';
import { claimConnection } from '../../../src/modules/ig-accounts/claim.js';
import { REEL_ID, fakeIg, setup, startApp } from '../../helpers.js';
import { addProduct, secondShop, shop } from '../../p3/pages/support.js';
import { IG_A, IG_B, addBusiness as addSliceBusiness, alertsFor, connected, consent, startSlice } from '../../p1/review-slice/support.js';
import { addBusiness, addStaff, api, need, nextPhone, startWorld } from '../../p0/spec-p0/support.js';

const MINE = '17900000000001701';
const THEIRS = '17900000000001801';
const body = (productIds, headline = 'Edit') => ({ productIds, headline });

function ownedIg(owners, hooks = {}) {
  const ig = fakeIg();
  ig.getMedia = async (account, id) => {
    if (hooks.fail) throw hooks.fail;
    if (hooks.wrongId) return { id: '1', caption: 'x' };
    if (owners[String(id)] !== account?.igUserId) throw Object.assign(new Error('Unsupported get request'), { status: 400, kind: 'validation' });
    return { id: String(id), caption: 'Brunch look', permalink: `https://www.instagram.com/reel/${id}/`, media_type: 'VIDEO', media_product_type: 'REELS' };
  };
  return ig;
}

async function twoShops(t, hooks) {
  const a = await shop(t, { ig: ownedIg({ [MINE]: 'ME', [THEIRS]: 'IG-two' }, hooks) });
  const b = await secondShop(a.app);
  return { a, b, mine: await addProduct(a.app, a.repos, a.tenant, { name: 'Lamp' }), theirs: await addProduct(a.app, b.repos, b.tenant, { name: 'Pot' }) };
}

// ---------------------------------------------------------------- D-5

test('D-5 corner: malformed post ids are refused and write nothing', async (t) => {
  const { a, mine } = await twoShops(t);
  for (const id of ['abc', '123abc', '12 34', '-5', '1.5', '0x10', 'null']) {
    const res = await a.api('PUT', `/reels/${encodeURIComponent(id)}`, body([mine.id]));
    assert.ok(res.status >= 400 && res.status < 500, `${id}: got ${res.status}`);
  }
  assert.deepEqual(await a.app.db.platform.query('SELECT 1 FROM reels WHERE tenant_id = $1', [a.tenant.id]), []);
});

test('D-5 corner: a product of another business cannot be put on a reel, even for the business\'s own post', async (t) => {
  const { a, theirs } = await twoShops(t);
  const res = await a.api('PUT', `/reels/${MINE}`, body([theirs.id]));
  assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
  assert.equal(await a.repos.reels.get(MINE), null);
});

test('D-5 corner: an Instagram outage is a retryable conflict and writes nothing; a mismatched answer is not found', async (t) => {
  const down = await twoShops(t, { fail: Object.assign(new Error('boom'), { status: 500 }) });
  const res = await down.a.api('PUT', `/reels/${MINE}`, body([down.mine.id]));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(await down.a.repos.reels.get(MINE), null);

  const wrong = await twoShops(t, { wrongId: true });
  const res2 = await wrong.a.api('PUT', `/reels/${MINE}`, body([wrong.mine.id]));
  assert.equal(res2.status, 404);
  assert.equal(await wrong.a.repos.reels.get(MINE), null);
});

test('D-5 corner: the other business\'s same id cannot read, change or delete this business\'s reel', async (t) => {
  const { a, b, mine, theirs } = await twoShops(t);
  assert.equal((await a.api('PUT', `/reels/${MINE}`, body([mine.id], 'First'))).status, 200);
  assert.equal((await a.api('PUT', `/reels/${MINE}`, body([mine.id], 'Second'))).status, 200);
  const seenByB = await b.api('GET', `/reels/${MINE}`);
  assert.notEqual(seenByB.body?.headline, 'Second', 'B does not see A\'s reel');
  assert.equal((await b.api('PUT', `/reels/${MINE}`, body([theirs.id]))).status, 404);
  const del = await b.api('DELETE', `/reels/${MINE}`);
  assert.ok(del.status < 500, `delete: ${del.status}`);
  assert.equal((await a.repos.reels.get(MINE)).headline, 'Second', 'B deleting the id does not remove A\'s reel');
});

test('D-5 corner: both businesses writing the same post id at once never mixes rows', async () => {
  const { db, platform, repos: a } = await setup();
  const b = bindTenant(platform, await platform.tenants.create({ slug: 'racer', name: 'Racer' }));
  const lamp = await a.products.create({ name: 'Lamp', price: '499', active: 'on' });
  const pot = await b.products.create({ name: 'Pot', price: '199', active: 'on' });
  const runs = [];
  for (let i = 0; i < 4; i += 1) {
    runs.push(a.reels.save(MINE, { headline: `A${i}`, keywords: 'LINK', productIds: [lamp.id], active: 'on' }));
    runs.push(b.reels.save(MINE, { headline: `B${i}`, keywords: 'LINK', productIds: [pot.id], active: 'on' }));
  }
  await Promise.allSettled(runs);
  const ra = await a.reels.get(MINE);
  const rb = await b.reels.get(MINE);
  assert.match(ra.headline, /^A/);
  assert.match(rb.headline, /^B/);
  assert.deepEqual(ra.products.map((p) => p.id), [lamp.id]);
  assert.deepEqual(rb.products.map((p) => p.id), [pot.id]);
  await db.close();
});

test('D-5 corner: the reels repo refuses to run without a business', async () => {
  const { db } = await setup();
  await assert.rejects(() => reelsRepo(db).save(MINE, { headline: 'x', keywords: 'LINK', productIds: [], active: 'on' }));
  await assert.rejects(() => reelsRepo(db).get(MINE));
  await db.close();
});

test('D-5 corner: staff without the automations permission cannot set up a reel; with it, a business with no Instagram gets a conflict', async (t) => {
  const app = await startWorld(t);
  const biz = await addBusiness(app, { slug: 'edge-shop', name: 'Edge Shop' });
  const product = await biz.repos.products.create({ name: 'Lamp', price: '499', active: 'on' });
  const put = (token) => api(app, biz, token, `/reels/${MINE}`, { method: 'PUT', body: body([product.id]) });
  const without = await addStaff(app, biz, { permissions: ['orders'] });
  assert.equal((await put(without.token)).status, 403);
  const withIt = await addStaff(app, biz, { permissions: ['automations'] });
  assert.equal((await put(withIt.token)).status, 409);
  assert.equal((await put(undefined)).status, 401);
  assert.equal((await put('forged-token')).status, 401);
});

// ---------------------------------------------------------------- tenancy-1

const liveRows = (s, table, col, id) => s.q(`SELECT tenant_id FROM ${table} WHERE ${col} = $1 AND NOT (access_token_enc = '' AND status_reason = 'owner.disconnected')`, [id]);

test('tenancy-1 corner: three businesses racing for a released account, exactly one wins and no row is lost', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  assert.equal((await a.api('DELETE', '/instagram/connection')).status, 204);
  const racers = [];
  for (const n of ['rc1', 'rc2', 'rc3']) {
    const biz = await addSliceBusiness(slice.app, n);
    await slice.q("UPDATE tenants SET plan = 't2' WHERE id = $1", [biz.tenant.id]);
    racers.push(biz);
  }
  const results = await Promise.all(racers.map((r) => claimConnection(slice.app.db.platform, 'instagram', { tenantId: r.tenant.id, accountId: IG_A, name: 'x' })));
  assert.equal(results.filter((r) => r !== null).length, 1, 'exactly one claim succeeds');
  assert.equal((await liveRows(slice, 'ig_accounts', 'ig_user_id', IG_A)).length, 1);
  const [{ n }] = await slice.q('SELECT count(*) AS n FROM ig_accounts WHERE ig_user_id = $1 AND tenant_id = $2', [IG_A, a.tenant.id]);
  assert.equal(Number(n), 1, 'the first business\'s released row is still there');
});

test('tenancy-1 corner: a live row blocks every other business, and reconnecting your own row passes nobody over', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  const b = await addSliceBusiness(slice.app, 'blocked');
  const db = slice.app.db.platform;
  assert.equal(await claimConnection(db, 'instagram', { tenantId: b.tenant.id, accountId: IG_A, name: 'x' }), null);
  assert.deepEqual(await alertsFor(slice, a.tenant.id), [], 'nothing was said to the holder');
  assert.deepEqual(await claimConnection(db, 'instagram', { tenantId: a.tenant.id, accountId: IG_A, name: 'x' }), { passedOver: [] });
  const rows = await slice.q('SELECT tenant_id FROM ig_accounts WHERE ig_user_id = $1', [IG_A]);
  assert.deepEqual(rows.map((r) => r.tenant_id), [a.tenant.id], 'no row for the refused business');
});

test('tenancy-1 corner: a row with no token that its owner did not release (token lost) is still held, not free to take', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  await slice.q("UPDATE ig_accounts SET access_token_enc = '', status_reason = 'token.expired' WHERE tenant_id = $1", [a.tenant.id]);
  const b = await addSliceBusiness(slice.app, 'opportunist');
  assert.equal(await claimConnection(slice.app.db.platform, 'instagram', { tenantId: b.tenant.id, accountId: IG_A }), null);
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, a.tenant.id);
});

test('tenancy-1 corner: lookups prefer the live row; unknown, empty and odd ids find nothing', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  const tenants = slice.app.platform.tenants;
  for (const odd of ['0', '', `${IG_A}' OR '1'='1`, IG_B]) assert.equal(await tenants.getByIgAccount(odd), null, JSON.stringify(odd));
  assert.equal((await tenants.getByIgAccount(IG_A)).id, a.tenant.id);
  assert.equal((await a.api('DELETE', '/instagram/connection')).status, 204);
  assert.equal((await tenants.getByIgAccount(IG_A)).id, a.tenant.id, 'only a released row is left: it still resolves to its business');
});

test('tenancy-1 corner: linkIgAccount is idempotent for the holder and refused for another business', async (t) => {
  const slice = await startSlice(t);
  const tenants = slice.app.platform.tenants;
  const x = await addSliceBusiness(slice.app, 'linkx');
  const y = await addSliceBusiness(slice.app, 'linky');
  await tenants.linkIgAccount(x.tenant.id, IG_B, 'one');
  await tenants.linkIgAccount(x.tenant.id, IG_B, 'two');
  await assert.rejects(() => tenants.linkIgAccount(y.tenant.id, IG_B, 'three'), /already connected to another business/);
  const rows = await slice.q('SELECT tenant_id, username FROM ig_accounts WHERE ig_user_id = $1', [IG_B]);
  assert.deepEqual(rows.map((r) => [r.tenant_id, r.username]), [[x.tenant.id, 'two']]);
});

test('tenancy-1 corner: a replayed or forged consent callback changes nothing', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  await a.api('DELETE', '/instagram/connection');
  const b = await addSliceBusiness(slice.app, 'replayer');
  await slice.q("UPDATE tenants SET plan = 't2' WHERE id = $1", [b.tenant.id]);
  const flow = await consent(slice, b, { igUserId: IG_A });
  assert.equal(flow.outcome, 'connected');
  const replay = await flow.callback();
  const outcome = new URL(replay.headers.get('location') ?? 'http://x/', 'http://x').searchParams.get('instagram');
  assert.notEqual(outcome, 'connected', 'a used callback does not connect again');
  const forged = await fetch(`${slice.app.base}/oauth/instagram/callback?code=forged&state=forged`, { redirect: 'manual', headers: { 'x-forwarded-host': flow.back.host } });
  assert.ok(forged.status < 500, `forged callback: ${forged.status}`);
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, b.tenant.id);
  assert.equal((await liveRows(slice, 'ig_accounts', 'ig_user_id', IG_A)).length, 1);
});

test('tenancy-1 corner: the database itself refuses a second live Facebook Page row, and allows a released one beside it', async (t) => {
  const slice = await startSlice(t);
  const x = await addSliceBusiness(slice.app, 'dbx');
  const y = await addSliceBusiness(slice.app, 'dby');
  await slice.q(`INSERT INTO fb_pages (page_id, tenant_id, name, access_token_enc) VALUES ('555', $1, 'P', 'enc')`, [x.tenant.id]);
  await assert.rejects(() => slice.q(`INSERT INTO fb_pages (page_id, tenant_id, name, access_token_enc) VALUES ('555', $1, 'P', 'enc2')`, [y.tenant.id]), /fb_pages_live_idx|duplicate/);
  await slice.q(`INSERT INTO fb_pages (page_id, tenant_id, name, access_token_enc, status_reason) VALUES ('555', $1, 'P', '', 'owner.disconnected')`, [y.tenant.id]);
  assert.equal((await slice.q(`SELECT 1 FROM fb_pages WHERE page_id = '555'`)).length, 2);
});

// ---------------------------------------------------------------- D-6

test('D-6 corner: whitespace-only DEFAULT_TENANT is no fallback; a non-string value is not read as empty', () => {
  assert.ok(!productionProblems({ defaultTenant: '   ' }).some((p) => p.id === 'tenancy.no_default'));
  assert.ok(productionProblems({ defaultTenant: 'x' }).some((p) => p.id === 'tenancy.no_default'));
});

test('D-6 corner: with no fallback business, odd host spellings and unknown accounts reach no business', async () => {
  const app = await startApp({ overrides: { defaultTenant: '' } });
  try {
    for (const host of ['NOBODY.BHAVA.TEST', 'nobody.bhava.test:8080', 'nobody.bhava.test.', 'default']) {
      const res = await fetch(`${app.base}/`, { headers: { 'x-forwarded-host': host }, redirect: 'manual' });
      assert.ok([400, 404].includes(res.status), `${JSON.stringify(host)} -> ${res.status}`);
    }
    assert.equal(await app.platform.tenants.getByIgAccount('17841499999999999'), null);
  } finally {
    app.close();
    await app.db.close();
  }
});

// ---------------------------------------------------------------- tenancy-2

async function switchWorld(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'sw-alpha', name: 'Sw Alpha' });
  const b = await addBusiness(app, { slug: 'sw-beta', name: 'Sw Beta' });
  const product = await b.repos.products.create({ name: 'Lamp', price: '499', active: 'on' });
  await b.repos.reels.save(REEL_ID, { headline: 'Lamp edit', keywords: 'LINK', productIds: [product.id], active: 'on' });
  const phone = nextPhone();
  const inA = await addStaff(app, a, { permissions: ['automations'], phone });
  const inB = await addStaff(app, b, { permissions: ['automations'], phone });
  const switched = (path, id = b.tenant.id, token = inA.token) => api(app, a, token, path, { headers: { 'x-tenant-id': String(id) } });
  return { app, a, b, inA, inB, switched };
}

test('tenancy-2 corner: a pending or non-primary domain never becomes the store host of a switched request', async (t) => {
  const { app, b, switched } = await switchWorld(t);
  await app.platform.tenants.addDomain(b.tenant.id, 'pending.beta-brand.example');
  await app.platform.tenants.addDomain(b.tenant.id, 'second.beta-brand.example');
  await app.db.platform.query(`UPDATE tenant_domains SET status = 'verified', is_primary = false WHERE tenant_id = $1 AND domain = 'second.beta-brand.example'`, [b.tenant.id]);
  const res = need(await switched('/reels'), 200, 'switched');
  assert.doesNotMatch(res.json().items[0].storeUrl, /beta-brand\.example/);
  await app.db.platform.query(`UPDATE tenant_domains SET status = 'verified', is_primary = true WHERE tenant_id = $1 AND domain = 'pending.beta-brand.example'`, [b.tenant.id]);
  const after = need(await switched('/reels'), 200, 'after verify');
  assert.equal(new URL(after.json().items[0].storeUrl).host, 'pending.beta-brand.example');
});

test('tenancy-2 corner: the signed-in business\'s own primary domain never leaks into links built for the other', async (t) => {
  const { app, a, switched } = await switchWorld(t);
  await app.platform.tenants.addDomain(a.tenant.id, 'shop.alpha-brand.example');
  await app.db.platform.query(`UPDATE tenant_domains SET status = 'verified', is_primary = true WHERE tenant_id = $1`, [a.tenant.id]);
  const res = need(await switched('/reels'), 200, 'switched');
  assert.doesNotMatch(res.json().items[0].storeUrl, /alpha-brand/);
});

test('tenancy-2 corner: malformed, foreign, removed or forged switches are refused', async (t) => {
  const { app, a, b, inB, switched } = await switchWorld(t);
  const stranger = await addBusiness(app, { slug: 'sw-gamma', name: 'Sw Gamma' });
  const seen = {};
  for (const id of ['abc', '-1', '0', '1e3', '99999999999999999999', `${b.tenant.id}.5`, `${b.tenant.id} OR 1=1`, stranger.tenant.id, 424242]) {
    const res = await switched('/reels', id);
    seen[id] = res.status;
    assert.ok([400, 403, 404].includes(res.status), `${JSON.stringify(id)} -> ${res.status}`);
  }
  assert.equal(seen[stranger.tenant.id], seen[424242], 'a real foreign business reads like one that does not exist');
  assert.equal((await switched('/reels', a.tenant.id)).status, 200, 'switching to the current business is plain');
  assert.equal((await switched('/reels', b.tenant.id, 'forged-token')).status, 401);
  assert.equal((await api(app, b, inB.token, '/reels', { headers: { 'x-tenant-id': String(stranger.tenant.id) } })).status, 403, 'B\'s account has no membership at a third business');
  assert.equal((await switched('/reels')).status, 200);
  await app.db.platform.query('UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND id = $2', [b.tenant.id, inB.user.id]);
  assert.equal((await switched('/reels')).status, 403, 'a removal counts on the very next call');
});

test('tenancy-2 corner: memberOf is null for a shopper role, an unknown business and an unrelated account', async (t) => {
  const { a, b, inA } = await switchWorld(t);
  await withTenant(a.tenant, async () => {
    assert.ok(await a.repos.users.memberOf(inA.user, b.tenant.id));
    assert.equal(await a.repos.users.memberOf(inA.user, 999999), null);
    assert.equal(await a.repos.users.memberOf({ ...inA.user, role: 'customer' }, b.tenant.id), null);
    assert.equal(await a.repos.users.memberOf({ ...inA.user, id: inA.user.id + 1000 }, b.tenant.id), null);
  });
});
