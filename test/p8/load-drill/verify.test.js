// "Lost" and "twice", counted from the database and from the Meta simulator's record, on a real Postgres with the real tables.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { openDb } from '../../../src/db/index.js';
import { createRepos } from '../../../src/repos/index.js';
import { createSecrets } from '../../../src/platform/secrets.js';
import { loadBudgets, startPostgres } from '../../../tools/load/stack.mjs';
import { sendDelays, verifyWebhooks, waitDrained } from '../../../tools/load/verify.mjs';

const budgets = loadBudgets();
let dir;
let server;
let db;
let tenantIds;
let sent = [];
let world;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-verify-test-'));
  server = await startPostgres({ dir: path.join(dir, 'pg'), budgets });
  db = await openDb({ url: server.appUrl, ownerUrl: server.ownerUrl, poolSize: 2 });
  const repos = createRepos(db, { secrets: createSecrets({ dataKey: Buffer.alloc(32, 1).toString('base64') }) });
  tenantIds = [];
  for (const n of [1, 2]) {
    const tenant = await repos.tenants.create({ slug: `verify${n}`, name: `Verify ${n}`, plan: 't3' });
    await repos.tenants.linkIgAccount(tenant.id, `17841400000000${n}`, `verify${n}_ig`);
    tenantIds.push(tenant.id);
  }
  world = { db, meta: { get: async () => ({ sent }) } };
}, { timeout: 180_000 });

after(async () => {
  await db?.close().catch(() => {});
  await server?.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const event = (tenantId, n, objectId, status, field = 'comments') => db.platform.query(
  `INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id, payload, status, received_at) VALUES ($1, 'instagram', $2, $3, $4, '{}', $5, now() - interval '30 seconds')`,
  [tenantId, `17841400000000${n}`, field, objectId, status],
);
const job = (tenantId, n, commentId, key, status = 'sent', sentAgoSeconds = 10) => db.platform.query(
  `INSERT INTO outbound_jobs (tenant_id, channel, ig_user_id, kind, idempotency_key, status, comment_id, expires_at, sent_at) VALUES ($1, 'instagram', $2, 'private_reply', $3, $4, $5, now() + interval '1 day', now() - ($6 || ' seconds')::interval)`,
  [tenantId, `17841400000000${n}`, key, status, commentId, String(sentAgoSeconds)],
);

test('Q-07: a webhook that was answered 200 and is not stored is lost; one that is stored but not done is unhandled; a message and a comment are each looked up in their own field', async () => {
  await event(tenantIds[0], 1, 'c-ok', 'done');
  await event(tenantIds[0], 1, 'm-ok', 'done', 'messages');
  await event(tenantIds[0], 1, 'c-stuck', 'stored');
  await event(tenantIds[1], 2, 'c-failed', 'failed');
  const accepted = [
    { id: 'c-ok', field: 'comments', tenantId: tenantIds[0] },
    { id: 'm-ok', field: 'messages', tenantId: tenantIds[0] },
    { id: 'c-stuck', field: 'comments', tenantId: tenantIds[0] },
    { id: 'c-failed', field: 'comments', tenantId: tenantIds[1] },
    { id: 'c-gone', field: 'comments', tenantId: tenantIds[0] },
    { id: 'c-ok', field: 'comments', tenantId: tenantIds[1] },
  ];
  const result = await verifyWebhooks(world, accepted);
  assert.equal(result.accepted, 6);
  assert.equal(result.lost, 2, 'c-gone is nowhere, and c-ok was stored for the other business only');
  assert.deepEqual(result.lostSample.sort(), ['c-gone', 'c-ok']);
  assert.equal(result.unhandled, 2);
  assert.deepEqual(result.unhandledByStatus, { stored: 1, failed: 1 });
  assert.equal(result.stored, 4);
  assert.equal(result.duplicateSends, 0);
});

test('Q-07: a comment that Meta recorded as delivered twice, or that has two sent jobs, is a send twice; two different comments are not', async () => {
  sent = [
    { igUserId: '178414000000001', commentId: 'c-1', kind: 'private_reply' },
    { igUserId: '178414000000001', commentId: 'c-2', kind: 'private_reply' },
    { igUserId: '178414000000002', commentId: 'c-1', kind: 'private_reply' },
    { igUserId: '178414000000001', commentId: 'c-1', kind: 'public_reply' },
    { igUserId: '178414000000001', recipientId: 'person', kind: 'dm' },
  ];
  assert.equal((await verifyWebhooks(world, [])).duplicateSends, 0, 'the same comment id at two businesses, or a reply and a DM to one comment, is not twice');
  sent.push({ igUserId: '178414000000001', commentId: 'c-2', kind: 'private_reply' });
  assert.equal((await verifyWebhooks(world, [])).duplicateSends, 1);
  await job(tenantIds[0], 1, 'c-9', 'key-9a');
  await job(tenantIds[0], 1, 'c-9', 'key-9b');
  await job(tenantIds[0], 1, 'c-8', 'key-8', 'sent');
  await job(tenantIds[1], 2, 'c-8', 'key-8-other', 'sent');
  await job(tenantIds[0], 1, 'c-7', 'key-7a', 'failed');
  await job(tenantIds[0], 1, 'c-7', 'key-7b', 'sent');
  const result = await verifyWebhooks(world, []);
  assert.equal(result.duplicateSends, 2, 'two sent jobs for c-9 at one business; c-8 at two businesses and c-7 with one failure are fine');
  assert.ok(result.jobStatuses.sent >= 5 && result.jobStatuses.failed === 1);
});

test('waitDrained: false when something is still waiting for the time given, true once nothing is; it can be asked about some businesses only', async () => {
  await event(tenantIds[1], 2, 'c-waiting', 'processing');
  assert.equal(await waitDrained(world, { ms: 700 }), false);
  assert.equal(await waitDrained(world, { ms: 700, tenantIds: [tenantIds[0]], sends: false }), false, 'the first business still has c-stuck');
  await db.platform.query(`UPDATE inbound_events SET status = 'done' WHERE status IN ('stored', 'processing')`);
  assert.equal(await waitDrained(world, { ms: 2000 }), true);
  await job(tenantIds[0], 1, 'c-queued', 'key-queued', 'queued');
  assert.equal(await waitDrained(world, { ms: 600 }), false, 'a send still queued is work waiting');
  assert.equal(await waitDrained(world, { ms: 600, sends: false }), true);
});

test('Q-06: the delay of a DM is from the comment arriving to the DM going out, for the businesses and the time asked about', async () => {
  await db.platform.query(`DELETE FROM outbound_jobs`);
  await event(tenantIds[0], 1, 'c-d1', 'done');
  await event(tenantIds[1], 2, 'c-d2', 'done');
  await job(tenantIds[0], 1, 'c-d1', 'k-d1', 'sent', 10);
  await job(tenantIds[1], 2, 'c-d2', 'k-d2', 'sent', 25);
  const since = new Date(Date.now() - 3_600_000);
  const first = await sendDelays(world, { tenantIds: [tenantIds[0]], since });
  assert.equal(first.length, 1);
  assert.ok(first[0] > 19 && first[0] < 21, `30 s since arrival, 10 s since the send: 20 s, got ${first[0]}`);
  const second = await sendDelays(world, { tenantIds: [tenantIds[1]], since });
  assert.ok(second[0] > 4 && second[0] < 6, `got ${second[0]}`);
  assert.equal((await sendDelays(world, { tenantIds, since })).length, 2);
  assert.equal((await sendDelays(world, { tenantIds, since: new Date() })).length, 0, 'a comment from before the window is left out');
});
