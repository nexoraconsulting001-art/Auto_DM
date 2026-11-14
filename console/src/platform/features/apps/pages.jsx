import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Banner, Button, Chip, ChipRow, ListCard, ListRow, PageHeader, Panel, SelectField, TextAreaField, TextField, Toggle } from '../../../design/index.jsx';
import { ActionSheet, BusinessSelect, Can, Facts, PagedRows, QueryState, When, useAct, useOne, usePlatformList } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { api } from '../../api.js';

const TABS = [
  { id: 'builds', label: 'Builds' },
  { id: 'submissions', label: 'Store submissions' },
  { id: 'rejections', label: 'Rejections' },
  { id: 'updates', label: 'Updates' },
];
const requestKey = () => `req-${globalThis.crypto.randomUUID()}`;
const VERSION = /^\d+\.\d+\.\d+$/;
const BUILD_TONE = { queued: 'neutral', building: 'warn', built: 'good', failed: 'bad', submitted: 'good' };
const OTA_TONE = { publishing: 'warn', live: 'good', rolling_back: 'warn', rolled_back: 'neutral', superseded: 'neutral', blocked: 'bad', failed: 'bad' };
const SUBMISSION_TONE = { draft: 'neutral', in_review: 'warn', rejected: 'bad', approved: 'good', live: 'good' };

// ---- Builds ------------------------------------------------------------------------------------------------------------

function BatchSheet({ open, onClose }) {
  const act = useAct();
  const [appVersion, setAppVersion] = useState('');
  const [runtimeVersion, setRuntimeVersion] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [platforms, setPlatforms] = useState({ android: true, ios: true });
  const chosen = Object.keys(platforms).filter((name) => platforms[name]);
  return (
    <ActionSheet
      open={open}
      title="Rebuild every app"
      intro="A native change rebuilds every business that has an app. A business whose build fails never stops the others."
      submitLabel="Start the rebuild"
      reasonLabel="What changed"
      valid={VERSION.test(appVersion) && runtimeVersion.trim() !== '' && fingerprint.trim().length >= 8 && chosen.length > 0}
      onClose={onClose}
      onSubmit={(note) => act(() => api.createAppBatch({ body: { reason: 'native_change', note, appVersion, runtimeVersion: runtimeVersion.trim(), fingerprint: fingerprint.trim(), platforms: chosen, requestKey: requestKey() } }), 'The rebuild has started.')}
    >
      <TextField label="App version" hint="Like 1.2.0" value={appVersion} onChange={(event) => setAppVersion(event.target.value)} error={appVersion && !VERSION.test(appVersion) ? 'Use a version like 1.2.0' : undefined} required />
      <TextField label="Runtime version" value={runtimeVersion} onChange={(event) => setRuntimeVersion(event.target.value)} required />
      <TextField label="Native fingerprint" hint="At least 8 characters." value={fingerprint} onChange={(event) => setFingerprint(event.target.value)} required />
      <Toggle label="Android" checked={platforms.android} onChange={(event) => setPlatforms((p) => ({ ...p, android: event.target.checked }))} />
      <Toggle label="iPhone and iPad" checked={platforms.ios} onChange={(event) => setPlatforms((p) => ({ ...p, ios: event.target.checked }))} />
    </ActionSheet>
  );
}

function BatchRow({ batch }) {
  const [open, setOpen] = useState(false);
  const detail = useOne(['app-batch', batch.id], () => api.appBatch({ params: { id: batch.id } }), { enabled: open });
  return (
    <div data-testid={`batch-${batch.id}`}>
      <ListRow
        as="button"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={`Version ${batch.appVersion} on runtime ${batch.runtimeVersion}`}
        meta={`${batch.counts.built} built, ${batch.counts.failed} failed, ${batch.counts.submitted} submitted of ${batch.counts.total}${batch.note ? ` · ${batch.note}` : ''}`}
        trailing={<Badge tone={batch.status === 'open' ? 'warn' : 'good'}>{batch.status === 'open' ? 'Open' : 'Finished'}</Badge>}
      />
      {open && (
        <QueryState query={detail} label="Loading the builds">
          {(data) => (
            <ListCard>
              {data.builds.map((build) => (
                <ListRow
                  key={build.id}
                  title={`${build.tenantName} · ${build.platform === 'ios' ? 'iPhone' : 'Android'}`}
                  meta={build.failedMessage ? `${build.failedMessage}${build.failedField ? ` (${build.failedField})` : ''}` : `Build ${build.buildNumber}`}
                  trailing={<Badge tone={BUILD_TONE[build.status]}>{word('build', build.status)}</Badge>}
                />
              ))}
            </ListCard>
          )}
        </QueryState>
      )}
    </div>
  );
}

