import { tenantId } from '../../tenancy.js';

/**
 * What a session looks like, and the one way its row in traffic_sessions is rewritten.
 *
 * A session's dimensions are worked out from its first hit, and a rollup write replaces a whole row, so every later hit (and an order paid days later)
 * has to find them again. analytics.rollups has no lookup by session id, and traffic_events has no column for them. Until one is added they are kept as
 * JSON in the outbound_host of the session's first event, which is never an outbound tap in practice. Everything that reads or writes them is in this
 * file, so moving them to a proper column is one change. They hold derived values only: never an IP or a user agent.
 */
export const DIMS_LIKE = '{%';
export const PAID_STATUSES = Object.freeze(['paid', 'shipped', 'delivered']);

export const encodeDims = (dims) => JSON.stringify(dims);

export function decodeDims(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** The row holding this session's dimensions. FOR UPDATE inside a transaction, so two hits on one session take turns. */
export async function loadDims(runner, sessionId, { lock = false } = {}) {
  const [row] = await runner.query(
    `SELECT id, outbound_host FROM traffic_events WHERE tenant_id = $1 AND session_id = $2 AND outbound_host LIKE $3 ORDER BY id LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [tenantId(), sessionId, DIMS_LIKE],
  );
  const dims = decodeDims(row?.outbound_host);
  return dims ? { rowId: row.id, dims } : null;
}

/** Every counter for one session, always recounted from its events, so a lost write mends itself at the next hit. */
export async function countSession(runner, sessionId) {
  const tid = tenantId();
  const [c] = await runner.query(
    `SELECT count(*) FILTER (WHERE name = 'page_view')::int AS page_view,
            count(*) FILTER (WHERE name = 'landing_view')::int AS landing_view,
            count(*) FILTER (WHERE name = 'page_view' AND page_kind = 'landing')::int AS landing_page,
            count(*) FILTER (WHERE name = 'category_view')::int AS category_view,
            count(*) FILTER (WHERE name = 'page_view' AND page_kind = 'category')::int AS category_page,
            count(*) FILTER (WHERE name = 'product_view')::int AS product_view,
            count(*) FILTER (WHERE name = 'page_view' AND page_kind = 'product')::int AS product_page,
            count(*) FILTER (WHERE name = 'product_tap')::int AS product_taps,
            count(*) FILTER (WHERE name = 'outbound_tap')::int AS outbound_taps,
            count(*) FILTER (WHERE name = 'whatsapp_tap')::int AS whatsapp_taps,
            count(*) FILTER (WHERE name = 'add_to_cart')::int AS add_to_cart,
            count(*) FILTER (WHERE name = 'checkout_started')::int AS checkout_started,
            count(*) FILTER (WHERE name = 'payment_success')::int AS payment_success
     FROM traffic_events WHERE tenant_id = $1 AND session_id = $2`,
    [tid, sessionId],
  );
  // Revenue counts paid, shipped and delivered orders only, read from the order itself: a browser can't claim a sale (7.4).
  const [money] = await runner.query(
    `SELECT count(*)::int AS orders, COALESCE(sum(o.total_paise), 0)::bigint AS revenue_paise
     FROM traffic_events e JOIN orders o ON o.tenant_id = e.tenant_id AND o.id = e.order_id
     WHERE e.tenant_id = $1 AND e.session_id = $2 AND e.name = 'order' AND o.status = ANY($3::text[])`,
    [tid, sessionId, PAID_STATUSES],
  );
  // A page load sends one page_view and, on some pages, one more specific view. Whichever is larger is the number of pages seen.
  const views = Math.max(c.page_view, c.landing_view + c.category_view + c.product_view);
  return {
    page_views: views,
    landing_views: Math.max(c.landing_view, c.landing_page),
    category_views: Math.max(c.category_view, c.category_page),
    product_views: Math.max(c.product_view, c.product_page),
    product_taps: c.product_taps,
    outbound_taps: c.outbound_taps,
    whatsapp_taps: c.whatsapp_taps,
    add_to_cart: c.add_to_cart,
    checkout_started: c.checkout_started,
    payment_success: c.payment_success,
    orders: money.orders,
    revenue_paise: Number(money.revenue_paise),
  };
}

const DIMENSION_FIELDS = ['day', 'hour', 'weekday', 'source', 'referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'media_id', 'landing_page', 'device', 'os', 'browser', 'in_app', 'city', 'state', 'visitor_type'];

/** The traffic_sessions row for a session. */
export function sessionRow(sessionId, dims, counters) {
  const row = { session_id: sessionId, visitor_id: dims.visitor_id ?? null, started_at: dims.started_at, last_hit_at: dims.last_hit_at, engaged_ms: dims.engaged_ms ?? 0, bounced: counters.page_views <= 1 ? 1 : 0, ...counters };
  for (const field of DIMENSION_FIELDS) row[field] = dims[field] ?? (field === 'hour' || field === 'weekday' ? 0 : '');
  return row;
}

export const writeSession = (rollups, sessionId, dims, counters) => rollups.write('traffic_sessions', [sessionRow(sessionId, dims, counters)]);
