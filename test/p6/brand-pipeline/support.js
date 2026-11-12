import '../../../tools/net-guard.mjs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createEas } from '../../../tools/sim/eas/index.mjs';
import { withTenant } from '../../../src/tenancy.js';
import { createAppBuilds } from '../../../src/modules/app-builds/index.js';
import { OWNER, TEST_SIGNING_SHA256, enableApp, startApp } from '../../helpers.js';

// Shared by the brand-pipeline tests: one app (in-memory database, no worker: the tests run the queue's handlers themselves),
// the EAS simulator, and businesses with app details on their own verified domain. The default business of startApp has a
// fallback host under the test platform domain, so each business here gets a domain of its own.

export const EXPO_TOKEN = 'expo-pipeline-test-token-7c1d';
export const PLATFORM_HOST = 'admin.bhava.test';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const key = () => `rk-${crypto.randomBytes(9).toString('hex')}`;
let serial = 0;

/** A plain PNG: `alpha` makes it fully transparent. */
export const png = (width, height, { alpha = false, color = '#2E7D5B' } = {}) => sharp({
  create: { width, height, channels: alpha ? 4 : 3, background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : color },
}).png().toBuffer();

export async function startWorld({ overrides = {} } = {}) {
  const eas = createEas({ token: EXPO_TOKEN });
  await eas.start();
  const app = await startApp({ overrides: { expoToken: EXPO_TOKEN, easBaseUrl: eas.url, appBuildDriver: 'eas', appBuildPollMs: 30, providerTimeoutMs: 700, ...overrides } });
  const sql = (text, params) => app.db.platform.query(text, params);
  const { token } = await (await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) })).json();

  async function call(method, path, body, headers = {}) {
    const res = await fetch(`${app.base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    return { status: res.status, body: json, text };
  }

  let consoleSession = null;
  const w = {
    app, eas, sql, token,
    ctx: app.ctx,
    /** The seller API of the default business, as its owner. */
    api: (method, path, body, { bearer = token } = {}) => call(method, `/api/v1${path}`, body, { authorization: `Bearer ${bearer}` }),
    /** The Platform Console, signed in as a super admin. */
    async console(method, path, body) {
      if (!consoleSession) {
        await app.platform.platformUsers.create({ email: 'ops@team.example', password: 'platform-pass-123', role: 'super_admin' });
        const res = await fetch(`${app.base}/login`, { method: 'POST', headers: { 'x-forwarded-host': PLATFORM_HOST, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ops@team.example', password: 'platform-pass-123' }) });
        consoleSession = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf };
      }
      return call(method, path, body, { 'x-forwarded-host': PLATFORM_HOST, cookie: consoleSession.cookie, 'x-csrf-token': consoleSession.csrf });
    },
    /** A builds service on the app's context; `seams` as createAppBuilds takes them. */
    builds: (seams = {}) => createAppBuilds(app.ctx, { submit: async () => ({}), ...seams }),
    /** Moves the build service's clock and follows every building build, until `done` says so. */
    async drive(service, done, { rounds = 30, stepMs = 15_000 } = {}) {
      for (let i = 0; i < rounds; i++) {
        const value = await done();
        if (value) return value;
        await eas.post('/clock', { advanceMs: stepMs });
        await service.poll();
      }
      return done();
    },
    async close() {
      app.ctx.notify?.close?.();
      app.close();
      await eas.close();
    },
  };
  // The default business gets a domain of its own and a complete app.
  w.main = await brand(w, { tenant: app.tenant, platforms: ['android', 'ios'] });
  return w;
}

/**
 * A business with its own verified domain and complete app details (enableApp) for `platforms`, its icon uploaded. `tenant`
 * reuses one; `config` changes app_configs columns. Returns { tenant, host, run(fn), row(), set(columns) }.
 */
export async function brand(w, { tenant, platforms = ['android', 'ios'], config = {}, name, icon = true } = {}) {
  const n = ++serial;
  const t = tenant ?? await w.app.platform.tenants.ensure({ slug: `brand-${n}-${crypto.randomBytes(3).toString('hex')}`, name: name ?? `Shop ${n}` });
  const host = `shop${t.id}-${n}.example`;
  await w.sql(`INSERT INTO tenant_domains (domain, tenant_id, status, verified_at) VALUES ($1, $2, 'verified', now())`, [host, t.id]);
  const run = (fn) => withTenant(t, fn);
  let iconId = null;
  if (icon) iconId = await run(async () => w.ctx.repos.media.save(await png(1024, 1024), 'image/png'));
  await enableApp(w.app, {
    tenant: t, platforms,
    config: {
      app_name: (name ?? `Shop ${n}`).slice(0, 30), short_name: `Shop${n}`.slice(0, 12), android_package: `com.example.s${t.id}x${n}`, ios_bundle_id: `com.example.s${t.id}x${n}`,
      url_scheme: `shop${t.id}x${n}`, shop_domain: host, support_email: `help${n}@seller.example`, privacy_url: `https://${host}/policies/privacy`,
      play_signing_sha256: [TEST_SIGNING_SHA256], icon_media_id: iconId, ...config,
    },
  });
  return {
    tenant: t, host, run, iconId,
    row: async () => (await w.sql('SELECT * FROM app_configs WHERE tenant_id = $1', [t.id]))[0],
    set: async (patch) => {
      const names = Object.keys(patch);
      await w.sql(`UPDATE app_configs SET ${names.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE tenant_id = $1`, [t.id, ...names.map((c) => patch[c])]);
    },
    builds: async () => w.sql('SELECT * FROM app_builds WHERE tenant_id = $1 ORDER BY id', [t.id]),
  };
}

/** A business with no shopper app in its plan. */
export async function plainBusiness(w) {
  const n = ++serial;
  const tenant = await w.app.platform.tenants.ensure({ slug: `plain-${n}-${crypto.randomBytes(3).toString('hex')}`, name: `Plain ${n}` });
  await w.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled, limit_value) VALUES ($1, 'app.android', false, NULL), ($1, 'app.ios', false, NULL)
               ON CONFLICT (tenant_id, feature) DO UPDATE SET enabled = false`, [tenant.id]);
  return { tenant, run: (fn) => withTenant(tenant, fn) };
}
