import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Card, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, Ring, Sheet, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { usePagedList } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { ANALYTICS_LIMITS as L, FIGURE_TEXT } from '../insights/shared/catalog.js';
import { OVERRIDE_WORD, TRIP_WORDS, guardView, overrideTyped, thresholdsBody } from '../insights/shared/figures.js';
import { AnalyticsLoadable, LastUpdated, PermissionNeeded, SafetyTabs, SourceTag } from '../insights/shared/ui.jsx';
import { formatCount, formatPercent, wordFor } from '../insights/shared/words.js';

const REFRESH_MS = 60_000;

function useGuardRefresh() {
  const queries = useQueryClient();
  return () => Promise.all([
    queries.invalidateQueries({ queryKey: ['reach-guard'] }),
    queries.invalidateQueries({ queryKey: ['compliance-status'] }),
  ]);
}

/** The owner's override, with the word typed out and a plain warning first (7.6). Only offered when a drop in reach started slow mode. */
function Override() {
  const sheet = useRef(null);
  const { toast } = useFeedback();
  const refresh = useGuardRefresh();
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState('');
  const override = useMutation({
    mutationFn: () => api.compliance.slowModeOverride({ confirmation: typed.trim() }),
    onSuccess: async () => {
      sheet.current?.close();
      setTyped('');
      toast('Slow mode is off. Messages go out at the normal pace.');
      await refresh();
    },
    onError: (error) => setProblem(error.message),
  });
  return (
    <>
      <Button variant="outline" onClick={() => { setProblem(''); sheet.current?.showModal(); }}>Override slow mode</Button>
      <Sheet ref={sheet} title="Override slow mode?">
        <div className="an-confirm">
          <Banner tone="warn">Your reach is lower than usual. Sending at full speed now can make a restriction on your account worse. Bhava slows down to lower that risk.</Banner>
          <p className="muted">This is written to your audit log with your name.</p>
          <FieldGroup>
            <TextField label={`Type “${OVERRIDE_WORD}” to confirm`} autoComplete="off" autoCapitalize="none" spellCheck={false} value={typed} error={problem || undefined} onChange={(event) => setTyped(event.target.value)} />
          </FieldGroup>
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => sheet.current?.close()}>Keep slow mode</Button>
            <Button variant="danger" disabled={!overrideTyped(typed)} loading={override.isPending} onClick={() => override.mutate()}>Confirm override</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function SlowMode({ status, view }) {
  const slow = status.slowMode;
  if (!slow.active && !slow.restoring) return null;
  return (
    <Panel title="Slow mode">
      <p>{slow.restoring ? 'Speed is coming back in steps, as your reach recovers.' : `Messages go out at half speed${slow.until ? ` until ${formatDateTime(slow.until)}` : ''}.`}</p>
      {view.offerOverride && <Override />}
      {view.overrideNote && <p className="muted">{view.overrideNote}</p>}
    </Panel>
  );
}

const THRESHOLD_FIELDS = [
  { name: 'reachDropPercent', label: 'Trip when daily reach falls below this % of usual', limits: L.reachDropPercent },
  { name: 'mediaDropPercent', label: 'Trip when posts reach below this % of usual after 24 hours', limits: L.mediaDropPercent },
  { name: 'clearPercent', label: 'Clear when reach is back above this % of usual', limits: L.clearPercent },
];

function Thresholds({ thresholds, canEdit }) {
  const { toast } = useFeedback();
  const refresh = useGuardRefresh();
  const [values, setValues] = useState(() => Object.fromEntries(THRESHOLD_FIELDS.map((f) => [f.name, String(thresholds[f.name])])));
  const [errors, setErrors] = useState({});
  const save = useMutation({
    mutationFn: (body) => api.reachGuard.setThresholds(body),
    onSuccess: async () => {
      toast('Thresholds saved.');
      await refresh();
    },
    onError: (error) => {
      setErrors(error.fields ?? {});
      toast(error.message);
    },
  });

  if (!canEdit) {
    return (
      <Panel title="When Reach Guard steps in">
        <dl className="an-facts">
          {THRESHOLD_FIELDS.map((f) => <div key={f.name}><dt>{f.label}</dt><dd>{formatPercent(thresholds[f.name])}</dd></div>)}
        </dl>
        <p className="muted">{FIGURE_TEXT.ownerOnly} The owner can change these.</p>
      </Panel>
    );
  }

  function submit(event) {
    event.preventDefault();
    const result = thresholdsBody(values, thresholds);
    setErrors(result.errors ?? {});
    if (result.errors) return;
    if (!Object.keys(result.body).length) {
      toast('Nothing has changed.');
      return;
    }
    save.mutate(result.body);
  }

  return (
    <Panel title="When Reach Guard steps in">
      <form className="an-form" onSubmit={submit} noValidate>
        <FieldGroup>
          {THRESHOLD_FIELDS.map((f) => (
            <TextField
              key={f.name}
              label={f.label}
              type="number"
              inputMode="numeric"
              min={f.limits.min}
              max={f.limits.max}
              step={1}
              value={values[f.name]}
              error={errors[f.name]}
              hint={`${f.limits.min} to ${f.limits.max}. Usually ${f.limits.default}.`}
              onChange={(event) => setValues((current) => ({ ...current, [f.name]: event.target.value }))}
            />
          ))}
        </FieldGroup>
        <Button type="submit" loading={save.isPending}>Save thresholds</Button>
      </form>
    </Panel>
  );
}

function Trips() {
  const trips = usePagedList('reach-guard-trips', api.reachGuard.trips);
  return (
    <Panel title="Past slowdowns">
      <AnalyticsLoadable query={trips} label="Loading past slowdowns" errorTitle="We couldn’t load past slowdowns">
        {() => (trips.items.length ? (
          <>
            <div className="an-rows">
              {trips.items.map((trip) => (
                <div key={trip.id} className="an-row">
                  <span className="an-row-main">
                    <span className="an-row-title">{wordFor(TRIP_WORDS, trip.trigger)}</span>
                    <span className="an-row-meta">{`Started ${formatDateTime(trip.startedAt)}${trip.clearedAt ? `, cleared ${formatDateTime(trip.clearedAt)}` : ', still on'}`}</span>
                    {trip.overriddenAt && <span className="an-row-meta">{`Overridden by the owner ${formatDateTime(trip.overriddenAt)}`}</span>}
                  </span>
                  <span className="an-row-end">
                    {trip.dropPercent !== null && <span>{`Down ${formatPercent(trip.dropPercent)}`}</span>}
                    {trip.baseline !== null && <span className="an-row-meta">{`Usual ${formatCount(trip.baseline)}`}</span>}
                  </span>
                </div>
              ))}
            </div>
            <LoadMore query={trips} />
          </>
        ) : <EmptyState title="No slowdowns yet">When reach drops sharply, Reach Guard slows automations down and records it here.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

function Guard({ status }) {
  const { session } = useSession();
  const view = guardView(status, { role: session.user.role });
  return (
    <>
      <Card ink aria-labelledby="guard-title">
        <div className="an-state">
          <div className="an-hero-head">
            <span className="an-hero-title">Reach Guard</span>
            <Badge tone={view.tone === 'neutral' ? 'neel' : view.tone}>{view.badge}</Badge>
          </div>
          <h2 id="guard-title">{view.title}</h2>
          <p className="an-state-message">{status.message}</p>
          {view.learning && (
            <div className="an-progress">
              <Ring done={Math.min(view.learning.days, view.learning.daysNeeded)} total={view.learning.daysNeeded} label={`${view.learning.days} of ${view.learning.daysNeeded} settled days`} />
              <span className="an-progress-text">
                <span>{`${Math.min(view.learning.days, view.learning.daysNeeded)} of ${view.learning.daysNeeded} settled days of reach`}</span>
                <span>{`${Math.min(view.learning.media, view.learning.mediaNeeded)} of ${view.learning.mediaNeeded} posts`}</span>
                <span>Until then nothing can trip.</span>
              </span>
            </div>
          )}
          {status.since && <span className="an-hero-sub">{`Since ${formatDateTime(status.since)}`}</span>}
        </div>
      </Card>
      {view.state === 'permission_needed' && <PermissionNeeded />}
      <SlowMode status={status} view={view} />
      <Panel title="Your usual reach" action={<SourceTag source="platform" />}>
        <dl className="an-facts">
          <div><dt>Usual daily reach</dt><dd>{status.baselineReach === null ? FIGURE_TEXT.noData : formatCount(status.baselineReach)}</dd></div>
          <div><dt>Settled days counted</dt><dd>{formatCount(status.settledDays)}</dd></div>
          <div><dt>Posts counted</dt><dd>{formatCount(status.mediaCounted)}</dd></div>
        </dl>
        <p className="muted">{`“Usual” is the middle value of the last ${L.baselineDays} settled days, leaving out the last ${L.settleDays} days while Instagram settles them.`}</p>
        <LastUpdated at={status.lastEvaluatedAt} prefix="Last checked" />
      </Panel>
      <Thresholds key={JSON.stringify(status.thresholds)} thresholds={status.thresholds} canEdit={view.canEditThresholds} />
    </>
  );
}

/** Reach Guard (7.6): a warning and a slowdown when reach drops sharply, in plain words, with normal causes and no promises. */
export default function ReachGuardPage() {
  const status = useQuery({ queryKey: ['reach-guard', 'status'], queryFn: () => api.reachGuard.status(), refetchInterval: REFRESH_MS });
  return (
    <>
      <PageHeader eyebrow="Account safety" title="Reach Guard" />
      <SafetyTabs />
      <AnalyticsLoadable query={status} label="Checking your reach" errorTitle="We couldn’t check your reach">
        {(data) => <Guard status={data} />}
      </AnalyticsLoadable>
      <Trips />
    </>
  );
}
