import { ANALYTICS_LIMITS as L, EXPLORE_DIMENSIONS, EXPLORE_DIMENSION_NAMES, EXPLORE_METRICS, EXPLORE_METRIC_NAMES, FIGURE_TEXT, ROLLUP_STORES } from '../../contracts/analytics.js';
import { ApiError, canSeeRevenue } from '../../contracts/api/index.js';
import { readAll } from './rollup.js';
import { addDays, compareRange, daysBetween, rangeOf } from './time.js';

const ROUND = (value, places) => Number(value.toFixed(places));
const MONEY_RATES = new Set(['revenue_per_session']);

/** What a traffic_daily measure is called in traffic_items_daily, for breakdowns by product or category. */
const ITEM_MEASURES = Object.freeze({ sessions: 'sessions', page_views: 'views', landing_views: 'views', category_views: 'views', product_views: 'views', product_taps: 'taps', outbound_taps: 'outbound_taps', whatsapp_taps: 'whatsapp_taps', add_to_cart: 'add_to_cart', checkout_started: 'checkout_started', orders: 'orders', revenue_paise: 'revenue_paise' });
const ITEM_DIMENSIONS = new Set(['product', 'category']);
const NUMERIC_DIMENSIONS = new Set(['hour', 'weekday']);
const DIMENSION_LABELS = { date: 'Date', hour: 'Hour', weekday: 'Weekday', source: 'Source', utm_source: 'UTM source', utm_medium: 'UTM medium', utm_campaign: 'UTM campaign', utm_content: 'UTM content', content: 'Reel, post or story', category: 'Category', landing_page: 'Landing page', product: 'Product', device: 'Device', os: 'OS', browser: 'Browser', in_app: 'In-app or browser', city: 'City', state: 'State', visitor_type: 'New or returning' };

const refuse = (message) => new ApiError('validation_failed', message);

/** The names in a request are checked against the catalogue here as well as in the schema, so nothing else can ever become part of a query. */
function checkDefinition(def) {
  for (const name of [...def.metrics, ...(def.thresholds ?? []).map((t) => t.metric)]) if (!EXPLORE_METRIC_NAMES.includes(name)) throw refuse('Choose a metric from the list.');
  for (const name of [...(def.dimensions ?? []), ...(def.filters ?? []).map((f) => f.dimension)]) if (!EXPLORE_DIMENSION_NAMES.includes(name)) throw refuse('Choose a breakdown from the list.');
  if ((def.dimensions ?? []).length > L.exploreMaxBreakdowns) throw refuse(`Use at most ${L.exploreMaxBreakdowns} breakdowns.`);
  for (const filter of def.filters ?? []) {
    if (NUMERIC_DIMENSIONS.has(filter.dimension) && !filter.values.every((v) => /^\d{1,2}$/.test(v))) throw refuse('Hour and weekday filters take whole numbers.');
    if (filter.dimension === 'date' && !filter.values.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) throw refuse('Date filters take YYYY-MM-DD.');
  }
  const items = new Set([...(def.dimensions ?? []), ...(def.filters ?? []).map((f) => f.dimension)].filter((d) => ITEM_DIMENSIONS.has(d)));
  if (items.size > 1) throw refuse('Choose product or category, not both.');
}

/** Which rollup can answer a measure, given the columns the query groups or filters by. null: this figure doesn't exist at that level, so it is left empty rather than guessed. */
function place(store, measure, columns) {
  if (columns.has('item_ref')) {
    if (store !== 'traffic_daily' || !Object.hasOwn(ITEM_MEASURES, measure)) return null;
    store = 'traffic_items_daily';
    measure = ITEM_MEASURES[measure];
  }
  const dims = ROLLUP_STORES[store].dimensions;
  for (const column of columns) if (column !== 'item_kind' && !dims.includes(column)) return null;
  return { store, measure };
}

function placements(metric, columns) {
  const def = EXPLORE_METRICS[metric];
  if (def.rate) {
    const [top, bottom] = def.rate.map((m) => place('traffic_daily', m, columns));
    return top && bottom ? { rate: true, top, bottom } : null;
  }
  const plain = place(def.store, def.measure, columns);
  return plain ? { rate: false, plain } : null;
}

const cellKey = ({ store, measure }) => `${store}:${measure}`;

function filtersFor(def) {
  const filters = [];
  const seenItems = new Set();
  for (const f of def.filters ?? []) filters.push({ dimension: EXPLORE_DIMENSIONS[f.dimension], op: f.op, values: f.values });
  for (const name of [...(def.dimensions ?? []), ...(def.filters ?? []).map((f) => f.dimension)]) if (ITEM_DIMENSIONS.has(name)) seenItems.add(name);
  for (const kind of seenItems) filters.push({ dimension: 'item_kind', op: 'include', values: [kind] });
  return filters;
}

function emptyCell() {
  return { value: null, previous: null, change: null, changePercent: null, lowVolume: false };
}

