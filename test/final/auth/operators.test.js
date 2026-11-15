// auth-3 (PRD 5.10, 5.17): an operator whose access is turned off, whose role changes or whose authenticator is reset loses
// every session at once: the console's, and the impersonation and service sessions they opened inside businesses.
// auth-6 (PRD 5.10): impersonation opens the business as an owner still on its team, never a removed one.
import { test } from 'node:test';
import crypto from 'node:crypto';
import { assert, consoleUser, grantService, impersonate, need, one, opCall, shopOn, sql, startService, useBillingWorld } from '../../p7/spec-p7/support.js';

const world = useBillingWorld();
const opId = async (op) => (await one(world, 'SELECT id FROM platform_users WHERE email = $1', [op.email])).id;

async function stillOpen(session, what) {
  need(await session.call('GET', '/products'), 200, `${what} works before the change`);
}

async function endedFor(session, what) {
  const res = await session.call('GET', '/products');
  assert.equal(res.status, 401, `${what}: answered ${res.status} after the operator lost access`);
}

test('auth-3: turning an operator off ends their live impersonation inside the business at once', async () => {
  const shop = await shopOn(world, 't3');
  const admin = await consoleUser(world);
  const op = await consoleUser(world, 'support');
  const session = await impersonate(world, shop, op);
  await stillOpen(session, 'The impersonation');
  need(await opCall(world, admin, 'PATCH', `/team/${await opId(op)}`, { disabled: true, reason: 'left the team' }), 200, 'Turning the operator off');
  await endedFor(session, 'The impersonation of a disabled operator');
  const row = await one(world, 'SELECT ended_at FROM impersonation_sessions WHERE id = $1', [session.started.session.id]);
  assert.ok(row.ended_at, 'the impersonation is ended, not left to run out');
  const cookie = await one(world, 'SELECT revoked_at FROM sessions WHERE impersonation_id = $1', [session.started.session.id]);
  assert.ok(cookie.revoked_at, 'the cookie it opened is revoked');
});

test('auth-3: changing an operator\'s role ends their live impersonation', async () => {
  const shop = await shopOn(world, 't3');
  const admin = await consoleUser(world);
  const op = await consoleUser(world, 'support');
  const session = await impersonate(world, shop, op);
  await stillOpen(session, 'The impersonation');
  need(await opCall(world, admin, 'PATCH', `/team/${await opId(op)}`, { role: 'onboarding', reason: 'moved teams' }), 200, 'Changing the role');
  await endedFor(session, 'The impersonation of a demoted operator');
});

test('auth-3: turning a service operator off, or resetting their authenticator, ends their service sessions', async () => {
  const admin = await consoleUser(world);
  for (const change of [{ disabled: true }, { resetTotp: true }]) {
    const shop = await shopOn(world, 't3');
    await grantService(shop, 'catalog_management');
    const op = await consoleUser(world, 'service_operator');
    const session = await startService(world, shop, op, 'catalog_management', 'TASK-1');
    await stillOpen(session, 'The service session');
    need(await opCall(world, admin, 'PATCH', `/team/${await opId(op)}`, { ...change, reason: 'spec' }), 200, `Changing the operator: ${Object.keys(change)[0]}`);
    await endedFor(session, `The service session after ${Object.keys(change)[0]}`);
    const row = await one(world, 'SELECT ended_at FROM service_sessions WHERE id = $1', [session.started.session?.id ?? session.started.id]);
    assert.ok(row?.ended_at, 'the service session is ended');
  }
});

test('auth-3: a disabled operator\'s session ends even if it was opened behind the change\'s back (read-time check)', async () => {
  const shop = await shopOn(world, 't3');
  const op = await consoleUser(world, 'support');
  const session = await impersonate(world, shop, op);
  await stillOpen(session, 'The impersonation');
  // Straight in the table, as if the ending had been missed: the session is still checked against the operator on every request.
  await sql(world, 'UPDATE platform_users SET disabled_at = now() WHERE id = $1', [await opId(op)]);
  await endedFor(session, 'The impersonation of an operator disabled in the table');
});

test('auth-6: impersonation opens the business as an owner still on its team, not a removed one', async () => {
  const shop = await shopOn(world, 't3');
  const [first] = await sql(world, `SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner' ORDER BY id LIMIT 1`, [shop.tenantId]);
  const phone = `+9197${crypto.randomInt(10_000_000, 99_999_999)}`;
  const [second] = await sql(world, `INSERT INTO users (tenant_id, name, phone, role, password_hash) VALUES ($1, 'Second owner', $2, 'owner', '!') RETURNING id`, [shop.tenantId, phone]);
  // team.remove keeps the role and sets removed_at.
  await sql(world, 'UPDATE users SET removed_at = now() WHERE tenant_id = $1 AND id = $2', [shop.tenantId, first.id]);
  const op = await consoleUser(world, 'support');
  const session = await impersonate(world, shop, op);
  const row = await one(world, 'SELECT owner_user_id FROM impersonation_sessions WHERE id = $1', [session.started.session.id]);
  assert.equal(Number(row.owner_user_id), Number(second.id), 'the owner still on the team');
  assert.equal(session.me.status, 200, `the impersonated session answered ${session.me.status}`);
  need(await session.call('GET', '/products'), 200, 'Reading as the owner on the team');
});
