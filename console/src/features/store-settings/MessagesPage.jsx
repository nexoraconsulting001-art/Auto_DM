import { useQuery } from '@tanstack/react-query';
import { MANAGERS, OWNER_ONLY, staffWith } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, SelectField, Stat, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useFilters, usePagedList, useRefresh } from '../../lib/query.js';
import { ALERT_EVENTS } from '../orders/shared/contract.js';
import { ALERT_SHOW } from '../orders/shared/filters.js';
import { ALERT_EVENT_LABELS, TEMPLATE } from '../orders/shared/labels.js';
import { StatusBadge, StoreScreen, useAction } from '../orders/shared/ui.jsx';
import { AlertLine } from './OrderMessages.jsx';

/**
 * Messages to shoppers (9.15, 9.16): by WhatsApp and email only. There is no SMS anywhere (S-96). WhatsApp is the business's
 * own number, charged at Meta's price with no markup; email comes from the business's domain or a neutral one, never ours.
 */
const LOCAL_PART = /^[a-z0-9._-]{1,40}$/;
/** What each WhatsApp template is for, in words; one we don't know reads as its name with spaces. */
const PURPOSES = Object.freeze({
  order_placed: 'Order placed', order_paid: 'Payment received', order_shipped: 'Shipped', order_delivered: 'Delivered', order_cancelled: 'Cancelled', order_refunded: 'Refunded',
  otp: 'Sign-in code', cart_reminder: 'Cart reminder', review_request: 'Review request', return_update: 'Return update',
});
const purposeText = (purpose) => PURPOSES[purpose] ?? String(purpose).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const COST_ROWS = [['utility', 'Order update'], ['authentication', 'Sign-in code'], ['marketing', 'Cart reminder or offer']];

function AlertSettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [local, domain] = String(settings.emailFromAddress ?? '').split('@');
  const form = useForm({ whatsapp: settings.whatsapp, email: settings.email, events: settings.events, emailFrom: settings.emailFrom, emailFromLocal: local ?? '', emailReplyTo: settings.emailReplyTo });

  async function save(event) {
    event.preventDefault();
    const found = {};
    const fromLocal = form.values.emailFromLocal.trim().toLowerCase();
    if (!LOCAL_PART.test(fromLocal)) found.emailFromLocal = 'Use letters, digits, dot, dash or underscore';
    const replyTo = form.values.emailReplyTo.trim();
    if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) found.emailReplyTo = 'Enter a valid email';
    if (Object.keys(found).length) return form.reject(found);
    const body = { whatsapp: form.values.whatsapp, email: form.values.email, events: form.values.events, emailFrom: form.values.emailFrom, emailFromLocal: fromLocal, emailReplyTo: replyTo };
    const done = await form.run(() => api.alertSettings.update(body));
    if (done) {
      toast('Order updates saved.');
      await refresh();
    }
    return undefined;
  }

  const toggleEvent = (name, on) => form.set('events', (current) => (on ? [...new Set([...current, name])] : current.filter((other) => other !== name)));

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Order updates">
      <fieldset className="store-checks">
        <legend>Send order updates by</legend>
        <Toggle label="WhatsApp" {...form.toggle('whatsapp')} />
        <Toggle label="Email" {...form.toggle('email')} />
      </fieldset>
      <fieldset className="store-checks">
        <legend>When</legend>
        {ALERT_EVENTS.map((name) => (
          <label key={name} className="store-check">
            <input type="checkbox" checked={form.values.events.includes(name)} onChange={(event) => toggleEvent(name, event.target.checked)} />
            {ALERT_EVENT_LABELS[name]}
          </label>
        ))}
      </fieldset>
      <FieldGroup>
        <SelectField label="Emails come from" {...form.field('emailFrom')}>
          <option value="own">Your own domain</option>
          <option value="neutral">A neutral sending domain</option>
        </SelectField>
        <TextField label="Sender name before the @" hint={domain ? `Sent as ${form.values.emailFromLocal || '…'}@${domain}` : 'Letters, digits, dot, dash or underscore.'} maxLength={40} autoCapitalize="none" {...form.field('emailFromLocal')} />
        <TextField label="Replies go to (optional)" type="email" {...form.field('emailReplyTo')} />
      </FieldGroup>
      <p className="field-hint">Each update goes once per channel, and only to shoppers who agreed to it at checkout.</p>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Save order updates</Button>
    </form>
  );
}

