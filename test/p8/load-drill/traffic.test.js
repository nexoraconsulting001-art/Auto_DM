// The traffic of the load test: the mix adds up, every webhook is signed as Meta signs and fits the app's own schema, and two runs ask for the same things.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyHubSignature } from '../../../src/adapters/meta/index.js';
import { WebhookEntry } from '../../../src/contracts/api/provider.js';
import { EXPECT, classPlans, createRecorder, createRng, stormPlan, webhookRequest } from '../../../tools/load/traffic.mjs';
import { loadBudgets } from '../../../tools/load/stack.mjs';

const budgets = loadBudgets();
const shops = [1, 2, 3].map((n) => ({
  n, slug: `biz${n}`, host: `biz${n}.shops.example`, tenantId: n, igUserId: `1784140000000000${n}`, reelId: `180000000000000${n}`, token: `token-${n}`,
  productIds: [n * 10 + 1, n * 10 + 2], productSlugs: [`item-1-of-${n}`, `item-2-of-${n}`],
}));
const posts = [];
const world = { secrets: { appSecret: 'a-made-up-secret' }, shops, client: { request: async () => ({ status: 200 }) }, razorpay: { post: async (...a) => posts.push(['razorpay', ...a]) }, meta: { post: async (...a) => posts.push(['meta', ...a]) } };

test('the rng gives the same numbers for the same seed and different ones for another', () => {
  const draw = (seed) => { const r = createRng(seed); return Array.from({ length: 6 }, () => r.int(1000)); };
  assert.deepEqual(draw(5), draw(5));
  assert.notDeepEqual(draw(5), draw(6));
  const r = createRng(1);
  for (let i = 0; i < 1000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); }
});

test('the plan has one entry per class of the mix and the rates add up to the stated rate', () => {
  const plan = classPlans({ world, rec: createRecorder(), rps: 50, mix: budgets.mix, rng: createRng(1), tag: 't' });
  assert.deepEqual(plan.map((p) => p.name), budgets.mix.map((m) => m.class));
  assert.equal(Math.round(plan.reduce((s, p) => s + p.rate, 0) * 1000) / 1000, 50);
  for (const p of plan) assert.equal(p.rate, (50 * budgets.mix.find((m) => m.class === p.name).weight) / 100);
});

test('two plans from the same seed ask for the same things in the same order, and different businesses get different requests', () => {
  const ask = (seed) => classPlans({ world, rec: createRecorder(), rps: 50, mix: budgets.mix, rng: createRng(seed), tag: 't' }).filter((p) => p.name !== 'beacon' && p.name !== 'store_api').map((p) => Array.from({ length: 12 }, (_, i) => { const s = p.make(i); return `${s.method ?? 'GET'} ${s.host ?? ''}${s.path}`; }));
  assert.deepEqual(ask(9), ask(9));
  const hosts = new Set(ask(9).flat().map((line) => line.split(' ')[1].split('/')[0]));
  assert.ok(hosts.size >= 2, 'the requests are spread over the businesses');
});

test('buyer requests carry a buyer address of their own, in the range set aside for documentation', () => {
  const plans = classPlans({ world, rec: createRecorder(), rps: 50, mix: budgets.mix, rng: createRng(3), tag: 't' });
  const addresses = new Set();
  for (const name of ['buyer_page', 'beacon', 'store_api']) {
    for (let i = 0; i < 40; i++) {
      const forwarded = plans.find((p) => p.name === name).make(i).headers['x-forwarded-for'];
      assert.match(forwarded, /^203\.0\.\d+\.\d+$/);
      addresses.add(forwarded);
    }
  }
  assert.ok(addresses.size > 20, 'not one address for every buyer');
});

test('a webhook is signed over its exact bytes with the app secret, fits the webhook schema, and names its own comment and fan', () => {
  const rec = createRecorder();
  const comment = webhookRequest({ world, rec, shop: shops[0], index: 7, field: 'comments', tag: 'abc' });
  assert.equal(comment.method, 'POST');
  assert.equal(comment.path, '/webhook');
  assert.ok(verifyHubSignature(Buffer.from(comment.body), comment.headers['x-hub-signature-256'], 'a-made-up-secret'));
  assert.ok(!verifyHubSignature(Buffer.from(`${comment.body} `), comment.headers['x-hub-signature-256'], 'a-made-up-secret'), 'a changed byte breaks it');
  const body = JSON.parse(comment.body);
  assert.equal(WebhookEntry.safeParse(body.entry[0]).success, true);
  assert.equal(body.entry[0].id, shops[0].igUserId);
  const value = body.entry[0].changes[0].value;
  assert.equal(value.media.id, shops[0].reelId);
  assert.match(value.text, /price/);
  const message = JSON.parse(webhookRequest({ world, rec, shop: shops[1], index: 8, field: 'messages', tag: 'abc' }).body);
  assert.equal(WebhookEntry.safeParse(message.entry[0]).success, true);
  assert.ok(message.entry[0].messaging[0].message.mid);
  const other = JSON.parse(webhookRequest({ world, rec, shop: shops[0], index: 8, field: 'comments', tag: 'abc' }).body).entry[0].changes[0].value;
  assert.notEqual(other.id, value.id);
  assert.notEqual(other.from.id, value.from.id);
  assert.notEqual(JSON.parse(webhookRequest({ world, rec, shop: shops[0], index: 7, field: 'comments', tag: 'abd' }).body).entry[0].changes[0].value.id, value.id, 'another run never reuses a comment id');
});

