import crypto from 'node:crypto';
import os from 'node:os';
import { InsightsDeferredError, MetaApiError, isInsightsDenied } from '../../adapters/meta/index.js';
import { ANALYTICS_LIMITS as L, META_METRICS } from '../../contracts/analytics.js';
import { log, reportError } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import {
  ACCOUNT_JOBS, BACKFILL_EVERY_MS, CALL_CLASS, DAY, HOUR, MEDIA_LIST_EVERY_MS, MINUTE, STORY_EDGE_RECHECK_MS, STORY_LIST_EVERY_MS,
  accountDaysToFetch, accountJitterSeconds, addDays, dayOf, firstDueAt, mediaEveryMs, mediaJitterSeconds, nextDueAfter, nextStoryDue, onlineFollowerCells, pollOffsetSeconds, retryDelayMs, storyPhase,
} from './schedule.js';

const CLAIM_LIMIT = 120;
const CLAIM_PER_BUSINESS = 20;
const BUSINESSES_AT_ONCE = 6;
const MAX_MEDIA_PAGES = 200; // 20,000 posts in 2 years, far past any real account: this only stops a broken cursor from looping for ever
const DEFER_RETRY_MS = 15 * MINUTE;
const STORY_RETRY_MS = 5 * MINUTE;
const LOCKED_OUT_RETRY_MS = 6 * HOUR;
const REGAIN_DEFAULT_MS = 60 * MINUTE;

/** A class of failure that says Meta won't help this account right now, so the rest of its polls wait rather than each finding that out. */
const STOP_ACCOUNT_KINDS = new Set(['buc_throttled', 'throttled', 'timeout', 'network', 'server_error', 'malformed']);

const CLASS_ORDER = Object.freeze({ story_insights: 0, insights: 1, media_list: 2 });
const ACCOUNT_COLUMNS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'shares', 'saves', 'replies', 'reposts'];
const whole = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const codeOf = (err) => (Number.isInteger(err?.code) ? err.code : null);

/** The account rows of some days, one rollup row per day: what src/platform's meta_account_daily holds. */
export function accountRollupRows(accountId, figures) {
  const days = new Map();
  for (const figure of figures) {
    const row = days.get(figure.day) ?? { day: figure.day, account_id: accountId };
    days.set(figure.day, row);
    const value = figure.value === null ? null : Number(figure.value);
    if (figure.metric === 'followers_count') row.followers_count = value;
    else if (figure.breakdown === '' && ACCOUNT_COLUMNS.includes(figure.metric)) row[figure.metric] = value;
    else if (value === null) continue;
    else if (figure.metric === 'profile_links_taps') row.profile_links_taps = (row.profile_links_taps ?? 0) + value;
    else if (figure.metric === 'follows_and_unfollows' && /^(NON|UNFOLLOW)/i.test(figure.breakdown_value)) row.unfollows = (row.unfollows ?? 0) + value;
    else if (figure.metric === 'follows_and_unfollows') row.follows = (row.follows ?? 0) + value;
  }
  return [...days.values()];
}

/** One media's snapshot as a meta_content_daily row. Watch time is milliseconds from Meta, and the skip rate is a percentage kept in basis points. */
export function contentRollupRow(media, day, metrics) {
  const n = (name) => whole(metrics[name]);
  return {
    day,
    media_id: media.media_id,
    content_kind: media.kind,
    views: n('views'),
    reach: n('reach'),
    likes: n('likes'),
    comments: n('comments'),
    shares: n('shares'),
    saved: n('saved'),
    total_interactions: n('total_interactions'),
    reposts: n('reposts'),
    follows: n('follows'),
    profile_visits: n('profile_visits'),
    link_clicks: n('link_clicks'),
    avg_watch_ms: n('ig_reels_avg_watch_time'),
    total_watch_ms: n('ig_reels_video_view_total_time'),
    skip_rate_bp: Number.isFinite(metrics.reels_skip_rate) ? Math.round(metrics.reels_skip_rate * 100) : null,
  };
}

