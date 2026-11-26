// atk-auth-1 (PRD 5.20, migration 928, auth-2): the day's cap counts every working business self-serve made today,
// whichever way it was made: a first sign-in (F-109) as much as signup.start. One count, signup_made_today(), is what the
// sign-up module, the first sign-in and the database's own check all use; a held place is not a business and is not counted.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { world } from '../../p7/signup-plans/support.js';

let w;
before(async () => { w = await world(); });
after(() => w?.close());

const madeToday = async () => Number((await w.sql('SELECT signup_made_today() AS n'))[0].n);
const placeOf = async (personId) => (await w.sql(
  `SELECT t.id, t.signup_held, t.signup_opened_at FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE u.person_id = $1 ORDER BY t.id`,
  [personId],
))[0];
const resetLimits = () => w.sql('DELETE FROM rate_limit_hits');

test('atk-auth-1: a working first-sign-in business is counted, a held place is not, and the cap then holds the next first sign-in', async () => {
  await w.setMode('public');
  await resetLimits();
  const before = await madeToday();
  const first = await w.person();
  const firstPlace = await placeOf(first.personId);
  assert.equal(firstPlace.signup_held, false);
  assert.ok(firstPlace.signup_opened_at, 'a working first business is stamped opened');
  assert.equal(await madeToday(), before + 1, 'the first sign-in counts against the day');

  await w.sql('UPDATE signup_settings SET daily_cap = $1', [before + 1]);
  try {
    const late = await w.person();
    const latePlace = await placeOf(late.personId);
    assert.equal(latePlace.signup_held, true, 'the cap is reached: the next first sign-in is held');
    assert.equal(latePlace.signup_opened_at, null);
    assert.equal(await madeToday(), before + 1, 'a held place is not counted');

    // signup.start: the person whose first business is already open finishes sign-up on it (it is not a new business)...
    const { started } = await w.signUp(first, { name: `Kept ${crypto.randomBytes(2).toString('hex')}` });
    assert.equal(started.status, 201, JSON.stringify(started.json));
    assert.equal(started.json.tenantId, Number(firstPlace.id), 'the open first business is adopted');
    assert.equal(await madeToday(), before + 1, 'adopting an open business opens nothing new');
    // ...while the held person is refused: that would be a new business past the cap.
    const refused = await w.signUp(late, { name: `Over ${crypto.randomBytes(2).toString('hex')}` });
    assert.deepEqual([refused.started.status, refused.started.json.reason], [403, 'signup.daily_cap']);
    assert.equal((await placeOf(late.personId)).signup_held, true);
  } finally {
    await w.sql('UPDATE signup_settings SET daily_cap = NULL');
  }
});

test('atk-auth-1: the database refuses to open a business past the cap, however the row is written', async () => {
  const already = await madeToday();
  await w.sql('UPDATE signup_settings SET daily_cap = $1', [Math.max(1, already)]);
  try {
    const slug = () => `cap-${crypto.randomBytes(4).toString('hex')}`;
    await assert.rejects(
      w.sql(`INSERT INTO tenants (slug, name, plan, account_type, signup_opened_at) VALUES ($1, 'Past cap', 'free', 'creator', now())`, [slug()]),
      /signup\.daily_cap/,
      'a business made open past the cap',
    );
    const [{ id }] = await w.sql(`INSERT INTO tenants (slug, name, plan, signup_held) VALUES ($1, 'Held', 'free', true) RETURNING id`, [slug()]);
    await assert.rejects(
      w.sql('UPDATE tenants SET signup_held = false, signup_opened_at = now() WHERE id = $1', [id]),
      /signup\.daily_cap/,
      'a held place opened past the cap',
    );
    await assert.rejects(w.sql('UPDATE tenants SET signup_opened_at = now() WHERE id = $1', [id]), /check|tenants_held_not_opened|signup\.daily_cap/i, 'a held place is never counted open');
    // Businesses we onboard ourselves are not self-serve: the cap does not touch them.
    const [console] = await w.sql(`INSERT INTO tenants (slug, name, plan, status) VALUES ($1, 'Onboarded', 'free', 'onboarding') RETURNING signup_opened_at`, [slug()]);
    assert.equal(console.signup_opened_at, null);
    assert.equal(await madeToday(), already);
  } finally {
    await w.sql('UPDATE signup_settings SET daily_cap = NULL');
  }
});
