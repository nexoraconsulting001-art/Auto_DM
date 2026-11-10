import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, Loadable, PageHeader, Panel, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { LOWERABLE_CAPS, WORD_LISTS, capsToOverrides, overridesToCaps } from './notices.js';
import './compliance.css';

function RulesForm({ settings, canEdit }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ dryRun: settings.dryRun, disclosureEnabled: settings.disclosureEnabled, utmEnabled: settings.utmEnabled, ...overridesToCaps(settings.capOverrides) });

  async function save(event) {
    event.preventDefault();
    const { overrides, errors } = capsToOverrides(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      await api.compliance.updateSettings({ dryRun: form.values.dryRun, disclosureEnabled: form.values.disclosureEnabled, utmEnabled: form.values.utmEnabled, capOverrides: overrides });
      toast('Saved.');
      await refresh();
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="How messages go out">
        <Toggle label="Dry run for the whole business" disabled={!canEdit} {...form.toggle('dryRun')} />
        <p className="field-hint">Every rule runs and is logged, and nothing is sent.</p>
        <Toggle label="Add an “Automated reply” note" disabled={!canEdit} {...form.toggle('disclosureEnabled')} />
        <p className="field-hint">A neutral line at the end of each automated DM. It counts toward the length limit.</p>
        <Toggle label="Add tracking tags to my website links" disabled={!canEdit} {...form.toggle('utmEnabled')} />
      </Panel>
      <Panel title="Limits">
        <p className="muted">You can make these stricter, never looser. Leave one empty for the standard limit.</p>
        <FieldGroup>
          {LOWERABLE_CAPS.map(({ code, label, max }) => (
            <TextField key={code} label={label} inputMode="numeric" placeholder={String(max)} disabled={!canEdit} name={code} value={form.values[code]} error={form.errors[code]} onChange={(event) => form.set(code, event.target.value)} />
          ))}
        </FieldGroup>
      </Panel>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      {canEdit && <Button type="submit" size="large" block loading={form.busy}>Save rules</Button>}
    </form>
  );
}

function WordsPanel({ canEdit }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [list, setList] = useState(WORD_LISTS[0].code);
  const [draft, setDraft] = useState('');
  const words = useQuery({ queryKey: ['compliance-words', list], queryFn: () => api.compliance.words({ list }) });
  const add = useMutation({
    mutationFn: () => api.compliance.addWord({ list, word: draft.trim() }),
    onSuccess: async () => {
      setDraft('');
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  const remove = useMutation({
    mutationFn: (id) => api.compliance.removeWord(id),
    onSuccess: () => refresh(),
    onError: (error) => toast(error.message),
  });
  const current = WORD_LISTS.find((entry) => entry.code === list);

  function submit(event) {
    event.preventDefault();
    if (draft.trim()) add.mutate();
  }

  return (
    <Panel title="Words we watch for">
      <ChipRow label="Word list">
        {WORD_LISTS.map((entry) => <Chip key={entry.code} pressed={entry.code === list} onClick={() => setList(entry.code)}>{entry.label}</Chip>)}
      </ChipRow>
      <p className="muted">{current.text}</p>
      <Loadable query={words} label="Loading this list" errorTitle="We couldn’t load this list">
        {({ base, added }) => (
          <>
            {added.length ? (
              <div className="keyword-list">
                {added.map((word) => (
                  <span key={word.id} className="keyword">
                    {word.word}
                    {canEdit && <button type="button" className="keyword-remove" aria-label={`Remove ${word.word}`} onClick={() => remove.mutate(word.id)}><X size={14} aria-hidden="true" /></button>}
                  </span>
                ))}
              </div>
            ) : <EmptyState title="No words of your own yet">The standard list below always applies.</EmptyState>}
            <details className="word-base">
              <summary>Standard list ({base.length})</summary>
              {base.join(', ')}
            </details>
          </>
        )}
      </Loadable>
      {canEdit && (
        <form className="inline-field" onSubmit={submit} noValidate>
          <FieldGroup>
            <TextField label="Add a word" maxLength={60} value={draft} onChange={(event) => setDraft(event.target.value)} />
          </FieldGroup>
          <Button type="submit" variant="soft" loading={add.isPending} disabled={!draft.trim()}>Add</Button>
        </form>
      )}
    </Panel>
  );
}

export default function ComplianceSettingsPage() {
  const allowed = useAllowed();
  const canEdit = allowed(MANAGERS);
  const settings = useQuery({ queryKey: ['compliance-settings'], queryFn: () => api.compliance.settings() });
  return (
    <>
      <BackLink to="/compliance">Compliance</BackLink>
      <PageHeader title="Rules and word lists" />
      {!canEdit && <Banner>Only the owner or a manager can change these.</Banner>}
      <Loadable query={settings} label="Loading your rules" errorTitle="We couldn’t load your rules">
        {(current) => <RulesForm settings={current} canEdit={canEdit} />}
      </Loadable>
      <WordsPanel canEdit={canEdit} />
    </>
  );
}
