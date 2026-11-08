import { tenantId } from '../tenancy.js';

/**
 * Analytics events: every number Bhava measures itself (DMs, taps, visits, orders) is written here,
 * and dashboards read only through this module. One interface, two drivers (ANALYTICS_DRIVER):
 *   pg          the `events` table in the main Postgres (QA)
 *   clickhouse  a separate ClickHouse database over HTTP (production)
 *
 *   track(name, props)                         as the current business
 *   count(name, { since, until }) -> number    for the current business
 *   countByDay(name, { since, until }) -> [{ day: 'YYYY-MM-DD', n }]
 */
export function createAnalytics(config = {}, { db } = {}) {
  const driver = config.analyticsDriver || 'pg';
  if (driver === 'pg') return pgAnalytics(db);
  if (driver === 'clickhouse') return clickhouseAnalytics(config);
  throw new Error(`Unknown ANALYTICS_DRIVER "${driver}" (use pg or clickhouse)`);
}

const EVENT_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const checkName = (name) => {
  if (!EVENT_NAME.test(name)) throw new Error(`Invalid event name: ${name}`);
  return name;
};
const iso = (d) => (d instanceof Date ? d : new Date(d ?? 0)).toISOString();

function pgAnalytics(db) {
  if (!db) throw new Error('The pg analytics driver needs the database');
  return {
    driver: 'pg',
    async track(name, props = {}) {
      await db.query('INSERT INTO events (tenant_id, name, props) VALUES ($1, $2, $3)', [tenantId(), checkName(name), JSON.stringify(props)]);
    },
    async count(name, { since = 0, until = Date.now() + 1000 } = {}) {
      const [{ n }] = await db.query(
        'SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND name = $2 AND at >= $3 AND at < $4',
        [tenantId(), checkName(name), iso(since), iso(until)],
      );
      return n;
    },
    async countByDay(name, { since = 0, until = Date.now() + 1000 } = {}) {
      const rows = await db.query(
        `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM events
         WHERE tenant_id = $1 AND name = $2 AND at >= $3 AND at < $4 GROUP BY 1 ORDER BY 1`,
        [tenantId(), checkName(name), iso(since), iso(until)],
      );
      return rows;
    },
  };
}

function clickhouseAnalytics(config) {
  if (!config.clickhouseUrl) throw new Error('CLICKHOUSE_URL is required when ANALYTICS_DRIVER=clickhouse');
  const base = new URL(config.clickhouseUrl);
  const database = config.clickhouseDb || 'bhava';
  const auth = base.username ? `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}` : undefined;
  base.username = '';
  base.password = '';

  async function run(sql, { body, params = {} } = {}) {
    const url = new URL(base);
    url.searchParams.set('query', sql);
    url.searchParams.set('database', database);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, String(v));
    const res = await fetch(url, { method: 'POST', body, headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`ClickHouse error ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }

  let ready;
  const ensureTable = () =>
    (ready ??= (async () => {
      const db = new URL(base);
      db.searchParams.set('query', `CREATE DATABASE IF NOT EXISTS ${database}`);
      const res = await fetch(db, { method: 'POST', headers: auth ? { authorization: auth } : {} });
      if (!res.ok) throw new Error(`ClickHouse error ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await run(`CREATE TABLE IF NOT EXISTS events (
        tenant_id UInt32, name LowCardinality(String), props String, at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (tenant_id, name, at)`);
    })().catch((err) => {
      ready = undefined;
      throw err;
    }));

  const chTime = (d) => iso(d).replace('T', ' ').replace('Z', '');

  return {
    driver: 'clickhouse',
    async track(name, props = {}) {
      await ensureTable();
      const row = JSON.stringify({ tenant_id: tenantId(), name: checkName(name), props: JSON.stringify(props), at: chTime(new Date()) });
      await run('INSERT INTO events FORMAT JSONEachRow', { body: row });
    },
    async count(name, { since = 0, until = Date.now() + 1000 } = {}) {
      await ensureTable();
      const text = await run(
        'SELECT count() FROM events WHERE tenant_id = {t:UInt32} AND name = {n:String} AND at >= {s:DateTime64(3)} AND at < {u:DateTime64(3)}',
        { params: { t: tenantId(), n: checkName(name), s: chTime(since), u: chTime(until) } },
      );
      return Number(text.trim());
    },
    async countByDay(name, { since = 0, until = Date.now() + 1000 } = {}) {
      await ensureTable();
      const text = await run(
        `SELECT formatDateTime(toDate(at), '%Y-%m-%d') AS day, toUInt32(count()) AS n FROM events
         WHERE tenant_id = {t:UInt32} AND name = {n:String} AND at >= {s:DateTime64(3)} AND at < {u:DateTime64(3)}
         GROUP BY day ORDER BY day FORMAT JSONEachRow`,
        { params: { t: tenantId(), n: checkName(name), s: chTime(since), u: chTime(until) } },
      );
      return text.trim() ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
    },
  };
}
