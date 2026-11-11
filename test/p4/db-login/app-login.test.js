// Two database logins (Phase 4 contract step "db-login"). Business work logs in as the restricted app role;
// the owner is used for migrations and db.platform only. These need a real Postgres server (TEST_DATABASE_URL):
// the built-in test database has one user and no logins to separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { APP_ROLE, assertRestrictedLogin, openDb, openRuntimeDb, ownerDatabaseUrl } from '../../../src/db/index.js';
import { bindTenant, createRepos } from '../../../src/repos/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { setLogSink } from '../../../src/platform/log.js';
import { housekeeping } from '../../../src/worker.js';
import { OWNER, appLoginUrl, openTestDb, startApp } from '../../helpers.js';

const real = Boolean(process.env.TEST_DATABASE_URL);
const onPostgres = { skip: !real && 'needs real Postgres (TEST_DATABASE_URL)' };

// Where log lines go when a test is not catching them.
const toConsole = (line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);

const DENIED = '42501'; // insufficient_privilege: no grant, or a row the policy refuses
const denied = (promise, what) => assert.rejects(promise, (err) => err.code === DENIED, what);

/** Two businesses with a product, an audit row and a compliance row each, on a two-login database. */
async function twoBusinesses() {
  const db = await openTestDb({ logins: 2 });
  const platform = createRepos(db);
  const a = await platform.tenants.create({ slug: 'a', name: 'A' });
  const b = await platform.tenants.create({ slug: 'b', name: 'B' });
  for (const tenant of [a, b]) {
    await bindTenant(platform, tenant).products.create({ name: `${tenant.slug} lamp`, price: '100', active: 'on' });
    await db.platform.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'test', 'made')`, [tenant.id]);
    await db.platform.query(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'test', 'made')`, [tenant.id]);
  }
  const [{ owner }] = await db.platform.query('SELECT current_user AS owner');
  return { db, platform, a, b, owner };
}

const names = (rows) => rows.map((r) => r.name).sort();

test('with two logins, business work is on a login that is the app role and nothing more', onPostgres, async () => {
  const { db, a, owner } = await twoBusinesses();
  try {
    assert.equal(db.logins, 2);
    assert.equal(db.kind, 'postgres');
    assert.notEqual(owner, APP_ROLE);
    for (const run of [(fn) => withTenant(a, fn), (fn) => fn()]) {
      const [who] = await run(() => db.query(
        `SELECT session_user::text AS login, current_user::text AS role, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                (SELECT count(*) FROM pg_class c WHERE c.relowner = r.oid) AS owned,
                (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) AS roles
           FROM pg_roles r WHERE r.rolname = current_user`,
      ));
      assert.deepEqual(who, { login: APP_ROLE, role: APP_ROLE, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, owned: 0, roles: 0 });
    }
    // The platform path is the owner's, and only that.
    assert.equal((await db.platform.query('SELECT session_user::text AS login'))[0].login, owner);
    assert.equal((await withTenant(a, () => db.platform.query('SELECT session_user::text AS login')))[0].login, owner);
  } finally {
    await db.close();
  }
});

test('the app connection cannot RESET ROLE or SET ROLE its way to the owner', onPostgres, async () => {
  const { db, a, owner } = await twoBusinesses();
  try {
    for (const run of [(fn) => withTenant(a, fn), (fn) => fn()]) {
      // RESET ROLE goes back to the login, and the login is the app role: nothing changes.
      await run(() => db.tx(async (t) => {
        await t.exec('RESET ROLE');
        const [{ role }] = await t.query('SELECT current_user::text AS role');
        assert.equal(role, APP_ROLE);
        await t.exec('RESET SESSION AUTHORIZATION');
        assert.equal((await t.query('SELECT current_user::text AS role'))[0].role, APP_ROLE);
        assert.deepEqual(names(await t.query('SELECT name FROM products WHERE name LIKE $1', ['b %'])), []);
      }));
      // In one statement, as an injected query would be.
      const stacked = await run(() => db.exec(`RESET ROLE; SELECT current_user::text AS role, (SELECT count(*) FROM products WHERE name LIKE 'b %') AS seen`));
      assert.deepEqual(stacked.at(-1).rows, [{ role: APP_ROLE, seen: 0 }]);
      for (const sql of [`SET ROLE "${owner}"`, `SET LOCAL ROLE "${owner}"`, `SET SESSION AUTHORIZATION "${owner}"`, `SELECT set_config('role', '${owner}', true)`]) {
        await denied(run(() => db.exec(sql)), sql);
      }
      await denied(run(() => db.exec(`ALTER ROLE ${APP_ROLE} BYPASSRLS`)), 'ALTER ROLE');
      await denied(run(() => db.exec(`GRANT "${owner}" TO ${APP_ROLE}`)), 'GRANT role');
      await denied(run(() => db.exec('ALTER TABLE products DISABLE ROW LEVEL SECURITY')), 'ALTER TABLE');
      await denied(run(() => db.exec('DROP POLICY tenant_fence ON products')), 'DROP POLICY');
    }
  } finally {
    await db.close();
  }
});

