// PRD 4.1 and 4.13: webhook intake and routing. C-01, C-02, C-03, C-46.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_SECRET, DAY, HOUR, addShop, assertNoDm, commentPayload, failingDb, hit, hubSignature, need, openWorld, pause, unique, useWorld, VERIFY_TOKEN } from './support.js';

const world = useWorld();

const countAll = async (tenantId) => {
  const [{ inbound, events }] = await world.rawDb.platform.query('SELECT (SELECT count(*)::int FROM inbound_events WHERE tenant_id = $1) AS inbound, (SELECT count(*)::int FROM compliance_events WHERE tenant_id = $1) AS events', [tenantId]);
  return { inbound, events };
};

const BAD_SIGNATURES = {
  'one made with the wrong secret': (raw) => hubSignature(raw, 'not-the-secret'),
  'one made with an empty secret': (raw) => hubSignature(raw, ''),
  'one for different bytes': () => hubSignature('{"object":"instagram","entry":[]}', APP_SECRET),
  'a value with no digest': () => 'sha256=',
  'an empty value': () => '',
  'a digest one byte short': (raw) => hubSignature(raw, APP_SECRET).slice(0, -2),
  'a digest that is not hex': () => `sha256=${'z'.repeat(64)}`,
  'the right digest with no sha256= prefix': (raw) => hubSignature(raw, APP_SECRET).replace('sha256=', ''),
  'the right digest named sha1': (raw) => hubSignature(raw, APP_SECRET).replace('sha256=', 'sha1='),
};

for (const [label, make] of Object.entries(BAD_SIGNATURES)) {
  test(`C-01: ${label} gets 401 and nothing is stored`, async () => {
    const shop = await addShop(world);
    const reel = await shop.automate();
    const payload = commentPayload(shop, { mediaId: reel.mediaId, from: world.fan() });
    const raw = JSON.stringify(payload);
    const res = await world.webhook(raw, { signature: make(raw) });
    assert.equal(res.status, 401);
    await shop.settle();
    assert.deepEqual(await countAll(shop.tenantId), { inbound: 0, events: 0 });
    await assertNoDm(shop);
  });
}

test('C-01: no signature header at all gets 401 and nothing is stored', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const res = await world.webhook(commentPayload(shop, { mediaId: reel.mediaId, from: world.fan() }), { signature: 'none' });
  assert.equal(res.status, 401);
  assert.deepEqual(await countAll(shop.tenantId), { inbound: 0, events: 0 });
});

test('C-01: a body changed after signing is refused, down to one trailing space', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const raw = JSON.stringify(commentPayload(shop, { mediaId: reel.mediaId, from: world.fan() }));
  const res = await world.webhook(`${raw} `, { signature: hubSignature(raw, APP_SECRET) });
  assert.equal(res.status, 401);
  assert.deepEqual(await countAll(shop.tenantId), { inbound: 0, events: 0 });
});

test('C-01: the simulator\'s forged delivery is refused and no DM follows', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const { delivery } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from: world.fan(), text: 'price', signature: 'bad' });
  assert.equal(delivery.status, 401);
  await shop.settle();
  await assertNoDm(shop);
});

test('C-01: with no app secret set, every webhook is refused, even one signed with the empty secret', async () => {
  const w = await openWorld({ overrides: { appSecret: '' } });
  try {
    const raw = JSON.stringify({ object: 'instagram', entry: [] });
    assert.equal((await w.webhook(raw, { signature: hubSignature(raw, '') })).status, 401);
  } finally {
    await w.close();
  }
});

test('C-01: the Meta handshake echoes the challenge only for the right verify token', async () => {
  const good = await hit(world, `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345`);
  assert.equal(good.status, 200);
  assert.equal(good.text, '12345');
  assert.equal((await hit(world, '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345')).status, 403);
  assert.equal((await hit(world, '/webhook?hub.mode=subscribe&hub.challenge=12345')).status, 403);
});

test('C-02: the event is stored before the 200, and a worker that was down processes it once when it comes back', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  let comment;
  try {
    comment = await shop.comment(reel.mediaId);
    const rows = await shop.inbound();
    assert.equal(rows.length, 1, 'The event is already in inbound_events when the 200 has gone back');
    assert.equal(rows[0].status, 'stored');
    assert.equal(rows[0].field, 'comments');
    assert.equal(rows[0].object_id, comment.id);
    await assertNoDm(shop, 'Nothing is sent inline in the webhook request');
  } finally {
    world.startWorker();
  }
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.inbound())[0].status, 'done');
});

