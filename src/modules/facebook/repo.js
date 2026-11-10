import { ApiError } from '../../contracts/api/index.js';
import { log } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { writeAudit } from '../audit/index.js';
import { DISCONNECTED_BY_OWNER, raiseAlert } from '../ig-accounts/index.js';

// Any fixed number: it only has to differ from the other advisory locks taken on a business.
const LINK_LOCK = 4_242_106;

const targetOf = (pageId) => `facebook:${pageId}`;

/** One row of the compliance log, on `runner`, so a change and its row land together. Ids only. */
const logDecision = (runner, decision, details) => runner.query(
  `INSERT INTO compliance_events (tenant_id, channel, kind, decision, reason, details) VALUES ($1, 'facebook', 'token', $2, '', $3)`,
  [tenantId(), decision, JSON.stringify(details)],
);

/**
 * The current business's Facebook Pages and their tokens (PRD 6.10). compliance.send() reads get(). A token is encrypted here and decrypted
 * only when it is about to be used. Only an active Page ever has a token: a Page with a problem comes back with none, so nothing can send with it.
 */
export function fbPagesRepo(db, { secrets }) {
  function reveal(row) {
    if (!row.access_token_enc || row.status !== 'active') return '';
    try {
      return secrets.decrypt(row.access_token_enc);
    } catch {
      log.warn('fb_pages.undecryptable', { pageId: row.page_id });
      return '';
    }
  }

  const toAccount = (row) => ({ pageId: row.page_id, name: row.name, token: reveal(row), tokenVersion: row.token_version, status: row.status });

  /** Everything known about a connection, never the token. */
  const toDetail = (row) => ({
    pageId: row.page_id,
    name: row.name,
    linkedIgUserId: row.linked_ig_user_id,
    status: row.status,
    statusReason: row.status_reason,
    hasToken: row.access_token_enc !== '',
    tokenVersion: row.token_version,
    tokenExpiresAt: row.token_expires_at,
    scopes: row.granted_scopes ?? [],
    subscribedFields: row.subscribed_fields ?? [],
    subscribedAt: row.subscribed_at,
    connectedBy: row.connected_by,
    connectedAt: row.connected_at,
  });

  /** Jobs held for a reconnect go back in the queue. One past its expires_at stays held, for the compliance engine to expire with its own reason. */
  const releaseHeldJobs = (t, pageId) => t.query(
    `UPDATE outbound_jobs SET status = 'queued', reason = '', run_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND fb_page_id = $2 AND status = 'held' AND reason = 'paused.reconnect' AND expires_at > now() RETURNING id`,
    [tenantId(), pageId],
  );

  /** The compliance engine reopens Instagram's breaker when it is reconnected, and has no such step for Facebook: this is it. */
  const closeTokenBreaker = (t) => t.query(
    `UPDATE breakers SET state = 'closed', trip_reason = '', open_until = NULL, wait_minutes = 30, throttle_cycles = 0, updated_at = now()
     WHERE tenant_id = $1 AND channel = 'facebook' AND state <> 'closed' AND trip_reason = 'token.rejected'`,
    [tenantId()],
  );

  return {
    /** One of this business's Pages, as compliance.send() needs it: { pageId, name, token, tokenVersion, status }, or null. */
    async get(pageId) {
      const [row] = await db.query('SELECT * FROM fb_pages WHERE tenant_id = $1 AND page_id = $2', [tenantId(), String(pageId)]);
      return row ? toAccount(row) : null;
    },

    /** The Page this business sends from: the one with the newest token, or null when none is working. */
    async current() {
      const [row] = await db.query(
        `SELECT * FROM fb_pages WHERE tenant_id = $1 AND access_token_enc <> '' AND status = 'active' ORDER BY token_updated_at DESC NULLS LAST LIMIT 1`,
        [tenantId()],
      );
      if (!row) return null;
      const account = toAccount(row);
      return account.token ? account : null;
    },

    /** One Page's connection details, with no token, or null. */
    async detail(pageId) {
      const [row] = await db.query('SELECT * FROM fb_pages WHERE tenant_id = $1 AND page_id = $2', [tenantId(), String(pageId)]);
      return row ? toDetail(row) : null;
    },

    /** The connection a seller sees: a working one, otherwise the one that most recently stopped working. Null when there is none. */
    async primary() {
      const [row] = await db.query(
        `SELECT * FROM fb_pages WHERE tenant_id = $1 AND status_reason <> $2
         ORDER BY (access_token_enc <> '') DESC, status_changed_at DESC NULLS LAST, token_updated_at DESC NULLS LAST LIMIT 1`,
        [tenantId(), DISCONNECTED_BY_OWNER],
      );
      return row ? toDetail(row) : null;
    },

    /** This business's other Pages that still hold a token: connecting a new Page replaces them. */
    async othersWithTokens(pageId) {
      const rows = await db.query(`SELECT page_id FROM fb_pages WHERE tenant_id = $1 AND page_id <> $2 AND access_token_enc <> ''`, [tenantId(), String(pageId)]);
      return rows.map((row) => row.page_id);
    },

    /**
     * Connect or reconnect: the token, its version, what was granted, and the jobs held for a reconnect, in one transaction. The Page must already be
     * on this business. token_expires_at stays empty: a Page token made from a long-lived user token doesn't end on a date, it ends when Meta refuses it.
     */
    async saveConnection({ pageId, name = '', igUserId = '', token, scopes = [], connectedBy = null }) {
      const id = String(pageId);
      if (!token) throw new ValidationError('An access token is required');
      const encrypted = secrets.encrypt(token);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE fb_pages SET name = $3, linked_ig_user_id = $4, access_token_enc = $5, token_version = token_version + 1, token_updated_at = now(), token_expires_at = NULL,
             granted_scopes = $6, subscribed_fields = '{}', subscribed_at = NULL, status = 'active', status_reason = '', status_changed_at = now(), connected_by = $7::integer, connected_at = now()
           WHERE tenant_id = $1 AND page_id = $2 RETURNING *`,
          [tenantId(), id, name, igUserId, encrypted, scopes, connectedBy],
        );
        if (!row) throw new ValidationError('This Facebook Page is not on this business');
        const released = await releaseHeldJobs(t, id);
        await closeTokenBreaker(t);
        await writeAudit(t, {
          actor: connectedBy ? `user:${connectedBy}` : 'system',
          action: 'facebook.connected',
          target: targetOf(id),
          details: { scopes, tokenVersion: row.token_version, jobsReleased: released.length },
        });
        return { page: toDetail(row), jobsReleased: released.length };
      });
    },

    /** Records which webhook fields Meta has confirmed for this Page. */
    async setSubscribed(pageId, fields) {
      await db.query('UPDATE fb_pages SET subscribed_fields = $3, subscribed_at = now() WHERE tenant_id = $1 AND page_id = $2', [tenantId(), String(pageId), [...fields]]);
    },

    /**
     * Meta refused the token on a read, the same news compliance.send() gets on a send, and reported the same way: only Facebook stops, and one
     * token is alerted once whichever notices first. False when there was nothing to change.
     */
    async markRejected(pageId, tokenVersion, { actor = 'system' } = {}) {
      const id = String(pageId);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE fb_pages SET status = 'reconnect_needed', status_reason = 'token.rejected', status_changed_at = now()
           WHERE tenant_id = $1 AND page_id = $2 AND status = 'active' AND token_version = $3 RETURNING token_version`,
          [tenantId(), id, tokenVersion],
        );
        if (!row) return false;
        const held = await t.query(
          `UPDATE outbound_jobs SET status = 'held', reason = 'paused.reconnect', updated_at = now() WHERE tenant_id = $1 AND fb_page_id = $2 AND status = 'queued' RETURNING id`,
          [tenantId(), id],
        );
        await logDecision(t, 'token.rejected', { pageId: id, tokenVersion: row.token_version, jobsHeld: held.length });
        await writeAudit(t, { actor, action: 'facebook.token.rejected', target: targetOf(id), details: { tokenVersion: row.token_version, jobsHeld: held.length } });
        await raiseAlert(t, {
          kind: 'token.rejected',
          severity: 'critical',
          message: 'Facebook stopped accepting this account’s connection. Reconnect it to start sending again.',
          target: id,
          dedupeKey: `token.rejected:facebook:${id}:${row.token_version}`,
        });
        return true;
      });
    },

    /** The seller ended this connection. The token goes and nothing waits for it. The row stays, as "not connected", so the inbox survives. */
    async disconnect(pageId, { actor }) {
      const id = String(pageId);
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE fb_pages SET access_token_enc = '', status = 'deauthorized', status_reason = $3, status_changed_at = now(), token_updated_at = now(),
             granted_scopes = '{}', subscribed_fields = '{}', subscribed_at = NULL
           WHERE tenant_id = $1 AND page_id = $2 RETURNING token_version`,
          [tenantId(), id, DISCONNECTED_BY_OWNER],
        );
        if (!row) return false;
        const cancelled = await t.query(
          `UPDATE outbound_jobs SET status = 'cancelled', reason = 'cancelled.owner', updated_at = now() WHERE tenant_id = $1 AND fb_page_id = $2 AND status IN ('queued', 'held') RETURNING id`,
          [tenantId(), id],
        );
        await logDecision(t, 'token.deauthorized', { pageId: id, source: 'owner', jobsCancelled: cancelled.length });
        await writeAudit(t, { actor, action: 'facebook.disconnected', target: targetOf(id), details: { jobsCancelled: cancelled.length } });
        return true;
      });
    },
  };
}

const toLink = (row) => ({ fbPostId: row.fb_post_id, igMediaId: row.ig_media_id, status: row.status, confirmedAt: row.confirmed_at });

/**
 * Which Facebook post is which Instagram reel, for the current business (PRD 6.10). A link is only ever made by the owner confirming it. A link the
 * owner replaced or removed stays as 'rejected', which is what keeps "the link when this comment arrived" answerable (FB-03).
 */
export function fbLinksRepo(db) {
  return {
    /** The Page's confirmed links, newest first. */
    async list({ pageId, cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        `SELECT * FROM fb_post_links WHERE tenant_id = $1 AND fb_page_id = $2 AND status = 'confirmed' AND ($3::int IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
        [tenantId(), String(pageId), after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map(toLink), nextCursor: page.nextCursor };
    },

    /** Map of post id to its confirmed Instagram twin, for these posts. */
    async linkedTo(postIds) {
      const rows = await db.query(
        `SELECT fb_post_id, ig_media_id FROM fb_post_links WHERE tenant_id = $1 AND status = 'confirmed' AND fb_post_id = ANY($2::text[])`,
        [tenantId(), postIds.map(String)],
      );
      return new Map(rows.map((row) => [row.fb_post_id, row.ig_media_id]));
    },

    /** What the owner has already settled on this Page, which is never suggested again. */
    async decided(pageId) {
      const rows = await db.query(`SELECT fb_post_id, ig_media_id, status FROM fb_post_links WHERE tenant_id = $1 AND fb_page_id = $2 AND status <> 'suggested'`, [tenantId(), String(pageId)]);
      const confirmed = rows.filter((row) => row.status === 'confirmed');
      return {
        confirmedPosts: new Set(confirmed.map((row) => row.fb_post_id)),
        confirmedMedia: new Set(confirmed.map((row) => row.ig_media_id)),
        rejected: new Set(rows.filter((row) => row.status === 'rejected').map((row) => `${row.fb_post_id}\n${row.ig_media_id}`)),
      };
    },

    /**
     * The Instagram twin a post had at `at`, or null (FB-03). A comment follows the link in force when it arrived, however long it then
     * waited in the queue, so a fix made in the meantime changes only what comes after it.
     */
    async twinAt(postId, at) {
      const [row] = await db.query(
        `SELECT ig_media_id FROM fb_post_links
         WHERE tenant_id = $1 AND fb_post_id = $2 AND confirmed_at <= $3::timestamptz AND (status = 'confirmed' OR (status = 'rejected' AND updated_at > $3::timestamptz))
         ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
        [tenantId(), String(postId), at],
      );
      return row?.ig_media_id ?? null;
    },

    /** True when this business already uses this Instagram media in an automation or a reel. */
    async ownsMedia(igMediaId) {
      const [row] = await db.query(
        `SELECT (EXISTS (SELECT 1 FROM automation_triggers WHERE tenant_id = $1 AND channel = 'instagram' AND media_id = $2 AND active)
              OR EXISTS (SELECT 1 FROM reels WHERE tenant_id = $1 AND ig_media_id = $2 AND active)) AS owned`,
        [tenantId(), String(igMediaId)],
      );
      return Boolean(row?.owned);
    },

    /** Confirms this post as this reel, replacing whatever the post was linked to. A reel can be the twin of one post at a time. */
    async save({ pageId, postId, igMediaId, userId, actor, at }) {
      return db.tx(async (t) => {
        await t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [LINK_LOCK, tenantId()]);
        const [taken] = await t.query(
          `SELECT 1 FROM fb_post_links WHERE tenant_id = $1 AND ig_media_id = $2 AND status = 'confirmed' AND fb_post_id <> $3`,
          [tenantId(), igMediaId, postId],
        );
        if (taken) throw new ApiError('conflict', 'That reel is already linked to another Facebook post. Remove that link first.');
        const [same] = await t.query(`SELECT * FROM fb_post_links WHERE tenant_id = $1 AND fb_post_id = $2 AND ig_media_id = $3 AND status = 'confirmed'`, [tenantId(), postId, igMediaId]);
        if (same) return toLink(same);
        await t.query(`UPDATE fb_post_links SET status = 'rejected', updated_at = $3::timestamptz WHERE tenant_id = $1 AND fb_post_id = $2 AND status = 'confirmed'`, [tenantId(), postId, at]);
        const [row] = await t.query(
          `INSERT INTO fb_post_links (tenant_id, fb_page_id, fb_post_id, ig_media_id, status, confirmed_by, confirmed_at, updated_at)
           VALUES ($1, $2, $3, $4, 'confirmed', $5, $6::timestamptz, $6::timestamptz)
           ON CONFLICT (tenant_id, fb_post_id, ig_media_id) DO UPDATE SET fb_page_id = EXCLUDED.fb_page_id, status = 'confirmed', confirmed_by = EXCLUDED.confirmed_by, confirmed_at = EXCLUDED.confirmed_at, updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [tenantId(), pageId, postId, igMediaId, userId, at],
        );
        await writeAudit(t, { actor, action: 'facebook.link_saved', target: targetOf(postId), details: { igMediaId } });
        return toLink(row);
      });
    },

    /** Ends a confirmed link. False when the post has none. */
    async remove(postId, { actor, at }) {
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE fb_post_links SET status = 'rejected', updated_at = $3::timestamptz WHERE tenant_id = $1 AND fb_post_id = $2 AND status = 'confirmed' RETURNING ig_media_id`,
          [tenantId(), postId, at],
        );
        if (!row) return false;
        await writeAudit(t, { actor, action: 'facebook.link_removed', target: targetOf(postId), details: { igMediaId: row.ig_media_id } });
        return true;
      });
    },
  };
}
