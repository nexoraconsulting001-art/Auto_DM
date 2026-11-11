import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { createCustomers, customerApi, FILE_PATH, sweepDownloadFiles } from './customers.js';
import { createGoogleSignIn } from './google.js';
import { legacyAccountPage, legacyAccountRoutes } from './legacy.js';
import { sharedPlatformRoutes, shopperRoutes } from './routes.js';
import { createShopperService } from './service.js';
import { shopperSession } from './session.js';
import { createSharedProfiles } from './shared.js';

/**
 * PRD 9.3 (shopper sign-in), 9.4 (addresses), 9.17 (the account and the customer list) and 9.22 (shared sign-in across
 * stores). This folder is the shoppers track's.
 *
 * Tables: shoppers, shopper_sessions, shopper_otps, shopper_addresses (400), and the platform's own shared_* tables (415),
 * which business code cannot read: shared.js reaches them through db.platform and hands a business only what its own
 * shopper needs.
 *
 * What other modules use:
 *   req.shopper, req.shopperCsrf (also on res.locals)   set on every request inside a business by session.js; null when
 *                                                       nobody is signed in. Never req.user: a shopper is not a seller.
 *   shopperServices(ctx)                                { service, shared, google, customers } for this app or worker:
 *     service.addresses.list(shopperId)                 saved addresses, default first (S-13)
 *     service.otps.codVerified({ phone, checkoutKey })  true for 30 minutes after the cash-on-delivery code (9.5)
 *     shared.addresses(tenantId, shopperId)             saved addresses from the shared profile, for this shopper's own checkout
 *     shared.codRisk(tenantId, shopperId)               'none' | 'elevated' | 'high': a label only (S-103)
 *     shared.consent({ tenantId, shopper, googleSub, addresses, noticeVersion })   the unticked-by-default box at checkout
 *   /auth/shared?next=/checkout                         sends a browser with details saved at another store through the
 *                                                       platform host and back, signed in with no code (S-98)
 *
 * A code is sent through ctx.shopperMessages as purpose 'authentication' (never the adapter), stored as a keyed hash and
 * limited with platform.rateLimit (STORE_LIMITS.otp). The shopper's cookie is SHOPPER_COOKIE, apart from the seller's.
 * POST /login still signs sellers in (legacy.js).
 */
const services = new WeakMap();

/** This app's (or worker's) shopper services, made once per database handle. */
export function shopperServices(ctx) {
  let found = services.get(ctx.db);
  if (!found) {
    const service = createShopperService(ctx);
    const shared = createSharedProfiles(ctx);
    found = { service, shared, google: createGoogleSignIn(ctx.config), customers: createCustomers(ctx) };
    services.set(ctx.db, found);
  }
  return found;
}

const HOUR = 3_600_000;

async function purgeExpired(db) {
  const pdb = db.platform ?? db;
  await pdb.query(`DELETE FROM shopper_otps WHERE expires_at < now() - interval '1 day'`);
  await pdb.query(`DELETE FROM shopper_sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`);
}

export const shoppers = {
  name: 'shoppers',

  setup(ctx) {
    // The cash-on-delivery risk label (9.22, S-103) counts parcels delivered and parcels sent back, with no business on the row.
    ctx.orderEvents?.on(['order.delivered', 'order.rto_initiated'], 'shoppers.cod-signal', async (event) => {
      const { shared } = shopperServices(ctx);
      if (!shared.available) return;
      const [order] = await ctx.db.query('SELECT shopper_id, payment_mode FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
      if (!order?.shopper_id || order.payment_mode !== 'cod') return;
      // At least once: the event id is the guard against counting one parcel twice.
      const first = await ctx.platform.rateLimit.hit('shared_cod_event', String(event.id), { limit: 1, windowMs: 400 * 24 * HOUR });
      if (!first.allowed) return;
      await shared.recordCodOutcome(tenantId(), order.shopper_id, { refused: event.type === 'order.rto_initiated' });
      log.info('shoppers.cod_signal', { orderId: event.orderId, refused: event.type === 'order.rto_initiated' });
    });
  },

  routes(app, ctx) {
    const s = shopperServices(ctx);
    app.use(shopperSession(ctx, s.service));
    app.use('/', legacyAccountRoutes(ctx));
    app.use('/', shopperRoutes(ctx, s));
    app.get('/account', legacyAccountPage(ctx));

    // A customer-list download (owner only, 9.17). Not JSON, so it lives outside /api/v1.
    app.get(FILE_PATH, async (req, res, next) => {
      try {
        res.set('Cache-Control', 'private, no-store');
        if (!req.user) return res.status(401).type('text').send('Sign in to your admin, then open this link again.');
        if (req.user.role !== 'owner') return res.status(403).type('text').send('Only the owner can download the customer list.');
        const id = /^[1-9][0-9]{0,15}$/.test(req.params.id) ? Number(req.params.id) : 0;
        const found = await s.customers.downloads.file(id);
        if (found.status !== 200) return res.status(found.status).type('text').send(found.status === 410 ? 'This file has expired. Make a new one from Customers.' : 'We couldn’t find that file.');
        res.set({ 'Content-Type': found.type, 'Content-Disposition': `attachment; filename="${found.name}"` });
        return res.send(found.buffer);
      } catch (err) {
        return next(err);
      }
    });
  },

  platformRoutes(router, ctx) {
    sharedPlatformRoutes(router, ctx, shopperServices(ctx).shared);
  },

  api: (ctx) => customerApi(() => shopperServices(ctx).customers),

  jobs({ db, platform }) {
    let nextRun = 0;
    return async function schedule() {
      if (Date.now() < nextRun) return;
      nextRun = Date.now() + HOUR;
      await purgeExpired(db).catch((err) => reportError(err, { msg: 'shoppers.purge_failed' }));
      await sweepDownloadFiles({ db, storage: platform.storage }).catch((err) => reportError(err, { msg: 'shoppers.sweep_failed' }));
    };
  },
};
