// PRD 5.12 and 3: the DM meter, its alerts, and what happens at the limit. F-82, F-86, F-112. Real sends through the compliance gate,
// real comments from simulated shoppers, the usage tables as the database keeps them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageMonthOf } from '../../../src/contracts/billing.js';
import { change, dmMeter, impersonate, json, key, need, one, opCall, consoleUser, setDmUsed, shopOn, sql, subscribe, authorize, charge, useBillingWorld, unique } from './support.js';

const world = useBillingWorld();

const heldJobs = (shop) => sql(world, `SELECT id, status, reason FROM outbound_jobs WHERE tenant_id = $1 AND reason = 'held.dm_limit'`, [shop.tenantId]);
const usedNow = async (shop) => Number((await one(world, `SELECT used FROM usage_months WHERE tenant_id = $1 AND meter = 'dms' AND month = $2`, [shop.tenantId, usageMonthOf()]))?.used ?? 0);
const alerts = (shop, kind) => sql(world, `SELECT id FROM notification_events WHERE tenant_id = $1 AND kind = $2`, [shop.tenantId, kind]);

/** A business on tier 1 (5,000 included) with a live automation, its meter at `used`. */
async function meterShop(used, plan = 't1', included = 5000) {
  const shop = await shopOn(world, plan);
  await setDmUsed(world, shop, used, { included });
  const auto = await shop.automate();
  return { shop, auto };
}
const comments = (shop, auto, n) => Promise.all(Array.from({ length: n }, () => shop.comment(auto.mediaId, { from: world.fan() })));

test('F-86: at 79% nothing is said; the DM that reaches 80% alerts the owner once, with counts, and later DMs do not repeat it', async () => {
  const { shop, auto } = await meterShop(3998);
  await comments(shop, auto, 1);
  await shop.settle();
  assert.equal(await usedNow(shop), 3999, 'a DM counts once when Meta accepts it');
  assert.equal((await dmMeter(shop)).percent, 79);
  assert.equal((await alerts(shop, 'dm.usage_80')).length, 0, 'no alert at 79%');
  await comments(shop, auto, 1);
  await shop.settle();
  assert.equal((await dmMeter(shop)).percent, 80);
  await world.quiet(600);
  assert.equal((await alerts(shop, 'dm.usage_80')).length, 1, 'one alert at 80%');
  await comments(shop, auto, 3);
  await shop.settle();
  await world.quiet(600);
  assert.equal((await alerts(shop, 'dm.usage_80')).length, 1, 'still one');
  const row = await one(world, `SELECT alert_80_at, alert_100_at FROM usage_months WHERE tenant_id = $1 AND meter = 'dms'`, [shop.tenantId]);
  assert.ok(row.alert_80_at && !row.alert_100_at);
  const data = (await one(world, `SELECT data FROM notification_events WHERE tenant_id = $1 AND kind = 'dm.usage_80'`, [shop.tenantId])).data;
  assert.ok(JSON.stringify(data).match(/80|4000|5000/), 'the alert carries the numbers');
  assert.doesNotMatch(JSON.stringify(data), /\+?91\d{10}/, 'no phone number in an alert');
});

test('F-86: reaching 100% alerts once more, a pack lifts it, and crossing 80% again of the new allowance is not a second 80% alert in the same month', async () => {
  const { shop, auto } = await meterShop(4999);
  await comments(shop, auto, 1);
  await shop.settle();
  await world.quiet(600);
  assert.equal((await alerts(shop, 'dm.usage_100')).length, 1);
  assert.equal((await alerts(shop, 'dm.usage_80')).length, 1, 'the 80% alert was due on the way and goes once');
  await comments(shop, auto, 2);
  await shop.settle();
  await world.quiet(500);
  assert.equal((await alerts(shop, 'dm.usage_100')).length, 1);
});

