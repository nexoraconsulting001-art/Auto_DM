import { COMPLIANCE_LIMITS } from '../../contracts/compliance.js';
import { tenantId } from '../../tenancy.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';

const LAST_MESSAGE_CHARS = 500;
const DETAIL_MESSAGES = 200;

/** The owner can still answer: now minus the person's last message is under 23h50m (PRD 6.7). */
export function windowOpen(lastUserMessageAt, now = new Date()) {
  return Boolean(lastUserMessageAt) && now.getTime() - new Date(lastUserMessageAt).getTime() < COMPLIANCE_LIMITS.messagingWindowMs;
}

/** An automation pause that hasn't run out, as the row's reason, or ''. */
const activePause = (thread, now = new Date()) =>
  (thread?.automation_paused_until && new Date(thread.automation_paused_until) > now ? thread.pause_reason : '');

const isSortAt = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/.test(value);

/**
 * The owner inbox and "Needs a human" (PRD 6.7): the only place a shopper's display name and message text are kept, for
 * 30 days. The compliance worker writes what comes in and what the automations send; this reads it and adds what the owner types.
 */
export function inboxRepo(db) {
  const toThread = (row, now = new Date()) => {
    const paused = Boolean(activePause(row, now));
    return {
      id: row.id,
      channel: row.channel,
      username: row.username,
      lastMessage: row.last_message,
      lastMessageAt: row.last_message_at,
      lastUserMessageAt: row.last_user_message_at,
      status: row.status,
      automationPausedUntil: paused ? row.automation_paused_until : null,
      pauseReason: paused ? row.pause_reason : '',
      canReply: windowOpen(row.last_user_message_at, now),
    };
  };

  const toItem = (row) => ({
    id: row.id, channel: row.channel, kind: row.kind, reason: row.reason, threadId: row.thread_id, commentId: row.comment_id, mediaId: row.media_id, username: row.username, text: row.text, status: row.status, createdAt: row.created_at,
  });

  return {
    async threadBySubject(channel, subject) {
      const [row] = await db.query('SELECT * FROM inbox_threads WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3', [tenantId(), channel, subject]);
      return row ?? null;
    },

    async threadRow(id) {
      const [row] = await db.query('SELECT * FROM inbox_threads WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row ?? null;
    },

    /** What the owner typed, once it has gone. `mid` is null for a send Meta gave no id for. */
    async addOwnerReply({ threadId, text, mid = null, at }) {
      await db.tx(async (t) => {
        await t.query(
          `INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, kind, text, mid, created_at)
           VALUES ($1, $2, 'out', 'owner', 'text', $3, $4, $5)
           ON CONFLICT (tenant_id, mid) WHERE mid IS NOT NULL DO NOTHING`,
          [tenantId(), threadId, text, mid, at],
        );
        await t.query(
          `UPDATE inbox_threads SET last_message = $3, last_message_at = GREATEST(last_message_at, $4::timestamptz), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), threadId, text.slice(0, LAST_MESSAGE_CHARS), at],
        );
      });
    },

    /** A manual reply stops automation in the thread for a while (PRD 6.7). Returns until when. */
    async pauseForOwner(id, until) {
      const [row] = await db.query(
        `UPDATE inbox_threads SET automation_paused_until = GREATEST(automation_paused_until, $3::timestamptz), pause_reason = 'thread.owner_replied', updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING automation_paused_until`,
        [tenantId(), id, until],
      );
      return row?.automation_paused_until ?? null;
    },

    async listThreads({ status, cursor, limit, now }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 2 && isSortAt(key[0]) && isRowId(key[1])) : [null, null];
      const rows = await db.query(
        `SELECT *, COALESCE(last_message_at, created_at)::text AS sort_at FROM inbox_threads
         WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::timestamptz IS NULL OR (COALESCE(last_message_at, created_at), id) < ($3::timestamptz, $4::int))
         ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC LIMIT $5`,
        [tenantId(), status ?? null, after[0], after[1], limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.sort_at, row.id]);
      return { items: page.items.map((row) => toThread(row, now)), nextCursor: page.nextCursor };
    },

    async threadDetail(id, now) {
      const [row] = await db.query('SELECT * FROM inbox_threads WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      if (!row) return null;
      const messages = await db.query(
        `SELECT * FROM (SELECT * FROM inbox_messages WHERE tenant_id = $1 AND thread_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3) latest ORDER BY created_at, id`,
        [tenantId(), id, DETAIL_MESSAGES],
      );
      return {
        ...toThread(row, now),
        messages: messages.map((m) => ({ id: Number(m.id), direction: m.direction, author: m.author, kind: m.kind, text: m.text, mediaRef: m.media_ref, at: m.created_at })),
      };
    },

    toThread,

    async listNeedsHuman({ status, cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(
        'SELECT * FROM needs_human_items WHERE tenant_id = $1 AND status = $2 AND ($3::int IS NULL OR id < $3) ORDER BY id DESC LIMIT $4',
        [tenantId(), status, after, limit + 1],
      );
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map(toItem), nextCursor: page.nextCursor };
    },

    /** Marks an item done. A thread with nothing left open goes back to the ordinary list. */
    async resolve(id, userId) {
      return db.tx(async (t) => {
        const [row] = await t.query(
          `UPDATE needs_human_items SET status = 'resolved', resolved_by = $3, resolved_at = COALESCE(resolved_at, now()) WHERE tenant_id = $1 AND id = $2 RETURNING *`,
          [tenantId(), id, userId],
        );
        if (!row) return null;
        if (row.thread_id) {
          await t.query(
            `UPDATE inbox_threads SET status = 'open', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'needs_human'
               AND NOT EXISTS (SELECT 1 FROM needs_human_items n WHERE n.tenant_id = $1 AND n.thread_id = $2 AND n.status = 'open')`,
            [tenantId(), row.thread_id],
          );
        }
        return toItem(row);
      });
    },
  };
}
