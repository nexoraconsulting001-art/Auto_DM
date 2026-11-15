import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Banner, Button, Chip, ChipRow, ListCard, PageHeader, SelectField, TextAreaField, TextField } from '../../../design/index.jsx';
import { ActionSheet, BusinessSelect, Can, PagedRows, When, useAct, useOne, usePlatformList } from '../../kit.jsx';
import { api } from '../../api.js';
import './feedback.css';

const SEVERITY_TONE = { low: 'neutral', medium: 'neel', high: 'warn', blocker: 'bad' };
const STATE_TONE = { new: 'neel', planned: 'warn', fixed: 'good', declined: 'neutral' };
const label = (value) => value.charAt(0).toUpperCase() + value.slice(1);
const ID = /^[1-9]\d{0,9}$/;
const FEEDBACK_SEVERITIES = ['low', 'medium', 'high', 'blocker'];
const FEEDBACK_STATES = ['new', 'planned', 'fixed', 'declined'];

/** Log one item against a business. Every value goes to the server as typed; it is shown back as text. */
function LogSheet({ onClose, defaultBusiness }) {
  const act = useAct();
  const [business, setBusiness] = useState(defaultBusiness);
  const [saidBy, setSaidBy] = useState('');
  const [area, setArea] = useState('');
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState('medium');
  const valid = ID.test(String(business)) && saidBy.trim() !== '' && area.trim() !== '' && text.trim() !== '';
  return (
    <ActionSheet
      open
      title="Log feedback"
      needsReason={false}
      submitLabel="Log it"
      valid={valid}
      onClose={onClose}
      onSubmit={() => act(() => api.createFeedback({ params: { id: Number(business) }, body: { saidBy: saidBy.trim(), area: area.trim(), text: text.trim(), severity } }), 'The feedback is logged.')}
    >
      <BusinessSelect label="Business" value={business} onChange={setBusiness} required />
      <TextField label="Who said it" value={saidBy} maxLength={120} onChange={(event) => setSaidBy(event.target.value)} required />
      <TextField label="Where in the product" hint="For example Orders, Checkout or the app." value={area} maxLength={80} onChange={(event) => setArea(event.target.value)} required />
      <TextAreaField label="What they said" rows={4} value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} required />
      <SelectField label="How bad" value={severity} onChange={(event) => setSeverity(event.target.value)}>
        {FEEDBACK_SEVERITIES.map((item) => <option key={item} value={item}>{label(item)}</option>)}
      </SelectField>
    </ActionSheet>
  );
}

/** Move an item along: its state, its severity, and what fixed it. Only the fields that changed are sent. */
function TrackSheet({ item, onClose }) {
  const act = useAct();
  const [state, setState] = useState(item.state);
  const [severity, setSeverity] = useState(item.severity);
  const [fixedIn, setFixedIn] = useState(item.fixedIn);
  const body = {};
  if (state !== item.state) body.state = state;
  if (severity !== item.severity) body.severity = severity;
  if (state === 'fixed' && (state !== item.state || fixedIn.trim() !== item.fixedIn)) body.fixedIn = fixedIn.trim();
  const valid = Object.keys(body).length > 0 && (state !== 'fixed' || fixedIn.trim() !== '');
  return (
    <ActionSheet
      open
      title="Track this feedback"
      needsReason={false}
      submitLabel="Save"
      valid={valid}
      onClose={onClose}
      onSubmit={() => act(() => api.updateFeedback({ params: { id: item.id }, body }), 'The feedback is updated.')}
    >
      <SelectField label="State" value={state} onChange={(event) => setState(event.target.value)}>
        {FEEDBACK_STATES.map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </SelectField>
      {state === 'fixed' && (
        <TextField label="What fixed it" hint="The commit or release." value={fixedIn} maxLength={80} onChange={(event) => setFixedIn(event.target.value)} required />
      )}
      <SelectField label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value)}>
        {FEEDBACK_SEVERITIES.map((value) => <option key={value} value={value}>{label(value)}</option>)}
      </SelectField>
    </ActionSheet>
  );
}

function Item({ item, onBusiness }) {
  const [editing, setEditing] = useState(false);
  return (
    <article className="feedback-item" data-testid={`feedback-${item.id}`}>
      <div className="feedback-head">
        <button type="button" className="feedback-business" onClick={() => onBusiness(item.tenantId)}>{item.tenantName}</button>
        <span className="feedback-badges">
          <Badge tone={SEVERITY_TONE[item.severity]}>{label(item.severity)}</Badge>
          <Badge tone={STATE_TONE[item.state]}>{label(item.state)}</Badge>
        </span>
      </div>
      {/* The words are a text child, never markup. */}
      <p className="feedback-words">{item.text}</p>
      <span className="feedback-meta">{item.saidBy} · {item.area} · <When value={item.createdAt} /></span>
      {item.state === 'fixed' && <span className="feedback-meta">Fixed in {item.fixedIn}</span>}
      <Can route="platform.updateFeedback">
        <div>
          <Button variant="soft" onClick={() => setEditing(true)}>Track</Button>
          {editing && <TrackSheet item={item} onClose={() => setEditing(false)} />}
        </div>
      </Can>
    </article>
  );
}

function OnlyBusiness({ id, onClear }) {
  const query = useOne(['business', id], () => api.business({ params: { id: Number(id) } }));
  return (
    <div className="feedback-filter">
      <Banner tone="info">Showing only {query.data?.name ?? `business ${id}`}</Banner>
      <Button variant="soft" onClick={onClear}>Show all businesses</Button>
    </div>
  );
}

export function FeedbackPage() {
  const [params, setParams] = useSearchParams();
  const rawTenant = params.get('tenantId') ?? '';
  const tenantId = ID.test(rawTenant) ? rawTenant : '';
  const state = FEEDBACK_STATES.includes(params.get('state')) ? params.get('state') : 'all';
  const [logging, setLogging] = useState(false);
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const list = usePlatformList('feedback', api.feedback, { ...(tenantId ? { tenantId } : {}), state });
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Feedback" actions={<Can route="platform.createFeedback"><Button onClick={() => setLogging(true)}>Log feedback</Button></Can>} />
      {tenantId && <OnlyBusiness id={tenantId} onClear={() => set('tenantId', '')} />}
      <ChipRow label="State">
        {['all', ...FEEDBACK_STATES].map((item) => <Chip key={item} pressed={state === item} onClick={() => set('state', item)}>{label(item)}</Chip>)}
      </ChipRow>
      <PagedRows query={list} empty="No feedback" emptyText="Log what a business says in a showcase session, then track it to fixed." label="Loading feedback">
        {(items) => <ListCard>{items.map((item) => <Item key={item.id} item={item} onBusiness={(id) => set('tenantId', String(id))} />)}</ListCard>}
      </PagedRows>
      {logging && <LogSheet defaultBusiness={tenantId} onClose={() => setLogging(false)} />}
    </div>
  );
}
