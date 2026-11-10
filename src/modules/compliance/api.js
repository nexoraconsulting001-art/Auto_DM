import { ApiError } from '../../contracts/api/index.js';
import { writeAudit } from '../audit/index.js';
import { tenantId } from '../../tenancy.js';

const EXPLANATIONS = Object.freeze({
  '': 'This went through normally.',
  optout: 'This person asked not to get automated messages.',
  negative_intent: 'The comment read like a complaint, so no sales link went out. It’s in “Needs a human”.',
  'window.closed': 'It has been more than 24 hours since this person last messaged you.',
  'expired.7d': 'Instagram only allows a reply within 7 days of the comment.',
  'expired.public_reply': 'The public reply waited too long to be useful.',
  'followup.no_response': 'A follow-up only goes after the person has replied.',
  'mention.no_window': 'A mention on its own doesn’t allow a DM.',
  'cap.per_comment': 'This comment already got its one reply.',
  'cap.per_media': 'This person already got a DM for this post.',
  'cap.per_person_24h': 'This person reached the daily limit of DMs.',
  'cap.mention_7d': 'This person already got a DM for a mention this week.',
  'cap.followup': 'This person already got a follow-up for this automation.',
  'cap.welcome_once': 'This person already got the welcome message.',
  'cap.reply_per_message': 'This message already got an automated reply.',
  'cap.dm_replies_24h': 'This person reached the daily limit of automated replies.',
  own_account: 'This was your own comment.',
  own_thread: 'This was a reply under your own comment.',
  unsupported_media: 'Comments on ads and Live aren’t answered.',
  unmapped: 'No automation is set up for this post.',
  no_keyword: 'The comment didn’t have one of the keywords.',
  too_short: 'The comment was too short to act on.',
  test_mode: 'This automation is in Test, and the person isn’t a tester.',
  'automation.draft': 'This automation is still a draft.',
  outside_hours: 'This came in outside the automation’s hours.',
  'comment.deleted': 'The comment was deleted before the reply went out.',
  'comment.edited': 'The comment was edited, so it no longer asks for this.',
  'recipient.unavailable': 'Instagram says this person can’t be messaged.',
  'thread.handoff': 'The person asked for a human, so automation is paused in this chat.',
  'thread.owner_replied': 'You replied yourself, so automation is paused in this chat.',
  'send.unknown_outcome': 'Instagram didn’t confirm this. We won’t resend it, in case it arrived.',
  'send.error': 'Instagram refused this message.',
});
const pausedText = 'Automation was paused when this came in. It’s waiting for you, if it hasn’t expired.';

function explain(reason) {
  if (Object.hasOwn(EXPLANATIONS, reason)) return EXPLANATIONS[reason];
  if (reason.startsWith('paused.') || reason.startsWith('held.') || reason.startsWith('rate.')) return pausedText;
  if (reason.startsWith('content.') || reason.startsWith('link.')) return 'The message or its link broke a content rule. Check the automation.';
  return 'See the reason code for details.';
}

const OWNER_ONLY_MESSAGE = 'Owner only.';
const SUPPORT_PAUSE = 'Paused by support. Contact support.';

/** What an owner may type to override slow mode (PRD 4.3). The wording isn't set yet, so the screen can pick any of these. */
export const SLOW_MODE_CONFIRMATIONS = Object.freeze(['override', 'override slow mode', 'i understand', 'confirm']);

function capDefaults(limits) {
  return {
    'cap.per_comment': 1, 'cap.per_media': 1, 'cap.mention_7d': 1, 'cap.followup': 1, 'cap.welcome_once': 1, 'cap.reply_per_message': 1,
    'cap.per_person_24h': limits.capPerPerson24h, 'cap.dm_replies_24h': limits.capDmReplies24h,
    'cap.public_reply_media_h': limits.publicRepliesPerMediaHour, 'cap.public_reply_tenant_h': limits.publicRepliesPerTenantHour,
  };
}

