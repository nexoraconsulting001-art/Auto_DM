import { catalogApi } from './catalog.js';
import { mountPasswordChange } from './password.js';
import { peopleApi } from './people.js';
import { reelsApi } from './reels.js';
import { adminListsRepo } from './repo.js';
import { settingsApi } from './settings.js';
import { createSetupChecks } from './setup.js';

/**
 * A later module's own handlers for routes this module answers: modules list them in takesOver(ctx), and they replace the Phase 0
 * handler of the same id here. The route still belongs to admin-api, so a test that swaps admin-api out (test/p0/api-contract)
 * still owns those ids. An id admin-api doesn't answer, or one two modules both take, is an error at startup.
 */
function takenOver(ctx, own) {
  const taken = new Map();
  for (const module of ctx.modules ?? []) {
    for (const [id, handler] of Object.entries(module.takesOver?.(ctx) ?? {})) {
      if (!Object.hasOwn(own, id)) throw new Error(`Module "${module.name}" takes over "${id}", which admin-api doesn't answer`);
      if (taken.has(id)) throw new Error(`Modules "${taken.get(id)}" and "${module.name}" both take over "${id}"`);
      taken.set(id, module.name);
      own[id] = handler;
    }
  }
  return own;
}

/**
 * The seller API: answers the /api/v1 routes of the contract (src/contracts/api) from the existing repos.
 * The api-v1 router has already checked who is calling and validated the input, and validates what is
 * returned here. Sign-in, the session and sign-out are answered by api-auth; changing a password is here.
 * Phase 3's catalog and categories modules replace the product and category handlers through takesOver.
 *
 * List this in src/modules/index.js before apiV1, because of the password route (see password.js).
 */
export const adminApi = {
  name: 'admin-api',
  repos: (db) => ({ adminLists: adminListsRepo(db) }),
  routes: (app, ctx) => mountPasswordChange(app, ctx),
  api(ctx) {
    const setup = createSetupChecks(ctx);
    return takenOver(ctx, { ...catalogApi(ctx), ...reelsApi(ctx, setup), ...peopleApi(ctx), ...settingsApi(ctx, setup) });
  },
};