function OneBusiness() {
  const act = useAct();
  const [business, setBusiness] = useState('');
  const [platforms, setPlatforms] = useState({ android: true, ios: false });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState('');
  const chosen = Object.keys(platforms).filter((name) => platforms[name]);

  async function build() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await act(() => api.buildBusinessApp({ params: { id: business }, body: { platforms: chosen, requestKey: requestKey() } }));
      setMessage('The build is queued.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="One business’s app">
      <div className="stack">
        <BusinessSelect value={business} onChange={setBusiness} />
        {error && <Banner tone="bad">{error}</Banner>}
        {message && <Banner tone="good">{message}</Banner>}
        <Toggle label="Android" checked={platforms.android} onChange={(event) => setPlatforms((p) => ({ ...p, android: event.target.checked }))} />
        <Toggle label="iPhone and iPad" checked={platforms.ios} onChange={(event) => setPlatforms((p) => ({ ...p, ios: event.target.checked }))} />
        <div className="form-actions">
          <Button disabled={!business || !chosen.length} loading={busy} onClick={build}>Build this business’s app</Button>
          <Can route="platform.setAppMinimum"><Button variant="outline" disabled={!business} onClick={() => setSheet('minimum')}>Set the minimum version</Button></Can>
          <Can route="platform.setAppReviewAccess"><Button variant="outline" disabled={!business} onClick={() => setSheet('review')}>Store review access</Button></Can>
        </div>
      </div>
      <Can route="platform.setAppMinimum"><MinimumSheet tenantId={business} open={sheet === 'minimum'} onClose={() => setSheet('')} /></Can>
      <Can route="platform.setAppReviewAccess"><ReviewAccessSheet tenantId={business} open={sheet === 'review'} onClose={() => setSheet('')} /></Can>
    </Panel>
  );
}

function MinimumSheet({ tenantId, open, onClose }) {
  const act = useAct();
  const [platform, setPlatform] = useState('android');
  const [minVersion, setMinVersion] = useState('');
  const [storeUrl, setStoreUrl] = useState('');
  return (
    <ActionSheet
      open={open}
      title="Minimum app version"
      intro="People on an older version are asked to update. Empty fields take the minimum away."
      needsReason={false}
      submitLabel="Save"
      valid={(minVersion === '' || VERSION.test(minVersion)) && (storeUrl === '' || storeUrl.startsWith('https://'))}
      onClose={onClose}
      onSubmit={() => act(() => api.setAppMinimum({ params: { id: tenantId }, body: { platform, minVersion, storeUrl } }), 'The minimum version is saved.')}
    >
      <SelectField label="Platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
        <option value="android">Android</option>
        <option value="ios">iPhone and iPad</option>
      </SelectField>
      <TextField label="Minimum version" value={minVersion} onChange={(event) => setMinVersion(event.target.value)} error={minVersion && !VERSION.test(minVersion) ? 'Use a version like 1.2.0' : undefined} />
      <TextField label="Store link" inputMode="url" value={storeUrl} onChange={(event) => setStoreUrl(event.target.value)} />
    </ActionSheet>
  );
}

/** The review number's code is typed here and sent; it is never read back or shown (it is stored only as a hash). */
function ReviewAccessSheet({ tenantId, open, onClose }) {
  const act = useAct();
  const [enabled, setEnabled] = useState(true);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  return (
    <ActionSheet
      open={open}
      title="Store review access"
      intro="The number and code a store reviewer signs in with. The code is stored as a hash and cannot be shown again."
      needsReason={false}
      submitLabel="Save"
      valid={!enabled || (/^\+[1-9][0-9]{7,14}$/.test(phone) && /^[0-9]{6}$/.test(code))}
      onClose={() => { setCode(''); onClose(); }}
      onSubmit={() => act(() => api.setAppReviewAccess({ params: { id: tenantId }, body: enabled ? { enabled, phone, code } : { enabled } }), 'Review access is saved.')}
    >
      <Toggle label="Review access is on" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      {enabled && (
        <>
          <TextField label="Review phone number" type="tel" hint="With the country code, like +919876543210" autoComplete="off" value={phone} onChange={(event) => setPhone(event.target.value)} />
          <TextField label="Review code" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
        </>
      )}
    </ActionSheet>
  );
}

