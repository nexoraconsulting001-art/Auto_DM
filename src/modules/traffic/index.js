import { ANALYTICS_LIMITS as L } from '../../contracts/analytics.js';
import { analyticsApi, trafficApi } from './api.js';
import { customFunnelsRepo } from './custom-funnels.js';
import { tenantId } from '../../tenancy.js';
import { pageMiddleware, registerBeacon } from './page.js';
import { savedViewsRepo } from './saved-views.js';
import { servicesFor } from './services.js';
import { tagSettingsRepo } from './tags.js';

const QUEUE_TAGS = 'traffic.tags';
const QUEUE_FANOUT = 'traffic.fanout';
const QUEUE_SYNC = 'traffic.sync';
const QUEUE_PURGE = 'traffic.purge';
const SYNC_EVERY_MS = 5 * 60_000;
const TAGS_EVERY_MS = 60_000;
const PURGE_EVERY_MS = 24 * 3_600_000;
const ACTIVE_WITHIN_MS = 2 * 86_400_000;
const OUTBOX_KEEP_DAYS = 30;

/** Route ids this track answers in place of a not-yet-built stub in another module. */
const ADOPTED_STUBS = Object.freeze({
  reports: ['explore.catalog', 'explore.query', 'savedViews.list', 'savedViews.create', 'savedViews.get', 'savedViews.update', 'savedViews.remove', 'savedViews.pin', 'savedViews.unpin', 'dashboard.cards', 'funnels.list', 'funnels.create', 'funnels.get', 'funnels.update', 'funnels.remove', 'funnels.results', 'cohorts.get'],
  insights: ['insights.funnels', 'insights.funnel', 'destinations.connections', 'destinations.setSiteTag', 'destinations.reports', 'destinations.uploadReport'],
});
const adopted = new WeakMap();
const isNotBuiltStub = (handler) => typeof handler === 'function' && /not_implemented/.test(Function.prototype.toString.call(handler));

/**
 * This track builds Explore, funnels and the per-content funnel, but the contract's stubs for those ids live in the reports and insights modules, and two modules
 * can't answer one route. For this one app, the ids that are still stubs there are taken over here, on a copy of the module list, so nothing shared is changed. A
 * handler someone has really written in those modules is left alone and wins. Delete this once the ids have left those stubs.
 */
function adoptContractStubs(ctx) {
  const taken = new Set();
  ctx.modules = ctx.modules.map((module) => {
    const ids = Object.hasOwn(ADOPTED_STUBS, module.name) ? ADOPTED_STUBS[module.name] : null;
    if (!ids || !module.api) return module;
    const answers = module.api(ctx);
    const stubs = new Set(ids.filter((id) => isNotBuiltStub(answers[id])));
    stubs.forEach((id) => taken.add(id));
    return { ...module, api: (c) => Object.fromEntries(Object.entries(module.api(c)).filter(([id]) => !stubs.has(id))) };
  });
  adopted.set(ctx, taken);
}

async function fanOut({ db, platform, config }) {
  const since = new Date(Date.now() - ACTIVE_WITHIN_MS);
  const rows = await db.platform.query(
    `SELECT DISTINCT tenant_id FROM (
       SELECT tenant_id FROM traffic_events WHERE at >= $1::timestamptz
       UNION SELECT tenant_id FROM outbound_jobs WHERE created_at >= $1::timestamptz
       UNION SELECT tenant_id FROM orders WHERE updated_at >= $1::timestamptz
       UNION SELECT tenant_id FROM link_taps WHERE last_tapped_at >= $1::timestamptz
     ) active`,
    [since],
  );
  const bucket = Math.floor((config.trafficNow?.() ?? Date.now()) / SYNC_EVERY_MS);
  for (const { tenant_id: id } of rows) await platform.queue.enqueue(QUEUE_SYNC, {}, { tenantId: id, dedupeKey: `traffic-sync:${id}:${bucket}`, maxAttempts: 3 });
}

const previousDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** One business's turn: its funnel, then its summaries for the days that can still change. */
export async function syncBusiness(ctx) {
  const { sync, rollupService } = servicesFor(ctx);
  await sync.run();
  const until = await rollupService.today();
  const range = { since: previousDay(previousDay(until)), until };
  await rollupService.ensureTrafficDaily(range);
  await rollupService.ensureItems(range);
  await rollupService.ensureFunnelDaily(range);
}

/** Raw events, visitors and the per-person funnel rows after 13 months; rollups as the stores say. Done for every business, so it runs outside any one. */
export async function purge({ db, platform }) {
  await platform.analytics.rollups.purgeExpired(new Date());
  const before = new Date(Date.now() - L.rawEventDays * 86_400_000);
  await db.platform.query('DELETE FROM traffic_events WHERE at < $1::timestamptz', [before]);
  await db.platform.query('DELETE FROM traffic_visitors WHERE last_seen_at < $1::timestamptz', [before]);
  await db.platform.query('DELETE FROM funnel_events WHERE occurred_at < $1::timestamptz', [before]);
  await db.platform.query(`DELETE FROM tag_outbox WHERE created_at < $1::timestamptz AND status IN ('sent', 'failed')`, [new Date(Date.now() - OUTBOX_KEEP_DAYS * 86_400_000)]);
  await db.platform.query('DELETE FROM traffic_previews WHERE day < $1::date', [new Date(Date.now() - L.rollupDays * 86_400_000).toISOString().slice(0, 10)]);
}

/** PRD 7.4, 7.10 to 7.12, 7.14 and 7.15: visits on the seller's own pages, Explore, funnels and cohorts, the funnel per piece of content, and the seller's own pixels. */
export const traffic = {
  name: 'traffic',

  repos: (db, { secrets }) => ({ tagSettings: tagSettingsRepo(db, { secrets }), savedViews: savedViewsRepo(db), customFunnels: customFunnelsRepo(db) }),

  beforeTenant(app, ctx) {
    adoptContractStubs(ctx);
    registerBeacon(app, ctx, servicesFor(ctx));
  },

  /**
   * A new order is tied to the visit that placed it from the order's own event (PRD 7.4), whichever checkout made it: the
   * order carries its visitor (orders.visitor_id). Linking twice is harmless: the visit's order event has a unique key.
   */
  setup(ctx) {
    ctx.orderEvents?.on('order.created', 'traffic.order-link', async (event) => {
      const [order] = await ctx.db.query('SELECT id, visitor_id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
      if (order?.visitor_id) await servicesFor(ctx).ingest.linkOrder(order, order.visitor_id);
    });
  },

  routes(app, ctx) {
    const { ingest, tags } = servicesFor(ctx);
    app.use(pageMiddleware(ctx, ingest, tags));
  },

  /** With no app built on this ctx (a test listing routes, say) only the contract's own ids for this module are answered. */
  api(ctx) {
    const own = trafficApi(ctx);
    const taken = adopted.get(ctx);
    if (!taken) return own;
    return { ...own, ...Object.fromEntries(Object.entries(analyticsApi(ctx)).filter(([id]) => taken.has(id))) };
  },

  /** The compliance worker's stream: comments and read receipts become funnel rows, and this never claims an event as handled. */
  async onInboundEvent(event, ctx) {
    if (event.type !== 'comment' && event.type !== 'seen') return false;
    return servicesFor(ctx).sync.onInbound(event);
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(QUEUE_TAGS, () => servicesFor(ctx).tags.drain());
    queue.work(QUEUE_FANOUT, () => fanOut(ctx));
    queue.work(QUEUE_SYNC, () => syncBusiness(ctx));
    queue.work(QUEUE_PURGE, () => purge(ctx));
    return async function schedule() {
      await queue.every(QUEUE_TAGS, TAGS_EVERY_MS);
      await queue.every(QUEUE_FANOUT, SYNC_EVERY_MS);
      await queue.every(QUEUE_PURGE, PURGE_EVERY_MS);
    };
  },
};
