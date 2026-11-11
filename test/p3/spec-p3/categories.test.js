// PRD 8.13: each category keeps its own ordered list of reels. Drag and drop saves the whole order at once; pins, schedules and
// auto-join rules sit on top of it; every buyer surface reads the one stored order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, MINUTE, addP3Shop, assertBranded404, assertNoLiveMarkup, creatorPage, eventually, need, noPlatformName, reelSlugsOf, sectionsOf, setTier, useP3World } from './kit.js';

const world = useP3World();

const ids = (items) => items.map((i) => i.pageId);
const live = (items) => items.filter((i) => i.live).map((i) => i.pageId);
const iso = (ms) => new Date(Date.now() + ms).toISOString();

async function reels(shop, names) {
  const out = {};
  for (const name of names) out[name] = await shop.page({ headline: `Reel ${name}` });
  return out;
}
const slugsOf = (map, names) => names.map((n) => map[n].slug);
const idsOf = (map, names) => names.map((n) => map[n].id);

async function categoryWith(shop, name, pages) {
  const category = await shop.category(name);
  await shop.addToCategory(category.id, pages.map((p) => p.id));
  return category;
}

const categoryPage = async (shop, category) => reelSlugsOf(need(await shop.open(`/c/${category.slug}`), 200, `The ${category.name} page`).text);
const reelsTab = async (shop, category) => reelSlugsOf(need(await shop.open(category ? `/reels?c=${category.slug}` : '/reels'), 200, 'The Reels tab').text);
const rows = (shop, categoryId) => shop.sql('SELECT page_id, position, pinned, pin_position FROM category_reels WHERE tenant_id = $1 AND category_id = $2 ORDER BY pinned DESC, pin_position NULLS LAST, position', [shop.tenantId, categoryId]);

// ---- K-43 ------------------------------------------------------------------------------------------------------------------

test('K-43: in "Bottles" (A, B, C) the owner drags C to the top: C, A, B is saved and shown on the next page load', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C']);
  const bottles = await categoryWith(shop, 'Bottles', [r.A, r.B, r.C]);
  assert.deepEqual(ids(await shop.sequence(bottles.id)), idsOf(r, ['A', 'B', 'C']), 'Added at the bottom, in order');
  assert.deepEqual(await categoryPage(shop, bottles), slugsOf(r, ['A', 'B', 'C']));

  const saved = await shop.setOrder(bottles.id, idsOf(r, ['C', 'A', 'B']));
  assert.deepEqual(ids(saved.items), idsOf(r, ['C', 'A', 'B']));
  assert.deepEqual(saved.items.map((i) => i.position), [0, 1, 2]);
  assert.deepEqual(ids(await shop.sequence(bottles.id)), idsOf(r, ['C', 'A', 'B']), 'Saved');
  assert.deepEqual(await categoryPage(shop, bottles), slugsOf(r, ['C', 'A', 'B']), 'Shown on the next page load');
  assert.deepEqual((await rows(shop, bottles.id)).map((x) => x.page_id), idsOf(r, ['C', 'A', 'B']));
  assert.equal((await shop.must('GET', `/categories/${bottles.id}`)).reelCount, 3);
});

test('K-43: saving writes the whole order at once: a list with a missing, repeated, unknown or foreign reel never loses or doubles one', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C']);
  const theirs = await other.page({ headline: 'Other business reel' });
  const theirCategory = await other.category('Theirs');
  const bottles = await categoryWith(shop, 'Bottles', [r.A, r.B, r.C]);
  const [a, b, c] = idsOf(r, ['A', 'B', 'C']);
  const bad = [
    { order: [c, a, b, b] }, { order: [c, a, b, 99999999] }, { order: [c, a, b, theirs.id] }, { order: [c, a, b], pinned: [theirs.id] },
    { order: [c, a], pinned: [b, b] }, { order: 'c,a,b' }, { order: [c, a, -1] }, { order: [c, a, 1.5] }, {},
  ];
  for (const body of bad) {
    const res = await shop.send('PUT', `/categories/${bottles.id}/reels`, body);
    assert.ok(res.status < 500, `${JSON.stringify(body)} answered ${res.status}`);
    const now = ids(await shop.sequence(bottles.id));
    assert.deepEqual([...now].sort((x, y) => x - y), [a, b, c].sort((x, y) => x - y), `After ${JSON.stringify(body)} the category holds ${now}`);
    assert.ok(!now.includes(theirs.id));
  }
  assert.equal((await shop.send('PUT', `/categories/${bottles.id}/reels`, { order: [c, a, b, theirs.id] })).status, 400);
  for (const [method, route, body] of [['GET', `/categories/${theirCategory.id}/reels`], ['PUT', `/categories/${theirCategory.id}/reels`, { order: [a] }], ['POST', `/categories/${theirCategory.id}/reels`, { pageId: a }], ['POST', `/categories/${bottles.id}/reels`, { pageId: theirs.id }], ['POST', `/categories/${theirCategory.id}/reels/pin`, { pageId: theirs.id }]]) {
    const res = await shop.send(method, route, body);
    assert.ok([400, 404].includes(res.status), `${method} ${route} across businesses answered ${res.status}`);
  }
  assert.deepEqual(await other.sequence(theirCategory.id), []);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM category_reels c JOIN reels r ON r.id = c.page_id WHERE c.tenant_id <> r.tenant_id'))[0].n, 0);
});

