import express from 'express';
import { z } from 'zod';
import { safeNext } from '../../auth.js';
import { OtpSend, OtpVerify } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { tenantId } from '../../tenancy.js';
import { ValidationError } from '../../util.js';
import { loadBuyerLayout } from '../../views/buyer/index.js';
import { platformHostOf } from '../platform-console/host.js';
import { csrfFor, field, newToken, originOf, readCookie, readToken, safeEqual, signToken } from './keys.js';
import { OtpError } from './service.js';
import { clearSessionCookie, sameSiteOnly, sessionCookie } from './session.js';
import { accountPage, messagePage, orderDetailPage, ordersPage, sharedConfirmPage, sharedConsentPage, signInPage } from './views.js';

/**
 * The shopper's buyer routes (src/contracts/store-routes.js, owner 'shoppers'): sign-in with a WhatsApp code or Google,
 * signing in with details saved at another store, signing out, the account and its orders, saved addresses, and the
 * shared-profile consent screen. A shopper never becomes req.user: see session.js.
 *
 * Errors from the JSON calls are { error, code, fields? } with the codes of src/contracts/api/errors.js.
 */
const GOOGLE_COOKIE = '_gst';
const SHARED_COOKIE = '_shn';
const TICKET_COOKIE = '_sht';
const SIGN_IN_PROBLEMS = Object.freeze({
  shared_none: 'No saved details were found on this device. Sign in with a WhatsApp code instead.',
  expired: 'That sign-in link expired. Please start again.',
  google_cancelled: 'Google sign-in was cancelled. You can sign in with a WhatsApp code instead.',
  google_failed: 'Google sign-in didn’t work just now. You can sign in with a WhatsApp code instead.',
});
const IN_APP = /\b(Instagram|FBAN|FBAV|FB_IAB|FBIOS)\b/i;
const ID = /^[1-9][0-9]{0,9}$/;
const FALLBACK_NOTICE = (store) => ({
  version: 1,
  bodyEn: `${store} uses your name, phone number and address to take, deliver and support your order.`,
  bodyHi: `${store} आपके नाम, फ़ोन नंबर और पते का उपयोग आपका ऑर्डर लेने, पहुँचाने और उससे जुड़ी मदद के लिए करता है।`,
});

const SharedConsentBody = z.strictObject({ noticeVersion: z.number().int().min(1), agree: z.literal(true, 'Tick the box to agree first.'), next: z.string().max(500).optional() });

const fail = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const fieldsOf = (issues) => Object.fromEntries(issues.map((i) => [String(i.path[0] ?? 'body'), i.message]));
const badBody = (res, parsed) => fail(res, 400, 'validation_failed', parsed.error.issues[0]?.message ?? 'Please check the details and try again.', { fields: fieldsOf(parsed.error.issues) });

