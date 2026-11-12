import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, PageHeader, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed } from '../../lib/query.js';
import { useFresh } from '../account/fresh.jsx';
import {
  ACCESS_STATUS, ACCOUNT_TYPES, CLOSED_TEST, DUNS_OPTIONS, PLATFORMS, PLATFORM_LABELS, STORE_LABELS, ascKeyProblems, closedTestSummary, failureText,
} from './rules.js';
import { AreaTabs, NoPasswords, Note, SecretBox, Status, StoreScreen, UpgradePrompt, useAppConfig, useFields } from './ui.jsx';

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');

function Steps({ steps }) {
  if (!steps?.length) return null;
  return (
    <ol className="myapp-steps" aria-label="Steps">
      {steps.map((step) => (
        <li key={step.code} data-done={step.done}>
          <span><Badge tone={step.done ? 'good' : 'neutral'}>{step.done ? 'Done' : 'To do'}</Badge> <strong>{step.title}</strong></span>
          {step.warning && <span className="warning">{step.warning}</span>}
        </li>
      ))}
    </ol>
  );
}

function AccountForm({ access, owner, fresh, onSaved }) {
  const { toast } = useFeedback();
  const { platform } = access;
  const fields = useFields({
    accountType: access.accountType === 'unknown' ? '' : access.accountType,
    legalName: access.legalName,
    dunsStatus: access.dunsStatus === 'unknown' ? '' : access.dunsStatus,
    playAccountAfterCutoff: false,
    startedAt: day(access.closedTest.startedAt),
    testers: access.closedTest.testers ?? '',
  });
  const { values } = fields;
  const personalPlay = platform === 'android' && values.accountType === 'personal';

  async function save(event) {
    event.preventDefault();
    const body = {};
    const errors = {};
    if (values.accountType && values.accountType !== access.accountType) body.accountType = values.accountType;
    if (values.legalName.trim() !== access.legalName) body.legalName = values.legalName.trim();
    if (values.accountType === 'organisation' && values.dunsStatus && values.dunsStatus !== access.dunsStatus) body.dunsStatus = values.dunsStatus;
    if (platform === 'android' && values.accountType && values.playAccountAfterCutoff) body.playAccountAfterCutoff = true;
    if (personalPlay && (values.startedAt || values.testers !== '')) {
      const testers = values.testers === '' ? null : Number(values.testers);
      if (testers !== null && (!Number.isInteger(testers) || testers < 0 || testers > 1000)) errors.testers = 'Testers is a number from 0 to 1000.';
      else body.closedTest = { startedAt: values.startedAt ? `${values.startedAt}T00:00:00+05:30` : null, testers };
    }
    fields.touchAll(Object.keys(values));
    if (values.legalName.length > 200) errors.legalName = 'Legal name is too long. The most is 200 characters.';
    if (Object.keys(errors).length) {
      fields.setMessage(Object.values(errors)[0]);
      return undefined;
    }
    if (!Object.keys(body).length) return toast('Nothing has changed.');
    const done = await fields.run(async () => { onSaved(await fresh.run(() => api.storeAccess.save(platform, body))); });
    if (done) toast(`${PLATFORM_LABELS[platform]} account details saved.`);
    return undefined;
  }

  return (
    <form className="myapp-form" onSubmit={save} noValidate aria-label={`${PLATFORM_LABELS[platform]} account`}>
      <fieldset className="myapp-radio">
        <legend>Account type</legend>
        {ACCOUNT_TYPES.map(([value, label]) => (
          <label key={value}><input type="radio" name={`type-${platform}`} value={value} checked={values.accountType === value} onChange={() => fields.set('accountType', value)} /> {label}</label>
        ))}
      </fieldset>
      <TextField label="Legal name on the account" hint="Shoppers see this as the app’s seller." value={values.legalName} maxLength={220} autoComplete="organization" onChange={(event) => fields.set('legalName', event.target.value)} error={fields.server.legalName} />
      {values.accountType === 'organisation' && (
        <>
          <SelectField label="D-U-N-S number" hint="Organisation accounts need one. Applying can take a few weeks." value={values.dunsStatus} onChange={(event) => fields.set('dunsStatus', event.target.value)} error={fields.server.dunsStatus}>
            <option value="">Choose one</option>
            {DUNS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </SelectField>
          {access.dunsLookupUrl && /^https:\/\//.test(access.dunsLookupUrl) && (
            <p className="field-hint"><a href={access.dunsLookupUrl} target="_blank" rel="noopener noreferrer">Look up or apply for a D-U-N-S number</a></p>
          )}
        </>
      )}
      {platform === 'android' && (
        <label className="myapp-check">
          <input type="checkbox" checked={values.playAccountAfterCutoff} onChange={(event) => fields.set('playAccountAfterCutoff', event.target.checked)} />
          My Play developer account was made after Google started asking for a closed test
        </label>
      )}
      {personalPlay && (
        <Panel title="Closed test">
          <p className="field-hint">Google asks a personal account for {CLOSED_TEST.testers} testers who stay for {CLOSED_TEST.days} days in a row before it can publish.</p>
          <div className="myapp-grid">
            <TextField label="Day the test started" type="date" value={values.startedAt} onChange={(event) => fields.set('startedAt', event.target.value)} />
            <TextField label="Testers joined" type="number" min="0" max="1000" inputMode="numeric" value={values.testers} onChange={(event) => fields.set('testers', event.target.value)} error={fields.server.testers} />
          </div>
          <p className="myapp-meta" role="status">{closedTestSummary(access.closedTest)}</p>
        </Panel>
      )}
      {fields.message && <Banner tone="bad">{fields.message}</Banner>}
      {!owner && <p className="field-hint">Only the owner can change store accounts.</p>}
      <div className="myapp-actions"><Button type="submit" loading={fields.busy} disabled={!owner}>Save account details</Button></div>
    </form>
  );
}

