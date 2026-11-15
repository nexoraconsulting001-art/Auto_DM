/**
 * The world the load test runs in, built the way the QA server is: a real Postgres with its settings and two logins, the
 * web app and the worker as two separate processes under their memory limits, and the Meta and Razorpay simulators.
 * Nothing in it can reach an outside service: the processes load tools/net-guard.mjs, and their environment is made here
 * from nothing (no variable of the person's shell is passed on), so no real address or key can get in.
 *
 *   const world = await startWorld({ budgets, dir, businesses: 10, say });
 *   world.web.pid, world.worker.pid, world.pg.pid     what the monitor reads
 *   world.shops[i]                                    { n, slug, host, tenantId, igUserId, reelId, productSlugs, productIds, token, ... }
 *   await world.restart(['web','worker'], { hard })   kills them and starts them again; answers { downMs, backMs }
 *   await world.close()                               stops everything this world started, by its own pid
 *
 * The businesses are made the way a person makes one (the business, its owner, its Instagram account at the simulator,
 * products, a live automation, payments through the console API and the simulator's KYC). The seed loader of the
 * showcase (scripts/showcase.js, Phase 8 seed track) is used when it is built; until then this does the same work with
 * the repos and the API.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMeta, DEFAULT_SCOPES } from '../sim/meta/index.mjs';
import { createRazorpay } from '../sim/razorpay/index.mjs';
import { ROOT, startNode, startPostgres } from './stack.mjs';
import { createClient, sleep } from './http.mjs';

export const PLATFORM_DOMAIN = 'shops.example';
const FIELDS = ['comments', 'messages', 'messaging_postbacks', 'mentions'];

export const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** The only variables a child gets from this shell: where programs and temporary folders are. Nothing secret, nothing that names a service. */
function inheritedBasics() {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'COMSPEC', 'ComSpec'];
  return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}

/** The environment of web and worker. Every value is made up for this run. */
export function childEnv({ ownerUrl, appUrl, webPort, workerPort, metaUrl, razorpay, secrets, storageDir, backupDir = '' }) {
  return {
    ...inheritedBasics(),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(ROOT, 'tools', 'net-guard.mjs')).href}`,
    PASSWORD_LOGIN: '1',
    ACCESS_TOKEN_MINUTES: '600',
    DATABASE_URL: appUrl,
    DATABASE_OWNER_URL: ownerUrl,
    PORT: String(webPort),
    WORKER_HEALTH_PORT: String(workerPort),
    DEFAULT_TENANT: '',
    PLATFORM_DOMAIN,
    ADMIN_UI: 'console',
    APP_SECRET: secrets.appSecret,
    VERIFY_TOKEN: secrets.verifyToken,
    IG_APP_ID: 'sim-app',
    GRAPH_BASE_URL: metaUrl,
    META_TIMEOUT_MS: '5000',
    META_CALLBACK_BASE_URL: `http://127.0.0.1:${webPort}`,
    SESSION_SECRET: secrets.session,
    DATA_KEY: secrets.dataKey,
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: storageDir,
    QUEUE_DRIVER: 'pg',
    ANALYTICS_DRIVER: 'pg',
    CACHE_DRIVER: 'memory',
    PAYMENT_MODE: 'managed',
    PROVIDER_TIMEOUT_MS: '5000',
    FETCH_HOST_GAP_MS: '0',
    RAZORPAY_BASE_URL: razorpay.url,
    RAZORPAY_AUTH_BASE_URL: razorpay.url,
    RAZORPAY_KEY_ID: razorpay.keyId,
    RAZORPAY_KEY_SECRET: razorpay.keySecret,
    RAZORPAY_WEBHOOK_SECRET: razorpay.webhookSecret,
    RAZORPAY_PARTNER_CLIENT_ID: razorpay.partner.clientId,
    RAZORPAY_PARTNER_CLIENT_SECRET: razorpay.partner.clientSecret,
    ...(backupDir ? { BACKUP_STORAGE_DRIVER: 'local', BACKUP_STORAGE_DIR: backupDir } : {}),
  };
}

export const madeUpSecrets = () => ({
  appSecret: crypto.randomBytes(16).toString('hex'),
  verifyToken: crypto.randomBytes(8).toString('hex'),
  session: crypto.randomBytes(24).toString('hex'),
  dataKey: crypto.randomBytes(32).toString('base64'),
});

export async function waitReady(client, host, ms, node) {
  const end = Date.now() + ms;
  for (;;) {
    if (node.child.exitCode !== null || node.child.signalCode !== null) throw new Error(`${node.role} stopped while starting`);
    const res = await client.request({ path: '/readyz', host });
    if (res.status === 200) return;
    if (Date.now() > end) throw new Error(`${node.role} did not answer /readyz within ${ms / 1000} s`);
    await sleep(150);
  }
}

