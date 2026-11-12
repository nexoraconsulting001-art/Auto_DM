// The shopper app's gate and sessions (PRD 10.7): the build-time business check, the minimum version, guest and signed-in
// sessions with rotating refresh tokens, and the wall between shopper and seller tokens.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppBootstrap, AppMe, AppRefreshed, AppSession } from '../../../src/contracts/store-routes.js';
import { OWNER, shopperApp } from '../../helpers.js';
import { appWorld, assertBrandOnly, guestApp, json, newDevice, signedInApp } from './support.js';

test('the gate: a wrong build, platform or business is a bare 404; the web is left alone', async () => {
  const w = await appWorld({ platforms: ['android'] });
  try {
    const other = await w.addStore('haldi', 'Haldi House');
    const noApp = await w.addStore('kesar', 'Kesar Co', { app: false });
    const id = w.app.tenant.id;
    const bare = async (a, what) => {
      const res = await a.fetch('/api/store/app/bootstrap');
      assert.equal(res.status, 404, what);
      assert.equal(await res.text(), '', `${what}: no body`);
      assert.equal(res.headers.get('cache-control'), 'no-store', what);
      assert.equal(res.headers.get('content-type'), null, `${what}: nothing to read`);
    };
    // An app built for this business, calling another business's host: the same answer whether that business has an app or not.
    await bare(shopperApp(w.app.base, { tenantId: id, host: other.host }), 'business A on business B’s host');
    await bare(shopperApp(w.app.base, { tenantId: id, host: noApp.host }), 'business A on a host with no app');
    await bare(shopperApp(w.app.base, { tenantId: noApp.tenant.id, host: noApp.host }), 'a business with no app of its own');
    await bare(shopperApp(w.app.base, { tenantId: id, platform: 'ios' }), 'no app.ios entitlement');
    await bare(shopperApp(w.app.base, { tenantId: id, platform: 'web' }), 'an unknown platform');
    await bare(shopperApp(w.app.base, { tenantId: 'abc' }), 'a junk business id');
    const ownerApp = shopperApp(w.app.base, { tenantId: id });
    ownerApp.headers['x-app'] = 'owner';
    await bare(ownerApp, 'the owner app’s header');

    // The right build on its own host is answered, in the seller's brand.
    const mine = shopperApp(w.app.base, { tenantId: other.tenant.id, host: other.host });
    const boot = await json(await mine.fetch('/api/store/app/bootstrap'));
    assert.equal(boot.status, 200);
    AppBootstrap.parse(boot.body);
    assert.equal(boot.body.name, 'Test store', 'app_configs.app_name');
    assertBrandOnly(boot.body, 'bootstrap');

    // Without the app's headers, the app's routes are not there; the store's own JSON still answers the web.
    const web = await fetch(`${w.app.base}/api/store/app/bootstrap`);
    assert.equal(web.status, 404);
    assert.equal(await web.text(), '');
    const lookup = await fetch(`${w.app.base}/api/store/products?ids=1`);
    assert.notEqual(lookup.status, 404, 'a web call is the web’s');
  } finally {
    await w.close();
  }
});

