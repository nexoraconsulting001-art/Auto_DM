import crypto from 'node:crypto';
import { ApiError } from '../../contracts/api/errors.js';
import { STORE_LIMITS } from '../../contracts/orders.js';
import { quietUntil } from '../../contracts/shopper-messages.js';
import { formatRupees } from '../../contracts/catalog.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { html, raw } from '../../views/html.js';
import { priceLines, buyable } from '../checkout/pricing.js';
import { consentLinks } from '../consent/index.js';
import { STORE_FEATURE } from '../storefront/http.js';
import { businessOf, firstName } from '../order-alerts/business.js';
import { alertSettingsFor } from '../order-alerts/index.js';

/**
 * Abandoned-cart reminders (PRD 9.15). Only a signed-in shopper has a server cart, so only they are reminded, and only on a
 * channel they said yes to for marketing (9.18): a WhatsApp template (the cart_reminder template, Marketing) or an email
 * with an unsubscribe link. Never an Instagram DM, even while a conversation window is open (S-51): this module has no
 * path to Instagram at all.
 *
 * Each time a cart is left is an "episode" (carts.episode). At most two reminders per episode, about one hour and 24 hours
 * after the last activity (STORE_LIMITS.reminders), never between 9 pm and 9 am India time (S-50): a time that falls inside
 * is moved to 9 am, and the gate holds anything that still lands there. A cart found only after both marks have passed gets
 * the later one alone, never two at once.
 *
 * Reminders stop when the shopper orders (order.created, S-49), empties the cart, comes back to it (a new episode starts
 * once it is left again), takes consent back or replies STOP, or the owner turns reminders off. The link restores the cart
 * on the store's own address, and the click is counted (restore.js).
 *
 * A row is claimed for sending in one statement (a ten-minute lease, provider_message_id 'claim'), so two workers never send
 * it. A row still 'claim'ed after its lease is one whose sender died mid-send: a WhatsApp one is failed as
 * 'unknown_delivery' rather than sent again on a guess; an email goes again with the same idempotency key and the same link.
 */
const { afterMs: AFTER_MS } = STORE_LIMITS.reminders;
const MAX_IDLE = "interval '7 days'";
const LINK_DAYS = 30;
const CLAIM = 'claim';
const SCAN_LIMIT = 200;

export const restoreHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * `clock` is what the time of day is for the quiet-hours rule (tests pin it to a daytime hour); every other time is the
 * database's and the process's own.
 */
