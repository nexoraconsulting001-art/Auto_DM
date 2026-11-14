import { ADDON_ROUTE_OWNERS } from '../../contracts/api/addons.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { whatsappApi } from './api.js';
import { WHATSAPP_CHANNEL, whatsappChannel } from './channel.js';
import { createIntake } from './intake.js';
import { createProcessor } from './process.js';

/**
 * The WhatsApp add-on (PRD 6.12, A-61 to A-66), on the business's own number and display name.
 *
 * - channel.js: WhatsApp as a channel of the compliance gate, registered in setup(ctx) in the app and the worker. Every
 *   send passes the same queue, budget per number, window (window.closed), opt-in for templates (wa.no_optin), opt-outs,
 *   caps, content and link checks, pauses, kill switch and log as an Instagram one. It is the only caller of sendText.
 * - intake.js: shoppers' messages from POST /webhooks/whatsapp, ahead of order-alerts' handler on the same path:
 *   verified on the raw bytes, routed by phone number id only, stored with the inbox thread before the answer, once per
 *   message id. Threads show in the owner inbox with channel 'whatsapp' (A-65).
 * - process.js: what each message does, once: opt-out words (opt_outs on the whatsapp channel, the marketing opt-in
 *   withdrawn), START, a request for a person, and keyword replies with the 6.2 matcher, answered with the set's reel
 *   page or link as a direct link with utm_source=whatsapp, through ctx.compliance.enqueue (A-61, A-63, A-64).
 *   The worker's schedule() sweeps up what the intake did not finish.
 * - api.js: status, embedded signup (connectStart, connectFinish with a one-time state), disconnect, keyword sets and
 *   the opt-in list (A-66). There is no broadcast route.
 *
 * Message counts for pass-through billing are the usage module's: it meters every accepted send on this channel as
 * 'whatsapp_messages' (compliance.onAccepted).
 *
 * Owns whatsapp_keywords and whatsapp_optins (770). Migration 771 lets oauth_states hold a WhatsApp signup state and gives
 * inbound_events the 'pending' status this module's messages wait in. Shares whatsapp_accounts and whatsapp_templates (409)
 * with order-alerts.
 */
const API = ADDON_ROUTE_OWNERS['whatsapp-automation'];

const built = new WeakMap();
/** One processor and intake per process context. */
function servicesFor(ctx) {
  let found = built.get(ctx);
  if (!found) {
    const processor = createProcessor(ctx);
    found = { processor, intake: createIntake(ctx, processor) };
    built.set(ctx, found);
  }
  return found;
}

export const whatsappAutomation = {
  name: 'whatsapp-automation',
  owns: { migrations: ['770_whatsapp_automation.sql', '771_whatsapp_inbound.sql'], tables: ['whatsapp_keywords', 'whatsapp_optins'], api: API, store: [], platform: [], jobs: [] },

  setup(ctx) {
    ctx.compliance?.registerChannel?.(WHATSAPP_CHANNEL, whatsappChannel(ctx));
  },

  beforeTenant(app, ctx) {
    const { intake } = servicesFor(ctx);
    app.post(STORE_PROVIDER_PATHS.whatsapp.path, (req, res, next) => Promise.resolve(intake.receive(req, res, next)).catch((err) => {
      reportError(err, { msg: 'whatsapp.inbound_error' });
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on our side.' });
    }));
  },

  api: (ctx) => whatsappApi(ctx),

  jobs(ctx) {
    const { processor } = servicesFor(ctx);
    return async function schedule() {
      await processor.sweep();
    };
  },
};