function Builds() {
  const batches = usePlatformList('app-batches', api.appBatches);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <Can route="platform.createAppBatch"><Button onClick={() => setOpen(true)}>Rebuild every app</Button></Can>
      <PagedRows query={batches} empty="No rebuilds yet" emptyText="A native change rebuilds every app in one batch; it shows here." label="Loading builds">
        {(items) => <ListCard>{items.map((batch) => <BatchRow key={batch.id} batch={batch} />)}</ListCard>}
      </PagedRows>
      <OneBusiness />
      <Can route="platform.createAppBatch"><BatchSheet open={open} onClose={() => setOpen(false)} /></Can>
    </div>
  );
}

// ---- Submissions -------------------------------------------------------------------------------------------------------

function MoveSheet({ submission, open, onClose }) {
  const act = useAct();
  const [to, setTo] = useState('in_review');
  const [storeUrl, setStoreUrl] = useState('');
  const [guideline, setGuideline] = useState('');
  const [message, setMessage] = useState('');
  const valid = (to !== 'live' || /^https:\/\/\S+$/.test(storeUrl)) && (to !== 'rejected' || guideline.trim() !== '');
  return (
    <ActionSheet
      open={open}
      title={`Move ${submission.tenantName}’s ${submission.platform === 'ios' ? 'iPhone' : 'Android'} app`}
      submitLabel="Move"
      valid={valid}
      onClose={onClose}
      onSubmit={(reason) => act(() => api.setSubmissionState({
        params: { id: submission.id },
        body: { to, reason, ...(to === 'live' ? { storeUrl } : {}), ...(to === 'rejected' ? { rejection: { guideline: guideline.trim(), message } } : {}) },
      }), 'The submission is moved.')}
    >
      <SelectField label="Move to" value={to} onChange={(event) => setTo(event.target.value)}>
        {['draft', 'in_review', 'rejected', 'approved', 'live'].map((state) => <option key={state} value={state}>{word('submission', state)}</option>)}
      </SelectField>
      {to === 'live' && <TextField label="Store link" inputMode="url" value={storeUrl} onChange={(event) => setStoreUrl(event.target.value)} error={storeUrl && !valid ? 'Use the app’s store link, starting https://' : undefined} required />}
      {to === 'rejected' && (
        <>
          <TextField label="Guideline the store named" hint="Like 4.2.6" value={guideline} onChange={(event) => setGuideline(event.target.value)} required />
          <TextAreaField label="What the store said" value={message} onChange={(event) => setMessage(event.target.value)} />
        </>
      )}
    </ActionSheet>
  );
}

