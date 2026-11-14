// PRD 5.20 (F-129): each account's referral link in admin, the referral written at sign-up, credited once when the referred
// account starts a paid plan, self-referrals blocked (the same person or phone, Instagram account or payment method), and
// never a referral link inside a DM.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { notePaymentMethod } from '../../../src/modules/referrals/index.js';
import { api, automationBody, call, world } from './support.js';

let w;
before(async () => {
  w = await world();
  await w.setMode('public');
  await w.sql('UPDATE billing_settings SET referral_reward_paise = 50000');
});
after(() => w?.close());

/** A referrer: a person who signed up, with their business and its code from referrals.get. */
async function referrer(name = 'Referrer Shop') {
  const who = await w.person();
  const { started } = await w.signUp(who, { name });
  const tenantId = started.json.tenantId;
  const headers = { ...who.headers, 'x-tenant-id': String(tenantId) };
  const mine = await call(w, '/api/v1/referrals', { headers });
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  return { who, tenantId, code: mine.json.code, link: mine.json.link, get: async () => (await call(w, '/api/v1/referrals', { headers })).json };
}

const referralOf = async (referredTenantId) => (await w.sql('SELECT tenant_id, state, block_reason, reward_paise, credited_at FROM seller_referrals WHERE referred_tenant_id = $1', [referredTenantId]))[0];

test('F-129: the link carries the code to the sign-up page; a referred account is credited once, on its first paid plan, and the referrer sees counts only', async () => {
  const ravi = await referrer();
  assert.match(ravi.code, /^[a-z0-9]{6,20}$/);
  assert.equal(ravi.link, `https://app.bhava.test/signup?ref=${ravi.code}`);
  const empty = await ravi.get();
  assert.deepEqual([empty.counts, empty.creditedPaise, empty.rewardPaise], [{ pending: 0, credited: 0, blocked: 0 }, 0, 50000]);

  // The code arrives with the page (?ref=) and is kept with the run.
  const friend = await w.person();
  const { started } = await w.signUp(friend, { name: 'Friend Shop', ref: ravi.code });
  assert.equal(started.status, 201);
  const referred = started.json.tenantId;
  assert.deepEqual(Object.values(await referralOf(referred)).slice(0, 2), [ravi.tenantId, 'pending']);

  // A gift from the console is not a paid plan.
  await w.changePlan(referred, 't1', { source: 'console' });
  assert.equal((await referralOf(referred)).state, 'pending');
  // The paid event, delivered three times and once more after a plan change: one credit.
  await w.changePlan(referred, 't1', { source: 'billing', actor: 'billing' });
  await w.changePlan(referred, 't1', { source: 'billing', actor: 'billing' });
  await Promise.all([w.changePlan(referred, 't2', { source: 'billing', actor: 'billing' }), w.changePlan(referred, 't2', { source: 'owner', actor: 'user:9' })]);
  const credited = await referralOf(referred);
  assert.deepEqual([credited.state, Number(credited.reward_paise)], ['credited', 50000]);
  const firstCredit = credited.credited_at;
  await w.changePlan(referred, 'free', { source: 'billing', actor: 'billing' });
  await w.changePlan(referred, 't3', { source: 'billing', actor: 'billing' });
  assert.deepEqual((await referralOf(referred)).credited_at, firstCredit, 'credited at most once');

  const seen = await ravi.get();
  assert.deepEqual([seen.counts.credited, seen.creditedPaise], [1, 50000]);
  assert.equal(JSON.stringify(seen).includes('Friend Shop'), false, 'nothing of the referred business is shown');

  // A second code later changes nothing: an account is referred once.
  const other = await referrer('Other Referrer');
  await w.sql(`UPDATE signup_runs SET referral_code = $1 WHERE tenant_id = $2`, [other.code, referred]);
  assert.equal((await referralOf(referred)).tenant_id, ravi.tenantId);
});

