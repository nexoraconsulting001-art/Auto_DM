import { FIGURE_TEXT, STEPS_NEEDING_TIER_3 } from '../../contracts/analytics.js';
import { isRowId, pageOfFetched, readCursor } from '../admin-api/paging.js';
import { tenantId } from '../../tenancy.js';
import { DIMS_LIKE } from './sessions.js';
import { addDays, dayStart, previousOf, rangeOf, timeZoneOf } from './time.js';

const toFunnel = (row) => ({ id: row.id, name: row.name, steps: row.steps, countBy: row.count_by, windowMinutes: row.window_minutes, updatedAt: row.updated_at });

/** A step of a custom funnel, as a condition on one event. Only these fixed pieces of text are ever part of the query; a chosen page is a parameter. */
const STEP_MATCH = {
  landing_view: `(e.name = 'landing_view' OR (e.name = 'page_view' AND e.page_kind = 'landing'))`,
  category_view: `(e.name = 'category_view' OR (e.name = 'page_view' AND e.page_kind = 'category'))`,
  product_view: `(e.name = 'product_view' OR (e.name = 'page_view' AND e.page_kind = 'product'))`,
  product_tap: `e.name = 'product_tap'`,
  outbound_click: `e.name = 'outbound_tap'`,
  whatsapp_tap: `e.name = 'whatsapp_tap'`,
  add_to_cart: `e.name = 'add_to_cart'`,
  checkout_started: `e.name = 'checkout_started'`,
  payment_success: `e.name = 'payment_success'`,
};

/** Where each breakdown comes from: the first step's session, and the first step itself for product and category. */
const SESSION_BREAKDOWN = { date: 'day', hour: 'hour', weekday: 'weekday', source: 'source', utm_source: 'utm_source', utm_medium: 'utm_medium', utm_campaign: 'utm_campaign', utm_content: 'utm_content', content: 'media_id', landing_page: 'landing_page', device: 'device', os: 'os', browser: 'browser', in_app: 'in_app', city: 'city', state: 'state', visitor_type: 'visitor_type' };

const round4 = (value) => Number(value.toFixed(4));

