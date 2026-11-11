// Reel stores and the Instagram post picker through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REEL_ID, fakeIg } from '../../helpers.js';
import { at, bearer, jsonRequest, ok, refused, secondBusiness, walk, withApp } from './support.js';

const save = (productIds, extra = {}) => ({ keywords: ['LINK'], productIds, headline: 'Brunch edit', ...extra });

async function products(api, n = 2) {
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push((await ok(await api('POST', '/products', { name: `Item ${i}`, pricePaise: i * 100 }), 201)).id);
  return ids;
}

test('saving creates the reel store and shows its products in the chosen order', withApp(async ({ api }) => {
  const [a, b] = await products(api);
  const reel = await ok(await api('PUT', `/reels/${REEL_ID}`, save([b, a], { keywords: ['LINK', 'SHOP'], dmMessage: 'Hello', buttonText: 'Open', publicReply: 'Sent', permalink: 'https://instagram.com/reel/x', thumbnailUrl: 'https://cdn.example/t.jpg', videoUrl: 'https://cdn.example/v.mp4', caption: 'Hi' })));
  assert.equal(reel.id, REEL_ID);
  assert.equal(reel.slug, 'brunch-edit');
  assert.deepEqual(reel.keywords, ['LINK', 'SHOP']);
  assert.equal(reel.dmMessage, 'Hello');
  assert.equal(reel.buttonText, 'Open');
  assert.equal(reel.publicReply, 'Sent');
  assert.equal(reel.active, true);
  assert.equal(reel.permalink, 'https://instagram.com/reel/x');
  assert.equal(reel.thumbnailUrl, 'https://cdn.example/t.jpg');
  assert.equal(reel.videoUrl, 'https://cdn.example/v.mp4');
  assert.equal(reel.caption, 'Hi');
  assert.equal(reel.storeUrl, 'https://shop.test/r/brunch-edit?src=dm');
  assert.deepEqual(reel.products.map((p) => p.id), [b, a]);
  assert.deepEqual(reel.products.map((p) => p.position), [0, 1]);
  assert.deepEqual(reel.products.map((p) => p.pricePaise), [200, 100]);
  assert.deepEqual(await ok(await api('GET', `/reels/${REEL_ID}`)), reel);
}));

test('saving again replaces the store but keeps the link already sent in DMs, and a reel left paused stays paused', withApp(async ({ api }) => {
  const [a] = await products(api, 1);
  await ok(await api('PUT', `/reels/${REEL_ID}`, save([a], { active: false })));
  const renamed = await ok(await api('PUT', `/reels/${REEL_ID}`, save([a], { headline: 'New headline' })));
  assert.equal(renamed.headline, 'New headline');
  assert.equal(renamed.slug, 'brunch-edit');
  assert.equal(renamed.active, false);
  const moved = await ok(await api('PUT', `/reels/${REEL_ID}`, save([a], { slug: 'new-link', active: true })));
  assert.equal(moved.slug, 'new-link');
  assert.equal(moved.active, true);
  assert.equal(moved.storeUrl, 'https://shop.test/r/new-link?src=dm');
}));

test('a keyword with a comma, a dangerous link and a product that is gone are all refused', withApp(async (app) => {
  const { api } = app;
  const [a] = await products(api, 1);
  const url = `/reels/${REEL_ID}`;
  assert.ok((await refused(await api('PUT', url, save([a], { keywords: ['one,two'] })), 400, 'validation_failed')).fields.keywords);
  assert.ok((await refused(await api('PUT', url, save([a], { permalink: 'javascript:alert(1)' })), 400, 'validation_failed')).fields.permalink);
  assert.ok((await refused(await api('PUT', url, save([a], { thumbnailUrl: 'javascript:alert(1)' })), 400, 'validation_failed')).fields.thumbnailUrl);
  await refused(await api('PUT', url, save([a + 999])), 400, 'validation_failed');
  await refused(await api('PUT', url, save([])), 400, 'validation_failed');
  await refused(await api('PUT', url, { productIds: [a], keywords: ['LINK'] }), 400, 'validation_failed'); // no headline or slug
  await refused(await api('GET', url), 404, 'not_found');

  const leaf = await secondBusiness(app);
  const [theirs] = await products(leaf.api, 1);
  const error = await refused(await api('PUT', url, save([theirs])), 400, 'validation_failed');
  assert.doesNotMatch(error.error, /Item/);
  await refused(await api('GET', url), 404, 'not_found');
}));

