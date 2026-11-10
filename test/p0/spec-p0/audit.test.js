// PRD 2 (data access) and 5.14: the audit log, what owners may see of it, and who may export raw events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeList } from '../../../src/contracts/api/index.js';
import { createPlatform } from '../../../src/platform/index.js';
import { housekeeping } from '../../../src/worker.js';
import { CONSOLE_HOST, addBusiness, api, asAppRole, consoleUser, findAppRole, hit, need, onConsole, signIn, startWorld } from './support.js';
import { consolePaths, rawExportsTable, razorpayKeys, sellerPaths } from './surfaces.js';

const auditRows = (app, tenantId) => app.db.query('SELECT * FROM audit_log WHERE tenant_id = $1 ORDER BY id', [tenantId]);

async function storeWithEvents(t, options) {
  const app = await startWorld(t, options);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  await app.db.query(`INSERT INTO compliance_events (tenant_id, kind, decision, reason) VALUES ($1, 'dm', 'allow', ''), ($1, 'dm', 'deny', 'cap.user'), ($2, 'dm', 'allow', '')`, [a.tenant.id, b.tenant.id]);
  return { app, a, b };
}

test('F-60: a changed Razorpay key appears in the audit row only as rzp_...1234', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  const token = await signIn(app, shop);
  const keyId = 'rzp_test_Xk9Lm2Pq1234'; // secret-scan:allow (made up)
  const keySecret = 'gatewaySecretValue9876'; // secret-scan:allow (made up)
  need(await api(app, shop, token, '/settings/payment', { method: 'PATCH', body: razorpayKeys(keyId, keySecret) }), 200, 'Save the Razorpay keys');

  const rows = await auditRows(app, shop.tenant.id);
  const row = rows.find((r) => /key|razorpay|gateway/i.test(`${r.action} ${r.target}`));
  assert.ok(row, `No audit row for the key change. Actions: ${rows.map((r) => r.action).join(', ')}`);
  const text = JSON.stringify(row);
  assert.match(text, /rzp_\.\.\.1234/);
  assert.doesNotMatch(text, /Xk9Lm2Pq/);
  assert.doesNotMatch(text, /gatewaySecretValue/);
});

test('F-61: DELETE FROM audit_log is denied, for the app\'s own connection and the app role', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  await app.db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'spec', 'login')`, [shop.tenant.id]);

  await assert.rejects(() => app.db.query('DELETE FROM audit_log'), /denied|retention|insert-only/i);
  const role = await findAppRole(app.db);
  assert.ok(role, 'No app role exists');
  await assert.rejects(
    () => asAppRole(app.db, role, shop.tenant.id, (q) => q.query('DELETE FROM audit_log')),
    /denied|retention|insert-only/i,
  );
  assert.equal((await auditRows(app, shop.tenant.id)).length, 1, 'the row is still there');
});

test('F-61: audit rows cannot be edited', async (t) => {
  const app = await startWorld(t);
  const shop = await addBusiness(app, { slug: 'kesar-home', name: 'Kesar Home' });
  await app.db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'spec', 'login')`, [shop.tenant.id]);
  await assert.rejects(() => app.db.query(`UPDATE audit_log SET actor = 'someone else'`), /insert-only|denied/i);
});

test('F-62: a kill switch across 40 businesses writes 1 audit row and 40 compliance rows', async (t) => {
  const app = await startWorld(t);
  for (let i = 1; i <= 39; i++) await app.platform.tenants.create({ slug: `shop-${i}`, name: `Shop ${i}` });
  const [{ n }] = await app.db.query(`SELECT count(*)::int AS n FROM tenants WHERE status = 'active'`);
  assert.equal(n, 40, 'the default business plus 39');
  const operator = await consoleUser(app);
  const reason = 'Meta policy notice, ticket 77';

  need(await onConsole(app, operator, consolePaths.killSwitch, { method: 'POST', body: { scope: 'global', reason } }), [200, 201], 'Engage the kill switch');
  const audits = await app.db.query(`SELECT * FROM audit_log WHERE action ILIKE '%kill%'`);
  assert.equal(audits.length, 1);
  assert.match(JSON.stringify(audits[0]), new RegExp(reason));
  assert.match(audits[0].actor, new RegExp(operator.email));
  const compliance = await app.db.query(`SELECT tenant_id FROM compliance_events WHERE kind ILIKE '%kill%' OR reason = 'paused.global'`);
  assert.equal(compliance.length, 40);
  assert.equal(new Set(compliance.map((r) => r.tenant_id)).size, 40, 'one per business');
});

