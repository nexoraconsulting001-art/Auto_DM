/**
 * Reading a database as the drill compares it: every table's rows and checksum (whole, and for each business on the tables
 * that carry tenant_id), the sequences, the grants and the row-level security settings. The same function runs on the source
 * and on the restored copy; `diffSnapshots` says what is different. `checkFence` and `checkLogins` look at the restored
 * copy through the restricted app login.
 *
 * Every read is on the owner's connection with the time zone and number formats fixed, so a checksum is the same on any server.
 * Nothing here prints a row: a difference is named by table, business id and the two counts.
 */
import { DrillError, checksumSql } from './sql.mjs';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** A { query } over one pg client, answering rows, as src/db's helpers expect. */
export const rowsOf = (client) => ({
  query: async (sql, params) => (await client.query(sql, params)).rows,
  exec: (sql) => client.query(sql),
});

async function fixFormats(client) {
  await client.query("SET TIME ZONE 'UTC'");
  await client.query("SET DateStyle = 'ISO, MDY'");
  await client.query('SET extra_float_digits = 1');
  await client.query("SET bytea_output = 'hex'");
}

/**
 * { tables: { name: { keys, tenantColumn, whole: { rows, checksum }, tenants: { id: { rows, checksum } } } }, tenantIds, sequences, grants, security }.
 * `perTenant: false` leaves the per-business reads out (the refuse step's quick look).
 */
export async function snapshot(client, { perTenant = true } = {}) {
  await fixFormats(client);
  const q = async (sql, params) => (await client.query(sql, params)).rows;
  const tables = (await q(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`)).map((r) => r.name);
  const columns = new Map();
  for (const r of await q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`)) {
    columns.set(r.table_name, [...(columns.get(r.table_name) ?? []), r.column_name]);
  }
  const keys = new Map((await q(`
    SELECT c.relname AS name, array_agg(a.attname::text ORDER BY k.ord) AS cols
      FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE con.contype = 'p' AND n.nspname = 'public' GROUP BY c.relname`)).map((r) => [r.name, r.cols]));
  const tenantIds = tenantTable(tables) ? (await q('SELECT id FROM tenants ORDER BY id')).map((r) => Number(r.id)) : [];
  const out = { tables: {}, tenantIds };
  for (const name of tables) {
    if (!IDENT.test(name)) throw new DrillError(`The table "${name}" has a name the drill cannot check safely.`);
    const cols = columns.get(name) ?? [];
    const order = keys.get(name) ?? cols;
    for (const col of order) if (!IDENT.test(col)) throw new DrillError(`The column "${name}.${col}" has a name the drill cannot check safely.`);
    const [whole] = await q(checksumSql(name, order));
    const entry = { keys: order, tenantColumn: cols.includes('tenant_id') ? 'tenant_id' : '', whole: { rows: Number(whole.rows), checksum: whole.checksum }, tenants: {} };
    if (perTenant && entry.tenantColumn) {
      for (const id of tenantIds) {
        const [one] = await q(checksumSql(name, order, { tenantColumn: 'tenant_id' }), [id]);
        entry.tenants[id] = { rows: Number(one.rows), checksum: one.checksum };
      }
    }
    out.tables[name] = entry;
  }
  out.sequences = Object.fromEntries((await q(`SELECT sequencename AS name, last_value FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`)).map((r) => [r.name, r.last_value === null ? null : String(r.last_value)]));
  out.grants = (await q(`
    SELECT c.relname AS name, a.privilege_type AS privilege, a.grantee::regrole::text AS grantee
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') AND a.grantee <> 0 ORDER BY 1, 3, 2`)).map((r) => `${r.name}:${r.grantee}:${r.privilege}`);
  out.security = {
    tables: (await q(`SELECT c.relname AS name, c.relrowsecurity AS on, c.relforcerowsecurity AS forced FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`)).map((r) => `${r.name}:${r.on ? 'rls' : 'open'}:${r.forced ? 'forced' : 'owner-exempt'}`),
    policies: (await q(`SELECT tablename, policyname, cmd, roles::text AS roles, COALESCE(qual, '') AS qual, COALESCE(with_check, '') AS with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2`)).map((r) => `${r.tablename}:${r.policyname}:${r.cmd}:${r.roles}:${r.qual}:${r.with_check}`),
  };
  return out;
}

const tenantTable = (tables) => tables.includes('tenants');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const listDiff = (what, a, b) => {
  const left = new Set(a);
  const right = new Set(b);
  const missing = a.filter((x) => !right.has(x));
  const extra = b.filter((x) => !left.has(x));
  return [...missing.slice(0, 5).map((x) => `${what}: missing after restore: ${x}`), ...extra.slice(0, 5).map((x) => `${what}: not in the source: ${x}`)];
};

