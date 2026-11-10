// The login adapter: Instagram Login and Unified Login behind one interface, chosen by config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { INSTAGRAM_SCOPES, createFacebookLogin, createInstagramLogin, createLoginAdapter, createMetaAdapters, createMetaClient, createUnifiedLogin } from '../../../src/adapters/meta/index.js';

const REDIRECT = 'http://127.0.0.1:9/callback';
const DAY = 86_400_000;

async function withSim(options, run) {
  const meta = createMeta(options);
  await meta.start();
  try {
    await run(meta);
  } finally {
    await meta.close();
  }
}

const igConfig = (meta) => ({ graphBaseUrl: meta.url, igAppId: 'sim-app', appSecret: 'sim-app-secret' });
const fbConfig = (meta) => ({ graphBaseUrl: meta.url, fbAppId: 'sim-fb-app', fbAppSecret: 'sim-fb-app-secret', metaLogin: 'unified' });

async function consent(url) {
  const res = await fetch(url, { redirect: 'manual' });
  assert.equal(res.status, 302, await res.clone().text());
  return new URL(res.headers.get('location'));
}

test('config picks the login, and an unknown value is refused', () => {
  assert.equal(createLoginAdapter({}).kind, 'instagram');
  assert.equal(createLoginAdapter({ metaLogin: 'instagram' }).kind, 'instagram');
  assert.equal(createLoginAdapter({ metaLogin: 'unified' }).kind, 'unified');
  assert.throws(() => createLoginAdapter({ metaLogin: 'twitter' }), /META_LOGIN/);
  assert.equal(createMetaAdapters({ metaLogin: 'unified' }).login.kind, 'unified');
});

test('both logins have the same interface', () => {
  for (const login of [createInstagramLogin({}), createUnifiedLogin({})]) {
    assert.deepEqual(['authorizeUrl', 'connect', 'refresh'].map((name) => typeof login[name]), ['function', 'function', 'function'], login.kind);
    assert.deepEqual([...login.scopes], [...INSTAGRAM_SCOPES]);
  }
});

test('a login without its app id says so before sending anyone to Meta', () => {
  assert.throws(() => createInstagramLogin({}).authorizeUrl({ state: 's', redirectUri: REDIRECT }), /app id/);
  assert.throws(() => createUnifiedLogin({}).authorizeUrl({ state: 's', redirectUri: REDIRECT }), /app id/);
});

test('publishing is never requested', () => {
  assert.equal(INSTAGRAM_SCOPES.some((s) => /publish/.test(s)), false);
  const url = new URL(createInstagramLogin({ igAppId: 'a', appSecret: 'b' }).authorizeUrl({ state: 'st', redirectUri: REDIRECT }));
  assert.equal(url.origin, 'https://www.instagram.com');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.doesNotMatch(url.searchParams.get('scope'), /publish/);
});

test('Instagram Login: consent to a stored connection', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop', appScopedId: '9999' });
    const login = createInstagramLogin(igConfig(meta));
    const back = await consent(login.authorizeUrl({ state: 'st-1', redirectUri: REDIRECT }));
    assert.equal(back.searchParams.get('state'), 'st-1');

    const connection = await login.connect({ code: `${back.searchParams.get('code')}#_`, redirectUri: REDIRECT });
    assert.equal(connection.igUserId, '1784');
    assert.equal(connection.appScopedId, '9999');
    assert.equal(connection.username, 'shop');
    assert.equal(connection.loginKind, 'instagram');
    assert.deepEqual(connection.scopes, [...INSTAGRAM_SCOPES]);
    assert.ok(connection.expiresAt instanceof Date);
    assert.ok(connection.expiresAt.getTime() > Date.now() + 50 * DAY);

    const client = createMetaClient(igConfig(meta));
    assert.equal((await client.forAccount({ igUserId: connection.igUserId, token: connection.token }).getAccount()).username, 'shop');
  });
});

test('Instagram Login: the flat answer shape works too', async () => {
  await withSim({ app: { oauthShape: 'flat' } }, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    const login = createInstagramLogin(igConfig(meta));
    const back = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    assert.equal((await login.connect({ code: back.searchParams.get('code'), redirectUri: REDIRECT })).igUserId, '1784');
  });
});

test('Instagram Login: partial consent reports only what was granted', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    const granted = INSTAGRAM_SCOPES.filter((s) => !/insights/.test(s));
    await meta.post('/oauth/next', { igUserId: '1784', scopes: granted });
    const login = createInstagramLogin(igConfig(meta));
    const back = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    assert.deepEqual((await login.connect({ code: back.searchParams.get('code'), redirectUri: REDIRECT })).scopes, granted);
  });
});

