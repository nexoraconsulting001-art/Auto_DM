import { catalogApi } from './catalog.js';
import { mountPasswordChange } from './password.js';
import { peopleApi } from './people.js';
import { reelsApi } from './reels.js';
import { adminListsRepo } from './repo.js';
import { settingsApi } from './settings.js';
import { createSetupChecks } from './setup.js';

/**
 * The seller API: answers the /api/v1 routes of the contract (src/contracts/api) from the existing repos.
 * The api-v1 router has already checked who is calling and validated the input, and validates what is
 * returned here. Sign-in, the session and sign-out are answered by api-auth; changing a password is here.
 *
 * List this in src/modules/index.js before apiV1, because of the password route (see password.js).
 */
export const adminApi = {
  name: 'admin-api',
  repos: (db) => ({ adminLists: adminListsRepo(db) }),
  routes: (app, ctx) => mountPasswordChange(app, ctx),
  api(ctx) {
    const setup = createSetupChecks(ctx);
    return { ...catalogApi(ctx), ...reelsApi(ctx, setup), ...peopleApi(ctx), ...settingsApi(ctx, setup) };
  },
};
