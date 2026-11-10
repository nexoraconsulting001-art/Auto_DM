import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { canSeeRevenue } from '@contracts/access.js';
import { Card, Chip, ChipRow, EmptyState, PageHeader, Panel, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useSession } from '../../lib/session.jsx';
import { ANALYTICS_LIMITS, FIGURE_TEXT, PAGE_KINDS } from '../insights/shared/catalog.js';
import { TRAFFIC_TILES, heatmap, rangeWords, shares, trafficTile } from '../insights/shared/figures.js';
import { AnalyticsLoadable, BarList, FigureTile, Heatmap, LastUpdated, LineChart, RangeBar, SourceTag, TrafficTabs, useRange } from '../insights/shared/ui.jsx';
import { PAGE_KIND_WORDS, TRAFFIC_SOURCE_WORDS, breakdownValue, changeWords, formatCount, formatMoney, formatRate, wordFor } from '../insights/shared/words.js';

export const BREAKDOWNS = Object.freeze([
  { value: 'in_app', label: 'Opened in' },
  { value: 'device', label: 'Device' },
  { value: 'os', label: 'System' },
  { value: 'browser', label: 'Browser' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'visitor_type', label: 'New or returning' },
  { value: 'utm_campaign', label: 'Campaign' },
]);

function useCompare() {
  const [params, setParams] = useSearchParams();
  const compare = params.get('compare') === 'previous' ? 'previous' : 'none';
  const setCompare = (on) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (on) next.set('compare', 'previous');
    else next.delete('compare');
    return next;
  }, { replace: true });
  return [compare, setCompare];
}

function Hero({ summary, trend, live, query, compare }) {
  const sessions = summary.sessions;
  const change = compare === 'previous' ? changeWords(sessions.changePercent) : '';
  const tone = (sessions.changePercent ?? 0) > 0 ? 'an-pill-up' : (sessions.changePercent ?? 0) < 0 ? 'an-pill-down' : 'an-pill-flat';
  return (
    <Card ink aria-labelledby="traffic-hero">
      <div className="an-hero-head">
        <span className="an-hero-title" id="traffic-hero">{`Sessions · ${rangeWords(query).replace('the ', '')}`}</span>
        {live && <span className="an-pill an-pill-ink"><span className="an-live-dot" aria-hidden="true" /><span><strong>{formatCount(live.active)}</strong> live now</span></span>}
      </div>
      <span className="an-hero-value">{sessions.value === null ? FIGURE_TEXT.noData : formatCount(sessions.value)}<span className="sr-only">{` sessions in ${rangeWords(query)}`}</span></span>
      <span className="an-hero-sub">
        {change && <span className={`an-pill ${tone}`}>{change}</span>}
        {summary.previews > 0 && <span>{`${formatCount(summary.previews)} ${summary.previews === 1 ? 'preview' : 'previews'} by you, your team or link checkers not counted`}</span>}
      </span>
      {trend && <LineChart days={trend.points.map((p) => ({ day: p.day, value: p.sessions }))} previous={compare === 'previous' ? trend.points.map((p) => p.previous) : null} label="Sessions" onInk />}
      <SourceTag source={summary.source} onInk />
    </Card>
  );
}

function Tiles({ summary }) {
  const { session } = useSession();
  const tiles = TRAFFIC_TILES.map((tile) => trafficTile(tile, summary, { canSeeRevenue: canSeeRevenue(session.user) })).filter(Boolean);
  return (
    <section className="stack" aria-label="Key numbers">
      <div className="panel-head"><h2>Key numbers</h2><SourceTag source={summary.source} /></div>
      <div className="an-tiles">
        {tiles.map((tile) => (
          <FigureTile key={tile.key} label={tile.label} value={tile.value} note={tile.change ? <span className={tile.direction > 0 ? 'an-tile-note-up' : tile.direction < 0 ? 'an-tile-note-down' : ''}>{tile.change}</span> : null} />
        ))}
      </div>
      <LastUpdated at={summary.lastUpdatedAt} prefix="Last visit counted" />
    </section>
  );
}