/** Explore: any metric by any dimension, inside one business (7.11). Metrics and dimensions only come from the catalogue, and the rollups only read the current business. */
export function createExplore(ctx, rollupService) {
  const { repos, platform } = ctx;
  const rollups = platform.analytics.rollups;

  async function planAllows() {
    const [pages, commerce] = [await repos.entitlements.can('traffic.pages'), await repos.entitlements.can('traffic.commerce')];
    return (metric) => {
      const min = EXPLORE_METRICS[metric].minTier ?? 0;
      return min >= 3 ? commerce : min >= 2 ? pages : true;
    };
  }

  /** Why a metric can't be shown to this person, or null. */
  function hiddenReason(metric, plan, canRevenue) {
    if (!plan(metric)) return EXPLORE_METRICS[metric].minTier >= 3 ? FIGURE_TEXT.needsTier3 : 'Needs tier 2';
    if (EXPLORE_METRICS[metric].revenue && !canRevenue) return FIGURE_TEXT.ownerOnly;
    return null;
  }

  async function catalog(user) {
    const plan = await planAllows();
    const canRevenue = canSeeRevenue(user);
    return {
      metrics: EXPLORE_METRIC_NAMES.map((name) => {
        const def = EXPLORE_METRICS[name];
        const reason = hiddenReason(name, plan, canRevenue);
        return { name, label: def.label, source: def.source, isRate: Boolean(def.rate), available: !reason, reason };
      }),
      dimensions: EXPLORE_DIMENSION_NAMES.map((name) => ({ name, label: DIMENSION_LABELS[name] ?? name })),
    };
  }

  /** Reads the given metrics for one range. Each result row is keyed by its breakdown columns. Everything is figures only: no row can name a visitor. */
  async function readRange(metrics, columns, def, range) {
    const groupColumns = new Set([...columns, ...(def.filters ?? []).map((f) => EXPLORE_DIMENSIONS[f.dimension])]);
    const filters = filtersFor(def);
    const placed = new Map(metrics.map((m) => [m, placements(m, groupColumns)]));
    const wanted = new Map();
    const add = (p) => (wanted.get(p.store) ?? wanted.set(p.store, new Set()).get(p.store)).add(p.measure);
    for (const p of placed.values()) {
      if (!p) continue;
      if (p.rate) [p.top, p.bottom].forEach(add);
      else add(p.plain);
    }

    const rows = new Map();
    for (const [store, measures] of wanted) {
      const storeFilters = filters.filter((f) => ROLLUP_STORES[store].dimensions.includes(f.dimension));
      const read = await readAll(rollups, store, { measures: [...measures], dimensions: [...columns], filters: storeFilters, since: range.since, until: range.until });
      for (const row of read) {
        const key = JSON.stringify(columns.map((c) => String(row[c])));
        if (!rows.has(key)) rows.set(key, { dims: Object.fromEntries(columns.map((c) => [c, String(row[c])])), cells: {} });
        for (const m of measures) rows.get(key).cells[`${store}:${m}`] = row[m];
      }
    }
    if (!columns.length && !rows.has('[]')) rows.set('[]', { dims: {}, cells: {} });

    return { rows, value(metric, cells) {
      const p = placed.get(metric);
      if (!p) return { value: null, lowVolume: false };
      if (!p.rate) return { value: cells[cellKey(p.plain)] ?? (ROLLUP_STORES[p.plain.store].nullable ? null : 0), lowVolume: false };
      const top = Number(cells[cellKey(p.top)] ?? 0);
      const bottom = Number(cells[cellKey(p.bottom)] ?? 0);
      if (bottom < L.lowVolumeDenominator) return { value: null, lowVolume: true };
      return { value: ROUND(top / bottom, MONEY_RATES.has(metric) ? 2 : 4), lowVolume: false };
    } };
  }

  function cell(current, previous, comparing) {
    const out = emptyCell();
    out.value = current?.value ?? null;
    out.lowVolume = Boolean(current?.lowVolume);
    if (comparing) {
      out.previous = previous?.value ?? null;
      if (out.value !== null && out.previous !== null) {
        out.change = ROUND(out.value - out.previous, 4);
        out.changePercent = out.previous === 0 ? null : ROUND((out.change / Math.abs(out.previous)) * 100, 2);
      }
    }
    return out;
  }

  function sorter(def, shown, columnsByName) {
    const direction = def.sortDirection === 'asc' ? 1 : -1;
    const wantsDate = def.dimensions?.[0] === 'date' || def.dimensions?.[0] === 'hour' || def.dimensions?.[0] === 'weekday';
    const by = def.sortBy ?? (wantsDate ? def.dimensions[0] : def.metrics.find((m) => shown.includes(m)) ?? null);
    if (by && shown.includes(by)) {
      return (a, b) => {
        const left = a.metrics[by].value;
        const right = b.metrics[by].value;
        if (left === null) return right === null ? 0 : 1;
        if (right === null) return -1;
        return (left - right) * direction;
      };
    }
    if (by && columnsByName.has(by)) {
      const dir = def.sortBy ? direction : 1;
      const numeric = NUMERIC_DIMENSIONS.has(by);
      return (a, b) => (numeric ? Number(a.dimensions[by]) - Number(b.dimensions[by]) : a.dimensions[by] < b.dimensions[by] ? -1 : a.dimensions[by] > b.dimensions[by] ? 1 : 0) * dir;
    }
    return () => 0;
  }

  /** `definition` is an ExploreRequest. Pass `allowRevenue: true` only for a caller with no signed-in person, such as a key that has passed its own check. */
  async function query(definition, { user = null, allowRevenue = false } = {}) {
    const def = { dimensions: [], filters: [], thresholds: [], ...definition };
    checkDefinition(def);
    const today = await rollupService.today();
    const range = rangeOf(def, today);
    const previous = compareRange(def, range);
    const plan = await planAllows();
    const canRevenue = allowRevenue || canSeeRevenue(user);

    const hiddenMetrics = def.metrics.filter((m) => hiddenReason(m, plan, canRevenue));
    const shown = def.metrics.filter((m) => !hiddenMetrics.includes(m));
    const thresholds = def.thresholds.filter((t) => !hiddenReason(t.metric, plan, canRevenue));
    const measured = [...new Set([...shown, ...thresholds.map((t) => t.metric)])];
    const columns = def.dimensions.map((d) => EXPLORE_DIMENSIONS[d]);
    if (new Set(columns).size !== columns.length) throw refuse('Choose two different breakdowns.');

    for (const r of previous ? [range, previous] : [range]) await refreshFor(measured, def, r);
    const current = await readRange(measured, columns, def, range);
    const earlier = previous ? await readRange(measured, columns, def, previous) : null;
    const dateColumn = columns.indexOf('day');
    const offset = previous ? daysBetween(previous.since, range.since) : 0;
    const shiftKey = (key) => {
      if (dateColumn === -1) return key;
      const parts = JSON.parse(key);
      parts[dateColumn] = addDays(parts[dateColumn], offset);
      return JSON.stringify(parts);
    };
    const earlierByKey = earlier ? new Map([...earlier.rows].map(([key, row]) => [shiftKey(key), row])) : null;

    const named = (raw) => Object.fromEntries(def.dimensions.map((d, i) => [d, raw[columns[i]]]));
    const out = [];
    for (const [key, row] of current.rows) {
      const metrics = {};
      const prevRow = earlierByKey?.get(key);
      for (const m of measured) metrics[m] = cell(current.value(m, row.cells), prevRow ? earlier.value(m, prevRow.cells) : earlier ? earlier.value(m, {}) : null, Boolean(previous));
      const keep = thresholds.every((t) => {
        const v = metrics[t.metric].value;
        return v !== null && (t.op === 'gte' ? v >= t.value : v <= t.value);
      });
      if (keep) out.push({ dimensions: named(row.dims), metrics: Object.fromEntries(shown.map((m) => [m, metrics[m]])) });
    }
    out.sort(sorter(def, shown, new Set(def.dimensions)));

    // Totals are for everything the filters leave, as 7.10 shows it, whatever a threshold hides from the table.
    const totalsNow = await readRange(shown, [], def, range);
    const totalsThen = previous ? await readRange(shown, [], def, previous) : null;
    const totals = Object.fromEntries(shown.map((m) => [m, cell(totalsNow.value(m, totalsNow.rows.get('[]').cells), totalsThen ? totalsThen.value(m, totalsThen.rows.get('[]').cells) : null, Boolean(previous))]));

    const start = Number(/^\d{1,9}$/.test(def.page ?? '') ? def.page : 0);
    const limit = def.limit ?? L.explorePageRows;
    const rows = out.slice(start, start + limit);
    return {
      columns: shown.map((m) => ({ metric: m, label: EXPLORE_METRICS[m].label, source: EXPLORE_METRICS[m].source, isRate: Boolean(EXPLORE_METRICS[m].rate) })),
      rows,
      totals,
      hiddenMetrics,
      from: range.since,
      to: range.until,
      compareFrom: previous?.since ?? null,
      compareTo: previous?.until ?? null,
      nextPage: start + limit < out.length ? String(start + limit) : null,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async function refreshFor(metrics, def, range) {
    const stores = new Set();
    const columns = new Set([...def.dimensions, ...def.filters.map((f) => f.dimension)].map((d) => EXPLORE_DIMENSIONS[d]));
    for (const m of metrics) {
      const p = placements(m, columns);
      if (!p) continue;
      for (const placedMeasure of p.rate ? [p.top, p.bottom] : [p.plain]) stores.add(placedMeasure.store);
    }
    if (stores.has('traffic_daily')) await rollupService.ensureTrafficDaily(range);
    if (stores.has('traffic_items_daily')) await rollupService.ensureItems(range);
    if (stores.has('funnel_daily')) await rollupService.ensureFunnelDaily(range);
  }

  return { catalog, query };
}
