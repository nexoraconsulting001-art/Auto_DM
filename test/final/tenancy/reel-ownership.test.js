// D-5 (p0-authz-r1-6): an Instagram or Facebook post id is a business's own only when its own connected account says so.
// Another business writing the id first must never lock the real owner out of its reel or landing page, and a refusal
// must read the same whether the id is held elsewhere or does not exist (no existence oracle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindTenant } from '../../../src/repos/index.js';
import { fakeIg, setup } from '../../helpers.js';
import { addProduct, ownerApi, secondShop, shop } from '../../p3/pages/support.js';

const A_REEL = '17900000000000701';
const A_OLD = '17900000000000702';
const A_PAGE_MEDIA = '17900000000000703';
const B_REEL = '17900000000000801';
const NOWHERE = '17900000000000999';
const A_FB_PAGE = '102000000000101';
const B_FB_PAGE = '102000000000202';

/** Instagram as each account sees it: a media id reads only with the token of the account that posted it. */
function ownedIg(owners) {
  const ig = fakeIg();
  ig.getMedia = async (account, id) => {
    if (owners[String(id)] !== account?.igUserId) throw Object.assign(new Error('Unsupported get request'), { status: 400, kind: 'validation' });
    return { id: String(id), caption: 'Brunch look', permalink: `https://www.instagram.com/reel/${id}/`, media_type: 'VIDEO', media_product_type: 'REELS' };
  };
  return ig;
}

const reelBody = (productIds, headline) => ({ productIds, headline });
const errorOf = (res) => ({ status: res.status, code: res.body?.code, message: res.body?.error });

async function twoShops(t, overrides = {}) {
  const ig = ownedIg({ [A_REEL]: 'ME', [A_OLD]: 'ME', [A_PAGE_MEDIA]: 'ME', [B_REEL]: 'IG-two' });
  const a = await shop(t, { ig, overrides });
  const b = await secondShop(a.app);
  const mine = await addProduct(a.app, a.repos, a.tenant, { name: 'Brass lamp' });
  const theirs = await addProduct(a.app, b.repos, b.tenant, { name: 'Plant pot' });
  return { a, b, mine, theirs, q: (sql, params) => a.app.db.platform.query(sql, params) };
}

test('D-5: two businesses can each hold the same post id in the database; neither write touches the other', async () => {
  const { db, platform, repos: a } = await setup();
  const b = bindTenant(platform, await platform.tenants.create({ slug: 'squatter', name: 'Squatter' }));
  const lamp = await a.products.create({ name: 'Brass lamp', price: '499', active: 'on' });
  const pot = await b.products.create({ name: 'Plant pot', price: '199', active: 'on' });

  await b.reels.save(A_REEL, { headline: 'Squat', keywords: 'LINK', productIds: [pot.id], active: 'on' });
  const saved = await a.reels.save(A_REEL, { headline: 'Mine', keywords: 'LINK', productIds: [lamp.id], active: 'on' });
  assert.equal(saved.headline, 'Mine');
  assert.deepEqual(saved.products.map((p) => p.id), [lamp.id]);

  await a.reels.save(A_REEL, { headline: 'Mine again', keywords: 'LINK', productIds: [lamp.id], active: 'on' });
  const theirs = await b.reels.get(A_REEL);
  assert.equal(theirs.headline, 'Squat', 'the other business\'s row is untouched');
  assert.deepEqual(theirs.products.map((p) => p.id), [pot.id]);
  assert.equal((await a.reels.getActiveByMediaId(A_REEL)).headline, 'Mine again');

  await b.reels.remove(A_REEL);
  assert.equal((await a.reels.get(A_REEL)).headline, 'Mine again', 'removing one business\'s row leaves the other\'s');
  await db.close();
});

test('D-5: reels.save takes only a post on the business\'s own Instagram, and a squatted id never locks the owner out', async (t) => {
  const { a, b, mine, theirs, q } = await twoShops(t);

  const squat = await b.api('PUT', `/reels/${A_REEL}`, reelBody([theirs.id], 'Squat'));
  assert.equal(squat.status, 404, JSON.stringify(squat.body));
  assert.equal(squat.body.code, 'not_found');
  assert.equal(await b.repos.reels.get(A_REEL), null, 'nothing is written for a post that is not theirs');
  assert.deepEqual(errorOf(await b.api('PUT', `/reels/${NOWHERE}`, reelBody([theirs.id], 'Nowhere'))), errorOf(squat), 'a post of another account reads like one that does not exist');

  assert.equal((await b.api('PUT', `/reels/${B_REEL}`, reelBody([theirs.id], 'Own'))).status, 200, 'a business sets up its own post');
  assert.equal((await a.api('PUT', `/reels/${A_REEL}`, reelBody([mine.id], 'Mine'))).status, 200);

  // A row written before ownership was checked (or by any other path) does not stand in the owner's way.
  await q(`INSERT INTO reels (tenant_id, ig_media_id, slug) VALUES ($1, $2, 'old-squat')`, [b.tenant.id, A_OLD]);
  const owner = await a.api('PUT', `/reels/${A_OLD}`, reelBody([mine.id], 'Old post'));
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal((await a.repos.reels.get(A_OLD)).headline, 'Old post');
  assert.equal((await b.repos.reels.get(A_OLD)).slug, 'old-squat', 'the other business\'s row is not changed by the owner either');
  const knownToB = await b.api('GET', `/reels/${A_OLD}`);
  assert.equal(knownToB.status, 200);
  assert.notEqual(knownToB.body.headline, 'Old post', 'B never sees A\'s reel');
});

