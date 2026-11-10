/** The Graph API for Instagram Login: reads, subscribed_apps, comment replies, private replies and the Send API. */
import { ERRORS, HOUR, INSIGHT_METRICS, SCOPES, SECOND, WEBHOOK_FIELDS, graphError, toSeconds } from './constants.mjs';
import { validateMessage } from './message.mjs';
import { authenticate, chargeBuc, input, isOwnAccount, jsonParam, nextId, person, requireScopes, throttle } from './state.mjs';
import { emit } from './webhooks.mjs';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+0000');
const notFound = () => graphError(ERRORS.OBJECT_NOT_FOUND);
const invalid = (message) => graphError(ERRORS.INVALID_PARAM, `(#100) ${message}`);
const encodeCursor = (offset) => Buffer.from(String(offset)).toString('base64url');

const ACCOUNT_FIELDS = {
  id: (a) => a.appScopedId,
  user_id: (a) => a.igUserId,
  username: (a) => a.username,
  name: (a) => a.name,
  account_type: (a) => a.accountType,
  profile_picture_url: (a) => a.profilePictureUrl,
  followers_count: (a) => a.followersCount,
  follows_count: (a) => a.followsCount,
  media_count: (a, ctx) => [...ctx.s.media.values()].filter((m) => m.igUserId === a.igUserId).length,
  biography: (a) => a.biography,
  website: (a) => a.website,
};

const MEDIA_FIELDS = {
  id: (m) => m.id,
  caption: (m) => m.caption,
  media_type: (m) => m.mediaType,
  media_product_type: (m) => m.productType,
  permalink: (m) => m.permalink,
  shortcode: (m) => m.shortcode,
  timestamp: (m) => iso(m.at),
  media_url: (m) => m.mediaUrl,
  thumbnail_url: (m) => m.thumbnailUrl,
  like_count: (m) => m.likeCount,
  comments_count: (m, ctx) => [...ctx.s.comments.values()].filter((c) => c.mediaId === m.id && !c.deleted).length,
  username: (m, ctx) => ctx.s.accounts.get(m.igUserId).username,
};

const COMMENT_FIELDS = {
  id: (c) => c.id,
  text: (c) => c.text,
  timestamp: (c) => iso(c.at),
  username: (c) => c.from.username,
  from: (c) => c.from,
  media: (c, ctx) => ({ id: c.mediaId, media_product_type: ctx.s.media.get(c.mediaId).productType }),
  parent_id: (c) => c.parentId,
  like_count: () => 0,
  hidden: () => false,
};

const PERSON_FIELDS = {
  id: (p) => p.id,
  name: (p) => p.name,
  username: (p) => p.username,
};

/** `fields=a,b{c,d}` selects a and b. Graph always adds id, and refuses a field the node does not have. */
function project(ctx, node, table, typeName, fields) {
  const names = fields ? String(fields).match(/[^,{\s]+(?:\{[^}]*\})?/g)?.map((part) => part.split('{')[0]) ?? [] : [];
  const out = {};
  for (const name of [...names, 'id']) {
    if (!Object.hasOwn(table, name)) throw invalid(`Tried accessing nonexisting field (${name}) on node type (${typeName})`);
    const value = table[name](node, ctx);
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === '') return 0;
  const decoded = Buffer.from(String(cursor), 'base64url').toString();
  if (!/^\d+$/.test(decoded)) throw invalid('The after cursor is not valid');
  return Number(decoded);
}

function paged(ctx, req, items, render) {
  const params = input(req);
  const limit = Math.min(Math.max(Number.parseInt(params.limit, 10) || 25, 1), 100);
  const offset = decodeCursor(params.after);
  const slice = items.slice(offset, offset + limit);
  if (!slice.length) return { data: [] };
  const end = offset + slice.length;
  const paging = { cursors: { before: encodeCursor(offset), after: encodeCursor(end) } };
  if (end < items.length) {
    const next = new URL(req.rawPath, ctx.sim.url);
    for (const [key, value] of Object.entries(req.query)) next.searchParams.set(key, value);
    next.searchParams.set('after', encodeCursor(end));
    paging.next = next.href;
  }
  return { data: slice.map(render), paging };
}

