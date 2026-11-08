import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { config as defaultConfig } from './config.js';
import { openDb } from './db/index.js';
import { createRepos } from './repos/index.js';
import { createAuth } from './auth.js';
import { handleComment } from './handler.js';
import * as instagram from './instagram.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes, baseUrlFor, tenantBaseUrl } from './routes/admin.js';
import { createTenantResolver, withTenant } from './tenancy.js';
import { createPlatform, describePlatform } from './platform/index.js';
import { log, reportError, requestIds } from './platform/log.js';
import { apiRoutes, mediaRoutes, storeRoutes } from './routes/store.js';

export function verifySignature(rawBody, header, secret) {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Builds the web app. `db` comes from openDb(); `platform` (storage, queue, analytics, cache, metrics,
 * secrets) from createPlatform(); `ig` can be swapped for a fake in tests.
 */
export function createApp({ db, ig = instagram, config = defaultConfig, platform = createPlatform(config, { db }) }) {
  const repos = createRepos(db, { storage: platform.storage });
  const auth = createAuth({ secret: config.sessionSecret, users: repos.users, sessions: repos.sessions, cache: platform.cache });
  const tenants = createTenantResolver({ tenants: repos.tenants, platformDomain: config.platformDomain, defaultTenant: config.defaultTenant });

  /** The business that owns an Instagram account: linked accounts first, then the default business. */
  async function tenantForIgAccount(igUserId) {
    if (igUserId) {
      const linked = await repos.tenants.getByIgAccount(igUserId);
      if (linked) return linked;
    }
    return config.defaultTenant ? repos.tenants.getBySlug(config.defaultTenant) : null;
  }
  const app = express();

  app.set('trust proxy', 1); // exactly one proxy (Caddy, Codespaces or Render) terminates HTTPS in front of the app
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

    let unmapped = false;
    for (const entry of req.body?.entry || []) {
      const tenant = await tenantForIgAccount(entry.id);
      if (!tenant) {
        log.warn('webhook.unknown_account', { igAccount: String(entry.id) });
        unmapped = true;
        continue;
      }
      const base = tenantBaseUrl(tenant, config) || baseUrlFor(req, config);
      const storeUrl = (slug) => `${base}/r/${encodeURIComponent(slug)}?src=dm`;
      const ownIds = new Set([entry.id, config.igUserId].filter(Boolean).map(String));
      await withTenant(tenant, async () => {
        for (const change of entry.changes || []) {
          if (change.field !== 'comments') continue;
          try {
            const result = await handleComment(change.value, { repos, ig, ownIds, storeUrl, oneDmPerUser: config.oneDmPerUser });
            log.info('webhook.comment', { comment: change.value?.id, media: change.value?.media?.id, result });
            platform.metrics.inc('webhook_comments_total', { result: result.split(':')[0] });
            if (result === 'skip:unmapped-reel') unmapped = true;
          } catch (err) {
            reportError(err, { msg: 'webhook.comment_failed', comment: change.value?.id });
          }
        }
      });
    }
    // Reels this store doesn't use may belong to another app on the same Instagram account. It gets the
    // delivery byte for byte, with Meta's signature, and checks it with the same app secret.
    if (unmapped && config.forwardWebhookUrl) {
      fetch(config.forwardWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': req.get('x-hub-signature-256') },
        body: req.rawBody,
        signal: AbortSignal.timeout(5000),
      })
        .then((r) => console.log(`Passed comment on to ${config.forwardWebhookUrl}: ${r.status}`))
        .catch((err) => console.error(`Couldn't pass comment on to ${config.forwardWebhookUrl}: ${err.message}`));
    }
  });

  // DM links from the app that shares this Instagram account (see FORWARD_WEBHOOK_URL) point here.
  if (config.pluginUrl) {
    app.get('/l/:slug', (req, res) => {
      const qs = new URLSearchParams(req.query).toString();
      res.redirect(302, `${config.pluginUrl}/r/${encodeURIComponent(req.params.slug)}${qs ? `?${qs}` : ''}`);
    });
  }

  // Everything below belongs to one business, found from the web address.
  app.use(async (req, res, next) => {
    // req.hostname honours X-Forwarded-Host only from the trusted proxy in front (Caddy).
    const tenant = await tenants.resolve(req.hostname);
    if (!tenant) return res.status(404).type('text').send('There is no store at this address.');
    withTenant(tenant, next);
  });

  app.use('/media', mediaRoutes({ repos }));
  // Everything below knows who is logged in, and logged-in POSTs need the session's CSRF token.
  app.use(auth.load, auth.checkCsrf);
  app.use('/', accountRoutes({ repos, auth, config }));
  app.use('/admin', adminRoutes({ repos, ig, auth, config }));
  app.use('/api', apiRoutes({ repos }));
  app.use('/', storeRoutes({ repos, ig, auth }));

  app.use((err, req, res, _next) => {
    reportError(err, { msg: 'http.error', method: req.method, path: req.path });
    if (res.headersSent) return;
    if (req.path.startsWith('/api/') || req.get('accept')?.includes('application/json')) {
      return res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
    }
    res.status(500).type('text').send('Something went wrong on our side. Please go back and try again.');
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = defaultConfig;
  const db = await openDb({ url: config.databaseUrl, dataDir: config.dataDir });
  const platform = createPlatform(config, { db });
  const repos = createRepos(db, { storage: platform.storage });
  if (!config.databaseUrl) console.warn('DATABASE_URL is empty: using the built-in database, which is only for tests and quick local runs');
  const tenant = config.defaultTenant ? await repos.tenants.ensure({ slug: config.defaultTenant, name: config.defaultTenantName }) : null;
  const owner = tenant ? await withTenant(tenant, () => repos.users.ensureOwner({ phone: config.adminPhone, password: config.adminPassword })) : null;
  const server = createApp({ db, config, platform }).listen(config.port, () => {
    log.info('modules', describePlatform(platform));
    console.log(`auto-dm listening on :${config.port}${config.dryRun ? ' (DRY_RUN)' : ''}`);
    console.log(`Database: ${config.databaseUrl ? 'Postgres (DATABASE_URL)' : config.dataDir}`);
    if (tenant) console.log(`Default business: ${tenant.name} (${tenant.slug})`);
    if (owner) console.log(`Store owner: log in on /login with ${owner.phone} and ADMIN_PASSWORD`);
    else console.log('No store owner yet: set ADMIN_PHONE and ADMIN_PASSWORD in .env to use /admin');
    if (!process.env.SESSION_SECRET) console.log('Tip: set SESSION_SECRET in .env so logins survive restarts');
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
