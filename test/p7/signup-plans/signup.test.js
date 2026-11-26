// PRD 5.20: self-serve sign-up on the sign-in host, its mode on the server, invites, limits, the guided first automation
// and the step times (F-121, F-122), and one Free plan per Instagram account held by the database.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNUP_STEPS } from '../../../src/contracts/billing.js';
import { captureLogs } from '../../p5/accounts/support.js';
import { checkPassword } from '../../../src/repos/users.js';
import { world } from './support.js';

let w;
before(async () => {
  w = await world();
});
after(() => w?.close());

const REEL = '17900000000000501';
const tenantsOf = async (personId) => (await w.sql(`SELECT DISTINCT tenant_id FROM users WHERE person_id = $1 AND role = 'owner'`, [personId])).map((r) => r.tenant_id);

test('sign-up needs a signed-in person, and the mode is the server’s: closed refuses, invite needs a code that works once', async () => {
  const anonymous = await w.signup(null, 'POST', '/signup', { accountType: 'creator', name: 'Nobody' });
  assert.equal(anonymous.status, 401);

  await w.setMode('closed');
  const asha = await w.person();
  const status = await w.signup(asha, 'GET', '/signup');
  assert.deepEqual([status.status, status.json.mode, status.json.open, status.json.signedIn], [200, 'closed', false, true]);
  const closed = await w.signup(asha, 'POST', '/signup', { accountType: 'creator', name: 'Asha Looks', runToken: status.json.runToken });
  assert.deepEqual([closed.status, closed.json.code, closed.json.reason], [403, 'forbidden', 'signup.closed']);

  await w.setMode('invite');
  const made = await w.console('POST', '/signup/invites', { note: 'Pilot', maxUses: 1 });
  assert.equal(made.status, 201);
  const { code } = made.json;
  const stored = await w.sql('SELECT code_hash FROM signup_invites WHERE id = $1', [made.json.invite.id]);
  assert.equal(JSON.stringify(stored).includes(code.replace(/-/g, '')), false, 'only the hash is kept');
  assert.equal((await w.signup(asha, 'POST', '/signup', { accountType: 'creator', name: 'Asha Looks' })).json.reason, 'signup.invite_required');
  assert.equal((await w.signup(asha, 'GET', `/signup?inviteCode=${code}`)).json.open, true, 'a usable code opens the page');

  // Two people with the same single-use code at the same moment: exactly one business is made.
  const [ravi, meera] = [await w.person(), await w.person()];
  const tries = await Promise.all([ravi, meera].map((who) => w.signup(who, 'POST', '/signup', { accountType: 'seller', name: 'Race Shop', inviteCode: code.toLowerCase() })));
  assert.deepEqual(tries.map((t) => t.status).sort(), [201, 403]);
  assert.equal(tries.find((t) => t.status === 403).json.reason, 'signup.invite_invalid');
  assert.deepEqual((await w.sql('SELECT uses, max_uses FROM signup_invites WHERE id = $1', [made.json.invite.id]))[0], { uses: 1, max_uses: 1 });

  const revoked = await w.console('POST', `/signup/invites/${made.json.invite.id}/revoke`);
  assert.ok(revoked.json.revokedAt);
  const list = await w.console('GET', '/signup/invites');
  assert.equal(list.json.items[0].id, made.json.invite.id);
  assert.equal(JSON.stringify(list.json).includes(code), false, 'the code is shown once, when made');
  const mode = await w.console('PUT', '/signup', { mode: 'public', reason: 'Advanced Access granted' });
  assert.deepEqual([mode.status, mode.json.mode, mode.json.freePerInstagram], [200, 'public', 1]);
  assert.equal((await w.sql(`SELECT count(*)::int AS n FROM audit_log WHERE tenant_id IS NULL AND action = 'signup.mode_set'`))[0].n, 1);
});

