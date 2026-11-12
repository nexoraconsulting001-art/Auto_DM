import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Panel, PageHeader, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { LoadMore } from '../../design/index.jsx';
import { usePagedList, useAllowed } from '../../lib/query.js';
import {
  APP_FIELDS, APP_FIELD_NAMES, BUILD_STATUS, BUILD_STEP_LABELS, PLATFORMS, PLATFORM_LABELS, appFieldProblem, buildActive, configToForm, formToUpdate, newRequestKey,
} from './rules.js';
import { AreaTabs, NoPasswords, Note, Status, StoreScreen, UpgradePrompt, useAppConfig, useFields } from './ui.jsx';

const SECTIONS = [
  ['Your app', ['appName', 'shortName', 'shopDomain', 'supportEmail', 'privacyUrl', 'urlScheme', 'splashBackground'], null],
  ['Android', ['androidPackage', 'playAccountId', 'playSigningSha256'], 'android'],
  ['iPhone and iPad', ['iosBundleId', 'appleTeamId'], 'ios'],
];

function Field({ name, fields }) {
  const spec = APP_FIELDS[name];
  const shown = fields.server[name] || (fields.touched[name] ? appFieldProblem(name, fields.values[name]) : '');
  const common = { label: spec.label, hint: spec.hint, error: shown, value: fields.values[name] ?? '', name, onChange: (event) => fields.set(name, event.target.value) };
  if (name === 'playSigningSha256') return <TextAreaField {...common} rows={3} autoCapitalize="characters" spellCheck={false} />;
  return <TextField {...common} maxLength={spec.max ? spec.max + 20 : undefined} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode={name === 'supportEmail' ? 'email' : name === 'playAccountId' ? 'numeric' : undefined} />;
}

function Problems({ validation }) {
  if (!validation) return null;
  if (validation.ok) return <Note tone="good">Everything needed to build is filled in. Checked {formatDateTime(validation.checkedAt)}.</Note>;
  return (
    <Banner tone="warn">
      <strong>Before we can build:</strong>
      <ul className="myapp-problems">
        {validation.problems.map((problem) => (
          <li key={`${problem.field}-${problem.code}-${problem.platform ?? ''}`}>
            {problem.message}{problem.platform ? ` (${PLATFORM_LABELS[problem.platform]})` : ''}
          </li>
        ))}
      </ul>
    </Banner>
  );
}

