import { STORE_LIMITS, taxInside } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';

/**
 * Prices a bag from the catalog (PRD 9.2, 9.5). A line coming in is a product, a variant and a quantity and nothing else;
 * every name, price, photo and tax rate going out is the database's (S-05). Used by the cart, a quote, the coupon check and
 * the order itself: placing an order passes `lock: true`, which locks the product and variant rows in id order for the
 * length of the transaction.
 *
 *   priceLines(q, lines, { lock }) -> { lines, notices }
 *
 * Each line out is a PricedLine (src/contracts/store-routes.js) plus what an order line needs (sku, hsnCode, gstRateBp,
 * weightGrams, available, stockVariantId). `state` says whether it can be bought:
 *   ok        yes
 *   capped    yes, but the quantity was cut to 10 or to what is left; `qty` is the new one
 *   sold_out  nothing left, or marked out of stock
 *   inactive  hidden, removed, another business's, or it needs an option that wasn't chosen
 *
 * Where stock lives (9.12): a variant with options holds its own stock. A product with no options keeps its stock on the
 * product row, even when the catalog keeps one plain variant for its SKU; that variant is bought as the product.
 * `stockVariantId` names the variant whose row holds the stock, or null for the product's. NULL stock is unlimited.
 */
const keyOf = (line) => `${line.productId}:${line.variantId ?? 0}`;

/** The same product and option is one line; quantities add up (9.2). */
export function mergeLines(lines = []) {
  const merged = new Map();
  for (const line of lines) {
    const key = keyOf(line);
    const before = merged.get(key);
    if (before) before.qty += line.qty;
    else merged.set(key, { productId: line.productId, variantId: line.variantId ?? null, qty: line.qty });
  }
  return [...merged.values()];
}

/** True when a variant is a real choice (size M), not the plain one the catalog keeps for a product's SKU. */
export const hasOptions = (variant) => Array.isArray(variant?.option_values) && variant.option_values.length > 0;

const imageOf = (product) => {
  const first = Array.isArray(product.images) ? product.images[0] : null;
  return typeof first === 'string' ? first : typeof first?.url === 'string' ? first.url : '';
};

const LIVE = (p) => p.active && !['broken', 'missing'].includes(p.fetch_status);

