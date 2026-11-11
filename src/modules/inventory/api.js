import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, readCursor, writeCursor } from '../admin-api/paging.js';

/**
 * The console's stock screens (PRD 9.12): every product or variant with what is on hand, what is held and what can be sold,
 * a change to stock on hand with its reason, the movements, and the low-stock threshold. All of it is this business's only.
 */
// A variant with options holds its own stock; a product without options holds it on the product row, even when the catalog
// keeps one plain variant for its SKU (src/modules/checkout/pricing.js says the same for checkout).
const LINES = `
  SELECT p.id AS product_id, NULL::int AS variant_id, p.name, '' AS option,
         COALESCE((SELECT v.sku FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND cardinality(v.option_values) = 0 LIMIT 1), '') AS sku,
         p.stock, p.reserved, p.low_stock_threshold
  FROM products p WHERE p.tenant_id = $1
    AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.tenant_id = p.tenant_id AND v.product_id = p.id AND cardinality(v.option_values) > 0)
  UNION ALL
  SELECT p.id, v.id, p.name, array_to_string(v.option_values, ' / '), v.sku, v.stock, v.reserved, v.low_stock_threshold
  FROM product_variants v JOIN products p ON p.tenant_id = v.tenant_id AND p.id = v.product_id WHERE v.tenant_id = $1 AND cardinality(v.option_values) > 0`;

const toLine = (row, threshold) => {
  const available = row.stock === null ? null : row.stock - row.reserved;
  return {
    productId: row.product_id, variantId: row.variant_id, name: row.name, option: row.option ?? '', sku: row.sku ?? '', stock: row.stock, reserved: row.reserved,
    available, lowStockThreshold: row.low_stock_threshold, low: available !== null && available <= (row.low_stock_threshold ?? threshold),
  };
};

const likeText = (value) => String(value ?? '').replace(/[%_\\]/g, (c) => `\\${c}`);

export function inventoryApi({ db }) {
  const threshold = async (q = db) => (await q.query('SELECT low_stock_threshold FROM inventory_settings WHERE tenant_id = $1', [tenantId()]))[0]?.low_stock_threshold ?? 3;

  return {
    'inventory.list': async ({ query }) => {
      const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 2 && isRowId(key[0]) && Number.isInteger(key[1]) && key[1] >= 0) : null;
      const level = await threshold();
      const rows = await db.query(
        `SELECT * FROM (${LINES}) s
         WHERE ($2 = '' OR s.name ILIKE '%' || $2 || '%' OR s.sku ILIKE '%' || $2 || '%')
           AND ($3 = 'all' OR (s.stock IS NOT NULL AND s.stock - s.reserved <= CASE WHEN $3 = 'out' THEN 0 ELSE COALESCE(s.low_stock_threshold, $4::int) END))
           AND ($5::int IS NULL OR (s.product_id, COALESCE(s.variant_id, 0)) > ($5::int, $6::int))
         ORDER BY s.product_id, COALESCE(s.variant_id, 0) LIMIT $7`,
        [tenantId(), likeText(query.search), query.show, level, after?.[0] ?? null, after?.[1] ?? 0, query.limit + 1],
      );
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return { items: items.map((row) => toLine(row, level)), nextCursor: rows.length > query.limit ? writeCursor([last.product_id, last.variant_id ?? 0]) : null };
    },

    /** Sets stock on hand, or moves it by a number. Never below what is held for orders already placed, and never below zero. */
    'inventory.adjust': async ({ body, user }) => {
      const tid = tenantId();
      return db.tx(async (t) => {
        const [product] = await t.query('SELECT id, name, stock, reserved, low_stock_threshold FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tid, body.productId]);
        if (!product) return null;
        const variants = await t.query(
          `SELECT id, array_to_string(option_values, ' / ') AS option, sku, stock, reserved, low_stock_threshold FROM product_variants
           WHERE tenant_id = $1 AND product_id = $2 AND cardinality(option_values) > 0 ORDER BY id FOR UPDATE`,
          [tid, product.id],
        );
        const variant = body.variantId === null ? null : variants.find((v) => v.id === body.variantId);
        if (body.variantId !== null && !variant) return null;
        if (body.variantId === null && variants.length) throw new ApiError('validation_failed', 'This product has options: change the stock of one of them.', { fields: { variantId: 'Pick an option' } });
        const table = variant ? 'product_variants' : 'products';
        const row = variant ?? product;

        let next = row.stock;
        if (body.stock !== undefined) next = body.stock;
        else if (body.delta !== undefined) {
          if (row.stock === null) throw new ApiError('validation_failed', 'This item isn’t counted. Set its stock first.', { fields: { delta: 'Set the stock first' } });
          next = row.stock + body.delta;
        }
        if (next !== null && next < 0) throw new ApiError('validation_failed', 'Stock can’t go below zero.', { fields: { [body.stock !== undefined ? 'stock' : 'delta']: 'Stock can’t go below zero' } });
        if (next !== null && next < row.reserved) throw new ApiError('conflict', `${row.reserved} are held for orders being paid for. Stock can’t go below that.`);
        if (next === null && row.reserved > 0) throw new ApiError('conflict', `${row.reserved} are held for orders being paid for. Try again once those are paid or released.`);

        const lowAt = body.lowStockThreshold === undefined ? row.low_stock_threshold : body.lowStockThreshold;
        await t.query(`UPDATE ${table} SET stock = $3, low_stock_threshold = $4 WHERE tenant_id = $1 AND id = $2`, [tid, row.id, next, lowAt]);
        const delta = next === null ? 0 : next - (row.stock ?? 0);
        if (delta !== 0) {
          await t.query(
            `INSERT INTO stock_movements (tenant_id, product_id, variant_id, delta, reason, ref, actor) VALUES ($1, $2, $3, $4, 'manual', $5, $6)`,
            [tid, product.id, variant?.id ?? null, delta, `adjust:${crypto.randomUUID()}`, `user:${user.id}`],
          );
        }
        return toLine(
          { product_id: product.id, variant_id: variant?.id ?? null, name: product.name, option: variant?.option ?? '', sku: variant?.sku ?? '', stock: next, reserved: row.reserved, low_stock_threshold: lowAt },
          await threshold(t),
        );
      });
    },

    'inventory.movements': async ({ query }) => {
      const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && Number.isSafeInteger(key[0]) && key[0] > 0)[0] : null;
      const rows = await db.query(
        `SELECT id, product_id, variant_id, delta, reason, order_id, actor, created_at FROM stock_movements
         WHERE tenant_id = $1 AND ($2::int IS NULL OR product_id = $2) AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
        [tenantId(), query.productId ?? null, after, query.limit + 1],
      );
      const items = rows.slice(0, query.limit);
      return {
        items: items.map((m) => ({ id: Number(m.id), productId: m.product_id, variantId: m.variant_id, delta: m.delta, reason: m.reason, orderId: m.order_id, actor: /^user:/.test(m.actor) ? 'Team' : 'System', at: m.created_at })),
        nextCursor: rows.length > query.limit ? writeCursor([Number(items.at(-1).id)]) : null,
      };
    },

    'inventorySettings.get': async () => ({ lowStockThreshold: await threshold() }),

    'inventorySettings.update': async ({ body }) => {
      await db.query(
        `INSERT INTO inventory_settings (tenant_id, low_stock_threshold) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET low_stock_threshold = EXCLUDED.low_stock_threshold, updated_at = now()`,
        [tenantId(), body.lowStockThreshold],
      );
      return { lowStockThreshold: body.lowStockThreshold };
    },
  };
}
