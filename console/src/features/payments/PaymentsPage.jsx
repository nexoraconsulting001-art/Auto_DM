import { useQuery } from '@tanstack/react-query';
import { MANAGERS, OWNER_ONLY } from '@contracts/access.js';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, SelectField, TextAreaField, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useFilters, useRefresh } from '../../lib/query.js';
import { PAYMENT_AREA } from '../orders/shared/areas.js';
import { BUSINESS_TYPES } from '../orders/shared/contract.js';
import { BUSINESS_TYPE_LABELS, KYC, statusOf } from '../orders/shared/labels.js';
import { NumberField, RupeeField, StatusBadge, StoreScreen, StoreTabs, useAction } from '../orders/shared/ui.jsx';
import { KEY_ID, ONLINE_METHODS, OPTION_FIELDS, formToOptions, optionsToForm } from './form.js';

const MODES = {
  managed: { title: 'Bhava-managed', note: 'Shoppers pay through Bhava’s gateway account and each payment is passed to your bank, less the gateway’s own fee. No commission.' },
  own: { title: 'Your own gateway account', note: 'Shoppers pay into your own Razorpay account. You see the money there first.' },
};

/** Starts the managed linked account and its KYC (owner only). */
function LinkedAccountForm() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ legalName: '', contactName: '', email: '', phone: '', businessType: 'proprietorship' });

  async function submit(event) {
    event.preventDefault();
    const found = {};
    for (const [name, message] of [['legalName', 'Enter the legal name'], ['contactName', 'Enter a contact name'], ['email', 'Enter an email'], ['phone', 'Enter a phone number']]) {
      if (!String(form.values[name]).trim()) found[name] = message;
    }
    if (Object.keys(found).length) return form.reject(found);
    const done = await form.run(() => api.paymentAccount.startLinked(Object.fromEntries(Object.entries(form.values).map(([key, value]) => [key, String(value).trim()]))));
    if (done) {
      toast('Sent for KYC. We’ll switch online payments on once it passes.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Start KYC">
      <FieldGroup>
        <TextField label="Legal name of the business" maxLength={200} autoComplete="organization" {...form.field('legalName')} />
        <SelectField label="Kind of business" {...form.field('businessType')}>
          {BUSINESS_TYPES.map((type) => <option key={type} value={type}>{BUSINESS_TYPE_LABELS[type]}</option>)}
        </SelectField>
        <TextField label="Contact name" maxLength={80} autoComplete="name" {...form.field('contactName')} />
        <TextField label="Email" type="email" autoComplete="email" {...form.field('email')} />
        <TextField label="Phone" type="tel" maxLength={16} autoComplete="tel" {...form.field('phone')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Start KYC</Button>
    </form>
  );
}

/** Own mode: the key id and secret checkout signs with (5.15). The secret is never shown again. */
function OwnKeysForm() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ razorpayKeyId: '', razorpayKeySecret: '' });

  async function submit(event) {
    event.preventDefault();
    const keyId = form.values.razorpayKeyId.trim();
    const found = {};
    if (!KEY_ID.test(keyId)) found.razorpayKeyId = 'Use the key id from your Razorpay dashboard';
    if (!form.values.razorpayKeySecret) found.razorpayKeySecret = 'Enter the key secret';
    if (Object.keys(found).length) return form.reject(found);
    const done = await form.run(() => api.settings.updatePayment({ razorpayKeyId: keyId, razorpayKeySecret: form.values.razorpayKeySecret }));
    if (done) {
      form.set('razorpayKeySecret', '');
      toast('Keys saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={submit} noValidate aria-label="Your gateway keys">
      <FieldGroup>
        <TextField label="Key id" autoComplete="off" placeholder="rzp_live_…" {...form.field('razorpayKeyId')} />
        <TextField label="Key secret" type="password" autoComplete="new-password" hint="Stored encrypted. It’s never shown again." {...form.field('razorpayKeySecret')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" variant="soft" loading={form.busy}>Save keys</Button>
    </form>
  );
}

function AccountPanel({ account }) {
  const allowed = useAllowed();
  const isOwner = allowed(OWNER_ONLY);
  const { confirm } = useFeedback();
  const action = useAction();
  const other = account.mode === 'managed' ? 'own' : 'managed';
  const kyc = statusOf(KYC, account.kycStatus);

  async function switchMode() {
    const yes = await confirm({
      title: `Switch to ${MODES[other].title.toLowerCase()}?`,
      text: 'This applies to new orders only. Orders already placed keep settling the way they were paid.',
      confirm: 'Switch',
      cancel: 'Keep it as it is',
      tone: 'primary',
    });
    if (yes) await action.run('mode', () => api.paymentAccount.setMode({ mode: other }), 'Switched. New orders use it from now.');
  }

  async function connect() {
    const result = await action.run('connect', () => api.paymentAccount.connectUrl());
    if (result?.url) window.location.assign(result.url);
  }

  async function disconnect() {
    const yes = await confirm({ title: 'Disconnect your gateway account?', text: 'Shoppers can’t pay online with it until you connect again.', confirm: 'Disconnect', cancel: 'Keep it' });
    if (yes) await action.run('disconnect', () => api.paymentAccount.disconnect(), 'Disconnected.');
  }

  return (
    <Panel title="How you’re paid" action={<Badge tone="neel">{MODES[account.mode].title}</Badge>}>
      <p className="muted">{MODES[account.mode].note}</p>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      {account.mode === 'managed' ? (
        <div className="stack">
          <dl className="facts">
            <div><dt>KYC</dt><dd><StatusBadge table={KYC} status={account.kycStatus} /></dd></div>
            {account.linkedAccount && <div><dt>Linked account</dt><dd className="facts-long">{account.linkedAccount}</dd></div>}
          </dl>
          {account.kycStatus === 'pending' && <Banner tone="warn">Your details are being checked. Online payment switches on when KYC passes. Until then only cash on delivery shows, if it’s on.</Banner>}
          {['not_started', 'rejected'].includes(account.kycStatus) && (isOwner
            ? <><p className="muted">{account.kycStatus === 'rejected' ? 'KYC wasn’t accepted. Check the details and send them again.' : 'Give your business details to start KYC. Online payment switches on when it passes.'}</p><LinkedAccountForm /></>
            : <p className="muted">KYC is {kyc.label.toLowerCase()}. The owner starts it.</p>)}
        </div>
      ) : (
        <div className="stack">
          <dl className="facts">
            <div><dt>Connected</dt><dd>{account.ownConnection === 'none' ? 'Not yet' : account.ownConnection === 'oauth' ? 'Yes, by signing in' : 'Yes, with keys'}</dd></div>
            {account.ownAccount && <div><dt>Account</dt><dd className="facts-long">{account.ownAccount}</dd></div>}
          </dl>
          {account.webhookUrl && (
            <div className="stack">
              <p className="muted">Bhava receives your gateway’s payment updates at this address. If your gateway asks for it, give it this:</p>
              <p className="store-code">{account.webhookUrl}</p>
              <CopyButton text={account.webhookUrl} label="Copy address" />
            </div>
          )}
          {isOwner && (
            <>
              <div className="row-actions">
                <Button loading={action.busy === 'connect'} onClick={connect}>{account.ownConnection === 'none' ? 'Connect your Razorpay account' : 'Connect again'}</Button>
                {account.ownConnection !== 'none' && <Button variant="outline" loading={action.busy === 'disconnect'} onClick={disconnect}>Disconnect</Button>}
              </div>
              <details className="store-more">
                <summary>Use keys instead</summary>
                <OwnKeysForm />
              </details>
            </>
          )}
        </div>
      )}
      {isOwner
        ? <Button variant="outline" loading={action.busy === 'mode'} onClick={switchMode}>Switch to {MODES[other].title.toLowerCase()}</Button>
        : <p className="field-hint">Only the owner changes how the business is paid.</p>}
    </Panel>
  );
}

function MethodsForm({ options }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(optionsToForm(options), { rename: OPTION_FIELDS });
  const percent = form.values.advanceKind === 'percent';

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToOptions(form.values);
    if (errors) return form.reject(errors);
    const done = await form.run(() => api.paymentSettings.update(body));
    if (done) {
      toast('Payment options saved.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Ways to pay">
      {!options.onlineReady && <Banner tone="warn">Online payment is off until your account can take money. Shoppers see only cash on delivery, if it’s on.</Banner>}
      <fieldset className="store-checks">
        <legend>Online</legend>
        {ONLINE_METHODS.map(([name, label]) => <Toggle key={name} label={label} {...form.toggle(name)} />)}
      </fieldset>
      <fieldset className="store-checks">
        <legend>Cash on delivery</legend>
        <Toggle label="Offer cash on delivery" {...form.toggle('cod')} />
        {form.values.cod && (
          <FieldGroup>
            <RupeeField label="Cash on delivery fee" hint="0 for none." {...form.field('codFee')} />
            <RupeeField label="Largest order for cash on delivery" hint="Leave empty for no limit. Above it, shoppers are told why it isn’t offered." {...form.field('codMax')} />
            <TextAreaField label="Only these PIN codes" hint="Separate with commas. Leave empty for wherever the courier offers it." rows={2} {...form.field('codPins')} />
            <NumberField label="Stop after this many returned parcels" hint="A number that refused this many parcels can’t choose cash on delivery. Empty for never." {...form.field('codBlock')} />
          </FieldGroup>
        )}
      </fieldset>
      <fieldset className="store-checks">
        <legend>Part advance</legend>
        <Toggle label="Ask for part of the money first" {...form.toggle('partAdvance')} />
        {form.values.partAdvance && (
          <FieldGroup>
            <SelectField label="Advance is" {...form.field('advanceKind')}>
              <option value="fixed">A fixed amount</option>
              <option value="percent">A percentage of the order</option>
            </SelectField>
            {percent
              ? <TextField label="Advance (%)" inputMode="decimal" {...form.field('advanceValue')} />
              : <RupeeField label="Advance" {...form.field('advanceValue')} />}
          </FieldGroup>
        )}
      </fieldset>
      <FieldGroup>
        <NumberField label="Minutes an unpaid order keeps its stock" hint="5 to 1440. After that the order is cancelled and the stock goes back." {...form.field('holdMinutes')} />
      </FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Save payment options</Button>
    </form>
  );
}

export default function PaymentsPage() {
  const allowed = useAllowed();
  const [params] = useFilters();
  const account = useQuery({ queryKey: ['payment-account'], queryFn: api.paymentAccount.get, enabled: allowed(MANAGERS) });
  const options = useQuery({ queryKey: ['payment-settings'], queryFn: api.paymentSettings.get, enabled: allowed(MANAGERS) });
  const back = params.get('payments');
  return (
    <>
      <PageHeader title="Payments" />
      <StoreTabs label="Payments area" tabs={PAYMENT_AREA} current="/payments" />
      {back === 'connected' && <Banner tone="good">Your gateway account is connected.</Banner>}
      {back === 'failed' && <Banner tone="bad">The gateway didn’t connect. Try again.</Banner>}
      <StoreScreen query={account} label="Loading how you’re paid" errorTitle="We couldn’t load how you’re paid">
        {(data) => <AccountPanel account={data} />}
      </StoreScreen>
      <Panel title="Ways to pay">
        <StoreScreen query={options} label="Loading your payment options" errorTitle="We couldn’t load your payment options">
          {(data) => (data ? <MethodsForm key={JSON.stringify(data)} options={data} /> : <EmptyState title="No payment options yet">Save them below.</EmptyState>)}
        </StoreScreen>
      </Panel>
    </>
  );
}
