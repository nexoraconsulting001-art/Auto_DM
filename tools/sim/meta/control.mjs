/**
 * The Meta simulator's own controls, under /__sim. Tests use these to play the part of Instagram's users:
 *
 *   POST /app                  { id, secret, verifyToken, webhookUrl, deauthorizeUrl, deletionUrl, redirectUris, oauthShape, rotateOnRefresh, echoes, accessLevel }
 *   POST /limits               any key of LIMITS, to shrink a budget
 *   POST /accounts             { igUserId, username, token?, scopes?, subscribedFields?, impressions?, appRole?, ... }, returns its token
 *   POST /tokens               { igUserId, kind?, value?, scopes?, issuedAt?, ttlMs? }
 *   POST /tokens/expire        { token }
 *   POST /tokens/revoke        { token } or { igUserId }
 *   POST /oauth/next           { igUserId?, scopes?, deny? }: what the next consent screen does
 *   POST /media                { igUserId, id?, caption?, productType?, children?, ... }: children is a list of ids, for a carousel album
 *   POST /insights             { id, metrics: { reach: 10 } }; id is a media or account id. More insights controls are in insights.mjs, and Conversions API's in conversions.mjs
 *   POST /usage                { igUserId, percent, regainMinutes? }; percent null goes back to counting
 *   POST /people               { igUserId, id, unavailable?, name?, username? }: name or username makes the profile readable
 *   POST /comments             { igUserId, mediaId, from: { id, username }, text, id?, parentId?, at? }
 *   POST /comments/delete      { id, notify? }: notify also sends a webhook (verb "remove"); whether Meta does is to confirm
 *   POST /comments/edit        { id, text, notify? }: the same, with verb "edited"
 *   POST /owner-replies        { igUserId, to, text, at? }: the owner types in the Instagram app, which comes back as an echo
 *   POST /messages             { igUserId, from, text, at? }: a person DMs the business
 *   POST /postbacks            { igUserId, from, payload, title?, at? }: a person taps a button
 *   POST /story-replies        { igUserId, from, text, storyId?, url?, at? }
 *   POST /mentions             { igUserId, from?, url?, mediaId?, commentId? }: a story mention, or with mediaId a post mention
 *   POST /webhooks/send        { body } or { raw }: any payload, signed
 *   POST /webhooks/flush       { batchSize? }: sends what { hold: true } collected
 *   POST /webhooks/retry       every failed delivery again, within 36 hours of its first attempt
 *   POST /webhooks/verify      { verifyToken? }: the GET handshake
 *   GET  /webhooks             { deliveries, held }
 *   GET  /sent?igUserId=&recipientId=&commentId=&kind=   every DM and public reply that went out
 *   POST /deauthorize          { igUserId, userId?, signature? }: also ends the account's tokens and subscriptions
 *   POST /deletion             { igUserId, userId?, signature? }
 *
 * Everything that makes an event takes the delivery options { deliver: false, hold: true, duplicates: n, signature: 'bad' | 'none' }.
 * Faults here also take code and subcode (a Graph error code) and regainMinutes (estimated_time_to_regain_access in the usage header).
 */
import { SimError } from '../base.mjs';
import { LIMITS, toSeconds } from './constants.mjs';
import { checkAppConfig, issueToken, makeAccount, makeMedia, nextId, person, revokeAccountTokens } from './state.mjs';
import { deliverPayload, deliverRawBody, deliveryView, emit, flushHeld, retryFailed, sendCallback, verifyHandshake } from './webhooks.mjs';

const refuse = (error, status = 400) => new SimError(status, { error });

function requireId(value, label) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') throw refuse(`${label} is required.`);
  return String(value);
}

function checkSignature(signature) {
  if (signature !== undefined && !['good', 'bad', 'none'].includes(signature)) throw refuse('signature must be good, bad or none.');
}

function deliveryOptions(body) {
  checkSignature(body.signature);
  if (body.duplicates !== undefined && !(Number.isInteger(body.duplicates) && body.duplicates >= 1)) throw refuse('duplicates must be a whole number from 1.');
  return { deliver: body.deliver, hold: body.hold, duplicates: body.duplicates, signature: body.signature };
}

