import express from 'express';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { reportError } from '../../platform/log.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { section } from '../../views/buyer/index.js';
import { cookieOf, hookPages } from '../reviews/page-hook.js';
import { shopperFrom, storeOn } from '../storefront/http.js';
import { baseOf, sendStoreNotFound, sendStorePage } from '../storefront/shell.js';
import { addToAccount } from '../wishlist/index.js';
import { invitePage, pointsPage } from './pages.js';
import { createReferrals } from './referrals.js';
import { normalizeCode } from './rules.js';
import { createLoyalty } from './service.js';

/**
 * PRD 9.21: loyalty points and referrals, an add-on (the `loyalty` feature: tier 4 and 5, and tier 3 by a tenant_features
 * row). This folder is the loyalty track's.
 *
 * Tables (migration 413): loyalty_settings, loyalty_accounts, loyalty_ledger, referral_codes, referrals.
 * service.js is the ledger and every order event's effect on it; referrals.js the links and the self-referral rules;
 * rules.js the arithmetic.
 *
 * Buyer routes (src/contracts/store-routes.js):
 *   GET /account/points    balance, pending, history and the shopper's invite link (the store's 404 without the add-on)
 *   GET /refer/:code       a friend arriving: remembers the code in this browser for their first order
 * Console routes: loyaltySettings.get/update (managers), loyalty.members/ledger/referrals (staff with customers),
 * loyalty.adjust (owner only). Every one answers 403 without the add-on (S-91).
 * Order events, on one listener so they arrive in order per order: order.paid, order.delivered, order.return_window_closed,
 * refund.processed, order.cancelled, order.rto_delivered, order.reinstated (service.js says what each does).
 * Job: loyalty.sweep posts points whose return window has closed and lapses expired ones.
 *
 * For checkout: ctx.loyalty.preview({ shopperId, points, orderPaise }, q) for the quote, and ctx.loyalty.redeem(t, { shopperId,
 * orderId, points, valuePaise }) inside the order's transaction. ctx.loyalty.referrals.attach(orderId, { code, visitorId,
 * ownDevice }) records a referral against a placed order.
 *
 * Checkout takes `referralCode` in its body but does nothing with it yet, so this module records the referral itself: it
 * watches POST /api/store/checkout (before checkout's own route), reads the code from the body or from the cookie the
 * invite link set, and records the referral once the order has been placed. The friend's first-order reward
 * (friend_reward_paise) needs checkout to price it and is not given: referrals record 0.
 */
export const LOYALTY_JOB = 'loyalty.sweep';
/** The friend's browser remembers the code it was invited with; the referrer's browser is marked as theirs. */
export const REF_COOKIE = '_ref';
export const REF_DEVICE_COOKIE = '_refdev';
const REF_COOKIE_DAYS = 30;
const DEVICE_COOKIE_DAYS = 365;
const ORDER_EVENTS = ['order.paid', 'order.delivered', 'order.return_window_closed', 'refund.processed', 'order.cancelled', 'order.rto_delivered', 'order.reinstated'];

const built = new WeakMap();
/** The loyalty service of one app's or worker's context. */
export function loyaltyFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    service = createLoyalty(ctx);
    service.referrals = createReferrals(ctx, service);
    built.set(ctx, service);
  }
  return service;
}

const cookie = (req, res, name, value, days) => res.cookie(name, value, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: days * 86_400_000 });

/** Records the referral of an order checkout has just placed: see the note above. Never changes what checkout answers. */
function referralWatch(ctx, service) {
  return (req, res, next) => {
    try {
      const code = normalizeCode(req.body?.referralCode) || normalizeCode(cookieOf(req, REF_COOKIE));
      const tenant = currentTenant();
      if (!code || !tenant) return next();
      const visitorId = visitorIdFrom(req);
      const ownDevice = normalizeCode(cookieOf(req, REF_DEVICE_COOKIE)) === code;
      let answer = null;
      const json = res.json;
      res.json = function watched(body) {
        answer = body;
        return json.call(this, body);
      };
      res.on('finish', () => {
        if (res.statusCode !== 201 || typeof answer?.orderNumber !== 'string' || !answer.orderNumber) return;
        withTenant(tenant, async () => {
          const [order] = await ctx.db.query('SELECT id FROM orders WHERE tenant_id = $1 AND order_number = $2', [tenantId(), answer.orderNumber]);
          if (order) await service.referrals.attach(order.id, { code, visitorId, ownDevice });
        }).catch((err) => reportError(err, { msg: 'loyalty.referral_failed' }));
      });
    } catch (err) {
      reportError(err, { msg: 'loyalty.referral_watch_failed' });
    }
    return next();
  };
}