export async function priceLines(q, linesIn, { lock = false } = {}) {
  const tid = tenantId();
  const all = mergeLines(linesIn);
  const lines = all.slice(0, STORE_LIMITS.maxCartLines);
  const notices = [];
  if (all.length > STORE_LIMITS.maxCartLines) notices.push(`A bag holds ${STORE_LIMITS.maxCartLines} different items. The rest were left out.`);
  const ids = [...new Set(lines.map((l) => l.productId))].sort((a, b) => a - b);
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const products = ids.length
    ? await q.query(
      `SELECT id, name, slug, price_paise, images, option_values, stock, reserved, active, in_stock, fetch_status, gst_rate_bp, hsn_code, weight_grams
       FROM products WHERE tenant_id = $1 AND id = ANY($2::int[]) ORDER BY id${forUpdate}`,
      [tid, ids],
    )
    : [];
  const variants = ids.length
    ? await q.query(
      `SELECT id, product_id, option_values, sku, price_paise, in_stock, stock, reserved, weight_grams
       FROM product_variants WHERE tenant_id = $1 AND product_id = ANY($2::int[]) ORDER BY id${forUpdate}`,
      [tid, ids],
    )
    : [];
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantsOf = new Map();
  for (const v of variants) variantsOf.set(v.product_id, [...(variantsOf.get(v.product_id) ?? []), v]);

  const priced = lines.map((line) => {
    const product = productById.get(line.productId);
    const own = variantsOf.get(line.productId) ?? [];
    const choices = own.filter(hasOptions);
    const plain = own.find((v) => !hasOptions(v)) ?? null;
    // A chosen variant must be this product's. With no options, the plain variant (if any) is the product itself.
    const variant = line.variantId !== null ? own.find((v) => v.id === line.variantId) ?? null : choices.length ? null : plain;
    const out = {
      productId: line.productId, variantId: variant?.id ?? line.variantId, name: product?.name ?? '', option: hasOptions(variant) ? variant.option_values.join(' / ') : '',
      image: product ? imageOf(product) : '', qty: line.qty, unitPaise: 0, linePaise: 0, state: 'ok',
      sku: variant?.sku ?? '', hsnCode: product?.hsn_code ?? '', gstRateBp: product?.gst_rate_bp ?? 0,
      weightGrams: variant?.weight_grams ?? product?.weight_grams ?? null, available: null, stockVariantId: hasOptions(variant) ? variant.id : null,
    };
    // Options chosen as plain text in the Phase 0 store have no variant to hold their stock, so they can't be ordered here.
    const needsOption = !variant ? choices.length > 0 || (product?.option_values?.length ?? 0) > 0 : choices.length > 0 && !hasOptions(variant);
    if (!product || !LIVE(product) || (line.variantId !== null && !variant) || needsOption) {
      out.state = 'inactive';
      if (product && LIVE(product) && needsOption) notices.push(`Choose an option for ${product.name}.`);
      else notices.push(product ? `${product.name} is no longer available.` : 'An item in your bag is no longer available.');
      return out;
    }
    out.unitPaise = Number(variant ? variant.price_paise : product.price_paise);
    const counted = hasOptions(variant) ? variant : product;
    const sellable = product.in_stock && (!hasOptions(variant) || variant.in_stock);
    const available = counted.stock === null ? Infinity : Math.max(0, counted.stock - counted.reserved);
    out.available = Number.isFinite(available) ? available : null;
    if (!sellable || available <= 0) {
      out.state = 'sold_out';
      notices.push(`${product.name}${out.option ? ` (${out.option})` : ''} is sold out.`);
    } else {
      if (out.qty > STORE_LIMITS.maxQtyPerLine) {
        out.qty = STORE_LIMITS.maxQtyPerLine;
        out.state = 'capped';
        notices.push(`You can buy up to ${STORE_LIMITS.maxQtyPerLine} of ${product.name} in one order.`);
      }
      if (out.qty > available) {
        out.qty = available;
        out.state = 'capped';
        notices.push(`Only ${available} left of ${product.name}${out.option ? ` (${out.option})` : ''}.`);
      }
    }
    out.linePaise = out.unitPaise * out.qty;
    return out;
  });
  return { lines: priced, notices };
}

export const buyable = (line) => line.state === 'ok' || line.state === 'capped';

/** The fields of a PricedLine, without what only the server needs. A line that can't be bought shows no amount. */
export const publicLine = ({ productId, variantId, name, option, image, qty, unitPaise, linePaise, state }) =>
  ({ productId, variantId, name, option, image, qty, unitPaise, linePaise: buyable({ state }) ? linePaise : 0, state });

/**
 * Splits a discount over the lines it applies to, in proportion to each line's value, in whole paise that add up exactly
 * and never exceed a line. Returns one share per line, in order (0 for a line it doesn't apply to).
 */
export function splitDiscount(lines, eligible, discountPaise) {
  const shares = lines.map(() => 0);
  const base = lines.reduce((sum, line, i) => sum + (eligible[i] ? line.linePaise : 0), 0);
  if (discountPaise <= 0 || base <= 0) return shares;
  const total = Math.min(discountPaise, base);
  let given = 0;
  const remainders = [];
  lines.forEach((line, i) => {
    if (!eligible[i] || line.linePaise <= 0) return;
    const exact = BigInt(total) * BigInt(line.linePaise);
    shares[i] = Number(exact / BigInt(base));
    given += shares[i];
    remainders.push({ i, rest: Number(exact % BigInt(base)) });
  });
  remainders.sort((a, b) => b.rest - a.rest || a.i - b.i);
  // Each share is at most its line and the total at most the base, so this ends: every pass gives at least one paisa.
  for (let k = 0; given < total; k = (k + 1) % remainders.length) {
    const { i } = remainders[k];
    if (shares[i] < lines[i].linePaise) {
      shares[i] += 1;
      given += 1;
    }
  }
  return shares;
}

/** GST inside each line after its share of the discount (9.14: GST on the discounted value). Prices include tax. */
export const lineTax = (line, discountShare = 0) => taxInside(Math.max(0, line.linePaise - discountShare), line.gstRateBp).taxPaise;