test('the app connection cannot read or change another business\'s rows', onPostgres, async () => {
  const { db, a, b } = await twoBusinesses();
  try {
    await withTenant(a, async () => {
      assert.deepEqual(names(await db.query('SELECT name FROM products')), ['a lamp'], 'a query with no WHERE');
      assert.deepEqual(await db.query('SELECT name FROM products WHERE tenant_id = $1', [b.id]), [], 'asking for the other business by id');
      assert.deepEqual(await db.query('SELECT id FROM tenants WHERE id = $1', [b.id]), []);
      assert.deepEqual(await db.query('SELECT id FROM audit_log WHERE tenant_id = $1', [b.id]), []);
      assert.deepEqual(await db.query(`UPDATE products SET name = 'taken' WHERE tenant_id = $1 RETURNING id`, [b.id]), []);
      assert.deepEqual(await db.query('DELETE FROM products WHERE tenant_id = $1 RETURNING id', [b.id]), []);
      await denied(db.query(`INSERT INTO products (tenant_id, name, slug, price_paise) VALUES ($1, 'planted', 'planted', 100)`, [b.id]), 'a row planted in the other business');
      await denied(db.query(`UPDATE products SET tenant_id = $1`, [b.id]), 'a row moved to the other business');
      // Turning row security off does not show more: the query is refused instead.
      await denied(db.exec('SET LOCAL row_security = off; SELECT name FROM products'), 'row_security = off');
    });
    // No business named: no business rows at all, and nothing to write to.
    assert.deepEqual(await db.query('SELECT name FROM products'), []);
    assert.deepEqual(await db.query('SELECT id FROM tenants'), []);
    assert.deepEqual(await db.query(`UPDATE products SET name = 'taken' RETURNING id`), []);
    // Tables with no grant to the app role are closed to it altogether.
    await denied(db.query('SELECT 1 FROM platform_users'), 'platform_users');
    await denied(db.query('SELECT 1 FROM schema_migrations'), 'schema_migrations');
    await denied(withTenant(a, () => db.query('SELECT 1 FROM platform_sessions')), 'platform_sessions');

    assert.deepEqual(names(await db.platform.query('SELECT name FROM products')), ['a lamp', 'b lamp'], 'nothing was changed, and the platform path still sees both');
    assert.deepEqual(names(await withTenant(b, () => db.query('SELECT name FROM products'))), ['b lamp']);
  } finally {
    await db.close();
  }
});

test('a connection left with another business named does not carry it into the next piece of work', onPostgres, async () => {
  const { db, a, b } = await twoBusinesses();
  try {
    // Session-wide, on every pooled connection the app login has open.
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => db.exec(`SELECT set_config('app.tenant_id', '${b.id}', false), pg_sleep(0.05)`)));
    for (let i = 0; i < 6; i++) {
      assert.deepEqual(await db.query('SELECT name FROM products'), [], 'work for no business');
      assert.deepEqual(names(await withTenant(a, () => db.query('SELECT name FROM products'))), ['a lamp'], 'work for business a');
    }
  } finally {
    await db.close();
  }
});

