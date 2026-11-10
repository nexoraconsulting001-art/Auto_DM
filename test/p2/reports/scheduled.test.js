// Scheduled reports (PRD 7.13, N-62): any saved view on a schedule, to the team by default, outside addresses by the owner only and in the audit
// log, a version per recipient's role, once per due moment, and nothing while the business is paused or closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileStore } from '../../../src/modules/reports/files.js';
import { DAY, istAt, openWorld, parseCsv } from './support.js';

const yesterday = () => new Date(Date.now() - DAY).toISOString().slice(0, 10);
const newView = (shop, definition = { metrics: ['sessions'], range: '7' }, visibility = 'team', who) => shop.json('/saved-views', { method: 'POST', body: { name: 'Weekly sessions', visibility, definition } }, 201, who);
const schedule = (shop, viewId, body = {}, who) => shop.json('/scheduled-reports', { method: 'POST', body: { viewId, frequency: 'weekly', hourOfDay: 9, weekday: 1, ...body } }, 201, who);
const due = (shop, id) => shop.sql(`UPDATE scheduled_reports SET next_run_at = now() - interval '1 second' WHERE tenant_id = $1 AND id = $2`, [shop.tenantId, id]);

test('N-62: a manager schedules a team view; it goes to the team, next on Monday 09:00 on the business\'s clock', async (t) => {
  const w = await openWorld(t, { at: istAt('2026-11-09', 9, 1) });
  const shop = await w.addShop();
  const manager = await shop.addUser('manager');
  const analyst = await shop.addUser('staff', ['analytics']);
  await shop.addUser('staff', ['orders']);
  const view = await newView(shop);
  const made = await schedule(shop, view.id, {}, manager.token);
  assert.equal(made.nextRunAt, new Date(istAt('2026-11-16', 9, 0)).toISOString());
  assert.equal(made.viewName, 'Weekly sessions');
  const team = made.recipients.map((r) => r.userId).sort((a, b) => a - b);
  const [owner] = await shop.sql(`SELECT id FROM users WHERE tenant_id = $1 AND role = 'owner'`, [shop.tenantId]);
  assert.deepEqual(team, [owner.id, manager.user.id, analyst.user.id].sort((a, b) => a - b), 'Everyone who reads analytics, and nobody else');
  assert.ok(made.recipients.every((r) => r.kind === 'team'));
  assert.equal((await shop.audit('scheduled_report.created')).length, 1);
  assert.equal((await shop.json('/scheduled-reports')).items[0].id, made.id);
  const changed = await shop.json(`/scheduled-reports/${made.id}`, { method: 'PATCH', body: { frequency: 'daily', hourOfDay: 18 } });
  assert.equal(changed.nextRunAt, new Date(istAt('2026-11-09', 18, 0)).toISOString());
  assert.deepEqual([changed.weekday, changed.dayOfMonth], [null, null]);
});

