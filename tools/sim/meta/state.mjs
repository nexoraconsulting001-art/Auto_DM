/** The Meta simulator's data, and the rules every route shares: tokens, ownership, throttles and the BUC bucket. */
import crypto from 'node:crypto';
import { DEFAULT_SCOPES, ERRORS, LIMITS, MINUTE, graphError } from './constants.mjs';
import { SimError } from '../base.mjs';
import { isLoopbackUrl } from '../guard.mjs';

const withoutUndefined = (object = {}) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

/** A simulator must never send anything off this machine, however it is configured. */
export function checkAppConfig(app) {
  for (const key of ['webhookUrl', 'deauthorizeUrl', 'deletionUrl']) {
    if (app[key] && !isLoopbackUrl(app[key])) throw new SimError(400, { error: `${key} must be an http(s) URL on this machine.` });
  }
  return app;
}

export function freshState(options = {}) {
  return {
    app: checkAppConfig({
      id: 'sim-app',
      secret: 'sim-app-secret',
      verifyToken: 'sim-verify-token',
      webhookUrl: '',
      deauthorizeUrl: '',
      deletionUrl: '',
      redirectUris: [],
      // The Instagram Login docs wrap this response in data[]; field reports show it flat. 'flat' tests the other form.
      oauthShape: 'documented',
      rotateOnRefresh: false,
      echoes: true,
      // 'standard': only accounts with an app role work, as before App Review (PRD 4.15).
      accessLevel: 'advanced',
      ...withoutUndefined(options.app),
    }),
    facebookApp: checkAppConfig({ id: 'sim-fb-app', secret: 'sim-fb-app-secret', webhookUrl: '', redirectUris: [], ...withoutUndefined(options.facebookApp) }),
    limits: { ...LIMITS, ...withoutUndefined(options.limits) },
    accounts: new Map(),
    tokens: new Map(),
    codes: new Map(),
    media: new Map(),
    comments: new Map(),
    people: new Map(),
    insights: new Map(),
    iceBreakers: new Map(),
    pages: new Map(),
    pagePosts: new Map(),
    pageComments: new Map(),
    nextFacebookLogin: null,
    sent: [],
    deliveries: [],
    held: [],
    nextLogin: null,
    lastSeeded: null,
    seq: 0,
  };
}

/** Numeric, like Instagram's own ids. */
export const nextId = (ctx) => String(17_900_000_000_000_000n + BigInt(++ctx.s.seq));

export function makeAccount({ igUserId, appScopedId, username, name, accountType, followersCount, followsCount, biography, website, profilePictureUrl, impressions, subscribedFields, appRole }) {
  return {
    igUserId,
    // Instagram Login gives one person two ids: /me `id` and the code exchange's user_id are app-scoped; /me `user_id` is the id webhooks carry.
    appScopedId: appScopedId ?? `9${igUserId}`,
    username: username ?? `user_${igUserId}`,
    name: name ?? username ?? `User ${igUserId}`,
    accountType: accountType ?? 'BUSINESS',
    followersCount: followersCount ?? 0,
    followsCount: followsCount ?? 0,
    biography: biography ?? '',
    website: website ?? '',
    profilePictureUrl: profilePictureUrl ?? '',
    impressions: impressions ?? 1,
    subscribedFields: new Set(subscribedFields ?? []),
    appRole: Boolean(appRole),
    privateReplyTimes: [],
    sendTimes: [],
    bucTimes: [],
    usage: null,
  };
}

/** Media as Graph describes it; anything not given gets a plausible value. */
export function makeMedia(ctx, account, id, fields = {}) {
  return {
    id,
    igUserId: account.igUserId,
    caption: fields.caption ?? '',
    mediaType: fields.mediaType ?? 'VIDEO',
    productType: fields.productType ?? 'REELS',
    permalink: fields.permalink ?? `https://www.instagram.com/reel/${id}/`,
    shortcode: fields.shortcode ?? id,
    mediaUrl: fields.mediaUrl ?? `https://media.invalid/${id}.mp4`,
    thumbnailUrl: fields.thumbnailUrl ?? `https://media.invalid/${id}.jpg`,
    likeCount: fields.likeCount ?? 0,
    at: fields.at ?? ctx.clock.now(),
  };
}

export function issueToken(ctx, account, { kind = 'long', value, scopes = DEFAULT_SCOPES, issuedAt = ctx.clock.now(), ttlMs } = {}) {
  const lifetime = ttlMs ?? (kind === 'short' ? ctx.s.limits.shortTokenMs : ctx.s.limits.longTokenMs);
  const token = {
    value: value ?? `IGAAsim${crypto.randomBytes(24).toString('hex')}`,
    kind,
    igUserId: account.igUserId,
    scopes: [...scopes],
    issuedAt,
    expiresAt: issuedAt + lifetime,
    revoked: false,
  };
  ctx.s.tokens.set(token.value, token);
  return token;
}

