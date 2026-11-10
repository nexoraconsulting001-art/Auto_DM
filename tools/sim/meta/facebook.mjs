/**
 * Facebook, for PRD 6.10 and for Unified Login: Facebook Login for Business, Pages, Messenger replies and the Page feed
 * webhook. Permission names and Messenger's limits are to confirm, so private replies follow Instagram's rules here.
 *
 * Controls, under /__sim:
 *   POST /facebook-app           { id, secret, webhookUrl, redirectUris }: a separate Meta app from Instagram Login's
 *   POST /pages                  { pageId, name?, token?, igUserId?, scopes?, subscribedFields?, tokenTtlMs? }, returns its token
 *   POST /facebook/login-next    { pageIds?, scopes?, deny? }: what the next consent screen does
 *   POST /facebook/posts         { pageId, id?, message?, type?, permalink?, at? }
 *   POST /facebook/comments      { pageId, postId, from: { id, name }, text, id?, parentId?, at? }
 *   POST /facebook/comments/delete  { id }
 *   POST /facebook/messages      { pageId, from, text, at? }
 *   POST /facebook/postbacks     { pageId, from, payload, title?, at? }
 * What Pages send lands in GET /sent?pageId=. Events take the delivery options { deliver: false, duplicates: n, signature: 'bad' | 'none' }.
 */
import crypto from 'node:crypto';
import { SimError, reply } from '../base.mjs';
import { isLoopbackUrl } from '../guard.mjs';
import { DAY, ERRORS, HOUR, SCOPES, SECOND, graphError, toSeconds } from './constants.mjs';
import { validateMessage } from './message.mjs';
import { input, issueToken, jsonParam, liveToken, nextId, person, requestToken, throttle } from './state.mjs';
import { emit } from './webhooks.mjs';

const refuse = (error, status = 400) => new SimError(status, { error });
const plain = (text) => reply(400, text, { 'content-type': 'text/plain' });
const notFound = () => graphError(ERRORS.OBJECT_NOT_FOUND);
const invalid = (message) => graphError(ERRORS.INVALID_PARAM, `(#100) ${message}`);
const parseScopes = (scope) => String(scope ?? '').split(/[\s,]+/).filter(Boolean);
const tokenAnswer = (ctx, token) => ({ access_token: token.value, token_type: 'bearer', expires_in: toSeconds(token.expiresAt - ctx.clock.now()) });

/** Unified Login's permission names, and the Instagram Login names the Graph routes check. */
const INSTAGRAM_EQUIVALENT = Object.freeze({
  instagram_basic: SCOPES.basic,
  instagram_manage_messages: SCOPES.messages,
  instagram_manage_comments: SCOPES.comments,
  instagram_manage_insights: SCOPES.insights,
});
const withEquivalents = (scopes) => [...new Set([...scopes, ...scopes.map((s) => INSTAGRAM_EQUIVALENT[s]).filter(Boolean)])];

export function makePage(body) {
  return { pageId: String(body.pageId), name: body.name ?? `Page ${body.pageId}`, igUserId: body.igUserId === undefined ? null : String(body.igUserId), subscribedFields: new Set(body.subscribedFields ?? []), privateReplyTimes: [], sendTimes: [] };
}

function issuePageToken(ctx, page, { value, scopes, ttlMs } = {}) {
  const token = issueToken(ctx, { igUserId: page.igUserId }, { kind: 'page', value, scopes: scopes ?? ['pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_engagement'], ttlMs: ttlMs ?? 3650 * DAY });
  token.pageId = page.pageId;
  return token;
}

function redirectAllowed(app, uri) {
  if (!uri) return false;
  return app.redirectUris?.length ? app.redirectUris.includes(uri) : isLoopbackUrl(uri);
}

function userToken(ctx, req) {
  const value = requestToken(req);
  if (!value) throw graphError(ERRORS.TOKEN_MISSING);
  const token = liveToken(ctx, value);
  if (!String(token.kind).startsWith('fb_user')) throw graphError(ERRORS.TOKEN_INVALID);
  return token;
}

function authenticatePage(ctx, req) {
  const value = requestToken(req);
  if (!value) throw graphError(ERRORS.TOKEN_MISSING);
  const token = liveToken(ctx, value);
  const page = ctx.s.pages.get(req.params.id);
  if (!page || token.pageId !== page.pageId) throw notFound();
  return { token, page };
}

function requireScope(token, scope) {
  if (!token.scopes.includes(scope)) throw graphError(ERRORS.PERMISSION, `(#200) This action requires the ${scope} permission.`);
}

function commitPageDm(ctx, page, { kind, recipientId, commentId, message }) {
  const id = `m_${nextId(ctx)}`;
  ctx.s.sent.push({ id, at: ctx.clock.now(), kind, pageId: page.pageId, recipientId, ...(commentId ? { commentId } : {}), message });
  return { recipient_id: recipientId, message_id: id };
}