test('D-5: a business with no Instagram connected cannot claim any post id', async (t) => {
  const { a, q } = await twoShops(t);
  const tenant = await a.app.platform.tenants.create({ slug: 'three', name: 'Third Shop', plan: 't2' });
  const repos = bindTenant(a.app.platform, tenant);
  const owner = { phone: '9000000003', password: 'third-pass' };
  await repos.users.ensureOwner(owner);
  const api = await ownerApi(a.app, { host: 'three.bhava.test', ...owner });
  const product = await addProduct(a.app, repos, tenant, { name: 'Jug' });
  const res = await api('PUT', `/reels/${A_REEL}`, reelBody([product.id], 'Squat'));
  assert.ok(res.status >= 400 && res.status < 500, `refused, got ${res.status}`);
  assert.deepEqual(await q('SELECT 1 FROM reels WHERE tenant_id = $1', [tenant.id]), []);
});

test('D-5: pages.create on Instagram is not blocked by another business holding the same post id', async (t) => {
  const { a, b, mine, theirs, q } = await twoShops(t);
  const refused = await b.api('POST', '/pages', { kind: 'reel', mediaId: A_PAGE_MEDIA, headline: 'Squat', productIds: [theirs.id] });
  assert.ok(refused.status >= 400 && refused.status < 500, `refused, got ${refused.status}`);
  assert.deepEqual(errorOf(await b.api('POST', '/pages', { kind: 'reel', mediaId: NOWHERE, headline: 'Nowhere', productIds: [theirs.id] })), errorOf(refused));

  await q(`INSERT INTO reels (tenant_id, ig_media_id, slug) VALUES ($1, $2, 'page-squat')`, [b.tenant.id, A_PAGE_MEDIA]);
  const made = await a.api('POST', '/pages', { kind: 'reel', mediaId: A_PAGE_MEDIA, headline: 'Kitchen edit', productIds: [mine.id] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.mediaId, A_PAGE_MEDIA);
});

async function connectFacebookPage(s, repos, tenant, pageId) {
  await s.app.db.platform.query('INSERT INTO fb_pages (page_id, tenant_id, name) VALUES ($1, $2, $3)', [pageId, tenant.id, 'Page']);
  await repos.fbPages.saveConnection({ pageId, name: 'Page', token: `page-token-${pageId}` });
}

test('D-5: pages.create on Facebook takes only a post of the business\'s own connected Page', async (t) => {
  const { a, b, mine, theirs, q } = await twoShops(t, { facebookPages: true });
  await connectFacebookPage(a, a.repos, a.tenant, A_FB_PAGE);
  await connectFacebookPage(a, b.repos, b.tenant, B_FB_PAGE);
  const post = `${A_FB_PAGE}_5550001`;

  const squat = await b.api('POST', '/pages', { channel: 'facebook', kind: 'post', mediaId: post, headline: 'Squat', productIds: [theirs.id] });
  assert.ok(squat.status >= 400 && squat.status < 500, `refused, got ${squat.status}`);
  assert.deepEqual(await q('SELECT 1 FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [b.tenant.id, post]), []);
  for (const other of [`${B_FB_PAGE}5_1`, '5550001', `x_${A_FB_PAGE}_1`]) {
    const res = await b.api('POST', '/pages', { channel: 'facebook', kind: 'post', mediaId: other, headline: 'Not ours', productIds: [theirs.id] });
    assert.ok(res.status >= 400 && res.status < 500, `${other}: refused, got ${res.status}`);
  }

  const own = await b.api('POST', '/pages', { channel: 'facebook', kind: 'post', mediaId: `${B_FB_PAGE}_7770001`, headline: 'Own post', productIds: [theirs.id] });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const made = await a.api('POST', '/pages', { channel: 'facebook', kind: 'post', mediaId: post, headline: 'Our post', productIds: [mine.id] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
});

test('D-5: a business with no Facebook Page connected cannot claim a Facebook post id', async (t) => {
  const { a, b, theirs, q } = await twoShops(t, { facebookPages: true });
  await connectFacebookPage(a, a.repos, a.tenant, A_FB_PAGE);
  const res = await b.api('POST', '/pages', { channel: 'facebook', kind: 'post', mediaId: `${A_FB_PAGE}_5550002`, headline: 'Squat', productIds: [theirs.id] });
  assert.ok(res.status >= 400 && res.status < 500, `refused, got ${res.status}`);
  assert.deepEqual(await q('SELECT 1 FROM reels WHERE tenant_id = $1', [b.tenant.id]), []);
});
