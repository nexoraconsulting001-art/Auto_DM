import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { openRuntimeDb } from './db/index.js';
import { createRepos } from './repos/index.js';
import { createGoogleAdapters } from './adapters/google/index.js';
import { createMetaAdapters, verifyHubSignature } from './adapters/meta/index.js';
import { createAuth } from './auth.js';
import { handleComment } from './handler.js';
import { createInstagram } from './instagram.js';
import { createCompliance } from './modules/compliance/index.js';
import { MODULES } from './modules/index.js';
import { createMetaCallObserver } from './modules/meta-calls.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes, baseUrlFor, buyerBaseUrl } from './routes/admin.js';
import { ApiError, isApiV1Url } from './contracts/api/index.js';
import { sendApiError } from './modules/api-v1/respond.js';
import { createTenantResolver, withTenant } from './tenancy.js';
import { createPlatform, describePlatform } from './platform/index.js';
import { log, reportError, requestIds } from './platform/log.js';
import { apiRoutes, mediaRoutes, storeRoutes } from './routes/store.js';

export const verifySignature = verifyHubSignature;

/**
 * Builds the web app. `db` comes from openDb(); `platform` (storage, queue, analytics, cache, metrics,
 * secrets) from createPlatform(); `ig` can be swapped for a fake in tests. Features plug in through
 * `modules` (see src/modules/index.js).
 */
