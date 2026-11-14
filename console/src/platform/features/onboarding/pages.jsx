import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, ListCard, ListRow, PageHeader, Panel, Toggle } from '../../../design/index.jsx';
import { useFeedback } from '../../../components/feedback.jsx';
import { Facts, PagedRows, QueryState, Secret, When, useAct, useOne, usePlatformList } from '../../kit.jsx';
import { OPERATOR_TARGET_MS, createActivityTracker, formatDuration, maskLink, targetState, word } from '../../lib/rules.js';
import { api } from '../../api.js';

const STEP_TONE = { done: 'good', failed: 'bad', waiting: 'warn', pending: 'neutral' };
const OPERATOR_LABELS = { form: 'Form', brand_read: 'Brand read', import: 'Import', review: 'Review', invite: 'Invite' };

export function OnboardingPage() {
  const [done, setDone] = useState('');
  const query = usePlatformList('onboarding', api.onboardingList, done ? { done } : {});
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Onboarding" />
      <ChipRow label="Show">
        <Chip pressed={done === ''} onClick={() => setDone('')}>All</Chip>
        <Chip pressed={done === 'false'} onClick={() => setDone('false')}>Still open</Chip>
        <Chip pressed={done === 'true'} onClick={() => setDone('true')}>Done</Chip>
      </ChipRow>
      <PagedRows query={query} empty="Nothing to onboard" emptyText="Businesses you create, or that sign up, appear here." label="Loading onboarding">
        {(items) => (
          <ListCard>
            {items.map((item) => (
              <ListRow
                key={item.tenantId}
                as={Link}
                to={`/onboarding/${item.tenantId}`}
                title={item.tenantName}
                meta={`${item.stepsDone} of ${item.stepsRequired} steps · link: ${word('invite', item.inviteState)} · ${formatDuration(item.activeMs)} of your time`}
                trailing={<Badge tone={item.done ? 'good' : 'warn'}>{item.done ? 'Done' : 'Open'}</Badge>}
              />
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}

/**
 * Counts how long the operator is actively on this business and reports it against a step (F-27). A gap of over two
 * minutes is not counted; what has been counted goes to the server each minute, when the step changes, and when they leave.
 */
function useOperatorTime(id) {
  const tracker = useRef(createActivityTracker());
  const step = useRef('review');
  const send = useCallback(async () => {
    const spent = tracker.current.flush();
    if (spent) await api.recordOnboardingTime({ params: { id }, body: { step: step.current, ...spent } }).catch(() => {});
  }, [id]);
  useEffect(() => {
    tracker.current.touch();
    const every = setInterval(send, 60_000);
    const hidden = () => { if (document.visibilityState === 'hidden') send(); };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(every);
      document.removeEventListener('visibilitychange', hidden);
      send();
    };
  }, [send]);
  return {
    touch: () => tracker.current.touch(),
    enter(next) {
      if (next !== step.current) {
        send();
        step.current = next;
      }
      tracker.current.touch();
    },
  };
}

function InvitePanel({ workspace, enter }) {
  const act = useAct();
  const { toast } = useFeedback();
  const [whatsapp, setWhatsapp] = useState(true);
  const [email, setEmail] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const invite = workspace.invite;
  const live = invite && !invite.usedAt && !invite.revokedAt && new Date(invite.expiresAt) > new Date();

  async function send() {
    setBusy('send');
    setError('');
    try {
      const via = [whatsapp && 'whatsapp', email && 'email'].filter(Boolean);
      setSent(await act(() => api.sendOnboardingInvite({ params: { id: workspace.tenantId }, body: { via } }), 'The link is ready.'));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy('');
    }
  }
  async function revoke() {
    setBusy('revoke');
    setError('');
    try {
      await act(() => api.revokeOnboardingInvite({ params: { id: workspace.tenantId } }), 'The link is revoked.');
      setSent(null);
    } catch (failure) {
      setError(failure.message);
      toast('The link was not revoked.');
    } finally {
      setBusy('');
    }
  }

  return (
    <Panel title="Invite link" onFocusCapture={() => enter('invite')} onPointerDownCapture={() => enter('invite')}>
      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        {invite ? (
          <Facts rows={[
            ['Made', <When key="a" value={invite.createdAt} />],
            ['Good until', <When key="b" value={invite.expiresAt} />],
            ['Opened', invite.usedAt ? <When key="c" value={invite.usedAt} /> : 'Not yet'],
            ['Revoked', invite.revokedAt ? <When key="d" value={invite.revokedAt} /> : ''],
            ['Made by', invite.createdBy],
          ]}
          />
        ) : <p className="muted">No link has been made for this business yet.</p>}
        {sent && (
          <Banner tone="good">
            <div className="stack">
              <span>This is the owner’s link. It is shown now and not again; only the start of it appears here.</span>
              <span data-testid="invite-link" className="pc-link-text">{maskLink(sent.url)}</span>
              <Secret value={sent.url} label="Invite link" />
            </div>
          </Banner>
        )}
        <Toggle label="Send on WhatsApp" checked={whatsapp} onChange={(event) => setWhatsapp(event.target.checked)} />
        <Toggle label="Send by email" checked={email} onChange={(event) => setEmail(event.target.checked)} />
        <div className="form-actions">
          <Button loading={busy === 'send'} onClick={send}>{live ? 'Make a new link' : 'Make and send the link'}</Button>
          {live && <Button variant="outline" loading={busy === 'revoke'} onClick={revoke}>Revoke the link</Button>}
        </div>
      </div>
    </Panel>
  );
}

export function OnboardingWorkspacePage() {
  const { id } = useParams();
  const act = useAct();
  const query = useOne(['onboarding', id], () => api.onboarding({ params: { id } }));
  const time = useOperatorTime(id);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  async function check() {
    setChecking(true);
    setError('');
    try {
      await act(() => api.checkOnboarding({ params: { id } }), 'The checks have run.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="stack" onPointerDownCapture={time.touch} onKeyDownCapture={time.touch}>
      <BackLink to="/onboarding">Onboarding</BackLink>
      <QueryState query={query} label="Loading the workspace">
        {(workspace) => {
          const state = targetState(workspace.activeMs);
          return (
            <>
              <PageHeader eyebrow="Onboarding" title={workspace.tenantName} actions={<Badge tone={workspace.done ? 'good' : 'warn'}>{workspace.done ? 'Done' : 'Open'}</Badge>} />
              {error && <Banner tone="bad">{error}</Banner>}
              {workspace.checkoutOpen && <Banner tone="info">Checkout is open for this business.</Banner>}
              <Panel title="Your time" onFocusCapture={() => time.enter('review')}>
                <p data-testid="active-time">{formatDuration(workspace.activeMs)} of {formatDuration(OPERATOR_TARGET_MS)}</p>
                <Badge tone={state === 'within' ? 'good' : 'warn'}>{state === 'within' ? 'Within the target' : 'Over the target'}</Badge>
                {workspace.timings.length > 0 && (
                  <Facts rows={workspace.timings.map((t) => [OPERATOR_LABELS[t.step] ?? t.step, formatDuration(t.activeMs)])} />
                )}
              </Panel>
              <Panel title="Checklist" action={<Button variant="soft" loading={checking} onClick={check}>Check now</Button>} onFocusCapture={() => time.enter('review')} onPointerDownCapture={() => time.enter('review')}>
                <ListCard>
                  {workspace.steps.map((step) => (
                    <ListRow
                      key={step.step}
                      title={step.label}
                      meta={[step.required ? 'Required' : 'Optional', step.reason, step.checkedAt ? 'checked' : 'not checked yet'].filter(Boolean).join(' · ')}
                      trailing={<Badge tone={STEP_TONE[step.status]}>{word('step', step.status)}</Badge>}
                    />
                  ))}
                </ListCard>
                {workspace.kyc && <p className="muted">Payments review: {workspace.kyc.status.replace('_', ' ')}{workspace.kyc.reason ? `. ${workspace.kyc.reason}` : ''}</p>}
              </Panel>
              <InvitePanel workspace={workspace} enter={time.enter} />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