test('C-02: the 200 comes back with no Graph call made during the request', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  try {
    const before = (await world.meta.calls()).length;
    await shop.comment(reel.mediaId);
    assert.equal((await world.meta.calls()).length, before, 'Intake only stores: timestamps and sends belong to the worker');
  } finally {
    world.startWorker();
  }
  await shop.settle();
});

test('C-02: a worker killed halfway through an event leaves it to be picked up again, and it is processed once', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  world.stopWorker();
  try {
    await shop.comment(reel.mediaId);
    await shop.sql(`UPDATE inbound_events SET status = 'processing', attempts = 1, lease_until = now() - interval '1 second' WHERE tenant_id = $1`, [shop.tenantId]);
  } finally {
    world.startWorker();
  }
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
  assert.equal((await shop.inbound())[0].status, 'done');
});

test('C-02: a worker killed while a send was in flight is never resent: the job ends unknown', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.refuseSends({ code: 613, status: 429 });
  await shop.comment(reel.mediaId);
  await shop.settle();
  await shop.sql(`UPDATE outbound_jobs SET status = 'sending', locked_by = 'dead-worker', lease_until = now() - interval '1 second', run_at = now() - interval '2 hours' WHERE tenant_id = $1`, [shop.tenantId]);
  await world.travel(2 * HOUR);
  await shop.settle();
  const [job] = await shop.jobs();
  assert.equal(job.status, 'unknown');
  assert.equal(job.reason, 'send.unknown_outcome');
  assert.equal((await shop.dms()).length, 0);
});

test('C-02: if the event can\'t be stored Meta does not get a 200, and its retry works once storage is back', async () => {
  const state = { on: false };
  const w = await openWorld({ wrapDb: (db) => failingDb(db, /insert\s+into\s+inbound_events/i, state) });
  try {
    const shop = await addShop(w);
    const reel = await shop.automate();
    const { comment } = await w.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from: w.fan(), text: 'price', deliver: false });
    const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from: w.fan() });
    state.on = true;
    const refused = await w.webhook(payload);
    assert.ok(refused.status >= 500, `Expected a 5xx so Meta retries, got ${refused.status}`);
    state.on = false;
    assert.equal(await shop.inbound().then((r) => r.length), 0);
    need(await w.webhook(payload), 200, 'The retry');
    await shop.settle();
    assert.equal((await shop.dms()).length, 1);
  } finally {
    await w.close();
  }
});

test('C-03: the same event three times in a row is 1 row and 1 DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const { delivery } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from: world.fan(), text: 'price', duplicates: 3 });
  assert.equal(delivery.status, 200);
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-03: the same event three times at the same moment is 1 row and 1 DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from });
  const answers = await Promise.all([world.webhook(payload), world.webhook(payload), world.webhook(payload)]);
  assert.deepEqual(answers.map((r) => r.status), [200, 200, 200]);
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-03: the same comment twice inside one batch is 1 row and 1 DM', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  const one = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from });
  need(await world.webhook({ object: 'instagram', entry: [one.entry[0], one.entry[0]] }), 200, 'The batch');
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-03: two workers racing over the same events send each DM once', async () => {
  const w = await openWorld();
  try {
    w.addWorker();
    const shop = await addShop(w);
    const reel = await shop.automate();
    const fans = Array.from({ length: 12 }, () => w.fan());
    await Promise.all(fans.map((from) => shop.comment(reel.mediaId, { from })));
    await shop.settle({ ms: 20_000 });
    const dms = await shop.dms();
    assert.equal(dms.length, 12);
    assert.equal(new Set(dms.map((m) => m.commentId)).size, 12, 'Each comment gets its own reply, once');
  } finally {
    await w.close();
  }
});

test('C-03: Meta redelivering 30 hours later, inside its 36 hour retry, adds nothing', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from });
  need(await world.webhook(payload), 200, 'First delivery');
  await shop.settle();
  await world.travel(30 * HOUR);
  need(await world.webhook(payload), 200, 'Late redelivery');
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-03: a batch of 1,000 events in one POST, the most Meta sends, is stored whole', async () => {
  const shop = await addShop(world);
  const entry = Array.from({ length: 1000 }, (_, i) => commentPayload(shop, { id: `batch-${unique()}-${i}`, mediaId: '1', text: `comment number ${i} with a little more text in it`, from: { id: `${i}`, username: `user_${i}` } }).entry[0]);
  need(await world.webhook({ object: 'instagram', entry }), 200, 'A batch of 1,000');
  assert.equal((await shop.inbound()).length, 1000);
});

