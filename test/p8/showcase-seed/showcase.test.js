// The whole showcase against the app: both sample businesses loaded through the seller API, thirty-day-style activity made
// through the simulators, and what that leaves behind. Each file of the manifest is a smaller copy of the real seed
// (support.js trimmed), so the file runs in minutes on the built-in database; the same code loads the full seed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { exportBrands, seedShowcase } from '../../../scripts/showcase.js';
import { scanDatabase } from '../../../tools/sim/activity/people.mjs';
import { createClock, run } from '../../../tools/sim/activity/index.mjs';
import { openShowcaseWorld } from '../../../tools/sim/activity/world.mjs';
import { openTestDb } from '../../helpers.js';
import { loadBoth, trimmed } from './support.js';

const SEED = 80_808;
const DAYS = 2;
const LONG = { timeout: 1_500_000 };

const businesses = () => loadBoth().map((b) => trimmed(b, { reels: 1, products: 6 }));

async function open() {
  const db = await openTestDb();
  const world = await openShowcaseWorld({ db });
  return { db, world };
}

const startOf = () => createClock(new Date(Date.now() - DAYS * 86_400_000));

/** What a run left, as numbers that do not depend on the clock or on any generated id. */
async function aggregates(world) {
  const one = async (sql) => (await world.sql(sql)).map((r) => Object.values(r).map(String).join(':')).join(',');
  return {
    orders: await one(`SELECT count(*), coalesce(sum(total_paise), 0) FROM orders`),
    byStatus: await one(`SELECT payment_status || '/' || fulfilment_status, count(*) FROM orders GROUP BY 1 ORDER BY 1`),
    items: await one(`SELECT count(*), coalesce(sum(qty), 0) FROM order_items`),
    jobs: await one(`SELECT status, count(*) FROM outbound_jobs GROUP BY 1 ORDER BY 1`),
    decisions: await one(`SELECT kind || '/' || decision, count(*) FROM compliance_events GROUP BY 1 ORDER BY 1`),
    inbound: await one(`SELECT count(*) FROM inbox_messages WHERE direction = 'in'`),
    refunds: await one(`SELECT count(*) FROM refunds`),
  };
}

