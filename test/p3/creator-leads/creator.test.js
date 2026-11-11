// PRD 8.14: the creator page, its shelves, its search, its links and its badge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BROWSER, addCategory, addMedia, addPage, addTeamMember, secondBusiness, setPlan, startWorld, tileSlugs } from './support.js';

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

const save = async (business, body) => {
  const res = await business.api('/creator-page', { method: 'PATCH', body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

/** A category holding the pages given, in order. */
async function shelf(business, name, pages) {
  const category = await addCategory(business, name);
  for (const page of pages) {
    const res = await business.api(`/categories/${category.id}/reels`, { method: 'POST', body: { pageId: page.id } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return category;
}

test('the page is saved with a name the store doesn’t use, and answers nothing until it is on', async (t) => {
  const w = await world(t);
  const empty = (await w.api('/creator-page')).body;
  assert.deepEqual({ slug: empty.slug, enabled: empty.enabled, url: empty.url, updatedAt: empty.updatedAt }, { slug: '', enabled: false, url: '', updatedAt: null });

  const noName = await w.api('/creator-page', { method: 'PATCH', body: { enabled: true } });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.fields.slug, 'Pick a name for your page first');
  for (const slug of ['admin', 'r', 'lead', 'reels', 'shop', 'api']) {
    assert.equal((await w.api('/creator-page', { method: 'PATCH', body: { slug } })).status, 400, `${slug} is a page of the store`);
    const check = (await w.api(`/creator-page/slug?slug=${slug}`)).body;
    assert.equal(check.available, false);
  }
  assert.equal((await w.api('/creator-page/slug?slug=Priya')).body.available, true);
  assert.equal((await w.api('/creator-page/slug?slug=-bad-')).body.available, false);

  const saved = await save(w, { slug: 'priya', displayName: 'Priya Rao', bio: 'Steel and brass for the kitchen', websiteUrl: 'https://priya.example/shop' });
  assert.equal(saved.slug, 'priya');
  assert.equal(saved.enabled, false);
  assert.match(saved.url, /\/priya$/);
  assert.equal((await w.page('/priya')).status, 404, 'off: not served');
  await save(w, { enabled: true });
  const page = await w.page('/priya');
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1 id="creator-name">Priya Rao<\/h1>/);
  assert.match(page.text, /href="https:\/\/priya\.example\/shop" rel="noopener"/);
  assert.equal((await w.page('/PRIYA')).status, 200, 'the name is not case sensitive');
  assert.equal((await w.page('/someone-else')).status, 404);

  // A photo is a file this business uploaded; a web link's bytes are not ours to serve.
  assert.equal((await w.api('/creator-page', { method: 'PATCH', body: { photoUrl: 'https://cdn.example/p.jpg' } })).status, 400);
  assert.equal((await w.api('/creator-page', { method: 'PATCH', body: { photoUrl: '/media/2f1c1c5e-8a0e-4a4e-9a51-0d7f4e1b2a3c' } })).status, 400, 'no such file');
  const media = await addMedia(w);
  assert.equal((await save(w, { photoUrl: `/media/${media}` })).photoUrl, `/media/${media}`);
  assert.match((await w.page('/priya')).text, new RegExp(`<img src="/media/${media}"`));

  // The store's own pages still answer: /<slug> takes nothing that isn't the page.
  assert.notEqual((await w.page('/login')).status, 404);
  const audit = await w.db.platform.query(`SELECT action, details FROM audit_log WHERE action = 'creator_page.saved' ORDER BY id`);
  assert.ok(audit.length >= 3);
  assert.doesNotMatch(JSON.stringify(audit), /Priya Rao/);
});

test('K-49, K-48: shelves follow the category order and each shelf its sequence; uncategorised reels come last, newest first', async (t) => {
  const w = await world(t);
  const pages = [];
  for (const name of ['A', 'B', 'C', 'D', 'E']) pages.push(await addPage(w, { headline: `Reel ${name}` }));
  const [pa, pb, pc, pd, pe] = pages;
  const kitchen = await shelf(w, 'Kitchen', [pa, pb]);
  const bottles = await shelf(w, 'Bottles', [pb, pc]);
  await save(w, { slug: 'priya', enabled: true, moreShelfTitle: 'Everything else' });

  let page = await w.page('/priya');
  assert.deepEqual(tileSlugs(page.text), [pa.slug, pb.slug, pb.slug, pc.slug, pe.slug, pd.slug], 'a reel in two categories is on both shelves');
  assert.ok(page.text.indexOf('>Kitchen</a>') < page.text.indexOf('>Bottles</a>'));
  assert.match(page.text, /Everything else/);

  // The owner reorders: the page follows, with no copy of the order of its own.
  assert.equal((await w.api(`/categories/${bottles.id}/reels`, { method: 'PUT', body: { order: [pc.id, pb.id] } })).status, 200);
  assert.equal((await w.api('/categories/order', { method: 'PUT', body: { ids: [bottles.id, kitchen.id] } })).status, 204);
  page = await w.page('/priya');
  assert.deepEqual(tileSlugs(page.text), [pc.slug, pb.slug, pa.slug, pb.slug, pe.slug, pd.slug]);
  assert.deepEqual(tileSlugs((await w.page('/c/bottles')).text), [pc.slug, pb.slug], 'the category page shows the same order');
  assert.deepEqual(tileSlugs((await w.page('/reels?c=bottles')).text), [pc.slug, pb.slug], 'and so does the Reels tab');
  assert.deepEqual(tileSlugs((await w.page('/priya/bottles')).text), [pc.slug, pb.slug], 'and the shelf');

  // K-50: a reel turned off is gone on the next load.
  await w.db.platform.query('UPDATE reels SET active = false WHERE id = $1', [pc.id]);
  assert.deepEqual(tileSlugs((await w.page('/priya')).text), [pb.slug, pa.slug, pb.slug, pe.slug, pd.slug]);
});

test('K-51, K-63: a tile opens its landing page directly with the bio tags, and a product opens the seller’s own link', async (t) => {
  const w = await world(t);
  const product = await w.repos.products.create({ name: 'Steel bottle 1L', price: '499', active: 'on' });
  await w.db.platform.query(`UPDATE products SET external_url = 'https://www.amazon.in/dp/B0TEST', tags = ARRAY['insulated'] WHERE id = $1`, [product.id]);
  const reel = await addPage(w, { headline: 'Bottle demo', products: [product] });
  const kitchen = await shelf(w, 'Kitchen', [reel]);
  await w.db.platform.query('INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3)', [w.tenant.id, product.id, kitchen.id]);
  await save(w, { slug: 'priya', enabled: true });

  const page = await w.page('/priya');
  assert.match(page.text, new RegExp(`class="reel-tile" href="/r/${reel.slug}\\?utm_source=instagram&amp;utm_medium=bio"`));
  assert.doesNotMatch(page.text, /href="\/(l|go)\//);
  const landing = await w.page(`/r/${reel.slug}?utm_source=instagram&utm_medium=bio`);
  assert.equal(landing.status, 200, 'the tile’s address answers itself, with no redirect');

  const shelfPage = await w.page('/priya/kitchen');
  assert.match(shelfPage.text, new RegExp(`href="https://www\\.amazon\\.in/dp/B0TEST" rel="noopener" data-product="${product.id}"`), 'the real address, counted by the click beacon');
});

test('K-60: search finds this page’s products and reels, and nothing of another business', async (t) => {
  const w = await world(t);
  const leaf = await secondBusiness(w);
  const bottle = await w.repos.products.create({ name: 'Steel bottle 1L', price: '499', active: 'on' });
  const demo = await addPage(w, { headline: 'Morning routine', products: [bottle] });
  const captioned = await addPage(w, { headline: 'Unboxing', caption: 'My new steel bottle arrived' });
  const other = await addPage(w, { headline: 'Brass lamp' });
  const theirBottle = await leaf.repos.products.create({ name: 'Steel bottle by Leaf', price: '799', active: 'on' });
  const theirs = await addPage(leaf, { headline: 'Leaf steel bottle', caption: 'steel bottle', products: [theirBottle] });
  await save(w, { slug: 'priya', enabled: true });
  await save(leaf, { slug: 'priya', enabled: true });

  const found = await w.page('/priya?q=steel+bottle');
  assert.equal(found.status, 200);
  assert.deepEqual(tileSlugs(found.text).sort(), [demo.slug, captioned.slug].sort(), 'the product’s reel and the reel that says it');
  assert.match(found.text, /Steel bottle 1L/);
  assert.doesNotMatch(found.text, /Leaf/);
  assert.ok(!tileSlugs(found.text).includes(other.slug));
  assert.match(found.text, /<meta name="robots" content="noindex,follow">/, 'a search result is not a page to index');

  const theirPage = await leaf.page('/priya?q=steel+bottle');
  assert.deepEqual(tileSlugs(theirPage.text), [theirs.slug]);
  assert.doesNotMatch(theirPage.text, /Steel bottle 1L/);

  // What a shopper types is text, never a pattern or markup.
  const odd = await w.page(`/priya?q=${encodeURIComponent('%_<script>alert(1)</script>')}`);
  assert.equal(odd.status, 200);
  assert.doesNotMatch(odd.text, /<script>alert/);
  assert.deepEqual(tileSlugs(odd.text), []);
  assert.match(odd.text, /Nothing matched your search/);
  assert.equal((await w.page('/priya?q[]=a&q[]=b')).status, 200, 'an odd query is ignored');
});

test('K-61, K-62, K-53: a shelf link opens on that shelf, indexable, with its own title and preview; a crawler gets the tags', async (t) => {
  const w = await world(t);
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  const reel = await addPage(w, { headline: 'Kadai test', thumbnail: 'https://cdn.example/kadai.jpg' });
  const kitchen = await shelf(w, 'Kitchen', [reel]);
  await w.db.platform.query(`UPDATE categories SET description = 'Pots and pans' WHERE id = $1`, [kitchen.id]);
  await save(w, { slug: 'priya', enabled: true, displayName: 'Priya', bio: 'Cookware I use' });

  const crawler = { 'user-agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' };
  const home = await w.page('/priya', { headers: crawler });
  assert.equal(home.status, 200);
  for (const tag of ['og:url', 'og:title', 'og:description', 'og:image', 'og:type']) assert.match(home.text, new RegExp(`<meta property="${tag}" content="[^"]+">`), tag);
  assert.match(home.text, /<meta name="robots" content="index,follow">/);
  assert.match(home.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1(:\d+)?\/priya">/);
  assert.match(home.text, /<title>Priya · Zari &amp; Co<\/title>/);
  assert.doesNotMatch(home.text, /_t\/|data-k=/, 'a crawler’s fetch gets no counting script');

  const shelfPage = await w.page('/priya/kitchen', { headers: crawler });
  assert.equal(shelfPage.status, 200);
  assert.match(shelfPage.text, /<title>Kitchen · Priya<\/title>/);
  assert.match(shelfPage.text, /<meta property="og:description" content="Pots and pans">/);
  assert.match(shelfPage.text, /<meta property="og:image" content="https:\/\/cdn\.example\/kadai\.jpg">/);
  assert.match(shelfPage.text, /<link rel="canonical" href="http:\/\/127\.0\.0\.1(:\d+)?\/priya\/kitchen">/);
  assert.match(shelfPage.text, /<meta name="robots" content="index,follow">/);
  assert.match(shelfPage.text, /<a class="chip" href="\/priya\/kitchen" aria-current="page">Kitchen<\/a>/, 'the page opens on that shelf');
  assert.deepEqual(tileSlugs(shelfPage.text), [reel.slug]);
  assert.equal((await w.page('/priya/nope')).status, 404);

  // No visit is counted for the crawler, and one is for a shopper's browser.
  const visits = async () => (await w.db.platform.query(`SELECT count(*)::int AS n FROM traffic_events WHERE tenant_id = $1`, [w.tenant.id]))[0].n;
  assert.equal(await visits(), 0);
  const shopper = await w.page('/priya', { headers: BROWSER });
  assert.match(shopper.text, /data-k="creator" data-r="priya"/, 'a shopper’s page is counted as the creator page');
});

test('K-52, K-64: the Free plan page carries the badge; a paid page names the seller only', async (t) => {
  const w = await world(t, { plan: 'free' });
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  await addPage(w, { headline: 'Reel one' });
  const saved = await save(w, { slug: 'zari', enabled: true });
  assert.equal(saved.badge, true);
  const free = await w.page('/zari', { headers: BROWSER });
  assert.equal(free.status, 200);
  assert.match(free.text, /<span class="made-with">Made with Bhava<\/span>/);

  await setPlan(w, 't1');
  assert.equal((await w.api('/creator-page')).body.badge, false);
  for (const path of ['/zari', '/zari?q=reel', '/zari/_tiles?shelf=_more&offset=0', '/zari/missing-shelf']) {
    const res = await w.page(path, { headers: BROWSER });
    assert.doesNotMatch(res.text, /bhava/i, `${path} names the platform`);
    assert.doesNotMatch(JSON.stringify(res.headers), /bhava/i, `${path} headers name the platform`);
  }
  const paid = await w.page('/zari', { headers: BROWSER });
  assert.match(paid.text, /Zari &amp; Co/);
  assert.doesNotMatch(paid.text, /made-with"/);
});

test('the first 12 tiles are in the page and the rest load in pieces, each shelf from where it stopped', async (t) => {
  const w = await world(t);
  const pages = [];
  for (let i = 0; i < 15; i++) pages.push(await addPage(w, { headline: `Kitchen ${i + 1}` }));
  await shelf(w, 'Kitchen', pages);
  const loose = [];
  for (let i = 0; i < 3; i++) loose.push(await addPage(w, { headline: `Loose ${i + 1}` }));
  await save(w, { slug: 'priya', enabled: true });

  const page = await w.page('/priya');
  assert.deepEqual(tileSlugs(page.text), pages.slice(0, 12).map((p) => p.slug), 'twelve tiles, no more');
  assert.match(page.text, /data-more="\/priya\/_tiles\?shelf=kitchen&amp;offset=12" data-grid="grid-\d+"/);
  assert.match(page.text, /data-more="\/priya\/_tiles\?shelf=_more&amp;offset=0" data-grid="grid-more"/);

  const rest = await w.page('/priya/_tiles?shelf=kitchen&offset=12');
  assert.equal(rest.status, 200);
  assert.deepEqual(tileSlugs(rest.text), pages.slice(12).map((p) => p.slug));
  assert.equal(rest.headers['x-next'], undefined, 'nothing after these');
  assert.doesNotMatch(rest.text, /<script|<html/, 'a piece of the page, not a page');
  const first = await w.page('/priya/_tiles?shelf=kitchen&offset=0');
  assert.equal(first.headers['x-next'], '/priya/_tiles?shelf=kitchen&offset=12');
  const more = await w.page('/priya/_tiles?shelf=_more&offset=0');
  assert.deepEqual(tileSlugs(more.text), loose.toReversed().map((p) => p.slug), 'newest first');
  assert.equal((await w.page('/priya/_tiles?shelf=nope')).status, 404);
  assert.equal((await w.page('/priya/_tiles?shelf=kitchen&offset=-5')).status, 200, 'a bad offset starts from the top');

  // With no script, each shelf's own link shows it all.
  assert.equal(tileSlugs((await w.page('/priya/kitchen?all=1')).text).length, 15);
  assert.equal(tileSlugs((await w.page('/priya/kitchen')).text).length, 12);
});

test('one business’s page never shows or answers for another’s', async (t) => {
  const w = await world(t);
  const leaf = await secondBusiness(w);
  const mine = await addPage(w, { headline: 'Mine' });
  const theirs = await addPage(leaf, { headline: 'Theirs' });
  await shelf(w, 'Kitchen', [mine]);
  await shelf(leaf, 'Kitchen', [theirs]);
  await save(w, { slug: 'priya', enabled: true, displayName: 'Priya' });
  await save(leaf, { slug: 'leafy', enabled: true, displayName: 'Leafy' });

  assert.equal((await w.page('/leafy')).status, 404, 'their name on my address is nothing');
  assert.equal((await leaf.page('/priya')).status, 404);
  assert.deepEqual(tileSlugs((await w.page('/priya')).text), [mine.slug]);
  assert.deepEqual(tileSlugs((await leaf.page('/leafy')).text), [theirs.slug]);
  assert.deepEqual(tileSlugs((await leaf.page('/leafy/kitchen')).text), [theirs.slug]);
  assert.deepEqual(tileSlugs((await leaf.page('/leafy/_tiles?shelf=kitchen')).text), [theirs.slug]);
  assert.equal((await leaf.api('/creator-page')).body.displayName, 'Leafy');
  assert.equal((await w.api('/creator-page')).body.displayName, 'Priya');

  // Another business's uploaded file can't be my photo.
  const theirFile = await addMedia(leaf);
  assert.equal((await w.api('/creator-page', { method: 'PATCH', body: { photoUrl: `/media/${theirFile}` } })).status, 400);
});

test('only owners and managers read or change the page', async (t) => {
  const w = await world(t);
  assert.equal((await w.api('/creator-page', { token: 'nope' })).status, 401);
  const staff = await addTeamMember(w, w, { role: 'staff', permissions: ['catalog', 'customers'] });
  assert.equal((await staff.api('/creator-page')).status, 403);
  assert.equal((await staff.api('/creator-page', { method: 'PATCH', body: { slug: 'staff-made' } })).status, 403);
  const manager = await addTeamMember(w, w, { role: 'manager' });
  assert.equal((await manager.api('/creator-page', { method: 'PATCH', body: { slug: 'by-manager' } })).status, 200);
  assert.equal((await w.api('/creator-page')).body.slug, 'by-manager');
});
