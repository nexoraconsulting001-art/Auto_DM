import crypto from 'node:crypto';
import { CommentValue, FeedValue, MessagingEvent, WebhookChange, WebhookEntry } from '../../contracts/api/provider.js';
import { log as logger, reportError } from '../../platform/log.js';
import { currentTenant, tenantId, withTenant } from '../../tenancy.js';
import { buyerBaseUrl, reelStoreUrl } from '../admin-api/urls.js';
import { matchesKeywords } from '../automations/match.js';
import { hasNegativeIntent, isOptOut, isStart, isTooShort, wantsHuman } from './words.js';

const MINUTE = 60_000;
const INBOUND_LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const ECHO_RETRY_MS = 3_000;
const DRAIN_PER_TENANT = 25;
const DRAIN_LIMIT = 200;
const INBOX_TEXT_CHARS = 2000;
const HANDLED_FIELDS = new Set(['comments', 'live_comments', 'feed', 'mentions', 'messages', 'messaging_postbacks']);
const DEFAULT_OPTOUT_CONFIRMATION = 'You won’t get automated messages from us any more. Reply START if you change your mind.';
const LEGACY_DM_TEXT = 'Here’s everything from the reel 👇';

const short = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Postgres can't store a NUL in text or a lone surrogate in jsonb, and either one in a comment must not cost us the event. */
function storable(value, depth = 0) {
  if (typeof value === 'string') return value.replaceAll('\0', '').toWellFormed();
  if (depth > 12 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => storable(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [storable(k, depth + 1), storable(v, depth + 1)]));
}

/** An edit gets a key of its own, and one per text, so that two different edits are both seen and a redelivery of either is not. */
function commentKey(id, verb, text) {
  if (verb === 'edited') return `${id}:edited:${short(text)}`;
  if (verb === 'remove' || verb === 'removed' || verb === 'delete' || verb === 'deleted') return `${id}:remove`;
  return String(id);
}

function changeRow(accountId, field, value, shared) {
  const row = { account_id: accountId, field, status: 'stored' };
  if (field === 'comments' || field === 'live_comments') {
    const parsed = CommentValue.safeParse(value);
    if (!parsed.success) return null;
    return { ...row, object_id: commentKey(parsed.data.id, parsed.data.verb ?? '', parsed.data.text), payload: { value, ...shared } };
  }
  if (field === 'feed') {
    const parsed = FeedValue.safeParse(value);
    if (!parsed.success) return null;
    if (parsed.data.item !== 'comment' || !parsed.data.comment_id) return { ignored: true };
    return { ...row, object_id: commentKey(parsed.data.comment_id, parsed.data.verb === 'add' ? '' : parsed.data.verb, parsed.data.message), payload: { value, ...shared } };
  }
  if (field === 'mentions') {
    if (!isObject(value) || (value.comment_id === undefined && value.media_id === undefined)) return null;
    return { ...row, object_id: String(value.comment_id ?? value.media_id), payload: { value, ...shared } };
  }
  if (field === 'messages' || field === 'messaging_postbacks') return messagingRow(accountId, value, shared);
  return { ignored: true };
}

function messagingRow(accountId, value, shared) {
  const parsed = MessagingEvent.safeParse(value);
  if (!parsed.success) return null;
  const { message, postback, read, sender, timestamp } = parsed.data;
  if (message) return { account_id: accountId, field: 'messages', status: 'stored', object_id: message.mid, payload: { event: value, ...shared } };
  if (postback) return { account_id: accountId, field: 'messaging_postbacks', status: 'stored', object_id: postback.mid ?? `${sender.id}:${timestamp}:${short(postback.payload)}`, payload: { event: value, ...shared } };
  if (read) return { account_id: accountId, field: 'messaging_seen', status: 'stored', object_id: `${sender.id}:${read.mid ?? read.watermark ?? timestamp}`, payload: { event: value, ...shared } };
  return { ignored: true };
}