test('F-63: the owner of A opening the log sees only A\'s rows', async (t) => {
  const { app, a, b } = await storeWithEvents(t);
  await app.db.query(
    `INSERT INTO audit_log (tenant_id, actor, action, target) VALUES ($1, 'owner-a', 'brand.update', 'alpha-row'), ($2, 'owner-b', 'brand.update', 'beta-row'), (NULL, 'operator', 'plan.change', 'platform-row')`,
    [a.tenant.id, b.tenant.id],
  );
  const res = need(await api(app, a, await signIn(app, a), sellerPaths.auditLog), 200, 'The owner opens the audit log');
  assert.match(res.text, /alpha-row/);
  assert.doesNotMatch(res.text, /beta-row/);
  assert.doesNotMatch(res.text, /platform-row/);
  assert.ok(res.json().items.length >= 1);
});

const RAW_OR_EVENT_EXPORT = /raw|event[-_ ]?log|audit.*export|export.*(?:audit|compliance|events)/i;

function assertNoRawExportRoute() {
  const offered = routeList.filter((r) => RAW_OR_EVENT_EXPORT.test(`${r.id} ${r.path}`));
  assert.deepEqual(offered.map((r) => r.id), [], 'the seller API offers a raw event export');
}

const RAW_EXPORT_GUESSES = ['/raw-export', '/events/export', '/events', '/audit-log/export', '/compliance/export', '/export/raw', '/exports/raw', '/activity/export'];

async function assertOwnerCannotFetchRawEvents(t) {
  const { app, a } = await storeWithEvents(t);
  const token = await signIn(app, a);
  for (const guess of RAW_EXPORT_GUESSES) {
    for (const method of ['GET', 'POST']) {
      const res = await api(app, a, token, guess, { method, ...(method === 'POST' ? { body: { reason: 'please' } } : {}) });
      assert.ok([403, 404].includes(res.status), `${method} /api/v1${guess} answered ${res.status}`);
      assert.doesNotMatch(res.text, /cap\.user/, `${method} /api/v1${guess} returned raw event rows`);
    }
    const page = await hit(app, guess, { host: a.host, token });
    assert.doesNotMatch(page.text, /cap\.user/, `GET ${guess} returned raw event rows`);
  }
}

/** A route for a summary export: named for export or report, read-only, and not a raw one. */
const summaryExports = () => routeList.filter((r) => r.method === 'GET' && /export|report/i.test(`${r.id} ${r.path}`) && !RAW_OR_EVENT_EXPORT.test(`${r.id} ${r.path}`));

async function assertSummaryExportAvailable(t) {
  const { app, a } = await storeWithEvents(t);
  const exports = summaryExports();
  assert.ok(exports.length > 0, 'The seller API has no summary export route');
  const res = need(await api(app, a, await signIn(app, a), exports[0].path), 200, 'Download a summary export');
  assert.doesNotMatch(res.text, /cap\.user/, 'the summary holds no raw event rows');
}

test('U-10: an owner finds no raw event log export anywhere in the seller API', async (t) => {
  assertNoRawExportRoute();
  await assertOwnerCannotFetchRawEvents(t);
});

test('U-10: an owner still has the dashboard and reel-level figures', async (t) => {
  const { app, a } = await storeWithEvents(t);
  const token = await signIn(app, a);
  need(await api(app, a, token, '/stats/dashboard'), 200, 'Dashboard');
  need(await api(app, a, token, '/reels'), 200, 'Reel-level report');
});

test('U-10: a summary export is available instead', assertSummaryExportAvailable);

test('F-119: the owner of A is offered no raw event log download', async (t) => {
  assertNoRawExportRoute();
  await assertOwnerCannotFetchRawEvents(t);
});

test('F-119: a summary export is available (PRD 7.9)', assertSummaryExportAvailable);

function exportBody(tenantId, extra = {}) {
  return { tables: ['compliance_events'], tenantIds: [tenantId], from: '2026-01-01', to: '2027-01-01', ...extra };
}