test('F-122: a person signed in with a WhatsApp code gets one Free business of the type they chose, at an address that is not reserved, with no password', async () => {
  await w.setMode('public');
  const priya = await w.person();
  const before = await tenantsOf(priya.personId);
  assert.equal(before.length, 1, 'the first sign-in made the empty business of F-109');
  const { started } = await w.signUp(priya, { name: 'Admin', accountType: 'creator' });
  assert.equal(started.status, 201, JSON.stringify(started.json));
  assert.notEqual(started.json.slug, 'admin');
  assert.match(started.json.host, new RegExp(`^${started.json.slug}\\.bhava\\.test$`));
  assert.deepEqual(await tenantsOf(priya.personId), before, 'the empty first business became this one: no second business');
  const [tenant] = await w.sql('SELECT plan, account_type, name FROM tenants WHERE id = $1', [started.json.tenantId]);
  assert.deepEqual(tenant, { plan: 'free', account_type: 'creator', name: 'Admin' });
  const [owner] = await w.sql('SELECT role, password_hash FROM users WHERE tenant_id = $1 AND person_id = $2', [started.json.tenantId, priya.personId]);
  assert.deepEqual(owner, { role: 'owner', password_hash: null }); // no password is NULL (migration 976, user decision 2026-11-26)
  for (const tried of ['', '!', 'null', 'password']) assert.equal(await checkPassword(tried, owner.password_hash), false, 'no password never signs in by password');
  const audit = await w.sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'business.created' ORDER BY id DESC LIMIT 1`, [started.json.tenantId]);
  assert.equal(audit[0].details.via, 'signup');

  // A second sign-up by the same person makes a second business (their first is no longer empty of a run).
  const second = await w.signUp(priya, { name: 'Priya Two' });
  assert.equal(second.started.status, 201);
  assert.notEqual(second.started.json.tenantId, started.json.tenantId);
  assert.equal((await tenantsOf(priya.personId)).length, 2);
});

test('sign-up is limited per person and per address', async () => {
  await w.setMode('public');
  const busy = await w.person();
  const answers = [];
  for (let i = 0; i < 6; i++) answers.push((await w.signUp(busy, { name: `Busy ${i}` })).started.status);
  assert.deepEqual(answers, [201, 201, 201, 201, 201, 429], 'five a day per person');

  const ip = '10.250.0.9';
  const statuses = [];
  for (let i = 0; i < 11; i++) {
    const who = await w.person();
    statuses.push((await w.signup(who, 'POST', '/signup', { accountType: 'seller', name: `Same Address ${i}` }, ip)).status);
  }
  assert.equal(statuses.at(-1), 429, 'ten an hour per address');
  assert.equal(statuses.filter((s) => s === 201).length, 10);
});

test('F-121: Instagram, then a reel, a keyword and a link go live as a two-tap automation after the link and template checks; each step is timed once', async () => {
  await w.setMode('public');
  const nisha = await w.person();
  const { runToken, started } = await w.signUp(nisha, { name: 'Nisha Studio', accountType: 'creator' });
  const tenantId = started.json.tenantId;
  assert.equal(started.json.next, 'instagram_connected');

  const early = await w.signup(nisha, 'POST', '/signup/first-automation', { runToken, mediaId: REEL, keyword: 'LINK', link: 'https://nisha.example/shop' });
  assert.deepEqual([early.json.live, early.json.problems[0].reason], [false, 'instagram.not_connected']);

  await w.connectInstagram(tenantId, 'IG-NISHA');
  // A shortener is refused by the link rules (4.11) and nothing goes live.
  const bad = await w.signup(nisha, 'POST', '/signup/first-automation', { runToken, mediaId: REEL, keyword: 'LINK', link: 'https://bit.ly/abc' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.live, false);
  assert.equal(bad.json.problems[0].field, 'link');
  assert.equal((await w.sql(`SELECT count(*)::int AS n FROM automations WHERE tenant_id = $1 AND state = 'live'`, [tenantId]))[0].n, 0);

  // A referral link or the platform's own page in a DM is refused (4.10).
  const promo = await w.signup(nisha, 'POST', '/signup/first-automation', { runToken, mediaId: REEL, keyword: 'LINK', link: 'https://app.bhava.test/signup?ref=abcdefgh' });
  assert.deepEqual([promo.json.live, promo.json.problems[0].reason], [false, 'content.bhava_promo']);

  const good = await w.signup(nisha, 'POST', '/signup/first-automation', { runToken, mediaId: REEL, keyword: 'LINK', link: 'https://nisha.example/shop' });
  assert.equal(good.json.live, true, JSON.stringify(good.json));
  const [automation] = await w.sql('SELECT state, link_mode, link_url, keywords FROM automations WHERE tenant_id = $1 AND id = $2', [tenantId, good.json.automationId]);
  assert.deepEqual([automation.state, automation.link_mode, automation.link_url], ['live', 'two_tap', 'https://nisha.example/shop']);
  const again = await w.signup(nisha, 'POST', '/signup/first-automation', { runToken, mediaId: REEL, keyword: 'SHOP', link: 'https://nisha.example/shop' });
  assert.equal(again.json.automationId, good.json.automationId, 'the same reel again changes that automation');
  assert.equal((await w.sql('SELECT count(*)::int AS n FROM automations WHERE tenant_id = $1', [tenantId]))[0].n, 1);

  const lines = await captureLogs(async () => {
    const finished = await w.signup(nisha, 'POST', '/signup/finish', { runToken });
    assert.equal(finished.status, 200);
    assert.equal(finished.json.tenantId, tenantId);
    assert.equal(finished.json.withinTarget, true);
    assert.ok(finished.json.elapsedMs >= 0);
  });
  assert.equal(lines.join('\n').includes(nisha.phone), false, 'no phone number in the logs');
  assert.ok(lines.some((line) => line.includes('signup.finished')));

  const status = await w.signup(nisha, 'GET', `/signup?runToken=${runToken}`);
  assert.deepEqual(status.json.steps.map((s) => s.step), SIGNUP_STEPS, 'every step, once, in order');
  assert.equal(status.json.next, null);
  const [{ n }] = await w.sql('SELECT count(*)::int AS n FROM signup_steps s JOIN signup_runs r ON r.id = s.run_id WHERE r.tenant_id = $1', [tenantId]);
  assert.equal(n, SIGNUP_STEPS.length);

  // Someone else's run token gets them nothing of it.
  const stranger = await w.person();
  assert.equal((await w.signup(stranger, 'POST', '/signup/finish', { runToken })).status, 404);
  const theirs = await w.signup(stranger, 'GET', `/signup?runToken=${runToken}`);
  assert.notEqual(theirs.json.runToken, runToken);
  assert.equal(theirs.json.tenantId, null);
});

test('one Free plan per Instagram account, held by the database even when two businesses connect it at once', async () => {
  await w.setMode('public');
  const first = (await w.signUp(await w.person(), { name: 'Free One' })).started.json.tenantId;
  await w.connectInstagram(first, 'IG-SHARED');
  // The first business lets the account go; a second Free business may not take it.
  await w.sql(`DELETE FROM ig_accounts WHERE ig_user_id = 'IG-SHARED'`);
  const second = (await w.signUp(await w.person(), { name: 'Free Two' })).started.json.tenantId;
  await assert.rejects(() => w.connectInstagram(second, 'IG-SHARED'), /free_taken/);
  assert.equal((await w.sql(`SELECT count(*)::int AS n FROM ig_accounts WHERE ig_user_id = 'IG-SHARED'`))[0].n, 0);

  // A paid business may connect it.
  await w.changePlan(second, 't1', { source: 'billing', actor: 'billing' });
  await w.connectInstagram(second, 'IG-SHARED');

  // Two new Free businesses connecting a fresh account at the same moment: one gets it, and the other cannot take it later.
  const a = (await w.signUp(await w.person(), { name: 'Race A' })).started.json.tenantId;
  const b = (await w.signUp(await w.person(), { name: 'Race B' })).started.json.tenantId;
  const link = (tenant) => w.sql(`INSERT INTO ig_accounts (ig_user_id, tenant_id) VALUES ('IG-RACE', $1)`, [tenant]);
  const results = await Promise.allSettled([link(a), link(b)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const loser = results[0].status === 'fulfilled' ? b : a;
  await w.sql(`DELETE FROM ig_accounts WHERE ig_user_id = 'IG-RACE'`);
  await assert.rejects(() => link(loser), /free_taken/);
  assert.deepEqual((await w.sql(`SELECT tenant_id FROM instagram_tenants WHERE ig_user_id = 'IG-RACE' AND free_claim`)).map((r) => r.tenant_id), [loser === a ? b : a]);

  // The setting is a number: two Free businesses per account once it says 2.
  await w.sql('UPDATE signup_settings SET free_per_instagram = 2');
  try {
    await link(loser);
  } finally {
    await w.sql('UPDATE signup_settings SET free_per_instagram = 1');
  }
});