function pagePrivateReply(ctx, page, commentId, message) {
  throttle(ctx, page.privateReplyTimes, HOUR, ctx.s.limits.privateRepliesPerHour);
  validateMessage(message, ctx.s.limits);
  const comment = ctx.s.pageComments.get(String(commentId));
  if (!comment || comment.pageId !== page.pageId || comment.deleted) throw notFound();
  if (comment.from.id === page.pageId) throw graphError(ERRORS.CANNOT_REPLY);
  if (ctx.clock.now() - comment.at >= ctx.s.limits.privateReplyWindowMs) throw graphError(ERRORS.REPLY_WINDOW_CLOSED);
  if (comment.privateReplyId) throw graphError(ERRORS.ALREADY_REPLIED);
  const result = commitPageDm(ctx, page, { kind: 'private_reply', recipientId: comment.from.id, commentId: comment.id, message });
  comment.privateReplyId = result.message_id;
  return result;
}

function pageSendApi(ctx, page, recipientId, message) {
  throttle(ctx, page.sendTimes, SECOND, ctx.s.limits.sendPerSecond);
  validateMessage(message, ctx.s.limits);
  const who = person(ctx, page.pageId, recipientId);
  if (who.lastUserMessageAt === null || ctx.clock.now() - who.lastUserMessageAt >= ctx.s.limits.messagingWindowMs) throw graphError(ERRORS.WINDOW_CLOSED);
  return commitPageDm(ctx, page, { kind: 'send_api', recipientId, message });
}

function pageMessages(ctx, req) {
  const { token, page } = authenticatePage(ctx, req);
  requireScope(token, 'pages_messaging');
  const params = input(req);
  const recipient = jsonParam(params.recipient);
  const message = jsonParam(params.message);
  if (recipient?.comment_id) return pagePrivateReply(ctx, page, recipient.comment_id, message);
  if (recipient?.id) return pageSendApi(ctx, page, String(recipient.id), message);
  throw invalid('Param recipient must hold comment_id or id');
}

function setSubscription(ctx, req) {
  const { token, page } = authenticatePage(ctx, req);
  requireScope(token, 'pages_manage_metadata');
  const fields = parseScopes(input(req).subscribed_fields);
  if (!fields.length) throw invalid('subscribed_fields is required');
  page.subscribedFields = new Set(fields);
  return { success: true };
}

function getSubscription(ctx, req) {
  const { page } = authenticatePage(ctx, req);
  return { data: page.subscribedFields.size ? [{ id: ctx.s.facebookApp.id, subscribed_fields: [...page.subscribedFields] }] : [] };
}

function clearSubscription(ctx, req) {
  const { page } = authenticatePage(ctx, req);
  page.subscribedFields = new Set();
  return { success: true };
}

function pageNode(ctx, req) {
  const { page } = authenticatePage(ctx, req);
  return { id: page.pageId, name: page.name };
}

const PAGE_HANDLERS = {
  'POST /:id/messages': pageMessages,
  'POST /:id/subscribed_apps': setSubscription,
  'GET /:id/subscribed_apps': getSubscription,
  'DELETE /:id/subscribed_apps': clearSubscription,
  'GET /:id': pageNode,
};

/** Wraps graphRoutes' `on`, so a Page's id reaches the Page's version of a route. */
export function withPages(on, ctx) {
  return (method, pattern, handler) => {
    const forPage = PAGE_HANDLERS[`${method} ${pattern}`];
    on(method, pattern, forPage ? (req) => (ctx.s.pages.has(req.params.id) ? forPage(ctx, req) : handler(req)) : handler);
  };
}

/** POST /oauth/access_token with the Facebook app's id: the code exchange and the long-lived exchange. Null when it isn't Facebook's. */
export function facebookExchange(ctx, req) {
  const { client_id: clientId, client_secret: clientSecret, grant_type: grantType, fb_exchange_token: shortValue, redirect_uri: redirectUri, code } = input(req);
  const app = ctx.s.facebookApp;
  if (clientId !== app.id) return null;
  if (clientSecret !== app.secret) throw graphError(ERRORS.CLIENT_SECRET);
  if (grantType === 'fb_exchange_token') {
    const short = liveToken(ctx, shortValue);
    if (short.kind !== 'fb_user_short') throw graphError(ERRORS.TOKEN_INVALID);
    const long = issueToken(ctx, { igUserId: null }, { kind: 'fb_user_long', scopes: short.scopes, ttlMs: ctx.s.limits.longTokenMs });
    Object.assign(long, { pageIds: short.pageIds, requested: short.requested });
    return tokenAnswer(ctx, long);
  }
  const grant = ctx.s.codes.get(code);
  if (!grant?.facebook || grant.used || ctx.clock.now() >= grant.expiresAt) throw invalid('This authorization code has expired or been used.');
  if (grant.redirectUri !== redirectUri) throw invalid('redirect_uri does not match the one used in the dialog.');
  grant.used = true;
  const short = issueToken(ctx, { igUserId: null }, { kind: 'fb_user_short', scopes: withEquivalents(grant.scopes), ttlMs: ctx.s.limits.shortTokenMs });
  Object.assign(short, { pageIds: grant.pageIds, requested: grant.scopes });
  return tokenAnswer(ctx, short);
}

