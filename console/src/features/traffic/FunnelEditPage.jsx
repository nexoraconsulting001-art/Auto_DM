import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, IconButton, PageHeader, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { moveItem } from '../../lib/lists.js';
import { useAllowed } from '../../lib/query.js';
import { ANALYTICS_LIMITS as L, CUSTOM_FUNNEL_STEPS } from '../insights/shared/catalog.js';
import { FUNNEL_STEP_WORDS, WINDOW_CHOICES, funnelBody, stepNeedsTier3 } from '../insights/shared/figures.js';
import { AnalyticsLoadable } from '../insights/shared/ui.jsx';
import { wordFor } from '../insights/shared/words.js';

const BLANK = Object.freeze({ name: '', steps: [{ kind: 'landing_view' }, { kind: 'product_tap' }], countBy: 'session', windowMinutes: 1440 });

function StepEditor({ step, index, count, onChange, onMove, onRemove }) {
  return (
    <li className="an-step">
      <div className="an-step-editor">
        <span className="an-rank" aria-hidden="true">{index + 1}</span>
        <FieldGroup>
          <SelectField label={`Step ${index + 1}`} value={step.kind} onChange={(event) => onChange({ kind: event.target.value, page: step.page ?? '' })}>
            {CUSTOM_FUNNEL_STEPS.map((kind) => <option key={kind} value={kind}>{wordFor(FUNNEL_STEP_WORDS, kind)}{stepNeedsTier3(kind) ? ' (tier 3)' : ''}</option>)}
          </SelectField>
        </FieldGroup>
        <span className="row-actions">
          <IconButton label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={18} aria-hidden="true" /></IconButton>
          <IconButton label={`Move step ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown size={18} aria-hidden="true" /></IconButton>
          <IconButton label={`Remove step ${index + 1}`} disabled={count <= L.funnelMinSteps} onClick={onRemove}><X size={18} aria-hidden="true" /></IconButton>
        </span>
        {step.kind === 'page_view' && (
          <div className="an-step-page">
            <FieldGroup>
              <TextField label="Page address or name" maxLength={200} placeholder="/r/diwali-sale" value={step.page ?? ''} onChange={(event) => onChange({ ...step, page: event.target.value })} />
            </FieldGroup>
          </div>
        )}
      </div>
    </li>
  );
}

function FunnelForm({ initial, id }) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState({});
  const save = useMutation({
    mutationFn: (body) => (id ? api.funnels.update(id, body) : api.funnels.create(body)),
    onSuccess: async (saved) => {
      toast('Funnel saved.');
      await queries.invalidateQueries({ queryKey: ['custom-funnels'] });
      await queries.invalidateQueries({ queryKey: ['funnel', String(saved.id)] });
      navigate(`/funnels/${saved.id}`);
    },
    onError: (error) => {
      const fields = {};
      for (const [path, message] of Object.entries(error.fields ?? {})) fields[path.split('.')[0]] ??= message;
      setErrors({ ...fields, form: error.message });
    },
  });
  const setStep = (index, step) => setForm((current) => ({ ...current, steps: current.steps.map((s, i) => (i === index ? step : s)) }));

  function submit(event) {
    event.preventDefault();
    const result = funnelBody(form);
    setErrors(result.errors ?? {});
    if (!result.errors) save.mutate(result.body);
  }

  return (
    <form className="an-form" onSubmit={submit} noValidate>
      {errors.form && <Banner tone="bad">{errors.form}</Banner>}
      <FieldGroup>
        <TextField label="Name" maxLength={80} value={form.name} error={errors.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
      </FieldGroup>
      <Panel title="Steps, in order">
        <p className="muted">A shopper counts at a step only after doing every step before it, in order. The first step decides where the visit came from. Steps after an outbound click need tier 3.</p>
        <ol className="an-funnel">
          {form.steps.map((step, index) => (
            <StepEditor
              key={index}
              step={step}
              index={index}
              count={form.steps.length}
              onChange={(next) => setStep(index, next)}
              onMove={(delta) => setForm((current) => ({ ...current, steps: moveItem(current.steps, index, delta) }))}
              onRemove={() => setForm((current) => ({ ...current, steps: current.steps.filter((_, i) => i !== index) }))}
            />
          ))}
        </ol>
        {errors.steps && <p className="field-error" role="alert">{errors.steps}</p>}
        {form.steps.length < L.funnelMaxSteps && <Button variant="soft" onClick={() => setForm({ ...form, steps: [...form.steps, { kind: 'add_to_cart' }] })}><Plus size={16} aria-hidden="true" />Add a step</Button>}
      </Panel>
      <FieldGroup>
        <SelectField label="Count" value={form.countBy} onChange={(event) => setForm({ ...form, countBy: event.target.value })}>
          <option value="session">Each visit</option>
          <option value="visitor">Each shopper, across visits</option>
        </SelectField>
        <SelectField label="All steps within" value={String(form.windowMinutes)} error={errors.windowMinutes} onChange={(event) => setForm({ ...form, windowMinutes: Number(event.target.value) })}>
          {WINDOW_CHOICES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          {!WINDOW_CHOICES.some((w) => w.value === form.windowMinutes) && <option value={form.windowMinutes}>{`${form.windowMinutes} minutes`}</option>}
        </SelectField>
      </FieldGroup>
      <Button type="submit" size="large" block loading={save.isPending}>Save funnel</Button>
    </form>
  );
}

/** Building a funnel of 2 to 8 steps (7.12). Owners and managers only, as the API decides. */
export default function FunnelEditPage() {
  const { id } = useParams();
  const allowed = useAllowed();
  const existing = useQuery({ queryKey: ['funnel', id, 'definition'], queryFn: () => api.funnels.get(id), enabled: Boolean(id) });
  const back = id ? `/funnels/${id}` : '/funnels';
  if (!allowed(MANAGERS)) {
    return (
      <>
        <BackLink to={back}>Funnels</BackLink>
        <EmptyState title="Only the owner or a manager can build funnels">You can still see every funnel’s results.</EmptyState>
      </>
    );
  }
  return (
    <>
      <BackLink to={back}>{id ? 'This funnel' : 'Funnels'}</BackLink>
      <PageHeader eyebrow="Traffic" title={id ? 'Change this funnel' : 'New funnel'} />
      {id ? (
        <AnalyticsLoadable query={existing} detail label="Loading this funnel" errorTitle="We couldn’t load this funnel">
          {(funnel) => <FunnelForm id={funnel.id} initial={{ name: funnel.name, steps: funnel.steps.map((s) => ({ kind: s.kind, page: s.page ?? '' })), countBy: funnel.countBy, windowMinutes: funnel.windowMinutes }} />}
        </AnalyticsLoadable>
      ) : <FunnelForm initial={BLANK} />}
    </>
  );
}