test('Instagram Login: a used code is refused, and no error shows the secret', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    const login = createInstagramLogin(igConfig(meta));
    const back = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    const code = back.searchParams.get('code');
    await login.connect({ code, redirectUri: REDIRECT });
    await assert.rejects(() => login.connect({ code, redirectUri: REDIRECT }), (err) => err.kind === 'oauth' && !err.message.includes('sim-app-secret'));
  });
});

test('Instagram Login: a token refreshes once it is a day old', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop', token: 'first-token' });
    const login = createInstagramLogin(igConfig(meta));
    await assert.rejects(() => login.refresh('first-token'), (err) => err.code === 100);
    await meta.post('/clock', { advanceMs: DAY + 1000 });
    const fresh = await login.refresh('first-token');
    assert.notEqual(fresh.token, 'first-token');
    assert.ok(fresh.expiresAt instanceof Date);
  });
});

test('Unified Login: consent to a stored connection, on graph.facebook.com\'s route and with the same scope names', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    await meta.post('/pages', { pageId: '55', name: 'Shop Page', igUserId: '1784' });
    await meta.post('/pages', { pageId: '56', name: 'No Instagram' });
    const login = createUnifiedLogin(fbConfig(meta));
    const authorize = new URL(login.authorizeUrl({ state: 'u1', redirectUri: REDIRECT }));
    assert.match(authorize.pathname, /\/v23\.0\/dialog\/oauth$/);
    const back = await consent(authorize.href);

    const connection = await login.connect({ code: back.searchParams.get('code'), redirectUri: REDIRECT });
    assert.equal(connection.igUserId, '1784');
    assert.equal(connection.pageId, '55');
    assert.equal(connection.loginKind, 'unified');
    assert.equal(connection.expiresAt, null);
    assert.deepEqual([...connection.scopes].sort(), [...INSTAGRAM_SCOPES].sort());

    const account = { igUserId: connection.igUserId, token: connection.token, loginKind: connection.loginKind };
    const client = createMetaClient(fbConfig(meta));
    assert.equal((await client.forAccount(account).getAccount()).username, 'shop');
    await meta.post('/messages', { igUserId: '1784', from: '42', text: 'hi', deliver: false });
    assert.ok((await client.sender(account).dm('42', { text: 'hello' })).messageId);
    assert.deepEqual(await login.refresh(connection.token), { token: connection.token, expiresAt: null });
  });
});

test('Unified Login: a person with no linked Instagram account is told, and a named account is honoured', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/pages', { pageId: '56', name: 'No Instagram' });
    const login = createUnifiedLogin(fbConfig(meta));
    const none = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    await assert.rejects(() => login.connect({ code: none.searchParams.get('code'), redirectUri: REDIRECT }), /No Facebook Page/);

    await meta.post('/accounts', { igUserId: '1', username: 'one' });
    await meta.post('/accounts', { igUserId: '2', username: 'two' });
    await meta.post('/pages', { pageId: '61', igUserId: '1' });
    await meta.post('/pages', { pageId: '62', igUserId: '2' });
    const back = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    assert.equal((await login.connect({ code: back.searchParams.get('code'), redirectUri: REDIRECT, igUserId: '2' })).pageId, '62');
  });
});

test('Facebook Pages: consent lists the Pages shared, each with its own token', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    await meta.post('/pages', { pageId: '55', name: 'Shop Page', igUserId: '1784' });
    await meta.post('/pages', { pageId: '56', name: 'Other' });
    await meta.post('/facebook/login-next', { pageIds: ['55'] });
    const login = createFacebookLogin(fbConfig(meta));
    const back = await consent(login.authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    const { pages, scopes } = await login.connect({ code: back.searchParams.get('code'), redirectUri: REDIRECT });
    assert.deepEqual(pages.map((p) => [p.pageId, p.name, p.igUserId]), [['55', 'Shop Page', '1784']]);
    assert.ok(pages[0].token);
    assert.ok(scopes.includes('pages_messaging'));
  });
});

test('a refused consent redirects with the error and no code', async () => {
  await withSim({}, async (meta) => {
    await meta.post('/accounts', { igUserId: '1784', username: 'shop' });
    await meta.post('/oauth/next', { deny: true });
    const back = await consent(createInstagramLogin(igConfig(meta)).authorizeUrl({ state: 's', redirectUri: REDIRECT }));
    assert.equal(back.searchParams.get('error'), 'access_denied');
    assert.equal(back.searchParams.get('code'), null);
  });
});
