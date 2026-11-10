import { ComplianceAction } from '../../contracts/compliance.js';
import { reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { complianceRepo } from './repo.js';

const failure = (err) => {
  if (err?.delivery === 'none') return { outcome: 'failed', reason: 'send.error' };
  return { outcome: 'unknown', reason: 'send.unknown_outcome' };
};

/**
 * The compliance gate (PRD 4): the only path to Meta. A module asks for a send with one of these and never calls Meta itself.
 *
 *   compliance.check(action)    -> { allow, outcome, reason }   every rule, no side effects
 *   compliance.send(action)     -> SendResult                   sends now (manual replies, and the queue worker)
 *   compliance.enqueue(action)  -> SendResult                   creates the outbound_jobs row; the worker sends it
 *   compliance.clientFor(acct)  the send calls of src/handler.js, routed through send()
 *
 * Shapes are in src/contracts/compliance.js. This is the stub: it validates, sends and logs, and applies none of
 * the rules yet. The compliance track fills it in here, behind these same four calls.
 */
export function createCompliance({ db, repos, ig }) {
  const log = complianceRepo(db);

  const findAccount = (action) => (action.channel === 'facebook' ? repos.fbPages?.get(action.accountId) : repos.igAccounts?.get(action.accountId));

  function dispatch(action, account) {
    const { kind, commentId, recipientId, message } = action;
    if (kind === 'public_reply') return ig.replyToComment(account, commentId, message.text);
    if (kind === 'dm') return ig.sendMessage(account, { id: recipientId }, message);
    if (message.button?.url && !message.quickReplies) return ig.sendPrivateReplyButton(account, commentId, message.text, message.button.url, message.button.title);
    if (!message.button && !message.quickReplies) return ig.sendPrivateReply(account, commentId, message.text);
    return ig.sendMessage(account, { commentId }, message);
  }

  async function writeLog(action, result) {
    try {
      const subject = action.personId ? await log.subjectHash(action.channel, action.personId) : '';
      await log.record({ channel: action.channel, kind: action.kind, subject, decision: result.outcome, reason: result.reason, automationId: action.automationId ?? null, mediaId: action.mediaId ?? '', commentId: action.commentId ?? '', details: { purpose: action.purpose, status: result.status, metaCode: result.metaCode, metaSubcode: result.metaSubcode } });
    } catch (err) {
      // The message has already gone or failed: losing its log row must not change what the caller is told.
      reportError(err, { msg: 'compliance.log_failed', kind: action.kind });
    }
  }

  const blank = { jobId: null, messageId: null, status: null, metaCode: null, metaSubcode: null };

  /** `account` skips the lookup when the caller already holds it. */
  async function send(input, { account: known } = {}) {
    tenantId();
    const action = ComplianceAction.parse(input);
    const account = known ?? await findAccount(action);
    let result;
    if (!account?.token) {
      result = { ...blank, outcome: 'held', reason: 'paused.reconnect' };
    } else {
      try {
        const sent = await dispatch(action, account);
        result = sent?.dryRun
          ? { ...blank, outcome: 'would_send', reason: '' }
          : { ...blank, outcome: 'sent', reason: '', messageId: sent?.messageId ?? sent?.message_id ?? sent?.id ?? null, status: sent?.status ?? null };
      } catch (err) {
        result = { ...blank, ...failure(err), status: err.status ?? null, metaCode: err.code ?? null, metaSubcode: err.subcode ?? null, error: err };
      }
    }
    await writeLog(action, result);
    return result;
  }

  /** Inserts the job once per idempotency key. A key seen before is skipped. */
  async function enqueue(input) {
    const business = tenantId();
    const action = ComplianceAction.parse(input);
    const instagram = action.channel === 'instagram';
    const subject = action.personId ? await log.subjectHash(action.channel, action.personId) : '';
    const [row] = await db.query(
      `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, fb_page_id, kind, purpose, idempotency_key, automation_id, variant_id, media_id, comment_id, recipient_id, subject_hash, payload, expires_at, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`,
      [business, action.channel, instagram ? action.accountId : null, instagram ? null : action.accountId, action.kind, action.purpose, action.idempotencyKey,
        action.automationId ?? null, action.variantId ?? null, action.mediaId ?? '', action.commentId ?? '', action.recipientId ?? '', subject, JSON.stringify({ message: action.message }), action.expiresAt, action.isTest],
    );
    if (row) return { ...blank, outcome: 'queued', reason: '', jobId: Number(row.id) };
    return { ...blank, outcome: 'skipped', reason: action.kind === 'private_reply' ? 'cap.per_comment' : 'webhook.duplicate' };
  }

  return {
    send,
    enqueue,

    async check(input) {
      ComplianceAction.parse(input);
      tenantId();
      return { allow: true, outcome: 'queued', reason: '' };
    },

    /** Failures are thrown here, because that is what src/handler.js is written against. */
    clientFor(account) {
      const week = () => new Date(Date.now() + 7 * 86_400_000 - 3_600_000);
      const through = async (action) => {
        const result = await send({ channel: 'instagram', accountId: account.igUserId, expiresAt: week(), ...action }, { account });
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
  };
}
