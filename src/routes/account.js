import express from 'express';
import { safeNext, sameOriginOnly as sameSite } from '../auth.js';
import { buyerSettings } from '../modules/brand/index.js';
import { ValidationError, normalizePhone } from '../util.js';
import { accountPage, loginPage, signupPage } from '../views/store.js';

/** Login, signup and "My account" for everyone. The owner uses the same login and lands in /admin. */
export function accountRoutes({ repos, auth, config }) {
  // The .env owner's password comes from ADMIN_PASSWORD and is reset on every start.
  const isEnvOwner = (user) => user.role === 'owner' && Boolean(config?.adminPhone) && user.phone === normalizePhone(config.adminPhone);
  const r = express.Router();
  const page = (res, view, status = 200) => res.status(status).type('html').send(String(view));
  // Staff with no permissions yet have nothing to open in the console.
  const home = (user) => (['owner', 'manager'].includes(user.role) || (user.role === 'staff' && user.permissions?.length) ? '/admin' : '/account');

  r.get('/login', async (req, res) => {
    if (req.user) return res.redirect(safeNext(req.query.next, home(req.user)));
    page(res, loginPage({ settings: await buyerSettings(repos), next: safeNext(req.query.next, '/') }));
  });

  r.post('/login', sameSite, async (req, res) => {
    const settings = await buyerSettings(repos);
    const next = safeNext(req.body.next, '');
    const phone = String(req.body.phone || '').slice(0, 20);
    if (await auth.tooManyAttempts(req)) {
      return page(res, loginPage({ settings, next: next || '/', phone, error: 'Too many tries. Wait 15 minutes and try again.' }), 429);
    }
    const user = await repos.users.verify(phone, req.body.password);
    if (!user) {
      await auth.recordFailure(req);
      return page(res, loginPage({ settings, next: next || '/', phone, error: 'That mobile number and password don’t match.' }), 401);
    }
    await auth.login(req, res, user);
    res.redirect(303, next && next !== '/' ? next : home(user));
  });

  r.get('/signup', async (req, res) => {
    if (req.user) return res.redirect(home(req.user));
    page(res, signupPage({ settings: await buyerSettings(repos), next: safeNext(req.query.next, '/') }));
  });

  r.post('/signup', sameSite, async (req, res) => {
    const settings = await buyerSettings(repos);
    const next = safeNext(req.body.next, '/');
    const values = { name: String(req.body.name || '').slice(0, 80), phone: String(req.body.phone || '').slice(0, 20) };
    if (await auth.tooManyAttempts(req)) {
      return page(res, signupPage({ settings, next, values, error: 'Too many tries. Wait 15 minutes and try again.' }), 429);
    }
    try {
      const user = await repos.users.create({ ...values, password: req.body.password });
      await auth.login(req, res, user);
      res.redirect(303, next !== '/' ? next : '/account');
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      await auth.recordFailure(req);
      page(res, signupPage({ settings, next, values, error: err.message }), 400);
    }
  });

  r.post('/logout', async (req, res) => {
    await auth.logout(req, res);
    res.redirect(303, '/');
  });

  r.get('/account', auth.requireUser, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    page(res, accountPage({
      settings: await buyerSettings(repos),
      user: req.user,
      isEnvOwner: isEnvOwner(req.user),
      csrf: req.csrf,
      orders: await repos.orders.listForUser(req.user.id),
      flash: req.query.saved ? 'Your password was updated.' : '',
    }));
  });

  r.post('/account/password', auth.requireUser, async (req, res) => {
    const renderError = async (message) => {
      const settings = await buyerSettings(repos);
      const orders = await repos.orders.listForUser(req.user.id);
      const view = String(accountPage({ settings, user: req.user, isEnvOwner: isEnvOwner(req.user), csrf: req.csrf, orders }));
      // Show the problem above the password form without a separate page.
      page(res, view.replace('<h2>Change password</h2>', `<h2>Change password</h2><p class="form-error" role="alert">${message}</p>`), 400);
    };
    if (isEnvOwner(req.user)) return renderError('The owner password is set in .env (ADMIN_PASSWORD).');
    if (await auth.tooManyAttempts(req)) return renderError('Too many tries. Wait 15 minutes and try again.');
    if (!(await repos.users.verify(req.user.phone, req.body.current))) {
      await auth.recordFailure(req);
      return renderError('Your current password isn’t right.');
    }
    try {
      await repos.users.setPassword(req.user.id, req.body.password);
    } catch (err) {
      if (err instanceof ValidationError) return renderError(err.message);
      throw err;
    }
    // The password change logged this account out everywhere; keep this browser logged in.
    await auth.login(req, res, req.user);
    res.redirect(303, '/account?saved=1');
  });

  return r;
}
