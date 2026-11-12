import { APP_ROUTES } from '../../contracts/store-routes.js';
import { ApiError } from '../../contracts/api/index.js';
import { reportError } from '../../platform/log.js';
import { sendStoreError } from '../storefront/http.js';
import { SHOPPER_PUSH_ORDER_EVENTS, SHOPPER_PUSH_QUEUE, createShopperPush } from './service.js';

export { CAP_MESSAGE, NO_AUDIENCE_MESSAGE, NO_CREDENTIALS_MESSAGE, SHOPPER_PUSH_ORDER_EVENTS, SHOPPER_PUSH_QUEUE, quietEnd } from './service.js';

/**
 * Push to shoppers from the brand's own app (PRD 10.11). Track links-push. The rules are section 9 of the Phase 6 contract in
 * HANDOFF.md; service.js holds them, and its header says how.
 *
 *   shopperPushFor(ctx) -> { registerDevice(session, { token, permission }), prefs(session), savePrefs(session, patch),
 *                            removeDevice(session), detachShopper(t, deviceId), followOrder(session, orderToken | { orderToken }),
 *                            sendCampaign(input, actor), campaigns(query), summary(),
 *                            credentials: { get() -> masked, save(patch, actor) -> masked },
 *                            orderEvent(event), runCampaign(id), runReels(), scan(), work(payload) }   made once per ctx (a WeakMap)
 *   sender.js            senderFor(ctx) -> { send, configured, close }: the notifications module's push adapter through
 *                        forCredentials({ fcm?, apns? }) with this business's own decrypted credentials, and nothing else. The
 *                        only file outside src/modules/notifications that may name forCredentials (a test keeps it so).
 *
 * `session` is the app session the gate set (req.appSession: { deviceId, platform, version, guest, shopperId, ... }). The
 * app's calls need one: without it (a browser, or no gate) they answer 401. detachShopper(t, deviceId) is for app-api's
 * sign-out, in its own transaction.
 *
 * A push that cannot go out because of the brand's own keys (none set, or refused by Google or Apple) is told to the owner
 * only, as an alert (kind app.push_keys, once a week per platform and cause); the shopper's app sees only configured: false.
 *
 * Owns migration 606. Listener shopper-push.orders on the SHOPPER_PUSH_KINDS order events (claims and sends at once: order
 * updates never wait); queue shopper-push.send (a campaign, or a business's due reel pushes); the schedule hands due
 * campaigns and reel pushes older than mergeMs to that queue, every minute, from any worker.
 */
const API = ['pushCampaigns.list', 'pushCampaigns.summary', 'pushCampaigns.send', 'pushCredentials.get', 'pushCredentials.save'];
const STORE = ['pushDevice', 'pushDeviceRemove', 'pushPrefsGet', 'pushPrefsSave', 'pushFollowOrder'];

const built = new WeakMap();
/** The shopper push service of one app's or worker's context. */
export function shopperPushFor(ctx) {
  let service = built.get(ctx);
  if (!service) {
    service = createShopperPush(ctx);
    built.set(ctx, service);
  }
  return service;
}

/** An app call: the gate's session or 401, JSON in, no cache, the store's error shape. */
const appCall = (handler) => async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!req.appSession) throw new ApiError('unauthorized', 'Open the app and try again.');
    if ((req.method === 'PUT' || req.method === 'POST') && !req.is('application/json')) throw new ApiError('unsupported_media_type', 'Send this as JSON.');
    const out = await handler(req);
    if (out === undefined || out === null) return res.status(204).end();
    return res.json(out);
  } catch (err) {
    return sendStoreError(err, req, res);
  }
};

export const shopperPush = {
  name: 'shopper-push',
  owns: {
    migrations: ['606_shopper_push.sql'],
    tables: ['shopper_push_devices', 'shopper_push_consents', 'shopper_push_orders', 'push_campaigns', 'shopper_push_log', 'shopper_push_events', 'app_push_credentials'],
    api: API,
    store: STORE,
    platform: [],
    jobs: ['shopper-push.orders', 'shopper-push.send'],
  },

  setup(ctx) {
    ctx.orderEvents?.on(SHOPPER_PUSH_ORDER_EVENTS, 'shopper-push.orders', (event) => shopperPushFor(ctx).orderEvent(event));
  },

  api: (ctx) => {
    const service = () => shopperPushFor(ctx);
    return {
      'pushCampaigns.list': ({ query }) => service().campaigns(query),
      'pushCampaigns.summary': () => service().summary(),
      'pushCampaigns.send': ({ body, user }) => service().sendCampaign(body, user),
      'pushCredentials.get': () => service().credentials.get(),
      'pushCredentials.save': ({ body, user }) => service().credentials.save(body, user),
    };
  },

  routes(app, ctx) {
    const service = () => shopperPushFor(ctx);
    const path = (id) => APP_ROUTES[id].path;
    app.put(path('pushDevice'), appCall((req) => service().registerDevice(req.appSession, req.body)));
    app.delete(path('pushDeviceRemove'), appCall(async (req) => {
      await service().removeDevice(req.appSession);
      return null;
    }));
    app.get(path('pushPrefsGet'), appCall((req) => service().prefs(req.appSession)));
    app.put(path('pushPrefsSave'), appCall((req) => service().savePrefs(req.appSession, req.body)));
    app.post(path('pushFollowOrder'), appCall(async (req) => {
      await service().followOrder(req.appSession, req.body);
      return null;
    }));
  },

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(SHOPPER_PUSH_QUEUE, (job) => shopperPushFor(ctx).work(job.payload ?? {}));
    return async function schedule() {
      try {
        await shopperPushFor(ctx).scan();
      } catch (err) {
        reportError(err, { msg: 'shopper_push.scan_failed' });
      }
    };
  },
};
