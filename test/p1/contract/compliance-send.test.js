// compliance.send(): the interface, what the stub does today, and the rule that nothing else reaches Meta to send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { ComplianceAction, SendResultShape } from '../../../src/contracts/compliance.js';
import { createInstagram, forBusiness } from '../../../src/instagram.js';
import { createCompliance } from '../../../src/modules/compliance/index.js';
import { NoTenantError, withTenant } from '../../../src/tenancy.js';
import { fakeIg, setup } from '../../helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const soon = () => new Date(Date.now() + 3_600_000);
const dm = (extra = {}) => ({ kind: 'dm', accountId: 'IG-A', recipientId: '42', personId: '42', idempotencyKey: 'dm:1', expiresAt: soon(), message: { text: 'hello' }, ...extra });

async function world(ig = fakeIg()) {
  const base = await setup();
  await base.platform.tenants.linkIgAccount(base.tenant.id, 'IG-A', 'a');
  await base.repos.igAccounts.setToken('IG-A', 'token-a');
  const compliance = createCompliance({ db: base.db, repos: base.platform, ig });
  const inBusiness = (fn) => withTenant(base.tenant, fn);
  return { ...base, ig, compliance, inBusiness };
}

const events = (db) => db.platform.query('SELECT * FROM compliance_events ORDER BY id');

test('send and enqueue refuse to run without a business', async () => {
  const { compliance } = await world();
  await assert.rejects(() => compliance.send(dm()), NoTenantError);
  await assert.rejects(() => compliance.enqueue(dm()), NoTenantError);
});

test('an action that breaks the interface is refused before anything happens', async () => {
  const { compliance, inBusiness, ig } = await world();
  for (const bad of [{ ...dm(), kind: 'broadcast' }, { ...dm(), recipientId: undefined }, { ...dm(), expiresAt: 'tomorrow' }, { ...dm(), kind: 'private_reply', recipientId: undefined }, { ...dm(), message: {} }]) {
    await assert.rejects(() => inBusiness(() => compliance.send(bad)), /invalid|Required|comment|recipient/i);
  }
  assert.deepEqual(ig.calls, []);
});

test('a send reaches Meta from the business\'s own account, and the log holds a hash and no person', async () => {
  const meta = createMeta();
  await meta.start();
  try {
    const { token } = await meta.post('/accounts', { igUserId: 'IG-A', username: 'a' });
    await meta.post('/messages', { igUserId: 'IG-A', from: '42', text: 'hi', deliver: false });
    const w = await world(createInstagram({ graphBaseUrl: meta.url }));
    await w.repos.igAccounts.setToken('IG-A', token);

    const result = await w.inBusiness(() => w.compliance.send(dm({ automationId: undefined, mediaId: 'M1' })));
    assert.equal(result.outcome, 'sent');
    assert.ok(result.messageId);
    assert.equal(SendResultShape.safeParse(result).success, true);
    const { sent } = await meta.get('/sent');
    assert.deepEqual(sent.map((m) => [m.igUserId, m.recipientId, m.message.text]), [['IG-A', '42', 'hello']]);

    const [row] = await events(w.db);
    assert.equal(row.channel, 'instagram');
    assert.equal(row.decision, 'sent');
    assert.equal(row.media_id, 'M1');
    assert.match(row.subject, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(row), /"42"|hello|token/);
  } finally {
    await meta.close();
  }
});

test('the same person hashes differently in two businesses, and the same within one', async () => {
  const w = await world();
  const repo = w.platform.compliance;
  const other = await w.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  const here = await w.inBusiness(() => repo.subjectHash('instagram', '42'));
  assert.equal(await w.inBusiness(() => repo.subjectHash('instagram', '42')), here);
  assert.notEqual(await withTenant(other, () => repo.subjectHash('instagram', '42')), here);
  assert.notEqual(await w.inBusiness(() => repo.subjectHash('facebook', '42')), here);
});

test('a timeout or 5xx is an unknown outcome, and a refusal is a failure, reported rather than thrown', async () => {
  const meta = createMeta();
  await meta.start();
  try {
    const { token } = await meta.post('/accounts', { igUserId: 'IG-A', username: 'a' });
    await meta.post('/messages', { igUserId: 'IG-A', from: '42', text: 'hi', deliver: false });
    const w = await world(createInstagram({ graphBaseUrl: meta.url, metaTimeoutMs: 100 }));
    await w.repos.igAccounts.setToken('IG-A', token);
    const send = (extra) => w.inBusiness(() => w.compliance.send(dm(extra)));

    await meta.fault({ kind: 'timeout' });
    assert.deepEqual([(await send()).outcome, (await events(w.db)).at(-1).reason], ['unknown', 'send.unknown_outcome']);
    await meta.fault({ kind: 'server_error' });
    assert.equal((await send()).reason, 'send.unknown_outcome');
    const refused = await send({ message: { text: 'x'.repeat(1001) } });
    assert.deepEqual([refused.outcome, refused.reason, refused.metaCode], ['failed', 'send.error', 100]);
  } finally {
    await meta.close();
  }
});

test('with no token nothing is called, and the job is held for reconnect', async () => {
  const w = await world();
  await w.platform.tenants.linkIgAccount(w.tenant.id, 'IG-EMPTY', 'e');
  const result = await w.inBusiness(() => w.compliance.send(dm({ accountId: 'IG-EMPTY' })));
  assert.deepEqual([result.outcome, result.reason], ['held', 'paused.reconnect']);
  assert.deepEqual(w.ig.calls, []);
});

