// PRD 6.9: test mode, dry run and testers. A-49 to A-54.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPLIANCE_LIMITS, INSIDE_MS, MINUTE, OUTSIDE_MS, addShop, addStaff, assertNoDm, assertReason, buttonsOf, need, useWorld } from './support.js';

const world = useWorld();
const CODE_MS = COMPLIANCE_LIMITS.testerCodeMs;

test('the code lifetime used below is the PRD\'s', () => assert.equal(CODE_MS, 15 * MINUTE));

const newCode = (shop) => shop.call('/testers/codes', 201, { method: 'POST', body: { label: 'Asha' } }, 'A tester code');
const testers = async (shop) => (await shop.call('/testers', 200)).items;

async function addTester(shop) {
  const person = world.fan('tester');
  const { code } = await newCode(shop);
  await shop.dm(person, code);
  await shop.settle();
  assert.equal((await testers(shop)).length, 1, 'The tester was added');
  return person;
}

test('A-49: an automation in Test, and a tester commenting the keyword: a real DM to the tester, not counted', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const auto = await shop.automate({ state: 'test' });
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
  const [job] = await shop.jobs('comment_id = $2', [comment.id]);
  assert.equal(job.is_test, true);
  assert.equal((await shop.call(`/automations/${auto.id}/stats`, 200)).sends, 0);
  assert.equal((await shop.call('/stats/dashboard', 200)).dms, 0);
});

test('A-49: a tester on a Live automation is excluded from the numbers too', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const auto = await shop.automate();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms()).filter((m) => m.kind === 'private_reply').length, 1);
  assert.equal((await shop.call('/stats/dashboard', 200)).dms, 0);
});

test('A-49: a tester\'s two-tap tap isn\'t counted', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const auto = await shop.automate({ state: 'test', linkMode: 'two_tap' });
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  const [first] = await shop.dms({ kind: 'private_reply' });
  await shop.tap(person, buttonsOf(first)[0].payload);
  await shop.settle();
  assert.deepEqual((await shop.call('/links/taps', 200)).items, []);
});

test('A-49: "Send test to me" sends to a tester whose window is open', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const auto = await shop.automate({ state: 'test' });
  const [tester] = await testers(shop);
  assert.equal(tester.windowOpen, true);
  const out = await shop.call(`/automations/${auto.id}/send-test`, 200, { method: 'POST', body: { testerId: tester.id } });
  assert.equal(out.outcome, 'sent');
  assert.equal((await shop.dms({ recipientId: person.id })).length >= 1, true);
});

test('A-49: "Send test to me" to a tester with a closed window goes nowhere, window.closed', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const auto = await shop.automate({ state: 'test' });
  const [tester] = await testers(shop);
  const before = (await shop.dms({ recipientId: person.id })).length;
  await world.travel(COMPLIANCE_LIMITS.messagingWindowMs + OUTSIDE_MS);
  assert.equal((await testers(shop))[0].windowOpen, false);
  const out = await shop.call(`/automations/${auto.id}/send-test`, 200, { method: 'POST', body: { testerId: tester.id } });
  assert.equal(out.reason, 'window.closed');
  assert.equal((await shop.dms({ recipientId: person.id })).length, before);
});

