// The fence around each business in the database itself: what a transaction inside withTenant() can reach, on the path
// the app really takes (src/db/index.js), and that every table holding business rows is behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROLE } from '../../../src/db/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { bindTenant } from '../../../src/repos/index.js';
import { setup } from '../../helpers.js';
import { CUSTOMER } from '../spec-p0/support.js';

async function twoBusinesses() {
  const { db, platform, repos: a, tenant: tenantA } = await setup();
  const tenantB = await platform.tenants.create({ slug: 'beta-store', name: 'Beta Store' });
  const b = bindTenant(platform, tenantB);
  const lamp = await a.products.create({ name: 'Lamp', price: '100', active: 'on' });
  const pot = await b.products.create({ name: 'Pot', price: '200', active: 'on' });
  return { db, platform, a, b, tenantA, tenantB, lamp, pot };
}

test('inside a business, a query that forgets its WHERE still sees only that business', async () => {
  const { db, tenantA, tenantB } = await twoBusinesses();
  assert.deepEqual((await withTenant(tenantA, () => db.query('SELECT name FROM products'))).map((r) => r.name), ['Lamp']);
  assert.deepEqual((await withTenant(tenantB, () => db.query('SELECT name FROM products'))).map((r) => r.name), ['Pot']);
});

test('a transaction inside a business is fenced for every statement, and runs as the app role', async () => {
  const { db, tenantA } = await twoBusinesses();
  const seen = await withTenant(tenantA, () => db.tx(async (t) => ({
    first: await t.query('SELECT count(*)::int AS n FROM products'),
    second: await t.query('SELECT count(*)::int AS n FROM tenants'),
    who: await t.query('SELECT current_user AS name, current_tenant_id() AS tenant'),
  })));
  assert.equal(seen.first[0].n, 1);
  assert.equal(seen.second[0].n, 1, 'a business sees only its own row of tenants');
  assert.deepEqual(seen.who[0], { name: APP_ROLE, tenant: tenantA.id });
});

test('inside a business, another business\'s rows cannot be written, moved into or deleted', async () => {
  const { db, tenantA, tenantB, pot, b } = await twoBusinesses();
  await assert.rejects(
    () => withTenant(tenantA, () => db.query(`INSERT INTO settings (tenant_id, key, value) VALUES ($1, 'store_name', 'Hijacked')`, [tenantB.id])),
    /row-level security/,
  );
  const changed = await withTenant(tenantA, () => db.query(`UPDATE products SET name = 'Taken' WHERE id = $1 RETURNING id`, [pot.id]));
  assert.deepEqual(changed, []);
  const removed = await withTenant(tenantA, () => db.query('DELETE FROM products WHERE id = $1 RETURNING id', [pot.id]));
  assert.deepEqual(removed, []);
  assert.equal((await b.products.get(pot.id)).name, 'Pot');
});

test('the fence lasts one transaction: nothing stays on the connection afterwards', async () => {
  const { db, tenantA } = await twoBusinesses();
  await withTenant(tenantA, () => db.query('SELECT 1'));
  const [after] = await db.query(`SELECT current_user AS name, current_setting('app.tenant_id', true) AS tenant`);
  assert.notEqual(after.name, APP_ROLE);
  assert.ok(!after.tenant, 'no business is left set');
});

test('db.platform is unfenced even inside a business, for the few things that look across them', async () => {
  const { db, tenantA } = await twoBusinesses();
  const [{ n }] = await withTenant(tenantA, () => db.platform.query('SELECT count(*)::int AS n FROM products'));
  assert.equal(n, 2);
  const inTx = await withTenant(tenantA, () => db.platform.tx((t) => t.query('SELECT count(*)::int AS n FROM products')));
  assert.equal(inTx[0].n, 2);
});

