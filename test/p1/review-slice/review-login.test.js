import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureReviewBusiness, reviewSettings } from '../../../src/modules/ig-connect/review.js';
import { setLogSink } from '../../../src/platform/log.js';
import { withTenant } from '../../../src/tenancy.js';
import { IG_A, accountRow, addBusiness, auditFor, seedIg, startSlice, until } from './support.js';

const REVIEW = { slug: 'meta-review', phone: '9123456780', code: 'review-code-1' };
const HOST = 'meta-review.bhava.test';

async function startReview(t, overrides = {}) {
  const slice = await startSlice(t, { overrides: { metaReview: REVIEW, ...overrides } });
  const tenant = await until(async () => {
    const found = await slice.app.platform.tenants.getBySlug(REVIEW.slug);
    if (!found) return null;
    const ready = await withTenant(found, () => slice.app.platform.users.findByPhone(REVIEW.phone));
    return ready ? found : null;
  });
  return { ...slice, tenant };
}

const at = (slice, path, { host = HOST, cookie, ...init } = {}) =>
  fetch(`${slice.app.base}${path}`, { redirect: 'manual', ...init, headers: { 'x-forwarded-host': host, ...(cookie ? { cookie } : {}), ...init.headers } });

const form = (fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });

async function signIn(slice) {
  const res = await at(slice, '/review/login', form({ phone: REVIEW.phone, code: REVIEW.code }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/review');
  return res.headers.get('set-cookie').split(';')[0];
}

const csrfIn = (html) => /name="_csrf" value="([^"]+)"/.exec(html)[1];

test('with no review number and code configured, there is no review login', async (t) => {
  const slice = await startSlice(t);
  const res = await fetch(`${slice.app.base}/review`, { redirect: 'manual' });
  assert.equal(res.status, 404);
  assert.equal(await slice.app.platform.tenants.getBySlug('meta-review'), null);
});

test('a short review code turns it off rather than leaving a weak way in', () => {
  assert.equal(reviewSettings({ metaReview: { phone: REVIEW.phone, code: 'short' } }), null);
  assert.equal(reviewSettings({ metaReview: { phone: 'not-a-number', code: REVIEW.code } }), null);
  assert.deepEqual(reviewSettings({ metaReview: { phone: REVIEW.phone, code: REVIEW.code } }), { slug: 'meta-review', phone: REVIEW.phone, code: REVIEW.code });
  assert.equal(reviewSettings({}, {}), null);
  assert.equal(reviewSettings({}, { META_REVIEW_PHONE: REVIEW.phone, META_REVIEW_CODE: REVIEW.code, META_REVIEW_SLUG: 'Review Co' }).slug, 'review-co');
});

test('the review login is on the review business only', async (t) => {
  const slice = await startReview(t);
  assert.equal((await at(slice, '/review')).status, 200);
  const other = await addBusiness(slice.app);
  assert.equal((await at(slice, '/review', { host: other.host })).status, 404);
  assert.equal((await at(slice, '/review/login', { host: other.host, ...form({ phone: REVIEW.phone, code: REVIEW.code }) })).status, 404);
});

test('F-50: the review code on another number is refused and logged, with no number in the log', async (t) => {
  const slice = await startReview(t);
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));

  const res = await at(slice, '/review/login', form({ phone: '9000000077', code: REVIEW.code }));
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  const [row] = await auditFor(slice, slice.tenant.id);
  assert.deepEqual([row.action, row.details], ['review.login_refused', { reason: 'other_number' }]);
  assert.ok(lines.some((line) => line.includes('review.login_refused')));
  assert.equal(lines.join('\n').includes('9000000077'), false);
});

test('a wrong code is refused and logged too', async (t) => {
  const slice = await startReview(t);
  const res = await at(slice, '/review/login', form({ phone: REVIEW.phone, code: 'wrong-code-99' }));
  assert.equal(res.status, 401);
  const [row] = await auditFor(slice, slice.tenant.id);
  assert.deepEqual(row.details, { reason: 'wrong_code' });
});

