import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, EmptyState, PageHeader, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { useFresh } from '../account/fresh.jsx';
import { CREDENTIAL_STATUS, apnsProblems, fcmProblem } from './rules.js';
import { AreaTabs, Note, SecretBox, Status, StoreScreen, UpgradePrompt, useAppConfig, useFields } from './ui.jsx';

const BLANK_APNS = { keyId: '', teamId: '', key: '', env: 'production' };

function useSave(fresh, fields, queries) {
  const { toast } = useFeedback();
  return async (body, doneText) => {
    const done = await fields.run(async () => {
      const saved = await fresh.run(() => api.pushCredentials.save(body));
      queries.setQueryData(['app-publishing', 'push-credentials'], saved);
    });
    if (done) toast(doneText);
    return done;
  };
}

function FcmCard({ fcm, fresh }) {
  const { confirm } = useFeedback();
  const queries = useQueryClient();
  const fields = useFields({ serviceAccount: '' });
  const [shown, setShown] = useState('');
  const save = useSave(fresh, fields, queries);

  async function submit(event) {
    event.preventDefault();
    const problem = fcmProblem(fields.values.serviceAccount);
    setShown(problem);
    if (problem) return;
    const body = { fcm: { serviceAccount: fields.values.serviceAccount.trim() } };
    await save(body, 'Your Firebase key is saved. It cannot be read back.');
    fields.reset({ serviceAccount: '' }); // saved or refused, it is not kept here
  }

  async function remove() {
    if (await confirm({ title: 'Remove the Firebase key?', text: 'Android shoppers stop getting offers and order updates until you add a key again.', confirm: 'Remove it' })) {
      await save({ fcm: null }, 'Your Firebase key is removed.');
    }
  }

  return (
    <form className="myapp-form" onSubmit={submit} noValidate aria-label="Android push key">
      <Panel title="Android: Firebase service account" action={<Status table={CREDENTIAL_STATUS} value={fcm.status} />}>
        {fcm.set
          ? <Note tone="good">A key is saved for project {fcm.projectId || 'your project'}{fcm.clientEmailMasked ? ` (${fcm.clientEmailMasked})` : ''}. It is never shown again. Paste a new one to replace it.</Note>
          : <p className="field-hint">No key saved yet. Without one, Android shoppers get no push messages.</p>}
        {fcm.status === 'invalid' && <Banner tone="bad">Firebase did not accept the saved key. Paste a new one.</Banner>}
        <SecretBox label="Service account file (JSON)" hint="In Firebase, open Project settings, Service accounts, and make a new private key. Paste the whole file." rows={5} value={fields.values.serviceAccount} onChange={(event) => { fields.set('serviceAccount', event.target.value); setShown(''); }} error={fields.server.fcm || fields.server.serviceAccount || shown} />
        {fields.message && <Banner tone="bad">{fields.message}</Banner>}
        <div className="myapp-actions">
          <Button type="submit" loading={fields.busy}>Save Firebase key</Button>
          {fcm.set && <Button variant="danger" onClick={remove}>Remove</Button>}
        </div>
      </Panel>
    </form>
  );
}

function ApnsCard({ apns, fresh }) {
  const { confirm } = useFeedback();
  const queries = useQueryClient();
  const fields = useFields(BLANK_APNS);
  const [shown, setShown] = useState({});
  const save = useSave(fresh, fields, queries);
  const clearShown = (name) => setShown((current) => ({ ...current, [name]: '' }));

  async function submit(event) {
    event.preventDefault();
    const { body, errors } = apnsProblems(fields.values);
    setShown(errors);
    if (!body) {
      fields.setMessage(Object.values(errors)[0]);
      return;
    }
    await save({ apns: body }, 'Your Apple push key is saved. It cannot be read back.');
    fields.reset(BLANK_APNS);
  }

  async function remove() {
    if (await confirm({ title: 'Remove the Apple push key?', text: 'iPhone shoppers stop getting offers and order updates until you add a key again.', confirm: 'Remove it' })) {
      await save({ apns: null }, 'Your Apple push key is removed.');
    }
  }

  const field = (name, label, extra = {}) => (
    <TextField label={label} value={fields.values[name]} error={fields.server[name] || shown[name]} autoComplete="off" spellCheck={false} onChange={(event) => { fields.set(name, event.target.value); clearShown(name); }} {...extra} />
  );
  return (
    <form className="myapp-form" onSubmit={submit} noValidate aria-label="iPhone push key">
      <Panel title="iPhone and iPad: Apple push key" action={<Status table={CREDENTIAL_STATUS} value={apns.status} />}>
        {apns.set
          ? <Note tone="good">A key is saved (key ID {apns.keyId}, team {apns.teamId}, {apns.env}). The key itself is never shown. Add a new one to replace it.</Note>
          : <p className="field-hint">No key saved yet. Without one, iPhone shoppers get no push messages.</p>}
        {apns.status === 'invalid' && <Banner tone="bad">Apple did not accept the saved key. Add a new one.</Banner>}
        <div className="myapp-form">
          {field('keyId', 'APNs key ID', { autoCapitalize: 'characters' })}
          {field('teamId', 'Apple team ID', { autoCapitalize: 'characters' })}
          <SecretBox label="APNs key (.p8 file)" hint="Make an APNs key in your Apple Developer account. Paste the file’s contents. This is a key, not your Apple sign-in." rows={4} value={fields.values.key} onChange={(event) => { fields.set('key', event.target.value); clearShown('key'); }} error={fields.server.key || shown.key} />
          <SelectField label="Use it for" value={fields.values.env} onChange={(event) => fields.set('env', event.target.value)}>
            <option value="production">Live app (production)</option>
            <option value="sandbox">Test builds (sandbox)</option>
          </SelectField>
        </div>
        {fields.message && <Banner tone="bad">{fields.message}</Banner>}
        <div className="myapp-actions">
          <Button type="submit" loading={fields.busy}>Save Apple key</Button>
          {apns.set && <Button variant="danger" onClick={remove}>Remove</Button>}
        </div>
      </Panel>
    </form>
  );
}

export default function PushKeysPage() {
  const allowed = useAllowed();
  const owner = allowed(OWNER_ONLY);
  const fresh = useFresh();
  const config = useAppConfig();
  const credentials = useQuery({ queryKey: ['app-publishing', 'push-credentials'], queryFn: () => api.pushCredentials.get(), enabled: owner });
  const entitled = (platform) => !config.data || config.data[platform].entitled;
  return (
    <>
      <PageHeader title="Push keys" />
      <AreaTabs current="/my-app/push-keys" />
      {!owner ? (
        <EmptyState title="Only the owner can set push keys">Ask the owner of your business to add them. They are confirmed with a code each time.</EmptyState>
      ) : (
        <StoreScreen query={credentials} label="Loading your push keys" errorTitle="We couldn’t load your push keys">
          {(data) => (
            <div className="myapp-stack">
              <p className="field-hint myapp-promise">Keys are stored encrypted and cannot be read back. Saving one asks you to confirm it is you with a code on WhatsApp. We never ask for your Apple or Google password.</p>
              {entitled('android') ? <FcmCard fcm={data.fcm} fresh={fresh} /> : <UpgradePrompt platform="android" what="push messages" />}
              {entitled('ios') ? <ApnsCard apns={data.apns} fresh={fresh} /> : <UpgradePrompt platform="ios" what="push messages" />}
            </div>
          )}
        </StoreScreen>
      )}
      {fresh.sheet}
    </>
  );
}
