// seller-ui-9: "Sign in instead" on the lock screen signs the locked session out through the one sign-out path
// (apps/owner/src/shell/sign-out.js), not by emptying SecureStore and starting again. Here, the session's side of it: signOut
// from a locked session reads no refresh token and sends nothing (F-110, P-68), and still runs the 'signedOut' listeners
// that drop the owner app's query cache and saved rows. The wiring is read by medium-ui.test.js and rendered by
// apps/owner/spec/unlock.test.js.
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

test('seller-ui-9: signing out of a locked session reads no refresh token, sends nothing, and runs the signedOut listeners', async () => {
  const { server, store, session } = await lockedSession();
  const heard = [];
  session.on('signedOut', (reason) => heard.push(reason));
  // What apps/owner/src/shell/sign-out.js does for a locked session: no push unregister (there is no token), then signOut.
  await session.signOut({ reason: 'signed_out', requireServer: false });
  assert.deepEqual(server.calls, [], 'the refresh token is read only after an unlock (F-110, P-68)');
  assert.deepEqual(heard, ['signed_out'], 'the signedOut listeners ran (the query cache and every business’s saved rows)');
  assert.equal(session.getState().status, SESSION_STATUS.signedOut);
  assert.equal(await store.getRefreshToken(), null);
  assert.equal(await store.isLockEnabled(), false);
  assert.equal(await store.getSnapshot(), null);
});

test('seller-ui-9: session.start() on an emptied store, the old lock-screen path, never told the listeners (why the fix goes through signOut)', async () => {
  const { store, session } = await lockedSession();
  const heard = [];
  session.on('signedOut', (reason) => heard.push(reason));
  await store.clearSession();
  await session.start();
  assert.equal(session.getState().status, SESSION_STATUS.signedOut);
  assert.deepEqual(heard, [], 'no signedOut event: the query cache and saved rows would stay');
});
