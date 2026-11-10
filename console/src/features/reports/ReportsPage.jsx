import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Button, Chip, ChipRow, EmptyState, LoadMore, PageHeader, Panel, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { useFilters, usePagedList } from '../../lib/query.js';
import { DOWNLOAD_STATUS_WORDS, FORMAT_WORDS, REPORT_KIND_WORDS, REPORT_STATUS_WORDS, SUMMARY_FILES, canOpen, isOwnFile, rangeDates } from '../insights/shared/figures.js';
import { DownloadButtons } from '../insights/shared/download.jsx';
import { AnalyticsLoadable, RangeBar, ReportTabs, useRange } from '../insights/shared/ui.jsx';
import { formatCount, formatDay, wordFor } from '../insights/shared/words.js';

const SOURCE_NAMES = Object.freeze({
  ...Object.fromEntries(SUMMARY_FILES.map((f) => [f.source, f.label])),
  explore: 'Explore view',
  funnel: 'Funnel',
  cohort: 'Cohorts',
});

/** The summary files (7.9, 7.13): aggregates only, in the business's time zone, never a shopper's details or one visit at a time. */
function SummaryFiles() {
  const [range, setRange, asked] = useRange('28');
  return (
    <Panel title="Download a summary">
      <p className="muted">Summary figures only, as CSV or Excel, in your time zone. No file lists a shopper or a single visit. Big files are made in the background, and every link expires after 7 days.</p>
      <RangeBar query={range} onChange={setRange} asked={asked} label="Dates in the file" />
      <ul className="an-rows">
        {SUMMARY_FILES.map((file) => (
          <li key={file.source} className="an-row">
            <span className="an-row-main">
              <span className="an-row-title">{file.label}</span>
              <span className="an-row-meta">{file.detail}</span>
              <DownloadButtons label={`Download ${file.label}`} request={() => ({ source: file.source, range: rangeDates(range) })} />
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">To download any other question, ask it in <Link to="/explore">Explore</Link>, a <Link to="/funnels">funnel</Link> or <Link to="/cohorts">cohorts</Link>.</p>
    </Panel>
  );
}

function Downloads() {
  const downloads = usePagedList('downloads', api.downloads.list);
  return (
    <Panel title="Your downloads">
      <AnalyticsLoadable query={downloads} label="Loading your downloads" errorTitle="We couldn’t load your downloads">
        {() => (downloads.items.length ? (
          <>
            <div className="an-rows">
              {downloads.items.map((d) => {
                const status = wordFor(DOWNLOAD_STATUS_WORDS, d.status, null) ?? { label: d.status, tone: 'neutral' };
                return (
                  <div key={d.id} className="an-row">
                    <span className="an-row-main">
                      <span className="an-row-title">{`${wordFor(SOURCE_NAMES, d.source)}, ${wordFor(FORMAT_WORDS, d.format)}`}</span>
                      <span className="an-row-meta">{`Made ${formatDateTime(d.createdAt)}${d.rowCount !== null ? `, ${formatCount(d.rowCount)} rows` : ''}${d.expiresAt ? `. Expires ${formatDate(d.expiresAt)}` : ''}`}</span>
                    </span>
                    <span className="an-row-end">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {canOpen(d) && <Button as="a" variant="soft" href={d.fileUrl}>Open</Button>}
                    </span>
                  </div>
                );
              })}
            </div>
            <LoadMore query={downloads} />
          </>
        ) : <EmptyState title="No downloads yet">Files you make here, in Explore, funnels and cohorts are listed for 7 days.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Preferences() {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const preferences = useQuery({ queryKey: ['reports', 'preferences'], queryFn: () => api.reports.preferences() });
  const save = useMutation({
    mutationFn: (body) => api.reports.updatePreferences(body),
    onSuccess: (saved) => {
      queries.setQueryData(['reports', 'preferences'], saved);
      toast('Saved.');
    },
    onError: (error) => toast(error.message),
  });
  return (
    <Panel title="Report emails">
      <AnalyticsLoadable query={preferences} label="Loading your report emails" errorTitle="We couldn’t load your report emails">
        {(data) => (
          <>
            <Toggle label="Weekly summary, Mondays at 9 am" checked={data.weekly} disabled={save.isPending} onChange={(event) => save.mutate({ weekly: event.target.checked })} />
            <p className="muted">Views, reach and followers week on week, your top posts, funnel totals, Reach Guard and Account Health.</p>
            <Toggle label="Monthly performance report, on the 1st" checked={data.monthly} disabled={save.isPending || !data.monthlyAvailable} onChange={(event) => save.mutate({ monthly: event.target.checked })} />
            <p className="muted">{data.monthlyAvailable ? 'A PDF for last month, per reel, post and story, with traffic by source. Kept below.' : 'The monthly report comes with tier 2 and up.'}</p>
          </>
        )}
      </AnalyticsLoadable>
    </Panel>
  );
}

const KIND_FILTERS = [{ value: 'all', label: 'All' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'scheduled', label: 'Scheduled' }];

function Runs() {
  const [params, setFilter] = useFilters();
  const kind = KIND_FILTERS.some((k) => k.value === params.get('kind')) ? params.get('kind') : 'all';
  const runs = usePagedList('report-runs', api.reports.list, { kind });
  return (
    <Panel title="Reports sent">
      <ChipRow label="Kind of report">
        {KIND_FILTERS.map((k) => <Chip key={k.value} pressed={k.value === kind} onClick={() => setFilter('kind', k.value === 'all' ? '' : k.value)}>{k.label}</Chip>)}
      </ChipRow>
      <AnalyticsLoadable query={runs} label="Loading your reports" errorTitle="We couldn’t load your reports">
        {() => (runs.items.length ? (
          <>
            <div className="an-rows">
              {runs.items.map((run) => {
                const status = wordFor(REPORT_STATUS_WORDS, run.status, null) ?? { label: run.status, tone: 'neutral' };
                return (
                  <div key={run.id} className="an-row">
                    <span className="an-row-main">
                      <span className="an-row-title">{wordFor(REPORT_KIND_WORDS, run.kind)}</span>
                      <span className="an-row-meta">{`${formatDay(run.periodStart)} to ${formatDay(run.periodEnd, { year: true })}${run.sentAt ? `. Sent ${formatDateTime(run.sentAt)}` : ''}`}</span>
                    </span>
                    <span className="an-row-end">
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {isOwnFile(run.fileUrl) && <Button as="a" variant="soft" href={run.fileUrl}><FileText size={16} aria-hidden="true" />PDF</Button>}
                    </span>
                  </div>
                );
              })}
            </div>
            <LoadMore query={runs} />
          </>
        ) : <EmptyState title="No reports yet">The first weekly summary goes out on Monday morning.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

/** Reports and files (7.9, 7.13): summary downloads, the weekly and monthly emails, and what has been sent. */
export default function ReportsPage() {
  return (
    <>
      <PageHeader eyebrow="Insights" title="Reports" />
      <ReportTabs />
      <SummaryFiles />
      <Downloads />
      <Preferences />
      <Runs />
    </>
  );
}
