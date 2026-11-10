import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePlatformRole } from '../../../src/auth.js';
import { MODULES } from '../../../src/modules/index.js';
import { OWNER, login, setup, startApp } from '../../helpers.js';
import { withConsoleApi } from '../console-port/support/console-api.js';
import { at, dbAtMigration, json } from './support.js';

const PLATFORM_HOST = 'admin.bhava.test';
const STAFF = { email: 'Asha@Bhava.example', password: 'platform-pass', role: 'support' };
const ADMIN = { email: 'root@bhava.example', password: 'platform-pass', role: 'super_admin' };

// A console route only a super admin may use, added the way a real module would.
const guarded = {
  name: 'guarded',
  platformRoutes(router) {
    router.get('/raw-export', requirePlatformRole('super_admin'), (req, res) => res.json({ by: req.platformUser.email }));
    router.post('/kill', requirePlatformRole('super_admin', 'support'), (_req, res) => res.json({ ok: true }));
  },
};

const consoleApp = () => startApp({ modules: [...MODULES, guarded] });
const onConsole = (app, path, init = {}) => fetch(`${app.base}${path}`, { redirect: 'manual', ...init, headers: { ...at(PLATFORM_HOST), ...init.headers } });

async function signIn(app, { email, password }) {
  const res = await onConsole(app, '/login', json({ email, password }));
  assert.equal(res.status, 200);
  return { cookie: res.headers.get('set-cookie').split(';')[0], ...(await res.json()) };
}

test('business roles are owner, staff and customer', async () => {
  const { db, repos, tenant } = await setup();
  await assert.rejects(
    () => db.query(`INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1, 'x', '9000000099', 'h', 'admin')`, [tenant.id]),
    /check constraint/,
  );
  const owner = await repos.users.create({ name: 'Owner', phone: '9000000002', password: 'secret1', role: 'owner' });
  const staff = await repos.users.create({ name: 'Staff', phone: '9000000003', password: 'secret1', role: 'staff' });
  const other = await repos.users.create({ name: 'Other', phone: '9000000004', password: 'secret1', role: 'admin' });
  assert.deepEqual([owner.role, staff.role, other.role], ['owner', 'staff', 'customer']);
  assert.equal((await repos.users.setRole(other.id, 'staff')).role, 'staff');
  await assert.rejects(() => repos.users.setRole(other.id, 'admin'), /owner, staff or customer/);
  assert.deepEqual((await repos.users.listTeam()).map((u) => u.role).sort(), ['owner', 'staff', 'staff']);
});

test('the migration turns old admins into owners and keeps customers', async () => {
  const { db, finish } = await dbAtMigration('004');
  const [t] = await db.query(`INSERT INTO tenants (slug, name) VALUES ('old', 'Old') RETURNING id`);
  await db.query(
    `INSERT INTO users (tenant_id, name, phone, password_hash, role) VALUES ($1, 'A', '9000000001', 'h', 'admin'), ($1, 'C', '9000000002', 'h', 'customer')`,
    [t.id],
  );
  await finish();
  assert.deepEqual((await db.query('SELECT role FROM users ORDER BY phone')).map((r) => r.role), ['owner', 'customer']);
});

test('staff are kept out of the admin panel until permissions exist, and cannot be reset from it', async () => {
  const app = await startApp({ modules: withConsoleApi() });
  try {
    const staff = await app.repos.users.create({ name: 'Staff', phone: '9000000003', password: 'secret1', role: 'staff' });
    const s = await login(app.base, { phone: '9000000003', password: 'secret1' });
    const res = await fetch(`${app.base}/api/v1/products`, { headers: { cookie: s.cookie }, redirect: 'manual' });
    assert.equal(res.status, 403);
    assert.equal(s.location, '/account');

    const o = await login(app.base);
    const reset = await fetch(`${app.base}/api/v1/customers/${staff.id}/reset-password`, { method: 'POST', headers: { cookie: o.cookie, 'x-csrf-token': o.csrf }, redirect: 'manual' });
    assert.notEqual(reset.status, 200);
    assert.ok(await app.repos.users.verify('9000000003', 'secret1'), 'password unchanged');
  } finally {
    app.close();
  }
});