function Costs({ cost }) {
  return (
    <div className="stack">
      <h3>WhatsApp price per message</h3>
      <dl className="facts">
        {COST_ROWS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{cost[key] === null ? 'Not known yet' : formatPaise(cost[key])}</dd></div>)}
      </dl>
      <p className="field-hint">What WhatsApp charges, passed on at cost with no markup.</p>
    </div>
  );
}

function WhatsappConnect() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ wabaId: '', phoneNumberId: '', accessToken: '', displayNumber: '' });

  async function submit(event) {
    event.preventDefault();
    const found = {};
    if (!form.values.wabaId.trim()) found.wabaId = 'Enter the WhatsApp Business Account ID';
    if (!form.values.phoneNumberId.trim()) found.phoneNumberId = 'Enter the phone number ID';
    if (!form.values.accessToken.trim()) found.accessToken = 'Enter the access token';
    if (Object.keys(found).length) return form.reject(found);
    const body = { wabaId: form.values.wabaId.trim(), phoneNumberId: form.values.phoneNumberId.trim(), accessToken: form.values.accessToken.trim(), ...(form.values.displayNumber.trim() ? { displayNumber: form.values.displayNumber.trim() } : {}) };
    const done = await form.run(() => api.whatsappAccount.connect(body));
    if (done) {
      form.set('accessToken', '');
      toast('WhatsApp connected.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Connect WhatsApp">
      <FieldGroup>
        <TextField label="WhatsApp Business Account ID" maxLength={40} autoComplete="off" {...form.field('wabaId')} />
        <TextField label="Phone number ID" maxLength={40} autoComplete="off" {...form.field('phoneNumberId')} />
        <TextField label="Access token" type="password" autoComplete="new-password" hint="Stored encrypted. It’s never shown again." {...form.field('accessToken')} />
        <TextField label="Number shoppers see (optional)" type="tel" maxLength={20} {...form.field('displayNumber')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" loading={form.busy}>Connect WhatsApp</Button>
    </form>
  );
}

function WhatsappPanel() {
  const allowed = useAllowed();
  const isOwner = allowed(OWNER_ONLY);
  const { confirm } = useFeedback();
  const action = useAction();
  const account = useQuery({ queryKey: ['whatsapp-account'], queryFn: api.whatsappAccount.get });
  const templates = useQuery({ queryKey: ['whatsapp-templates'], queryFn: api.whatsappTemplates.all });

  async function disconnect() {
    const yes = await confirm({ title: 'Disconnect WhatsApp?', text: 'Order updates and sign-in codes stop going by WhatsApp. Email carries on.', confirm: 'Disconnect', cancel: 'Keep it' });
    if (yes) await action.run('disconnect', () => api.whatsappAccount.disconnect(), 'WhatsApp disconnected.');
  }

  return (
    <Panel title="WhatsApp number">
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={account} label="Loading your WhatsApp number" errorTitle="We couldn’t load your WhatsApp number">
        {(data) => (data.connected ? (
          <div className="stack">
            <p>{data.displayNumber || 'Connected'} {data.status === 'active' ? <Badge tone="good">Working</Badge> : <Badge tone="warn">{data.status === 'reconnect' ? 'Connect again' : 'Off'}</Badge>}</p>
            {data.status === 'reconnect' && isOwner && <><Banner tone="warn">WhatsApp stopped accepting the token. Connect again.</Banner><WhatsappConnect /></>}
            {isOwner && <Button variant="outline" loading={action.busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>}
          </div>
        ) : isOwner ? (
          <div className="stack">
            <p className="muted">Use your own WhatsApp Business number. Shoppers see your name and number, never ours.</p>
            <WhatsappConnect />
          </div>
        ) : <EmptyState title="WhatsApp isn’t connected">The owner connects the business’s WhatsApp number.</EmptyState>)}
      </StoreScreen>
      <h3>Message templates</h3>
      <p className="muted">WhatsApp reviews each template before it can be sent. Until one is approved, that update goes by email only.</p>
      <StoreScreen query={templates} label="Loading your templates" errorTitle="We couldn’t load your templates">
        {({ items }) => (items.length ? (
          <div>
            {items.map((template) => (
              <div key={template.id} className="order-line">
                <div className="order-line-head">
                  <span className="order-line-title">{purposeText(template.purpose)}</span>
                  <StatusBadge table={TEMPLATE} status={template.status} />
                </div>
                <span className="order-line-meta">{template.name} · {template.language} · {template.category}{template.checkedAt ? ` · checked ${formatDateTime(template.checkedAt)}` : ''}</span>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No templates yet">They’re sent for review when you check below.</EmptyState>)}
      </StoreScreen>
      <Button variant="soft" loading={action.busy === 'sync'} onClick={() => action.run('sync', () => api.whatsappTemplates.sync(), 'Templates checked.')}>Check template reviews</Button>
    </Panel>
  );
}

function CartReminders() {
  const allowed = useAllowed();
  const action = useAction();
  const settings = useQuery({ queryKey: ['cart-reminders'], queryFn: api.cartReminders.get });
  const stats = useQuery({ queryKey: ['cart-reminders', 'stats'], queryFn: () => api.cartReminders.stats({ days: 30 }), enabled: allowed(staffWith('analytics')) });
  return (
    <Panel title="Cart reminders">
      <p className="muted">At most two reminders, about an hour and a day after a signed-in shopper leaves their cart, only on channels they agreed to for offers. Never between 9 pm and 9 am, and never by Instagram DM.</p>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={settings} label="Loading your cart reminders" errorTitle="We couldn’t load your cart reminders">
        {(data) => (
          <div className="stack">
            <Toggle label="Send cart reminders" checked={data.enabled} disabled={action.busy === 'reminders'} onChange={(event) => action.run('reminders', () => api.cartReminders.update({ enabled: event.target.checked }), event.target.checked ? 'Cart reminders on.' : 'Cart reminders off.')} />
            {data.enabled && data.templateStatus !== 'approved' && <Banner tone="warn">The WhatsApp reminder template is {data.templateStatus === 'none' ? 'not sent for review yet' : TEMPLATE[data.templateStatus]?.label.toLowerCase() ?? data.templateStatus}. Reminders go by email until it is approved.</Banner>}
          </div>
        )}
      </StoreScreen>
      {allowed(staffWith('analytics')) && (
        <StoreScreen query={stats} label="Loading how reminders did" errorTitle="We couldn’t load how reminders did">
          {(data) => (
            <div className="store-stats" aria-label={`Last ${data.days} days`}>
              <Stat value={String(data.sent)} label="Sent" />
              <Stat value={String(data.clicked)} label="Opened the cart" />
              <Stat value={String(data.ordered)} label="Then ordered" />
              <Stat value={formatPaise(data.revenuePaise)} label="Sales from them" />
            </div>
          )}
        </StoreScreen>
      )}
    </Panel>
  );
}

/** Messages that failed or were held back show here, with a way to send them again (S-53). */
function RecentMessages() {
  const [params, setFilter] = useFilters();
  const status = ALERT_SHOW.some(([key]) => key === params.get('alerts')) ? params.get('alerts') : 'all';
  const alerts = usePagedList('order-alerts', api.orderAlerts.list, { status });
  const action = useAction();
  return (
    <Panel title="Recent order updates">
      <ChipRow label="Filter order updates">
        {ALERT_SHOW.map(([key, label]) => <Chip key={key} pressed={status === key} onClick={() => setFilter('alerts', key === 'all' ? '' : key)}>{label}</Chip>)}
      </ChipRow>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={alerts} label="Loading your order updates" errorTitle="We couldn’t load your order updates">
        {() => (alerts.items.length ? (
          <>
            <div>{alerts.items.map((alert) => <AlertLine key={alert.id} alert={alert} action={action} showOrder />)}</div>
            <LoadMore query={alerts} />
          </>
        ) : <EmptyState title={status === 'all' ? 'No order updates yet' : 'None here'}>Updates sent to shoppers about their orders show here.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}

export default function MessagesPage() {
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: ['alert-settings'], queryFn: api.alertSettings.get, enabled: allowed(MANAGERS) });
  return (
    <>
      <BackLink to="/store-settings">Store setup</BackLink>
      <PageHeader title="Messages to shoppers" />
      <p className="lead">Order updates and reminders go by WhatsApp and email, in your store’s name.</p>
      <Panel title="Order updates">
        <StoreScreen query={settings} label="Loading your order updates settings" errorTitle="We couldn’t load your order updates settings">
          {(data) => (
            <>
              <AlertSettingsForm key={JSON.stringify(data)} settings={data} />
              <Costs cost={data.whatsappCostPaise} />
            </>
          )}
        </StoreScreen>
      </Panel>
      <WhatsappPanel />
      <CartReminders />
      {allowed(staffWith('orders')) && <RecentMessages />}
    </>
  );
}