async function eachAtOnce(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

/**
 * Fills the insights cache on the schedule of PRD 7.8. Every minute a tick finds what is due across businesses and leases it for 10 minutes; each business then runs
 * inside its own withTenant(), with its own token and its own rate guard, and every failure stops at that business. Nothing here can send a message, and every read of
 * Meta goes through meta.client.insightsFor() with compliance.insightsGuard(), which applies 4.3's pauses and call classes.
 *
 * What goes wrong for one account:
 *   a pause (usage header, 80002)  the poll waits for the regain time, and no call is made
 *   insights permission denied     analytics shows "Permission needed", slow mode starts, and the account is asked again every 6 hours
 *   token refused (190)            the token is written off as everywhere else, and polls wait for a reconnect
 *   anything else                  backs off, up to 6 hours
 */
export function createInsightsPoller(ctx) {
  const { db, repos, meta, compliance, platform, config } = ctx;
  const clock = config?.complianceNow ?? Date.now;
  const now = () => clock();
  const analytics = () => platform.analytics.rollups;

  /** The cached figures are what matter: if the rollup can't be written it is logged, and the next poll of that day writes it again. */
  async function writeRollup(store, rows) {
    if (!rows.length) return;
    try {
      await analytics().write(store, rows);
    } catch (err) {
      log.warn('insights.rollup_failed', { store, error: err?.name });
    }
  }

  /** Starts collecting for any connected Instagram account that isn't yet. Facebook Pages wait until their metric names are confirmed (PRD 6.10). */
  async function enrolNew(at) {
    const accounts = await db.platform.query(
      `SELECT i.tenant_id, i.ig_user_id FROM ig_accounts i
       JOIN tenants t ON t.id = i.tenant_id AND t.status IN ('onboarding', 'active', 'paused')
       LEFT JOIN analytics_accounts a ON a.tenant_id = i.tenant_id AND a.channel = 'instagram' AND a.ig_user_id = i.ig_user_id
       WHERE a.id IS NULL AND i.access_token_enc <> '' AND i.status = 'active' LIMIT 500`,
    );
    for (const account of accounts) {
      try {
        await withTenant(account.tenant_id, async () => {
          const offsetSec = pollOffsetSeconds(account.tenant_id);
          await repos.insights.enrol({
            igUserId: account.ig_user_id,
            collectingSince: dayOf(at),
            offsetSec,
            polls: ACCOUNT_JOBS.map((job) => {
              const jitterSeconds = accountJitterSeconds(offsetSec, job);
              return { job, jitterSeconds, dueAt: firstDueAt(at, jitterSeconds) };
            }),
          });
        });
      } catch (err) {
        reportError(err, { msg: 'insights.enrol_failed', igUserId: account.ig_user_id });
      }
    }
    return accounts.length;
  }

  /**
   * Leases what is due, story polls first (4.3's order), and at most CLAIM_PER_BUSINESS each, so one business with thousands of posts can't crowd out the others.
   * This looks across businesses, so it goes through db.platform; everything after it is inside withTenant().
   */
  function claim(at, { limit = CLAIM_LIMIT, perBusiness = CLAIM_PER_BUSINESS } = {}) {
    const lockedBy = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
    return db.platform.query(
      `WITH due AS (
         SELECT p.id, p.next_due_at, CASE p.call_class WHEN 'story_insights' THEN 0 WHEN 'insights' THEN 1 ELSE 2 END AS class_rank,
                row_number() OVER (PARTITION BY p.tenant_id ORDER BY CASE p.call_class WHEN 'story_insights' THEN 0 WHEN 'insights' THEN 1 ELSE 2 END, p.next_due_at, p.id) AS n
         FROM insight_polls p JOIN tenants t ON t.id = p.tenant_id
         WHERE p.stopped_at IS NULL AND p.next_due_at <= $1::timestamptz AND (p.lease_until IS NULL OR p.lease_until <= $1::timestamptz)
           AND t.status IN ('onboarding', 'active', 'paused')
       ),
       picked AS (SELECT id, class_rank, next_due_at FROM due WHERE n <= $2 ORDER BY class_rank, next_due_at, id LIMIT $3),
       locked AS (
         SELECT p.id FROM insight_polls p JOIN picked USING (id)
         WHERE p.stopped_at IS NULL AND (p.lease_until IS NULL OR p.lease_until <= $1::timestamptz)
         FOR UPDATE OF p SKIP LOCKED
       )
       UPDATE insight_polls p SET lease_until = $4::timestamptz, locked_by = $5, last_started_at = $1::timestamptz
       FROM locked WHERE p.id = locked.id RETURNING p.*`,
      [new Date(at).toISOString(), perBusiness, limit, new Date(at + L.pollLeaseMs).toISOString(), lockedBy],
    );
  }

  /** Ends a poll without a Meta call, for the ones a pause or a lost token has reached. */
  async function holdPolls(polls, outcome, nextDueAt, errorCode = null) {
    for (const poll of polls) await repos.insights.finishPoll(poll, { outcome, nextDueAt, errorCode, at: now() });
  }

  const closeStory = async (media, poll, state, outcome) => {
    await repos.insights.closeStory(media.id, state);
    await repos.insights.finishPoll(poll, { outcome, stop: true, at: now() });
  };

  /** Whether a story's window has passed. Answered with no call to Meta, so it works even when the token is gone. */
  function storyClosed(media, at) {
    if (media.posted_at) return storyPhase(at - +new Date(media.posted_at)) === 'closed';
    return at >= +new Date(media.story_expires_at);
  }

  /** The last good snapshot stays, marked as maybe incomplete (N-12). */
  const closeIncomplete = (media, poll) => closeStory(media, poll, 'final_incomplete', 'final_incomplete');

  // ---- the jobs ------------------------------------------------------------------------------------------------------

  async function captureOnlineFollowers(reader, account, at) {
    const { available, hours } = await reader.onlineFollowers();
    await repos.insights.setOnlineFollowersState(account.id, available ? 'available' : 'unavailable');
    if (available) await repos.insights.saveOnlineFollowers(account.id, onlineFollowerCells(hours, at, await repos.insights.timeZone()), at);
  }

  async function accountDaily({ poll, account, reader }) {
    const at = now();
    const today = dayOf(at);
    const { days, more } = accountDaysToFetch(today, await repos.insights.storedDays(account.id, addDays(today, -L.accountRetentionDays)));
    for (const day of days) {
      await repos.insights.replaceDay(account.id, day, await reader.accountDay(day), at);
      await writeRollup('meta_account_daily', accountRollupRows(account.account_id, await repos.insights.dayFigures(account.id, [day])));
    }

    const followers = await reader.followers();
    await repos.insights.saveFollowers(account.id, today, followers, at);
    await writeRollup('meta_account_daily', accountRollupRows(account.account_id, await repos.insights.dayFigures(account.id, [today])));
    if (followers !== null && followers >= L.minFollowersForDemographics && account.online_followers !== 'unavailable') await captureOnlineFollowers(reader, account, at);

    await repos.insights.markRefreshed(account.id, at);
    const due = +poll.next_due_at;
    return { insightsAnswered: true, nextDueAt: more ? nextDueAfter(due, BACKFILL_EVERY_MS, at) : nextDueAfter(due, L.accountEveryMs, at) };
  }

  async function demographics({ poll, account, reader }) {
    const at = now();
    const enough = account.followers_count === null || account.followers_count >= L.minFollowersForDemographics;
    if (enough) {
      for (const metric of META_METRICS.demographics) {
        for (const timeframe of L.demographicsTimeframes) {
          for (const breakdown of META_METRICS.demographicBreakdowns) {
            await repos.insights.replaceDemographics(account.id, { metric, timeframe, breakdown, items: await reader.demographics(metric, timeframe, breakdown), at });
          }
        }
      }
      if (account.online_followers === 'unavailable' && account.followers_count !== null) await captureOnlineFollowers(reader, account, at); // once a week, in case it came back
    }
    return { insightsAnswered: enough, nextDueAt: nextDueAfter(+poll.next_due_at, L.demographicsEveryMs, at) };
  }

  /** Stores listed posts and gives each new one its own poll, spread across the hour. */
  async function saveListed(account, items, offset, at) {
    const refs = await repos.insights.upsertMedia(account.id, items);
    await repos.insights.ensureMediaPolls(account.id, items.map((m) => {
      const jitterSeconds = mediaJitterSeconds(offset, m.id);
      return { job: 'media', mediaRef: refs.get(m.id), jitterSeconds, dueAt: firstDueAt(at, jitterSeconds) };
    }));
  }

  /** Walks /media back 2 years the first time. After that a page of posts already known means everything older is known too (7.2, N-09). */
  async function mediaList({ poll, account, reader }) {
    const at = now();
    const oldest = at - L.mediaHistoryDays * DAY;
    const { poll_offset_sec: offset } = await repos.insights.settings();
    const firstWalk = !account.media_listed_at;
    let after;
    let pages = 0;
    do {
      const page = await reader.mediaPage({ after, limit: 100 });
      const inHistory = page.items.filter((m) => m.postedAt && +m.postedAt >= oldest);
      const known = await repos.insights.knownMediaIds(account.id, inHistory.map((m) => m.id));
      await saveListed(account, inHistory, offset, at);
      const reachedTheEnd = inHistory.length < page.items.length || (!firstWalk && inHistory.every((m) => known.has(m.id)));
      after = reachedTheEnd ? null : page.next;
      pages += 1;
    } while (after && pages < MAX_MEDIA_PAGES);
    await repos.insights.markMediaListed(account.id, at);
    return { nextDueAt: nextDueAfter(+poll.next_due_at, MEDIA_LIST_EVERY_MS, at) };
  }

  /** Reads live stories. A Live on this edge isn't a story Meta gives insights for, so it is kept as "not tracked" (7.3); a reshared story can't be told apart yet. */
  async function storyList({ poll, account, reader }) {
    const at = now();
    let page = await reader.storiesPage({ limit: 100 });
    if (!page.available) {
      await repos.insights.setStoriesEdge(account.id, 'unavailable');
      return { nextDueAt: nextDueAfter(+poll.next_due_at, STORY_EDGE_RECHECK_MS, at) };
    }
    await repos.insights.setStoriesEdge(account.id, 'available');
    for (let pages = 0; pages < MAX_MEDIA_PAGES; pages++) {
      const stories = page.items.map((item) => ({
        ...item,
        kind: 'story',
        storyTracking: item.kind === 'story' ? 'edge' : 'not_tracked',
        postedAt: item.postedAt ?? new Date(at),
        storyExpiresAt: +(item.postedAt ?? new Date(at)) + L.storyLifeMs,
      }));
      const refs = await repos.insights.upsertMedia(account.id, stories);
      await repos.insights.ensureMediaPolls(account.id, stories.filter((s) => s.storyTracking === 'edge').map((s) => ({ job: 'story', mediaRef: refs.get(s.id), jitterSeconds: 0, dueAt: nextStoryDue(+s.postedAt, at) })));
      if (!page.next) break;
      page = await reader.storiesPage({ after: page.next, limit: 100 });
    }
    return { nextDueAt: nextDueAfter(+poll.next_due_at, STORY_LIST_EVERY_MS, at) };
  }

  async function mediaInsights({ poll, account, reader }) {
    const media = await repos.insights.mediaByRef(poll.media_ref);
    if (!media || media.deleted_at) return { outcome: 'deleted', stop: true };
    const at = now();
    const result = await reader.mediaInsights(media.media_id, media.kind);
    if (result.status === 'gone') {
      await repos.insights.markMediaDeleted(media.id, at);
      return { outcome: 'gone', stop: true };
    }
    if (result.status === 'expired') return { outcome: 'expired', stop: true, insightsAnswered: true };

    const posted = media.posted_at ? +new Date(media.posted_at) : null;
    const age = posted === null ? L.mediaMidUnderMs : at - posted;
    if (result.status === 'ok') {
      await repos.insights.saveSnapshot(media.id, { slot: +poll.next_due_at, at, ageMinutes: Math.max(0, Math.floor(age / MINUTE)), metrics: result.metrics, breakdowns: result.breakdowns });
      await writeRollup('meta_content_daily', [contentRollupRow(media, dayOf(at), result.metrics)]);
      await repos.insights.markRefreshed(account.id, at);
    }
    const every = mediaEveryMs(age);
    if (every === null) return { outcome: 'expired', stop: true, insightsAnswered: true };
    return { insightsAnswered: true, nextDueAt: nextDueAfter(+poll.next_due_at, every, at) };
  }

  /** A story, every 2 hours and then once more at 22 to 23.5 hours (7.3). The window is the reason for each branch: past it, Meta is not asked. */
  async function storyInsights({ poll, account, reader }) {
    const media = await repos.insights.mediaByRef(poll.media_ref);
    if (!media || media.story_final_state !== 'open') return { outcome: 'closed', stop: true };
    const at = now();
    if (storyClosed(media, at)) {
      await closeIncomplete(media, poll);
      return { finished: true };
    }

    const posted = media.posted_at ? +new Date(media.posted_at) : null;
    const isFinal = posted !== null && storyPhase(at - posted) === 'final';
    const result = await reader.storyInsights(media.media_id);
    if (result.status === 'gone') {
      await repos.insights.markMediaDeleted(media.id, at);
      await closeIncomplete(media, poll);
      return { finished: true };
    }
    if (result.status === 'expired') {
      await closeIncomplete(media, poll);
      return { finished: true, insightsAnswered: true };
    }

    const belowThreshold = result.status === 'below_threshold';
    await repos.insights.saveSnapshot(media.id, {
      slot: +poll.next_due_at,
      at,
      ageMinutes: posted === null ? Math.max(0, Math.floor((at - (+new Date(media.story_expires_at) - L.storyLifeMs)) / MINUTE)) : Math.max(0, Math.floor((at - posted) / MINUTE)),
      metrics: belowThreshold ? {} : result.metrics,
      breakdowns: belowThreshold ? {} : result.breakdowns,
      belowThreshold,
      isFinal,
    });
    if (!belowThreshold) await writeRollup('meta_content_daily', [contentRollupRow(media, dayOf(at), result.metrics)]);
    await repos.insights.markRefreshed(account.id, at);
    if (isFinal) {
      await closeStory(media, poll, 'final', 'final');
      return { finished: true, insightsAnswered: true };
    }
    return { insightsAnswered: true, nextDueAt: posted === null ? nextDueAfter(+poll.next_due_at, L.storyEveryMs, at) : nextStoryDue(posted, at) };
  }

  const JOBS = { account_daily: accountDaily, demographics, media_list: mediaList, story_list: storyList, media: mediaInsights, story: storyInsights };

  // ---- what happens when a job doesn't finish ------------------------------------------------------------------------

  /** Slow mode is asked for again each time: it holds for a week at most, and the account is asked every 6 hours for as long as the permission is gone. */
  async function deny(account) {
    await repos.insights.setPermission(account.id, 'denied', now());
    await compliance.slowMode.enter('instagram', account.ig_user_id, 'insights_denied').catch((err) => reportError(err, { msg: 'insights.slow_mode_failed', igUserId: account.ig_user_id }));
  }

  /** A clean answer from the insights endpoints means the permission is back, so "Permission needed" goes and the restore starts. */
  async function allow(account) {
    if (account.permission !== 'denied') return;
    if (await repos.insights.setPermission(account.id, 'ok', now())) {
      await compliance.slowMode.leave('instagram', account.ig_user_id, 'insights_denied').catch((err) => reportError(err, { msg: 'insights.slow_mode_failed', igUserId: account.ig_user_id }));
    }
  }

  /** Decides what a failure means for this poll, and returns when the account's other polls should wait until, or null when they can carry on. */
  async function failed(poll, account, err) {
    const at = now();
    const isStory = CALL_CLASS[poll.job] === 'story_insights';
    if (err instanceof InsightsDeferredError) {
      const nextDueAt = err.retryAt ? +new Date(err.retryAt) : at + (isStory ? STORY_RETRY_MS : DEFER_RETRY_MS);
      await repos.insights.finishPoll(poll, { outcome: 'deferred', nextDueAt, at });
      return nextDueAt;
    }
    if (isInsightsDenied(err)) {
      const nextDueAt = at + LOCKED_OUT_RETRY_MS;
      await deny(account);
      await repos.insights.finishPoll(poll, { outcome: 'denied', nextDueAt, errorCode: codeOf(err), at });
      return nextDueAt;
    }
    if (err instanceof MetaApiError && err.kind === 'token_invalid') {
      const nextDueAt = at + LOCKED_OUT_RETRY_MS;
      await repos.igAccounts.loseToken(account.ig_user_id, 'token.rejected', { actor: 'system:insights', details: { cause: 'read_refused', code: codeOf(err) } })
        .catch((failure) => reportError(failure, { msg: 'insights.lose_token_failed', igUserId: account.ig_user_id }));
      await repos.insights.finishPoll(poll, { outcome: 'token_invalid', nextDueAt, errorCode: codeOf(err), at });
      return nextDueAt;
    }

    const known = err instanceof MetaApiError;
    if (known) log.warn('insights.poll_failed', { job: poll.job, igUserId: account.ig_user_id, kind: err.kind, status: err.status, code: codeOf(err) });
    else reportError(err, { msg: 'insights.poll_crashed', job: poll.job, igUserId: account.ig_user_id });

    const backoff = isStory ? Math.min(retryDelayMs(poll.attempts), STORY_RETRY_MS) : retryDelayMs(poll.attempts);
    const regain = err.usage?.regainMinutes > 0 ? err.usage.regainMinutes * MINUTE : REGAIN_DEFAULT_MS;
    const nextDueAt = at + (known && err.kind === 'buc_throttled' ? regain : backoff);
    await repos.insights.finishPoll(poll, { outcome: known ? `error:${err.kind}` : 'error:crash', nextDueAt, errorCode: codeOf(err), failed: true, at });
    return known && STOP_ACCOUNT_KINDS.has(err.kind) ? nextDueAt : null;
  }

  /** With no working token nothing can be asked. A story's window still closes, so that much is done here; the rest waits for a reconnect. */
  async function withoutToken(polls) {
    const at = now();
    for (const poll of polls) {
      if (poll.job === 'story') {
        const media = await repos.insights.mediaByRef(poll.media_ref);
        if (media && storyClosed(media, at)) {
          await closeIncomplete(media, poll);
          continue;
        }
      }
      await holdPolls([poll], 'no_token', at + LOCKED_OUT_RETRY_MS);
    }
  }

  async function runAccount(polls) {
    const account = await repos.insights.accountByRef(polls[0].account_ref);
    if (!account) return;
    const ig = await repos.igAccounts.get(account.ig_user_id);
    if (!ig?.token) {
      await withoutToken(polls);
      return;
    }
    const reader = meta.client.insightsFor(ig, compliance.insightsGuard('instagram', ig.igUserId));
    // Stories first: their deadline can't wait, and a pause that stops them stops everything after them too.
    const ordered = [...polls].sort((a, b) => CLASS_ORDER[a.call_class] - CLASS_ORDER[b.call_class]);
    for (const [index, poll] of ordered.entries()) {
      try {
        const result = await JOBS[poll.job]({ poll, account, reader });
        if (result.insightsAnswered) await allow(account);
        if (result.finished) continue;
        await repos.insights.finishPoll(poll, { outcome: result.outcome ?? 'ok', nextDueAt: result.nextDueAt ?? null, stop: Boolean(result.stop), at: now() });
      } catch (err) {
        const waitUntil = await failed(poll, account, err);
        if (waitUntil !== null) {
          await holdPolls(ordered.slice(index + 1), 'waiting', waitUntil);
          return;
        }
      }
    }
  }

  /** One business's claimed polls. Whatever happens here stays here: the next business's run starts regardless. */
  function runBusiness(tenantId, polls) {
    return withTenant(tenantId, async () => {
      const byAccount = new Map();
      for (const poll of polls) byAccount.set(poll.account_ref, [...(byAccount.get(poll.account_ref) ?? []), poll]);
      for (const accountPolls of byAccount.values()) await runAccount(accountPolls);
    }).catch((err) => reportError(err, { msg: 'insights.business_failed', tenant: tenantId }));
  }

  return {
    enrolNew,
    claim,

    /** What the worker runs every minute. Every worker can run it at once: a poll has one lease holder. */
    async tick() {
      const at = now();
      await enrolNew(at);
      const polls = await claim(at);
      const byBusiness = new Map();
      for (const poll of polls) byBusiness.set(poll.tenant_id, [...(byBusiness.get(poll.tenant_id) ?? []), poll]);
      await eachAtOnce([...byBusiness.entries()], BUSINESSES_AT_ONCE, ([tenantId, businessPolls]) => runBusiness(tenantId, businessPolls));
      return { claimed: polls.length };
    },
  };
}