export function facebookRoutes(on, ctx) {
  on('GET', '/dialog/oauth', (req) => {
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, scope, state } = req.query;
    const app = ctx.s.facebookApp;
    if (clientId !== app.id) return plain('Invalid app id');
    if (!redirectAllowed(app, redirectUri)) return plain('The redirect_uri is not registered for this app.');
    if (responseType !== 'code') return plain('response_type must be code.');
    const requested = parseScopes(scope);
    if (!requested.length) return plain('Invalid scope.');

    const login = ctx.s.nextFacebookLogin ?? {};
    ctx.s.nextFacebookLogin = null;
    const target = new URL(redirectUri);
    if (state !== undefined) target.searchParams.set('state', state);
    if (login.deny) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('error_reason', 'user_denied');
      return reply(302, '', { location: target.href });
    }
    const code = `AQfb${crypto.randomBytes(16).toString('hex')}`;
    ctx.s.codes.set(code, { facebook: true, scopes: login.scopes ?? requested, pageIds: login.pageIds ?? [...ctx.s.pages.keys()], redirectUri, expiresAt: ctx.clock.now() + ctx.s.limits.codeMs, used: false });
    target.searchParams.set('code', code);
    return reply(302, '', { location: target.href });
  });

  on('GET', '/:id/accounts', (req) => {
    const token = userToken(ctx, req);
    if (req.params.id !== 'me') throw notFound();
    const data = token.pageIds.map((pageId) => ctx.s.pages.get(pageId)).filter(Boolean).map((page) => {
      const account = page.igUserId ? ctx.s.accounts.get(page.igUserId) : null;
      return {
        id: page.pageId,
        name: page.name,
        access_token: issuePageToken(ctx, page, { scopes: token.scopes }).value,
        ...(account ? { instagram_business_account: { id: account.igUserId, username: account.username } } : {}),
      };
    });
    return { data };
  });

  on('GET', '/:id/permissions', (req) => {
    const token = userToken(ctx, req);
    if (req.params.id !== 'me') throw notFound();
    return { data: token.requested.map((permission) => ({ permission, status: 'granted' })) };
  });

  const posts = (req, type) => {
    const { page } = authenticatePage(ctx, req);
    return { data: [...ctx.s.pagePosts.values()].filter((p) => p.pageId === page.pageId && (!type || p.type === type)).reverse().map((p) => ({ id: p.id, message: p.message, created_time: new Date(p.at).toISOString(), permalink_url: p.permalink })) };
  };
  on('GET', '/:id/posts', (req) => posts(req));
  on('GET', '/:id/video_reels', (req) => posts(req, 'reel'));

  on('POST', '/:id/comments', (req) => {
    const value = requestToken(req);
    if (!value) throw graphError(ERRORS.TOKEN_MISSING);
    const token = liveToken(ctx, value);
    const parent = ctx.s.pageComments.get(req.params.id);
    if (!parent || parent.pageId !== token.pageId || parent.deleted) throw notFound();
    const text = input(req).message;
    if (typeof text !== 'string' || !text.trim()) throw invalid('Param message must be a non-empty string');
    const id = nextId(ctx);
    const from = { id: parent.pageId, name: ctx.s.pages.get(parent.pageId).name };
    ctx.s.pageComments.set(id, { id, pageId: parent.pageId, postId: parent.postId, from, text, parentId: parent.id, at: ctx.clock.now(), deleted: false, privateReplyId: null });
    ctx.s.sent.push({ id, at: ctx.clock.now(), kind: 'public_reply', pageId: parent.pageId, commentId: parent.id, message: { text } });
    return { id };
  });
}

