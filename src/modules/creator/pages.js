import { BUYER_ROUTES, DEFAULT_BLOCKS, isReservedPath } from '../../contracts/buyer-pages.js';
import { whatsappDigits } from '../../contracts/catalog.js';
import { buyerPage, icon, initials, loadBuyerLayout, notFoundPage, safeHref, section, sendBuyerPage, ticker } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';
import { absolute, categoryProducts, chipRow, likeText, nowOf, pageBase, productList, reelTile, searchProducts, searchTerms, tileStyles } from '../categories/buyer.js';
import { tileImage } from '../categories/repo.js';
import { leadFormFor } from '../leads/form.js';
import { CREATOR_SLUG } from './repo.js';

/**
 * The creator page (PRD 8.14) at /<slug> on the business's own host, each shelf at /<slug>/<category slug>, and the tiles after
 * the first 12 at /<slug>/_tiles. Shelves are the visible categories in their order, each showing its reel sequence (8.13),
 * read through the categories repo, so this page always agrees with the category page and the Reels tab (K-48, K-49). Live
 * reels in no category come last, newest first.
 *
 * Every link is direct: a tile opens its landing page with the bio UTM, so the visit counts as source bio (K-51), and a
 * product opens its own page or the seller's site (K-63). The page is indexable, unlike the others. It wears the seller's
 * brand only; the one exception is the small badge in the footer of a Free plan page (K-64).
 *
 * /<slug> is a wildcard, so anything that isn't this business's saved, switched-on page goes on to the next route untouched.
 */
export const FIRST_TILES = 12;
const ALL_TILES = 120;
const MORE_SHELF = '_more';
const CATEGORY_SLUG = /^[a-z0-9-]{1,80}$/;
const MAX_OFFSET = 5000;

// Static, built from the theme's variables: nothing a seller types reaches it.
const CREATOR_CSS = [
  '.creator-head{padding:8px 20px 0;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center}',
  '.creator-photo{width:96px;height:96px;border-radius:999px;overflow:hidden;display:flex;align-items:center;justify-content:center;background:var(--primary);color:var(--on-primary);font-family:var(--display);font-weight:var(--display-weight);font-size:30px;border:3px solid var(--card);box-shadow:0 0 0 2px var(--primary)}',
  '.creator-photo img{width:100%;height:100%;object-fit:cover}',
  '.creator-head h1{font-family:var(--display);font-weight:var(--display-weight);font-size:clamp(28px,8vw,36px);line-height:1.08;letter-spacing:-.02em}',
  '.creator-head p{margin:0;color:var(--muted);max-width:44ch}',
  '.creator-links{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}',
  '.creator-links .btn,.creator-links .outline-btn{align-self:auto;padding:0 18px;min-height:44px}',
  '.creator-search{display:flex;gap:8px;padding:20px 20px 4px}',
  '.creator-search input{flex:1;min-width:0;min-height:44px;padding:0 12px;border:1.5px solid var(--line-strong);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}',
  '.creator-search button{flex:none;border:0}',
  '.creator-banner{display:block;margin:20px 20px 0;padding:14px 16px;border-radius:12px;background:var(--primary);color:var(--on-primary);font-weight:700;text-decoration:none;text-align:center}',
  '.creator-banner img{width:100%;border-radius:8px;margin-bottom:8px}',
  '.shelf-link{font-size:14px;font-weight:600}',
  '.made-with{font-size:12px;text-align:center}',
].join('');

// Loads the tiles after the first 12 as each shelf's end scrolls into view. Without it, each shelf's own link shows them.
const TILES_SCRIPT = `(function(){var io='IntersectionObserver' in window;document.querySelectorAll('[data-more]').forEach(function(el){var busy=false,ob=null;function stop(){if(ob)ob.disconnect();}function load(){if(busy)return;busy=true;fetch(el.getAttribute('data-more'),{credentials:'same-origin'}).then(function(r){if(!r.ok)throw 0;var next=r.headers.get('x-next');return r.text().then(function(t){var grid=document.getElementById(el.getAttribute('data-grid'));if(grid)grid.insertAdjacentHTML('beforeend',t);if(next&&next.charAt(0)==='/'&&next.charAt(1)!=='/'){el.setAttribute('data-more',next);busy=false;if(ob){ob.unobserve(el);ob.observe(el);}}else{stop();el.remove();}});}).catch(function(){busy=false;stop();});}if(io){ob=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)load();});},{rootMargin:'300px'});ob.observe(el);}var a=el.querySelector('a');if(a)a.addEventListener('click',function(ev){ev.preventDefault();load();});});})();`;

const one = (value) => (typeof value === 'string' ? value : '');
const tilesUrl = (slug, shelf, offset) => `/${slug}/_tiles?shelf=${encodeURIComponent(shelf)}&offset=${offset}`;

