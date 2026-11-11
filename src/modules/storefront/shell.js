import { POLICY_KINDS } from '../../contracts/api/store.js';
import { buyerPage, loadBuyerLayout, notFoundPage, sendBuyerPage } from '../../views/buyer/index.js';
import { esc, html, raw } from '../../views/html.js';
import { currentTenant } from '../../tenancy.js';

/**
 * The frame every Phase 4 buyer page sits in (PRD 9.1): the shared buyer layout (src/views/buyer) in the seller's brand only,
 * plus what the store adds to it: the home-screen app's manifest, the bag's script, a bag link in the header, the policy
 * links in the footer and the store's own styles. Nothing here writes the platform's name.
 *
 *   sendStorePage(ctx, req, res, { title, description?, main, kind, ref?, status?, scripts?, indexable?, url?, image? })
 *   sendStoreNotFound(ctx, req, res, message)
 */
export const BAG_SCRIPT = '/store/bag.js';
export const CHECKOUT_SCRIPT = '/store/checkout.js';
export const ASSET_VERSION = '4.0.2';

/** The address a page is seen at: the business's verified domain when it has one, else the address the shopper used. */
export function baseOf(req) {
  const primary = currentTenant()?.primary_domain ?? null;
  return primary ? `https://${primary}` : `${req.protocol}://${req.get('host')}`;
}

// Structure for the store's own parts, built only from the theme's variables: nothing a seller types reaches it.
const STORE_CSS = [
  '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
  '.tile{display:flex;flex-direction:column;gap:6px;text-decoration:none;background:var(--card);padding:10px;border-radius:12px;border:1px solid var(--line)}',
  '.tile img,.tile .ph{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:8px;background:var(--chip)}',
  '.tile b{font-weight:600;font-size:14px;line-height:1.3}.tile .muted{font-size:13px}',
  '.muted{color:var(--muted)}.small{font-size:13px}',
  '.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.between{justify-content:space-between}',
  '.stack{display:flex;flex-direction:column;gap:12px}',
  '.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px}',
  'label{display:flex;flex-direction:column;gap:4px;font-size:14px;font-weight:600}',
  'label.check{flex-direction:row;align-items:flex-start;gap:10px;font-weight:400}',
  'input,select,textarea{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line-strong);border-radius:10px;min-height:44px;padding:8px 12px;width:100%}',
  'label.check input{width:22px;min-height:22px;flex:none;margin-top:2px}',
  '.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
  '.btn{min-height:48px;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;border:0;font:inherit;font-weight:700;padding:0 20px;text-decoration:none}',
  '.btn[disabled]{opacity:.55;cursor:not-allowed}.btn.wide{width:100%}',
  '.lines{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}',
  '.line{display:grid;grid-template-columns:64px 1fr auto;gap:10px;align-items:center}',
  '.line img,.line .ph{width:64px;height:76px;object-fit:cover;border-radius:8px;background:var(--chip)}',
  '.line.off{opacity:.6}',
  '.qty{display:inline-flex;align-items:center;gap:6px}.qty button{min-width:36px;min-height:36px;border-radius:999px;border:1px solid var(--line-strong);background:var(--card);font:inherit;cursor:pointer}',
  '.totals{display:grid;grid-template-columns:1fr auto;gap:6px;font-size:15px}.totals .grand{font-weight:800;font-size:18px}',
  '.notice-box{border-radius:12px;padding:12px 14px;background:var(--chip);font-size:14px}',
  '.error{color:#B3261E;font-size:14px}',
  '.pager{display:flex;justify-content:space-between;gap:10px;padding-top:12px}',
  '.opts{display:flex;flex-wrap:wrap;gap:8px}.opts input{position:absolute;opacity:0;width:1px;height:1px}',
  '.opts label{flex-direction:row;font-weight:600;border:1px solid var(--line-strong);border-radius:999px;padding:8px 14px;min-height:44px;align-items:center;cursor:pointer;background:var(--card)}',
  '.opts input:checked+span{color:var(--primary)}.opts label:has(input:checked){border-color:var(--primary);box-shadow:0 0 0 2px var(--primary) inset}',
  '.opts label.sold{opacity:.5;text-decoration:line-through}',
  '.gallery{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory}.gallery img{width:86%;flex:none;scroll-snap-align:center;border-radius:14px;aspect-ratio:4/5;object-fit:cover;background:var(--chip)}',
  '.status{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--chip);font-weight:700;font-size:13px}',
  '.bag-link{position:relative}.bag-link [data-bag-count]{position:absolute;top:2px;right:2px;min-width:18px;height:18px;border-radius:999px;background:var(--accent);color:var(--on-accent);font-size:11px;display:flex;align-items:center;justify-content:center;padding:0 4px}',
  '.bag-link [data-bag-count]:empty{display:none}',
  '[hidden]{display:none!important}',
].join('');

