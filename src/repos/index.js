import { activityRepo } from './activity.js';
import { categoriesRepo } from './categories.js';
import { mediaRepo } from './media.js';
import { ordersRepo } from './orders.js';
import { productsRepo } from './products.js';
import { reelsRepo } from './reels.js';
import { sessionsRepo } from './sessions.js';
import { settingsRepo } from './settings.js';
import { statsRepo } from './stats.js';
import { tenantsRepo } from './tenants.js';
import { usersRepo } from './users.js';
import { withTenant } from '../tenancy.js';
import { createStorage } from '../platform/storage.js';

/**
 * Every repo except `tenants` works on the current business only (see tenancy.js) and throws when
 * called outside withTenant(). `tenants` is the platform-level repo.
 * `storage` holds uploaded files (in memory unless given, which suits tests).
 */
export function createRepos(db, { storage = createStorage({ storageDriver: 'memory' }) } = {}) {
  return {
    activity: activityRepo(db),
    categories: categoriesRepo(db),
    media: mediaRepo(db, { storage }),
    orders: ordersRepo(db),
    products: productsRepo(db),
    reels: reelsRepo(db),
    sessions: sessionsRepo(db),
    settings: settingsRepo(db),
    stats: statsRepo(db),
    tenants: tenantsRepo(db),
    users: usersRepo(db),
  };
}

/**
 * The same repos, with every call run as `tenant` (scripts, jobs and tests). Web requests don't need
 * this: the business is already set from the web address.
 */
export function bindTenant(repos, tenant) {
  const bound = {};
  for (const [name, repo] of Object.entries(repos)) {
    bound[name] = {};
    for (const [key, value] of Object.entries(repo)) {
      bound[name][key] = typeof value === 'function' ? (...args) => withTenant(tenant, () => value.apply(repo, args)) : value;
    }
  }
  return bound;
}