/** Items are stored oldest first, so reversing before the (stable) sort puts the latest first when times tie. */
const newestFirst = (items) => [...items].reverse().sort((a, b) => b.at - a.at);

function ownMedia(ctx, id, account) {
  const media = ctx.s.media.get(id);
  if (!media || media.igUserId !== account.igUserId) throw notFound();
  return media;
}

function ownComment(ctx, id, account) {
  const comment = ctx.s.comments.get(String(id));
  if (!comment || comment.igUserId !== account.igUserId || comment.deleted) throw notFound();
  return comment;
}

function requireOwnAccount(ref, account) {
  if (!isOwnAccount(ref, account)) throw notFound();
}

/** What the app sent lands in `sent`; Meta then echoes it to the app's own webhook. Never awaited: a send does not wait on the app. */
function commitDm(ctx, account, { kind, recipientId, commentId, message, tag }) {
  const id = `m_${nextId(ctx)}`;
  const at = ctx.clock.now();
  ctx.s.sent.push({ id, at, kind, igUserId: account.igUserId, recipientId, ...(commentId ? { commentId } : {}), message, ...(tag ? { tag } : {}) });
  if (ctx.s.app.echoes) {
    const event = { sender: { id: account.igUserId }, recipient: { id: recipientId }, timestamp: at, message: { mid: id, is_echo: true, ...message } };
    void emit(ctx, account, 'messages', { id: account.igUserId, time: at, messaging: [event] });
  }
  return { recipient_id: recipientId, message_id: id };
}

function privateReply(ctx, account, token, commentId, message, tag) {
  requireScopes(token, [SCOPES.comments]);
  throttle(ctx, account.privateReplyTimes, HOUR, ctx.s.limits.privateRepliesPerHour);
  if (tag) throw invalid('A private reply cannot carry a message tag');
  validateMessage(message, ctx.s.limits);
  const comment = ownComment(ctx, commentId, account);
  if (comment.from.id === account.igUserId) throw graphError(ERRORS.CANNOT_REPLY);
  if (ctx.clock.now() - comment.at >= ctx.s.limits.privateReplyWindowMs) throw graphError(ERRORS.REPLY_WINDOW_CLOSED);
  if (comment.privateReplyId) throw graphError(ERRORS.ALREADY_REPLIED);
  if (person(ctx, account.igUserId, comment.from.id).unavailable) throw graphError(ERRORS.RECIPIENT_UNAVAILABLE);
  const result = commitDm(ctx, account, { kind: 'private_reply', recipientId: comment.from.id, commentId: comment.id, message });
  comment.privateReplyId = result.message_id;
  return result;
}

function sendApi(ctx, account, recipientId, message, tag) {
  throttle(ctx, account.sendTimes, SECOND, ctx.s.limits.sendPerSecond);
  if (tag !== undefined && tag !== 'HUMAN_AGENT') throw invalid('tag must be HUMAN_AGENT');
  validateMessage(message, ctx.s.limits);
  const who = person(ctx, account.igUserId, recipientId);
  if (who.unavailable) throw graphError(ERRORS.RECIPIENT_UNAVAILABLE);
  const windowMs = tag ? ctx.s.limits.humanAgentWindowMs : ctx.s.limits.messagingWindowMs;
  if (who.lastUserMessageAt === null || ctx.clock.now() - who.lastUserMessageAt >= windowMs) throw graphError(ERRORS.WINDOW_CLOSED);
  return commitDm(ctx, account, { kind: 'send_api', recipientId, message, tag });
}

