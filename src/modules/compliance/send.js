import crypto from 'node:crypto';
import os from 'node:os';
import { DM_LIMIT_REASON, METERED_SEND_KINDS, UNMETERED_HOLD_PURPOSES, dmUsageKey } from '../../contracts/billing.js';
import { ACCOUNT_COLUMNS, COMPLIANCE_LIMITS, ComplianceAction } from '../../contracts/compliance.js';
import { log as logger, reportError } from '../../platform/log.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { createBreaker } from './breaker.js';
import { createBudgets } from './budgets.js';
import { createChannels } from './channels.js';
import { budgetMultiplier, callAllowed, createGate, evaluate, evaluateCreation, expiryReason, finalMessage, triggerOf } from './gate.js';
import { createInbound } from './inbound.js';
import { complianceRepo } from './repo.js';
import { createSlowMode } from './slow-mode.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const RAW_WEBHOOK_RETENTION_MS = 7 * DAY;
const SCORE_REVIEW_THRESHOLD = 50; // bad events per 1,000 sends (PRD 4.13, value to set)
const SCORE_MIN_SENDS = 200;
const SLOW_MODE_AFTER_REGAIN_MS = HOUR;
const USAGE_SLOW_MODE_PERCENT = 90;
const THREAD_OWNER_REPLIED = 'thread.owner_replied';
const FAIRNESS_TENANTS_AT_ONCE = 8;
const STREAM_SENDS_PER_TICK = 25;
const NOT_DELIVERED = new Set(['failed', 'cancelled', 'expired', 'skipped', 'would_send']);
const DELIVERED = new Set(['sent', 'sent_fallback']);

/** The queue one short turn of the engine runs on. */
export const DRAIN_QUEUE = 'compliance.drain';
const WORK_SLICE_MS = 3000;
const WAKE_FLOOR_MS = 1000;
const WAKE_CEILING_MS = 60_000;

// True once this process has registered the worker. A web process on its own never does: it stores, pokes the queue and answers.
let workerRunningHere = false;
export const markWorkerRunning = () => {
  workerRunningHere = true;
};

const blank = Object.freeze({ jobId: null, messageId: null, status: null, metaCode: null, metaSubcode: null });
const intOrNull = (v) => (Number.isInteger(v) ? v : null);

class CapRefused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

const budgetFor = (kind) => ({ private_reply: 'private_reply', dm: 'send_api' }[kind] ?? null);

/** Which caps a job claims, in the transaction that creates it (PRD 4.7). scope means once-only; limit and windowMs a rolling count. */
function capsFor(action, { trigger, inReplyTo }, subject, limits) {
  const { kind, purpose, commentId, mediaId, automationId } = action;
  const perAutomation = String(automationId ?? 0);
  const rolling = (cap, limit, windowMs) => ({ cap, subject, limit, windowMs });
  const perPerson = subject ? [rolling('cap.per_person_24h', limits.capPerPerson24h, DAY)] : [];
  const dmReplies = subject ? [rolling('cap.dm_replies_24h', limits.capDmReplies24h, DAY)] : [];
  const perMedia = mediaId && subject ? [{ cap: 'cap.per_media', subject, scope: `${perAutomation}:${mediaId}` }] : [];
  const perMessage = inReplyTo && subject ? [{ cap: 'cap.reply_per_message', subject, scope: inReplyTo }] : [];

  if (kind === 'public_reply') {
    return [
      ...(mediaId ? [{ cap: 'cap.public_reply_media_h', subject: `media:${mediaId}`, limit: limits.publicRepliesPerMediaHour, windowMs: HOUR }] : []),
      { cap: 'cap.public_reply_tenant_h', subject: '', limit: limits.publicRepliesPerTenantHour, windowMs: HOUR },
    ];
  }
  if (kind === 'private_reply') return [{ cap: 'cap.per_comment', subject: '', scope: commentId }, ...perMedia, ...perPerson];
  if (['manual', 'test', 'optout_confirm'].includes(purpose)) return [];
  if (purpose === 'followup') return subject ? [{ cap: 'cap.followup', subject, scope: perAutomation }, ...perPerson] : [];
  if (purpose === 'welcome') return subject ? [{ cap: 'cap.welcome_once', subject, scope: 'welcome' }] : [];
  // The second message of the two-tap flow counts with the first; only a repeat tap's resend is limited (PRD 6.13).
  if (purpose === 'link') return dmReplies;
  if (purpose === 'faq' || purpose === 'ai_reply') return [...perMessage, ...dmReplies];
  if (trigger === 'mention') return subject ? [rolling('cap.mention_7d', 1, 7 * DAY), ...perPerson] : [];
  if (mediaId || trigger === 'story_reply') return [...perMedia, ...perMessage, ...perPerson];
  return [...perMessage, ...dmReplies];
}

const lock = (t, key) => t.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);

/**
 * The compliance gate (PRD 4): the only path to Meta. A module asks for a send with one of these and never calls Meta itself.
 *
 *   compliance.check(action)    -> { allow, outcome, reason }   every rule, no side effects
 *   compliance.send(action)     -> SendResult                   sends now (a manual reply). Runs every rule and creates the job row first.
 *   compliance.enqueue(action)  -> SendResult                   creates the outbound_jobs row, caps claimed; a worker sends it
 *
 * Optional second argument to send and enqueue, none of it in the action's contract:
 *   { trigger }      'comment', 'story_reply', 'mention' or 'dm_keyword'. Or begin the idempotency key with that word and a colon.
 *   { inReplyTo }    the mid of the inbound DM this answers: one automated reply per inbound DM.
 *   { runAt }        Date: not before this (follow-ups).
 *   { fallbackText } plain text to use if Meta refuses the button template. Otherwise the link is put after the text.
 *
 * A job is 'queued' with a lease while a worker considers it, and 'sending' only for the moment Meta is being called. So a crash before the
 * call reruns it, and a crash during the call leaves it 'sending', which becomes 'unknown' and is never resent.
 *
 * config may carry complianceNow (a clock), complianceRandom, complianceLimits and complianceInline: false (never work in the web process), for tests.
 */
