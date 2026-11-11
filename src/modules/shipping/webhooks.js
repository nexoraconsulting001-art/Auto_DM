import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { opsAlert } from './alerts.js';
import { cleanText, isAwb, providerId } from './util.js';

/**
 * The courier's tracking webhook (PRD 9.7, 9.10): POST /webhooks/courier, one address for Bhava's master account. The token
 * in x-api-key is checked before the body is read (a wrong or missing one is 401 and nothing is stored: S-35), the event is
 * cut down to the AWB, statuses, times and hub names, stored in provider_webhook_events, and only then answered 200. The work
 * is done afterwards from that table: in this process straight away (kick), and by the worker's sweep for anything left.
 *
 * Shiprocket sends no event id, so the id is the AWB, the status and its time joined (9.10): the same event again is the same
 * row. Each event is routed to its business by its AWB (an AWB names one parcel anywhere, S-79). The pickup location and the
 * courier's own order id it names must be that parcel's: an event naming one business's AWB and another's pickup is stored,
 * ignored, flagged as a security event and never changes anything. An AWB nobody has is ignored.
 */
const BATCH = 50;
const MAX_ATTEMPTS = 8;
const MAX_SCANS = 30;

/** What is kept of a tracking event: no name, phone number or address ever, only the parcel's ids, statuses, times and hubs. */
export function cleanCourierEvent(body) {
  const scans = Array.isArray(body?.scans) ? body.scans.slice(0, MAX_SCANS) : [];
  const awb = typeof body?.awb === 'string' || typeof body?.awb === 'number' ? String(body.awb).trim() : '';
  return {
    awb: isAwb(awb) ? awb : '',
    status: cleanText(body?.current_status ?? body?.shipment_status, 80),
    at: cleanText(body?.current_timestamp, 40),
    srOrderId: providerId(body?.sr_order_id),
    pickupLocation: cleanText(body?.pickup_location, 36),
    isReturn: Number(body?.is_return) === 1,
    scans: scans.filter((s) => s && typeof s === 'object').map((s) => ({
      status: cleanText(s['sr-status-label'] ?? s.activity ?? s.status, 80),
      location: cleanText(s.location, 120),
      at: cleanText(s.date, 40),
    })).filter((s) => s.status && s.at),
  };
}

/** The scans an event carries, its own current status among them. */
export const scansOf = (ev) => [...(ev.scans ?? []).map((s) => ({ providerStatus: s.status, location: s.location, at: s.at })), ...(ev.status && ev.at ? [{ providerStatus: ev.status, location: ev.scans?.[0]?.location ?? '', at: ev.at }] : [])];

