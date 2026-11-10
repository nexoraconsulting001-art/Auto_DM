import { MetaApiError, createMetaClient, wireMessage } from './adapters/meta/index.js';
import { log } from './platform/log.js';
import { tenantId } from './tenancy.js';

export { MetaApiError as InstagramApiError };

/**
 * Instagram for one business at a time, over the Meta adapter (src/adapters/meta): every call has a 10 s timeout and only
 * reaches Meta's own hosts, or a simulator outside production. There is no global token. Every call takes the account
 * it acts for as its first argument, { igUserId, token }, which comes from repos.igAccounts, where the token
 * is decrypted by the secrets module only when it is about to be used. forBusiness() does that lookup for you.
 *
 * Messages go through ctx.compliance.send(), the only caller of the send calls here. With dryRun, sends are logged
 * (ids only) and not made.
 */
export function createInstagram(config = {}, { onCall } = {}) {
  const { dryRun = false } = config;
  const meta = createMetaClient(config, { onCall });
  const dryRunResult = (kind, commentId) => {
    log.info('ig.dry_run', { kind, comment: commentId });
    return { dryRun: true };
  };
  const unwrap = async (sending) => (await sending).data;

  return {
    /** Private Reply: DMs the author of a comment. Allowed once per comment, within 7 days of it. */
    async sendPrivateReply(account, commentId, text) {
      if (dryRun) return dryRunResult('private_reply', commentId);
      return unwrap(meta.sender(account).privateReply(commentId, { text }));
    },

    /** Private Reply with a tappable button that opens `url`. Instagram limits `buttonTitle` to 20 characters and `text` to 640. */
    async sendPrivateReplyButton(account, commentId, text, url, buttonTitle) {
      if (dryRun) return dryRunResult('private_reply_button', commentId);
      return unwrap(meta.sender(account).privateReply(commentId, wireMessage({ text: text.slice(0, 640), button: { url, title: buttonTitle.slice(0, 20) } })));
    },

    /** Any message, nothing cut. `recipient` is { commentId } or { id }. Resolves to { messageId, status, usage, data }. */
    async sendMessage(account, recipient, message) {
      if (dryRun) return dryRunResult(recipient.commentId ? 'private_reply' : 'dm', recipient.commentId ?? null);
      const wire = wireMessage(message);
      const sender = meta.sender(account);
      return recipient.commentId ? sender.privateReply(recipient.commentId, wire) : sender.dm(recipient.id, wire);
    },

    async replyToComment(account, commentId, text) {
      if (dryRun) return dryRunResult('public_reply', commentId);
      return unwrap(meta.sender(account).publicReply(commentId, text));
    },

    async getAccount(account) {
      return meta.forAccount(account).getAccount();
    },

    async listMedia(account, limit = 25) {
      return meta.forAccount(account).listMedia({ limit });
    },

    async getMedia(account, mediaId) {
      return meta.forAccount(account).getMedia(mediaId);
    },
  };
}

const CALLS = ['sendPrivateReply', 'sendPrivateReplyButton', 'sendMessage', 'replyToComment', 'getAccount', 'listMedia', 'getMedia'];

/** The same calls with the account filled in, for code that works on one account at a time. */
export const forAccount = (client, account) =>
  Object.fromEntries(CALLS.map((name) => [name, (...args) => client[name](account, ...args)]));

/**
 * The client for the current business's account: the one named, or the one it sends from. Null when it has no token.
 * Refuses to run outside withTenant(), and can only ever find this business's accounts.
 */
export async function forBusiness(client, repos, igUserId) {
  tenantId();
  const account = igUserId ? await repos.igAccounts.get(igUserId) : await repos.igAccounts.current();
  return account?.token ? forAccount(client, account) : null;
}
