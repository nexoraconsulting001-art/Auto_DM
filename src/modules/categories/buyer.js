import { displayPrice } from '../../contracts/catalog.js';
import { BIO_UTM } from '../../contracts/buyer-pages.js';
import { priceText, productCard, safeHref } from '../../views/buyer/index.js';
import { html, raw } from '../../views/html.js';
import { currentTenant, tenantId } from '../../tenancy.js';
import { sized } from '../pages/variants.js';
import { LIVE_PRODUCT_SQL, tileImage, tileTitle } from './repo.js';

/**
 * Parts of the buyer pages this module and the creator page share: reel tiles, chips and product cards, drawn inside the shared
 * layout (src/views/buyer) in the seller's brand only. Every link is direct: a tile opens its landing page, a product its own
 * page or the seller's site (K-51, K-63). Nothing here writes the platform's name.
 */

/** The time buyer pages judge windows and story expiry by. Tests set config.pagesNow. */
export const nowOf = (config) => new Date((config?.pagesNow ?? Date.now)());

/**
 * The address a buyer page is seen at, for its canonical link and og:url: the business's verified domain when it has one,
 * else the address the shopper used. Never the platform's own domain unless the shopper is already on it.
 */
export function pageBase(req) {
  const primary = currentTenant()?.primary_domain ?? null;
  if (primary) return `https://${primary}`;
  return `${req.protocol}://${req.get('host')}`;
}

/** A path on this host made absolute for a share tag; a web link stays as it is. */
export const absolute = (base, url) => (String(url ?? '').startsWith('/') ? `${base}${url}` : String(url ?? ''));

/** The landing page address a tile opens, with no hop. The creator page adds the bio UTM so its visits count as source bio (8.14). */
export function pageHref(slug, { bio = false } = {}) {
  const path = `/r/${encodeURIComponent(slug)}`;
  return bio ? `${path}?${new URLSearchParams(BIO_UTM)}` : path;
}

// A grid of reel covers and a row of chips. Static, built from the theme's own variables: nothing a seller types reaches it.
export const TILE_CSS = [
  '.reel-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
  '@media (max-width:360px){.reel-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.reel-tile{position:relative;display:block;aspect-ratio:9/16;overflow:hidden;border-radius:10px;background:var(--frame-bg);color:#FFFFFF;text-decoration:none}',
  '.reel-tile img{width:100%;height:100%;object-fit:cover}',
  '.reel-tile span{position:absolute;left:0;right:0;bottom:0;padding:24px 8px 8px;font-size:12px;font-weight:700;line-height:1.25;background:linear-gradient(transparent,rgba(0,0,0,.72))}',
  '.reel-tile b{position:absolute;top:6px;left:6px;font-size:11px;padding:2px 7px;border-radius:999px;background:var(--accent);color:var(--on-accent)}',
  '.chips{display:flex;gap:8px;overflow-x:auto;padding:4px 20px 8px;scrollbar-width:none}',
  '.chips a{flex:none}.chips a[aria-current="page"]{background:var(--primary);color:var(--on-primary)}',
  '.cards{display:flex;flex-direction:column;gap:12px}',
  '.more-tiles{display:flex;justify-content:center;padding-top:4px}',
  '.empty{color:var(--muted);margin:0}',
].join('');

export const tileStyles = () => html`<style>${raw(TILE_CSS)}</style>`;

/**
 * One reel tile. `row` is a page row from the categories repo. `variant` asks for the business's own picture at a phone's size
 * (pages/variants.js; a picture kept elsewhere is unchanged), and `first` marks the tile the page should fetch before the rest.
 */
export function reelTile(row, { now = new Date(), bio = false, eager = false, variant = '', first = false } = {}) {
  const image = safeHref(variant ? sized(tileImage(row, now), variant) : tileImage(row, now));
  return html`<a class="reel-tile" href="${pageHref(row.slug, { bio })}" data-page="${Number(row.page_id)}">${image ? html`<img src="${image}" alt="" width="180" height="320"${eager ? '' : raw(' loading="lazy"')}${first ? raw(' fetchpriority="high"') : ''} decoding="async">` : ''}${row.pinned ? html`<b>Top</b>` : ''}<span>${tileTitle(row)}</span></a>`;
}

