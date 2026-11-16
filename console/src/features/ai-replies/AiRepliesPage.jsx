import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Banner, Button, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, SelectField, Sheet, Spinner, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { MANAGERS } from '@contracts/access.js';
import { usePagedList, useAllowed, useRefresh } from '../../lib/query.js';
import { Screen } from '../catalog/shared/ui.jsx';
import { UpgradePrompt } from '../billing/UpgradePrompt.jsx';
import { isPlanProblem } from '../billing/contract.js';
import '../billing/billing.css';
import { AI_THRESHOLD, FAQ_LIMITS, OUTCOMES, OUTCOME_WORDS, checkFaq, checkQuestion, percent, reasonWords, thresholdOk } from './model.js';

function FaqSheet({ entry, onClose, onPlan }) {
  const dialog = useRef(null);
  const refresh = useRefresh();
  const { toast } = useFeedback();
  const form = useForm({ question: entry?.question ?? '', answer: entry?.answer ?? '', active: entry?.active ?? true });
  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
  }, []);
  async function submit(event) {
    event.preventDefault();
    const found = checkFaq(form.values);
    if (Object.keys(found).length) return form.reject(found);
    const body = { question: form.values.question.trim(), answer: form.values.answer.trim(), active: form.values.active };
    const ok = await form.run(async () => {
      try {
        await (entry ? api.faq.update(entry.id, body) : api.faq.create(body));
      } catch (error) {
        if (isPlanProblem(error)) onPlan(error);
        throw error;
      }
    });
    if (ok) {
      dialog.current.close();
      toast(entry ? 'Answer saved.' : 'Answer added.');
      await refresh();
    }
    return ok;
  }
  return (
    <Sheet ref={dialog} title={entry ? 'Edit answer' : 'Add an answer'} onClose={onClose}>
      <form className="p7-stack" onSubmit={submit} noValidate>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <FieldGroup>
          <TextAreaField label="Question" rows={2} maxLength={FAQ_LIMITS.question + 50} {...form.field('question')} />
          <TextAreaField label="Answer" rows={4} maxLength={FAQ_LIMITS.answer + 50} {...form.field('answer')} />
        </FieldGroup>
        <Toggle label="Use this answer" {...form.toggle('active')} />
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => dialog.current.close()}>Cancel</Button>
          <Button type="submit" loading={form.busy}>Save</Button>
        </div>
      </form>
    </Sheet>
  );
}