test('K-43: two saves at the same moment leave one complete order, never a mix with a reel lost or doubled', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C', 'D', 'E']);
  const category = await categoryWith(shop, 'Race', Object.values(r));
  const one = idsOf(r, ['E', 'D', 'C', 'B', 'A']);
  const two = idsOf(r, ['C', 'A', 'E', 'B', 'D']);
  const answers = await Promise.all([one, two, one, two].map((order) => shop.send('PUT', `/categories/${category.id}/reels`, { order })));
  for (const res of answers) assert.ok([200, 409].includes(res.status), `A concurrent save answered ${res.status}: ${res.text.slice(0, 150)}`);
  const final = ids(await shop.sequence(category.id));
  assert.ok(JSON.stringify(final) === JSON.stringify(one) || JSON.stringify(final) === JSON.stringify(two), `The final order ${final} is neither save`);
  const positions = (await rows(shop, category.id)).map((x) => x.position);
  assert.equal(new Set(positions).size, 5, `Positions: ${positions}`);
  const twice = await Promise.all([shop.send('POST', `/categories/${category.id}/reels`, { pageId: r.A.id }), shop.send('POST', `/categories/${category.id}/reels`, { pageId: r.A.id })]);
  for (const res of twice) assert.ok(res.status < 500);
  assert.equal(ids(await shop.sequence(category.id)).filter((id) => id === r.A.id).length, 1, 'Adding a reel twice doesn\'t list it twice');
});

// ---- K-44 ------------------------------------------------------------------------------------------------------------------

test('K-44: R is first in "Bottles" and fourth in "Kitchen"; reordering "Kitchen" leaves "Bottles" as it was', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['R', 'B1', 'B2', 'K1', 'K2', 'K3']);
  const bottles = await categoryWith(shop, 'Bottles', [r.R, r.B1, r.B2]);
  const kitchen = await categoryWith(shop, 'Kitchen', [r.K1, r.K2, r.K3, r.R]);
  assert.equal(ids(await shop.sequence(bottles.id))[0], r.R.id);
  assert.equal(ids(await shop.sequence(kitchen.id))[3], r.R.id);
  const before = await rows(shop, bottles.id);

  await shop.setOrder(kitchen.id, idsOf(r, ['R', 'K3', 'K1', 'K2']));
  assert.deepEqual(ids(await shop.sequence(kitchen.id)), idsOf(r, ['R', 'K3', 'K1', 'K2']), 'Kitchen changed');
  assert.deepEqual(ids(await shop.sequence(bottles.id)), idsOf(r, ['R', 'B1', 'B2']), 'Bottles did not');
  assert.deepEqual(await rows(shop, bottles.id), before, 'Not one row of Bottles was touched');
  await shop.setOrder(kitchen.id, idsOf(r, ['K1', 'K2', 'K3', 'R']));
  assert.deepEqual(await categoryPage(shop, bottles), slugsOf(r, ['R', 'B1', 'B2']), 'R is still first in Bottles');
  assert.deepEqual(await categoryPage(shop, kitchen), slugsOf(r, ['K1', 'K2', 'K3', 'R']), 'And fourth in Kitchen');

  await shop.must('POST', `/categories/${kitchen.id}/reels/remove`, { pageId: r.R.id });
  assert.deepEqual(ids(await shop.sequence(bottles.id)), idsOf(r, ['R', 'B1', 'B2']), 'Removing it from Kitchen leaves it in Bottles');
  await shop.must('DELETE', `/categories/${kitchen.id}`, undefined, 204);
  assert.deepEqual(ids(await shop.sequence(bottles.id)), idsOf(r, ['R', 'B1', 'B2']), 'Deleting Kitchen leaves Bottles alone');
  assert.equal((await shop.open(`/r/${r.K1.slug}`)).status, 200, 'And deletes no reel');
});

