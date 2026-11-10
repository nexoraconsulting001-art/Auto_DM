import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { linkProblem } from '../links/rules.js';
import { checkContent, checkPublicReply, urlsIn, withDisclosure } from './content.js';

/**
 * The rules, as a pure function of a snapshot of the world (PRD 4.3 to 4.12). evaluate() answers "may this go now?" and
 * evaluateCreation() answers "may this be created, and as what?". Both are pure so the edges can be tested exactly;
 * createGate() builds the snapshot.
 *
 * An answer is { allow, outcome, reason, retryAt? }. outcome 'queued' with a retryAt means "not yet": the job stays queued.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RESTORE_MS = 48 * HOUR;
const SLOW_MODE_MEDIA_GAP_MS = 2 * MINUTE;
const BLOCKED_HOSTS_TTL_MS = 5 * MINUTE;

/** Usage headers are only as good as the last call that carried one: with every call paused, nothing would ever refresh them. */
export const USAGE_STALE_MS = 5 * MINUTE;

const OK = Object.freeze({ allow: true, outcome: 'queued', reason: '' });
const deny = (outcome, reason, retryAt) => ({ allow: false, outcome, reason, ...(retryAt ? { retryAt } : {}) });

export function expiryReason(action) {
  if (action.kind === 'public_reply') return 'expired.public_reply';
  return action.kind === 'private_reply' ? 'expired.7d' : 'window.closed';
}

/** The kind of trigger behind a DM: the caller says, or its idempotency key begins with it. */
export function triggerOf(action, options = {}) {
  if (options.trigger) return options.trigger;
  const prefix = /^(story_reply|story_mention|mention|dm_keyword|dm_reply):/.exec(action.idempotencyKey)?.[1];
  return prefix === 'story_mention' ? 'mention' : prefix === 'dm_reply' ? 'dm_keyword' : prefix ?? '';
}

export function slowModeActive(rate, at) {
  if (!rate?.slowModeUntil || +rate.slowModeUntil <= at) return false;
  return !(rate.overrideAt && rate.startedAt && +rate.overrideAt >= +rate.startedAt);
}

/** The lowest multiplier that applies; they never stack (PRD 4.3). Restoring runs at 0.75 for 48h after slow mode ends. */
export function budgetMultiplier(state, at, limits) {
  const reduced = limits.reducedBudgetMultiplier;
  if (slowModeActive(state.rate, at) || state.scoreReviewNeeded || (state.breaker?.reducedUntil && +state.breaker.reducedUntil > at)) return reduced;
  const until = state.rate?.slowModeUntil ? +state.rate.slowModeUntil : 0;
  const overridden = state.rate?.overrideAt && state.rate?.startedAt && +state.rate.overrideAt >= +state.rate.startedAt;
  return until && !overridden && at >= until && at < until + RESTORE_MS ? 0.75 : 1;
}

/** The message as it will really be sent: with the seller's note, on automated DMs only (PRD 4.10). */
export function finalMessage(action, state) {
  const automated = action.purpose !== 'manual' && action.kind !== 'public_reply';
  if (!automated || !state.disclosureEnabled) return action.message;
  return { ...action.message, text: withDisclosure(action.message.text) };
}

function contentProblem(action, state, message) {
  const [problem] = action.kind === 'public_reply'
    ? checkPublicReply(message.text)
    : checkContent({ text: message.text, buttonTitle: message.button?.title ?? '', url: message.button?.url ?? '', quickReplies: message.quickReplies ?? [], filled: true, ownDomain: state.ownDomain });
  if (problem) return problem.reason;
  const context = { whatsappNumber: state.whatsappNumber ?? '', blockedHosts: state.blockedHosts ?? new Map() };
  for (const url of [message.button?.url, ...urlsIn(message.text)].filter(Boolean)) {
    const reason = linkProblem(url, context);
    if (reason) return reason;
  }
  return null;
}

/** thread.handoff or thread.owner_replied while that thread's automation is paused (PRD 4.7). A manual reply is not automation. */
const threadPause = (action, s, at) => (action.kind !== 'public_reply' && s.thread?.pausedUntil && +s.thread.pausedUntil > at && s.thread.pauseReason) || null;

/**
 * Every rule, at the moment of sending. Broadest stop first, so the log names the switch that actually stopped it.
 * s: { globalKill, tenantPaused, breakerBlocks, account, automation, optedOut, thread, rate, disclosureEnabled, lastAutomationDmAt, lastMediaDmAt, ... }
 */
