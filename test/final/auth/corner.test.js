// Corner cases around the "auth" fixes of the final review (auth-1 to auth-9, D-4): boundaries, the other business's ids,
// concurrent requests, expired, forged or reused sessions and tokens, malformed input, and roles at the edge of a permission.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApple } from '../../../tools/sim/apple/index.mjs';
import { openWorld as openPayWorld, refundBody } from '../../p4/payments/support.js';
import { OWN_LOGIN, openWorld as openShipWorld, raw as shipRaw } from '../../p4/shipping/support.js';
import { appWorld, guestApp } from '../../p6/shopper-api/support.js';
import { OWNER, accountsApp, call, codeSignIn, freshIp, otherBusiness, random10, sellerCodeFor, sentCount, testDevice, typedAccount } from '../../p5/accounts/support.js';
import { world as signupWorld } from '../../p7/signup-plans/support.js';
import { IG_A, IG_B, accountRow, addBusiness, consoleSession, seedIg, startSlice } from '../../p1/review-slice/support.js';
import { CONSOLE_HOST, consoleUser, hit, impersonate, json, need, one, opCall, shopOn, sql, totp, unique, useBillingWorld } from '../../p7/spec-p7/support.js';

// ---- auth-1: refunds need a fresh re-auth, owner only --------------------------------------------------------------------------