function DetailsForm({ config }) {
  const { toast } = useFeedback();
  const queries = useQueryClient();
  const fields = useFields(configToForm(config));
  const [validation, setValidation] = useState(config.validation);
  const [checking, setChecking] = useState(false);
  const names = useMemo(() => APP_FIELD_NAMES.filter((name) => !APP_FIELDS[name].platform || config[APP_FIELDS[name].platform].entitled), [config]);

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToUpdate(fields.values, config);
    fields.touchAll(names);
    const first = names.map((name) => errors[name]).find(Boolean);
    if (first) return fields.setMessage(`Please check: ${first}`);
    for (const name of Object.keys(body)) if (!names.includes(name)) delete body[name];
    if (!Object.keys(body).length) return toast('Nothing has changed.');
    const done = await fields.run(async () => {
      const saved = await api.appPublishing.save(body);
      queries.setQueryData(['app-publishing', 'config'], saved);
      fields.reset(configToForm(saved));
      setValidation(saved.validation);
    });
    if (done) toast('Your app details are saved.');
    return undefined;
  }

  async function check() {
    setChecking(true);
    try {
      setValidation(await api.appPublishing.validate());
    } catch (error) {
      fields.setMessage(error.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <form className="myapp-form" onSubmit={save} noValidate aria-label="App details">
      {SECTIONS.map(([title, list, platform]) => (
        <Panel key={title} title={title}>
          {platform && !config[platform].entitled ? <UpgradePrompt platform={platform} what="an app" /> : (
            <div className="myapp-form">{list.map((name) => <Field key={name} name={name} fields={fields} />)}</div>
          )}
        </Panel>
      ))}
      <p className="field-hint">Your icon, splash picture, colours and fonts come from your brand kit, so the app matches your store.</p>
      {fields.message && <Banner tone="bad">{fields.message}</Banner>}
      <Problems validation={validation} />
      <div className="myapp-actions">
        <Button type="submit" loading={fields.busy}>Save details</Button>
        <Button variant="outline" onClick={check} loading={checking}>Check my app</Button>
      </div>
    </form>
  );
}

function Builds({ config }) {
  const { toast } = useFeedback();
  const allowed = useAllowed();
  const queries = useQueryClient();
  const owner = allowed(OWNER_ONLY);
  const builds = usePagedList('app-publishing:builds', api.appPublishing.builds, {}, {
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some(buildActive)) ? 5000 : false),
  });
  const entitled = PLATFORMS.filter((platform) => config[platform].entitled);
  const [picked, setPicked] = useState(entitled);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function request() {
    setBusy(true);
    setProblem('');
    try {
      await api.appPublishing.requestBuild({ platforms: picked, requestKey: newRequestKey('build') });
      toast('Your build is queued.');
      await queries.invalidateQueries({ queryKey: ['app-publishing:builds'] });
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Builds">
      <fieldset className="myapp-radio">
        <legend>Build the app for</legend>
        {PLATFORMS.map((platform) => (config[platform].entitled ? (
          <label key={platform} className="myapp-check">
            <input type="checkbox" checked={picked.includes(platform)} onChange={(event) => setPicked(event.target.checked ? [...picked, platform] : picked.filter((p) => p !== platform))} />
            {PLATFORM_LABELS[platform]}
          </label>
        ) : <UpgradePrompt key={platform} platform={platform} what="a build" />))}
      </fieldset>
      {problem && <Banner tone="bad">{problem}</Banner>}
      {!owner && <p className="field-hint">Only the owner can start a build.</p>}
      <div className="myapp-actions">
        <Button onClick={request} loading={busy} disabled={!owner || !picked.length}>Build my app</Button>
      </div>
      <StoreScreen query={builds} label="Loading your builds" errorTitle="We couldn’t load your builds">
        {() => (builds.items.length ? (
          <div role="list" aria-label="Builds">
            {builds.items.map((build) => (
              <div key={build.id} role="listitem" className="myapp-row">
                <div className="myapp-row-head">
                  <strong>{PLATFORM_LABELS[build.platform]} {build.appVersion} ({build.buildNumber})</strong>
                  <Status table={BUILD_STATUS} value={build.status} />
                </div>
                <span className="myapp-meta">Started {formatDateTime(build.createdAt)}{build.finishedAt ? `, finished ${formatDateTime(build.finishedAt)}` : ''}</span>
                {build.status === 'failed' && (
                  <p>
                    {build.failedStep ? `Stopped at: ${BUILD_STEP_LABELS[build.failedStep]}. ` : ''}
                    {build.failedMessage}
                    {build.failedField ? ` (${APP_FIELDS[build.failedField]?.label ?? build.failedField})` : ''}
                  </p>
                )}
                {build.submitError && <p>The store did not take it: {build.submitError}</p>}
              </div>
            ))}
            <LoadMore query={builds} />
          </div>
        ) : <p className="field-hint">No builds yet. Fill in your details, then build your app.</p>)}
      </StoreScreen>
    </Panel>
  );
}

export default function AppDetailsPage() {
  const config = useAppConfig();
  return (
    <>
      <PageHeader title="My app" eyebrow={config.data ? <Badge tone="neel">{config.data.appName || 'Not named yet'}</Badge> : undefined} />
      <AreaTabs current="/my-app" />
      <StoreScreen query={config} label="Loading your app" errorTitle="We couldn’t load your app">
        {(data) => (
          <div className="myapp-stack">
            <NoPasswords />
            <DetailsForm key={data.appName + data.shortName} config={data} />
            <Builds config={data} />
          </div>
        )}
      </StoreScreen>
    </>
  );
}
