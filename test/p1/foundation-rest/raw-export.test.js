// PRD 2 and 5.14: the raw event export, beyond the scenarios in test/p0/spec-p0/audit.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../../../src/platform/storage.js';
import { platformConsole } from '../../../src/modules/platform-console/index.js';
import { createRawExport, sweepRawExports } from '../../../src/modules/platform-console/raw-export.js';
import { addBusiness, consoleUser, need, onConsole, startWorld } from '../../p0/spec-p0/support.js';

const RANGE = { from: '2026-01-01', to: '2027-01-01' };

async function world(t) {
  const app = await startWorld(t);
  const a = await addBusiness(app, { slug: 'alpha-store', name: 'Alpha Store' });
  const b = await addBusiness(app, { slug: 'beta-store', name: 'Beta Store' });
  await app.db.query(
    `INSERT INTO compliance_events (tenant_id, kind, decision, reason, created_at) VALUES ($1, 'dm', 'allow', 'in', '2026-03-01'), ($1, 'dm', 'deny', 'too-old', '2025-03-01'), ($1, 'dm', 'allow', 'last-day', '2026-12-31 23:00'), ($2, 'dm', 'allow', 'other', '2026-03-01')`,
    [a.tenant.id, b.tenant.id],
  );
  const storage = createStorage({ storageDriver: 'memory' });
  const stored = [];
  const spied = { ...storage, put: async (key, ...rest) => { stored.push(key); return storage.put(key, ...rest); }, get: storage.get, remove: storage.remove };
  return { app, a, b, storage: spied, stored, deps: { db: app.db, storage: spied } };
}

const body = (tenantId, extra = {}) => ({ reason: 'Audit 1', tables: ['compliance_events'], tenantIds: [tenantId], ...RANGE, ...extra });

test('the file holds only the businesses and dates asked for, the end date included', async (t) => {
  const { a, stored, storage, deps } = await world(t);
  const result = await createRawExport(deps, body(a.tenant.id, { from: '2026-01-01', to: '2026-12-31' }), 'platform:x@team.example');
  assert.equal(result.rowCount, 2);
  const lines = (await storage.get(stored[0])).toString().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.reason), ['in', 'last-day']);
  assert.ok(lines.every((l) => l.table === 'compliance_events' && l.tenant_id === a.tenant.id));
});

test('several tables and businesses go in one export with one audit row', async (t) => {
  const { app, a, b, deps } = await world(t);
  await app.db.query(`INSERT INTO events (tenant_id, name, at) VALUES ($1, 'view', '2026-05-05')`, [b.tenant.id]);
  const before = (await app.db.query(`SELECT count(*)::int AS n FROM audit_log`))[0].n;
  const { rowCount } = await createRawExport(deps, body(a.tenant.id, { tables: ['compliance_events', 'events'], tenantIds: [a.tenant.id, b.tenant.id] }), 'platform:x@team.example');
  assert.equal(rowCount, 4);
  const rows = await app.db.query(`SELECT tenant_id, details FROM audit_log WHERE action = 'raw_export.create'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, null, 'about several businesses, so about no single one');
  assert.equal((await app.db.query(`SELECT count(*)::int AS n FROM audit_log`))[0].n, before + 1);
});

test('dates the wrong way round, an unknown table and a bad date are refused through the console', async (t) => {
  const { app, a } = await world(t);
  const operator = await consoleUser(app);
  const post = (payload) => onConsole(app, operator, '/raw-export', { method: 'POST', body: payload });
  assert.equal((await post(body(a.tenant.id, { from: '2027-01-01', to: '2026-01-01' }))).status, 400);
  assert.equal((await post(body(a.tenant.id, { tables: ['users'] }))).status, 400);
  assert.equal((await post(body(a.tenant.id, { tables: ['compliance_events; DROP TABLE users'] }))).status, 400);
  assert.equal((await post(body(a.tenant.id, { from: 'yesterday' }))).status, 400);
  assert.equal((await post(body(a.tenant.id, { tenantIds: [] }))).status, 400);
  assert.deepEqual(await app.db.query(`SELECT 1 FROM audit_log WHERE action LIKE 'raw_export%'`), []);
  need(await post(body(a.tenant.id)), 201, 'Positive control');
});

test('if the record can\'t be written, the file doesn\'t stay behind', async (t) => {
  const { a, app, storage, stored } = await world(t);
  const failing = { query: app.db.query, platform: { query: app.db.platform.query, tx: async () => { throw new Error('database gone'); } } };
  await assert.rejects(() => createRawExport({ db: failing, storage }, body(a.tenant.id), 'platform:x@team.example'), /database gone/);
  assert.equal(await storage.get(stored[0]), null);
});

test('the sweep deletes expired files only, and the records and audit rows stay', async (t) => {
  const { app, a, storage, stored, deps } = await world(t);
  await createRawExport(deps, body(a.tenant.id), 'platform:x@team.example');
  await createRawExport(deps, body(a.tenant.id), 'platform:x@team.example');
  await app.db.platform.query(`UPDATE raw_exports SET expires_at = now() - interval '1 minute' WHERE storage_key = $1`, [stored[0]]);

  assert.equal(await sweepRawExports(deps), 1);
  assert.equal(await storage.get(stored[0]), null);
  assert.ok(await storage.get(stored[1]), 'the other one has days left');
  const rows = await app.db.platform.query('SELECT storage_key, deleted_at FROM raw_exports ORDER BY id');
  assert.ok(rows[0].deleted_at);
  assert.equal(rows[1].deleted_at, null);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'raw_export.create'`)).length, 2);
  assert.equal(await sweepRawExports(deps), 0, 'nothing left to do the second time');
});

test('a file that won\'t delete is tried again next time and doesn\'t stop the rest', async (t) => {
  const { app, a, storage, stored, deps } = await world(t);
  await createRawExport(deps, body(a.tenant.id), 'x');
  await createRawExport(deps, body(a.tenant.id), 'x');
  await app.db.platform.query(`UPDATE raw_exports SET expires_at = now() - interval '1 minute'`);
  const flaky = { ...storage, remove: (key) => (key === stored[0] ? Promise.reject(new Error('busy')) : storage.remove(key)) };
  await sweepRawExports({ db: app.db, storage: flaky });
  assert.equal(await storage.get(stored[1]), null);
  assert.equal((await app.db.platform.query('SELECT 1 FROM raw_exports WHERE deleted_at IS NULL')).length, 1);
});

test('the sweep runs once an hour, and a failure doesn\'t stop the worker\'s other jobs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let runs = 0;
  const schedule = platformConsole.jobs({ db: { query: async () => { runs++; throw new Error('database gone'); } }, platform: { storage: {} } });
  await schedule();
  await schedule();
  assert.equal(runs, 1);
  t.mock.timers.tick(3_600_000);
  await schedule();
  assert.equal(runs, 2);
});
