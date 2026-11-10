import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { ANALYTICS_LIMITS, FIGURE_TEXT } from './shared/catalog.js';
import { followerSummary, newestFirst, orderMetrics } from './shared/figures.js';
import { AnalyticsLoadable, BarList, EstimatedNote, FigureTile, InsightsTabs, LastUpdated, LineChart, PermissionNeeded, RangeBar, SourceTag, useRange } from './shared/ui.jsx';
import { BREAKDOWN_WORDS, MAY_CHANGE_NOTE, figureText, formatCount, formatDay, gapNote, metaValue, wordFor } from './shared/words.js';

const SHOWN_DAYS = 14;

/** Refresh now (7.8): at most once every 15 minutes, and never while Instagram has asked for a pause. It only brings the next fetch forward. */
export function RefreshNow({ lastUpdatedAt }) {
  const queries = useQueryClient();
  const [message, setMessage] = useState('');
  const refresh = useMutation({
    mutationFn: () => api.insights.refresh(),
    onSuccess: async (result) => {
      setMessage(result.message);
      await queries.invalidateQueries({ queryKey: ['insights'] });
    },
    onError: (error) => setMessage(error.message),
  });
  return (
    <div className="an-meta">
      <LastUpdated at={lastUpdatedAt} />
      <span className="an-meta-actions">
        <Button variant="outline" loading={refresh.isPending} onClick={() => refresh.mutate()}>
          <RefreshCw size={16} strokeWidth={1.8} aria-hidden="true" />
          Refresh now
        </Button>
        <span className="an-message" role="status">{message}</span>
      </span>
    </div>
  );
}

function StatusNotes({ status }) {
  if (!status.connected) return null;
  return (
    <>
      {status.permission === 'needed' && <PermissionNeeded />}
      {status.collectingSince && <p className="muted">{`Collecting since ${formatDay(status.collectingSince, { year: true })}. Instagram keeps account figures for ${ANALYTICS_LIMITS.accountRetentionDays} days, so older days come from what Bhava has stored.`}</p>}
    </>
  );
}

function NotConnected() {
  return (
    <EmptyState title="Connect Instagram to see your insights" action={<Button as={Link} to="/connect">Connect Instagram</Button>}>
      Bhava reads your reach, views and audience from Instagram once it’s connected, and keeps them here.
    </EmptyState>
  );
}

function DayList({ metric }) {
  const [all, setAll] = useState(false);
  const days = newestFirst(metric.days);
  const shown = all ? days : days.slice(0, SHOWN_DAYS);
  return (
    <Panel title="Day by day" action={<SourceTag source="platform" />}>
      <div className="an-days" role="list" aria-label={`${metric.label}, day by day`}>
        {shown.map((day) => (
          <div key={day.day} className="an-day" role="listitem">
            <span className="an-day-when">
              {formatDay(day.day, { year: true })}
              {day.mayChange && <Badge tone="warn">{FIGURE_TEXT.mayChange}</Badge>}
            </span>
            <span className={day.state === 'ok' ? 'an-day-value' : 'an-day-value an-day-empty'}>{figureText(day.value, day.state)}</span>
          </div>
        ))}
      </div>
      {days.length > SHOWN_DAYS && <Button variant="soft" block onClick={() => setAll(!all)}>{all ? 'Show fewer days' : `Show all ${days.length} days`}</Button>}
      <p className="muted">{MAY_CHANGE_NOTE}</p>
    </Panel>
  );
}

function Breakdowns({ metric }) {
  if (!metric.breakdowns.length) return null;
  return (
    <Panel title={`${metric.label}, broken down`} action={<SourceTag source="platform" />}>
      {metric.breakdowns.map((group) => (
        <div key={group.breakdown} className="stack">
          <h3>{wordFor(BREAKDOWN_WORDS, group.breakdown, group.breakdown)}</h3>
          <BarList label={wordFor(BREAKDOWN_WORDS, group.breakdown, group.breakdown)} items={group.items.map((item) => ({ key: item.key, label: metaValue(item.key), value: item.value }))} />
        </div>
      ))}
    </Panel>
  );
}

