import crypto from 'node:crypto';
import { SIGNATURE_HEADERS } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';

/**
 * WhatsApp's webhooks (PRD 9.16): delivery reports for what was sent, and shoppers' replies, of which only STOP matters.
 *
 *   GET  /webhooks/whatsapp    the subscription handshake: hub.verify_token must be WHATSAPP_VERIFY_TOKEN; the challenge
 *                              is echoed as plain text, never as a page
 *   POST /webhooks/whatsapp    verified on the exact bytes (X-Hub-Signature-256 with WHATSAPP_APP_SECRET) before anything is
 *                              read: a bad or missing signature is 401 and nothing is stored. Then it is cut down, stored in
 *                              provider_webhook_events, answered 200, and worked through from that table.
 *
 * What is kept of a delivery: message ids, statuses, times, error codes, pricing categories and the business's phone
 * number id. A reply's text is never kept: only whether it was STOP, and then the shopper's number encrypted with DATA_KEY,
 * because withdrawing consent needs it. One delivery (WhatsApp sends no event id) is one row, by the hash of its bytes.
 *
 * A delivery report moves an order alert from sent to delivered, or to failed, and never back ("delivered" arriving before
 * "sent" is fine). A STOP withdraws the shopper's yes to WhatsApp marketing at that business and stops its cart reminders.
 */
const STOP_WORDS = new Set(['stop', 'unsubscribe', 'stop all', 'opt out', 'optout', 'cancel', 'बंद', 'रोकें']);
const BATCH = 50;
const MAX_ATTEMPTS = 8;
const MESSAGE_ID = /^[A-Za-z0-9_.:=+/-]{1,120}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
const CATEGORIES = new Set(['utility', 'authentication', 'marketing', 'service', 'authentication_international', 'referral_conversion']);

const sha256 = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const word = (value, max, pattern) => {
  const s = String(value ?? '');
  return pattern.test(s) ? s.slice(0, max) : '';
};

export const isStop = (text) => STOP_WORDS.has(String(text ?? '').normalize('NFKC').trim().toLowerCase().replace(/[.!]+$/, ''));