/** The differences between two snapshots, as plain sentences (at most `limit`). Empty means the same. Rows are never quoted. */
export function diffSnapshots(source, restored, { only = ['rows', 'sequences', 'grants', 'security'], limit = 25 } = {}) {
  const out = [];
  const add = (line) => { if (out.length < limit) out.push(line); };
  if (only.includes('rows')) {
    for (const name of new Set([...Object.keys(source.tables), ...Object.keys(restored.tables)])) {
      const a = source.tables[name];
      const b = restored.tables[name];
      if (!a || !b) { add(`table ${name}: ${a ? 'missing after restore' : 'not in the source'}`); continue; }
      if (a.whole.rows !== b.whole.rows) add(`table ${name}: ${a.whole.rows} rows in the source, ${b.whole.rows} after restore`);
      else if (a.whole.checksum !== b.whole.checksum) add(`table ${name}: same ${a.whole.rows} rows but a different checksum`);
      for (const id of new Set([...Object.keys(a.tenants), ...Object.keys(b.tenants)])) {
        const x = a.tenants[id];
        const y = b.tenants[id];
        if (!x || !y) add(`table ${name}, business ${id}: ${x ? 'missing after restore' : 'not in the source'}`);
        else if (x.rows !== y.rows) add(`table ${name}, business ${id}: ${x.rows} rows in the source, ${y.rows} after restore`);
        else if (x.checksum !== y.checksum) add(`table ${name}, business ${id}: same ${x.rows} rows but a different checksum`);
      }
    }
    if (!same(source.tenantIds, restored.tenantIds)) add(`the businesses differ: ${source.tenantIds.length} in the source, ${restored.tenantIds.length} after restore`);
  }
  if (only.includes('sequences')) {
    for (const name of new Set([...Object.keys(source.sequences), ...Object.keys(restored.sequences)])) {
      if (source.sequences[name] !== restored.sequences[name]) add(`sequence ${name}: ${source.sequences[name]} in the source, ${restored.sequences[name]} after restore`);
    }
  }
  if (only.includes('grants')) for (const line of listDiff('grant', source.grants, restored.grants)) add(line);
  if (only.includes('security')) {
    for (const line of listDiff('row-level security', source.security.tables, restored.security.tables)) add(line);
    for (const line of listDiff('policy', source.security.policies, restored.security.policies)) add(line);
  }
  return out;
}

/** What a snapshot covers, for the report: { tables, businesses, rows, tenantTables }. */
export function coverage(snap) {
  const names = Object.keys(snap.tables);
  return { tables: names.length, businesses: snap.tenantIds.length, rows: names.reduce((s, n) => s + snap.tables[n].whole.rows, 0), tenantTables: names.filter((n) => snap.tables[n].tenantColumn).length };
}

/**
 * The fence, read through the restricted app login on the restored copy. `app` is a connected pg client for that login.
 * For each business and each table that carries tenant_id: with the business set, the rows it sees are its own, as many as the
 * owner counted, and none of another's; with no business set, none at all. Answers { problems, checked }.
 */
export async function checkFence(app, snap) {
  const problems = [];
  let checked = 0;
  const probe = async (table, setting, ownId) => {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [setting]);
      const { rows } = await app.query(
        `SELECT count(*) FILTER (WHERE tenant_id = $1::integer)::int AS own, count(*) FILTER (WHERE tenant_id IS NOT NULL AND tenant_id <> $1::integer)::int AS foreign_rows, count(*) FILTER (WHERE tenant_id IS NOT NULL)::int AS any_rows FROM ${table}`,
        [ownId],
      );
      return rows[0];
    } catch (err) {
      return err.code === '42501' ? { denied: true } : { error: err.code || err.message };
    } finally {
      await app.query('ROLLBACK');
    }
  };
  for (const [table, info] of Object.entries(snap.tables)) {
    if (!info.tenantColumn) continue;
    const none = await probe(table, '', 0);
    checked++;
    if (none.error) problems.push(`table ${table}: the app login could not be asked (${none.error})`);
    else if (!none.denied && none.any_rows !== 0) problems.push(`table ${table}: ${none.any_rows} rows visible with no business set`);
    for (const id of snap.tenantIds) {
      const seen = await probe(table, String(id), id);
      checked++;
      if (seen.error) problems.push(`table ${table}, business ${id}: the app login could not be asked (${seen.error})`);
      else if (seen.denied) continue;
      else if (seen.foreign_rows !== 0) problems.push(`table ${table}, business ${id}: ${seen.foreign_rows} rows of other businesses visible`);
      else if (seen.own !== info.tenants[id]?.rows) problems.push(`table ${table}, business ${id}: sees ${seen.own} of its ${info.tenants[id]?.rows} rows`);
    }
  }
  return { problems: problems.slice(0, 25), checked };
}

/**
 * Both logins on the restored copy. `owner` and `app` are connected pg clients. The app login must be the restricted one
 * (src/db assertRestrictedLogin), must not be able to make or alter a table, and the owner must be able to read every business.
 */
export async function checkLogins({ owner, app, assertRestrictedLogin }) {
  const problems = [];
  const ownerName = (await owner.query('SELECT current_user AS name')).rows[0]?.name;
  if (!ownerName) problems.push('the owner login did not answer');
  let appName = '';
  try {
    appName = await assertRestrictedLogin(rowsOf(app));
  } catch (err) {
    problems.push(`the app login is not the restricted one: ${String(err.message).split('\n')[0].slice(0, 200)}`);
  }
  for (const [what, sql] of [['make a table', 'CREATE TABLE drill_probe (x integer)'], ['alter a table', 'ALTER TABLE tenants ADD COLUMN drill_probe integer'], ['drop a table', 'DROP TABLE tenants']]) {
    try {
      await app.query('BEGIN');
      await app.query(sql);
      problems.push(`the app login can ${what}`);
    } catch (err) {
      if (err.code !== '42501') problems.push(`the app login was refused to ${what} for an unexpected reason (${err.code || 'error'})`);
    } finally {
      await app.query('ROLLBACK').catch(() => {});
    }
  }
  const [{ n }] = (await owner.query('SELECT count(*)::int AS n FROM tenants')).rows;
  return { problems, ownerName, appName, businesses: n };
}
