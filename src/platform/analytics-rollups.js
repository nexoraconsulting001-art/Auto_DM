import crypto from 'node:crypto';
import { ROLLUP_STORES } from '../contracts/analytics.js';
import { tenantId } from '../tenancy.js';

/**
 * Rollups: the one way anything reads or writes the summarised analytics tables (PRD 7.10, 7.11), so a separate analytics database can replace
 * Postgres later without changing a caller. Everything is about the current business, except purgeExpired().
 *
 *   write(store, rows)              Adds rows; a row whose key already exists is replaced whole, so a rerun changes nothing.
 *   rebuild(store, range, rows)     Clears a day range and writes rows, as one step. For a recount, where a row may have to disappear.
 *   clear(store, { since, until })  Removes a day range.
 *   read(store, query) -> rows      query: { measures, dimensions?, filters?, having?, since, until, orderBy?, direction?, limit?, offset? }
 *   purgeExpired(now?)              Applies every store's retention, for every business. Run from a job, outside withTenant().
 *
 * A store and its columns are ROLLUP_STORES in src/contracts/analytics.js. Days are 'YYYY-MM-DD' in the business's time zone, and since and until
 * are both included. A filter is { dimension, op: 'include' | 'exclude', values }; having is { measure, op: 'gte' | 'lte', value }. A row comes back as
 * { <dimension>: value, <measure>: number or null }. Nothing is ever put into SQL unless the catalogue has it, so a name from a request can't reach it.
 */
const IS_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 500;
const MAX_LIMIT = 10_000;
const DAY_MS = 86_400_000;

function storeOf(name) {
  if (!Object.hasOwn(ROLLUP_STORES, name)) throw new Error(`Unknown rollup store: ${name}`);
  return ROLLUP_STORES[name];
}

function checkDay(value, label) {
  if (typeof value !== 'string' || !IS_DAY.test(value)) throw new Error(`${label} must be a YYYY-MM-DD day`);
  return value;
}

const writableColumns = (store) => [...store.key.filter((k) => k !== 'dims_hash'), ...store.dimensions.filter((d) => !store.key.includes(d)), ...store.columns, ...store.extras];
const hashedDimensions = (store) => store.dimensions.filter((d) => d !== 'day');
const dimsHash = (store, row) => crypto.createHash('sha256').update(JSON.stringify(hashedDimensions(store).map((d) => row[d]))).digest('hex');

/** The row with every column filled in the catalogue's order, and its key. Refuses a column the store doesn't have. */
function prepareRow(store, row) {
  const known = new Set(writableColumns(store));
  for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`Rollup rows have no column "${key}"`);
  const out = {};
  for (const column of store.dimensions) {
    if (store.numericDimensions.includes(column)) {
      if (!Number.isInteger(row[column])) throw new Error(`Rollup column "${column}" must be a whole number`);
      out[column] = row[column];
    } else if (column === 'day') {
      out.day = checkDay(row.day, 'day');
    } else {
      out[column] = String(row[column] ?? '');
    }
  }
  for (const column of store.columns) out[column] = row[column] ?? (store.nullable ? null : 0);
  for (const column of store.extras) out[column] = row[column] ?? null;
  for (const column of store.key) {
    if (column === 'dims_hash') out.dims_hash = dimsHash(store, out);
    else if (column !== 'day' && !row[column]) throw new Error(`Rollup rows need "${column}"`);
    else out[column] = row[column];
  }
  return out;
}

function prepareRows(store, rows) {
  const unique = new Map();
  for (const row of rows) {
    const ready = prepareRow(store, row);
    unique.set(JSON.stringify(store.key.map((k) => ready[k])), ready); // the last row with a key wins, as a second write would
  }
  return [...unique.values()];
}