test('the reel list carries its funnel numbers and pages', withApp(async ({ api, repos }) => {
  const [a] = await products(api, 1);
  for (const [i, id] of ['1001', '1002', '1003'].entries()) await ok(await api('PUT', `/reels/${id}`, save([a], { slug: `reel-${i}` })));
  await repos.activity.log({ commentId: 'c1', reelId: '1001', username: 'a', text: 'x', result: 'sent' });
  await repos.reels.recordVisit('1001', 'dm');
  const { items, sizes } = await walk(api, '/reels', 2);
  assert.deepEqual(sizes, [2, 1]);
  assert.deepEqual(items.map((r) => r.id), ['1003', '1002', '1001']);
  const first = items.find((r) => r.id === '1001');
  assert.equal(first.productCount, 1);
  assert.equal(first.dmCount, 1);
  assert.equal(first.visitCount, 1);
  assert.equal(first.orderCount, 0);
}));

test('removing a reel store takes it away, and a second try is a 404', withApp(async ({ api }) => {
  const [a] = await products(api, 1);
  await ok(await api('PUT', `/reels/${REEL_ID}`, save([a])));
  assert.equal((await api('DELETE', `/reels/${REEL_ID}`)).status, 204);
  await refused(await api('GET', `/reels/${REEL_ID}`), 404, 'not_found');
  await refused(await api('DELETE', `/reels/${REEL_ID}`), 404, 'not_found');
}));

test('Instagram posts list the account\'s posts and say which already have a store', withApp(async ({ api }) => {
  const before = await ok(await api('GET', '/instagram/posts'));
  assert.deepEqual(before, { items: [{ id: REEL_ID, caption: 'Brunch look', mediaType: 'REELS', permalink: '', thumbnailUrl: '', configured: false }], nextCursor: null });
  const [a] = await products(api, 1);
  await ok(await api('PUT', `/reels/${REEL_ID}`, save([a])));
  assert.equal((await ok(await api('GET', '/instagram/posts'))).items[0].configured, true);
}));

test('Instagram posts page, and fall back to the media link for the picture', async () => {
  const ig = fakeIg();
  ig.listMedia = async () => ({ data: [{ id: '1', media_type: 'IMAGE', media_url: 'https://cdn.example/1.jpg', permalink: 'https://instagram.com/p/1' }, { id: '2' }, { id: '3' }] });
  await withApp({ ig }, async ({ api }) => {
    const { items, sizes } = await walk(api, '/instagram/posts', 2);
    assert.deepEqual(sizes, [2, 1]);
    assert.deepEqual(items.map((p) => p.id), ['1', '2', '3']);
    assert.equal(items[0].mediaType, 'IMAGE');
    assert.equal(items[0].thumbnailUrl, 'https://cdn.example/1.jpg');
    assert.equal(items[0].permalink, 'https://instagram.com/p/1');
    assert.equal(items[1].caption, '');
  })();
});

test('with no Instagram connected, or Instagram failing, the seller gets a message and nothing leaks', async () => {
  const ig = fakeIg();
  ig.listMedia = async () => { throw Object.assign(new Error('Instagram API GET failed (400): token EAAB-secret'), { status: 400, code: 190 }); };
  await withApp({ ig }, async ({ api, db, tenant }) => {
    const failing = await refused(await api('GET', '/instagram/posts'), 409, 'conflict');
    assert.doesNotMatch(JSON.stringify(failing), /EAAB|secret|API GET/);
    await db.query(`UPDATE ig_accounts SET access_token_enc = '' WHERE tenant_id = $1`, [tenant.id]);
    const none = await refused(await api('GET', '/instagram/posts'), 409, 'conflict');
    assert.match(none.error, /Connect your Instagram/);
  })();
});

test('F-09: a spoofed forwarded host does not change the link, on the business\'s own address', withApp({ overrides: { publicBaseUrl: '' } }, async (app) => {
  const { api, base, owner } = app;
  const [a] = await products(api, 1);
  const reel = await ok(await api('PUT', `/reels/${REEL_ID}`, save([a])));
  assert.equal(reel.storeUrl, 'https://default.bhava.test/r/brunch-edit?src=dm');
  const leaf = await secondBusiness(app);
  assert.ok(leaf);
  const spoofed = await fetch(`${base}/api/v1/reels/${REEL_ID}`, jsonRequest('GET', undefined, { ...bearer(owner), ...at('evil.example') }));
  assert.equal((await ok(spoofed)).storeUrl, 'https://default.bhava.test/r/brunch-edit?src=dm');
  const setup = await fetch(`${base}/api/v1/settings/setup`, jsonRequest('GET', undefined, { ...bearer(owner), ...at('evil.example') }));
  assert.equal((await ok(setup)).storeUrl, 'https://default.bhava.test');
  // Another business's own address refuses the token altogether (Phase 4), so there is no link to change.
  const onLeaf = await fetch(`${base}/api/v1/reels/${REEL_ID}`, jsonRequest('GET', undefined, { ...bearer(owner), ...at('leaf.bhava.test') }));
  assert.equal(onLeaf.status, 401);
}));
