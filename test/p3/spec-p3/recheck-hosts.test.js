// PRD 8.2 and 8.8: the per-host limit under load. One business has 200 imported products due on one host; the fetcher keeps
// its gap between requests to that host, a run takes at most 50, and another business's re-checks are not held up behind it.
// This world runs safeFetch with a real per-host gap, so it has a file of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_LIMITS, addP3Shop, jsonLdPage, pause, unique, useP3World } from './kit.js';

const GAP_MS = 400;
const world = useP3World({ hostGapMs: GAP_MS });

/** `n` imported products of one business on `host`, all due for a re-check. Seeded in the database: importing 200 one by one would take the whole gap each. */
async function dueOn(shop, host, n) {
  world.sites.site(host, { pages: { '/p/*': { body: () => jsonLdPage({ name: 'Due product', price: '799', image: `https://${host}/img.png` }) } } });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const p = await shop.product({ name: `Due ${i}`, pricePaise: 99900, externalUrl: `https://${host}/p/${i}` });
    ids.push(p.id);
  }
  await shop.sql(
    `UPDATE products SET source = 'link', price_manual = false, fetch_status = 'ok', fetched_at = now() - interval '30 hours', next_check_at = now() - interval '1 hour'
     WHERE tenant_id = $1 AND id = ANY($2)`,
    [shop.tenantId, ids],
  );
  return ids;
}

const checkedCount = async (shop) => (await shop.sql(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1 AND fetched_at > now() - interval '10 minutes'`, [shop.tenantId]))[0].n;

test('K-26: 200 products due on one host: the per-host limit holds, a run takes at most 50, and other businesses\' re-checks still run', { timeout: 240_000 }, async () => {
  const big = await addP3Shop(world);
  const small = await addP3Shop(world);
  const busy = `busy-${unique()}.example`;
  const quiet = `quiet-${unique()}.example`;
  world.stopWorker();
  await dueOn(big, busy, 200);
  await dueOn(small, quiet, 3);
  const mark = world.dials.length;
  const started = Date.now();
  world.startWorker();

  let smallDoneAt = null;
  let bigAtThatMoment = null;
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    await world.tick();
    await pause(500);
    if (smallDoneAt === null && await checkedCount(small) === 3) {
      smallDoneAt = Date.now() - started;
      bigAtThatMoment = await checkedCount(big);
    }
    if (smallDoneAt !== null && Date.now() - started > 12_000) break;
  }
  const elapsed = Date.now() - started;
  const dials = world.dialsSince(mark);
  const toBusy = dials.filter((d) => d.host === busy).map((d) => d.at).sort((a, b) => a - b);

  assert.ok(toBusy.length >= 3, `The busy host was being re-checked: ${toBusy.length} requests in ${elapsed} ms`);
  const gaps = toBusy.slice(1).map((at, i) => at - toBusy[i]);
  const tooClose = gaps.filter((g) => g < GAP_MS * 0.8);
  assert.deepEqual(tooClose, [], `Requests to one host came closer together than the ${GAP_MS} ms gap`);
  assert.ok(toBusy.length <= Math.ceil(elapsed / GAP_MS) + 1, `${toBusy.length} requests to one host in ${elapsed} ms breaks the per-host limit`);

  assert.notEqual(smallDoneAt, null, `The other business's 3 re-checks never finished while the busy host was being worked through (${await checkedCount(small)} of 3)`);
  assert.ok(smallDoneAt < 12_000, `The other business waited ${smallDoneAt} ms behind the busy host`);
  assert.ok(bigAtThatMoment < 200, 'The other business finished long before the 200 did');

  assert.ok(await checkedCount(big) <= toBusy.length, 'No product is marked checked without a request for it');
  const perRun = await big.sql(
    `SELECT count(*)::int AS n FROM product_checks WHERE tenant_id = $1 GROUP BY date_trunc('second', checked_at) ORDER BY n DESC LIMIT 1`, [big.tenantId]);
  assert.ok((perRun[0]?.n ?? 0) <= CATALOG_LIMITS.recheckPerRun, 'More than 50 checks landed in one second');
  const wrongTenant = await big.sql(
    `SELECT count(*)::int AS n FROM product_checks c JOIN products p ON p.id = c.product_id WHERE c.tenant_id <> p.tenant_id`);
  assert.equal(wrongTenant[0].n, 0, 'Every check belongs to its product\'s business');
});

test('K-26: a pasted link to a host that is busy is told so, or waits its turn; it never jumps the gap', { timeout: 120_000 }, async () => {
  const shop = await addP3Shop(world);
  const host = `paced-${unique()}.example`;
  world.sites.site(host, { pages: { '/p/*': { body: () => jsonLdPage({ name: 'Paced product', price: '100', image: `https://${host}/img.png` }) } } });
  const mark = world.dials.length;
  const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => shop.send('POST', '/imports/link', { url: `https://${host}/p/${i}` })));
  for (const res of answers) {
    assert.equal(res.status, 200, `A paste answered ${res.status}: ${res.text.slice(0, 200)}`);
    const body = res.json();
    assert.ok(body.status === 'draft' || body.reason === 'host_busy' || body.reason === 'timeout', `A paste to a busy host gave ${body.status}/${body.reason}`);
  }
  const at = world.dialsSince(mark).filter((d) => d.host === host).map((d) => d.at).sort((a, b) => a - b);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  assert.deepEqual(gaps.filter((g) => g < GAP_MS * 0.8), [], `Six pastes at once reached one host closer together than ${GAP_MS} ms`);
});
