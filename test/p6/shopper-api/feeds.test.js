// What the shopper app browses (PRD 10.7, 10.11): the bootstrap, home, catalog, a product, categories and their reels in the
// stored order (P-65), the Reels tab, a landing page that records nothing (P-51), and the policies. Seller's brand only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  AppBootstrap, AppCategory, AppCategoryCard, AppHome, AppLanding, AppPolicy, AppProduct, AppProductCard, AppReels,
} from '../../../src/contracts/store-routes.js';
import { withTenant } from '../../../src/tenancy.js';
import { appWorld, assertBrandOnly, guestApp, json, product, q, withSizes } from './support.js';

const page = (item) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** A reel with these products in a category, as the owner made it. Returns its page id and slug. */
async function reel(w, { mediaId, headline, productIds }) {
  return withTenant(w.app.tenant, async () => {
    await w.app.repos.reels.save(mediaId, { headline, keywords: 'LINK', productIds, active: 'on' });
    await w.app.db.query(`UPDATE reels SET media_type = 'VIDEO', media_url = $3, thumbnail_url = $4 WHERE tenant_id = $1 AND ig_media_id = $2`,
      [w.app.tenant.id, mediaId, `https://cdn.example.com/${mediaId}.mp4`, `https://cdn.example.com/${mediaId}.jpg`]);
    const [row] = await w.app.db.query('SELECT id, slug FROM reels WHERE tenant_id = $1 AND ig_media_id = $2', [w.app.tenant.id, mediaId]);
    return row;
  });
}

test('the bootstrap carries the app’s own name, colours, links and features, and never the platform', async () => {
  const w = await appWorld();
  try {
    await w.app.db.platform.query(`UPDATE app_configs SET app_name = 'Neel', colors = '{"primary":"#3b2fc9","bad":"red"}', heading_font = 'Unbounded', support_email = 'care@neel.example' WHERE tenant_id = $1`, [w.app.tenant.id]);
    const a = await guestApp(w);
    const boot = await json(await a.fetch('/api/store/app/bootstrap'));
    assert.equal(boot.status, 200);
    AppBootstrap.parse(boot.body);
    assert.equal(boot.body.name, 'Neel');
    assert.equal(boot.body.theme.colors.primary, '#3B2FC9', 'app_configs over the brand kit');
    assert.equal(boot.body.theme.colors.bad, undefined, 'only real colours');
    assert.equal(boot.body.theme.headingFont, 'Unbounded');
    assert.equal(boot.body.supportEmail, 'care@neel.example');
    assert.equal(boot.body.links.privacy, 'https://shop.test/policies/privacy', 'app_configs.privacy_url');
    assert.match(boot.body.links.terms, /\/policies\/terms$/);
    assert.deepEqual(boot.body.push, { android: false, ios: false });
    assert.equal(boot.body.minVersion, '0.0.0');
    assert.equal(boot.body.signIn.whatsapp, true);
    assert.equal(boot.body.signIn.google, true);
    assert.equal(boot.headers.get('cache-control'), 'no-store');
    assertBrandOnly(boot.body, 'bootstrap');
  } finally {
    await w.close();
  }
});

