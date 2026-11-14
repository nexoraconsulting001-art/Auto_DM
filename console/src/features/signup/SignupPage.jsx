import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Check, Link2 } from 'lucide-react';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, PageHeader, Panel, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { Screen } from '../catalog/shared/ui.jsx';
import '../billing/billing.css';
import { ACCOUNT_TYPES, STEP_LABELS, TYPE_COPY, checkAutomation, checkStart, minutes, problemsByField, screenFor } from './model.js';

const returnTo = (run) => `/admin/signup${run ? `?run=${encodeURIComponent(run)}` : ''}`;

function Progress({ screen }) {
  const at = STEP_LABELS.findIndex(([name]) => name === screen);
  return (
    <ol className="p7-list" aria-label="Sign-up steps">
      {STEP_LABELS.map(([name, label], index) => (
        <li key={name} className="p7-step-title" aria-current={index === at ? 'step' : undefined}>
          <Badge tone={index < at || screen === 'done' ? 'good' : index === at ? 'neel' : 'neutral'}>{index < at || screen === 'done' ? 'Done' : index === at ? 'Now' : 'Next'}</Badge>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function StartForm({ status, onStarted, initial }) {
  const form = useForm({ accountType: '', name: '', inviteCode: initial.invite, referralCode: initial.ref });
  const needsInvite = status.mode === 'invite';
  async function submit(event) {
    event.preventDefault();
    const found = checkStart(form.values);
    if (Object.keys(found).length) return form.reject(found);
    const ok = await form.run(async () => {
      const started = await api.signup.start({ accountType: form.values.accountType, name: form.values.name.trim(), inviteCode: form.values.inviteCode.trim(), referralCode: form.values.referralCode.trim(), runToken: status.runToken });
      onStarted(started);
    });
    return ok;
  }
  return (
    <Panel title="What are you here to do?">
      <form className="p7-stack" onSubmit={submit} noValidate>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div role="radiogroup" aria-label="Account type" className="p7-stack">
          {ACCOUNT_TYPES.map((type) => (
            <label key={type} className="p7-plan" data-current={form.values.accountType === type}>
              <span className="p7-row">
                <input type="radio" name="accountType" value={type} checked={form.values.accountType === type} onChange={() => form.set('accountType', type)} />
                <strong>{TYPE_COPY[type].title}</strong>
              </span>
              <span className="p7-meta">{TYPE_COPY[type].text}</span>
            </label>
          ))}
          {form.errors.accountType && <span className="field-error">{form.errors.accountType}</span>}
        </div>
        <FieldGroup>
          <TextField label={form.values.accountType === 'seller' ? 'Shop name' : 'Your name'} autoComplete="organization" {...form.field('name')} />
          {needsInvite && <TextField label="Invite code" hint="Sign-up is by invite right now." {...form.field('inviteCode')} />}
          <TextField label="Referral code (optional)" {...form.field('referralCode')} />
        </FieldGroup>
        <Button type="submit" size="large" block loading={form.busy}>Continue</Button>
      </form>
    </Panel>
  );
}

function InstagramStep({ onContinue, run }) {
  const connection = useQuery({ queryKey: ['signup', 'instagram'], queryFn: () => api.instagram.connection() });
  const connect = useMutation({
    mutationFn: () => api.instagram.connect({ returnTo: returnTo(run) }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
  });
  return (
    <Panel title="Connect your Instagram">
      <Screen query={connection} label="Checking your Instagram" errorTitle="We couldn’t check Instagram">
        {(data) => (
          <div className="p7-stack">
            {data.status === 'active'
              ? <Banner tone="good">Connected{data.username ? ` as @${data.username}` : ''}.</Banner>
              : <p className="p7-meta">Use Meta’s official login. We never ask for your Instagram password and we never post for you.</p>}
            {connect.isError && <Banner tone="bad">{connect.error.message}</Banner>}
            {data.status === 'active'
              ? <Button size="large" block onClick={onContinue}>Continue</Button>
              : <Button size="large" block loading={connect.isPending} onClick={() => connect.mutate()}><Link2 size={18} aria-hidden="true" /> Connect Instagram</Button>}
          </div>
        )}
      </Screen>
    </Panel>
  );
}

function AutomationStep({ runToken, onDone }) {
  const reels = useQuery({ queryKey: ['signup', 'reels'], queryFn: () => api.instagram.media({ type: 'reel', limit: 12 }) });
  const form = useForm({ mediaId: '', keyword: '', link: '' });
  const [problems, setProblems] = useState({});
  async function submit(event) {
    event.preventDefault();
    setProblems({});
    const found = checkAutomation(form.values);
    if (Object.keys(found).length) return form.reject(found);
    return form.run(async () => {
      const result = await api.signup.firstAutomation({ runToken, mediaId: form.values.mediaId, keyword: form.values.keyword.trim(), link: form.values.link.trim() });
      if (result.problems.length) {
        setProblems(problemsByField(result.problems));
        throw Object.assign(new Error('Fix the highlighted details and try again.'), { fields: {} });
      }
      onDone(result);
    });
  }
  const shown = { ...problems, ...form.errors };
  return (
    <Panel title="Your first automation">
      <p className="p7-meta">When someone comments your keyword on a reel, they get your link in a DM.</p>
      <form className="p7-stack" onSubmit={submit} noValidate>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Screen query={reels} label="Loading your reels" errorTitle="We couldn’t load your reels">
          {(data) => (data.items.length === 0
            ? <EmptyState title="No reels found">Post a reel on Instagram, then come back.</EmptyState>
            : (
              <fieldset className="p7-stack">
                <legend className="field-label">Pick a reel</legend>
                <ChipRow label="Reels">
                  {data.items.map((reel) => (
                    <Chip key={reel.id} pressed={form.values.mediaId === reel.id} onClick={() => form.set('mediaId', reel.id)}>{(reel.caption || 'Reel').slice(0, 24)}</Chip>
                  ))}
                </ChipRow>
                {shown.mediaId && <span className="field-error">{shown.mediaId}</span>}
              </fieldset>
            ))}
        </Screen>
        <FieldGroup>
          <TextField label="Keyword" hint="The word people comment, such as LINK." {...form.field('keyword')} error={shown.keyword} />
          <TextField label="Link to send" inputMode="url" {...form.field('link')} error={shown.link} />
        </FieldGroup>
        <Button type="submit" size="large" block loading={form.busy}>Make it live</Button>
      </form>
    </Panel>
  );
}

function FinishStep({ runToken, onDone }) {
  const finish = useMutation({ mutationFn: () => api.signup.finish({ runToken }), onSuccess: onDone });
  return (
    <Panel title="You are ready">
      <div className="p7-stack">
        <Banner tone="good">Your first automation is live.</Banner>
        {finish.isError && <Banner tone="bad">{finish.error.message}</Banner>}
        <Button size="large" block loading={finish.isPending} onClick={() => finish.mutate()}>Finish sign-up</Button>
      </div>
    </Panel>
  );
}

function Done({ finished }) {
  return (
    <Panel title="Welcome to Bhava">
      <div className="p7-stack">
        <p className="p7-row"><Check size={20} aria-hidden="true" /> You are set up{finished ? ` in about ${minutes(finished.elapsedMs)} ${minutes(finished.elapsedMs) === 1 ? 'minute' : 'minutes'}` : ''}.</p>
        {finished && <a className="btn btn-primary btn-large btn-block" href={`https://${finished.host}/admin`}>Open your console</a>}
        {!finished && <a className="btn btn-primary btn-large btn-block" href={`${import.meta.env.BASE_URL}`}>Open your console</a>}
      </div>
    </Panel>
  );
}

export default function SignupPage() {
  const [params, setParams] = useSearchParams();
  const queries = useQueryClient();
  const initial = { invite: params.get('invite') ?? '', ref: params.get('ref') ?? '' };
  // The run the server opened for this person stays in the address, so a reload or a return from Instagram resumes it.
  const run = params.get('run') ?? '';
  const [finished, setFinished] = useState(null);
  const [instagramDone, setInstagramDone] = useState(false);
  const status = useQuery({
    queryKey: ['signup', 'status', run],
    queryFn: () => api.signup.status({ ...(run ? { runToken: run } : {}), ...(initial.invite ? { inviteCode: initial.invite } : {}), ...(initial.ref ? { ref: initial.ref } : {}) }),
  });
  const refresh = () => queries.invalidateQueries({ queryKey: ['signup'] });
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Welcome" title="Set up Bhava" />
      <Screen query={status} label="Opening sign-up" errorTitle="We couldn’t open sign-up">
        {(data) => {
          const screen = finished ? 'done' : instagramDone && screenFor(data) === 'instagram' ? 'automation' : screenFor(data);
          return (
            <>
              <Progress screen={screen} />
              {screen === 'signin' && <EmptyState title="Sign in first">Sign in with your WhatsApp number or Google, then come back here.</EmptyState>}
              {screen === 'closed' && <EmptyState title="Sign-up is closed right now">{data.mode === 'invite' ? 'Sign-up is by invite. Ask the Bhava team for your invite code.' : 'Please check back soon.'}</EmptyState>}
              {screen === 'type' && <StartForm status={data} initial={initial} onStarted={(started) => { setParams((current) => { const next = new URLSearchParams(current); next.set('run', started.runToken); return next; }, { replace: true }); refresh(); }} />}
              {screen === 'instagram' && <InstagramStep run={run} onContinue={() => setInstagramDone(true)} />}
              {screen === 'automation' && <AutomationStep runToken={data.runToken} onDone={refresh} />}
              {screen === 'finish' && <FinishStep runToken={data.runToken} onDone={(result) => { setFinished(result); refresh(); }} />}
              {screen === 'done' && <Done finished={finished} />}
            </>
          );
        }}
      </Screen>
    </div>
  );
}