describe('auth-1 corners', () => {
  const reason = (r) => r.json?.code ?? r.json?.error?.code ?? r.json?.error;

  test('a manager and a staff member cannot refund or retry, even on a fresh session', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 99900 });
    const made = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(made.status, 201, made.text);
    for (const role of ['manager', 'staff']) {
      const member = await shop.member(role, role === 'manager' ? '9000000031' : '9000000032');
      const refund = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000), { as: member.token });
      assert.equal(refund.status, 403, `${role} refunded: ${refund.text}`);
      const retry = await shop.api('POST', `/refunds/${made.json.id}/retry`, undefined, { as: member.token });
      assert.equal(retry.status, 403, `${role} retried: ${retry.text}`);
    }
    assert.equal((await shop.refunds(order.id)).length, 1);
  });

  test('no token, a forged token and a token of another business get nothing', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 50000 });
    const none = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000), { as: null });
    assert.equal(none.status, 401, none.text);
    const forged = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000), { as: `${shop.token.slice(0, -2)}xx` });
    assert.equal(forged.status, 401, forged.text);
    const other = await world.secondBusiness();
    // The other business's owner, fresh, on this business's host.
    const crossHost = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000), { as: other.token });
    assert.ok([401, 403, 404].includes(crossHost.status), `another business's owner answered ${crossHost.status}`);
    // The other business's owner on their own host: this order does not exist for them.
    const theirs = await other.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(theirs.status, 404, theirs.text);
    assert.equal((await shop.refunds(order.id)).length, 0);
  });

  test('another business cannot retry or read this business\'s refund', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 50000 });
    const made = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(made.status, 201, made.text);
    const other = await world.secondBusiness();
    assert.equal((await other.api('POST', `/refunds/${made.json.id}/retry`)).status, 404);
    assert.equal((await other.api('GET', `/refunds/${made.json.id}`)).status, 404);
  });

  test('the fresh window: ended a second ago is refused, ends in a minute is allowed, never re-authed is refused', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 99900 });
    const setFresh = (expr) => shop.sql(`UPDATE sessions SET fresh_until = ${expr} WHERE tenant_id = $1`, [shop.tenant.id]);
    await setFresh(`now() - interval '1 second'`);
    const just = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(just.status, 403, just.text);
    assert.equal(reason(just), 'reauth_required');
    await setFresh('NULL');
    const never = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(never.status, 403, never.text);
    await setFresh(`now() + interval '1 minute'`);
    const ok = await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(1000));
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await shop.refunds(order.id)).length, 1);
  });

  test('malformed refund input is refused and makes no refund: zero, negative, fractional, text, too much, bad key', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 10000 });
    const bodies = [refundBody(0), refundBody(-5), refundBody(10.5), refundBody('100'), refundBody(10001), refundBody(1000, { idempotencyKey: 'short' }), refundBody(1000, { idempotencyKey: 'has spaces in it!' }), { amountPaise: 1000 }];
    for (const body of bodies) {
      const res = await shop.api('POST', `/orders/${order.id}/refunds`, body);
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} answered ${res.status}`);
    }
    assert.equal((await shop.refunds(order.id)).length, 0);
    const notAnId = await shop.api('POST', `/orders/abc/refunds`, refundBody(1000));
    assert.ok(notAnId.status === 400 || notAnId.status === 404, `${notAnId.status}`);
    // Exactly the whole amount is allowed.
    assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, refundBody(10000))).status, 201);
  });

  test('the same idempotency key sent together makes one refund', async (t) => {
    const world = await openPayWorld(t);
    const { shop } = world;
    await shop.payReady();
    const { order } = await shop.paidOrder({ totalPaise: 50000 });
    const body = refundBody(3000);
    const answers = await Promise.all(Array.from({ length: 4 }, () => shop.api('POST', `/orders/${order.id}/refunds`, body)));
    assert.ok(answers.every((a) => a.status < 500), answers.map((a) => a.status).join(','));
    assert.equal((await shop.refunds(order.id)).length, 1, 'a repeated tap made more than one refund');
  });
});

// ---- auth-5: shipping login is the owner's ---------------------------------------------------------------------------------------

describe('auth-5 corners', () => {
  async function member(world, role, phone) {
    const password = 'member-pass-1';
    await world.shop.inTenant(() => world.repos.users.create({ name: `A ${role}`, phone, password, role }));
    const res = await shipRaw(world.port, '/api/v1/auth/login', { method: 'POST', host: '127.0.0.1', body: { phone, password } });
    assert.ok(res.json?.token, `sign-in of ${role} failed with ${res.status}`);
    return res.json.token;
  }

  test('staff cannot change shipping settings either, and nothing is saved', async (t) => {
    const world = await openShipWorld(t);
    const { shop } = world;
    const staff = await member(world, 'staff', '9000000041');
    const before = await shop.settingsRow();
    const res = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password }, { as: staff });
    assert.equal(res.status, 403, `staff answered ${res.status}: ${res.text}`);
    assert.deepEqual(await shop.settingsRow(), before);
  });

  test('a manager cannot blank, clear or change the saved login with empty or odd values', async (t) => {
    const world = await openShipWorld(t);
    const { shop } = world;
    const as = await member(world, 'manager', '9000000042');
    assert.equal((await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password })).status, 200);
    const saved = await shop.settingsRow();
    for (const body of [{ ownPassword: '' }, { ownEmail: '' }, { ownEmail: OWN_LOGIN.email.toUpperCase() }, { mode: 'own', ownPassword: null }, { ownEmail: 'a@b.example', mode: 'managed' }]) {
      const res = await shop.api('PATCH', '/shipping-settings', body, { as });
      const row = await shop.settingsRow();
      assert.deepEqual([row.mode, row.own_email, row.own_password_enc], [saved.mode, saved.own_email, saved.own_password_enc], `${JSON.stringify(body)} changed the login (status ${res.status})`);
    }
  });

  test('another business\'s owner cannot touch this business\'s shipping settings', async (t) => {
    const world = await openShipWorld(t);
    const { shop } = world;
    const other = await world.business({ name: 'Other Shop' });
    // A bearer token carries its own business, whatever host it is sent to: the request acts on the token's business only.
    const res = await shop.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: OWN_LOGIN.email, ownPassword: OWN_LOGIN.password }, { as: other.token });
    assert.ok(res.status < 500, `answered ${res.status}`);
    const row = await shop.settingsRow();
    assert.deepEqual([row.mode, row.own_email, row.own_password_enc], ['managed', '', ''], 'another business\'s owner changed this business');
    // And a business's own manager cannot reach the other business's settings with their token.
    const manager = await member(world, 'manager', '9000000043');
    const before = await other.settingsRow();
    await other.api('PATCH', '/shipping-settings', { mode: 'own', ownEmail: 'x@y.example', ownPassword: 'pw-pw-pw-1' }, { as: manager });
    assert.deepEqual(await other.settingsRow(), before, 'this business\'s manager changed the other business');
  });
});

// ---- auth-9: the shopper app's Apple nonce is spent once -------------------------------------------------------------------------

describe('auth-9 corners', () => {
  let apple;
  let w;
  before(async () => {
    apple = createApple({ audience: 'sim.apple.owner-app' });
    await apple.start();
    w = await appWorld({ overrides: { appleKeysBaseUrl: apple.url } });
  });
  after(async () => { await w?.close(); await apple?.close(); });
  const bundle = () => `com.example.t${w.app.tenant.id}`;
  const sessionCount = async () => (await w.app.db.platform.query(`SELECT count(*)::int AS n FROM shopper_app_sessions WHERE tenant_id = $1`, [w.app.tenant.id]))[0].n;

  test('the same token and nonce sent together open exactly one session', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const { identityToken } = await apple.post('/identity-token', { sub: 'apple-race', nonce, aud: bundle() });
    const devices = await Promise.all(Array.from({ length: 4 }, () => guestApp(w, { platform: 'ios' })));
    const answers = await Promise.all(devices.map((d) => d.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: d.device } })));
    const ok = answers.filter((a) => a.status === 201).length;
    assert.equal(ok, 1, `${ok} sessions opened from one token: ${answers.map((a) => a.status).join(',')}`);
  });

  test('a token with the wrong nonce, the wrong audience, no nonce or junk is refused and does not spend the right nonce', async () => {
    const ios = await guestApp(w, { platform: 'ios' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const good = await apple.post('/identity-token', { sub: 'apple-corner', nonce, aud: bundle() });
    const wrongAud = await apple.post('/identity-token', { sub: 'apple-corner', nonce, aud: 'com.someone.else' });
    const before = await sessionCount();
    const tries = [
      { identityToken: good.identityToken, nonce: crypto.randomBytes(16).toString('hex') },
      { identityToken: wrongAud.identityToken, nonce },
      { identityToken: good.identityToken },
      { identityToken: 'not.a.jwt', nonce },
      { identityToken: `${good.identityToken.slice(0, -3)}abc`, nonce },
    ];
    for (const body of tries) {
      const res = await ios.fetch('/api/store/app/apple', { method: 'POST', body: { ...body, device: ios.device } });
      assert.ok(res.status === 400 || res.status === 401, `${res.status} for ${Object.keys(body).join('+')}`);
    }
    assert.equal(await sessionCount(), before, 'a refused token opened a session');
    const okRes = await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken: good.identityToken, nonce, device: ios.device } });
    assert.equal(okRes.status, 201, 'the real nonce was spent by a refused try');
  });

  test('a token for another business\'s bundle id cannot sign in here', async () => {
    const ios = await guestApp(w, { platform: 'ios' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const { identityToken } = await apple.post('/identity-token', { sub: 'apple-other-biz', nonce, aud: `com.example.t${Number(w.app.tenant.id) + 999}` });
    const res = await ios.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: ios.device } });
    assert.equal(res.status, 401);
  });

  test('an Android device cannot use the Apple route', async () => {
    const android = await guestApp(w, { platform: 'android' });
    const nonce = crypto.randomBytes(16).toString('hex');
    const { identityToken } = await apple.post('/identity-token', { sub: 'apple-android', nonce, aud: bundle() });
    const res = await android.fetch('/api/store/app/apple', { method: 'POST', body: { identityToken, nonce, device: android.device } });
    assert.ok([401, 403, 404].includes(res.status), `${res.status}`);
  });
});

// ---- auth-7 and auth-4: sign-in and re-auth codes, team removal ---------------------------------------------------------------------

describe('auth-7 and auth-4 corners', () => {
  let app;
  let owner;
  before(async () => {
    app = await accountsApp();
    owner = await codeSignIn(app, { device: testDevice('Owner phone') });
  });
  after(() => app?.close());
  const sql = (text, params = []) => app.db.platform.query(text, params);
  const reset = async () => {
    await sql(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
    await sql('DELETE FROM rate_limit_hits');
  };
  const reauthStart = (session) => call(app, '/api/v1/auth/reauth/start', { method: 'POST', headers: session.auth, ip: freshIp() });
  const reauthVerify = (session, body) => call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: session.auth, body, ip: freshIp() });
  const as = (session) => ({ ...session.auth });

  async function staffOf(name, role = 'staff') {
    const phone = random10();
    await typedAccount(app, app.tenant, { phone, role, name, permissions: role === 'staff' ? ['orders'] : [] });
    await reset();
    return codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice(name) });
  }

  test('auth-7: a stranger spending one number\'s limits does not touch another number\'s sign-in', async () => {
    await reset();
    const victim = random10();
    for (let i = 0; i < 12; i++) await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: victim, code: '000000' }, ip: freshIp() });
    const bystander = await staffOf('Bystander');
    assert.equal((await call(app, '/api/v1/auth/me', { headers: as(bystander) })).status, 200);
  });

  test('auth-7: malformed numbers and codes are refused before anything is sent', async () => {
    await reset();
    // auth.start answers the same 202 for any number so it never says whether a number has an account; what matters is that nothing is sent.
    const sentBefore = await sentCount(app.whatsapp);
    for (const phone of ['', '123', 'abcdefghij', '+', null, 12345, '9'.repeat(40)]) {
      const res = await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone }, ip: freshIp() });
      assert.ok(res.status === 202 || (res.status >= 400 && res.status < 500), `phone ${JSON.stringify(phone)} answered ${res.status}`);
    }
    const noBody = await call(app, '/api/v1/auth/start', { method: 'POST', body: {}, ip: freshIp() });
    assert.ok(noBody.status === 202 || (noBody.status >= 400 && noBody.status < 500), `${noBody.status}`);
    assert.equal(await sentCount(app.whatsapp), sentBefore, 'a code was sent to a malformed number');
    for (const code of ['', '12345', '1234567', 'abcdef', null]) {
      const res = await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: OWNER.phone, code }, ip: freshIp() });
      assert.ok(res.status >= 400 && res.status < 500, `code ${JSON.stringify(code)} answered ${res.status}`);
    }
  });

  test('auth-7: re-auth needs a session, takes exactly one proof, and a code works once', async () => {
    await reset();
    assert.equal((await call(app, '/api/v1/auth/reauth/start', { method: 'POST', ip: freshIp() })).status, 401, 'no session');
    assert.equal((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', body: { code: '123456' }, ip: freshIp() })).status, 401, 'no session');
    assert.equal((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: { authorization: 'Bearer forged.token.value' }, body: { code: '123456' }, ip: freshIp() })).status, 401, 'forged token');
    assert.equal((await reauthVerify(owner, {})).status, 400, 'neither a code nor a device unlock');
    assert.equal((await reauthVerify(owner, { code: '123456', deviceSecret: 'x'.repeat(20) })).status, 400, 'both');
    assert.equal((await reauthVerify(owner, { code: 'abc' })).status, 400, 'malformed code');

    assert.equal((await reauthStart(owner)).status, 202);
    const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
    assert.equal((await reauthVerify(owner, { code })).status, 200);
    const again = await reauthVerify(owner, { code });
    assert.equal(again.status, 400, 'a code was used twice');
  });

  test('auth-7: a re-auth code is bound to the person it was sent to, and dies when it expires', async () => {
    await reset();
    const other = await staffOf('Other person');
    assert.equal((await reauthStart(owner)).status, 202);
    const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
    const stolen = await reauthVerify(other, { code });
    assert.equal(stolen.status, 400, 'another person\'s session took the owner\'s code');
    await sql(`UPDATE seller_login_codes SET expires_at = now() - interval '1 second' WHERE purpose = 'reauth' AND used_at IS NULL`);
    const late = await reauthVerify(owner, { code });
    assert.equal(late.status, 400, 'an expired code worked');
  });

  test('auth-7: five wrong tries on a code spend it, so even the right code then fails', async () => {
    await reset();
    assert.equal((await reauthStart(owner)).status, 202);
    const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
    const wrong = code === '000000' ? '111111' : '000000';
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push((await reauthVerify(owner, { code: wrong })).status);
    assert.ok(answers.every((s) => s === 400 || s === 429), answers.join(','));
    const late = await reauthVerify(owner, { code });
    assert.ok(late.status === 400 || late.status === 429, `the right code after six wrong ones answered ${late.status}`);
  });

  test('auth-4: removing a missing, repeated or other-business member changes nothing', async () => {
    await reset();
    const keep = await staffOf('Keeps');
    const gone = await staffOf('Goes');
    const remove = (id, session = owner) => call(app, `/api/v1/team/${id}`, { method: 'DELETE', headers: as(session) });
    assert.equal((await remove(99999999)).status, 404, 'a missing id');
    assert.ok([400, 404].includes((await remove('abc')).status), 'not an id');
    assert.equal((await remove(gone.user.id)).status, 204);
    assert.equal((await remove(gone.user.id)).status, 404, 'removed twice');

    const theirs = await otherBusiness(app, 'Not Mine');
    const theirId = await typedAccount(app, theirs, { phone: random10(), role: 'staff', name: 'Their staff' });
    assert.equal((await remove(theirId)).status, 404, 'another business\'s member');
    const [row] = await sql('SELECT removed_at FROM users WHERE id = $1', [theirId]);
    assert.equal(row.removed_at, null, 'another business\'s member was removed');
    assert.equal((await call(app, '/api/v1/auth/me', { headers: as(keep) })).status, 200, 'an unrelated member was signed out');
  });

  test('auth-4: the last owner cannot be removed, and a manager or staff member cannot remove anyone', async () => {
    await reset();
    const manager = await staffOf('A manager', 'manager');
    const staff = await staffOf('A staff', 'staff');
    const victim = await staffOf('Victim');
    for (const actor of [manager, staff]) {
      const res = await call(app, `/api/v1/team/${victim.user.id}`, { method: 'DELETE', headers: as(actor) });
      assert.equal(res.status, 403, `${actor.user.role} removed someone: ${res.status}`);
    }
    assert.equal((await call(app, '/api/v1/auth/me', { headers: as(victim) })).status, 200);
    const last = await call(app, `/api/v1/team/${owner.user.id}`, { method: 'DELETE', headers: as(owner) });
    assert.equal(last.status, 409, `the last owner was removed: ${last.status}`);
    assert.equal((await call(app, '/api/v1/auth/me', { headers: as(owner) })).status, 200);
  });

  test('auth-4: a stale session cannot remove or invite, and a bad contact or an owner role is refused', async () => {
    await reset();
    const victim = await staffOf('Stale victim');
    await sql(`UPDATE sessions SET fresh_until = now() - interval '1 second' WHERE tenant_id = $1 AND user_id = $2`, [app.tenant.id, owner.user.id]);
    const stale = await call(app, `/api/v1/team/${victim.user.id}`, { method: 'DELETE', headers: as(owner) });
    assert.equal(stale.status, 403, stale.text);
    const staleInvite = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: random10(), role: 'staff', permissions: ['orders'] } });
    assert.equal(staleInvite.status, 403, staleInvite.text);
    await sql(`UPDATE sessions SET fresh_until = now() + interval '5 minutes' WHERE tenant_id = $1 AND user_id = $2`, [app.tenant.id, owner.user.id]);
    for (const body of [{ contact: '12', role: 'staff', permissions: [] }, { contact: 'not a contact', role: 'staff' }, { contact: random10(), role: 'god' }, { role: 'staff' }]) {
      const res = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body });
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(body)} answered ${res.status}`);
    }
  });

  test('auth-4: an invitation that expired is not taken up at sign-in', async () => {
    await reset();
    const phone = random10();
    const theirs = await otherBusiness(app, 'Invitee Shop');
    await typedAccount(app, theirs, { phone, role: 'owner', name: 'Invitee' });
    await sql(`UPDATE sessions SET fresh_until = now() + interval '5 minutes' WHERE tenant_id = $1 AND user_id = $2`, [app.tenant.id, owner.user.id]);
    const invite = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: phone, role: 'staff', permissions: ['orders'] } });
    assert.equal(invite.status, 201, invite.text);
    await sql(`UPDATE team_invites SET expires_at = now() - interval '1 second' WHERE id = $1`, [invite.json.id]);
    await reset();
    await codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Invitee phone') }).catch(() => null);
    // Nor by accepting it with its code (R6-SEC: accepting is the only way an invitation is taken up).
    await reset();
    const mine = await codeSignIn(app, { phone, tenantId: theirs.id, device: testDevice('Invitee phone') });
    assert.equal((await call(app, '/api/v1/auth/invites/accept', { method: 'POST', headers: as(mine), body: { code: invite.json.code } })).status, 404);
    const made = await sql('SELECT u.id FROM users u JOIN person_identities i ON i.person_id = u.person_id WHERE u.tenant_id = $1 AND i.subject LIKE $2', [app.tenant.id, `%${phone}`]);
    assert.deepEqual(made, [], 'an expired invitation made an account');
  });
});