test('home, the catalog and a product: today’s prices, only what is live, the seller’s words', async () => {
  const w = await appWorld();
  try {
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000, stock: 5, mrpPaise: 60000 });
    const kurta = await product(w.app, { name: 'Cotton kurta', pricePaise: 120000, stock: 3 });
    const sizes = await withSizes(w.app, kurta.id, [{ value: 'S', pricePaise: 120000, stock: 2 }, { value: 'M', pricePaise: 130000, stock: 0 }]);
    const hidden = await product(w.app, { name: 'Old stock', pricePaise: 1000, stock: 5 });
    await q(w.app, 'UPDATE products SET active = false WHERE tenant_id = $1 AND id = $2', [w.app.tenant.id, hidden.id]);
    await reel(w, { mediaId: '1800000000000001', headline: 'Diwali lamps', productIds: [lamp.id] });
    const a = await guestApp(w);

    const home = await json(await a.fetch('/api/store/app/home'));
    assert.equal(home.status, 200, JSON.stringify(home.body));
    AppHome.parse(home.body);
    assert.ok(home.body.products.some((p) => p.id === lamp.id));
    assert.ok(!home.body.products.some((p) => p.id === hidden.id), 'an inactive product is absent');
    assert.equal(home.body.reels[0].title, 'Diwali lamps');
    assert.equal(home.body.reels[0].productCount, 1);
    assertBrandOnly(home.body, 'home');

    const list = await json(await a.fetch('/api/store/app/catalog?sort=price-asc&limit=1'));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    page(AppProductCard).parse(list.body);
    assert.deepEqual(list.body.items.map((p) => p.name), ['Brass lamp']);
    assert.equal(list.body.items[0].pricePaise, 50000);
    assert.equal(list.body.items[0].comparePaise, 60000);
    assert.equal(list.body.nextCursor, '2');
    const next = await json(await a.fetch(`/api/store/app/catalog?sort=price-asc&limit=1&cursor=${list.body.nextCursor}`));
    assert.deepEqual(next.body.items.map((p) => p.name), ['Cotton kurta']);
    assert.equal(next.body.nextCursor, null);
    const search = await json(await a.fetch('/api/store/app/catalog?q=kurta'));
    assert.deepEqual(search.body.items.map((p) => p.name), ['Cotton kurta']);
    assert.equal((await a.fetch('/api/store/app/catalog?price=1')).status, 400, 'an unknown query field is refused');
    assert.equal((await a.fetch('/api/store/app/catalog?cursor=../../x')).status, 400);

    // The price changes in the catalog: the app shows today's at once.
    await q(w.app, 'UPDATE products SET price_paise = 45000 WHERE tenant_id = $1 AND id = $2', [w.app.tenant.id, lamp.id]);
    const detail = await json(await a.fetch(`/api/store/app/products/${lamp.slug}`));
    assert.equal(detail.status, 200);
    AppProduct.parse(detail.body);
    assert.equal(detail.body.pricePaise, 45000);
    assert.equal(detail.body.reels.length, 1);
    assert.equal(detail.body.reels[0].videoUrl, 'https://cdn.example.com/1800000000000001.mp4');
    const kurtaDetail = await json(await a.fetch(`/api/store/app/products/${kurta.slug}`));
    assert.deepEqual(kurtaDetail.body.variants.map((v) => [v.id, v.option, v.pricePaise, v.inStock]), [[sizes.S, 'S', 120000, true], [sizes.M, 'M', 130000, false]]);
    assert.deepEqual(kurtaDetail.body.options, [{ name: 'Size', values: ['S', 'M'] }]);
    assert.equal(kurtaDetail.body.maxQty, 10);
    assert.equal((await a.fetch(`/api/store/app/products/${hidden.slug}`)).status, 404, 'not live, not there');
    assert.equal((await a.fetch('/api/store/app/products/NOT_A_SLUG')).status, 404);
  } finally {
    await w.close();
  }
});

test('P-65: the app’s category screen shows the pinned reel first, then the set order; the Reels tab agrees', async () => {
  const w = await appWorld();
  try {
    const p1 = await product(w.app, { name: 'Steel bottle', pricePaise: 70000, stock: 9 });
    const [category] = await q(w.app, `INSERT INTO categories (tenant_id, name, slug, visible) VALUES ($1, 'Kitchen', 'kitchen', true) RETURNING id`, [w.app.tenant.id]);
    await q(w.app, 'INSERT INTO product_categories (tenant_id, product_id, category_id) VALUES ($1, $2, $3)', [w.app.tenant.id, p1.id, category.id]);
    const first = await reel(w, { mediaId: '1800000000000011', headline: 'Morning chai', productIds: [p1.id] });
    const second = await reel(w, { mediaId: '1800000000000012', headline: 'Lunch box', productIds: [p1.id] });
    const third = await reel(w, { mediaId: '1800000000000013', headline: 'Festive table', productIds: [p1.id] });
    const later = await reel(w, { mediaId: '1800000000000014', headline: 'Next month', productIds: [p1.id] });
    await withTenant(w.app.tenant, async () => {
      for (const r of [first, second, third, later]) await w.app.repos.categorySequences.add(category.id, r.id);
      await w.app.repos.categorySequences.pin(category.id, third.id);
      await w.app.repos.categorySequences.schedule(category.id, later.id, { startsAt: new Date(Date.now() + 30 * 86_400_000), endsAt: null });
    });
    const a = await guestApp(w);

    const shown = await json(await a.fetch('/api/store/app/categories/kitchen'));
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    AppCategory.parse(shown.body);
    assert.deepEqual(shown.body.reels.map((r) => [r.title, r.pinned]), [['Festive table', true], ['Morning chai', false], ['Lunch box', false]], 'pinned first, then the set order, the later window left out');
    assert.deepEqual(shown.body.products.items.map((p) => p.name), ['Steel bottle']);
    assertBrandOnly(shown.body, 'category');

    const cats = await json(await a.fetch('/api/store/app/categories'));
    z.object({ items: z.array(AppCategoryCard) }).parse(cats.body);
    assert.deepEqual(cats.body.items.map((c) => c.slug), ['kitchen']);

    const reels = await json(await a.fetch('/api/store/app/reels?category=kitchen&limit=2'));
    AppReels.parse(reels.body);
    assert.deepEqual(reels.body.items.map((r) => r.title), ['Festive table', 'Morning chai']);
    assert.equal(reels.body.nextCursor, '2');
    const rest = await json(await a.fetch('/api/store/app/reels?category=kitchen&limit=2&cursor=2'));
    assert.deepEqual(rest.body.items.map((r) => r.title), ['Lunch box']);
    assert.deepEqual(reels.body.chips.map((c) => c.slug), ['kitchen']);
    assert.equal((await a.fetch('/api/store/app/reels?category=nothing')).status, 404);

    // A hidden category is not found, as on the web.
    await q(w.app, 'UPDATE categories SET visible = false WHERE tenant_id = $1 AND id = $2', [w.app.tenant.id, category.id]);
    assert.equal((await a.fetch('/api/store/app/categories/kitchen')).status, 404);
  } finally {
    await w.close();
  }
});

