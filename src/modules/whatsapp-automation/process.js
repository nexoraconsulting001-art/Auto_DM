import { ADDON_FEATURES, WHATSAPP_CHANNEL, WHATSAPP_LIMITS } from '../../contracts/addons.js';
import { reportError } from '../../platform/log.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { buyerBaseUrl } from '../admin-api/urls.js';
import { matchesKeywords } from '../automations/match.js';
import { isOptOut, isStart, wantsHuman } from '../compliance/words.js';
import { directLink } from '../links/rules.js';
import { isStop, stopWhatsappMarketing } from '../order-alerts/webhook.js';
import { countWebhookProcessed } from '../../platform/metrics.js';

/**
 * What a stored WhatsApp message means (PRD 6.12), worked through once. intake.js stores each message as an inbound_events
 * row (channel 'whatsapp', status 'pending') with its inbox thread and message, and runs it straight away; sweep() in the
 * worker takes any it missed. A row is claimed with a lease before anything is done, so a repeat or a second worker never
 * runs it twice, and each send has an idempotency key of the message id besides.
 *
 * In order, on the whole message:
 *   - an opt-out word (PRD 4.6, with WhatsApp's trailing punctuation and order-alerts' STOP words): the person goes on the
 *     whatsapp blocklist (opt_outs), their marketing opt-in is withdrawn, and the first time only they get the seller's
 *     confirmation. Recorded even with the add-on off: stopping is never a send.
 *   - START: the opt-out is lifted and the marketing opt-in recorded again (source 'keyword').
 *   - a request for a person: the thread goes to "Needs a human" and automation pauses on it.
 *   - otherwise, with the add-on on and the number active: the first active keyword set (by position) whose keywords the
 *     6.2 matcher finds answers with its reel's landing page or its link, as a direct link with utm_source=whatsapp. It is
 *     enqueued with the compliance engine as a free-form 'dm' that expires when the 24 hour window closes.
 *
 * Nothing here logs a number, a name or a message.
 */
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const SWEEP_LIMIT = 100;
/** The intake runs a message the moment it is stored; the sweep leaves it that long before taking it over. */
const SWEEP_AFTER_MS = 10_000;
const INBOX_TEXT_CHARS = 2000;
const DEFAULT_OPTOUT_CONFIRMATION = 'You won’t get automated messages from us any more. Reply START if you change your mind.';
const FEATURE = ADDON_FEATURES.whatsapp;

/** WhatsApp shoppers type "Stop." and "STOP!" as readily as STOP; the whole message must still be the word. */
const stripped = (text) => String(text ?? '').trim().replace(/[.!]+$/u, '');
export const isWhatsappOptOut = (text, added = []) => isOptOut(stripped(text), added) || isStop(text);
export const isWhatsappStart = (text) => isStart(stripped(text));

