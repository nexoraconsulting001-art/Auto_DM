// auth-4 (PRD 5.11; the team contract): an invitation is taken up when the invited person signs in with that identity,
// never the moment another business types their number; and removing someone from one business ends their sessions in
// that business only. Another business can never sign a person out of their own business.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsApp, call, codeSignIn, freshIp, otherBusiness, random10, testDevice, typedAccount } from '../../p5/accounts/support.js';

let app;
let owner;
before(async () => {
  app = await accountsApp();
  owner = await codeSignIn(app, { device: testDevice('Owner phone') });
});
after(() => app?.close());

const reset = async () => {
  await app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);
  await app.db.platform.query('DELETE FROM rate_limit_hits');
};
const as = (session) => ({ ...session.auth });
const personOf = async (phone) => (await app.db.platform.query(`SELECT person_id FROM person_identities WHERE kind = 'phone' AND subject = $1`, [`+91${phone}`]))[0]?.person_id
  ?? (await app.db.platform.query(`SELECT person_id FROM person_identities WHERE kind = 'phone' AND subject LIKE $1`, [`%${phone}`]))[0]?.person_id;

test('auth-4: inviting the owner of another business does not make an account for them until they sign in', async () => {
  const phone = random10();
  const theirs = await otherBusiness(app, 'Their Own Shop');
  await typedAccount(app, theirs, { phone, role: 'owner', name: 'Their Owner' });
  await reset();
  const mine = await codeSignIn(app, { phone, tenantId: theirs.id, device: testDevice('Their phone') });
  const personId = await personOf(phone);
  assert.ok(personId, 'the person proved their number');

  const invite = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: phone, role: 'staff', permissions: ['orders'] } });
  assert.equal(invite.status, 201, invite.text);
  const made = await app.db.platform.query('SELECT id FROM users WHERE tenant_id = $1 AND person_id = $2', [app.tenant.id, personId]);
  assert.deepEqual(made, [], 'an account appeared in the inviting business before the person signed in');
  const [open] = await app.db.platform.query('SELECT accepted_at FROM team_invites WHERE tenant_id = $1 AND id = $2', [app.tenant.id, invite.json.id]);
  assert.equal(open.accepted_at, null, 'the invitation is still open');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: as(mine) })).status, 200);

  // Signing in does not take it up (R6-SEC): the person accepts it, with the code the owner passed on.
  await reset();
  await assert.rejects(() => codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Their phone 2') }), /403/, 'signing in alone joined the inviting business');
  assert.equal((await call(app, '/api/v1/auth/invites/accept', { method: 'POST', headers: as(mine), body: { code: invite.json.code } })).status, 201);
  await reset();
  const joined = await codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Their phone 2') });
  assert.equal(joined.user.role, 'staff');
});

test('auth-4: removing someone ends their sessions in this business only, never in their own business', async () => {
  const phone = random10();
  const theirs = await otherBusiness(app, 'Kept Shop');
  await typedAccount(app, theirs, { phone, role: 'owner', name: 'Kept Owner' });
  await reset();
  const inTheirs = await codeSignIn(app, { phone, tenantId: theirs.id, device: testDevice('Kept phone') });
  await reset();
  const webTheirs = await codeSignIn(app, { phone, tenantId: theirs.id, transport: 'cookie', device: testDevice('Kept laptop') });

  const invite = await call(app, '/api/v1/team/invites', { method: 'POST', headers: as(owner), body: { contact: phone, role: 'staff', permissions: ['orders'] } });
  assert.equal(invite.status, 201, invite.text);
  assert.equal((await call(app, '/api/v1/auth/invites/accept', { method: 'POST', headers: as(inTheirs), body: { code: invite.json.code } })).status, 201);
  await reset();
  const inMine = await codeSignIn(app, { phone, tenantId: app.tenant.id, device: testDevice('Kept phone 2') });
  assert.equal(inMine.user.role, 'staff');

  const removed = await call(app, `/api/v1/team/${inMine.user.id}`, { method: 'DELETE', headers: as(owner) });
  assert.equal(removed.status, 204, removed.text);
  assert.equal((await call(app, '/api/v1/auth/me', { headers: as(inMine) })).status, 401, 'the removed account is signed out here');
  assert.equal((await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: inMine.refreshToken }, ip: freshIp() })).status, 401, 'and cannot refresh into it');

  assert.equal((await call(app, '/api/v1/auth/me', { headers: as(inTheirs) })).status, 200, 'their own business\'s app session was ended by another business');
  assert.equal((await call(app, '/api/v1/auth/me', { headers: as(webTheirs) })).status, 200, 'their own business\'s web session was ended by another business');
  const refreshed = await call(app, '/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: inTheirs.refreshToken }, ip: freshIp() });
  assert.ok(refreshed.status < 300, `their own app could not refresh: ${refreshed.status}`);
});
