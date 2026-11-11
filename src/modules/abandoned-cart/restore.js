import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { formatRupees } from '../../contracts/catalog.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { html, jsonScript, raw } from '../../views/html.js';
import { section } from '../../views/buyer/index.js';
import { buyable, priceLines, publicLine } from '../checkout/pricing.js';
import { shopperFrom, storeOn } from '../storefront/http.js';
import { sendStoreNotFound, sendStorePage } from '../storefront/shell.js';

/**
 * GET /cart/restore/:token (PRD 9.15): a cart reminder's link. On the store's own address, with no redirect through anyone
 * else's site. It shows what was in the bag, priced from the catalog now, puts it back in this browser's bag (the bag
 * script's StoreBag), and counts the tap. The token is unguessable and only its hash is stored; a link of another store, a
 * made-up one or one older than 30 days finds nothing. The page shows products only: never the shopper's name, number or
 * address, since a forwarded link must not give those away.
 */
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

// Fills this browser's bag once the bag script has loaded (it is deferred; this runs after it, on DOMContentLoaded).
const FILL_BAG = `document.addEventListener('DOMContentLoaded', function () {
  try {
    var data = JSON.parse(document.getElementById('restore-bag').textContent);
    var bag = window.StoreBag;
    if (!bag || !Array.isArray(data)) return;
    var now = bag.read();
    data.forEach(function (l) {
      var same = now.lines.find(function (x) { return x.productId === l.productId && (x.variantId || null) === (l.variantId || null); });
      if (same) same.qty = Math.max(same.qty, l.qty);
      else if (now.lines.length < 50) now.lines.push({ productId: l.productId, variantId: l.variantId || null, qty: l.qty });
    });
    bag.write(now);
  } catch (e) {}
});`;

export function mountRestore(app, ctx, reminders) {
  app.get(STORE_ROUTES.cartRestore.path, async (req, res, next) => {
    try {
      if (!(await storeOn(ctx.repos))) return next();
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      const token = String(req.params.token ?? '');
      const found = TOKEN.test(token) ? await reminders.byToken(token) : null;
      if (!found) return sendStoreNotFound(ctx, req, res, 'This link isn’t valid. Your bag may still be waiting in the shop.');
      await shopperFrom(req, ctx.db);
      if (found.expired) {
        return sendStorePage(ctx, req, res, {
          status: 410, kind: 'checkout', ref: 'cart_restore', title: 'Link expired',
          main: ({ theme }) => section({ theme, id: 'restore-h', kicker: 'Bag', title: 'This link has expired', body: html`<p>Have a look around the shop for what you liked.</p><p><a class="btn" href="/shop">Go to the shop</a></p>` }),
        });
      }
      await reminders.markClicked(found.id);
      log.info('cart_reminder.clicked', { reminder: Number(found.id), tenantId: tenantId() });
      const lines = await ctx.db.query('SELECT product_id AS "productId", variant_id AS "variantId", qty FROM cart_lines WHERE tenant_id = $1 AND cart_id = $2 ORDER BY id', [tenantId(), found.cart_id]);
      const priced = (await priceLines(ctx.db, lines)).lines;
      const ok = priced.filter(buyable);
      const gone = priced.filter((l) => !buyable(l));
      const ordered = found.cart_status === 'ordered';
      const bag = ordered ? [] : ok.map((l) => ({ productId: l.productId, variantId: l.variantId ?? null, qty: l.qty }));
      const item = (l) => html`<li class="line"><span>${l.name}${l.option ? html` <span class="muted">(${l.option})</span>` : ''}</span><span>× ${l.qty}</span><span>${buyable(l) ? formatRupees(l.linePaise) : 'No longer available'}</span></li>`;
      return sendStorePage(ctx, req, res, {
        kind: 'checkout', ref: 'cart_restore', title: 'Your bag',
        main: ({ theme }) => section({
          theme, id: 'restore-h', kicker: 'Bag', title: ordered ? 'You have already ordered these' : 'Your bag is waiting',
          body: html`<div class="stack" data-restored-bag>
${priced.length ? html`<ul class="lines">${[...ok, ...gone].map((l) => item(publicLine(l)))}</ul>` : html`<p class="notice-box">Your bag is empty now.</p>`}
${ordered ? html`<p><a class="btn wide" href="/account/orders">See your orders</a></p>` : html`<p><a class="btn wide" href="/cart">Go to your bag</a></p>`}
<p class="muted small">Prices are checked again when you place your order.</p>
</div>
<script type="application/json" id="restore-bag">${jsonScript(bag)}</script>
<script>${raw(FILL_BAG)}</script>`,
        }),
      });
    } catch (err) {
      return next(err);
    }
  });
}
