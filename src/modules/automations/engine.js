import crypto from 'node:crypto';
import { COMPLIANCE_LIMITS as L } from '../../contracts/compliance.js';
import { tenantId } from '../../tenancy.js';
import { directLink } from '../links/rules.js';
import { windowOpen } from './inbox.js';
import { hasWords, isTooShort, matchesKeywords } from './match.js';
import { chooseVariant, firstMessage, parseFaqPayload, parseTwoTapPayload, plainMessage, render, twoTapPayload } from './message.js';
import { scheduleStatus } from './schedule.js';

const MEDIA_LABELS = Object.freeze({ REELS: 'reel', FEED: 'post' });
const LAUNCHED = new Set(['live', 'test']);
const INBOX_RETENTION = `interval '30 days'`;
const MAX_KEY_PART = 150;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 40);
/** A message id as part of an idempotency key: they run long, and a key stops at 200 characters. */
const keyPart = (mid) => (String(mid).length > MAX_KEY_PART ? sha(mid) : String(mid));
/** Outside text on its way to Postgres, which can't store a NUL. */
const clean = (text) => (typeof text === 'string' ? text.replaceAll('\0', '') : '');

/**
 * Decides which automation answers what people do on Instagram (PRD 6.1 to 6.5, 6.9), and what it says. The webhook worker in the
 * compliance module has already stored the event and applied its rules: by the time one gets here it isn't the business's own, a STOP,
 * a request for a person or, on mapped media, a complaint. It reaches this through onInboundEvent.
 *
 * Every message is handed over with compliance.enqueue(), which claims the caps with the job, and its worker sends it through
 * compliance.send(). "Send test" goes through send() directly. Nothing here calls Meta to send.
 *
 * deps: { db, repos, compliance, meta, config, now }. `repos` are the unbound ones, so everything but housekeeping runs inside withTenant().
 */