// ---- K-45 ------------------------------------------------------------------------------------------------------------------

test('K-45: pinning D, fourth of 6, shows it first with the other 5 in order; unpinned, D is fourth again', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C', 'D', 'E', 'F']);
  const category = await categoryWith(shop, 'Pins', Object.values(r));
  const pinned = await shop.must('POST', `/categories/${category.id}/reels/pin`, { pageId: r.D.id });
  assert.deepEqual(ids(pinned.items), idsOf(r, ['D', 'A', 'B', 'C', 'E', 'F']));
  assert.deepEqual(pinned.items.map((i) => i.pinned), [true, false, false, false, false, false]);
  assert.deepEqual(await categoryPage(shop, category), slugsOf(r, ['D', 'A', 'B', 'C', 'E', 'F']), 'Shoppers see D first');

  const unpinned = await shop.must('POST', `/categories/${category.id}/reels/unpin`, { pageId: r.D.id });
  assert.deepEqual(ids(unpinned.items), idsOf(r, ['A', 'B', 'C', 'D', 'E', 'F']), 'D is fourth again');
  assert.ok(unpinned.items.every((i) => !i.pinned));
  assert.deepEqual(await categoryPage(shop, category), slugsOf(r, ['A', 'B', 'C', 'D', 'E', 'F']));
});

test('K-45: pinned reels keep their own drag order above the rest; pinning twice, or a reel not in the category, changes nothing', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C', 'D', 'E', 'F']);
  const outsider = await shop.page({ headline: 'Not in this category' });
  const category = await categoryWith(shop, 'Pins', Object.values(r));
  await shop.must('POST', `/categories/${category.id}/reels/pin`, { pageId: r.D.id });
  await shop.must('POST', `/categories/${category.id}/reels/pin`, { pageId: r.F.id });
  assert.deepEqual(ids(await shop.sequence(category.id)), idsOf(r, ['D', 'F', 'A', 'B', 'C', 'E']), 'Pins in the order they were pinned');
  await shop.must('POST', `/categories/${category.id}/reels/pin`, { pageId: r.D.id });
  assert.deepEqual(ids(await shop.sequence(category.id)), idsOf(r, ['D', 'F', 'A', 'B', 'C', 'E']), 'Pinning again changes nothing');
  await shop.setOrder(category.id, idsOf(r, ['E', 'C', 'B', 'A']), idsOf(r, ['F', 'D']));
  assert.deepEqual(ids(await shop.sequence(category.id)), idsOf(r, ['F', 'D', 'E', 'C', 'B', 'A']), 'Pinned reels are dragged among themselves, the rest among themselves');
  const stray = await shop.send('POST', `/categories/${category.id}/reels/pin`, { pageId: outsider.id });
  assert.ok([400, 404].includes(stray.status), `Pinning a reel that isn't in the category answered ${stray.status}`);
  await shop.must('POST', `/categories/${category.id}/reels/unpin`, { pageId: r.F.id });
  await shop.must('POST', `/categories/${category.id}/reels/unpin`, { pageId: r.D.id });
  const end = ids(await shop.sequence(category.id));
  assert.deepEqual([...end].sort((x, y) => x - y), Object.values(r).map((p) => p.id).sort((x, y) => x - y), 'All six are still there, once each');
  assert.deepEqual(end.filter((id) => ![r.D.id, r.F.id].includes(id)), idsOf(r, ['E', 'C', 'B', 'A']), 'The others kept their order throughout');
  const second = await categoryWith(shop, 'Other', [r.A, r.D]);
  await shop.must('POST', `/categories/${category.id}/reels/pin`, { pageId: r.D.id });
  assert.deepEqual(ids(await shop.sequence(second.id)), idsOf(r, ['A', 'D']), 'A pin in one category is not a pin in another');
});