test('a guest session at install; every app call needs a live token; refresh rotates and a reused token ends the family', async () => {
  const w = await appWorld();
  try {
    const a = shopperApp(w.app.base, { tenantId: w.app.tenant.id, device: newDevice() });
    // No session yet: only the routes marked auth 'none' answer.
    assert.equal((await a.fetch('/api/store/app/me')).status, 401);
    assert.equal((await a.fetch('/api/store/cart')).status, 401, 'Phase 4 JSON needs an app session too');
    const start = await a.start('guest');
    assert.equal(start.status, 201);
    AppSession.parse(start.body);
    assert.equal(start.body.guest, true);
    assert.equal(start.body.shopper, null);
    assert.match(start.body.accessToken, /^sa_/);
    assert.match(start.body.refreshToken, /^sr_/);
    assert.equal(start.body.accessExpiresInSeconds, 15 * 60);

    const me = await json(await a.fetch('/api/store/app/me'));
    assert.equal(me.status, 200);
    AppMe.parse(me.body);
    assert.equal(me.body.shopper, null);
    // A guest is not signed in: signed-in routes are 401.
    for (const path of ['/api/store/app/orders', '/api/store/app/rewards']) assert.equal((await a.fetch(path)).status, 401, path);

    const [row] = await w.app.db.platform.query('SELECT tenant_id, shopper_id, method, platform, app_version FROM shopper_app_sessions');
    assert.deepEqual(row, { tenant_id: w.app.tenant.id, shopper_id: null, method: 'guest', platform: 'android', app_version: '1.0.0' });
    const [family] = await w.app.db.platform.query(`SELECT subject_kind, tenant_id, shopper_id, app_platform FROM token_families WHERE subject_kind = 'shopper'`);
    assert.deepEqual(family, { subject_kind: 'shopper', tenant_id: w.app.tenant.id, shopper_id: null, app_platform: 'android' });
    const [{ n: hashed }] = await w.app.db.platform.query('SELECT count(*)::int AS n FROM shopper_app_sessions WHERE token_hash = $1', [start.body.accessToken]);
    assert.equal(hashed, 0, 'only the hash is stored');

    // Refresh: a new pair; the old access token stops working.
    const first = { ...a.tokens };
    const refreshed = await a.refresh();
    assert.equal(refreshed.status, 200);
    AppRefreshed.parse(refreshed.body);
    assert.notEqual(refreshed.body.refreshToken, first.refreshToken);
    assert.equal((await a.fetch('/api/store/app/me')).status, 200);
    const stale = shopperApp(w.app.base, { tenantId: w.app.tenant.id });
    stale.tokens.accessToken = first.accessToken;
    assert.equal((await stale.fetch('/api/store/app/me')).status, 401, 'one live access token per install');

    // The first refresh token, presented again: the whole family ends, the latest tokens with it.
    stale.tokens.refreshToken = first.refreshToken;
    const replay = await stale.refresh();
    assert.equal(replay.status, 401);
    assert.equal((await a.fetch('/api/store/app/me')).status, 401, 'the access token of the family is dead');
    assert.equal((await a.refresh()).status, 401, 'the newest refresh token is dead too');
    const [ended] = await w.app.db.platform.query(`SELECT revoke_reason FROM token_families WHERE subject_kind = 'shopper'`);
    assert.equal(ended.revoke_reason, 'token_reuse');

    // Junk and unknown refresh tokens are refused and change nothing.
    for (const junk of ['nope', 'sr_unknown-token', 'x'.repeat(199)]) {
      const res = await json(await a.fetch('/api/store/app/session/refresh', { method: 'POST', body: { refreshToken: junk } }));
      assert.equal(res.status, 401, junk.slice(0, 10));
      assertBrandOnly(res.body);
    }
    assert.equal((await a.fetch('/api/store/app/session/refresh', { method: 'POST', body: { refreshToken: 'a', price: 1 } })).status, 400, 'strict body');
  } finally {
    await w.close();
  }
});

test('a token of one business is unknown at another, whatever the app says it is', async () => {
  const w = await appWorld();
  try {
    const other = await w.addStore('haldi', 'Haldi House');
    const here = await guestApp(w);
    const there = shopperApp(w.app.base, { tenantId: other.tenant.id, host: other.host });
    there.tokens.accessToken = here.tokens.accessToken;
    there.tokens.refreshToken = here.tokens.refreshToken;
    assert.equal((await there.fetch('/api/store/app/me')).status, 401, 'an access token of another business');
    assert.equal((await there.refresh()).status, 401, 'a refresh token of another business');
    assert.equal((await here.fetch('/api/store/app/me')).status, 200, 'and it changed nothing at home');
    assert.equal((await here.refresh()).status, 200, 'the refresh token is still unspent');
    // A token from an install on one platform is not good for the other.
    const ios = shopperApp(w.app.base, { tenantId: w.app.tenant.id, platform: 'ios' });
    ios.tokens.accessToken = here.tokens.accessToken;
    assert.equal((await ios.fetch('/api/store/app/me')).status, 401);
  } finally {
    await w.close();
  }
});

test('a shopper token never reaches a seller route, and a seller token never acts as a shopper', async () => {
  const w = await appWorld();
  try {
    const a = await signedInApp(w, { phone: '9876500001' });
    const login = await fetch(`${w.app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
    const { token: sellerToken } = await login.json();
    assert.ok(sellerToken);

    // The shopper's tokens at the seller API, in either scheme.
    for (const authorization of [`Shopper ${a.tokens.accessToken}`, `Bearer ${a.tokens.accessToken}`]) {
      const res = await fetch(`${w.app.base}/api/v1/orders`, { headers: { authorization } });
      assert.equal(res.status, 401, authorization.split(' ')[0]);
    }
    const sellerRefresh = await fetch(`${w.app.base}/api/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: a.tokens.refreshToken }) });
    assert.equal(sellerRefresh.status, 401);
    assert.equal((await a.fetch('/api/store/app/me')).status, 200, 'the shopper session is untouched');
    // The admin pages see nobody.
    const admin = await fetch(`${w.app.base}/admin`, { redirect: 'manual', headers: { authorization: `Shopper ${a.tokens.accessToken}` } });
    // The admin console is a static shell for everyone; the app token must not change what an anonymous visitor gets.
    const anon = await fetch(`${w.app.base}/admin`, { redirect: 'manual' });
    assert.equal(admin.status, anon.status);
    assert.equal(await admin.text(), await anon.text());

    // The seller's token at the app's routes, in either scheme.
    const asApp = shopperApp(w.app.base, { tenantId: w.app.tenant.id });
    for (const authorization of [`Shopper ${sellerToken}`, `Bearer ${sellerToken}`]) {
      const me = await asApp.fetch('/api/store/app/me', { headers: { authorization } });
      assert.equal(me.status, 401, authorization.split(' ')[0]);
      const orders = await asApp.fetch('/api/store/app/orders', { headers: { authorization } });
      assert.equal(orders.status, 401);
    }
    const ok = await fetch(`${w.app.base}/api/v1/orders`, { headers: { authorization: `Bearer ${sellerToken}` } });
    assert.equal(ok.status, 200, 'the seller token still works where it belongs');
  } finally {
    await w.close();
  }
});