function SubmissionRow({ submission }) {
  const [open, setOpen] = useState(false);
  const latest = submission.rejections[0];
  return (
    <div className="list-row pc-submission" data-testid={`submission-${submission.id}`}>
      <span className="list-row-main">
        <span className="list-row-title">{submission.tenantName} · {submission.platform === 'ios' ? 'iPhone and iPad' : 'Android'}</span>
        <span className="list-row-meta">Version {submission.appVersion}{submission.buildNumber ? ` (build ${submission.buildNumber})` : ''}{submission.liveVersion ? ` · live ${submission.liveVersion}` : ''}</span>
        {latest && <span className="list-row-meta">Rejected under {latest.guideline}: {latest.playbook.title}</span>}
        {submission.presubmit && !submission.presubmit.passed && <span className="list-row-meta">Pre-check failed: {submission.presubmit.checks.filter((c) => !c.passed).map((c) => c.detail || c.code).join('; ')}</span>}
      </span>
      <span className="pc-badges">
        <Badge tone={SUBMISSION_TONE[submission.state]}>{word('submission', submission.state)}</Badge>
        <Button variant="soft" onClick={() => setOpen(true)}>Move</Button>
      </span>
      <MoveSheet submission={submission} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function ReviewTasks() {
  const act = useAct();
  const tasks = usePlatformList('app-review-tasks', api.appReviewTasks, { status: 'open' });
  const [task, setTask] = useState(null);
  return (
    <>
      <h2 className="pc-h2">Needs a person</h2>
      <PagedRows query={tasks} empty="Nothing needs a person" emptyText="A rejection that cannot be fixed by itself waits here." label="Loading tasks">
        {(items) => (
          <ListCard>
            {items.map((item) => (
              <div className="list-row" key={item.id}>
                <span className="list-row-main">
                  <span className="list-row-title">{item.tenantName} · {item.guideline}</span>
                  <span className="list-row-meta">{item.platform === 'ios' ? 'iPhone and iPad' : 'Android'} · opened <When value={item.openedAt} /></span>
                </span>
                <Button variant="soft" onClick={() => setTask(item)}>Resolve</Button>
              </div>
            ))}
          </ListCard>
        )}
      </PagedRows>
      {task && (
        <ActionSheet
          open
          title={`Resolve ${task.guideline} for ${task.tenantName}`}
          reasonLabel="What was done"
          submitLabel="Mark resolved"
          onClose={() => setTask(null)}
          onSubmit={(resolution) => act(() => api.resolveAppReviewTask({ params: { id: task.id }, body: { resolution } }), 'The task is resolved.')}
        />
      )}
    </>
  );
}

function Submissions() {
  const [state, setState] = useState('');
  const query = usePlatformList('app-submissions', api.appSubmissions, state ? { state } : {});
  return (
    <div className="stack">
      <ChipRow label="State">
        <Chip pressed={state === ''} onClick={() => setState('')}>All</Chip>
        {['in_review', 'rejected', 'approved', 'live'].map((item) => <Chip key={item} pressed={state === item} onClick={() => setState(item)}>{word('submission', item)}</Chip>)}
      </ChipRow>
      <PagedRows query={query} empty="No submissions" emptyText="Apps appear here once they are submitted to a store." label="Loading submissions">
        {(items) => <ListCard>{items.map((submission) => <SubmissionRow key={submission.id} submission={submission} />)}</ListCard>}
      </PagedRows>
      <ReviewTasks />
    </div>
  );
}

// ---- Rejections --------------------------------------------------------------------------------------------------------

function Rejections() {
  const rejections = usePlatformList('app-rejections', api.appRejections);
  const playbooks = useOne(['app-playbooks'], () => api.appPlaybooks());
  return (
    <div className="stack">
      <PagedRows query={rejections} empty="No rejections" emptyText="A store rejection is listed here with the guideline and what to do about it." label="Loading rejections">
        {(items) => (
          <ListCard>
            {items.map((item) => (
              <ListRow
                key={item.id}
                title={`${item.tenantName} · ${item.guideline}`}
                meta={<>{item.message || item.playbook.title} · <When value={item.rejectedAt} /></>}
                trailing={<Badge tone={item.playbook.autoResubmit ? 'good' : 'warn'}>{item.playbook.autoResubmit ? 'Resubmits itself' : 'Needs a person'}</Badge>}
              />
            ))}
          </ListCard>
        )}
      </PagedRows>
      <h2 className="pc-h2">Playbooks</h2>
      <QueryState query={playbooks} label="Loading playbooks">
        {(data) => (
          <ListCard>
            {data.items.map((playbook) => <ListRow key={playbook.code} title={`${playbook.guideline} · ${playbook.title}`} meta={playbook.doc} trailing={<Badge tone={playbook.autoResubmit ? 'good' : 'neutral'}>{playbook.autoResubmit ? 'Automatic' : 'By hand'}</Badge>} />)}
          </ListCard>
        )}
      </QueryState>
    </div>
  );
}

// ---- Over-the-air updates ----------------------------------------------------------------------------------------------

function PublishSheet({ open, onClose }) {
  const act = useAct();
  const [form, setForm] = useState({ runtimeVersion: '', bundleFingerprint: '', bundleId: '', bundleHash: '', message: '' });
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.value }));
  const valid = form.runtimeVersion.trim() && form.bundleFingerprint.trim().length >= 8 && form.bundleId.trim() && /^[0-9a-f]{64}$/.test(form.bundleHash);
  return (
    <ActionSheet
      open={open}
      needsReason={false}
      title="Publish an update"
      intro="It starts at 10% of people and grows as it stays healthy. A bundle that changes native code is blocked."
      submitLabel="Publish"
      valid={Boolean(valid)}
      onClose={onClose}
      onSubmit={() => act(() => api.publishOta({ body: { ...form, runtimeVersion: form.runtimeVersion.trim(), requestKey: requestKey() } }), 'The update is publishing.')}
    >
      <TextField label="Runtime version" value={form.runtimeVersion} onChange={set('runtimeVersion')} required />
      <TextField label="Bundle fingerprint" value={form.bundleFingerprint} onChange={set('bundleFingerprint')} required />
      <TextField label="Bundle id" value={form.bundleId} onChange={set('bundleId')} required />
      <TextField label="Bundle hash" hint="64 lower-case hex digits" value={form.bundleHash} onChange={set('bundleHash')} error={form.bundleHash && !/^[0-9a-f]{64}$/.test(form.bundleHash) ? 'The bundle hash is 64 lower-case hex digits' : undefined} required />
      <TextField label="Note" value={form.message} onChange={set('message')} />
    </ActionSheet>
  );
}

