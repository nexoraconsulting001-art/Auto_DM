import { useQuery } from '@tanstack/react-query';
import { Chip, ChipRow, EmptyState, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useFilters } from '../../lib/query.js';
import { ANALYTICS_LIMITS } from './shared/catalog.js';
import { shares } from './shared/figures.js';
import { AnalyticsLoadable, BarList, InsightsTabs, LastUpdated, SourceTag } from './shared/ui.jsx';
import { DEMOGRAPHIC_WORDS, GENDER_WORDS, TIMEFRAME_WORDS, formatRate, wordFor } from './shared/words.js';

const TOP = 8;

function Breakdown({ group }) {
  const items = shares(group.items.map((item) => ({ ...item })), 'value')
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP)
    .map((item) => ({ key: item.key, label: group.breakdown === 'gender' ? wordFor(GENDER_WORDS, item.key) : item.key, value: item.value, note: formatRate(item.share, 0) }));
  return (
    <div className="stack">
      <h3>{wordFor(DEMOGRAPHIC_WORDS, group.breakdown)}</h3>
      <BarList label={wordFor(DEMOGRAPHIC_WORDS, group.breakdown)} items={items} />
    </div>
  );
}

function Audience({ audience }) {
  // Under 100 followers Instagram shares no demographics. That is a notice, not an error (N-02).
  if (!audience.available) return <EmptyState title={audience.message ?? 'Not available yet'}>Instagram shares who your audience is once an account has enough followers to keep people anonymous.</EmptyState>;
  return (
    <>
      <Panel title="Your followers" action={<SourceTag source={audience.source} />}>
        {audience.followers.length ? audience.followers.map((group) => <Breakdown key={group.breakdown} group={group} />) : <p className="muted">No data for this period yet.</p>}
      </Panel>
      <Panel title="People who engaged" action={<SourceTag source={audience.source} />}>
        {audience.engaged.length ? audience.engaged.map((group) => <Breakdown key={group.breakdown} group={group} />) : <p className="muted">No data for this period yet.</p>}
      </Panel>
      <LastUpdated at={audience.lastUpdatedAt} />
    </>
  );
}

/** Who follows and who engages (7.1): age, gender, city and country, for this week or this month only, as Instagram allows. */
export default function AudiencePage() {
  const [params, setFilter] = useFilters();
  const timeframe = ANALYTICS_LIMITS.demographicsTimeframes.includes(params.get('timeframe')) ? params.get('timeframe') : 'this_month';
  const audience = useQuery({ queryKey: ['insights', 'audience', timeframe], queryFn: () => api.insights.audience({ timeframe }) });
  return (
    <>
      <PageHeader eyebrow="Insights" title="Audience" />
      <InsightsTabs />
      <ChipRow label="Period">
        {ANALYTICS_LIMITS.demographicsTimeframes.map((value) => (
          <Chip key={value} pressed={value === timeframe} onClick={() => setFilter('timeframe', value === 'this_month' ? '' : value)}>{wordFor(TIMEFRAME_WORDS, value)}</Chip>
        ))}
      </ChipRow>
      <AnalyticsLoadable query={audience} label="Loading your audience" errorTitle="We couldn’t load your audience">
        {(data) => <Audience audience={data} />}
      </AnalyticsLoadable>
    </>
  );
}