test('platform users have their own table and no business', async () => {
  const { db, platform } = await setup();
  const user = await platform.platformUsers.create(STAFF);
  assert.equal(user.email, 'asha@bhava.example');
  assert.equal(user.role, 'support');
  assert.equal('password_hash' in user, false);
  assert.equal((await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'platform_users' AND column_name = 'tenant_id'`)).length, 0);
  await assert.rejects(() => platform.platformUsers.create({ ...STAFF, role: 'owner' }), /super_admin or support/);
  await assert.rejects(() => platform.platformUsers.create(STAFF), /already exists/);
  await assert.rejects(() => db.query(`INSERT INTO platform_users (email, password_hash, role) VALUES ('a@b.c', 'h', 'owner')`), /check constraint/);
  assert.ok(await platform.platformUsers.verify('ASHA@bhava.example', STAFF.password));
  assert.equal(await platform.platformUsers.verify('asha@bhava.example', 'wrong'), null);
});

test('requirePlatformRole refuses guests and the wrong role, and lets the right one through', async () => {
  const app = await consoleApp();
  try {
    await app.platform.platformUsers.create(STAFF);
    await app.platform.platformUsers.create(ADMIN);
    assert.equal((await onConsole(app, '/raw-export')).status, 401);

    const support = await signIn(app, STAFF);
    assert.equal(support.user.role, 'support');
    assert.equal((await onConsole(app, '/raw-export', { headers: { cookie: support.cookie } })).status, 403);

    const root = await signIn(app, ADMIN);
    const ok = await onConsole(app, '/raw-export', { headers: { cookie: root.cookie } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { by: ADMIN.email });
  } finally {
    app.close();
  }
});

test('F-25: owner credentials are rejected on the console host', async () => {
  const app = await consoleApp();
  try {
    for (const body of [{ email: OWNER.phone, password: OWNER.password }, { phone: OWNER.phone, password: OWNER.password }]) {
      assert.equal((await onConsole(app, '/login', json(body))).status, 401);
    }
    // Nor does an owner's business session count there.
    const { cookie } = await login(app.base);
    assert.equal((await onConsole(app, '/me', { headers: { cookie } })).status, 401);
    assert.equal((await onConsole(app, '/admin', { headers: { cookie } })).status, 404);
  } finally {
    app.close();
  }
});

test('platform users can sign in only on the platform host', async () => {
  const app = await consoleApp();
  try {
    await app.platform.platformUsers.create(ADMIN);
    const elsewhere = await fetch(`${app.base}/login`, json({ email: ADMIN.email, phone: ADMIN.email, password: ADMIN.password }));
    assert.equal(elsewhere.status, 401);
    assert.equal((await fetch(`${app.base}/raw-export`, { redirect: 'manual' })).status, 404);

    const { cookie } = await signIn(app, ADMIN);
    const onBusiness = await fetch(`${app.base}/api/v1/auth/me`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(onBusiness.status, 401, 'a platform session means nothing on a business site');
    assert.equal((await fetch(`${app.base}/raw-export`, { headers: { cookie }, redirect: 'manual' })).status, 404);
  } finally {
    app.close();
  }
});

test('the platform host never serves a business, even with a default business', async () => {
  const app = await consoleApp();
  try {
    for (const path of ['/', '/shop', '/admin', '/account', '/api/products?ids=1']) {
      const res = await onConsole(app, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(await res.text(), /Test store|My store/, path);
    }
  } finally {
    app.close();
  }
});

test('no platform host configured: platform sign-in is off', async () => {
  const app = await startApp({ overrides: { platformDomain: '', platformHost: '' } });
  try {
    await app.platform.platformUsers.create(ADMIN);
    const res = await fetch(`${app.base}/me`, { headers: at('admin.anything.test'), redirect: 'manual' });
    assert.notEqual(res.headers.get('content-type'), 'application/json');
  } finally {
    app.close();
  }
});

test('PLATFORM_HOST overrides the default platform host', async () => {
  const app = await startApp({ overrides: { platformHost: 'console.bhava.test' } });
  try {
    await app.platform.platformUsers.create(ADMIN);
    const res = await fetch(`${app.base}/login`, { ...json({ email: ADMIN.email, password: ADMIN.password }), headers: { 'content-type': 'application/json', ...at('console.bhava.test') } });
    assert.equal(res.status, 200);
  } finally {
    app.close();
  }
});

test('a platform session needs its CSRF token, can log out, and logging in is rate limited', async () => {
  const app = await consoleApp();
  try {
    await app.platform.platformUsers.create(STAFF);
    const s = await signIn(app, STAFF);
    assert.equal((await onConsole(app, '/kill', { method: 'POST', headers: { cookie: s.cookie } })).status, 403);
    assert.equal((await onConsole(app, '/kill', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } })).status, 200);

    assert.equal((await onConsole(app, '/logout', { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } })).status, 204);
    assert.equal((await onConsole(app, '/me', { headers: { cookie: s.cookie } })).status, 401);

    for (let i = 0; i < 10; i++) await onConsole(app, '/login', json({ email: STAFF.email, password: 'wrong' }));
    assert.equal((await onConsole(app, '/login', json({ email: STAFF.email, password: STAFF.password }))).status, 429);
  } finally {
    app.close();
  }
});

test('a login form from another site is refused on the console', async () => {
  const app = await consoleApp();
  try {
    await app.platform.platformUsers.create(STAFF);
    const res = await onConsole(app, '/login', json({ email: STAFF.email, password: STAFF.password }, { origin: 'https://evil.test' }));
    assert.equal(res.status, 403);
  } finally {
    app.close();
  }
});
