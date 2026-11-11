import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, Chip, EmptyState, FieldGroup, PageHeader, Panel, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { AreaTabs, PlanState, Screen, isPlanRefusal } from '../catalog/shared/ui.jsx';
import { CHANNEL_CHOICES, LEAD_TABS, channelText, consentBody, formRowBody, formsToRows, sameChannels, surfaceText } from './form.js';

/** Runs one save, holding why it was refused. */
function useSave() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [state, setState] = useState({ busy: '', failure: null, fieldError: '' });
  async function run(name, check, call, done) {
    const { body, error } = check();
    if (error) return setState({ busy: '', failure: null, fieldError: error });
    setState({ busy: name, failure: null, fieldError: '' });
    try {
      await call(body);
      toast(done);
      await refresh();
      return setState({ busy: '', failure: null, fieldError: '' });
    } catch (failure) {
      return setState({ busy: '', failure, fieldError: '' });
    }
  }
  return { ...state, run };
}

function Refusal({ failure }) {
  if (!failure) return null;
  return isPlanRefusal(failure) ? <PlanState error={failure} /> : <Banner tone="bad">{failure.message}</Banner>;
}

/** Where the form shows, and the line that invites shoppers to fill it in. Each place is saved on its own. */
function Surface({ row }) {
  const save = useSave();
  const [enabled, setEnabled] = useState(row.enabled);
  const [offerLine, setOfferLine] = useState(row.offerLine);
  const [name, about] = surfaceText(row.surface);
  const changed = enabled !== row.enabled || offerLine.trim() !== row.offerLine;

  function submit(event) {
    event.preventDefault();
    return save.run(row.surface, () => formRowBody({ surface: row.surface, enabled, offerLine }), (body) => api.leadForms.update(body), 'Saved.');
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label={name}>
      <Panel title={name}>
        <p className="muted">{about}.</p>
        <Toggle label={`Show the form on ${name.toLowerCase()}`} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <FieldGroup>
          <TextField label="Line above the form" maxLength={160} placeholder="Get first look at new drops" hint="Optional. Say what they get for leaving their details." value={offerLine} error={save.fieldError} onChange={(event) => setOfferLine(event.target.value)} />
        </FieldGroup>
        <Refusal failure={save.failure} />
        <Button type="submit" variant="soft" loading={save.busy !== ''} disabled={!changed}>Save</Button>
      </Panel>
    </form>
  );
}

/** The wording shoppers agree to. It names the business and the ways it may contact them; a change makes a new numbered version. */
function Consent({ consent }) {
  const save = useSave();
  const current = consent?.channels ?? [];
  const [picked, setPicked] = useState(current);
  const flip = (channel) => setPicked((list) => (list.includes(channel) ? list.filter((other) => other !== channel) : [...list, channel]));

  return (
    <Panel title="What shoppers agree to">
      {consent ? (
        <>
          <p className="muted">Wording {consent.version}, for {current.map(channelText).join(', ')}. Shown beside the form’s tick box.</p>
          <p className="p3-consent">{consent.body}</p>
        </>
      ) : <p className="muted">The wording is written from your business’s name as soon as you pick how you will contact people, or switch the form on.</p>}
      <span className="field-label" id="consent-channels">How you may contact them</span>
      <div className="chip-wrap" role="group" aria-labelledby="consent-channels">
        {CHANNEL_CHOICES.map(([channel, label]) => <Chip key={channel} pressed={picked.includes(channel)} onClick={() => flip(channel)}>{label}</Chip>)}
      </div>
      <p className="field-hint">Changing this writes a new wording for people who sign up from now on. Earlier leads keep the wording they agreed to.</p>
      {save.fieldError && <p className="field-error" role="alert">{save.fieldError}</p>}
      <Refusal failure={save.failure} />
      <Button variant="soft" loading={save.busy !== ''} disabled={Boolean(consent) && sameChannels(picked, current)} onClick={() => save.run('consent', () => consentBody(picked), (body) => api.leadForms.setConsent(body), 'New wording saved.')}>
        {consent ? 'Write a new wording' : 'Write the wording'}
      </Button>
    </Panel>
  );
}

function Settings({ settings, stamp }) {
  if (!settings.available) {
    return <EmptyState title="The lead form isn’t on your plan">It collects a name and a phone number or email on your pages, with consent. Ask the Bhava team about adding it.</EmptyState>;
  }
  return (
    <>
      <Consent key={`consent-${stamp}`} consent={settings.consent} />
      {formsToRows(settings).map((row) => <Surface key={`${row.surface}-${stamp}`} row={row} />)}
    </>
  );
}

export default function LeadFormPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const settings = useQuery({ queryKey: ['lead-forms'], queryFn: () => api.leadForms.get(), enabled: canManage });
  return (
    <>
      <PageHeader title="Lead form" />
      <AreaTabs label="Leads pages" tabs={LEAD_TABS} current="/leads/form" />
      {canManage ? (
        <>
          <p className="lead">A short form on your pages: a first name and a phone number or an email, and a tick box to agree.</p>
          <Screen query={settings} label="Loading your lead form" errorTitle="We couldn’t load your lead form">
            {(data) => <Settings settings={data} stamp={settings.dataUpdatedAt} />}
          </Screen>
        </>
      ) : <EmptyState title="Only the owner or a manager can change this">Ask them to set up the lead form.</EmptyState>}
    </>
  );
}
