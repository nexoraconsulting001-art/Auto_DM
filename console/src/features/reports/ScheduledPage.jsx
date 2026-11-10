import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Trash2, X } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Button, EmptyState, FieldGroup, IconButton, LoadMore, PageHeader, Panel, SelectField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { FORMAT_WORDS, FREQUENCY_WORDS, scheduleWords } from '../insights/shared/figures.js';
import { AnalyticsLoadable, ReportTabs } from '../insights/shared/ui.jsx';
import { WEEKDAY_NAMES, formatHour, wordFor } from '../insights/shared/words.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, d) => d + 1);

/** "Is this an email address?" by position only, as the API checks it: a long address can never stall anything. */
export function looksLikeEmail(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.indexOf('@');
  return at > 0 && at === text.lastIndexOf('@') && text.indexOf('.', at + 2) > 0 && !text.endsWith('.');
}

function useScheduleRefresh() {
  const queries = useQueryClient();
  return () => queries.invalidateQueries({ queryKey: ['scheduled-reports'] });
}

function NewSchedule({ initialView }) {
  const { toast } = useFeedback();
  const refresh = useScheduleRefresh();
  const views = useQuery({ queryKey: ['saved-views', 'list', 'picker'], queryFn: () => api.savedViews.list({ limit: 100 }) });
  const [form, setForm] = useState({ viewId: initialView ?? '', frequency: 'weekly', weekday: 1, dayOfMonth: 1, hourOfDay: 9, format: 'csv' });
  const [problem, setProblem] = useState('');
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));
  const create = useMutation({
    mutationFn: () => api.scheduledReports.create({
      viewId: Number(form.viewId),
      frequency: form.frequency,
      hourOfDay: Number(form.hourOfDay),
      ...(form.frequency === 'weekly' ? { weekday: Number(form.weekday) } : {}),
      ...(form.frequency === 'monthly' ? { dayOfMonth: Number(form.dayOfMonth) } : {}),
      format: form.format,
      enabled: true,
    }),
    onSuccess: async () => {
      toast('Report scheduled. Your team gets it by email.');
      await refresh();
    },
    onError: (error) => setProblem(error.message),
  });

  function submit(event) {
    event.preventDefault();
    setProblem('');
    if (!/^\d+$/.test(String(form.viewId))) {
      setProblem('Choose a saved view to send.');
      return;
    }
    create.mutate();
  }

  return (
    <Panel title="Schedule a report">
      <AnalyticsLoadable query={views} label="Loading your saved views" errorTitle="We couldn’t load your saved views">
        {(data) => (data.items.length ? (
          <form className="an-form" onSubmit={submit} noValidate>
            <FieldGroup>
              <SelectField label="Saved view" value={String(form.viewId)} onChange={set('viewId')}>
                <option value="">Choose a view…</option>
                {data.items.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
              </SelectField>
              <SelectField label="How often" value={form.frequency} onChange={set('frequency')}>
                {Object.entries(FREQUENCY_WORDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </SelectField>
              {form.frequency === 'weekly' && (
                <SelectField label="On" value={String(form.weekday)} onChange={set('weekday')}>
                  {WEEKDAY_NAMES.map((name, i) => <option key={name} value={i}>{name}</option>)}
                </SelectField>
              )}
              {form.frequency === 'monthly' && (
                <SelectField label="On day" value={String(form.dayOfMonth)} onChange={set('dayOfMonth')}>
                  {DAYS_OF_MONTH.map((d) => <option key={d} value={d}>{d}</option>)}
                </SelectField>
              )}
              <SelectField label="At" value={String(form.hourOfDay)} onChange={set('hourOfDay')}>
                {HOURS.map((h) => <option key={h} value={h}>{formatHour(h)}</option>)}
              </SelectField>
              <SelectField label="As" value={form.format} onChange={set('format')}>
                {Object.entries(FORMAT_WORDS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </SelectField>
            </FieldGroup>
            {problem && <p className="field-error" role="alert">{problem}</p>}
            <p className="muted">It goes to your team by email from Bhava, in your time zone. The owner can add outside addresses.</p>
            <Button type="submit" loading={create.isPending}>Schedule</Button>
          </form>
        ) : <EmptyState title="Save a view first" action={<Button as={Link} to="/explore">Open Explore</Button>}>A scheduled report sends a saved Explore view. Ask a question there and save it.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Recipients({ report, isOwner }) {
  const { toast } = useFeedback();
  const refresh = useScheduleRefresh();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState('');
  const add = useMutation({
    mutationFn: () => api.scheduledReports.addRecipient(report.id, { email: email.trim() }),
    onSuccess: async () => {
      setEmail('');
      toast('Added. The change is in your audit log.');
      await refresh();
    },
    onError: (error) => setProblem(error.fields?.email ?? error.message),
  });
  const remove = useMutation({
    mutationFn: (id) => api.scheduledReports.removeRecipient(id),
    onSuccess: async () => {
      toast('Removed.');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  return (
    <div className="stack">
      <h3>Sent to</h3>
      <ul className="an-rows">
        {report.recipients.map((r) => (
          <li key={r.id} className="an-row">
            <span className="an-row-main">
              <span className="an-row-title">{r.email}</span>
              <span className="an-row-meta">{r.kind === 'team' ? 'Team member' : 'Outside address'}</span>
            </span>
            {isOwner && r.kind === 'outside' && <IconButton label={`Stop sending to ${r.email}`} onClick={() => remove.mutate(r.id)}><X size={18} aria-hidden="true" /></IconButton>}
          </li>
        ))}
        {!report.recipients.length && <li className="muted">Your team, by default.</li>}
      </ul>
      {isOwner && (
        <form className="an-condition" onSubmit={(event) => { event.preventDefault(); setProblem(''); if (!looksLikeEmail(email)) setProblem('Enter an email address'); else add.mutate(); }} noValidate>
          <FieldGroup>
            <TextField label="Add an outside address" type="email" autoComplete="off" value={email} error={problem || undefined} onChange={(event) => setEmail(event.target.value)} />
          </FieldGroup>
          <Button type="submit" variant="soft" loading={add.isPending}>Add</Button>
        </form>
      )}
    </div>
  );
}

function ScheduleRow({ report, isOwner }) {
  const { confirm, toast } = useFeedback();
  const refresh = useScheduleRefresh();
  const update = useMutation({
    mutationFn: (body) => api.scheduledReports.update(report.id, body),
    onSuccess: refresh,
    onError: (error) => toast(error.message),
  });
  const remove = useMutation({
    mutationFn: () => api.scheduledReports.remove(report.id),
    onSuccess: async () => {
      toast('Schedule deleted.');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  async function askToRemove() {
    if (await confirm({ title: `Stop sending “${report.viewName}”?`, text: 'Nobody gets it after this. The saved view stays.', confirm: 'Delete schedule' })) remove.mutate();
  }
  return (
    <Panel title={report.viewName} action={<IconButton label={`Delete the schedule for ${report.viewName}`} onClick={askToRemove}><Trash2 size={18} aria-hidden="true" /></IconButton>}>
      <span className="an-badges">
        <Badge tone="neel">{scheduleWords(report)}</Badge>
        <Badge>{wordFor(FORMAT_WORDS, report.format)}</Badge>
      </span>
      <Toggle label="Sending" checked={report.enabled} disabled={update.isPending} onChange={(event) => update.mutate({ enabled: event.target.checked })} />
      <p className="muted">{`Next ${formatDateTime(report.nextRunAt)}${report.lastRunAt ? `. Last sent ${formatDateTime(report.lastRunAt)}` : ''}.`}</p>
      <Recipients report={report} isOwner={isOwner} />
    </Panel>
  );
}

/** Any saved view, by email on a schedule (7.13). Owners and managers schedule; only the owner adds outside addresses. */
export default function ScheduledPage() {
  const allowed = useAllowed();
  const { session } = useSession();
  const [params] = useSearchParams();
  const canSchedule = allowed(MANAGERS);
  const reports = usePagedList('scheduled-reports', api.scheduledReports.list, {}, { enabled: canSchedule });
  const initialView = /^\d{1,9}$/.test(params.get('view') ?? '') ? params.get('view') : '';
  return (
    <>
      <PageHeader eyebrow="Reports" title="Scheduled reports" />
      <ReportTabs />
      {canSchedule ? (
        <>
          <NewSchedule initialView={initialView} />
          <AnalyticsLoadable query={reports} label="Loading scheduled reports" errorTitle="We couldn’t load scheduled reports">
            {() => (reports.items.length ? (
              <>
                {reports.items.map((report) => <ScheduleRow key={report.id} report={report} isOwner={session.user.role === 'owner'} />)}
                <LoadMore query={reports} />
              </>
            ) : <EmptyState title="Nothing scheduled yet">Scheduled reports go out daily, weekly or monthly, as CSV or Excel.</EmptyState>)}
          </AnalyticsLoadable>
        </>
      ) : <EmptyState title="Only the owner or a manager can schedule reports">You can still download summaries on the Reports page.</EmptyState>}
    </>
  );
}
