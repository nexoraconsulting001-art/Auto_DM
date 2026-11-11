import { STORE_LIMITS } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';
import { mergeLines } from '../checkout/pricing.js';

/**
 * The server cart (PRD 9.2): one open cart per shopper at one business, mirrored from the browser's bag once the shopper is
 * signed in, so a second device (S-06) and the reminders (9.15) see it. It holds products, variants and quantities, never a
 * price. Every line names a product of this business; a variant must be that product's, or the line is dropped.
 *
 *   lines(shopperId)                    the open cart's lines, oldest first
 *   replace(shopperId, lines, { visitorId })  the bag as it is now: merged, 10 a line, 50 lines. An empty bag closes the cart.
 *   ordered(shopperId)                  the order was placed: the cart is closed, and the next bag starts a new one
 */
export function cartRepo(db) {
  const openLines = (shopperId, q = db) => q.query(
    `SELECT l.product_id AS "productId", l.variant_id AS "variantId", l.qty FROM cart_lines l JOIN carts c ON c.tenant_id = l.tenant_id AND c.id = l.cart_id
     WHERE c.tenant_id = $1 AND c.shopper_id = $2 AND c.status = 'active' ORDER BY l.id`,
    [tenantId(), shopperId],
  );
  return {
    lines: openLines,

    async replace(shopperId, linesIn, { visitorId = null } = {}) {
      const tid = tenantId();
      const lines = mergeLines(linesIn).map((l) => ({ ...l, qty: Math.min(STORE_LIMITS.maxQtyPerLine, l.qty) })).slice(0, STORE_LIMITS.maxCartLines);
      return db.tx(async (t) => {
        if (!lines.length) {
          await t.query(`UPDATE carts SET status = 'emptied', updated_at = now() WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'active'`, [tid, shopperId]);
          return [];
        }
        const [cart] = await t.query(
          `INSERT INTO carts (tenant_id, shopper_id, visitor_id) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, shopper_id) WHERE status = 'active'
           DO UPDATE SET updated_at = now(), last_activity_at = now(), visitor_id = COALESCE(EXCLUDED.visitor_id, carts.visitor_id)
           RETURNING id`,
          [tid, shopperId, visitorId],
        );
        await t.query('DELETE FROM cart_lines WHERE tenant_id = $1 AND cart_id = $2', [tid, cart.id]);
        await t.query(
          `INSERT INTO cart_lines (tenant_id, cart_id, product_id, variant_id, qty)
           SELECT $1, $2, x.product_id, x.variant_id, x.qty FROM unnest($3::int[], $4::int[], $5::int[]) WITH ORDINALITY AS x(product_id, variant_id, qty, n)
           WHERE EXISTS (SELECT 1 FROM products p WHERE p.tenant_id = $1 AND p.id = x.product_id)
             AND (x.variant_id IS NULL OR EXISTS (SELECT 1 FROM product_variants v WHERE v.tenant_id = $1 AND v.id = x.variant_id AND v.product_id = x.product_id))
           ORDER BY x.n`,
          [tid, cart.id, lines.map((l) => l.productId), lines.map((l) => l.variantId), lines.map((l) => l.qty)],
        );
        return openLines(shopperId, t);
      });
    },

    async ordered(shopperId) {
      await db.query(`UPDATE carts SET status = 'ordered', updated_at = now() WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'active'`, [tenantId(), shopperId]);
    },
  };
}
