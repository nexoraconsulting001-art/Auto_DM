// auth-2 (PRD 5.20, F-109; signup_settings): a first sign-in on the sign-in host makes a usable Free business only while
// sign-up is open to that person: mode 'public' and the day's cap not reached. Otherwise the person is signed in to a
// held place that answers only the sign-in and sign-up routes, until signup.start (with a working invite code, or once
// sign-up is public) makes it a business. A stranger can never get a working business just by signing in.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_HOST, call, world } from '../../p7/signup-plans/support.js';

let w;
before(async () => { w = await world(); });
after(() => w?.close());

const heldOf = async (personId) => w.sql(
  `SELECT t.id, t.slug, t.signup_held FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.person_id = $1 ORDER BY t.id`,
  [personId],
);
const resetLimits = () => w.sql('DELETE FROM rate_limit_hits');

async function refusedEverywhere(who, label) {
  const list = await w.signup(who, 'GET', '/automations');
  assert.deepEqual([list.status, list.json.reason], [403, 'signup.pending'], `${label}: business routes are refused`);
  const team = await w.signup(who, 'GET', '/team');
  assert.deepEqual([team.status, team.json.reason], [403, 'signup.pending'], `${label}: owner routes are refused`);
  const connect = await w.signup(who, 'POST', '/instagram/connect', {});
  assert.equal(connect.status, 403, `${label}: Instagram cannot be connected`);
  const me = await w.signup(who, 'GET', '/auth/me');
  assert.equal(me.status, 200, `${label}: the person is still signed in`);
  const status = await w.signup(who, 'GET', '/signup');
  assert.equal(status.json.signedIn, true, `${label}: and can go on to sign up`);
  const [business] = await heldOf(who.personId);
  assert.equal(business?.signup_held, true, `${label}: the first sign-in made no working business`);
  const site = await call(w, '/api/v1/automations', { host: `${business.slug}.bhava.test` });
  assert.equal(site.status, 404, `${label}: the held place has no address of its own`);
}

test('auth-2: with sign-up closed, a first sign-in makes no working business', async () => {
  await w.setMode('closed');
  await resetLimits();
  const stranger = await w.person();
  await refusedEverywhere(stranger, 'closed');
  const again = await w.signup(stranger, 'POST', '/signup', { accountType: 'creator', name: 'Sneaky Shop' });
  assert.equal(again.json.reason, 'signup.closed');
  assert.equal((await heldOf(stranger.personId))[0].signup_held, true, 'still held');
});

test('auth-2: with sign-up by invite, a first sign-in is held until signup.start with a working code', async () => {
  await w.setMode('invite');
  await resetLimits();
  const invited = await w.person();
  await refusedEverywhere(invited, 'invite');
  const needCode = await w.signup(invited, 'POST', '/signup', { accountType: 'creator', name: 'No Code Shop' });
  assert.equal(needCode.json.reason, 'signup.invite_required');

  const made = await w.console('POST', '/signup/invites', { note: 'auth-2', maxUses: 1 });
  assert.equal(made.status, 201);
  const { started } = await w.signUp(invited, { name: 'Invited Shop', inviteCode: made.json.code });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  const businesses = await heldOf(invited.personId);
  assert.equal(businesses.length, 1, 'the held place became the business: no second one');
  assert.deepEqual([businesses[0].id, businesses[0].signup_held], [started.json.tenantId, false]);
  assert.equal((await w.signup(invited, 'GET', '/automations')).status, 200, 'the business now works');
});

test('auth-2: with sign-up public but the day’s cap reached, a first sign-in is held', async () => {
  await w.setMode('public');
  await resetLimits();
  const first = await w.person();
  assert.equal((await heldOf(first.personId))[0].signup_held, false, 'public and under the cap: F-109 as before');
  assert.equal((await w.signup(first, 'GET', '/automations')).status, 200);
  const { started } = await w.signUp(first, { name: 'Cap Filler' });
  assert.equal(started.status, 201);
  const [{ n }] = await w.sql(
    `SELECT count(*)::int AS n FROM signup_runs r JOIN tenants t ON t.id = r.tenant_id
      WHERE t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`,
  );
  await w.sql('UPDATE signup_settings SET daily_cap = $1', [Math.max(1, n)]);
  try {
    const late = await w.person();
    await refusedEverywhere(late, 'cap');
  } finally {
    await w.sql('UPDATE signup_settings SET daily_cap = NULL');
  }
});

test('auth-2: the app host itself is unchanged for someone not signed in', async () => {
  const anonymous = await call(w, '/api/v1/automations', { host: APP_HOST });
  assert.equal(anonymous.status, 401);
});