export function createCompliance({ db, repos, ig, meta, config = {}, platform }) {
  const log = complianceRepo(db);
  const clock = config.complianceNow ?? Date.now;
  const now = () => new Date(clock());
  const random = config.complianceRandom ?? Math.random;
  const limits = { ...COMPLIANCE_LIMITS, ...config.complianceLimits };
  const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

  const channels = createChannels();
  const gate = createGate({ db, repos, config, now, limits, channels });
  /** What an account's token bucket is counted under: the channel's own key, or the account id. */
  const budgetKeyOf = (action) => channels.get(action.channel)?.budgetKey(action) ?? action.accountId;
  const ACCOUNT_ID = `COALESCE(${Object.values(ACCOUNT_COLUMNS).join(', ')})`;
  const budgets = createBudgets({ db, now, random, limits });
  const breaker = createBreaker({ db, repos, now, gate });
  const consumers = [];
  // Metering (PRD 5.12). The usage module registers both; until it does the quota is unlimited and nobody is told.
  let quota = null;
  const acceptedListeners = [];

  /**
   * Whether this business has DMs left this month, asked of the usage module at the moment of sending. Only an automated
   * private reply or DM is ever held for it: never a public reply, the owner's own reply, the confirmation of an opt-out or
   * a test send. A provider that fails is reported and read as "yes": a fault in metering must not stop a seller's messages.
   */
  async function dmQuotaLeft(action, { isTest = false } = {}) {
    if (!quota || isTest || action.isTest || !METERED_SEND_KINDS.includes(action.kind) || UNMETERED_HOLD_PURPOSES.includes(action.purpose)) return true;
    try {
      return (await quota.hasDmsLeft({ channel: action.channel ?? null, kind: action.kind, purpose: action.purpose, automationId: action.automationId ?? null })) !== false;
    } catch (err) {
      reportError(err, { msg: 'compliance.quota_failed' });
      return true;
    }
  }

  /** Tells the usage module that Meta accepted a send: ids only, once per job, never for a test send or a public reply. */
  async function tellAccepted(job, action, at) {
    if (job.is_test || action.isTest || action.purpose === 'test' || !METERED_SEND_KINDS.includes(job.kind ?? action.kind)) return;
    const event = Object.freeze({
      tenantId: tenantId(), jobId: Number(job.id), key: dmUsageKey(job.id), channel: action.channel, kind: job.kind ?? action.kind, purpose: action.purpose,
      automated: action.purpose !== 'manual', automationId: action.automationId ?? null, at,
    });
    for (const listener of acceptedListeners) {
      try {
        await listener(event);
      } catch (err) {
        reportError(err, { msg: 'compliance.accepted_listener_failed', job: event.jobId });
      }
    }
  }

  /** Puts this business's jobs held for the DM limit back in the queue, while unexpired. Returns how many. */
  async function requeueDmLimit() {
    const rows = await db.query(
      `UPDATE outbound_jobs SET status = 'queued', reason = '', lease_until = NULL, updated_at = $2::timestamptz
       WHERE tenant_id = $1 AND status = 'held' AND reason = $3 AND expires_at > $2::timestamptz RETURNING id`,
      [tenantId(), now(), DM_LIMIT_REASON],
    );
    return rows.length;
  }

  const subjectOf = async (action) => {
    const person = action.personId ?? action.recipientId;
    return person ? log.subjectHash(action.channel, person) : '';
  };

  /** sendMessage answers with the receipt, usage header included, and cuts nothing. The older two calls are for the reels bridge and clientFor. */
  function dispatch(action, account, { legacy = false } = {}) {
    const { kind, commentId, recipientId, message } = action;
    const registered = channels.get(action.channel);
    if (registered) return registered.send(action, account, { legacy });
    if (kind === 'public_reply') return ig.replyToComment(account, commentId, message.text);
    if (kind === 'dm') return ig.sendMessage(account, { id: recipientId }, message);
    if (legacy && message.button?.url && !message.quickReplies) return ig.sendPrivateReplyButton(account, commentId, message.text, message.button.url, message.button.title);
    if (legacy && !message.button && !message.quickReplies) return ig.sendPrivateReply(account, commentId, message.text);
    return ig.sendMessage(account, { commentId }, message);
  }

  const swallow = (msg, fields = {}) => (err) => reportError(err, { msg, ...fields });

  async function writeLog(action, result, { subject = '', jobId = null, errorClass } = {}) {
    try {
      await log.record({
        channel: action.channel,
        kind: action.kind,
        subject,
        decision: result.outcome,
        reason: result.reason,
        automationId: action.automationId ?? null,
        jobId,
        mediaId: action.mediaId ?? '',
        commentId: action.commentId ?? '',
        details: { purpose: action.purpose, status: result.status, metaCode: result.metaCode, metaSubcode: result.metaSubcode, ...(errorClass ? { errorClass } : {}) },
        at: now(),
      });
    } catch (err) {
      // The message has already gone or failed: losing its log row must not change what the caller is told.
      reportError(err, { msg: 'compliance.log_failed', kind: action.kind });
    }
  }

  async function needsHuman(job, kind, reason) {
    await db.query(
      `INSERT INTO needs_human_items (tenant_id, channel, job_id, kind, reason, subject_hash, comment_id, media_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
      [tenantId(), job.channel, job.id, kind, reason, job.subject_hash, job.comment_id, job.media_id, now()],
    );
  }

  async function claimCaps(t, specs, { action, jobId, at, overrides, readOnly }) {
    const business = tenantId();
    for (const spec of specs) {
      const limit = Math.min(spec.limit ?? 1, overrides?.[spec.cap] ?? Infinity);
      if (limit <= 0) return spec.cap;
      if (spec.scope) {
        if (readOnly) {
          const [row] = await t.query('SELECT 1 FROM cap_claims WHERE tenant_id = $1 AND channel = $2 AND cap = $3 AND subject_hash = $4 AND scope_key = $5', [business, action.channel, spec.cap, spec.subject, spec.scope]);
          if (row) return spec.cap;
          continue;
        }
        const rows = await t.query(
          `INSERT INTO cap_claims (tenant_id, channel, cap, subject_hash, scope_key, automation_id, job_id, claimed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
           ON CONFLICT (tenant_id, channel, cap, subject_hash, scope_key) WHERE scope_key <> '' DO NOTHING RETURNING id`,
          [business, action.channel, spec.cap, spec.subject, spec.scope, action.automationId ?? null, jobId, at],
        );
        if (!rows.length) return spec.cap;
      } else {
        const [{ n }] = await t.query(
          `SELECT count(*)::int AS n FROM cap_claims WHERE tenant_id = $1 AND channel = $2 AND cap = $3 AND subject_hash = $4 AND claimed_at > $5::timestamptz`,
          [business, action.channel, spec.cap, spec.subject, new Date(+at - spec.windowMs)],
        );
        if (n >= limit) return spec.cap;
        if (!readOnly) {
          await t.query(
            `INSERT INTO cap_claims (tenant_id, channel, cap, subject_hash, scope_key, automation_id, job_id, claimed_at, expires_at) VALUES ($1, $2, $3, $4, '', $5, $6, $7::timestamptz, $8::timestamptz)`,
            [business, action.channel, spec.cap, spec.subject, action.automationId ?? null, jobId, at, new Date(+at + spec.windowMs)],
          );
        }
      }
    }
    return null;
  }

  /** Inside a transaction. Null when this idempotency key has been used. */
  async function insertJob(t, { action, status, reason = '', subject, runAt, at, payload, isTest, lockedBy = null, leaseUntil = null, attempts = 0, tokenVersion = null }) {
    const account = (channel) => (action.channel === channel ? action.accountId : null);
    const [row] = await t.query(
      `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, fb_page_id, wa_phone_number_id, kind, purpose, idempotency_key, status, reason, automation_id, variant_id, media_id, comment_id, recipient_id,
         subject_hash, payload, expires_at, run_at, is_test, locked_by, lease_until, attempts, token_version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $25, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17::timestamptz, $18::timestamptz, $19, $20, $21::timestamptz, $22, $23, $24::timestamptz, $24::timestamptz)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *`,
      [tenantId(), action.channel, account('instagram'), account('facebook'), action.kind, action.purpose, action.idempotencyKey, status, reason,
        action.automationId ?? null, action.variantId ?? null, action.mediaId ?? '', action.commentId ?? '', action.recipientId ?? '', subject, JSON.stringify(payload), action.expiresAt, runAt, isTest, lockedBy, leaseUntil, attempts, tokenVersion, at, account('whatsapp')],
    );
    return row ?? null;
  }

  const duplicateReason = (action) => {
    if (action.kind === 'private_reply') return 'cap.per_comment';
    return /^(dm_keyword|dm_reply):/.test(action.idempotencyKey) ? 'cap.reply_per_message' : 'webhook.duplicate';
  };

  /** Creates the job and claims its caps in one transaction. Throws CapRefused when a cap says no; the insert is undone with it. */
  async function createJobTx(fields, { capOptions, overrides, readOnly, extraLocks = [] }) {
    const { action, subject, at } = fields;
    const business = tenantId();
    return db.tx(async (t) => {
      if (subject) await lock(t, `${business}:${action.channel}:${subject}`);
      for (const key of extraLocks) await lock(t, key);
      if (subject && action.purpose !== 'manual' && action.purpose !== 'optout_confirm') {
        // Re-read inside the transaction, so a STOP that lands while this job is being created can't slip past.
        const [out] = await t.query('SELECT 1 FROM opt_outs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3', [business, action.channel, subject]);
        if (out) throw new CapRefused('optout');
      }
      const job = await insertJob(t, fields);
      if (!job) return null;
      const refused = await claimCaps(t, capsFor(action, capOptions, subject, limits), { action, jobId: job.id, at, overrides, readOnly });
      if (refused) throw new CapRefused(refused);
      return job;
    });
  }

  const skipResult = (outcome, reason, extra = {}) => ({ ...blank, outcome, reason, ...extra });

  /** A rule said no before there was a job: logged, reported, nothing created. */
  async function refuse(action, subject, outcome, reason) {
    const result = skipResult(outcome, reason);
    await writeLog(action, result, { subject });
    return result;
  }

  const hasTag = (input) => input && typeof input === 'object' && input.tag !== undefined;

  const payloadFor = (action, capOptions, options = {}) => ({
    message: action.message,
    ...(capOptions.trigger ? { trigger: capOptions.trigger } : {}),
    ...(capOptions.inReplyTo ? { inReplyTo: capOptions.inReplyTo } : {}),
    ...(options.fallbackText ? { fallbackText: options.fallbackText } : {}),
    ...(options.legacy ? { legacy: true, publicReply: Boolean(options.publicReply) } : {}),
  });

  const inReplyToOf = (action, options) => options.inReplyTo ?? (/^(?:dm_keyword|dm_reply):(.+)$/.exec(action.idempotencyKey)?.[1] ?? '');

  /** Inserts the job once per idempotency key and claims its caps. A paused business still gets its job, as held. */
  async function enqueue(input, options = {}) {
    tenantId();
    const action = ComplianceAction.parse(input);
    const subject = await subjectOf(action);
    if (hasTag(input)) return refuse(action, subject, 'skipped', 'tag.not_allowed');
    const trigger = triggerOf(action, options);
    const capOptions = { trigger, inReplyTo: inReplyToOf(action, options) };
    const at = now();
    const state = await gate.load(action, { subject, needsLinks: false });
    if (state.automation?.state === 'missing') return refuse(action, subject, 'skipped', 'unmapped');

    const decided = evaluateCreation(action, state, { at: +at, limits });
    if (decided.terminal) return refuse(action, subject, decided.terminal.outcome, decided.terminal.reason);
    if (!state.account) return refuse(action, subject, 'held', 'paused.reconnect');

    const fields = {
      action, status: decided.status, reason: decided.reason, subject, runAt: options.runAt ?? at, at,
      payload: payloadFor(action, capOptions, options),
      isTest: action.isTest || state.dryRun,
    };
    try {
      const job = await createJobTx(fields, { capOptions, overrides: state.capOverrides, readOnly: fields.isTest });
      if (!job) return refuse(action, subject, 'skipped', duplicateReason(action));
      const result = { ...blank, outcome: decided.status, reason: decided.reason, jobId: Number(job.id) };
      await writeLog(action, result, { subject, jobId: job.id });
      return result;
    } catch (err) {
      if (err instanceof CapRefused) return refuse(action, subject, 'skipped', err.reason);
      throw err;
    }
  }

  async function check(input, options = {}) {
    tenantId();
    const action = ComplianceAction.parse(input);
    if (hasTag(input)) return { allow: false, outcome: 'skipped', reason: 'tag.not_allowed' };
    const subject = await subjectOf(action);
    const state = await gate.load(action, { subject, account: options.account });
    const { allow, outcome, reason } = evaluate(action, state, { at: +now(), limits, trigger: triggerOf(action, options) });
    return { allow, outcome, reason };
  }

  function delivered(sent, outcome = 'sent', reason = '') {
    if (sent?.dryRun) return skipResult('would_send', '');
    return { ...blank, outcome, reason, messageId: sent?.messageId ?? sent?.message_id ?? sent?.id ?? null, status: intOrNull(sent?.status), usage: sent?.usage ?? null };
  }

  /** Marks the account for reconnecting and raises the alert (PRD 4.2). One token version is reported once. */
  async function tokenRejected(action, account, err) {
    const facebook = action.channel === 'facebook';
    const registered = channels.get(action.channel);
    const label = registered ? `${action.channel[0].toUpperCase()}${action.channel.slice(1)}` : facebook ? 'Facebook' : 'Instagram';
    if (registered) await Promise.resolve().then(() => registered.tokenRejected?.(action)).catch(swallow('compliance.reconnect_mark_failed'));
    else await db.query(
      `UPDATE ${facebook ? 'fb_pages' : 'ig_accounts'} SET status = 'reconnect_needed', status_reason = 'token.rejected', status_changed_at = $3::timestamptz
       WHERE tenant_id = $1 AND ${facebook ? 'page_id' : 'ig_user_id'} = $2 AND status = 'active'`,
      [tenantId(), action.accountId, now()],
    ).catch(swallow('compliance.reconnect_mark_failed'));
    await writeLog({ ...action, kind: 'token' }, { outcome: 'held', reason: 'token.rejected', status: intOrNull(err.status), metaCode: intOrNull(err.code), metaSubcode: intOrNull(err.subcode) });
    await repos.alerts?.raise({
      kind: 'token.rejected', severity: 'critical', target: action.accountId,
      message: `${label === 'Whatsapp' ? 'WhatsApp' : label} stopped accepting this account's connection. Reconnect it to start sending again.`,
      dedupeKey: `token.rejected:${action.channel}:${action.accountId}:${account?.tokenVersion ?? 0}`,
    }).catch(swallow('compliance.token_alert_failed'));
    await breaker.trip(action.channel, 'token.rejected').catch(swallow('compliance.breaker_failed'));
  }

  /** What Meta's refusal means for this job. Reported, never thrown. */
  async function mapError(err, action, account) {
    const facts = { ...blank, status: intOrNull(err?.status), metaCode: intOrNull(err?.code), metaSubcode: intOrNull(err?.subcode), error: err, usage: err?.usage ?? null };
    const reply = action.kind !== 'dm';
    switch (err?.kind) {
      case 'token_invalid':
        await tokenRejected(action, account, err);
        return { ...facts, outcome: 'held', reason: 'paused.reconnect', errorClass: 'token' };
      case 'throttled':
        return { ...facts, outcome: 'queued', reason: 'rate.throttled', retryAt: await budgets.throttled(action.channel, action.accountId, err.usage), errorClass: 'throttle' };
      case 'buc_throttled': {
        const until = await budgets.bucThrottled(action.channel, action.accountId, err.usage);
        await budgets.startSlowMode(action.channel, action.accountId, 'buc_80002', new Date(+until + SLOW_MODE_AFTER_REGAIN_MS));
        return { ...facts, outcome: 'queued', reason: 'rate.throttled', retryAt: until, errorClass: 'throttle' };
      }
      case 'already_replied': return { ...facts, outcome: 'skipped', reason: 'cap.per_comment' };
      case 'reply_window_closed': return { ...facts, outcome: 'expired', reason: 'expired.7d' };
      case 'window_closed': return { ...facts, outcome: 'skipped', reason: 'window.closed', errorClass: 'policy' };
      case 'recipient_unavailable': return { ...facts, outcome: 'failed', reason: 'recipient.unavailable', blockPerson: true };
      case 'not_found':
        if (reply) return { ...facts, outcome: 'cancelled', reason: 'comment.deleted' };
        return { ...facts, outcome: 'failed', reason: 'send.error' };
      case 'permission':
      case 'cannot_reply':
        return { ...facts, outcome: 'failed', reason: 'send.error', errorClass: 'policy' };
      default:
        if (err?.reason === 'api.host_blocked') return { ...facts, outcome: 'failed', reason: 'api.host_blocked' };
        if (err?.delivery === 'none') return { ...facts, outcome: 'failed', reason: 'send.error', errorClass: 'error' };
        return { ...facts, outcome: 'unknown', reason: 'send.unknown_outcome', errorClass: 'error' };
    }
  }

  const isRich = (message) => Boolean(message.button || message.quickReplies?.length);

  function fallbackMessage(message, fallbackText) {
    if (fallbackText) return { text: fallbackText };
    const url = message.button?.url;
    return { text: url && !message.text.includes(url) ? `${message.text}\n${url}` : message.text };
  }

  /** PRD 4.4: plain text only when Meta proved nothing went out, and only if the plain text passes the gate again. */
  async function tryFallback(err, job, action, state, options) {
    const plain = { ...action, message: fallbackMessage(action.message, options.fallbackText) };
    const again = await gate.load(plain, { subject: state.subject ?? job?.subject_hash ?? '', account: state.account });
    const verdict = evaluate(plain, again, { at: +now(), limits, trigger: options.trigger ?? '' });
    if (!verdict.allow) return mapError(err, action, state.account);
    try {
      return delivered(await dispatch({ ...plain, message: finalMessage(plain, again) }, state.account, options), 'sent_fallback', 'fallback.validation');
    } catch (second) {
      return mapError(second, action, state.account);
    }
  }

  /** One attempt at Meta, with the retries the rules allow: a 190 after a token swap (once), and plain text after a validation error (once). */
  async function attempt(job, action, state, options = {}) {
    const message = finalMessage(action, state);
    try {
      return delivered(await dispatch({ ...action, message }, state.account, options));
    } catch (err) {
      if (err?.kind === 'token_invalid') {
        const fresh = await gate.findAccount(action);
        if (fresh?.token && fresh.tokenVersion !== state.account.tokenVersion) {
          try {
            return delivered(await dispatch({ ...action, message }, fresh, options));
          } catch (second) {
            return mapError(second, action, fresh);
          }
        }
      }
      if (err?.canFallback && isRich(message) && action.kind !== 'public_reply') return tryFallback(err, job, action, state, options);
      return mapError(err, action, state.account);
    }
  }

  /** Writes what happened to the job, then the log row and the rest. Only the job write can fail the caller; everything after it is best effort. */
  async function settle(job, action, result, { direct = false } = {}) {
    const at = now();
    const outcome = direct && (result.outcome === 'queued' || result.outcome === 'held') ? 'failed' : result.outcome;
    const finalResult = { ...result, outcome };
    const delivery = DELIVERED.has(outcome);
    const params = [tenantId(), job.id, outcome, result.reason, result.status, result.metaCode, result.metaSubcode, result.messageId, delivery ? at : null, result.retryAt ?? null, at];
    const update = `UPDATE outbound_jobs SET status = $3, reason = $4, http_status = $5, meta_code = $6, meta_subcode = $7, message_id = COALESCE($8, message_id),
         sent_at = $9::timestamptz, run_at = COALESCE($10::timestamptz, run_at), lease_until = NULL, locked_by = NULL, updated_at = $11::timestamptz
       WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'held', 'sending', 'unknown') RETURNING id`;
    let moved;
    try {
      moved = await db.query(update, params);
    } catch (err) {
      if (!/outbound_jobs_message_idx|duplicate key/i.test(String(err?.message))) throw err;
      params[7] = null; // Meta gave a message id it has given before: the row still has to say what happened.
      moved = await db.query(update, params);
    }
    // Only the settle that really moved the row to delivered counts the DM, so a job is counted once (PRD 5.12).
    if (delivery && moved?.length) await tellAccepted(job, action, at);

    if (NOT_DELIVERED.has(outcome)) await db.query('DELETE FROM cap_claims WHERE tenant_id = $1 AND job_id = $2', [tenantId(), job.id]).catch(swallow('compliance.claim_release_failed'));
    const changed = job.status === 'sending' || job.reason !== result.reason || (outcome !== 'queued' && outcome !== 'held');
    if (changed && !(outcome === 'queued' && !result.reason)) await writeLog(action, finalResult, { subject: job.subject_hash, jobId: job.id, errorClass: result.errorClass });

    await sideEffects(job, action, finalResult).catch(swallow('compliance.side_effects_failed', { job: Number(job.id) }));
    return finalResult;
  }

  async function sideEffects(job, action, result) {
    const { outcome, reason } = result;
    if (result.usage) await noteUsage(action, result.usage);
    if (result.blockPerson && job.subject_hash) await log.addOptOut(action.channel, job.subject_hash, 'send_error', now());
    if (outcome === 'unknown') await needsHuman(job, 'unknown_outcome', reason);
    if (outcome === 'failed' && !/^(content|link)\./.test(reason)) await needsHuman(job, 'send_failed', reason);
    if (outcome === 'failed' && /^(content|link)\./.test(reason)) {
      await repos.alerts?.raise({ kind: reason, severity: 'warning', target: String(job.automation_id ?? ''), message: 'A message couldn’t be sent because it broke a content rule. Check the automation’s message and link.', dedupeKey: `${reason}:${job.automation_id ?? 0}:${Math.floor(+now() / DAY)}` });
    }
    if (DELIVERED.has(outcome)) {
      logger.info('dm.sent', { job: Number(job.id), kind: job.kind, comment: job.comment_id || undefined, media: job.media_id || undefined });
      await afterDelivered(job, action, result);
    }
    if (job.payload?.legacy && (DELIVERED.has(outcome) || outcome === 'unknown' || outcome === 'failed')) {
      await repos.activity.finish(job.comment_id, DELIVERED.has(outcome) ? 'sent' : 'error', reason).catch(swallow('compliance.activity_failed'));
    }
  }

  async function noteUsage(action, usage) {
    await budgets.usage(action.channel, action.accountId, usage);
    if ((usage.percent ?? 0) >= USAGE_SLOW_MODE_PERCENT) {
      await budgets.startSlowMode(action.channel, action.accountId, 'buc_80002', new Date(+now() + SLOW_MODE_AFTER_REGAIN_MS));
      await writeLog({ ...action, kind: 'usage' }, { outcome: 'held', reason: 'rate.usage_header', status: null, metaCode: null, metaSubcode: null });
    }
  }

  async function afterDelivered(job, action, result) {
    const at = now();
    if (action.purpose === 'manual') {
      await db.query(
        `UPDATE inbox_threads SET automation_paused_until = $4::timestamptz, pause_reason = $5, updated_at = $6::timestamptz
         WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3`,
        [tenantId(), action.channel, job.subject_hash, new Date(+at + limits.threadOwnerRepliedMs), THREAD_OWNER_REPLIED, at],
      );
      return;
    }
    if (action.kind !== 'public_reply' && job.subject_hash) {
      await db.query(
        `UPDATE inbox_threads SET last_bot_message_at = $4::timestamptz, updated_at = $4::timestamptz WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3`,
        [tenantId(), action.channel, job.subject_hash, at],
      );
      await db.query(
        `INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, kind, text, mid, job_id, created_at)
         SELECT t.tenant_id, t.id, 'out', 'automation', 'text', $4::text, $5::text, $6::bigint, $7::timestamptz FROM inbox_threads t
         WHERE t.tenant_id = $1 AND t.channel = $2 AND t.subject_hash = $3
         ON CONFLICT (tenant_id, mid) WHERE mid IS NOT NULL DO NOTHING`,
        [tenantId(), action.channel, job.subject_hash, action.message.text, result.messageId, job.id, at],
      );
    }
    if (job.kind === 'private_reply') await schedulePublicReply(job, action);
  }

  /** PRD 4.9: off by default, 5 to 10 variants, never the same one twice running on a media, 20 to 90 s after the DM is confirmed sent. */
  async function schedulePublicReply(job, action) {
    let enabled = false;
    if (job.automation_id) {
      const [row] = await db.query('SELECT public_reply_enabled FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId(), job.automation_id]);
      enabled = Boolean(row?.public_reply_enabled);
    } else if (job.payload?.legacy) {
      enabled = Boolean(job.payload.publicReply);
    }
    if (!enabled || !action.commentId) return;
    const variants = (await repos.brandKit?.get())?.publicReplyVariants ?? [];
    if (variants.length < limits.publicReplyMinVariants) return;

    const at = now();
    const business = tenantId();
    const delay = limits.publicReplyMinDelayMs + random() * (limits.publicReplyMaxDelayMs - limits.publicReplyMinDelayMs);
    const reply = {
      kind: 'public_reply', purpose: 'trigger', channel: action.channel, accountId: action.accountId, idempotencyKey: `public_reply:${action.commentId}`,
      expiresAt: new Date(+at + limits.publicReplyExpiryMs), commentId: action.commentId, mediaId: action.mediaId, automationId: action.automationId,
      isTest: Boolean(job.is_test),
    };
    const state = await gate.load({ ...reply, message: { text: '.' } }, { subject: job.subject_hash, needsLinks: false });
    const overrides = state.capOverrides;
    const decided = evaluateCreation({ ...reply, message: { text: '.' } }, state, { at: +at, limits });
    if (decided.terminal) return void writeLog({ ...reply, message: { text: '' } }, skipResult(decided.terminal.outcome, decided.terminal.reason), { subject: job.subject_hash });
    let text = '';
    try {
      const created = await db.tx(async (t) => {
        if (job.subject_hash) await lock(t, `${business}:${action.channel}:${job.subject_hash}`);
        await lock(t, `public:${business}:${action.mediaId ?? ''}`);
        await lock(t, `public:${business}`);
        const [last] = await t.query(
          `SELECT payload FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND media_id = $3 AND kind = 'public_reply' ORDER BY id DESC LIMIT 1`,
          [business, action.channel, action.mediaId ?? ''],
        );
        const lastText = last?.payload?.message?.text;
        const choices = variants.filter((v) => v !== lastText);
        text = choices[Math.floor(random() * choices.length)];
        const fields = { action: { ...reply, message: { text } }, status: decided.status, reason: decided.reason, subject: job.subject_hash, runAt: new Date(+at + delay), at, payload: { message: { text } }, isTest: reply.isTest };
        const row = await insertJob(t, fields);
        if (!row) return null;
        const refused = await claimCaps(t, capsFor(fields.action, {}, job.subject_hash, limits), { action: fields.action, jobId: row.id, at, overrides, readOnly: reply.isTest });
        if (refused) throw new CapRefused(refused);
        return row;
      });
      if (created) await writeLog({ ...reply, message: { text } }, { ...blank, outcome: decided.status, reason: decided.reason }, { subject: job.subject_hash, jobId: created.id });
    } catch (err) {
      if (!(err instanceof CapRefused)) throw err;
      await writeLog({ ...reply, message: { text } }, skipResult('skipped', err.reason), { subject: job.subject_hash });
    }
  }

  const isErrorOutcome = (result) => result.outcome === 'failed' || result.outcome === 'unknown' || Boolean(result.errorClass);

  /** The breaker's view of a finished attempt. */
  async function observe(action, result, { probe = false, state } = {}) {
    const channel = action.channel;
    const delivery = DELIVERED.has(result.outcome);
    if (probe) await (delivery ? breaker.probeSucceeded(channel) : breaker.probeFailed(channel));
    else if (delivery) await breaker.noteSuccess(channel);
    if (delivery) await budgets.messagingOk(channel, action.accountId, state?.rate);
    if (probe || delivery) return;
    if (result.errorClass === 'throttle') return breaker.noteThrottle(channel);
    if (result.errorClass === 'token') return undefined; // already tripped when the token was refused
    if (isErrorOutcome(result)) return breaker.noteFailure(channel);
    return undefined;
  }

  async function send(input, options = {}) {
    tenantId();
    const action = ComplianceAction.parse(input);
    const subject = await subjectOf(action);
    if (hasTag(input)) return refuse(action, subject, 'skipped', 'tag.not_allowed');
    const trigger = triggerOf(action, options);
    const capOptions = { trigger, inReplyTo: inReplyToOf(action, options) };
    const state = await gate.load(action, { subject, account: options.account });
    state.subject = subject;
    if (state.automation?.state === 'missing') return refuse(action, subject, 'skipped', 'unmapped');

    const at = now();
    const verdict = evaluate(action, state, { at: +at, limits, trigger });
    if (!verdict.allow) {
      if (verdict.outcome === 'queued') return refuse(action, subject, 'held', verdict.reason || 'rate.throttled');
      return refuse(action, subject, verdict.outcome, verdict.reason);
    }
    // A send asked for now has no job to hold, so like a throttled one it is refused as held and the caller decides (enqueue to wait).
    if (!state.dryRun && !(await dmQuotaLeft(action))) return refuse(action, subject, 'held', DM_LIMIT_REASON);
    const budget = budgetFor(action.kind);
    if (budget && !state.dryRun && !(await budgets.take(action.channel, budgetKeyOf(action), budget, budgetMultiplier(state, +at, limits)))) {
      return refuse(action, subject, 'held', 'rate.throttled');
    }

    const fields = {
      action, status: 'sending', subject, runAt: at, at, payload: payloadFor(action, capOptions, options),
      isTest: action.isTest || state.dryRun, lockedBy: workerId, leaseUntil: new Date(+at + limits.leaseMs), attempts: 1, tokenVersion: state.account.tokenVersion ?? null,
    };
    let job;
    try {
      job = await createJobTx(fields, { capOptions, overrides: state.capOverrides, readOnly: fields.isTest });
      if (!job) return refuse(action, subject, 'skipped', duplicateReason(action));
    } catch (err) {
      if (err instanceof CapRefused) return refuse(action, subject, 'skipped', err.reason);
      throw err;
    }

    if (state.dryRun) {
      const result = { ...blank, outcome: 'would_send', reason: '', jobId: Number(job.id) };
      return settle(job, action, result, { direct: true });
    }
    const result = await attempt(job, action, state, { ...options, trigger });
    result.jobId = Number(job.id);
    const told = await settle(job, action, result, { direct: true });
    await observe(action, result, { state }).catch(swallow('compliance.breaker_failed'));
    return told;
  }

  const actionOf = (job) => ({
    kind: job.kind,
    purpose: job.purpose,
    channel: job.channel,
    accountId: job[ACCOUNT_COLUMNS[job.channel]],
    idempotencyKey: job.idempotency_key,
    expiresAt: new Date(job.expires_at),
    message: job.payload?.message ?? { text: '' },
    commentId: job.comment_id || undefined,
    recipientId: job.recipient_id || undefined,
    automationId: job.automation_id ?? undefined,
    variantId: job.variant_id ?? undefined,
    mediaId: job.media_id || undefined,
    isTest: Boolean(job.is_test),
  });

  async function claimOne({ channel, accountId, kind }) {
    const at = now();
    const [job] = await db.query(
      `UPDATE outbound_jobs SET locked_by = $5, lease_until = $6::timestamptz, updated_at = $7::timestamptz
       WHERE tenant_id = $1 AND id = (
         SELECT id FROM outbound_jobs
         WHERE tenant_id = $1 AND channel = $2 AND ${ACCOUNT_ID} = $3 AND kind = $4 AND status = 'queued'
           AND run_at <= $7::timestamptz AND (lease_until IS NULL OR lease_until <= $7::timestamptz)
         ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING *`,
      [tenantId(), channel, accountId, kind, workerId, new Date(+at + limits.leaseMs), at],
    );
    return job ?? null;
  }

  const unlease = (job) => db.query(`UPDATE outbound_jobs SET lease_until = NULL, locked_by = NULL WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`, [tenantId(), job.id]);

  /** Decides and sends one claimed job. { stop: true } means this account has no budget left this tick. */
  async function processJob(job) {
    const action = actionOf(job);
    const trigger = job.payload?.trigger ?? triggerOf(action);
    const state = await gate.load(action, { subject: job.subject_hash });
    state.subject = job.subject_hash;
    let probe = false;
    if (state.breakerBlocks) {
      probe = await breaker.tryProbe(action.channel, limits.leaseMs);
      if (probe) state.breakerBlocks = false;
    }
    const at = now();
    const verdict = evaluate(action, state, { at: +at, limits, trigger });
    if (!verdict.allow) {
      if (probe) await breaker.probeUnused(action.channel);
      await settle(job, action, { ...blank, outcome: verdict.outcome, reason: verdict.reason, retryAt: verdict.retryAt, jobId: Number(job.id) });
      return { sent: false };
    }
    if (state.dryRun) {
      if (probe) await breaker.probeUnused(action.channel);
      await settle(job, action, { ...blank, outcome: 'would_send', reason: '', jobId: Number(job.id) });
      return { sent: false };
    }
    // The month's DMs are used up (PRD 5.12): held, not dropped. It goes when a pack is added, the plan is upgraded or the month resets.
    if (!(await dmQuotaLeft(action, { isTest: job.is_test }))) {
      if (probe) await breaker.probeUnused(action.channel);
      await settle(job, action, { ...blank, outcome: 'held', reason: DM_LIMIT_REASON, jobId: Number(job.id) });
      return { sent: false };
    }
    const budget = budgetFor(action.kind);
    if (budget && !(await budgets.take(action.channel, budgetKeyOf(action), budget, budgetMultiplier(state, +at, limits)))) {
      if (probe) await breaker.probeUnused(action.channel);
      await unlease(job);
      return { stop: true };
    }

    // From here on the call to Meta may happen, so a crash can only mean "unknown". This is the only write that opens that door.
    const [claimed] = await db.query(
      `UPDATE outbound_jobs SET status = 'sending', attempts = attempts + 1, token_version = $4, lease_until = $5::timestamptz, updated_at = $6::timestamptz
       WHERE tenant_id = $1 AND id = $2 AND status = 'queued' AND locked_by = $3 RETURNING id`,
      [tenantId(), job.id, workerId, state.account.tokenVersion ?? null, new Date(+at + limits.leaseMs), at],
    );
    if (!claimed) {
      if (probe) await breaker.probeUnused(action.channel);
      return { sent: false };
    }
    const result = await attempt(job, action, state, { fallbackText: job.payload?.fallbackText, trigger, legacy: Boolean(job.payload?.legacy) });
    result.jobId = Number(job.id);
    await settle({ ...job, status: 'sending' }, action, result);
    await observe(action, result, { probe, state }).catch(swallow('compliance.breaker_failed'));
    return { sent: true };
  }

  async function runStream(stream, perStream) {
    let sent = 0;
    for (let i = 0; i < perStream; i++) {
      const job = await claimOne(stream);
      if (!job) break;
      const done = await processJob(job);
      if (done.sent) sent++;
      if (done.stop) break;
    }
    return sent;
  }

  /** At most a few businesses at a time, and each stream a bounded slice per tick, so one business's queue never delays another's (C-47). */
  async function drainOutbound({ perStream = STREAM_SENDS_PER_TICK, concurrency = FAIRNESS_TENANTS_AT_ONCE } = {}) {
    const at = now();
    const rows = await db.platform.query(
      `SELECT tenant_id, channel, ${ACCOUNT_ID} AS account_id, kind FROM outbound_jobs
       WHERE status = 'queued' AND run_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
       GROUP BY tenant_id, channel, ${ACCOUNT_ID}, kind`,
      [at],
    );
    const byTenant = new Map();
    for (const row of rows) byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), { channel: row.channel, accountId: row.account_id, kind: row.kind }]);
    const queue = [...byTenant.entries()];
    let sent = 0;
    const lane = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const [tenant, streams] = next;
        try {
          await withTenant(tenant, async () => {
            for (const stream of streams) sent += await runStream(stream, perStream);
          });
        } catch (err) {
          reportError(err, { msg: 'compliance.stream_failed', tenant });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, lane));
    return sent;
  }

  /** PRD 4.3: a job whose worker died while Meta was being called has an unknown result and is never sent again. */
  async function recoverStale() {
    const at = now();
    const rows = await db.platform.query(
      `UPDATE outbound_jobs SET status = 'unknown', reason = 'send.unknown_outcome', lease_until = NULL, updated_at = $1::timestamptz
       WHERE status = 'sending' AND lease_until < $1::timestamptz RETURNING *`,
      [at],
    );
    for (const job of rows) {
      await withTenant(job.tenant_id, async () => {
        const action = actionOf(job);
        await writeLog(action, skipResult('unknown', 'send.unknown_outcome'), { subject: job.subject_hash, jobId: job.id, errorClass: 'error' });
        await needsHuman(job, 'unknown_outcome', 'send.unknown_outcome').catch(swallow('compliance.needs_human_failed'));
        await breaker.noteFailure(action.channel).catch(swallow('compliance.breaker_failed'));
      });
    }
    return rows.length;
  }

  /** Drops whatever has passed its expires_at while waiting, with its expiry reason (PRD 4.12). */
  async function expire() {
    const at = now();
    const rows = await db.platform.query(
      `UPDATE outbound_jobs SET status = 'expired', lease_until = NULL, locked_by = NULL, updated_at = $1::timestamptz,
         reason = CASE kind WHEN 'public_reply' THEN 'expired.public_reply' WHEN 'private_reply' THEN 'expired.7d' ELSE 'window.closed' END
       WHERE id IN (SELECT id FROM outbound_jobs WHERE status IN ('queued', 'held') AND expires_at <= $1::timestamptz AND (lease_until IS NULL OR lease_until <= $1::timestamptz) ORDER BY expires_at LIMIT 500)
       RETURNING *`,
      [at],
    );
    for (const job of rows) {
      await withTenant(job.tenant_id, async () => {
        const action = actionOf(job);
        await db.query('DELETE FROM cap_claims WHERE tenant_id = $1 AND job_id = $2', [job.tenant_id, job.id]).catch(swallow('compliance.claim_release_failed'));
        await writeLog(action, skipResult('expired', expiryReason(action)), { subject: job.subject_hash, jobId: job.id });
      });
    }
    return rows.length;
  }

  /** Puts held jobs whose reason has lifted back in the queue, to go at the normal budget, never as a burst (PRD 4.12). */
  async function releaseFor() {
    const business = tenantId();
    const at = now();
    const queuedAgain = `status = 'queued', reason = '', lease_until = NULL, updated_at = $2::timestamptz`;
    const [flags] = await db.query(
      `SELECT (SELECT engaged FROM platform_switches WHERE key = 'global_kill') AS global_kill,
              COALESCE((SELECT paused FROM compliance_settings WHERE tenant_id = $1), false) AS paused,
              (SELECT status FROM tenants WHERE id = $1) AS status`,
      [business],
    );
    if (!flags.global_kill) await db.query(`UPDATE outbound_jobs SET ${queuedAgain} WHERE tenant_id = $1 AND status = 'held' AND reason = 'paused.global'`, [business, at]);
    if (await dmQuotaLeft({ kind: 'dm', purpose: 'release' })) await requeueDmLimit();
    if (!flags.paused && !['paused', 'suspended', 'closed', 'killed'].includes(flags.status)) await db.query(`UPDATE outbound_jobs SET ${queuedAgain} WHERE tenant_id = $1 AND status = 'held' AND reason = 'paused.tenant'`, [business, at]);

    await db.query(
      `UPDATE breakers b SET state = 'closed', trip_reason = '', open_until = NULL, wait_minutes = 30, throttle_cycles = 0, updated_at = $2::timestamptz
       WHERE b.tenant_id = $1 AND b.state <> 'closed' AND b.trip_reason = 'token.rejected' AND b.channel = 'instagram' AND NOT EXISTS (
         SELECT 1 FROM ig_accounts a WHERE a.tenant_id = b.tenant_id AND (a.status <> 'active' OR a.access_token_enc = '' OR a.token_updated_at IS NULL OR a.token_updated_at <= b.opened_at)
       ) AND EXISTS (SELECT 1 FROM ig_accounts a WHERE a.tenant_id = b.tenant_id)`,
      [business, at],
    );
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain} FROM ig_accounts a
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.reconnect' AND j.channel = 'instagram'
         AND a.tenant_id = j.tenant_id AND a.ig_user_id = j.ig_user_id AND a.status = 'active' AND a.access_token_enc <> ''`,
      [business, at],
    );
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain} FROM fb_pages a
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.reconnect' AND j.channel = 'facebook'
         AND a.tenant_id = j.tenant_id AND a.page_id = j.fb_page_id AND a.status = 'active' AND a.access_token_enc <> ''`,
      [business, at],
    );
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain} FROM whatsapp_accounts a
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.reconnect' AND j.channel = 'whatsapp'
         AND a.tenant_id = j.tenant_id AND a.phone_number_id = j.wa_phone_number_id AND a.status = 'active' AND a.access_token_enc <> ''`,
      [business, at],
    );
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain}
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.breaker'
         AND NOT EXISTS (SELECT 1 FROM breakers b WHERE b.tenant_id = j.tenant_id AND b.channel = j.channel AND b.state <> 'closed')`,
      [business, at],
    );
    // A breaker past its wait gets one job back, to be its probe. The others stay held until the probe says so.
    await db.query(
      `UPDATE outbound_jobs SET ${queuedAgain}
       WHERE id IN (
         SELECT DISTINCT ON (j.channel) j.id FROM outbound_jobs j JOIN breakers b ON b.tenant_id = j.tenant_id AND b.channel = j.channel
         WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.breaker' AND j.expires_at > $2::timestamptz AND b.state = 'open' AND b.open_until <= $2::timestamptz
           AND NOT EXISTS (SELECT 1 FROM outbound_jobs q WHERE q.tenant_id = j.tenant_id AND q.channel = j.channel AND q.status = 'queued')
         ORDER BY j.channel, j.run_at, j.id
       )`,
      [business, at],
    );
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain} FROM automations a
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason = 'paused.automation' AND a.tenant_id = j.tenant_id AND a.id = j.automation_id AND a.state IN ('live', 'test')
         AND (a.ends_at IS NULL OR a.ends_at > $2::timestamptz)`,
      [business, at],
    );
    const ended = await db.query(
      `UPDATE outbound_jobs j SET status = 'cancelled', reason = 'cancelled.owner', updated_at = $2::timestamptz FROM automations a
       WHERE j.tenant_id = $1 AND j.status = 'held' AND a.tenant_id = j.tenant_id AND a.id = j.automation_id AND (a.state = 'archived' OR a.ends_at <= $2::timestamptz)
       RETURNING j.*`,
      [business, at],
    );
    for (const job of ended) await afterCancel(job);
    await db.query(
      `UPDATE outbound_jobs j SET ${queuedAgain}
       WHERE j.tenant_id = $1 AND j.status = 'held' AND j.reason IN ('held.review', 'rate.slow_mode')
         AND NOT EXISTS (
           SELECT 1 FROM account_rate_state r WHERE r.tenant_id = j.tenant_id AND r.channel = j.channel AND r.account_id = COALESCE(j.ig_user_id, j.fb_page_id, j.wa_phone_number_id)
             AND r.slow_mode_until > $2::timestamptz AND (r.slow_mode_override_at IS NULL OR r.slow_mode_override_at < r.slow_mode_started_at)
         )`,
      [business, at],
    );
  }

  async function release() {
    const rows = await db.platform.query(`SELECT DISTINCT tenant_id FROM outbound_jobs WHERE status = 'held'`);
    for (const { tenant_id: tenant } of rows) {
      try {
        await withTenant(tenant, releaseFor);
      } catch (err) {
        reportError(err, { msg: 'compliance.release_failed', tenant });
      }
    }
  }

  async function afterCancel(job) {
    await db.query('DELETE FROM cap_claims WHERE tenant_id = $1 AND job_id = $2', [tenantId(), job.id]).catch(swallow('compliance.claim_release_failed'));
    await writeLog(actionOf(job), skipResult('cancelled', job.reason), { subject: job.subject_hash, jobId: job.id });
  }

  /** Cancels this person's jobs that haven't gone. { only: ['followup'] } narrows it to those purposes. Returns how many. */
  async function cancelForPerson(channel, subject, reason, { only } = {}) {
    const purposes = only ? `AND purpose IN (${only.map((p) => `'${p.replace(/[^a-z_]/g, '')}'`).join(',')})` : `AND purpose NOT IN ('manual', 'optout_confirm')`;
    const rows = await db.query(
      `UPDATE outbound_jobs SET status = 'cancelled', reason = $4, lease_until = NULL, locked_by = NULL, updated_at = $5::timestamptz
       WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 AND status IN ('queued', 'held') ${purposes} RETURNING *`,
      [tenantId(), channel, subject, reason, now()],
    );
    for (const job of rows) await afterCancel(job);
    return rows.length;
  }

  /** Cancels what is waiting on one comment: its private reply and any public reply. */
  async function cancelForComment(channel, commentId, reason, filter = () => true) {
    const rows = await db.query(
      `SELECT * FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND comment_id = $3 AND status IN ('queued', 'held')`,
      [tenantId(), channel, commentId],
    );
    let cancelled = 0;
    for (const job of rows) {
      if (!(await filter(job))) continue;
      const [row] = await db.query(
        `UPDATE outbound_jobs SET status = 'cancelled', reason = $3, lease_until = NULL, locked_by = NULL, updated_at = $4::timestamptz
         WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'held') RETURNING *`,
        [tenantId(), job.id, reason, now()],
      );
      if (row) {
        await afterCancel(row);
        cancelled++;
      }
    }
    return cancelled;
  }

  /** The owner discards held jobs (PRD 4.12), or an automation is archived. */
  async function discardHeld({ automationId } = {}) {
    const rows = await db.query(
      `UPDATE outbound_jobs SET status = 'cancelled', reason = 'cancelled.owner', lease_until = NULL, updated_at = $2::timestamptz
       WHERE tenant_id = $1 AND status = 'held' AND ($3::integer IS NULL OR automation_id = $3) RETURNING *`,
      [tenantId(), now(), automationId ?? null],
    );
    for (const job of rows) await afterCancel(job);
    return rows.length;
  }

  const inbound = createInbound({ db, repos, log, meta, now, limits, config, platform, enqueue, cancelForPerson, cancelForComment, consumers, gate, callAllowedNow: (channel, accountId, callClass) => hasCapacity(channel, accountId, callClass) });

  const housekeepingEveryMs = Math.min(limits.switchCacheMs, (config.queuePollMs ?? 500) * 4);
  let lastHousekeeping = 0;

  /** One turn of the worker. Returns how many messages went, so an idle worker can wait and a busy one doesn't. */
  async function pump() {
    await recoverStale();
    await inbound.recover();
    const events = await inbound.drain();
    const at = +now();
    if (at - lastHousekeeping >= housekeepingEveryMs) {
      lastHousekeeping = at;
      await expire();
      await release();
    }
    return events + await drainOutbound();
  }

  let lastHourly = 0;

  /** Every score and retention sweep, once an hour. */
  async function maintain() {
    const at = +now();
    if (at - lastHourly < HOUR) return;
    lastHourly = at;
    await db.platform.query('DELETE FROM inbound_events WHERE received_at < $1::timestamptz', [new Date(at - RAW_WEBHOOK_RETENTION_MS)]);
    // PRD 4.14: a once-only cap key lasts the automation's life plus 90 days.
    await db.platform.query(
      `UPDATE cap_claims c SET expires_at = a.archived_at + interval '90 days' FROM automations a
       WHERE c.expires_at IS NULL AND a.tenant_id = c.tenant_id AND a.id = c.automation_id AND a.archived_at IS NOT NULL`,
    );
    await db.platform.query('DELETE FROM cap_claims WHERE expires_at < $1::timestamptz', [new Date(at)]);
    const since = new Date(at - 7 * DAY);
    await db.platform.query(
      `WITH counts AS (
         SELECT tenant_id,
                count(*) FILTER (WHERE decision IN ('sent', 'sent_fallback')) AS sends,
                count(*) FILTER (WHERE kind = 'optout' OR reason = 'negative_intent' OR decision IN ('failed', 'unknown')) AS bad
         FROM compliance_events WHERE created_at > $1::timestamptz AND channel IS NOT NULL GROUP BY tenant_id
       )
       UPDATE compliance_settings s SET score = LEAST(9999, c.bad * 1000.0 / GREATEST(c.sends, 1)), score_at = $2::timestamptz,
         score_review_needed = s.score_review_needed OR (c.sends >= $3 AND c.bad * 1000.0 / c.sends > $4)
       FROM counts c WHERE c.tenant_id = s.tenant_id`,
      [since, new Date(at), SCORE_MIN_SENDS, SCORE_REVIEW_THRESHOLD],
    );
    logger.info('compliance.maintenance');
  }

  /** True when anything is waiting: a turn of the worker has something to look at. */
  async function hasWork() {
    const [row] = await db.platform.query(
      `SELECT EXISTS (SELECT 1 FROM inbound_events WHERE status IN ('stored', 'processing'))
           OR EXISTS (SELECT 1 FROM outbound_jobs WHERE status IN ('queued', 'held', 'sending')) AS busy`,
    );
    return Boolean(row.busy);
  }

  /** When the next turn is due, in ms from now, or null if nothing is waiting for the clock. Whatever is further off than a minute, schedule() picks up. */
  async function nextWakeMs() {
    const at = +now();
    const [row] = await db.platform.query(`SELECT min(run_at) AS next FROM outbound_jobs WHERE status = 'queued'`);
    const [deferred] = await db.platform.query(`SELECT 1 FROM inbound_events WHERE status = 'stored' LIMIT 1`);
    if (deferred) return WAKE_FLOOR_MS;
    if (!row?.next) return null;
    return Math.min(WAKE_CEILING_MS, Math.max(WAKE_FLOOR_MS, +new Date(row.next) - at));
  }

  /**
   * Asks a worker to take a turn. With no delay this is a fresh row every time, because a key would merge this poke with one that has
   * already run, and an event stored just after it would then wait for the next. A delayed wake-up is keyed by the second it is due.
   */
  async function enqueueTurn(delayMs = 0) {
    if (!platform?.queue) return;
    const options = { retryInFlight: true, maxAttempts: 1, ...(delayMs ? { delayMs, dedupeKey: `wake:${Math.floor((+now() + delayMs) / 1000)}` } : {}) };
    await platform.queue.enqueue(DRAIN_QUEUE, {}, options);
  }

  /** One job's worth of work, on the queue. Bounded, so a stopped worker stops soon and one long backlog can't hold the queue. */
  async function workOnce() {
    const end = Date.now() + WORK_SLICE_MS;
    try {
      let moved;
      do {
        moved = await pump();
      } while (moved > 0 && Date.now() < end);
      const wake = await nextWakeMs();
      if (wake !== null) await enqueueTurn(wake);
    } catch (err) {
      reportError(err, { msg: 'compliance.worker_failed' });
    }
  }

  let workingHere = false;
  let workAgain = false;

  /** With no worker in this process and outside production (a test, or a quick local run), nothing else would ever handle what was stored. */
  function workHere() {
    if (workingHere) {
      workAgain = true;
      return;
    }
    workingHere = true;
    (async () => {
      do {
        workAgain = false;
        await inbound.drain();
        await drainOutbound();
      } while (workAgain);
    })().catch(swallow('compliance.work_here_failed')).finally(() => {
      workingHere = false;
    });
  }

  /** Something new is waiting. PRD 4.1: the web process only stores; a worker handles it. */
  async function poke() {
    const noWorkerAnywhere = !workerRunningHere && process.env.NODE_ENV !== 'production' && config.complianceInline !== false;
    if (noWorkerAnywhere) return workHere();
    return enqueueTurn().catch(swallow('compliance.poke_failed'));
  }

  const hasCapacity = async (channel, accountId, callClass) => callAllowed(await gate.rateState(channel, accountId), callClass, +now());

  async function observeCall(channel, accountId, { kind, usage }) {
    if (usage) await budgets.usage(channel, accountId, usage);
    if (kind === 'buc_throttled') {
      const until = await budgets.bucThrottled(channel, accountId, usage);
      await budgets.startSlowMode(channel, accountId, 'buc_80002', new Date(+until + SLOW_MODE_AFTER_REGAIN_MS));
    }
  }

  return {
    send,
    enqueue,
    check,

    /** Another channel for the gate (PRD 6.12: WhatsApp), registered by its module in setup(ctx). The definition is in channels.js. */
    registerChannel: (name, definition) => channels.register(name, definition),
    channels: () => channels.names(),
    /** '' or the reason nothing may go out on this channel now (paused.global, paused.tenant): what ctx.shopperMessages asks before a WhatsApp send. */
    async sendingPaused(channel, options) {
      tenantId();
      return gate.sendingPaused(channel, options);
    },

    /** Failures are thrown here, because that is what src/handler.js is written against. Nothing in production calls it any more. */
    clientFor(account) {
      const week = () => new Date(+now() + limits.privateReplyExpiryMs);
      const through = async (action) => {
        const result = await send({ channel: 'instagram', accountId: account.igUserId, expiresAt: week(), ...action }, { account, legacy: true });
        if (result.error) throw result.error;
        return result;
      };
      const privateReply = (commentId, message) => through({ kind: 'private_reply', commentId, idempotencyKey: `private_reply:${commentId}`, message });
      return {
        sendPrivateReply: (commentId, text) => privateReply(commentId, { text }),
        sendPrivateReplyButton: (commentId, text, url, title) => privateReply(commentId, { text, button: { url, title } }),
        replyToComment: (commentId, text) => through({ kind: 'public_reply', commentId, idempotencyKey: `public_reply:${commentId}`, message: { text } }),
      };
    },

    /** Intake and the worker. */
    storeDelivery: inbound.storeDelivery,
    poke,
    workOnce,
    hasWork,
    pump,
    drainInbound: inbound.drain,
    recoverInbound: inbound.recover,
    drainOutbound,
    recoverStale,
    release,
    expire,
    maintain,

    /**
     * Metering (PRD 5.12), registered by the usage module in setup(ctx), in the app and in the worker.
     *
     *   useQuota({ hasDmsLeft })   hasDmsLeft({ channel, kind, purpose, automationId }) -> boolean, asked inside the business just
     *                              before an automated private reply or DM would go. False holds the job with held.dm_limit.
     *                              One provider; registering again replaces it; null removes it (unlimited).
     *   onAccepted(fn)             fn({ tenantId, jobId, key, channel, kind, purpose, automated, automationId, at }) once for each
     *                              private reply or DM that Meta accepted, inside the business. Ids only. Never for a test send, a
     *                              dry run or a public reply. `key` is the usage event's idempotency key.
     *   releaseDmLimit()           inside a business, after a pack is added, the plan is upgraded or the month resets: its held
     *                              jobs go back in the queue (unexpired ones; the rest expire as usual) and the worker is woken.
     *                              release(), every minute, does the same for every business the provider says has DMs again.
     */
    useQuota(provider) {
      if (provider !== null && typeof provider?.hasDmsLeft !== 'function') throw new Error('useQuota needs { hasDmsLeft }');
      quota = provider;
    },
    onAccepted(fn) {
      if (typeof fn !== 'function') throw new Error('onAccepted needs a function');
      if (!acceptedListeners.includes(fn)) acceptedListeners.push(fn);
    },
    async releaseDmLimit() {
      tenantId();
      const released = await requeueDmLimit();
      if (released) await poke();
      return released;
    },

    /** A module that acts on inbound events registers here: fn(event). Truthy means "this was mine". See inbound.js for the event. */
    onInbound: (fn) => {
      if (!consumers.includes(fn)) consumers.push(fn);
    },

    /** Reading the rate state, for anything that calls Meta for reasons other than messaging (PRD 4.3). callClass is in gate.js. */
    callAllowed: hasCapacity,
    observeCall,
    /** What meta.client.insightsFor(account, guard) takes: every insights call asks check(callClass) first and reports through observe. */
    insightsGuard: (channel, accountId) => ({
      check: (callClass) => hasCapacity(channel, accountId, callClass),
      observe: (outcome) => observeCall(channel, accountId, outcome),
    }),
    slowMode: createSlowMode({ budgets, gate, now, limits }),
    startSlowMode: (channel, accountId, trigger, until) => budgets.startSlowMode(channel, accountId, trigger, until),
    overrideSlowMode: (channel, accountId) => budgets.overrideSlowMode(channel, accountId),

    /** The two-tap tap, an order, or a handoff cancels a pending follow-up (PRD 4.5). */
    cancelFollowups: (channel, subject, reason = 'cancelled.owner') => cancelForPerson(channel, subject, reason, { only: ['followup'] }),
    discardHeld,

    /** True while new activations are frozen (PRD 4.13). */
    async activationsFrozen() {
      const [row] = await db.query(`SELECT engaged FROM platform_switches WHERE key = 'activations_frozen'`);
      return Boolean(row?.engaged);
    },

    /** PRD 4.4: when a private reply stops being allowed. */
    privateReplyExpiresAt: ({ createdTime, receivedAt }) => inbound.privateReplyExpiresAt({ createdTime, receivedAt }),

    /** Skips the switch cache. For a change made by this process, and for tests. */
    invalidateSwitches: () => gate.invalidate(),
    budgets,
    breaker,
    gate,
    limits,
    log,
    now,
  };
}
