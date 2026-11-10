// Signing in, signing out and changing a password through /api/v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER } from '../../helpers.js';
import { bearer, capturingLogs, jsonRequest, ok, refused, secondBusiness, withApp } from './support.js';

const owner2 = { name: 'Second Owner', phone: '9000000002', password: 'first-pass', role: 'owner' };
const CHANGE = '/api/v1/auth/password';
const change = (currentPassword, newPassword) => ({ currentPassword, newPassword });

async function cookieSession(app, who) {
  const res = await fetch(`${app.base}/api/v1/auth/login`, jsonRequest('POST', { ...who, transport: 'cookie' }));
  assert.equal(res.status, 201);
  const session = await res.json();
  return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: session.csrf };
}

test('an owner signs in with phone and password, sees the session and signs out', withApp(async (app) => {
  const { base, owner, api } = app;
  const me = await ok(await api('GET', '/auth/me'));
  assert.equal(me.user.role, 'owner');
  assert.equal(me.business.slug, 'default');
  assert.deepEqual(me.user.permissions, []);
  assert.equal((await api('POST', '/auth/logout')).status, 204);
  await refused(await fetch(`${base}/api/v1/auth/me`, { headers: bearer(owner) }), 401, 'unauthorized');
}));

test('wrong details are refused without saying which part was wrong', withApp(async ({ base }) => {
  const wrongPassword = await refused(await fetch(`${base}/api/v1/auth/login`, jsonRequest('POST', { phone: OWNER.phone, password: 'nope' })), 401, 'unauthorized');
  const noSuchUser = await refused(await fetch(`${base}/api/v1/auth/login`, jsonRequest('POST', { phone: '9111111111', password: 'nope' })), 401, 'unauthorized');
  assert.equal(wrongPassword.error, noSuchUser.error);
}));

test('changing a password with a token: the old token and password stop, the new ones work', withApp(async (app) => {
  await app.repos.users.create(owner2);
  const old = await app.signIn(owner2);
  const other = await app.signIn(owner2);
  const res = await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change(owner2.password, 'second-pass'), bearer(old)));
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await ok(res);
  assert.equal(body.expiresInDays, 30);
  assert.ok(body.token);
  assert.equal(body.csrf, undefined);

  for (const token of [old, other]) await refused(await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(token) }), 401, 'unauthorized');
  assert.equal((await ok(await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(body.token) }))).user.phone, owner2.phone);
  await refused(await fetch(`${app.base}/api/v1/auth/login`, jsonRequest('POST', { phone: owner2.phone, password: owner2.password })), 401, 'unauthorized');
  assert.ok(await app.signIn({ phone: owner2.phone, password: 'second-pass' }));
}));

test('changing a password in the console: the browser stays signed in on a fresh session', withApp(async (app) => {
  await app.repos.users.create(owner2);
  const { cookie, csrf } = await cookieSession(app, owner2);
  const noCsrf = await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change(owner2.password, 'second-pass'), { cookie }));
  await refused(noCsrf, 403, 'forbidden');
  assert.ok(await app.repos.users.verify(owner2.phone, owner2.password));

  const res = await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change(owner2.password, 'second-pass'), { cookie, 'x-csrf-token': csrf }));
  const fresh = res.headers.get('set-cookie').split(';')[0];
  const body = await ok(res);
  assert.ok(body.csrf);
  assert.notEqual(body.csrf, csrf);
  assert.equal(body.token, undefined);
  assert.notEqual(fresh, cookie);
  await refused(await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie } }), 401, 'unauthorized');
  assert.equal((await ok(await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie: fresh } }))).csrf, body.csrf);
}));

test('a wrong current password changes nothing, names the field, and counts toward the limit', withApp(async (app) => {
  await app.repos.users.create(owner2);
  const token = await app.signIn(owner2);
  const attempt = () => fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change('wrong', 'second-pass'), bearer(token)));
  const error = await refused(await attempt(), 400, 'validation_failed');
  assert.ok(error.fields.currentPassword);
  assert.ok(await app.repos.users.verify(owner2.phone, owner2.password));
  assert.equal((await ok(await fetch(`${app.base}/api/v1/auth/me`, { headers: bearer(token) }))).user.phone, owner2.phone);
  for (let i = 0; i < 9; i++) await attempt();
  await refused(await attempt(), 429, 'rate_limited');
}));

test('a password change is refused when signed out, when not JSON, and when the new one is unusable', withApp(async (app) => {
  await app.repos.users.create(owner2);
  const token = await app.signIn(owner2);
  const post = (body) => fetch(`${app.base}${CHANGE}`, jsonRequest('POST', body, bearer(token)));
  await refused(await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change('a', 'second-pass'))), 401, 'unauthorized');
  await refused(await fetch(`${app.base}${CHANGE}`, { method: 'POST', headers: bearer(token), body: new URLSearchParams(change(owner2.password, 'second-pass')) }), 415, 'unsupported_media_type');
  assert.ok((await refused(await post(change(owner2.password, 'short')), 400, 'validation_failed')).fields.newPassword);
  assert.ok((await refused(await post(change(owner2.password, 'x'.repeat(201))), 400, 'validation_failed')).fields.newPassword);
  assert.ok((await refused(await post({ newPassword: 'second-pass' }), 400, 'validation_failed')).fields.currentPassword);
  await refused(await post([]), 400, 'validation_failed');
  assert.ok(await app.repos.users.verify(owner2.phone, owner2.password));
}));

test('the owner set from .env cannot change the password here, because it would reset on restart', withApp(async ({ base, owner, repos }) => {
  const error = await refused(await fetch(`${base}${CHANGE}`, jsonRequest('POST', change(OWNER.password, 'second-pass'), bearer(owner))), 409, 'conflict');
  assert.match(error.error, /ADMIN_PASSWORD/);
  assert.ok(await repos.users.verify(OWNER.phone, OWNER.password));
}));

test('a shopper can change their own password too, and it does not touch another business\'s account on the same number', withApp(async (app) => {
  const shopper = { name: 'Asha K', phone: '9876543210', password: 'secret1' };
  await app.repos.users.create(shopper);
  const token = await app.signIn(shopper);
  const leaf = await secondBusiness(app);
  await leaf.repos.users.create(shopper);
  await ok(await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change(shopper.password, 'second-pass'), bearer(token))));
  assert.ok(await leaf.repos.users.verify(shopper.phone, shopper.password));
  assert.equal(await leaf.repos.users.verify(shopper.phone, 'second-pass'), null);
}));

test('a password change writes no phone or password to the logs', withApp(async (app) => {
  await app.repos.users.create(owner2);
  const token = await app.signIn(owner2);
  const lines = await capturingLogs(async () => {
    const { token: fresh } = await ok(await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change(owner2.password, 'second-pass'), bearer(token))));
    await refused(await fetch(`${app.base}${CHANGE}`, jsonRequest('POST', change('wrong-pass', 'third-pass'), bearer(fresh))), 400, 'validation_failed');
  });
  assert.ok(lines.some((l) => l.msg === 'auth.password_changed'));
  const written = JSON.stringify(lines);
  for (const secret of [owner2.phone, owner2.password, 'second-pass', 'third-pass', 'wrong-pass']) assert.ok(!written.includes(secret), secret);
}));
