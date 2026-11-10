import { log } from './platform/log.js';

const DEFAULT_BASE_URL = 'https://graph.instagram.com';

export class InstagramApiError extends Error {
  constructor(method, pathname, status, data) {
    super(`Instagram API ${method} /${pathname} failed (${status}): ${data?.error?.message || 'no details'}`);
    this.status = status;
    this.code = data?.error?.code;
  }
}

const id = (value) => encodeURIComponent(String(value));

/**
 * The Instagram API client. There is no global token: every call takes the account it acts for as its first
 * argument, { igUserId, token }, which comes from repos.igAccounts. GRAPH_BASE_URL points it at the
 * simulator. With dryRun, sends are logged (ids only) and not made.
 */
export function createInstagram({ graphBaseUrl = '', graphVersion = 'v23.0', dryRun = false } = {}) {
  const base = (graphBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');

  async function graph(account, method, pathname, { query = {}, body } = {}) {
    if (!account?.token) throw new Error('This Instagram account has no access token');
    const url = new URL(`${base}/${graphVersion}/${pathname}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${account.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new InstagramApiError(method, pathname, res.status, data);
    return data;
  }

  const sendAs = (account) => id(account?.igUserId || 'me');
  const dryRunResult = (kind, commentId) => {
    log.info('ig.dry_run', { kind, comment: commentId });
    return Promise.resolve({ dryRun: true });
  };
  const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url';

  return {
    /** Private Reply: DMs the author of a comment. Allowed once per comment, within 7 days of it. */
    sendPrivateReply(account, commentId, text) {
      if (dryRun) return dryRunResult('private_reply', commentId);
      return graph(account, 'POST', `${sendAs(account)}/messages`, {
        body: { recipient: { comment_id: commentId }, message: { text } },
      });
    },

    /** Private Reply with a tappable button that opens `url`. Instagram limits `buttonTitle` to 20 characters and `text` to 640. */
    sendPrivateReplyButton(account, commentId, text, url, buttonTitle) {
      if (dryRun) return dryRunResult('private_reply_button', commentId);
      return graph(account, 'POST', `${sendAs(account)}/messages`, {
        body: {
          recipient: { comment_id: commentId },
          message: {
            attachment: {
              type: 'template',
              payload: {
                template_type: 'button',
                text: text.slice(0, 640),
                buttons: [{ type: 'web_url', url, title: buttonTitle.slice(0, 20) }],
              },
            },
          },
        },
      });
    },

    replyToComment(account, commentId, text) {
      if (dryRun) return dryRunResult('public_reply', commentId);
      return graph(account, 'POST', `${id(commentId)}/replies`, { query: { message: text } });
    },

    getAccount(account) {
      return graph(account, 'GET', 'me', { query: { fields: 'user_id,username' } });
    },

    listMedia(account, limit = 25) {
      return graph(account, 'GET', `${sendAs(account)}/media`, { query: { fields: MEDIA_FIELDS, limit: String(limit) } });
    },

    getMedia(account, mediaId) {
      return graph(account, 'GET', id(mediaId), { query: { fields: MEDIA_FIELDS } });
    },
  };
}

const CALLS = ['sendPrivateReply', 'sendPrivateReplyButton', 'replyToComment', 'getAccount', 'listMedia', 'getMedia'];

/** The same calls with the account filled in, for code that works on one account at a time. */
export const forAccount = (client, account) =>
  Object.fromEntries(CALLS.map((name) => [name, (...args) => client[name](account, ...args)]));