export function revokeAccountTokens(ctx, account) {
  for (const token of ctx.s.tokens.values()) if (token.igUserId === account.igUserId) token.revoked = true;
}

/** What Meta knows about one person, per business account: a window with one business opens nothing with another. */
export function person(ctx, igUserId, igsid) {
  const key = `${igUserId}:${igsid}`;
  if (!ctx.s.people.has(key)) ctx.s.people.set(key, { lastUserMessageAt: null, unavailable: false, profile: null });
  return ctx.s.people.get(key);
}

export const isOwnAccount = (ref, account) => ref === 'me' || ref === account.igUserId || ref === account.appScopedId;

export function input(req) {
  return { ...req.query, ...(typeof req.body === 'object' && req.body !== null ? req.body : {}) };
}

/** Graph takes objects as JSON strings when they arrive in a query or a form. */
export function jsonParam(value) {
  if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function requestToken(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, '').trim();
  return input(req).access_token;
}

export function requireScopes(token, scopes) {
  for (const scope of scopes) {
    if (!token.scopes.includes(scope)) throw graphError(ERRORS.PERMISSION, `(#200) This action requires the ${scope} permission.`);
  }
}

/** The token with this value, if it can still be used. Expiry is exact: at expiresAt it is already dead. */
export function liveToken(ctx, value) {
  const token = ctx.s.tokens.get(value);
  if (!token) throw graphError(ERRORS.TOKEN_INVALID);
  if (token.revoked) throw graphError(ERRORS.TOKEN_REVOKED);
  if (ctx.clock.now() >= token.expiresAt) throw graphError(ERRORS.TOKEN_EXPIRED);
  return token;
}

/** The account behind the request's token. Records it on req, so the response carries that account's usage header. */
export function authenticate(ctx, req, scopes = []) {
  const value = requestToken(req);
  if (!value) throw graphError(ERRORS.TOKEN_MISSING);
  const token = liveToken(ctx, value);
  const account = ctx.s.accounts.get(token.igUserId);
  // A Facebook user token, or a Page with no Instagram account, reaches nothing here.
  if (!account) throw graphError(ERRORS.OBJECT_NOT_FOUND);
  req.account = account;
  if (ctx.s.app.accessLevel === 'standard' && !account.appRole) throw graphError(ERRORS.PERMISSION, '(#200) This account has no role on the app, and the app has only Standard Access.');
  requireScopes(token, scopes);
  return { token, account };
}

/** Counts a call against a rolling budget; throws 613 once the budget for this window is used. */
export function throttle(ctx, times, windowMs, limit) {
  const now = ctx.clock.now();
  while (times.length && times[0] <= now - windowMs) times.shift();
  if (times.length >= limit) throw graphError(ERRORS.RATE_LIMITED);
  times.push(now);
}

function bucState(ctx, account) {
  const now = ctx.clock.now();
  const windowMs = ctx.s.limits.bucWindowMs;
  while (account.bucTimes.length && account.bucTimes[0] <= now - windowMs) account.bucTimes.shift();
  const limit = ctx.s.limits.bucPerImpression * account.impressions;
  if (account.usage) return { percent: account.usage.percent, regainMinutes: account.usage.percent >= 100 ? account.usage.regainMinutes ?? 60 : 0 };
  const percent = Math.floor((account.bucTimes.length * 100) / limit);
  const regainMinutes = percent >= 100 ? Math.ceil((account.bucTimes[0] + windowMs - now) / MINUTE) : 0;
  return { percent, regainMinutes };
}

/** Business Use Case bucket (PRD 4.3 rows 17 and 18): messaging is excluded, everything else shares it. */
export function chargeBuc(ctx, account) {
  if (bucState(ctx, account).percent >= 100) throw graphError(ERRORS.BUC_THROTTLED);
  account.bucTimes.push(ctx.clock.now());
}

function usageHeader(account, { percent, regainMinutes }) {
  return JSON.stringify({ [account.igUserId]: [{ type: 'instagram', call_count: percent, total_cputime: percent, total_time: percent, estimated_time_to_regain_access: regainMinutes }] });
}

/** Headers on every Graph response. An injected 80002 can name its own regain time. */
export function graphHeaders(ctx, req, fault) {
  const headers = { 'x-fb-trace-id': crypto.randomBytes(8).toString('base64url'), 'facebook-api-version': 'v23.0' };
  // An injected fault never reached a handler, so the account comes from the token as sent.
  const account = req.account ?? ctx.s.accounts.get(ctx.s.tokens.get(requestToken(req))?.igUserId);
  if (!account) return headers;
  const forced = fault?.regainMinutes !== undefined ? { percent: 100, regainMinutes: fault.regainMinutes } : bucState(ctx, account);
  return { ...headers, 'x-business-use-case-usage': usageHeader(account, forced) };
}
