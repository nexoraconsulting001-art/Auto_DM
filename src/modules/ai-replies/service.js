import { ADDON_FEATURES, AI_LIMITS, AI_PURPOSE, AI_REASONS, AI_SOURCE, AI_THRESHOLD } from '../../contracts/addons.js';
import { COMPLIANCE_LIMITS, REASON_CODES } from '../../contracts/compliance.js';
import { ProviderError } from '../../adapters/http.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { buyerBaseUrl } from '../admin-api/urls.js';
import { dmReplyKey } from '../automations/message.js';
import { DISCLOSURE_LINE } from '../compliance/content.js';
import { planOff } from '../../contracts/api/errors.js';
import { checkDraft, neverAnswer, pickSources, withoutContacts } from './rules.js';

/**
 * AI replies (PRD 6.11, A-55 to A-60): the decision for one inbound DM no keyword rule answered, "Ask a test question", and
 * the sweep that hands a thread over when the window closes on a queued reply. Everything runs inside one business
 * (tenantId()); the sweep alone looks across businesses, through db.platform, and then enters each one.
 *
 * The order is fixed:
 *   1. the add-on (entitlement) and the switch; otherwise nothing at all happens, and the provider is never called;
 *   2. one ai_reply_log row per inbound DM (the unique index): a second delivery of the same DM is a no-op;
 *   3. the never-answer check in code (A-59): ai.handoff, the provider is not called;
 *   4. this business's FAQ entries and catalog facts that relate to the question, and the provider, once, never retried;
 *   5. the draft checked in code (A-57: ai.ungrounded), then the score against the business's threshold (A-56);
 *   6. compliance.enqueue as the one automated reply to that DM (dmReplyKey), with the gate adding the seller's note.
 * Every way it does not answer ends in "Needs a human" (except where the gate says someone or something already has).
 * Plain logs hold ids only; the question and the answer live in ai_reply_log, under the inbox retention rule.
 */
const FEATURE = ADDON_FEATURES.aiReplies;
const CHANNELS = new Set(['instagram', 'facebook']);
const KNOWN_REASONS = new Set(REASON_CODES);
/** A reply the gate refuses for one of these needs no person: the rule already answered, the shopper opted out, or a person already has the thread. */
const NO_HANDOFF = new Set(['cap.reply_per_message', 'optout', 'thread.handoff', 'thread.owner_replied']);
const REFUSED = new Set(['skipped', 'expired', 'failed', 'cancelled', 'unknown']);
/** How far back the sweep looks: the window is a day long, so a reply older than this cannot still be waiting on it. */
const SWEEP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

const round3 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);
const reasonOrNull = (reason) => (reason && KNOWN_REASONS.has(reason) ? reason : null);

