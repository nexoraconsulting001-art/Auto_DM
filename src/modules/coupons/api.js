import { z } from 'zod';
import { ApiError } from '../../contracts/api/errors.js';
import { CartLine } from '../../contracts/store-routes.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { tenantId } from '../../tenancy.js';
import { readCursor, writeCursor } from '../admin-api/paging.js';
import { buyable, priceLines } from '../checkout/pricing.js';
import { toE164 } from '../checkout/quote.js';
import { limited, parseBody, storeCall } from '../storefront/http.js';
import { COUPON_CODE, evaluate, normalizeCode } from './rules.js';

/**
 * The console's coupons (PRD 9.14) and the shopper's code check. A code is unique per business whatever its case. Once a
 * coupon has been used, its code and kind are fixed, and it can be turned off but not removed, so its orders keep it.
 * A coupon may name the reel or post it was made for (7.4): that page must be this business's, and so must every product
 * or category it is limited to.
 */
const FEATURE = 'store.coupons';

export const toCoupon = (row) => ({
  id: row.id, code: row.code, kind: row.kind, percentBp: row.percent_bp, amountPaise: row.amount_paise === null ? null : Number(row.amount_paise),
  maxDiscountPaise: row.max_discount_paise === null ? null : Number(row.max_discount_paise), minOrderPaise: Number(row.min_order_paise),
  startsAt: row.starts_at, endsAt: row.ends_at, maxUses: row.max_uses, maxUsesPerCustomer: row.max_uses_per_customer, usedCount: row.used_count,
  firstOrderOnly: row.first_order_only, scope: row.scope, scopeIds: row.scope_ids ?? [], pageId: row.page_id, active: row.active, createdAt: row.created_at,
});

const COLUMNS = Object.freeze({
  code: 'code', kind: 'kind', percentBp: 'percent_bp', amountPaise: 'amount_paise', maxDiscountPaise: 'max_discount_paise', minOrderPaise: 'min_order_paise',
  startsAt: 'starts_at', endsAt: 'ends_at', maxUses: 'max_uses', maxUsesPerCustomer: 'max_uses_per_customer', firstOrderOnly: 'first_order_only',
  scope: 'scope', scopeIds: 'scope_ids', pageId: 'page_id', active: 'active',
});

const invalid = (field, message) => new ApiError('validation_failed', message, { fields: { [field]: message } });

/** The coupon as it will be, checked as a whole: the kind's own amount, the dates, the scope. */
function check(next) {
  if (next.kind === 'percent') {
    if (!next.percent_bp) throw invalid('percentBp', 'Enter the percentage off');
    if (next.amount_paise !== null) throw invalid('amountPaise', 'A percentage coupon has no flat amount');
  } else if (next.kind === 'flat') {
    if (!next.amount_paise) throw invalid('amountPaise', 'Enter the amount off');
    if (next.percent_bp !== null) throw invalid('percentBp', 'A flat coupon has no percentage');
    if (next.max_discount_paise !== null) throw invalid('maxDiscountPaise', 'A flat coupon has no cap');
  } else {
    if (next.percent_bp !== null || next.amount_paise !== null) throw invalid('kind', 'Free delivery has no amount');
    if (next.max_discount_paise !== null) throw invalid('maxDiscountPaise', 'Free delivery has no cap');
  }
  if (next.starts_at && next.ends_at && new Date(next.ends_at) <= new Date(next.starts_at)) throw invalid('endsAt', 'The end must be after the start');
  if (next.scope !== 'all' && !next.scope_ids?.length) throw invalid('scopeIds', next.scope === 'products' ? 'Pick at least one product' : 'Pick at least one category');
  if (next.max_uses !== null && next.max_uses < next.used_count) throw invalid('maxUses', `It has been used ${next.used_count} times already`);
}

