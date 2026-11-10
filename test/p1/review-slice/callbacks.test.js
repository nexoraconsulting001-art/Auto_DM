import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedRequest } from '../../../tools/sim/meta/index.mjs';
import { APP_SECRET, IG_A, IG_B, accountRow, addBusiness, addJob, alertsFor, auditFor, connected, consent, decisions, jobStatus, seedIg, startSlice, subscribedOnMeta, until } from './support.js';

const post = (slice, path, signed) => fetch(`${slice.app.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(signed === undefined ? {} : { signed_request: signed }) });
const signed = (payload, secret = APP_SECRET) => signedRequest({ algorithm: 'HMAC-SHA256', ...payload }, secret);

/** Instagram data of every kind this business could hold about an account. Returns what a test needs to find it again. */
async function seedPlatformData(slice, business, igUserId) {
  const { q } = slice;
  const tenant = business.tenant.id;
  const [thread] = await q(`INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, username, last_message, last_message_at) VALUES ($1, 'instagram', $2, 'subject-1', 'igsid-1', 'asha.k', 'where is my order', now()) RETURNING id`, [tenant, igUserId]);
  await q(`INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, text) VALUES ($1, $2, 'in', 'person', 'where is my order')`, [tenant, thread.id]);
  await q(`INSERT INTO needs_human_items (tenant_id, channel, thread_id, kind, username, text) VALUES ($1, 'instagram', $2, 'handoff', 'asha.k', 'where is my order')`, [tenant, thread.id]);
  await q(`INSERT INTO needs_human_items (tenant_id, channel, kind, username, text) VALUES ($1, 'instagram', 'negative_comment', 'ravi', 'bad service')`, [tenant]);
  await q(`INSERT INTO inbound_events (tenant_id, channel, account_id, field, object_id, payload) VALUES ($1, 'instagram', $2, 'comments', 'c-1', '{"text":"LINK"}')`, [tenant, igUserId]);
  await q(`INSERT INTO activity (tenant_id, comment_id, username, text, result) VALUES ($1, $2, 'asha.k', 'LINK', 'sent')`, [tenant, `c-${tenant}`]);
  await q(`INSERT INTO reels (tenant_id, ig_media_id, slug, caption, thumbnail_url, permalink) VALUES ($1, $2, 'brunch', 'Brunch caption', 'https://cdn.invalid/t.jpg', 'https://instagram.com/reel/x')`, [tenant, `media-${tenant}`]);
  const [automation] = await q(`INSERT INTO automations (tenant_id, name, slug, state, trigger_type) VALUES ($1, 'Brunch', 'brunch', 'live', 'comment') RETURNING id`, [tenant]);
  await q(`INSERT INTO automation_triggers (tenant_id, automation_id, channel, target_type, media_id, caption, thumbnail_url) VALUES ($1, $2, 'instagram', 'reel', $3, 'Brunch caption', 'https://cdn.invalid/t.jpg')`, [tenant, automation.id, `media-${tenant}`]);
  await q(`INSERT INTO cap_claims (tenant_id, channel, cap, subject_hash, scope_key) VALUES ($1, 'instagram', 'cap.per_comment', 'subject-1', 'c-1')`, [tenant]);
  await q(`INSERT INTO opt_outs (tenant_id, channel, subject_hash, source) VALUES ($1, 'instagram', 'subject-2', 'dm')`, [tenant]);
  await q(`INSERT INTO account_rate_state (tenant_id, channel, account_id, usage_percent) VALUES ($1, 'instagram', $2, 10)`, [tenant, igUserId]);
  const job = await addJob(slice, tenant, igUserId);
  return { automation: automation.id, job, media: `media-${tenant}` };
}

const count = async ({ q }, table, tenant) => (await q(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [tenant]))[0].n;
const INSTAGRAM_DATA = ['inbox_threads', 'inbox_messages', 'needs_human_items', 'inbound_events', 'activity', 'outbound_jobs', 'cap_claims', 'automation_triggers', 'account_rate_state', 'ig_accounts'];
const deletionClosed = (slice) => until(async () => (await slice.q('SELECT status FROM data_deletion_requests'))[0]?.status === 'completed');

test('C-06: a valid deauthorize deletes the token, holds jobs and alerts owner and ops', async (t) => {
  const slice = await startSlice(t);
  const { business, seeded } = await connected(slice);
  const job = await addJob(slice, business.tenant.id, IG_A);

  const result = await slice.sim.post('/deauthorize', { igUserId: IG_A });
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const row = await accountRow(slice, IG_A);
  assert.deepEqual([row.status, row.access_token_enc, row.status_reason], ['deauthorized', '', 'token.deauthorized']);
  assert.deepEqual([...row.granted_scopes, ...row.subscribed_fields], []);
  assert.equal(await business.repos.igAccounts.current(), null);
  assert.equal((await business.repos.igAccounts.get(IG_A)).token, '');
  assert.deepEqual(await jobStatus(slice, job), { status: 'held', reason: 'paused.reconnect' });

  const alerts = await alertsFor(slice, business.tenant.id);
  assert.deepEqual(alerts.map((a) => [a.kind, a.audience, a.severity]), [['token.deauthorized', 'owner', 'critical'], ['token.deauthorized', 'ops', 'critical']]);
  assert.equal(JSON.stringify(alerts).includes(seeded.username), false);
  assert.ok((await decisions(slice, business.tenant.id)).some((d) => d.decision === 'token.deauthorized'));
  assert.ok((await auditFor(slice, business.tenant.id)).some((a) => a.action === 'instagram.token.deauthorized'));

  const view = (await business.api('GET', '/instagram/connection')).body;
  assert.deepEqual([view.status, view.health, view.webhooksSubscribed], ['deauthorized', 'red', false]);
});

test('C-07: a deauthorize with a bad or missing signature is a 400 and changes nothing', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const before = await accountRow(slice, IG_A);

  assert.equal((await post(slice, '/meta/deauthorize', signed({ user_id: IG_A }, 'not-the-secret'))).status, 400);
  assert.equal((await post(slice, '/meta/deauthorize', undefined)).status, 400);
  assert.equal((await post(slice, '/meta/deauthorize', 'garbage')).status, 400);
  assert.equal((await slice.sim.post('/deauthorize', { igUserId: IG_A, signature: 'bad' })).status, 400);
  assert.deepEqual(await accountRow(slice, IG_A), before);
  assert.deepEqual(await alertsFor(slice, business.tenant.id), []);
});

test('a signed payload missing the user or using another algorithm is refused', async (t) => {
  const slice = await startSlice(t);
  await connected(slice);
  const before = await accountRow(slice, IG_A);
  assert.equal((await post(slice, '/meta/deauthorize', signed({}))).status, 400);
  assert.equal((await post(slice, '/meta/deauthorize', signedRequest({ algorithm: 'none', user_id: IG_A }, APP_SECRET))).status, 400);
  assert.deepEqual(await accountRow(slice, IG_A), before);
});

test('Meta can name the account by its app-scoped id as well', async (t) => {
  const slice = await startSlice(t);
  const { seeded } = await connected(slice);
  const result = await slice.sim.post('/deauthorize', { igUserId: IG_A, userId: seeded.appScopedId });
  assert.equal(result.status, 200);
  assert.equal((await accountRow(slice, IG_A)).status, 'deauthorized');
});

test('a repeat deauthorize does nothing more, and an unknown account is just acknowledged', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/deauthorize', { igUserId: IG_A });
  assert.equal((await post(slice, '/meta/deauthorize', signed({ user_id: IG_A }))).status, 200);
  assert.equal((await alertsFor(slice, business.tenant.id)).length, 2);
  assert.equal((await post(slice, '/meta/deauthorize', signed({ user_id: 'nobody' }))).status, 200);
});

test('one account removing the app does not touch another business', async (t) => {
  const slice = await startSlice(t);
  await connected(slice, IG_A);
  const other = await connected(slice, IG_B);
  const job = await addJob(slice, other.business.tenant.id, IG_B);
  await slice.sim.post('/deauthorize', { igUserId: IG_A });

  assert.equal((await accountRow(slice, IG_B)).status, 'active');
  assert.ok((await other.business.repos.igAccounts.current()).token);
  assert.deepEqual(await jobStatus(slice, job), { status: 'queued', reason: '' });
  assert.deepEqual(await alertsFor(slice, other.business.tenant.id), []);
});

test('C-08: after a deauthorize and a reconnect, held jobs still in time send and the rest stay out', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const inTime = await addJob(slice, business.tenant.id, IG_A);
  const tooLate = await addJob(slice, business.tenant.id, IG_A, { expiresIn: "interval '-1 hour'" });
  const pausedOtherwise = await addJob(slice, business.tenant.id, IG_A, { status: 'held', reason: 'paused.tenant' });

  await slice.sim.post('/deauthorize', { igUserId: IG_A });
  assert.deepEqual(await jobStatus(slice, inTime), { status: 'held', reason: 'paused.reconnect' });

  await slice.q(`UPDATE ig_accounts SET status_changed_at = now() - interval '2 hours' WHERE ig_user_id = $1`, [IG_A]);
  const before = await accountRow(slice, IG_A);
  const { outcome } = await consent(slice, business, { igUserId: IG_A });
  assert.equal(outcome, 'connected');

  const row = await accountRow(slice, IG_A);
  assert.equal(row.status, 'active');
  assert.equal(row.token_version, before.token_version + 1);
  assert.deepEqual(await jobStatus(slice, inTime), { status: 'queued', reason: '' });
  assert.deepEqual(await jobStatus(slice, tooLate), { status: 'held', reason: 'paused.reconnect' }, 'past its time, it waits for the expiry sweep');
  assert.deepEqual(await jobStatus(slice, pausedOtherwise), { status: 'held', reason: 'paused.tenant' }, 'a job held for another reason is left alone');
  assert.ok(row.subscribed_at, 'the reconnect subscribes again');
});

test('C-49: a valid deletion request answers with a url and code, and the token is gone by then', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const data = await seedPlatformData(slice, business, IG_A);

  const result = await slice.sim.post('/deletion', { igUserId: IG_A });
  assert.deepEqual([result.status, result.valid], [200, true]);
  assert.match(result.body.confirmation_code, /^[a-f0-9]{32}$/);
  assert.equal(result.body.url, `https://connect.bhava.test/meta/deletion/${result.body.confirmation_code}`);
  assert.equal(await business.repos.igAccounts.current(), null);
  assert.equal((await slice.q('SELECT state FROM automations WHERE id = $1', [data.automation]))[0].state, 'paused');
  await deletionClosed(slice);
});