test('every use of the review login is logged, and it gives an owner session on the review business', async (t) => {
  const slice = await startReview(t);
  const cookie = await signIn(slice);
  assert.ok((await auditFor(slice, slice.tenant.id)).some((row) => row.action === 'review.login'));
  const me = await at(slice, '/api/v1/auth/me', { cookie });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.role, 'owner');
  assert.equal(body.business.slug, REVIEW.slug);
});

test('the review code is not a password anywhere else', async (t) => {
  const slice = await startReview(t);
  const res = await at(slice, '/login', form({ phone: REVIEW.phone, password: REVIEW.code }));
  assert.equal(res.status, 401);
});

test('the whole flow on one page: connect, granted permissions, webhooks, privacy, disconnect', async (t) => {
  const slice = await startReview(t);
  const cookie = await signIn(slice);
  let page = await (await at(slice, '/review', { cookie })).text();
  assert.match(page, /No account is connected yet/);
  assert.match(page, /Connect Instagram/);

  await seedIg(slice.sim, IG_A);
  await slice.sim.post('/oauth/next', { igUserId: IG_A });
  const start = await at(slice, '/review/connect', { cookie, ...form({ _csrf: csrfIn(page) }) });
  assert.equal(start.status, 303);
  const dialog = await fetch(start.headers.get('location'), { redirect: 'manual' });
  assert.equal(dialog.status, 302);
  const back = new URL(dialog.headers.get('location'));
  const done = await fetch(`${slice.app.base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': back.host } });
  const landing = new URL(done.headers.get('location'));
  assert.equal(landing.host, HOST);
  assert.equal(`${landing.pathname}${landing.search}`, '/review?instagram=connected');

  page = await (await at(slice, '/review?instagram=connected', { cookie })).text();
  assert.match(page, /Instagram is connected/);
  assert.match(page, /Connected as <strong>@user0011<\/strong>/);
  for (const scope of ['instagram_business_basic', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights']) assert.match(page, new RegExp(scope));
  assert.equal(page.includes('>No</span></td>'), false, 'every permission shows as granted');
  assert.match(page, /Subscribed: <span class="ok">Yes/);
  assert.match(page, /href="\/privacy"/);
  assert.match(page, /meta\/deletion/);
  assert.match(page, /Disconnect Instagram/);
  assert.doesNotMatch(page, /IGAAsim/);

  const out = await at(slice, '/review/disconnect', { cookie, ...form({ _csrf: csrfIn(page) }) });
  assert.equal(out.headers.get('location'), '/review?instagram=disconnected');
  assert.equal((await accountRow(slice, IG_A)).access_token_enc, '');
});

test('the steps need a signed-in reviewer and a CSRF token', async (t) => {
  const slice = await startReview(t);
  const anonymous = await at(slice, '/review/connect', form({}));
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get('location'), '/review');
  const cookie = await signIn(slice);
  assert.equal((await at(slice, '/review/connect', { cookie, ...form({}) })).status, 403);
  assert.equal((await at(slice, '/review/disconnect', { cookie, ...form({ _csrf: 'wrong' }) })).status, 403);
});

test('the review account has an app role, as it needs under Standard Access', async (t) => {
  const slice = await startReview(t);
  const [row] = await until(async () => {
    const rows = await slice.q('SELECT app_role_ok FROM compliance_settings WHERE tenant_id = $1', [slice.tenant.id]);
    return rows.length ? rows : null;
  });
  assert.equal(row.app_role_ok, true);
});

test('starting the app again leaves the review business as it was', async (t) => {
  const slice = await startReview(t);
  const again = await ensureReviewBusiness({ repos: slice.app.platform, review: REVIEW });
  assert.equal(again.id, slice.tenant.id);
  assert.equal((await slice.q('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [slice.tenant.id]))[0].n, 1);
});