const JUNK_BODIES = { 'a JSON array': '[]', 'null': 'null', 'a number': '42', 'a string': '"instagram"', 'an entry that is not a list': '{"object":"instagram","entry":"x"}', 'entries of the wrong types': '{"object":"instagram","entry":[null,1,"a",[],{}]}', 'changes of the wrong types': '{"object":"instagram","entry":[{"id":"1","changes":[null,3,{"field":1},{"value":{}}]}]}', 'broken JSON': '{"object":"instagram","entry":[', 'empty': '' };

for (const [label, raw] of Object.entries(JUNK_BODIES)) {
  test(`C-03: a correctly signed body that is ${label} never gets a 5xx and stores nothing`, async () => {
    const before = await world.rawDb.platform.query('SELECT count(*)::int AS n FROM inbound_events');
    const res = await world.webhook(raw);
    assert.ok(res.status === 200 || res.status === 400, `Got ${res.status}`);
    const after = await world.rawDb.platform.query('SELECT count(*)::int AS n FROM inbound_events');
    assert.equal(after[0].n, before[0].n);
    assert.equal((await hit(world, '/healthz')).status, 200);
  });
}

test('C-03: one malformed item never takes the rest of its delivery down', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  const good = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from }).entry[0];
  const bad = { id: shop.igUserId, time: 1, changes: [{ field: 'comments', value: { nonsense: true } }, { field: 'comments' }] };
  need(await world.webhook({ object: 'instagram', entry: [bad, good, null] }), 200, 'A delivery with broken items');
  await shop.settle();
  assert.equal((await shop.dms()).length, 1);
});

test('C-03: a comment holding a NUL byte is not a 5xx loop: it answers 200 and the next event still works', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  const from = world.fan();
  const res = await world.webhook(commentPayload(shop, { id: `nul-${unique()}`, mediaId: reel.mediaId, text: 'price\u0000 please', from }));
  assert.equal(res.status, 200);
  await shop.settle();
  const after = await shop.comment(reel.mediaId, { from: world.fan() });
  await shop.settle();
  assert.equal((await shop.dms({ commentId: after.id })).length, 1);
});

test('C-03: a body trying prototype pollution changes nothing', async () => {
  const raw = '{"object":"instagram","__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"entry":[{"id":"1","__proto__":{"polluted":"yes"},"changes":[]}]}';
  assert.equal((await world.webhook(raw)).status, 200);
  assert.equal(({}).polluted, undefined);
});

test('C-03: an id sent as a number routes the same as an id sent as text', async () => {
  const shop = await addShop(world, { igUserId: '1784140000123' });
  const reel = await shop.automate();
  const from = world.fan();
  const { comment } = await world.meta.post('/comments', { igUserId: shop.igUserId, mediaId: reel.mediaId, from, text: 'price', deliver: false });
  const payload = commentPayload(shop, { id: comment.id, mediaId: reel.mediaId, from });
  payload.entry[0].id = 1784140000123;
  need(await world.webhook(payload), 200, 'Numeric entry id');
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1);
  assert.equal((await shop.dms()).length, 1);
});

test('C-46: a comment on one business\'s account is routed only to that business, and sent with its token', async () => {
  const mehta = await addShop(world);
  const plant = await addShop(world);
  const mehtaReel = await mehta.automate();
  const plantReel = await plant.automate();
  const comment = await plant.comment(plantReel.mediaId);
  await plant.settle();
  const [dm] = await plant.dms();
  assert.equal(dm.commentId, comment.id);
  assert.equal((await mehta.inbound()).length, 0);
  assert.equal((await mehta.events()).length, 0);
  await assertNoDm(mehta);
  assert.ok(mehtaReel.id);
});