test('deletion really removes the account\'s data, keeps only what must stay, and logs both halves', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  const data = await seedPlatformData(slice, business, IG_A);
  const tenant = business.tenant.id;

  await slice.sim.post('/deletion', { igUserId: IG_A });
  await deletionClosed(slice);

  for (const table of INSTAGRAM_DATA) assert.equal(await count(slice, table, tenant), 0, `${table} still holds rows`);
  const [reel] = await slice.q('SELECT caption, thumbnail_url, permalink, active FROM reels WHERE ig_media_id = $1', [data.media]);
  assert.deepEqual(reel, { caption: '', thumbnail_url: '', permalink: '', active: false });
  assert.equal(await count(slice, 'opt_outs', tenant), 1, 'the opt-out list outlives this');

  const log = await decisions(slice, tenant);
  assert.ok(log.some((d) => d.decision === 'deletion.requested'));
  assert.ok(log.some((d) => d.decision === 'deletion.completed'));
  assert.equal(JSON.stringify(log).includes('asha.k'), false);
  assert.equal((await business.api('GET', '/instagram/connection')).body.status, 'not_connected');
});

test('deletion stays inside the one business', async (t) => {
  const slice = await startSlice(t);
  const one = await connected(slice, IG_A);
  const two = await connected(slice, IG_B);
  await seedPlatformData(slice, one.business, IG_A);
  await seedPlatformData(slice, two.business, IG_B);
  await slice.sim.post('/deletion', { igUserId: IG_A });
  await deletionClosed(slice);

  for (const table of INSTAGRAM_DATA) assert.ok((await count(slice, table, two.business.tenant.id)) > 0, `${table} lost another business's rows`);
  assert.ok((await two.business.repos.igAccounts.current()).token);
});

