import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { canSeeRevenue } from '@contracts/access.js';
import { Chip, ChipRow, EmptyState, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useFilters } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { FIGURE_TEXT } from '../insights/shared/catalog.js';
import { DownloadButtons } from '../insights/shared/download.jsx';
import { AnalyticsLoadable, LastUpdated, RangeBar, SourceTag, TrafficTabs, useRange } from '../insights/shared/ui.jsx';
import { TRAFFIC_SOURCE_WORDS, formatCount, formatDay, formatMoney, formatRate, wordFor } from '../insights/shared/words.js';

const KINDS = [{ value: 'visitors', label: 'Visitors' }, { value: 'buyers', label: 'Buyers' }];
const GROUPS = [{ value: 'first_week', label: 'First visit week' }, { value: 'first_month', label: 'First visit month' }, { value: 'first_source', label: 'First source' }];

const cohortName = (groupBy, key) => (groupBy === 'first_source' ? wordFor(TRAFFIC_SOURCE_WORDS, key) : formatDay(key, { year: true }) || key);

function VisitorTable({ result }) {
  const unit = result.groupBy === 'first_month' ? 'Month' : 'Week';
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <caption className="sr-only">Share of each group that came back in each later period</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Visitors</th>
            {Array.from({ length: result.periods }, (_, i) => <th key={i} scope="col">{`${unit} ${i + 1}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((row) => (
            <tr key={row.key}>
              <th scope="row">{cohortName(result.groupBy, row.key)}</th>
              <td>{formatCount(row.size)}</td>
              {row.lowVolume
                ? <td colSpan={Math.max(1, result.periods)}>{FIGURE_TEXT.lowVolume}</td>
                : Array.from({ length: result.periods }, (_, i) => <td key={i}>{typeof row.rates[i] === 'number' ? formatRate(row.rates[i], 0) : '–'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BuyerTable({ result, money }) {
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <caption className="sr-only">Buyers by the month of their first order</caption>
        <thead>
          <tr>
            <th scope="col">First order</th>
            <th scope="col">Buyers</th>
            <th scope="col">Ordered again</th>
            {money && <th scope="col">Revenue per buyer</th>}
          </tr>
        </thead>
        <tbody>
          {result.cohorts.map((row) => (
            <tr key={row.key}>
              <th scope="row">{cohortName(result.groupBy, row.key)}</th>
              <td>{formatCount(row.size)}</td>
              <td>{row.lowVolume ? FIGURE_TEXT.lowVolume : formatRate(row.repeatOrderRate, 0) || '–'}</td>
              {money && <td>{row.lowVolume ? FIGURE_TEXT.lowVolume : formatMoney(row.revenuePerBuyerPaise) || '–'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Do visitors and buyers come back (7.12)? Counts only, never who; a group under 20 shows "low volume" and no rate (N-59). */
export default function CohortsPage() {
  const { session } = useSession();
  const [params, setFilter] = useFilters();
  const [range, setRange, asked] = useRange('90');
  const kind = KINDS.some((k) => k.value === params.get('kind')) ? params.get('kind') : 'visitors';
  const groupBy = GROUPS.some((g) => g.value === params.get('group')) ? params.get('group') : 'first_week';
  const query = { ...range, kind, groupBy };
  const cohorts = useQuery({ queryKey: ['cohorts', query], queryFn: () => api.cohorts.get(query), placeholderData: keepPreviousData });
  const money = canSeeRevenue(session.user);

  return (
    <>
      <PageHeader eyebrow="Traffic" title="Cohorts" />
      <TrafficTabs />
      <ChipRow label="Who">
        {KINDS.map((k) => <Chip key={k.value} pressed={k.value === kind} onClick={() => setFilter('kind', k.value === 'visitors' ? '' : k.value)}>{k.label}</Chip>)}
      </ChipRow>
      {kind === 'visitors' && (
        <ChipRow label="Group by">
          {GROUPS.map((g) => <Chip key={g.value} pressed={g.value === groupBy} onClick={() => setFilter('group', g.value === 'first_week' ? '' : g.value)}>{g.label}</Chip>)}
        </ChipRow>
      )}
      <RangeBar query={range} onChange={setRange} asked={asked} />
      <Panel title={kind === 'buyers' ? 'Do buyers order again?' : 'Do visitors come back?'} action={<SourceTag source="bhava" />}>
        <AnalyticsLoadable query={cohorts} label="Grouping your visitors" errorTitle="We couldn’t group your visitors">
          {(result) => (result.cohorts.length ? (
            <>
              {result.kind === 'buyers' ? <BuyerTable result={result} money={money} /> : <VisitorTable result={result} />}
              <p className="muted">{`Groups of fewer than 20 show “${FIGURE_TEXT.lowVolume}”. Shoppers with cookies off are counted per visit only and aren’t in any group.`}</p>
              <LastUpdated at={result.lastUpdatedAt} prefix="Worked out" />
            </>
          ) : <EmptyState title="No groups yet">Once shoppers visit on more than one day, you’ll see how many come back.</EmptyState>)}
        </AnalyticsLoadable>
      </Panel>
      <Panel title="Download">
        <DownloadButtons label="Download these groups" request={() => ({ source: 'cohort', cohort: query })} />
      </Panel>
    </>
  );
}