test('C-46: one batch with entries for two businesses goes to each of them, and neither sees the other\'s', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelA = await a.automate();
  const reelB = await b.automate();
  const fanA = world.fan();
  const fanB = world.fan();
  const made = await Promise.all([
    world.meta.post('/comments', { igUserId: a.igUserId, mediaId: reelA.mediaId, from: fanA, text: 'price', deliver: false }),
    world.meta.post('/comments', { igUserId: b.igUserId, mediaId: reelB.mediaId, from: fanB, text: 'price', deliver: false }),
  ]);
  const entry = [commentPayload(a, { id: made[0].comment.id, mediaId: reelA.mediaId, from: fanA }).entry[0], commentPayload(b, { id: made[1].comment.id, mediaId: reelB.mediaId, from: fanB }).entry[0]];
  need(await world.webhook({ object: 'instagram', entry }), 200, 'A mixed batch');
  await a.settle();
  await b.settle();
  assert.deepEqual((await a.dms()).map((m) => m.commentId), [made[0].comment.id]);
  assert.deepEqual((await b.dms()).map((m) => m.commentId), [made[1].comment.id]);
  assert.equal((await a.inbound()).length, 1);
  assert.equal((await b.inbound()).length, 1);
});

test('C-46: a media id one business automates means nothing when it arrives on another business\'s account', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const reelA = await a.automate();
  const from = world.fan();
  need(await world.webhook(commentPayload(b, { id: `cross-${unique()}`, mediaId: reelA.mediaId, from })), 200, 'A delivery on B\'s account for A\'s reel');
  await b.settle();
  await a.settle();
  await assertNoDm(a);
  await assertNoDm(b);
  assert.deepEqual((await b.events()).map((e) => e.reason), ['unmapped']);
  assert.equal((await a.inbound()).length, 0);
});

test('C-46: two businesses can automate the same media id, each answers only on its own account', async () => {
  const a = await addShop(world);
  const b = await addShop(world);
  const sharedId = `9${unique()}`;
  await a.automate({ mediaId: await a.reel({ id: sharedId }) });
  const saved = await b.tryAutomation({ mediaId: sharedId });
  assert.equal(saved.status, 201, 'One business must not be able to lock another out of a media id');
});

test('C-46: an account no business owns gets a 200, leaves only its id behind, and is never given to the default business', async () => {
  const w = await openWorld({ defaultTenant: 'default' });
  try {
    await w.platform.tenants.ensure({ slug: 'default', name: 'Default' });
    const stranger = `8${unique()}`;
    const text = 'private words from a stranger';
    const payload = { object: 'instagram', entry: [{ id: stranger, time: 1, changes: [{ field: 'comments', value: { id: `s-${unique()}`, text, from: { id: '77', username: 'stranger_handle' }, media: { id: '5' } } }] }] };
    need(await w.webhook(payload), 200, 'An unknown account');
    await w.settle();
    assert.equal((await w.rawDb.platform.query('SELECT count(*)::int AS n FROM inbound_events'))[0].n, 0, 'Nothing is stored against any business');
    const rows = await w.rawDb.platform.query('SELECT * FROM inbound_unrouted WHERE account_id = $1', [stranger]);
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows[0]), /private words|stranger_handle/);
    need(await w.webhook(payload), 200, 'The same again');
    assert.equal((await w.rawDb.platform.query('SELECT deliveries FROM inbound_unrouted WHERE account_id = $1', [stranger]))[0].deliveries, 2);
    assert.deepEqual((await w.meta.get('/sent')).sent, []);
  } finally {
    await w.close();
  }
});

test('C-46: nothing is forwarded to another app, even if an old forwarding setting is present', async () => {
  const forwarded = [];
  const { default: http } = await import('node:http');
  const other = http.createServer((rq, rs) => { forwarded.push(rq.url); rs.end('ok'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${other.address().port}/incoming`;
  const w = await openWorld({ overrides: { forwardWebhookUrl: url, pluginUrl: url } });
  try {
    const shop = await addShop(w);
    const reel = await shop.automate();
    await shop.comment(reel.mediaId);
    await shop.settle();
    await pause(50);
    assert.deepEqual(forwarded, []);
  } finally {
    await w.close();
    await new Promise((resolve) => other.close(resolve));
  }
});

test('C-51: retention: raw webhooks older than 7 days are gone, and a younger one stays', async () => {
  const shop = await addShop(world);
  const reel = await shop.automate();
  await shop.comment(reel.mediaId);
  await shop.settle();
  await world.travel(7 * DAY - 60_000);
  await shop.settle();
  assert.equal((await shop.inbound()).length, 1, 'Not yet 7 days old');
  await world.travel(120_000);
  await shop.settle();
  assert.equal((await shop.inbound()).length, 0, 'Past 7 days');
});
