import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { usePagedList } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { ANALYTICS_LIMITS, FIGURE_TEXT, REPORTING_BASE_PATH, REPORTING_SCOPE } from '../insights/shared/catalog.js';
import { AnalyticsLoadable, ReportTabs } from '../insights/shared/ui.jsx';

/** A new key, shown this once. It is stored hashed, so nobody can show it again, Bhava included. */
function NewKey({ created, onDone }) {
  return (
    <Panel title="Your new key">
      <Banner tone="warn">Copy it now. It won’t be shown again: if it’s lost, revoke it and make another.</Banner>
      <code className="an-key-once">{created.key}</code>
      <div className="row-actions">
        <CopyButton text={created.key} label="Copy key" />
        <Button variant="outline" onClick={onDone}>I’ve copied it</Button>
      </div>
    </Panel>
  );
}

function CreateKey({ onCreated }) {
  const queries = useQueryClient();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState('');
  const create = useMutation({
    mutationFn: () => api.apiKeys.create({ name: name.trim() }),
    onSuccess: async (created) => {
      setName('');
      onCreated(created);
      await queries.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (error) => setProblem(error.fields?.name ?? error.message),
  });
  return (
    <Panel title="Make a key">
      <form className="an-form" onSubmit={(event) => { event.preventDefault(); setProblem(''); if (!name.trim()) setProblem('Name this key'); else create.mutate(); }} noValidate>
        <FieldGroup>
          <TextField label="Name" hint="Where it will be used, such as “Google Sheets”." maxLength={60} value={name} error={problem || undefined} onChange={(event) => setName(event.target.value)} />
        </FieldGroup>
        <Button type="submit" loading={create.isPending}>Create key</Button>
      </form>
    </Panel>
  );
}

function Keys() {
  const { confirm, toast } = useFeedback();
  const queries = useQueryClient();
  const keys = usePagedList('api-keys', api.apiKeys.list);
  const revoke = useMutation({
    mutationFn: (id) => api.apiKeys.revoke(id),
    onSuccess: async () => {
      toast('Key revoked. It stops working at once.');
      await queries.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (error) => toast(error.message),
  });
  async function askToRevoke(key) {
    if (await confirm({ title: `Revoke “${key.name}”?`, text: 'Anything using it stops working at once. This can’t be undone.', confirm: 'Revoke key' })) revoke.mutate(key.id);
  }
  return (
    <Panel title="Keys">
      <AnalyticsLoadable query={keys} label="Loading your keys" errorTitle="We couldn’t load your keys">
        {() => (keys.items.length ? (
          <>
            <div className="an-rows">
              {keys.items.map((key) => (
                <div key={key.id} className="an-row">
                  <span className="an-row-main">
                    <span className="an-row-title">{key.name}</span>
                    <span className="an-row-meta">{`${key.prefix}… · ${key.scope} · made ${formatDate(key.createdAt)}`}</span>
                    <span className="an-row-meta">{key.revokedAt ? `Revoked ${formatDateTime(key.revokedAt)}` : key.lastUsedAt ? `Last used ${formatDateTime(key.lastUsedAt)}` : 'Not used yet'}</span>
                  </span>
                  {key.revokedAt ? <Badge>Revoked</Badge> : <Button variant="danger" onClick={() => askToRevoke(key)}>Revoke</Button>}
                </div>
              ))}
            </div>
            <LoadMore query={keys} />
          </>
        ) : <EmptyState title="No keys yet">A key lets your own sheets and tools read your summary figures.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

/** Keys for the reporting API (7.13): the owner's alone to make and revoke, read-only, summary figures only. */
export default function ApiKeysPage() {
  const { session } = useSession();
  const [created, setCreated] = useState(null);
  const isOwner = session.user.role === 'owner';
  const base = `${REPORTING_BASE_PATH}/businesses/${session.business.id}`;
  return (
    <>
      <PageHeader eyebrow="Reports" title="API keys" />
      <ReportTabs />
      <p className="lead">{`Read your summary figures from your own tools: the same figures, breakdowns and filters as Explore. Keys are read-only (${REPORTING_SCOPE}), and each can make ${ANALYTICS_LIMITS.apiRequestsPerMinute} requests a minute.`}</p>
      {isOwner ? (
        <>
          {created ? <NewKey created={created} onDone={() => setCreated(null)} /> : <CreateKey onCreated={setCreated} />}
          <Keys />
          <Panel title="How to use a key">
            <p className="muted">Send the key as a bearer token. Dates are in your time zone, and pages come back with a cursor.</p>
            <code className="an-snippet">{`GET ${base}/metrics?metrics=sessions,orders&dimensions=source&range=28\nAuthorization: Bearer <your key>`}</code>
            <code className="an-snippet">{`GET ${base}/catalog`}</code>
          </Panel>
        </>
      ) : (
        <EmptyState title="Owner only">{`${FIGURE_TEXT.ownerOnly} Only the owner can make or revoke API keys.`}</EmptyState>
      )}
    </>
  );
}