test('U-11: a super admin\'s raw export needs a reason and logs who, when, why and what', async (t) => {
  const { app, a } = await storeWithEvents(t);
  const operator = await consoleUser(app);
  const started = new Date(Date.now() - 2000);

  const noReason = await onConsole(app, operator, consolePaths.rawExport, { method: 'POST', body: exportBody(a.tenant.id) });
  assert.equal(noReason.status, 400);
  assert.deepEqual(await app.db.query(`SELECT 1 FROM audit_log WHERE action ILIKE '%export%'`), [], 'a refused export writes no row');

  const why = 'DPDP request 4411';
  need(await onConsole(app, operator, consolePaths.rawExport, { method: 'POST', body: exportBody(a.tenant.id, { reason: why }) }), [200, 201], 'Raw export with a reason');
  const [row] = await app.db.query(`SELECT * FROM audit_log WHERE action ILIKE '%export%'`);
  assert.ok(row, 'The export wrote no audit row');
  assert.match(row.actor, new RegExp(operator.email), 'who');
  assert.ok(new Date(row.created_at) >= started, 'when');
  const what = JSON.stringify(row.details);
  assert.match(what, new RegExp(why), 'why');
  assert.match(what, /compliance_events/, 'which tables');
  assert.match(what, new RegExp(`\\b${a.tenant.id}\\b`), 'which business');
  assert.match(what, /2026-01-01/, 'which dates');
  assert.match(what, /"rowCount":\s*2/, 'how many rows');
});

test('U-11: the raw export works only in the Platform Console and only for a super admin', async (t) => {
  const { app, a } = await storeWithEvents(t);
  const body = exportBody(a.tenant.id, { reason: 'any' });
  const admin = await consoleUser(app, 'super_admin');
  need(await onConsole(app, admin, consolePaths.rawExport, { method: 'POST', body }), [200, 201], 'Positive control: a super admin');

  const support = await consoleUser(app, 'support');
  assert.equal((await onConsole(app, support, consolePaths.rawExport, { method: 'POST', body })).status, 403, 'support role');

  assert.equal((await hit(app, consolePaths.rawExport, { host: CONSOLE_HOST, method: 'POST', body })).status, 401, 'signed out');
  const onShop = await hit(app, consolePaths.rawExport, { host: a.host, method: 'POST', cookie: admin.cookie, body });
  assert.equal(onShop.status, 404, 'the export does not exist on a business address');
});

test('F-120: a raw export for one business is audited and holds only that business\'s rows', async (t) => {
  const { app, a, b } = await storeWithEvents(t);
  const operator = await consoleUser(app);
  const res = need(await onConsole(app, operator, consolePaths.rawExport, { method: 'POST', body: exportBody(a.tenant.id, { reason: 'Audit 12' }) }), [200, 201], 'Raw export').json();
  assert.equal(res.rowCount, 2, 'only A has two compliance rows');
  assert.equal((await app.db.query(`SELECT * FROM audit_log WHERE action ILIKE '%export%'`)).length, 1);
  assert.ok(b.tenant.id);
});

test('F-120: the export file expires after 7 days and the audit row stays', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-export-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const { app, a } = await storeWithEvents(t, { overrides: { storageDriver: 'local', storageDir } });
  const operator = await consoleUser(app);
  const before = Date.now();
  const res = need(await onConsole(app, operator, consolePaths.rawExport, { method: 'POST', body: exportBody(a.tenant.id, { reason: 'Audit 13' }) }), [200, 201], 'Raw export').json();

  const days = (new Date(res.expiresAt).getTime() - before) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1, `The file expires after ${days} days`);
  const files = () => fs.readdirSync(storageDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  assert.ok(files().length > 0, 'the export file exists');

  await app.db.query(`UPDATE ${rawExportsTable} SET expires_at = now() - interval '1 hour'`);
  const drivers = createPlatform({ storageDriver: 'local', storageDir, queueDriver: 'pg', analyticsDriver: 'pg', cacheDriver: 'memory' }, { db: app.db });
  await housekeeping({ db: app.db, queue: drivers.queue, storage: drivers.storage });
  assert.deepEqual(files(), [], 'the file is gone');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action ILIKE '%export%'`)).length, 1, 'the audit row stays');
});