test('the app role is not a superuser, cannot bypass the policies, and owns nothing', async () => {
  const { db } = await setup();
  // Whether it can log in is no longer fixed: with two database logins (Phase 4, test/p4/db-login) it is the app's own login,
  // and a role belongs to the whole server, so another database there may already have given it one.
  const [role] = await db.query('SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1', [APP_ROLE]);
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
  const owned = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = $1`, [APP_ROLE]);
  assert.deepEqual(owned, []);
});

test('every table with a tenant_id, nullable ones too, has row-level security and a policy', async () => {
  const { db } = await setup();
  const rows = await db.query(
    `SELECT c.table_name, cl.relrowsecurity AS secured, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.table_name) AS policies
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     JOIN pg_class cl ON cl.oid = format('public.%I', c.table_name)::regclass
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'`,
  );
  assert.ok(rows.length >= 20, `found ${rows.length} tables`);
  assert.deepEqual(rows.filter((r) => !r.secured || r.policies < 1).map((r) => r.table_name), []);
});

test('the logs are add-and-read for the app role: no update, delete or truncate, and no platform rows', async () => {
  const { db, tenantA, tenantB } = await twoBusinesses();
  await db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'a', 'x'), ($2, 'b', 'x'), (NULL, 'ops', 'x')`, [tenantA.id, tenantB.id]);
  await db.query(`INSERT INTO compliance_events (tenant_id, kind, decision) VALUES ($1, 'dm', 'allow')`, [tenantA.id]);
  assert.equal((await withTenant(tenantA, () => db.query('SELECT actor FROM audit_log'))).length, 1, 'neither B\'s row nor the platform row');
  for (const sql of ['UPDATE compliance_events SET reason = $$x$$', 'DELETE FROM compliance_events', 'UPDATE audit_log SET actor = $$x$$', 'DELETE FROM audit_log', 'TRUNCATE audit_log', 'TRUNCATE compliance_events']) {
    await assert.rejects(() => withTenant(tenantA, () => db.query(sql)), /permission denied/, sql);
  }
  await withTenant(tenantA, () => db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'a', 'y')`, [tenantA.id]));
  await assert.rejects(() => withTenant(tenantA, () => db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES (NULL, 'a', 'y')`)), /row-level security/);
});

test('the order counter is the one thing a business can change on its tenants row', async () => {
  const { db, a, tenantA, lamp } = await twoBusinesses();
  const order = await a.orders.create({ items: [{ productId: lamp.id, qty: 1 }], customer: CUSTOMER }, await a.settings.getAll());
  assert.match(order.order_number, /1001$/);
  await assert.rejects(() => withTenant(tenantA, () => db.query(`UPDATE tenants SET plan = 't5' WHERE id = $1`, [tenantA.id])), /permission denied/);
});

test('the recipe in HANDOFF.md fences a new table in one line', async () => {
  const { db, tenantA, tenantB } = await twoBusinesses();
  await db.exec(`
    CREATE TABLE recipe_widgets (
      id serial PRIMARY KEY,
      tenant_id integer NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      product_id integer NOT NULL,
      UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id) ON DELETE CASCADE
    );
    SELECT fence_tenant_table('recipe_widgets');
  `);
  const [lampRow] = await withTenant(tenantA, () => db.query('SELECT id FROM products'));
  const [potRow] = await withTenant(tenantB, () => db.query('SELECT id FROM products'));
  await withTenant(tenantA, () => db.query('INSERT INTO recipe_widgets (tenant_id, product_id) VALUES ($1, $2)', [tenantA.id, lampRow.id]));
  assert.equal((await withTenant(tenantA, () => db.query('SELECT 1 FROM recipe_widgets'))).length, 1, 'the serial id works for the app role');
  assert.equal((await withTenant(tenantB, () => db.query('SELECT 1 FROM recipe_widgets'))).length, 0);
  await assert.rejects(
    () => withTenant(tenantA, () => db.query('INSERT INTO recipe_widgets (tenant_id, product_id) VALUES ($1, $2)', [tenantA.id, potRow.id])),
    /foreign key/,
    'a row of A cannot link to B\'s product',
  );
});

test('claiming another business\'s Instagram post is still a clear refusal under the fence', async () => {
  const { a, b, lamp, pot } = await twoBusinesses();
  await b.reels.save('17900000000000900', { headline: 'Theirs', keywords: 'LINK', productIds: [pot.id], active: 'on' });
  await assert.rejects(() => a.reels.save('17900000000000900', { headline: 'Mine', keywords: 'LINK', productIds: [lamp.id], active: 'on' }), /belongs to another business/);
  assert.equal(await a.adminLists.reelHeldElsewhere('17900000000000900'), true);
});