test('self-referrals are blocked: the same person, the same Instagram account, the same payment method', async () => {
  // The same person signing up a second business with their own code.
  const meera = await referrer('Meera Main');
  const again = await w.signUp(meera.who, { name: 'Meera Second', referralCode: meera.code });
  assert.equal(again.started.status, 201);
  assert.deepEqual([(await referralOf(again.started.json.tenantId)).state, (await referralOf(again.started.json.tenantId)).block_reason], ['blocked', 'same_phone']);
  await w.changePlan(again.started.json.tenantId, 't1', { source: 'billing', actor: 'billing' });
  assert.equal((await referralOf(again.started.json.tenantId)).state, 'blocked', 'a blocked referral is never credited');

  // The same Instagram account, on a referred account made by someone else.
  const kiran = await referrer('Kiran Main');
  await w.connectInstagram(kiran.tenantId, 'IG-KIRAN');
  await w.sql(`DELETE FROM ig_accounts WHERE ig_user_id = 'IG-KIRAN'`);
  const alt = await w.signUp(await w.person(), { name: 'Kiran Alt', referralCode: kiran.code });
  const altId = alt.started.json.tenantId;
  assert.equal((await referralOf(altId)).state, 'pending');
  await w.changePlan(altId, 't1', { source: 'console' }); // paid by gift, so the Free claim is not in the way
  await w.connectInstagram(altId, 'IG-KIRAN');
  assert.deepEqual([(await referralOf(altId)).state, (await referralOf(altId)).block_reason], ['blocked', 'same_instagram']);

  // The same payment method.
  const sana = await referrer('Sana Main');
  const sanaAlt = (await w.signUp(await w.person(), { name: 'Sana Alt', referralCode: sana.code })).started.json.tenantId;
  await notePaymentMethod(w.db, { tenantId: sana.tenantId, fingerprint: 'card-fp-1', key: 'test-key' });
  await notePaymentMethod(w.db, { tenantId: sanaAlt, fingerprint: 'card-fp-1', key: 'test-key' });
  assert.deepEqual([(await referralOf(sanaAlt)).state, (await referralOf(sanaAlt)).block_reason], ['blocked', 'same_payment_method']);
  const marks = await w.sql('SELECT mark_hash FROM seller_payment_marks WHERE tenant_id = $1', [sanaAlt]);
  assert.equal(JSON.stringify(marks).includes('card-fp-1'), false, 'only a keyed hash is kept');
  const counts = (await sana.get()).counts;
  assert.deepEqual(counts, { pending: 0, credited: 0, blocked: 1 });

  // A business's own rows only: one referrer cannot read another's referrals.
  const rows = await w.sql('SELECT count(*)::int AS n FROM seller_referrals WHERE tenant_id = $1', [sana.tenantId]);
  assert.equal(rows[0].n, 1);
});

test('no DM carries a referral link or a link to the platform, on any plan', async () => {
  const token = await w.ownerToken();
  const code = (await w.sql('SELECT code FROM seller_referral_codes LIMIT 1'))[0].code;
  for (const plan of ['free', 't3']) {
    await w.changePlan(w.tenant.id, plan);
    for (const [n, extra] of [
      [80, { linkUrl: `https://partner.example/join?ref=${code}` }],
      [81, { variants: [{ label: 'A', body: `Join me at https://app.bhava.test/signup?ref=${code}` }] }],
      [82, { linkUrl: 'https://admin.bhava.test/console' }],
    ]) {
      const made = await api(w, token, 'POST', '/automations', automationBody(n + (plan === 'free' ? 0 : 10), extra));
      if (made.status !== 201) {
        assert.equal(made.json.reason, 'content.bhava_promo', JSON.stringify(made.json));
        continue;
      }
      const live = await api(w, token, 'POST', `/automations/${made.json.id}/state`, { state: 'live' });
      assert.deepEqual([live.status, live.json.reason], [400, 'content.bhava_promo'], JSON.stringify(live.json));
      await api(w, token, 'DELETE', `/automations/${made.json.id}`);
    }
  }
});
