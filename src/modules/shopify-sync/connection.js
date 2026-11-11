import { ApiError } from '../../contracts/api/errors.js';
import { STORE_PROVIDER_PATHS } from '../../contracts/store-routes.js';
import { ProviderError } from '../../adapters/http.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { tenantBaseUrl } from '../admin-api/urls.js';
import { writeAudit } from '../audit/index.js';

/**
 * A business's own Shopify app (PRD 9.11): its shop's myshopify.com address, its Admin API token and the secret Shopify signs
 * its webhooks with, both stored encrypted with DATA_KEY and never returned. One shop belongs to one business: a second
 * business connecting the same shop is refused (it is how a webhook finds its business).
 *
 *   view()                      ShopifyConnection (src/contracts/api/store.js)
 *   connect(input, actor)       checks the token with Shopify, saves, registers the webhooks, and starts the first sync
 *   setMode({ mode, paused })   'source' (Shopify is the source; orders placed here are pushed to it) or 'two_way'
 *   disconnect(actor)           forgets the shop and its links; products stay, orders waiting to be pushed are skipped
 *   active()                    { tenantId, shopDomain, mode, status, client } for sync work, or null
 *
 * Every Admin call goes through `client`, which keeps to Shopify's limit of two calls a second per shop across every
 * process (platform.rateLimit), waiting its turn rather than being refused.
 */
export const WEBHOOK_TOPICS = Object.freeze(['products/create', 'products/update', 'products/delete', 'inventory_levels/update', 'app/uninstalled']);
const CALLS_PER_SECOND = 2;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The shop's Admin API with every call paced to Shopify's limit for that shop. */
export function pacedClient({ providers, platform }, { shopDomain, accessToken }) {
  const raw = providers.shopify.forShop({ shopDomain, accessToken });
  async function turn() {
    for (let i = 0; i < 20; i++) {
      const hit = await platform.rateLimit.hit('shopify_admin', shopDomain, { limit: CALLS_PER_SECOND, windowMs: 1000 });
      if (hit.allowed) return;
      await sleep(Math.max(50, Math.min(1000, hit.retryAfterMs)));
    }
  }
  return new Proxy(raw, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        await turn();
        return value.apply(target, args);
      };
    },
  });
}