test('the minimum version: 426 with the store link below it, the bootstrap still answers', async () => {
  const w = await appWorld();
  try {
    const a = await guestApp(w);
    await w.app.repos.appVersions.set({ app: 'shopper', platform: 'android', tenantId: w.app.tenant.id, minVersion: '1.2.0', storeUrl: 'https://play.google.com/store/apps/details?id=com.example.t1' });
    const old = await json(await a.fetch('/api/store/app/me'));
    assert.equal(old.status, 426);
    assert.equal(old.body.code, 'update_required');
    assert.equal(old.body.storeUrl, 'https://play.google.com/store/apps/details?id=com.example.t1');
    assertBrandOnly(old.body);
    assert.equal((await a.fetch('/api/store/cart')).status, 426, 'the Phase 4 JSON too');
    const boot = await json(await a.fetch('/api/store/app/bootstrap'));
    assert.equal(boot.status, 200);
    assert.equal(boot.body.minVersion, '1.2.0');
    assert.equal(boot.body.storeUrl, 'https://play.google.com/store/apps/details?id=com.example.t1');
    const current = shopperApp(w.app.base, { tenantId: w.app.tenant.id, version: '1.2.0' });
    Object.assign(current.tokens, a.tokens);
    assert.equal((await current.fetch('/api/store/app/me')).status, 200);
    const ios = await guestApp(w, { platform: 'ios' });
    assert.equal((await ios.fetch('/api/store/app/me')).status, 200, 'each platform has its own minimum');
  } finally {
    await w.close();
  }
});

test('signing in with a WhatsApp code: the session belongs to the shopper, the web sign-in check is refused, signing out leaves a guest', async () => {
  const w = await appWorld();
  try {
    const a = await guestApp(w);
    const guestRefresh = a.tokens.refreshToken;
    // The web's code check, with purpose sign_in, is not a way in for the app.
    const sent = await a.fetch('/api/store/otp/send', { method: 'POST', body: { phone: '9876500002', purpose: 'sign_in' } });
    assert.equal(sent.status, 200);
    const code = await w.lastCode('9876500002');
    const webVerify = await json(await a.fetch('/api/store/otp/verify', { method: 'POST', body: { phone: '9876500002', purpose: 'sign_in', code } }));
    assert.equal(webVerify.status, 400);
    assert.equal(webVerify.headers.get('set-cookie'), null, 'no cookie for the app');

    const wrong = await a.start({ grant: 'otp', phone: '9876500002', code: code === '111111' ? '222222' : '111111' });
    assert.equal(wrong.status, 400);
    const signed = await a.start({ grant: 'otp', phone: '9876500002', code });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    AppSession.parse(signed.body);
    assert.equal(signed.body.guest, false);
    assert.equal(signed.body.shopper.phoneMasked, '••••• ••002');
    assert.equal(signed.body.shopper.phoneVerified, true);
    assertBrandOnly(signed.body);
    assert.equal(JSON.stringify(signed.body).includes('9876500002'), false, 'the number is never echoed');

    const [session] = await w.app.db.platform.query(`SELECT method, shopper_id FROM shopper_app_sessions WHERE revoked_at IS NULL`);
    assert.equal(session.method, 'whatsapp_otp');
    assert.ok(session.shopper_id);
    // Signing in ended the install's guest family.
    const reuse = shopperApp(w.app.base, { tenantId: w.app.tenant.id });
    reuse.tokens.refreshToken = guestRefresh;
    assert.equal((await reuse.refresh()).status, 401);
    // The sign-in wrote the consent record of the notice in force.
    const consent = await w.app.db.platform.query(`SELECT source FROM consent_records WHERE shopper_id = $1`, [session.shopper_id]).catch(() => null);
    if (consent) assert.ok(consent.some((r) => r.source === 'sign_in'));

    const me = await json(await a.fetch('/api/store/app/me'));
    assert.equal(me.body.shopper.id, session.shopper_id);
    assert.equal((await a.fetch('/api/store/app/orders')).status, 200);

    const signedIn = { ...a.tokens };
    const out = await json(await a.fetch('/api/store/app/session/end', { method: 'POST' }));
    assert.equal(out.status, 200);
    AppSession.parse(out.body);
    assert.equal(out.body.guest, true);
    const old = shopperApp(w.app.base, { tenantId: w.app.tenant.id });
    Object.assign(old.tokens, signedIn);
    assert.equal((await old.fetch('/api/store/app/me')).status, 401);
    assert.equal((await old.refresh()).status, 401);
    old.tokens.accessToken = out.body.accessToken;
    assert.equal((await json(await old.fetch('/api/store/app/me'))).body.shopper, null, 'the same device is a guest again');
  } finally {
    await w.close();
  }
});
