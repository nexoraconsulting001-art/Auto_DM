import crypto from 'node:crypto';
import { ANALYTICS_LIMITS as L, TAG_EVENTS, TAG_HOSTS, TAG_PROVIDERS } from '../../contracts/analytics.js';
import { ApiError } from '../../contracts/api/index.js';
import { hashedUserData } from '../../adapters/meta/conversions.js';
import { reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { writeAudit } from '../audit/index.js';
import { clockOf, localParts, timeZoneOf } from './time.js';

const SENDING_LEASE_MS = 2 * 60_000;
const MAX_ATTEMPTS = 8;
const DRAIN_LIMIT = 200;
const backoffMs = (attempts) => Math.min(6 * 3_600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
const OFF = Object.freeze({ meta: { on: false, pixelId: '' }, ga4: { on: false, measurementId: '' }, commerce: false, any: false });

/** The browser event each tag event comes from. Purchase comes from the order itself, never from a page. */
const TAG_FOR_BEACON = { page_view: 'page_view', product_view: 'view_content', add_to_cart: 'add_to_cart', checkout_started: 'initiate_checkout' };

const CONTENT_POLICY = (hosts) => [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${hosts.length ? ` ${hosts.join(' ')}` : ''}`,
  `connect-src 'self'${hosts.length ? ` ${hosts.join(' ')}` : ''}`,
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/** A buyer page's policy. It names Meta's or Google's hosts only for a tag that is on for this business (7.14). */
export function contentSecurityPolicy(state = OFF) {
  return CONTENT_POLICY([...(state.meta.on ? TAG_HOSTS.meta : []), ...(state.ga4.on ? TAG_HOSTS.ga4 : [])]);
}

const toView = (row, { available, consentReady }) => ({
  available,
  consentReady,
  meta: { enabled: Boolean(row?.meta_enabled), pixelId: row?.meta_pixel_id ?? '', capiTokenSet: Boolean(row?.meta_capi_token_enc) },
  ga4: { enabled: Boolean(row?.ga4_enabled), measurementId: row?.ga4_measurement_id ?? '', apiSecretSet: Boolean(row?.ga4_api_secret_enc) },
});

/** Per business, off until the owner turns one on. Tokens are encrypted here and decrypted only just before a send, and no read returns one. */
export function tagSettingsRepo(db, { secrets }) {
  const select = async (runner = db) => (await runner.query('SELECT * FROM tag_settings WHERE tenant_id = $1', [tenantId()]))[0] ?? null;

  function encrypted(value) {
    if (!secrets.configured) throw new ValidationError('Tokens can’t be stored yet. Please contact support.');
    return secrets.encrypt(value);
  }

  return {
    get: () => select(),

    /** Applies a partial change. Turning a tag off also drops what it had waiting, so nothing more goes out for it (N-72). */
    async save(patch, { actor, userId }) {
      return db.tx(async (t) => {
        const row = await select(t);
        const next = {
          meta_enabled: patch.meta?.enabled ?? row?.meta_enabled ?? false,
          meta_pixel_id: patch.meta?.pixelId ?? row?.meta_pixel_id ?? '',
          meta_capi_token_enc: patch.meta?.capiToken ? encrypted(patch.meta.capiToken) : (row?.meta_capi_token_enc ?? ''),
          ga4_enabled: patch.ga4?.enabled ?? row?.ga4_enabled ?? false,
          ga4_measurement_id: patch.ga4?.measurementId ?? row?.ga4_measurement_id ?? '',
          ga4_api_secret_enc: patch.ga4?.apiSecret ? encrypted(patch.ga4.apiSecret) : (row?.ga4_api_secret_enc ?? ''),
        };
        if (next.meta_enabled && !next.meta_pixel_id) throw new ValidationError('Enter the Pixel ID first');
        if (next.ga4_enabled && !next.ga4_measurement_id) throw new ValidationError('Enter the measurement ID first');
        const [saved] = await t.query(
          `INSERT INTO tag_settings (tenant_id, meta_enabled, meta_pixel_id, meta_capi_token_enc, ga4_enabled, ga4_measurement_id, ga4_api_secret_enc, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (tenant_id) DO UPDATE SET meta_enabled = EXCLUDED.meta_enabled, meta_pixel_id = EXCLUDED.meta_pixel_id, meta_capi_token_enc = EXCLUDED.meta_capi_token_enc,
             ga4_enabled = EXCLUDED.ga4_enabled, ga4_measurement_id = EXCLUDED.ga4_measurement_id, ga4_api_secret_enc = EXCLUDED.ga4_api_secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now()
           RETURNING *`,
          [tenantId(), next.meta_enabled, next.meta_pixel_id, next.meta_capi_token_enc, next.ga4_enabled, next.ga4_measurement_id, next.ga4_api_secret_enc, userId ?? null],
        );
        for (const [provider, on] of [['meta', next.meta_enabled], ['ga4', next.ga4_enabled]]) {
          if (!on) await t.query(`UPDATE tag_outbox SET status = 'failed', last_error = 'tag_off', lease_until = NULL WHERE tenant_id = $1 AND provider = $2 AND status = 'queued'`, [tenantId(), provider]);
        }
        await writeAudit(t, { actor, action: 'tags.update', target: 'tags', details: {
          meta: { enabled: next.meta_enabled, pixelChanged: patch.meta?.pixelId !== undefined, tokenChanged: Boolean(patch.meta?.capiToken) },
          ga4: { enabled: next.ga4_enabled, measurementChanged: patch.ga4?.measurementId !== undefined, secretChanged: Boolean(patch.ga4?.apiSecret) },
        } });
        return saved;
      });
    },
  };
}

/** The loader for a tag that is on, with the seller's own id. Only ever called for a shopper who said yes. The first page event is sent by the traffic script, with the shared event id. */
export function tagSnippet(state) {
  const parts = [];
  if (state.meta.on) {
    parts.push(`<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','${TAG_HOSTS.meta[0]}/en_US/fbevents.js');fbq('init','${state.meta.pixelId}');</script>`);
  }
  if (state.ga4.on) {
    parts.push(`<script async src="${TAG_HOSTS.ga4[0]}/gtag/js?id=${state.ga4.measurementId}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;gtag('js',new Date());gtag('config','${state.ga4.measurementId}',{send_page_view:false});</script>`);
  }
  return parts.join('');
}

/** Pixels and server events for the current business. Nothing here runs for a shopper who hasn't accepted "Analytics and ads" (7.14). */
export function createTags(ctx) {
  const { db, repos, platform, config, meta, google } = ctx;
  const now = clockOf(config);
  const settings = repos.tagSettings;

  /** The seller's token, decrypted only here, just before a send. */
  function credentials(row, provider) {
    if (provider === 'meta') return row.meta_capi_token_enc ? { pixelId: row.meta_pixel_id, token: platform.secrets.decrypt(row.meta_capi_token_enc) } : null;
    return row.ga4_api_secret_enc ? { measurementId: row.ga4_measurement_id, apiSecret: platform.secrets.decrypt(row.ga4_api_secret_enc) } : null;
  }

  /** What the current business has on. Bhava has no tag of its own: with nothing configured there is nothing here. */
  async function pageState() {
    const row = await settings.get();
    if (!row?.meta_enabled && !row?.ga4_enabled) return OFF;
    if (!await repos.entitlements.can('tags.pixels')) return OFF;
    return {
      meta: { on: Boolean(row.meta_enabled && row.meta_pixel_id), pixelId: row.meta_pixel_id },
      ga4: { on: Boolean(row.ga4_enabled && row.ga4_measurement_id), measurementId: row.ga4_measurement_id },
      commerce: await repos.entitlements.can('tags.commerce'),
      any: true,
    };
  }

  async function granted(visitorId, shopperId) {
    return (await platform.consent.analyticsAndAds({ visitorId, shopperId })).granted === true;
  }

  function clientId(visitorId, sessionId) {
    return crypto.createHash('sha256').update(`${tenantId()}:${visitorId ?? sessionId}`).digest('hex').slice(0, 32);
  }

  /** Puts one event on the outbox for each tag that is on and can send, with the id the browser used, so duplicates can be removed. */
  async function enqueue(tagEvent, { eventId, at, visitorId, sessionId, user, url = '', valuePaise = 0, orderRef = '' }) {
    const row = await settings.get();
    const state = await pageState();
    if (!state.meta.on && !state.ga4.on) return 0;
    const names = TAG_EVENTS[tagEvent];
    if (names.minTier >= 3 && !state.commerce) return 0;
    const shopperId = user?.role === 'customer' ? user.id : undefined;
    if (!await granted(visitorId ?? undefined, shopperId)) return 0;

    const custom = valuePaise > 0 || orderRef ? { currency: 'INR', value: valuePaise / 100 } : {};
    const eventTime = Math.floor(+at / 1000);
    const consent = { visitorId: visitorId ?? null, shopperId: shopperId ?? null };
    const rows = [];
    if (state.meta.on && row.meta_capi_token_enc) {
      const userData = shopperId ? hashedUserData({ email: user.email, phone: user.phone }) : {};
      rows.push(['meta', names.meta, { event: { event_name: names.meta, event_time: eventTime, event_id: eventId, action_source: 'website', ...(url ? { event_source_url: url } : {}), ...(Object.keys(userData).length ? { user_data: userData } : {}), ...(Object.keys(custom).length ? { custom_data: custom } : {}) }, consent }]);
    }
    if (state.ga4.on && row.ga4_api_secret_enc) {
      rows.push(['ga4', names.ga4, { clientId: clientId(visitorId, sessionId), event: { name: names.ga4, params: { event_id: eventId, ...custom, ...(orderRef ? { transaction_id: orderRef } : {}) } }, consent }]);
    }
    for (const [provider, name, payload] of rows) {
      await db.query(
        `INSERT INTO tag_outbox (tenant_id, provider, event_id, event_name, payload, next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $6::timestamptz)
         ON CONFLICT (tenant_id, provider, event_name, event_id) DO NOTHING`,
        [tenantId(), provider, eventId, name, JSON.stringify(payload), at],
      );
    }
    return rows.length;
  }

  async function onBrowserEvent(beacon, { at, visitorId, sessionId, user, host, path }) {
    if (!beacon.eventId || !Object.hasOwn(TAG_FOR_BEACON, beacon.name)) return;
    const url = host && !/^\/order(\/|$)/.test(path) ? `https://${host}${path}` : '';
    await enqueue(TAG_FOR_BEACON[beacon.name], { eventId: beacon.eventId, at, visitorId, sessionId, user, url, valuePaise: beacon.valuePaise });
  }

  /** One purchase, once an order is paid. Its value is read from the order. The browser never sends this event, so there is nothing to double count. */
  async function onPurchase({ orderId, orderNumber, totalPaise, at, visitorId, sessionId, user }) {
    await enqueue('purchase', { eventId: `order-${orderId}`, at, visitorId, sessionId, user, valuePaise: totalPaise, orderRef: orderNumber });
  }

  async function addHealth(provider, { sent = 0, failed = 0, error = '' }) {
    const day = localParts(new Date(now()), await timeZoneOf(db)).day;
    await db.query(
      `INSERT INTO tag_health_daily (tenant_id, provider, day, sent, failed, last_error, last_error_at) VALUES ($1, $2, $3::date, $4, $5, $6, CASE WHEN $6 = '' THEN NULL ELSE $7::timestamptz END)
       ON CONFLICT (tenant_id, provider, day) DO UPDATE SET sent = tag_health_daily.sent + $4, failed = tag_health_daily.failed + $5,
         last_error = CASE WHEN $6 = '' THEN tag_health_daily.last_error ELSE $6 END, last_error_at = CASE WHEN $6 = '' THEN tag_health_daily.last_error_at ELSE $7::timestamptz END`,
      [tenantId(), provider, day, sent, failed, error, new Date(now())],
    );
  }

  /** Whole days, ending today or yesterday, on which this tag failed and sent nothing. */
  async function failedStreak(provider) {
    const rows = await db.query('SELECT day::text AS day, sent, failed FROM tag_health_daily WHERE tenant_id = $1 AND provider = $2 ORDER BY day DESC LIMIT 60', [tenantId(), provider]);
    const today = localParts(new Date(now()), await timeZoneOf(db)).day;
    let expected = rows[0]?.day === today ? today : previousDay(today);
    let count = 0;
    let first = null;
    for (const row of rows) {
      if (row.day !== expected || row.sent > 0 || row.failed === 0) break;
      count += 1;
      first = row.day;
      expected = previousDay(expected);
    }
    return { count, first };
  }

  async function alertIfFailing(provider) {
    const { count, first } = await failedStreak(provider);
    if (count < L.tagAlertAfterFailedDays) return;
    const name = provider === 'meta' ? 'Meta Pixel' : 'Google Analytics';
    await repos.alerts.raise({ kind: 'tags.failing', severity: 'warning', target: provider, message: `Your ${name} events have been failing for ${count} days. Check the connection in your tag settings.`, dedupeKey: `tags.failing:${provider}:${first}` });
  }

  const describeError = (err) => `${err?.kind ?? 'error'}${err?.code ? `:${err.code}` : ''}`.slice(0, 80);

  async function settle(ids, outcome) {
    await db.query(
      `UPDATE tag_outbox SET status = $3, last_error = $4, sent_at = $5::timestamptz, lease_until = NULL WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
      [tenantId(), ids, outcome.status, outcome.error ?? '', outcome.sentAt ?? null],
    );
  }

  async function retryOrFail(rows, error) {
    const at = +now();
    for (const row of rows) {
      const done = row.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE tag_outbox SET status = $3, last_error = $4, next_attempt_at = $5::timestamptz, lease_until = NULL WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), row.id, done ? 'failed' : 'queued', error, new Date(at + backoffMs(row.attempts))],
      );
    }
  }

  /** Sends for one business. Consent is asked again here, because a shopper may have withdrawn since the event was queued. */
  async function sendBatch(claimed) {
    const row = await settings.get();
    const state = await pageState();
    const allowed = [];
    for (const item of claimed) {
      const on = state[item.provider]?.on;
      if (!on) await settle([item.id], { status: 'failed', error: 'tag_off' });
      else if (!await granted(item.payload.consent?.visitorId ?? undefined, item.payload.consent?.shopperId ?? undefined)) await settle([item.id], { status: 'failed', error: 'consent_withdrawn' });
      else allowed.push(item);
    }
    for (const provider of TAG_PROVIDERS) {
      const items = allowed.filter((item) => item.provider === provider);
      if (!items.length) continue;
      const secret = credentials(row, provider);
      if (!secret) {
        await settle(items.map((i) => i.id), { status: 'failed', error: 'no_credentials' });
        continue;
      }
      await (provider === 'meta' ? sendMeta(secret, items) : sendGa4(secret, items));
    }
  }

  async function finish(provider, items, err) {
    if (err) {
      const error = describeError(err);
      await retryOrFail(items, error);
      await addHealth(provider, { failed: items.length, error });
      await alertIfFailing(provider);
      return;
    }
    await settle(items.map((i) => i.id), { status: 'sent', sentAt: new Date(now()) });
    await addHealth(provider, { sent: items.length });
  }

  async function sendMeta(credentials, items) {
    let failure = null;
    try {
      await meta.conversions.send(credentials, items.map((i) => i.payload.event));
    } catch (err) {
      failure = err;
    }
    await finish('meta', items, failure);
  }

  async function sendGa4(credentials, items) {
    for (const item of items) {
      let failure = null;
      try {
        await google.ga4.send(credentials, { clientId: item.payload.clientId, events: [item.payload.event] });
      } catch (err) {
        failure = err;
      }
      await finish('ga4', [item], failure);
    }
  }

  /** Called by the worker: claims what is due across every business, and sends each one's as that business. */
  async function drain({ limit = DRAIN_LIMIT } = {}) {
    const at = new Date(now());
    await db.platform.query(`UPDATE tag_outbox SET status = 'queued', lease_until = NULL WHERE status = 'sending' AND lease_until < $1::timestamptz`, [at]);
    const claimed = await db.platform.query(
      `UPDATE tag_outbox SET status = 'sending', attempts = attempts + 1, lease_until = $2::timestamptz
       WHERE id IN (SELECT id FROM tag_outbox WHERE status = 'queued' AND next_attempt_at <= $1::timestamptz ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [at, new Date(+at + SENDING_LEASE_MS), limit],
    );
    const byTenant = Map.groupBy(claimed, (row) => row.tenant_id);
    for (const [tenant, rows] of byTenant) {
      try {
        await withTenant(tenant, () => sendBatch(rows.map((row) => ({ ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }))));
      } catch (err) {
        reportError(err, { msg: 'tags.send_failed', business: tenant });
      }
    }
    return claimed.length;
  }

  async function health() {
    const row = await settings.get();
    const totals = await db.query(
      `SELECT provider, COALESCE(sum(sent), 0)::int AS sent, COALESCE(sum(failed), 0)::int AS failed FROM tag_health_daily WHERE tenant_id = $1 GROUP BY provider`,
      [tenantId()],
    );
    const items = [];
    for (const provider of TAG_PROVIDERS) {
      const total = totals.find((t) => t.provider === provider);
      const [last] = await db.query(
        `SELECT last_error, last_error_at FROM tag_health_daily WHERE tenant_id = $1 AND provider = $2 AND last_error <> '' ORDER BY day DESC LIMIT 1`,
        [tenantId(), provider],
      );
      items.push({
        provider,
        enabled: Boolean(provider === 'meta' ? row?.meta_enabled : row?.ga4_enabled),
        sent: total?.sent ?? 0,
        failed: total?.failed ?? 0,
        failedDaysInARow: (await failedStreak(provider)).count,
        lastError: last?.last_error ?? '',
        lastErrorAt: last?.last_error_at ?? null,
      });
    }
    return { items };
  }

  async function view() {
    return toView(await settings.get(), { available: await repos.entitlements.can('tags.pixels'), consentReady: Boolean(platform.consent.built) });
  }

  async function update(body, user) {
    if (!await repos.entitlements.can('tags.pixels')) throw new ApiError('forbidden', 'Pixels and analytics tags are available from tier 2.');
    await settings.save(body, { actor: `user:${user.id}`, userId: user.id });
    return view();
  }

  return { pageState, granted, onBrowserEvent, onPurchase, drain, health, view, update };
}

const previousDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