export function createWebhooks(ctx, { tracking }) {
  const { db, config, providers } = ctx;
  const platformDb = db.platform ?? db;
  const metrics = ctx.platform?.metrics;

  const refuse = (res) => {
    log.warn('shipping.webhook_refused');
    metrics?.inc?.('courier_webhooks_refused_total', {});
    return res.status(401).end();
  };

  async function receive(req, res) {
    const token = config.shiprocketWebhookToken;
    if (!token || !providers.shiprocket.verifyWebhook(req.get(SIGNATURE_HEADERS.courier) ?? '', token)) return refuse(res);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'That event could not be read.' });
    const ev = cleanCourierEvent(body);
    // The courier tests the address with an empty event when it is set up: it gets its 200, and there is nothing to keep.
    if (!ev.awb || !ev.status || !ev.at) return res.status(200).json({ ok: true });
    const [row] = await platformDb.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('shiprocket', 'managed', $1, $2, $3::jsonb)
       ON CONFLICT (provider, scope, event_id) DO NOTHING RETURNING id`,
      [`${ev.awb}|${ev.status}|${ev.at}`.slice(0, 200), ev.status.slice(0, 100), JSON.stringify(ev)],
    );
    res.status(200).json({ ok: true });
    metrics?.inc?.('courier_webhooks_total', { result: row ? 'stored' : 'duplicate' });
    if (row) kick();
  }

  async function finish(row, { status, outcome, security = false, tenantId = null }) {
    await platformDb.query(
      `UPDATE provider_webhook_events SET status = $2, outcome = $3, security = $4, tenant_id = COALESCE($5, tenant_id), attempts = attempts + 1, last_error = '', processed_at = now()
       WHERE id = $1 AND status = 'received'`,
      [row.id, status, String(outcome).slice(0, 60), security, tenantId],
    );
    return { id: Number(row.id), status, outcome, security };
  }

  async function failed(row, err) {
    const why = `${err?.name ?? 'Error'}${err?.code ? `:${err.code}` : ''}`.slice(0, 300);
    const [after] = await platformDb.query(
      `UPDATE provider_webhook_events SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END
       WHERE id = $1 AND status = 'received' RETURNING status, tenant_id`,
      [row.id, why, MAX_ATTEMPTS],
    );
    reportError(err, { msg: 'shipping.webhook_failed', event: Number(row.id) });
    if (after?.status === 'failed') {
      await opsAlert(platformDb, { tenantId: after.tenant_id, kind: 'shipping.webhook_failed', message: `A tracking event could not be worked through after ${MAX_ATTEMPTS} tries (event ${row.id}).`, target: `webhook:${row.id}`, dedupeKey: `courier-webhook-failed:${row.id}` });
    }
    return { id: Number(row.id), status: after?.status ?? 'received', outcome: 'error' };
  }

  /** Which business and parcel an event is about, or why it is ignored. */
  async function route(row) {
    const ev = row.payload ?? {};
    if (!isAwb(ev.awb)) return { ignore: 'not_handled' };
    const [s] = await platformDb.query('SELECT tenant_id, id, mode, kind, pickup_location, provider_order_id FROM shipments WHERE awb = $1', [ev.awb]);
    if (!s) {
      const [owner] = ev.pickupLocation ? await platformDb.query(`SELECT tenant_id FROM shipping_settings WHERE pickup_location = $1 AND mode = 'managed'`, [ev.pickupLocation]) : [];
      return { ignore: 'unknown_shipment', tenantId: owner?.tenant_id ?? null };
    }
    // The event names this parcel by its AWB; everything else it names must be the same parcel's (S-79).
    const otherPickup = ev.pickupLocation && ev.pickupLocation !== s.pickup_location;
    const otherOrder = ev.srOrderId && s.provider_order_id && ev.srOrderId !== s.provider_order_id;
    if (otherPickup || otherOrder) return { ignore: 'tenant_mismatch', security: true, shipment: s, why: otherPickup ? 'pickup_location' : 'courier_order' };
    if (s.mode !== 'managed') return { ignore: 'other_account', tenantId: s.tenant_id };
    return { tenantId: s.tenant_id, run: async () => (await tracking.apply(s.id, scansOf(ev))).result };
  }

  async function securityEvent(row, routed) {
    log.warn('shipping.webhook_security', { event: Number(row.id), shipment: Number(routed.shipment.id), awbTenant: routed.shipment.tenant_id, why: routed.why });
    metrics?.inc?.('courier_webhook_security_total', {});
    await withTenant(routed.shipment.tenant_id, () => writeAudit(db, {
      actor: 'webhook:courier', action: 'shipping.webhook_mismatch', target: `shipment:${routed.shipment.id}`, details: { event: Number(row.id), why: routed.why },
    })).catch((err) => reportError(err, { msg: 'shipping.audit_failed' }));
    await opsAlert(platformDb, {
      tenantId: routed.shipment.tenant_id, kind: 'shipping.webhook_mismatch',
      message: `A tracking event named one parcel’s AWB with another parcel’s ${routed.why === 'pickup_location' ? 'pickup location' : 'courier order'}. It was stored and ignored (event ${row.id}); nothing changed.`,
      target: `webhook:${row.id}`, dedupeKey: `courier-webhook-mismatch:${row.id}`,
    });
  }

  async function processOne(row) {
    try {
      const routed = await route(row);
      if (routed.ignore) {
        if (routed.security) await securityEvent(row, routed);
        return await finish(row, { status: 'ignored', outcome: routed.ignore, security: Boolean(routed.security), tenantId: routed.security ? null : routed.tenantId ?? null });
      }
      const outcome = await withTenant(routed.tenantId, routed.run);
      return await finish(row, { status: outcome === 'processed' || outcome === 'recorded' ? 'processed' : 'ignored', outcome: outcome === 'duplicate' ? 'stale' : outcome, tenantId: routed.tenantId });
    } catch (err) {
      return failed(row, err);
    }
  }

  /** One pass over what is waiting, oldest first. A failure waits longer before each try (5 s, 20 s, 80 s, ... up to an hour). */
  async function dispatch({ limit = BATCH } = {}) {
    const rows = await platformDb.query(
      `SELECT * FROM provider_webhook_events
       WHERE provider = 'shiprocket' AND status = 'received'
         AND (attempts = 0 OR received_at < now() - make_interval(secs => least(3600, 5 * power(4, attempts - 1))))
       ORDER BY id LIMIT $1`,
      [limit],
    );
    const results = [];
    for (const row of rows) results.push(await processOne(row));
    return results;
  }

  async function drain() {
    const all = [];
    for (let pass = 0; pass < 100; pass++) {
      const results = await dispatch();
      all.push(...results);
      if (results.length < BATCH) break;
    }
    return all;
  }

  let running = null;
  let again = false;
  /** Works through new events soon, in this process. One run at a time. */
  function kick() {
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await drain();
        } while (again);
      } catch (err) {
        reportError(err, { msg: 'shipping.webhooks_drain_failed' });
      } finally {
        running = null;
      }
    })();
  }

  /** For tests and the worker: waits for a run in progress, then drains what is left. */
  async function settle() {
    while (running) await running;
    return drain();
  }

  return { receive, dispatch, drain, kick, settle, route };
}
