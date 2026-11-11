import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { categoriesApi, categoryTakeovers } from './api.js';
import { registerCategoryPages } from './pages.js';
import { categorySequencesRepo } from './repo.js';

/**
 * PRD 8.13: each category's ordered reels, pins, schedules and auto-join rules (migration 303), and the buyer pages that show
 * the order (/c/:slug and the Reels tab, BUYER_ROUTES in src/contracts/buyer-pages.js). One stored order per category; every
 * surface reads it through this module's repo, `repos.categorySequences`, so none keeps a copy:
 *
 *   live(categoryId, { now, limit, offset })   one category's live reels in order (pinned, then position)
 *   liveShelves({ now, perCategory })           every visible category's live reels, in category order
 *   liveUncategorized({ limit, offset })        live reels in no visible category, newest first ("More reels")
 *   moreReelsFor(pageId, { now, limit })        a landing page's "More reels" strip (K-42)
 *   setPageCategories(pageId, ids), categoriesOfPage(pageId)   for the landing page editor
 *   joinByRules({ pageIds })                    auto-join rules for pages just made or changed (the job also runs it)
 *
 * categories.list, .create, .get and .update belong to admin-api (Phase 0) and are replaced here through takesOver(ctx), to add
 * each category's reel count.
 */
export const QUEUE_RULES = 'categories.rules';
const RULES_EVERY_MS = 60_000;

/** Every business with an active rule and the plan for it: new pages made since each rule changed join its category. */
export async function runRules(ctx) {
  const { db, repos } = ctx;
  const businesses = await db.platform.query('SELECT DISTINCT tenant_id FROM category_rules WHERE active ORDER BY tenant_id');
  let added = 0;
  for (const { tenant_id: id } of businesses) {
    try {
      added += await withTenant(id, async () => ((await repos.entitlements.can('category_sequences')) ? repos.categorySequences.joinByRules() : 0));
    } catch (err) {
      reportError(err, { msg: 'categories.rules_failed', tenantId: id });
    }
  }
  if (added) log.info('categories.rules_joined', { added, businesses: businesses.length });
  return added;
}

export const categories = {
  name: 'categories',
  repos: (db) => ({ categorySequences: categorySequencesRepo(db) }),
  takesOver: (ctx) => categoryTakeovers(ctx),
  api: (ctx) => categoriesApi(ctx),
  routes: (app, ctx) => registerCategoryPages(app, ctx),
  jobs(ctx) {
    ctx.platform.queue.work(QUEUE_RULES, () => runRules(ctx));
    return async () => {
      await ctx.platform.queue.every(QUEUE_RULES, RULES_EVERY_MS);
    };
  },
};
