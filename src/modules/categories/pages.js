import { BUYER_ROUTES } from '../../contracts/buyer-pages.js';
import { buyerPage, loadBuyerLayout, notFoundPage, section, sendBuyerPage } from '../../views/buyer/index.js';
import { html } from '../../views/html.js';
import { absolute, categoryProducts, chipRow, nowOf, pageBase, productList, reelGrid, tileStyles } from './buyer.js';
import { tileImage, tileTitle } from './repo.js';

/**
 * The category page (/c/:slug) and the Reels tab (/reels), PRD 8.13: both read the one stored order of each category through the
 * categories repo, so they always agree with each other, the creator page and the landing pages' strip (K-48). Tier 2 and up
 * (category_sequences); below that the Phase 0 store keeps answering both addresses.
 */
const SLUG = /^[a-z0-9-]{1,80}$/;

/** The reels of every chip in the Reels tab's All: categories in order, a reel in two of them once at its first place, then the rest. */
export function allReels(shelves, uncategorized) {
  const seen = new Set();
  const out = [];
  for (const shelf of shelves) {
    for (const row of shelf.items) {
      if (seen.has(row.page_id)) continue;
      seen.add(row.page_id);
      out.push(row);
    }
  }
  for (const row of uncategorized) if (!seen.has(row.page_id)) out.push(row);
  return out;
}

export function registerCategoryPages(app, ctx) {
  const { db, repos, config } = ctx;

  async function included() {
    return repos.entitlements.can('category_sequences');
  }

  async function notFound(res, message) {
    const { theme, business } = await loadBuyerLayout(repos);
    return sendBuyerPage(res, notFoundPage({ theme, business, message }), { status: 404 });
  }

  app.get(BUYER_ROUTES.category.path, async (req, res, next) => {
    try {
      if (!(await included())) return next();
      const slug = String(req.params.slug ?? '').toLowerCase();
      const category = SLUG.test(slug) ? await repos.categories.getBySlug(slug) : null;
      if (!category) return notFound(res, 'This category isn’t available.');
      const now = nowOf(config);
      const [{ theme, business }, reels, products] = await Promise.all([
        loadBuyerLayout(repos),
        repos.categorySequences.live(category.id, { now, limit: 60 }),
        categoryProducts(db, category.id, { limit: 48 }),
      ]);
      const base = pageBase(req);
      const image = category.image_url || (reels[0] ? tileImage(reels[0], now) : '');
      const main = html`${tileStyles()}
${section({ theme, id: 'category-h', kicker: 'Category', title: category.name, body: html`${category.description ? html`<p>${category.description}</p>` : ''}
${reels.length ? reelGrid(reels, { now, eagerFirst: true }) : products.length ? '' : html`<p class="empty">Nothing here yet. Check back soon.</p>`}` })}
${products.length ? section({ theme, id: 'category-products-h', kicker: 'Shop', title: 'Products', body: productList(products) }) : ''}`;
      const view = buyerPage({
        theme,
        business,
        meta: {
          title: `${category.name} · ${business.name}`,
          description: category.description || `${category.name} from ${business.name}`,
          url: `${base}/c/${encodeURIComponent(category.slug)}`,
          image: image ? { url: absolute(base, image), alt: category.name } : undefined,
        },
        main,
        headerEnd: html`<a class="chip" href="/reels">Reels</a>`,
      });
      return sendBuyerPage(res, view, { page: { kind: 'category', ref: category.slug } });
    } catch (err) {
      return next(err);
    }
  });

  app.get(BUYER_ROUTES.reels.path, async (req, res, next) => {
    try {
      if (!(await included())) return next();
      const now = nowOf(config);
      const [{ theme, business }, shelves, uncategorized] = await Promise.all([
        loadBuyerLayout(repos),
        repos.categorySequences.liveShelves({ now, perCategory: 60 }),
        repos.categorySequences.liveUncategorized({ limit: 60 }),
      ]);
      const picked = typeof req.query.c === 'string' ? shelves.find((s) => s.category.slug === req.query.c.toLowerCase()) : null;
      if (typeof req.query.c === 'string' && req.query.c && !picked) return notFound(res, 'This category isn’t available.');
      const rows = picked ? picked.items : allReels(shelves, uncategorized);
      const chips = [{ href: '/reels', label: 'All' }, ...shelves.map((s) => ({ href: `/reels?c=${encodeURIComponent(s.category.slug)}`, label: s.category.name }))];
      const current = picked ? `/reels?c=${encodeURIComponent(picked.category.slug)}` : '/reels';
      const base = pageBase(req);
      const first = rows[0];
      const main = html`${tileStyles()}
${chipRow(chips, current, 'Reel categories')}
${section({ theme, id: 'reels-h', kicker: picked ? 'Reels' : 'Shop by reels', title: picked ? picked.category.name : 'All reels', body: rows.length ? reelGrid(rows, { now, eagerFirst: true }) : html`<p class="empty">No reels yet. Check back soon.</p>` })}`;
      const view = buyerPage({
        theme,
        business,
        meta: {
          title: `${picked ? `${picked.category.name} reels` : 'Reels'} · ${business.name}`,
          description: `Shop the reels of ${business.name}`,
          url: `${base}/reels`,
          image: first && tileImage(first, now) ? { url: absolute(base, tileImage(first, now)), alt: tileTitle(first) } : undefined,
        },
        main,
      });
      return sendBuyerPage(res, view, { page: { kind: 'store', ref: 'reels' } });
    } catch (err) {
      return next(err);
    }
  });
}
