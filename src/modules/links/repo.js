import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';

const toMeasurementId = (row) => ({ id: row.id, mediaId: row.media_id, kind: row.kind, network: row.network, value: row.value, updatedAt: row.updated_at });

/** SQL that is true when `column` names a media with an active trigger on a live automation of the business in $1. */
const isLiveReel = (column) => `EXISTS (SELECT 1 FROM automation_triggers t JOIN automations a ON a.tenant_id = t.tenant_id AND a.id = t.automation_id
                                        WHERE t.tenant_id = $1 AND t.media_id = ${column} AND t.active AND a.state = 'live')`;

function insertCheck(runner, { automationId, url, verdict, at }) {
  return runner.query(
    'INSERT INTO link_checks (tenant_id, automation_id, url, ok, reason, http_status, checked_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)',
    [tenantId(), automationId, url, verdict.ok, verdict.reason ?? '', verdict.httpStatus, at],
  );
}

/** Per-reel measurement ids, two-tap taps and link checks (PRD 4.11, 6.6, 6.13). Every call is for the current business. */
export function linksRepo(db) {
  return {
    // ---- measurement ids ----

    async listMeasurementIds({ mediaId, cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        `SELECT * FROM measurement_ids WHERE tenant_id = $1 AND ($2::text IS NULL OR media_id = $2) AND ($3::int IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
        [tenantId(), mediaId ?? null, after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map(toMeasurementId), nextCursor: page.nextCursor };
    },

    /** Sets the reel's id of this kind, replacing the one it had: a reel has one (PRD 6.6). */
    async saveMeasurementId({ mediaId, kind, network, value }, { actor }) {
      return db.tx(async (t) => {
        const [row] = await t.query(
          `INSERT INTO measurement_ids (tenant_id, media_id, kind, network, value) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, media_id, kind, network) DO UPDATE SET value = EXCLUDED.value, updated_at = now() RETURNING *`,
          [tenantId(), mediaId, kind, network, value],
        );
        await writeAudit(t, { actor, action: 'measurement_id.save', target: `measurement_id:${row.id}`, details: { kind, mediaId, network } });
        return toMeasurementId(row);
      });
    },

    async updateMeasurementId(id, value, { actor }) {
      return db.tx(async (t) => {
        const [row] = await t.query('UPDATE measurement_ids SET value = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *', [tenantId(), id, value]);
        if (!row) return null;
        await writeAudit(t, { actor, action: 'measurement_id.update', target: `measurement_id:${id}`, details: { kind: row.kind, mediaId: row.media_id, network: row.network } });
        return toMeasurementId(row);
      });
    },

    /** False when there is no such id in this business. */
    async removeMeasurementId(id, { actor }) {
      return db.tx(async (t) => {
        const [row] = await t.query('DELETE FROM measurement_ids WHERE tenant_id = $1 AND id = $2 RETURNING kind, media_id, network', [tenantId(), id]);
        if (!row) return false;
        await writeAudit(t, { actor, action: 'measurement_id.remove', target: `measurement_id:${id}`, details: { kind: row.kind, mediaId: row.media_id, network: row.network } });
        return true;
      });
    },

    /** True when this live reel's id is also on another live reel, so that earnings can't be split (PRD 6.6, A-35). */
    async sharedWithLiveReel({ mediaId, kind, network, value }) {
      const [row] = await db.query(
        `SELECT ${isLiveReel('$2')} AS this_live,
                EXISTS (SELECT 1 FROM measurement_ids m WHERE m.tenant_id = $1 AND m.kind = $3 AND m.network = $4 AND m.value = $5 AND m.media_id <> $2 AND ${isLiveReel('m.media_id')}) AS other_live`,
        [tenantId(), mediaId, kind, network, value],
      );
      return Boolean(row.this_live && row.other_live);
    },

    async idsForMedia(mediaId) {
      const rows = await db.query('SELECT * FROM measurement_ids WHERE tenant_id = $1 AND media_id = $2', [tenantId(), mediaId]);
      return rows.map(toMeasurementId);
    },

    // ---- two-tap taps ----

    /**
     * The private reply that carried this button, if it went to this person. A payload is only something Meta echoes back, so
     * whoever got hold of a copy could send it: what it claims has to match a DM we really sent to whoever tapped.
     */
    async firstDm({ channel, automationId, mediaId, commentId, subject }) {
      const [row] = await db.query(
        `SELECT id, variant_id, is_test FROM outbound_jobs
         WHERE tenant_id = $1 AND idempotency_key = $2 AND channel = $3 AND automation_id = $4 AND media_id = $5 AND subject_hash = $6
           AND kind = 'private_reply' AND status IN ('sending', 'sent', 'sent_fallback', 'unknown')`,
        [tenantId(), `private_reply:${commentId}`, channel, automationId, mediaId, subject],
      );
      return row ?? null;
    },

    /**
     * One row per person per reel: a repeat adds to tap_count and not to the people counted (PRD 6.13). `at` is the time on Meta's event,
     * so running the same event again after a crash finds its own timestamp and adds nothing.
     */
    async recordTap({ automationId, channel, mediaId, subject, commentId, variantId, isTest, at }) {
      await db.query(
        `INSERT INTO link_taps (tenant_id, automation_id, channel, media_id, subject_hash, comment_id, variant_id, is_test, first_tapped_at, last_tapped_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $9::timestamptz)
         ON CONFLICT (tenant_id, automation_id, channel, media_id, subject_hash) DO UPDATE SET
           tap_count = link_taps.tap_count + CASE WHEN link_taps.last_tapped_at = EXCLUDED.last_tapped_at THEN 0 ELSE 1 END,
           last_tapped_at = GREATEST(link_taps.last_tapped_at, EXCLUDED.last_tapped_at),
           is_test = link_taps.is_test AND EXCLUDED.is_test`,
        [tenantId(), automationId, channel, mediaId, subject, commentId, variantId, isTest, at],
      );
    },

    /** Per automation and reel. Testers, test mode and dry runs aren't counted (PRD 6.9). */
    async tapSummaries({ automationId, cursor, limit }) {
      const isKey = (key) => key.length === 3 && isRowId(key[0]) && typeof key[1] === 'string' && typeof key[2] === 'string';
      const after = cursor ? readCursor(cursor, isKey) : [null, null, null];
      const rows = await db.query(
        `SELECT automation_id, channel, media_id, count(*)::int AS people, sum(tap_count)::int AS taps FROM link_taps
         WHERE tenant_id = $1 AND NOT is_test AND ($2::int IS NULL OR automation_id = $2)
           AND ($3::int IS NULL OR (automation_id, channel, media_id) > ($3::int, $4::text, $5::text))
         GROUP BY automation_id, channel, media_id ORDER BY automation_id, channel, media_id LIMIT $6`,
        [tenantId(), automationId ?? null, ...after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.automation_id, row.channel, row.media_id]);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((row) => ({ automationId: row.automation_id, channel: row.channel, mediaId: row.media_id, people: row.people, taps: row.taps })),
      };
    },

    // ---- link checks ----

    recordCheck: (entry) => insertCheck(db, entry),

    /** A check of the automation's link passed. If the owner has changed the link since the check began, the answer is about nothing. */
    async linkPassed(automationId, url, verdict, at) {
      await db.tx(async (t) => {
        const [row] = await t.query(`UPDATE automations SET link_status = 'ok', link_checked_at = $4::timestamptz WHERE tenant_id = $1 AND id = $2 AND link_url = $3 RETURNING id`, [tenantId(), automationId, url, at]);
        if (row) await insertCheck(t, { automationId, url, verdict, at });
      });
    },

    /** The daily check failed: pauses the automation if it is still live on this link. True when it did (PRD 4.11, C-64). */
    async pauseForFailedLink(automationId, url, verdict, at) {
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE automations SET state = 'paused', paused_reason = $5, link_status = 'failed', link_checked_at = $4::timestamptz, updated_at = $4::timestamptz
           WHERE tenant_id = $1 AND id = $2 AND link_url = $3 AND state = 'live' RETURNING id`,
          [tenantId(), automationId, url, at, verdict.reason],
        );
        if (!row) return false;
        await insertCheck(t, { automationId, url, verdict, at });
        await writeAudit(t, { actor: 'system:link_check', action: 'automation.state', target: `automation:${automationId}`, details: { from: 'live', to: 'paused', reason: verdict.reason } });
        return true;
      });
    },

    /** The owner checked the link again and it works, so an automation paused over it can go live again: checkLaunch refuses a failed link. */
    async clearFailedLink(url, at) {
      await db.query(`UPDATE automations SET link_status = 'ok', link_checked_at = $3::timestamptz WHERE tenant_id = $1 AND link_url = $2 AND link_status = 'failed'`, [tenantId(), url, at]);
    },
  };
}
