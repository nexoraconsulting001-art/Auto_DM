import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { catalogRepo } from '../catalog/repo.js';
import { createFromDraft } from '../catalog/imported.js';
import { pricePaise } from '../imports/extract.js';
import { fromShopify } from '../imports/shopify.js';

/**
 * Products and stock from Shopify (PRD 9.11): the first import of an Admin product, and every change after it, from a
 * webhook or the reconcile. What is linked to what is shopify_links:
 *
 *   product         local_id is products.id
 *   variant         local_id is product_variants.id for a variant with options; for a product sold without options (Shopify's
 *                   one "Default Title" variant) it is minus the product's id, because that product is its own variant
 *   inventory_item  the same local ids as variant: the row that holds the stock
 *   order           local_id is orders.id (push.js)
 *
 * "Latest wins" without going backwards: each product and inventory link keeps the Shopify time of the last change applied
 * (remote_updated_at), and a change no newer than it (a repeat, or one delivered late) changes nothing (S-36). A change with
 * no time at all only ever creates; it never overwrites.
 *
 * Prices: Shopify's rupees as text, read the way imports read them (src/modules/imports/extract.js): a negative, unreadable or
 * absurd price (over ₹100 crore) is refused and the price stays as it was. An MRP is kept only above the price.
 *
 * Stock never oversells. Shopify's count is what is left at Shopify; an order placed here that Shopify has not been told of
 * yet (its push still waiting, or pushed after Shopify counted) is taken off it too. Units held here for an unpaid order are
 * kept: if Shopify's count leaves fewer than are held, nothing more is sold here and the owner is told.
 *
 * Two-way mode only: a price the owner changed here since the last sync, which Shopify also changed, is a conflict. The later
 * change wins and both values go in shopify_conflicts; a local win is pushed to Shopify by push.js.
 */
const DAY_MS = 86_400_000;
const NUL = /\u0000/g;
const text = (value, max) => String(value ?? '').replace(NUL, '').slice(0, max);
const idOf = (value) => (/^[0-9]{1,20}$/.test(String(value ?? '')) ? String(value) : null);
const timeOf = (value) => {
  const at = value ? new Date(value) : null;
  return at && Number.isFinite(at.getTime()) ? at : null;
};
const tracked = (v) => v.inventoryManagement === 'shopify' || (v.inventoryManagement === undefined && Number.isInteger(v.inventoryQuantity));

/** What is kept of an Admin product, from a webhook or a list: ids, names, prices, stock, times. No customer data. */
export function cleanProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const id = idOf(p.id);
  if (!id) return null;
  return {
    id,
    updatedAt: timeOf(p.updated_at)?.toISOString() ?? null,
    status: ['active', 'draft', 'archived'].includes(p.status) ? p.status : '',
    title: text(p.title, 300),
    handle: text(p.handle, 200),
    bodyHtml: text(p.body_html, 20_000),
    productType: text(p.product_type, 100),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 100).map((t) => text(t, 60)) : text(p.tags, 2000),
    options: (Array.isArray(p.options) ? p.options : []).slice(0, 3).map((o) => ({ name: text(o?.name, 60), values: (Array.isArray(o?.values) ? o.values : []).slice(0, 100).map((v) => text(v, 60)) })),
    images: (Array.isArray(p.images) ? p.images : []).slice(0, 6).map((img) => text(img?.src, 2000)).filter((src) => /^https:\/\//.test(src)),
    variants: (Array.isArray(p.variants) ? p.variants : []).slice(0, 100).map((v) => ({
      id: idOf(v?.id),
      price: typeof v?.price === 'string' || typeof v?.price === 'number' ? text(v.price, 40) : '',
      compareAt: typeof v?.compare_at_price === 'string' || typeof v?.compare_at_price === 'number' ? text(v.compare_at_price, 40) : '',
      sku: text(v?.sku, 100),
      option1: v?.option1 == null ? null : text(v.option1, 60),
      option2: v?.option2 == null ? null : text(v.option2, 60),
      option3: v?.option3 == null ? null : text(v.option3, 60),
      inventoryItemId: idOf(v?.inventory_item_id),
      inventoryQuantity: Number.isSafeInteger(v?.inventory_quantity) ? v.inventory_quantity : null,
      inventoryManagement: v?.inventory_management === undefined ? undefined : v.inventory_management === 'shopify' ? 'shopify' : null,
      continueSelling: v?.inventory_policy === 'continue',
    })).filter((v) => v.id),
  };
}

