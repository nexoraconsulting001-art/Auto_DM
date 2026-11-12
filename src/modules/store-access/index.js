import { notBuilt } from '../not-built.js';

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
 */
const API = ['storeAccess.get', 'storeAccess.save', 'storeAccess.check'];

export const storeAccess = {
  name: 'store-access',
  owns: { migrations: ['604_store_access.sql'], tables: ['store_access'], api: API, store: [], platform: [], jobs: [] },
  api: () => notBuilt(...API),
};