export function createConnection(ctx) {
  const { db, platform, providers, config, repos } = ctx;
  const platformDb = db.platform ?? db;

  async function row() {
    const [found] = await db.query('SELECT * FROM shopify_connections WHERE tenant_id = $1', [tenantId()]);
    return found ?? null;
  }

  async function webhookUrl() {
    const tenant = await repos.tenants.get(tenantId());
    const base = tenant ? String(tenantBaseUrl(tenant, config) ?? '').replace(/\/+$/, '') : '';
    return base ? `${base}${STORE_PROVIDER_PATHS.shopify.path}` : null;
  }

  async function view() {
    const c = await row();
    const [counts] = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'failed')::int AS failed FROM shopify_order_pushes WHERE tenant_id = $1`,
      [tenantId()],
    );
    return {
      connected: Boolean(c),
      shopDomain: c?.shop_domain ?? '',
      mode: c?.mode ?? 'source',
      status: c?.status ?? 'none',
      lastReconciledAt: c?.last_reconciled_at ?? null,
      pendingOrders: counts?.pending ?? 0,
      failedOrders: counts?.failed ?? 0,
      webhookUrl: await webhookUrl(),
    };
  }

  /** The connection with a paced client, for sync work; null when there is none, it is paused, or its token can't be read. */
  async function active({ evenPaused = false } = {}) {
    const c = await row();
    if (!c || (!evenPaused && c.status !== 'active') || !c.access_token_enc) return null;
    let accessToken;
    try {
      accessToken = platform.secrets.decrypt(c.access_token_enc);
    } catch {
      return null;
    }
    return { tenantId: c.tenant_id, shopDomain: c.shop_domain, mode: c.mode, status: c.status, lastReconciledAt: c.last_reconciled_at, client: pacedClient(ctx, { shopDomain: c.shop_domain, accessToken }) };
  }

  async function connect({ shopDomain, accessToken, webhookSecret, mode }, actor) {
    const domain = shopDomain.toLowerCase();
    const [taken] = await platformDb.query('SELECT tenant_id FROM shopify_connections WHERE shop_domain = $1', [domain]);
    if (taken && taken.tenant_id !== tenantId()) throw new ApiError('conflict', 'This Shopify store is already connected to another business.');
    const client = pacedClient(ctx, { shopDomain: domain, accessToken });
    try {
      await client.shop();
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (err.kind === 'auth' || err.kind === 'rejected') throw new ApiError('validation_failed', 'Shopify didn’t accept this access token. Copy it again from your Shopify app.', { fields: { accessToken: 'Not accepted by Shopify' } });
      throw new ApiError('conflict', 'Shopify couldn’t be reached. Try again in a minute.');
    }
    const before = await row();
    try {
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO shopify_connections (tenant_id, shop_domain, mode, access_token_enc, webhook_secret_enc, status, connected_at, last_error, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'active', now(), '', now())
           ON CONFLICT (tenant_id) DO UPDATE SET shop_domain = EXCLUDED.shop_domain, mode = EXCLUDED.mode, access_token_enc = EXCLUDED.access_token_enc,
             webhook_secret_enc = EXCLUDED.webhook_secret_enc, status = 'active', connected_at = now(), last_error = '', updated_at = now()`,
          [tenantId(), domain, mode, platform.secrets.encrypt(accessToken), platform.secrets.encrypt(webhookSecret)],
        );
        // Another shop's ids mean nothing here.
        if (before && before.shop_domain !== domain) await t.query('DELETE FROM shopify_links WHERE tenant_id = $1', [tenantId()]);
        await writeAudit(t, { actor, action: 'shopify.connected', target: `shopify:${domain}`, details: { mode, replaced: Boolean(before) } });
      });
    } catch (err) {
      if (err?.code === '23505') throw new ApiError('conflict', 'This Shopify store is already connected to another business.');
      throw err;
    }
    const address = await webhookUrl();
    if (address) {
      try {
        await client.registerWebhooks({ address, topics: [...WEBHOOK_TOPICS] });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        await db.query(`UPDATE shopify_connections SET last_error = $2 WHERE tenant_id = $1`, [tenantId(), `webhooks:${err.kind}:${err.status}`.slice(0, 200)]);
        log.warn('shopify.webhooks_not_registered', { kind: err.kind, status: err.status });
      }
    }
    log.info('shopify.connected', { tenantId: tenantId(), mode });
    return view();
  }

  async function setMode({ mode, paused }, actor) {
    const c = await row();
    if (!c) throw new ApiError('conflict', 'Connect your Shopify store first.');
    const changes = {};
    if (mode && mode !== c.mode) changes.mode = mode;
    if (paused === true && c.status !== 'paused') changes.status = 'paused';
    if (paused === false && c.status === 'paused') changes.status = 'active';
    if (Object.keys(changes).length) {
      await db.tx(async (t) => {
        const names = Object.keys(changes);
        await t.query(`UPDATE shopify_connections SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')}, updated_at = now() WHERE tenant_id = $1`, [tenantId(), ...names.map((n) => changes[n])]);
        await writeAudit(t, { actor, action: 'shopify.mode_changed', target: `shopify:${c.shop_domain}`, details: changes });
      });
    }
    return view();
  }

  async function disconnect(actor) {
    const c = await row();
    if (!c) return;
    await db.tx(async (t) => {
      await t.query('DELETE FROM shopify_connections WHERE tenant_id = $1', [tenantId()]);
      await t.query('DELETE FROM shopify_links WHERE tenant_id = $1', [tenantId()]);
      await t.query(`UPDATE shopify_order_pushes SET status = 'skipped', last_error = 'disconnected' WHERE tenant_id = $1 AND status IN ('pending', 'failed')`, [tenantId()]);
      await writeAudit(t, { actor, action: 'shopify.disconnected', target: `shopify:${c.shop_domain}` });
    });
  }

  async function recordError(message) {
    await db.query('UPDATE shopify_connections SET last_error = $2, updated_at = now() WHERE tenant_id = $1', [tenantId(), String(message).slice(0, 200)]);
  }

  /** The token no longer works (or the app was removed): the owner must connect again. */
  async function needsReconnect(why) {
    await db.query(`UPDATE shopify_connections SET status = 'reconnect', last_error = $2, updated_at = now() WHERE tenant_id = $1 AND status <> 'reconnect'`, [tenantId(), String(why).slice(0, 200)]);
    await repos.alerts.raise({ kind: 'shopify.reconnect', severity: 'critical', message: 'Your Shopify store needs to be connected again. Until then products, stock and orders are not kept in step.', target: 'shopify', dedupeKey: `shopify-reconnect:${new Date().toISOString().slice(0, 10)}` }).catch(() => {});
  }

  return { row, view, active, connect, setMode, disconnect, recordError, needsReconnect, webhookUrl };
}
