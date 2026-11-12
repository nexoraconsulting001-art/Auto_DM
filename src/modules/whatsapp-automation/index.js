import { ADDON_ROUTE_OWNERS } from '../../contracts/api/addons.js';
import { notBuilt } from '../not-built.js';
import { WHATSAPP_CHANNEL, whatsappChannel } from './channel.js';

/**
 * The WhatsApp add-on (PRD 6.12, A-61 to A-66). Track whatsapp-automation. Contract only so far: every route answers
 * 501. What is built is the channel: setup(ctx) registers WhatsApp with the compliance gate (channel.js), in the app and
 * in the worker, so a 'whatsapp' action passes the same queue, budget per number, window, opt-outs, caps, content and
 * link checks, pauses and log as an Instagram one.
 *
 * Owns whatsapp_keywords and whatsapp_optins (770), and shares whatsapp_accounts and whatsapp_templates (409) with
 * order-alerts, which keeps whatsappAccount.* (a token typed in) and the templates. What the track builds here:
 *
 * - whatsapp.connectStart and connectFinish: Meta's embedded signup. Finish checks the one-time state, exchanges the code
 *   (providers.whatsapp.exchangeCode), reads the number's display name, subscribes the app, and stores the token
 *   encrypted in whatsapp_accounts. A phone number id another business holds is refused (the unique index).
 * - Inbound: order-alerts' webhook route already verifies the signature and finds the business by phone number id. This
 *   module takes each message from providers.whatsapp.parseMessages: an unknown number is dropped (tenant.unknown_entry),
 *   a repeated message id is a no-op (inbox_messages.mid), an older message never moves last_user_message_at back.
 *   It writes inbox_threads (channel 'whatsapp', wa_phone_number_id, subject_hash from repos.compliance.subjectHash)
 *   and inbox_messages, so the thread shows in the owner inbox with its badge (A-65).
 * - Opt-out and START words (src/modules/compliance/words.js) write opt_outs on the whatsapp channel and withdraw the
 *   marketing rows of whatsapp_optins; order updates stay with the shopper-message gate (A-64).
 * - Keyword replies: matchesKeywords over whatsapp_keywords by position; the answer is that set's reel or link as a
 *   direct link with utm_source=whatsapp (directLink), enqueued with ctx.compliance.enqueue as a 'dm' with
 *   { inReplyTo: messageId } (A-61). The gate refuses it outside the window (A-63) and a template without an opt-in (A-62).
 * - Every message Meta accepts is metered (ctx.compliance.onAccepted carries the channel; meter 'whatsapp_messages').
 */
const API = ADDON_ROUTE_OWNERS['whatsapp-automation'];

export const whatsappAutomation = {
  name: 'whatsapp-automation',
  owns: { migrations: ['770_whatsapp_automation.sql'], tables: ['whatsapp_keywords', 'whatsapp_optins'], api: API, store: [], platform: [], jobs: [] },
  setup(ctx) {
    ctx.compliance?.registerChannel?.(WHATSAPP_CHANNEL, whatsappChannel(ctx));
  },
  api: () => notBuilt(...API),
};
