// "Delete my account" (PRD 10.6, Apple 5.1.1(v)): audited, ops told, a timeline shown, every session ended; signing in
// again cancels it, and when it falls due the person is gone while a business with no other owner is left for ops.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenHash } from '../../../src/contracts/accounts.js';
import { withTenant } from '../../../src/tenancy.js';
import { accountsFor } from '../../../src/modules/accounts/index.js';
import { accountsApp, call, codeSignIn, freshIp, otherBusiness, random10, testDevice, typedAccount } from './support.js';

let app;
before(async () => {
  app = await accountsApp();
});
after(() => app?.close());

const reset = async () => {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
};

test('P-26: Delete my account writes the request to the audit log of every business, tells ops, shows a timeline and ends every session', async () => {
  const phone = random10();
  const second = await otherBusiness(app, 'Second Shop');
  await typedAccount(app, app.tenant, { phone, role: 'staff', permissions: ['orders'] });
  await typedAccount(app, second, { phone, role: 'owner' });
  const session = await codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Deleting phone') });
  await reset();
  const web = await codeSignIn(app, { phone, transport: 'cookie', tenantId: second.id });

  const refused = await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: session.auth, body: { confirm: 'delete' } });
  assert.equal(refused.status, 400, 'it has to be typed in capitals');
  const asked = await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: session.auth, body: { confirm: 'DELETE' } });
  assert.equal(asked.status, 202);
  assert.equal(asked.json.status, 'requested');
  const days = (Date.parse(asked.json.dueAt) - Date.parse(asked.json.requestedAt)) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1, 'due in 30 days');

  for (const tenant of [app.tenant, second]) {
    const [audit] = await withTenant(tenant, () => app.db.query(`SELECT actor, details FROM audit_log WHERE tenant_id = $1 AND action = 'account.deletion_requested'`, [tenant.id]));
    assert.ok(audit, `audited in ${tenant.name}`);
    assert.equal(JSON.stringify(audit).includes(phone), false);
    const [alert] = await withTenant(tenant, () => app.db.query(`SELECT audience, severity, message FROM alerts WHERE tenant_id = $1 AND kind = 'account.deletion_requested'`, [tenant.id]));
    assert.equal(alert.audience, 'ops', 'ops are told');
    assert.equal(alert.message.includes(phone), false);
  }
  const [soleOwner] = await withTenant(second, () => app.db.query(`SELECT severity FROM alerts WHERE tenant_id = $1 AND kind = 'account.deletion_requested'`, [second.id]));
  assert.equal(soleOwner.severity, 'critical', 'the only owner of a business: ops must decide');

  assert.equal((await call(app, '/api/v1/orders', { headers: session.auth })).status, 401, 'the app is signed out');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: { cookie: web.cookie } })).status, 401, 'and the console');
  assert.equal((await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: session.refreshToken }, ip: freshIp() })).status, 401);

  // Asking twice keeps one request; signing in again cancels it.
  await reset();
  const back = await codeSignIn(app, { phone, tenantId: app.tenant.id });
  const [cancelled] = await app.db.platform.query(`SELECT status FROM account_deletion_requests ORDER BY id DESC LIMIT 1`);
  assert.equal(cancelled.status, 'cancelled');
  const again = await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: back.auth, body: { confirm: 'DELETE' } });
  assert.equal(again.status, 202);
  await reset();
  const third = await codeSignIn(app, { phone, tenantId: app.tenant.id });
  await app.db.platform.query(`UPDATE account_deletion_requests SET status = 'requested' WHERE id = (SELECT max(id) FROM account_deletion_requests)`);
  const twice = await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: third.auth, body: { confirm: 'DELETE' } });
  assert.equal(twice.json.requestedAt, (await app.db.platform.query(`SELECT requested_at FROM account_deletion_requests WHERE status = 'requested'`))[0].requested_at.toISOString());

  // Deleting needs a fresh re-auth.
  await reset();
  const stale = await codeSignIn(app, { phone, tenantId: app.tenant.id });
  await app.db.platform.query('UPDATE sessions SET fresh_until = NULL WHERE id = $1', [tokenHash(stale.accessToken)]);
  assert.equal((await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: stale.auth, body: { confirm: 'DELETE' } })).json.code, 'reauth_required');
});

test('when a request falls due the person and their identities are gone, team accounts are removed, and a sole owner\'s business is left for ops', async () => {
  const phone = random10();
  const own = await otherBusiness(app, 'Sole Owner Shop');
  await typedAccount(app, app.tenant, { phone, role: 'staff', permissions: ['orders'] });
  await typedAccount(app, own, { phone, role: 'owner' });
  await reset();
  const session = await codeSignIn(app, { phone, tenantId: app.tenant.id });
  assert.equal((await call(app, '/api/v1/auth/delete-account', { method: 'POST', headers: session.auth, body: { confirm: 'DELETE' } })).status, 202);
  await app.db.platform.query(`UPDATE account_deletion_requests SET due_at = now() - interval '1 minute', requested_at = now() - interval '31 days' WHERE status = 'requested'`);

  const done = await accountsFor(app.ctx).deletion.carryOut();
  assert.equal(done, 1);
  const [request] = await app.db.platform.query(`SELECT status, completed_at FROM account_deletion_requests ORDER BY id DESC LIMIT 1`);
  assert.equal(request.status, 'completed');
  assert.ok(request.completed_at);
  const identities = await app.db.platform.query(`SELECT 1 FROM person_identities WHERE subject = $1`, [`+91${phone}`]);
  assert.deepEqual(identities, []);
  const staff = await app.db.platform.query('SELECT removed_at, name, phone FROM users WHERE tenant_id = $1 AND person_id IS NOT NULL AND name = $2', [app.tenant.id, 'Deleted account']);
  assert.ok(staff.length >= 1 && staff.every((u) => u.removed_at && !u.phone.includes(phone)));
  const [ownerRow] = await app.db.platform.query(`SELECT removed_at FROM users WHERE tenant_id = $1 AND role = 'owner'`, [own.id]);
  assert.equal(ownerRow.removed_at, null, 'a business is never deleted here');
  const [kept] = await withTenant(own, () => app.db.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'account.deletion_owner_kept'`, [own.id]));
  assert.ok(kept);
  assert.equal(await accountsFor(app.ctx).deletion.carryOut(), 0, 'nothing more is due');
});