// ---- K-46 ------------------------------------------------------------------------------------------------------------------

test('K-46: a reel scheduled for a window in "Sale" is hidden there before and after it, and other categories still show it', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'E', 'B']);
  const sale = await categoryWith(shop, 'Sale', [r.A, r.E, r.B]);
  const everyday = await categoryWith(shop, 'Everyday', [r.E, r.A]);
  const schedule = (startsAt, endsAt) => shop.must('PUT', `/categories/${sale.id}/reels/schedule`, { pageId: r.E.id, startsAt, endsAt });

  const before = await schedule(iso(2 * HOUR), iso(10 * HOUR)); // the window opens in 2 hours: it is "before 10:00"
  const itemBefore = before.items.find((i) => i.pageId === r.E.id);
  assert.deepEqual([itemBefore.live, itemBefore.hiddenReason], [false, 'before_window']);
  assert.deepEqual(ids(before.items), idsOf(r, ['A', 'E', 'B']), 'It keeps its place while hidden');
  assert.deepEqual(await categoryPage(shop, sale), slugsOf(r, ['A', 'B']), 'Hidden in Sale; the others close up');
  assert.deepEqual(await categoryPage(shop, everyday), slugsOf(r, ['E', 'A']), 'Everyday still shows it');
  assert.equal((await shop.open(`/r/${r.E.slug}`)).status, 200, 'The reel\'s own page still opens');

  const during = await schedule(iso(-2 * HOUR), iso(6 * HOUR)); // inside the window
  assert.deepEqual(live(during.items), idsOf(r, ['A', 'E', 'B']));
  assert.deepEqual(await categoryPage(shop, sale), slugsOf(r, ['A', 'E', 'B']), 'Inside the window it is back in its place');

  const after = await schedule(iso(-10 * HOUR), iso(-2 * HOUR)); // the window closed 2 hours ago: it is "after 18:00"
  const itemAfter = after.items.find((i) => i.pageId === r.E.id);
  assert.deepEqual([itemAfter.live, itemAfter.hiddenReason], [false, 'after_window']);
  assert.deepEqual(await categoryPage(shop, sale), slugsOf(r, ['A', 'B']));
  assert.deepEqual(await reelsTab(shop, sale), slugsOf(r, ['A', 'B']), 'The Reels tab chip hides it too');
  assert.deepEqual(await categoryPage(shop, everyday), slugsOf(r, ['E', 'A']));
  assert.deepEqual(live(await shop.sequence(everyday.id)), idsOf(r, ['E', 'A']), 'No window was put on it in Everyday');

  const cleared = await schedule(null, null);
  assert.deepEqual(live(cleared.items), idsOf(r, ['A', 'E', 'B']), 'With the window cleared it shows again');
});

test('K-46: a window that ends before it starts, or is not a time, is refused; a window ending in a minute hides the reel on time', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'E']);
  const sale = await categoryWith(shop, 'Sale', [r.A, r.E]);
  const outsider = await shop.page();
  for (const body of [
    { pageId: r.E.id, startsAt: iso(HOUR), endsAt: iso(-HOUR) }, { pageId: r.E.id, startsAt: iso(HOUR), endsAt: iso(HOUR) }, { pageId: r.E.id, startsAt: 'tomorrow', endsAt: null },
    { pageId: r.E.id, startsAt: '2026-13-45T99:00:00Z', endsAt: null }, { pageId: r.E.id }, { pageId: outsider.id, startsAt: iso(-HOUR), endsAt: iso(HOUR) }, { pageId: r.E.id, startsAt: '10:00', endsAt: '18:00' },
  ]) {
    const res = await shop.send('PUT', `/categories/${sale.id}/reels/schedule`, body);
    assert.ok([400, 404].includes(res.status), `${JSON.stringify(body)} answered ${res.status}`);
  }
  assert.deepEqual(live(await shop.sequence(sale.id)), idsOf(r, ['A', 'E']), 'Nothing was scheduled');
  await shop.must('PUT', `/categories/${sale.id}/reels/schedule`, { pageId: r.E.id, startsAt: null, endsAt: iso(-MINUTE) });
  assert.deepEqual(await categoryPage(shop, sale), slugsOf(r, ['A']), 'An end time alone hides it once passed');
  await shop.must('PUT', `/categories/${sale.id}/reels/schedule`, { pageId: r.E.id, startsAt: iso(-MINUTE), endsAt: null });
  assert.deepEqual(await categoryPage(shop, sale), slugsOf(r, ['A', 'E']), 'A start time alone shows it once reached');
});