test('N-62: staff can\'t schedule, only the owner adds an outside address, the add and the removal are audited, and the address is checked', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const manager = await shop.addUser('manager');
  const analyst = await shop.addUser('staff', ['analytics']);
  const view = await newView(shop);
  assert.equal((await shop.call('/scheduled-reports', { method: 'POST', body: { viewId: view.id } }, analyst.token)).status, 403);
  const made = await schedule(shop, view.id, {}, manager.token);
  const refused = await shop.call(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'x@firm.example' } }, manager.token);
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'Owner only.');
  const added = await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'Accounts@Firm.example' } }, 201);
  assert.equal(added.kind, 'outside');
  const again = await shop.call(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'accounts@firm.example' } });
  assert.equal(again.status, 409, 'The same address in any letter case is one recipient');
  for (const email of ['a@b.example\r\nBcc: x@y.example', 'a b@firm.example', 'notanaddress', '@firm.example', 'a@b', `${'a'.repeat(250)}@firm.example`]) {
    assert.equal((await shop.call(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email } })).status, 400, JSON.stringify(email));
  }
  const [audit] = await shop.audit('scheduled_report.recipient_added');
  assert.equal(audit.target, `scheduled_report:${made.id}`);
  assert.equal(audit.details.email, 'Ac***@Firm.example', 'The address is masked in the log');
  assert.equal((await shop.call(`/scheduled-report-recipients/${added.id}`, { method: 'DELETE' }, manager.token)).status, 403);
  assert.equal((await shop.call(`/scheduled-report-recipients/${added.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await shop.audit('scheduled_report.recipient_removed')).length, 1);
  assert.equal((await shop.call(`/scheduled-report-recipients/${added.id}`, { method: 'DELETE' })).status, 404);
  const teammate = await shop.addUser('manager', [], { email: 'mira@team.example' });
  const asTeam = await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'MIRA@team.example' } }, 201);
  assert.deepEqual([asTeam.kind, asTeam.userId], ['team', teammate.user.id], 'A teammate\'s address makes them a team recipient');
  const packer = await shop.addUser('staff', ['orders'], { email: 'packer@team.example' });
  assert.equal((await shop.call(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'packer@team.example' } })).status, 400, `${packer.user.id} can't see analytics`);
});

test('N-62: hostile schedules are refused, another business\'s is not found, and tier 1 is told it needs tier 2', async (t) => {
  const w = await openWorld(t);
  const a = await w.addShop();
  const b = await w.addShop();
  const theirs = await schedule(b, (await newView(b)).id);
  assert.equal((await a.call(`/scheduled-reports/${theirs.id}`, { method: 'PATCH', body: { enabled: false } })).status, 404);
  assert.equal((await a.call(`/scheduled-reports/${theirs.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.call(`/scheduled-reports/${theirs.id}/recipients`, { method: 'POST', body: { email: 'a@firm.example' } })).status, 404);
  const theirRecipient = (await b.json(`/scheduled-reports/${theirs.id}/recipients`, { method: 'POST', body: { email: 'b@firm.example' } }, 201)).id;
  assert.equal((await a.call(`/scheduled-report-recipients/${theirRecipient}`, { method: 'DELETE' })).status, 404);
  assert.equal((await a.call('/scheduled-reports', { method: 'POST', body: { viewId: (await newView(b)).id } })).status, 404, 'Another business\'s view');
  assert.deepEqual((await a.json('/scheduled-reports')).items, []);
  const view = await newView(a);
  for (const body of [{ viewId: view.id, hourOfDay: 24 }, { viewId: view.id, hourOfDay: -1 }, { viewId: view.id, weekday: 7 }, { viewId: view.id, dayOfMonth: 29 }, { viewId: view.id, frequency: 'hourly' }, { viewId: view.id, format: 'exe' }]) {
    assert.equal((await a.call('/scheduled-reports', { method: 'POST', body })).status, 400, JSON.stringify(body));
  }
  const tier1 = await w.addShop({ plan: 't1' });
  const refused = await tier1.call('/scheduled-reports', { method: 'POST', body: { viewId: (await newView(tier1)).id } });
  assert.equal(refused.status, 403);
  assert.match(refused.json().error, /tier 2/);
  const privateView = await newView(a, undefined, 'private');
  const manager = await a.addUser('manager');
  assert.equal((await a.call('/scheduled-reports', { method: 'POST', body: { viewId: privateView.id } }, manager.token)).status, 404, 'Someone else\'s private view');
});

test('N-62: a due report goes once, as an attachment, each recipient getting what their role allows, and the next run is set', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  await shop.write('traffic_daily', [{ day: yesterday(), hour: 10, weekday: 1, source: 'bio_link', sessions: 30, orders: 2, revenue_paise: 123456 }]);
  const analyst = await shop.addUser('staff', ['analytics'], { email: 'ana@team.example' });
  const view = await newView(shop, { metrics: ['sessions', 'revenue_paise'], dimensions: ['source'], range: '7' });
  const made = await schedule(shop, view.id);
  await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'accounts@firm.example' } }, 201);
  await due(shop, made.id);
  await w.runJobs();
  await w.runJobs();
  const [run, ...more] = await shop.runs('scheduled');
  assert.equal(more.length, 0, 'One run');
  assert.equal(run.status, 'sent');
  const sent = await shop.deliveries('report_run_id = $2', [run.id]);
  assert.equal(sent.length, 3, 'The owner, the analyst and the accountant');
  const outside = sent.find((d) => d.to_address === 'accounts@firm.example');
  assert.ok(outside.attachment_key && /\.csv$/.test(outside.attachment_name));
  assert.match(`${outside.subject} ${outside.body}`, /Bhava/);
  const store = fileStore(w.drivers);
  const fileFor = async (d) => (await store.get(d.attachment_key)).toString('utf8');
  assert.match(await fileFor(outside), /123456/, 'The owner added the address, so it gets what the owner sees');
  const theirs = sent.find((d) => d.user_id === analyst.user.id);
  assert.equal(theirs.to_address, 'ana@team.example');
  const limited = await fileFor(theirs);
  assert.doesNotMatch(limited, /123456|revenue/i, 'Staff without orders get no revenue');
  assert.ok(parseCsv(limited.replace(/^﻿/, '')).flat().includes('30'));
  const [row] = await shop.sql('SELECT * FROM scheduled_reports WHERE id = $1', [made.id]);
  assert.ok(row.last_run_at);
  assert.ok(new Date(row.next_run_at) > new Date(), 'Scheduled again');
  const local = new Date(new Date(row.next_run_at).getTime() + 5.5 * 3_600_000);
  assert.deepEqual([local.getUTCDay(), local.getUTCHours(), local.getUTCMinutes()], [1, 9, 0]);
});

test('N-62: removed recipients, people who lost analytics and private views stop getting it', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const analyst = await shop.addUser('staff', ['analytics']);
  const manager = await shop.addUser('manager');
  const made = await schedule(shop, (await newView(shop)).id);
  const gone = await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'gone@firm.example' } }, 201);
  await shop.call(`/scheduled-report-recipients/${gone.id}`, { method: 'DELETE' });
  await shop.repos.users.setPermissions(analyst.user.id, ['orders']);
  const privately = await schedule(shop, (await newView(shop, undefined, 'private', manager.token)).id, {}, manager.token);
  assert.deepEqual(privately.recipients.map((r) => r.userId), [manager.user.id], 'A private view goes to the person who made it');
  await shop.sql(`INSERT INTO scheduled_report_recipients (tenant_id, scheduled_report_id, kind, user_id) VALUES ($1, $2, 'team', $3)`, [shop.tenantId, privately.id, analyst.user.id]);
  await due(shop, made.id);
  await due(shop, privately.id);
  await w.runJobs();
  const sent = await shop.deliveries();
  assert.deepEqual(await shop.deliveries('to_address = $2', ['gone@firm.example']), []);
  assert.equal(sent.some((d) => d.user_id === analyst.user.id), false);
  const toPrivate = sent.filter((d) => d.attachment_key.includes(`/scheduled/${privately.id}-`));
  assert.deepEqual(toPrivate.map((d) => d.user_id), [manager.user.id]);
});

test('N-62: one due report, two workers at once, is sent once', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const made = await schedule(shop, (await newView(shop)).id);
  await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'once@firm.example' } }, 201);
  await due(shop, made.id);
  const [row] = await shop.sql('SELECT next_run_at FROM scheduled_reports WHERE id = $1', [made.id]);
  const job = { payload: { id: made.id, dueAt: new Date(row.next_run_at).toISOString() }, attempt: 1 };
  const { reportServices } = await import('../../../src/modules/reports/services.js');
  await shop.inside(() => Promise.all([reportServices(w.jobCtx).scheduled.run(job), reportServices(w.jobCtx).scheduled.run(job)]));
  await w.runJobs();
  assert.equal((await shop.deliveries('to_address = $2', ['once@firm.example'])).length, 1);
});

test('7.13: scheduled reports stop while the business is paused or closed, and a run missed then is not sent late', async (t) => {
  const w = await openWorld(t);
  const shop = await w.addShop();
  const made = await schedule(shop, (await newView(shop)).id);
  await shop.json(`/scheduled-reports/${made.id}/recipients`, { method: 'POST', body: { email: 'paused@firm.example' } }, 201);
  for (const status of ['paused', 'closed', 'suspended']) {
    await shop.sql('UPDATE tenants SET status = $2 WHERE id = $1', [shop.tenantId, status]);
    await due(shop, made.id);
    await w.runJobs();
    assert.deepEqual(await shop.deliveries(), [], status);
  }
  await shop.sql(`UPDATE tenants SET status = 'active' WHERE id = $1`, [shop.tenantId]);
  await shop.sql(`UPDATE scheduled_reports SET next_run_at = now() - interval '3 days' WHERE id = $1`, [made.id]);
  await w.runJobs();
  assert.deepEqual(await shop.deliveries(), [], 'Three days late is not sent');
  const [row] = await shop.sql('SELECT next_run_at FROM scheduled_reports WHERE id = $1', [made.id]);
  assert.ok(new Date(row.next_run_at) > new Date(), 'It is set for its next time instead');
  await shop.json(`/scheduled-reports/${made.id}`, { method: 'PATCH', body: { enabled: false } });
  await due(shop, made.id);
  await w.runJobs();
  assert.deepEqual(await shop.deliveries(), [], 'A disabled schedule sends nothing');
});