export const reelGrid = (rows, options = {}) => html`<div class="reel-grid">${rows.map((row, i) => reelTile(row, { ...options, eager: options.eagerFirst ? i < 3 : false }))}</div>`;

/** A row of chips; `current` is the href that is this page. */
export function chipRow(chips, current, label = 'Categories') {
  const items = chips.map((c) => ({ ...c, href: safeHref(c.href) })).filter((c) => c.href);
  if (items.length < 2) return '';
  return html`<nav class="chips" aria-label="${label}">${items.map((c) => html`<a class="chip" href="${c.href}"${c.href === current ? raw(' aria-current="page"') : ''}>${c.label}</a>`)}</nav>`;
}

// ---- products ---------------------------------------------------------------------------------------------------------

const PRODUCT_COLS = `p.id, p.name, p.slug, p.price_paise, p.mrp_paise, p.in_stock, p.images->>0 AS image, p.external_url, p.tags`;

/** The cheapest variant prices for a set of products, so a card shows what displayPrice() says (K-03). */
async function withVariants(db, rows) {
  if (!rows.length) return rows;
  const variants = await db.query('SELECT product_id, price_paise, mrp_paise, in_stock FROM product_variants WHERE tenant_id = $1 AND product_id = ANY($2::int[])', [tenantId(), rows.map((r) => r.id)]);
  const byProduct = new Map();
  for (const v of variants) byProduct.set(v.product_id, [...(byProduct.get(v.product_id) ?? []), v]);
  return rows.map((row) => ({ ...row, price: displayPrice(row, byProduct.get(row.id) ?? []) }));
}

/** A category's products a page may show, featured first. */
export async function categoryProducts(db, categoryId, { limit = 24 } = {}) {
  const rows = await db.query(
    `SELECT ${PRODUCT_COLS} FROM products p JOIN product_categories pc ON pc.tenant_id = p.tenant_id AND pc.product_id = p.id
     WHERE p.tenant_id = $1 AND pc.category_id = $2 AND ${LIVE_PRODUCT_SQL} ORDER BY p.featured DESC, p.id DESC LIMIT $3`,
    [tenantId(), categoryId, Math.min(Math.max(limit, 1), 200)],
  );
  return withVariants(db, rows);
}

/** Products found by every word of a search, in their name or tags: this business's only (K-60). */
export async function searchProducts(db, terms, { limit = 24 } = {}) {
  if (!terms.length) return [];
  const rows = await db.query(
    `SELECT ${PRODUCT_COLS} FROM products p
     WHERE p.tenant_id = $1 AND ${LIVE_PRODUCT_SQL}
       AND (SELECT bool_and(p.name ILIKE '%' || term || '%' ESCAPE '\\' OR EXISTS (SELECT 1 FROM unnest(p.tags) tag WHERE tag ILIKE '%' || term || '%' ESCAPE '\\'))
            FROM unnest($2::text[]) term)
     ORDER BY p.featured DESC, p.id DESC LIMIT $3`,
    [tenantId(), terms.map(likeText), Math.min(Math.max(limit, 1), 100)],
  );
  return withVariants(db, rows);
}

/** A search term inside LIKE, taken literally. */
export const likeText = (term) => String(term).replace(/[\\%_]/g, (c) => `\\${c}`);

/** At most five words of at most 40 characters, from what the shopper typed. */
export function searchTerms(q) {
  return String(q ?? '').replace(/[\0-\x1f\x7f]/g, ' ').trim().slice(0, 80).split(/\s+/).filter(Boolean).slice(0, 5).map((w) => w.slice(0, 40));
}

/** A product's card: its own page, or the seller's site or marketplace opened directly (K-63). */
export function productTile(row, { eager = false } = {}) {
  const external = safeHref(row.external_url);
  const href = external || `/p/${encodeURIComponent(row.slug)}`;
  return productCard({
    name: row.name,
    imageUrl: row.image ?? '',
    imageAlt: row.name,
    price: priceText(row.price ?? displayPrice(row)),
    href,
    buttonText: external ? 'Visit website' : 'View',
    productId: row.id,
    eager,
  });
}

export const productList = (rows) => html`<div class="cards">${rows.map((row) => productTile(row))}</div>`;
