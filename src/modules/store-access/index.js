import { storeAccessFor } from './service.js';

export { storeAccessFor, closedTestOf, keyLast4, CLOSED_TEST, DUNS_LOOKUP } from './service.js';

/**
 * The business's own developer accounts and our access to them (PRD 10.9). Track store-release. Owns store_access (604).
 *
 *   storeAccessFor(ctx) -> { list(), save(platform, patch, actor), check(platform), credentials(platform) -> decrypted, for
 *                            submit only }   made once per ctx (a WeakMap)
 *
 * A personal Play account shows a warning and adds the closed-testing step (12 testers, 14 days); no D-U-N-S number shows the
 * lookup link and a waiting status; check() asks ctx.appStores (appStoreConnect.forKey(...).checkAccess, googlePlay.checkAccess)
 * and a role that is too low names the role needed (config.appStoreRoleNeeded, config.playPermissionNeeded). Never a password:
 * the App Store Connect .p8 is stored with platform.secrets and answered only as its last four characters, and Play access is
 * our one service account (PLAY_SERVICE_ACCOUNT) that the owner invites. storeAccess.save is fresh.
 *
 * Also: get(platform) and reviewReader(platform) (the store's review state for this business's app, for app-submissions' poll).
 * check() also reads the seller name the store shows and marks the legal-name step done when it is the business's legal name;
 * 604 has no column for it, so the newest 'store_access.checked' audit row keeps whether it matched (never the name itself).
 */
const API = ['storeAccess.get', 'storeAccess.save', 'storeAccess.check'];

export const storeAccess = {
  name: 'store-access',
  owns: { migrations: ['604_store_access.sql'], tables: ['store_access'], api: API, store: [], platform: [], jobs: [] },
  api: (ctx) => ({
    'storeAccess.get': async () => ({ items: await storeAccessFor(ctx).list() }),
    'storeAccess.save': ({ params, body, user }) => storeAccessFor(ctx).save(params.id, body, user),
    'storeAccess.check': ({ params, user }) => storeAccessFor(ctx).check(params.id, user),
  }),
};