test('the app connection cannot TRUNCATE, empty or drop audit_log or compliance_events', onPostgres, async () => {
  const { db, a } = await twoBusinesses();
  try {
    for (const table of ['audit_log', 'compliance_events']) {
      for (const run of [(fn) => withTenant(a, fn), (fn) => fn()]) {
        for (const sql of [`TRUNCATE ${table}`, `TRUNCATE ${table} CASCADE`, `TRUNCATE ${table} RESTART IDENTITY`, `DELETE FROM ${table}`, `UPDATE ${table} SET created_at = now()`, `DROP TABLE ${table}`, `ALTER TABLE ${table} DISABLE TRIGGER ALL`, `RESET ROLE; TRUNCATE ${table}`]) {
          await denied(run(() => db.exec(sql)), sql);
        }
      }
      assert.equal((await db.platform.query(`SELECT count(*) AS n FROM ${table}`))[0].n, 2, `${table} still has both rows`);
    }
    // No table at all can be truncated by the app login.
    const truncatable = await db.platform.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege('${APP_ROLE}', c.oid, 'TRUNCATE')`,
    );
    assert.deepEqual(truncatable, []);
  } finally {
    await db.close();
  }
});

test('retention still runs with two logins: it goes through the platform path', onPostgres, async () => {
  const { db, platform, a } = await twoBusinesses();
  try {
    const repos = bindTenant(platform, a);
    await repos.users.ensureOwner(OWNER);
    const user = await repos.users.findByPhone(OWNER.phone);
    await repos.sessions.create(user.id, 30);
    await db.platform.query(`UPDATE sessions SET expires_at = now() - interval '1 day'`);
    await repos.sessions.create(user.id, 30);
    assert.equal((await db.platform.query('SELECT count(*) AS n FROM sessions'))[0].n, 2);
    await housekeeping({ db, queue: { cleanup: async () => {} } });
    assert.equal((await db.platform.query('SELECT count(*) AS n FROM sessions'))[0].n, 1, 'the expired session is gone and the live one is kept');
  } finally {
    await db.close();
  }
});

test('the app runs on two logins: sign-in, the token, a seller route and the storefront', onPostgres, async () => {
  const app = await startApp({ logins: 2 });
  try {
    assert.equal(app.db.logins, 2);
    const login = await fetch(`${app.base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(OWNER) });
    assert.equal(login.status, 201);
    const { token } = await login.json();
    const me = await fetch(`${app.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).business.slug, 'default');
    const products = await fetch(`${app.base}/api/v1/products`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(products.status, 200);
    assert.equal((await fetch(`${app.base}/`)).status, 200);
    assert.equal((await fetch(`${app.base}/shop`)).status, 200);
    assert.equal((await fetch(`${app.base}/readyz`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/v1/auth/me`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  } finally {
    app.close();
    await app.db.close();
  }
});

test('a DATABASE_URL that logs in as the owner or a superuser is refused when an owner connection is also set', onPostgres, async () => {
  const db = await openTestDb({ logins: 2 });
  const ownerUrl = db.urls.owner;
  await db.close();
  // The same owner login under a second spelling, so the two settings differ.
  const asOwner = new URL(ownerUrl);
  asOwner.searchParams.set('application_name', 'bhava');
  await assert.rejects(openDb({ url: asOwner.href, ownerUrl, poolSize: 2 }), /must log in as the restricted app role.*(superuser|owns)/);

  // A login of another name is fine while it is a member of the app role and of nothing else...
  const name = `bhava_app_${crypto.randomBytes(4).toString('hex')}`;
  const member = new URL(appLoginUrl(ownerUrl));
  member.username = name;
  const owner = await openDb({ url: ownerUrl, migrate: false, poolSize: 1 });
  try {
    const first = await openDb({ url: member.href, ownerUrl, poolSize: 2 });
    assert.equal(first.logins, 2);
    const platform = createRepos(first);
    const a = await platform.tenants.create({ slug: 'a', name: 'A' });
    const b = await platform.tenants.create({ slug: 'b', name: 'B' });
    await bindTenant(platform, b).products.create({ name: 'b lamp', price: '100', active: 'on' });
    assert.equal((await first.query('SELECT session_user::text AS login'))[0].login, name);
    assert.deepEqual(await withTenant(a, () => first.query('SELECT name FROM products')), []);
    await denied(first.exec('TRUNCATE audit_log'), 'TRUNCATE as a member login');
    await first.close();

    // ...and refused the moment it can do more.
    await owner.exec(`ALTER ROLE ${name} BYPASSRLS`);
    await assert.rejects(openDb({ url: member.href, ownerUrl, poolSize: 2 }), /can bypass row-level security/);
    await owner.exec(`ALTER ROLE ${name} NOBYPASSRLS; GRANT pg_read_all_data TO ${name}`);
    await assert.rejects(openDb({ url: member.href, ownerUrl, poolSize: 2 }), /belongs to a role other than/);
  } finally {
    await owner.exec(`DROP ROLE IF EXISTS ${name}`);
    await owner.close();
  }
});

