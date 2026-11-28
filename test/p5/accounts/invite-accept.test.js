// R6-SEC: a team invitation is taken up only by the invitee's own act (PRD 5.11): signed in with the invited phone or
// email verified, they accept with the code the owner passed on. Signing in alone joins nothing, and until they accept the
// inviting business learns nothing about them: not their name, not their number, not that they use Bhava at all.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsApp, call, codeSignIn, random10, testDevice } from './support.js';

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
const accept = (session, code) => call(app, '/api/v1/auth/invites/accept', { method: 'POST', headers: session.auth, body: { code } });

test('signing in with an invited number joins nothing and tells the inviter nothing; accepting with the code does', async () => {
  const phone = random10();
  const invited = await call(app, '/api/v1/team/invites', { method: 'POST', headers: owner.auth, body: { contact: phone, role: 'staff', permissions: ['orders'] } });
  assert.equal(invited.status, 201, invited.text);
  assert.equal(typeof invited.json.code, 'string', 'the owner gets the invitation code once, to pass on');
  assert.ok(invited.json.code.length >= 20);
  assert.equal((await call(app, '/api/v1/team', { headers: owner.auth })).json.invites.some((i) => 'code' in i), false, 'and never again');

  // The invitee signs in to their own business: nothing happens in the inviting one.
  await reset();
  const invitee = await codeSignIn(app, { phone, device: testDevice('Their phone') });
  assert.notEqual(invitee.business.id, app.tenant.id, 'their sign-in does not land in the inviting business');
  assert.equal(invitee.businesses.some((b) => b.id === app.tenant.id), false, 'nor is it in their switcher');
  const before = await call(app, '/api/v1/team', { headers: owner.auth });
  assert.equal(before.json.items.some((m) => m.phone.endsWith(phone.slice(-4))), false, 'the inviter sees no member with their number');
  assert.ok(before.json.invites.some((i) => i.id === invited.json.id), 'the invitation is still open');

  // A wrong code, or the right code in someone else's hands, joins nobody, with one answer for both.
  assert.equal((await accept(invitee, 'not-the-code-at-all-0000')).status, 404);
  await reset();
  const stranger = await codeSignIn(app, { phone: random10(), device: testDevice('Stranger phone') });
  const theirs = await accept(stranger, invited.json.code);
  assert.equal(theirs.status, 404, 'the code works only for the person invited');
  assert.equal((await call(app, '/api/v1/team', { headers: owner.auth })).json.invites.some((i) => i.id === invited.json.id), true);

  // The invitee accepts: now they are on the team, with the invitation's role.
  const yes = await accept(invitee, invited.json.code);
  assert.equal(yes.status, 201, yes.text);
  assert.deepEqual([yes.json.business.id, yes.json.business.role], [app.tenant.id, 'staff']);
  const team = await call(app, '/api/v1/team', { headers: owner.auth });
  const joined = team.json.items.find((m) => m.phone.endsWith(phone.slice(-4)));
  assert.ok(joined, 'on the team once accepted');
  assert.deepEqual([joined.role, joined.permissions], ['staff', ['orders']]);
  assert.equal(team.json.invites.some((i) => i.id === invited.json.id), false, 'taken up');
  assert.equal((await accept(invitee, invited.json.code)).status, 404, 'a code works once');
  const businesses = await call(app, '/api/v1/auth/businesses', { headers: invitee.auth });
  assert.ok(businesses.json.businesses.some((b) => b.id === app.tenant.id), 'and the business is in their switcher');
});
