import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { bindTenant } from '../../../src/repos/index.js';
import { NoTenantError } from '../../../src/tenancy.js';
import { createInstagram, forAccount } from '../../../src/instagram.js';
import { config } from '../../../src/config.js';
import { setLogSink } from '../../../src/platform/log.js';
import { tenantCommand } from '../../../scripts/tenant.js';
import { REEL_ID, seedReel, setup, startApp } from '../../helpers.js';

const sign = (body) => `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
const webhook = (app, body) => fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) }, body });
const comment = (igAccount, id) => JSON.stringify({ entry: [{ id: igAccount, changes: [{ field: 'comments', value: { id, text: 'LINK', media: { id: REEL_ID }, from: { id: 'u1', username: 'bob' } } }] }] });
const until = async (check) => {
  for (const end = Date.now() + 5000; !(await check()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
};

/** A local stand-in for the Instagram API that records what it was sent. */
function fakeGraph(respond = () => ({ id: 'x' })) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      const out = respond(req);
      res.statusCode = out.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.status ? out.body : out));
    });
  }).listen(0);
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

test('a token is stored encrypted and read back only by its own business', async () => {
  const { db, platform, repos, tenant } = await setup();
  await platform.tenants.linkIgAccount(tenant.id, 'IG-1', 'kesar');
  await repos.igAccounts.setToken('IG-1', 'IGQVJ-very-secret-token');

  const [row] = await db.query(`SELECT * FROM ig_accounts WHERE ig_user_id = 'IG-1'`);
  assert.doesNotMatch(JSON.stringify(row), /very-secret-token/);
  assert.match(row.access_token_enc, /^v1\./);

  assert.deepEqual(await repos.igAccounts.get('IG-1'), { igUserId: 'IG-1', username: 'kesar', token: 'IGQVJ-very-secret-token' });

  const other = bindTenant(platform, await platform.tenants.create({ slug: 'leaf', name: 'Leaf' }));
  assert.equal(await other.igAccounts.get('IG-1'), null);
  assert.equal(await other.igAccounts.current(), null);
  await assert.rejects(() => other.igAccounts.setToken('IG-1', 'stolen'), /not linked to this business/);
  assert.equal((await repos.igAccounts.get('IG-1')).token, 'IGQVJ-very-secret-token');
  await assert.rejects(() => platform.igAccounts.get('IG-1'), NoTenantError);
});

test('an account with no token is not connected, and an empty token is refused', async () => {
  const { platform, repos, tenant } = await setup();
  await platform.tenants.linkIgAccount(tenant.id, 'IG-1');
  assert.equal(await repos.igAccounts.current(), null);
  assert.equal((await repos.igAccounts.get('IG-1')).token, '');
  await assert.rejects(() => repos.igAccounts.setToken('IG-1', '  '), /token is required/);
});

test('current() is the account with the newest token', async () => {
  const { platform, repos, tenant } = await setup();
  await platform.tenants.linkIgAccount(tenant.id, 'IG-1');
  await platform.tenants.linkIgAccount(tenant.id, 'IG-2');
  await repos.igAccounts.setToken('IG-1', 'one');
  await new Promise((r) => setTimeout(r, 5));
  await repos.igAccounts.setToken('IG-2', 'two');
  assert.equal((await repos.igAccounts.current()).igUserId, 'IG-2');
});

test('the client sends each call with the account given, to the configured address', async () => {
  const graph = fakeGraph();
  try {
    const ig = createInstagram({ graphBaseUrl: graph.baseUrl, graphVersion: 'v99.0' });
    await ig.sendPrivateReply({ igUserId: 'A', token: 'token-a' }, 'c1', 'hello');
    await ig.sendPrivateReplyButton({ igUserId: 'B', token: 'token-b' }, 'c2', 'hi', 'https://x.test/r/y', 'A very long button title indeed');
    await ig.replyToComment({ igUserId: 'A', token: 'token-a' }, 'c3', 'thanks');
    assert.deepEqual(graph.seen.map((r) => [r.method, r.path.split('?')[0], r.auth]), [
      ['POST', '/v99.0/A/messages', 'Bearer token-a'],
      ['POST', '/v99.0/B/messages', 'Bearer token-b'],
      ['POST', '/v99.0/c3/replies', 'Bearer token-a'],
    ]);
    assert.deepEqual(graph.seen[0].body, { recipient: { comment_id: 'c1' }, message: { text: 'hello' } });
    assert.equal(graph.seen[1].body.message.attachment.payload.buttons[0].title, 'A very long button t');
    assert.ok(graph.seen.every((r) => !/token-/.test(r.path)), 'tokens never go in a URL');
  } finally {
    graph.close();
  }
});

test('the client refuses a call with no token, and takes no token from the environment', async () => {
  process.env.IG_ACCESS_TOKEN = 'leaked-global-token';
  try {
    const ig = createInstagram({ graphBaseUrl: 'http://127.0.0.1:9' });
    await assert.rejects(() => ig.sendPrivateReply({ igUserId: 'A', token: '' }, 'c1', 'x'), /no access token/);
    await assert.rejects(() => ig.sendPrivateReply(null, 'c1', 'x'), /no access token/);
    assert.equal('accessToken' in config, false);
    assert.equal('igUserId' in config, false);
  } finally {
    delete process.env.IG_ACCESS_TOKEN;
  }
});

test('an Instagram error carries the status and code, and no token', async () => {
  const graph = fakeGraph(() => ({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }));
  try {
    const ig = createInstagram({ graphBaseUrl: graph.baseUrl });
    await assert.rejects(() => ig.getAccount({ igUserId: 'A', token: 'sekret-token' }), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 100);
      assert.match(err.message, /Invalid parameter/);
      assert.doesNotMatch(err.message, /sekret-token/);
      return true;
    });
  } finally {
    graph.close();
  }
});

test('ids in API paths cannot climb out of their segment', async () => {
  const graph = fakeGraph();
  try {
    await createInstagram({ graphBaseUrl: graph.baseUrl }).getMedia({ igUserId: 'A', token: 't' }, '../../me/secrets');
    assert.equal(graph.seen[0].path.split('?')[0], '/v23.0/..%2F..%2Fme%2Fsecrets');
  } finally {
    graph.close();
  }
});

test('dry run sends nothing and logs ids only', async () => {
  const graph = fakeGraph();
  const lines = [];
  setLogSink((line) => lines.push(line));
  try {
    const ig = createInstagram({ graphBaseUrl: graph.baseUrl, dryRun: true });
    assert.deepEqual(await ig.sendPrivateReply({ igUserId: 'A', token: 't' }, 'c1', 'SECRET-MESSAGE'), { dryRun: true });
    await ig.sendPrivateReplyButton({ igUserId: 'A', token: 't' }, 'c2', 'SECRET-MESSAGE', 'https://x.test', 'Go');
    await ig.replyToComment({ igUserId: 'A', token: 't' }, 'c3', 'SECRET-MESSAGE');
    assert.equal(graph.seen.length, 0);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => !l.includes('SECRET-MESSAGE')));
  } finally {
    setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`));
    graph.close();
  }
});