/** An async route whose failures reach the error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function shopperRoutes(ctx, { service, shared, google }) {
  const { repos, config, platform, auth } = ctx;
  const r = express.Router();
  const platformHost = platformHostOf(config);
  const platformOrigin = (req) => (platformHost ? `${req.protocol}://${platformHost}` : '');
  /**
   * Saved details across stores need the store's own address: a custom domain or its own name under the platform domain.
   * An address that only falls back to the default business is never trusted with a ticket, so a forged Host header
   * cannot have the platform hand one to a page that isn't the store's (9.22).
   */
  async function sharedOn(req) {
    if (!shared.available || !platformHost) return false;
    const owner = await ctx.tenantResolver?.owner(req.hostname);
    return owner?.id === tenantId();
  }
  const home = (user) => (['owner', 'manager'].includes(user.role) || (user.role === 'staff' && user.permissions?.length) ? '/admin' : '/account');

  async function notice() {
    try {
      const n = await platform.consent.notice();
      if (n) return n;
    } catch (err) {
      reportError(err, { msg: 'shopper.notice_failed' });
    }
    const { business } = await loadBuyerLayout(repos);
    return FALLBACK_NOTICE(business.name || 'This store');
  }

  /** S-59: a sign-in writes a consent record with the notice version that was on the sign-in page, for fulfilment. */
  async function recordSignInConsent(shopperId) {
    if (!platform.consent.built) return;
    const current = await platform.consent.notice();
    await platform.consent.record({ subject: { shopperId }, choices: [{ purpose: 'fulfilment', granted: true }], noticeVersion: current.version, source: 'sign_in' });
  }

  /**
   * Starts the shopper's session on this browser and returns where to go next. A session already on this browser ends
   * first. When the shopper has a shared profile, the way back goes once through the platform's own host, so this browser
   * is remembered there for the next store (9.22).
   */
  async function completeSignIn(req, res, shopper, method, { next, phone = null, googleSub = null } = {}) {
    if (req.shopperToken) await service.sessions.revoke(req.shopperToken);
    const token = await service.sessions.create(shopper.id, method);
    sessionCookie(req, res, token);
    await recordSignInConsent(shopper.id);
    log.info('shopper.signed_in', { shopperId: shopper.id, method });
    const to = safeNext(next, '/');
    if (!(await sharedOn(req))) return { to, token };
    await shared.linkAfterSignIn({ tenantId: tenantId(), shopperId: shopper.id, phone, googleSub });
    const ticket = await shared.rememberTicket(tenantId(), shopper.id, `${originOf(req)}${to}`);
    return { to: ticket ? `${platformOrigin(req)}/shared/remember?t=${encodeURIComponent(ticket)}` : to, token };
  }

  async function page(res, build, status = 200) {
    const layout = await loadBuyerLayout(repos);
    // A shopper's own pages are never kept by any cache, the browser's included (sendBuyerPage allows the browser's).
    return res.status(status).set('Cache-Control', 'no-store').type('html').send(String(build(layout)));
  }
  const signInFirst = (req, res) => res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);

  // ---- sign-in ----
  r.get('/login', route(async (req, res) => {
    if (req.shopper) return res.redirect(safeNext(req.query.next, '/account'));
    if (req.user) return res.redirect(safeNext(req.query.next, home(req.user)));
    const next = safeNext(req.query.next, '/');
    const n = await notice();
    const problem = req.query.shared === 'none' ? 'shared_none' : String(req.query.problem ?? '');
    const error = Object.hasOwn(SIGN_IN_PROBLEMS, problem) ? SIGN_IN_PROBLEMS[problem] : '';
    const offerShared = await sharedOn(req);
    return page(res, (layout) => signInPage(layout, { next, notice: n, googleOn: google.configured, inApp: IN_APP.test(req.get('user-agent') ?? ''), sharedOn: offerShared, error, sellerCsrf: req.csrf ?? '' }));
  }));

  r.post('/api/store/otp/send', sameSiteOnly, route(async (req, res) => {
    const parsed = OtpSend.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed);
    try {
      return res.json(await service.otps.send({ ...parsed.data, ip: String(req.ip ?? '') }));
    } catch (err) {
      if (!(err instanceof OtpError)) throw err;
      if (err.retryAfterMs) res.set('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
      return fail(res, err.status, err.status === 503 ? 'internal' : err.code, err.message);
    }
  }));

  r.post('/api/store/otp/verify', sameSiteOnly, route(async (req, res) => {
    const parsed = OtpVerify.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed);
    let proof;
    try {
      proof = await service.otps.verify(parsed.data);
    } catch (err) {
      if (!(err instanceof OtpError)) throw err;
      return fail(res, err.status, err.code, err.message);
    }
    // A cash-on-delivery code only proves the number for that checkout attempt (9.5); checkout asks otps.codVerified().
    if (parsed.data.purpose === 'cod') return res.json({ verified: true });
    const shopper = await service.shoppers.forVerifiedPhone(proof.phone);
    const { to, token } = await completeSignIn(req, res, shopper, 'whatsapp_otp', { next: req.query.next, phone: proof.phone });
    return res.json({ signedIn: true, next: to, csrf: csrfFor(config, token) });
  }));

  // ---- Google (S-92: no code is asked for) ----
  r.get('/auth/google', route(async (req, res) => {
    const next = safeNext(req.query.next, '/');
    if (!google.configured) return res.redirect(`/login?next=${encodeURIComponent(next)}`);
    const nonce = newToken(16);
    const state = signToken(config, 'google-state', { t: tenantId(), n: nonce, x: next }, 10 * 60_000);
    res.cookie(GOOGLE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/auth/google', maxAge: 10 * 60_000 });
    return res.redirect(google.authorizeUrl({ redirectUri: `${originOf(req)}/auth/google/callback`, state, nonce }));
  }));

  r.get('/auth/google/callback', route(async (req, res) => {
    const state = readToken(config, 'google-state', typeof req.query.state === 'string' ? req.query.state : '');
    const nonce = readCookie(req, GOOGLE_COOKIE);
    res.clearCookie(GOOGLE_COOKIE, { path: '/auth/google' });
    // A problem goes back to the sign-in page, so no page is ever drawn at an address that holds Google's code.
    const back = (problem) => res.redirect(303, `/login?next=${encodeURIComponent(safeNext(state?.x, '/'))}&problem=${problem}`);
    if (!state || state.t !== tenantId() || !nonce || !safeEqual(nonce, state.n)) return back('expired');
    if (req.query.error || typeof req.query.code !== 'string') return back('google_cancelled');
    let who;
    try {
      who = await google.signIn({ code: req.query.code, redirectUri: `${originOf(req)}/auth/google/callback`, nonce: state.n });
    } catch (err) {
      log.warn('shopper.google_failed', { kind: err?.kind ?? 'error' });
      return back('google_failed');
    }
    const shopper = await service.shoppers.forGoogle(who);
    const { to } = await completeSignIn(req, res, shopper, 'google', { next: state.x, googleSub: who.sub });
    return res.redirect(303, to);
  }));

  // ---- details saved at another store (9.22, S-98) ----
  r.get('/auth/shared', route(async (req, res) => {
    const next = safeNext(req.query.next, '/');
    if (!(await sharedOn(req))) return res.redirect(`/login?next=${encodeURIComponent(next)}`);
    const nonce = newToken(16);
    res.cookie(SHARED_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/auth/shared', maxAge: 5 * 60_000 });
    const q = shared.signRequest(tenantId(), originOf(req), nonce, next);
    return res.redirect(`${platformOrigin(req)}/shared/recognise?q=${encodeURIComponent(q)}`);
  }));

  /** The ticket the platform handed back, for this store and this browser only. Null when it isn't. */
  function ticketFor(req, value) {
    const ticket = shared.readTicket(value);
    const nonce = readCookie(req, SHARED_COOKIE);
    return ticket && ticket.t === tenantId() && nonce && safeEqual(nonce, String(ticket.n)) ? ticket : null;
  }

  // The platform's answer arrives in the address; it is moved into a cookie at once, so the page that asks "Continue?"
  // has a clean address that no tag, history entry or referrer can carry the ticket from.
  r.get('/auth/shared/callback', route(async (req, res) => {
    const next = safeNext(req.query.next, '/');
    const value = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (req.query.none || !ticketFor(req, value)) return res.redirect(303, `/login?next=${encodeURIComponent(next)}&shared=none`);
    res.cookie(TICKET_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/auth/shared', maxAge: 2 * 60_000 });
    return res.redirect(303, `/auth/shared/continue?next=${encodeURIComponent(next)}`);
  }));

  r.get('/auth/shared/continue', route(async (req, res) => {
    const next = safeNext(req.query.next, '/');
    const ticket = ticketFor(req, readCookie(req, TICKET_COOKIE));
    const phone = ticket ? await shared.verifiedPhone(ticket.p) : null;
    if (!phone) return res.redirect(303, `/login?next=${encodeURIComponent(next)}&shared=none`);
    const n = await notice();
    // Nothing reaches this business until the shopper says Continue.
    return page(res, (layout) => sharedConfirmPage(layout, { phone, next, notice: n, shopperCsrf: req.shopperCsrf, sellerCsrf: req.csrf ?? '' }));
  }));

  r.post('/auth/shared/confirm', route(async (req, res) => {
    const next = safeNext(field(req.body, 'next', 500), '/');
    const ticket = ticketFor(req, readCookie(req, TICKET_COOKIE));
    const phone = ticket && (await shared.firstUse(ticket.j)) ? await shared.verifiedPhone(ticket.p) : null;
    res.clearCookie(SHARED_COOKIE, { path: '/auth/shared' });
    res.clearCookie(TICKET_COOKIE, { path: '/auth/shared' });
    if (!phone) return page(res, (layout) => messagePage(layout, { title: 'Please sign in', message: 'That link expired. Sign in with a WhatsApp code.', action: { href: `/login?next=${encodeURIComponent(next)}`, label: 'Sign in' } }), 400);
    const shopper = await service.shoppers.forVerifiedPhone(phone);
    const { to } = await completeSignIn(req, res, shopper, 'shared', { next, phone });
    return res.redirect(303, to);
  }));

  r.post('/logout', route(async (req, res) => {
    if (req.shopperToken) await service.sessions.revoke(req.shopperToken);
    clearSessionCookie(res);
    if (req.user) await auth.logout(req, res);
    return res.redirect(303, '/');
  }));

  // ---- the account (9.17) ----
  async function choicesFor(shopperId) {
    const n = await notice();
    const empty = { whatsapp: null, email: null };
    if (!platform.consent.built) return { noticeVersion: n.version, orderUpdates: empty, marketing: empty };
    const rows = await platform.consent.status({ shopperId });
    const now = (purpose, channel) => rows.find((x) => x.purpose === purpose && x.channel === channel)?.granted ?? null;
    return {
      noticeVersion: n.version,
      orderUpdates: { whatsapp: now('order_updates', 'whatsapp'), email: now('order_updates', 'email') },
      marketing: { whatsapp: now('marketing', 'whatsapp'), email: now('marketing', 'email') },
    };
  }

  async function addressesFor(shopperId) {
    const own = await service.addresses.list(shopperId);
    if (!shared.available) return own;
    const seen = new Set(own.map((a) => `${a.line1}|${a.pincode}|${a.name}`.toLowerCase()));
    const theirs = (await shared.addresses(tenantId(), shopperId)).filter((a) => !seen.has(`${a.line1}|${a.pincode}|${a.name}`.toLowerCase()));
    return [...own, ...theirs];
  }

  r.get('/account', route(async (req, res, next) => {
    if (!req.shopper) return req.user ? next() : signInFirst(req, res);
    const shopper = req.shopper;
    const [orders, addresses, choices, sharedStatus] = await Promise.all([
      service.orders.list(shopper.id, { limit: 5 }),
      addressesFor(shopper.id),
      choicesFor(shopper.id),
      shared.available ? shared.status(tenantId(), shopper.id) : { on: false },
    ]);
    return page(res, (layout) => accountPage(layout, {
      shopper, orders, addresses, choices, shared: { available: shared.available, ...sharedStatus }, shopperCsrf: req.shopperCsrf, sellerCsrf: req.csrf ?? '',
      flash: req.query.signedin ? 'You’re signed in.' : '',
    }));
  }));

  r.get('/account/orders', route(async (req, res) => {
    if (!req.shopper) return signInFirst(req, res);
    const orders = await service.orders.list(req.shopper.id, { limit: 200 });
    return page(res, (layout) => ordersPage(layout, { orders }));
  }));

  r.get('/account/orders/:orderNumber', route(async (req, res) => {
    if (!req.shopper) return signInFirst(req, res);
    const order = await service.orders.get(req.shopper.id, req.params.orderNumber);
    if (!order) return page(res, (layout) => messagePage(layout, { title: 'Not found', message: 'We couldn’t find that order in your account.', action: { href: '/account/orders', label: 'Your orders' } }), 404);
    return page(res, (layout) => orderDetailPage(layout, { order, shopperCsrf: req.shopperCsrf, sellerCsrf: req.csrf ?? '' }));
  }));

  // ---- saved addresses (9.4) ----
  const needShopper = (req, res, next) => (req.shopper ? next() : fail(res, 401, 'unauthorized', 'Please sign in again.'));
  const addressError = (res, err) => {
    if (err instanceof ValidationError) return fail(res, 400, 'validation_failed', err.message, err.fields ? { fields: err.fields } : {});
    throw err;
  };

  r.get('/api/store/addresses', needShopper, route(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ items: await addressesFor(req.shopper.id) });
  }));

  r.post('/api/store/addresses', needShopper, route(async (req, res) => {
    try {
      const address = await service.addresses.create(req.shopper.id, req.body);
      if (shared.available) await shared.addAddress(tenantId(), req.shopper.id, address);
      return res.status(201).json({ address });
    } catch (err) {
      return addressError(res, err);
    }
  }));

  r.put('/api/store/addresses/:id', needShopper, route(async (req, res) => {
    if (!ID.test(req.params.id)) return fail(res, 404, 'not_found', 'We couldn’t find that address.');
    try {
      const address = await service.addresses.update(req.shopper.id, Number(req.params.id), req.body);
      return address ? res.json({ address }) : fail(res, 404, 'not_found', 'We couldn’t find that address.');
    } catch (err) {
      return addressError(res, err);
    }
  }));

  r.delete('/api/store/addresses/:id', needShopper, route(async (req, res) => {
    if (!ID.test(req.params.id)) return fail(res, 404, 'not_found', 'We couldn’t find that address.');
    return (await service.addresses.remove(req.shopper.id, Number(req.params.id))) ? res.sendStatus(204) : fail(res, 404, 'not_found', 'We couldn’t find that address.');
  }));

  // ---- the shared-profile consent screen (9.22, S-97) ----
  r.get('/account/shared-profile', route(async (req, res) => {
    if (!req.shopper) return signInFirst(req, res);
    if (!shared.available) return page(res, (layout) => messagePage(layout, { title: 'Not available', message: 'Saving details for other stores isn’t available here yet.', action: { href: '/account', label: 'Back to your account' } }));
    const [n, status, identity] = await Promise.all([shared.notice(), shared.status(tenantId(), req.shopper.id), service.shoppers.identity(req.shopper.id)]);
    res.set('Referrer-Policy', 'no-referrer');
    return page(res, (layout) => sharedConsentPage(layout, {
      notice: n, status, shopperCsrf: req.shopperCsrf, sellerCsrf: req.csrf ?? '', next: safeNext(req.query.next, '/account'), canConsent: Boolean(identity?.phone || identity?.googleSub),
    }));
  }));

  r.post('/api/store/shared-profile', needShopper, route(async (req, res) => {
    if (!shared.available) return fail(res, 409, 'conflict', 'Saving details for other stores isn’t available here yet.');
    const parsed = SharedConsentBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed);
    const identity = await service.shoppers.identity(req.shopper.id);
    if (!identity?.phone && !identity?.googleSub) return fail(res, 409, 'conflict', 'Sign in with a WhatsApp code or Google first.');
    try {
      await shared.consent({
        tenantId: tenantId(), shopper: { id: req.shopper.id, phone: identity.phone }, googleSub: identity.googleSub,
        addresses: await service.addresses.list(req.shopper.id), noticeVersion: parsed.data.noticeVersion,
      });
    } catch (err) {
      if (err?.code === 'notice_changed') return fail(res, 409, 'conflict', err.message);
      throw err;
    }
    const to = safeNext(parsed.data.next, '/account');
    const ticket = platformHost ? await shared.rememberTicket(tenantId(), req.shopper.id, `${originOf(req)}${to}`) : null;
    return res.status(201).json({ on: true, redirect: ticket ? `${platformOrigin(req)}/shared/remember?t=${encodeURIComponent(ticket)}` : to });
  }));

  r.delete('/api/store/shared-profile', needShopper, route(async (req, res) => {
    if (!shared.available) return fail(res, 409, 'conflict', 'Saving details for other stores isn’t available here yet.');
    const { removed } = await shared.withdraw(tenantId(), req.shopper.id);
    return res.json({ on: false, removed });
  }));

  return r;
}