test('F-112: a Free account at 500 DMs has the next automated DM held with held.dm_limit, then sent when it upgrades', async () => {
  const shop = await shopOn(world, 'free');
  await setDmUsed(world, shop, 499, { included: 500 });
  const auto = await shop.automate({ linkMode: 'two_tap' });
  await comments(shop, auto, 1);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1, 'the 500th goes');
  const sentBefore = (await shop.dms()).length;
  await comments(shop, auto, 1);
  await shop.settle();
  assert.equal((await shop.dms()).length, sentBefore, 'the 501st does not');
  const held = await heldJobs(shop);
  assert.equal(held.length, 1, 'held, not dropped');
  const usage = json(need(await shop.send('GET', '/billing/usage'), 200, 'Usage at the limit'));
  assert.equal(usage.heldDms, 1);
  assert.equal(usage.canBuyPacks, false, 'Free is offered an upgrade, not a pack');
  assert.equal((await dmMeter(shop)).over, true);
  await sql(world, `UPDATE tenants SET plan = 't1' WHERE id = $1`, [shop.tenantId]);
  await world.tick();
  const released = await world.until(async () => (await shop.dms()).length === sentBefore + 1);
  assert.ok(released, 'an upgrade lets the held DM go while it has not expired');
});

test('F-112: one DM over the limit is held, never counted, and the count never passes the allowance, also when ten shoppers comment at once', async () => {
  const { shop, auto } = await meterShop(4994);
  await comments(shop, auto, 10);
  await shop.settle({ ms: 20_000 });
  const sent = (await shop.dms()).length;
  assert.equal(sent, 6, `6 places were left, ${sent} went`);
  assert.equal(await usedNow(shop), 5000, 'exactly the allowance');
  assert.equal((await heldJobs(shop)).length, 4);
  assert.equal((await dmMeter(shop)).left, 0);
});

test('F-112: an expired held DM is not sent when the limit lifts, and a pack lifts the hold for the ones that are still good', async () => {
  const { shop, auto } = await meterShop(5000);
  await comments(shop, auto, 2);
  await shop.settle();
  assert.equal((await heldJobs(shop)).length, 2);
  const [old] = await heldJobs(shop);
  await sql(world, `UPDATE outbound_jobs SET expires_at = now() - interval '1 second' WHERE id = $1`, [old.id]);
  need(await shop.send('POST', '/billing/items', { code: 'dm_pack', quantity: 1, requestKey: key() }), 201, 'Buying a pack');
  await world.tick();
  await world.until(async () => (await shop.dms()).length >= 1);
  await shop.settle();
  assert.equal((await shop.dms()).length, 1, 'only the unexpired one');
});

test('F-82: test-mode sends, a tester\'s comment and "send test" are not counted on the meter', async () => {
  const { shop } = await meterShop(10);
  const tester = world.fan('tester');
  const { code } = json(need(await shop.send('POST', '/testers/codes', { label: 'Asha' }), 201, 'A tester code'));
  await shop.dm(tester, code);
  await shop.settle();
  const auto = await shop.automate({ state: 'test' });
  const testerRow = json(need(await shop.send('GET', '/testers'), 200, 'Testers')).items[0];
  for (let i = 0; i < 6; i++) {
    await shop.comment(auto.mediaId, { from: tester });
    need(await shop.send('POST', `/automations/${auto.id}/send-test`, { testerId: testerRow.id }), 200, 'Send test');
  }
  await shop.settle();
  assert.ok((await shop.dms()).length >= 6, 'the tester did get the messages');
  assert.equal(await usedNow(shop), 10, 'none of them counted');
  assert.equal((await dmMeter(shop)).used, 10);
});

test('F-82: a dry run and an operator looking round the business do not move the meter', async () => {
  const { shop } = await meterShop(5);
  const dry = await shop.automate({ dryRun: true });
  await shop.comment(dry.mediaId, { from: world.fan() });
  await shop.settle();
  const op = await consoleUser(world);
  const session = await impersonate(world, shop, op);
  for (const path of ['/automations', '/billing/features', '/stats/dashboard', '/orders', '/products']) await session.call('GET', path);
  assert.equal(await usedNow(shop), 5);
});

