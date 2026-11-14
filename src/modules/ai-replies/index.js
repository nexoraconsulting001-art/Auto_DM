import { ADDON_ROUTE_OWNERS } from '../../contracts/api/addons.js';
import { reportError } from '../../platform/log.js';
import { usageFor } from '../usage/index.js';
import { aiRepliesApi } from './api.js';
import { createAiReplies } from './service.js';

export { checkDraft, neverAnswer, pickSources } from './rules.js';
export { createAiReplies } from './service.js';

/**
 * AI replies (PRD 6.11, A-55 to A-60). Owns faq_entries, ai_settings and ai_reply_log (760).
 *
 * - setup(ctx): ctx.inbound.onUnmatched(handler), in the app and the worker. The handler runs on the queue, inside the
 *   business, with { channel, threadId, messageId } for a DM no keyword rule answered; it reads the text from the inbox.
 * - service.js holds the decision, in its fixed order: the add-on and the switch, one log row per DM, the never-answer
 *   check (ai.handoff), the provider (ctx.providers.ai) with this business's FAQ and catalog facts only, the draft checked
 *   in code (ai.ungrounded), the threshold (ai.low_confidence), then ctx.compliance.enqueue as the one reply to that DM.
 *   A provider failure is ai.provider_failed. Each refusal is a "Needs a human" item.
 * - rules.js is the pure part: what is never answered, which sources go, whether a draft is grounded.
 * - jobs: ai_replies.window_closed (every minute) hands over a queued reply the window closed on (A-60).
 * - AI units are metered once per answer, test questions included (meter ai_units, key ai_reply:<log id>).
 */
const API = ADDON_ROUTE_OWNERS['ai-replies'];
export const AI_REPLIES_JOBS = Object.freeze({ windowClosed: 'ai_replies.window_closed' });
const MINUTE = 60_000;
const services = new WeakMap();

/** The one AI replies service of a context (the app's or the worker's). */
export function aiRepliesFor(ctx) {
  let service = services.get(ctx);
  if (!service) {
    service = createAiReplies({
      db: ctx.db, repos: ctx.repos, compliance: ctx.compliance, providers: ctx.providers ?? {}, config: ctx.config ?? {},
      meter: ctx.db ? usageFor(ctx).meter : null,
    });
    services.set(ctx, service);
  }
  return service;
}

export const aiReplies = {
  name: 'ai-replies',
  owns: { migrations: ['760_ai_replies.sql'], tables: ['faq_entries', 'ai_settings', 'ai_reply_log'], api: API, store: [], platform: [], jobs: Object.values(AI_REPLIES_JOBS) },
  setup(ctx) {
    if (!ctx?.inbound?.onUnmatched || !ctx.db || !ctx.compliance) return;
    ctx.inbound.onUnmatched((event) => aiRepliesFor(ctx).onUnmatched(event));
  },
  api: (ctx) => aiRepliesApi(ctx, aiRepliesFor),
  jobs(ctx) {
    const queue = ctx.platform?.queue;
    if (!queue || !ctx.db) return undefined;
    queue.work(AI_REPLIES_JOBS.windowClosed, () => aiRepliesFor(ctx).sweepWindowClosed());
    return async () => {
      try {
        await queue.every(AI_REPLIES_JOBS.windowClosed, MINUTE);
      } catch (err) {
        reportError(err, { msg: 'ai_replies.schedule_failed' });
      }
    };
  },
};
