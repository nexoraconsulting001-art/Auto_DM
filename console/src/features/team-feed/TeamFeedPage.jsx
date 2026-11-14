import { useState } from 'react';
import { Badge, Banner, Button, EmptyState, ErrorState, LoadMore, PageHeader, Panel, SelectField, Spinner } from '../../design/index.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { usePagedList, useRefresh } from '../../lib/query.js';
import '../billing/billing.css';
import { SERVICE_KEYS, SERVICE_WORDS, STATE_KEYS, STATE_WORDS, actionWords, actionsFor, summarize } from './model.js';

const DONE_WORDS = { undo: 'Change undone.', approve: 'Change approved and applied.', reject: 'Change rejected. Nothing was changed.' };

function Line({ change, busy, onAct }) {
  const state = STATE_WORDS[change.state] ?? { label: change.state, tone: 'neutral' };
  const rows = summarize(change);
  const actions = actionsFor(change);
  return (
    <li className="p7-item" data-testid="team-change" data-state={change.state}>
      <div className="grow">
        <span className="p7-step-title"><strong>{actionWords(change.routeId)}</strong><Badge tone={state.tone}>{state.label}</Badge></span>
        <span className="p7-meta">{SERVICE_WORDS[change.service] ?? change.service}{change.taskRef ? ` · ${change.taskRef}` : ''} · {formatDateTime(change.createdAt)}</span>
        {change.target && <span className="p7-meta">{change.target}</span>}
        {rows.length > 0 && (
          <ul className="p7-list" aria-label="What changed">
            {rows.map((row) => <li key={row.field} className="p7-meta"><strong>{row.field}</strong>: {row.before ? `${row.before} → ` : ''}{row.after || 'removed'}</li>)}
          </ul>
        )}
        {change.state === 'applied' && !change.canUndo && <span className="p7-meta">This one cannot be undone from here.</span>}
      </div>
      {actions.includes('approve') && <Button loading={busy === `approve${change.id}`} aria-label={`Approve: ${actionWords(change.routeId)}`} onClick={() => onAct('approve', change)}>Approve</Button>}
      {actions.includes('reject') && <Button variant="outline" loading={busy === `reject${change.id}`} aria-label={`Reject: ${actionWords(change.routeId)}`} onClick={() => onAct('reject', change)}>Reject</Button>}
      {actions.includes('undo') && <Button variant="outline" loading={busy === `undo${change.id}`} aria-label={`Undo: ${actionWords(change.routeId)}`} onClick={() => onAct('undo', change)}>Undo</Button>}
    </li>
  );
}

export default function TeamFeedPage() {
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const [filters, setFilters] = useState({ service: '', state: '' });
  const [busy, setBusy] = useState('');
  const query = Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
  const list = usePagedList('team-feed', api.teamFeed.list, query, { retry: false });

  async function act(kind, change) {
    if (kind === 'undo' && !(await confirm({ title: 'Undo this change?', text: 'The old value is put back.', confirm: 'Undo', cancel: 'Keep it', tone: 'primary' }))) return;
    if (kind === 'reject' && !(await confirm({ title: 'Reject this change?', text: 'Nothing will be changed.', confirm: 'Reject', cancel: 'Keep it' }))) return;
    setBusy(`${kind}${change.id}`);
    try {
      await api.teamFeed[kind](change.id);
      toast(DONE_WORDS[kind]);
      await refresh();
    } catch (error) {
      toast(error.code === 'service.cannot_undo' ? 'That change cannot be undone any more.' : error.message);
      await refresh();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Your team" title="Done by Bhava team" />
      <Panel title="Filter">
        <div className="p7-two">
          <SelectField label="Service" value={filters.service} onChange={(event) => setFilters((current) => ({ ...current, service: event.target.value }))}>
            <option value="">All services</option>
            {SERVICE_KEYS.map((key) => <option key={key} value={key}>{SERVICE_WORDS[key]}</option>)}
          </SelectField>
          <SelectField label="State" value={filters.state} onChange={(event) => setFilters((current) => ({ ...current, state: event.target.value }))}>
            <option value="">All</option>
            {STATE_KEYS.map((key) => <option key={key} value={key}>{STATE_WORDS[key].label}</option>)}
          </SelectField>
        </div>
      </Panel>
      {list.isPending && <Spinner label="Loading what the team did" />}
      {list.isError && <ErrorState title="We couldn’t load the feed" error={list.error} onRetry={() => list.refetch()} />}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="Nothing yet">When the Bhava team makes a change for you, it shows up here and you can undo it.</EmptyState>}
      {list.items.some((change) => change.state === 'draft') && <Banner tone="warn">Some changes are waiting for you. Nothing happens until you approve.</Banner>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Changes">
          {list.items.map((change) => <Line key={change.id} change={change} busy={busy} onAct={act} />)}
        </ul>
      )}
      <LoadMore query={list} />
    </div>
  );
}