export const storeStyles = () => html`<style>${raw(STORE_CSS)}</style>`;

const header = () => html`<nav class="row" aria-label="Store">
<a class="chip" href="/search" aria-label="Search">Search</a>
<a class="chip bag-link" href="/cart" aria-label="Your bag">Bag<span data-bag-count></span></a>
</nav>`;

const POLICY_LABELS = Object.freeze({ terms: 'Terms', refund: 'Refunds', shipping: 'Shipping', privacy: 'Privacy' });
/** The policy pages the consent module serves (9.18), one link each. */
export const policyLinks = () => POLICY_KINDS.map((kind) => ({ href: `/policies/${kind}`, label: POLICY_LABELS[kind] ?? kind }));
const FOOTER_LINKS = [{ href: '/shop', label: 'Shop' }, { href: '/about', label: 'About' }, ...policyLinks()];

/** The WhatsApp chat link for the footer: a direct wa.me link (6.6), or nothing. */
function whatsappHref(settings) {
  const digits = String(settings?.support_whatsapp ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `https://wa.me/91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `https://wa.me/${digits}`;
  return '';
}

/** Adds the store's tags to the head of a finished document. */
function withHead(document, extra) {
  const text = String(document);
  const at = text.indexOf('</head>');
  return at === -1 ? text : `${text.slice(0, at)}${extra}\n${text.slice(at)}`;
}

export async function renderStorePage(ctx, req, { title, description = '', main, scripts = [], indexable = false, url = '', image = null, data = null }) {
  const { theme, business, settings } = await loadBuyerLayout(ctx.repos);
  if (typeof main === 'function') main = main({ theme, business, settings });
  const view = buyerPage({
    theme,
    business,
    meta: { title: title ? `${title} · ${business.name}` : business.name, description: description || settings.tagline || '', url: url || `${baseOf(req)}${req.path}`, indexable, image: image ?? undefined },
    main: html`${storeStyles()}${main}`,
    headerEnd: header(),
    footer: { note: `© ${business.name}`, whatsappHref: whatsappHref(settings), links: FOOTER_LINKS },
  });
  const tags = [
    '<link rel="manifest" href="/manifest.webmanifest">',
    req.csrf ? `<meta name="csrf-token" content="${esc(req.csrf)}">` : '',
    req.shopper?.id ? '<meta name="store-shopper" content="1">' : '',
    // A signed-in shopper's writes to /api/store must carry their session's token (shoppers/session.js).
    req.shopperCsrf ? `<meta name="shopper-csrf" content="${esc(req.shopperCsrf)}">` : '',
    data ? `<script type="application/json" id="store-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>` : '',
    ...[BAG_SCRIPT, ...scripts].map((src) => `<script src="${esc(src)}?v=${ASSET_VERSION}" defer></script>`),
  ].filter(Boolean).join('\n');
  return withHead(view, tags);
}

export async function sendStorePage(ctx, req, res, { kind = 'store', ref = '', status = 200, ...page }) {
  return sendBuyerPage(res, await renderStorePage(ctx, req, page), { status, page: { kind, ref } });
}

export async function sendStoreNotFound(ctx, req, res, message = 'This page doesn’t exist.') {
  const { theme, business } = await loadBuyerLayout(ctx.repos);
  return sendBuyerPage(res, withHead(notFoundPage({ theme, business, message }), '<link rel="manifest" href="/manifest.webmanifest">'), { status: 404 });
}