export const loyalty = {
  name: 'loyalty',

  setup(ctx) {
    const service = loyaltyFor(ctx);
    ctx.loyalty = service;
    ctx.orderEvents?.on(ORDER_EVENTS, 'loyalty.order-events', async (event) => {
      switch (event.type) {
        case 'order.paid': return service.earn(event.orderId);
        case 'order.delivered': return service.delivered(event.orderId);
        case 'order.return_window_closed': return service.windowClosed(event.orderId);
        case 'refund.processed': return service.refunded(event.orderId, event.entityId);
        case 'order.cancelled':
        case 'order.rto_delivered': return service.cancelled(event.orderId);
        case 'order.reinstated': return service.reinstated(event.orderId);
        default: return undefined;
      }
    });
  },

  routes(app, ctx) {
    const service = loyaltyFor(ctx);
    const r = express.Router();
    const live = async () => ((await storeOn(ctx.repos)) ? service.active() : null);

    r.post(STORE_ROUTES.checkoutPlace.path, referralWatch(ctx, service));

    r.get(STORE_ROUTES.points.path, async (req, res, next) => {
      try {
        const settings = await live();
        if (!settings) return await sendStoreNotFound(ctx, req, res, 'This page doesn’t exist.');
        const shopper = await shopperFrom(req, ctx.db);
        if (!shopper) return res.redirect(303, `/login?next=${encodeURIComponent(STORE_ROUTES.points.path)}`);
        const [account, history] = await Promise.all([service.account(shopper.id), service.history(shopper.id)]);
        let referralUrl = '';
        if (settings.referralEnabled) {
          const code = await service.referrals.codeFor(shopper.id);
          referralUrl = `${baseOf(req)}/refer/${code}`;
          // This browser is the referrer's: an order placed on it through their own link earns nothing (S-90).
          cookie(req, res, REF_DEVICE_COOKIE, code, DEVICE_COOKIE_DAYS);
        }
        res.set('Cache-Control', 'no-store');
        return await sendStorePage(ctx, req, res, {
          kind: 'other', ref: 'points', title: 'Your points',
          main: ({ theme }) => section({ theme, id: 'points-h', kicker: 'Rewards', title: 'Your points', body: pointsPage({ account, settings, history, referralUrl }) }),
        });
      } catch (err) {
        return next(err);
      }
    });

    r.get(STORE_ROUTES.referralLanding.path, async (req, res, next) => {
      try {
        const code = normalizeCode(req.params.code);
        const settings = code ? await live() : null;
        const owner = settings?.referralEnabled ? await service.referrals.ownerOf(code) : null;
        if (!owner) return res.redirect(303, '/');
        const shopper = await shopperFrom(req, ctx.db);
        const own = shopper?.id === owner.shopperId;
        if (own) cookie(req, res, REF_DEVICE_COOKIE, code, DEVICE_COOKIE_DAYS);
        else cookie(req, res, REF_COOKIE, code, REF_COOKIE_DAYS);
        res.set('Cache-Control', 'no-store');
        return await sendStorePage(ctx, req, res, {
          kind: 'other', ref: 'refer', title: own ? 'Your invite link' : 'Welcome',
          main: ({ theme }) => section({ theme, id: 'refer-h', kicker: 'Welcome', title: own ? 'Your invite link' : 'You’re invited', body: invitePage({ own }) }),
        });
      } catch (err) {
        return next(err);
      }
    });
    app.use(r);
  },

  /** The account page is the shoppers module's, mounted first: the hook goes in before any route, and runs as the page is sent. */
  beforeTenant(app, ctx) {
    const service = loyaltyFor(ctx);
    // The account says how many points there are, and where to see them, while the program is on.
    hookPages(app, {
      name: 'loyalty',
      paths: '/account',
      async transform(page, { req }) {
        if (!page.includes('<section class="acct">') || !req.shopper?.id) return page;
        const settings = (await storeOn(ctx.repos)) ? await service.active() : null;
        if (!settings) return page;
        const { balance, pending } = await service.account(req.shopper.id);
        const more = pending ? ` and ${pending.toLocaleString('en-IN')} on the way` : '';
        const refer = settings.referralEnabled ? ' Invite friends from there too.' : '';
        return addToAccount(page, `<div class="panel"><h2>Your points</h2><p class="muted">${balance.toLocaleString('en-IN')} to use${more}.${refer}</p><a class="btn-quiet" href="${STORE_ROUTES.points.path}">See your points</a></div>`);
      },
    });
  },

  api: (ctx) => {
    // The service is made on first use, so listing the routes needs nothing of ctx.
    const service = () => loyaltyFor(ctx);
    const actor = (user) => `user:${user.id}`;
    return {
      'loyaltySettings.get': () => service().getSettings(),
      'loyaltySettings.update': ({ body, user }) => service().updateSettings(body, actor(user)),
      'loyalty.members': ({ query }) => service().members(query),
      'loyalty.ledger': ({ params, query }) => service().ledger(params.id, query),
      'loyalty.adjust': ({ params, body, user }) => service().adjust(params.id, body, actor(user)),
      'loyalty.referrals': ({ query }) => service().referralList(query),
    };
  },

  jobs(ctx) {
    const service = loyaltyFor(ctx);
    ctx.platform.queue.work(LOYALTY_JOB, () => service.sweep());
    return async function schedule() {
      await ctx.platform.queue.every(LOYALTY_JOB, 5 * 60_000);
    };
  },
};