export function evaluate(action, s, { at, limits, trigger = '' }) {
  const automated = action.purpose !== 'manual';
  const personal = automated && action.purpose !== 'optout_confirm';

  if (+action.expiresAt <= at) return deny('expired', expiryReason(action));

  if (s.globalKill) return deny('held', 'paused.global');
  if (s.tenantPaused) return deny('held', 'paused.tenant');
  if (!s.account?.token || s.account.status !== 'active') return deny('held', 'paused.reconnect');
  if (s.breakerBlocks) return deny('held', 'paused.breaker');
  if (automated && s.automation?.state === 'paused') return deny('held', 'paused.automation');
  if (automated && s.automation?.state === 'archived') return deny('cancelled', 'cancelled.owner');

  if (personal && s.optedOut) return deny('skipped', 'optout');
  if (personal) {
    const paused = threadPause(action, s, at);
    if (paused) return deny('skipped', paused);
  }

  const lastUser = s.thread?.lastUserMessageAt ? +s.thread.lastUserMessageAt : null;
  if (action.purpose === 'followup') {
    const ourDm = s.lastAutomationDmAt ? +s.lastAutomationDmAt : null;
    if (!lastUser || !ourDm || lastUser <= ourDm) return deny('skipped', 'followup.no_response');
  }
  if (action.kind === 'dm' && (lastUser === null || at - lastUser >= limits.messagingWindowMs)) {
    return deny('skipped', trigger === 'mention' ? 'mention.no_window' : 'window.closed');
  }
  if (action.purpose === 'followup' && at < lastUser + limits.followupMinDelayMs) {
    return deny('queued', '', new Date(lastUser + limits.followupMinDelayMs));
  }

  const message = finalMessage(action, s);
  const problem = contentProblem(action, s, message);
  if (problem) return deny('failed', problem);

  const rate = s.rate;
  if (action.kind === 'public_reply') {
    if (slowModeActive(rate, at)) return deny('held', 'rate.slow_mode');
    if (rate?.otherPausedUntil && +rate.otherPausedUntil > at) return deny('queued', 'rate.usage_header', rate.otherPausedUntil);
    if (freshUsage(rate, at) >= 75) return deny('queued', 'rate.usage_header', new Date(at + USAGE_STALE_MS));
    return OK;
  }
  if (rate?.messagingPausedUntil && +rate.messagingPausedUntil > at) return deny('queued', 'rate.throttled', rate.messagingPausedUntil);
  if (slowModeActive(rate, at) && s.lastMediaDmAt && at - +s.lastMediaDmAt < SLOW_MODE_MEDIA_GAP_MS) {
    return deny('queued', 'rate.slow_mode', new Date(+s.lastMediaDmAt + SLOW_MODE_MEDIA_GAP_MS));
  }
  return OK;
}

const freshUsage = (rate, at) => (rate?.usageAt && at - +rate.usageAt <= USAGE_STALE_MS ? rate.usagePercent ?? 0 : 0);

/**
 * Whether a call that isn't a message may run (PRD 4.3). Rows 75 and 90 are the usage header; 80002 pauses everything here until the
 * regain time. Token refresh and subscribed_apps always run.
 */
export function callAllowed(rate, callClass, at) {
  if (callClass === 'token_refresh' || callClass === 'subscribed_apps') return { allow: true, reason: '' };
  if (rate?.otherPausedUntil && +rate.otherPausedUntil > at) return { allow: false, reason: 'rate.usage_header', retryAt: rate.otherPausedUntil };
  const usage = freshUsage(rate, at);
  if (usage >= 90) return { allow: false, reason: 'rate.usage_header' };
  if (usage >= 75 && ['insights', 'public_reply', 'media_list'].includes(callClass)) return { allow: false, reason: 'rate.usage_header' };
  return { allow: true, reason: '' };
}

/**
 * The rules at job creation (PRD 4.6, 4.12): the blocklist and the thread here, caps in the same transaction as the insert.
 * Anything paused is still created, as held. A window is not checked here: it is a fact about the moment of sending.
 * Returns { terminal } with the answer, or { status, reason } to create the job as.
 */