function KeyForm({ access, owner, fresh, onSaved }) {
  const { toast, confirm } = useFeedback();
  const fields = useFields({ keyId: '', issuerId: '', privateKey: '' });
  const [shown, setShown] = useState({});
  const { credential } = access;

  async function save(event) {
    event.preventDefault();
    const { body, errors } = ascKeyProblems(fields.values);
    setShown(errors);
    if (!body) {
      fields.setMessage(Object.values(errors)[0]);
      return undefined;
    }
    fields.setMessage('');
    const done = await fields.run(async () => { onSaved(await fresh.run(() => api.storeAccess.save('ios', { ascKey: body }))); });
    // Whatever the answer was, the key is not kept on this page.
    fields.reset({ keyId: '', issuerId: '', privateKey: '' });
    if (done) toast('Your App Store Connect key is saved. It cannot be read back.');
    return undefined;
  }

  async function remove() {
    if (!(await confirm({ title: 'Remove the App Store Connect key?', text: 'We can no longer send builds or read review results until you add a key again.', confirm: 'Remove it' }))) return;
    await fields.run(async () => { onSaved(await fresh.run(() => api.storeAccess.save('ios', { ascKey: null }))); });
  }

  const err = (name) => fields.server[name] || shown[name];
  return (
    <form className="myapp-form" onSubmit={save} noValidate aria-label="App Store Connect key">
      <Panel title="App Store Connect key">
        <p className="field-hint">Make an API key in App Store Connect (Users and Access, Integrations) with the App Manager role, and give us its three parts. This is a key, not your Apple sign-in.</p>
        {credential.set
          ? <Note tone="good">A key is saved{credential.keyId ? ` (key ID ${credential.keyId}` : ''}{credential.keyLast4 ? `, ends in ${credential.keyLast4})` : credential.keyId ? ')' : ''}. It is never shown again. Enter a new one to replace it.</Note>
          : <p className="field-hint">No key saved yet.</p>}
        <div className="myapp-form">
          <TextField label="Key ID" value={fields.values.keyId} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={(event) => { fields.set('keyId', event.target.value); setShown((s) => ({ ...s, keyId: '' })); }} error={err('keyId')} />
          <TextField label="Issuer ID" value={fields.values.issuerId} autoComplete="off" spellCheck={false} onChange={(event) => { fields.set('issuerId', event.target.value); setShown((s) => ({ ...s, issuerId: '' })); }} error={err('issuerId')} />
          <SecretBox label="Private key (.p8 file)" hint="Paste the file’s contents. Saving asks you to confirm it is you." rows={4} value={fields.values.privateKey} onChange={(event) => { fields.set('privateKey', event.target.value); setShown((s) => ({ ...s, privateKey: '' })); }} error={err('privateKey')} />
        </div>
        {fields.message && <Banner tone="bad">{fields.message}</Banner>}
        <div className="myapp-actions">
          <Button type="submit" loading={fields.busy} disabled={!owner}>Save key</Button>
          {credential.set && <Button variant="danger" onClick={remove} disabled={!owner}>Remove key</Button>}
        </div>
      </Panel>
    </form>
  );
}