test('P-51: reading a landing page in the app records nothing; its products are today’s', async () => {
  const w = await appWorld();
  try {
    const lamp = await product(w.app, { name: 'Brass lamp', pricePaise: 50000, stock: 5 });
    const page1 = await reel(w, { mediaId: '1800000000000021', headline: 'Diwali lamps', productIds: [lamp.id] });
    await reel(w, { mediaId: '1800000000000022', headline: 'More lamps', productIds: [lamp.id] });
    const a = await guestApp(w);
    const visits = async () => (await w.app.db.platform.query('SELECT count(*)::int AS n FROM visits'))[0].n;
    const before = await visits();
    const landing = await json(await a.fetch(`/api/store/app/landing/${page1.slug}`));
    assert.equal(landing.status, 200, JSON.stringify(landing.body));
    AppLanding.parse(landing.body);
    assert.equal(landing.body.title, 'Diwali lamps');
    assert.deepEqual(landing.body.media, { kind: 'video', url: 'https://cdn.example.com/1800000000000021.mp4', poster: 'https://cdn.example.com/1800000000000021.jpg' });
    assert.deepEqual(landing.body.products.map((p) => [p.name, p.pricePaise]), [['Brass lamp', 50000]]);
    assert.deepEqual(landing.body.moreReels.map((r) => r.title), ['More lamps']);
    assertBrandOnly(landing.body, 'landing');
    assert.equal(await visits(), before, 'no visit, tap or click');
    assert.equal((await a.fetch('/api/store/app/landing/not-a-page')).status, 404);
    await q(w.app, 'UPDATE reels SET active = false WHERE tenant_id = $1 AND id = $2', [w.app.tenant.id, page1.id]);
    assert.equal((await a.fetch(`/api/store/app/landing/${page1.slug}`)).status, 404, 'a page that is off is not there');
  } finally {
    await w.close();
  }
});

test('the policies: the seller’s own text, or a default in the seller’s name', async () => {
  const w = await appWorld();
  try {
    await q(w.app, `INSERT INTO policy_pages (tenant_id, kind, body) VALUES ($1, 'refund', 'Returns within 7 days.')`, [w.app.tenant.id]);
    const a = await guestApp(w);
    const refund = await json(await a.fetch('/api/store/app/policies/refund'));
    assert.equal(refund.status, 200);
    AppPolicy.parse(refund.body);
    assert.equal(refund.body.body, 'Returns within 7 days.');
    assert.ok(refund.body.updatedAt);
    const privacy = await json(await a.fetch('/api/store/app/policies/privacy'));
    assert.equal(privacy.body.title, 'Privacy policy');
    assert.match(privacy.body.body, /Neel Studio/);
    assert.equal(privacy.body.updatedAt, null);
    for (const kind of ['terms', 'shipping']) assertBrandOnly((await json(await a.fetch(`/api/store/app/policies/${kind}`))).body, kind);
    assertBrandOnly(privacy.body, 'privacy');
    assert.equal((await a.fetch('/api/store/app/policies/cookies')).status, 404);
  } finally {
    await w.close();
  }
});