/** The last 30 minutes, every 15 seconds (7.10). */
function Realtime({ live }) {
  return (
    <Panel title="Right now" action={<SourceTag source="bhava" />}>
      <AnalyticsLoadable query={live} label="Checking who’s on your pages" errorTitle="We couldn’t check who’s on your pages">
        {(data) => (
          <>
            <p className="an-score"><span className="an-score-number">{formatCount(data.active)}</span><span className="muted">{`${data.active === 1 ? 'person' : 'people'} on your pages in the last 30 minutes`}</span></p>
            {data.topPages.length > 0 && (
              <div className="stack">
                <h3>Top pages</h3>
                <BarList label="Top pages now" items={data.topPages.map((p) => ({ key: p.ref || p.title, label: p.title || p.ref || 'A page', value: p.active }))} />
              </div>
            )}
            {data.topSources.length > 0 && (
              <div className="stack">
                <h3>Where from</h3>
                <BarList label="Sources now" items={data.topSources.map((s) => ({ key: s.source, label: wordFor(TRAFFIC_SOURCE_WORDS, s.source), value: s.active }))} />
              </div>
            )}
            <p className="muted">{`Updates every ${ANALYTICS_LIMITS.realtimeRefreshMs / 1000} seconds.`}</p>
          </>
        )}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Sources({ query }) {
  const { session } = useSession();
  const money = canSeeRevenue(session.user);
  const sources = useQuery({ queryKey: ['traffic', 'sources', query], queryFn: () => api.traffic.sources(query), placeholderData: keepPreviousData });
  return (
    <Panel title="Where they come from" action={<SourceTag source="bhava" />}>
      <AnalyticsLoadable query={sources} label="Loading where visits come from" errorTitle="We couldn’t load where visits come from">
        {(data) => {
          if (!data.items.length) return <EmptyState title="No visits yet">Visits to your store pages from DM links, your bio and elsewhere show up here.</EmptyState>;
          const showOrders = money && data.items.some((row) => row.orders !== null);
          const withShare = shares(data.items, 'sessions');
          return (
            <div className="an-table-wrap">
              <table className="an-table">
                <caption className="sr-only">Sessions by source</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Sessions</th>
                    <th scope="col">Visitors</th>
                    <th scope="col">Taps</th>
                    {showOrders && <th scope="col">Orders</th>}
                  </tr>
                </thead>
                <tbody>
                  {withShare.map((row) => (
                    <tr key={`${row.source}:${row.referrerDomain}`}>
                      <th scope="row">
                        {wordFor(TRAFFIC_SOURCE_WORDS, row.source)}
                        {row.referrerDomain && <span className="an-col-source">{row.referrerDomain}</span>}
                        <span className="an-col-source">{formatRate(row.share, 0)}</span>
                      </th>
                      <td>{formatCount(row.sessions)}</td>
                      <td>{formatCount(row.visitors)}</td>
                      <td>{row.productTaps === null ? '–' : formatCount(row.productTaps)}</td>
                      {showOrders && <td>{row.orders === null ? '–' : formatCount(row.orders)}{row.revenuePaise ? <span className="an-cell-change">{formatMoney(row.revenuePaise)}</span> : null}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </AnalyticsLoadable>
    </Panel>
  );
}

function When({ query }) {
  const heat = useQuery({ queryKey: ['traffic', 'heatmap', query], queryFn: () => api.traffic.heatmap(query), placeholderData: keepPreviousData });
  return (
    <Panel title="When they come" action={<SourceTag source="bhava" />}>
      <AnalyticsLoadable query={heat} label="Loading when visits happen" errorTitle="We couldn’t load when visits happen">
        {(data) => {
          const grid = heatmap(data.cells, { value: 'sessions', combine: 'sum' });
          if (grid.empty) return <p className="muted">{`${FIGURE_TEXT.noData} for these days yet.`}</p>;
          return (
            <>
              <Heatmap grid={grid} label="Sessions by weekday and two-hour block" />
              {grid.peak && <p className="an-peak">{`Busiest: ${grid.peak.label}`}</p>}
              <p className="muted">{`Times are in ${data.timeZone}.`}</p>
            </>
          );
        }}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Who({ query }) {
  const [params, setParams] = useSearchParams();
  const by = BREAKDOWNS.some((b) => b.value === params.get('by')) ? params.get('by') : 'in_app';
  const breakdown = useQuery({ queryKey: ['traffic', 'breakdown', by, query], queryFn: () => api.traffic.breakdown({ ...query, by }), placeholderData: keepPreviousData });
  const choose = (value) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value === 'in_app') next.delete('by');
    else next.set('by', value);
    return next;
  }, { replace: true });
  return (
    <Panel title="Who they are" action={<SourceTag source="bhava" />}>
      <ChipRow label="Break down by">
        {BREAKDOWNS.map((b) => <Chip key={b.value} pressed={b.value === by} onClick={() => choose(b.value)}>{b.label}</Chip>)}
      </ChipRow>
      <AnalyticsLoadable query={breakdown} label="Loading who visits" errorTitle="We couldn’t load who visits">
        {(data) => {
          const items = shares(data.items, 'sessions').map((item) => ({ key: item.key || '(none)', label: breakdownValue(by, item.key), value: item.sessions, note: formatRate(item.share, 0) }));
          return items.length ? <BarList label={`Sessions by ${by}`} items={items} /> : <p className="muted">{`${FIGURE_TEXT.noData} for these days yet.`}</p>;
        }}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Pages({ query }) {
  const [params, setParams] = useSearchParams();
  const kind = PAGE_KINDS.includes(params.get('pages')) ? params.get('pages') : 'all';
  const pages = useQuery({ queryKey: ['traffic', 'pages', kind, query], queryFn: () => api.traffic.pages({ ...query, kind }), placeholderData: keepPreviousData });
  const choose = (value) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value === 'all') next.delete('pages');
    else next.set('pages', value);
    return next;
  }, { replace: true });
  return (
    <Panel title="What they open" action={<SourceTag source="bhava" />}>
      <ChipRow label="Kind of page">
        {['all', 'landing', 'product', 'category', 'link_in_bio', 'store'].map((value) => <Chip key={value} pressed={value === kind} onClick={() => choose(value)}>{value === 'all' ? 'All pages' : wordFor(PAGE_KIND_WORDS, value)}</Chip>)}
      </ChipRow>
      <AnalyticsLoadable query={pages} label="Loading your pages" errorTitle="We couldn’t load your pages">
        {(data) => (data.items.length ? (
          <div className="an-rows">
            {data.items.map((page) => (
              <div key={`${page.kind}:${page.ref}`} className="an-row">
                <span className="an-row-main">
                  <span className="an-row-title">{page.title || page.ref || 'A page'}</span>
                  <span className="an-row-meta">{wordFor(PAGE_KIND_WORDS, page.kind)}</span>
                </span>
                <span className="an-row-end">
                  <span>{`${formatCount(page.views)} views`}</span>
                  <span className="an-row-meta">{`${formatCount(page.taps)} taps`}</span>
                </span>
              </div>
            ))}
          </div>
        ) : <p className="muted">Page views appear here from tier 2, once shoppers open your landing, product and category pages.</p>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

/** Where every visit to the seller's own pages comes from and what it does (7.10). Visits on other sites are never Bhava's traffic. */
export default function TrafficPage() {
  const [range, setRange, asked] = useRange('7');
  const [compare, setCompare] = useCompare();
  const query = { ...range, compare };
  const summary = useQuery({ queryKey: ['traffic', 'summary', query], queryFn: () => api.traffic.summary(query), placeholderData: keepPreviousData });
  const trend = useQuery({ queryKey: ['traffic', 'trend', query], queryFn: () => api.traffic.trend(query), placeholderData: keepPreviousData });
  const live = useQuery({ queryKey: ['traffic', 'realtime'], queryFn: () => api.traffic.realtime(), refetchInterval: ANALYTICS_LIMITS.realtimeRefreshMs });

  return (
    <>
      <PageHeader eyebrow="Insights" title="Traffic" />
      <TrafficTabs />
      <p className="lead">Where shoppers come from, what they open and when. Visits on your own site or Amazon are counted there, not here.</p>
      <RangeBar query={range} onChange={setRange} asked={asked} />
      <Toggle label="Compare with the period before" checked={compare === 'previous'} onChange={(event) => setCompare(event.target.checked)} />
      <AnalyticsLoadable query={summary} label="Loading your traffic" errorTitle="We couldn’t load your traffic">
        {(data) => (
          <>
            <Hero summary={data} trend={trend.data} live={live.data} query={range} compare={compare} />
            <Tiles summary={data} />
          </>
        )}
      </AnalyticsLoadable>
      <Realtime live={live} />
      <Sources query={query} />
      <When query={query} />
      <Who query={query} />
      <Pages query={query} />
    </>
  );
}