/** What is kept of an inventory level change. */
export function cleanLevel(body) {
  const itemId = idOf(body?.inventory_item_id);
  if (!itemId || !Number.isSafeInteger(body?.available)) return null;
  return { inventoryItemId: itemId, locationId: idOf(body.location_id), available: body.available, updatedAt: timeOf(body.updated_at)?.toISOString() ?? null };
}

/** A cleaned product back in Shopify's own shape, for the import's reader. */
const asShopify = (p) => ({
  id: p.id, title: p.title, handle: p.handle || `product-${p.id}`, body_html: p.bodyHtml, product_type: p.productType, tags: p.tags, options: p.options,
  images: p.images.map((src) => ({ src })),
  variants: p.variants.map((v) => ({ id: v.id, price: v.price, compare_at_price: v.compareAt || null, sku: v.sku, option1: v.option1, option2: v.option2, option3: v.option3 })),
});

export function createProductSync(ctx) {
  const { db, repos } = ctx;
  const catalog = catalogRepo(db);

  // ---- links ----

  async function linkOf(kind, shopifyId) {
    const [row] = await db.query('SELECT * FROM shopify_links WHERE tenant_id = $1 AND kind = $2 AND shopify_id = $3', [tenantId(), kind, shopifyId]);
    return row ?? null;
  }

  async function setLink(kind, localId, shopifyId, { remoteUpdatedAt, localUpdatedAt } = {}) {
    // One local thing is one Shopify thing: a link this one replaces goes first.
    await db.query('DELETE FROM shopify_links WHERE tenant_id = $1 AND kind = $2 AND local_id = $3 AND shopify_id <> $4', [tenantId(), kind, localId, shopifyId]);
    await db.query(
      `INSERT INTO shopify_links (tenant_id, kind, local_id, shopify_id, remote_updated_at, local_updated_at, synced_at) VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, kind, shopify_id) DO UPDATE SET local_id = EXCLUDED.local_id,
         remote_updated_at = COALESCE(GREATEST(shopify_links.remote_updated_at, EXCLUDED.remote_updated_at), shopify_links.remote_updated_at, EXCLUDED.remote_updated_at),
         local_updated_at = COALESCE(EXCLUDED.local_updated_at, shopify_links.local_updated_at), synced_at = now()`,
      [tenantId(), kind, localId, shopifyId, remoteUpdatedAt ?? null, localUpdatedAt ?? null],
    );
  }

  async function productRow(id) {
    const [row] = await db.query('SELECT id, price_paise, mrp_paise, stock, reserved, active, updated_at FROM products WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    return row ?? null;
  }

  /** The local row each Shopify variant is: { ref, variantId } where ref is the link's local_id. */
  async function variantRefs(productId, variants) {
    const rows = await db.query('SELECT id, option_values, source_ref FROM product_variants WHERE tenant_id = $1 AND product_id = $2', [tenantId(), productId]);
    const withOptions = rows.filter((r) => r.option_values.length);
    const out = new Map();
    for (const v of variants) {
      const own = withOptions.find((r) => r.source_ref === v.id);
      if (own) out.set(v.id, { ref: own.id, variantId: own.id });
      else if (!withOptions.length) out.set(v.id, { ref: -productId, variantId: null });
    }
    return out;
  }

  // ---- stock ----

  /** Units sold here that Shopify does not know of yet, for the row holding this stock. */
  async function unseenSales(productId, variantId, countedAt) {
    const [row] = await db.query(
      `SELECT COALESCE(sum(oi.qty), 0)::int AS qty FROM order_items oi
       JOIN shopify_order_pushes p ON p.tenant_id = oi.tenant_id AND p.order_id = oi.order_id
       WHERE oi.tenant_id = $1 AND oi.product_id = $2
         AND CASE WHEN $3::int IS NULL
                  THEN oi.variant_id IS NULL OR oi.variant_id IN (SELECT v.id FROM product_variants v WHERE v.tenant_id = $1 AND v.product_id = $2 AND v.option_values = '{}')
                  ELSE oi.variant_id = $3::int END
         AND (p.status IN ('pending', 'failed') OR (p.status = 'pushed' AND $4::timestamptz IS NOT NULL AND p.pushed_at > $4::timestamptz))`,
      [tenantId(), productId, variantId, countedAt],
    );
    return row.qty;
  }

  /**
   * Sets stock from Shopify's count `available` (null: Shopify doesn't count it, so neither do we). Returns 'changed',
   * 'same' or 'clamped' (fewer at Shopify than are held here).
   */
  async function applyStock({ productId, variantId }, available, { countedAt = null, itemId = '' } = {}) {
    const table = variantId ? 'product_variants' : 'products';
    const id = variantId ?? productId;
    const unseen = available === null ? 0 : await unseenSales(productId, variantId, countedAt);
    return db.tx(async (t) => {
      const [now] = await t.query(`SELECT stock, reserved FROM ${table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId(), id]);
      if (!now) return 'same';
      if (available === null) {
        if (now.stock === null) return 'same';
        await t.query(`UPDATE ${table} SET stock = NULL WHERE tenant_id = $1 AND id = $2`, [tenantId(), id]);
        return 'changed';
      }
      const wanted = Math.max(0, available - unseen);
      const next = Math.max(wanted, now.reserved);
      if (now.stock === next) return next > wanted ? 'clamped' : 'same';
      await t.query(`UPDATE ${table} SET stock = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId(), id, next]);
      if (now.stock !== null) {
        await t.query(
          `INSERT INTO stock_movements (tenant_id, product_id, variant_id, delta, reason, ref, actor) VALUES ($1, $2, $3, $4, 'shopify', $5, 'shopify')
           ON CONFLICT (tenant_id, reason, ref) DO NOTHING`,
          [tenantId(), productId, variantId, next - now.stock, `shopify:item:${itemId || id}:${Date.now()}`.slice(0, 120)],
        );
      }
      return next > wanted ? 'clamped' : 'changed';
    });
  }

  async function oversoldAlert(productId) {
    log.warn('shopify.stock_below_holds', { productId });
    await repos.alerts.raise({
      kind: 'shopify.stock_short',
      severity: 'warning',
      message: 'Shopify has fewer of a product in stock than unpaid orders here are holding. Nothing more of it is sold here until stock is back.',
      target: `product:${productId}`,
      dedupeKey: `shopify-stock-short:${productId}:${new Date().toISOString().slice(0, 10)}`,
    }).catch((err) => reportError(err, { msg: 'shopify.alert_failed' }));
  }

  /** An inventory_levels/update: one inventory item's count at Shopify. */
  async function applyLevel(level) {
    const link = await linkOf('inventory_item', level.inventoryItemId);
    if (!link) return 'unknown_item';
    const at = timeOf(level.updatedAt);
    if (!at || (link.remote_updated_at && at <= new Date(link.remote_updated_at))) return 'stale';
    const local = Number(link.local_id);
    const ref = local < 0 ? { productId: -local, variantId: null } : { productId: await productOfVariant(local), variantId: local };
    if (!ref.productId) return 'unknown_item';
    const result = await applyStock(ref, level.available, { countedAt: at, itemId: level.inventoryItemId });
    await setLink('inventory_item', local, level.inventoryItemId, { remoteUpdatedAt: at });
    if (result === 'clamped') await oversoldAlert(ref.productId);
    return 'processed';
  }

  async function productOfVariant(variantId) {
    const [row] = await db.query('SELECT product_id FROM product_variants WHERE tenant_id = $1 AND id = $2', [tenantId(), variantId]);
    return row?.product_id ?? null;
  }

  // ---- prices ----

  const priceOf = (v) => pricePaise(v.price);
  const mrpOf = (v, price) => {
    const mrp = pricePaise(v.compareAt);
    return mrp !== null && price !== null && mrp > price ? mrp : null;
  };

  async function conflict({ kind, localId, shopifyId, field, localValue, remoteValue, winner }) {
    await db.query(
      `INSERT INTO shopify_conflicts (tenant_id, kind, local_id, shopify_id, field, local_value, remote_value, winner) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId(), kind, localId, shopifyId, field, String(localValue ?? '').slice(0, 500), String(remoteValue ?? '').slice(0, 500), winner],
    );
  }

  /** Writes a product's own price (a product sold without options), keeping its plain SKU variant in step. */
  async function setProductPrice(productId, price, mrp) {
    await db.tx(async (t) => {
      await t.query('UPDATE products SET price_paise = $3, mrp_paise = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), productId, price, mrp]);
      await t.query(
        `UPDATE product_variants SET price_paise = $3, mrp_paise = $4, updated_at = now() WHERE tenant_id = $1 AND product_id = $2 AND option_values = '{}'`,
        [tenantId(), productId, price, mrp],
      );
    });
  }

  /** Writes one option variant's price, then the product's own price as the lowest of its variants. */
  async function setVariantPrice(productId, variantId, price, mrp) {
    await db.tx(async (t) => {
      await t.query('UPDATE product_variants SET price_paise = $3, mrp_paise = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), variantId, price, mrp]);
      const [low] = await t.query(
        `SELECT price_paise, mrp_paise FROM product_variants WHERE tenant_id = $1 AND product_id = $2 AND option_values <> '{}' ORDER BY price_paise, id LIMIT 1`,
        [tenantId(), productId],
      );
      if (low) await t.query('UPDATE products SET price_paise = $3, mrp_paise = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), productId, low.price_paise, low.mrp_paise]);
    });
  }

  // ---- a whole product ----

  /** Adds an Admin product that has no link yet, or links one an earlier storefront import (8.3) already made. */
  async function create(product, connection) {
    if (product.status && product.status !== 'active') return { outcome: 'not_active' };
    const draft = fromShopify(asShopify(product), `https://${connection.shopDomain}`);
    if (!draft) return { outcome: 'unreadable' };
    const handle = draft.handle;
    let productId = null;
    // The same product read earlier from the shop's storefront: link it instead of making a second one.
    const earlier = await db.query(
      `SELECT p.id FROM products p WHERE p.tenant_id = $1 AND p.source = 'shopify' AND p.source_ref LIKE '%/' || $2
         AND NOT EXISTS (SELECT 1 FROM shopify_links l WHERE l.tenant_id = p.tenant_id AND l.kind = 'product' AND l.local_id = p.id) LIMIT 2`,
      [tenantId(), handle],
    );
    if (earlier.length === 1) productId = earlier[0].id;
    else {
      productId = await createFromDraft(catalog, { ...draft, externalUrl: '' }, { source: 'shopify', sourceRef: `${connection.shopDomain}/${handle}`.slice(0, 500), priceManual: false });
    }
    const after = await productRow(productId);
    await setLink('product', productId, product.id, { remoteUpdatedAt: product.updatedAt, localUpdatedAt: after?.updated_at });
    const refs = await variantRefs(productId, product.variants);
    for (const v of product.variants) {
      const ref = refs.get(v.id);
      if (!ref) continue;
      await setLink('variant', ref.ref, v.id);
      if (v.inventoryItemId) await setLink('inventory_item', ref.ref, v.inventoryItemId, { remoteUpdatedAt: product.updatedAt });
      const available = v.continueSelling || !tracked(v) ? null : v.inventoryQuantity;
      const result = await applyStock({ productId, variantId: ref.variantId }, available, { countedAt: timeOf(product.updatedAt), itemId: v.inventoryItemId ?? '' });
      if (result === 'clamped') await oversoldAlert(productId);
    }
    if (earlier.length === 1) {
      await applyPrices(productId, product, connection, { force: true });
      // What was just written here is Shopify's, not an owner's change.
      await setLink('product', productId, product.id, { localUpdatedAt: (await productRow(productId))?.updated_at });
    }
    log.info('shopify.product_linked', { productId, adopted: earlier.length === 1 });
    return { outcome: 'created', productId };
  }

  /** Applies Shopify's prices to a linked product. In two-way mode an owner's newer change here wins, and the clash is kept. */
  async function applyPrices(productId, product, connection, { force = false } = {}) {
    const current = await productRow(productId);
    if (!current) return;
    const link = await linkOf('product', product.id);
    const localChanged = !force && connection.mode === 'two_way' && link?.local_updated_at && new Date(current.updated_at) > new Date(link.local_updated_at);
    const remoteAt = timeOf(product.updatedAt);
    const refs = await variantRefs(productId, product.variants);
    for (const v of product.variants) {
      const ref = refs.get(v.id);
      if (!ref) continue;
      const price = priceOf(v);
      if (price === null) {
        log.warn('shopify.price_refused', { productId, variant: v.id });
        continue;
      }
      const mrp = mrpOf(v, price);
      const [was] = ref.variantId
        ? await db.query('SELECT price_paise, mrp_paise FROM product_variants WHERE tenant_id = $1 AND id = $2', [tenantId(), ref.variantId])
        : [current];
      if (!was || (Number(was.price_paise) === price && (was.mrp_paise === null ? null : Number(was.mrp_paise)) === mrp)) continue;
      if (localChanged) {
        const winner = remoteAt && remoteAt > new Date(current.updated_at) ? 'remote' : 'local';
        await conflict({ kind: ref.variantId ? 'variant' : 'product', localId: ref.ref, shopifyId: v.id, field: 'price', localValue: Number(was.price_paise), remoteValue: price, winner });
        if (winner === 'local') continue;
      }
      if (ref.variantId) await setVariantPrice(productId, ref.variantId, price, mrp);
      else await setProductPrice(productId, price, mrp);
    }
  }

  /**
   * A products/create or products/update, or a product read by the reconcile. Returns what happened: 'created',
   * 'processed', 'stale' (not newer than what was applied) or why nothing was done.
   */
  async function applyProduct(product, connection) {
    const link = await linkOf('product', product.id);
    if (!link) return (await create(product, connection)).outcome;
    const productId = Number(link.local_id);
    const current = await productRow(productId);
    if (!current) {
      await db.query(`DELETE FROM shopify_links WHERE tenant_id = $1 AND kind = 'product' AND shopify_id = $2`, [tenantId(), product.id]);
      return (await create(product, connection)).outcome;
    }
    const at = timeOf(product.updatedAt);
    // A change with no time, or none newer than the last one applied, never overwrites (S-36).
    if (!at || (link.remote_updated_at && at <= new Date(link.remote_updated_at))) return 'stale';
    if (product.status && product.status !== 'active' && current.active) {
      await db.query('UPDATE products SET active = false, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), productId]);
    }
    await applyPrices(productId, product, connection);
    const refs = await variantRefs(productId, product.variants);
    for (const v of product.variants) {
      const ref = refs.get(v.id);
      if (!ref) continue;
      await setLink('variant', ref.ref, v.id);
      if (!v.inventoryItemId) continue;
      const itemLink = await linkOf('inventory_item', v.inventoryItemId);
      if (itemLink?.remote_updated_at && at <= new Date(itemLink.remote_updated_at)) continue;
      const available = v.continueSelling || !tracked(v) ? null : v.inventoryQuantity;
      if (available === null && v.inventoryManagement === undefined) continue;
      const result = await applyStock({ productId, variantId: ref.variantId }, available, { countedAt: at, itemId: v.inventoryItemId });
      await setLink('inventory_item', ref.ref, v.inventoryItemId, { remoteUpdatedAt: at });
      if (result === 'clamped') await oversoldAlert(productId);
    }
    const after = await productRow(productId);
    await setLink('product', productId, product.id, { remoteUpdatedAt: at, localUpdatedAt: after?.updated_at });
    return 'processed';
  }

  /** products/delete: Shopify no longer sells it, so neither does the store. */
  async function removeProduct(shopifyId) {
    const link = await linkOf('product', shopifyId);
    if (!link) return 'unknown_product';
    await db.query('UPDATE products SET active = false, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tenantId(), Number(link.local_id)]);
    return 'processed';
  }

  /**
   * The reconcile: every Admin product (changed since `since`, or all), page by page. Catches what a missed webhook would
   * have said. Returns counts.
   */
  async function reconcile(connection, { since = null, maxPages = 200 } = {}) {
    const counts = { read: 0, created: 0, processed: 0, stale: 0, other: 0 };
    let pageInfo = null;
    for (let page = 0; page < maxPages; page++) {
      const { items, nextPageInfo } = await connection.client.products(pageInfo ? { pageInfo } : { since: since ?? undefined });
      for (const raw of items) {
        const product = cleanProduct(raw);
        if (!product) continue;
        counts.read++;
        try {
          const outcome = await applyProduct(product, connection);
          counts[outcome in counts ? outcome : 'other']++;
        } catch (err) {
          counts.other++;
          reportError(err, { msg: 'shopify.reconcile_product_failed', product: product.id });
        }
      }
      if (!nextPageInfo) break;
      pageInfo = nextPageInfo;
    }
    return counts;
  }

  return { applyProduct, applyLevel, removeProduct, reconcile, linkOf, setLink, unseenSales, conflict, DAY_MS };
}
