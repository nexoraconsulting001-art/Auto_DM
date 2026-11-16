// The review login opens the demo business even when nobody ran scripts/demo-tenant.js first (PRD 10.6, P-24, F-50).
// Before, a configured review login with no demo business answered 401 to the right code ("flag_off"): App Review
// could not sign in although the go-live item for it was ready. The first accepted review sign-in now makes the demo
// business; a refused try makes nothing; first sign-ins at once, in one process or two, make one.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { demoTenantService } from '../../../src/modules/demo-tenant/index.js';
import { REVIEW_CODE, REVIEW_LOCAL, call, reviewApp, verify } from '../../p5/review-demo/support.js';

let app;
before(async () => { app = await reviewApp(); });
after(() => app?.close());

const demos = async () => (await app.db.platform.query('SELECT id FROM tenants WHERE is_demo')).map((r) => r.id);

test('a refused review try makes no demo business', async () => {
  assert.equal((await verify(app, REVIEW_LOCAL, '111111')).status, 401);
  assert.equal((await verify(app, '9876543210', REVIEW_CODE)).status, 401);
  assert.deepEqual(await demos(), [], 'a wrong code made the demo business');
});

test('first review sign-ins at once make one demo business with sample data, and every one opens it', async () => {
  const tries = await Promise.all([1, 2, 3].map(() => verify(app, REVIEW_LOCAL, REVIEW_CODE)));
  for (const res of tries) assert.equal(res.status, 201, `A first review sign-in: ${res.status} ${res.text.slice(0, 200)}`);
  const ids = await demos();
  assert.equal(ids.length, 1, `${ids.length} demo businesses`);
  for (const res of tries) assert.equal(res.json.business.id, ids[0], 'A review sign-in opened another business');
  const [login] = await app.db.platform.query('SELECT tenant_id FROM review_logins WHERE enabled');
  assert.equal(login.tenant_id, ids[0], 'The review login does not name the demo business');
  const uses = await app.db.platform.query('SELECT accepted, reason FROM review_login_uses WHERE accepted');
  assert.ok(uses.length >= 3 && uses.every((u) => u.reason === ''));
  const orders = await call(app, '/api/v1/orders?limit=50', { headers: { authorization: `Bearer ${tries[0].json.accessToken}` } });
  assert.equal(orders.status, 200);
  assert.ok(orders.json.items.length >= 3, `The demo business has ${orders.json.items.length} orders`);
});

test('two processes asking for the demo business at once get the same one, and an existing one is never rewritten', async () => {
  const [kept] = await demos();
  const [sample] = await app.db.platform.query('SELECT digest, filled_at FROM demo_samples WHERE tenant_id = $1', [kept]);
  const two = [1, 2].map(() => demoTenantService({ db: app.db, repos: app.platform, config: app.config }));
  assert.deepEqual(await Promise.all(two.map((s) => s.provide())), [kept, kept]);
  const [after] = await app.db.platform.query('SELECT digest, filled_at FROM demo_samples WHERE tenant_id = $1', [kept]);
  assert.deepEqual(after, sample, 'provide() rewrote the demo business');

  await app.db.platform.query('DELETE FROM tenants WHERE is_demo');
  const made = await Promise.all(two.map((s) => s.provide()));
  const ids = await demos();
  assert.equal(ids.length, 1, `${ids.length} demo businesses from two processes`);
  assert.deepEqual(made, [ids[0], ids[0]]);
});
