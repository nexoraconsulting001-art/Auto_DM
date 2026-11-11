// PRD 8.13: each category's ordered reels, pins, windows and auto-join rules, and the buyer pages that show the order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRules } from '../../../src/modules/categories/index.js';
import { containsWords, hashtagsIn, matchesRule } from '../../../src/modules/categories/match.js';
import { allReels } from '../../../src/modules/categories/pages.js';
import { addCategory, addPage, secondBusiness, sequenceIds, setPlan, startWorld, tileSlugs } from './support.js';

async function world(t, options) {
  const w = await startWorld(options);
  t.after(() => w.close());
  return w;
}

/** A category holding `n` pages, added in order. */
async function filled(w, name, n, business = w) {
  const category = await addCategory(business, name);
  const pages = [];
  for (let i = 0; i < n; i++) {
    const page = await addPage(business, { headline: `${name} ${String.fromCharCode(65 + i)}` });
    pages.push(page);
    const res = await business.api(`/categories/${category.id}/reels`, { method: 'POST', body: { pageId: page.id } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  return { category, pages, ids: pages.map((p) => p.id) };
}

test('rules match whole words and hashtags, in any case', () => {
  assert.equal(containsWords('New Steel bottle in stock', 'steel'), true);
  assert.equal(containsWords('The steeler is here', 'steel'), false);
  assert.equal(containsWords('steel-bottle!', 'steel bottle'), false);
  assert.equal(containsWords('a .* b', '.*'), true, 'the phrase is text, never a pattern');
  assert.deepEqual([...hashtagsIn('Lights #Diwali #diwali2026 and #सेल')].sort(), ['diwali', 'diwali2026', 'सेल'].sort());
  assert.equal(matchesRule({ match: 'hashtag', value: '#DIWALI' }, { caption: 'Glow #diwali' }), true);
  assert.equal(matchesRule({ match: 'hashtag', value: 'diwali' }, { caption: 'Glow #diwali2026' }), false);
  assert.equal(matchesRule({ match: 'hashtag', value: '#' }, { caption: 'Glow # diwali' }), false);
  assert.equal(matchesRule({ match: 'product_category', product_category_id: 4 }, { productCategoryIds: [3, 4] }), true);
  assert.equal(matchesRule({ match: 'other', value: 'x' }, { caption: 'x' }), false);
});

test('the Reels tab All shows a reel in two categories once, at its first place', () => {
  const row = (id) => ({ page_id: id });
  const shelves = [{ items: [row(1), row(2)] }, { items: [row(2), row(3)] }];
  assert.deepEqual(allReels(shelves, [row(3), row(4)]).map((r) => r.page_id), [1, 2, 3, 4]);
});

test('K-43, K-44: the whole order is saved at once, and only that category changes', async (t) => {
  const w = await world(t);
  const bottles = await filled(w, 'Bottles', 3);
  const [a, b, c] = bottles.ids;
  const kitchen = await addCategory(w, 'Kitchen');
  for (const id of [b, c, a]) await w.api(`/categories/${kitchen.id}/reels`, { method: 'POST', body: { pageId: id } });

  const saved = await w.api(`/categories/${bottles.category.id}/reels`, { method: 'PUT', body: { order: [c, a, b] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.items.map((i) => i.pageId), [c, a, b]);
  assert.deepEqual(await sequenceIds(w, bottles.category.id), [c, a, b]);
  assert.deepEqual(await sequenceIds(w, kitchen.id), [b, c, a], 'the other category keeps its own order');

  const page = await w.page('/c/bottles');
  assert.equal(page.status, 200);
  assert.deepEqual(tileSlugs(page.text), [bottles.pages[2].slug, bottles.pages[0].slug, bottles.pages[1].slug]);

  // A list that isn't exactly the category's reels changes nothing.
  const stale = await w.api(`/categories/${bottles.category.id}/reels`, { method: 'PUT', body: { order: [c, a] } });
  assert.equal(stale.status, 409);
  const twice = await w.api(`/categories/${bottles.category.id}/reels`, { method: 'PUT', body: { order: [c, a, a] } });
  assert.equal(twice.status, 400);
  assert.deepEqual(await sequenceIds(w, bottles.category.id), [c, a, b]);

  const audit = await w.db.platform.query(`SELECT action, details FROM audit_log WHERE tenant_id = $1 AND action = 'category.reels_saved'`, [w.tenant.id]);
  assert.equal(audit.length, 1);
});

test('K-45: a pinned reel shows first and returns to its place when unpinned', async (t) => {
  const w = await world(t);
  const { category, ids } = await filled(w, 'Bottles', 6);
  const d = ids[3];
  const pinned = await w.api(`/categories/${category.id}/reels/pin`, { method: 'POST', body: { pageId: d } });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.deepEqual(pinned.body.items.map((i) => i.pageId), [d, ids[0], ids[1], ids[2], ids[4], ids[5]]);
  assert.equal(pinned.body.items[0].pinned, true);

  // A second pin goes above the first; the pinned reels have their own order.
  await w.api(`/categories/${category.id}/reels/pin`, { method: 'POST', body: { pageId: ids[5] } });
  assert.deepEqual(await sequenceIds(w, category.id), [ids[5], d, ids[0], ids[1], ids[2], ids[4]]);
  const reordered = await w.api(`/categories/${category.id}/reels`, { method: 'PUT', body: { pinned: [d, ids[5]], order: [ids[0], ids[1], ids[2], ids[4]] } });
  assert.deepEqual(reordered.body.items.map((i) => i.pageId), [d, ids[5], ids[0], ids[1], ids[2], ids[4]]);

  await w.api(`/categories/${category.id}/reels/unpin`, { method: 'POST', body: { pageId: ids[5] } });
  const unpinned = await w.api(`/categories/${category.id}/reels/unpin`, { method: 'POST', body: { pageId: d } });
  assert.deepEqual(unpinned.body.items.map((i) => i.pageId), ids, 'both are back where they were');
  assert.equal(unpinned.body.items.every((i) => !i.pinned && i.pinPosition === null), true);

  const missing = await w.api(`/categories/${category.id}/reels/pin`, { method: 'POST', body: { pageId: 999999 } });
  assert.equal(missing.status, 404);
});

test('K-46: a window hides a reel in that category only, and the others close up', async (t) => {
  let now = Date.parse('2026-11-11T04:00:00Z');
  const w = await world(t, { overrides: { pagesNow: () => now } });
  const sale = await filled(w, 'Sale', 3);
  const other = await addCategory(w, 'Kitchen');
  const e = sale.pages[1];
  await w.api(`/categories/${other.id}/reels`, { method: 'POST', body: { pageId: e.id } });

  const set = await w.api(`/categories/${sale.category.id}/reels/schedule`, { method: 'PUT', body: { pageId: e.id, startsAt: '2026-11-11T10:00:00+05:30', endsAt: '2026-11-11T18:00:00+05:30' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const item = () => w.api(`/categories/${sale.category.id}/reels`).then((r) => r.body.items.find((i) => i.pageId === e.id));

  assert.equal((await item()).hiddenReason, 'before_window'); // 09:30 IST
  assert.deepEqual(tileSlugs((await w.page('/c/sale')).text), [sale.pages[0].slug, sale.pages[2].slug]);
  assert.deepEqual(tileSlugs((await w.page('/c/kitchen')).text), [e.slug], 'the other category still shows it');

  now = Date.parse('2026-11-11T06:00:00Z'); // 11:30 IST
  assert.equal((await item()).live, true);
  assert.deepEqual(tileSlugs((await w.page('/c/sale')).text), sale.pages.map((p) => p.slug), 'it is back in its place');

  now = Date.parse('2026-11-11T12:30:00Z'); // 18:00 IST exactly: the window has ended
  assert.equal((await item()).hiddenReason, 'after_window');
  assert.deepEqual(tileSlugs((await w.page('/c/sale')).text), [sale.pages[0].slug, sale.pages[2].slug]);

  const backwards = await w.api(`/categories/${sale.category.id}/reels/schedule`, { method: 'PUT', body: { pageId: e.id, startsAt: '2026-11-12T10:00:00Z', endsAt: '2026-11-11T10:00:00Z' } });
  assert.equal(backwards.status, 400);
  const cleared = await w.api(`/categories/${sale.category.id}/reels/schedule`, { method: 'PUT', body: { pageId: e.id, startsAt: null, endsAt: null } });
  assert.equal(cleared.body.items.find((i) => i.pageId === e.id).live, true);
});

test('only live reels show, and one that goes offline keeps its place', async (t) => {
  const w = await world(t);
  const { category, pages, ids } = await filled(w, 'Bottles', 3);
  await w.db.platform.query('UPDATE reels SET active = false WHERE id = $1', [ids[0]]);
  await w.db.platform.query('UPDATE products SET active = false WHERE id = $1', [pages[1].products[0].id]);

  const seller = await w.api(`/categories/${category.id}/reels`);
  assert.deepEqual(seller.body.items.map((i) => [i.pageId, i.hiddenReason]), [[ids[0], 'inactive'], [ids[1], 'no_active_products'], [ids[2], '']]);
  assert.deepEqual(tileSlugs((await w.page('/c/bottles')).text), [pages[2].slug]);

  await w.db.platform.query('UPDATE reels SET active = true WHERE id = $1', [ids[0]]);
  await w.db.platform.query('UPDATE products SET active = true WHERE id = $1', [pages[1].products[0].id]);
  assert.deepEqual(tileSlugs((await w.page('/c/bottles')).text), pages.map((p) => p.slug));
});

test('K-47: a rule adds a matching new reel at the top, never re-adds one the owner removed, and a change applies to new reels only', async (t) => {
  const w = await world(t);
  const festive = await filled(w, 'Festive', 2);
  const id = festive.category.id;
  const before = await addPage(w, { headline: 'Old lights', caption: 'From last year #diwali' });

  const made = await w.api(`/categories/${id}/rules`, { method: 'POST', body: { match: 'hashtag', value: '#Diwali', joinAt: 'top' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const rule = made.body;

  const fresh = await addPage(w, { headline: 'New lights', caption: 'Glow up #DIWALI' });
  const other = await addPage(w, { headline: 'Plain', caption: 'Nothing festive, #diwali2026' });
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 1);
  assert.deepEqual(await sequenceIds(w, id), [fresh.id, ...festive.ids], 'the new reel is first; the reel made before the rule and the near miss stay out');
  const joined = (await w.api(`/categories/${id}/reels`)).body.items[0];
  assert.equal(joined.joinedBy, 'rule');
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 0, 'running again adds nothing');

  // The owner removes it: the same rule does not add it back, now or when applied to existing reels.
  const removed = await w.api(`/categories/${id}/reels/remove`, { method: 'POST', body: { pageId: fresh.id } });
  assert.deepEqual(removed.body.items.map((i) => i.pageId), festive.ids);
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 0);
  const applied = await w.api(`/category-rules/${rule.id}/apply`, { method: 'POST' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.added, 1, 'only the older reel joins; the removed one stays out');
  assert.deepEqual(await sequenceIds(w, id), [before.id, ...festive.ids]);
  assert.equal((await sequenceIds(w, id)).includes(other.id), false);

  // A changed rule looks at reels made after the change only.
  const plain = await addPage(w, { headline: 'Brass lamp', caption: 'A lamp in brass' });
  const changed = await w.api(`/category-rules/${rule.id}`, { method: 'PATCH', body: { value: 'brass' } });
  assert.equal(changed.status, 200);
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 0, 'a hashtag rule: "brass" as a word is not #brass');
  const tagged = await addPage(w, { headline: 'Brass bowl', caption: 'Shiny #brass' });
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 1);
  assert.equal((await sequenceIds(w, id))[0], tagged.id);
  assert.equal((await sequenceIds(w, id)).includes(plain.id), false);

  // The owner adding it by hand clears the removal.
  await w.api(`/categories/${id}/reels`, { method: 'POST', body: { pageId: fresh.id, at: 'bottom' } });
  assert.equal((await sequenceIds(w, id)).at(-1), fresh.id);

  assert.equal((await w.api(`/category-rules/${rule.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await w.api(`/categories/${id}/rules`)).body.items.length, 0);
  assert.equal((await sequenceIds(w, id)).includes(tagged.id), true, 'removing a rule leaves its reels in place');
});

test('a rule can match a caption keyword or a linked product’s category', async (t) => {
  const w = await world(t);
  const steel = await addCategory(w, 'Steel');
  const kitchen = await addCategory(w, 'Kitchen things');
  const keyword = await w.api(`/categories/${steel.id}/rules`, { method: 'POST', body: { match: 'caption_keyword', value: 'steel bottle' } });
  assert.equal(keyword.status, 201);
  const byProduct = await w.api(`/categories/${kitchen.id}/rules`, { method: 'POST', body: { match: 'product_category', productCategoryId: steel.id, joinAt: 'top' } });
  assert.equal(byProduct.status, 201, JSON.stringify(byProduct.body));
  assert.equal((await w.api(`/categories/${kitchen.id}/rules`, { method: 'POST', body: { match: 'product_category', productCategoryId: 999999 } })).status, 400);
  assert.equal((await w.api(`/categories/${kitchen.id}/rules`, { method: 'POST', body: { match: 'hashtag', value: '' } })).status, 400);

  const product = await w.repos.products.create({ name: 'Flask', price: '799', active: 'on' });
  await w.db.platform.query('INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3)', [w.tenant.id, product.id, steel.id]);
  const a = await addPage(w, { headline: 'One', caption: 'Our new STEEL bottle is here' });
  const b = await addPage(w, { headline: 'Two', caption: 'A flask', products: [product] });
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 2);
  assert.deepEqual(await sequenceIds(w, steel.id), [a.id]);
  assert.deepEqual(await sequenceIds(w, kitchen.id), [b.id]);
});

test('K-48: the category page and the Reels tab read the one stored order', async (t) => {
  const w = await world(t);
  const bottles = await filled(w, 'Bottles', 3);
  const kitchen = await addCategory(w, 'Kitchen');
  const [x, y, z] = bottles.pages;
  const extra = await addPage(w, { headline: 'Kitchen only' });
  for (const id of [z.id, extra.id]) await w.api(`/categories/${kitchen.id}/reels`, { method: 'POST', body: { pageId: id } });
  const loose = await addPage(w, { headline: 'No category' });
  await w.api(`/categories/${bottles.category.id}/reels`, { method: 'PUT', body: { order: [y.id, z.id, x.id] } });

  const wanted = [y.slug, z.slug, x.slug];
  assert.deepEqual(tileSlugs((await w.page('/c/bottles')).text), wanted);
  const chip = await w.page('/reels?c=bottles');
  assert.equal(chip.status, 200);
  assert.deepEqual(tileSlugs(chip.text), wanted);

  const all = await w.page('/reels');
  assert.deepEqual(tileSlugs(all.text), [...wanted, extra.slug, loose.slug], 'categories in order, a shared reel once, uncategorised reels last');
  const chips = [...all.text.matchAll(/class="chip" href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual(chips, ['/reels', '/reels?c=bottles', '/reels?c=kitchen']);

  // The category order is the chip order.
  const reorder = await w.api('/categories/order', { method: 'PUT', body: { ids: [kitchen.id, bottles.category.id] } });
  assert.equal(reorder.status, 204);
  assert.deepEqual(tileSlugs((await w.page('/reels')).text), [z.slug, extra.slug, y.slug, x.slug, loose.slug]);
  assert.equal((await w.api('/categories/order', { method: 'PUT', body: { ids: [kitchen.id] } })).status, 409);

  const list = await w.api('/categories');
  assert.deepEqual(list.body.items.map((c) => [c.name, c.reelCount]), [['Kitchen', 2], ['Bottles', 3]]);

  assert.equal((await w.page('/reels?c=nope')).status, 404);
  assert.equal((await w.page('/c/nope')).status, 404);
  assert.deepEqual(await w.repos.categorySequences.moreReelsFor(x.id, { limit: 6 }).then((rows) => rows.map((r) => r.page_id)), [y.id, z.id]);
});

test('buyer pages carry the seller’s brand only, and every tile is a direct link', async (t) => {
  const w = await world(t);
  await w.repos.settings.update({ store_name: 'Zari & Co' });
  await filled(w, 'Bottles', 2);
  for (const path of ['/c/bottles', '/reels', '/reels?c=bottles', '/c/missing']) {
    const res = await w.page(path);
    assert.doesNotMatch(res.text, /bhava/i, `${path} names the platform`);
    assert.doesNotMatch(JSON.stringify(res.headers), /bhava/i, `${path} headers name the platform`);
    assert.match(res.text, /Zari &amp; Co/);
    assert.doesNotMatch(res.text, /href="\/(l|go)\//, `${path} links through a hop`);
    assert.match(res.text, /<meta name="robots" content="noindex,follow">/);
  }
});

test('one business never sees or changes another’s sequences', async (t) => {
  const w = await world(t);
  const mine = await filled(w, 'Bottles', 2);
  const leaf = await secondBusiness(w);
  const theirs = await filled(w, 'Bottles', 2, leaf);

  // Reading and changing the other business's category is a 404, whatever the action.
  const id = theirs.category.id;
  const page = theirs.ids[0];
  const tries = [
    ['GET', `/categories/${id}/reels`],
    ['PUT', `/categories/${id}/reels`, { order: theirs.ids.toReversed() }],
    ['POST', `/categories/${id}/reels`, { pageId: mine.ids[0] }],
    ['POST', `/categories/${id}/reels/remove`, { pageId: page }],
    ['POST', `/categories/${id}/reels/pin`, { pageId: page }],
    ['POST', `/categories/${id}/reels/unpin`, { pageId: page }],
    ['PUT', `/categories/${id}/reels/schedule`, { pageId: page, startsAt: null, endsAt: '2020-01-01T00:00:00Z' }],
    ['GET', `/categories/${id}/rules`],
    ['POST', `/categories/${id}/rules`, { match: 'hashtag', value: 'x' }],
  ];
  for (const [method, path, body] of tries) {
    const res = await w.api(path, { method, body });
    assert.equal(res.status, 404, `${method} ${path} answered ${res.status}`);
  }
  // My category can't take their page, and a rule can't point at their category.
  assert.equal((await w.api(`/categories/${mine.category.id}/reels`, { method: 'POST', body: { pageId: page } })).status, 404);
  assert.equal((await w.api(`/categories/${mine.category.id}/rules`, { method: 'POST', body: { match: 'product_category', productCategoryId: id } })).status, 400);
  const rule = (await leaf.api(`/categories/${id}/rules`, { method: 'POST', body: { match: 'hashtag', value: 'x' } })).body;
  for (const [method, path, body] of [['PATCH', `/category-rules/${rule.id}`, { active: false }], ['DELETE', `/category-rules/${rule.id}`], ['POST', `/category-rules/${rule.id}/apply`]]) {
    assert.equal((await w.api(path, { method, body })).status, 404, `${method} ${path}`);
  }
  assert.equal((await w.api('/categories/order', { method: 'PUT', body: { ids: [mine.category.id, id] } })).status, 409);

  assert.deepEqual(await sequenceIds(leaf, id), theirs.ids, 'nothing of theirs changed');
  // Same slug, two hosts: each shows its own reels.
  assert.deepEqual(tileSlugs((await w.page('/c/bottles')).text), mine.pages.map((p) => p.slug));
  assert.deepEqual(tileSlugs((await leaf.page('/c/bottles')).text), theirs.pages.map((p) => p.slug));
  assert.deepEqual(tileSlugs((await leaf.page('/reels')).text), theirs.pages.map((p) => p.slug));

  // The rules job joins each business's own reels to its own categories.
  await w.api(`/categories/${mine.category.id}/rules`, { method: 'POST', body: { match: 'hashtag', value: 'x' } });
  const theirNew = await addPage(leaf, { headline: 'Theirs', caption: 'tagged #x' });
  const myNew = await addPage(w, { headline: 'Mine', caption: 'tagged #x' });
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 2);
  assert.deepEqual(await sequenceIds(w, mine.category.id), [...mine.ids, myNew.id]);
  assert.deepEqual(await sequenceIds(leaf, id), [...theirs.ids, theirNew.id]);
});

test('ordering is tier 2: below it changes are refused and the buyer pages are not served by this module', async (t) => {
  const w = await world(t);
  const { category, ids } = await filled(w, 'Bottles', 2);
  await setPlan(w, 't1');
  const save = await w.api(`/categories/${category.id}/reels`, { method: 'PUT', body: { order: ids.toReversed() } });
  assert.equal(save.status, 403);
  assert.equal(save.body.code, 'forbidden');
  assert.equal((await w.api(`/categories/${category.id}/rules`, { method: 'POST', body: { match: 'hashtag', value: 'x' } })).status, 403);
  assert.equal((await w.api(`/categories/${category.id}/reels`)).status, 200, 'reading is never refused');
  assert.deepEqual(await sequenceIds(w, category.id), ids);
  assert.equal(tileSlugs((await w.page('/c/bottles')).text).length, 0, 'the sequence page is not shown below tier 2');
  await addPage(w, { headline: 'Tagged', caption: '#x' });
  await setPlan(w, 't2');
  await w.api(`/categories/${category.id}/rules`, { method: 'POST', body: { match: 'hashtag', value: 'x' } });
  await setPlan(w, 't1');
  await addPage(w, { headline: 'Tagged later', caption: '#x' });
  assert.equal(await runRules({ db: w.db, repos: w.platform }), 0, 'rules rest while the plan does not include them');
});
