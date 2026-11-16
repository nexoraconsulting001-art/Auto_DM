// Attack: every business API route that takes an id in its address, called by the owner of a brand-new business
// with the ids of rows that belong to other businesses. The attacker owns no rows at all, so any 2xx read is a
// leak, and any change to another business's rows is a cross-business write (PRD 5.1: one business can never see,
// change or link to another's data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeList } from '../../../src/contracts/api/index.js';
import { demoTenantService } from '../../../src/modules/demo-tenant/index.js';
import { addBusiness, hit, signIn, startWorld } from '../../p0/spec-p0/support.js';

/** Every table with a tenant_id, and whether it has an id column. */
async function tenantTables(app) {
  return app.db.platform.query(
    `SELECT c.relname AS name, EXISTS (SELECT 1 FROM pg_attribute i WHERE i.attrelid = c.oid AND i.attname = 'id' AND NOT i.attisdropped) AS has_id
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  );
}

/** Every row of every business but `except`, as sorted JSON per table. */
async function othersSnapshot(app, tables, except) {
  const out = {};
  for (const { name } of tables) {
    const rows = await app.db.platform.query(`SELECT to_jsonb(x)::text AS j FROM ${name} x WHERE tenant_id IS DISTINCT FROM $1`, [except]);
    out[name] = rows.map((r) => r.j).sort();
  }
  return out;
}

const segmentTables = (path) => {
  const segs = path.split('/').filter(Boolean);
  const at = segs.indexOf(':id');
  const before = segs.slice(0, at).filter((s) => !s.startsWith(':'));
  const last = before.at(-1) ?? '';
  const joined = before.join('_').replace(/-/g, '_');
  const base = last.replace(/-/g, '_');
  return [...new Set([joined, base, `${base}s`, base.replace(/s$/, ''), `inbox_${base}`, `${base.replace(/s$/, '')}_items`])];
};

async function idsFor(app, tables, attacker, path) {
  const names = new Set(tables.filter((t) => t.has_id).map((t) => t.name));
  for (const table of segmentTables(path)) {
    if (!names.has(table)) continue;
    const rows = await app.db.platform.query(`SELECT id FROM ${table} WHERE tenant_id <> $1 ORDER BY id LIMIT 3`, [attacker]);
    if (rows.length) return { table, ids: rows.map((r) => String(r.id)) };
  }
  return { table: null, ids: ['1', '2', '3'] };
}

async function world(t) {
  const app = await startWorld(t);
  const demo = demoTenantService({ db: app.db, repos: app.platform, config: app.config });
  await demo.ensure();
  const attacker = await addBusiness(app, { slug: 'thief', name: 'Thief Traders', plan: 't5' });
  const token = await signIn(app, attacker);
  const tables = await tenantTables(app);
  return { app, attacker, token, tables };
}

const idRoutes = routeList.filter((r) => /:id\b/.test(r.path) && !r.consoleOnly);

test('IDOR sweep: no id route shows a brand-new business another business\'s row', async (t) => {
  const { app, attacker, token, tables } = await world(t);
  const leaks = [];
  for (const route of idRoutes.filter((r) => r.method === 'GET')) {
    const { table, ids } = await idsFor(app, tables, attacker.tenant.id, route.path);
    for (const id of ids) {
      const path = `/api/v1${route.path.replace(':id', id)}`;
      const res = await hit(app, path, { host: attacker.host, token });
      if (res.status >= 200 && res.status < 300) leaks.push(`${route.id} GET ${path} (${table ?? 'no table'}) -> ${res.status} ${res.text.slice(0, 160)}`);
      assert.ok(res.status < 500, `${route.id} ${path}: ${res.status} ${res.text.slice(0, 200)}`);
    }
  }
  assert.deepEqual(leaks, [], `reads of other businesses' rows:\n${leaks.join('\n')}`);
});

test('IDOR sweep: no id route changes another business\'s rows, whatever the body', async (t) => {
  const { app, attacker, token, tables } = await world(t);
  const before = await othersSnapshot(app, tables, attacker.tenant.id);
  const crashes = [];
  const bodies = [undefined, {}, { name: 'pwned', state: 'live', status: 'cancelled', reason: 'x', note: 'x', text: 'x', amountPaise: 100, quantity: 1, active: false, headline: 'pwned' }];
  for (const route of idRoutes.filter((r) => r.method !== 'GET')) {
    const { ids } = await idsFor(app, tables, attacker.tenant.id, route.path);
    for (const id of ids) {
      for (const body of bodies) {
        const path = `/api/v1${route.path.replace(':id', id)}`;
        const res = await hit(app, path, { host: attacker.host, token, method: route.method, body, headers: { 'idempotency-key': `k-${route.id}-${id}-${Math.random()}` } });
        if (res.status >= 500) crashes.push(`${route.id} ${route.method} ${path} -> ${res.status} ${res.text.slice(0, 160)}`);
      }
    }
  }
  const after = await othersSnapshot(app, tables, attacker.tenant.id);
  const changed = [];
  for (const { name } of tables) {
    const was = new Set(before[name]);
    const now = new Set(after[name]);
    const gone = before[name].filter((j) => !now.has(j));
    const added = after[name].filter((j) => !was.has(j));
    if (gone.length || added.length) changed.push(`${name}: -${gone.length} +${added.length} e.g. ${(gone[0] ?? '').slice(0, 200)} => ${(added[0] ?? '').slice(0, 200)}`);
  }
  assert.deepEqual(changed, [], `other businesses' rows changed:\n${changed.join('\n')}`);
  assert.deepEqual(crashes, [], `server errors:\n${crashes.join('\n')}`);
});