function checkQuery(store, query) {
  const { measures, dimensions = [], filters = [], having = [], orderBy, direction = 'desc', limit = 1000, offset = 0 } = query;
  if (!Array.isArray(measures) || !measures.length) throw new Error('A rollup read needs at least one measure');
  for (const name of measures) if (!Object.hasOwn(store.measures, name)) throw new Error(`Unknown rollup measure: ${name}`);
  for (const name of dimensions) if (!store.dimensions.includes(name)) throw new Error(`Unknown rollup dimension: ${name}`);
  for (const filter of filters) {
    if (!store.dimensions.includes(filter.dimension)) throw new Error(`Unknown rollup dimension: ${filter.dimension}`);
    if (filter.op !== 'include' && filter.op !== 'exclude') throw new Error('A filter op is include or exclude');
    if (!Array.isArray(filter.values) || !filter.values.length) throw new Error('A filter needs values');
  }
  for (const rule of having) {
    if (!measures.includes(rule.measure)) throw new Error(`A threshold can use only a measure being read: ${rule.measure}`);
    if (rule.op !== 'gte' && rule.op !== 'lte') throw new Error('A threshold op is gte or lte');
    if (!Number.isFinite(rule.value)) throw new Error('A threshold needs a number');
  }
  if (orderBy !== undefined && !measures.includes(orderBy) && !dimensions.includes(orderBy)) throw new Error(`Rollups can be ordered only by what is being read: ${orderBy}`);
  if (direction !== 'asc' && direction !== 'desc') throw new Error('direction is asc or desc');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be 1 to ${MAX_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a whole number');
  return { measures, dimensions, filters, having, orderBy: orderBy ?? measures[0], direction, limit, offset, since: checkDay(query.since, 'since'), until: checkDay(query.until, 'until') };
}

/** A read, for either database. `d` says how that database spells a day, a parameter and an aggregate. */
function compile(tableName, store, query, d) {
  const dimensionSql = (name) => (name === 'day' ? d.dayText : name);
  const measureSql = (name) => d.aggregate(store.measures[name]);
  const where = [d.tenant(), `day >= ${d.param(query.since, 'day')}`, `day <= ${d.param(query.until, 'day')}`];
  for (const filter of query.filters) {
    const numeric = store.numericDimensions.includes(filter.dimension);
    const values = numeric ? filter.values.map(Number) : filter.values.map(String);
    where.push(`${filter.op === 'exclude' ? 'NOT ' : ''}(${dimensionSql(filter.dimension)} ${d.inList(values, numeric)})`);
  }
  const having = query.having.map((rule) => `${measureSql(rule.measure)} ${rule.op === 'gte' ? '>=' : '<='} ${d.param(rule.value, 'number')}`);
  const groups = query.dimensions.map(dimensionSql);
  const select = [...query.dimensions.map((name) => `${dimensionSql(name)} AS d_${name}`), ...query.measures.map((name) => `${measureSql(name)} AS m_${name}`)];
  const orderAlias = query.measures.includes(query.orderBy) ? `m_${query.orderBy}` : `d_${query.orderBy}`;
  const order = [`${orderAlias} ${query.direction.toUpperCase()} NULLS LAST`, ...query.dimensions.map((name) => `d_${name}`).filter((alias) => alias !== orderAlias)];
  return `SELECT ${select.join(', ')} FROM ${tableName}${d.final} WHERE ${where.join(' AND ')}${groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}${having.length ? ` HAVING ${having.join(' AND ')}` : ''} ORDER BY ${order.join(', ')} LIMIT ${query.limit} OFFSET ${query.offset}`;
}

function toRow(store, query, raw) {
  const row = {};
  for (const name of query.dimensions) row[name] = store.numericDimensions.includes(name) ? Number(raw[`d_${name}`]) : String(raw[`d_${name}`]);
  for (const name of query.measures) row[name] = raw[`m_${name}`] === null || raw[`m_${name}`] === undefined ? null : Number(raw[`m_${name}`]);
  return row;
}

const cutoffDay = (store, now) => new Date(+now - store.retainDays * DAY_MS).toISOString().slice(0, 10);

// ---- Postgres --------------------------------------------------------------------------------------------------------

export function pgRollups(db) {
  const PG_AGGREGATE = {
    sum: (c) => `SUM(${c})`,
    max: (c) => `MAX(${c})`,
    count: () => 'COUNT(*)',
    distinct: (c) => `COUNT(DISTINCT ${c})`,
    median: (c) => `percentile_cont(0.5) WITHIN GROUP (ORDER BY ${c})`,
  };

  function dialect(params) {
    const param = (value, kind) => {
      params.push(value);
      return `$${params.length}${kind === 'day' ? '::date' : '::numeric'}`;
    };
    return {
      dayText: 'day::text',
      final: '',
      tenant: () => {
        params.push(tenantId());
        return `tenant_id = $${params.length}`;
      },
      param,
      inList: (values, numeric) => {
        params.push(values);
        return `= ANY($${params.length}::${numeric ? 'integer' : 'text'}[])`;
      },
      aggregate: ({ fn, column }) => PG_AGGREGATE[fn](column),
    };
  }

  async function insert(runner, name, store, rows) {
    if (!rows.length) return 0;
    const columns = Object.keys(rows[0]);
    const updates = columns.filter((c) => !store.key.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params = [];
      const values = chunk.map((row) => {
        const placeholders = [tenantId(), ...columns.map((c) => row[c])].map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await runner.query(
        `INSERT INTO ${name} (tenant_id, ${columns.join(', ')}) VALUES ${values.join(', ')}
         ON CONFLICT (tenant_id, ${store.key.join(', ')}) DO UPDATE SET ${updates.join(', ')}`,
        params,
      );
    }
    return rows.length;
  }

  const clearOn = (runner, name, { since, until }) => runner.query(
    `DELETE FROM ${name} WHERE tenant_id = $1 AND day >= $2::date AND day <= $3::date`,
    [tenantId(), checkDay(since, 'since'), checkDay(until, 'until')],
  );

  return {
    async write(name, rows) {
      const store = storeOf(name);
      const ready = prepareRows(store, rows);
      return ready.length > CHUNK ? db.tx((t) => insert(t, name, store, ready)) : insert(db, name, store, ready);
    },

    rebuild(name, range, rows) {
      const store = storeOf(name);
      const ready = prepareRows(store, rows);
      return db.tx(async (t) => {
        await clearOn(t, name, range);
        return insert(t, name, store, ready);
      });
    },

    async clear(name, range) {
      storeOf(name);
      await clearOn(db, name, range);
    },

    async read(name, spec) {
      const store = storeOf(name);
      const query = checkQuery(store, spec);
      const params = [];
      const rows = await db.query(compile(name, store, query, dialect(params)), params);
      return rows.map((raw) => toRow(store, query, raw));
    },

    async purgeExpired(now = new Date()) {
      const platform = db.platform ?? db;
      for (const [name, store] of Object.entries(ROLLUP_STORES)) await platform.query(`DELETE FROM ${name} WHERE day < $1::date`, [cutoffDay(store, now)]);
    },
  };
}

// ---- ClickHouse: the same interface, on tables it makes from the catalogue -----------------------------------------------

const quoted = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function clickhouseRollups(run) {
  const CH_AGGREGATE = {
    sum: (c) => `sum(${c})`,
    max: (c) => `max(${c})`,
    count: () => 'count()',
    distinct: (c) => `uniqExact(${c})`,
    median: (c) => `quantileExact(0.5)(${c})`,
  };
  const ready = new Map();

  function ensure(name) {
    if (ready.has(name)) return ready.get(name);
    const store = storeOf(name);
    const columnType = (column) => {
      if (column === 'day') return 'Date';
      if (store.numericDimensions.includes(column)) return 'Int32';
      if (store.columns.includes(column)) return store.nullable ? 'Nullable(Int64)' : 'Int64';
      if (store.extras.includes(column)) return 'Nullable(String)';
      return 'String';
    };
    const columns = [...new Set([...store.key, ...store.dimensions, ...store.columns, ...store.extras])];
    const making = run(`CREATE TABLE IF NOT EXISTS ${name} (tenant_id UInt32, ${columns.map((c) => `${c} ${columnType(c)}`).join(', ')}, version DateTime64(3, 'UTC') DEFAULT now64(3))
      ENGINE = ReplacingMergeTree(version) ORDER BY (tenant_id, ${store.key.join(', ')})`).catch((err) => {
      ready.delete(name);
      throw err;
    });
    ready.set(name, making);
    return making;
  }

  function dialect(params) {
    const named = (value, type) => {
      const key = `p${Object.keys(params).length}`;
      params[key] = value;
      return `{${key}:${type}}`;
    };
    return {
      dayText: 'toString(day)',
      final: ' FINAL',
      tenant: () => `tenant_id = ${named(tenantId(), 'UInt32')}`,
      param: (value, kind) => named(value, kind === 'day' ? 'Date' : 'Float64'),
      inList: (values, numeric) => `IN ${named(`[${values.map((v) => (numeric ? v : quoted(v))).join(',')}]`, numeric ? 'Array(Int32)' : 'Array(String)')}`,
      aggregate: ({ fn, column }) => CH_AGGREGATE[fn](column),
    };
  }

  async function insert(name, rows) {
    if (!rows.length) return 0;
    await ensure(name);
    await run(`INSERT INTO ${name} FORMAT JSONEachRow`, { body: rows.map((row) => JSON.stringify({ tenant_id: tenantId(), ...row })).join('\n') });
    return rows.length;
  }

  async function clear(name, { since, until }) {
    await ensure(name);
    await run(`DELETE FROM ${name} WHERE tenant_id = {t:UInt32} AND day >= {s:Date} AND day <= {u:Date}`, { params: { t: tenantId(), s: checkDay(since, 'since'), u: checkDay(until, 'until') } });
  }

  return {
    write: (name, rows) => insert(name, prepareRows(storeOf(name), rows)),

    async rebuild(name, range, rows) {
      const prepared = prepareRows(storeOf(name), rows);
      await clear(name, range);
      return insert(name, prepared);
    },

    clear,

    async read(name, spec) {
      const store = storeOf(name);
      const query = checkQuery(store, spec);
      await ensure(name);
      const params = {};
      const text = await run(`${compile(name, store, query, dialect(params))} FORMAT JSONEachRow`, { params });
      return text.trim() ? text.trim().split('\n').map((line) => toRow(store, query, JSON.parse(line))) : [];
    },

    async purgeExpired(now = new Date()) {
      for (const [name, store] of Object.entries(ROLLUP_STORES)) {
        await ensure(name);
        await run(`DELETE FROM ${name} WHERE day < {d:Date}`, { params: { d: cutoffDay(store, now) } });
      }
    },
  };
}