async function checkOwned(q, next) {
  const tid = tenantId();
  if (next.scope !== 'all') {
    const table = next.scope === 'products' ? 'products' : 'categories';
    const ids = [...new Set(next.scope_ids)];
    const [{ n }] = await q.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::int[])`, [tid, ids]);
    if (n !== ids.length) throw invalid('scopeIds', next.scope === 'products' ? 'Pick products from your catalog' : 'Pick categories from your store');
    next.scope_ids = ids;
  } else {
    next.scope_ids = [];
  }
  if (next.page_id !== null) {
    const [page] = await q.query('SELECT 1 FROM reels WHERE tenant_id = $1 AND id = $2', [tid, next.page_id]);
    if (!page) throw invalid('pageId', 'Pick one of your reels or posts');
  }
}

const isUnique = (err) => err?.code === '23505';

export function couponsApi({ db, repos }) {
  const included = async () => {
    if (!(await repos.entitlements.can(FEATURE))) throw new ApiError('forbidden', 'Discount codes come with the store plan.');
  };
  const load = async (id, q = db, lock = false) => (await q.query(`SELECT * FROM coupons WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [tenantId(), id]))[0] ?? null;

  return {
    'coupons.list': async ({ query }) => {
      await included();
      const after = query.cursor ? readCursor(query.cursor, (key) => key.length === 1 && Number.isInteger(key[0]) && key[0] > 0)[0] : null;
      const search = normalizeCode(query.search).replace(/[^A-Z0-9_-]/g, '');
      const rows = await db.query(
        `SELECT * FROM coupons WHERE tenant_id = $1 AND ($2 = '' OR code LIKE '%' || $2 || '%') AND ($3::int IS NULL OR id < $3)
           AND CASE $4 WHEN 'active' THEN active AND (ends_at IS NULL OR ends_at > now()) AND (max_uses IS NULL OR used_count < max_uses)
                       WHEN 'ended' THEN NOT active OR ends_at <= now() OR (max_uses IS NOT NULL AND used_count >= max_uses) ELSE true END
         ORDER BY id DESC LIMIT $5`,
        [tenantId(), search.replace(/_/g, '\\_'), after, query.show, query.limit + 1],
      );
      const items = rows.slice(0, query.limit);
      return { items: items.map(toCoupon), nextCursor: rows.length > query.limit ? writeCursor([items.at(-1).id]) : null };
    },

    'coupons.create': async ({ body }) => {
      await included();
      const next = {
        code: body.code, kind: body.kind, percent_bp: body.percentBp ?? null, amount_paise: body.amountPaise ?? null, max_discount_paise: body.maxDiscountPaise ?? null,
        min_order_paise: body.minOrderPaise ?? 0, starts_at: body.startsAt ?? null, ends_at: body.endsAt ?? null, max_uses: body.maxUses ?? null,
        max_uses_per_customer: body.maxUsesPerCustomer ?? null, first_order_only: body.firstOrderOnly ?? false, scope: body.scope ?? 'all',
        scope_ids: body.scopeIds ?? [], page_id: body.pageId ?? null, active: body.active ?? true, used_count: 0,
      };
      if (!COUPON_CODE.test(next.code)) throw invalid('code', 'Use 2 to 40 letters, digits, - or _');
      check(next);
      await checkOwned(db, next);
      try {
        const [row] = await db.query(
          `INSERT INTO coupons (tenant_id, code, kind, percent_bp, amount_paise, max_discount_paise, min_order_paise, starts_at, ends_at, max_uses, max_uses_per_customer,
             first_order_only, scope, scope_ids, page_id, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::int[], $15, $16) RETURNING *`,
          [tenantId(), next.code, next.kind, next.percent_bp, next.amount_paise, next.max_discount_paise, next.min_order_paise, next.starts_at, next.ends_at, next.max_uses,
            next.max_uses_per_customer, next.first_order_only, next.scope, next.scope_ids, next.page_id, next.active],
        );
        return toCoupon(row);
      } catch (err) {
        if (isUnique(err)) throw new ApiError('conflict', 'You already have a code like this.', { fields: { code: 'Already in use' } });
        throw err;
      }
    },

    'coupons.get': async ({ params }) => {
      await included();
      const row = await load(params.id);
      return row && toCoupon(row);
    },

    'coupons.update': async ({ params, body }) => {
      await included();
      try {
        return await db.tx(async (t) => {
          const row = await load(params.id, t, true);
          if (!row) return null;
          const next = { ...row };
          for (const [field, column] of Object.entries(COLUMNS)) if (body[field] !== undefined) next[column] = body[field];
          if (row.used_count > 0 && (next.code !== row.code || next.kind !== row.kind)) {
            throw new ApiError('conflict', 'This code has been used, so its code and kind stay as they are. Make a new one instead.');
          }
          if (next.kind !== row.kind) {
            // A new kind drops the old kind's amount unless the change gives one.
            if (body.percentBp === undefined && next.kind !== 'percent') next.percent_bp = null;
            if (body.amountPaise === undefined && next.kind !== 'flat') next.amount_paise = null;
            if (body.maxDiscountPaise === undefined && next.kind !== 'percent') next.max_discount_paise = null;
          }
          if (!COUPON_CODE.test(next.code)) throw invalid('code', 'Use 2 to 40 letters, digits, - or _');
          check(next);
          await checkOwned(t, next);
          const [updated] = await t.query(
            `UPDATE coupons SET code = $3, kind = $4, percent_bp = $5, amount_paise = $6, max_discount_paise = $7, min_order_paise = $8, starts_at = $9, ends_at = $10,
               max_uses = $11, max_uses_per_customer = $12, first_order_only = $13, scope = $14, scope_ids = $15::int[], page_id = $16, active = $17, updated_at = now()
             WHERE tenant_id = $1 AND id = $2 RETURNING *`,
            [tenantId(), row.id, next.code, next.kind, next.percent_bp, next.amount_paise, next.max_discount_paise, next.min_order_paise, next.starts_at, next.ends_at,
              next.max_uses, next.max_uses_per_customer, next.first_order_only, next.scope, next.scope_ids, next.page_id, next.active],
          );
          return toCoupon(updated);
        });
      } catch (err) {
        if (isUnique(err)) throw new ApiError('conflict', 'You already have a code like this.', { fields: { code: 'Already in use' } });
        throw err;
      }
    },

    'coupons.remove': async ({ params }) => {
      await included();
      return db.tx(async (t) => {
        const row = await load(params.id, t, true);
        if (!row) throw new ApiError('not_found'); // a route with no body answers 204 for anything but a throw
        const [used] = await t.query('SELECT 1 FROM coupon_redemptions WHERE tenant_id = $1 AND coupon_id = $2 LIMIT 1', [tenantId(), row.id]);
        if (used || row.used_count > 0) throw new ApiError('conflict', 'This code has been used, so its orders keep it. Turn it off instead.');
        await t.query('DELETE FROM coupons WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
        return true;
      });
    },

    /** Orders that used it and weren't cancelled, what it took off them, and what they came to (7.4). */
    'coupons.stats': async ({ params }) => {
      await included();
      const row = await load(params.id);
      if (!row) return null;
      const [stats] = await db.query(
        `SELECT count(*)::int AS orders, COALESCE(sum(r.discount_paise), 0) AS discount, COALESCE(sum(o.total_paise), 0) AS revenue
         FROM coupon_redemptions r JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id
         WHERE r.tenant_id = $1 AND r.coupon_id = $2 AND r.status = 'applied' AND o.fulfilment_status NOT IN ('cancelled', 'rto_delivered')`,
        [tenantId(), row.id],
      );
      return { couponId: row.id, orders: stats.orders, discountPaise: Number(stats.discount), revenuePaise: Number(stats.revenue) };
    },
  };
}