export function customFunnelsRepo(db) {
  return {
    async list({ cursor, limit }) {
      const after = cursor ? readCursor(cursor, (key) => key.length === 1 && isRowId(key[0]))[0] : null;
      const rows = await db.query(`SELECT * FROM custom_funnels WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`, [tenantId(), after, limit + 1]);
      const page = pageOfFetched(rows, limit, (row) => [row.id]);
      return { items: page.items.map(toFunnel), nextCursor: page.nextCursor };
    },
    async get(id) {
      const [row] = await db.query('SELECT * FROM custom_funnels WHERE tenant_id = $1 AND id = $2', [tenantId(), id]);
      return row ? toFunnel(row) : null;
    },
    async create(input, user) {
      const [row] = await db.query(
        `INSERT INTO custom_funnels (tenant_id, name, steps, count_by, window_minutes, created_by) VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING *`,
        [tenantId(), input.name, JSON.stringify(input.steps), input.countBy, input.windowMinutes, user.id],
      );
      return toFunnel(row);
    },
    async update(id, patch) {
      const [row] = await db.query(
        `UPDATE custom_funnels SET name = COALESCE($3, name), steps = COALESCE($4::jsonb, steps), count_by = COALESCE($5, count_by), window_minutes = COALESCE($6, window_minutes), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId(), id, patch.name ?? null, patch.steps ? JSON.stringify(patch.steps) : null, patch.countBy ?? null, patch.windowMinutes ?? null],
      );
      return row ? toFunnel(row) : null;
    },
    async remove(id) {
      const rows = await db.query('DELETE FROM custom_funnels WHERE tenant_id = $1 AND id = $2 RETURNING id', [tenantId(), id]);
      return rows.length > 0;
    },
  };
}

/** Counts a funnel straight from the events: steps in order, within the window, and the first step decides who is counted and what they are broken down by (7.12). */
export function createFunnelResults(ctx, rollupService) {
  const { db, repos } = ctx;

  function buildQuery(steps, { countBy, windowMinutes, breakdown }, bounds) {
    const params = [tenantId(), bounds.from, bounds.to, windowMinutes, DIMS_LIKE];
    const param = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const match = (step) => {
      if (step.kind !== 'page_view') return STEP_MATCH[step.kind];
      const page = param(step.page ?? '');
      return `(e.name = 'page_view' AND (e.path = ${page} OR e.page_ref = ${page}))`;
    };
    const actor = countBy === 'visitor' ? 'COALESCE(e.visitor_id::text, e.session_id::text)' : 'e.session_id::text';
    const sameActor = countBy === 'visitor' ? '(e.visitor_id = p.visitor_id OR (p.visitor_id IS NULL AND e.session_id = p.session_id))' : 'e.session_id = p.session_id';

    let dim = `''`;
    if (breakdown === 'product' || breakdown === 'category') dim = `CASE WHEN e.page_kind = ${param(breakdown)} THEN e.page_ref ELSE '' END`;
    else if (breakdown) dim = `COALESCE(d.dims ->> ${param(SESSION_BREAKDOWN[breakdown])}, '')`;

    const first = `s1 AS (
      SELECT DISTINCT ON (actor) actor, at AS t0, at AS t, id AS i, session_id, visitor_id, dim FROM (
        SELECT ${actor} AS actor, e.at, e.id, e.session_id, e.visitor_id, ${dim} AS dim
        FROM traffic_events e LEFT JOIN dims d ON d.session_id = e.session_id
        WHERE e.tenant_id = $1 AND e.session_id IS NOT NULL AND e.at >= $2::timestamptz AND e.at < $3::timestamptz AND ${match(steps[0])}
      ) x ORDER BY actor, at, id
    )`;
    const later = steps.slice(1).map((step, index) => `s${index + 2} AS (
      SELECT DISTINCT ON (p.actor) p.actor, p.t0, e.at AS t, e.id AS i, p.session_id, p.visitor_id, p.dim
      FROM s${index + 1} p JOIN traffic_events e ON e.tenant_id = $1 AND ${sameActor} AND (e.at, e.id) > (p.t, p.i) AND e.at <= p.t0 + make_interval(mins => $4)
      WHERE ${match(step)}
      ORDER BY p.actor, e.at, e.id
    )`);
    const counts = steps.map((_step, index) => `SELECT ${index + 1} AS step, dim, count(*)::int AS n FROM s${index + 1} GROUP BY dim`).join(' UNION ALL ');
    const sql = `WITH dims AS (SELECT session_id, outbound_host::jsonb AS dims FROM traffic_events WHERE tenant_id = $1 AND at >= $2::timestamptz AND at < $3::timestamptz AND outbound_host LIKE $5),
      ${[first, ...later].join(',\n')}
      ${counts}`;
    return { sql, params };
  }

  async function countSteps(steps, options, range, timeZone) {
    if (!steps.length) return [];
    const bounds = { from: dayStart(range.since, timeZone), to: dayStart(addDays(range.until, 1), timeZone) };
    const { sql, params } = buildQuery(steps, options, bounds);
    return db.query(sql, params);
  }

  async function results(funnelId, query) {
    const funnel = await repos.customFunnels.get(funnelId);
    if (!funnel) return null;
    const timeZone = await timeZoneOf(db);
    const range = rangeOf(query, await rollupService.today());
    const commerce = await repos.entitlements.can('funnels.commerce');
    const usable = (step) => commerce || !STEPS_NEEDING_TIER_3.includes(step.kind);
    const active = funnel.steps.filter(usable);
    const options = { countBy: funnel.countBy, windowMinutes: funnel.windowMinutes, breakdown: query.breakdown };
    const rows = await countSteps(active, options, range, timeZone);
    const previous = query.compare === 'previous' ? await countSteps(active, { ...options, breakdown: undefined }, previousOf(range), timeZone) : null;

    const totalAt = (list, index) => list.filter((r) => r.step === index + 1).reduce((sum, r) => sum + r.n, 0);
    let activeIndex = 0;
    let before = null;
    const steps = funnel.steps.map((step) => {
      if (!usable(step)) return { kind: step.kind, ...(step.page ? { page: step.page } : {}), count: 0, stepRate: null, dropOff: null, previous: null, unavailable: true, message: FIGURE_TEXT.needsTier3 };
      const count = totalAt(rows, activeIndex);
      const result = { kind: step.kind, ...(step.page ? { page: step.page } : {}), count, stepRate: before === null || before === 0 ? null : round4(count / before), dropOff: before === null ? null : before - count, previous: previous ? totalAt(previous, activeIndex) : null, unavailable: false, message: null };
      before = count;
      activeIndex += 1;
      return result;
    });

    const keys = query.breakdown ? [...new Set(rows.map((r) => r.dim))] : [];
    const breakdown = keys.map((key) => ({ key, counts: active.map((_s, i) => rows.find((r) => r.step === i + 1 && r.dim === key)?.n ?? 0) }));
    return { funnelId: funnel.id, countBy: funnel.countBy, steps, breakdown, source: 'bhava', lastUpdatedAt: new Date().toISOString() };
  }

  return { results };
}
