import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, Banner, Button, Chip, ChipRow, PageHeader, Panel, SelectField, TextAreaField, TextField } from '../../../design/index.jsx';
import { ActionSheet, Can, Facts, QueryState, When, useAct, useOne } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { api } from '../../api.js';
import { OWNER_LABELS, PHASE_LABELS, STATE_LABELS, nextStepFor } from './next-steps.js';
import './golive.css';

/**
 * Go-live (G-15 to G-17): every item of the checklist as ready, missing or not checked, who must act, the phase it
 * blocks and the next step; and beside it the sign-up switch. The page shows only what the server answers: an item's
 * detail is a fixed phrase or a setting's name, never a value. The server decides everything again on every call.
 */
const STATE_TONE = { ready: 'good', missing: 'bad', unknown: 'warn' };
const STATE_ORDER = { missing: 0, unknown: 1, ready: 2 };
const OWNERS = ['us', 'user'];
const MODES = ['closed', 'invite', 'public'];

function groupsOf(items, { owner, blockingOnly, openOnly }) {
  const shown = items.filter((i) => i.kind !== 'per_business' && (!owner || i.owner === owner) && (!blockingOnly || i.blocks) && (!openOnly || i.state !== 'ready'));
  const out = [];
  for (const who of OWNERS) {
    const mine = shown.filter((i) => i.owner === who);
    for (const phase of [...new Set(mine.map((i) => i.phase))].sort((a, b) => a - b)) {
      const items = mine.filter((i) => i.phase === phase).sort((a, b) => Number(b.blocks) - Number(a.blocks) || STATE_ORDER[a.state] - STATE_ORDER[b.state]);
      out.push({ key: `${who}-${phase}`, owner: who, phase, items });
    }
  }
  return out;
}

function Item({ item }) {
  const step = nextStepFor(item);
  const detail = item.state === 'unknown' && item.detail === 'NOT CHECKED' ? 'Not checked: run the live checks.' : item.detail;
  return (
    <div className="gl-item" data-testid={`golive-item-${item.id}`} data-state={item.state}>
      <div className="gl-item-head">
        <span className="gl-item-title">{item.title}</span>
        <span className="pc-badges">
          {item.blocks && <Badge tone="neutral">Blocks go-live</Badge>}
          <Badge tone={STATE_TONE[item.state]}>{STATE_LABELS[item.state]}</Badge>
        </span>
      </div>
      <span className="gl-item-id">{item.id}</span>
      {item.state !== 'ready' && <span className="gl-detail">{detail}</span>}
      {step && <span className="gl-next">Next: {step}</span>}
    </div>
  );
}

function Checklist({ status, live, checking, onLive }) {
  const [owner, setOwner] = useState('');
  const [blockingOnly, setBlockingOnly] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);
  const groups = useMemo(() => groupsOf(status.items, { owner, blockingOnly, openOnly }), [status, owner, blockingOnly, openOnly]);
  const perBusiness = status.items.filter((i) => i.kind === 'per_business');
  const open = status.blockingMissing;
  return (
    <div className="stack">
      <Banner tone={status.ready ? 'good' : 'warn'}>
        <span data-testid="golive-verdict">
          {status.ready ? 'Ready for go-live: no blocking item is open.' : `Not ready for go-live: ${open} blocking item${open === 1 ? '' : 's'} open.`}
          {' '}
          {live ? <>Live checks ran <When value={status.checkedAt} />.</> : 'Live checks have not run, so items that ask a provider are not checked.'}
        </span>
      </Banner>
      <div className="gl-actions">
        <Button variant="outline" loading={checking} onClick={onLive}><RefreshCw size={16} aria-hidden="true" /> Check live</Button>
      </div>
      <ChipRow label="Show">
        <Chip pressed={owner === ''} onClick={() => setOwner('')}>Everyone</Chip>
        {OWNERS.map((who) => <Chip key={who} pressed={owner === who} onClick={() => setOwner(who)}>{OWNER_LABELS[who]}</Chip>)}
        <Chip pressed={blockingOnly} onClick={() => setBlockingOnly((v) => !v)}>Blocking only</Chip>
        <Chip pressed={openOnly} onClick={() => setOpenOnly((v) => !v)}>Open only</Chip>
      </ChipRow>
      {groups.length === 0 && <p>Nothing to show with these filters.</p>}
      {groups.map((group) => (
        <Panel key={group.key} title={`${OWNER_LABELS[group.owner]} · ${PHASE_LABELS[group.phase] ?? `Phase ${group.phase}`}`}>
          <div>{group.items.map((item) => <Item key={item.id} item={item} />)}</div>
        </Panel>
      ))}
      {perBusiness.length > 0 && (
        <Panel title="Done by each business (never blocks go-live)">
          <Facts rows={perBusiness.map((i) => [i.title, i.detail])} />
        </Panel>
      )}
    </div>
  );
}