// ---- K-47 ------------------------------------------------------------------------------------------------------------------

async function joined(shop, categoryId, pageId) {
  return eventually(shop, async () => {
    const items = await shop.sequence(categoryId);
    return items.some((i) => i.pageId === pageId) ? items : null;
  }, { ms: 20_000 });
}

test('K-47: "Festive" has the rule hashtag #diwali, join at top; a new reel with #diwali joins first and the older reels move down by one', async () => {
  const shop = await addP3Shop(world);
  const old = await reels(shop, ['A', 'B']);
  const festive = await categoryWith(shop, 'Festive', [old.A, old.B]);
  const rule = await shop.must('POST', `/categories/${festive.id}/rules`, { match: 'hashtag', value: '#diwali', joinAt: 'top' }, 201);
  assert.deepEqual([rule.match, rule.joinAt, rule.active, rule.categoryId], ['hashtag', 'top', true, festive.id]);
  assert.match(rule.value, /^#?diwali$/i);
  assert.deepEqual(ids(await shop.sequence(festive.id)), idsOf(old, ['A', 'B']), 'A new rule adds no existing reel');

  const fresh = await shop.page({ headline: 'Diwali launch', caption: 'Lights are up! #Diwali #sale' });
  const items = await joined(shop, festive.id, fresh.id);
  assert.ok(items, 'The new reel joined Festive');
  assert.deepEqual(ids(items), [fresh.id, old.A.id, old.B.id], 'First, with the older reels moved down by one');
  assert.equal(items[0].joinedBy, 'rule');
  assert.deepEqual(items.slice(1).map((i) => i.joinedBy), ['owner', 'owner']);
  assert.deepEqual(await categoryPage(shop, festive), [fresh.slug, old.A.slug, old.B.slug], 'Shoppers see it first');

  const another = await shop.page({ headline: 'Second Diwali reel', caption: 'More #diwali' });
  assert.deepEqual(ids(await joined(shop, festive.id, another.id)), [another.id, fresh.id, old.A.id, old.B.id], 'The next one joins above it');
});

test('K-47: only the hashtag itself matches, only this business\'s reels, and a bottom rule joins last', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const old = await reels(shop, ['A']);
  const festive = await categoryWith(shop, 'Festive', [old.A]);
  const keyword = await categoryWith(shop, 'Gifts', [old.A]);
  await shop.must('POST', `/categories/${festive.id}/rules`, { match: 'hashtag', value: 'diwali', joinAt: 'bottom' }, 201);
  await shop.must('POST', `/categories/${keyword.id}/rules`, { match: 'caption_keyword', value: 'gift', joinAt: 'top' }, 201);
  const near = [];
  for (const caption of ['#diwalisale only', 'diwali without the hash', '#notdiwali', 'di#wali', '#DIWALI2026']) near.push(await shop.page({ caption }));
  const hit = await shop.page({ caption: 'A gift for #DIWALI!' });
  const theirs = await other.page({ caption: 'Their #diwali gift reel' });
  const items = await joined(shop, festive.id, hit.id);
  assert.ok(items, 'The matching reel joined');
  assert.deepEqual(ids(items), [old.A.id, hit.id], 'At the bottom, and none of the near misses');
  assert.deepEqual(ids(await joined(shop, keyword.id, hit.id)), [hit.id, old.A.id], 'A caption keyword rule joins it at the top of its own category');
  await shop.settle({ ms: 3000 });
  const all = [...ids(await shop.sequence(festive.id)), ...ids(await shop.sequence(keyword.id))];
  for (const page of near) assert.ok(!ids(items).includes(page.id), 'A near miss did not join');
  assert.ok(!all.includes(theirs.id), 'Another business\'s reel never joins');
  const theirCategory = await other.category('Festive');
  assert.deepEqual(await other.sequence(theirCategory.id), [], 'And this business\'s rule adds nothing to theirs');
});

