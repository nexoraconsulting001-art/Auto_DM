// The whole path against the Meta simulator: a signed webhook in, the real Instagram client out, Meta's own rules enforced on the far side.
import '../../../tools/net-guard.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeta } from '../../../tools/sim/meta/index.mjs';
import { createInstagram } from '../../../src/instagram.js';
import { MODULES } from '../../../src/modules/index.js';
import { setLogSink } from '../../../src/platform/log.js';
import { IG_ACCOUNT, REEL_ID, seedReel, startApp } from '../../helpers.js';

const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  return check();
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setup(t, { modules, seed = true } = {}) {
  const meta = await createMeta({ app: { secret: 'secret', verifyToken: 'vt', echoes: true } }).start();
  t.after(() => meta.close());
  const { token } = await meta.post('/accounts', { igUserId: IG_ACCOUNT.igUserId, username: IG_ACCOUNT.username, subscribedFields: ['comments', 'messages', 'messaging_postbacks'] });
  const app = await startApp({ ig: createInstagram({ graphBaseUrl: meta.url, graphVersion: 'v23.0' }), overrides: { graphBaseUrl: meta.url, graphVersion: 'v23.0', metaTimeoutMs: 1000 }, ...(modules ? { modules } : {}) });
  t.after(() => app.close());
  await app.repos.igAccounts.setToken(IG_ACCOUNT.igUserId, token);
  if (seed) await seedReel(app.repos);
  await meta.post('/app', { webhookUrl: `${app.base}/webhook` });
  const comment = (fields = {}) => meta.post('/comments', { igUserId: IG_ACCOUNT.igUserId, mediaId: REEL_ID, from: { id: 'shopper-1', username: 'asha_secret_name' }, text: 'LINK please', ...fields });
  const sent = async (kind) => (await meta.get('/sent', kind ? { kind } : {})).sent;
  const jobs = () => app.db.platform.query('SELECT * FROM outbound_jobs ORDER BY id');
  const events = () => app.db.platform.query('SELECT * FROM compliance_events ORDER BY id');
  return { meta, app, comment, sent, jobs, events };
}

test('a comment on a mapped reel becomes one button DM from the account\'s own token', async (t) => {
  const { meta, comment, sent, jobs } = await setup(t);
  await comment({ id: 'c-1' });
  const [dm] = await until(async () => {
    const list = await sent('private_reply');
    return list.length ? list : null;
  });
  assert.equal(dm.commentId, 'c-1');
  assert.equal(dm.message.attachment.payload.template_type, 'button');
  await until(async () => (await jobs())[0]?.status !== 'sending');
  assert.equal((await jobs())[0].status, 'sent');
  await until(async () => (await meta.get('/webhooks')).deliveries.some((d) => d.body?.entry?.[0]?.messaging?.[0]?.message?.is_echo));
  await pause(100);
  assert.equal((await sent('private_reply')).length, 1, 'its own echo does not trigger anything');
});

test('C-14: the comment\'s own time decides: 6d 23h 30m old is never sent', async (t) => {
  const { meta, comment, events, sent } = await setup(t);
  await comment({ id: 'old-1', at: Date.now() - (6 * DAY + 23 * HOUR + 30 * 60_000) });
  await until(async () => (await events()).some((e) => e.reason === 'expired.7d'));
  assert.ok((await events()).some((e) => e.reason === 'expired.7d' && e.comment_id === 'old-1'));
  assert.deepEqual(await sent('private_reply'), []);
  const lookups = await meta.calls({ method: 'GET', path: '*/old-1' });
  assert.equal(lookups.length, 1);
});

test('C-15: a comment Meta no longer has is cancelled, with one call and no fallback', async (t) => {
  const { meta, comment, jobs, app } = await setup(t);
  const { comment: { id } } = await comment({ deliver: false });
  await meta.post('/comments/delete', { id });
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: IG_ACCOUNT.igUserId, changes: [{ field: 'comments', value: { id, text: 'LINK', from: { id: 'shopper-1' }, media: { id: REEL_ID } } }] }] });
  const { hubSignature } = await import('../../../tools/sim/meta/index.mjs');
  await fetch(`${app.base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': hubSignature(body, 'secret') }, body });
  await until(async () => (await jobs())[0]?.status === 'cancelled');
  assert.deepEqual((await jobs()).map((j) => [j.status, j.reason]), [['cancelled', 'comment.deleted']]);
  assert.equal((await meta.calls({ method: 'POST', path: `*/${IG_ACCOUNT.igUserId}/messages` })).length, 1);
});

test('C-22: STOP in a DM blocks the person and confirms once, through the real Send API', async (t) => {
  const { meta, app, sent } = await setup(t);
  await meta.post('/messages', { igUserId: IG_ACCOUNT.igUserId, from: { id: 'shopper-2' }, text: 'STOP' });
  const list = await until(async () => {
    const all = await sent();
    return all.length ? all : null;
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].recipientId, 'shopper-2');
  const rows = await app.db.platform.query('SELECT source FROM opt_outs');
  assert.deepEqual(rows, [{ source: 'dm' }]);
});

test('a usage header at 90% on a messaging response starts slow mode', async (t) => {
  const answering = {
    name: 'answering',
    onInboundEvent: (event, ctx) => ctx.compliance.enqueue({
      kind: 'private_reply', channel: event.channel, accountId: event.accountId, idempotencyKey: `private_reply:${event.commentId}`, commentId: event.commentId, personId: event.personId,
      mediaId: event.mediaId, expiresAt: event.expiresAt, message: { text: 'Here you go', button: { url: 'https://example.test/p', title: 'Open' } },
    }).then(() => true),
  };
  const { meta, app, comment, sent } = await setup(t, { modules: [...MODULES, answering] });
  await meta.post('/usage', { igUserId: IG_ACCOUNT.igUserId, percent: 91 });
  await comment({ id: 'u-1' });
  await until(async () => (await sent('private_reply')).length === 1);
  await until(async () => (await app.db.platform.query('SELECT 1 FROM account_rate_state WHERE slow_mode_until IS NOT NULL')).length);
  const [rate] = await app.db.platform.query('SELECT usage_percent, slow_mode_trigger FROM account_rate_state');
  assert.deepEqual([rate.usage_percent, rate.slow_mode_trigger], [91, 'buc_80002']);
});

test('C-51: after sends, no log line holds a username or a message', async (t) => {
  const lines = [];
  setLogSink((line) => lines.push(line));
  t.after(() => setLogSink((line, level) => (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)));
  const { meta, comment, sent } = await setup(t);
  for (let i = 0; i < 5; i++) await comment({ id: `log-${i}`, from: { id: `p${i}`, username: 'asha_secret_name' }, text: 'LINK secret words here' });
  await meta.post('/messages', { igUserId: IG_ACCOUNT.igUserId, from: { id: 'shopper-3', username: 'asha_secret_name' }, text: 'secret words here, STOP please' });
  await until(async () => (await sent('private_reply')).length === 5);
  await pause(100);
  const all = lines.join('\n');
  assert.match(all, /webhook\.comment/);
  assert.doesNotMatch(all, /asha_secret_name|secret words/);
});