/** Who can sign up, beside the checklist. Public may be refused with the open items; a super admin may then force it. */
function SignupSwitch({ status }) {
  const act = useAct();
  const query = useOne(['signup'], () => api.signup());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('invite');
  const [cap, setCap] = useState('');
  const [refused, setRefused] = useState(null);
  const [forceReason, setForceReason] = useState('');
  const capText = cap.trim();
  const capValue = capText === '' ? undefined : /^\d{1,6}$/.test(capText) ? Number(capText) : Number.NaN;
  const capOk = capValue === undefined || (Number.isInteger(capValue) && capValue >= 1 && capValue <= 100000);
  const forcing = Array.isArray(refused);
  const blockingIds = status.items.filter((i) => i.blocks && i.state !== 'ready').map((i) => i.id);

  function start(signup) {
    setMode(signup.mode);
    setCap(signup.dailyCap ? String(signup.dailyCap) : '');
    setRefused(null);
    setForceReason('');
    setOpen(true);
  }

  async function submit(reason) {
    const body = { mode, reason, ...(capValue !== undefined ? { dailyCap: capValue } : {}), ...(forcing ? { force: true, forceReason: forceReason.trim() } : {}) };
    try {
      await act(() => api.setSignupMode({ body }), forcing ? 'Sign-up is open to the public. The open items are on record.' : 'Who can sign up is changed.');
    } catch (failure) {
      if (failure?.code === 'conflict' && !forcing) {
        setRefused(String(failure.fields?.golive ?? '').split(' ').filter(Boolean));
        throw new Error('The checklist has blocking items open, so public sign-up is refused. Give a second reason to open it anyway.');
      }
      throw failure;
    }
  }

  return (
    <QueryState query={query} label="Loading sign-up">
      {(signup) => (
        <Panel title="Who can sign up" action={<Badge tone={signup.mode === 'public' ? 'warn' : 'good'}>{word('signup', signup.mode)}</Badge>}>
          <div className="stack">
            <Facts rows={[
              ['Sign-up is', word('signup', signup.mode)],
              ['New businesses a day', signup.dailyCap === null || signup.dailyCap === undefined ? 'No cap' : String(signup.dailyCap)],
              ['Changed', <When key="u" value={signup.updatedAt} />],
            ]} />
            {signup.mode !== 'public' && blockingIds.length > 0 && (
              <p className="gl-detail">Opening to the public waits for {blockingIds.length} blocking item{blockingIds.length === 1 ? '' : 's'} on the checklist.</p>
            )}
            <Can route="platform.setSignupMode" fallback={<p className="gl-detail">Only a super admin can change who can sign up.</p>}>
              <Button variant="outline" onClick={() => start(signup)}>Change who can sign up</Button>
              <ActionSheet
                open={open}
                title={forcing ? 'Open sign-up anyway' : 'Change who can sign up'}
                intro={forcing
                  ? 'These blocking items are open. Opening now is recorded as forced, with both reasons and the open items.'
                  : 'Invite codes are made on the Sign-up screen. A daily cap limits how many businesses sign-up makes in a day, India time.'}
                submitLabel={forcing ? 'Open anyway' : 'Change'}
                tone={forcing ? 'danger' : 'primary'}
                valid={capOk && (!forcing || forceReason.trim().length >= 3)}
                onClose={() => setOpen(false)}
                onSubmit={submit}
              >
                {forcing && <ul className="gl-missing-list" data-testid="golive-refused">{refused.map((id) => <li key={id}>{id}</li>)}</ul>}
                <SelectField label="Sign-up is" value={mode} disabled={forcing} onChange={(event) => setMode(event.target.value)}>
                  {MODES.map((item) => <option key={item} value={item}>{word('signup', item)}</option>)}
                </SelectField>
                <TextField label="New businesses a day" inputMode="numeric" hint="Empty keeps the cap as it is." value={cap} disabled={forcing} onChange={(event) => setCap(event.target.value)} error={capOk ? undefined : 'Enter a whole number from 1 to 100000'} />
                {forcing && <TextAreaField label="Second reason: why open with these items open" rows={3} maxLength={500} value={forceReason} onChange={(event) => setForceReason(event.target.value)} required />}
              </ActionSheet>
            </Can>
          </div>
        </Panel>
      )}
    </QueryState>
  );
}

export function GolivePage() {
  const [live, setLive] = useState(false);
  const query = useOne(['golive', live ? 'live' : 'offline'], () => api.goliveStatus(live ? { query: { live: '1' } } : {}));
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Go-live" />
      <QueryState query={query} label="Loading the go-live checklist">
        {(status) => (
          <div className="gl-layout">
            <Checklist status={status} live={live} checking={query.isFetching} onLive={() => (live ? query.refetch() : setLive(true))} />
            <div className="gl-side"><SignupSwitch status={status} /></div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