export function facebookControls(on, ctx) {
  const needPage = (id) => {
    const page = ctx.s.pages.get(String(id ?? ''));
    if (!page) throw refuse(`No Page ${id}; POST /__sim/pages first.`, 404);
    return page;
  };
  const sender = (value) => {
    const id = typeof value === 'object' && value !== null ? value.id : value;
    if ((typeof id !== 'string' && typeof id !== 'number') || id === '') throw refuse('from is required.');
    return { id: String(id), name: (typeof value === 'object' && value?.name) || undefined };
  };
  const when = (body) => {
    if (body.at !== undefined && !Number.isFinite(body.at)) throw refuse('at must be a number.');
    return body.at ?? ctx.clock.now();
  };
  const send = (page, field, entry, body) => emit(ctx, page, field, entry, { deliver: body.deliver, duplicates: body.duplicates, signature: body.signature, object: 'page', secret: ctx.s.facebookApp.secret, url: ctx.s.facebookApp.webhookUrl || ctx.s.app.webhookUrl });
  const messaging = (page, event, at) => ({ id: page.pageId, time: at, messaging: [{ recipient: { id: page.pageId }, timestamp: at, ...event }] });

  on('POST', '/facebook-app', ({ body }) => {
    for (const key of ['webhookUrl']) if (body[key] && !isLoopbackUrl(body[key])) throw refuse(`${key} must be an http(s) URL on this machine.`);
    Object.assign(ctx.s.facebookApp, body);
    return { id: ctx.s.facebookApp.id };
  });

  on('POST', '/pages', ({ body }) => {
    if (body.pageId === undefined || body.pageId === '') throw refuse('pageId is required.');
    if (ctx.s.pages.has(String(body.pageId))) throw refuse(`Page ${body.pageId} already exists.`, 409);
    if (body.igUserId !== undefined && !ctx.s.accounts.has(String(body.igUserId))) throw refuse(`No account ${body.igUserId}; POST /__sim/accounts first.`, 404);
    const page = makePage(body);
    ctx.s.pages.set(page.pageId, page);
    const token = issuePageToken(ctx, page, { value: body.token, scopes: body.scopes, ttlMs: body.tokenTtlMs });
    return { pageId: page.pageId, token: token.value, expiresAt: token.expiresAt };
  });

  on('POST', '/facebook/login-next', ({ body }) => {
    ctx.s.nextFacebookLogin = { pageIds: body.pageIds?.map(String), scopes: body.scopes, deny: Boolean(body.deny) };
    return { ok: true };
  });

  on('POST', '/facebook/posts', ({ body }) => {
    const page = needPage(body.pageId);
    const id = body.id === undefined ? `${page.pageId}_${nextId(ctx)}` : String(body.id);
    ctx.s.pagePosts.set(id, { id, pageId: page.pageId, message: body.message ?? '', type: body.type ?? 'post', permalink: body.permalink ?? `https://www.facebook.com/${id}`, at: when(body) });
    return { id };
  });

  on('POST', '/facebook/comments', async ({ body }) => {
    const page = needPage(body.pageId);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    if (!ctx.s.pagePosts.has(String(body.postId))) throw refuse(`No post ${body.postId}; POST /__sim/facebook/posts first.`, 404);
    const id = body.id === undefined ? nextId(ctx) : String(body.id);
    const from = sender(body.from);
    const at = when(body);
    ctx.s.pageComments.set(id, { id, pageId: page.pageId, postId: String(body.postId), from, text: body.text, parentId: body.parentId, at, deleted: false, privateReplyId: null });
    const value = { from, item: 'comment', verb: 'add', comment_id: id, post_id: String(body.postId), ...(body.parentId ? { parent_id: String(body.parentId) } : {}), message: body.text, created_time: toSeconds(at) };
    return { comment: { id, at }, delivery: await send(page, 'feed', { id: page.pageId, time: toSeconds(at), changes: [{ field: 'feed', value }] }, body) };
  });

  on('POST', '/facebook/comments/delete', ({ body }) => {
    const comment = ctx.s.pageComments.get(String(body.id ?? ''));
    if (!comment) throw refuse('No such comment.', 404);
    comment.deleted = true;
    return { ok: true };
  });

  on('POST', '/facebook/messages', async ({ body }) => {
    const page = needPage(body.pageId);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    const from = sender(body.from);
    const at = when(body);
    person(ctx, page.pageId, from.id).lastUserMessageAt = at;
    const mid = `m_fb_${nextId(ctx)}`;
    return { mid, delivery: await send(page, 'messages', messaging(page, { sender: { id: from.id }, message: { mid, text: body.text } }, at), body) };
  });

  on('POST', '/facebook/postbacks', async ({ body }) => {
    const page = needPage(body.pageId);
    if (typeof body.payload !== 'string') throw refuse('payload is required.');
    const from = sender(body.from);
    const at = when(body);
    person(ctx, page.pageId, from.id).lastUserMessageAt = at;
    const mid = `m_fbpb_${nextId(ctx)}`;
    return { mid, delivery: await send(page, 'messaging_postbacks', messaging(page, { sender: { id: from.id }, postback: { mid, title: body.title ?? '', payload: body.payload } }, at), body) };
  });
}