// ---- auth-2: sign-up gating of a first sign-in ----------------------------------------------------------------------------------------

describe('auth-2 corners', () => {
  let w;
  before(async () => { w = await signupWorld(); });
  after(() => w?.close());
  const heldOf = (personId) => w.sql(`SELECT t.id, t.signup_held FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.person_id = $1 ORDER BY t.id`, [personId]);

  test('a one-use invite code works once, and a made-up or expired code never works', async () => {
    await w.setMode('invite');
    await w.sql('DELETE FROM rate_limit_hits');
    const code = (await w.console('POST', '/signup/invites', { note: 'once', maxUses: 1 })).json.code;
    const first = await w.person();
    const second = await w.person();
    assert.equal((await w.signUp(first, { inviteCode: code })).started.status, 201);
    const reused = await w.signUp(second, { inviteCode: code });
    assert.ok(reused.started.status >= 400, `a one-use code worked twice: ${reused.started.status}`);
    const forged = await w.signUp(second, { inviteCode: 'NOPE-NOPE-NOPE' });
    assert.ok(forged.started.status >= 400, `a made-up code worked: ${forged.started.status}`);
    const expiring = (await w.console('POST', '/signup/invites', { note: 'old', maxUses: 5 })).json.code;
    await w.sql(`UPDATE signup_invites SET expires_at = now() - interval '1 second' WHERE id = (SELECT max(id) FROM signup_invites)`);
    const old = await w.signUp(second, { inviteCode: expiring });
    assert.ok(old.started.status >= 400, `an expired code worked: ${old.started.status}`);
    assert.equal((await heldOf(second.personId))[0].signup_held, true, 'the person is still held');
  });

  test('a held place stays held when sign-up opens, until the person signs up; a second sign-in makes no second place', async () => {
    await w.setMode('closed');
    await w.sql('DELETE FROM rate_limit_hits');
    const who = await w.person();
    assert.equal((await heldOf(who.personId)).length, 1);
    await codeSignIn(w, { phone: who.phone, transport: 'bearer', device: testDevice('Second device') }).catch(() => null);
    assert.equal((await heldOf(who.personId)).length, 1, 'a second sign-in made a second business');
    await w.setMode('public');
    assert.equal((await w.signup(who, 'GET', '/automations')).status, 403, 'a held place became a working business on its own');
    const { started } = await w.signUp(who, { name: 'Now Open' });
    assert.equal(started.status, 201, JSON.stringify(started.json));
    assert.equal((await heldOf(who.personId)).length, 1);
    assert.equal((await w.signup(who, 'GET', '/automations')).status, 200);
  });

  test('first sign-ins arriving together once the day cap is reached are all held', async () => {
    await w.setMode('public');
    await w.sql('DELETE FROM rate_limit_hits');
    const [{ n }] = await w.sql(`SELECT count(*)::int AS n FROM signup_runs r JOIN tenants t ON t.id = r.tenant_id WHERE t.created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`);
    await w.sql('UPDATE signup_settings SET daily_cap = $1', [Math.max(1, n)]);
    try {
      const people = await Promise.all(Array.from({ length: 4 }, () => w.person()));
      for (const p of people) {
        const rows = await heldOf(p.personId);
        assert.equal(rows.length, 1, 'one place each');
        assert.equal(rows[0].signup_held, true, 'a first sign-in over the cap got a working business');
        assert.equal((await w.signup(p, 'GET', '/automations')).status, 403);
      }
    } finally {
      await w.sql('UPDATE signup_settings SET daily_cap = NULL');
    }
  });
});

