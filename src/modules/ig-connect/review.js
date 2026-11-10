import crypto from 'node:crypto';
import { sameOriginOnly } from '../../auth.js';
import { log } from '../../platform/log.js';
import { currentTenant, withTenant } from '../../tenancy.js';
import { normalizePhone, slugify } from '../../util.js';
import { reviewPage, reviewSignInPage } from './pages.js';
import { connectionView } from './rules.js';

const REVIEW_BUSINESS_NAME = 'App Review demo';
const MIN_CODE_LENGTH = 8;

/**
 * The login Meta's reviewers use (PRD 5.11, 13): one review number and one fixed code, which open only the review business and nothing else. Off
 * unless META_REVIEW_PHONE and META_REVIEW_CODE are set. Returns { slug, phone, code }, or null when it is off.
 */
export function reviewSettings(config, env = process.env) {
  const given = config.metaReview ?? { slug: env.META_REVIEW_SLUG, phone: env.META_REVIEW_PHONE, code: env.META_REVIEW_CODE };
  const phone = normalizePhone(given.phone);
  const code = String(given.code ?? '');
  if (!phone || code.length < MIN_CODE_LENGTH) return null;
  return { slug: slugify(given.slug || 'meta-review'), phone, code };
}

/** Makes the review business and its owner, if they aren't there yet. */
export async function ensureReviewBusiness({ repos, review }) {
  const tenant = await repos.tenants.ensure({ slug: review.slug, name: REVIEW_BUSINESS_NAME });
  await withTenant(tenant, async () => {
    const existing = await repos.users.findByPhone(review.phone);
    if (!existing) {
      // The review code is how this account signs in. Nobody ever knows this password.
      await repos.users.create({ name: 'App reviewer', phone: review.phone, password: crypto.randomBytes(24).toString('base64url'), role: 'owner' });
    } else if (existing.role !== 'owner') {
      await repos.users.setRole(existing.id, 'owner');
    }
    await repos.igConnect.allowAppRole();
  });
  return tenant;
}

function sameSecret(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The pages of the review login, which walk a reviewer through connecting Instagram, what it grants, and how data is removed. */
export function reviewRoutes(app, { repos, auth, config, services, review }) {
  const { connect, gates } = services;
  const send = (res, view, status = 200) => res.status(status).set('Cache-Control', 'no-store').type('html').send(String(view));
  const onlyHere = (_req, _res, next) => next(currentTenant()?.slug === review.slug ? undefined : 'route');
  const signedIn = (req) => req.user?.role === 'owner';
  const needSignIn = (req, res, next) => (signedIn(req) ? next() : res.redirect(303, '/review'));

  async function refuse(req, res, reason) {
    await auth.recordFailure(req);
    await repos.audit.record({ actor: 'reviewer', action: 'review.login_refused', details: { reason } });
    log.warn('review.login_refused', { reason });
    send(res, reviewSignInPage({ error: 'That number and code don’t match.' }), 401);
  }

  app.get('/review', onlyHere, async (req, res) => {
    if (!signedIn(req)) return send(res, reviewSignInPage({}));
    const [account, result, decisions] = await Promise.all([repos.igAccounts.primary(), gates.evaluate(), repos.igConnect.recentDecisions(10)]);
    send(res, reviewPage({
      connection: connectionView(account),
      gates: result.gates,
      decisions,
      csrf: req.csrf,
      outcome: String(req.query.instagram ?? ''),
      deletionUrl: `${config.metaCallbackBaseUrl || config.publicBaseUrl || ''}/meta/deletion`,
    }));
  });

  app.post('/review/login', onlyHere, sameOriginOnly, async (req, res) => {
    if (await auth.tooManyAttempts(req)) return send(res, reviewSignInPage({ error: 'Too many tries. Wait 15 minutes and try again.' }), 429);
    // Both are always checked, so the answer takes the same time for a wrong number as for a wrong code.
    const rightNumber = normalizePhone(String(req.body?.phone ?? '').slice(0, 20)) === review.phone;
    const rightCode = sameSecret(String(req.body?.code ?? '').slice(0, 200), review.code);
    if (!rightNumber) return refuse(req, res, 'other_number');
    if (!rightCode) return refuse(req, res, 'wrong_code');
    const user = await repos.users.findByPhone(review.phone);
    if (!user || user.role !== 'owner') return refuse(req, res, 'no_review_account');
    await auth.login(req, res, user);
    await repos.audit.record({ actor: `user:${user.id}`, action: 'review.login' });
    log.info('review.login', { userId: user.id });
    res.redirect(303, '/review');
  });

  app.post('/review/connect', onlyHere, needSignIn, async (req, res) => {
    const { authorizeUrl } = await connect.start({ user: req.user, returnTo: '/review', req });
    res.redirect(303, authorizeUrl);
  });

  app.post('/review/disconnect', onlyHere, needSignIn, async (req, res) => {
    const account = await repos.igAccounts.primary();
    if (account) await connect.disconnect(account.igUserId, `user:${req.user.id}`);
    await gates.evaluate();
    res.redirect(303, '/review?instagram=disconnected');
  });
}
