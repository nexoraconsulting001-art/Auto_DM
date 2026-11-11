import crypto from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { ANALYTICS_LIMITS, VISITOR_COOKIE } from '../../contracts/analytics.js';
import { POLICY_KINDS } from '../../contracts/api/store.js';
import { ConsentSave } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { visitorIdFrom } from '../../platform/visitor.js';
import { tenantId, withTenant } from '../../tenancy.js';
import { loadBuyerLayout, sendBuyerPage } from '../../views/buyer/index.js';
import { readToken, signToken } from '../shoppers/keys.js';
import { clearSessionCookie } from '../shoppers/session.js';
import { isBuyerPage } from '../traffic/page-kinds.js';
import { bannerHtml, policyPage, unsubscribePage } from './views.js';

/**
 * The consent module's buyer routes (PRD 9.18): the policy pages, the shopper's consent choices, the one-tap unsubscribe
 * page, data requests from the account, and the cookie banner on every buyer page of a business that has a tag on.
 */
const SOURCES = new Set(['sign_in', 'account', 'banner', 'checkout']);
const DataRequestBody = z.strictObject({ kind: z.enum(['access', 'erasure']), confirm: z.boolean().optional() });
const UNSUBSCRIBE_DAYS = 400;

const fail = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * The unsubscribe link for a message (9.18: withdrawing is as easy as giving consent). Direct, on the business's own
 * address, and good for 400 days. Call inside the business. `origin` is the business's buyer address.
 */
export function unsubscribeUrl(config, store, { origin, shopperId, phone, email, channel, purpose = 'marketing' }) {
  const keys = store.keysOf({ shopperId, phone: channel === 'whatsapp' ? phone : undefined, email: channel === 'email' ? email : undefined });
  const token = signToken(config, 'unsubscribe', { t: tenantId(), s: keys.shopperId, p: keys.phoneHash, e: keys.emailHash, u: purpose, c: channel }, UNSUBSCRIBE_DAYS * 86_400_000);
  return `${String(origin).replace(/\/+$/, '')}/unsubscribe/${token}`;
}

function readUnsubscribe(config, token) {
  const t = readToken(config, 'unsubscribe', token);
  if (!t || t.t !== tenantId() || !['marketing', 'order_updates'].includes(t.u) || !['whatsapp', 'email'].includes(t.c)) return null;
  if (!t.s && !t.p && !t.e) return null;
  return t;
}

function insertBefore(page, closing, addition) {
  const at = page.toLowerCase().lastIndexOf(closing);
  return at === -1 ? page + addition : page.slice(0, at) + addition + page.slice(at);
}

/** The visitor id this browser carries, minting one (the traffic cookie) when it has none, so a cookie choice has a browser to belong to. */
function visitorOf(req, res) {
  const id = visitorIdFrom(req);
  if (id) return id;
  const minted = crypto.randomUUID();
  res.cookie(VISITOR_COOKIE, minted, { path: '/', maxAge: ANALYTICS_LIMITS.visitorCookieDays * 86_400_000, httpOnly: true, sameSite: 'lax', secure: req.secure });
  return minted;
}

/** The cookie banner, added to every buyer page while a business has a tag on and this browser hasn't answered (7.14). */
export function bannerMiddleware(ctx) {
  const { repos, platform } = ctx;
  return async (req, res, next) => {
    if (req.method !== 'GET' || !isBuyerPage(req.path) || !repos.tagSettings) return next();
    let banner = null;
    try {
      const tenant = await ctx.tenantResolver.resolve(req.hostname);
      if (tenant) {
        banner = await withTenant(tenant, async () => {
          const row = await repos.tagSettings.get();
          if (!row?.meta_enabled && !row?.ga4_enabled) return null;
          if (!(await repos.entitlements.can('tags.pixels'))) return null;
          const visitorId = visitorIdFrom(req);
          if (visitorId && (await platform.consent.analyticsAndAds({ visitorId })).answered) return null;
          const [notice, settings] = await Promise.all([platform.consent.notice(), repos.settings.getAll()]);
          return { store: settings.store_name || tenant.name || '', noticeVersion: notice?.version ?? 1 };
        });
      }
    } catch (err) {
      // A banner must never take a page down; with no answer, no tag loads either.
      reportError(err, { msg: 'consent.banner_failed' });
      banner = null;
    }
    if (!banner) return next();
    const send = res.send.bind(res);
    res.send = (body) => {
      res.send = send;
      if (typeof body !== 'string' || res.statusCode !== 200 || !/text\/html/i.test(res.get('content-type') ?? '')) return send(body);
      return send(insertBefore(body, '</body>', bannerHtml({ ...banner, shopperCsrf: req.shopperCsrf ?? '', sellerCsrf: req.csrf ?? '' })));
    };
    return next();
  };
}

