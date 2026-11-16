// auth-7 (PRD 5.11): a stranger who knows an owner's number cannot use up the code limits that the owner's own re-auth
// needs. Anonymous sign-in sends and tries are counted per number; a signed-in person's re-auth has its own count.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER, accountsApp, call, codeSignIn, freshIp, sellerCodeFor, testDevice } from '../../p5/accounts/support.js';

let app;
before(async () => { app = await accountsApp(); });
after(() => app?.close());

/** Lets the next code go out at once, as if the resend wait had passed. Limits are left as they are. */
const pastResendWait = () => app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);

test('auth-7: a stranger spending the anonymous per-number limits does not stop the owner re-authing', async () => {
  const owner = await codeSignIn(app, { device: testDevice('Owner phone') });

  // The stranger: every code send the number allows in an hour, then every wrong guess it allows in 15 minutes.
  for (let i = 0; i < 6; i++) {
    await pastResendWait();
    await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone: OWNER.phone }, ip: freshIp() });
  }
  await pastResendWait();
  assert.equal((await call(app, '/api/v1/auth/start', { method: 'POST', body: { phone: OWNER.phone }, ip: freshIp() })).status, 429, 'the anonymous per-number send limit is reached');
  for (let i = 0; i < 11; i++) await call(app, '/api/v1/auth/verify', { method: 'POST', body: { phone: OWNER.phone, code: '000000' }, ip: freshIp() });

  // The owner, signed in, asks for a re-auth code and types it.
  const started = await call(app, '/api/v1/auth/reauth/start', { method: 'POST', headers: owner.auth, ip: freshIp() });
  assert.equal(started.status, 202, `reauth.start answered ${started.status}`);
  assert.equal(started.json.sent, true);
  const code = await sellerCodeFor(app.whatsapp, OWNER.phone);
  const verified = await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: owner.auth, body: { code }, ip: freshIp() });
  assert.equal(verified.status, 200, `reauth.verify answered ${verified.status}: ${verified.text}`);
  assert.ok(verified.json.freshUntil);
});

test('auth-7: the owner\'s own re-auth is still limited, per person', async () => {
  await app.db.platform.query('DELETE FROM rate_limit_hits');
  const owner = await codeSignIn(app, { device: testDevice('Owner phone 2') });
  const answers = [];
  for (let i = 0; i < 12; i++) {
    answers.push((await call(app, '/api/v1/auth/reauth/verify', { method: 'POST', headers: owner.auth, body: { code: '000000' }, ip: freshIp() })).status);
  }
  assert.ok(answers.includes(429), `twelve wrong re-auth codes were never limited: ${answers.join(',')}`);
});