// ---- D-4: the Instagram connect is finished only by who started it -------------------------------------------------------------------

describe('D-4 corners', () => {
  const VICTIM = IG_B;

  async function consentAndReturn(app, authorizeUrl) {
    const dialog = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(dialog.status, 302, await dialog.text());
    const back = new URL(dialog.headers.get('location'));
    const done = await fetch(`${app.base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': back.host } });
    return { back, done, next: done.status === 303 ? new URL(done.headers.get('location'), 'http://relative.invalid') : null };
  }
  const follow = (app, next, headers = {}) => fetch(`${app.base}${next.pathname}${next.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': next.host, ...headers } });
  const startAsConsole = async (app, seller, session) => {
    const res = await fetch(`${app.base}/api/v1/instagram/connect`, { method: 'POST', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-host': seller.host, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).authorizeUrl;
  };

  test('forged, malformed and empty finish tokens connect nothing and never crash', async (t) => {
    const slice = await startSlice(t);
    const { app } = slice;
    const seller = await addBusiness(app);
    const countAccounts = async () => (await slice.q('SELECT count(*)::int AS n FROM ig_accounts'))[0].n;
    const accountsBefore = await countAccounts();
    const tokens = ['', 'x', 'x'.repeat(300), `${crypto.randomBytes(32).toString('base64url')}`, "'; DROP TABLE oauth_states; --", 12345, null, { $ne: 1 }];
    for (const finishToken of tokens) {
      const res = await seller.api('POST', '/instagram/connect/finish', { finishToken });
      assert.ok(res.status < 500, `${JSON.stringify(finishToken)} answered ${res.status}`);
      assert.ok(res.status >= 400 || res.body?.outcome === 'expired', `${JSON.stringify(finishToken)} connected something: ${res.status} ${JSON.stringify(res.body)}`);
    }
    assert.equal(await countAccounts(), accountsBefore, 'an Instagram account appeared');
    const none = await seller.anonymous('POST', '/instagram/connect/finish', { finishToken: 'x'.repeat(40) });
    assert.equal(none.status, 401);
  });

  test('a callback with an unknown state, no state or no code connects nothing, and a used callback address does not work twice', async (t) => {
    const slice = await startSlice(t);
    const { app, sim } = slice;
    const seller = await addBusiness(app);
    const session = await consoleSession(app, seller);
    for (const query of ['', '?state=forged', `?state=${crypto.randomBytes(32).toString('base64url')}&code=abc`, '?code=abc', `?state=${'a'.repeat(400)}&code=abc`]) {
      const res = await fetch(`${app.base}/oauth/instagram/callback${query}`, { redirect: 'manual', headers: { 'x-forwarded-host': 'connect.bhava.test' } });
      assert.ok(res.status < 500, `callback${query.slice(0, 20)} answered ${res.status}`);
      assert.doesNotMatch(res.headers.get('location') ?? '', /instagram=connected/);
    }
    await seedIg(sim, IG_A);
    await sim.post('/oauth/next', { igUserId: IG_A });
    const authorizeUrl = await startAsConsole(app, seller, session);
    const { back, next } = await consentAndReturn(app, authorizeUrl);
    assert.ok(next, 'the first callback is taken');
    const replay = await fetch(`${app.base}${back.pathname}${back.search}`, { redirect: 'manual', headers: { 'x-forwarded-host': back.host } });
    assert.ok(replay.status >= 400 || !/instagram=connected/.test(replay.headers.get('location') ?? ''), `the callback worked twice: ${replay.status}`);
    const finished = await follow(app, next, { cookie: session.cookie });
    assert.equal(finished.status, 303);
    assert.equal(await accountRow(slice, IG_A).then((r) => Number(r.tenant_id)), Number(seller.tenant.id));
  });

  test('another business\'s owner in their own console session cannot finish this business\'s connect', async (t) => {
    const slice = await startSlice(t);
    const { app, sim } = slice;
    const seller = await addBusiness(app);
    const rival = await addBusiness(app);
    const sellerSession = await consoleSession(app, seller);
    const rivalSession = await consoleSession(app, rival);
    await seedIg(sim, VICTIM);
    await sim.post('/oauth/next', { igUserId: VICTIM });
    const { next } = await consentAndReturn(app, await startAsConsole(app, seller, sellerSession));
    // The rival's cookie, on the seller's host and on the rival's own host.
    const onSeller = await follow(app, next, { cookie: rivalSession.cookie });
    assert.ok(!/instagram=connected/.test(onSeller.headers.get('location') ?? ''), 'the rival finished it');
    const onRival = await follow(app, { ...next, host: rival.host, pathname: next.pathname, search: next.search }, { cookie: rivalSession.cookie });
    assert.ok(!/instagram=connected/.test(onRival.headers.get('location') ?? ''), 'the rival finished it on their own host');
    assert.equal(await accountRow(slice, VICTIM), null, 'an Instagram account was connected');
  });

  test('a starter who is no longer a manager or owner when the finish arrives connects nothing', async (t) => {
    const slice = await startSlice(t);
    const { app, sim } = slice;
    const seller = await addBusiness(app);
    const session = await consoleSession(app, seller);
    await seedIg(sim, IG_A);
    await sim.post('/oauth/next', { igUserId: IG_A });
    const authorizeUrl = await startAsConsole(app, seller, session);
    // A second owner so the demotion is allowed, then the starter becomes staff before Meta answers.
    await slice.q(`UPDATE users SET role = 'staff' WHERE tenant_id = $1 AND phone = $2`, [seller.tenant.id, seller.phone]);
    const { next } = await consentAndReturn(app, authorizeUrl);
    if (next) {
      const finished = await follow(app, next, { cookie: session.cookie });
      assert.ok(!/instagram=connected/.test(finished.headers.get('location') ?? ''), 'a demoted starter finished the connect');
    }
    assert.equal(await accountRow(slice, IG_A), null);
  });

  test('a state that has expired connects nothing', async (t) => {
    const slice = await startSlice(t);
    const { app, sim } = slice;
    const seller = await addBusiness(app);
    const session = await consoleSession(app, seller);
    await seedIg(sim, IG_A);
    await sim.post('/oauth/next', { igUserId: IG_A });
    const authorizeUrl = await startAsConsole(app, seller, session);
    await slice.q(`UPDATE oauth_states SET expires_at = now() - interval '1 second' WHERE tenant_id = $1`, [seller.tenant.id]);
    const { next } = await consentAndReturn(app, authorizeUrl);
    if (next) assert.ok(!/instagram=connected/.test((await follow(app, next, { cookie: session.cookie })).headers.get('location') ?? ''));
    assert.equal(await accountRow(slice, IG_A), null);
  });
});

// ---- auth-3 and auth-6: operator changes end operator sessions ---------------------------------------------------------------------

describe('auth-3 and auth-6 corners', () => {
  const world = useBillingWorld();
  const opId = async (op) => (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [op.email])).id;
  const open = async (session) => need(await session.call('GET', '/products'), 200, 'The session');
  const ended = async (session) => assert.equal((await session.call('GET', '/products')).status, 401);

  test('turning one operator off leaves another operator\'s session in the same business alone', async () => {
    const shop = await shopOn(world, 't3');
    const admin = await consoleUser(world);
    const leaving = await consoleUser(world, 'support');
    const staying = await consoleUser(world, 'support');
    const a = await impersonate(world, shop, leaving);
    const b = await impersonate(world, shop, staying);
    await open(a);
    await open(b);
    need(await opCall(world, admin, 'PATCH', `/team/${await opId(leaving)}`, { disabled: true, reason: 'left' }), 200, 'Turning one off');
    await ended(a);
    await open(b);
  });

  test('turning an operator back on does not revive the sessions that ended, and a disabled operator cannot start a new one', async () => {
    const shop = await shopOn(world, 't3');
    const admin = await consoleUser(world);
    const op = await consoleUser(world, 'support');
    const session = await impersonate(world, shop, op);
    await open(session);
    need(await opCall(world, admin, 'PATCH', `/team/${await opId(op)}`, { disabled: true, reason: 'off' }), 200, 'Off');
    const whileOff = await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'sneaking' });
    assert.ok(whileOff.status >= 400 && whileOff.status < 500, `a disabled operator started an impersonation: ${whileOff.status}`);
    need(await opCall(world, admin, 'PATCH', `/team/${await opId(op)}`, { disabled: false, reason: 'back' }), 200, 'On again');
    await ended(session);
  });

  test('a support operator cannot disable or change anyone, and the session of an operator they tried to change keeps working', async () => {
    const shop = await shopOn(world, 't3');
    const support = await consoleUser(world, 'support');
    const target = await consoleUser(world, 'support');
    const session = await impersonate(world, shop, target);
    const tried = await opCall(world, support, 'PATCH', `/team/${await opId(target)}`, { disabled: true, reason: 'nope' });
    assert.ok(tried.status === 403 || tried.status === 401, `a support operator changed the team: ${tried.status}`);
    await open(session);
  });

  test('impersonating a business with every owner removed, or one that does not exist, is refused cleanly', async () => {
    const shop = await shopOn(world, 't3');
    await sql(world, `UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
    const op = await consoleUser(world, 'support');
    const none = await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, { reason: 'no owner left' });
    assert.ok(none.status >= 400 && none.status < 500, `answered ${none.status}`);
    assert.equal((await sql(world, 'SELECT 1 FROM impersonation_sessions WHERE tenant_id = $1', [shop.tenantId])).length, 0, 'a session was opened with no owner');
    const missing = await opCall(world, op, 'POST', '/tenants/99999999/impersonate', { reason: 'no such business' });
    assert.ok(missing.status === 404 || missing.status === 400, `answered ${missing.status}`);
    const noReason = await opCall(world, op, 'POST', `/tenants/${shop.tenantId}/impersonate`, {});
    assert.ok(noReason.status >= 400 && noReason.status < 500, `an impersonation without a reason answered ${noReason.status}`);
  });

  test('impersonation picks the oldest owner still on the team even when owners are removed in between', async () => {
    const shop = await shopOn(world, 't3');
    const [first] = await sql(world, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY id LIMIT 1`, [shop.tenantId]);
    const mk = async (n) => (await sql(world, `INSERT INTO users (tenant_id, name, phone, role, password_hash) VALUES ($1, $2, $3, 'owner', '!') RETURNING id`, [shop.tenantId, `Owner ${n}`, `+9197${crypto.randomInt(10_000_000, 99_999_999)}`]))[0];
    const second = await mk(2);
    const third = await mk(3);
    await sql(world, 'UPDATE users SET removed_at = now() WHERE id = ANY($1)', [[first.id, second.id]]);
    const op = await consoleUser(world, 'support');
    const session = await impersonate(world, shop, op);
    const row = await one(world, 'SELECT owner_user_id FROM impersonation_sessions WHERE id = $1', [session.started.session.id]);
    assert.equal(Number(row.owner_user_id), Number(third.id));
    await open(session);
  });
});

// ---- auth-8: the console sign-in ticket ------------------------------------------------------------------------------------------------

describe('auth-8 corners', () => {
  const world = useBillingWorld();
  const ip = () => `198.51.${crypto.randomInt(0, 255)}.${crypto.randomInt(1, 250)}`;
  const post = (path, body, from) => hit(world, path, { host: CONSOLE_HOST, method: 'POST', body, headers: { 'x-forwarded-for': from } });
  async function ticketFor(email, from) {
    assert.equal((await post('/sign-in/code', { email }, from)).status, 204);
    const last = (await world.mail.get('/sent')).sent.filter((m) => m.to.includes(email)).at(-1);
    const code = /(?<!\d)(\d{6})(?!\d)/.exec(`${last.text}${last.html}`)?.[1];
    return json(need(await post('/sign-in/verify', { email, code }, from), 200, 'The emailed code'));
  }
  const newOperator = async () => {
    const email = `cor${unique()}@team.example`.toLowerCase();
    await world.platform.platformUsers.create({ email, password: 'console-pass-1', role: 'support', name: 'Meera' });
    return email;
  };

  test('a forged, empty or malformed ticket never signs in, and a spent ticket cannot be used again', async () => {
    const from = ip();
    for (const ticket of ['', 'forged', 'x'.repeat(500), null, 7]) {
      const res = await post('/sign-in/totp', { ticket, code: '123456' }, from);
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(ticket)} answered ${res.status}`);
    }
    const email = await newOperator();
    const t = await ticketFor(email, from);
    need(await post('/sign-in/totp', { ticket: t.ticket, code: totp(t.enrol.secret) }, from), 200, 'Signing in');
    const again = await post('/sign-in/totp', { ticket: t.ticket, code: totp(t.enrol.secret, Date.now() + 30_000) }, from);
    assert.ok(again.status >= 400, `a spent ticket signed in again: ${again.status}`);
  });

  test('wrong TOTP tries on one ticket do not use up another operator\'s ticket from the same address', async () => {
    const from = ip();
    const [a, b] = [await newOperator(), await newOperator()];
    const ta = await ticketFor(a, from);
    const tb = await ticketFor(b, from);
    const wrong = totp(ta.enrol.secret) === '000000' ? '000001' : '000000';
    await Promise.all(Array.from({ length: 6 }, () => post('/sign-in/totp', { ticket: ta.ticket, code: wrong }, from)));
    need(await post('/sign-in/totp', { ticket: tb.ticket, code: totp(tb.enrol.secret) }, from), 200, 'The other operator signing in');
  });

  test('a ticket belongs to one email: the right code for another operator\'s secret does not open it', async () => {
    const from = ip();
    const [a, b] = [await newOperator(), await newOperator()];
    const ta = await ticketFor(a, from);
    const tb = await ticketFor(b, from);
    const res = await post('/sign-in/totp', { ticket: ta.ticket, code: totp(tb.enrol.secret) }, from);
    assert.ok(res.status >= 400, `another operator's code opened the ticket: ${res.status}`);
  });
});