describe('the showcase against the app', LONG, () => {
  let one;
  let loaded;
  let summary;
  let report;
  const list = businesses();

  before(async () => {
    one = await open();
    loaded = await seedShowcase({ world: one.world, businesses: list });
  });
  after(async () => {
    await one?.world.close();
    await one?.db.close();
  });

  test('Q-01 one call loads both businesses from their seed files: owner, brand kit, shop, posts, automations, FAQ, coupons, app', async () => {
    assert.equal(loaded.length, list.length);
    for (const b of loaded) {
      for (const kind of ['business', 'owner', 'category', 'product', 'page', 'automation', 'faq', 'coupon', 'paymentAccount']) assert.ok(b.created[kind] >= 1, `${b.key}: ${kind}`);
      assert.equal(b.created.product, b.catalogue.products.length);
      assert.equal(b.created.automation, b.seed.automations.length);
      assert.equal(b.created.coupon, b.seed.coupons.length);
    }
    const [row] = await one.world.sql(`SELECT count(*) AS n FROM tenants WHERE slug = ANY($1)`, [loaded.map((b) => b.slug)]);
    assert.equal(Number(row.n), loaded.length);
    for (const b of loaded) {
      const kit = (await b.api.get('/brand-kit')).data;
      assert.equal(kit.preset, b.seed.brandKit.preset, `${b.key}: the brand kit is its preset`);
      assert.equal(kit.publicReplyVariants.length, b.seed.brandKit.publicReplyVariants.length);
      const app = (await b.api.get('/app-publishing')).data;
      assert.equal(app.appName, b.seed.app.appName);
      assert.equal(app.androidPackage, b.seed.app.androidPackage);
      const listed = (await b.api.all('/automations')).filter((a) => b.seed.automations.some((s) => s.name === a.name));
      assert.equal(listed.length, b.seed.automations.length);
      for (const item of listed) {
        const a = (await b.api.get(`/automations/${item.id}`)).data;
        const wanted = b.seed.automations.find((s) => s.name === a.name);
        assert.equal(a.state, wanted.state, `${b.key}: ${a.name}`);
        assert.deepEqual(a.keywords, wanted.keywords);
      }
      const connection = (await b.api.get('/instagram/connection')).data;
      assert.equal(connection.igUserId, b.seed.business.igUserId);
      assert.equal(connection.status, 'active');
    }
  });

  test('Q-01 a second run changes nothing: every item is found by its natural key', async () => {
    const before = await one.world.sql(`SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM categories) c, (SELECT count(*) FROM reels) r, (SELECT count(*) FROM automations) a, (SELECT count(*) FROM faq_entries) f, (SELECT count(*) FROM coupons) k, (SELECT count(*) FROM users) u, (SELECT count(*) FROM tenants) t`);
    const again = await seedShowcase({ world: one.world, businesses: list });
    for (const b of again) {
      assert.deepEqual(b.created, {}, `${b.key} created ${JSON.stringify(b.created)}`);
      assert.ok(b.reused.product >= 1 && b.reused.page >= 1 && b.reused.automation >= 1);
    }
    const after = await one.world.sql(`SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM categories) c, (SELECT count(*) FROM reels) r, (SELECT count(*) FROM automations) a, (SELECT count(*) FROM faq_entries) f, (SELECT count(*) FROM coupons) k, (SELECT count(*) FROM users) u, (SELECT count(*) FROM tenants) t`);
    assert.deepEqual(after, before);
    loaded = again;
  });

  test('Q-04 after seeding, neither business reads the other\'s data on any route', async () => {
    const [a, b] = loaded;
    for (const [mine, theirs] of [[a, b], [b, a]]) {
      // A seller's session means nothing on another business's address.
      for (const route of ['/products', '/categories', '/pages', '/automations', '/coupons', '/faq', '/brand-kit', '/settings']) {
        const res = await one.world.hit(`/api/v1${route}`, { host: theirs.host, token: mine.session.token });
        assert.ok([401, 403, 404].includes(res.status), `${mine.key} on ${theirs.key}'s address, ${route}: ${res.status}`);
      }
      // What one lists never holds a name, code, question or post of the other.
      const theirNames = new Set((await theirs.api.all('/products')).map((p) => p.name));
      assert.ok((await mine.api.all('/products')).every((p) => !theirNames.has(p.name) || mine.catalogue.products.some((c) => c.name === p.name)), 'a product listed here was loaded here');
      const theirCodes = new Set(theirs.seed.coupons.map((c) => c.code));
      assert.ok((await mine.api.all('/coupons')).every((c) => !theirCodes.has(c.code) || mine.seed.coupons.some((s) => s.code === c.code)));
      const theirMedia = new Set(theirs.reels.map((r) => r.mediaId));
      assert.ok((await mine.api.all('/pages')).every((p) => !theirMedia.has(p.mediaId)));
      // Their records, asked for by id on my address, are not found.
      const theirProduct = (await theirs.api.all('/products'))[0];
      const crossed = await one.world.hit(`/api/v1/products/${theirProduct.id}`, { host: mine.host, token: mine.session.token });
      const own = (await mine.api.all('/products')).some((p) => p.id === theirProduct.id);
      if (!own) assert.equal(crossed.status, 404);
      // Their landing page is not served on my address.
      const slug = theirs.reels[0].slug;
      if (!mine.reels.some((r) => r.slug === slug)) assert.equal((await one.world.hit(`/r/${slug}`, { host: mine.host })).status, 404);
    }
    // In the database every row of the two shops belongs to its own business, and no two share a made-up Instagram account.
    const rows = await one.world.sql(`SELECT tenant_id, count(*)::int AS n FROM products GROUP BY 1 ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.tenant_id).sort(), loaded.map((x) => x.tenantId).sort());
    const accounts = await one.world.sql(`SELECT ig_user_id, count(DISTINCT tenant_id)::int AS tenants FROM ig_accounts GROUP BY 1`);
    assert.ok(accounts.every((r) => r.tenants === 1));
  });

  test('Q-03 days of activity arrive through the simulators and leave believable numbers on every screen', async () => {
    report = await run({ businesses: loaded, days: DAYS, seed: SEED, clock: startOf(), world: one.world, volume: 3 });
    assert.equal(report.days, DAYS);
    assert.equal(report.seed, SEED);
    assert.match(report.digest, /^[0-9a-f]{64}$/);
    assert.ok(report.events > 20, `${report.events} events`);
    for (const b of loaded) {
      const counts = report.counts[b.key];
      for (const kind of ['comment', 'visit', 'checkout', 'payment']) assert.ok(counts[kind] >= 1, `${b.key}: ${kind} ${JSON.stringify(counts)}`);
    }
    summary = await aggregates(one.world);
    const [orders] = await one.world.sql(`SELECT count(*)::int AS n, count(*) FILTER (WHERE payment_status = 'paid')::int AS paid, min(created_at) AS first, max(created_at) AS last FROM orders`);
    assert.ok(orders.n >= 2 && orders.paid >= 1, JSON.stringify(orders));
    assert.ok(new Date(orders.last) - new Date(orders.first) > 6 * 3_600_000, 'orders are spread over time, not made in one minute');
    const [dms] = await one.world.sql(`SELECT count(*)::int AS n FROM inbox_messages`);
    assert.ok(dms.n >= 1);
    const [traffic] = await one.world.sql(`SELECT (SELECT count(*) FROM traffic_events)::int AS events, (SELECT count(*) FROM insight_daily)::int AS insight_days`);
    assert.ok(traffic.events >= 1, JSON.stringify(traffic));
  });

  test('Q-03 every order went through the order state machine and every message through the compliance gate', async () => {
    const orders = await one.world.sql(`SELECT o.id, o.tenant_id, o.payment_status, o.fulfilment_status, (SELECT count(*) FROM order_status_history h WHERE h.tenant_id = o.tenant_id AND h.order_id = o.id)::int AS steps, (SELECT count(*) FROM order_events e WHERE e.tenant_id = o.tenant_id AND e.order_id = o.id)::int AS events FROM orders o`);
    for (const o of orders) {
      assert.ok(o.steps >= 1 && o.events >= 1, `order ${o.id} has its history and its events`);
      if (o.payment_status === 'paid') assert.ok(o.steps >= 2, `a paid order has moved: order ${o.id}`);
    }
    // Every message at Instagram is a job that was sent after the gate decided, and no job the gate refused reached it.
    const { sent } = await one.world.sims.meta.get('/sent');
    const jobs = await one.world.sql(`SELECT status, count(*)::int AS n FROM outbound_jobs GROUP BY 1`);
    const sentJobs = jobs.filter((j) => ['sent', 'sent_fallback'].includes(j.status)).reduce((total, j) => total + j.n, 0);
    assert.equal(sent.length, sentJobs, `the simulator received ${sent.length}, the queue says ${sentJobs} were sent`);
    assert.ok(sent.length >= 1, 'at least one DM was sent');
    for (const status of ['queued', 'sending']) assert.equal(jobs.find((j) => j.status === status)?.n ?? 0, 0, `nothing is left ${status}`);
    const decisions = await one.world.sql(`SELECT decision, count(*)::int AS n FROM compliance_events WHERE kind IN ('private_reply', 'dm', 'public_reply') GROUP BY 1`);
    const decidedSent = decisions.filter((d) => d.decision === 'sent').reduce((total, d) => total + d.n, 0);
    assert.equal(decidedSent, sentJobs, 'one "sent" decision for every message that left');
    // No Bhava text in what a shopper receives.
    for (const m of sent) assert.doesNotMatch(JSON.stringify(m.message), /bhava/i);
  });

  test('Q-03 the buyer\'s pages carry the seller\'s brand and nothing of the platform', async () => {
    for (const b of loaded) {
      const home = await one.world.hit('/', { host: b.host, headers: { accept: 'text/html' } });
      assert.equal(home.status, 200);
      assert.ok(home.text.includes(b.seed.settings.store_name ?? b.seed.business.name), `${b.key}: the store's own name is on its page`);
      assert.doesNotMatch(home.text, /bhava/i, `${b.key}: nothing of the platform on a buyer's page`);
      const page = await one.world.hit(`/r/${b.reels[0].slug}`, { host: b.host, headers: { accept: 'text/html' } });
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.text, /bhava/i);
    }
  });

  test('Q-02 after the activity, every person in the database is invented', async () => {
    assert.deepEqual(await scanDatabase((sql, params) => one.world.sql(sql, params)), []);
    const [{ n }] = await one.world.sql(`SELECT count(*)::int AS n FROM orders WHERE customer_name <> ''`);
    assert.ok(n >= 1, 'there are customers to have checked');
  });

  test('Q-03 the businesses stay apart through the activity: no order, message or visit crosses', async () => {
    const [a, b] = loaded;
    const mixed = await one.world.sql(
      `SELECT count(*)::int AS n FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id JOIN products p ON p.id = i.product_id WHERE p.tenant_id <> o.tenant_id`,
    );
    assert.equal(mixed[0].n, 0);
    const shoppers = await one.world.sql(`SELECT phone, count(DISTINCT tenant_id)::int AS tenants FROM shoppers GROUP BY 1`);
    assert.ok(shoppers.every((s) => s.tenants === 1), 'a shopper of one business is not a shopper of the other');
    for (const [x, y] of [[a, b], [b, a]]) {
      const mine = new Set((await x.api.all('/orders')).map((o) => o.orderNumber));
      const theirs = await y.api.all('/orders');
      assert.ok(mine.size >= 0 && theirs.every((o) => o.orderNumber));
    }
  });

  test('Q-03 a different seed makes different activity, and the same seed on the same data finds it already there', async () => {
    const other = await run({ businesses: loaded, days: 1, seed: SEED + 1, clock: startOf(), world: one.world, volume: 2 });
    assert.notEqual(other.digest, report.digest);
    assert.equal(other.seed, SEED + 1);
  });

  test('Q-01 the brand kit of each business exports as a brand file for build-brand', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'brands-'));
    try {
      const made = await exportBrands({ world: one.world, loaded, folder }).catch((err) => err);
      if (made instanceof Error) {
        // An app needs its icon and splash image before a build: the sample seed files name none, so say which field is missing.
        assert.match(made.message, /brand file of "(first|second)" cannot be made: \w+/);
        return;
      }
      for (const { key, file } of made) {
        const brand = JSON.parse(fs.readFileSync(file, 'utf8'));
        const b = loaded.find((x) => x.key === key);
        assert.equal(brand.name, b.seed.app.appName);
        assert.equal(brand.scheme, b.seed.app.urlScheme);
        assert.equal(brand.android.package, b.seed.app.androidPackage);
        assert.equal(JSON.stringify(brand).includes(b.owner.password), false);
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the same seed makes the same data', LONG, () => {
  test('Q-03 a second database loaded and run with the same seed ends with the same numbers and the same digest', async () => {
    const list = businesses();
    const first = await open();
    const second = await open();
    try {
      const results = [];
      for (const { world } of [first, second]) {
        const loaded = await seedShowcase({ world, businesses: list });
        const report = await run({ businesses: loaded, days: DAYS, seed: SEED, clock: startOf(), world, volume: 3 });
        results.push({ digest: report.digest, counts: report.counts, events: report.events, data: await aggregates(world) });
      }
      assert.equal(results[0].digest, results[1].digest);
      assert.deepEqual(results[0].counts, results[1].counts);
      assert.deepEqual(results[0].data, results[1].data);
    } finally {
      for (const f of [first, second]) {
        await f.world.close();
        await f.db.close();
      }
    }
  });
});
