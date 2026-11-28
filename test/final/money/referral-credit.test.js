// R7-MONEY-3 (M-10, user decision 2026-11-27): a referral is credited only once the referred business has connected an
// Instagram account the referrer never had AND has paid, in either order. Paying with no Instagram connected, or with only
// the referrer's own account, credits nothing.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { call, world } from '../../p7/signup-plans/support.js';

let w;
before(async () => {
  w = await world();
  await w.setMode('public');
  await w.sql('UPDATE billing_settings SET referral_reward_paise = 50000');
});
after(() => w?.close());

async function referrer(name = 'Referrer Shop') {
  const who = await w.person();
  const { started } = await w.signUp(who, { name });
  const tenantId = started.json.tenantId;
  const headers = { ...who.headers, 'x-tenant-id': String(tenantId) };
  const mine = await call(w, '/api/v1/referrals', { headers });
  return { tenantId, code: mine.json.code, get: async () => (await call(w, '/api/v1/referrals', { headers })).json };
}
async function referred(code) {
  const { started } = await w.signUp(await w.person(), { name: 'Friend Shop', ref: code });
  assert.equal(started.status, 201);
  return started.json.tenantId;
}
const referralOf = async (id) => (await w.sql('SELECT state, block_reason, reward_paise, credited_at FROM seller_referrals WHERE referred_tenant_id = $1', [id]))[0];
const paid = (id) => w.changePlan(id, 't1', { source: 'billing', actor: 'billing' });

test('M-10: paying with no Instagram connected credits nothing; connecting a different account then credits once', async () => {
  const ravi = await referrer();
  await w.connectInstagram(ravi.tenantId, 'IG-RAVI-1');
  const friend = await referred(ravi.code);
  await paid(friend);
  assert.equal((await referralOf(friend)).state, 'pending', 'paid, but no Instagram of its own yet');
  assert.deepEqual([(await ravi.get()).counts.credited, (await ravi.get()).creditedPaise], [0, 0]);

  await w.connectInstagram(friend, 'IG-FRIEND-1');
  const row = await referralOf(friend);
  assert.deepEqual([row.state, Number(row.reward_paise)], ['credited', 50000]);
  await w.connectInstagram(friend, 'IG-FRIEND-2');
  await paid(friend);
  assert.deepEqual((await referralOf(friend)).credited_at, row.credited_at, 'credited once');
});

test('M-10: connecting a different Instagram account first credits nothing until the business pays; a console gift is not paying', async () => {
  const asha = await referrer('Asha Shop');
  const friend = await referred(asha.code);
  await w.connectInstagram(friend, 'IG-FRIEND-3');
  assert.equal((await referralOf(friend)).state, 'pending', 'connected, not paid');
  await w.changePlan(friend, 't1', { source: 'console' });
  assert.equal((await referralOf(friend)).state, 'pending');
  await paid(friend);
  assert.equal((await referralOf(friend)).state, 'credited');
});

test('M-10: the referrer’s own Instagram account on the referred business blocks the credit, paid or not', async () => {
  const kiran = await referrer('Kiran Shop');
  await w.connectInstagram(kiran.tenantId, 'IG-KIRAN-9');
  await w.sql(`DELETE FROM ig_accounts WHERE ig_user_id = 'IG-KIRAN-9'`);
  const friend = await referred(kiran.code);
  await paid(friend);
  await w.connectInstagram(friend, 'IG-KIRAN-9');
  const row = await referralOf(friend);
  assert.deepEqual([row.state, row.block_reason, row.credited_at], ['blocked', 'same_instagram', null]);
});