function parseFields(value) {
  const parsed = jsonParam(value);
  const fields = Array.isArray(parsed) ? parsed.map(String) : String(parsed ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (!fields.length) throw invalid('subscribed_fields is required');
  for (const field of fields) if (!Object.hasOwn(WEBHOOK_FIELDS, field)) throw invalid(`Param subscribed_fields has an unknown field: ${field}`);
  return fields;
}

export function graphRoutes(on, ctx) {
  on('POST', '/:id/messages', (req) => {
    const { token, account } = authenticate(ctx, req, [SCOPES.messages]);
    requireOwnAccount(req.params.id, account);
    const params = input(req);
    const recipient = jsonParam(params.recipient);
    const message = jsonParam(params.message);
    if (recipient?.comment_id) return privateReply(ctx, account, token, recipient.comment_id, message, params.tag);
    if (recipient?.id) return sendApi(ctx, account, String(recipient.id), message, params.tag);
    throw invalid('Param recipient must hold comment_id or id');
  });

  on('GET', '/:id/media', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.basic]);
    chargeBuc(ctx, account);
    requireOwnAccount(req.params.id, account);
    const items = newestFirst([...ctx.s.media.values()].filter((m) => m.igUserId === account.igUserId && m.productType !== 'STORY'));
    return paged(ctx, req, items, (m) => project(ctx, m, MEDIA_FIELDS, 'IGMedia', input(req).fields));
  });

  // Whether this edge exists under Instagram Login is to confirm (PRD 6.8). Stories are live for 24 hours.
  on('GET', '/:id/stories', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.basic]);
    chargeBuc(ctx, account);
    requireOwnAccount(req.params.id, account);
    const liveSince = ctx.clock.now() - ctx.s.limits.storyMs;
    const items = newestFirst([...ctx.s.media.values()].filter((m) => m.igUserId === account.igUserId && m.productType === 'STORY' && m.at > liveSince));
    return paged(ctx, req, items, (m) => project(ctx, m, MEDIA_FIELDS, 'IGMedia', input(req).fields));
  });

  on('GET', '/:id/messenger_profile', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.messages]);
    requireOwnAccount(req.params.id, account);
    const iceBreakers = ctx.s.iceBreakers.get(account.igUserId);
    return { data: iceBreakers ? [{ ice_breakers: iceBreakers }] : [] };
  });

  on('POST', '/:id/messenger_profile', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.messages]);
    requireOwnAccount(req.params.id, account);
    const { platform, ice_breakers: list } = input(req);
    const iceBreakers = jsonParam(list);
    if (platform !== 'instagram') throw invalid('Param platform must be instagram');
    if (!Array.isArray(iceBreakers) || !iceBreakers.length) throw invalid('Param ice_breakers must be a non-empty array');
    for (const { call_to_actions: actions } of iceBreakers) {
      if (!Array.isArray(actions) || actions.length < 1 || actions.length > ctx.s.limits.iceBreakersMax) throw invalid(`Param call_to_actions must hold 1 to ${ctx.s.limits.iceBreakersMax} questions`);
      for (const action of actions) {
        if (typeof action?.question !== 'string' || !action.question.trim() || [...action.question].length > ctx.s.limits.iceBreakerQuestionChars) throw invalid(`Param question must be 1 to ${ctx.s.limits.iceBreakerQuestionChars} characters`);
        if (typeof action.payload !== 'string' || !action.payload) throw invalid('Param payload must be a non-empty string');
      }
    }
    ctx.s.iceBreakers.set(account.igUserId, iceBreakers);
    return { success: true };
  });

  on('DELETE', '/:id/messenger_profile', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.messages]);
    requireOwnAccount(req.params.id, account);
    ctx.s.iceBreakers.delete(account.igUserId);
    return { success: true };
  });

  on('GET', '/:id/comments', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.comments]);
    chargeBuc(ctx, account);
    const media = ownMedia(ctx, req.params.id, account);
    const items = newestFirst([...ctx.s.comments.values()].filter((c) => c.mediaId === media.id && !c.parentId && !c.deleted));
    return paged(ctx, req, items, (c) => project(ctx, c, COMMENT_FIELDS, 'IGComment', input(req).fields));
  });

  on('GET', '/:id/replies', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.comments]);
    chargeBuc(ctx, account);
    const parent = ownComment(ctx, req.params.id, account);
    const items = newestFirst([...ctx.s.comments.values()].filter((c) => c.parentId === parent.id && !c.deleted));
    return paged(ctx, req, items, (c) => project(ctx, c, COMMENT_FIELDS, 'IGComment', input(req).fields));
  });

  on('POST', '/:id/replies', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.comments]);
    chargeBuc(ctx, account);
    const parent = ownComment(ctx, req.params.id, account);
    const text = input(req).message;
    if (typeof text !== 'string' || !text.trim()) throw invalid('Param message must be a non-empty string');
    if ([...text].length > ctx.s.limits.publicReplyChars) throw invalid(`Param message must be at most ${ctx.s.limits.publicReplyChars} characters`);

    const at = ctx.clock.now();
    const id = nextId(ctx);
    const from = { id: account.igUserId, username: account.username };
    ctx.s.comments.set(id, { id, igUserId: account.igUserId, mediaId: parent.mediaId, from, text, parentId: parent.id, at, deleted: false, privateReplyId: null });
    ctx.s.sent.push({ id, at, kind: 'public_reply', igUserId: account.igUserId, commentId: parent.id, message: { text } });
    if (ctx.s.app.echoes) {
      const media = ctx.s.media.get(parent.mediaId);
      void emit(ctx, account, 'comments', { id: account.igUserId, time: toSeconds(at), changes: [{ field: 'comments', value: { from, media: { id: media.id, media_product_type: media.productType }, id, parent_id: parent.id, text } }] });
    }
    return { id };
  });

  on('GET', '/:id/subscribed_apps', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.basic]);
    chargeBuc(ctx, account);
    requireOwnAccount(req.params.id, account);
    return { data: account.subscribedFields.size ? [{ id: ctx.s.app.id, subscribed_fields: [...account.subscribedFields] }] : [] };
  });

  on('POST', '/:id/subscribed_apps', (req) => {
    const { token, account } = authenticate(ctx, req, [SCOPES.basic]);
    chargeBuc(ctx, account);
    requireOwnAccount(req.params.id, account);
    const fields = parseFields(input(req).subscribed_fields);
    requireScopes(token, [...new Set(fields.map((field) => WEBHOOK_FIELDS[field]))]);
    account.subscribedFields = new Set(fields);
    return { success: true };
  });

  on('DELETE', '/:id/subscribed_apps', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.basic]);
    chargeBuc(ctx, account);
    requireOwnAccount(req.params.id, account);
    account.subscribedFields = new Set();
    return { success: true };
  });

  on('GET', '/:id/insights', (req) => {
    const { account } = authenticate(ctx, req, [SCOPES.insights]);
    chargeBuc(ctx, account);
    if (!isOwnAccount(req.params.id, account)) ownMedia(ctx, req.params.id, account);
    const key = isOwnAccount(req.params.id, account) ? account.igUserId : req.params.id;
    const metrics = String(input(req).metric ?? '').split(',').map((m) => m.trim()).filter(Boolean);
    if (!metrics.length) throw invalid('Param metric is required');
    for (const name of metrics) if (!INSIGHT_METRICS.includes(name)) throw invalid(`metric[0] must be one of the supported metrics, got ${name}`);
    const period = input(req).period ?? 'lifetime';
    const seeded = ctx.s.insights.get(key) ?? {};
    return { data: metrics.map((name) => ({ name, period, values: [{ value: seeded[name] ?? 0 }], title: name, id: `${key}/insights/${name}/${period}` })) };
  });

  on('GET', '/:id', (req) => {
    const { token, account } = authenticate(ctx, req);
    chargeBuc(ctx, account);
    const id = req.params.id;
    const { fields } = input(req);
    if (isOwnAccount(id, account)) {
      requireScopes(token, [SCOPES.basic]);
      return project(ctx, account, ACCOUNT_FIELDS, 'IGUser', fields);
    }
    const media = ctx.s.media.get(id);
    if (media?.igUserId === account.igUserId) {
      requireScopes(token, [SCOPES.basic]);
      return project(ctx, media, MEDIA_FIELDS, 'IGMedia', fields);
    }
    const who = ctx.s.people.get(`${account.igUserId}:${id}`);
    if (who?.profile) {
      requireScopes(token, [SCOPES.messages]);
      return project(ctx, who.profile, PERSON_FIELDS, 'IGUser', fields);
    }
    requireScopes(token, [SCOPES.comments]);
    return project(ctx, ownComment(ctx, id, account), COMMENT_FIELDS, 'IGComment', fields);
  });
}