test('assertRestrictedLogin names what is wrong with the owner login', onPostgres, async () => {
  const db = await openTestDb({ logins: 1 });
  try {
    await assert.rejects(assertRestrictedLogin(db.platform), /must log in as the restricted app role/);
  } finally {
    await db.close();
  }
});

test('with only DATABASE_URL the old way still works, and production is warned once at start', onPostgres, async () => {
  const two = await openTestDb({ logins: 2 });
  const { owner: ownerUrl, app: appUrl } = two.urls;
  await two.close();
  const logged = [];
  setLogSink((line) => logged.push(JSON.parse(line)));
  const warnings = () => logged.filter((e) => e.msg === 'db.single_login');
  try {
    const one = await openRuntimeDb({ databaseUrl: ownerUrl, databaseOwnerUrl: '' }, { NODE_ENV: 'production' });
    try {
      assert.equal(one.logins, 1);
      assert.equal(warnings().length, 1, 'one warning');
      assert.equal(warnings()[0].level, 'warn');
      assert.doesNotMatch(JSON.stringify(warnings()[0]), /postgres:\/\//, 'the warning carries no connection string');
      const platform = createRepos(one);
      const a = await platform.tenants.create({ slug: 'a', name: 'A' });
      const [who] = await withTenant(a, () => one.query('SELECT current_user::text AS role, session_user::text AS login'));
      assert.equal(who.role, APP_ROLE, 'business work still steps down to the app role');
      assert.notEqual(who.login, APP_ROLE);
      assert.equal((await one.query('SELECT count(*) AS n FROM tenants'))[0].n, 1, 'work outside a business is the owner\'s, as before');
    } finally {
      await one.close();
    }

    logged.length = 0;
    const quiet = await openRuntimeDb({ databaseUrl: ownerUrl, databaseOwnerUrl: '' }, { NODE_ENV: 'development' });
    await quiet.close();
    assert.equal(warnings().length, 0, 'no warning outside production');

    const split = await openRuntimeDb({ databaseUrl: appUrl, databaseOwnerUrl: ownerUrl }, { NODE_ENV: 'production' });
    try {
      assert.equal(split.logins, 2);
      assert.equal(warnings().length, 0, 'no warning with two logins');
    } finally {
      await split.close();
    }
  } finally {
    setLogSink(toConsole);
  }
});

// ---- These need no server ----

test('the built-in database is one login and is never warned about', async () => {
  const logged = [];
  setLogSink((line) => logged.push(line));
  try {
    const db = await openRuntimeDb({ databaseUrl: '', databaseOwnerUrl: '', dataDir: undefined }, { NODE_ENV: 'production', ALLOW_PGLITE: '1' });
    assert.equal(db.logins, 1);
    assert.equal(db.kind, 'pglite');
    await db.close();
    assert.equal(logged.filter((l) => l.includes('db.single_login')).length, 0);
  } finally {
    setLogSink(toConsole);
  }
});

test('an owner connection without an app connection is refused, with nothing opened', async () => {
  await assert.rejects(openDb({ ownerUrl: 'postgres://owner:password@127.0.0.1:1/x' }), /DATABASE_OWNER_URL is set without DATABASE_URL/);
  await assert.rejects(openRuntimeDb({ databaseUrl: '', databaseOwnerUrl: 'postgres://owner:password@127.0.0.1:1/x' }, { NODE_ENV: 'production' }), /DATABASE_OWNER_URL is set without DATABASE_URL/);
});

test('backups and restores use the owner connection when there is one', () => {
  assert.equal(ownerDatabaseUrl({ databaseUrl: 'app', databaseOwnerUrl: 'owner' }), 'owner');
  assert.equal(ownerDatabaseUrl({ databaseUrl: 'only', databaseOwnerUrl: '' }), 'only');
  assert.equal(ownerDatabaseUrl({ databaseUrl: 'only' }), 'only');
});