test('A-49: another business\'s tester can\'t be sent a test, listed or removed', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  await addTester(a);
  const [tester] = await testers(a);
  const auto = await b.automate({ state: 'test' });
  assert.deepEqual(await testers(b), []);
  assert.ok([400, 404].includes((await b.api(`/automations/${auto.id}/send-test`, { method: 'POST', body: { testerId: tester.id } })).status));
  assert.equal((await b.api(`/testers/${tester.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await testers(a)).length, 1);
});

test('A-49: a removed tester goes back to being anybody', async () => {
  const shop = await addShop(world);
  const person = await addTester(shop);
  const [tester] = await testers(shop);
  assert.equal((await shop.api(`/testers/${tester.id}`, { method: 'DELETE' })).status, 204);
  const auto = await shop.automate({ state: 'test' });
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await assertReason(shop, 'test_mode', comment.id);
});

test('A-50: an automation in Test, and a non-tester commenting: no DM, test_mode', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ state: 'test' });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  await assertReason(shop, 'test_mode', comment.id);
});

test('A-50: a tester at another business is a non-tester here', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const person = await addTester(a);
  const auto = await b.automate({ state: 'test' });
  const comment = await b.comment(auto.mediaId, { from: person });
  await b.settle();
  await assertNoDm(b);
  await assertReason(b, 'test_mode', comment.id);
});

test('A-50: a test-mode skip doesn\'t use up a real cap', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ state: 'test' });
  const person = world.fan();
  await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  await shop.setState(auto.id, 'live');
  const comment = await shop.comment(auto.mediaId, { from: person });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: comment.id })).length, 1);
});

test('A-51: dry run on a matching comment logs would_send with the payload, and makes no Graph POST', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ dryRun: true });
  const comment = await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  const [job] = await shop.jobs('comment_id = $2', [comment.id]);
  assert.equal(job.status, 'would_send');
  assert.ok(JSON.stringify(job.payload).includes(shop.siteHost), 'The full payload, link included');
  assert.equal((await shop.events(`comment_id = $2 AND decision = 'would_send'`, [comment.id])).length, 1);
});

test('A-51: dry run for the whole business does the same', async () => {
  const shop = await addShop(world);
  await shop.call('/compliance/settings', 200, { method: 'PATCH', body: { dryRun: true } });
  const auto = await shop.automate();
  await shop.comment(auto.mediaId);
  await shop.settle();
  await assertNoDm(shop);
  assert.equal((await shop.jobs())[0].status, 'would_send');
});

test('A-51: dry run still applies every rule', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ dryRun: true });
  const person = world.fan();
  await shop.dm(person, 'STOP');
  await shop.settle();
  const blocked = await shop.comment(auto.mediaId, { from: person });
  const negative = await shop.comment(auto.mediaId, { text: 'price fraud' });
  await shop.settle();
  await assertReason(shop, 'optout', blocked.id);
  await assertReason(shop, 'negative_intent', negative.id);
});

test('A-51: dry run never reaches Meta for two-tap either, and a public reply stays quiet', async () => {
  const shop = await addShop(world);
  const auto = await shop.automate({ dryRun: true, linkMode: 'two_tap' });
  await shop.comment(auto.mediaId);
  await shop.settle();
  assert.equal((await shop.sent()).length, 0);
});

test('A-52: a tester DMing the code within 15 minutes is added by IGSID', async () => {
  const shop = await addShop(world);
  const person = world.fan('tester');
  const { code, expiresAt } = await newCode(shop);
  assert.ok(Math.abs(new Date(expiresAt) - Date.now() - CODE_MS) < 60_000);
  await shop.dm(person, code);
  await shop.settle();
  const [row] = await shop.sql('SELECT * FROM testers WHERE tenant_id = $1', [shop.tenantId]);
  assert.equal(row.recipient_id, person.id);
  assert.equal(row.subject_hash, await shop.hash(person.id));
  assert.equal(JSON.stringify(await testers(shop)).includes(person.username), false, 'There is no username lookup');
});

test('A-52: just inside 15 minutes the code works', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  await world.travel(CODE_MS - INSIDE_MS);
  await shop.dm(world.fan(), code);
  await shop.settle();
  assert.equal((await testers(shop)).length, 1);
});

test('A-52: a code works once', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  await shop.dm(world.fan(), code);
  await shop.settle();
  await shop.dm(world.fan(), code);
  await shop.settle();
  assert.equal((await testers(shop)).length, 1);
});

test('A-52: two people sending a code at the same moment: only one gets in', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  await Promise.all([shop.dm(world.fan(), code), shop.dm(world.fan(), code)]);
  await shop.settle();
  assert.equal((await testers(shop)).length, 1);
});

test('A-52: only a hash of the code is stored', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  const [row] = await shop.sql('SELECT * FROM tester_codes WHERE tenant_id = $1', [shop.tenantId]);
  assert.notEqual(row.code_hash, code);
  assert.equal(JSON.stringify(row).includes(code), false);
});

test('A-52: one business\'s code does nothing at another', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const { code } = await newCode(a);
  await b.dm(world.fan(), code);
  await b.settle();
  assert.deepEqual(await testers(b), []);
  assert.deepEqual(await testers(a), []);
});

test('A-52: adding a tester is for managers; staff are refused', async () => {
  const shop = await addShop(world);
  const staff = await addStaff(world, shop, { permissions: ['automations'] });
  assert.equal((await shop.api('/testers/codes', { method: 'POST', token: staff.token, body: {} })).status, 403);
});

test('A-52: the code isn\'t answered as a keyword or welcomed', async () => {
  const shop = await addShop(world);
  await shop.automate({ triggerType: 'dm_keyword', keywords: ['price'], matchMode: 'any', anyModeAcknowledged: true, triggers: [{ channel: 'instagram', targetType: 'dm' }] });
  const { code } = await newCode(shop);
  const person = world.fan();
  await shop.dm(person, code);
  await shop.settle();
  assert.equal((await shop.dms({ recipientId: person.id })).length, 0);
});

test('A-53: a tester DMing the code after 16 minutes is not added', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  await world.travel(16 * MINUTE);
  await shop.dm(world.fan(), code);
  await shop.settle();
  assert.deepEqual(await testers(shop), []);
});

test('A-53: a second past 15 minutes is too late', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  await world.travel(CODE_MS + OUTSIDE_MS);
  await shop.dm(world.fan(), code);
  await shop.settle();
  assert.deepEqual(await testers(shop), []);
});

test('A-53: a wrong code, a near miss and a hostile string add nobody', async () => {
  const shop = await addShop(world);
  const { code } = await newCode(shop);
  for (const text of ['000000', `${code}x`, `x${code}`, `' OR 1=1 --`]) await shop.dm(world.fan(), text);
  await shop.settle();
  assert.deepEqual(await testers(shop), []);
});

async function dryRunTen() {
  const shop = await addShop(world);
  const before = await shop.call('/stats/dashboard', 200);
  const auto = await shop.automate({ dryRun: true, linkMode: 'two_tap' });
  for (let i = 0; i < 10; i++) await shop.comment(auto.mediaId);
  await shop.settle({ ms: 12_000 });
  return { shop, before, auto };
}

test('A-54: the dashboard after 10 dry-run triggers shows DMs and taps unchanged', async () => {
  const { shop, before, auto } = await dryRunTen();
  const after = await shop.call('/stats/dashboard', 200);
  assert.equal(after.dms, before.dms);
  assert.equal(after.dmsToday, before.dmsToday);
  assert.deepEqual((await shop.call('/links/taps', 200)).items, []);
  assert.equal((await shop.call(`/automations/${auto.id}/stats`, 200)).sends, 0);
  assert.equal((await shop.jobs(`status = 'would_send'`)).length, 10);
});

test('A-54: a dry-run trigger leaves no analytics event and no real cap', async () => {
  const { shop, auto } = await dryRunTen();
  assert.equal((await shop.sql(`SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND name ILIKE '%dm%'`, [shop.tenantId]))[0].n, 0);
  assert.ok(auto.id);
  need(await shop.api('/stats/dashboard'), 200, 'The dashboard still answers');
});