function ReleaseRow({ release }) {
  const act = useAct();
  const [sheet, setSheet] = useState('');
  const [showHealth, setShowHealth] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const health = useOne(['ota-health', release.id], () => api.otaHealth({ params: { id: release.id } }), { enabled: showHealth });
  const active = release.status === 'live' || release.status === 'publishing';

  async function advance() {
    setBusy(true);
    setError('');
    try {
      await act(() => api.advanceOta({ params: { id: release.id } }), 'The rollout is wider.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="list-row pc-release" data-testid={`release-${release.id}`}>
      <span className="list-row-main">
        <span className="list-row-title">{release.message || `Update ${release.bundleId}`}</span>
        <span className="list-row-meta">Runtime {release.runtimeVersion} · {release.rollout}% of people · {release.channelsDone} of {release.channelsTotal} apps reached{release.blockReason ? ` · ${release.blockReason}` : ''}{release.rollbackReason ? ` · rolled back: ${release.rollbackReason}` : ''}</span>
        {error && <span className="field-error" role="alert">{error}</span>}
        {showHealth && (
          <QueryState query={health} label="Loading crash numbers">
            {(data) => <Facts rows={[['Launches', String(data.launches)], ['Crashes', String(data.crashes)], ['Crash rate', data.crashRate === null ? 'Not enough launches yet' : `${(data.crashRate * 100).toFixed(2)}%`], ['Roll back at', `${(data.threshold * 100).toFixed(2)}%`]]} />}
          </QueryState>
        )}
        <span className="row-actions">
          <Button variant="soft" onClick={() => setShowHealth(!showHealth)}>{showHealth ? 'Hide health' : 'Health'}</Button>
          {active && release.rollout < 100 && <Can route="platform.advanceOta"><Button variant="soft" loading={busy} onClick={advance}>Widen the rollout</Button></Can>}
          {active && <Button variant="danger" onClick={() => setSheet('rollback')}>Roll back</Button>}
        </span>
      </span>
      <Badge tone={OTA_TONE[release.status]}>{word('ota', release.status)}</Badge>
      <ActionSheet
        open={sheet === 'rollback'}
        title="Roll back this update"
        intro="People go back to the update before it."
        submitLabel="Roll back"
        tone="danger"
        onClose={() => setSheet('')}
        onSubmit={(reason) => act(() => api.rollBackOta({ params: { id: release.id }, body: { reason } }), 'The update is rolling back.')}
      />
    </div>
  );
}

function Updates() {
  const releases = usePlatformList('ota-releases', api.otaReleases);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <Can route="platform.publishOta"><Button onClick={() => setOpen(true)}>Publish an update</Button></Can>
      <PagedRows query={releases} empty="No updates yet" emptyText="An over-the-air update appears here with how far it has reached." label="Loading updates">
        {(items) => <ListCard>{items.map((release) => <ReleaseRow key={release.id} release={release} />)}</ListCard>}
      </PagedRows>
      <Can route="platform.publishOta"><PublishSheet open={open} onClose={() => setOpen(false)} /></Can>
    </div>
  );
}

export function AppsPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((item) => item.id === params.get('tab')) ? params.get('tab') : 'builds';
  return (
    <div className="stack">
      <PageHeader eyebrow="Bhava Console" title="Apps" />
      <ChipRow label="Part of the apps">
        {TABS.map((item) => <Chip key={item.id} pressed={tab === item.id} onClick={() => setParams({ tab: item.id }, { replace: true })}>{item.label}</Chip>)}
      </ChipRow>
      {tab === 'builds' && <Builds />}
      {tab === 'submissions' && <Submissions />}
      {tab === 'rejections' && <Rejections />}
      {tab === 'updates' && <Updates />}
    </div>
  );
}
