import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Card, EmptyState, FieldGroup, ListCard, ListRow, Loadable, LoadMore, PageHeader, Panel, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, plural } from '../../lib/format.js';
import { useAllowed, usePagedList, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { GATE_LABELS, SUPPORT_PAUSE, overallStatus, statusNotices } from './notices.js';
import { describeKind, describeReason } from './reasons.js';
import { NoticeList } from './StatusNotices.jsx';
import { useStatusSources } from './useStatus.js';
import './compliance.css';

function useStatusChange(action, success) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: action,
    onSuccess: async () => {
      toast(success);
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
}

function StatusHero({ status }) {
  const { title, tone, badge } = overallStatus(status);
  return (
    <Card ink aria-labelledby="status-title">
      <div className="status-hero">
        <div className="status-hero-head">
          <h2 id="status-title">{title}</h2>
          <Badge tone={tone}>{badge}</Badge>
        </div>
        <p>{status.heldJobs > 0 ? `${plural(status.heldJobs, 'message')} waiting to send.` : 'No messages are waiting.'}</p>
      </div>
    </Card>
  );
}

/** The seller's own kill switch. A pause by support can be seen here, but only support can lift it (PRD 4.12). */
function PausePanel({ status }) {
  const allowed = useAllowed();
  const { confirm } = useFeedback();
  const [pauseStore, setPauseStore] = useState(false);
  const pause = useStatusChange(() => api.compliance.pause({ pauseStore }), 'Stopped. Nothing will be sent until you resume.');
  const resume = useStatusChange(() => api.compliance.resume(), 'Resumed. Waiting messages send at the normal pace.');

  async function askToPause() {
    const yes = await confirm({
      title: 'Pause everything?',
      text: pauseStore
        ? 'No DM or public reply will go out, and your store will be closed to buyers, until you resume.'
        : 'No DM or public reply will go out until you resume. Your store stays open.',
      confirm: 'Pause everything',
    });
    if (yes) pause.mutate();
  }

  if (status.paused && !status.canResume) return <Panel title="Pause and resume"><p>{SUPPORT_PAUSE}</p></Panel>;
  if (!allowed(MANAGERS)) {
    return <Panel title="Pause and resume"><p className="muted">{status.paused ? 'Sending is stopped. ' : ''}Only the owner or a manager can change this.</p></Panel>;
  }
  if (status.paused) {
    return (
      <Panel title="Pause and resume">
        <p className="muted">{status.pauseStore ? 'Messages have stopped and your store is closed to buyers.' : 'Messages have stopped. Your store is still open.'}</p>
        <Button size="large" block loading={resume.isPending} onClick={() => resume.mutate()}>Resume sending</Button>
      </Panel>
    );
  }
  return (
    <Panel title="Pause and resume">
      <p className="muted">Stops every DM and public reply at once. New comments are still recorded, and messages wait until you resume if they haven’t expired.</p>
      <Toggle label="Also close my store to buyers" checked={pauseStore} onChange={(event) => setPauseStore(event.target.checked)} />
      <Button variant="danger" size="large" block loading={pause.isPending} onClick={askToPause}>Pause everything</Button>
    </Panel>
  );
}

/** Only a slowdown started by a drop in reach can be overridden, only by the owner, and only with the word typed out (PRD 4.3). */
function SlowModePanel({ status }) {
  const { session } = useSession();
  const [typed, setTyped] = useState('');
  const override = useStatusChange(() => api.compliance.slowModeOverride({ confirmation: typed }), 'Slow mode is off.');
  if (!status.slowMode.active) return null;
  const canOverride = status.slowMode.canOverride && session.user.role === 'owner';
  return (
    <Panel title="Slow mode">
      <p className="muted">Messages go out at half speed{status.slowMode.until ? ` until ${formatDateTime(status.slowMode.until)}` : ''}. It protects your account when Instagram shows signs of trouble.</p>
      {canOverride && (
        <>
          <Banner tone="warn">Your reach dropped, which is why this started. Overriding it can make things worse.</Banner>
          <FieldGroup>
            <TextField label="Type override to confirm" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} />
          </FieldGroup>
          <Button variant="outline" disabled={typed.trim().toLowerCase() !== 'override'} loading={override.isPending} onClick={() => override.mutate()}>Turn off slow mode</Button>
        </>
      )}
    </Panel>
  );
}

function HeldPanel({ canDiscard }) {
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const held = usePagedList('compliance-held', api.compliance.heldJobs);
  const discard = useMutation({
    mutationFn: () => api.compliance.discardHeld({}),
    onSuccess: async ({ discarded }) => {
      toast(`${plural(discarded, 'message')} discarded.`);
      await refresh();
    },
    onError: (error) => toast(error.message),
  });

  async function askToDiscard() {
    const yes = await confirm({ title: 'Discard every waiting message?', text: 'They will never be sent. This can’t be undone.', confirm: 'Discard all' });
    if (yes) discard.mutate();
  }

  return (
    <Panel title="Waiting to send" action={canDiscard && held.items.length > 0 ? <Button variant="outline" loading={discard.isPending} onClick={askToDiscard}>Discard all</Button> : undefined}>
      <Loadable query={held} label="Loading waiting messages" errorTitle="We couldn’t load waiting messages">
        {() => (held.items.length ? (
          <>
            <div className="row-list">
              {held.items.map((job) => (
                <ListRow key={job.id} title={describeKind(job.kind)} meta={`${describeReason(job.reason) || 'Waiting.'} Expires ${formatDateTime(job.expiresAt)}.`} />
              ))}
            </div>
            <LoadMore query={held} />
          </>
        ) : <EmptyState title="Nothing is waiting">Messages held by a pause or outside hours show up here.</EmptyState>)}
      </Loadable>
    </Panel>
  );
}

function GatesPanel({ gates }) {
  return (
    <Panel title="Meta’s checks">
      <div className="gate-list">
        {gates.map((gate) => (
          <div key={gate.code} className="gate">
            <span>{GATE_LABELS[gate.code] ?? gate.code}</span>
            <Badge tone={gate.passed ? 'good' : 'warn'}>{gate.passed ? 'Passed' : 'Not yet'}</Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Status({ status, connection, facebook }) {
  const allowed = useAllowed();
  // The pause panel below says who paused and what to do, so the same line isn't repeated above it.
  const notices = statusNotices({ status, connection, facebook }).filter((notice) => notice.key !== 'paused');
  return (
    <>
      <StatusHero status={status} />
      <NoticeList notices={notices} />
      <PausePanel status={status} />
      <SlowModePanel status={status} />
      <HeldPanel canDiscard={allowed(MANAGERS)} />
      <GatesPanel gates={status.gates} />
      <ListCard>
        <ListRow as={Link} to="/compliance/log" title="Compliance log" meta="Every decision about a message, and why." />
        <ListRow as={Link} to="/compliance/settings" title="Rules and word lists" meta="Dry run, limits, and the words we watch for." />
      </ListCard>
    </>
  );
}

export default function CompliancePage() {
  const { status, connection, facebook } = useStatusSources();
  return (
    <>
      <PageHeader title="Compliance" />
      <p className="lead">What is keeping your account safe, and the switch that stops every message.</p>
      <Loadable query={status} label="Checking your account" errorTitle="We couldn’t check your account">
        {(current) => <Status status={current} connection={connection.data} facebook={facebook.data} />}
      </Loadable>
    </>
  );
}