const slugPart = (s) => String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function createProcessor(ctx) {
  const { db, repos, config, compliance } = ctx;
  const platformDb = db.platform ?? db;
  const now = () => (typeof compliance?.now === 'function' ? compliance.now() : new Date());
  const limits = () => compliance?.limits ?? {};
  const record = (entry) => repos.compliance.record({ channel: WHATSAPP_CHANNEL, at: now(), ...entry }).catch((err) => reportError(err, { msg: 'whatsapp.log_failed' }));

  const entitled = async () => Boolean(await repos.entitlements?.can(FEATURE));

  async function activeAccount(phoneNumberId) {
    const [row] = await db.query(
      `SELECT 1 AS ok FROM whatsapp_accounts WHERE tenant_id = $1 AND phone_number_id = $2 AND status = 'active' AND access_token_enc <> ''`,
      [tenantId(), phoneNumberId],
    );
    return Boolean(row);
  }

  /** Can this business send on this number now: the add-on bought and the number connected. Pauses are the gate's. */
  const canSend = async (phoneNumberId) => (await entitled()) && activeAccount(phoneNumberId);

  // ---- claiming ----------------------------------------------------------------------------------------------------

  async function claim(id) {
    const at = now();
    const [row] = await db.query(
      `UPDATE inbound_events SET attempts = attempts + 1, lease_until = $3::timestamptz
       WHERE tenant_id = $1 AND id = $2 AND channel = 'whatsapp' AND status = 'pending' AND (lease_until IS NULL OR lease_until <= $4::timestamptz)
       RETURNING id, account_id, object_id, payload, attempts`,
      [tenantId(), id, new Date(+at + LEASE_MS), at],
    );
    return row ?? null;
  }

  async function finish(row, err) {
    if (!err) {
      await db.query(`UPDATE inbound_events SET status = 'done', lease_until = NULL, processed_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2`, [tenantId(), row.id, now()]);
      countWebhookProcessed(ctx.platform?.metrics, 'whatsapp', 'done');
      return;
    }
    const giveUp = row.attempts >= MAX_ATTEMPTS;
    countWebhookProcessed(ctx.platform?.metrics, 'whatsapp', giveUp ? 'failed' : 'retry');
    await db.query(
      `UPDATE inbound_events SET status = $3, lease_until = $4::timestamptz, processed_at = $5::timestamptz WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), row.id, giveUp ? 'failed' : 'pending', giveUp ? null : new Date(+now() + 2 ** row.attempts * 1000), giveUp ? now() : null],
    );
  }

  // ---- what a message does ----------------------------------------------------------------------------------------

  async function confirmationText() {
    const [row] = await db.query(
      `SELECT v.body FROM message_templates m JOIN template_variants v ON v.tenant_id = m.tenant_id AND v.template_id = m.id
       WHERE m.tenant_id = $1 AND m.automation_id IS NULL AND m.role = 'optout_confirm' AND v.active ORDER BY v.label LIMIT 1`,
      [tenantId()],
    );
    return row?.body || DEFAULT_OPTOUT_CONFIRMATION;
  }

  const windowEnd = (ev) => new Date(+ev.at + (limits().messagingWindowMs ?? 24 * 3_600_000));

  async function enqueue(action, options) {
    const result = await compliance.enqueue(action, options);
    if (result?.jobId) await compliance.poke?.();
    return result;
  }

  async function onOptOut(ev) {
    const at = now();
    const added = await repos.compliance.addOptOut(WHATSAPP_CHANNEL, ev.subject, 'dm', at);
    await db.query(
      `UPDATE whatsapp_optins SET withdrawn_at = $3::timestamptz WHERE tenant_id = $1 AND phone_hash = $2 AND purpose = 'marketing' AND withdrawn_at IS NULL`,
      [tenantId(), ev.subject, at],
    );
    await compliance.cancelFollowups?.(WHATSAPP_CHANNEL, ev.subject, 'cancelled.optout');
    // Whatever word they used, marketing stops with automation: consent withdrawn and cart reminders cancelled, as for a STOP.
    await stopWhatsappMarketing({ db, platform: ctx.platform }, `+${ev.personId}`);
    await record({ kind: 'optout', subject: ev.subject, decision: 'skipped', reason: 'optout' });
    if (!added || !(await canSend(ev.accountId))) return;
    await enqueue({
      kind: 'dm', purpose: 'optout_confirm', channel: WHATSAPP_CHANNEL, accountId: ev.accountId, recipientId: ev.personId, personId: ev.personId,
      idempotencyKey: `optout_confirm:wa:${ev.mid}`, expiresAt: windowEnd(ev), message: { text: await confirmationText() },
    });
  }

  async function onStart(ev) {
    const lifted = await repos.compliance.removeOptOut(WHATSAPP_CHANNEL, ev.subject);
    await db.query(
      `INSERT INTO whatsapp_optins (tenant_id, phone_hash, purpose, source, opted_in_at) VALUES ($1, $2, 'marketing', 'keyword', $3::timestamptz)
       ON CONFLICT (tenant_id, phone_hash, purpose) DO UPDATE SET
         source = CASE WHEN whatsapp_optins.withdrawn_at IS NULL THEN whatsapp_optins.source ELSE EXCLUDED.source END,
         opted_in_at = CASE WHEN whatsapp_optins.withdrawn_at IS NULL THEN whatsapp_optins.opted_in_at ELSE EXCLUDED.opted_in_at END,
         withdrawn_at = NULL`,
      [tenantId(), ev.subject, now()],
    );
    if (lifted) await record({ kind: 'optin', subject: ev.subject, decision: 'cancelled', reason: 'optout', details: { lifted: true } });
  }

  async function onHandoff(ev) {
    const at = now();
    await db.query(
      `UPDATE inbox_threads SET automation_paused_until = GREATEST(automation_paused_until, $3::timestamptz), pause_reason = 'thread.handoff', status = 'needs_human', updated_at = $4::timestamptz
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), ev.threadId, new Date(+at + (limits().threadHandoffMs ?? 24 * 3_600_000)), at],
    );
    await db.query(
      `INSERT INTO needs_human_items (tenant_id, channel, thread_id, kind, reason, subject_hash, username, text, created_at)
       SELECT $1::integer, 'whatsapp', $2::integer, 'handoff', 'thread.handoff', $3::text, '', $4::text, $5::timestamptz
       WHERE NOT EXISTS (SELECT 1 FROM needs_human_items WHERE tenant_id = $1::integer AND kind = 'handoff' AND subject_hash = $3::text AND status = 'open' AND thread_id = $2::integer)`,
      [tenantId(), ev.threadId, ev.subject, String(ev.text).slice(0, INBOX_TEXT_CHARS), at],
    );
    await compliance.cancelFollowups?.(WHATSAPP_CHANNEL, ev.subject, 'thread.handoff');
    await record({ kind: 'thread', subject: ev.subject, decision: 'held', reason: 'thread.handoff' });
  }

  async function matchingSet(text) {
    if (!String(text ?? '').trim()) return null;
    const sets = await db.query(
      'SELECT id, keywords, reel_id, link_url, message FROM whatsapp_keywords WHERE tenant_id = $1 AND active ORDER BY position, id',
      [tenantId()],
    );
    return sets.find((set) => matchesKeywords(text, set.keywords)) ?? null;
  }

  /** The reply's text with its direct link, or null when the set's reel no longer has a page to send. */
  async function replyFor(set) {
    const settings = await repos.compliance.settings().catch(() => null);
    const utmEnabled = settings?.utm_enabled !== false;
    let url;
    let linkType;
    let mediaId = '';
    if (set.reel_id) {
      const [reel] = await db.query('SELECT slug, ig_media_id, active FROM reels WHERE tenant_id = $1 AND id = $2', [tenantId(), set.reel_id]);
      const base = buyerBaseUrl(currentTenant(), config);
      if (!reel?.active || !/^https:\/\//.test(base ?? '')) return null;
      // The reel's own landing page on the seller's address (PRD 8.10): a page, never a redirect.
      url = `${base}/r/${encodeURIComponent(reel.slug)}`;
      linkType = 'bhava_page';
      mediaId = reel.ig_media_id;
    } else {
      url = set.link_url;
      linkType = 'seller_site';
    }
    const campaign = slugPart(set.keywords?.[0]) || `keyword-${set.id}`;
    const link = directLink({ url, linkType, channel: WHATSAPP_CHANNEL, automationSlug: campaign, mediaId, utmEnabled });
    const message = String(set.message ?? '').trim();
    const text = !message ? link : message.includes('{link}') ? message.replaceAll('{link}', link) : `${message}\n${link}`;
    return Buffer.byteLength(text, 'utf8') <= WHATSAPP_LIMITS.textBytes ? text : link;
  }

  async function onKeyword(ev) {
    if (!(await canSend(ev.accountId))) return;
    const set = await matchingSet(ev.text);
    if (!set) return;
    const text = await replyFor(set);
    if (!text) return;
    await enqueue({
      kind: 'dm', purpose: 'trigger', channel: WHATSAPP_CHANNEL, accountId: ev.accountId, recipientId: ev.personId, personId: ev.personId,
      idempotencyKey: `dm_keyword:wa:${ev.mid}`, expiresAt: windowEnd(ev), message: { text },
    }, { inReplyTo: ev.mid, trigger: 'dm_keyword' });
  }

  async function handle(row) {
    const [found] = await db.query(
      `SELECT m.text, m.kind, t.id AS thread_id, t.subject_hash, t.recipient_id
       FROM inbox_messages m JOIN inbox_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
       WHERE m.tenant_id = $1 AND m.mid = $2 AND t.channel = 'whatsapp'`,
      [tenantId(), row.object_id],
    );
    if (!found) return; // the thread was removed since (its number disconnected and deleted): nothing left to answer
    const at = new Date(row.payload?.at ?? now());
    const ev = {
      mid: row.object_id, accountId: row.account_id, personId: found.recipient_id, subject: found.subject_hash,
      threadId: found.thread_id, text: found.kind === 'text' ? found.text : '', at: Number.isNaN(+at) ? now() : at,
    };
    if (isWhatsappOptOut(ev.text, await repos.compliance.wordsFor('optout'))) return onOptOut(ev);
    if (isWhatsappStart(ev.text)) return onStart(ev);
    if (wantsHuman(ev.text, await repos.compliance.wordsFor('handoff'))) return onHandoff(ev);
    return onKeyword(ev);
  }

  /** Runs one stored message inside its business, if nobody else has it. True when this call ran it. */
  async function runInTenant(id) {
    const row = await claim(id);
    if (!row) return false;
    let failed = null;
    try {
      await handle(row);
    } catch (err) {
      failed = err;
      reportError(err, { msg: 'whatsapp.inbound_failed', event: Number(row.id) });
    }
    await finish(row, failed);
    return true;
  }

  const run = (tenant, id) => withTenant(tenant, () => runInTenant(id));

  /** The safety net: stored messages the intake did not finish (a crash, a failure waiting for its retry). */
  async function sweep({ limit = SWEEP_LIMIT } = {}) {
    const at = now();
    const rows = await platformDb.query(
      `SELECT e.id, t.id AS tenant_id, t.slug, t.name, t.status,
              (SELECT p.domain FROM tenant_domains p WHERE p.tenant_id = t.id AND p.is_primary AND p.status = 'verified') AS primary_domain
       FROM inbound_events e JOIN tenants t ON t.id = e.tenant_id
       WHERE e.status = 'pending' AND e.channel = 'whatsapp' AND e.received_at <= $1::timestamptz AND (e.lease_until IS NULL OR e.lease_until <= $2::timestamptz)
       ORDER BY e.received_at, e.id LIMIT $3`,
      [new Date(+at - SWEEP_AFTER_MS), at, limit],
    );
    let ran = 0;
    for (const r of rows) {
      const tenant = { id: r.tenant_id, slug: r.slug, name: r.name, status: r.status, primary_domain: r.primary_domain };
      try {
        if (await run(tenant, r.id)) ran++;
      } catch (err) {
        reportError(err, { msg: 'whatsapp.sweep_failed', event: Number(r.id) });
      }
    }
    return ran;
  }

  return { run, runInTenant, sweep, handle };
}
