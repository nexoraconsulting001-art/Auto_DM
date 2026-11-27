import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, Banner, Button, Chip, ChipRow, PageHeader, Panel } from '../../../design/index.jsx';
import { Facts, QueryState, When, useOne } from '../../kit.jsx';
import { api } from '../../api.js';
import { SignupSwitch } from '../signup/switch.jsx';
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
            <div className="gl-side"><SignupSwitch blockingIds={status.items.filter((i) => i.blocks && i.state !== 'ready').map((i) => i.id)} /></div>
          </div>
        )}
      </QueryState>
    </div>
  );
}