function Followers({ days }) {
  const summary = followerSummary(days);
  return (
    <Panel title="Followers" action={<SourceTag source="platform" />}>
      <dl className="an-facts">
        <div><dt>Latest</dt><dd>{summary.latest === null ? FIGURE_TEXT.noData : formatCount(summary.latest)}</dd></div>
        <div><dt>Change in this range</dt><dd>{summary.change === null ? FIGURE_TEXT.noData : `${summary.change > 0 ? '+' : ''}${formatCount(summary.change)}`}</dd></div>
        <div><dt>Counted on</dt><dd>{summary.day ? formatDay(summary.day) : FIGURE_TEXT.noData}</dd></div>
      </dl>
      <LineChart days={days} label="Followers" mayChange={days.filter((d) => d.mayChange).length} />
    </Panel>
  );
}

function Account({ data, status }) {
  const metrics = orderMetrics(data.metrics);
  const [picked, setPicked] = useState('views');
  const metric = metrics.find((m) => m.metric === picked) ?? metrics[0];
  if (status && !status.connected && !data.lastUpdatedAt) return <NotConnected />;
  if (!metric) return <EmptyState title="No figures yet">{FIGURE_TEXT.noData}. Figures appear about two days after each day ends.</EmptyState>;
  const recent = metric.days.filter((d) => d.mayChange).length;
  const collected = metric.days.some((d) => d.state !== 'not_collected');

  return (
    <>
      <Card ink aria-labelledby="account-hero">
        <div className="an-hero-head">
          <span className="an-hero-title" id="account-hero">{metric.label}</span>
          <SourceTag source={data.source} onInk />
        </div>
        <span className="an-hero-value">{metric.total === null ? FIGURE_TEXT.noData : formatCount(metric.total)}<span className="sr-only">{` from ${data.from} to ${data.to}`}</span></span>
        <span className="an-hero-sub">
          {`${formatDay(data.from)} to ${formatDay(data.to)}`}
          {gapNote(metric.gapDays) && <span>{gapNote(metric.gapDays)}</span>}
        </span>
        {metric.estimated && <EstimatedNote onInk />}
        <LineChart days={metric.days} label={metric.label} mayChange={recent} onInk />
      </Card>
      {!collected && <EmptyState title={FIGURE_TEXT.notCollected}>These days are from before Instagram was connected to Bhava, so there is nothing stored for them.</EmptyState>}
      <RefreshNow lastUpdatedAt={data.lastUpdatedAt ?? status?.lastUpdatedAt ?? null} />
      {status?.nextRefreshAt && <p className="muted">{`You can refresh again after ${formatDateTime(status.nextRefreshAt)}.`}</p>}
      <section aria-label="Every figure" className="stack">
        <div className="panel-head"><h2>Every figure</h2><SourceTag source={data.source} /></div>
        {metrics.some((m) => m.estimated) && <EstimatedNote />}
        <div className="an-tiles">
          {metrics.map((m) => (
            <FigureTile
              key={m.metric}
              label={m.label}
              value={m.total === null ? FIGURE_TEXT.noData : formatCount(m.total)}
              note={[m.estimated ? 'Estimated' : '', gapNote(m.gapDays)].filter(Boolean).join('. ')}
              pressed={m.metric === metric.metric}
              onSelect={() => setPicked(m.metric)}
            />
          ))}
        </div>
      </section>
      <DayList metric={metric} />
      <Breakdowns metric={metric} />
      <Followers days={data.followers} />
    </>
  );
}

export default function AccountPage() {
  const [query, setRange, asked] = useRange();
  const status = useQuery({ queryKey: ['insights', 'status'], queryFn: () => api.insights.status() });
  const account = useQuery({ queryKey: ['insights', 'account', query], queryFn: () => api.insights.account(query), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader eyebrow="Insights" title="Instagram" />
      <InsightsTabs />
      <AnalyticsLoadable query={status} label="Checking your Instagram insights" errorTitle="We couldn’t check your Instagram insights">
        {(current) => <StatusNotes status={current} />}
      </AnalyticsLoadable>
      <RangeBar query={query} onChange={setRange} asked={asked} />
      <AnalyticsLoadable query={account} label="Loading your insights" errorTitle="We couldn’t load your insights">
        {(data) => <Account data={data} status={status.data} />}
      </AnalyticsLoadable>
    </>
  );
}
