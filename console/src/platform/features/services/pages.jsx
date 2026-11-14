import { useState } from 'react';
import { Badge, Banner, Button, Chip, ChipRow, ListCard, ListRow, PageHeader, TextField } from '../../../design/index.jsx';
import { ActionSheet, Countdown, PagedRows, When, useAct, usePlatformList } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { api } from '../../api.js';

const TASK_REF_MAX = 120;
const CHANGE_TONE = { applied: 'good', draft: 'warn', approved: 'good', rejected: 'bad', undone: 'neutral' };

function StartSheet({ engagement, open, onClose, onStarted }) {
  const act = useAct();
  const [taskRef, setTaskRef] = useState('');
  const value = taskRef.trim();
  return (
    <ActionSheet
      open={open}
      title={`Work on ${engagement.tenantName}`}
      intro={`${word('service', engagement.service)}. Every change you make is recorded against the task reference.`}
      needsReason={false}
      submitLabel="Start the session"
      valid={value.length > 0 && value.length <= TASK_REF_MAX}
      onClose={() => { setTaskRef(''); onClose(); }}
      onSubmit={async () => onStarted(await act(() => api.startServiceSession({ params: { id: engagement.tenantId }, body: { service: engagement.service, taskRef: value } }), 'The session has started.'))}
    >
      <TextField label="Task reference" hint="The ticket or task this work is for." maxLength={TASK_REF_MAX} value={taskRef} onChange={(event) => setTaskRef(event.target.value)} required />
    </ActionSheet>
  );
}

function EngagementRow({ engagement, onStart }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="list-row pc-engagement" data-testid={`engagement-${engagement.tenantId}-${engagement.service}`}>
      <span className="list-row-main">
        <span className="list-row-title">{engagement.tenantName} · {word('service', engagement.service)}</span>
        <span className="list-row-meta">{word('mode', engagement.mode)} · {engagement.changesThisMonth} changes this month · since <When value={engagement.activeFrom} /></span>
      </span>
      <span className="pc-badges">
        <Badge tone={engagement.active ? 'good' : 'neutral'}>{engagement.active ? 'Active' : 'Ended'}</Badge>
        {engagement.active && <Button variant="soft" onClick={() => setOpen(true)}>Start a session</Button>}
      </span>
      {engagement.active && <StartSheet engagement={engagement} open={open} onClose={() => setOpen(false)} onStarted={onStart} />}
    </div>
  );
}

function SessionRow({ session }) {
  const act = useAct();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const live = !session.endedAt && new Date(session.expiresAt) > new Date();
  async function end() {
    setBusy(true);
    setError('');
    try {
      await act(() => api.endServiceSession({ params: { id: session.id } }), 'The session has ended.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="list-row pc-session" data-testid={`service-session-${session.id}`}>
      <span className="list-row-main">
        <span className="list-row-title">{session.tenantName} · {word('service', session.service)}</span>
        <span className="list-row-meta">{session.taskRef} · {session.operatorName} · {live ? <Countdown until={session.expiresAt} /> : <>ended <When value={session.endedAt ?? session.expiresAt} /></>}</span>
        {error && <span className="field-error" role="alert">{error}</span>}
      </span>
      {live && <Button variant="outline" loading={busy} onClick={end}>End</Button>}
    </div>
  );
}

export function ServicesPage() {
  const [started, setStarted] = useState(null);
  const [service, setService] = useState('');
  const filter = service ? { service } : {};
  const engagements = usePlatformList('services', api.services, { active: 'true', ...filter });
  const sessions = usePlatformList('service-sessions', api.serviceSessions, { active: 'true', ...filter });
  const changes = usePlatformList('service-changes', api.serviceChanges, filter);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Managed services" />
      <ChipRow label="Service">
        <Chip pressed={service === ''} onClick={() => setService('')}>All services</Chip>
        {['reel_management', 'reel_backlog', 'merchandising', 'catalog_management', 'performance_report'].map((item) => (
          <Chip key={item} pressed={service === item} onClick={() => setService(item)}>{word('service', item)}</Chip>
        ))}
      </ChipRow>
      {started && (
        <Banner tone="good">
          <div className="stack" data-testid="session-started">
            <span>Session started for {started.session.tenantName} on task {started.session.taskRef}. <Countdown until={started.session.expiresAt} /></span>
            <a className="btn btn-primary" href={started.url} target="_blank" rel="noopener noreferrer">Work in {started.session.tenantName}’s screens</a>
            <span>The seller’s screens show a banner while you are in them, and everything you change is recorded.</span>
          </div>
        </Banner>
      )}
      <h2 className="pc-h2">Businesses with a service</h2>
      <PagedRows query={engagements} empty="No active services" emptyText="When a business turns a service on, it appears here." label="Loading services">
        {(items) => <ListCard>{items.map((engagement) => <EngagementRow key={`${engagement.tenantId}-${engagement.service}`} engagement={engagement} onStart={setStarted} />)}</ListCard>}
      </PagedRows>
      <h2 className="pc-h2">Sessions running</h2>
      <PagedRows query={sessions} empty="No session is running" emptyText="A session starts from a business above and ends in 8 hours at most." label="Loading sessions">
        {(items) => <ListCard>{items.map((session) => <SessionRow key={session.id} session={session} />)}</ListCard>}
      </PagedRows>
      <h2 className="pc-h2">Changes made</h2>
      <PagedRows query={changes} empty="No changes yet" emptyText="Changes made in a service session are listed here with their task reference." label="Loading changes">
        {(items) => (
          <ListCard>
            {items.map((change) => (
              <ListRow
                key={change.id}
                title={`${change.taskRef} · ${word('service', change.service)}`}
                meta={<>{change.operatorName} · {change.routeId}{change.target ? ` · ${change.target}` : ''} · <When value={change.createdAt} /></>}
                trailing={<Badge tone={CHANGE_TONE[change.state]}>{word('change', change.state)}</Badge>}
              />
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}