test('another business\'s account can\'t be used', async () => {
  const w = await world();
  const other = await w.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  const result = await withTenant(other, () => w.compliance.send(dm()));
  assert.equal(result.outcome, 'held');
  assert.deepEqual(w.ig.calls, []);
});

test('enqueue creates one job per idempotency key, and one business never drops another\'s', async () => {
  const w = await world();
  const other = await w.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  await w.platform.tenants.linkIgAccount(other.id, 'IG-B', 'b');
  const first = await w.inBusiness(() => w.compliance.enqueue(dm()));
  assert.equal(first.outcome, 'queued');
  assert.ok(first.jobId);
  assert.deepEqual((({ outcome, reason }) => [outcome, reason])(await w.inBusiness(() => w.compliance.enqueue(dm()))), ['skipped', 'webhook.duplicate']);
  assert.equal((await withTenant(other, () => w.compliance.enqueue(dm({ accountId: 'IG-B' })))).outcome, 'queued');
  const [job] = await w.db.platform.query('SELECT * FROM outbound_jobs ORDER BY id LIMIT 1');
  assert.equal(job.status, 'queued');
  assert.match(job.subject_hash, /^[0-9a-f]{64}$/);
});

test('the legacy handler\'s client goes through send, and throws what the handler expects', async () => {
  const w = await world();
  const client = w.compliance.clientFor({ igUserId: 'IG-A', token: 'token-a' });
  await w.inBusiness(() => client.sendPrivateReplyButton('c1', 'Hi', 'https://x.test', 'Go'));
  await w.inBusiness(() => client.sendPrivateReply('c2', 'Hi'));
  await w.inBusiness(() => client.replyToComment('c3', 'Thanks'));
  assert.deepEqual(w.ig.calls, [['button', 'c1', 'Hi', 'https://x.test', 'Go'], ['text', 'c2', 'Hi'], ['reply', 'c3', 'Thanks']]);
  assert.equal((await events(w.db)).length, 3);

  const failing = await world(fakeIg({ failButton: true }));
  await assert.rejects(() => failing.inBusiness(() => failing.compliance.clientFor({ igUserId: 'IG-A', token: 't' }).sendPrivateReplyButton('c1', 'Hi', 'https://x.test', 'Go')), /template not supported/);
});

test('a failed log write never changes what the caller is told', async () => {
  const w = await world();
  const broken = { ...w.db, query: (sql, params) => (/compliance_events/.test(sql) ? Promise.reject(new Error('disk full')) : w.db.query(sql, params)) };
  const compliance = createCompliance({ db: broken, repos: w.platform, ig: w.ig });
  const result = await w.inBusiness(() => compliance.send(dm()));
  assert.equal(result.outcome, 'sent');
});

test('ComplianceAction fills in what it may, and requires what it must', () => {
  const parsed = ComplianceAction.parse(dm());
  assert.equal(parsed.channel, 'instagram');
  assert.equal(parsed.purpose, 'trigger');
  assert.equal(parsed.isTest, false);
  assert.equal(ComplianceAction.safeParse(dm({ idempotencyKey: '' })).success, false);
  assert.equal(ComplianceAction.safeParse({ kind: 'public_reply', accountId: 'a', idempotencyKey: 'k', expiresAt: soon(), message: { text: 'x' } }).success, false);
});

test('forBusiness finds only the current business\'s account, and refuses to run outside one', async () => {
  const w = await world();
  const other = await w.platform.tenants.create({ slug: 'beta-store', name: 'Beta' });
  await assert.rejects(() => forBusiness(w.ig, w.platform), NoTenantError);
  assert.equal(await withTenant(other, () => forBusiness(w.ig, w.platform)), null);
  assert.equal(await withTenant(other, () => forBusiness(w.ig, w.platform, 'IG-A')), null);
  const client = await w.inBusiness(() => forBusiness(w.ig, w.platform));
  await client.sendPrivateReply('c1', 'x');
  assert.deepEqual(w.ig.accounts.map((a) => a.token), ['token-a']);
});

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

const rel = (file) => path.relative(repoRoot, file).replaceAll('\\', '/');

test('nothing but compliance.send() can message anyone through Meta', () => {
  const SEND_CALL = /\.(sender|sendPrivateReply|sendPrivateReplyButton|sendMessage|replyToComment)\(/;
  // src/handler.js only ever receives compliance.clientFor(); the compliance track moves the webhook off it.
  const allowed = (file) => file === 'src/instagram.js' || file === 'src/handler.js' || file.startsWith('src/modules/compliance/');
  const offenders = [...sourceFiles(path.join(repoRoot, 'src')), ...sourceFiles(path.join(repoRoot, 'scripts'))]
    .map(rel)
    .filter((file) => !allowed(file) && !file.startsWith('src/adapters/meta/'))
    .filter((file) => SEND_CALL.test(fs.readFileSync(path.join(repoRoot, file), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('only the Meta adapter knows Meta\'s addresses', () => {
  const offenders = sourceFiles(path.join(repoRoot, 'src')).map(rel)
    .filter((file) => !file.startsWith('src/adapters/meta/'))
    .filter((file) => /graph\.(instagram|facebook)\.com|api\.instagram\.com/.test(fs.readFileSync(path.join(repoRoot, file), 'utf8')));
  assert.deepEqual(offenders, []);
});
