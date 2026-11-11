import express from 'express';
import { ApiError } from '../../contracts/api/errors.js';
import { formatRupees } from '../../contracts/catalog.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { STORE_ROUTES, WishlistPut } from '../../contracts/store-routes.js';
import { log } from '../../platform/log.js';
import { safeHref, section } from '../../views/buyer/index.js';
import { html, jsonScript, raw } from '../../views/html.js';
import { hookPages, insertBefore } from '../reviews/page-hook.js';
import { parseBody, shopperFrom, storeCall, storeOn } from '../storefront/http.js';
import { sendStorePage } from '../storefront/shell.js';
import { WISHLIST_ASSET_VERSION, WISHLIST_CSS, WISHLIST_JS, WISHLIST_SCRIPT } from './assets.js';
import { WISHLIST_FEATURE, wishlistRepo } from './repo.js';

/**
 * PRD 9.20: the wishlist. This folder is the wishlist track's.
 *
 * Tables (migration 412): wishlist_items.
 * Buyer routes (src/contracts/store-routes.js):
 *   GET /wishlist               the page: the account's saves, or this browser's when logged out
 *   GET /api/store/wishlist     the signed-in shopper's saves -> { items, notices }
 *   PUT /api/store/wishlist     { add, remove }: a heart, or the browser's saves merged after sign-in (S-84)
 * Console route: wishlist.counts (staff with analytics): how many saved each product, never who (S-86).
 * A heart on product cards and on the product page (assets.js), added to the storefront's pages as they are sent
 * (reviews/page-hook.js), and a link in the account. Gated by `store.wishlist` (tier 3 and above): without it the calls are
 * the store's 404 and the console's 403.
 * Order events: none.
 */
const signedInOnly = (req) => {
  if (!req.shopper?.id) throw new ApiError('unauthorized', 'Sign in to keep your wishlist on every device.');
  return req.shopper;
};

async function featureOn(ctx) {
  return (await storeOn(ctx.repos)) && Boolean(await ctx.repos.entitlements.can(WISHLIST_FEATURE));
}

const STATE_TEXT = Object.freeze({ inactive: 'Unavailable', sold_out: 'Sold out' });

function wishlistPage(items, { signedIn }) {
  const rows = items.map((item) => {
    const image = safeHref(item.image);
    const link = item.state === 'inactive' ? html`<b>${item.name}</b>` : html`<a href="/p/${encodeURIComponent(item.slug)}"><b>${item.name}</b></a>`;
    const action = item.state !== 'ok'
      ? ''
      : item.needsOption
        ? html`<a class="btn-quiet" href="/p/${encodeURIComponent(item.slug)}">Choose an option</a>`
        : html`<button class="btn-quiet" type="button" data-wish-bag="${item.productId}">Add to bag</button>`;
    return html`<li class="wish-row${item.state === 'ok' ? '' : ' off'}">${image ? html`<img src="${image}" alt="" width="64" height="76" loading="lazy">` : html`<span class="ph"></span>`}
<div class="stack" style="gap:4px">${link}<span class="small">${STATE_TEXT[item.state] ?? (item.pricePaise === null ? '' : formatRupees(item.pricePaise))}</span>
<span class="row">${action}<button class="btn-quiet" type="button" data-wish-remove="${item.productId}">Remove</button></span></div></li>`;
  });
  const empty = html`<p class="notice-box" data-wish-empty${signedIn && !items.length ? '' : raw(' hidden')}>Nothing saved yet. Tap the heart on anything you like. <a href="/shop">Start shopping</a></p>`;
  return html`<div class="stack" data-wish-page>
<p class="notice-box" data-wish-note hidden role="status"></p>
${empty}
<ul class="wish-list" data-wish-items>${rows}</ul>
${signedIn ? '' : html`<p class="muted small">Saved on this phone. <a href="/login?next=/wishlist">Sign in</a> to keep them on every device.</p>`}
</div>`;
}

/** What the script needs, and the script itself, for a page with hearts. */
const wishBits = ({ signedIn, saved }) => `<style>${WISHLIST_CSS}</style><script type="application/json" id="wish-data">${jsonScript({ signedIn, saved })}</script>`
  + `<script src="${WISHLIST_SCRIPT}?v=${WISHLIST_ASSET_VERSION}" defer></script>`;

const TILE = /<a class="tile" href="\/p\/([a-z0-9-]{1,80})"/g;
/** Pages with no product cards or product form: nothing to add. */
const NO_HEARTS = /^\/(api|admin|media|static|account|checkout|order|cart|login|logout|auth|track|policies|unsubscribe|webhooks?|oauth|store|refer|wishlist)(\/|$)/;

