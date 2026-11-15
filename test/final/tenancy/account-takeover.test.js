// tenancy-1: when a business disconnects its Instagram account and another business connects the same account, the first
// business's inbox, send history and insights stay where they are. The account now sends for the second business only,
// the first is told (an alert and an audit row), and nothing about the second business reaches the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IG_A, addBusiness, addJob, alertsFor, auditFor, connected, consent, startSlice } from '../../p1/review-slice/support.js';

async function historyOf({ q }, tenantId, igUserId) {
  const count = async (sql) => Number((await q(sql, [tenantId, igUserId]))[0].n);
  return {
    jobs: await count('SELECT count(*) AS n FROM outbound_jobs WHERE tenant_id = $1 AND ig_user_id = $2'),
    threads: await count('SELECT count(*) AS n FROM inbox_threads WHERE tenant_id = $1 AND ig_user_id = $2'),
    messages: await count('SELECT count(*) AS n FROM inbox_messages m JOIN inbox_threads th ON th.tenant_id = m.tenant_id AND th.id = m.thread_id WHERE th.tenant_id = $1 AND th.ig_user_id = $2'),
    insights: await count(`SELECT count(*) AS n FROM analytics_accounts WHERE tenant_id = $1 AND channel = 'instagram' AND ig_user_id = $2`),
    account: await count('SELECT count(*) AS n FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2'),
  };
}

/** A second business on a paid plan: one Instagram account gives one Free plan only (signup rule), which is not what is tested here. */
async function paidBusiness(slice) {
  const business = await addBusiness(slice.app);
  await slice.q("UPDATE tenants SET plan = 't2' WHERE id = $1", [business.tenant.id]);
  return business;
}

async function buildHistory(slice, tenantId, igUserId) {
  await addJob(slice, tenantId, igUserId, { status: 'sent' });
  const [thread] = await slice.q(
    `INSERT INTO inbox_threads (tenant_id, channel, ig_user_id, subject_hash, recipient_id, last_message, last_message_at)
     VALUES ($1, 'instagram', $2, 'subject-1', 'igsid-1', 'hello', now()) RETURNING id`,
    [tenantId, igUserId],
  );
  await slice.q(`INSERT INTO inbox_messages (tenant_id, thread_id, direction, author, text) VALUES ($1, $2, 'in', 'person', 'hello')`, [tenantId, thread.id]);
  await slice.q(`INSERT INTO analytics_accounts (tenant_id, channel, ig_user_id, collecting_since) VALUES ($1, 'instagram', $2, current_date)`, [tenantId, igUserId]);
}

test('tenancy-1: another business connecting an Instagram account this business disconnected leaves this business\'s history in place', async (t) => {
  const slice = await startSlice(t);
  const first = await connected(slice, IG_A);
  const a = first.business;
  await buildHistory(slice, a.tenant.id, IG_A);
  const before = await historyOf(slice, a.tenant.id, IG_A);
  assert.deepEqual(before, { jobs: 1, threads: 1, messages: 1, insights: 1, account: 1 });
  assert.equal((await a.api('DELETE', '/instagram/connection')).status, 204);

  const b = await paidBusiness(slice);
  assert.equal((await consent(slice, b, { igUserId: IG_A })).outcome, 'connected');

  assert.deepEqual(await historyOf(slice, a.tenant.id, IG_A), before, 'the first business keeps its inbox, send history and insights');
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, b.tenant.id, 'webhooks for the account go to the business that holds it now');
  assert.equal((await b.repos.igAccounts.current()).igUserId, IG_A);
  assert.equal(await a.repos.igAccounts.current(), null, 'nothing sends for the first business');
  const [aRow] = await slice.q('SELECT access_token_enc FROM ig_accounts WHERE tenant_id = $1 AND ig_user_id = $2', [a.tenant.id, IG_A]);
  assert.equal(aRow.access_token_enc, '');

  const alerts = (await alertsFor(slice, a.tenant.id)).filter((x) => x.kind === 'instagram.connected_elsewhere');
  assert.equal(alerts.length, 1, 'the first business is told');
  const audit = (await auditFor(slice, a.tenant.id)).filter((x) => x.action === 'instagram.connected_elsewhere');
  assert.equal(audit.length, 1, 'and it is in its audit log');
  const told = JSON.stringify({ alerts, audit });
  assert.doesNotMatch(told, new RegExp(`${b.name}|\\b${b.tenant.id}\\b|${b.phone}`), 'nothing about the other business is in what the first business sees');
  const inbox = await b.api('GET', '/inbox/threads');
  assert.ok(inbox.status !== 200 || inbox.body.items.length === 0, 'the second business sees none of the first business\'s inbox');

  // The first business cannot take it back while the second holds it, and its history is still untouched.
  assert.equal((await consent(slice, a, { igUserId: IG_A })).outcome, 'taken');
  assert.deepEqual(await historyOf(slice, a.tenant.id, IG_A), before);
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, b.tenant.id);
});

test('tenancy-1: when the second business lets the account go too, the first can connect it again and finds its history', async (t) => {
  const slice = await startSlice(t);
  const { business: a } = await connected(slice, IG_A);
  await buildHistory(slice, a.tenant.id, IG_A);
  const before = await historyOf(slice, a.tenant.id, IG_A);
  assert.equal((await a.api('DELETE', '/instagram/connection')).status, 204);
  const b = await paidBusiness(slice);
  assert.equal((await consent(slice, b, { igUserId: IG_A })).outcome, 'connected');
  assert.equal((await b.api('DELETE', '/instagram/connection')).status, 204);

  assert.equal((await consent(slice, a, { igUserId: IG_A })).outcome, 'connected');
  assert.deepEqual(await historyOf(slice, a.tenant.id, IG_A), before);
  assert.equal((await slice.app.platform.tenants.getByIgAccount(IG_A)).id, a.tenant.id);
  assert.equal((await a.repos.igAccounts.current()).igUserId, IG_A);
  assert.equal((await alertsFor(slice, b.tenant.id)).filter((x) => x.kind === 'instagram.connected_elsewhere').length, 1, 'the second business is told in turn');
});
