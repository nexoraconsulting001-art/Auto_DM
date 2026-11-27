// R5-PP-4: every test database works as production's restricted app login outside a business, on one login as on two,
// so a test or product path that leans on the owner outside db.platform fails in every run, not only on the production profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROLE } from '../../../src/db/index.js';
import { withTenant } from '../../../src/tenancy.js';
import { setup } from '../../helpers.js';

const WHO = `SELECT current_user::text AS role, current_setting('app.tenant_id', true) AS tenant`;

test('outside a business the business handle is the app role with no business: it sees no business rows and cannot write tenants', async () => {
  const { db, tenant } = await setup();
  try {
    assert.deepEqual(await db.query(WHO), [{ role: APP_ROLE, tenant: '' }]);
    assert.deepEqual(await db.tx((t) => t.query(WHO)), [{ role: APP_ROLE, tenant: '' }]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM tenants'))[0].n, 0, 'no business row is visible');
    await assert.rejects(() => db.query(`UPDATE tenants SET plan = 't5' WHERE id = $1`, [tenant.id]), /permission denied/);
    await assert.rejects(() => db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'a', 'x')`, [tenant.id]), /row-level security/);
  } finally {
    await db.close();
  }
});

test('inside a business the handle is fenced to it, and db.platform stays the owner everywhere', async () => {
  const { db, tenant } = await setup();
  try {
    assert.deepEqual(await withTenant(tenant, () => db.query(WHO)), [{ role: APP_ROLE, tenant: String(tenant.id) }]);
    const [owner] = await db.platform.query(WHO);
    assert.notEqual(owner.role, APP_ROLE);
    assert.equal((await db.platform.query('SELECT count(*)::int AS n FROM tenants'))[0].n, 1);
    const [inside] = await withTenant(tenant, () => db.platform.query(WHO));
    assert.notEqual(inside.role, APP_ROLE);
  } finally {
    await db.close();
  }
});
