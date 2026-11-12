import { ADDON_ROUTE_OWNERS } from '../../contracts/api/addons.js';
import { notBuilt } from '../not-built.js';

/**
 * AI replies (PRD 6.11, A-55 to A-60). Track ai-replies. Contract only so far: every route answers 501.
 *
 * Owns faq_entries, ai_settings and ai_reply_log (760). The rules it works to are in src/contracts/addons.js. What the
 * track builds here:
 *
 * - setup(ctx): ctx.inbound.onUnmatched(handler). The handler runs on the queue, inside the business, with
 *   { channel, threadId, messageId } for a DM no keyword rule answered (A-58: rules always run first). It reads the
 *   message from the inbox by id; the text is never in a job or a log line.
 * - In order: the entitlement (repos.entitlements.can('ai_replies')), ai_settings.enabled, one ai_reply_log row per
 *   inbound DM (the unique index makes a second run a no-op), then handoff words, refunds, order problems and negative
 *   intent (ai.handoff, A-59), then ctx.providers.ai.answer() with the active FAQ entries and catalog fields only.
 * - A provider failure or driver 'none' is ai.provider_failed; a score under the threshold is ai.low_confidence (A-56);
 *   a source that was not supplied (unknownSources), an invented price, discount, stock level, delivery date or policy,
 *   a link that is not the product's own, or an echo of the shopper's instructions is ai.ungrounded (A-57). Each ends
 *   as a needs_human_items row (kind 'handoff') and the thread in "Needs a human".
 * - An answer goes out only through ctx.compliance.enqueue: purpose 'ai_reply', the key dmReplyKey(mid) from
 *   automations/message.js and { inReplyTo: mid }, so it is the one automated reply to that DM and a rule's answer and
 *   this one can never both go. The gate adds the seller's note to every AI reply. A reply the window closes on is the
 *   gate's window.closed, and the module then raises the "Needs a human" item (A-60).
 * - usage.units of every call, test questions included, is metered for the business (meter 'ai_units').
 * - aiReplies.testQuestion runs the same decision with nothing enqueued and logs outcome 'test'.
 */
const API = ADDON_ROUTE_OWNERS['ai-replies'];

export const aiReplies = {
  name: 'ai-replies',
  owns: { migrations: ['760_ai_replies.sql'], tables: ['faq_entries', 'ai_settings', 'ai_reply_log'], api: API, store: [], platform: [], jobs: [] },
  api: () => notBuilt(...API),
};
