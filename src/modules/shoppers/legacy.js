import express from 'express';
import { safeNext, sameOriginOnly as sameSite } from '../../auth.js';
import { buyerSettings } from '../brand/index.js';
import { ValidationError, normalizePhone } from '../../util.js';
import { accountPage, loginPage, signupPage } from '../../views/store.js';
import { field } from './keys.js';

/**
 * What is left of the Phase 0 password accounts (src/routes/account.js), which live in `users`, not `shoppers`.
 *
 * POST /login is how the owner and staff sign in on the store's own address (test/helpers.js login() uses it), and how an
 * account made with a password before Phase 4 still signs in. GET /login is now the shopper sign-in page (routes.js), which
 * keeps this password form at its foot. /signup, the password account page and its password change stay for those Phase 0
 * accounts only: nothing on the new pages links to /signup, and no shopper made in Phase 4 has a password (PRD 9.3, 5.16).
 *
 * Every field is read as a string or not at all, so an object, an array, a NUL byte or a missing body is a 400 or 401,
 * never a server fault (p0-injection-r1-9, p0-authz-r1-8, p0-injection-r1-14), and two sign-ups at once with one number
 * get the existing-account message (p0-migrations-r1-13).
 */
const NUL = /\0/;

export function legacyAccountRoutes({ repos, auth, config }) {
  // The .env owner's password comes from ADMIN_PASSWORD and is reset on every start.
  const isEnvOwner = (user) => user.role === 'owner' && Boolean(config?.adminPhone) && user.phone === normalizePhone(config.adminPhone);
  const r = express.Router();
  const page = (res, view, status = 200) => res.status(status).type('html').send(String(view));
  // Staff with no permissions yet have nothing to open in the console.
  const home = (user) => (['owner', 'manager'].includes(user.role) || (user.role === 'staff' && user.permissions?.length) ? '/admin' : '/account');
  const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.post('/login', sameSite, route(async (req, res) => {
    const settings = await buyerSettings(repos);
    const next = safeNext(field(req.body, 'next', 500), '');
    const phone = field(req.body, 'phone', 20);
    const password = field(req.body, 'password', 200);
    if (await auth.tooManyAttempts(req)) {
      return page(res, loginPage({ settings, next: next || '/', phone, error: 'Too many tries. Wait 15 minutes and try again.' }), 429);
    }
    const user = phone && password && !NUL.test(phone + password) ? await repos.users.verify(phone, password) : null;
    if (!user) {
      await auth.recordFailure(req);
      return page(res, loginPage({ settings, next: next || '/', phone: NUL.test(phone) ? '' : phone, error: 'That mobile number and password don’t match.' }), 401);
    }
    await auth.login(req, res, user);
    return res.redirect(303, next && next !== '/' ? next : home(user));
  }));

  r.get('/signup', route(async (req, res) => {
    if (req.user) return res.redirect(home(req.user));
    return page(res, signupPage({ settings: await buyerSettings(repos), next: safeNext(req.query.next, '/') }));
  }));

  r.post('/signup', sameSite, route(async (req, res) => {
    const settings = await buyerSettings(repos);
    const next = safeNext(field(req.body, 'next', 500), '/');
    const values = { name: field(req.body, 'name', 80), phone: field(req.body, 'phone', 20) };
    const password = field(req.body, 'password', 200);
    if (await auth.tooManyAttempts(req)) {
      return page(res, signupPage({ settings, next, values, error: 'Too many tries. Wait 15 minutes and try again.' }), 429);
    }
    if (NUL.test(values.name + values.phone + password)) {
      return page(res, signupPage({ settings, next, values: { name: '', phone: '' }, error: 'Please use letters and numbers only.' }), 400);
    }
    try {
      const user = await repos.users.create({ ...values, password });
      await auth.login(req, res, user);
      return res.redirect(303, next !== '/' ? next : '/account');
    } catch (err) {
      // Two sign-ups with one number at the same moment: the second hits the unique index rather than the check before it.
      const duplicate = err?.code === '23505' ? new ValidationError('An account with this mobile number already exists. Log in instead.') : null;
      if (!(err instanceof ValidationError) && !duplicate) throw err;
      await auth.recordFailure(req);
      return page(res, signupPage({ settings, next, values, error: (duplicate ?? err).message }), 400);
    }
  }));

  r.post('/account/password', auth.requireUser, route(async (req, res) => {
    const renderError = async (message) => {
      const settings = await buyerSettings(repos);
      const orders = await repos.orders.listForUser(req.user.id);
      const view = String(accountPage({ settings, user: req.user, isEnvOwner: isEnvOwner(req.user), csrf: req.csrf, orders }));
      // Show the problem above the password form without a separate page.
      page(res, view.replace('<h2>Change password</h2>', `<h2>Change password</h2><p class="form-error" role="alert">${message}</p>`), 400);
    };
    if (isEnvOwner(req.user)) return renderError('The owner password is set in .env (ADMIN_PASSWORD).');
    if (await auth.tooManyAttempts(req)) return renderError('Too many tries. Wait 15 minutes and try again.');
    const current = field(req.body, 'current', 200);
    const password = field(req.body, 'password', 200);
    if (!current || !(await repos.users.verify(req.user.phone, current))) {
      await auth.recordFailure(req);
      return renderError('Your current password isn’t right.');
    }
    try {
      await repos.users.setPassword(req.user.id, password);
    } catch (err) {
      if (err instanceof ValidationError) return renderError(err.message);
      throw err;
    }
    // The password change logged this account out everywhere; keep this browser logged in.
    await auth.login(req, res, req.user);
    return res.redirect(303, '/account?saved=1');
  }));

  return r;
}

/** GET /account for a password account (owner, staff, or a Phase 0 customer): the Phase 0 page, unchanged. */
export function legacyAccountPage({ repos, config }) {
  const isEnvOwner = (user) => user.role === 'owner' && Boolean(config?.adminPhone) && user.phone === normalizePhone(config.adminPhone);
  return async (req, res, next) => {
    try {
      if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      res.set('Cache-Control', 'no-store');
      return res.type('html').send(String(accountPage({
        settings: await buyerSettings(repos),
        user: req.user,
        isEnvOwner: isEnvOwner(req.user),
        csrf: req.csrf,
        orders: await repos.orders.listForUser(req.user.id),
        flash: req.query.saved ? 'Your password was updated.' : '',
      })));
    } catch (err) {
      return next(err);
    }
  };
}
