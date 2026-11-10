import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { FIGURE_TEXT } from '../insights/shared/catalog.js';
import { BAND_WORDS, healthView, newestFirst, pointsText } from '../insights/shared/figures.js';
import { AnalyticsLoadable, LastUpdated, LineChart, RangeBar, SafetyTabs, SourceTag, useRange } from '../insights/shared/ui.jsx';
import { formatDay, wordFor } from '../insights/shared/words.js';

const HISTORY_SHOWN = 14;

function Deductions({ view }) {
  if (!view.deductions.length) return <p className="muted">Nothing is lowering your score.</p>;
  return (
    <ul className="an-rows" aria-label="What lowers your score, worst first">
      {view.deductions.map((d) => (
        <li key={d.code} className="an-deduction">
          <span className="an-deduction-head">
            <span>{d.message}</span>
            <span className="an-deduction-points">{pointsText(d.points)}</span>
          </span>
          <span className="an-deduction-fix">{d.fix}</span>
        </li>
      ))}
    </ul>
  );
}

function Score({ health }) {
  const view = healthView(health);
  if (view.score === null) {
    return <EmptyState title="Not worked out yet">The score comes from your connection, Instagram’s answers and Reach Guard over the last day. It appears after the first check.</EmptyState>;
  }
  return (
    <>
      <Card ink aria-labelledby="health-title">
        <div className="an-hero-head">
          <span className="an-hero-title" id="health-title">Account Health</span>
          {view.band && <Badge tone={view.band.tone}>{view.band.label}</Badge>}
        </div>
        <div className="an-score">
          <span className="an-score-number">{view.score}</span>
          <span className="an-score-of">out of 100</span>
        </div>
        <SourceTag source="bhava" onInk />
        <LastUpdated at={health.computedAt} prefix="Worked out" />
      </Card>
      <Panel title="What lowers it">
        <Deductions view={view} />
        {view.reconnect && <Button as={Link} to="/connect">Reconnect Instagram</Button>}
      </Panel>
    </>
  );
}

function History({ history }) {
  const days = history.days;
  const shown = newestFirst(days).slice(0, HISTORY_SHOWN);
  if (!days.some((d) => d.state === 'ok')) return <EmptyState title={FIGURE_TEXT.noData}>Each day’s score is kept for 90 days once Bhava starts working it out.</EmptyState>;
  return (
    <>
      <LineChart days={days} label="Account Health score" />
      <div className="an-days" role="list" aria-label="Score by day">
        {shown.map((day) => {
          const band = day.band ? wordFor(BAND_WORDS, day.band, null) : null;
          return (
            <div key={day.day} className="an-day" role="listitem">
              <span className="an-day-when">{formatDay(day.day, { year: true })}{band && <Badge tone={band.tone}>{band.label}</Badge>}</span>
              <span className={day.state === 'ok' ? 'an-day-value' : 'an-day-value an-day-empty'}>{day.state === 'ok' ? day.value : FIGURE_TEXT.noData}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One score with plain reasons and their fixes (7.7), and how it has moved over the last 90 days. */
export default function HealthPage() {
  const [query, setRange, asked] = useRange('28');
  const health = useQuery({ queryKey: ['account-health'], queryFn: () => api.accountHealth.get() });
  const history = useQuery({ queryKey: ['account-health', 'history', query], queryFn: () => api.accountHealth.history(query), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader eyebrow="Account safety" title="Account Health" />
      <SafetyTabs />
      <AnalyticsLoadable query={health} label="Working out your score" errorTitle="We couldn’t work out your score">
        {(data) => <Score health={data} />}
      </AnalyticsLoadable>
      <Panel title="Day by day" action={<SourceTag source="bhava" />}>
        <RangeBar query={query} onChange={setRange} asked={asked} />
        <AnalyticsLoadable query={history} label="Loading your score history" errorTitle="We couldn’t load your score history">
          {(data) => <History history={data} />}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
