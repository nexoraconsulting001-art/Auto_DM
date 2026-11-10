import { PROVIDER_PATHS } from '../../contracts/api/provider.js';
import { reportError } from '../../platform/log.js';
import { normalizeHost, withTenant } from '../../tenancy.js';
import { buyerSettings } from '../brand/index.js';
import { createCallbacks } from './callbacks.js';
import { createConnect } from './connect.js';
import { PRIVACY_PATH, createGates } from './gates.js';
import { createMediaList } from './media.js';
import { bhavaPrivacyPage, sellerPrivacyPage } from './pages.js';
import { applyRetention, igConnectRepo } from './repo.js';
import { ensureReviewBusiness, reviewRoutes, reviewSettings } from './review.js';
import { connectionView } from './rules.js';
import { createTokenKeeper } from './tokens.js';

const SWEEP = 'ig-connect.sweep';
const MAINTAIN = 'ig-connect.maintain';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const hostOf = (url) => {
  try {
    return normalizeHost(new URL(url).host);
  } catch {
    return '';
  }
};

/**
 * Bhava's own addresses, where /privacy is Bhava's policy. Every other address is a business's, where it has to be that business's. The address
 * registered with Meta counts only when it is its own: with META_CALLBACK_BASE_URL unset it is PUBLIC_BASE_URL, which is a store.
 */
function platformHosts(config) {
  const domain = normalizeHost(config.platformDomain);
  return new Set([
    domain,
    domain ? `www.${domain}` : '',
    config.metaCallbackBaseUrl !== config.publicBaseUrl ? hostOf(config.metaCallbackBaseUrl) : '',
  ].filter(Boolean));
}

/**
 * PRD 4.1, 4.2, 4.14, 4.15: connecting Instagram through the login adapter (ctx.meta.login), token refresh and alerts, subscribed_apps, the
 * deauthorize and deletion callbacks, the release gates, the privacy page and the review login. Provider callbacks go in beforeTenant.
 * One Meta app serves every business, and nothing here is per client. `options.fetchImpl` and `options.now` are for tests.
 */
export function createIgConnect({ fetchImpl, now } = {}) {
  const built = new WeakMap();

  /** One set of services per app or worker, made the first time something needs them. */
  function services(ctx) {
    if (built.has(ctx)) return built.get(ctx);
    const gates = createGates({ repos: ctx.repos, config: ctx.config, cache: ctx.platform.cache, ...(fetchImpl ? { fetchImpl } : {}) });
    const connect = createConnect({ db: ctx.db, repos: ctx.repos, meta: ctx.meta, config: ctx.config, platform: ctx.platform, gates });
    const callbacks = createCallbacks({ db: ctx.db, repos: ctx.repos, config: ctx.config, gates });
    const keeper = createTokenKeeper({ db: ctx.db, repos: ctx.repos, meta: ctx.meta, ...(now ? { now } : {}) });
    const made = { gates, connect, callbacks, keeper, media: createMediaList({ repos: ctx.repos, meta: ctx.meta }) };
    built.set(ctx, made);
    return made;
  }

  /** The hourly jobs: failed webhook subscriptions tried again, gates kept true, and data past its retention removed. */
  async function maintain(ctx) {
    const { connect, gates } = services(ctx);
    const accounts = await ctx.db.platform.query(`SELECT tenant_id, ig_user_id, subscribed_at FROM ig_accounts WHERE access_token_enc <> '' AND status = 'active' LIMIT 5000`);
    for (const account of accounts) {
      await withTenant(account.tenant_id, async () => {
        if (!account.subscribed_at) await connect.subscribe(account.ig_user_id);
        await gates.evaluate();
      }).catch((err) => reportError(err, { msg: 'ig_connect.maintain_failed', igUserId: account.ig_user_id }));
    }
    await applyRetention(ctx.db.platform);
  }

  return {
    name: 'ig-connect',
    repos: (db) => ({ igConnect: igConnectRepo(db) }),

    beforeTenant(app, ctx) {
      const { connect, callbacks } = services(ctx);
      app.get(PROVIDER_PATHS.instagramCallback, connect.callback);
      app.post(PROVIDER_PATHS.deauthorize, callbacks.deauthorize);
      app.post(PROVIDER_PATHS.deletion, callbacks.deletion);
      app.get(PROVIDER_PATHS.deletionStatus, callbacks.deletionStatus);

      const hosts = platformHosts(ctx.config);
      app.get(PRIVACY_PATH, (req, res, next) => {
        if (!hosts.has(normalizeHost(req.hostname))) return next();
        res.set('Cache-Control', 'public, max-age=3600').type('html').send(String(bhavaPrivacyPage({ config: ctx.config })));
      });

      const review = reviewSettings(ctx.config);
      if (review) ensureReviewBusiness({ repos: ctx.repos, review }).catch((err) => reportError(err, { msg: 'review.setup_failed' }));
    },

    routes(app, ctx) {
      // A buyer on a business's address sees that business's policy, never Bhava's.
      app.get(PRIVACY_PATH, async (_req, res) => {
        res.set('Cache-Control', 'public, max-age=3600').type('html').send(String(sellerPrivacyPage({ settings: await buyerSettings(ctx.repos) })));
      });
      const review = reviewSettings(ctx.config);
      if (review) reviewRoutes(app, { repos: ctx.repos, auth: ctx.auth, config: ctx.config, services: services(ctx), review });
    },

    api: (ctx) => ({
      'instagram.connection': async () => connectionView(await ctx.repos.igAccounts.primary()),
      'instagram.connect': ({ body, user, req }) => services(ctx).connect.start({ user, returnTo: body.returnTo, req }),
      'instagram.disconnect': async ({ user }) => {
        const account = await ctx.repos.igAccounts.primary();
        if (!account) return;
        const { connect, gates } = services(ctx);
        await connect.disconnect(account.igUserId, `user:${user.id}`);
        await gates.evaluate().catch((err) => reportError(err, { msg: 'ig_connect.gates_failed' }));
      },
      'instagram.media': ({ query }) => services(ctx).media(query),
    }),

    jobs(deps) {
      // With no Meta app there is nothing to refresh, and no callback could have been verified.
      if (!deps.config.appSecret && !deps.config.fbAppSecret) return undefined;
      const { queue } = deps.platform;
      queue.work(SWEEP, async () => {
        const { keeper, callbacks } = services(deps);
        await keeper.sweep();
        await callbacks.finishOpenDeletions();
      });
      queue.work(MAINTAIN, () => maintain(deps));
      return async () => {
        await queue.every(SWEEP, MINUTE);
        await queue.every(MAINTAIN, HOUR);
      };
    },
  };
}

export const igConnect = createIgConnect();

