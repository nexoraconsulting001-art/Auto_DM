import crypto from 'node:crypto';
import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { cleanLevel, cleanProduct } from './products.js';

/**
 * POST /webhooks/shopify (PRD 9.11, S-38). Each business's shop signs with its own app's secret, so the shop named in
 * X-Shopify-Shop-Domain picks the secret, and the HMAC (base64, X-Shopify-Hmac-Sha256) is checked on the exact bytes before
 * anything is read. A shop nobody connected, a missing or wrong HMAC, or another shop's secret is 401 and nothing is stored.
 *
 * A verified delivery is cut down to ids, prices, stock and times (no customer data), stored in provider_webhook_events under
 * its business ('tenant:<id>') with Shopify's webhook id as the event id, so a repeat is the same row (deduped by webhook
 * id), then answered 200 and worked through from that table: here straight away, and by the worker for anything left.
 * Every change is made inside the business the shop belongs to, through that business's own links: a webhook can only
 * ever touch its own business's products.
 */
const WEBHOOK_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const TOPIC = /^[a-z_]{1,40}\/[a-z_]{1,40}$/;
const BATCH = 50;
const MAX_ATTEMPTS = 8;
const sha256 = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

export function createShopifyWebhook(ctx, { products, connection }) {
  const { db, platform, providers } = ctx;
  const platformDb = db.platform ?? db;

  /** What is kept of a delivery, by topic. */
  function clean(topic, body) {
    if (topic === 'products/create' || topic === 'products/update') return { product: cleanProduct(body) };
    if (topic === 'products/delete') return { productId: /^[0-9]{1,20}$/.test(String(body?.id ?? '')) ? String(body.id) : null };
    if (topic === 'inventory_levels/update') return { level: cleanLevel(body) };
    return {};
  }

  async function receive(req, res) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    const domain = String(req.get(SIGNATURE_HEADERS.shopifyShop) ?? '').trim().toLowerCase();
    const [conn] = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/.test(domain)
      ? await platformDb.query('SELECT tenant_id, webhook_secret_enc FROM shopify_connections WHERE shop_domain = $1', [domain])
      : [];
    let secret = '';
    try {
      secret = conn?.webhook_secret_enc ? platform.secrets.decrypt(conn.webhook_secret_enc) : '';
    } catch {
      secret = '';
    }
    if (!raw || !secret || !providers.shopify.verifyWebhook(raw, req.get(SIGNATURE_HEADERS.shopify) ?? '', secret)) {
      log.warn('shopify.webhook_refused', { known: Boolean(conn) });
      return res.status(401).end();
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'That event could not be read.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'That event could not be read.' });
    const topic = String(req.get(SIGNATURE_HEADERS.shopifyTopic) ?? '').toLowerCase();
    const header = String(req.get(SIGNATURE_HEADERS.shopifyWebhookId) ?? '');
    const eventId = WEBHOOK_ID.test(header) ? header : `sha256:${sha256(raw)}`;
    const [row] = await platformDb.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload, tenant_id) VALUES ('shopify', $1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (provider, scope, event_id) DO NOTHING RETURNING id`,
      [`tenant:${conn.tenant_id}`, eventId, TOPIC.test(topic) ? topic : '', JSON.stringify(clean(topic, body)), conn.tenant_id],
    );
    res.status(200).json({ ok: true });
    if (row) kick();
  }

  /** One stored delivery, inside its business. Returns the outcome kept on the row. */
  async function work(row) {
    const payload = row.payload ?? {};
    const conn = await connection.active({ evenPaused: true });
    if (!conn) return 'not_connected';
    if (conn.status === 'paused') return 'paused';
    switch (row.event_type) {
      case 'products/create':
      case 'products/update':
        return payload.product ? products.applyProduct(payload.product, conn) : 'unreadable';
      case 'products/delete':
        return payload.productId ? products.removeProduct(payload.productId) : 'unreadable';
      case 'inventory_levels/update':
        return payload.level ? products.applyLevel(payload.level) : 'unreadable';
      case 'app/uninstalled':
        await connection.needsReconnect('app_uninstalled');
        return 'processed';
      default:
        return 'not_handled';
    }
  }

  async function processOne(row) {
    const tenant = Number(String(row.scope).slice('tenant:'.length));
    try {
      const outcome = await withTenant(tenant, () => work(row));
      await platformDb.query(
        `UPDATE provider_webhook_events SET status = $2, outcome = $3, attempts = attempts + 1, last_error = '', processed_at = now() WHERE id = $1 AND status = 'received'`,
        [row.id, ['processed', 'created'].includes(outcome) ? 'processed' : 'ignored', String(outcome).slice(0, 60)],
      );
    } catch (err) {
      reportError(err, { msg: 'shopify.webhook_failed', event: Number(row.id) });
      await platformDb.query(
        `UPDATE provider_webhook_events SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END WHERE id = $1 AND status = 'received'`,
        [row.id, String(err?.code ?? err?.kind ?? err?.name ?? 'error').slice(0, 300), MAX_ATTEMPTS],
      );
    }
  }

  async function drain() {
    let total = 0;
    for (let pass = 0; pass < 100; pass++) {
      const rows = await platformDb.query(
        `SELECT * FROM provider_webhook_events WHERE provider = 'shopify' AND status = 'received'
           AND (attempts = 0 OR received_at < now() - make_interval(secs => least(3600, 5 * power(4, attempts - 1))))
         ORDER BY id LIMIT $1`,
        [BATCH],
      );
      for (const row of rows) await processOne(row);
      total += rows.length;
      if (rows.length < BATCH) break;
    }
    return total;
  }

  let running = null;
  let again = false;
  function kick() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again);
      } catch (err) {
        reportError(err, { msg: 'shopify.webhook_drain_failed' });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return { receive, drain, kick, async settle() { while (running) await running; return drain(); } };
}