/** One row per thing in the delivery. A malformed item becomes a row of its own and never takes the rest with it. */
function rowsOf(body, base) {
  const channel = body.object === 'page' ? 'facebook' : 'instagram';
  const perAccount = new Map();
  let unreadable = 0;
  for (const raw of body.entry) {
    const entry = WebhookEntry.safeParse(raw);
    if (!entry.success) {
      unreadable++;
      continue;
    }
    const accountId = entry.data.id;
    const rows = perAccount.get(accountId) ?? [];
    perAccount.set(accountId, rows);
    const shared = { time: entry.data.time ?? null, base };
    const add = (made, field, value) => {
      if (made?.ignored) return;
      if (made) rows.push(made);
      else rows.push({ account_id: accountId, field, status: 'malformed', object_id: `malformed:${short(JSON.stringify(value ?? null))}`, payload: {} });
    };
    for (const change of Array.isArray(entry.data.changes) ? entry.data.changes : []) {
      const parsed = WebhookChange.safeParse(change);
      if (!parsed.success) {
        add(null, 'unknown', change);
      } else if (HANDLED_FIELDS.has(parsed.data.field)) {
        add(changeRow(accountId, parsed.data.field, parsed.data.value, shared), parsed.data.field, parsed.data.value);
      }
    }
    for (const event of Array.isArray(entry.data.messaging) ? entry.data.messaging : []) {
      add(messagingRow(accountId, event, shared), 'messages', event);
    }
  }
  return { channel, perAccount, unreadable };
}

/**
 * Webhook intake and the worker that handles what it stored (PRD 4.1, 4.4, 4.6, 4.8, 6.4). The compliance rules run here, and what is
 * left goes to the modules registered with compliance.onInbound(fn), which decide whether an automation answers it. fn gets:
 *
 *   { type: 'comment' | 'dm' | 'story_reply' | 'story_mention' | 'postback' | 'attachment' | 'post_mention' | 'seen', channel, accountId, receivedAt,
 *     personId, subject, username?, text, mediaId?, mediaType?, commentId?, parentId?, expiresAt?, mid?, payload?, storyId?, mediaRef?,
 *     tooShort?, threadId?, threadPaused? }
 *
 * By then a comment is known not to be the business's own, not in its own thread, not on an ad or a Live, not a STOP, and, on mapped
 * media, not a complaint. A DM is known not to be an echo, a STOP, a START or a request for a human. Return truthy to say "this was mine".
 * expiresAt is ready for a comment's private reply.
 */