export function createAiReplies({ db, repos, compliance, providers = {}, config = {}, meter = null }) {
  const now = () => (typeof compliance?.now === 'function' ? compliance.now() : new Date());
  const windowMs = compliance?.limits?.messagingWindowMs ?? COMPLIANCE_LIMITS.messagingWindowMs;
  const unitCost = Number.isSafeInteger(config.usageCostPaise?.ai_units) ? config.usageCostPaise.ai_units : 0;

  // ---- reading this business's data ----

  async function settings() {
    const [row] = await db.query('SELECT enabled, threshold FROM ai_settings WHERE tenant_id = $1', [tenantId()]);
    return { enabled: Boolean(row?.enabled), threshold: row ? Number(row.threshold) : AI_THRESHOLD.default };
  }

  async function activeFaq() {
    return (await db.query('SELECT id, question, answer FROM faq_entries WHERE tenant_id = $1 AND active ORDER BY id LIMIT 500', [tenantId()]))
      .map((r) => ({ id: Number(r.id), question: r.question, answer: r.answer }));
  }

  async function business() {
    const tenant = await repos.tenants.get(tenantId());
    return { name: String(tenant?.name ?? '').trim().slice(0, 120) || 'Our shop', base: tenant ? buyerBaseUrl(tenant, config) || '' : '' };
  }

  /** Name, price, stock status, sizes and the product's own direct link: nothing else of a product ever goes. */
  async function catalog(base) {
    const rows = await db.query(
      `SELECT id, name, slug, price_paise, in_stock, stock, reserved, option_label, option_values, external_url FROM products
       WHERE tenant_id = $1 AND active AND fetch_status NOT IN ('broken', 'missing') ORDER BY featured DESC, updated_at DESC, id DESC LIMIT 300`,
      [tenantId()],
    );
    return rows.map((p) => ({
      id: Number(p.id),
      name: String(p.name).slice(0, 200),
      pricePaise: Number(p.price_paise),
      inStock: Boolean(p.in_stock) && (p.stock === null || Number(p.stock) - Number(p.reserved ?? 0) > 0),
      sizes: /size/i.test(p.option_label ?? '') ? (p.option_values ?? []).map((v) => String(v).slice(0, 40)).slice(0, 30) : [],
      url: (p.external_url || (base ? `${base}/p/${encodeURIComponent(p.slug)}` : '')).slice(0, 2000),
    }));
  }

  async function wordLists() {
    const read = compliance?.log?.wordsFor;
    if (typeof read !== 'function') return { negative: [], handoff: [] };
    return { negative: await read('negative'), handoff: await read('handoff') };
  }

  // ---- the decision ----

  /**
   * What the add-on would do with this question: { outcome, reason, draft, sources, score, units, model, why }.
   * outcome is 'answered', 'handed_off' (ai.handoff, ai.low_confidence), 'dropped' (ai.ungrounded) or 'failed' (ai.provider_failed).
   */
  async function decide(question, threshold) {
    if (neverAnswer(question, await wordLists())) return { outcome: 'handed_off', reason: AI_REASONS.handoff, units: 0 };
    const provider = providers.ai;
    if (!provider?.configured) return { outcome: 'failed', reason: AI_REASONS.providerFailed, units: 0, why: 'not_configured' };
    if (question.length > AI_LIMITS.questionChars) return { outcome: 'handed_off', reason: AI_REASONS.lowConfidence, units: 0, why: 'too_long' };

    const shop = await business();
    const asked = withoutContacts(question);
    const { faq, products } = pickSources(asked, { faq: await activeFaq(), products: await catalog(shop.base) });
    let answer;
    try {
      answer = await provider.answer({ question: asked, faq, products, businessName: shop.name, disclosure: DISCLOSURE_LINE, language: '' });
    } catch (err) {
      if (!(err instanceof ProviderError)) reportError(err, { msg: 'ai_replies.provider_call_failed' });
      return { outcome: 'failed', reason: AI_REASONS.providerFailed, units: 0, why: err instanceof ProviderError ? err.kind : 'error' };
    }
    const drafted = { draft: answer.draft, sources: answer.sources, score: answer.confidence, units: answer.usage?.units ?? 0, model: answer.model ?? '', faq, products };
    const verdict = checkDraft(answer, { faq, products, question, models: [config.aiModel, provider.model, answer.model] });
    if (!verdict.ok) return { ...drafted, outcome: 'dropped', reason: AI_REASONS.ungrounded, why: verdict.why };
    if (!answer.sources.length || !(answer.confidence >= threshold)) return { ...drafted, outcome: 'handed_off', reason: AI_REASONS.lowConfidence };
    return { ...drafted, outcome: 'answered', reason: '' };
  }

  /** AI units, once per answer (the log row is the key). A meter that fails never changes what the shopper gets. */
  async function meterUnits(logId, units) {
    if (!meter || !Number.isSafeInteger(units) || units <= 0) return false;
    try {
      return await meter.record({ meter: 'ai_units', quantity: units, costPaise: units * unitCost, key: `ai_reply:${logId}`, at: now() });
    } catch (err) {
      reportError(err, { msg: 'ai_replies.meter_failed', log: logId });
      return false;
    }
  }

  const logColumns = (d) => [
    String(d.draft ?? '').slice(0, 4000),
    (d.sources ?? []).filter((s) => AI_SOURCE.test(s)).slice(0, AI_LIMITS.sources),
    round3(d.score),
    String(d.model ?? '').slice(0, 120),
    Number.isSafeInteger(d.units) && d.units > 0 ? d.units : 0,
  ];

  /** One "Needs a human" item for the thread, and the thread in that list. Ids, the reason and the shopper's own words (the inbox keeps them 30 days). */
  async function handOff({ channel, threadId, subjectHash, jobId = null, reason, text }) {
    await db.tx(async (t) => {
      await t.query(
        `INSERT INTO needs_human_items (tenant_id, channel, thread_id, job_id, kind, reason, subject_hash, text, created_at)
         VALUES ($1, $2, $3, $4, 'handoff', $5, $6, $7, $8::timestamptz)`,
        [tenantId(), channel, threadId, jobId, reason, subjectHash ?? '', String(text ?? '').slice(0, 2000), now()],
      );
      await t.query(`UPDATE inbox_threads SET status = 'needs_human', updated_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2 AND status <> 'needs_human'`, [tenantId(), threadId, now()]);
    });
  }

  /**
   * The handler for ctx.inbound.onUnmatched: one inbound DM no keyword rule answered. Returns what was decided (for tests),
   * or null when the add-on did nothing with it. Safe to run twice: the second run finds the log row and stops.
   */
  async function onUnmatched({ channel, threadId, messageId } = {}) {
    if (!CHANNELS.has(channel) || !threadId || !messageId) return null;
    if (!(await repos.entitlements.can(FEATURE))) return null;
    const switched = await settings();
    if (!switched.enabled) return null;

    const [row] = await db.query(
      `SELECT m.text, m.created_at, t.channel, t.recipient_id, t.ig_user_id, t.fb_page_id, t.subject_hash
       FROM inbox_messages m JOIN inbox_threads t ON t.tenant_id = m.tenant_id AND t.id = m.thread_id
       WHERE m.tenant_id = $1 AND m.mid = $2 AND m.thread_id = $3 AND m.direction = 'in'`,
      [tenantId(), String(messageId), Number(threadId)],
    );
    if (!row || row.channel !== channel) return null;
    const question = String(row.text ?? '').trim();
    if (!question) return null;
    const mid = String(messageId).slice(0, 400);

    // Claimed before anything else: a crash after this point leaves no reply rather than two.
    const [claimed] = await db.query(
      `INSERT INTO ai_reply_log (tenant_id, channel, thread_id, inbound_mid, question, threshold, outcome, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8::timestamptz)
       ON CONFLICT (tenant_id, channel, inbound_mid) WHERE inbound_mid <> '' DO NOTHING RETURNING id`,
      [tenantId(), channel, Number(threadId), mid, question.slice(0, 2000), switched.threshold, AI_REASONS.providerFailed, now()],
    );
    if (!claimed) return null;
    const logId = Number(claimed.id);

    let decision;
    try {
      decision = await decide(question, switched.threshold);
    } catch (err) {
      reportError(err, { msg: 'ai_replies.decide_failed', log: logId, thread: Number(threadId) });
      decision = { outcome: 'failed', reason: AI_REASONS.providerFailed, units: 0, why: 'error' };
    }
    await meterUnits(logId, decision.units);

    let jobId = null;
    let { outcome, reason } = decision;
    let handover = outcome !== 'answered';
    if (outcome === 'answered') {
      const result = await compliance.enqueue({
        kind: 'dm', purpose: AI_PURPOSE, channel, accountId: channel === 'facebook' ? row.fb_page_id : row.ig_user_id,
        recipientId: row.recipient_id, personId: row.recipient_id, idempotencyKey: dmReplyKey(mid),
        expiresAt: new Date(+new Date(row.created_at) + windowMs), message: { text: decision.draft },
      }, { inReplyTo: mid });
      jobId = result?.jobId ?? null;
      if (!jobId || REFUSED.has(result?.outcome)) {
        // The gate's own code stands (window.closed, optout, a cap, a content rule).
        reason = result?.reason || 'send.error';
        handover = !NO_HANDOFF.has(reason);
        outcome = handover ? 'handed_off' : 'dropped';
      }
    }

    await db.query(
      `UPDATE ai_reply_log SET answer = $3, source_ids = $4::text[], score = $5, model = $6, units = $7, outcome = $8, reason = $9, job_id = $10
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), logId, ...logColumns(decision), outcome, reasonOrNull(reason), jobId],
    );
    if (handover) {
      await handOff({ channel, threadId: Number(threadId), subjectHash: row.subject_hash, jobId, reason: reason || AI_REASONS.handoff, text: question })
        .catch((err) => reportError(err, { msg: 'ai_replies.handoff_failed', log: logId, thread: Number(threadId) }));
    }
    log.info('ai_replies.decided', { log: logId, thread: Number(threadId), job: jobId, outcome, reason: reason || null, rule: decision.why ?? null });
    return { logId, outcome, reason: reason || '', jobId, why: decision.why ?? null };
  }

  /**
   * "Ask a test question": the same decision with nothing enqueued, logged as outcome 'test' and metered like any other
   * answer. The switch need not be on; the add-on must be (the route checks it).
   */
  async function testQuestion(question) {
    if (!(await repos.entitlements.can(FEATURE))) throw planOff(FEATURE);
    const switched = await settings();
    const text = String(question ?? '').trim();
    const decision = await decide(text, switched.threshold);
    const [row] = await db.query(
      `INSERT INTO ai_reply_log (tenant_id, channel, question, answer, source_ids, score, threshold, model, units, outcome, reason, created_at)
       VALUES ($1, 'instagram', $2, $3, $4::text[], $5, $6, $7, $8, 'test', $9, $10::timestamptz) RETURNING id`,
      [tenantId(), text.slice(0, 2000), ...logColumns(decision).slice(0, 3), switched.threshold, ...logColumns(decision).slice(3), reasonOrNull(decision.reason), now()],
    );
    await meterUnits(Number(row.id), decision.units);
    const labels = new Map([...(decision.faq ?? []).map((f) => [`faq:${f.id}`, f.question]), ...(decision.products ?? []).map((p) => [`product:${p.id}`, p.name])]);
    const sources = (decision.sources ?? []).filter((s) => labels.has(s)).map((s) => {
      const [, kind, id] = AI_SOURCE.exec(s);
      return { kind, id: Number(id), label: labels.get(s) };
    });
    return {
      answer: decision.draft ?? '',
      sources,
      score: round3(decision.score),
      threshold: switched.threshold,
      wouldSend: decision.outcome === 'answered',
      reason: decision.reason || '',
    };
  }

  /**
   * A-60: a reply that was queued but never went because the window closed (the gate's expiry, or Meta's own refusal) is
   * handed to a person. Each one once: the log row moves from 'answered' to 'handed_off' in the same statement that finds it.
   */
  async function sweepWindowClosed() {
    const rows = await db.platform.query(
      `SELECT l.tenant_id, l.id FROM ai_reply_log l JOIN outbound_jobs j ON j.tenant_id = l.tenant_id AND j.id = l.job_id
       WHERE l.outcome = 'answered' AND l.created_at > $1::timestamptz AND j.status IN ('expired', 'skipped') AND j.reason = 'window.closed'
       ORDER BY l.id LIMIT 500`,
      [new Date(+now() - SWEEP_LOOKBACK_MS)],
    );
    let handed = 0;
    for (const { tenant_id: tenant, id } of rows) {
      try {
        await withTenant(Number(tenant), async () => {
          const [moved] = await db.query(
            `UPDATE ai_reply_log l SET outcome = 'handed_off', reason = 'window.closed' FROM inbox_threads t
             WHERE l.tenant_id = $1 AND l.id = $2 AND l.outcome = 'answered' AND t.tenant_id = l.tenant_id AND t.id = l.thread_id
             RETURNING l.channel, l.thread_id, l.job_id, l.question, t.subject_hash`,
            [tenantId(), Number(id)],
          );
          if (!moved) return;
          await handOff({ channel: moved.channel, threadId: Number(moved.thread_id), subjectHash: moved.subject_hash, jobId: moved.job_id, reason: 'window.closed', text: moved.question });
          handed++;
        });
      } catch (err) {
        reportError(err, { msg: 'ai_replies.sweep_failed', log: Number(id) });
      }
    }
    if (handed) log.info('ai_replies.window_closed', { handed });
    return handed;
  }

  return { settings, decide, onUnmatched, testQuestion, sweepWindowClosed };
}