export async function waitWorker(port, ms, node) {
  const end = Date.now() + ms;
  for (;;) {
    if (node.child.exitCode !== null || node.child.signalCode !== null) throw new Error('worker stopped while starting');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`worker did not answer /healthz within ${ms / 1000} s`);
    await sleep(150);
  }
}

export async function startWorld({ budgets, dir, businesses = budgets.businesses, say = () => {}, backupDir = '', withSeed = true }) {
  fs.mkdirSync(dir, { recursive: true });
  const started = [];
  const secrets = madeUpSecrets();
  const closers = [];
  const close = async () => {
    for (const fn of closers.reverse()) await fn().catch(() => {});
  };
  try {
    say('Starting Postgres with the QA server settings');
    const pg = await startPostgres({ dir: path.join(dir, 'pg'), budgets });
    closers.push(() => pg.stop());

    const webPort = await freePort();
    const workerPort = await freePort();
    const meta = createMeta({ app: { id: 'sim-app', secret: secrets.appSecret, verifyToken: secrets.verifyToken, webhookUrl: `http://127.0.0.1:${webPort}/webhook` } });
    await meta.start();
    closers.push(() => meta.close());
    const razorpay = createRazorpay({ webhookUrl: `http://127.0.0.1:${webPort}/webhooks/razorpay` });
    await razorpay.start();
    closers.push(() => razorpay.close());

    // Open the database as the app does (two logins), which also runs the migrations as the owner.
    const { openDb } = await import('../../src/db/index.js');
    const db = await openDb({ url: pg.appUrl, ownerUrl: pg.ownerUrl, poolSize: 2 });
    closers.push(() => db.close());

    const env = childEnv({ ownerUrl: pg.ownerUrl, appUrl: pg.appUrl, webPort, workerPort, metaUrl: meta.url, razorpay, secrets, storageDir: path.join(dir, 'files'), backupDir });
    fs.mkdirSync(env.STORAGE_DIR, { recursive: true });
    const client = createClient({ port: webPort, connections: budgets.run.connections });
    closers.push(async () => client.close());

    const world = { budgets, dir, pg, db, meta, razorpay, env, webPort, workerPort, secrets, client, shops: [], say, close };
    const spawnRole = (role) => startNode(role, { budgets, env });
    world.web = spawnRole('web');
    world.worker = spawnRole('worker');
    started.push(world.web, world.worker);
    closers.push(async () => {
      for (const node of [world.web, world.worker]) await node.stop().catch(() => {});
    });
    say('Starting the web app and the worker');
    await Promise.all([waitReady(client, undefined, 60_000, world.web), waitWorker(workerPort, 60_000, world.worker)]);

    /** Kills `roles` (hard: no chance to finish) and starts them again. Times are milliseconds. */
    world.restart = async (roles = ['web', 'worker'], { hard = true } = {}) => {
      const killedAt = performance.now();
      await Promise.all(roles.map((role) => world[role].stop({ hard })));
      const downMs = performance.now() - killedAt;
      const startedAt = performance.now();
      for (const role of roles) world[role] = spawnRole(role);
      await Promise.all(roles.map((role) => (role === 'web' ? waitReady(client, undefined, 120_000, world.web) : waitWorker(workerPort, 120_000, world.worker))));
      return { downMs, backMs: performance.now() - startedAt, killedAt };
    };

    if (withSeed) {
      say(`Making ${businesses} businesses`);
      const began = performance.now();
      await seedBusinesses(world, businesses);
      say(`Made ${businesses} businesses in ${Math.round((performance.now() - began) / 1000)} s`);
    }
    return world;
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/** The made-up phone of owner n. Not a real number: the 9000 block is used by tests only. */
const phoneOf = (n) => `9000${String(n).padStart(6, '0')}`;
const igIdOf = (n) => `1784140000000${String(n).padStart(4, '0')}`;

export async function seedBusinesses(world, count) {
  const { db, meta, razorpay, client, secrets } = world;
  const { createRepos, bindTenant } = await import('../../src/repos/index.js');
  const { createSecrets } = await import('../../src/platform/secrets.js');
  const repos = createRepos(db, { secrets: createSecrets({ dataKey: secrets.dataKey }) });
  await razorpay.post('/webhooks/url', { url: `http://127.0.0.1:${world.webPort}/webhooks/razorpay` });

  const makeOne = async (n) => {
    const slug = `biz${n}`;
    const name = `Business ${n}`;
    const tenant = await repos.tenants.create({ slug, name, plan: 't3' });
    const bound = bindTenant(repos, tenant);
    const owner = { phone: phoneOf(n), password: crypto.randomBytes(9).toString('hex') };
    await bound.users.ensureOwner(owner);
    await bound.settings.update({ store_name: name });
    const site = `https://${slug}-site.example`;
    await db.platform.query(`UPDATE tenants SET status = 'active', website = $2 WHERE id = $1`, [tenant.id, site]);
    await db.platform.query('INSERT INTO compliance_settings (tenant_id, subject_salt) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [tenant.id, crypto.randomBytes(24).toString('hex')]);
    await db.platform.query(`UPDATE compliance_settings SET access_level = 'advanced', app_role_ok = true, privacy_url_ok_at = now(), deletion_callback_ok_at = now(), gate_passed_at = now() WHERE tenant_id = $1`, [tenant.id]);

    const igUserId = igIdOf(n);
    const { token: igToken } = await meta.post('/accounts', { igUserId, username: `${slug}_ig`, subscribedFields: FIELDS, appRole: true, scopes: [...DEFAULT_SCOPES] });
    await repos.tenants.linkIgAccount(tenant.id, igUserId, `${slug}_ig`);
    await bound.igAccounts.setToken(igUserId, igToken);
    await db.platform.query(
      `UPDATE ig_accounts SET status = 'active', granted_scopes = $3, subscribed_fields = $4, subscribed_at = now(), token_version = 1, token_issued_at = now() - interval '2 days',
         token_expires_at = now() + interval '50 days', next_refresh_at = now() + interval '30 days', connected_at = now() WHERE tenant_id = $1 AND ig_user_id = $2`,
      [tenant.id, igUserId, [...DEFAULT_SCOPES], FIELDS],
    );

    const host = `${slug}.${PLATFORM_DOMAIN}`;
    const login = await client.request({ method: 'POST', path: '/api/v1/auth/login', host, body: owner });
    if (login.status !== 201) throw new Error(`Business ${n}: sign-in answered ${login.status}`);
    const token = JSON.parse(login.text).token;
    const api = async (method, p, body, want) => {
      const res = await client.request({ method, path: `/api/v1${p}`, host, headers: { authorization: `Bearer ${token}` }, body });
      if (!want.includes(res.status)) throw new Error(`Business ${n}: ${method} ${p} answered ${res.status}`);
      return res.text ? JSON.parse(res.text) : null;
    };

    for (let k = 1; k <= 4; k++) await api('POST', '/products', { name: `Item ${k} of ${n}`, pricePaise: 49900, active: true, stock: 100000 }, [200, 201]);
    const products = await db.platform.query('SELECT id, slug FROM products WHERE tenant_id = $1 ORDER BY id', [tenant.id]);
    if (products.length < 4) throw new Error(`Business ${n}: products were not made`);

    const reelId = `1800000000000${String(n).padStart(4, '0')}`;
    await meta.post('/media', { igUserId, id: reelId, productType: 'REELS', caption: 'A reel' });
    const saved = await api('POST', '/automations', {
      name: `Automation ${n}`, triggerType: 'comment', matchMode: 'keywords', keywords: ['price'], linkMode: 'one_tap', linkType: 'seller_site', linkUrl: `${site}/p/a`, linkButtonTitle: 'Open the link',
      triggers: [{ channel: 'instagram', targetType: 'reel', mediaId: reelId }],
      variants: [{ label: 'A', body: 'Hi {first_name}, here is the link you asked for.', buttonTitle: 'Open the link', fallbackText: 'Here is the link you asked for: {url}' }],
    }, [200, 201]);
    await db.platform.query(`UPDATE automations SET state = 'live', link_status = 'ok', link_checked_at = now() WHERE tenant_id = $1 AND id = $2`, [tenant.id, saved.id]);

    // Payments in managed mode: the linked account through the console API, its KYC passed at the simulator.
    await api('POST', '/payment-account/linked', { legalName: `Traders ${n}`, contactName: 'Meera Shah', email: `owner-${n}@seller.example`, phone: '+919811100000', businessType: 'proprietorship' }, [200, 201]);
    const [{ linked_account_id: linked }] = await db.platform.query('SELECT linked_account_id FROM payment_settings WHERE tenant_id = $1', [tenant.id]);
    await razorpay.post('/accounts/kyc', { id: linked, status: 'activated' });

    world.shops.push({
      n, slug, name, host, tenantId: tenant.id, igUserId, igToken, reelId, token, owner, site,
      productIds: products.map((p) => Number(p.id)), productSlugs: products.map((p) => p.slug),
    });
  };
  // Four at a time: the business's own sign-in and payment set-up are slow, and they do not depend on each other.
  const queue = Array.from({ length: count }, (_, i) => i + 1);
  await Promise.all(Array.from({ length: Math.min(4, count) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await makeOne(n);
  }));
  world.shops.sort((a, b) => a.n - b.n);

  // KYC reaches the app by webhook and the worker's job; wait for every business to be ready to take money.
  const end = Date.now() + 90_000;
  for (;;) {
    const [{ n }] = await db.platform.query(`SELECT count(*)::int AS n FROM payment_settings WHERE kyc_status = 'verified'`);
    if (n >= count) break;
    if (Date.now() > end) throw new Error(`Only ${n} of ${count} businesses finished payment set-up in 90 s`);
    await sleep(500);
  }
  return world.shops;
}

export const hostInfo = () => ({ cpus: os.cpus().length, totalMemoryMb: Math.round(os.totalmem() / 1048576), platform: process.platform, node: process.version });