test('C-50: a deletion with a bad signature is a 400 and deletes nothing', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await seedPlatformData(slice, business, IG_A);
  const before = await accountRow(slice, IG_A);

  const result = await slice.sim.post('/deletion', { igUserId: IG_A, signature: 'bad' });
  assert.deepEqual([result.status, result.valid], [400, false]);
  assert.equal((await post(slice, '/meta/deletion', undefined)).status, 400);
  assert.deepEqual(await accountRow(slice, IG_A), before);
  assert.deepEqual(await slice.q('SELECT * FROM data_deletion_requests'), []);
  for (const table of INSTAGRAM_DATA) assert.ok((await count(slice, table, business.tenant.id)) > 0);
});

test('a deletion for an account nobody has is acknowledged with a code, and closed', async (t) => {
  const slice = await startSlice(t);
  const res = await post(slice, '/meta/deletion', signed({ user_id: 'stranger-1' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const [row] = await until(async () => {
    const rows = await slice.q('SELECT * FROM data_deletion_requests WHERE status = $1', ['completed']);
    return rows.length ? rows : null;
  });
  assert.deepEqual([row.tenant_id, row.account_id, row.confirmation_code], [null, 'stranger-1', body.confirmation_code]);
});

test('the status page says how a request is going, and tells a stranger nothing', async (t) => {
  const slice = await startSlice(t);
  const { business, seeded } = await connected(slice);
  const { body } = await slice.sim.post('/deletion', { igUserId: IG_A });
  await deletionClosed(slice);
  const path = new URL(body.url).pathname;

  const json = await fetch(`${slice.app.base}${path}`);
  assert.equal(json.status, 200);
  const status = await json.json();
  assert.equal(status.status, 'completed');
  assert.ok(status.requestedAt && status.completedAt);
  assert.deepEqual(Object.keys(status).sort(), ['completedAt', 'requestedAt', 'status']);

  const page = await fetch(`${slice.app.base}${path}`, { headers: { accept: 'text/html' } });
  const html = await page.text();
  assert.match(page.headers.get('content-type'), /html/);
  assert.match(html, /has been deleted/);
  assert.equal(html.includes(seeded.username), false);
  assert.equal(html.includes(IG_A), false);
  assert.equal(html.includes(business.name), false);

  assert.equal((await fetch(`${slice.app.base}/meta/deletion/${'0'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${slice.app.base}/meta/deletion/not-a-code`)).status, 404);
});

test('the sweep finishes a deletion the web process did not get to', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await seedPlatformData(slice, business, IG_A);
  await business.repos.igAccounts.stopForDeletion(IG_A);
  await slice.q('INSERT INTO data_deletion_requests (confirmation_code, tenant_id, account_id) VALUES ($1, $2, $3)', ['a'.repeat(32), business.tenant.id, IG_A]);

  await slice.sweep();
  assert.equal((await slice.q('SELECT status FROM data_deletion_requests'))[0].status, 'completed');
  assert.equal(await count(slice, 'inbox_messages', business.tenant.id), 0);
  assert.equal(await count(slice, 'ig_accounts', business.tenant.id), 0);
});

test('if the seller reconnected before the sweep ran, the new connection is kept and the old data still goes', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await seedPlatformData(slice, business, IG_A);
  await slice.q('INSERT INTO data_deletion_requests (confirmation_code, tenant_id, account_id) VALUES ($1, $2, $3)', ['b'.repeat(32), business.tenant.id, IG_A]);

  await slice.sweep();
  assert.equal(await count(slice, 'inbox_threads', business.tenant.id), 0);
  assert.ok((await business.repos.igAccounts.current()).token, 'the live token was not deleted');
});

test('after deletion the seller can connect again from nothing', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await slice.sim.post('/deletion', { igUserId: IG_A });
  await deletionClosed(slice);
  assert.equal((await consent(slice, business, { igUserId: IG_A })).outcome, 'connected');
  assert.equal((await accountRow(slice, IG_A)).token_version, 1);
});

