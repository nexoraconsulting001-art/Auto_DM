import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { applyImport } from '../catalog/imported.js';

/**
 * The scheduled re-check (PRD 8.8): imported products whose last read is older than the business's interval (24 hours unless
 * it chose another) are read again, 50 a run. A page that is gone (404, 410) marks the product broken, which hides it from
 * buyer pages and tells the owner; a timeout or a 5xx is tried again next run. A changed price is updated and flagged, unless
 * the owner typed the price; stock follows the site.
 *
 * The run is for every business at once, so it picks its products through db.platform, a few from each business in turn, and
 * claims them so two workers never take the same one. Each product is then read and written as its own business.
 */

export const RECHECK_SWEEP = 'imports.recheck';

const HOUR = 3_600_000;
const CLAIM_MINUTES = 30;
const SOON_FAILURES = 3;
/** Sources that say whether a product is in stock. A page with only a title, or only Open Graph and no price, doesn't. */
const saysStock = (read) => ['adapter', 'shopify', 'json_ld'].includes(read.readFrom) || (read.readFrom === 'open_graph' && read.draft?.pricePaise !== null);

export function createRecheck({ db, repos, platform, config = {} }, reader) {
  const catalog = repos.catalog;
  const perRun = config.recheckPerRun ?? 50;
  const budgetMs = config.recheckBudgetMs ?? 180_000;

  /** What a run needs to know about one business, looked up once. */
  async function businessState() {
    return { hours: await catalog.recheckHours(), allowed: await repos.entitlements.can('catalog.import'), enabled: await repos.imports.enabledAdapters() };
  }

  /**
   * Re-checks one product of the current business. Answers what happened: ok, price_changed, sold_out, back_in_stock, broken,
   * retry, busy (its site is being read by someone else: still due) or skipped.
   */
  async function one(productId, state = null) {
    const product = await catalog.get(productId);
    if (!product) return 'skipped';
    if (product.source === 'manual' || !product.external_url || product.fetch_status === 'missing') {
      await catalog.markFetched(product.id, { nextCheckAt: null, failures: product.check_failures, read: false });
      return 'skipped';
    }
    const { hours, allowed, enabled } = state ?? (await businessState());
    const next = new Date(Date.now() + hours * HOUR);
    const keep = { failures: product.check_failures, read: false };
    if (!allowed) {
      await catalog.markFetched(product.id, { ...keep, nextCheckAt: next });
      return 'skipped';
    }

    const read = await reader.reread(product, { enabledAdapters: enabled });
    if (read.skipped) {
      await catalog.markFetched(product.id, { ...keep, nextCheckAt: next });
      await catalog.recordCheck({ productId: product.id, outcome: 'skipped' });
      return 'skipped';
    }
    if (!read.ok) {
      if (read.reason === 'host_busy') {
        await catalog.markFetched(product.id, { ...keep, nextCheckAt: new Date() });
        return 'busy';
      }
      const failures = product.check_failures + 1;
      if (read.gone) {
        await catalog.markFetched(product.id, { status: 'broken', nextCheckAt: next, failures, error: read.reason, read: false });
        await catalog.recordCheck({ productId: product.id, outcome: 'broken', httpStatus: read.status });
        if (product.fetch_status !== 'broken') {
          await repos.alerts.raise({
            kind: 'catalog.product_broken',
            severity: 'warning',
            message: `The page for “${product.name}” is no longer there, so it is hidden from your pages. Fix its link or archive it.`,
            target: `product:${product.id}`,
            dedupeKey: `catalog.broken:${product.id}:${new Date().toISOString().slice(0, 10)}`,
          });
        }
        return 'broken';
      }
      // A timeout or a 5xx is tried again next run, a few times; anything else waits for the usual interval.
      const soon = read.retryable && failures < SOON_FAILURES;
      await catalog.markFetched(product.id, { status: product.fetch_status === 'broken' ? 'broken' : 'retrying', nextCheckAt: soon ? new Date() : next, failures, error: read.reason, read: false });
      await catalog.recordCheck({ productId: product.id, outcome: 'retry', httpStatus: read.status });
      return 'retry';
    }

    const draft = read.draft
      ? {
          pricePaise: read.draft.pricePaise ?? undefined,
          mrpPaise: read.mrpKnown ? read.draft.mrpPaise : undefined,
          inStock: saysStock(read) ? read.draft.inStock : undefined,
          options: read.draft.options,
          variants: read.draft.variants,
        }
      : {};
    const result = await applyImport(catalog, product.id, draft, { text: false, flagPrice: true, mrpKnown: read.mrpKnown === true, recheckHours: hours });
    if (!result) return 'skipped';
    const outcome = result.priceChanged ? 'price_changed' : result.stock ?? 'ok';
    await catalog.recordCheck({ productId: product.id, outcome, httpStatus: 200, pricePaise: result.pricePaise });
    return outcome;
  }

  /** Takes up to `limit` due products, a fair share from each business, and holds them so no other worker takes them. */
  async function claim(limit) {
    const rows = await db.platform.query(
      `WITH due AS (
         SELECT p.id, row_number() OVER (PARTITION BY p.tenant_id ORDER BY p.next_check_at, p.id) AS turn
         FROM products p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.next_check_at <= now() AND t.status NOT IN ('closed', 'killed', 'suspended')
       ), picked AS (
         SELECT id FROM due ORDER BY turn, id LIMIT $1
       )
       UPDATE products p SET next_check_at = now() + make_interval(mins => $2)
       WHERE p.id IN (SELECT q.id FROM products q WHERE q.id IN (SELECT id FROM picked) AND q.next_check_at <= now() FOR UPDATE SKIP LOCKED)
       RETURNING p.id, p.tenant_id`,
      [limit, CLAIM_MINUTES],
    );
    // One from each business in turn, so a business with hundreds due never makes the others wait (K-26).
    const byBusiness = new Map();
    for (const row of rows.sort((a, b) => a.id - b.id)) byBusiness.set(row.tenant_id, [...(byBusiness.get(row.tenant_id) ?? []), row]);
    const order = [];
    for (let turn = 0; order.length < rows.length; turn++) for (const list of byBusiness.values()) if (list[turn]) order.push(list[turn]);
    return order;
  }

  return {
    one,

    /** One run across every business. Answers how many products it looked at, by outcome. */
    async sweep() {
      const claimed = await claim(perRun);
      const deadline = Date.now() + budgetMs;
      const states = new Map();
      const counts = {};
      for (const [index, row] of claimed.entries()) {
        if (Date.now() > deadline) {
          // Out of time: the rest go back to being due, for the next run.
          await db.platform.query('UPDATE products SET next_check_at = now() WHERE id = ANY($1::int[])', [claimed.slice(index).map((r) => r.id)]);
          break;
        }
        try {
          const outcome = await withTenant(row.tenant_id, async () => {
            if (!states.has(row.tenant_id)) states.set(row.tenant_id, await businessState());
            return one(row.id, states.get(row.tenant_id));
          });
          counts[outcome] = (counts[outcome] ?? 0) + 1;
        } catch (err) {
          reportError(err, { msg: 'catalog.recheck_failed', tenantId: row.tenant_id, productId: row.id });
          counts.error = (counts.error ?? 0) + 1;
        }
      }
      return { checked: claimed.length, ...counts };
    },

    /** Old check rows go after 90 days. */
    async prune() {
      await db.platform.query(`DELETE FROM product_checks WHERE checked_at < now() - interval '90 days'`);
    },
  };
}
