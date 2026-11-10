import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { canSeeRevenue } from '@contracts/access.js';
import { Badge, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, SelectField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { FIGURE_TEXT } from './shared/catalog.js';
import { KIND_FILTERS, bestHour, heatmap } from './shared/figures.js';
import { AnalyticsLoadable, Heatmap, InsightsTabs, SourceTag } from './shared/ui.jsx';
import { KIND_WORDS, formatCount, formatMoney, wordFor } from './shared/words.js';

export const RANKS = Object.freeze([
  { value: 'views', label: 'Views' },
  { value: 'reach', label: 'Reach' },
  { value: 'interactions', label: 'Interactions' },
  { value: 'dms', label: 'DMs' },
  { value: 'taps_or_visits', label: 'Taps or visits' },
  { value: 'sales', label: 'Sales', revenue: true },
]);
const MODES = [{ value: 'all', label: 'Any link' }, { value: 'one_tap', label: 'One tap' }, { value: 'two_tap', label: 'Two taps' }];
const DAYS = ['7', '30', '90'];

const pick = (list, value, fallback) => (list.some((item) => item.value === value) ? value : fallback);

function Ranking({ query, rank }) {
  const first = query.data?.pages[0];
  if (!query.items.length) return <EmptyState title="Nothing to rank yet">Posts from these days appear here once Instagram has figures for them.</EmptyState>;
  return (
    <>
      <div className="an-meta">
        <SourceTag source={first.source} />
        {first.comparedAtAgeDays !== null && <span className="an-updated">{`Compared at the same age: day ${first.comparedAtAgeDays}, so older posts don’t win on time alone.`}</span>}
      </div>
      <ol className="an-rows">
        {query.items.map((item, index) => (
          <li key={item.mediaId}>
            <Link className="an-row" to={`/analytics/funnels/${encodeURIComponent(item.mediaId)}`}>
              <span className="an-rank" aria-hidden="true">{index + 1}</span>
              <Thumb src={item.thumbnailUrl} />
              <span className="an-row-main">
                <span className="an-row-title">{item.caption || 'No caption'}</span>
                <span className="an-badges"><Badge>{wordFor(KIND_WORDS, item.kind)}</Badge><span className="an-row-meta">{`${item.ageDays} ${item.ageDays === 1 ? 'day' : 'days'} old`}</span></span>
              </span>
              <span className="an-row-end">{item.value === null ? FIGURE_TEXT.noData : rank === 'sales' ? formatMoney(item.value) : formatCount(item.value)}</span>
            </Link>
          </li>
        ))}
      </ol>
      <LoadMore query={query} />
    </>
  );
}

function BestTime({ best }) {
  // Under 20 posts in 90 days, and no online_followers, there is no suggestion and no heatmap at all (N-22).
  if (!best.available) return <EmptyState title={best.message ?? FIGURE_TEXT.notEnoughPosts}>A suggestion needs 20 posts in the last 90 days, or Instagram’s figures for when your followers are online.</EmptyState>;
  const grid = heatmap(best.cells, { combine: 'mean' });
  return (
    <>
      <p className="an-peak"><Clock size={16} strokeWidth={1.8} aria-hidden="true" />{`${best.label}: ${bestHour(best.cells)}`}</p>
      <Heatmap grid={grid} label={best.basis === 'online_followers' ? 'When your followers are online, by weekday and time' : 'Average reach of posts by the weekday and time they went up'} unit={best.basis === 'online_followers' ? 'followers online' : 'average reach'} />
      <p className="muted">{`Times are in ${best.timeZone}. ${best.basis === 'online_followers' ? 'Based on when your followers are online.' : 'Based on the average reach of your posts from the last 90 days.'}`}</p>
    </>
  );
}

/** The best content, ranked at the same age (7.5), and a suggested time to post. */
export default function TopPage() {
  const { session } = useSession();
  const [params, setFilter] = useFilters();
  const ranks = RANKS.filter((r) => !r.revenue || canSeeRevenue(session.user));
  const rank = pick(ranks, params.get('rank'), 'views');
  const kind = pick(KIND_FILTERS, params.get('kind'), 'all');
  const linkMode = pick(MODES, params.get('mode'), 'all');
  const days = DAYS.includes(params.get('days')) ? params.get('days') : '30';
  const top = usePagedList('insights-top', api.insights.top, { rank, kind, linkMode, days });
  const best = useQuery({ queryKey: ['insights', 'best-time'], queryFn: () => api.insights.bestTime() });

  return (
    <>
      <PageHeader eyebrow="Insights" title="Top content" />
      <InsightsTabs />
      <ChipRow label="Rank by">
        {ranks.map((r) => <Chip key={r.value} pressed={r.value === rank} onClick={() => setFilter('rank', r.value === 'views' ? '' : r.value)}>{r.label}</Chip>)}
      </ChipRow>
      <div className="an-inline">
        <SelectField label="Type" value={kind} onChange={(event) => setFilter('kind', event.target.value === 'all' ? '' : event.target.value)}>
          {KIND_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </SelectField>
        <SelectField label="Posted in the last" value={days} onChange={(event) => setFilter('days', event.target.value === '30' ? '' : event.target.value)}>
          {DAYS.map((d) => <option key={d} value={d}>{`${d} days`}</option>)}
        </SelectField>
      </div>
      <ChipRow label="Link">
        {MODES.map((m) => <Chip key={m.value} pressed={m.value === linkMode} onClick={() => setFilter('mode', m.value === 'all' ? '' : m.value)}>{m.label}</Chip>)}
      </ChipRow>
      <Panel title="Ranked">
        <AnalyticsLoadable query={top} label="Ranking your posts" errorTitle="We couldn’t rank your posts">
          {() => <Ranking query={top} rank={rank} />}
        </AnalyticsLoadable>
      </Panel>
      <Panel title="Best time to post" action={<Badge tone="warn">{FIGURE_TEXT.suggested}</Badge>}>
        <AnalyticsLoadable query={best} label="Working out the best time to post" errorTitle="We couldn’t work out the best time to post">
          {(data) => (
            <>
              <BestTime best={data} />
              {data.available && <SourceTag source="platform" />}
            </>
          )}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