test('retention removes old messages and raw events, and keeps new ones', async (t) => {
  const slice = await startSlice(t);
  const { business } = await connected(slice);
  await seedPlatformData(slice, business, IG_A);
  const tenant = business.tenant.id;
  const rows = (table) => count(slice, table, tenant);
  const fresh = [await rows('inbox_threads'), await rows('inbox_messages')];

  await slice.maintain();
  assert.deepEqual([await rows('inbox_threads'), await rows('inbox_messages')], fresh, 'fresh data stays');

  await slice.q(`UPDATE inbox_messages SET created_at = now() - interval '31 days'`);
  await slice.q(`UPDATE inbox_threads SET last_message_at = now() - interval '31 days'`);
  await slice.q(`UPDATE needs_human_items SET created_at = now() - interval '31 days'`);
  await slice.q(`UPDATE inbound_events SET received_at = now() - interval '8 days'`);
  await slice.q(`UPDATE activity SET created_at = now() - interval '31 days'`);
  await slice.maintain();
  for (const table of ['inbox_messages', 'inbox_threads', 'needs_human_items', 'inbound_events']) assert.equal(await rows(table), 0, table);
  assert.deepEqual(await slice.q('SELECT username, text FROM activity WHERE tenant_id = $1', [tenant]), [{ username: '', text: '' }]);
});

test('after a deauthorize Meta holds no subscription for the account', async (t) => {
  const slice = await startSlice(t);
  const business = await addBusiness(slice.app);
  await seedIg(slice.sim, IG_A);
  await consent(slice, business, { igUserId: IG_A });
  const { token } = await business.repos.igAccounts.get(IG_A);
  await slice.sim.post('/deauthorize', { igUserId: IG_A });
  const res = await subscribedOnMeta(slice.sim, IG_A, token);
  assert.deepEqual(res, []);
});