test('K-47: a reel the owner removed is not added back by the same rule; a changed rule applies to new reels unless "Apply to existing" is tapped', async () => {
  const shop = await addP3Shop(world);
  const festive = await shop.category('Festive');
  const before = await shop.page({ caption: 'Old #holi reel' });
  const rule = await shop.must('POST', `/categories/${festive.id}/rules`, { match: 'hashtag', value: 'diwali', joinAt: 'top' }, 201);
  const fresh = await shop.page({ caption: 'New #diwali reel' });
  assert.ok(await joined(shop, festive.id, fresh.id));
  await shop.must('POST', `/categories/${festive.id}/reels/remove`, { pageId: fresh.id });
  await shop.settle({ ms: 3000 });
  assert.deepEqual(ids(await shop.sequence(festive.id)), [], 'Removed');
  assert.equal((await shop.must('POST', `/category-rules/${rule.id}/apply`)).added, 0, 'Applying the rule again doesn\'t bring it back');
  assert.deepEqual(ids(await shop.sequence(festive.id)), []);

  const changed = await shop.must('PATCH', `/category-rules/${rule.id}`, { value: 'holi' });
  assert.match(changed.value, /holi/i);
  await shop.settle({ ms: 3000 });
  assert.deepEqual(ids(await shop.sequence(festive.id)), [], 'A changed rule doesn\'t reach back to existing reels by itself');
  assert.equal((await shop.must('POST', `/category-rules/${rule.id}/apply`)).added, 1, '"Apply to existing reels" adds the old match');
  assert.deepEqual(ids(await shop.sequence(festive.id)), [before.id]);

  await shop.must('PATCH', `/category-rules/${rule.id}`, { active: false });
  const ignored = await shop.page({ caption: 'Another #holi reel' });
  await shop.settle({ ms: 3000 });
  assert.ok(!ids(await shop.sequence(festive.id)).includes(ignored.id), 'A rule switched off adds nothing');
  const other = await addP3Shop(world);
  for (const [method, route, body] of [['PATCH', `/category-rules/${rule.id}`, { active: true }], ['DELETE', `/category-rules/${rule.id}`], ['POST', `/category-rules/${rule.id}/apply`], ['GET', `/categories/${festive.id}/rules`]]) {
    assert.equal((await other.send(method, route, body)).status, 404, `Another business ${method} ${route}`);
  }
  for (const body of [{ match: 'hashtag', value: '' }, { match: 'regex', value: '.*' }, { match: 'product_category' }, { match: 'hashtag', value: 'x'.repeat(101) }, { match: 'product_category', productCategoryId: 99999999 }]) {
    const res = await shop.send('POST', `/categories/${festive.id}/rules`, body);
    assert.ok([400, 404].includes(res.status), `Rule ${JSON.stringify(body).slice(0, 60)} answered ${res.status}`);
  }
});

// ---- K-48 ------------------------------------------------------------------------------------------------------------------

test('K-48: "Bottles" set to X, Y, Z shows as X, Y, Z on the category page, the Reels tab chip, the creator page and through the API the apps read', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['Z', 'X', 'Y']);
  const bottles = await categoryWith(shop, 'Bottles', [r.Z, r.X, r.Y]);
  const creator = await creatorPage(shop);
  await shop.setOrder(bottles.id, idsOf(r, ['X', 'Y', 'Z']));
  const want = slugsOf(r, ['X', 'Y', 'Z']);
  const surfaces = async () => {
    const creatorHtml = need(await shop.open(`/${creator.slug}`), 200, 'The creator page').text;
    const shelf = sectionsOf(creatorHtml).find((s) => s.heading.includes('Bottles'));
    assert.ok(shelf, 'The creator page has a Bottles shelf');
    return {
      'the category page': await categoryPage(shop, bottles),
      'the Reels tab chip': await reelsTab(shop, bottles),
      'the creator page shelf': shelf.slugs,
      'the shelf\'s own link': reelSlugsOf(need(await shop.open(`/${creator.slug}/${bottles.slug}`), 200, 'The shelf link').text).filter((s) => want.includes(s)),
      'the API the apps read': (await shop.sequence(bottles.id)).filter((i) => i.live).map((i) => i.slug),
    };
  };
  for (const [where, got] of Object.entries(await surfaces())) assert.deepEqual(got, want, `${where} shows ${got}`);

  await shop.setOrder(bottles.id, idsOf(r, ['Z', 'X', 'Y']));
  const changedWithin60s = await eventually(shop, async () => Object.values(await surfaces()).every((got) => JSON.stringify(got) === JSON.stringify(slugsOf(r, ['Z', 'X', 'Y']))), { ms: 60_000, every: 2_000, settle: false });
  assert.ok(changedWithin60s, `Every surface follows a new order within 60 seconds: ${JSON.stringify(await surfaces())}`);
  assert.equal((await shop.sql('SELECT count(*)::int AS n FROM category_reels WHERE tenant_id = $1 AND category_id = $2', [shop.tenantId, bottles.id]))[0].n, 3, 'One stored order: three rows, no copies');
  for (const path of [`/c/${bottles.slug}`, `/reels?c=${bottles.slug}`, '/reels']) {
    const res = await shop.open(path);
    noPlatformName(path, res.text);
    noPlatformName(`${path} headers`, res.headers);
  }
});