function PlayAccess({ access }) {
  return (
    <Panel title="Let us into your Play Console">
      <p className="field-hint">In Play Console, open Users and permissions, invite this address, and give it the {access.access.roleNeeded || 'release manager'} role. You do not share a password.</p>
      {access.serviceAccountEmail
        ? <p className="store-code" data-testid="service-account-email">{access.serviceAccountEmail}</p>
        : <p className="field-hint">The address will appear here when your account is ready.</p>}
    </Panel>
  );
}

function AccessCheck({ access, owner, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const { platform } = access;
  async function check() {
    setBusy(true);
    setProblem('');
    try {
      onSaved(await api.storeAccess.check(platform));
    } catch (error) {
      setProblem(failureText(error));
    } finally {
      setBusy(false);
    }
  }
  const { status, roleFound, roleNeeded, checkedAt } = access.access;
  return (
    <Panel title={`Our access to ${STORE_LABELS[platform].replace(/^the /, '')}`} action={<Status table={ACCESS_STATUS} value={status} />}>
      {status === 'role_too_low' && <Banner tone="warn">The role we found{roleFound ? ` (${roleFound})` : ''} is too low. We need {roleNeeded || 'a higher role'}.</Banner>}
      {status === 'invalid' && <Banner tone="bad">The store did not accept the key. Make a new one and save it again.</Banner>}
      {status === 'unreachable' && <Banner tone="warn">We could not reach the store just now. Try again in a few minutes.</Banner>}
      {checkedAt && <p className="myapp-meta">Last checked {formatDateTime(checkedAt)}</p>}
      {problem && <Banner tone="bad">{problem}</Banner>}
      <div className="myapp-actions"><Button variant="outline" onClick={check} loading={busy} disabled={!owner}>Check access</Button></div>
    </Panel>
  );
}

function PlatformSection({ access, owner, fresh }) {
  const queries = useQueryClient();
  const onSaved = (saved) => queries.setQueryData(['app-publishing', 'store-access'], (current) => (current ? { items: current.items.map((item) => (item.platform === saved.platform ? saved : item)) } : current));
  return (
    <section className="myapp-stack" aria-label={`${PLATFORM_LABELS[access.platform]} store account`}>
      <h2>{PLATFORM_LABELS[access.platform]} · {STORE_LABELS[access.platform].replace(/^the /, '')}</h2>
      <Steps steps={access.steps} />
      <AccountForm key={`${access.platform}-${access.accountType}-${access.legalName}`} access={access} owner={owner} fresh={fresh} onSaved={onSaved} />
      {access.platform === 'android' ? <PlayAccess access={access} /> : <KeyForm access={access} owner={owner} fresh={fresh} onSaved={onSaved} />}
      <AccessCheck access={access} owner={owner} onSaved={onSaved} />
    </section>
  );
}

export default function StoreAccountsPage() {
  const config = useAppConfig();
  const allowed = useAllowed();
  const fresh = useFresh();
  const owner = allowed(OWNER_ONLY);
  const list = useQuery({ queryKey: ['app-publishing', 'store-access'], queryFn: () => api.storeAccess.get() });
  return (
    <>
      <PageHeader title="Store accounts" />
      <AreaTabs current="/my-app/stores" />
      <NoPasswords />
      <StoreScreen query={list} label="Loading your store accounts" errorTitle="We couldn’t load your store accounts">
        {(data) => (
          <div className="myapp-stack">
            {PLATFORMS.map((platform) => {
              const access = data.items.find((item) => item.platform === platform);
              if (config.data && !config.data[platform].entitled) return <UpgradePrompt key={platform} platform={platform} what="a store account" />;
              return access ? <PlatformSection key={platform} access={access} owner={owner} fresh={fresh} /> : null;
            })}
          </div>
        )}
      </StoreScreen>
      {fresh.sheet}
    </>
  );
}