export function evaluateCreation(action, s, { at, limits }) {
  const automated = action.purpose !== 'manual';
  const personal = automated && action.purpose !== 'optout_confirm';

  if (+action.expiresAt <= at) return { terminal: deny('expired', expiryReason(action)) };
  if (personal && s.optedOut) return { terminal: deny('skipped', 'optout') };
  if (personal) {
    const paused = threadPause(action, s, at);
    if (paused) return { terminal: deny('skipped', paused) };
  }
  if (automated && s.automation?.state === 'archived') return { terminal: deny('cancelled', 'cancelled.owner') };

  if (s.globalKill) return { status: 'held', reason: 'paused.global' };
  if (s.tenantPaused) return { status: 'held', reason: 'paused.tenant' };
  if (s.account && s.account.status !== 'active') return { status: 'held', reason: 'paused.reconnect' };
  if (s.breakerBlocks) return { status: 'held', reason: 'paused.breaker' };
  if (automated && s.automation?.state === 'paused') return { status: 'held', reason: 'paused.automation' };
  if (action.kind === 'public_reply' && slowModeActive(s.rate, at)) return { status: 'held', reason: 'rate.slow_mode' };
  // PRD 4.3 keeps live automations sending in slow mode; it is an automation made since slow mode began that waits for review.
  if (slowModeActive(s.rate, at) && s.automation?.created_at && +new Date(s.automation.created_at) >= +new Date(s.rate.startedAt)) return { status: 'held', reason: 'held.review' };
  return { status: 'queued', reason: '' };
}

