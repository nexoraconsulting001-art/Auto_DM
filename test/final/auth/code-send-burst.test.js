// PRD 5.11: the per-number send limit counts codes that go out. Before, every request of a burst for one number was
// counted before the one that made the code was known (waiting -> count -> issue), so six requests at the same moment
// used up the number's five sends for the hour while one code went out. The count now happens in the transaction that
// makes the code, under the number's lock, so only that request counts. (Calls sendCode directly, so the requests
// interleave on PGlite too; over HTTP they rarely overlap on one connection.)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_LIMITS } from '../../../src/contracts/accounts.js';
import { accountsFor } from '../../../src/modules/accounts/index.js';
import { signInHandlers } from '../../../src/modules/accounts/sign-in.js';
import { accountsApp, random10, sentCount } from '../../p5/accounts/support.js';

let app;
before(async () => { app = await accountsApp(); });
after(() => app?.close());

const pastResendWait = () => app.db.platform.query(`UPDATE seller_login_codes SET created_at = created_at - interval '31 seconds'`);

test('six sends for one number at once count as one, and the number keeps the rest of its hourly sends', async () => {
  const { sendCode } = signInHandlers(app.ctx, accountsFor(app.ctx));
  const subject = `+91${random10()}`;
  const before = await sentCount(app.whatsapp);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => sendCode({ subject, purpose: 'signin' })));
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason?.code ?? String(r.reason)), [], 'a send of the burst was refused');
  assert.equal((await sentCount(app.whatsapp)) - before, 1, 'one burst, one code');
  // Four more codes may go out this hour (five in all), and the sixth is refused.
  for (let i = 0; i < AUTH_LIMITS.codeSendsPerNumber.limit - 1; i++) {
    await pastResendWait();
    await sendCode({ subject, purpose: 'signin' });
  }
  assert.equal((await sentCount(app.whatsapp)) - before, AUTH_LIMITS.codeSendsPerNumber.limit);
  await pastResendWait();
  await assert.rejects(sendCode({ subject, purpose: 'signin' }), (err) => err.code === 'rate_limited');
  assert.equal((await sentCount(app.whatsapp)) - before, AUTH_LIMITS.codeSendsPerNumber.limit, 'a refused send sent a code');
});