/**
 * The platform's own host (9.22): it remembers, in a cookie of its own, a browser that signed in at a store whose shopper
 * has a shared profile, and tells the next store only "this browser has one" with a one-use ticket for that store alone.
 * It never says which store the person came from. Mounted through platformRoutes, on the platform host only.
 */
export function sharedPlatformRoutes(router, ctx, shared) {
  const REMEMBER = '_shp';
  const backTo = async (origin, tenantId) => {
    try {
      const url = new URL(origin);
      if (!/^https?:$/.test(url.protocol)) return null;
      const tenant = await ctx.tenantResolver.owner(url.hostname);
      return tenant?.id === tenantId ? url : null;
    } catch {
      return null;
    }
  };

  router.get('/shared/remember', route(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const ticket = shared.readRememberTicket(typeof req.query.t === 'string' ? req.query.t : '');
    const back = ticket ? await backTo(ticket.r, ticket.t) : null;
    if (!ticket || !back || !(await shared.firstUse(ticket.j)) || !(await shared.profileExists(ticket.p))) return res.status(400).type('text').send('This link has expired.');
    res.cookie(REMEMBER, shared.rememberCookie(ticket.p), { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/shared', maxAge: shared.rememberMaxAgeMs });
    return res.redirect(303, back.href);
  }));

  router.get('/shared/recognise', route(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const request = shared.readRequest(typeof req.query.q === 'string' ? req.query.q : '');
    const origin = request ? await backTo(request.h, request.t) : null;
    if (!request || !origin) return res.status(400).type('text').send('This link has expired.');
    const next = encodeURIComponent(safeNext(request.x, '/'));
    const profileId = await shared.profileFromCookie(readCookie(req, REMEMBER));
    const phone = profileId ? await shared.verifiedPhone(profileId) : null;
    if (!phone) return res.redirect(303, `${origin.origin}/auth/shared/callback?none=1&next=${next}`);
    const ticket = shared.signTicket(profileId, request.t, request.n);
    return res.redirect(303, `${origin.origin}/auth/shared/callback?ticket=${encodeURIComponent(ticket)}&next=${next}`);
  }));
}