test('K-48: the Reels tab has a chip per category in category order; "All" lists a reel in two categories once, at its first place', async () => {
  const shop = await addP3Shop(world);
  const other = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B', 'C', 'D']);
  const kitchen = await categoryWith(shop, 'Kitchen <script>alert(1)</script>', [r.C, r.A]);
  const bottles = await categoryWith(shop, 'Bottles', [r.A, r.B]);
  const empty = await shop.category('Empty shelf');
  const theirs = await other.page({ headline: 'Other business' });
  const theirCategory = await categoryWith(other, 'Bottles', [theirs]);
  await shop.must('PUT', '/categories/order', { ids: [bottles.id, kitchen.id, empty.id] }, 204);

  const html = need(await shop.open('/reels'), 200, 'The Reels tab').text;
  assertNoLiveMarkup(html, 'The Reels tab');
  const chipAt = (c) => html.indexOf(`c=${c.slug}`);
  assert.ok(chipAt(bottles) >= 0 && chipAt(kitchen) >= 0, 'A chip for each category');
  assert.ok(chipAt(bottles) < chipAt(kitchen), 'Chips follow the category order');
  const all = reelSlugsOf(html);
  assert.deepEqual(all.filter((s) => [r.A, r.B, r.C].map((p) => p.slug).includes(s)), slugsOf(r, ['A', 'B', 'C']), '"All" walks the categories in order; A appears once, where Bottles has it');
  assert.equal(all.filter((s) => s === r.A.slug).length, 1);
  assert.ok(!all.includes(theirs.slug), 'Never another business\'s reel');
  assert.deepEqual(await reelsTab(shop, kitchen), slugsOf(r, ['C', 'A']));

  await shop.must('PUT', '/categories/order', { ids: [kitchen.id, bottles.id, empty.id] }, 204);
  const flipped = reelSlugsOf(need(await shop.open('/reels'), 200, 'The Reels tab').text).filter((s) => [r.A, r.B, r.C].map((p) => p.slug).includes(s));
  assert.deepEqual(flipped, slugsOf(r, ['C', 'A', 'B']), 'A new category order changes "All"');
  for (const path of [`/c/${theirCategory.slug}-x`, '/c/no-such-category', `/reels?c=${'x'.repeat(300)}`, '/c/%3Cscript%3E']) {
    const res = await shop.open(path);
    assert.ok([200, 404].includes(res.status), `${path} answered ${res.status}`);
    if (res.status === 404) assertBranded404(res, shop, path);
    assertNoLiveMarkup(res.text, path);
    assert.ok(!res.text.includes(theirs.slug));
  }
  const bad = await shop.send('PUT', '/categories/order', { ids: [kitchen.id, theirCategory.id] });
  assert.ok([400, 404].includes(bad.status), `Ordering another business's category answered ${bad.status}`);
});

test('K-48: sequences come with tier 2: on tier 1 the ordering routes refuse with the plan reason', async () => {
  const shop = await addP3Shop(world);
  const r = await reels(shop, ['A', 'B']);
  const category = await categoryWith(shop, 'Tiered', [r.A, r.B]);
  await setTier(world, shop, 't1');
  const res = await shop.send('PUT', `/categories/${category.id}/reels`, { order: idsOf(r, ['B', 'A']) });
  assert.equal(res.status, 403, `Reordering on tier 1 answered ${res.status}`);
  assert.equal(res.json().reason, 'plan.not_included');
  await setTier(world, shop, 't2');
  assert.deepEqual(ids((await shop.setOrder(category.id, idsOf(r, ['B', 'A']))).items), idsOf(r, ['B', 'A']));
});