export function registerCreatorPages(app, ctx) {
  const { db, repos, config } = ctx;

  /** This business's live creator page when the first path segment is its name; null for every other address. */
  async function find(req) {
    const slug = one(req.params.creator).toLowerCase();
    if (!CREATOR_SLUG.test(slug) || isReservedPath(slug)) return null;
    const page = await repos.creatorPages.getLive(slug);
    if (!page || !(await repos.entitlements.can('creator_page'))) return null;
    return page;
  }

  const tiles = (rows, now, { eagerFirst = false } = {}) => rows.map((row, i) => reelTile(row, { now, bio: true, eager: eagerFirst && i < 3 }));

  /** A grid of tiles and, when the shelf has more, the place the rest load into. `fallback` is the link that works with no script. */
  function shelfGrid({ id, rows, now, more = null, eagerFirst = false }) {
    return html`<div class="reel-grid" id="${id}">${tiles(rows, now, { eagerFirst })}</div>
${more ? html`<div class="more-tiles" data-more="${more.url}" data-grid="${id}"><a class="btn-quiet" href="${more.fallback}">Show more</a></div>` : ''}`;
  }

  /** What every view of the page shares: the layout, the page's name and photo, and the parts around the shelves. */
  async function frame(req, page) {
    const [{ theme, business, settings }, blocks, badge, whatsappAllowed] = await Promise.all([
      loadBuyerLayout(repos),
      repos.creatorPages.blocks(),
      repos.entitlements.can('badge.made_with'),
      repos.entitlements.can('whatsapp_order'),
    ]);
    const name = page.display_name || business.name;
    const photo = page.photo_media_id ? `/media/${page.photo_media_id}` : safeHref(theme.logoUrl);
    const website = safeHref(page.website_url);
    const digits = page.show_whatsapp && whatsappAllowed ? whatsappDigits(settings.support_whatsapp) : null;
    const placed = blocks ?? DEFAULT_BLOCKS.creator.map((block) => ({ block, settings: {} }));
    const shows = (block) => placed.some((b) => b.block === block);
    const head = html`<section class="creator-head" aria-labelledby="creator-name">
<span class="creator-photo">${photo ? html`<img src="${photo}" alt="" width="96" height="96" fetchpriority="high" decoding="async">` : html`<span aria-hidden="true">${initials(name)}</span>`}</span>
<h1 id="creator-name">${name}</h1>
${page.bio ? html`<p>${page.bio}</p>` : ''}
${website || (digits && shows('whatsapp')) ? html`<div class="creator-links">
${website ? html`<a class="btn" href="${website}" rel="noopener">Visit website</a>` : ''}
${digits && shows('whatsapp') ? html`<a class="outline-btn" href="https://wa.me/${digits}" rel="noopener">${icon('chat', 18)}WhatsApp</a>` : ''}
</div>` : ''}
</section>`;
    const leadForm = shows('lead_form') ? await leadFormFor(ctx, req, { theme, surface: 'creator', pageSlug: page.slug, back: `/${page.slug}` }) : '';

    function banner(s) {
      const text = one(s?.text).slice(0, 160);
      const image = safeHref(one(s?.imageUrl));
      const link = safeHref(one(s?.linkUrl));
      if (!text && !image) return '';
      const inner = html`${image ? html`<img src="${image}" alt="" loading="lazy" decoding="async">` : ''}${text}`;
      return link ? html`<a class="creator-banner" href="${link}"${/^https?:/i.test(link) ? raw(' rel="noopener"') : ''}>${inner}</a>` : html`<div class="creator-banner">${inner}</div>`;
    }

    /** The page's sections in the business's block order, with `shelves` as the shelves block. */
    function body(shelves) {
      const parts = { hero: () => head, shelves: () => shelves, lead_form: () => leadForm, ticker: () => ticker(theme), whatsapp: () => '' };
      const hasShelves = shows('shelves');
      const out = placed.map((b) => (b.block === 'banner' ? banner(b.settings) : Object.hasOwn(parts, b.block) ? parts[b.block]() : ''));
      // The shelves are the page: a layout that left them out still shows them, last.
      if (!hasShelves) out.push(shelves);
      return html`<style>${raw(CREATOR_CSS)}</style>${tileStyles()}${out}`;
    }

    const footer = badge ? { extra: html`<span class="made-with">Made with Bhava</span>` } : {};
    return { theme, business, name, photo, body, footer, base: pageBase(req) };
  }

  function searchBox(slug, q = '') {
    return html`<form class="creator-search" method="get" action="/${slug}" role="search">
<input type="search" name="q" value="${q}" maxlength="80" placeholder="Search reels and products" aria-label="Search reels and products">
<button class="btn" type="submit" aria-label="Search">${icon('search', 18)}</button></form>`;
  }

  async function preview(target, fallbacks, base) {
    const drawn = await repos.creatorPages.sharePreview(target);
    if (drawn) return { url: absolute(base, drawn.url), width: drawn.width, height: drawn.height };
    const url = fallbacks.map((u) => safeHref(u)).find(Boolean);
    return url ? { url: absolute(base, url) } : undefined;
  }

  // ---- the tiles after the first 12 -------------------------------------------------------------------------------------

  app.get(BUYER_ROUTES.creatorTiles.path, async (req, res, next) => {
    try {
      const page = await find(req);
      if (!page) return next();
      res.set({ 'Cache-Control': 'private, no-cache', 'X-Robots-Tag': 'noindex' });
      const shelf = one(req.query.shelf);
      const offset = /^\d{1,4}$/.test(one(req.query.offset)) ? Math.min(Number(req.query.offset), MAX_OFFSET) : 0;
      const now = nowOf(config);
      let rows;
      if (shelf === MORE_SHELF) rows = await repos.categorySequences.liveUncategorized({ limit: FIRST_TILES + 1, offset });
      else {
        const category = CATEGORY_SLUG.test(shelf) ? await repos.categories.getBySlug(shelf) : null;
        if (!category) return res.status(404).type('html').send(Buffer.from(''));
        rows = await repos.categorySequences.live(category.id, { now, limit: FIRST_TILES + 1, offset });
      }
      const shown = rows.slice(0, FIRST_TILES);
      if (rows.length > shown.length && offset + shown.length < MAX_OFFSET) res.set('X-Next', tilesUrl(page.slug, shelf, offset + shown.length));
      // A fragment for the page's own script, sent as bytes so nothing is added to it and it is never counted as a page.
      return res.type('html').send(Buffer.from(String(html`${tiles(shown, now)}`), 'utf8'));
    } catch (err) {
      return next(err);
    }
  });

  // ---- the page -----------------------------------------------------------------------------------------------------------

  app.get(BUYER_ROUTES.creator.path, async (req, res, next) => {
    try {
      const page = await find(req);
      if (!page) return next();
      const now = nowOf(config);
      const view = await frame(req, page);
      const { theme, business, name, base } = view;
      const q = one(req.query.q).trim().slice(0, 80);
      const terms = searchTerms(q);

      if (terms.length) {
        // Search stays inside this page: this business's reels and products only (K-60).
        const products = await searchProducts(db, terms, { limit: 24 });
        const reels = await repos.categorySequences.searchLive(terms.map(likeText), { productIds: products.map((p) => p.id), limit: 24 });
        const results = html`${searchBox(page.slug, q)}
${reels.length ? section({ theme, id: 'found-reels-h', kicker: 'Search', title: 'Reels', body: shelfGrid({ id: 'grid-found', rows: reels, now, eagerFirst: true }) }) : ''}
${products.length ? section({ theme, id: 'found-products-h', kicker: 'Search', title: 'Products', body: productList(products) }) : ''}
${!reels.length && !products.length ? section({ theme, id: 'found-none-h', kicker: 'Search', title: 'Nothing found', body: html`<p class="empty">Nothing matched your search. Try another word.</p><a class="shelf-link" href="/${page.slug}">See everything</a>` }) : ''}`;
        const doc = buyerPage({
          theme,
          business,
          meta: { title: `Search · ${name}`, description: `Search the reels and products of ${name}`, url: `${base}/${page.slug}`, indexable: false },
          main: view.body(results),
          footer: view.footer,
        });
        return sendBuyerPage(res, doc, { page: { kind: 'creator', ref: page.slug } });
      }

      const showAllMore = req.query.more === 'all';
      const [shelves, uncategorized] = await Promise.all([
        repos.categorySequences.liveShelves({ now, perCategory: FIRST_TILES }),
        repos.categorySequences.liveUncategorized({ limit: showAllMore ? ALL_TILES : FIRST_TILES + 1 }),
      ]);
      // The first 12 tiles are in the page; the rest of each shelf load as it scrolls into view.
      let budget = FIRST_TILES;
      const sections = shelves.map((shelf, index) => {
        const shown = shelf.items.slice(0, budget);
        budget -= shown.length;
        const href = `/${page.slug}/${shelf.category.slug}`;
        const more = shelf.total > shown.length ? { url: tilesUrl(page.slug, shelf.category.slug, shown.length), fallback: href } : null;
        return section({
          theme,
          id: `shelf-${shelf.category.id}-h`,
          kicker: 'Shelf',
          title: html`<a href="${href}">${shelf.category.name}</a>`,
          body: shelfGrid({ id: `grid-${shelf.category.id}`, rows: shown, now, more, eagerFirst: index === 0 }),
        });
      });
      const moreShown = uncategorized.slice(0, showAllMore ? ALL_TILES : budget);
      if (uncategorized.length) {
        const more = uncategorized.length > moreShown.length ? { url: tilesUrl(page.slug, MORE_SHELF, moreShown.length), fallback: `/${page.slug}?more=all` } : null;
        sections.push(section({
          theme,
          id: 'shelf-more-h',
          kicker: 'Shelf',
          title: page.more_shelf_title,
          body: shelfGrid({ id: 'grid-more', rows: moreShown, now, more, eagerFirst: !shelves.length }),
        }));
      }
      const chips = [{ href: `/${page.slug}`, label: 'All' }, ...shelves.map((s) => ({ href: `/${page.slug}/${s.category.slug}`, label: s.category.name }))];
      const first = shelves[0]?.items[0] ?? uncategorized[0];
      const shelvesBlock = html`${searchBox(page.slug)}
${chipRow(chips, `/${page.slug}`, 'Shelves')}
${sections.length ? sections : section({ theme, id: 'shelf-none-h', kicker: 'Reels', title: 'Coming soon', body: html`<p class="empty">No reels yet. Check back soon.</p>` })}
<script>${raw(TILES_SCRIPT)}</script>`;
      const doc = buyerPage({
        theme,
        business,
        meta: {
          title: name === business.name ? name : `${name} · ${business.name}`,
          description: page.bio || `Reels and products from ${name}`,
          url: `${base}/${page.slug}`,
          image: await preview('creator', [view.photo, first ? tileImage(first, now) : ''], base),
          indexable: !showAllMore,
        },
        main: view.body(shelvesBlock),
        footer: view.footer,
      });
      return sendBuyerPage(res, doc, { page: { kind: 'creator', ref: page.slug } });
    } catch (err) {
      return next(err);
    }
  });

  // ---- one shelf: the page opened on that category (K-61, K-62) -------------------------------------------------------

  app.get(BUYER_ROUTES.creatorShelf.path, async (req, res, next) => {
    try {
      const page = await find(req);
      if (!page) return next();
      const slug = one(req.params.shelf).toLowerCase();
      const category = CATEGORY_SLUG.test(slug) ? await repos.categories.getBySlug(slug) : null;
      if (!category) {
        const { theme, business } = await loadBuyerLayout(repos);
        return sendBuyerPage(res, notFoundPage({ theme, business, message: 'This shelf isn’t available.' }), { status: 404 });
      }
      const now = nowOf(config);
      const all = req.query.all === '1';
      const [view, rows, shelves, products] = await Promise.all([
        frame(req, page),
        repos.categorySequences.live(category.id, { now, limit: all ? ALL_TILES : FIRST_TILES + 1 }),
        repos.categorySequences.liveShelves({ now, perCategory: 1 }),
        categoryProducts(db, category.id, { limit: 12 }),
      ]);
      const { theme, business, name, base } = view;
      const href = `/${page.slug}/${category.slug}`;
      const shown = rows.slice(0, all ? ALL_TILES : FIRST_TILES);
      const more = rows.length > shown.length ? { url: tilesUrl(page.slug, category.slug, shown.length), fallback: `${href}?all=1` } : null;
      const chips = [{ href: `/${page.slug}`, label: 'All' }, ...shelves.map((s) => ({ href: `/${page.slug}/${s.category.slug}`, label: s.category.name }))];
      const shelfBlock = html`${searchBox(page.slug)}
${chipRow(chips, href, 'Shelves')}
${section({ theme, id: 'shelf-h', kicker: 'Shelf', title: category.name, body: html`${category.description ? html`<p>${category.description}</p>` : ''}
${shown.length ? shelfGrid({ id: `grid-${category.id}`, rows: shown, now, more, eagerFirst: true }) : html`<p class="empty">No reels here yet. Check back soon.</p>`}` })}
${products.length ? section({ theme, id: 'shelf-products-h', kicker: 'Shop', title: 'Products', body: productList(products) }) : ''}
${more ? html`<script>${raw(TILES_SCRIPT)}</script>` : ''}`;
      const doc = buyerPage({
        theme,
        business,
        meta: {
          title: `${category.name} · ${name}`,
          description: category.description || `${category.name} picks from ${name}`,
          url: `${base}${href}`,
          image: await preview(`shelf:${category.id}`, [category.image_url, shown[0] ? tileImage(shown[0], now) : '', view.photo], base),
          indexable: !all,
        },
        main: view.body(shelfBlock),
        footer: view.footer,
      });
      return sendBuyerPage(res, doc, { page: { kind: 'creator', ref: `${page.slug}/${category.slug}` } });
    } catch (err) {
      return next(err);
    }
  });
}
