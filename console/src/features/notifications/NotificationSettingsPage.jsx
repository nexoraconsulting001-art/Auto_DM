import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, FieldGroup, Loadable, PageHeader, Panel, SelectField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import '../account/account.css';
import { CHANNEL_LABELS, choiceBody, quietHoursProblems, quietHoursText, timezoneChoices, withChoice } from './rules.js';

const PREFS_KEY = ['notification-prefs'];

function QuietHours({ saved }) {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const [form, setForm] = useState(saved);
  const [problems, setProblems] = useState({});
  const zones = timezoneChoices(saved.timezone);
  const save = useMutation({
    mutationFn: (quietHours) => api.notifications.savePrefs({ quietHours }),
    onSuccess: (prefs) => {
      toast('Quiet hours saved.');
      queries.setQueryData(PREFS_KEY, prefs); // the form starts again from what was saved
    },
    onError: (error) => setProblems(Object.fromEntries(Object.entries(error.fields ?? {}).map(([field, message]) => [field.replace(/^quietHours\./, ''), message]))),
  });
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));

  function submit(event) {
    event.preventDefault();
    const found = quietHoursProblems(form);
    setProblems(found);
    if (!Object.keys(found).length) save.mutate(form);
  }

  return (
    <Panel title="Quiet hours">
      <p className="muted">{quietHoursText(saved)}</p>
      <form className="stack" onSubmit={submit} noValidate>
        {save.isError && !Object.keys(problems).length && <Banner tone="bad">{save.error.message}</Banner>}
        <Toggle label="Hold push and WhatsApp at night" checked={form.enabled} onChange={set('enabled')} />
        <FieldGroup>
          <div className="acct-two">
            <TextField label="From" type="time" name="quiet-from" required value={form.from} error={problems.from} onChange={set('from')} />
            <TextField label="To" type="time" name="quiet-to" required value={form.to} error={problems.to} onChange={set('to')} />
          </div>
          <SelectField label="Time zone" name="quiet-zone" value={form.timezone} error={problems.timezone} onChange={set('timezone')}>
            {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
          </SelectField>
        </FieldGroup>
        <p className="acct-footnote">Email and the list here are never held. Urgent alerts, such as a connection that stopped working, always come at once.</p>
        <Button type="submit" loading={save.isPending}>Save quiet hours</Button>
      </form>
    </Panel>
  );
}

function Choices({ prefs }) {
  const queries = useQueryClient();
  const [problem, setProblem] = useState('');
  const choose = useMutation({
    mutationFn: ({ kind, channel, enabled }) => api.notifications.savePrefs(choiceBody(kind, channel, enabled)),
    onMutate: ({ kind, channel, enabled }) => {
      setProblem('');
      const before = queries.getQueryData(PREFS_KEY);
      queries.setQueryData(PREFS_KEY, (current) => (current ? withChoice(current, kind, channel, enabled) : current));
      return { before };
    },
    onSuccess: (saved) => queries.setQueryData(PREFS_KEY, saved),
    onError: (error, _vars, context) => {
      if (context?.before) queries.setQueryData(PREFS_KEY, context.before);
      setProblem(error.message);
    },
  });

  return (
    <Panel title="What you hear about">
      <p className="muted">Everything is always in your notifications list here. Choose where else each one reaches you.</p>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <div className="acct-kinds">
        {prefs.kinds.map((kind) => (
          <section key={kind.kind} className="acct-kind" aria-label={kind.label}>
            <div className="acct-kind-head">
              <h3 className="acct-kind-name">{kind.label}</h3>
              {kind.critical && <Badge tone="warn">Urgent</Badge>}
              {kind.mandatory && <Badge tone="ink">Security notice</Badge>}
            </div>
            {kind.mandatory ? (
              <p className="acct-footnote">A security notice: it always reaches you and can’t be turned off.</p>
            ) : kind.channels.length ? (
              kind.channels.map((channel) => {
                const available = prefs.available[channel];
                return (
                  <Toggle
                    key={channel}
                    label={available ? CHANNEL_LABELS[channel] : `${CHANNEL_LABELS[channel]} (not set up yet)`}
                    checked={Boolean(prefs.events[kind.kind]?.[channel])}
                    disabled={!available || choose.isPending}
                    onChange={(event) => choose.mutate({ kind: kind.kind, channel, enabled: event.target.checked })}
                  />
                );
              })
            ) : (
              <p className="acct-footnote">Shown in your notifications list only.</p>
            )}
          </section>
        ))}
      </div>
    </Panel>
  );
}

/** Notification settings (PRD 5.13, 10.5): per kind and channel, with quiet hours for what is not urgent. This person's own, in this business. */
export default function NotificationSettingsPage() {
  const prefs = useQuery({ queryKey: PREFS_KEY, queryFn: api.notifications.prefs });
  return (
    <>
      <BackLink to="/notifications">Notifications</BackLink>
      <PageHeader eyebrow="Settings" title="Notification settings" />
      <Loadable query={prefs} label="Loading your choices" errorTitle="We couldn’t load your choices">
        {(data) => (
          <>
            <QuietHours key={JSON.stringify(data.quietHours)} saved={data.quietHours} />
            <Choices prefs={data} />
          </>
        )}
      </Loadable>
    </>
  );
}