/** Puts a panel in the account page, before its addresses, or at the end of its section. */
export function addToAccount(page, panel) {
  const anchor = '<div class="panel"><div class="row"><h2>Addresses</h2>';
  const at = page.indexOf(anchor);
  if (at !== -1) return `${page.slice(0, at)}${panel}\n${page.slice(at)}`;
  const acct = page.indexOf('<section class="acct">');
  if (acct === -1) return page;
  const end = page.indexOf('</section>', acct);
  return end === -1 ? page : page.slice(0, end) + panel + page.slice(end);
}

export const wishlist = {
  name: 'wishlist',

  routes(app, ctx) {
    const repo = wishlistRepo(ctx.db);
    const r = express.Router();
    const answer = async (shopperId, notices = []) => ({ body: { items: await repo.items(shopperId), notices } });
    const needFeature = async () => {
      if (!(await ctx.repos.entitlements.can(WISHLIST_FEATURE))) throw new ApiError('not_found', 'There is nothing here.');
    };

    r.get(STORE_ROUTES.wishlistGet.path, storeCall(ctx, async (req) => {
      await needFeature();
      return answer(signedInOnly(req).id);
    }));

    r.put(STORE_ROUTES.wishlistPut.path, storeCall(ctx, async (req) => {
      await needFeature();
      const body = parseBody(WishlistPut, req.body);
      const shopper = signedInOnly(req);
      const { full } = await repo.change(shopper.id, body);
      log.info('wishlist.changed', { shopperId: shopper.id, added: body.add.length, removed: body.remove.length, full });
      return answer(shopper.id, full ? [`Your wishlist holds up to ${STORE_LIMITS.wishlistItems} items. Remove something to save more.`] : []);
    }));

    r.get(WISHLIST_SCRIPT, async (req, res, next) => {
      try {
        if (!(await featureOn(ctx))) return next();
        res.set('Cache-Control', 'public, max-age=3600');
        return res.type('text/javascript').send(WISHLIST_JS);
      } catch (err) {
        return next(err);
      }
    });

    r.get(STORE_ROUTES.wishlistPage.path, async (req, res, next) => {
      try {
        if (!(await featureOn(ctx))) return next();
        const shopper = await shopperFrom(req, ctx.db);
        const items = shopper ? await repo.items(shopper.id) : [];
        res.set('Cache-Control', 'no-store');
        return await sendStorePage(ctx, req, res, {
          kind: 'other', ref: 'wishlist', title: 'Your wishlist',
          main: ({ theme }) => html`${raw(wishBits({ signedIn: Boolean(shopper), saved: items.map((i) => i.productId) }))}
${section({ theme, id: 'wish-h', kicker: 'Saved', title: 'Your wishlist', body: wishlistPage(items, { signedIn: Boolean(shopper) }) })}`,
        });
      } catch (err) {
        return next(err);
      }
    });
    app.use(r);
  },

  /**
   * The hearts and the account's link go on pages other modules draw, some of them mounted before this one (the account,
   * landing pages), so the hooks go in first, before any business is known. Each runs when its page is sent, which is
   * inside that page's business.
   */
  beforeTenant(app, ctx) {
    const repo = wishlistRepo(ctx.db);

    // Hearts on product cards and the product page.
    hookPages(app, {
      name: 'wishlist',
      when: (req) => !NO_HEARTS.test(req.path),
      async transform(page, { req }) {
        const slugs = [...new Set([...page.matchAll(TILE)].map((m) => m[1]))].slice(0, 120);
        if (!slugs.length && !page.includes('data-add-form')) return page;
        if (!(await featureOn(ctx))) return page;
        const ids = await repo.idsBySlug(slugs);
        const marked = page.replace(TILE, (whole, slug) => (ids.has(slug) ? `${whole} data-wish="${ids.get(slug)}"` : whole));
        const shopper = await shopperFrom(req, ctx.db);
        const saved = shopper ? await repo.savedIds(shopper.id) : [];
        return insertBefore(marked, '</body>', wishBits({ signedIn: Boolean(shopper), saved }));
      },
    });

    // A way to the wishlist from the account.
    hookPages(app, {
      name: 'wishlist',
      paths: '/account',
      async transform(page) {
        if (!page.includes('<section class="acct">') || !(await featureOn(ctx))) return page;
        return addToAccount(page, '<div class="panel"><h2>Saved items</h2><p class="muted">Things you saved for later.</p><a class="btn-quiet" href="/wishlist">See your wishlist</a></div>');
      },
    });
  },

  api: (ctx) => ({
    async 'wishlist.counts'({ query }) {
      if (!(await ctx.repos.entitlements.can(WISHLIST_FEATURE))) throw new ApiError('forbidden', 'The wishlist isn’t on your plan.', { reason: 'plan' });
      return wishlistRepo(ctx.db).counts(query);
    },
  }),
};