test('a webhook answered 200 is kept as accepted; one that is not is sent again until it is, and the retry is counted', async () => {
  const rec = createRecorder();
  const answers = [500, 200];
  const retrying = { ...world, client: { request: async () => ({ status: answers.shift() }) } };
  const spec = webhookRequest({ world: retrying, rec, shop: shops[2], index: 1, field: 'comments', tag: 'x', name: 'storm' });
  await spec.after({ status: 503 });
  assert.equal(rec.accepted.length, 1);
  assert.deepEqual({ ...rec.accepted[0], id: undefined }, { id: undefined, field: 'comments', name: 'storm', shop: 2, tenantId: 3, retried: 2 });
  assert.equal(rec.counts.webhookRetries, 2);
  const direct = webhookRequest({ world, rec, shop: shops[0], index: 2, field: 'messages', tag: 'x' });
  await direct.after({ status: 200 });
  assert.equal(rec.accepted.length, 2);
  assert.equal(rec.counts.webhookRetries, 2, 'a first answer of 200 is no retry');
}, { timeout: 20_000 });

test('a comment webhook makes its comment exist at Instagram first, as a real one does; a message does not', async () => {
  posts.length = 0;
  const rec = createRecorder();
  const comment = webhookRequest({ world, rec, shop: shops[0], index: 3, field: 'comments', tag: 'q' });
  await comment.before();
  assert.equal(posts.length, 1);
  assert.equal(posts[0][1], '/comments');
  assert.equal(posts[0][2].igUserId, shops[0].igUserId);
  assert.equal(posts[0][2].deliver, false, 'the app is sent the webhook by the load test, once');
  assert.equal(webhookRequest({ world, rec, shop: shops[0], index: 4, field: 'messages', tag: 'q' }).before, undefined);
});

test('the storm is one business, at the stated rate, all comments', () => {
  const plan = stormPlan({ world, rec: createRecorder(), shopIndex: 1, comments: 2000, seconds: 60, tag: 's' });
  assert.equal(plan.name, 'storm');
  assert.ok(Math.abs(plan.rate - 2000 / 60) < 1e-9);
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const body = JSON.parse(plan.make(i).body);
    assert.equal(body.entry[0].id, shops[1].igUserId);
    ids.add(body.entry[0].changes[0].value.id);
  }
  assert.equal(ids.size, 50);
});

test('what counts as an answer: a page is a 200, an API call any 2xx, and a refusal or a dropped connection is a failure', () => {
  assert.equal(EXPECT.buyer_page(200), true);
  assert.equal(EXPECT.buyer_page(304), false);
  assert.equal(EXPECT.seller_api_write(201), true);
  assert.equal(EXPECT.seller_api_read(201), false);
  for (const name of Object.keys(EXPECT)) {
    assert.equal(EXPECT[name](0), false, `${name}: no answer`);
    assert.equal(EXPECT[name](500), false, `${name}: 500`);
    assert.equal(EXPECT[name](429), false, `${name}: 429`);
  }
  const rec = createRecorder();
  for (const status of [200, 200, 500, 0]) rec.onResult({ name: 'buyer_page', status, ms: 10, error: status ? null : 'ECONNREFUSED', at: 1, meta: { shop: 0 } });
  const summary = rec.summary('buyer_page');
  assert.deepEqual([summary.requests, summary.failed], [4, 2]);
  assert.deepEqual(summary.failedStatuses.sort(), [500, 'ECONNREFUSED'].sort());
  assert.equal(rec.summary('buyer_page', (r) => r.shop === 7).requests, 0);
});

test('the slowest routes are listed by p95, with the class, and a route with too few answers is left out', () => {
  const rec = createRecorder();
  const add = (name, route, ms, n) => { for (let i = 0; i < n; i++) rec.onResult({ name, status: 200, ms: ms + i, error: null, at: i, meta: { shop: 0, route } }); };
  add('seller_api_read', 'GET /api/v1/orders', 100, 10);
  add('seller_api_read', 'GET /api/v1/stats/dashboard', 900, 10);
  add('buyer_page', 'GET /shop', 50, 10);
  add('beacon', 'POST /_t/e', 5000, 2);
  const slow = rec.slowest(2);
  assert.deepEqual(slow.map((s) => s.route), ['seller_api_read GET /api/v1/stats/dashboard', 'seller_api_read GET /api/v1/orders']);
  assert.equal(slow[0].requests, 10);
  assert.ok(slow[0].p95 >= 900);
});