export function controlRoutes(on, ctx) {
  const now = () => ctx.clock.now();
  const needAccount = (igUserId) => {
    const account = ctx.s.accounts.get(requireId(igUserId, 'igUserId'));
    if (!account) throw refuse(`No account ${igUserId}; POST /__sim/accounts first.`, 404);
    return account;
  };
  const from = (value) => {
    const id = requireId(typeof value === 'object' && value !== null ? value.id : value, 'from');
    return { id, username: (typeof value === 'object' && value?.username) || undefined };
  };
  // entry.time is milliseconds on messaging events and seconds on changes events, as Instagram sends them.
  const messagingEntry = (account, event, at) => ({ id: account.igUserId, time: at, messaging: [{ recipient: { id: account.igUserId }, timestamp: at, ...event }] });
  const eventTime = (body) => {
    if (body.at !== undefined && !Number.isFinite(body.at)) throw refuse('at must be a number.');
    return body.at ?? now();
  };
  const openWindow = (account, igsid, at) => {
    person(ctx, account.igUserId, igsid).lastUserMessageAt = at;
  };

  on('POST', '/app', ({ body }) => {
    const { secret: _secret, ...visible } = (ctx.s.app = checkAppConfig({ ...ctx.s.app, ...body }));
    return visible;
  });

  on('POST', '/limits', ({ body }) => {
    for (const [key, value] of Object.entries(body)) {
      if (!Object.hasOwn(LIMITS, key)) throw refuse(`Unknown limit "${key}".`);
      if (!Number.isFinite(value) || value < 0) throw refuse(`${key} must be a number from 0.`);
    }
    Object.assign(ctx.s.limits, body);
    return ctx.s.limits;
  });

  on('POST', '/accounts', ({ body }) => {
    const igUserId = requireId(body.igUserId, 'igUserId');
    if (ctx.s.accounts.has(igUserId)) throw refuse(`Account ${igUserId} already exists.`, 409);
    const account = makeAccount({ ...body, igUserId });
    ctx.s.accounts.set(igUserId, account);
    ctx.s.lastSeeded = igUserId;
    const token = issueToken(ctx, account, { kind: 'long', value: body.token, scopes: body.scopes, issuedAt: body.tokenIssuedAt, ttlMs: body.tokenTtlMs });
    return { igUserId, appScopedId: account.appScopedId, username: account.username, token: token.value, expiresAt: token.expiresAt };
  });

  on('POST', '/tokens', ({ body }) => {
    const token = issueToken(ctx, needAccount(body.igUserId), { kind: body.kind, value: body.value, scopes: body.scopes, issuedAt: body.issuedAt, ttlMs: body.ttlMs });
    return { token: token.value, kind: token.kind, issuedAt: token.issuedAt, expiresAt: token.expiresAt, scopes: token.scopes };
  });

  on('POST', '/tokens/expire', ({ body }) => {
    const token = ctx.s.tokens.get(body.token);
    if (!token) throw refuse('No such token.', 404);
    token.expiresAt = now();
    return { ok: true };
  });

  on('POST', '/tokens/revoke', ({ body }) => {
    if (body.igUserId !== undefined) {
      revokeAccountTokens(ctx, needAccount(body.igUserId));
      return { ok: true };
    }
    const token = ctx.s.tokens.get(body.token);
    if (!token) throw refuse('No such token.', 404);
    token.revoked = true;
    return { ok: true };
  });

  on('POST', '/oauth/next', ({ body }) => {
    if (body.igUserId !== undefined) needAccount(body.igUserId);
    ctx.s.nextLogin = { igUserId: body.igUserId ?? ctx.s.lastSeeded, scopes: body.scopes, deny: Boolean(body.deny) };
    return { ok: true };
  });

  on('POST', '/media', ({ body }) => {
    const account = needAccount(body.igUserId);
    const id = body.id === undefined ? nextId(ctx) : requireId(body.id, 'id');
    if (ctx.s.media.has(id)) throw refuse(`Media ${id} already exists.`, 409);
    ctx.s.media.set(id, makeMedia(ctx, account, id, body));
    for (const child of body.children ?? []) ctx.s.media.set(String(child), makeMedia(ctx, account, String(child), { productType: 'FEED', mediaType: 'IMAGE', parentId: id, at: body.at }));
    return { id };
  });

  on('POST', '/insights', ({ body }) => {
    ctx.s.insights.set(requireId(body.id, 'id'), { ...(ctx.s.insights.get(String(body.id)) ?? {}), ...body.metrics });
    if (body.notEnoughViewers !== undefined) ctx.s.lowViewers[body.notEnoughViewers ? 'add' : 'delete'](String(body.id));
    return { ok: true };
  });

  on('POST', '/usage', ({ body }) => {
    const account = needAccount(body.igUserId);
    if (body.percent === null || body.percent === undefined) {
      account.usage = null;
      return { ok: true };
    }
    if (!Number.isFinite(body.percent) || body.percent < 0) throw refuse('percent must be a number from 0, or null.');
    if (body.regainMinutes !== undefined && !(Number.isFinite(body.regainMinutes) && body.regainMinutes >= 0)) throw refuse('regainMinutes must be a number from 0.');
    account.usage = { percent: body.percent, regainMinutes: body.regainMinutes };
    return { ok: true };
  });

  on('POST', '/people', ({ body }) => {
    const who = person(ctx, needAccount(body.igUserId).igUserId, requireId(body.id, 'id'));
    if (body.unavailable !== undefined) who.unavailable = Boolean(body.unavailable);
    if (body.name !== undefined || body.username !== undefined) who.profile = { id: String(body.id), name: body.name, username: body.username };
    return { ok: true };
  });

  on('POST', '/comments', async ({ body }) => {
    const account = needAccount(body.igUserId);
    const options = deliveryOptions(body);
    const mediaId = requireId(body.mediaId, 'mediaId');
    if (typeof body.text !== 'string') throw refuse('text is required.');
    if (!ctx.s.media.has(mediaId)) ctx.s.media.set(mediaId, makeMedia(ctx, account, mediaId));
    const media = ctx.s.media.get(mediaId);
    if (media.igUserId !== account.igUserId) throw refuse(`Media ${mediaId} belongs to another account.`);
    const id = body.id === undefined ? nextId(ctx) : requireId(body.id, 'id');
    if (ctx.s.comments.has(id)) throw refuse(`Comment ${id} already exists.`, 409);
    const author = from(body.from);
    const at = eventTime(body);
    ctx.s.comments.set(id, { id, igUserId: account.igUserId, mediaId, from: author, text: body.text, parentId: body.parentId, at, deleted: false, privateReplyId: null });
    const value = { from: author, media: { id: mediaId, media_product_type: media.productType }, id, ...(body.parentId ? { parent_id: body.parentId } : {}), text: body.text };
    const delivery = await emit(ctx, account, 'comments', { id: account.igUserId, time: toSeconds(at), changes: [{ field: 'comments', value }] }, options);
    return { comment: { id, at }, delivery };
  });

  const notifyComment = (comment, verb) => {
    const media = ctx.s.media.get(comment.mediaId);
    const value = { from: comment.from, media: { id: media.id, media_product_type: media.productType }, id: comment.id, ...(comment.parentId ? { parent_id: comment.parentId } : {}), text: comment.text, verb };
    return emit(ctx, ctx.s.accounts.get(comment.igUserId), 'comments', { id: comment.igUserId, time: toSeconds(now()), changes: [{ field: 'comments', value }] });
  };

  on('POST', '/comments/delete', async ({ body }) => {
    const comment = ctx.s.comments.get(requireId(body.id, 'id'));
    if (!comment) throw refuse('No such comment.', 404);
    comment.deleted = true;
    return { ok: true, ...(body.notify ? { delivery: await notifyComment(comment, 'remove') } : {}) };
  });

  on('POST', '/comments/edit', async ({ body }) => {
    const comment = ctx.s.comments.get(requireId(body.id, 'id'));
    if (!comment) throw refuse('No such comment.', 404);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    comment.text = body.text;
    return { ok: true, ...(body.notify ? { delivery: await notifyComment(comment, 'edited') } : {}) };
  });

  on('POST', '/owner-replies', async ({ body }) => {
    const account = needAccount(body.igUserId);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    const to = requireId(body.to, 'to');
    const at = eventTime(body);
    const mid = `m_owner_${nextId(ctx)}`;
    const event = { sender: { id: account.igUserId }, recipient: { id: to }, timestamp: at, message: { mid, is_echo: true, text: body.text } };
    return { mid, delivery: await emit(ctx, account, 'messages', { id: account.igUserId, time: at, messaging: [event] }, deliveryOptions(body)) };
  });

  on('POST', '/messages', async ({ body }) => {
    const account = needAccount(body.igUserId);
    const options = deliveryOptions(body);
    const sender = from(body.from);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    const at = eventTime(body);
    openWindow(account, sender.id, at);
    const mid = `m_in_${nextId(ctx)}`;
    const delivery = await emit(ctx, account, 'messages', messagingEntry(account, { sender: { id: sender.id }, message: { mid, text: body.text } }, at), options);
    return { mid, delivery };
  });

  on('POST', '/postbacks', async ({ body }) => {
    const account = needAccount(body.igUserId);
    const options = deliveryOptions(body);
    const sender = from(body.from);
    if (typeof body.payload !== 'string') throw refuse('payload is required.');
    const at = eventTime(body);
    openWindow(account, sender.id, at);
    const mid = `m_pb_${nextId(ctx)}`;
    const delivery = await emit(ctx, account, 'messaging_postbacks', messagingEntry(account, { sender: { id: sender.id }, postback: { mid, title: body.title ?? '', payload: body.payload } }, at), options);
    return { mid, delivery };
  });

  on('POST', '/story-replies', async ({ body }) => {
    const account = needAccount(body.igUserId);
    const options = deliveryOptions(body);
    const sender = from(body.from);
    if (typeof body.text !== 'string') throw refuse('text is required.');
    const at = eventTime(body);
    openWindow(account, sender.id, at);
    const mid = `m_sr_${nextId(ctx)}`;
    const story = { id: body.storyId ?? nextId(ctx), url: body.url ?? 'https://media.invalid/story.jpg' };
    const delivery = await emit(ctx, account, 'messages', messagingEntry(account, { sender: { id: sender.id }, message: { mid, text: body.text, reply_to: { story } } }, at), options);
    return { mid, delivery };
  });

  // Whether a mention opens the window is unknown (PRD 4.3 row 9), so it does not, the cautious reading.
  on('POST', '/mentions', async ({ body }) => {
    const account = needAccount(body.igUserId);
    const options = deliveryOptions(body);
    const at = eventTime(body);
    if (body.mediaId !== undefined) {
      const value = { media_id: requireId(body.mediaId, 'mediaId'), ...(body.commentId ? { comment_id: String(body.commentId) } : {}) };
      return { delivery: await emit(ctx, account, 'mentions', { id: account.igUserId, time: toSeconds(at), changes: [{ field: 'mentions', value }] }, options) };
    }
    const sender = from(body.from);
    const mid = `m_sm_${nextId(ctx)}`;
    const attachments = [{ type: 'story_mention', payload: { url: body.url ?? 'https://media.invalid/mention.jpg' } }];
    return { mid, delivery: await emit(ctx, account, 'messages', messagingEntry(account, { sender: { id: sender.id }, message: { mid, attachments } }, at), options) };
  });

  on('POST', '/webhooks/send', ({ body }) => {
    const options = deliveryOptions(body);
    if (body.raw !== undefined) {
      if (typeof body.raw !== 'string') throw refuse('raw must be a string.');
      return deliverRawBody(ctx, body.raw, options);
    }
    if (typeof body.body !== 'object' || body.body === null) throw refuse('Give body (an object) or raw (a string).');
    return deliverPayload(ctx, body.body, options);
  });
  on('POST', '/webhooks/flush', ({ body }) => {
    if (body.batchSize !== undefined && !(Number.isInteger(body.batchSize) && body.batchSize >= 1)) throw refuse('batchSize must be a whole number from 1.');
    return flushHeld(ctx, { batchSize: body.batchSize, ...deliveryOptions(body) });
  });
  on('POST', '/webhooks/retry', () => retryFailed(ctx));
  on('POST', '/webhooks/verify', ({ body }) => verifyHandshake(ctx, body));
  on('GET', '/webhooks', () => ({ deliveries: ctx.s.deliveries.map(deliveryView), held: ctx.s.held }));

  on('GET', '/sent', ({ query }) => ({
    sent: ctx.s.sent.filter((m) => (!query.igUserId || m.igUserId === query.igUserId) && (!query.pageId || m.pageId === query.pageId) && (!query.recipientId || m.recipientId === query.recipientId) && (!query.commentId || m.commentId === query.commentId) && (!query.kind || m.kind === query.kind)),
  }));

  on('POST', '/deauthorize', async ({ body }) => {
    const account = needAccount(body.igUserId);
    checkSignature(body.signature);
    const result = await sendCallback(ctx, ctx.s.app.deauthorizeUrl, 'deauthorize', body.userId ?? account.igUserId, body.signature);
    if ((body.signature ?? 'good') === 'good') {
      revokeAccountTokens(ctx, account);
      account.subscribedFields = new Set();
    }
    return result;
  });

  on('POST', '/deletion', async ({ body }) => {
    const account = needAccount(body.igUserId);
    checkSignature(body.signature);
    const result = await sendCallback(ctx, ctx.s.app.deletionUrl, 'deletion', body.userId ?? account.igUserId, body.signature);
    const valid = result.status === 200 && typeof result.body?.url === 'string' && typeof result.body?.confirmation_code === 'string';
    return { ...result, valid };
  });
}