export function consentRoutes(ctx, { store, requests, privacy }) {
  const { repos, config, platform } = ctx;
  const r = express.Router();
  const layoutPage = async (res, build, status = 200) => {
    const layout = await loadBuyerLayout(repos);
    return sendBuyerPage(res, build(layout), { status });
  };

  // ---- the policy pages (S-61, S-62) ----
  r.get('/policies/:kind', route(async (req, res, next) => {
    if (!POLICY_KINDS.includes(req.params.kind)) return next();
    const kind = req.params.kind;
    const [body, grievance] = await Promise.all([privacy.policyBody(kind), privacy.grievance()]);
    let cookie = null;
    if (kind === 'privacy') {
      const visitorId = visitorIdFrom(req);
      const answer = visitorId ? await platform.consent.analyticsAndAds({ visitorId }) : { answered: false, granted: false };
      cookie = { answered: answer.answered, granted: answer.granted, noticeVersion: (await platform.consent.notice())?.version ?? 1 };
    }
    return layoutPage(res, (layout) => policyPage(layout, { kind, body, grievance, cookie, shopperCsrf: req.shopperCsrf ?? '', sellerCsrf: req.csrf ?? '' }));
  }));

  // ---- the shopper's choices ----
  r.get('/api/store/consent', route(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const notice = await store.ensureNotice();
    const choices = await store.choicesFor({ shopperId: req.shopper?.id ?? null, visitorId: visitorIdFrom(req) });
    return res.json({ notice: { version: notice.version, bodyEn: notice.bodyEn, bodyHi: notice.bodyHi }, choices });
  }));

  r.post('/api/store/consent', route(async (req, res) => {
    const parsed = ConsentSave.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Please check your choices.');
    // The contract's schema fills in "no" for anything not sent, so what was really chosen is read from the body itself:
    // a banner that answers cookies alone must not withdraw a shopper's messages.
    const sent = req.body.choices;
    const said = (group, channel) => typeof sent?.[group]?.[channel] === 'boolean';
    const choices = [];
    for (const [group, purpose] of [['orderUpdates', 'order_updates'], ['marketing', 'marketing']]) {
      for (const channel of ['whatsapp', 'email']) if (said(group, channel)) choices.push({ purpose, channel, granted: parsed.data.choices[group][channel] });
    }
    if (choices.length && !req.shopper) return fail(res, 401, 'unauthorized', 'Please sign in to change your messages.');
    const cookie = typeof sent?.analyticsAds === 'boolean';
    if (!choices.length && !cookie) return fail(res, 400, 'validation_failed', 'Nothing to save.');
    const asked = typeof req.query.source === 'string' && SOURCES.has(req.query.source) ? req.query.source : null;
    const notice = await store.ensureNotice();
    if (parsed.data.choices.noticeVersion > notice.version) return fail(res, 409, 'conflict', 'This page is out of date. Refresh it and try again.');
    if (choices.length) {
      await platform.consent.record({ subject: { shopperId: req.shopper.id }, choices, noticeVersion: parsed.data.choices.noticeVersion, source: asked && asked !== 'banner' ? asked : 'account' });
    }
    if (cookie) {
      const visitorId = visitorOf(req, res);
      await platform.consent.record({
        subject: { visitorId, ...(req.shopper ? { shopperId: req.shopper.id } : {}) },
        choices: [{ purpose: 'analytics_ads', granted: sent.analyticsAds }], noticeVersion: parsed.data.choices.noticeVersion, source: asked ?? 'banner',
      });
    }
    log.info('consent.recorded', { shopperId: req.shopper?.id ?? null, choices: choices.length + (cookie ? 1 : 0) });
    return res.json({ choices: await store.choicesFor({ shopperId: req.shopper?.id ?? null, visitorId: visitorIdFrom(req) ?? undefined }) });
  }));

  // ---- one tap from a message (S-64) ----
  r.get('/unsubscribe/:token', route(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const t = readUnsubscribe(config, req.params.token);
    return layoutPage(res, (layout) => unsubscribePage(layout, t
      ? { state: 'ask', purpose: t.u, channel: t.c, token: req.params.token, shopperCsrf: req.shopperCsrf ?? '', sellerCsrf: req.csrf ?? '' }
      : { state: 'bad' }), t ? 200 : 404);
  }));

  // The page's button, and a mail app's own one-click unsubscribe (RFC 8058), which posts to the link itself.
  r.post('/unsubscribe/:token', route(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const t = readUnsubscribe(config, req.params.token);
    if (!t) return layoutPage(res, (layout) => unsubscribePage(layout, { state: 'bad' }), 404);
    // Straight to the ledger: the link holds keyed hashes, which platform.consent's subject has no field for.
    await store.provider.revoke({ subject: { shopperId: t.s ?? undefined, phoneHash: t.p ?? undefined, emailHash: t.e ?? undefined }, purpose: t.u, channel: t.c, source: 'unsubscribe' });
    log.info('consent.unsubscribed', { purpose: t.u, channel: t.c });
    return layoutPage(res, (layout) => unsubscribePage(layout, { state: 'done', purpose: t.u, channel: t.c }));
  }));

  // ---- the shopper's own data (9.18, S-63) ----
  r.post('/api/store/data-requests', route(async (req, res) => {
    if (!req.shopper) return fail(res, 401, 'unauthorized', 'Please sign in again.');
    const parsed = DataRequestBody.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'validation_failed', 'Choose what you would like to do.');
    if (parsed.data.kind === 'erasure' && parsed.data.confirm !== true) return fail(res, 400, 'validation_failed', 'Please confirm that you want your data deleted.');
    res.set('Cache-Control', 'no-store');
    const made = await requests.create({ shopperId: req.shopper.id, kind: parsed.data.kind, source: 'account', actor: `shopper:${req.shopper.id}` });
    if (!made) return fail(res, 404, 'not_found', 'We couldn’t find your account.');
    if (parsed.data.kind === 'access') return res.status(201).json({ request: made.request, data: made.data });
    const done = made.request.status === 'completed';
    if (done) clearSessionCookie(res);
    return res.status(201).json({
      request: made.request,
      signedOut: done,
      message: done ? 'Your account and personal details were deleted. Tax records of your orders are kept with your details removed.'
        : 'We’ll delete your details as soon as your open orders are complete. Until then, they are only used for those orders.',
    });
  }));

  return r;
}

