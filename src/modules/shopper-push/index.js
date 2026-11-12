import { APP_ROUTES } from '../../contracts/store-routes.js';
import { notBuilt, storeNotBuilt } from '../not-built.js';

/**
 * Push to shoppers from the brand's own app (PRD 10.11). Track links-push. Read section 9 of the Phase 6 contract in HANDOFF.md
 * first: the rules are fixed there.
 *
 *   shopperPushFor(ctx) -> { registerDevice(session, { token, permission }), prefs(session), savePrefs(session, patch),
 *                            removeDevice(session), detachShopper(t, deviceId), followOrder(session, orderToken),
 *                            sendCampaign(input, actor), campaigns(query), summary(),
 *                            credentials: { get() -> masked, save(patch, actor) -> masked } }   made once per ctx (a WeakMap)
 *   sender.js            senderFor(tenant) -> { send, close }: the notifications module's push adapter through
 *                        forCredentials({ fcm?, apns? }) with this business's own decrypted credentials, and nothing else. The
 *                        only file outside src/modules/notifications that may name forCredentials (a test keeps it so).
 *
 * Registering never opts in; first_order_prompt may turn on order updates only; offers and new reels need an explicit true from
 * settings. Claim the shopper_push_log row, commit, then send; retry only a throttled answer; never send again on an unknown
 * outcome. Every push passes shopperPushProblem (src/contracts/apps.js); data is { link, kind } only. Offers and new-reel pushes
 * wait out quiet hours and count against config.shopperPushWeeklyCap.
 *
 * Owns migration 606. Listener shopper-push.orders on the SHOPPER_PUSH_KINDS order events; queue shopper-push.send; a schedule
 * drains shopper_push_events (older than mergeMs) and due campaigns.
 */
const API = ['pushCampaigns.list', 'pushCampaigns.summary', 'pushCampaigns.send', 'pushCredentials.get', 'pushCredentials.save'];
const STORE = ['pushDevice', 'pushDeviceRemove', 'pushPrefsGet', 'pushPrefsSave', 'pushFollowOrder'];

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
  api: () => notBuilt(...API),
  routes(app) {
    storeNotBuilt(app, APP_ROUTES, ...STORE);
  },
};
