import { reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { consentApi, createPrivacy } from './api.js';
import { createDataRequests, waitingErasures } from './erasure.js';
import { createConsentStore } from './provider.js';
import { bannerMiddleware, consentRoutes, unsubscribeUrl } from './routes.js';

/**
 * PRD 9.18: shopper data protection under India's DPDP Act 2023. This folder is the consent track's.
 *
 * Tables: consent_notices, consent_records, policy_pages, privacy_settings, data_requests (411).
 * The provider behind platform.consent (provider.js) is registered in setup(ctx), in the app and in the worker: from then
 * on platform.consent answers allows, analyticsAndAds, record, revoke, status and notice from this business's ledger, and
 * the shopper-message gate, the Phase 2 tags and server events, and checkout all ask it.
 *
 * Buyer routes (src/contracts/store-routes.js): GET /policies/:kind, GET and POST /api/store/consent, GET /unsubscribe/:token
 * (and POST, the page's button and RFC 8058 one-click), POST /api/store/data-requests. The cookie banner is added to every
 * buyer page of a business with a tag on, until the browser answers (mounted before the business's pages, in beforeTenant).
 * Console routes: privacy, policies, consentNotice and dataRequests (src/contracts/api/store.js).
 *
 * For other modules: consentLinks(ctx).unsubscribeUrl({ origin, shopperId?, phone?, email?, channel, purpose? }) is the
 * direct link a marketing message carries (call it inside the business; origin is the business's buyer address).
 * Erasure masks orders and invoices (erased_at, buyer_masked_at) and removes the rest, return proofs included (erasure.js).
 */
const services = new WeakMap();

function consentServices(ctx) {
  let found = services.get(ctx.db);
  if (!found) {
    const store = createConsentStore(ctx);
    found = {
      db: ctx.db,
      store,
      privacy: createPrivacy(ctx),
      requests: createDataRequests({ db: ctx.db, config: ctx.config, storage: ctx.platform.storage }),
    };
    services.set(ctx.db, found);
  }
  return found;
}

/** Links other modules put in messages to shoppers. */
export function consentLinks(ctx) {
  const { store } = consentServices(ctx);
  return { unsubscribeUrl: (args) => unsubscribeUrl(ctx.config, store, args) };
}

const TEN_MINUTES = 10 * 60_000;

export const consent = {
  name: 'consent',

  setup(ctx) {
    // Registered once per platform: the app and the worker each have their own.
    if (!ctx.platform.consent.built) ctx.platform.consent.use(consentServices(ctx).store.provider);
  },

  beforeTenant(app, ctx) {
    app.use(bannerMiddleware(ctx));
  },

  routes(app, ctx) {
    app.use('/', consentRoutes(ctx, consentServices(ctx)));
  },

  api: (ctx) => consentApi(() => consentServices(ctx)),

  jobs(ctx) {
    let nextRun = 0;
    return async function schedule() {
      if (Date.now() < nextRun) return;
      nextRun = Date.now() + TEN_MINUTES;
      // Erasures that waited for an order to finish (9.18), each worked inside its own business.
      try {
        const { requests } = consentServices(ctx);
        for (const row of await waitingErasures(ctx.db)) {
          await withTenant(row.tenant_id, () => requests.process(row.id)).catch((err) => reportError(err, { msg: 'consent.erasure_failed', requestId: Number(row.id) }));
        }
      } catch (err) {
        reportError(err, { msg: 'consent.erasures_failed' });
      }
    };
  },
};
