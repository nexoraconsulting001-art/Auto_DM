import { META_METRICS } from '../../contracts/analytics.js';
import { tenantId } from '../../tenancy.js';
import { CALL_CLASS, DEFAULT_TIME_ZONE } from './schedule.js';

const iso = (ms) => new Date(ms).toISOString();
const wholeOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/** Everything about one account except its token, with dates as text so a day is never moved by a time zone. */
const ACCOUNT_COLUMNS = `a.id, a.tenant_id, a.channel, a.ig_user_id, a.fb_page_id, a.account_id, a.collecting_since::text AS collecting_since, a.permission, a.permission_at,
  a.stories_edge, a.online_followers, a.followers_count, a.followers_at, a.media_listed_at, a.last_refresh_at`;

/**
 * The per-business insights cache (PRD 7.1 to 7.3, 7.5, 7.8). Workers fill it and screens read it; nothing here talks to Meta. Every method is for the current
 * business. A null figure is an empty data set from Meta and stays null: nothing here turns one into 0.
 */
export function insightsRepo(db) {
  const accountSelect = `SELECT ${ACCOUNT_COLUMNS}, (i.status = 'active' AND i.access_token_enc <> '') AS token_ok
    FROM analytics_accounts a LEFT JOIN ig_accounts i ON i.tenant_id = a.tenant_id AND i.ig_user_id = a.ig_user_id`;

  return {
    // ---- accounts ------------------------------------------------------------------------------------------------------

    /** Starts collecting for an Instagram account, with its four account-level polls. Running it twice changes nothing. */
    async enrol({ igUserId, collectingSince, offsetSec, polls }) {
      const t = tenantId();
      return db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, $3::date)
           ON CONFLICT (tenant_id, channel, account_id) DO NOTHING`,
          [t, String(igUserId), collectingSince],
        );
        await tx.query('INSERT INTO insight_settings (tenant_id, poll_offset_sec) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [t, offsetSec]);
        const [{ id }] = await tx.query(`SELECT id FROM analytics_accounts WHERE tenant_id = $1 AND channel = 'instagram' AND ig_user_id = $2`, [t, String(igUserId)]);
        for (const poll of polls) {
          await tx.query(
            `INSERT INTO insight_polls (tenant_id, account_ref, job, call_class, next_due_at, jitter_seconds) VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
             ON CONFLICT (tenant_id, account_ref, job) WHERE media_ref IS NULL DO NOTHING`,
            [t, id, poll.job, CALL_CLASS[poll.job], iso(poll.dueAt), poll.jitterSeconds],
          );
        }
        return id;
      });
    },

    /** The account screens show: one still connected if there is one, otherwise the most recent. Null before the first poll. */
    async currentAccount() {
      const [row] = await db.query(`${accountSelect} WHERE a.tenant_id = $1 AND a.channel = 'instagram' ORDER BY (i.status = 'active' AND i.access_token_enc <> '') DESC NULLS LAST, a.id DESC LIMIT 1`, [tenantId()]);
      return row ?? null;
    },

    async accountByRef(ref) {
      const [row] = await db.query(`${accountSelect} WHERE a.tenant_id = $1 AND a.id = $2`, [tenantId(), ref]);
      return row ?? null;
    },

    async accountForIg(igUserId) {
      const [row] = await db.query(`${accountSelect} WHERE a.tenant_id = $1 AND a.channel = 'instagram' AND a.ig_user_id = $2`, [tenantId(), String(igUserId)]);
      return row ?? null;
    },

    /** Returns true only when this changed it, so what follows a change happens once. */
    async setPermission(ref, permission, at) {
      const rows = await db.query('UPDATE analytics_accounts SET permission = $3, permission_at = $4::timestamptz WHERE tenant_id = $1 AND id = $2 AND permission <> $3 RETURNING id', [tenantId(), ref, permission, iso(at)]);
      return rows.length > 0;
    },

    setStoriesEdge: (ref, state) => db.query('UPDATE analytics_accounts SET stories_edge = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), ref, state]),
    setOnlineFollowersState: (ref, state) => db.query('UPDATE analytics_accounts SET online_followers = $3 WHERE tenant_id = $1 AND id = $2', [tenantId(), ref, state]),
    markMediaListed: (ref, at) => db.query('UPDATE analytics_accounts SET media_listed_at = $3::timestamptz WHERE tenant_id = $1 AND id = $2', [tenantId(), ref, iso(at)]),
    markRefreshed: (ref, at) => db.query('UPDATE analytics_accounts SET last_refresh_at = GREATEST(last_refresh_at, $3::timestamptz) WHERE tenant_id = $1 AND id = $2', [tenantId(), ref, iso(at)]),

    async settings() {
      const [row] = await db.query('SELECT refresh_now_at, poll_offset_sec FROM insight_settings WHERE tenant_id = $1', [tenantId()]);
      return row ?? { refresh_now_at: null, poll_offset_sec: 0 };
    },

    async timeZone() {
      const [row] = await db.query('SELECT timezone FROM tenants WHERE id = $1', [tenantId()]);
      return row?.timezone || DEFAULT_TIME_ZONE;
    },

    // ---- what polls write ----------------------------------------------------------------------------------------------

    async storedDays(ref, sinceDay) {
      const rows = await db.query(`SELECT DISTINCT day::text AS day FROM insight_daily WHERE tenant_id = $1 AND account_ref = $2 AND day >= $3::date AND metric <> 'followers_count'`, [tenantId(), ref, sinceDay]);
      return rows.map((r) => r.day);
    },

    /** One day's account rows, whole: a late revision overwrites, and a breakdown Meta stopped reporting goes (7.8). The follower snapshot belongs to another poll and stays. */
    async replaceDay(ref, day, rows, at) {
      const t = tenantId();
      const unique = new Map(rows.map((r) => [`${r.metric}|${r.breakdown}|${r.breakdownValue}`, r]));
      const records = [...unique.values()].map((r) => ({ metric: r.metric, breakdown: r.breakdown, breakdown_value: r.breakdownValue, value: wholeOrNull(r.value), estimated: META_METRICS.estimated.includes(r.metric) }));
      await db.tx(async (tx) => {
        await tx.query(`DELETE FROM insight_daily WHERE tenant_id = $1 AND account_ref = $2 AND day = $3::date AND metric <> 'followers_count'`, [t, ref, day]);
        await tx.query(
          `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, breakdown, breakdown_value, value, estimated, fetched_at)
           SELECT $1, $2, $3::date, x.metric, x.breakdown, x.breakdown_value, x.value, x.estimated, $4::timestamptz
           FROM jsonb_to_recordset($5::jsonb) AS x(metric text, breakdown text, breakdown_value text, value bigint, estimated boolean)`,
          [t, ref, day, iso(at), JSON.stringify(records)],
        );
      });
    },

    /** The day's follower count. When Meta gives none the row is null and the last known count stays on the account (7.1). */
    async saveFollowers(ref, day, count, at) {
      const t = tenantId();
      const value = wholeOrNull(count);
      await db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO insight_daily (tenant_id, account_ref, day, metric, value, fetched_at) VALUES ($1, $2, $3::date, 'followers_count', $4, $5::timestamptz)
           ON CONFLICT (tenant_id, account_ref, day, metric, breakdown, breakdown_value) DO UPDATE SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at`,
          [t, ref, day, value, iso(at)],
        );
        if (value !== null) await tx.query('UPDATE analytics_accounts SET followers_count = $3, followers_at = $4::timestamptz WHERE tenant_id = $1 AND id = $2', [t, ref, Math.max(0, value), iso(at)]);
      });
    },

    /** The stored figures of some days, for the rollup. */
    dayFigures: (ref, days) => db.query(
      'SELECT day::text AS day, metric, breakdown, breakdown_value, value FROM insight_daily WHERE tenant_id = $1 AND account_ref = $2 AND day = ANY($3::date[])',
      [tenantId(), ref, days],
    ),

    /** One breakdown of one demographics metric, replaced whole (7.8). */
    async replaceDemographics(ref, { metric, timeframe, breakdown, items, at }) {
      const t = tenantId();
      const records = [...new Map(items.filter((i) => Number.isFinite(i.value) && i.value >= 0).map((i) => [i.key, { breakdown_value: i.key, value: Math.round(i.value) }])).values()];
      await db.tx(async (tx) => {
        await tx.query('DELETE FROM insight_demographics WHERE tenant_id = $1 AND account_ref = $2 AND metric = $3 AND timeframe = $4 AND breakdown = $5', [t, ref, metric, timeframe, breakdown]);
        await tx.query(
          `INSERT INTO insight_demographics (tenant_id, account_ref, metric, timeframe, breakdown, breakdown_value, value, fetched_at)
           SELECT $1, $2, $3, $4, $5, x.breakdown_value, x.value, $6::timestamptz FROM jsonb_to_recordset($7::jsonb) AS x(breakdown_value text, value bigint)`,
          [t, ref, metric, timeframe, breakdown, iso(at), JSON.stringify(records)],
        );
      });
    },

    async saveOnlineFollowers(ref, cells, at) {
      const unique = [...new Map(cells.map((c) => [`${c.weekday}|${c.hour}`, c])).values()];
      await db.query(
        `INSERT INTO insight_online_followers (tenant_id, account_ref, weekday, hour, value, fetched_at)
         SELECT $1, $2, x.weekday, x.hour, x.value, $3::timestamptz FROM jsonb_to_recordset($4::jsonb) AS x(weekday smallint, hour smallint, value bigint)
         ON CONFLICT (tenant_id, account_ref, weekday, hour) DO UPDATE SET value = EXCLUDED.value, fetched_at = EXCLUDED.fetched_at`,
        [tenantId(), ref, iso(at), JSON.stringify(unique)],
      );
    },

    async knownMediaIds(ref, ids) {
      if (!ids.length) return new Set();
      const rows = await db.query('SELECT media_id FROM insight_media WHERE tenant_id = $1 AND account_ref = $2 AND media_id = ANY($3::text[])', [tenantId(), ref, ids]);
      return new Set(rows.map((r) => r.media_id));
    },

    /**
     * Adds or refreshes media and returns { mediaId: ref }. A story found on the edge replaces what a reply told us about it, including when it was posted. A reply
     * adds nothing to a story already known, and a not-tracked story stays not tracked.
     */
    async upsertMedia(ref, items) {
      if (!items.length) return new Map();
      const records = items.map((m) => ({
        media_id: m.id,
        kind: m.kind,
        caption: m.caption,
        permalink: m.permalink,
        thumbnail_url: m.thumbnailUrl,
        posted_at: m.postedAt ? new Date(m.postedAt).toISOString() : null,
        story_expires_at: m.storyExpiresAt ? new Date(m.storyExpiresAt).toISOString() : null,
        story_tracking: m.storyTracking ?? 'edge',
      }));
      const rows = await db.query(
        `INSERT INTO insight_media (tenant_id, account_ref, media_id, kind, caption, permalink, thumbnail_url, posted_at, story_expires_at, story_tracking)
         SELECT $1, $2, x.media_id, x.kind, x.caption, x.permalink, x.thumbnail_url, x.posted_at, x.story_expires_at, x.story_tracking
         FROM jsonb_to_recordset($3::jsonb) AS x(media_id text, kind text, caption text, permalink text, thumbnail_url text, posted_at timestamptz, story_expires_at timestamptz, story_tracking text)
         ON CONFLICT (tenant_id, account_ref, media_id) DO UPDATE SET
           caption = COALESCE(NULLIF(EXCLUDED.caption, ''), insight_media.caption), permalink = COALESCE(NULLIF(EXCLUDED.permalink, ''), insight_media.permalink),
           thumbnail_url = COALESCE(NULLIF(EXCLUDED.thumbnail_url, ''), insight_media.thumbnail_url),
           posted_at = COALESCE(EXCLUDED.posted_at, insight_media.posted_at),
           story_expires_at = COALESCE(EXCLUDED.story_expires_at, insight_media.story_expires_at),
           story_tracking = CASE WHEN insight_media.story_tracking = 'not_tracked' OR EXCLUDED.story_tracking = 'seen_only' THEN insight_media.story_tracking ELSE EXCLUDED.story_tracking END
         RETURNING id, media_id`,
        [tenantId(), ref, JSON.stringify([...new Map(records.map((r) => [r.media_id, r])).values()])],
      );
      return new Map(rows.map((r) => [r.media_id, r.id]));
    },

    /** A poll for each media ref that doesn't have one. An existing poll keeps its schedule, and one stopped stays stopped. */
    async ensureMediaPolls(ref, polls) {
      if (!polls.length) return;
      await db.query(
        `INSERT INTO insight_polls (tenant_id, account_ref, job, media_ref, call_class, next_due_at, jitter_seconds)
         SELECT $1, $2, x.job, x.media_ref, x.call_class, x.next_due_at, x.jitter_seconds
         FROM jsonb_to_recordset($3::jsonb) AS x(job text, media_ref bigint, call_class text, next_due_at timestamptz, jitter_seconds integer)
         ON CONFLICT (tenant_id, media_ref, job) WHERE media_ref IS NOT NULL DO NOTHING`,
        [tenantId(), ref, JSON.stringify(polls.map((p) => ({ job: p.job, media_ref: p.mediaRef, call_class: CALL_CLASS[p.job], next_due_at: iso(p.dueAt), jitter_seconds: p.jitterSeconds })))],
      );
    },

    async mediaByRef(id) {
      const [row] = await db.query('SELECT * FROM insight_media WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row ?? null;
    },

    /** Keeps the figures and marks the row "Deleted on Instagram" (7.2). */
    markMediaDeleted: (id, at) => db.query('UPDATE insight_media SET deleted_at = COALESCE(deleted_at, $3::timestamptz) WHERE tenant_id = $1 AND id = $2', [tenantId(), id, iso(at)]),

    /**
     * One snapshot and the row screens show, together. A rerun on the same slot adds no snapshot (N-38); the figures on the row are still the newest Meta gave, so a
     * late revision always lands. With no figures (below the viewer threshold) what the row already holds stays.
     */
    async saveSnapshot(mediaRef, { slot, at, ageMinutes, metrics, breakdowns, belowThreshold = false, isFinal = false }) {
      const t = tenantId();
      await db.tx(async (tx) => {
        await tx.query(
          `INSERT INTO insight_snapshots (tenant_id, media_ref, slot, captured_at, age_minutes, metrics, breakdowns, below_threshold, is_final)
           VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6::jsonb, $7::jsonb, $8, $9) ON CONFLICT (tenant_id, media_ref, slot) DO NOTHING`,
          [t, mediaRef, iso(slot), iso(at), ageMinutes, JSON.stringify(metrics), JSON.stringify(breakdowns), belowThreshold, isFinal],
        );
        await tx.query(
          `UPDATE insight_media SET below_threshold = $4, latest_at = $3::timestamptz,
             latest = CASE WHEN $4 THEN latest ELSE $5::jsonb END, latest_breakdowns = CASE WHEN $4 THEN latest_breakdowns ELSE $6::jsonb END
           WHERE tenant_id = $1 AND id = $2`,
          [t, mediaRef, iso(at), belowThreshold, JSON.stringify(metrics), JSON.stringify(breakdowns)],
        );
      });
    },

    /** Ends a story's collecting. Its newest snapshot is the last good one and stays as final (7.3). */
    async closeStory(mediaRef, state) {
      const t = tenantId();
      await db.tx(async (tx) => {
        await tx.query('UPDATE insight_media SET story_final_state = $3 WHERE tenant_id = $1 AND id = $2', [t, mediaRef, state]);
        await tx.query(
          `UPDATE insight_snapshots SET is_final = true WHERE tenant_id = $1 AND media_ref = $2
             AND id = (SELECT id FROM insight_snapshots WHERE tenant_id = $1 AND media_ref = $2 ORDER BY captured_at DESC, id DESC LIMIT 1)`,
          [t, mediaRef],
        );
      });
    },

    /** Records a claimed poll's end. Only the worker holding the lease can: one that overran it changes nothing. */
    async finishPoll(poll, { outcome, nextDueAt = null, stop = false, errorCode = null, failed = false, at }) {
      const rows = await db.query(
        `UPDATE insight_polls SET next_due_at = COALESCE($4::timestamptz, next_due_at), lease_until = NULL, locked_by = NULL, last_finished_at = $5::timestamptz, last_outcome = $6, last_error_code = $7,
           attempts = CASE WHEN $8 THEN attempts + 1 ELSE 0 END, stopped_at = CASE WHEN $9 THEN $5::timestamptz ELSE stopped_at END
         WHERE tenant_id = $1 AND id = $2 AND locked_by = $3 RETURNING id`,
        [tenantId(), poll.id, poll.locked_by, nextDueAt === null ? null : iso(nextDueAt), iso(at), outcome, errorCode, failed, stop],
      );
      return rows.length > 0;
    },

    /** Refresh now: takes this business's one refresh per 15 minutes (7.8), so two taps can't both win. */
    async claimRefresh(at, everyMs) {
      const t = tenantId();
      await db.query('INSERT INTO insight_settings (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [t]);
      const rows = await db.query(
        `UPDATE insight_settings SET refresh_now_at = $2::timestamptz WHERE tenant_id = $1 AND (refresh_now_at IS NULL OR refresh_now_at <= $3::timestamptz) RETURNING tenant_id`,
        [t, iso(at), iso(at - everyMs)],
      );
      return rows.length > 0;
    },

    /** Brings forward what a seller expects to change. It only moves due times: the worker's own pauses and lease still decide what runs. */
    pullPollsForward: (ref, at, youngSince) => db.query(
      `UPDATE insight_polls p SET next_due_at = $3::timestamptz
       WHERE p.tenant_id = $1 AND p.account_ref = $2 AND p.stopped_at IS NULL AND p.next_due_at > $3::timestamptz AND p.job <> 'demographics'
         AND (p.job <> 'media' OR EXISTS (SELECT 1 FROM insight_media m WHERE m.tenant_id = p.tenant_id AND m.id = p.media_ref AND m.posted_at >= $4::timestamptz))`,
      [tenantId(), ref, iso(at), iso(youngSince)],
    ),

    // ---- what screens read ---------------------------------------------------------------------------------------------

    dailyRows: (ref, from, to) => db.query(
      'SELECT day::text AS day, metric, breakdown, breakdown_value, value, fetched_at FROM insight_daily WHERE tenant_id = $1 AND account_ref = $2 AND day >= $3::date AND day <= $4::date',
      [tenantId(), ref, from, to],
    ),

    demographicsRows: (ref, timeframe) => db.query(
      'SELECT metric, breakdown, breakdown_value, value, fetched_at FROM insight_demographics WHERE tenant_id = $1 AND account_ref = $2 AND timeframe = $3 ORDER BY value DESC, breakdown_value',
      [tenantId(), ref, timeframe],
    ),

    async onlineFollowers(ref) {
      return db.query('SELECT weekday, hour, value FROM insight_online_followers WHERE tenant_id = $1 AND account_ref = $2 ORDER BY weekday, hour', [tenantId(), ref]);
    },

    /** Newest first. after is the [sort key, id] of the last row of the page before. */
    async mediaPage(ref, { kind, includeDeleted, limit, after = null, since = null }) {
      const params = [tenantId(), ref];
      const add = (value) => (params.push(value), `$${params.length}`);
      const where = ['tenant_id = $1', 'account_ref = $2'];
      if (kind !== 'all') where.push(`kind = ${add(kind)}`);
      if (!includeDeleted) where.push('deleted_at IS NULL');
      if (since !== null) where.push(`COALESCE(posted_at, created_at) >= ${add(iso(since))}::timestamptz`);
      if (after) where.push(`(COALESCE(posted_at, created_at), id) < (${add(after[0])}::timestamptz, ${add(after[1])}::bigint)`);
      return db.query(`SELECT *, COALESCE(posted_at, created_at)::text AS sort_at FROM insight_media WHERE ${where.join(' AND ')} ORDER BY COALESCE(posted_at, created_at) DESC, id DESC LIMIT ${Number(limit)}`, params);
    },

    async mediaById(ref, mediaId) {
      const [row] = await db.query('SELECT * FROM insight_media WHERE tenant_id = $1 AND account_ref = $2 AND media_id = $3', [tenantId(), ref, mediaId]);
      return row ?? null;
    },

    snapshots: (mediaRef) => db.query('SELECT age_minutes, captured_at, metrics FROM insight_snapshots WHERE tenant_id = $1 AND media_ref = $2 ORDER BY age_minutes, id', [tenantId(), mediaRef]),

    /** Posts that could be ranked. Stories only when asked for: at a day old at most, they would drag every post's comparison down to its first day. */
    rankable: (ref, { kind, since }) => db.query(
      `SELECT id, media_id, kind, caption, thumbnail_url, posted_at FROM insight_media
       WHERE tenant_id = $1 AND account_ref = $2 AND posted_at IS NOT NULL AND posted_at >= $3::timestamptz AND (($4 = 'all' AND kind <> 'story') OR kind = $4)`,
      [tenantId(), ref, iso(since), kind],
    ),

    /** For each media ref, its newest snapshot younger than the age. */
    async snapshotsUnderAge(mediaRefs, maxAgeMinutes) {
      if (!mediaRefs.length) return [];
      return db.query(
        `SELECT DISTINCT ON (media_ref) media_ref, metrics FROM insight_snapshots
         WHERE tenant_id = $1 AND media_ref = ANY($2::bigint[]) AND age_minutes < $3 ORDER BY media_ref, age_minutes DESC, id DESC`,
        [tenantId(), mediaRefs, maxAgeMinutes],
      );
    },

    /** Posts with a reach figure, for the average-reach heatmap (7.5). */
    postsWithReach: (ref, since) => db.query(
      `SELECT posted_at, (latest->>'reach')::numeric AS reach FROM insight_media
       WHERE tenant_id = $1 AND account_ref = $2 AND kind <> 'story' AND posted_at >= $3::timestamptz AND jsonb_typeof(latest->'reach') = 'number'`,
      [tenantId(), ref, iso(since)],
    ),
  };
}