export function createInbound({ db, repos, log, meta, now, limits, config, platform, enqueue, cancelForPerson, cancelForComment, consumers, gate, callAllowedNow }) {
  const swallow = (msg) => (err) => reportError(err, { msg });
  const note = (ev, reason, { decision = 'skipped', kind = 'comment', details = {} } = {}) => log.record({
    channel: ev.channel, kind, subject: ev.subject ?? '', decision, reason, details, mediaId: ev.mediaId ?? '', commentId: ev.commentId ?? '', at: now(),
  });

  // ---- storing a delivery -----------------------------------------------------------------------------------------

  async function routeAccounts(channel, ids) {
    const facebook = channel === 'facebook';
    const rows = await db.platform.query(
      `SELECT a.${facebook ? 'page_id' : 'ig_user_id'} AS account_id, t.id, t.slug, t.name, t.status
       FROM ${facebook ? 'fb_pages' : 'ig_accounts'} a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.${facebook ? 'page_id' : 'ig_user_id'} IN (SELECT jsonb_array_elements_text($1::jsonb))`,
      [JSON.stringify(ids)],
    );
    return new Map(rows.map((r) => [r.account_id, r]));
  }

  /** The account id and nothing else (PRD 4.1). */
  async function storeUnrouted(channel, accountId) {
    await db.platform.query(
      `INSERT INTO inbound_unrouted (channel, account_id) VALUES ($1, $2)
       ON CONFLICT (channel, account_id) DO UPDATE SET deliveries = inbound_unrouted.deliveries + 1, last_seen_at = now()`,
      [channel, accountId],
    );
    logger.warn('webhook.unknown_entry', { channel, account: accountId, reason: 'tenant.unknown_entry' });
  }

  async function storeForTenant(tenant, channel, rows) {
    const stored = await withTenant(tenant, () => db.query(
      `INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id, payload, status, received_at)
       SELECT $1::integer, $2::text, x.account_id, x.field, x.object_id, x.payload, x.status, $3::timestamptz
       FROM jsonb_to_recordset($4::jsonb) AS x(account_id text, field text, object_id text, payload jsonb, status text)
       ON CONFLICT (tenant_id, channel, field, object_id) DO NOTHING RETURNING field, object_id`,
      [tenant.id, channel, now(), JSON.stringify(storable(rows))],
    ));
    const isNew = new Set(stored.map((r) => `${r.field}\n${r.object_id}`));
    const seen = new Set();
    await withTenant(tenant, async () => {
      for (const row of rows) {
        const key = `${row.field}\n${row.object_id}`;
        const duplicate = !isNew.has(key) || seen.has(key);
        seen.add(key);
        if (!duplicate && row.status !== 'malformed') continue;
        const commentId = row.field === 'comments' || row.field === 'feed' ? row.object_id.split(':')[0] : '';
        const reason = duplicate ? 'webhook.duplicate' : 'webhook.malformed';
        await log.record({ channel, kind: 'webhook', decision: 'skipped', reason, details: { field: row.field }, commentId: duplicate ? commentId : '', at: now() }).catch(swallow('compliance.log_failed'));
      }
    });
  }

  /** Called from the route after the signature has passed. Nothing is forwarded anywhere. Throws if it can't store: the route then answers 500 and Meta retries. */
  async function storeDelivery(body, { base = '' } = {}) {
    if (!isObject(body) || !Array.isArray(body.entry)) {
      logger.warn('webhook.malformed', { reason: 'webhook.malformed' });
      return;
    }
    const { channel, perAccount, unreadable } = rowsOf(body, base);
    if (unreadable) logger.warn('webhook.malformed', { reason: 'webhook.malformed', entries: unreadable });
    const ids = [...perAccount.keys()];
    if (!ids.length) return;
    const owners = await routeAccounts(channel, ids);
    for (const [accountId, rows] of perAccount) {
      const owner = owners.get(accountId);
      if (!owner) await storeUnrouted(channel, accountId);
      else if (rows.length) await storeForTenant({ id: owner.id, slug: owner.slug, name: owner.name, status: owner.status }, channel, rows);
    }
  }

  // ---- what a stored event means --------------------------------------------------------------------------------

  const whenOf = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value);
    if (typeof value === 'string' && value) {
      const t = Date.parse(value);
      return Number.isNaN(t) ? null : new Date(t);
    }
    return null;
  };

  const privateReplyExpiresAt = ({ createdTime, receivedAt }) => (createdTime
    ? new Date(+new Date(createdTime) + limits.privateReplyExpiryMs)
    : new Date(+new Date(receivedAt) + limits.privateReplyNoTimestampExpiryMs));

  function decode(row) {
    const base = { rowId: row.id, channel: row.channel, accountId: row.account_id, field: row.field, receivedAt: row.received_at, requestBase: row.payload?.base ?? '' };
    if (row.field === 'comments' || row.field === 'live_comments') {
      const v = row.payload.value;
      const parsed = CommentValue.parse(v);
      const createdAt = whenOf(v.timestamp ?? v.created_time);
      return { ...base, type: 'comment', verb: parsed.verb ?? '', commentId: parsed.id, mediaId: parsed.media.id, mediaType: parsed.media.media_product_type ?? '', personId: parsed.from.id, username: parsed.from.username ?? '', text: parsed.text, parentId: parsed.parent_id ?? '', createdAt, expiresAt: privateReplyExpiresAt({ createdTime: createdAt, receivedAt: row.received_at }) };
    }
    if (row.field === 'feed') {
      const v = FeedValue.parse(row.payload.value);
      const createdAt = whenOf(v.created_time);
      const parentId = v.parent_id && v.parent_id !== v.post_id ? v.parent_id : '';
      return { ...base, type: 'comment', verb: v.verb === 'add' ? '' : v.verb, commentId: v.comment_id, mediaId: v.post_id ?? '', mediaType: '', personId: v.from?.id ?? '', username: v.from?.name ?? '', text: v.message, parentId, createdAt, expiresAt: privateReplyExpiresAt({ createdTime: createdAt, receivedAt: row.received_at }) };
    }
    if (row.field === 'mentions') {
      const v = row.payload.value;
      return { ...base, type: 'post_mention', commentId: v.comment_id ? String(v.comment_id) : '', mediaId: v.media_id ? String(v.media_id) : '', text: '' };
    }
    const e = MessagingEvent.parse(row.payload.event);
    const person = { personId: e.sender.id, timestamp: e.timestamp };
    if (e.postback) return { ...base, ...person, type: 'postback', mid: e.postback.mid ?? row.object_id, text: e.postback.title ?? '', payload: e.postback.payload };
    if (e.read) return { ...base, ...person, type: 'seen', mid: e.read.mid ?? '', watermark: e.read.watermark ?? null, text: '' };
    const m = e.message;
    if (!m) return null;
    if (m.is_echo) return { ...base, type: 'echo', recipientId: e.recipient.id, mid: m.mid, text: m.text ?? '' };
    const attachments = m.attachments ?? [];
    const mention = attachments.find((a) => a.type === 'story_mention');
    if (mention) return { ...base, ...person, type: 'story_mention', mid: m.mid, text: '', mediaRef: mention.payload?.url ?? '' };
    if (m.reply_to?.story) return { ...base, ...person, type: 'story_reply', mid: m.mid, text: m.text ?? '', storyId: m.reply_to.story.id, mediaId: m.reply_to.story.id, mediaRef: m.reply_to.story.url ?? '' };
    if (attachments.length && !m.text) return { ...base, ...person, type: 'attachment', mid: m.mid, text: '', mediaRef: attachments[0].payload?.url ?? '' };
    return { ...base, ...person, type: 'dm', mid: m.mid, text: m.text ?? '', quickReply: m.quick_reply?.payload ?? '' };
  }

  async function ownIds(ev) {
    if (ev.channel === 'facebook') return new Set([ev.accountId]);
    const [row] = await db.query('SELECT app_scoped_id FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [tenantId(), ev.accountId]);
    return new Set([ev.accountId, row?.app_scoped_id].filter(Boolean));
  }

  /** PRD 4.4: a reply under the business's own comment. Stored events first; only if those don't know, one read from Meta. */
  async function isOwnThread(ev, own) {
    if (!ev.parentId) return false;
    const [seen] = await db.query(`SELECT payload FROM inbound_events WHERE tenant_id = $1 AND channel = $2 AND field = $3 AND object_id = $4`, [tenantId(), ev.channel, ev.field, ev.parentId]);
    const author = seen?.payload?.value?.from?.id;
    if (author !== undefined) return own.has(String(author));
    const [ours] = await db.query(`SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND kind = 'public_reply' AND message_id = $2`, [tenantId(), ev.parentId]);
    if (ours) return true;
    try {
      const account = await gate.findAccount({ channel: ev.channel, accountId: ev.accountId });
      if (!account?.token || !meta?.client) return false;
      const comment = await meta.client.forAccount(account).getComment(ev.parentId);
      return own.has(String(comment?.from?.id ?? ''));
    } catch {
      return false; // can't tell, and treating it as a stranger's comment is what the other rules expect
    }
  }

  async function isMapped(ev) {
    const [trigger] = await db.query(`SELECT 1 FROM automation_triggers WHERE tenant_id = $1 AND channel = $2 AND media_id = $3 AND active LIMIT 1`, [tenantId(), ev.channel, ev.mediaId]);
    if (trigger) return true;
    if (ev.channel === 'facebook') {
      const [link] = await db.query(`SELECT 1 FROM fb_post_links WHERE tenant_id = $1 AND fb_post_id = $2 AND status = 'confirmed'`, [tenantId(), ev.mediaId]);
      return Boolean(link);
    }
    return Boolean(await repos.reels?.getActiveByMediaId(ev.mediaId));
  }

  async function addNeedsHuman({ channel, kind, reason, subject = '', threadId = null, commentId = '', mediaId = '', username = '', text = '' }) {
    await db.query(
      `INSERT INTO needs_human_items (tenant_id, channel, thread_id, kind, reason, subject_hash, comment_id, media_id, username, text, created_at)
       SELECT $1::integer, $2::text, $3::integer, $4::text, $5::text, $6::text, $7::text, $8::text, $9::text, $10::text, $11::timestamptz
       WHERE NOT EXISTS (SELECT 1 FROM needs_human_items WHERE tenant_id = $1::integer AND kind = $4::text AND subject_hash = $6::text AND status = 'open' AND comment_id = $7::text AND ($7::text <> '' OR thread_id = $3::integer))`,
      [tenantId(), channel, threadId, kind, reason, subject, commentId, mediaId, username, String(text).slice(0, INBOX_TEXT_CHARS), now()],
    );
  }

  // ---- comments -----------------------------------------------------------------------------------------------

  async function commentStillTriggers(job, text) {
    if (job.kind !== 'private_reply') return false;
    if (job.automation_id) {
      const [a] = await db.query('SELECT match_mode, keywords FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId(), job.automation_id]);
      if (!a || a.match_mode === 'any') return true;
      return matchesKeywords(text, a.keywords);
    }
    if (job.payload?.legacy) {
      const reel = await repos.reels?.getActiveByMediaId(job.media_id);
      if (!reel) return true;
      return matchesKeywords(text, Array.isArray(reel.keywords) ? reel.keywords : [reel.keywords]);
    }
    return true;
  }

  async function onCommentEdited(ev) {
    const negatives = await log.wordsFor('negative');
    const negative = hasNegativeIntent(ev.text, negatives);
    const cancelled = await cancelForComment(ev.channel, ev.commentId, 'comment.edited', async (job) => negative || !(await commentStillTriggers(job, ev.text)));
    if (!cancelled) await note({ ...ev, subject: await log.subjectHash(ev.channel, ev.personId) }, 'comment.edited', { decision: 'skipped', details: { cancelled: 0 } });
  }

  async function runConsumers(ev) {
    let handled = false;
    for (const consumer of consumers) if (await consumer(ev)) handled = true;
    return handled;
  }

  /** PRD 4.6: a comment that is just STOP. Blocklisted, and nothing goes back to it: no DM, no public reply, no confirmation. */
  async function onComment(ev) {
    if (['remove', 'removed', 'delete', 'deleted'].includes(ev.verb)) {
      await cancelForComment(ev.channel, ev.commentId, 'comment.deleted');
      return;
    }
    if (ev.verb === 'edited') {
      await onCommentEdited(ev);
      return;
    }
    if (!ev.personId) {
      await note(ev, 'webhook.malformed');
      return;
    }
    const subject = await log.subjectHash(ev.channel, ev.personId);
    const event = { ...ev, subject };
    const own = await ownIds(ev);
    if (own.has(ev.personId)) {
      await note(event, 'own_account');
      return;
    }
    if (ev.field === 'live_comments' || ['AD', 'LIVE'].includes(String(ev.mediaType).toUpperCase())) {
      await note(event, 'unsupported_media');
      return;
    }
    if (await isOwnThread(event, own)) {
      await note(event, 'own_thread');
      return;
    }
    const [optout, negatives] = [await log.wordsFor('optout'), await log.wordsFor('negative')];
    if (isOptOut(ev.text, optout)) {
      await log.addOptOut(ev.channel, subject, 'comment', now());
      await cancelForPerson(ev.channel, subject, 'cancelled.optout');
      await note(event, 'optout', { kind: 'optout' });
      return;
    }
    const mapped = await isMapped(event);
    if (mapped && hasNegativeIntent(ev.text, negatives)) {
      await addNeedsHuman({ channel: ev.channel, kind: 'negative_comment', reason: 'negative_intent', subject, commentId: ev.commentId, mediaId: ev.mediaId, username: ev.username, text: ev.text });
      await note(event, 'negative_intent');
      return;
    }
    const ready = { ...event, tooShort: isTooShort(ev.text), expiresAt: mapped ? await replyExpiry(event) : ev.expiresAt };
    const handled = await runConsumers(ready);
    if (!handled) await legacyComment(ready);
  }

  /**
   * PRD 4.4: a private reply expires 7 days less an hour from the comment. Webhooks don't say when a comment was made (row 23), so it is
   * asked for here, on media that could answer it, unless BUC is paused. Without an answer the received-at rule applies.
   */
  async function replyExpiry(ev) {
    if (ev.createdAt || !meta?.client) return ev.expiresAt;
    try {
      const { allow } = await callAllowedNow(ev.channel, ev.accountId, 'comment_timestamp');
      if (!allow) return ev.expiresAt;
      const account = await gate.findAccount({ channel: ev.channel, accountId: ev.accountId });
      if (!account?.token) return ev.expiresAt;
      const comment = await meta.client.forAccount(account).getComment(ev.commentId);
      const created = whenOf(comment?.timestamp);
      return created ? privateReplyExpiresAt({ createdTime: created, receivedAt: ev.receivedAt }) : ev.expiresAt;
    } catch {
      return ev.expiresAt;
    }
  }

  /** The reels mapping from before automations. Until the automations module answers a comment, this does, through the same gate. */
  async function legacyComment(ev) {
    const hasNewEngine = consumers.length > 0;
    const entry = { commentId: ev.commentId, reelId: ev.mediaId, userId: ev.personId, username: '', text: '' };
    const finish = async (result) => {
      logger.info('webhook.comment', { comment: ev.commentId, media: ev.mediaId, result });
      platform?.metrics?.inc('webhook_comments_total', { result: result.split(':')[0] });
    };
    const reel = ev.channel === 'instagram' ? await repos.reels?.getActiveByMediaId(ev.mediaId) : null;
    if (!reel) {
      if (hasNewEngine) return;
      await repos.activity?.log({ ...entry, result: 'skip:unmapped-reel' });
      await note(ev, 'unmapped');
      await finish('skip:unmapped-reel');
      return;
    }
    const keywords = Array.isArray(reel.keywords) ? reel.keywords : String(reel.keywords).split(',');
    if (ev.tooShort && !keywords.some((k) => matchesKeywords(ev.text, [k]) && !/[\p{L}\p{N}]/u.test(k))) {
      await repos.activity?.log({ ...entry, result: 'skip:too-short' });
      await note(ev, 'too_short');
      await finish('skip:too-short');
      return;
    }
    if (!matchesKeywords(ev.text, keywords)) {
      await repos.activity?.log({ ...entry, result: 'skip:no-keyword' });
      await note(ev, 'no_keyword');
      await finish('skip:no-keyword');
      return;
    }
    const account = await gate.findAccount({ channel: ev.channel, accountId: ev.accountId });
    if (!account?.token) await repos.activity?.log({ ...entry, result: 'skip:not-connected' });

    const base = buyerBaseUrl(currentTenant(), config) || ev.requestBase;
    const url = reelStoreUrl(base, reel.slug);
    const text = String(reel.dm_message || LEGACY_DM_TEXT).replace(/\{username\}/g, ev.username).replace(/\{first_name\}/g, '').replace(/\{url\}/g, url);
    if (account?.token) await repos.activity?.claim(entry);
    const result = await enqueue({
      kind: 'private_reply', purpose: 'trigger', channel: ev.channel, accountId: ev.accountId, idempotencyKey: `private_reply:${ev.commentId}`,
      expiresAt: ev.expiresAt, commentId: ev.commentId, personId: ev.personId, mediaId: ev.mediaId,
      message: { text, button: { url, title: reel.button_text || 'Shop now' } },
    }, { trigger: 'comment', legacy: true, publicReply: Boolean(reel.public_reply) });
    if (account?.token && result.outcome !== 'queued' && result.outcome !== 'held') await repos.activity?.finish(ev.commentId, 'skip:capped', result.reason);
    await finish(account?.token ? result.outcome : 'skip:not-connected');
  }

  // ---- messages -------------------------------------------------------------------------------------------------

  async function upsertThread(ev, { touchesWindow, username = '' }) {
    const facebook = ev.channel === 'facebook';
    const at = new Date(Math.min(ev.timestamp ?? +now(), +now()));
    const [row] = await db.query(
      `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, fb_page_id, subject_hash, recipient_id, username, last_message, last_message_at, last_user_message_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11::timestamptz, $11::timestamptz)
       ON CONFLICT (tenant_id, channel, subject_hash) DO UPDATE SET
         recipient_id = EXCLUDED.recipient_id,
         username = CASE WHEN EXCLUDED.username <> '' THEN EXCLUDED.username ELSE inbox_threads.username END,
         last_message = EXCLUDED.last_message,
         last_message_at = GREATEST(inbox_threads.last_message_at, EXCLUDED.last_message_at),
         last_user_message_at = GREATEST(inbox_threads.last_user_message_at, EXCLUDED.last_user_message_at),
         status = CASE WHEN inbox_threads.status = 'closed' THEN 'open' ELSE inbox_threads.status END,
         updated_at = EXCLUDED.updated_at
       RETURNING id, automation_paused_until, pause_reason`,
      [tenantId(), ev.channel, facebook ? null : ev.accountId, facebook ? ev.accountId : null, ev.subject, ev.personId, username, String(ev.text ?? '').slice(0, INBOX_TEXT_CHARS), at, touchesWindow ? at : null, now()],
    );
    return row;
  }

  async function addInboxMessage(threadId, ev, { direction = 'in', author = 'person', kind = 'text' } = {}) {
    await db.query(
      `INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, kind, text, media_ref, mid, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       ON CONFLICT (tenant_id, mid) WHERE mid IS NOT NULL DO NOTHING`,
      [tenantId(), threadId, direction, author, kind, String(ev.text ?? '').slice(0, INBOX_TEXT_CHARS), ev.mediaRef ?? '', ev.mid ?? null, now()],
    );
  }

  /** Ours comes back with the message id we saved. While one of ours to this person is mid-send the id may not be saved yet, so wait for it. */
  async function onEcho(ev, row) {
    const subject = await log.subjectHash(ev.channel, ev.recipientId);
    const event = { ...ev, subject, personId: ev.recipientId };
    const [ours] = await db.query('SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND message_id = $2', [tenantId(), ev.mid]);
    if (ours) return 'done';
    const [sending] = await db.query(`SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 AND status = 'sending' LIMIT 1`, [tenantId(), ev.channel, subject]);
    if (sending && row.attempts < MAX_ATTEMPTS) return 'defer';
    // A send whose receipt carried no id, or was lost, looks exactly like the owner typing. A recent one of ours to this person decides it.
    const [recent] = await db.query(
      `SELECT 1 FROM outbound_jobs WHERE tenant_id = $1 AND channel = $2 AND subject_hash = $3 AND message_id IS NULL AND status IN ('sent', 'sent_fallback', 'unknown') AND updated_at > $4::timestamptz LIMIT 1`,
      [tenantId(), ev.channel, subject, new Date(+now() - MINUTE)],
    );
    if (recent) return 'done';
    const until = new Date(+now() + limits.threadOwnerRepliedMs);
    const thread = await upsertThread(event, { touchesWindow: false });
    await db.query(
      `UPDATE inbox_threads SET automation_paused_until = GREATEST(automation_paused_until, $3::timestamptz), pause_reason = 'thread.owner_replied', updated_at = $4::timestamptz WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), thread.id, until, now()],
    );
    await addInboxMessage(thread.id, event, { direction: 'out', author: 'owner' });
    await note(event, 'thread.owner_replied', { kind: 'thread', decision: 'held' });
    return 'done';
  }

  async function confirmationText() {
    const [row] = await db.query(
      `SELECT v.body FROM message_templates m JOIN template_variants v ON v.tenant_id = m.tenant_id AND v.template_id = m.id
       WHERE m.tenant_id = $1 AND m.automation_id IS NULL AND m.role = 'optout_confirm' AND v.active ORDER BY v.label LIMIT 1`,
      [tenantId()],
    );
    return row?.body || DEFAULT_OPTOUT_CONFIRMATION;
  }

  async function onOptOut(ev) {
    const added = await log.addOptOut(ev.channel, ev.subject, 'dm', now());
    await cancelForPerson(ev.channel, ev.subject, 'cancelled.optout');
    await note(ev, 'optout', { kind: 'optout' });
    if (!added) return;
    await enqueue({
      kind: 'dm', purpose: 'optout_confirm', channel: ev.channel, accountId: ev.accountId, recipientId: ev.personId, personId: ev.personId,
      idempotencyKey: `optout_confirm:${ev.mid}`, expiresAt: new Date(+now() + limits.messagingWindowMs), message: { text: await confirmationText() },
    });
  }

  async function onHandoff(ev, thread) {
    const until = new Date(+now() + limits.threadHandoffMs);
    await db.query(
      `UPDATE inbox_threads SET automation_paused_until = GREATEST(automation_paused_until, $3::timestamptz), pause_reason = 'thread.handoff', status = 'needs_human', updated_at = $4::timestamptz WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), thread.id, until, now()],
    );
    await addNeedsHuman({ channel: ev.channel, kind: 'handoff', reason: 'thread.handoff', subject: ev.subject, threadId: thread.id, username: '', text: ev.text });
    await cancelForPerson(ev.channel, ev.subject, 'thread.handoff', { only: ['followup'] });
    await repos.alerts?.raise({ kind: 'thread.handoff', severity: 'info', target: String(thread.id), message: 'Someone asked to talk to a person. Their conversation is in “Needs a human”.', dedupeKey: `handoff:${thread.id}:${Math.floor(+now() / limits.threadHandoffMs)}` }).catch(swallow('compliance.handoff_alert_failed'));
    await note(ev, 'thread.handoff', { kind: 'thread', decision: 'held' });
  }

  const inboxKind = { story_reply: 'story_reply', story_mention: 'story_mention', postback: 'postback', attachment: 'attachment' };

  async function onPersonMessage(ev) {
    const own = await ownIds(ev);
    if (own.has(ev.personId)) return;
    const subject = await log.subjectHash(ev.channel, ev.personId);
    const event = { ...ev, subject };
    const touchesWindow = ev.type !== 'story_mention';
    const thread = await upsertThread(event, { touchesWindow });
    await addInboxMessage(thread.id, event, { kind: inboxKind[ev.type] ?? 'text' });

    if (ev.type === 'dm' || ev.type === 'story_reply') {
      if (isOptOut(ev.text, await log.wordsFor('optout'))) return onOptOut(event);
      if (isStart(ev.text)) {
        if (await log.removeOptOut(ev.channel, subject)) await note(event, 'optout', { kind: 'optin', decision: 'cancelled', details: { lifted: true } });
        return undefined;
      }
      if (wantsHuman(ev.text, await log.wordsFor('handoff'))) return onHandoff(event, thread);
    }
    const paused = thread.automation_paused_until && +new Date(thread.automation_paused_until) > +now();
    await runConsumers({ ...event, threadId: thread.id, threadPaused: paused ? thread.pause_reason : '' });
    return undefined;
  }

  async function handle(ev, row) {
    if (ev.type === 'comment') await onComment(ev);
    else if (ev.type === 'echo') return onEcho(ev, row);
    else if (ev.type === 'post_mention') await runConsumers(ev);
    else if (ev.type === 'seen') await runConsumers({ ...ev, subject: await log.subjectHash(ev.channel, ev.personId) });
    else await onPersonMessage(ev);
    return 'done';
  }

  // ---- the worker ------------------------------------------------------------------------------------------------

  async function finishEvent(row, status, leaseUntil = null) {
    await db.query(
      `UPDATE inbound_events SET status = $3, lease_until = $4::timestamptz, processed_at = CASE WHEN $3 = 'stored' THEN NULL ELSE $5::timestamptz END WHERE tenant_id = $1 AND id = $2`,
      [tenantId(), row.id, status, leaseUntil, now()],
    );
  }

  async function processRow(row) {
    try {
      const ev = decode(row);
      const verdict = ev ? await handle(ev, row) : 'done';
      if (verdict === 'defer') await finishEvent(row, 'stored', new Date(+now() + ECHO_RETRY_MS));
      else await finishEvent(row, 'done');
    } catch (err) {
      reportError(err, { msg: 'compliance.event_failed', event: Number(row.id), field: row.field });
      await finishEvent(row, row.attempts >= MAX_ATTEMPTS ? 'failed' : 'stored', new Date(+now() + 2 ** row.attempts * 1000)).catch(swallow('compliance.event_status_failed'));
    }
  }

  /** Claims a fair slice per business. Safe to rerun anything here: the send path has its own idempotency keys. */
  async function drain({ limit = DRAIN_LIMIT, perTenant = DRAIN_PER_TENANT, concurrency = 8 } = {}) {
    const at = now();
    const claimed = await db.platform.query(
      `UPDATE inbound_events SET status = 'processing', attempts = attempts + 1, lease_until = $4::timestamptz
       WHERE id IN (
         SELECT id FROM inbound_events WHERE id IN (
           SELECT id FROM (
             SELECT id, received_at, row_number() OVER (PARTITION BY tenant_id ORDER BY received_at, id) AS place
             FROM inbound_events WHERE status = 'stored' AND (lease_until IS NULL OR lease_until <= $1::timestamptz)
           ) ranked WHERE place <= $2 ORDER BY place, received_at, id LIMIT $3
         ) FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
      [at, perTenant, limit, new Date(+at + INBOUND_LEASE_MS)],
    );
    if (!claimed.length) return 0;
    const tenants = new Map((await db.platform.query(
      `SELECT id, slug, name, status, (SELECT p.domain FROM tenant_domains p WHERE p.tenant_id = tenants.id AND p.is_primary AND p.status = 'verified') AS primary_domain
       FROM tenants WHERE id IN (SELECT (jsonb_array_elements_text($1::jsonb))::integer)`,
      [JSON.stringify([...new Set(claimed.map((r) => r.tenant_id))])],
    )).map((t) => [t.id, t]));
    const byTenant = new Map();
    for (const row of claimed.sort((a, b) => +new Date(a.received_at) - +new Date(b.received_at) || Number(a.id) - Number(b.id))) {
      byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row]);
    }
    const queue = [...byTenant.values()];
    const lane = async () => {
      for (;;) {
        const rows = queue.shift();
        if (!rows) return;
        const tenant = tenants.get(rows[0].tenant_id) ?? { id: rows[0].tenant_id };
        await withTenant(tenant, async () => {
          for (const row of rows) await processRow(row);
        });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, lane));
    return claimed.length;
  }

  /** Events whose worker died. Rerunning is safe; only an event that keeps failing is given up on. */
  async function recover() {
    await db.platform.query(
      `UPDATE inbound_events SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'stored' END, lease_until = NULL
       WHERE status = 'processing' AND lease_until < $1::timestamptz`,
      [now(), MAX_ATTEMPTS],
    );
  }

  return { storeDelivery, drain, recover, privateReplyExpiresAt, decode };
}
