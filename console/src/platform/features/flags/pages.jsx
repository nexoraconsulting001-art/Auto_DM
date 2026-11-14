import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, ListCard, PageHeader, Panel, TextField, Toggle } from '../../../design/index.jsx';
import { ActionSheet, BusinessSelect, Can, QueryState, useAct, useOne } from '../../kit.jsx';
import { api } from '../../api.js';

const KEY_RULE = /^[a-z][a-z0-9_.]{1,59}$/;

function FlagSheet({ flag, open, onClose }) {
  const act = useAct();
  const [key, setKey] = useState(flag?.key ?? '');
  const [description, setDescription] = useState(flag?.description ?? '');
  const [enabled, setEnabled] = useState(flag?.enabled ?? false);
  const [percent, setPercent] = useState(String(flag?.percent ?? 0));
  const pct = /^\d{1,3}$/.test(percent) ? Number(percent) : -1;
  return (
    <ActionSheet
      open={open}
      title={flag ? `Change ${flag.key}` : 'New flag'}
      submitLabel="Save flag"
      valid={KEY_RULE.test(key) && pct >= 0 && pct <= 100}
      onClose={onClose}
      onSubmit={(reason) => act(() => api.saveFlag({ body: { key, description, enabled, percent: pct, reason } }), 'The flag is saved.')}
    >
      <TextField label="Key" hint="Lower-case letters, digits, dots and underscores." value={key} onChange={(event) => setKey(event.target.value)} readOnly={Boolean(flag)} error={key && !KEY_RULE.test(key) ? 'Use lower-case letters, digits, dots and underscores' : undefined} required />
      <TextField label="What it does" value={description} onChange={(event) => setDescription(event.target.value)} />
      <Toggle label="On for everyone" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <TextField label="Percent of businesses" inputMode="numeric" hint="0 to 100, when it is not on for everyone." value={percent} onChange={(event) => setPercent(event.target.value)} error={pct < 0 || pct > 100 ? 'Enter 0 to 100' : undefined} />
    </ActionSheet>
  );
}

function FlagRow({ flag }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="list-row" data-testid={`flag-${flag.key}`}>
      <span className="list-row-main">
        <span className="list-row-title">{flag.key}</span>
        <span className="list-row-meta">{flag.description || 'No description'} · {flag.percent}% · {flag.businesses} businesses have their own setting</span>
      </span>
      <span className="pc-badges">
        <Badge tone={flag.enabled ? 'good' : 'neutral'}>{flag.enabled ? 'On' : 'Off'}</Badge>
        <Can route="platform.saveFlag"><Button variant="soft" onClick={() => setOpen(true)}>Change</Button></Can>
      </span>
      <Can route="platform.saveFlag"><FlagSheet flag={flag} open={open} onClose={() => setOpen(false)} /></Can>
    </div>
  );
}

function TenantFlag({ tenantId, item }) {
  const act = useAct();
  const [choice, setChoice] = useState('');
  const apply = (reason) => act(
    () => api.setTenantFlag({ params: { id: tenantId }, body: { key: item.key, enabled: choice === 'default' ? null : choice === 'on', reason } }),
    'The setting is saved.',
  );
  return (
    <div className="list-row" data-testid={`tenant-flag-${item.key}`}>
      <span className="list-row-main">
        <span className="list-row-title">{item.key}</span>
        <span className="list-row-meta">{item.own === null ? 'Following the flag’s default' : `Set by hand to ${item.own ? 'on' : 'off'}`}</span>
      </span>
      <span className="pc-badges">
        <Badge tone={item.on ? 'good' : 'neutral'}>{item.on ? 'On' : 'Off'}</Badge>
        <Button variant="soft" onClick={() => setChoice(item.on ? 'off' : 'on')}>{item.on ? 'Turn off' : 'Turn on'}</Button>
        {item.own !== null && <Button variant="soft" onClick={() => setChoice('default')}>Use the default</Button>}
      </span>
      <ActionSheet
        open={choice !== ''}
        title={`${item.key} for this business`}
        intro={choice === 'default' ? 'The business goes back to what the flag says for everyone.' : `This turns it ${choice} for this business only.`}
        submitLabel="Save"
        onClose={() => setChoice('')}
        onSubmit={apply}
      />
    </div>
  );
}

export function FlagsPage() {
  const [params, setParams] = useSearchParams();
  const business = params.get('business') ?? '';
  const flags = useOne(['flags'], () => api.flags());
  const own = useOne(['tenant-flags', business], () => api.tenantFlags({ params: { id: business } }), { enabled: Boolean(business) });
  const [creating, setCreating] = useState(false);
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Flags" actions={<Can route="platform.saveFlag"><Button onClick={() => setCreating(true)}>New flag</Button></Can>} />
      <QueryState query={flags} label="Loading flags">
        {(data) => (data.items.length ? <ListCard>{data.items.map((flag) => <FlagRow key={flag.key} flag={flag} />)}</ListCard> : <p className="muted">No flags yet.</p>)}
      </QueryState>
      <Can route="platform.saveFlag"><FlagSheet open={creating} onClose={() => setCreating(false)} /></Can>
      <Panel title="For one business">
        <div className="stack">
          <BusinessSelect label="Business" value={business} onChange={(value) => setParams(value ? { business: value } : {}, { replace: true })} />
          {business && (
            <QueryState query={own} label="Loading this business’s flags">
              {(data) => (data.items.length ? <ListCard>{data.items.map((item) => <TenantFlag key={`${business}-${item.key}`} tenantId={business} item={item} />)}</ListCard> : <p className="muted">There are no flags.</p>)}
            </QueryState>
          )}
        </div>
      </Panel>
    </div>
  );
}
