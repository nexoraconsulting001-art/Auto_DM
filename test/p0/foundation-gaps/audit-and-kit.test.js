// Business statuses, the audit trail of payment keys, the owner's audit log and public-reply variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addBusiness, addStaff, api, need, signIn, startWorld } from '../spec-p0/support.js';
import { setup } from '../../helpers.js';
import { maskKeyId } from '../../../src/modules/gateway-keys/index.js';

const KEY_ID = 'rzp_test_AbCdEf991234'; // secret-scan:allow (made up)
const OTHER_KEY_ID = 'rzp_live_ZyXwVu885678'; // secret-scan:allow (made up)
const KEY_SECRET = 'madeUpGatewaySecretValue'; // secret-scan:allow (made up)

async function shop(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  return { app, a, token: await signIn(app, a) };
}

test('a business can be in every status the requirements name, and in no other', async () => {
  const { db, tenant } = await setup();
  for (const status of ['onboarding', 'active', 'paused', 'suspended', 'closed', 'killed']) {
    await db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenant.id, status]);
  }
  await assert.rejects(() => db.query(`UPDATE tenants SET status = 'gone' WHERE id = $1`, [tenant.id]), /check constraint/);
});

test('only the masked key id reaches the audit log, and the secret is encrypted at rest', async (t) => {
  const { app, a, token } = await shop(t);
  const save = (keyId) => api(app, a, token, '/settings/payment', { method: 'PATCH', body: { razorpayKeyId: keyId, razorpayKeySecret: KEY_SECRET } });
  const first = need(await save(KEY_ID), 200, 'first save');
  assert.doesNotMatch(first.text, /madeUpGateway|AbCdEf/, 'the answer holds no key');
  need(await save(OTHER_KEY_ID), 200, 'second save');

  const rows = await app.db.query(`SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'payment_keys.change' ORDER BY id`, [a.tenant.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].target, 'razorpay');
  assert.deepEqual(rows[1].details, { from: 'rzp_...1234', to: 'rzp_...5678', secretChanged: true });
  assert.match(rows[0].actor, /^user:\d+$/, 'an id, no name or phone');
  assert.doesNotMatch(JSON.stringify(rows), /AbCdEf|ZyXwVu|madeUpGateway/);

  const [stored] = await app.db.query('SELECT * FROM gateway_keys WHERE tenant_id = $1', [a.tenant.id]);
  assert.doesNotMatch(JSON.stringify(stored), /madeUpGateway/);
  assert.deepEqual(await a.repos.gatewayKeys.get('razorpay'), { keyId: OTHER_KEY_ID, keySecret: KEY_SECRET });
});

test('the key id and secret must come together, and a malformed key id is refused', async (t) => {
  const { app, a, token } = await shop(t);
  const patch = (body) => api(app, a, token, '/settings/payment', { method: 'PATCH', body });
  assert.equal((await patch({ razorpayKeyId: KEY_ID })).status, 400);
  assert.equal((await patch({ razorpayKeySecret: KEY_SECRET })).status, 400);
  assert.equal((await patch({ razorpayKeyId: 'not-a-key', razorpayKeySecret: KEY_SECRET })).status, 400);
  assert.deepEqual(await app.db.query('SELECT 1 FROM audit_log WHERE tenant_id = $1', [a.tenant.id]), [], 'a refused change writes no row');
  need(await patch({ upiId: 'shop@upi' }), 200, 'UPI alone still works, with no key audit');
  assert.deepEqual(await app.db.query('SELECT 1 FROM gateway_keys'), []);
});

test('a masked key id keeps only the rzp_ prefix and the last four characters', () => {
  assert.equal(maskKeyId('rzp_test_AbCd1234'), 'rzp_...1234'); // secret-scan:allow (made up)
  assert.equal(maskKeyId('abcd1234'), '...1234');
});

test('saving settings is all or nothing', async () => {
  const { repos } = await setup();
  await repos.settings.update({ upi_id: 'old@upi', upi_payee: 'Old Payee' });
  await assert.rejects(() => repos.settings.update({ upi_id: 'new@upi', upi_payee: 'bad\0value' }));
  const saved = await repos.settings.getAll();
  assert.deepEqual([saved.upi_id, saved.upi_payee], ['old@upi', 'Old Payee']);
});

test('the owner reads the audit log newest first, a page at a time', async (t) => {
  const { app, a, token } = await shop(t);
  for (let i = 1; i <= 5; i++) await a.repos.audit.record({ actor: 'user:1', action: 'brand.update', target: `row-${i}`, details: { n: i } });
  const first = need(await api(app, a, token, '/audit-log?limit=2'), 200, 'first page').json();
  assert.deepEqual(first.items.map((r) => r.target), ['row-5', 'row-4']);
  assert.deepEqual(first.items[0].details, { n: 5 });
  assert.ok(first.nextCursor);
  const second = need(await api(app, a, token, `/audit-log?limit=2&cursor=${first.nextCursor}`), 200, 'second page').json();
  assert.deepEqual(second.items.map((r) => r.target), ['row-3', 'row-2']);
  assert.equal((await api(app, a, token, '/audit-log?cursor=not-a-cursor')).status, 400);
});

test('staff cannot open the audit log, whatever they may otherwise do', async (t) => {
  const { app, a } = await shop(t);
  const staff = await addStaff(app, a, { permissions: ['orders', 'catalog', 'automations', 'analytics', 'customers', 'inbox'] });
  assert.equal((await api(app, a, staff.token, '/audit-log')).status, 403);
});

const VARIANTS = ['Sent!', 'Check your DMs', 'Just messaged you', 'Look in your inbox', 'It is on the way'];

test('public replies refuse phone numbers, prices, bare domains, blanks and repeats', async () => {
  const { repos } = await setup();
  await repos.brandKit.save({ publicReplyVariants: VARIANTS });
  for (const [what, list] of Object.entries({
    'a phone number': [...VARIANTS.slice(0, 4), 'Call 98765 43210'],
    'a price': [...VARIANTS.slice(0, 4), 'Only ₹499 today'],
    'a price in words': [...VARIANTS.slice(0, 4), 'Just Rs. 499'],
    'a bare domain': [...VARIANTS.slice(0, 4), 'See mystore.in now'],
    'a blank': [...VARIANTS.slice(0, 4), '   '],
    'repeats': [...VARIANTS.slice(0, 4), VARIANTS[0]],
  })) {
    await assert.rejects(() => repos.brandKit.save({ publicReplyVariants: list }), /reply|replies/i, what);
  }
  assert.deepEqual((await repos.brandKit.get()).publicReplyVariants, VARIANTS, 'the saved list is untouched');
});

test('public replies survive other kit changes, a change of look, and can be cleared', async () => {
  const { repos } = await setup();
  assert.deepEqual((await repos.brandKit.get()).publicReplyVariants, [], 'none by default');
  await repos.brandKit.save({ publicReplyVariants: VARIANTS });
  await repos.brandKit.save({ headingFont: 'Lora' });
  assert.deepEqual((await repos.brandKit.get()).publicReplyVariants, VARIANTS);
  await repos.brandKit.save({ preset: 'mitti' });
  assert.deepEqual((await repos.brandKit.get()).publicReplyVariants, VARIANTS);
  await repos.brandKit.save({ publicReplyVariants: [] });
  assert.deepEqual((await repos.brandKit.get()).publicReplyVariants, []);
});