export function createWhatsappWebhook(ctx) {
  const { db, config, providers, platform } = ctx;
  const platformDb = db.platform ?? db;

  /** What is kept of a delivery. Never a reply's text; a STOP's number only encrypted. */
  function clean(body) {
    const statuses = providers.whatsapp.parseStatuses(body).slice(0, 200).map((s) => ({
      messageId: word(s.messageId, 120, MESSAGE_ID),
      status: STATUSES.has(s.status) ? s.status : '',
      at: Number.isFinite(s.at?.getTime?.()) ? s.at.toISOString() : null,
      errorCode: word(s.errorCode, 20, /^[0-9]{1,20}$/),
      phoneNumberId: word(s.phoneNumberId, 40, ACCOUNT_ID),
      category: CATEGORIES.has(s.costCategory) ? s.costCategory : '',
    })).filter((s) => s.messageId && s.status && s.phoneNumberId);
    const stops = providers.whatsapp.parseInbound(body).slice(0, 200)
      .filter((m) => isStop(m.text) && /^[1-9][0-9]{7,14}$/.test(m.from) && ACCOUNT_ID.test(m.phoneNumberId))
      .map((m) => ({ phoneNumberId: m.phoneNumberId, from: platform.secrets.encrypt(`+${m.from}`) }));
    return { statuses, stops };
  }

  function verify(req, res) {
    const token = String(req.query['hub.verify_token'] ?? '');
    if (req.query['hub.mode'] === 'subscribe' && config.whatsappVerifyToken && token === config.whatsappVerifyToken) {
      return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100));
    }
    return res.sendStatus(403);
  }

  async function receive(req, res) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
    if (!raw || !config.whatsappAppSecret || !providers.whatsapp.verifyWebhook(raw, req.get(SIGNATURE_HEADERS.whatsapp) ?? '', config.whatsappAppSecret)) {
      log.warn('whatsapp.webhook_refused');
      return res.status(401).end();
    }
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'That event could not be read.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'That event could not be read.' });
    const payload = clean(body);
    if (!payload.statuses.length && !payload.stops.length) return res.status(200).json({ ok: true });
    const [row] = await platformDb.query(
      `INSERT INTO provider_webhook_events (provider, scope, event_id, event_type, payload) VALUES ('whatsapp', 'managed', $1, $2, $3::jsonb)
       ON CONFLICT (provider, scope, event_id) DO NOTHING RETURNING id`,
      [`sha256:${sha256(raw)}`, payload.stops.length ? 'messages' : 'statuses', JSON.stringify(payload)],
    );
    res.status(200).json({ ok: true });
    if (row) kick();
  }

  const tenantOf = async (phoneNumberId) => (await platformDb.query('SELECT tenant_id FROM whatsapp_accounts WHERE phone_number_id = $1', [phoneNumberId]))[0]?.tenant_id ?? null;

  /** One delivery report, inside its business. */
  async function applyStatus(s) {
    const cost = config.whatsappCostPaise?.[s.category];
    const costPaise = Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
    if (s.status === 'delivered' || s.status === 'read') {
      await db.query(
        `UPDATE order_alerts SET status = 'delivered', cost_paise = COALESCE(cost_paise, $3)
         WHERE tenant_id = $1 AND provider_message_id = $2 AND status IN ('sent', 'queued')`,
        [tenantId(), s.messageId, costPaise],
      );
    } else if (s.status === 'sent') {
      await db.query('UPDATE order_alerts SET cost_paise = COALESCE(cost_paise, $3) WHERE tenant_id = $1 AND provider_message_id = $2', [tenantId(), s.messageId, costPaise]);
    } else if (s.status === 'failed') {
      await db.query(
        `UPDATE order_alerts SET status = 'failed', error_code = $3 WHERE tenant_id = $1 AND provider_message_id = $2 AND status = 'sent'`,
        [tenantId(), s.messageId, `whatsapp:${s.errorCode}`.slice(0, 80)],
      );
      await db.query(`UPDATE cart_reminders SET status = 'failed' WHERE tenant_id = $1 AND provider_message_id = $2 AND status = 'sent'`, [tenantId(), s.messageId]);
    }
  }

  /** A STOP reply: the shopper's yes to WhatsApp marketing here is taken back, and their scheduled cart reminders stop. */
  async function applyStop(stop) {
    let phone;
    try {
      phone = platform.secrets.decrypt(stop.from);
    } catch {
      return;
    }
    await platform.consent.revoke({ subject: { phone }, purpose: 'marketing', channel: 'whatsapp', source: 'reply' });
    await db.query(
      `UPDATE cart_reminders r SET status = 'cancelled', stop_reason = 'opted_out'
       FROM shoppers s WHERE r.tenant_id = $1 AND s.tenant_id = r.tenant_id AND s.id = r.shopper_id AND s.phone = $2 AND r.status = 'scheduled' AND r.channel = 'whatsapp'`,
      [tenantId(), phone],
    );
    log.info('whatsapp.stop', { tenantId: tenantId() });
  }

  async function processOne(row) {
    try {
      const payload = row.payload ?? {};
      const groups = new Map();
      for (const s of payload.statuses ?? []) groups.set(s.phoneNumberId, [...(groups.get(s.phoneNumberId) ?? []), { kind: 'status', item: s }]);
      for (const s of payload.stops ?? []) groups.set(s.phoneNumberId, [...(groups.get(s.phoneNumberId) ?? []), { kind: 'stop', item: s }]);
      let known = 0;
      let firstTenant = null;
      let stopFailed = null;
      for (const [phoneNumberId, items] of groups) {
        const tenant = await tenantOf(phoneNumberId);
        if (!tenant) continue;
        known++;
        firstTenant ??= tenant;
        await withTenant(tenant, async () => {
          // One bad entry never takes the others down with it.
          for (const { kind, item } of items) {
            try {
              if (kind === 'status') await applyStatus(item);
              else await applyStop(item);
            } catch (err) {
              reportError(err, { msg: 'whatsapp.webhook_item_failed', event: Number(row.id), kind });
              if (kind === 'stop') stopFailed = err;
            }
          }
        });
      }
      // A STOP that could not be recorded is never dropped: the whole delivery is tried again (the rest repeat harmlessly).
      if (stopFailed) throw stopFailed;
      // Stopping marks the reply as handled; its encrypted number is dropped from the stored payload.
      await platformDb.query(
        `UPDATE provider_webhook_events SET status = $2, outcome = $3, tenant_id = $4, attempts = attempts + 1, processed_at = now(), last_error = '',
           payload = jsonb_set(payload, '{stops}', '[]'::jsonb)
         WHERE id = $1 AND status = 'received'`,
        [row.id, known ? 'processed' : 'ignored', known ? '' : 'unknown_account', firstTenant],
      );
    } catch (err) {
      reportError(err, { msg: 'whatsapp.webhook_failed', event: Number(row.id) });
      await platformDb.query(
        `UPDATE provider_webhook_events SET attempts = attempts + 1, last_error = $2, status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE status END WHERE id = $1 AND status = 'received'`,
        [row.id, String(err?.code ?? err?.name ?? 'error').slice(0, 300), MAX_ATTEMPTS],
      );
    }
  }

  async function drain() {
    let total = 0;
    for (let pass = 0; pass < 100; pass++) {
      const rows = await platformDb.query(
        `SELECT * FROM provider_webhook_events WHERE provider = 'whatsapp' AND status = 'received'
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
        reportError(err, { msg: 'whatsapp.webhook_drain_failed' });
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return { verify, receive, drain, kick, async settle() { while (running) await running; return drain(); } };
}
