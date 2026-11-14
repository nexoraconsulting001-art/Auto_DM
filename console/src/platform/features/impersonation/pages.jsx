import { useState } from 'react';
import { Badge, Banner, Button, Chip, ChipRow, PageHeader, Panel, TextField } from '../../../design/index.jsx';
import { ActionSheet, BusinessSelect, Countdown, Facts, PagedRows, When, useAct, useBusinessOptions, usePlatformList } from '../../kit.jsx';
import { nameMatches } from '../../lib/rules.js';
import { api } from '../../api.js';
import { ImpersonateSheet, StartedNote } from './actions.jsx';

/** Write mode is a second, deliberate step: type the business's name and say what has to change. */
function WriteSheet({ session, open, onClose }) {
  const act = useAct();
  const [typed, setTyped] = useState('');
  return (
    <ActionSheet
      open={open}
      title={`Allow changes in ${session.tenantName}`}
      intro={`You will be able to change things as the owner, until the session ends. Type the business name, ${session.tenantName}, to confirm.`}
      submitLabel="Allow changes"
      tone="danger"
      reasonLabel="What needs to change, and why"
      valid={nameMatches(typed, session.tenantName)}
      onClose={() => { setTyped(''); onClose(); }}
      onSubmit={(reason) => act(() => api.confirmImpersonationWrite({ params: { id: session.id }, body: { confirm: typed.trim(), reason } }), 'Changes are allowed for this session.')}
    >
      <TextField label="Business name" autoComplete="off" value={typed} onChange={(event) => setTyped(event.target.value)} required />
    </ActionSheet>
  );
}

function SessionCard({ session }) {
  const act = useAct();
  const [sheet, setSheet] = useState('');
  const [error, setError] = useState('');
  const [ending, setEnding] = useState(false);
  const live = !session.endedAt && new Date(session.expiresAt) > new Date();

  async function end() {
    setEnding(true);
    setError('');
    try {
      await act(() => api.endImpersonation({ params: { id: session.id } }), 'The session has ended.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setEnding(false);
    }
  }

  return (
    <Panel
      title={session.tenantName}
      data-testid={`session-${session.id}`}
      action={<Badge tone={session.mode === 'write' ? 'warn' : 'good'}>{session.mode === 'write' ? 'Changes allowed' : 'Read only'}</Badge>}
    >
      <div className="stack">
        {error && <Banner tone="bad">{error}</Banner>}
        <Facts rows={[
          ['Opened by', session.operatorName],
          ['Reason', session.reason],
          ['Started', <When key="s" value={session.startedAt} />],
          [live ? 'Time left' : 'Ended', live ? <Countdown key="c" until={session.expiresAt} /> : <When key="e" value={session.endedAt ?? session.expiresAt} />],
        ]}
        />
        {live && (
          <div className="form-actions">
            {session.mode === 'read' && <Button variant="outline" onClick={() => setSheet('write')}>Allow changes</Button>}
            <Button variant="danger" loading={ending} onClick={end}>End the session</Button>
          </div>
        )}
      </div>
      {live && session.mode === 'read' && <WriteSheet session={session} open={sheet === 'write'} onClose={() => setSheet('')} />}
    </Panel>
  );
}

export function ImpersonationPage() {
  const [live, setLive] = useState('true');
  const [choice, setChoice] = useState('');
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(null);
  const query = usePlatformList('impersonations', api.impersonations, live ? { live } : {});
  const options = useBusinessOptions();
  const chosen = options.data?.find((business) => String(business.id) === String(choice)) ?? null;

  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Impersonation" />
      <p className="muted">Open a business as its owner for 30 minutes. It starts read-only; changes need a second confirmation.</p>
      <Panel title="Start a session">
        <div className="stack">
          <BusinessSelect label="Business" value={choice} onChange={setChoice} />
          <Button disabled={!chosen} onClick={() => setOpen(true)}>Start a read-only session</Button>
          <StartedNote started={started} name={started?.session?.tenantName ?? chosen?.name ?? 'the business'} />
        </div>
        {chosen && <ImpersonateSheet business={chosen} open={open} onClose={() => setOpen(false)} onStarted={setStarted} />}
      </Panel>
      <ChipRow label="Sessions">
        <Chip pressed={live === 'true'} onClick={() => setLive('true')}>Running now</Chip>
        <Chip pressed={live === ''} onClick={() => setLive('')}>All sessions</Chip>
      </ChipRow>
      <PagedRows query={query} empty="No sessions" emptyText="Sessions you start appear here with their reason and time left." label="Loading sessions">
        {(items) => <div className="stack">{items.map((session) => <SessionCard key={session.id} session={session} />)}</div>}
      </PagedRows>
    </div>
  );
}