const settingsOf = (row) => ({ dryRun: row.dry_run, disclosureEnabled: row.disclosure_enabled, utmEnabled: row.utm_enabled, capOverrides: row.cap_overrides ?? {} });

/** The seller API's compliance routes (src/contracts/api/compliance.js). Takes ctx lazily, because a test reads the route ids with an empty one. */
export function complianceApi(ctx) {
  const { repos, compliance, db } = ctx;
  const repo = () => repos.compliance;
  const actor = (user) => `user:${user.id}`;

  async function status() {
    const business = tenantId();
    const row = await repo().settings();
    const [flags] = await db.query(
      `SELECT (SELECT engaged FROM platform_switches WHERE key = 'global_kill') AS global_kill,
              EXISTS (SELECT 1 FROM ig_accounts WHERE tenant_id = $1 AND status <> 'active') AS reconnect,
              COALESCE((SELECT state FROM breakers WHERE tenant_id = $1 AND channel = 'instagram'), 'closed') AS breaker,
              (SELECT count(*)::int FROM outbound_jobs WHERE tenant_id = $1 AND status = 'held') AS held`,
      [business],
    );
    const [rate] = await db.query(
      `SELECT slow_mode_until, slow_mode_trigger, slow_mode_started_at, slow_mode_override_at FROM account_rate_state
       WHERE tenant_id = $1 AND slow_mode_until IS NOT NULL ORDER BY slow_mode_until DESC LIMIT 1`,
      [business],
    );
    const accounts = await db.query(`SELECT granted_scopes FROM ig_accounts WHERE tenant_id = $1 AND access_token_enc <> ''`, [business]);
    const scopesOk = accounts.some((a) => ['instagram_business_manage_messages', 'instagram_business_manage_comments'].every((s) => a.granted_scopes.includes(s)));
    const now = +(compliance?.now?.() ?? new Date());
    const until = rate?.slow_mode_until ?? null;
    const overridden = rate?.slow_mode_override_at && rate?.slow_mode_started_at && +new Date(rate.slow_mode_override_at) >= +new Date(rate.slow_mode_started_at);
    const active = Boolean(until && +new Date(until) > now && !overridden);
    return {
      paused: row.paused,
      pausedBy: row.paused_by,
      canResume: !row.paused || row.paused_by === 'owner',
      pauseStore: row.pause_store,
      globalPause: Boolean(flags.global_kill),
      reconnectNeeded: Boolean(flags.reconnect),
      breaker: flags.breaker,
      slowMode: { active, until: active ? until : null, canOverride: active && rate.slow_mode_trigger === 'reach_drop' },
      heldJobs: flags.held,
      gates: [
        { code: 'gate.access_level', passed: row.access_level === 'advanced' || row.app_role_ok },
        { code: 'gate.scope_missing', passed: scopesOk },
        { code: 'gate.privacy_url', passed: Boolean(row.privacy_url_ok_at) },
        { code: 'gate.deletion_callback', passed: Boolean(row.deletion_callback_ok_at) },
      ],
    };
  }

  return {
    'compliance.status': status,

    'compliance.pause': async ({ body, user }) => {
      const business = tenantId();
      await repo().settings();
      await db.tx(async (t) => {
        // A pause by support stays one: the owner's own pause can't turn it into something the owner can lift.
        await t.query(
          `UPDATE compliance_settings SET paused = true, paused_by = COALESCE(CASE WHEN paused THEN paused_by END, 'owner'), paused_at = COALESCE(paused_at, now()), pause_store = $2, updated_at = now() WHERE tenant_id = $1`,
          [business, body.pauseStore],
        );
        await writeAudit(t, { actor: actor(user), action: 'compliance.pause', target: String(business), details: { pauseStore: body.pauseStore } });
      });
      compliance.invalidateSwitches();
      return status();
    },

    'compliance.resume': async ({ user }) => {
      const row = await repo().settings();
      if (row.paused && row.paused_by !== 'owner') throw new ApiError('forbidden', SUPPORT_PAUSE, { reason: 'paused.tenant' });
      if (!row.paused) return status();
      const business = tenantId();
      await db.tx(async (t) => {
        await t.query(`UPDATE compliance_settings SET paused = false, paused_by = NULL, paused_at = NULL, pause_store = false, pause_reason = '', updated_at = now() WHERE tenant_id = $1`, [business]);
        await writeAudit(t, { actor: actor(user), action: 'compliance.resume', target: String(business) });
      });
      compliance.invalidateSwitches();
      await compliance.poke();
      return status();
    },

    'compliance.settings': async () => settingsOf(await repo().settings()),

    'compliance.updateSettings': async ({ body, user }) => {
      const defaults = capDefaults(compliance.limits);
      const fields = {};
      for (const [cap, value] of Object.entries(body.capOverrides ?? {})) {
        if (value > defaults[cap]) fields[`capOverrides.${cap}`] = `This limit can only be lowered. The most it can be is ${defaults[cap]}.`;
      }
      if (Object.keys(fields).length) throw new ApiError('validation_failed', 'A limit can only be lowered.', { fields });
      const row = await repo().updateSettings(body);
      await repos.audit.record({ actor: actor(user), action: 'compliance.settings', target: String(tenantId()), details: { fields: Object.keys(body) } });
      compliance.invalidateSwitches();
      return settingsOf(row);
    },

    'compliance.activity': ({ query }) => repo().activity(query),

    'compliance.whyNoDm': async ({ query }) => {
      const row = await repo().latestForComment(query.commentId);
      if (!row) return null;
      return { commentId: query.commentId, outcome: row.decision, reason: row.reason, explanation: explain(row.reason), at: row.created_at };
    },

    'compliance.heldJobs': ({ query }) => repo().heldJobs(query),

    'compliance.discardHeld': async ({ body, user }) => {
      const discarded = await compliance.discardHeld({ automationId: body.automationId });
      await repos.audit.record({ actor: actor(user), action: 'compliance.discard_held', target: String(body.automationId ?? ''), details: { discarded } });
      return { discarded };
    },

    'compliance.slowModeOverride': async ({ body, user }) => {
      if (user.role !== 'owner') throw new ApiError('forbidden', OWNER_ONLY_MESSAGE);
      if (!SLOW_MODE_CONFIRMATIONS.includes(body.confirmation.trim().toLowerCase())) throw new ApiError('validation_failed', 'Type “override” to confirm.', { reason: 'rate.slow_mode' });
      const accounts = await db.query(
        `SELECT channel, account_id FROM account_rate_state WHERE tenant_id = $1 AND slow_mode_trigger = 'reach_drop' AND slow_mode_until > $2::timestamptz`,
        [tenantId(), compliance.now()],
      );
      let done = 0;
      for (const a of accounts) if (await compliance.overrideSlowMode(a.channel, a.account_id)) done++;
      if (!done) throw new ApiError('conflict', 'Slow mode can only be overridden when a drop in reach started it.', { reason: 'rate.slow_mode' });
      await repos.audit.record({ actor: actor(user), action: 'compliance.slow_mode_override', target: String(tenantId()) });
      return status();
    },

    'compliance.words': ({ query }) => repo().listWords(query.list),

    'compliance.addWord': async ({ body, user }) => {
      const word = await repo().addWord(body.list, body.word);
      if (!word) throw new ApiError('conflict', 'That word is already on the list.');
      await repos.audit.record({ actor: actor(user), action: 'compliance.word_added', target: body.list });
      return word;
    },

    'compliance.removeWord': async ({ params, user }) => {
      if (!(await repo().removeWord(params.id))) throw new ApiError('not_found');
      await repos.audit.record({ actor: actor(user), action: 'compliance.word_removed', target: String(params.id) });
    },
  };
}
