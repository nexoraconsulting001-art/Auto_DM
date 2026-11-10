import { metaUrls } from './hosts.js';
import { createMetaHttp } from './http.js';

export const DEFAULT_GRAPH_VERSION = 'v23.0';

const id = (value) => encodeURIComponent(String(value));
const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url';
const COMMENT_FIELDS = 'id,text,timestamp,from,media{id,media_product_type},parent_id';

/**
 * A DM in Meta's format: { text, button?, buttons?, quickReplies? }. A button is { url, title } or { payload, title }.
 * Nothing is shortened here. The compliance gate refuses what is over a limit (PRD 4.10).
 */
export function wireMessage({ text, button, buttons = button ? [button] : [], quickReplies = [] }) {
  const quick = quickReplies.length ? { quick_replies: quickReplies.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload })) } : {};
  if (!buttons.length) return { text, ...quick };
  return {
    attachment: {
      type: 'template',
      payload: {
        template_type: 'button',
        text,
        buttons: buttons.map((b) => (b.url ? { type: 'web_url', url: b.url, title: b.title } : { type: 'postback', payload: b.payload, title: b.title })),
      },
    },
    ...quick,
  };
}

/**
 * Meta's API for one business's account at a time. There is no global token: an account is what its business's repo
 * returns, { igUserId, token, loginKind? } for Instagram or { pageId, token } for a Facebook Page.
 *
 *   client.forAccount(account)     reads and setup, for any module
 *   client.sender(account)         the calls that message someone. Only src/instagram.js may call this, for
 *                                  compliance.send(); a test fails anything else that does.
 *
 * options: { env, onCall }; see createMetaHttp for onCall. Reads resolve to Graph's data. Senders resolve to
 * { messageId, recipientId, status, usage, data }. Failures are MetaApiError.
 */
export function createMetaClient(config = {}, { env = process.env, onCall } = {}) {
  const urls = metaUrls(config, env);
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION;
  const call = createMetaHttp({ timeoutMs: config.metaTimeoutMs, onCall });

  function bind(account) {
    if (!account?.token) throw new Error('This Instagram account has no access token');
    const facebook = Boolean(account.pageId) || account.loginKind === 'unified';
    return {
      owner: id(account.pageId || account.igUserId || 'me'),
      graph: (method, pathname, options = {}) => call({ base: facebook ? urls.facebookGraph : urls.graph, version, method, pathname, token: account.token, ...options }),
    };
  }

  const read = async (account, pathname, query) => (await bind(account).graph('GET', pathname, { query })).data;
  const receipt = ({ data, status, usage }) => ({ messageId: data.message_id ?? data.id ?? null, recipientId: data.recipient_id ?? null, status, usage, data });

  return {
    urls,

    forAccount(account) {
      const { owner, graph } = bind(account);
      const page = (limit, after) => ({ limit: String(limit), ...(after ? { after } : {}) });
      return {
        getAccount: () => read(account, account.loginKind === 'unified' ? owner : 'me', { fields: account.loginKind === 'unified' ? 'id,username' : 'user_id,username' }),
        listMedia: ({ limit = 25, after } = {}) => read(account, `${owner}/media`, { fields: MEDIA_FIELDS, ...page(limit, after) }),
        listStories: ({ limit = 25, after } = {}) => read(account, `${owner}/stories`, { fields: MEDIA_FIELDS, ...page(limit, after) }),
        getMedia: (mediaId) => read(account, id(mediaId), { fields: MEDIA_FIELDS }),
        getComment: (commentId) => read(account, id(commentId), { fields: COMMENT_FIELDS }),
        /** { name?, username? } of someone who has messaged the business. Either may be absent (PRD 4.10). */
        getPerson: (personId) => read(account, id(personId), { fields: 'name,username' }),
        insights: (objectId, query) => read(account, `${id(objectId)}/insights`, query),
        subscriptions: () => read(account, `${owner}/subscribed_apps`),
        subscribe: async (fields) => (await graph('POST', `${owner}/subscribed_apps`, { query: { subscribed_fields: fields.join(',') } })).data,
        unsubscribe: async () => (await graph('DELETE', `${owner}/subscribed_apps`)).data,
        iceBreakers: () => read(account, `${owner}/messenger_profile`, { fields: 'ice_breakers' }),
        setIceBreakers: async (iceBreakers) => (await graph('POST', `${owner}/messenger_profile`, { body: { platform: 'instagram', ice_breakers: iceBreakers } })).data,
        clearIceBreakers: async () => (await graph('DELETE', `${owner}/messenger_profile`, { body: { fields: ['ice_breakers'] } })).data,
        /** Facebook Pages only (PRD 6.10): for suggesting a post's Instagram twin. */
        listPosts: ({ limit = 25, after } = {}) => read(account, `${owner}/posts`, { fields: 'id,message,created_time,permalink_url', ...page(limit, after) }),
      };
    },

    sender(account) {
      const { owner, graph } = bind(account);
      const send = async (recipient, message) => receipt(await graph('POST', `${owner}/messages`, {
        body: { recipient, ...(account.pageId && recipient.id ? { messaging_type: 'RESPONSE' } : {}), message },
      }));
      return {
        privateReply: (commentId, message) => send({ comment_id: commentId }, message),
        dm: (recipientId, message) => send({ id: recipientId }, message),
        publicReply: async (commentId, text) => receipt(await graph('POST', `${id(commentId)}/${account.pageId ? 'comments' : 'replies'}`, { query: { message: text } })),
      };
    },
  };
}
