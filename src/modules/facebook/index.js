import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { facebookApi } from './api.js';
import { createFacebookConnect } from './connect.js';
import { answerLinkedComment } from './inbound.js';
import { fbLinksRepo, fbPagesRepo } from './repo.js';

const MAINTAIN = 'facebook.maintain';
const HOUR = 3_600_000;

const flows = new WeakMap();

/** One connection flow per app or worker, made the first time something needs it. */
function connectFor(ctx) {
  if (!flows.has(ctx)) flows.set(ctx, createFacebookConnect(ctx));
  return flows.get(ctx);
}

/** Webhook subscriptions that failed when the Page was connected, tried again. */
async function maintain(ctx) {
  const pages = await ctx.db.platform.query(`SELECT tenant_id, page_id FROM fb_pages WHERE access_token_enc <> '' AND status = 'active' AND subscribed_at IS NULL LIMIT 5000`);
  for (const page of pages) {
    await withTenant(page.tenant_id, () => connectFor(ctx).subscribe(page.page_id)).catch((err) => reportError(err, { msg: 'facebook.maintain_failed', pageId: page.page_id }));
  }
}

/**
 * PRD 6.10, behind config.facebookPages, which stays off until Facebook's own Meta review round: connecting a Page (ctx.meta.facebookLogin), and linking
 * posts to their Instagram twins. Provides repos.fbPages, which compliance.send() reads, and repos.fbLinks. Page webhooks arrive through the compliance
 * module's intake. Every Facebook message goes through compliance, as a job on the facebook channel, so a Facebook problem pauses only Facebook.
 */
export const facebook = {
  name: 'facebook',
  repos: (db, { secrets }) => ({ fbPages: fbPagesRepo(db, { secrets }), fbLinks: fbLinksRepo(db) }),

  beforeTenant(app, ctx) {
    if (ctx.config.facebookPages) app.get(PROVIDER_PATHS.facebookCallback, connectFor(ctx).callback);
  },

  api: (ctx) => facebookApi(ctx, () => connectFor(ctx)),

  /** The compliance worker calls this for every event that got past its rules. */
  onInboundEvent: answerLinkedComment,

  jobs(deps) {
    if (!deps.config.facebookPages) return undefined;
    const { queue } = deps.platform;
    queue.work(MAINTAIN, () => maintain(deps));
    return async () => {
      await queue.every(MAINTAIN, HOUR);
    };
  },
};