/** Builds the snapshot evaluate() reads. Switches come from a cache of at most COMPLIANCE_LIMITS.switchCacheMs (PRD 4.12). */
export function createGate({ db, repos, config, now, limits }) {
  const switchCache = new Map();
  let blockedHosts = { at: 0, map: new Map() };

  async function switches(channel) {
    const business = tenantId();
    const key = `${business}:${channel}`;
    const at = +now();
    const hit = switchCache.get(key);
    if (hit && at - hit.at < limits.switchCacheMs) return hit.value;
    const [row] = await db.query(
      `SELECT (SELECT engaged FROM platform_switches WHERE key = 'global_kill') AS global_kill, t.status AS tenant_status,
              s.paused, s.paused_by, s.pause_store, s.dry_run, s.disclosure_enabled, s.utm_enabled, s.cap_overrides, s.score_review_needed,
              b.state AS breaker_state, b.open_until, b.reduced_until, b.opened_at, b.updated_at AS breaker_updated_at, b.trip_reason
       FROM tenants t
       LEFT JOIN compliance_settings s ON s.tenant_id = t.id
       LEFT JOIN breakers b ON b.tenant_id = t.id AND b.channel = $2
       WHERE t.id = $1`,
      [business, channel],
    );
    const value = {
      globalKill: Boolean(row?.global_kill),
      tenantPaused: Boolean(row?.paused) || ['paused', 'suspended', 'closed', 'killed'].includes(row?.tenant_status),
      pausedBy: row?.paused_by ?? null,
      pauseStore: Boolean(row?.pause_store),
      dryRun: Boolean(row?.dry_run) || Boolean(config.dryRun),
      disclosureEnabled: Boolean(row?.disclosure_enabled),
      capOverrides: row?.cap_overrides ?? {},
      scoreReviewNeeded: Boolean(row?.score_review_needed),
      breaker: { state: row?.breaker_state ?? 'closed', openUntil: row?.open_until ?? null, reducedUntil: row?.reduced_until ?? null, openedAt: row?.opened_at ?? null, updatedAt: row?.breaker_updated_at ?? null, tripReason: row?.trip_reason ?? '' },
    };
    switchCache.set(key, { at, value });
    return value;
  }

  /** Call after this process changes a switch, so it doesn't wait out its own cache. */
  const invalidate = () => switchCache.clear();

  async function findAccount(action, known) {
    const facebook = action.channel === 'facebook';
    let account = known ?? null;
    if (!account) {
      try {
        account = facebook ? await repos.fbPages?.get(action.accountId) : await repos.igAccounts?.get(action.accountId);
      } catch (err) {
        // A token that can no longer be decrypted is an account that needs reconnecting, never a crash in the send path.
        reportError(err, { msg: 'compliance.account_unreadable', account: action.accountId });
        account = { token: '' };
      }
    }
    const [row] = await db.query(
      `SELECT status, token_version, token_updated_at FROM ${facebook ? 'fb_pages' : 'ig_accounts'} WHERE tenant_id = $1 AND ${facebook ? 'page_id' : 'ig_user_id'} = $2`,
      [tenantId(), action.accountId],
    );
    if (!row) return null; // not this business's account
    return { ...(account ?? { token: '' }), status: row.status, tokenVersion: row.token_version, tokenUpdatedAt: row.token_updated_at };
  }

  async function personState(channel, subject) {
    if (!subject) return { optedOut: false, thread: null };
    const [row] = await db.query(
      `SELECT (SELECT 1 FROM opt_outs o WHERE o.tenant_id = $1 AND o.channel = $2 AND o.subject_hash = $3) IS NOT NULL AS opted_out,
              t.last_user_message_at, t.automation_paused_until, t.pause_reason, t.id AS thread_id
       FROM (SELECT 1) x LEFT JOIN inbox_threads t ON t.tenant_id = $1 AND t.channel = $2 AND t.subject_hash = $3`,
      [tenantId(), channel, subject],
    );
    return {
      optedOut: Boolean(row?.opted_out),
      thread: row?.thread_id ? { id: row.thread_id, lastUserMessageAt: row.last_user_message_at, pausedUntil: row.automation_paused_until, pauseReason: row.pause_reason } : null,
    };
  }

  async function rateState(channel, accountId) {
    const [row] = await db.query('SELECT * FROM account_rate_state WHERE tenant_id = $1 AND channel = $2 AND account_id = $3', [tenantId(), channel, accountId]);
    if (!row) return null;
    return {
      messagingPausedUntil: row.messaging_paused_until,
      backoffMinutes: row.backoff_minutes,
      otherPausedUntil: row.other_paused_until,
      usagePercent: row.usage_percent,
      usageAt: row.usage_at,
      startedAt: row.slow_mode_started_at,
      slowModeUntil: row.slow_mode_until,
      slowModeTrigger: row.slow_mode_trigger,
      overrideAt: row.slow_mode_override_at,
    };
  }

  async function automationState(id) {
    if (!id) return null;
    const [row] = await db.query('SELECT state, ends_at, dry_run, public_reply_enabled, keywords, match_mode, created_at FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
    return row ?? { state: 'missing' };
  }

  async function lastDmAt(channel, subject, automationId) {
    if (!subject) return null;
    const [row] = await db.query(
      `SELECT max(sent_at) AS at FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 AND status IN ('sent', 'sent_fallback')
         AND ($4::integer IS NULL OR automation_id = $4) AND purpose <> 'followup'`,
      [tenantId(), channel, subject, automationId ?? null],
    );
    return row?.at ?? null;
  }

  async function lastOnMedia(action) {
    const [row] = await db.query(
      `SELECT max(sent_at) AS at FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND media_id = $3 AND kind <> 'public_reply' AND status IN ('sent', 'sent_fallback')`,
      [tenantId(), action.channel, action.mediaId],
    );
    return row?.at ?? null;
  }

  async function hostBlocklist() {
    const at = +now();
    if (at - blockedHosts.at > BLOCKED_HOSTS_TTL_MS || !blockedHosts.at) {
      const rows = await db.query('SELECT host, category FROM link_blocked_hosts');
      blockedHosts = { at, map: new Map(rows.map((r) => [r.host, r.category])) };
    }
    return blockedHosts.map;
  }

  /** Everything evaluate() needs for this action. Reads only. */
  async function load(action, { subject = '', account: known, needsLinks = true } = {}) {
    const at = +now();
    const sw = await switches(action.channel);
    const breakerBlocks = sw.breaker.state !== 'closed';
    const [account, person, rate, automation] = [
      await findAccount(action, known),
      await personState(action.channel, subject),
      await rateState(action.channel, action.accountId),
      await automationState(action.automationId),
    ];
    const state = { ...sw, breakerBlocks, account, ...person, rate, automation, ownDomain: config.platformDomain ?? '' };
    state.dryRun = sw.dryRun || Boolean(automation?.dry_run);
    state.isTest = action.isTest;
    if (action.purpose === 'followup') state.lastAutomationDmAt = await lastDmAt(action.channel, subject, action.automationId);
    if (slowModeActive(rate, at) && action.mediaId) state.lastMediaDmAt = await lastOnMedia(action);
    if (needsLinks && (action.message.button?.url || /https?:\/\//i.test(action.message.text))) {
      state.blockedHosts = await hostBlocklist();
      const settings = await repos.settings?.getAll?.();
      state.whatsappNumber = settings?.support_whatsapp ?? '';
    }
    return state;
  }

  return { load, findAccount, invalidate, rateState, switches };
}