export function createAutomationEngine({ db, repos, compliance, meta, config = {}, now = config.complianceNow ?? Date.now }) {
  const clock = () => new Date(now());
  const eventTime = (event) => new Date(Math.min(event.timestamp ?? now(), now()));

  /** Writes a decision to the compliance log. */
  const decide = (event, decision, reason, automationId = null) => repos.compliance.record({
    channel: event.channel, kind: event.type, subject: event.subject, decision, reason, automationId, mediaId: event.mediaId ?? '', commentId: event.commentId ?? '',
  });
  const skip = (event, reason, automationId) => decide(event, 'skipped', reason, automationId);

  const accountFor = async (channel, accountId) => (channel === 'facebook' ? repos.fbPages?.get(accountId) : repos.igAccounts.get(accountId));

  /** Someone's first name, or '' when Meta won't say (PRD 4.10: availability is to confirm). */
  async function firstNameOf({ channel, accountId, personId }) {
    try {
      const account = await accountFor(channel, accountId);
      if (!account?.token || !meta?.client) return '';
      const person = await meta.client.forAccount(account).getPerson(personId);
      return clean(person?.name).trim().split(/\s+/)[0] ?? '';
    } catch {
      return '';
    }
  }

  /** Why this automation can't take an event, or null. A paused one can: the gate creates the job as held (PRD 4.12). */
  function stateBlock(automation) {
    if (automation.state === 'draft') return 'automation.draft';
    if (automation.state === 'archived') return 'unmapped';
    if (automation.schedule.endsAt && clock() >= new Date(automation.schedule.endsAt)) return 'paused.automation';
    return null;
  }

  /** Whether the automation may take this event. If not, the reason has been logged. */
  async function admit(automation, event, tester) {
    const blocked = stateBlock(automation) ?? (automation.state === 'test' && !tester ? 'test_mode' : null);
    if (blocked) await skip(event, blocked, automation.id);
    return !blocked;
  }

  async function linkFor(automation, { channel, mediaId = '', variantLabel = '' }) {
    if (!automation.linkUrl) return '';
    const settings = await repos.automations.sendSettings();
    const measurement = ['amazon', 'affiliate'].includes(automation.linkType) && mediaId ? await repos.automations.measurement(mediaId) : {};
    return directLink({ url: automation.linkUrl, linkType: automation.linkType, channel, automationSlug: automation.slug, mediaId, variantLabel, utmEnabled: settings.utm, measurement });
  }

  /** Outside its hours a job is created held, with its caps claimed, and released when the hours arrive; or it isn't created at all (PRD 6.8). */
  async function hours(automation) {
    const status = scheduleStatus(automation.schedule, clock(), await repos.automations.timeZone());
    if (status.open) return { open: true };
    if (status.ended) return { reason: 'paused.automation' };
    return automation.schedule.outsideHours === 'skip' ? { reason: 'outside_hours' } : { holdUntil: status.nextOpenAt };
  }

  /** Builds the automation's first message and hands it to compliance. */
  async function launch(automation, event, { kind, purpose, key, expiresAt, tester, trigger, inReplyTo }) {
    const schedule = await hours(automation);
    if (schedule.reason || (schedule.holdUntil && schedule.holdUntil >= expiresAt)) return skip(event, schedule.reason ?? 'outside_hours', automation.id);

    const variant = chooseVariant(automation, `${automation.id}:${event.subject}`);
    if (!variant) return skip(event, 'automation.draft', automation.id);
    const finalUrl = await linkFor(automation, { channel: event.channel, mediaId: event.mediaId ?? '', variantLabel: variant.label });
    // Two taps is the private reply's flow (PRD 6.13). A story or a DM already has an open window, so it gets the link itself.
    const oneTap = automation.linkMode === 'one_tap' && (await repos.entitlements.can('links.one_tap'));
    const mode = kind === 'private_reply' && !oneTap ? 'two_tap' : 'direct';
    const firstName = variant.body.includes('{first_name}') || variant.fallbackText.includes('{first_name}') ? await firstNameOf(event) : '';
    const message = firstMessage({
      automation, variant, mode, firstName, finalUrl,
      payload: twoTapPayload({ automationId: automation.id, variantId: variant.id, mediaId: event.mediaId, commentId: event.commentId }),
    });
    const action = {
      kind, purpose, channel: event.channel, accountId: event.accountId, idempotencyKey: key, expiresAt, message, personId: event.personId,
      automationId: automation.id, variantId: variant.id, isTest: automation.state === 'test' || automation.dryRun || tester,
      ...(kind === 'dm' ? { recipientId: event.personId } : { commentId: event.commentId }),
      ...(event.mediaId ? { mediaId: event.mediaId } : {}),
    };
    const options = {
      ...(trigger ? { trigger } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(variant.fallbackText ? { fallbackText: render(variant.fallbackText, { firstName, url: mode === 'two_tap' ? '' : finalUrl }) } : {}),
      // Housekeeping releases a held job. Running it this late keeps a worker off the job until it has been marked held.
      ...(schedule.holdUntil ? { runAt: expiresAt } : {}),
    };
    const result = await compliance.enqueue(action, options);
    if (schedule.holdUntil && ['queued', 'held'].includes(result.outcome) && result.jobId) {
      await repos.automations.holdJob(result.jobId, clock());
      await decide(event, 'held', 'outside_hours', automation.id);
    }
    return undefined;
  }

  const isTester = (event) => repos.testers.isTester(event.channel, event.subject);

  // ---- Comments (PRD 6.1, 6.2) ----

  async function onComment(event) {
    const automation = await repos.automations.forMedia(event.channel, event.mediaId);
    if (!automation || automation.triggerType !== 'comment') {
      if (await repos.reels?.getActiveByMediaId(event.mediaId)) return false; // a Phase 0 reel: compliance answers it
      await skip(event, 'unmapped');
      return true;
    }
    const label = MEDIA_LABELS[String(event.mediaType).toUpperCase()];
    if (label) await repos.automations.relabelTrigger(event.channel, event.mediaId, label);
    const tester = await isTester(event);
    if (!(await admit(automation, event, tester))) return true;

    const short = event.tooShort ?? isTooShort(event.text);
    const matched = automation.matchMode === 'any' ? !short : matchesKeywords(event.text, automation.keywords);
    if (!matched) {
      await skip(event, short ? 'too_short' : 'no_keyword', automation.id);
      return true;
    }
    await launch(automation, event, { kind: 'private_reply', purpose: 'trigger', key: `private_reply:${event.commentId}`, expiresAt: event.expiresAt, tester, trigger: 'comment' });
    return true;
  }

  // ---- Direct messages, story replies and mentions (PRD 6.3, 6.4) ----

  function reactsToStory(automation, text) {
    if (!hasWords(text)) return automation.includeReactions || matchesKeywords(text, automation.keywords);
    return automation.matchMode === 'any' || !automation.keywords.length || matchesKeywords(text, automation.keywords);
  }

  /** True for a thread a person has taken over, whatever the message says. The reason is logged. */
  async function pausedThread(event) {
    if (event.threadPaused) await skip(event, event.threadPaused);
    return Boolean(event.threadPaused);
  }

  const dmWindowEnd = (event) => new Date(eventTime(event).getTime() + L.messagingWindowMs);

  /** A person answered our DM: the follow-up can go, at least 30 minutes later and inside the window (PRD 4.5). */
  async function scheduleFollowup(event) {
    const last = await repos.automations.lastTriggerDm(event.channel, event.subject, eventTime(event));
    if (!last) return;
    const automation = await repos.automations.get(last.automation_id);
    if (!automation?.followupEnabled || !automation.followupText || !LAUNCHED.has(automation.state)) return;
    const key = `followup:${automation.id}:${sha(event.subject)}`;
    if (await repos.automations.jobExists(key)) return;
    const sendAt = eventTime(event).getTime() + Math.max(L.followupMinDelayMs, automation.followupDelayMinutes * 60_000);
    if (sendAt >= dmWindowEnd(event).getTime()) return;
    await compliance.enqueue({
      kind: 'dm', purpose: 'followup', channel: event.channel, accountId: event.accountId, recipientId: event.personId, personId: event.personId, idempotencyKey: key, expiresAt: dmWindowEnd(event),
      automationId: automation.id, isTest: last.is_test, message: plainMessage({ template: automation.followupText, finalUrl: await linkFor(automation, { channel: event.channel }) }),
    }, { runAt: new Date(sendAt) });
  }

  /** Story and DM automations are a paid add-on below tier 3 (PRD 3). One left behind by a downgrade stops. */
  async function included(event, automation) {
    if (await repos.entitlements.can('triggers.story_dm')) return true;
    await skip(event, 'paused.automation', automation.id);
    return false;
  }

  async function onStoryReply(event) {
    if (await pausedThread(event)) return true;
    await scheduleFollowup(event);
    const specific = await repos.automations.forMedia(event.channel, event.storyId);
    const automation = specific?.triggerType === 'story_reply' ? specific : await repos.automations.anyStory(event.channel);
    if (!automation || automation.triggerType !== 'story_reply') {
      await skip(event, 'unmapped');
      return true;
    }
    if (!(await included(event, automation))) return true;
    const tester = await isTester(event);
    if (!(await admit(automation, event, tester))) return true;
    if (!reactsToStory(automation, event.text)) {
      await skip(event, 'no_keyword', automation.id);
      return true;
    }
    await launch(automation, event, { kind: 'dm', purpose: 'trigger', key: `story_reply:${keyPart(event.mid)}`, expiresAt: dmWindowEnd(event), tester, trigger: 'story_reply', inReplyTo: event.mid });
    return true;
  }

  async function onMention(event) {
    // A mention opens no window of its own (PRD 4.5), so it needs a message from this person inside the last 23h50m.
    const thread = await repos.inbox.threadRow(event.threadId);
    if (!windowOpen(thread?.last_user_message_at, clock())) {
      await skip(event, 'mention.no_window');
      return true;
    }
    if (await pausedThread(event)) return true;
    const [automation] = await repos.automations.byType('story_mention', event.channel);
    if (!automation) {
      await skip(event, 'unmapped');
      return true;
    }
    if (!(await included(event, automation))) return true;
    const tester = await isTester(event);
    if (!(await admit(automation, event, tester))) return true;
    await launch(automation, event, {
      kind: 'dm', purpose: 'trigger', key: `mention:${keyPart(event.mid)}`, expiresAt: new Date(new Date(thread.last_user_message_at).getTime() + L.messagingWindowMs), tester, trigger: 'mention',
    });
    return true;
  }

  async function answerFaq(position, event) {
    const template = await repos.iceBreakers.answerFor(position);
    if (!template) {
      await skip(event, 'unmapped');
      return;
    }
    await compliance.enqueue({
      kind: 'dm', purpose: 'faq', channel: event.channel, accountId: event.accountId, recipientId: event.personId, personId: event.personId, idempotencyKey: `dm_reply:${keyPart(event.mid)}`,
      expiresAt: dmWindowEnd(event), message: plainMessage({ template }), isTest: await isTester(event),
    }, { inReplyTo: event.mid });
  }

  /** The highest-priority rule that matches, or else the welcome. At most one automated reply per DM (PRD 6.4). */
  async function answerDirectMessage(event, text) {
    if (!(await repos.entitlements.can('triggers.story_dm'))) return;
    const tester = await isTester(event);
    const reply = { kind: 'dm', expiresAt: dmWindowEnd(event), tester };
    let needsTester = null;
    for (const rule of await repos.automations.byType('dm_keyword', event.channel)) {
      if (rule.matchMode !== 'any' && !matchesKeywords(text, rule.keywords)) continue;
      if (rule.state === 'test' && !tester) {
        needsTester ??= rule;
        continue;
      }
      if (stateBlock(rule)) continue;
      await launch(rule, event, { ...reply, purpose: 'faq', key: `dm_reply:${keyPart(event.mid)}`, trigger: 'dm_keyword', inReplyTo: event.mid });
      return;
    }
    const [welcome] = (await repos.automations.byType('dm_welcome', event.channel)).filter((rule) => (rule.state === 'live' || tester) && !stateBlock(rule));
    if (welcome) {
      await launch(welcome, event, { ...reply, purpose: 'welcome', key: `welcome:${event.subject}` });
      return;
    }
    await skip(event, needsTester ? 'test_mode' : 'no_keyword', needsTester?.id);
  }

  async function onDirectMessage(event) {
    // A tester's code is not a message to answer, whatever else is true of the thread (PRD 6.9).
    if (await repos.testers.redeem({ channel: event.channel, subject: event.subject, recipientId: event.personId, text: event.text, now: clock() })) return true;
    if (await pausedThread(event)) return true;
    await scheduleFollowup(event);
    await answerDirectMessage(event, event.quickReply || event.text);
    return true;
  }

  async function onPostback(event) {
    if (parseTwoTapPayload(event.payload)) return false; // the links track answers these (PRD 6.13)
    if (await pausedThread(event)) return true;
    const position = parseFaqPayload(event.payload);
    if (position) await answerFaq(position, event);
    else await answerDirectMessage(event, event.payload);
    return true;
  }

  const HANDLERS = { comment: onComment, dm: onDirectMessage, story_reply: onStoryReply, story_mention: onMention, postback: onPostback };

  return {
    /** One event from the compliance worker. Truthy means this module has dealt with it. */
    handle: async (event) => (HANDLERS[event.type] ? HANDLERS[event.type](event) : false),

    /** "Send test to me" (PRD 6.9): the first message, to a tester whose window is open. Null for a version that doesn't exist. */
    async sendTest(automation, tester, variantLabel) {
      const thread = await repos.inbox.threadBySubject(tester.channel, tester.subject_hash);
      if (!windowOpen(thread?.last_user_message_at, clock())) return { outcome: 'skipped', reason: 'window.closed' };
      const variant = variantLabel ? automation.variants.find((v) => v.label === variantLabel) : automation.variants[0];
      if (!variant) return null;
      const finalUrl = await linkFor(automation, { channel: tester.channel, mediaId: automation.triggers[0]?.mediaId ?? '', variantLabel: variant.label });
      return compliance.send({
        kind: 'dm', purpose: 'test', channel: tester.channel, accountId: thread.ig_user_id ?? thread.fb_page_id, recipientId: tester.recipient_id, personId: tester.recipient_id, idempotencyKey: `test:${automation.id}:${tester.id}:${crypto.randomUUID()}`,
        expiresAt: new Date(new Date(thread.last_user_message_at).getTime() + L.messagingWindowMs), message: firstMessage({ automation, variant, mode: 'direct', firstName: '', finalUrl }), automationId: automation.id, variantId: variant.id, isTest: true,
      });
    },

    /** End dates, held jobs whose hours have arrived, and retention, across businesses: the same work for every one of them. */
    async housekeeping({ retention = false } = {}) {
      await db.platform.query(`UPDATE automations SET state = 'paused', paused_reason = 'paused.automation', updated_at = $1 WHERE state IN ('live', 'test') AND ends_at <= $1`, [clock()]);
      const waiting = await db.platform.query(
        `SELECT DISTINCT j.tenant_id, j.automation_id, a.starts_at, a.ends_at, a.daily_start::text, a.daily_end::text, t.timezone
         FROM outbound_jobs j JOIN automations a ON a.tenant_id = j.tenant_id AND a.id = j.automation_id JOIN tenants t ON t.id = j.tenant_id
         WHERE j.status = 'held' AND j.reason = 'outside_hours'`,
      );
      for (const row of waiting) {
        const schedule = { startsAt: row.starts_at, endsAt: row.ends_at, dailyStart: row.daily_start, dailyEnd: row.daily_end };
        if (!scheduleStatus(schedule, clock(), row.timezone).open) continue;
        await db.platform.query(
          `UPDATE outbound_jobs SET status = 'queued', reason = '', run_at = $3, updated_at = $3 WHERE tenant_id = $1 AND automation_id = $2 AND status = 'held' AND reason = 'outside_hours'`,
          [row.tenant_id, row.automation_id, clock()],
        );
      }
      if (!retention) return;
      await db.platform.query(`DELETE FROM inbox_messages WHERE created_at < now() - ${INBOX_RETENTION}`);
      await db.platform.query(`UPDATE inbox_threads SET username = '', last_message = '' WHERE last_message_at < now() - ${INBOX_RETENTION} AND (username <> '' OR last_message <> '')`);
      await db.platform.query(`UPDATE needs_human_items SET username = '', text = '' WHERE created_at < now() - ${INBOX_RETENTION} AND (username <> '' OR text <> '')`);
      await db.platform.query(`DELETE FROM tester_codes WHERE used_at IS NULL AND expires_at < now() - interval '1 day'`);
    },
  };
}

const engines = new WeakMap();

/** The engine for this app or worker: one per compliance object. */
export function engineFor(ctx) {
  if (!engines.has(ctx.compliance)) engines.set(ctx.compliance, createAutomationEngine(ctx));
  return engines.get(ctx.compliance);
}