export function createCartReminders(ctx, { clock = () => new Date() } = {}) {
  const { db, repos, shopperMessages, platform, config } = ctx;
  const platformDb = db.platform ?? db;
  const settings = alertSettingsFor(ctx);

  // ---- the owner's switch and numbers ----

  async function view() {
    const s = await settings.row();
    const account = await settings.account();
    const channels = [];
    if (account.connected) channels.push('whatsapp');
    if (ctx.providers?.email && ctx.providers.email.driver !== 'none') channels.push('email');
    return { enabled: Boolean(s.cart_reminders), channels, templateStatus: await settings.templateStatus('cart_reminder') };
  }

  async function setEnabled(enabled, actor) {
    if (enabled && !(await repos.entitlements.can('store.cart_reminders'))) throw new ApiError('forbidden', 'Cart reminders aren’t on your plan.', { reason: 'plan' });
    await settings.save({ cart_reminders: enabled }, actor, 'cart_reminders.updated');
    if (!enabled) await db.query(`UPDATE cart_reminders SET status = 'cancelled', stop_reason = 'off' WHERE tenant_id = $1 AND status = 'scheduled'`, [tenantId()]);
    return view();
  }

  /** Reminders sent in the last `days`, the ones tapped, and the orders the shopper placed within a week of one. */
  async function stats(days) {
    const [counts] = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent, count(*) FILTER (WHERE status = 'sent' AND clicked_at IS NOT NULL)::int AS clicked
       FROM cart_reminders WHERE tenant_id = $1 AND sent_at >= now() - make_interval(days => $2)`,
      [tenantId(), days],
    );
    const [orders] = await db.query(
      `SELECT count(*)::int AS ordered, COALESCE(sum(o.total_paise), 0)::bigint AS revenue FROM orders o
       WHERE o.tenant_id = $1 AND o.flow = 'checkout' AND o.confirmed_at IS NOT NULL AND o.fulfilment_status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM cart_reminders r WHERE r.tenant_id = o.tenant_id AND r.shopper_id = o.shopper_id AND r.status = 'sent'
                     AND r.sent_at >= now() - make_interval(days => $2) AND o.created_at > r.sent_at AND o.created_at <= r.sent_at + interval '7 days')`,
      [tenantId(), days],
    );
    return { days, sent: counts.sent, clicked: counts.clicked, ordered: orders.ordered, revenuePaise: Number(orders.revenue) };
  }

  // ---- stopping ----

  /** order.created: the shopper ordered, so nothing more is sent about their cart (S-49). */
  async function onOrderCreated(event) {
    const [order] = await db.query('SELECT shopper_id FROM orders WHERE tenant_id = $1 AND id = $2', [tenantId(), event.orderId]);
    if (!order?.shopper_id) return;
    await db.query(`UPDATE cart_reminders SET status = 'cancelled', stop_reason = 'ordered' WHERE tenant_id = $1 AND shopper_id = $2 AND status = 'scheduled'`, [tenantId(), order.shopper_id]);
  }

  // ---- which channel, and the message ----

  const probe = (channel, shopper) => (channel === 'whatsapp'
    ? { channel, purpose: 'marketing', now: clock(), to: { shopperId: shopper.id, phone: shopper.phone ?? undefined }, template: { purpose: 'cart_reminder', params: ['a', 'b', 'c'] } }
    : { channel, purpose: 'marketing', now: clock(), to: { shopperId: shopper.id, email: shopper.email || undefined }, email: { subject: 'a', text: 'b', unsubscribeUrl: 'https://unsubscribe.invalid/' } });

  /** WhatsApp when the shopper said yes to it and the template is approved, else email when they said yes to that. */
  async function channelFor(shopper, prefer = ['whatsapp', 'email']) {
    const reasons = [];
    for (const channel of prefer) {
      const verdict = await shopperMessages.check(probe(channel, shopper));
      if (verdict.outcome === 'sent' || verdict.outcome === 'deferred') return { channel };
      reasons.push(verdict.reason);
    }
    return { channel: null, reason: reasons.includes('template_pending') ? 'template_pending' : 'no_consent' };
  }

  /** A link token that is the same for the same reminder every time, so a resent email carries the link the first one did. */
  function tokenFor(row) {
    const secret = config.sessionSecret || config.dataKey;
    if (!secret) return crypto.randomBytes(32).toString('base64url');
    return crypto.createHmac('sha256', String(secret)).update(`cart-reminder:${row.tenant_id}:${row.id}`).digest('base64url');
  }

  async function message(row, channel, shopper, business, token) {
    const link = `${business.base}/cart/restore/${token}?utm_source=${channel}&utm_medium=reminder&utm_campaign=cart`;
    if (channel === 'whatsapp') {
      return { channel, purpose: 'marketing', to: { shopperId: shopper.id, phone: shopper.phone }, template: { purpose: 'cart_reminder', params: [firstName(shopper.name), business.name, link] } };
    }
    const lines = await db.query('SELECT product_id AS "productId", variant_id AS "variantId", qty FROM cart_lines WHERE tenant_id = $1 AND cart_id = $2 ORDER BY id', [tenantId(), row.cart_id]);
    const priced = (await priceLines(db, lines)).lines.filter(buyable).slice(0, 10);
    const unsubscribeUrl = consentLinks(ctx).unsubscribeUrl({ origin: business.base, shopperId: shopper.id, email: shopper.email, channel: 'email', purpose: 'marketing' });
    const items = priced.map((l) => `${l.name}${l.option ? ` (${l.option})` : ''} × ${l.qty} – ${formatRupees(l.linePaise)}`);
    const text = [`Hi ${firstName(shopper.name)},`, '', `You left something in your bag at ${business.name}.`, '', ...items, '', `Back to your bag: ${link}`, '', business.name, '', `Unsubscribe: ${unsubscribeUrl}`].join('\n');
    const body = html`<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f4;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="background:#ffffff;border-radius:12px;padding:24px;border-top:6px solid ${raw(business.color)}">
<h1 style="margin:0 0 16px;font-size:20px">${business.name}</h1>
<p style="margin:0 0 12px">Hi ${firstName(shopper.name)},</p>
<p style="margin:0 0 16px">You left something in your bag. It is still here for you.</p>
${items.length ? html`<ul style="margin:0 0 16px;padding-left:18px">${items.map((i) => html`<li>${i}</li>`)}</ul>` : ''}
<p style="margin:0"><a href="${link}" style="display:inline-block;background:${raw(business.color)};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px">Back to your bag</a></p>
</div>
<p style="font-size:12px;color:#6b6b70;margin:16px 0 0">You are receiving this because you said yes to offers from ${business.name}. <a href="${unsubscribeUrl}" style="color:#6b6b70">Unsubscribe</a></p>
</div></body></html>`;
    return { channel, purpose: 'marketing', to: { shopperId: shopper.id, email: shopper.email }, email: { subject: `${business.name}: you left something in your bag`, html: String(body), text, unsubscribeUrl } };
  }

  // ---- planning: one episode's two reminders ----

  async function plan(cart, episode) {
    const [shopper] = await db.query('SELECT id, phone, email, name, erased_at FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), cart.shopper_id]);
    if (!shopper || shopper.erased_at) return 0;
    const left = new Date(cart.last_activity_at).getTime();
    const marks = AFTER_MS.map((ms) => new Date(left + ms));
    const steps = Date.now() >= marks[1].getTime() ? [2] : [1, 2];
    const { channel, reason } = await channelFor(shopper);
    if (!channel) {
      // Nothing to send on: recorded once for this episode, so the cart isn't asked about again every minute.
      await db.query(
        `INSERT INTO cart_reminders (tenant_id, cart_id, shopper_id, episode, step, channel, status, stop_reason, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, $6, 'skipped', $7, $8) ON CONFLICT (tenant_id, cart_id, episode, step) DO NOTHING`,
        [tenantId(), cart.id, shopper.id, episode, steps[0], shopper.phone ? 'whatsapp' : 'email', reason, marks[steps[0] - 1]],
      );
      return 0;
    }
    let made = 0;
    for (const step of steps) {
      const at = marks[step - 1];
      const [row] = await db.query(
        `INSERT INTO cart_reminders (tenant_id, cart_id, shopper_id, episode, step, channel, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, cart_id, episode, step) DO NOTHING RETURNING id`,
        [tenantId(), cart.id, shopper.id, episode, step, channel, quietUntil(at) ?? at],
      );
      if (row) made++;
    }
    return made;
  }

  /** Every cart of this business left for an hour or more (and less than a week) that has no reminders for this time yet. */
  async function planAll() {
    const carts = await db.query(
      `SELECT * FROM (
         SELECT c.id, c.shopper_id, c.episode, c.last_activity_at,
                (SELECT min(r.created_at) FROM cart_reminders r WHERE r.tenant_id = c.tenant_id AND r.cart_id = c.id AND r.episode = c.episode) AS planned_at
         FROM carts c
         WHERE c.tenant_id = $1 AND c.status = 'active' AND c.last_activity_at <= now() - make_interval(secs => $2::float / 1000) AND c.last_activity_at > now() - ${MAX_IDLE}
           AND EXISTS (SELECT 1 FROM cart_lines l WHERE l.tenant_id = c.tenant_id AND l.cart_id = c.id)) idle
       WHERE planned_at IS NULL OR last_activity_at > planned_at
       ORDER BY last_activity_at DESC LIMIT $3`,
      [tenantId(), AFTER_MS[0], SCAN_LIMIT],
    );
    let made = 0;
    for (const cart of carts) {
      let episode = cart.episode;
      if (cart.planned_at && new Date(cart.last_activity_at) > new Date(cart.planned_at)) {
        // The shopper came back after this time's reminders were planned, and has now left the cart again.
        const [next] = await db.query('UPDATE carts SET episode = episode + 1 WHERE tenant_id = $1 AND id = $2 AND episode = $3 RETURNING episode', [tenantId(), cart.id, cart.episode]);
        if (!next) continue;
        await db.query(`UPDATE cart_reminders SET status = 'cancelled', stop_reason = 'active_again' WHERE tenant_id = $1 AND cart_id = $2 AND episode = $3 AND status = 'scheduled'`, [tenantId(), cart.id, cart.episode]);
        episode = next.episode;
      } else if (cart.planned_at) {
        continue;
      }
      made += await plan(cart, episode);
    }
    return made;
  }

  // ---- sending ----

  async function claimDue(limit = 50) {
    return db.query(
      `WITH due AS (
         SELECT id, provider_message_id FROM cart_reminders WHERE tenant_id = $1 AND status = 'scheduled' AND scheduled_for <= now()
         ORDER BY scheduled_for, id LIMIT $2 FOR UPDATE SKIP LOCKED)
       UPDATE cart_reminders r SET scheduled_for = now() + interval '10 minutes', provider_message_id = '${CLAIM}'
       FROM due WHERE r.tenant_id = $1 AND r.id = due.id
       RETURNING r.*, due.provider_message_id AS was`,
      [tenantId(), limit],
    );
  }

  async function finish(id, fields) {
    const names = Object.keys(fields);
    await db.query(`UPDATE cart_reminders SET ${names.map((n, i) => `${n} = $${i + 3}`).join(', ')} WHERE tenant_id = $1 AND id = $2`, [tenantId(), id, ...names.map((n) => fields[n])]);
  }
  const stop = (id, reason, status = 'cancelled') => finish(id, { status, stop_reason: reason, provider_message_id: null });

  /** Why this reminder must not go now, or null when it may. */
  async function stopReason(row, enabled) {
    if (!enabled) return 'off';
    const [cart] = await db.query(
      `SELECT c.status, c.episode, c.last_activity_at, EXISTS (SELECT 1 FROM cart_lines l WHERE l.tenant_id = c.tenant_id AND l.cart_id = c.id) AS has_lines
       FROM carts c WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId(), row.cart_id],
    );
    if (!cart || cart.status === 'ordered') return 'ordered';
    if (cart.status === 'emptied' || !cart.has_lines) return 'emptied';
    if (cart.episode !== row.episode || new Date(cart.last_activity_at) > new Date(row.created_at)) return 'active_again';
    if (row.step === 1) {
      const [later] = await db.query(`SELECT 1 FROM cart_reminders WHERE tenant_id = $1 AND cart_id = $2 AND episode = $3 AND step = 2 AND status = 'sent'`, [tenantId(), row.cart_id, row.episode]);
      if (later) return 'late';
    }
    // An order placed since (as a guest, or before the cart closed) also ends it.
    const [ordered] = await db.query(`SELECT 1 FROM orders WHERE tenant_id = $1 AND shopper_id = $2 AND flow = 'checkout' AND created_at > $3 LIMIT 1`, [tenantId(), row.shopper_id, row.created_at]);
    if (ordered) return 'ordered';
    return null;
  }

  async function sendOne(row, enabled, business) {
    if (row.was === CLAIM && row.channel === 'whatsapp') return stop(row.id, 'unknown_delivery', 'failed');
    const why = await stopReason(row, enabled);
    if (why) return stop(row.id, why);
    const [shopper] = await db.query('SELECT id, phone, email, name, erased_at FROM shoppers WHERE tenant_id = $1 AND id = $2', [tenantId(), row.shopper_id]);
    if (!shopper || shopper.erased_at) return stop(row.id, 'erased');
    if (!business.base) return stop(row.id, 'no_link', 'skipped');
    // The shopper may have changed their mind since this was planned: the channel they say yes to now is the one used.
    const { channel, reason } = await channelFor(shopper, row.channel === 'email' ? ['email', 'whatsapp'] : ['whatsapp', 'email']);
    if (!channel) {
      const answer = await platform.consent.allows({ purpose: 'marketing', channel: row.channel, shopperId: shopper.id, phone: shopper.phone ?? undefined, email: shopper.email || undefined }).catch(() => null);
      return stop(row.id, reason === 'no_consent' && answer?.answered ? 'opted_out' : reason, 'skipped');
    }
    if (channel !== row.channel) await finish(row.id, { channel });
    const token = tokenFor(row);
    const msg = await message(row, channel, shopper, business, token);
    msg.dedupeKey = `cart-reminder-${row.tenant_id}-${row.id}`;
    msg.now = clock();
    const result = await shopperMessages.send(msg);
    const ids = { reminder: Number(row.id), cart: row.cart_id, step: row.step, channel };
    if (result.outcome === 'sent') {
      log.info('cart_reminder.sent', ids);
      return finish(row.id, { status: 'sent', sent_at: new Date(), restore_token_hash: restoreHash(token), provider_message_id: result.messageId ? String(result.messageId).slice(0, 120) : null, stop_reason: '' });
    }
    if (result.outcome === 'deferred') return finish(row.id, { scheduled_for: result.until ?? quietUntil(clock()) ?? new Date(Date.now() + 3_600_000), provider_message_id: null });
    if (result.outcome === 'skipped') {
      log.info('cart_reminder.skipped', { ...ids, reason: result.reason });
      return stop(row.id, result.reason === 'consent_unknown' ? 'no_consent' : String(result.reason).slice(0, 40), 'skipped');
    }
    log.warn('cart_reminder.failed', { ...ids, reason: result.reason, kind: result.kind ?? null });
    // One more try a little later for a failure the provider says may pass; never for one that may have gone out.
    if (result.retryable && row.stop_reason !== 'retry') return finish(row.id, { scheduled_for: new Date(Date.now() + 15 * 60_000), stop_reason: 'retry', provider_message_id: null });
    return stop(row.id, result.reason === 'unknown_delivery' ? 'unknown_delivery' : 'provider', 'failed');
  }

  async function sendDue() {
    const rows = await claimDue();
    if (!rows.length) return 0;
    const s = await settings.row();
    const enabled = Boolean(s.cart_reminders) && (await repos.entitlements.can('store.cart_reminders').catch(() => false)) && (await repos.entitlements.can(STORE_FEATURE).catch(() => false));
    const business = await businessOf(ctx);
    let sent = 0;
    // The later step first, so a cart found late never gets both at once.
    rows.sort((a, b) => b.step - a.step || Number(a.id) - Number(b.id));
    for (const row of rows) {
      try {
        await sendOne(row, enabled, business);
        const [after] = await db.query('SELECT status FROM cart_reminders WHERE tenant_id = $1 AND id = $2', [tenantId(), row.id]);
        if (after?.status === 'sent') sent++;
      } catch (err) {
        reportError(err, { msg: 'cart_reminder.send_error', reminder: Number(row.id) });
        await finish(row.id, { scheduled_for: new Date(Date.now() + 15 * 60_000), provider_message_id: null }).catch(() => {});
      }
    }
    return sent;
  }

  /** One pass for this business: plan what is due to be planned, then send what is due. */
  async function runTenant() {
    const s = await settings.row();
    let planned = 0;
    if (s.cart_reminders && (await repos.entitlements.can('store.cart_reminders').catch(() => false)) && (await repos.entitlements.can(STORE_FEATURE).catch(() => false))) planned = await planAll();
    const sent = await sendDue();
    return { planned, sent };
  }

  /** The job: every business with reminders on, and every business with a reminder due. */
  async function run() {
    const tenants = await platformDb.query(
      `SELECT tenant_id FROM alert_settings WHERE cart_reminders
       UNION SELECT DISTINCT tenant_id FROM cart_reminders WHERE status = 'scheduled' AND scheduled_for <= now()`,
    );
    const total = { planned: 0, sent: 0 };
    for (const { tenant_id: tenant } of tenants) {
      try {
        const once = await withTenant(tenant, runTenant);
        total.planned += once.planned;
        total.sent += once.sent;
      } catch (err) {
        reportError(err, { msg: 'cart_reminder.run_failed', tenantId: tenant });
      }
    }
    return total;
  }

  /** The reminder a restore link names, at this business, with how old it is. */
  async function byToken(token) {
    const [row] = await db.query(
      `SELECT r.id, r.cart_id, r.shopper_id, r.sent_at, r.clicked_at, c.status AS cart_status FROM cart_reminders r JOIN carts c ON c.tenant_id = r.tenant_id AND c.id = r.cart_id
       WHERE r.tenant_id = $1 AND r.restore_token_hash = $2`,
      [tenantId(), restoreHash(token)],
    );
    if (!row) return null;
    const expired = !row.sent_at || Date.now() - new Date(row.sent_at).getTime() > LINK_DAYS * 86_400_000;
    return { ...row, expired };
  }

  async function markClicked(id) {
    await db.query('UPDATE cart_reminders SET clicked_at = COALESCE(clicked_at, now()) WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
  }

  return { view, setEnabled, stats, onOrderCreated, planAll, sendDue, runTenant, run, byToken, markClicked, channelFor };
}