/** What the shopper's page sends to try a code: the code, the bag's lines, and the phone if typed. Strict, like every store body. */
export const CouponCheck = z.strictObject({
  code: z.string().trim().min(1, 'Enter a code').max(40),
  lines: z.array(CartLine).min(1, 'Your bag is empty').max(STORE_LIMITS.maxCartLines),
  phone: z.string().trim().max(20).optional(),
});
const CHECKS = Object.freeze({ limit: 30, windowMs: 10 * 60_000 });

/** POST /api/store/coupons/check -> { code, applied, message, discountPaise, freeShipping }. A code is tried at most 30 times in 10 minutes from one address. */
export function couponCheck(ctx) {
  return storeCall(ctx, async (req) => {
    const body = parseBody(CouponCheck, req.body);
    await limited(ctx.platform, 'coupon_checks', `${tenantId()}:${req.ip ?? ''}`, CHECKS);
    if (!(await ctx.repos.entitlements.can(FEATURE))) return { body: { code: normalizeCode(body.code), applied: false, message: 'This code isn’t valid.', discountPaise: 0, freeShipping: false } };
    const priced = (await priceLines(ctx.db, body.lines)).lines.filter(buyable);
    const phone = (body.phone && toE164(body.phone)) || req.shopper?.phone || '';
    const result = priced.length
      ? await evaluate(ctx.db, { code: body.code, lines: priced, phone, shopperId: req.shopper?.id ?? null, config: ctx.config })
      : { code: normalizeCode(body.code), applied: false, message: 'Your bag is empty.', discountPaise: 0, freeShipping: false };
    return { body: { code: result.code, applied: result.applied, message: result.message, discountPaise: result.discountPaise, freeShipping: result.freeShipping } };
  });
}
