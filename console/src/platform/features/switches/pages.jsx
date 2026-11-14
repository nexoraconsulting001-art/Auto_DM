import { useState } from 'react';
import { Badge, Banner, Button, Chip, ChipRow, ListCard, PageHeader, Panel } from '../../../design/index.jsx';
import { ActionSheet, Can, Facts, PagedRows, QueryState, When, useAct, useOne, usePlatformList } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { api } from '../../api.js';

const SCOPES = ['global', 'activations', 'business', 'account', 'automation'];

function SwitchPanel({ item }) {
  const act = useAct();
  const [sheet, setSheet] = useState('');
  const close = () => setSheet('');
  const pending = item.releaseRequestedBy && item.releaseRequestedAt;
  return (
    <Panel title="Global kill switch" action={<Badge tone={item.engaged ? 'bad' : 'good'}>{item.engaged ? 'Engaged' : 'Off'}</Badge>} data-testid="global-switch">
      <div className="stack">
        {item.engaged ? (
          <Banner tone="bad">Nothing is sending for any business. Releasing needs a second person to approve.</Banner>
        ) : <p className="muted">Sending is running for every business that is not paused.</p>}
        <Facts rows={[
          ['Set by', item.engaged ? item.engagedBy : ''],
          ['Why', item.engaged ? item.reason : ''],
          ['At', item.engaged ? <When key="at" value={item.engagedAt} /> : ''],
        ]}
        />
        {pending && (
          <div data-testid="pending-release">
            <Banner tone="warn">
            Release asked for by {item.releaseRequestedBy} at <When value={item.releaseRequestedAt} />. It takes effect when someone else approves it.
          </Banner>
          </div>
        )}
        <div className="form-actions">
          {!item.engaged && <Button variant="danger" onClick={() => setSheet('engage')}>Engage the kill switch</Button>}
          {item.engaged && !pending && <Button onClick={() => setSheet('request')}>Ask to release</Button>}
          {item.engaged && pending && <Button onClick={() => setSheet('approve')}>Approve the release</Button>}
        </div>
      </div>
      <ActionSheet
        open={sheet === 'engage'}
        title="Engage the kill switch"
        intro="Every business stops sending, straight away. Use this only when sending itself is unsafe."
        submitLabel="Stop all sending"
        tone="danger"
        onClose={close}
        onSubmit={(reason) => act(() => api.engageKill({ body: { scope: 'global', reason } }), 'The kill switch is on.')}
      />
      <ActionSheet
        open={sheet === 'request'}
        title="Ask to release"
        intro="Sending does not restart until a second person approves."
        submitLabel="Ask to release"
        onClose={close}
        onSubmit={(reason) => act(() => api.requestRelease({ body: { reason } }), 'The release is waiting for approval.')}
      />
      <ActionSheet
        open={sheet === 'approve'}
        title="Approve the release"
        intro={`This restarts sending for every business. ${item.releaseRequestedBy} asked for it, so it must be you who approves, not them.`}
        submitLabel="Approve and restart"
        onClose={close}
        onSubmit={(reason) => act(() => api.approveRelease({ body: { reason } }), 'Sending has restarted.')}
      />
    </Panel>
  );
}

function ActivationsPanel({ frozen }) {
  const act = useAct();
  const [open, setOpen] = useState(false);
  return (
    <Can route="platform.unfreezeActivations">
      <Panel title="New automations" action={frozen && <Badge tone={frozen.engaged ? 'bad' : 'good'}>{frozen.engaged ? 'Frozen' : 'Open'}</Badge>}>
        <p className="muted">{frozen?.engaged ? `Frozen by ${frozen.engagedBy}: ${frozen.reason}` : 'Businesses can switch new automations on.'}</p>
        <Button variant="outline" onClick={() => setOpen(true)}>Unfreeze new automations</Button>
        <ActionSheet
          open={open}
          title="Unfreeze new automations"
          submitLabel="Unfreeze"
          onClose={() => setOpen(false)}
          onSubmit={(reason) => act(() => api.unfreezeActivations({ body: { reason } }), 'New automations can be switched on again.')}
        />
      </Panel>
    </Can>
  );
}

export function SwitchesPage() {
  const switches = useOne(['switches'], () => api.switches());
  const [scope, setScope] = useState('');
  const [engaged, setEngaged] = useState(true);
  const pauses = usePlatformList('pauses', api.pauses, { ...(scope ? { scope } : {}), ...(engaged ? { engaged: 'true' } : {}) });
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Pauses and switches" />
      <QueryState query={switches} label="Loading switches">
        {(data) => {
          const kill = data.items.find((item) => item.key === 'global_kill');
          const frozen = data.items.find((item) => item.key === 'activations_frozen');
          return (
            <>
              {kill && <SwitchPanel item={kill} />}
              <ActivationsPanel frozen={frozen} />
            </>
          );
        }}
      </QueryState>
      <h2 className="pc-h2">Every pause</h2>
      <ChipRow label="Scope">
        <Chip pressed={scope === ''} onClick={() => setScope('')}>All scopes</Chip>
        {SCOPES.map((item) => <Chip key={item} pressed={scope === item} onClick={() => setScope(item)}>{word('scope', item)}</Chip>)}
      </ChipRow>
      <ChipRow label="State">
        <Chip pressed={engaged} onClick={() => setEngaged(true)}>Engaged now</Chip>
        <Chip pressed={!engaged} onClick={() => setEngaged(false)}>Include lifted</Chip>
      </ChipRow>
      <PagedRows query={pauses} empty="Nothing is paused" emptyText="A pause set by Bhava, a business or the system shows here with who set it and why." label="Loading pauses">
        {(items) => (
          <ListCard>
            {items.map((pause, index) => (
              <div className="list-row pc-pause" key={`${pause.scope}-${pause.tenantId}-${pause.target}-${index}`} data-scope={pause.scope}>
                <span className="list-row-main">
                  <span className="list-row-title">{word('scope', pause.scope)}{pause.tenantName ? ` · ${pause.tenantName}` : ''}{pause.target ? ` · ${pause.target}` : ''}</span>
                  <span className="list-row-meta">
                    {pause.actor || 'Unknown'} · {pause.reason || 'No reason recorded'} · <When value={pause.at} />
                  </span>
                  {pause.releasePending && <span className="list-row-meta">Release asked for by {pause.releasePending.requestedBy}</span>}
                </span>
                <span className="pc-badges">
                  <Badge tone={pause.engaged ? 'bad' : 'neutral'}>{pause.engaged ? 'Engaged' : 'Lifted'}</Badge>
                  <Badge tone={pause.by === 'platform' ? 'neel' : 'neutral'}>{pause.by === 'platform' ? 'By Bhava' : pause.by === 'owner' ? 'By the owner' : 'By the system'}</Badge>
                </span>
              </div>
            ))}
          </ListCard>
        )}
      </PagedRows>
    </div>
  );
}
