import { useQuery } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, PageHeader, Panel, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, usePagedList, useRefresh } from '../../lib/query.js';
import { Facts, StoreScreen, useAction } from '../orders/shared/ui.jsx';

/** Shopify sync (9.11): Shopify as the source with orders pushed to it, or both ways with the latest change winning and a log. */
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const MODES = [
  ['source', 'Shopify is the source', 'Products, prices and stock come from Shopify. Orders placed here are sent to Shopify.'],
  ['two_way', 'Both ways', 'Changes on either side are copied across. The latest change wins, and each conflict is logged.'],
];
const STATUS = { none: ['neutral', 'Not connected'], active: ['good', 'Syncing'], reconnect: ['bad', 'Connect again'], paused: ['warn', 'Paused'] };

function ModeChoice({ value, onChange, disabled }) {
  return (
    <fieldset className="store-choice" disabled={disabled}>
      <legend>How to sync</legend>
      {MODES.map(([mode, title, note]) => (
        <label key={mode} className="store-option">
          <input type="radio" name="shopify-mode" value={mode} checked={value === mode} onChange={() => onChange(mode)} />
          <span className="store-option-text"><span className="store-option-title">{title}</span><span className="store-option-note">{note}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

function ConnectForm() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ shopDomain: '', accessToken: '', webhookSecret: '', mode: 'source' });

  async function submit(event) {
    event.preventDefault();
    const shopDomain = form.values.shopDomain.trim().toLowerCase();
    const found = {};
    if (!SHOP_DOMAIN.test(shopDomain)) found.shopDomain = 'Use your store’s myshopify.com address';
    if (!form.values.accessToken.trim()) found.accessToken = 'Enter the Admin API access token';
    if (!form.values.webhookSecret.trim()) found.webhookSecret = 'Enter the webhook signing secret';
    if (Object.keys(found).length) return form.reject(found);
    const done = await form.run(() => api.shopify.connect({ shopDomain, accessToken: form.values.accessToken.trim(), webhookSecret: form.values.webhookSecret.trim(), mode: form.values.mode }));
    if (done) {
      toast('Shopify connected. The first sync has started.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Connect Shopify">
      <p className="muted">Make a custom app in your Shopify admin, then paste its details here. Both secrets are stored encrypted and never shown again.</p>
      <FieldGroup>
        <TextField label="Store address" placeholder="your-store.myshopify.com" autoCapitalize="none" autoComplete="off" {...form.field('shopDomain')} />
        <TextField label="Admin API access token" type="password" autoComplete="new-password" {...form.field('accessToken')} />
        <TextField label="Webhook signing secret" type="password" autoComplete="new-password" {...form.field('webhookSecret')} />
      </FieldGroup>
      <ModeChoice value={form.values.mode} onChange={(mode) => form.set('mode', mode)} />
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Connect Shopify</Button>
    </form>
  );
}

function Conflicts() {
  const conflicts = usePagedList('shopify-conflicts', api.shopify.conflicts);
  return (
    <Panel title="Conflicts">
      <StoreScreen query={conflicts} label="Loading the conflicts" errorTitle="We couldn’t load the conflicts">
        {() => (conflicts.items.length ? (
          <>
            <ListCard aria-label="Conflicts">
              {conflicts.items.map((conflict) => (
                <ListRow
                  key={conflict.id}
                  title={`${conflict.kind} ${conflict.localId}: ${conflict.field}`}
                  meta={`Here “${conflict.localValue}”, Shopify “${conflict.remoteValue}” · ${formatDateTime(conflict.at)}`}
                  trailing={<Badge tone="neel">{conflict.winner === 'local' ? 'Kept this one' : 'Took Shopify’s'}</Badge>}
                />
              ))}
            </ListCard>
            <LoadMore query={conflicts} />
          </>
        ) : <EmptyState title="No conflicts">When both sides change the same thing, it is listed here.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}

function Connected({ shop }) {
  const allowed = useAllowed();
  const isOwner = allowed(OWNER_ONLY);
  const { confirm } = useFeedback();
  const action = useAction();
  const [tone, label] = STATUS[shop.status] ?? STATUS.none;

  async function disconnect() {
    const yes = await confirm({ title: 'Disconnect Shopify?', text: 'Nothing is synced until you connect again. Products already here stay.', confirm: 'Disconnect', cancel: 'Keep it' });
    if (yes) await action.run('disconnect', () => api.shopify.disconnect(), 'Shopify disconnected.');
  }

  return (
    <>
      <Panel title={shop.shopDomain} action={<Badge tone={tone}>{label}</Badge>}>
        {action.problem && <Banner tone="bad">{action.problem}</Banner>}
        {shop.status === 'reconnect' && <Banner tone="bad">Shopify stopped accepting the token. Disconnect and connect again with a new one.</Banner>}
        <Facts rows={[
          ['Last full check', shop.lastReconciledAt ? formatDateTime(shop.lastReconciledAt) : 'Not yet'],
          ['Orders waiting to go to Shopify', String(shop.pendingOrders)],
          ['Orders that didn’t go', String(shop.failedOrders)],
        ]}
        />
        {shop.webhookUrl && (
          <div className="stack">
            <p className="muted">Shopify sends its updates to this address. Your custom app should use it:</p>
            <p className="store-code">{shop.webhookUrl}</p>
            <CopyButton text={shop.webhookUrl} label="Copy address" />
          </div>
        )}
        <ModeChoice value={shop.mode} disabled={!isOwner || action.busy === 'mode'} onChange={(mode) => action.run('mode', () => api.shopify.setMode({ mode }), 'Sync changed.')} />
        <div className="row-actions">
          <Button variant="soft" loading={action.busy === 'reconcile'} onClick={() => action.run('reconcile', () => api.shopify.reconcile(), 'Checking everything now.')}>Check everything now</Button>
          {isOwner && (shop.status === 'paused'
            ? <Button variant="outline" loading={action.busy === 'pause'} onClick={() => action.run('pause', () => api.shopify.setMode({ paused: false }), 'Sync resumed.')}>Resume</Button>
            : <Button variant="outline" loading={action.busy === 'pause'} onClick={() => action.run('pause', () => api.shopify.setMode({ paused: true }), 'Sync paused.')}>Pause</Button>)}
          {isOwner && <Button variant="danger" loading={action.busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>}
        </div>
        {!isOwner && <p className="field-hint">Only the owner changes how Shopify syncs.</p>}
      </Panel>
      {shop.mode === 'two_way' && <Conflicts />}
    </>
  );
}

export default function ShopifyPage() {
  const allowed = useAllowed();
  const shop = useQuery({ queryKey: ['shopify'], queryFn: api.shopify.get });
  return (
    <>
      <BackLink to="/store-settings">Store setup</BackLink>
      <PageHeader title="Shopify" />
      <StoreScreen query={shop} label="Loading your Shopify connection" errorTitle="We couldn’t load your Shopify connection">
        {(data) => (data.connected ? <Connected shop={data} /> : (
          <Panel title="Connect your Shopify store">
            {allowed(OWNER_ONLY) ? <ConnectForm /> : <EmptyState title="Shopify isn’t connected">The owner connects the business’s Shopify store.</EmptyState>}
          </Panel>
        ))}
      </StoreScreen>
    </>
  );
}
