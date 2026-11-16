// seller-ui-2: owners have no password (PRD line 842: "No passwords"; signup and team create them with NO_PASSWORD), so a
// refund cannot ask for one. A refund is owner only "after a fresh re-auth" (PRD 9.8, line 2467): the route is `fresh`, the
// server refuses a stale session with reauth_required, and the console and the owner app ask "Confirm it is you" instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RefundCreate, routes } from '../../../src/contracts/api/index.js';
import { NO_PASSWORD } from '../../../src/modules/accounts/shared.js';
import { hashSessionToken } from '../../../src/repos/sessions.js';
import { openWorld } from '../../p4/payments/support.js';
import { refundBody as refundRules } from '../../../apps/owner/src/features/orders/kit/rules.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const body = (amountPaise) => ({ amountPaise, reason: 'Damaged in transit', idempotencyKey: `rf-${crypto.randomUUID()}` });

test('the refund contract asks for a fresh session, never a password', () => {
  assert.equal(routes['refunds.create'].fresh, true, 'refunds.create is a fresh route');
  assert.equal('password' in RefundCreate.shape, false, 'RefundCreate takes no password');
  assert.equal(RefundCreate.safeParse(body(100)).success, true);
});

test('an owner with no password refunds on a fresh session; a stale session is asked to re-auth and nothing moves', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  // The owner as signup makes them: no password at all.
  await shop.sql(`UPDATE users SET password_hash = $2 WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenant.id, NO_PASSWORD]);

  const done = await shop.api('POST', `/orders/${order.id}/refunds`, body(20000));
  assert.equal(done.status, 201, done.text);
  assert.equal(done.json.amountPaise, 20000);
  const audit = await shop.sql(`SELECT action, actor FROM audit_log WHERE tenant_id = $1 AND action = 'refund.request'`, [shop.tenant.id]);
  assert.equal(audit.length, 1, 'the refund is in the audit log');
  assert.match(audit[0].actor, /^user:\d+$/);

  await shop.sql(`UPDATE sessions SET fresh_until = now() - interval '1 minute' WHERE id = $1`, [hashSessionToken(shop.token)]);
  const stale = await shop.api('POST', `/orders/${order.id}/refunds`, body(10000));
  assert.equal(stale.status, 403, stale.text);
  assert.equal(stale.json.code, 'reauth_required');
  assert.equal((await shop.refunds(order.id)).length, 1, 'no second refund');
  assert.equal((await world.rzp.get('/state')).refunds.length, 1, 'nothing more sent to the gateway');
});

test('a manager still cannot refund, fresh or not', async (t) => {
  const world = await openWorld(t);
  const { shop } = world;
  await shop.payReady();
  const { order } = await shop.paidOrder({ totalPaise: 99900 });
  const manager = await shop.member('manager', '9000000005');
  assert.equal((await shop.api('POST', `/orders/${order.id}/refunds`, body(100), { as: manager.token })).status, 403);
  assert.equal((await shop.refunds(order.id)).length, 0);
});

test('neither the console nor the owner app asks for a password to refund; both go through the re-auth', () => {
  const consoleScreen = read('console/src/features/payments/OrderMoney.jsx');
  const appScreen = read('apps/owner/src/features/refunds/RefundCreateScreen.js');
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // what runs, not what explains it
  for (const [name, text] of [['OrderMoney.jsx', consoleScreen], ['RefundCreateScreen.js', appScreen]]) {
    assert.doesNotMatch(code(text), /password/i, `${name} asks for no password`);
  }
  assert.match(consoleScreen, /api\.refunds\.create\(/, 'the console calls refunds.create, which the client re-auths for');
  assert.match(appScreen, /runFresh\(\(\) => api\.refunds\.create\(/, 'the app asks for the fresh check, as for every fresh route');
  assert.equal('password' in refundRules({ amountText: '10', idempotencyKey: 'k-12345678' }, { most: 99900 }).body, false, 'the app builds no password into a refund');
});

test('the activity simulator signs in again when a fresh route asks, as a seller re-auths, and never otherwise', async () => {
  const { sellerApi } = await import('../../../tools/sim/activity/seed.mjs');
  const run = async (answers) => {
    const tokens = [];
    const world = { hit: async (_url, options) => { tokens.push(options.token); return answers.shift(); } };
    const session = { token: 'old', login: async () => 'new' };
    const res = await sellerApi(world, 'shop.test', session).post('/orders/1/refunds', {}, { allow: [400, 403, 409] });
    return { res, tokens };
  };
  const asked = await run([{ status: 403, data: { code: 'reauth_required' } }, { status: 201, data: { id: 1 } }]);
  assert.deepEqual(asked.tokens, ['old', 'new']);
  assert.equal(asked.res.status, 201);
  const forbidden = await run([{ status: 403, data: { code: 'forbidden' } }]);
  assert.deepEqual(forbidden.tokens, ['old'], 'a plain refusal is not a reason to sign in again');
});