function Faq({ onPlan }) {
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const list = usePagedList('faq', api.faq.list, {}, { retry: false });
  const [editing, setEditing] = useState(undefined);
  async function remove(entry) {
    if (!(await confirm({ title: 'Delete this answer?', text: 'The AI will stop using it.', confirm: 'Delete' }))) return;
    try {
      await api.faq.remove(entry.id);
      toast('Answer deleted.');
      await refresh();
    } catch (error) {
      toast(error.message);
    }
  }
  return (
    <Panel title="Your answers" action={<Button variant="soft" onClick={() => setEditing(null)}>Add an answer</Button>}>
      <p className="p7-meta">The AI answers only from these and your products. It never makes up an answer.</p>
      {list.isPending && <Spinner label="Loading your answers" />}
      {list.isError && <Banner tone="bad">We could not load your answers. {list.error.message}</Banner>}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="No answers yet">Add your first answer, such as your delivery time or return policy.</EmptyState>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Answers">
          {list.items.map((entry) => (
            <li key={entry.id} className="p7-item" data-testid="faq-entry">
              <span className="grow"><strong>{entry.question}</strong><span className="p7-meta p7-qa">{entry.answer}</span></span>
              {!entry.active && <Badge>Off</Badge>}
              <Button variant="outline" aria-label={`Edit ${entry.question}`} onClick={() => setEditing(entry)}>Edit</Button>
              <Button variant="outline" aria-label={`Delete ${entry.question}`} onClick={() => remove(entry)}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      <LoadMore query={list} />
      {editing !== undefined && <FaqSheet key={editing?.id ?? 'new'} entry={editing} onClose={() => setEditing(undefined)} onPlan={onPlan} />}
    </Panel>
  );
}

function Settings({ settings, onPlan }) {
  const refresh = useRefresh();
  const canChange = useAllowed()(MANAGERS); // aiReplies.save is managers only; staff with automations can read, not change
  const { toast } = useFeedback();
  const [threshold, setThreshold] = useState(String(settings.threshold));
  const save = useMutation({
    mutationFn: (body) => api.aiReplies.save(body),
    onSuccess: async () => {
      toast('Saved.');
      await refresh();
    },
    onError: (error) => {
      if (isPlanProblem(error)) onPlan(error);
      toast(error.message);
    },
  });
  const value = Number(threshold);
  const valid = thresholdOk(value);
  return (
    <Panel title="AI replies">
      <div className="p7-stack">
        {!settings.configured && <Banner tone="warn">No AI service is set up for Bhava yet, so every question goes to you.</Banner>}
        <Toggle label="Answer questions with AI" checked={settings.enabled} disabled={!canChange || save.isPending || (!settings.enabled && !settings.canEnable)} onChange={(event) => save.mutate({ enabled: event.target.checked })} />
        {!settings.canEnable && !settings.enabled && <p className="p7-meta">Add at least one answer below to switch this on.</p>}
        <TextField label="Confidence needed to send" type="number" inputMode="decimal" min={AI_THRESHOLD.min} max={AI_THRESHOLD.max} step={AI_THRESHOLD.step} value={threshold} disabled={!canChange} onChange={(event) => setThreshold(event.target.value)} error={valid ? undefined : `Use a number from ${AI_THRESHOLD.min} to ${AI_THRESHOLD.max}.`} hint="Below this, a person replies instead." />
        {!canChange && <p className="p7-meta">Only an owner or manager can change these.</p>}
        <Button variant="soft" disabled={!canChange || !valid || value === settings.threshold} loading={save.isPending} onClick={() => save.mutate({ threshold: value })}>Save confidence</Button>
      </div>
    </Panel>
  );
}

/** Asks the model and shows the answer, its sources and score. Nothing is sent to anyone. */
function TestQuestion({ onPlan }) {
  const [question, setQuestion] = useState('');
  const [problem, setProblem] = useState('');
  const ask = useMutation({
    mutationFn: (text) => api.aiReplies.testQuestion({ question: text }),
    onError: (error) => {
      if (isPlanProblem(error)) onPlan(error);
    },
  });
  function submit(event) {
    event.preventDefault();
    const found = checkQuestion(question);
    setProblem(found);
    if (!found) ask.mutate(question.trim());
  }
  const result = ask.data;
  return (
    <Panel title="Ask a test question">
      <form className="p7-stack" onSubmit={submit} noValidate>
        <p className="p7-meta">See what a shopper would get. Nothing is sent to anyone.</p>
        <TextAreaField label="Question" rows={2} value={question} onChange={(event) => setQuestion(event.target.value)} error={problem || undefined} />
        <Button type="submit" variant="soft" loading={ask.isPending}>Ask a test question</Button>
      </form>
      {ask.isError && !isPlanProblem(ask.error) && <Banner tone="bad">{ask.error.message}</Banner>}
      {result && (
        <div className="p7-stack" data-testid="test-answer">
          <Banner tone={result.wouldSend ? 'good' : 'warn'}>{result.wouldSend ? 'This would be sent.' : reasonWords(result.reason)}</Banner>
          {result.answer && <p className="p7-qa">{result.answer}</p>}
          <p className="p7-meta">Confidence {percent(result.score)} (needs {percent(result.threshold)})</p>
          <div>
            <strong>Sources</strong>
            {result.sources.length === 0 ? <p className="p7-meta">No source was used.</p> : (
              <ul className="p7-list" aria-label="Sources">
                {result.sources.map((source) => <li key={`${source.kind}-${source.id}`} className="p7-item"><Badge tone="neel">{source.kind === 'faq' ? 'Answer' : 'Product'}</Badge><span className="grow">{source.label}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function Log() {
  const [outcome, setOutcome] = useState('');
  const list = usePagedList('ai-log', api.aiReplies.log, outcome ? { outcome } : {}, { retry: false });
  return (
    <Panel title="What the AI did">
      <SelectField label="Show" value={outcome} onChange={(event) => setOutcome(event.target.value)}>
        <option value="">Everything</option>
        {OUTCOMES.map((name) => <option key={name} value={name}>{OUTCOME_WORDS[name].label}</option>)}
      </SelectField>
      {list.isPending && <Spinner label="Loading the log" />}
      {list.isError && <Banner tone="bad">We could not load the log. {list.error.message}</Banner>}
      {!list.isPending && !list.isError && list.items.length === 0 && <EmptyState title="Nothing yet">Replies and hand-offs show up here.</EmptyState>}
      {list.items.length > 0 && (
        <ul className="p7-list" aria-label="Log">
          {list.items.map((entry) => (
            <li key={entry.id} className="p7-item">
              <span className="grow">
                <span className="p7-step-title"><Badge tone={OUTCOME_WORDS[entry.outcome]?.tone}>{OUTCOME_WORDS[entry.outcome]?.label ?? entry.outcome}</Badge><span className="p7-meta">{formatDateTime(entry.at)} · {percent(entry.score)}</span></span>
                <span className="p7-meta p7-qa">{entry.question || 'Message removed after the retention period.'}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <LoadMore query={list} />
    </Panel>
  );
}

export default function AiRepliesPage() {
  const settings = useQuery({ queryKey: ['ai-replies'], queryFn: () => api.aiReplies.settings() });
  const [plan, setPlan] = useState(null);
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Automations" title="FAQ and AI replies" />
      <UpgradePrompt error={plan} />
      <Screen query={settings} label="Loading AI replies" errorTitle="We couldn’t load AI replies">
        {(data) => (
          <>
            <Settings settings={data} onPlan={setPlan} />
            <Faq onPlan={setPlan} />
            <TestQuestion onPlan={setPlan} />
            <Log />
          </>
        )}
      </Screen>
    </div>
  );
}