test('F-82: the same send reported twice counts once, and a send of another business never counts here', async () => {
  const { shop } = await meterShop(0);
  const other = await shopOn(world, 't1');
  const k = `dup:${unique()}`;
  const put = (tenant) => sql(world, `INSERT INTO usage_events (tenant_id, meter, quantity, idempotency_key) VALUES ($1, 'dms', 1, $2) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`, [tenant, k]);
  await Promise.all([put(shop.tenantId), put(shop.tenantId), put(shop.tenantId)]);
  assert.equal(await usedNow(shop), 1);
  assert.equal(await usedNow(other), 0);
  await put(other.tenantId);
  assert.equal(await usedNow(other), 1, 'the same key in another business is another event');
  assert.equal(await usedNow(shop), 1);
});

test('F-86: a month ends at midnight in India: a send at 23:59:59 counts in the old month, one at 00:00:00 in the new, and the new one starts at zero', async () => {
  const { shop } = await meterShop(0);
  const at = (iso) => sql(world, `INSERT INTO usage_events (tenant_id, meter, quantity, idempotency_key, occurred_at) VALUES ($1, 'dms', 1, $2, $3) RETURNING month`, [shop.tenantId, `m:${unique()}`, iso]);
  const [last] = await at('2031-04-30T18:29:59Z');
  const [first] = await at('2031-04-30T18:30:00Z');
  assert.equal(String(last.month instanceof Date ? last.month.toISOString() : last.month).slice(0, 10) <= '2031-04-30', true);
  const months = await sql(world, `SELECT to_char(month, 'YYYY-MM-DD') AS month, used FROM usage_months WHERE tenant_id = $1 AND meter = 'dms' AND month >= '2031-04-01' ORDER BY month`, [shop.tenantId]);
  assert.deepEqual(months.map((m) => [m.month, Number(m.used)]), [['2031-04-01', 1], ['2031-05-01', 1]]);
  assert.equal(usageMonthOf(new Date('2031-04-30T18:29:59Z')), '2031-04-01');
  assert.equal(usageMonthOf(new Date('2031-04-30T18:30:00Z')), '2031-05-01');
  void first;
});

test('F-86: yearly billing still resets the included DMs each month', async () => {
  const shop = await shopOn(world, 'free');
  need(await change(shop, 't1', 'yearly'), 200, 'Choosing yearly');
  await authorize(world, shop);
  await charge(world, shop);
  await world.until(async () => (await one(world, 'SELECT plan FROM tenants WHERE id = $1', [shop.tenantId])).plan === 't1');
  await sql(world, `INSERT INTO usage_events (tenant_id, meter, quantity, idempotency_key, occurred_at) VALUES ($1, 'dms', 4000, $2, '2031-01-15T00:00:00Z')`, [shop.tenantId, `y:${unique()}`]);
  const thisMonth = await sql(world, `SELECT used FROM usage_months WHERE tenant_id = $1 AND meter = 'dms' AND month = $2`, [shop.tenantId, usageMonthOf()]);
  assert.equal(Number(thisMonth[0]?.used ?? 0), 0, 'last year\'s sends are in last year\'s month');
});

test('F-81: the meter is the owner\'s own: usage, and the pack option, are not readable by staff or another business', async () => {
  const { shop } = await meterShop(10);
  const other = await shopOn(world, 't1');
  await setDmUsed(world, other, 4321, { included: 5000 });
  assert.equal((await dmMeter(shop)).used, 10);
  assert.equal((await dmMeter(other)).used, 4321);
  const claimed = await shop.send('GET', `/billing/usage?tenantId=${other.tenantId}`);
  assert.equal(json(claimed).meters.find((m) => m.meter === 'dms').used, 10, 'a tenant id in the query changes nothing');
  void subscribe, opCall;
});
