// seller-ui-9: "Sign in instead" on the lock screen signs the locked session out through the one sign-out path
// (apps/owner/src/shell/sign-out.js: releaseForSignOut, then the push unregister, then signOut). Here, the session's side of
// it: from a locked session the server hears the sign-out and the push unregister, nothing is loaded on the way, and the
// 'signedOut' listeners (the owner app's query cache and saved rows) run. sign-out.js itself is read by medium-ui.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_STATUS, createSession } from '../../../packages/app-core/src/session.js';

const BASE = 'http://localhost:9/api/v1';
const APP = { name: 'owner', version: '1.4.0', platform: 'android' };
const DEVICE = 'device-0000000000000001';
const USER = { id: 7, name: 'Asha', role: 'owner', permissions: [] };
const SHOP = { id: 1, slug: 'a', name: 'Shop A', plan: 't3', logoUrl: '', accountType: 'seller' };
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function memoryStore() {
  const held = new Map();
  const get = async (k) => held.get(k) ?? null;
  const put = async (k, v) => (v === null || v === undefined || v === '' ? held.delete(k) : held.set(k, String(v)));
  return {
    held,
    getRefreshToken: () => get('refresh'), setRefreshToken: (v) => put('refresh', v),
    getDeviceSecret: () => get('device_secret'), setDeviceSecret: (v) => put('device_secret', v),
    isLockEnabled: async () => (await get('lock')) === '1', setLockEnabled: (on) => put('lock', on ? '1' : null),
    getTenantId: async () => Number(await get('tenant')) || null, setTenantId: (v) => put('tenant', v),
    getSnapshot: async () => JSON.parse((await get('snapshot')) ?? 'null'), setSnapshot: (v) => put('snapshot', v ? JSON.stringify(v) : null),
    getDeviceId: async () => DEVICE,
    clearSession: async () => ['refresh', 'device_secret', 'lock', 'lock_offered', 'tenant', 'snapshot'].forEach((k) => held.delete(k)),
  };
}

function fakeServer() {
  const server = { calls: [], family: 'alive', refresh: 'r1', access: new Set(['a1']), count: 1, down: false };
  server.fetch = async (url, init = {}) => {
    const p = String(url).replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const token = init.headers?.authorization?.replace('Bearer ', '') ?? null;
    server.calls.push({ method: init.method ?? 'GET', path: p, token });
    if (server.down) throw new TypeError('Network request failed');
    if (p === '/auth/refresh') {
      if (server.family !== 'alive' || body.refreshToken !== server.refresh) return json(401, { error: 'Sign in again', code: 'unauthorized' });
      server.count++;
      server.refresh = `r${server.count}`;
      server.access = new Set([`a${server.count}`]);
      return json(201, { accessToken: `a${server.count}`, accessExpiresInSeconds: 900, refreshToken: server.refresh });
    }
    if (!token || !server.access.has(token)) return json(401, { error: 'Sign in again', code: 'unauthorized' });
    if (p === '/auth/logout') {
      server.family = 'revoked';
      server.access.clear();
      return json(204, null);
    }
    if (p === `/push/devices/${DEVICE}`) return json(204, null);
    if (p === '/auth/me') return json(200, { user: USER, business: SHOP, freshUntil: null });
    if (p === '/auth/businesses') return json(200, { businesses: [{ id: 1, slug: 'a', name: 'Shop A', role: 'owner', logoUrl: '', current: true }] });
    return json(404, { error: 'Not found', code: 'not_found' });
  };
  return server;
}

/** Signed in once with the lock on, then the app opened again: locked, the refresh token not yet read. */
async function lockedSession() {
  const server = fakeServer();
  const store = memoryStore();
  const first = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
  await first.adopt({ user: USER, business: SHOP, businesses: [], accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' });
  await store.setLockEnabled(true);
  const session = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
  await session.start();
  assert.equal(session.getState().status, SESSION_STATUS.locked);
  server.calls.length = 0;
  return { server, store, session };
}

/** What apps/owner/src/shell/sign-out.js does, in its order (unregisterFromPush is api.push.unregister, its errors swallowed). */
async function signOutEverywhere({ session, store, requireServer }) {
  await session.releaseForSignOut({ requireServer });
  await session.api.push.unregister(await store.getDeviceId()).catch(() => false);
  await session.signOut({ reason: 'signed_out', requireServer });
}

test('seller-ui-9: signing out of a locked session ends it on the server, stops the push, and runs the signedOut listeners', async () => {
  const { server, store, session } = await lockedSession();
  const heard = [];
  session.on('signedOut', (reason) => heard.push(reason));

  assert.equal(typeof session.releaseForSignOut, 'function');
  await session.releaseForSignOut({ requireServer: false });
  assert.equal(session.getState().status, SESSION_STATUS.locked, 'released only for the sign-out: still locked');
  assert.equal(server.calls.some((c) => c.path === '/auth/me'), false, 'nothing of the business is loaded');

  await session.api.push.unregister(DEVICE);
  await session.signOut({ reason: 'signed_out', requireServer: false });
  const paths = server.calls.map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /auth/refresh', `DELETE /push/devices/${DEVICE}`, 'POST /auth/logout']);
  assert.ok(server.calls.slice(1).every((c) => c.token), 'the unregister and the logout carry the released token');
  assert.equal(server.family, 'revoked', 'the server ended the session');
  assert.deepEqual(heard, ['signed_out'], 'the signedOut listeners ran (query cache and saved rows)');
  assert.equal(session.getState().status, SESSION_STATUS.signedOut);
  assert.equal(await store.getRefreshToken(), null);
  assert.equal(await store.isLockEnabled(), false);
});

test('seller-ui-9: with no connection, "Sign in instead" still forgets everything here (requireServer false), and never loads anything', async () => {
  const { server, store, session } = await lockedSession();
  const heard = [];
  session.on('signedOut', (reason) => heard.push(reason));
  server.down = true;
  await signOutEverywhere({ session, store, requireServer: false });
  assert.deepEqual(heard, ['signed_out']);
  assert.equal(session.getState().status, SESSION_STATUS.signedOut);
  assert.equal(await store.getRefreshToken(), null);
  assert.equal(server.calls.some((c) => c.path === '/auth/me'), false);
});

test('seller-ui-9: releaseForSignOut does nothing to a session that is not locked', async () => {
  const server = fakeServer();
  const store = memoryStore();
  const session = createSession({ baseUrl: BASE, app: APP, store, fetch: server.fetch });
  await session.adopt({ user: USER, business: SHOP, businesses: [], accessToken: 'a1', accessExpiresInSeconds: 900, refreshToken: 'r1' });
  server.calls.length = 0;
  assert.equal(await session.releaseForSignOut({ requireServer: true }), false);
  assert.deepEqual(server.calls, [], 'a signed-in session already has its token');
});