export function createApp({ db, config = defaultConfig, modules = MODULES, metaCalls = createMetaCallObserver(modules), ig = createInstagram(config, { onCall: metaCalls.onCall }), platform = createPlatform(config, { db }) }) {
  const repos = createRepos(db, { storage: platform.storage, secrets: platform.secrets, modules });
  const auth = createAuth({ secret: config.sessionSecret, users: repos.users, sessions: repos.sessions, tenants: repos.tenants, cache: platform.cache });
  const tenants = createTenantResolver({ tenants: repos.tenants, platformDomain: config.platformDomain, defaultTenant: config.defaultTenant });
  const meta = createMetaAdapters(config, { onCall: metaCalls.onCall });
  const google = createGoogleAdapters(config);
  const compliance = createCompliance({ db, repos, ig, meta, config, platform });
  const ctx = { db, repos, ig, meta, google, compliance, auth, config, platform, modules, tenantResolver: tenants };
  metaCalls.bind(ctx);

  /** The business that owns an Instagram account: linked accounts first, then the default business. */
  async function tenantForIgAccount(igUserId) {
    if (igUserId) {
      const linked = await repos.tenants.getByIgAccount(igUserId);
      if (linked) return linked;
    }
    return config.defaultTenant ? repos.tenants.getBySlug(config.defaultTenant) : null;
  }
  const app = express();

  app.set('trust proxy', 1); // exactly one proxy (Caddy) terminates HTTPS in front of the app
  app.disable('x-powered-by');
  app.use(requestIds());
  app.use(platform.metrics.middleware());
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => (req.rawBody = buf) }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use('/static', express.static(path.join(config.rootDir, 'public'), { maxAge: '1h' }));

  // Liveness: the process is up. Readiness: it can reach the database (load balancers use this).
  app.get(['/health', '/healthz'], (_req, res) => res.send('ok'));
  app.get('/readyz', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, modules: describePlatform(platform) });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  platform.metrics.gauge('queue_jobs', async () =>
    Object.entries(await platform.queue.stats()).flatMap(([queue, counts]) =>
      Object.entries(counts).map(([status, value]) => ({ labels: { queue, status }, value }))));
  app.get('/metrics', platform.metrics.handler(config.metricsToken));

  // Modules come first, so a module's POST /webhook replaces the routes below.
  for (const module of modules) module.beforeTenant?.(app, ctx);

  // Meta webhook verification handshake
  app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && config.verifyToken && req.query['hub.verify_token'] === config.verifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
  });

  app.post('/webhook', async (req, res) => {
    if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), config.appSecret)) {
      log.warn('webhook.bad_signature');
      return res.sendStatus(401);
    }
    // Acknowledge fast; Meta retries deliveries that are slow to get a 200.
    res.sendStatus(200);

    for (const entry of req.body?.entry || []) {
      const tenant = await tenantForIgAccount(entry.id);
      if (!tenant) {
        log.warn('webhook.unknown_account', { igAccount: String(entry.id) });
        continue;
      }
      const base = buyerBaseUrl(tenant, config) || baseUrlFor(req, config);
      const storeUrl = (slug) => `${base}/r/${encodeURIComponent(slug)}?src=dm`;
      const ownIds = new Set([entry.id].filter(Boolean).map(String));
      await withTenant(tenant, async () => {
        for (const change of entry.changes || []) {
          if (change.field !== 'comments') continue;
          try {
            // Every DM goes out with the token of the Instagram account the comment arrived on.
            const account = await repos.igAccounts.get(entry.id);
            const client = account?.token ? compliance.clientFor(account) : null;
            const result = await handleComment(change.value, { repos, ig: client, ownIds, storeUrl, oneDmPerUser: config.oneDmPerUser });
            log.info('webhook.comment', { comment: change.value?.id, media: change.value?.media?.id, result });
            platform.metrics.inc('webhook_comments_total', { result: result.split(':')[0] });
          } catch (err) {
            reportError(err, { msg: 'webhook.comment_failed', comment: change.value?.id });
          }
        }
      });
    }
  });

  // A bearer token names its own user and business, so it is checked before the web address is looked at.
  app.use(auth.bearer);

  // Everything below belongs to one business: the bearer token's, or the one found from the web address.
  app.use(async (req, res, next) => {
    if (req.bearer) return next();
    // req.hostname honours X-Forwarded-Host only from the trusted proxy in front (Caddy).
    const tenant = await tenants.resolve(req.hostname);
    if (!tenant) {
      if (isApiV1Url(req.originalUrl)) return sendApiError(new ApiError('not_found', 'There is no store at this address.'), req, res);
      return res.status(404).type('text').send('There is no store at this address.');
    }
    withTenant(tenant, next);
  });

  app.use('/media', mediaRoutes({ repos }));
  // Everything below knows who is logged in, and POSTs from a cookie session need its CSRF token.
  app.use(auth.load, auth.checkCsrf);
  for (const module of modules) module.routes?.(app, ctx);
  app.use('/', accountRoutes({ repos, auth, config }));
  if (config.adminUi !== 'console') app.use('/admin', adminRoutes({ repos, ig, auth, config }));
  app.use('/api', apiRoutes({ repos }));
  app.use('/', storeRoutes({ repos, ig, auth }));

  app.use((err, req, res, _next) => {
    if (isApiV1Url(req.originalUrl)) return sendApiError(err, req, res);
    reportError(err, { msg: 'http.error', method: req.method, path: req.path });
    if (res.headersSent) return;
    if (req.path.startsWith('/api/') || req.get('accept')?.includes('application/json')) {
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
    res.status(500).type('text').send('Something went wrong on our side. Please go back and try again.');
  });

  return app;
}

async function main(config = defaultConfig) {
  const db = await openRuntimeDb(config);
  const platform = createPlatform(config, { db });
  const repos = createRepos(db, { storage: platform.storage, secrets: platform.secrets });
  const tenant = config.defaultTenant ? await repos.tenants.ensure({ slug: config.defaultTenant, name: config.defaultTenantName }) : null;
  const owner = tenant ? await withTenant(tenant, () => repos.users.ensureOwner({ phone: config.adminPhone, password: config.adminPassword })) : null;
  const server = createApp({ db, config, platform }).listen(config.port, () => {
    log.info('server.started', {
      port: config.port,
      dryRun: config.dryRun,
      database: db.kind,
      modules: describePlatform(platform),
      defaultBusiness: tenant?.slug ?? null,
      ownerFromEnv: Boolean(owner),
      sessionSecretSet: Boolean(process.env.SESSION_SECRET),
    });
  });
  // On a deploy, finish the requests in progress before stopping.
  const stop = () => server.close(async () => {
    await platform.cache.close();
    await db.close();
    process.exit(0);
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    reportError(err, { msg: 'server.failed_to_start' });
    process.exit(1);
  });
}