test('forAccount fills in the account', async () => {
  const graph = fakeGraph();
  try {
    await forAccount(createInstagram({ graphBaseUrl: graph.baseUrl }), { igUserId: 'A', token: 'token-a' }).sendPrivateReply('c1', 'hi');
    assert.equal(graph.seen[0].auth, 'Bearer token-a');
  } finally {
    graph.close();
  }
});

test('each business sends with its own token', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
    await app.platform.tenants.linkIgAccount(other.id, 'IG-LEAF', 'leaf');
    const leaf = bindTenant(app.platform, other);
    await leaf.igAccounts.setToken('IG-LEAF', 'leaf-token');
    await seedReel(app.repos, { n: 1 });
    await leaf.products.create({ name: 'Pot', price: '1', active: 'on' });
    const pot = (await leaf.products.list())[0];

    await webhook(app, comment('ME', 'c-a'));
    await until(() => app.ig.calls.length >= 1);
    await app.repos.reels.remove(REEL_ID);
    await leaf.reels.save(REEL_ID, { headline: 'Leaf', keywords: 'LINK', productIds: [pot.id], active: 'on' });
    await webhook(app, comment('IG-LEAF', 'c-b'));
    await until(() => app.ig.calls.length >= 2);

    assert.deepEqual(app.ig.accounts.map((a) => [a.igUserId, a.token]), [['ME', 'test-ig-token'], ['IG-LEAF', 'leaf-token']]);
  } finally {
    app.close();
  }
});

test('with no token nothing is sent, and the activity log says why', async () => {
  const app = await startApp();
  try {
    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
    await app.platform.tenants.linkIgAccount(other.id, 'IG-LEAF', 'leaf');
    const leaf = bindTenant(app.platform, other);
    await seedReel(leaf, { n: 1 });
    await webhook(app, comment('IG-LEAF', 'c-b'));
    await until(async () => (await leaf.activity.count()) > 0);
    assert.equal(app.ig.calls.length, 0);
    assert.equal((await leaf.activity.list())[0].result, 'skip:not-connected');
  } finally {
    app.close();
  }
});

test('the admin reads Instagram with the business\'s own account, and each business has its own status', async () => {
  const { login } = await import('../../helpers.js');
  const app = await startApp();
  try {
    const { cookie } = await login(app.base);
    assert.match(await (await fetch(`${app.base}/admin`, { headers: { cookie } })).text(), /1 of 6 done/);
    assert.deepEqual(app.ig.accounts, []);

    const other = await app.platform.tenants.create({ slug: 'leaf', name: 'Leaf' });
    const leaf = bindTenant(app.platform, other);
    await leaf.users.ensureOwner({ phone: '9000000009', password: 'leaf-owner' });
    const host = { 'x-forwarded-host': 'leaf.bhava.test' };
    const res = await fetch(`${app.base}/login`, { method: 'POST', headers: host, body: new URLSearchParams({ phone: '9000000009', password: 'leaf-owner' }), redirect: 'manual' });
    const leafCookie = res.headers.get('set-cookie').split(';')[0];
    const dash = await (await fetch(`${app.base}/admin`, { headers: { ...host, cookie: leafCookie } })).text();
    assert.match(dash, /0 of 6 done/, 'another business is not connected just because the first one is');
    assert.match(dash, /Instagram isn’t connected yet/);
  } finally {
    app.close();
  }
});

test('the server command stores a token', async () => {
  const { platform: repos, tenant } = await setup();
  await repos.tenants.linkIgAccount(tenant.id, 'IG-9', 'x');
  await assert.rejects(() => tenantCommand(repos, ['ig-token', tenant.slug, 'IG-9']), /IG_ACCESS_TOKEN/);
  assert.match(await tenantCommand(repos, ['ig-token', tenant.slug, 'IG-9'], { igToken: 'abc' }), /Stored the token/);
  assert.equal((await bindTenant(repos, tenant).igAccounts.get('IG-9')).token, 'abc');
});
