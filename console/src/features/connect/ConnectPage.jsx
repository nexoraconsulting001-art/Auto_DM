import { useMutation, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Card, Loadable, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { RETURN_TO, SCOPE_LABELS, connectionView, returnBanner } from './connection.js';
import './connect.css';

/** Starts Meta's own login. The browser leaves the console here and Meta brings it back to RETURN_TO. */
function useConnect(start) {
  const { toast } = useFeedback();
  return useMutation({
    mutationFn: () => start({ returnTo: RETURN_TO }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError: (error) => toast(error.message),
  });
}

function useDisconnect(remove, { title, text, done }) {
  const { confirm, toast } = useFeedback();
  const refresh = useRefresh();
  const disconnect = useMutation({
    mutationFn: () => remove(),
    onSuccess: async () => {
      toast(done);
      await refresh();
    },
    onError: (error) => toast(error.message),
  });
  return {
    pending: disconnect.isPending,
    ask: async () => {
      if (await confirm({ title, text, confirm: 'Disconnect' })) disconnect.mutate();
    },
  };
}

function Scopes({ connection }) {
  return (
    <Panel title="What Bhava can do">
      <div className="scope-list">
        {SCOPE_LABELS.map(({ scope, label, detail }) => {
          const granted = connection.scopes.includes(scope);
          return (
            <div key={scope} className="scope">
              <span className="scope-text">
                <span className="scope-name">{label}</span>
                <span className="scope-detail">{detail}</span>
              </span>
              <Badge tone={granted ? 'good' : 'warn'}>{granted ? 'Allowed' : 'Permission needed'}</Badge>
            </div>
          );
        })}
      </div>
      <p className="field-hint">Bhava never posts to your account.</p>
    </Panel>
  );
}

function Instagram({ connection, canManage }) {
  const view = connectionView(connection);
  const connect = useConnect((body) => api.instagram.connect(body));
  const disconnect = useDisconnect(() => api.instagram.disconnect(), {
    title: 'Disconnect Instagram?',
    text: 'Automations stop and waiting messages are held. You can connect again later.',
    done: 'Instagram is disconnected.',
  });

  return (
    <>
      <Card aria-labelledby="ig-title">
        <div className="connect-head">
          <h2 id="ig-title" className="connect-title">{view.title}</h2>
          <Badge tone={view.tone}>{view.badge}</Badge>
        </div>
        {view.connected && connection.tokenExpiresAt && <p className="muted">Renews by itself. Current access lasts until {formatDate(connection.tokenExpiresAt)}.</p>}
        {view.connected && !connection.webhooksSubscribed && <Banner tone="warn">Instagram isn’t sending us comments yet. We keep trying every hour.</Banner>}
        {connection.status === 'reconnect_needed' && <p className="muted">Instagram stopped accepting this connection, so messages are on hold until you reconnect.</p>}
        {connection.status === 'deauthorized' && <p className="muted">Access was removed from Instagram’s side, so messages are on hold until you reconnect.</p>}
        {connection.status === 'not_connected' && <p className="muted">Connect the Instagram professional account you sell from, so comments can be answered with a DM.</p>}
        {canManage && view.action && <Button size="large" block loading={connect.isPending} onClick={() => connect.mutate()}>{view.action}</Button>}
        {!canManage && view.action && <p className="muted">Ask the owner or a manager to do this.</p>}
        <div className="connect-promise">
          <span>We only use Meta’s official login.</span>
          <span>We never ask for your Instagram password.</span>
        </div>
      </Card>
      {connection.status !== 'not_connected' && <Scopes connection={connection} />}
      {canManage && view.connected && <Button variant="danger" loading={disconnect.pending} onClick={disconnect.ask}>Disconnect Instagram</Button>}
    </>
  );
}

/** Nothing at all until Facebook Pages is switched on (PRD 6.10). A server without it yet answers an error, which also means nothing. */
function Facebook({ canManage }) {
  const connection = useQuery({ queryKey: ['facebook-connection'], queryFn: () => api.facebook.connection(), retry: false });
  const connect = useConnect((body) => api.facebook.connect(body));
  const disconnect = useDisconnect(() => api.facebook.disconnect(), { title: 'Disconnect this Page?', text: 'Facebook automations stop. Instagram keeps working.', done: 'Facebook Page disconnected.' });
  const page = connection.data;
  if (!page?.enabled) return null;
  const view = connectionView({ ...page, username: '', missingScopes: [] });
  const connected = page.status === 'active';
  return (
    <Panel title="Facebook Page" action={<Badge tone={view.tone}>{view.badge}</Badge>}>
      <p className="muted">{connected ? page.pageName : 'Optional. Comments on the Facebook copy of a reel get the same DM.'}</p>
      {canManage && !connected && <Button variant="soft" loading={connect.isPending} onClick={() => connect.mutate()}>{page.status === 'not_connected' ? 'Connect Page' : 'Reconnect Page'}</Button>}
      {canManage && connected && <Button variant="outline" loading={disconnect.pending} onClick={disconnect.ask}>Disconnect Page</Button>}
    </Panel>
  );
}

export default function ConnectPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const [params] = useSearchParams();
  const connection = useQuery({ queryKey: ['instagram-connection'], queryFn: () => api.instagram.connection() });
  const landed = returnBanner(params.get('instagram'));
  return (
    <>
      <PageHeader title="Instagram" />
      {landed && <Banner tone={landed.tone}>{landed.text}</Banner>}
      <Loadable query={connection} label="Checking your Instagram connection" errorTitle="We couldn’t check your Instagram connection">
        {(current) => <Instagram connection={current} canManage={canManage} />}
      </Loadable>
      <Facebook canManage={canManage} />
    </>
  );
}
